"use strict";

const crypto = require("node:crypto");
const path = require("path");

const gameStore = require(path.join(__dirname, "../../gameStore"));
const log = require(path.join(__dirname, "../../utils/logger"));
const sessionRegistry = require(path.join(
  __dirname,
  "../../services/chat/sessionRegistry",
));
const skillQueueRuntime = require(path.join(
  __dirname,
  "../../services/skills/training/skillQueueRuntime",
));
// R28: the SP curve and the server's own clock. Only read from — the level
// thresholds a skill sheet needs are a game mechanic, and the browser gets them
// by having this module evaluated for it rather than by re-deriving them.
const skillTrainingMath = require(path.join(
  __dirname,
  "../../services/skills/training/skillTrainingMath",
));
const planetRuntime = require(path.join(
  __dirname,
  "../../services/planet/planetRuntimeStore",
));
const onlineRuntime = require(path.join(
  __dirname,
  "../../services/online/onlineStatusRuntime",
));
const characterControlRuntime = require(path.join(
  __dirname,
  "../../services/online/characterControlRuntime",
));
const {
  AUTHORIZATION_POLICIES,
  createCharacterCommandRuntime,
} = require(path.join(
  __dirname,
  "../../services/online/characterCommandRuntime",
));
const {
  createCharacterEventRuntime,
} = require(path.join(
  __dirname,
  "../../services/online/characterEventRuntime",
));
const { marketDaemonClient } = require(path.join(
  __dirname,
  "../../services/market/marketDaemonClient",
));
const { isDeferredCallResponse } = require(path.join(
  __dirname,
  "../../network/callResponseControl",
));
// Web chat-gateway helper (goal R7): Local + Corp presence/read/send for the
// browser-backed session. It only calls existing chat surfaces (plus a
// session-derived corp path that mirrors Local); it never modifies core chat
// mechanics. Kept in gatewayServices/ alongside localChatGatewayService, but it
// is a plain helper the runtime calls — not a protobuf gateway service (it is
// intentionally NOT registered in gatewayServices/index.js).
const webChatGatewayService = require(path.join(
  __dirname,
  "gatewayServices/webChatGatewayService",
));
// Bridge-session push stream (goal R10 / roadmap G6): the epoch/sequence
// replay-or-snapshot event stream keyed by bridgeSessionID that carries session
// notifications and chat to a connected browser. Purely additive — the
// notification response drain below is unchanged.
const {
  createSessionEventRuntime,
} = require(path.join(__dirname, "sessionEventStream"));
// Read-only chat sources for the push stream. chatRuntime's module-level
// emitter is subscribed, never modified; channelRules supplies the same room
// name derivation the chat read path already uses.
const chatRuntime = require(path.join(__dirname, "../chat/chatRuntime"));
const {
  getLocalChatRoomNameForSession,
} = require(path.join(__dirname, "../../services/chat/channelRules"));

const SNAPSHOT_ITEM_LIMIT = 20000;
// Deny-by-default allowlist for the browser-backed `callMethod` bridge path.
// Each entry is an explicit (service, method) pair — never a whole service:
// service-granular entries would expose destructive siblings (e.g. whitelisting
// all of charUnboundMgr would expose Handle_DeleteCharacter). The list is scope
// control for the web-client bridge, not a security measure; later web-client
// goals extend it pair-by-pair as pages migrate to retail calls.
const WEB_CALL_ALLOWLIST = Object.freeze([
  Object.freeze({ service: "charUnboundMgr", method: "GetCharacterSelectionData" }),
  Object.freeze({ service: "charUnboundMgr", method: "SelectCharacterID" }),
  Object.freeze({ service: "map", method: "GetStationInfo" }),
  Object.freeze({ service: "station", method: "GetGuests" }),
  Object.freeze({ service: "stationSvc", method: "GetStationItemBits" }),
  // R3 station inventory + ship operations (bound-object two-step). Binds mint a
  // bound handle; the methods dispatch on that handle. Deny-by-default still
  // governs every pair — a bound-method call whose (service, method) is not
  // listed here is refused before dispatch, exactly like a top-level call.
  // invbroker: the retail two-step inventory surface (Step 5/6 of the courier
  // inventory). GetInventory/GetInventoryFromId/MachoBindObject are the binds
  // (they return a bound inventory object); List/Add/MultiMerge/StackAll/
  // GetCapacity dispatch on that bound object.
  Object.freeze({ service: "invbroker", method: "MachoBindObject" }),
  Object.freeze({ service: "invbroker", method: "GetInventory" }),
  Object.freeze({ service: "invbroker", method: "GetInventoryFromId" }),
  Object.freeze({ service: "invbroker", method: "List" }),
  Object.freeze({ service: "invbroker", method: "Add" }),
  Object.freeze({ service: "invbroker", method: "MultiMerge" }),
  Object.freeze({ service: "invbroker", method: "StackAll" }),
  Object.freeze({ service: "invbroker", method: "GetCapacity" }),
  // R14 inventory depth. Three of the four operations need NO new pair —
  // they are the listed methods called with arguments R3 hardcoded away:
  //   split a stack  = Add(itemID, sourceLocationID, qty=<partial>)  — the SAME
  //                    Add, with a qty short of the whole stack (across
  //                    containers or in place).
  //   re-merge       = MultiMerge(ops, sourceContainerID)            — already listed.
  //   open container = GetInventoryFromId(containerItemID) then List() with NO
  //                    flag. Containers are NOT a distinct protocol surface:
  //                    the bind is byte-for-byte the ship-cargo bind, and
  //                    container contents carry flagID 0 (not 4/5), so a
  //                    flag-scoped List would answer empty. Container-ness is a
  //                    purely CLIENT-side static-data test (groupID/categoryID
  //                    + singleton) — the server has no notion of it here.
  // So R14's inventory half adds exactly two pairs:
  //
  // MultiAdd(itemIDs, sourceLocationID, flag=<dest>) is the batch sibling of
  // Add — one call moves a multi-selection instead of N round-trips. It
  // dispatches on the DESTINATION binding, exactly like Add.
  Object.freeze({ service: "invbroker", method: "MultiAdd" }),
  // TrashItems(itemIDs, locationID) DESTROYS items. It is listed because it is
  // the only retail way to discard, and it is fenced the same way R12 fenced
  // DestroyFitting: the BFF refuses the route outright without an explicit
  // `confirm: true`, and the web UI puts a two-step confirm in front of that.
  // Unlike the container methods it dispatches on the inventory-MANAGER
  // moniker (Moniker('invbroker', (stationID, groupStation))), not on a
  // per-container binding — the handler reads the location from its arguments.
  Object.freeze({ service: "invbroker", method: "TrashItems" }),
  // R14 corporation hangars. The corp hangar is the station hangar with two
  // differences, and NEITHER needs a new invbroker pair:
  //   - the binding is the corporation's OFFICE at this station
  //     (GetInventoryFromId(officeID)) instead of the stationID, and
  //   - contents are scoped by a DIVISION flag 115..121 (flagCorpSAG1..7), plus
  //     184 (flagCorpGoalDeliveries), instead of flag 4.
  // List/Add/MultiAdd/GetCapacity are then the ordinary already-listed methods.
  // So the corp half adds exactly two pairs, both plain READS:
  //
  // officeManager.GetMyCorporationsOffices answers the caller's corporation's
  // offices (a rowset of leases) — this is how the bridge learns WHICH office
  // to bind at the docked station. It is the read-only sibling of RentOffice /
  // UnrentOffice / TrashImpoundedOffice, none of which are listed.
  //
  // ⚠ IDENTITY: the rowset's `officeID` column is the office's ITEM id
  // (resolveClientOfficeID -> office.itemID), while corp hangar CONTENTS sit at
  // office.officeID — a SEPARATELY allocated counter. The two are not equal.
  // GetInventoryFromId accepts any of officeID/officeFolderID/itemID and
  // normalizes the bound context to office.officeID, so BINDING with the rowset
  // value is correct; but a caller must never assume that value is also the
  // items' locationID. The bridge therefore takes each row's own locationID
  // from the List result when it needs a source location.
  Object.freeze({ service: "officeManager", method: "GetMyCorporationsOffices" }),
  // corpRegistry.GetCorporation answers the corporation row, which carries the
  // seven free-text division names (division1..division7). It is listed so the
  // browser can label a division by its NAME rather than a flag number — the
  // R7d "no visible numeric IDs" invariant applies to division flags too.
  // Every mutating corpRegistry sibling stays refused.
  Object.freeze({ service: "corpRegistry", method: "GetCorporation" }),
  // R12 ship fitting. Fitting is NOT a dedicated service — it is this same
  // invbroker bound-object two-step with a SLOT flag instead of flag 4/5:
  //   fit    = ship binding . Add(moduleItemID, sourceLocationID, {flag:<slot>})
  //   unfit  = hangar/ship binding . Add(moduleItemID, shipID, {flag:4|5})
  // so `Add` (already listed above) carries both, and only two pairs are new.
  //
  // ListByFlags reads the fit: one call over the slot-flag ranges answers with
  // the fitted module rows (itemID/typeID/flagID) per slot, instead of one
  // List(flag) round-trip per slot. It is a plain read, the flag-scoped sibling
  // of List.
  Object.freeze({ service: "invbroker", method: "ListByFlags" }),
  // DestroyFitting is the rig path: rigs cannot be unfitted, so removing one
  // DESTROYS it. It is listed because that is the only retail way to clear a
  // rig slot, and the BFF gates it behind an explicit confirmation flag (and
  // the web UI behind a two-step confirm) so it can never be a stray click.
  Object.freeze({ service: "invbroker", method: "DestroyFitting" }),
  // dogmaIM: the fitting READ (resources + which modules are online) and the
  // online/offline actions. All four are TOP-LEVEL calls on the docked session
  // — each handler resolves the character's active ship from the session
  // itself, so no bind step is involved (unlike invbroker/ship/agentMgr).
  //
  // ShipGetInfo answers the active ship's dogma attribute dict, which carries
  // CPU output/load, powergrid output/load, capacitor capacity/charge/recharge,
  // calibration used/capacity and the per-family slot counts. ShipOnlineModules
  // answers the flat list of fitted module itemIDs that are currently online —
  // a cheap, side-effect-free per-module state read.
  //
  // GetAllInfo is DELIBERATELY NOT listed: it would serve the same read, but it
  // is the login/undock bootstrap call and fires post-response side effects
  // (afterCallResponse -> post-GetAllInfo charge refresh, post-undock dogma
  // multi-event, character dogma state sync). A panel refresh must not replay
  // a session bootstrap, and ShipGetInfo + ShipOnlineModules cover the read.
  Object.freeze({ service: "dogmaIM", method: "ShipGetInfo" }),
  Object.freeze({ service: "dogmaIM", method: "ShipOnlineModules" }),
  // The online/offline actions. The handlers own the CPU / powergrid /
  // capacitor / max-group gating and answer a refusal with their OWN reason
  // (NOT_ENOUGH_CPU -> "You do not have enough CPU to online that module.",
  // NOT_ENOUGH_POWER -> the powergrid equivalent, NotEnoughCapacitorForOnline,
  // CannotOnlineReachedMaxGroupOnline, ...). The bridge surfaces that reason
  // verbatim and never pre-judges fitting validity itself.
  Object.freeze({ service: "dogmaIM", method: "SetModuleOnline" }),
  Object.freeze({ service: "dogmaIM", method: "TakeModuleOffline" }),
  // ship: Moniker('ship',(stationID,groupStation)) -> Board (Step 7). The bind
  // is MachoBindObject; Board makes a hangar ship active on the docked session.
  Object.freeze({ service: "ship", method: "MachoBindObject" }),
  Object.freeze({ service: "ship", method: "Board" }),
  // R4 agents + courier missions (agentMgr — the courier arc, inventory Steps
  // 2/3/4/11/12). GetAgents is a plain top-level read of the station's agent
  // roster. The rest are the retail bound-object two-step: the agent moniker is
  // Moniker('agentMgr', agentID) via GetAgentMoniker -> MachoBindObject (bind),
  // and DoAction/GetMission*/GetAgentLocationWrap/GetStandingGainsForMission
  // dispatch on that bound agent. GetMyJournalDetails is reachable both
  // top-level (whole journal) and bound (filtered to the agent), so it is
  // listed once and works on either seam. DoAction drives the whole
  // conversation: DoAction(None) opens it, DoAction(<accept actionID>) accepts
  // a courier in person (a synchronous outcome), and DoAction(<decline>) is the
  // one deferred outcome (see the deferred-call-response handling below).
  Object.freeze({ service: "agentMgr", method: "GetAgents" }),
  Object.freeze({ service: "agentMgr", method: "MachoBindObject" }),
  Object.freeze({ service: "agentMgr", method: "DoAction" }),
  Object.freeze({ service: "agentMgr", method: "GetMissionBriefingInfo" }),
  Object.freeze({ service: "agentMgr", method: "GetMissionObjectiveInfo" }),
  Object.freeze({ service: "agentMgr", method: "GetMissionKeywords" }),
  Object.freeze({ service: "agentMgr", method: "GetAgentLocationWrap" }),
  Object.freeze({ service: "agentMgr", method: "GetStandingGainsForMission" }),
  Object.freeze({ service: "agentMgr", method: "GetMyJournalDetails" }),
  // R6 courier completion (inventory Step 12): the post-completion pull reads a
  // wallet/LP/standings panel issues after Complete pays out. These are plain
  // TOP-LEVEL server-tier reads on the docked session (no bind step — the client
  // accessors return bare sm.RemoteSvc('account'|'LPSvc'|'standingMgr')). The
  // mission journal read (agentMgr.GetMyJournalDetails, above) is the fourth
  // Step-12 read and is already allowlisted, and Complete itself is
  // agentMgr.DoAction (a synchronous outcome like accept, already allowlisted) —
  // so R6 adds no completion pair, only these three read-only pairs. Each is a
  // deny-by-default (service, method) pair; only own-character personal reads are
  // exercised (GetCashBalance(0), no accountKey/corp variant).
  Object.freeze({ service: "account", method: "GetCashBalance" }),
  Object.freeze({ service: "LPSvc", method: "GetAllMyCharacterWalletLPBalances" }),
  Object.freeze({ service: "standingMgr", method: "GetCharStandings" }),
  // R55 Standings page: the rest of the retail standings panel's reads
  // (eve/client/.../neocom/charsheet/standingsPanel). GetCharStandings above is
  // "NPCs to my character"; GetCorpStandings is "NPCs to my corp" — both plain
  // TOP-LEVEL reads scoped server-side off the docked session
  // (Handle_GetCharStandings/GetCorpStandings key off session.characterID /
  // session.corporationID, no args). GetStandingTransactions(fromID, toID) is the
  // per-entity standings HISTORY the panel shows for a character row, and
  // GetStandingCompositions(fromID, toID) the per-member breakdown it shows for a
  // corp row — both take (fromID, toID) positional args and answer read-only
  // (standingRuntime.getStandingTransactions / getStandingCompositions). All four
  // are reads; every mutating standingMgr sibling (SetStanding/SetPlayerStanding/
  // the NPC-standing setters) stays refused. standing2 is a DISTINCT service name
  // and is NOT listed.
  Object.freeze({ service: "standingMgr", method: "GetCorpStandings" }),
  Object.freeze({ service: "standingMgr", method: "GetStandingTransactions" }),
  Object.freeze({ service: "standingMgr", method: "GetStandingCompositions" }),
  // R50 Corp Wallet tab: the per-division corporation balances the retail corp
  // wallet window reads (eve/client/.../wallet/panels/corp/corpDivisionsPanel.py
  // calls sm.GetService('account').GetWalletDivisionsInfo()). A plain TOP-LEVEL
  // read on the docked session — same `account` service, same seam as
  // GetCashBalance, no bind step (GetAccountMgr() is sm.RemoteSvc('account')).
  // Handle_GetWalletDivisionsInfo scopes off session.corporationID and answers a
  // read-only list<KeyVal{key,balance}>; it writes nothing. This is the ONE
  // corp-wallet pair — the corp variant of GetCashBalance is DELIBERATELY not
  // reached (this all-divisions read supersedes it for the panel), and every
  // mutating account sibling (transfers) stays refused.
  Object.freeze({ service: "account", method: "GetWalletDivisionsInfo" }),
  // R54 Wallet ledger (personal): the transactions + journal the retail wallet
  // window reads (eve/client/.../wallet/panels/transactionsPanel.py ->
  // accountsvc._GetPersonalTransactions issues GetTransactions(accountingKeyCash,
  // year, month, False); GetJournal backs the journal panel). Plain TOP-LEVEL
  // reads on the docked session -- same `account` service/seam as GetCashBalance,
  // no bind step. The BFF issues ONLY the personal variant (args[3]/isCorpWallet
  // = 0, accountKey = 1000 CASH); the corp branch (args[3] = 1) is DELIBERATELY
  // never passed, and even if it were it only ever reads the session's OWN
  // corporation's ledger (scoped off session.corporationID). GetEntryTypes is the
  // ref-type -> label static map (entryTypeID -> entryTypeName) the journal panel
  // uses to render "Player Trading" instead of a code (accountsvc.GetRefTypeKeyByID).
  // All three are read-only; every mutating account sibling (GiveCash/transfers)
  // stays refused.
  Object.freeze({ service: "account", method: "GetJournal" }),
  Object.freeze({ service: "account", method: "GetTransactions" }),
  Object.freeze({ service: "account", method: "GetEntryTypes" }),
  // R5a manually-stepped space movement (undock -> warp -> jump -> dock;
  // inventory Steps 7/8/9). These are the atomic moves the retail client's
  // client-side autopilot issues; the browser sequences them via buttons, and
  // EveJS's existing space handlers stay authoritative for each move (no
  // server-side travel job — roadmap section 7). The persistent browser-backed
  // session participates in space the same way a retail socket session does:
  // Handle_Undock runs undockSession(session), which attaches the session to a
  // space scene (session._space) via applyCharacterToSession + spaceRuntime,
  // exactly like a retail undock. No new session-carry code is needed — the
  // persistent session already carries the duck-typed fields + notification
  // surfaces the space runtime reads (the same shape the space parity tests
  // hand to undockSession/dockSession).
  //
  // ship.Undock (Moniker('ship',(stationID,groupStation)).Undock) is a
  // TOP-LEVEL call on the docked session: Handle_Undock resolves the ship from
  // the session, so it does not need the ship bound-object OID. onlineModules
  // is a kwarg (never positional).
  Object.freeze({ service: "ship", method: "Undock" }),
  // beyonce (the remote park, Moniker('beyonce', solarsystemID) via
  // michelle.GetRemotePark()) is the bound-object two-step R3 established:
  // beyonce.MachoBindObject mints the bound park handle, and the Cmd* methods
  // dispatch on it. Each Cmd* handler operates on the in-space session
  // (session._space) — warpToStuffAutopilot warps to a gate/celestial,
  // setSpeedFraction/followBall approach, stargateJump changes system, and
  // dock returns to a station. The autopilot decide-loop that sequences them
  // is R5b (client-side); R5a issues each move by an explicit button.
  Object.freeze({ service: "beyonce", method: "MachoBindObject" }),
  Object.freeze({ service: "beyonce", method: "CmdWarpToStuffAutopilot" }),
  Object.freeze({ service: "beyonce", method: "CmdWarpToStuff" }),
  Object.freeze({ service: "beyonce", method: "CmdSetSpeedFraction" }),
  Object.freeze({ service: "beyonce", method: "CmdFollowBall" }),
  Object.freeze({ service: "beyonce", method: "CmdStargateJump" }),
  Object.freeze({ service: "beyonce", method: "CmdDock" }),
  // R13 flight fidelity: the remaining in-space flight verbs the retail
  // right-click menu offers. Only THREE new pairs are needed, because two of
  // the "missing" verbs are the SAME server methods already allowlisted above,
  // simply called with the arguments R5a hardcoded away:
  //   - keep at range IS CmdFollowBall(targetID, range) with a non-zero range
  //     (the autopilot's approach is the same method at range 0.0), and
  //   - warp at range IS CmdWarpToStuff("item", itemID) with a minRange kwarg.
  // Orbit / align / stop have no such stand-in, so they are added here. Each is
  // still a deny-by-default (service, method) pair. (⚠ CmdGotoPoint /
  // CmdGotoBookmark / CmdAbandonLoot / CmdFleetTagTarget / CmdJumpThroughFleet —
  // named here through R102 — are allowlisted by the R103 WB-BEYONCE WRITES batch
  // below, confirm-gated at the BFF; the remaining free-flight / fleet-beacon
  // siblings CmdGotoDirection / CmdSteerDirection / CmdBridgeToFleetModuleBeacon
  // stay refused before dispatch.)
  //
  // CmdAlignTo takes KWARGS only (dstID / bookmarkID, exactly one non-null);
  // CmdOrbit takes [targetID, range]; CmdStop takes no arguments and — as in
  // retail — is the verb that also cancels client-side navigation, so the
  // browser autopilot aborts alongside it (that half is client-side).
  Object.freeze({ service: "beyonce", method: "CmdOrbit" }),
  Object.freeze({ service: "beyonce", method: "CmdAlignTo" }),
  Object.freeze({ service: "beyonce", method: "CmdStop" }),
  // R103 PLUMBING sweep — WB-BEYONCE: the 7 Phase-4 BOUND nav/bookmark WRITES that
  // ride the SAME beyonce remote-park bind (Moniker("beyonce", solarSystemID) via
  // beyonce.MachoBindObject, allowlisted above) the autopilot movement path uses.
  // Free-flight goto (point / bookmark), loot abandonment, a fleet target tag, the
  // fleet jump-beacon jump, and the two in-space bookmark creators. Reachable ONLY
  // via confirm-gated BFF POST routes (the browser must send `confirm:true` or the
  // route refuses before any dispatch); dispatched as BOUND methods off
  // parkBindSpec(session.solarSystemID) (mirrors the R5a/R13 movement verbs). The
  // solar system is resolved from the SESSION's own live flight, never caller-sent.
  //
  // ⚠ OWNERSHIP: every one of these resolves ship / scene / char from the SESSION
  // (spaceRuntime.<op>(session, …) / fleetRuntime.<op>(session, …) / creatorID =
  // session.characterID for the bookmark writers). CmdJumpThroughFleet takes a
  // fleet-mate's (charID, shipID) but validates it against the SESSION's own fleet
  // membership (fleet.members.get(otherCharID)) and the bridge is looked up scoped
  // to the session char — the legitimate cyno-jump mechanism, not caller-forgeable.
  // No caller-supplied foreign ship id — NO handoff-doc flag.
  Object.freeze({ service: "beyonce", method: "CmdGotoPoint" }),
  Object.freeze({ service: "beyonce", method: "CmdGotoBookmark" }),
  Object.freeze({ service: "beyonce", method: "CmdAbandonLoot" }),
  Object.freeze({ service: "beyonce", method: "CmdFleetTagTarget" }),
  Object.freeze({ service: "beyonce", method: "CmdJumpThroughFleet" }),
  Object.freeze({ service: "beyonce", method: "BookmarkLocation" }),
  Object.freeze({ service: "beyonce", method: "BookmarkScanResult" }),
  // structureJumpBridgeMgr.CmdJumpThroughStructureStargate is the server-tier
  // alternative jump through an Upwell jump gate (autopilot.py:349). Bridged
  // for parity with the retail jump surface; NPC stargates use beyonce above.
  Object.freeze({ service: "structureJumpBridgeMgr", method: "CmdJumpThroughStructureStargate" }),
  // R15 industry READS (blueprints / jobs / facilities). The whole industry
  // retail surface is TOP-LEVEL (sm.RemoteSvc) — there is no MachoBindObject
  // step anywhere in it — so these ride the ordinary callMethod seam with no
  // new bridge machinery. Every pair below is side-effect free.
  //
  // blueprintManager.GetBlueprintDataByOwner(ownerID, facilityID|None) is THE
  // blueprint-list call: it answers [list<blueprintInstance>, dict<facilityID ->
  // count>] and each instance carries materialEfficiency / timeEfficiency /
  // runs / locationID / jobID directly, so no per-blueprint follow-up read is
  // needed. GetBlueprintData (one instance by itemID) is listed because the
  // install flow re-reads a SINGLE blueprint after a mutation to prove what
  // actually applied, rather than trusting a 200.
  Object.freeze({ service: "blueprintManager", method: "GetBlueprintDataByOwner" }),
  Object.freeze({ service: "blueprintManager", method: "GetBlueprintData" }),
  // industryManager reads. GetJobsByOwner(ownerID, includeCompleted) takes
  // session.charid for personal jobs or session.corpid for corporation jobs;
  // the bridge only ever passes the character's own id. GetJob(jobID) is the
  // single-job re-read after install/deliver/cancel. GetJobCounts(charID)
  // answers {activityID: usedSlots} — how many job slots are in use.
  Object.freeze({ service: "industryManager", method: "GetJobsByOwner" }),
  Object.freeze({ service: "industryManager", method: "GetJob" }),
  Object.freeze({ service: "industryManager", method: "GetJobCounts" }),
  // facilityManager reads. GetFacilities() is region-scoped off the session's
  // own regionid (set by applyCharacterToSession), so it needs no arguments and
  // cannot be pointed at another region. GetMaxActivityModifiers() answers the
  // per-activity modifier ceiling the panel shows alongside each facility.
  // GetFacilityLocations(facilityID, ownerID) answers the input/output hangar
  // CHOICES for an install — a read, listed here because the install flow must
  // offer them before it can send a job.
  Object.freeze({ service: "facilityManager", method: "GetFacilities" }),
  Object.freeze({ service: "facilityManager", method: "GetMaxActivityModifiers" }),
  Object.freeze({ service: "facilityManager", method: "GetFacilityLocations" }),
  // ⚠ facilityManager.SetFacilityTaxes is DELIBERATELY ABSENT. It is a
  // corp-admin mutator that rewrites what every member of a corporation pays to
  // use a structure — out of scope for a player-facing industry panel, and it
  // stays refused before dispatch like every other unlisted sibling.
  //
  // R15 industry MUTATORS. These are the three real state changes industry
  // makes, and installing is the expensive one: installIndustryJob CONSUMES
  // MATERIALS out of a hangar and CHARGES THE WALLET before it writes the job.
  // So it is fenced the same way R12 fenced DestroyFitting and R14 fenced
  // TrashItems — the BFF refuses the route outright without an explicit
  // `confirm: true`, and the web UI puts a two-step confirm in front of that.
  //
  // InstallJob takes ONE POSITIONAL DICT (the shape industry.Job.dump()
  // produces; parseIndustryRequest reads it). The server RECOMPUTES materials,
  // time and cost from the blueprint definition plus facility modifiers, so the
  // client's own cost/time/materials fields are advisory — what actually gets
  // charged is the server's quote.
  Object.freeze({ service: "industryManager", method: "InstallJob" }),
  // CompleteJob(jobID, solarSystemID) IS delivery — it grants the products and
  // marks the job delivered. CancelJob(jobID, solarSystemID) stops a running
  // job and returns the blueprint, but does NOT refund the materials or the
  // installation fee, which is why the UI confirms it too.
  Object.freeze({ service: "industryManager", method: "CompleteJob" }),
  Object.freeze({ service: "industryManager", method: "CancelJob" }),
  // industryManager.CompleteManyJobs is the BATCH CompleteJob — a batch delivery
  // is exactly the kind of action a stray click should not fire across a whole job
  // list, so it is confirm-gated at the BFF. It is allowlisted by the R93 WRITES
  // batch (see the R93 block below), not absent.
  //
  // industryMonitor is the retail INSTALL PREVIEW. ConnectJob(<job dict>)
  // answers (monitorID, availableMaterials) — how much of each required
  // material the player actually has at the input location — which is what
  // turns the confirm step into an informed decision instead of a guess.
  // It is not a pure read (it persists a monitor row), so DisconnectJob is
  // listed alongside it and the BFF always releases the monitor it opened.
  Object.freeze({ service: "industryMonitor", method: "ConnectJob" }),
  Object.freeze({ service: "industryMonitor", method: "DisconnectJob" }),
  // R16 market READS. Like industry, the whole retail market surface is
  // TOP-LEVEL (sm.ProxySvc('marketProxy')) — no MachoBindObject step — so these
  // ride the ordinary callMethod seam and add no bridge machinery.
  //
  // ⚠ THE SERVICE-NAME TRAP. There are TWO market services registered, and the
  // obvious one is the wrong one. `marketService.js` (service name "market") is
  // a DEAD STUB: every one of its methods answers an empty rowset. The live
  // implementation — daemon-backed order books, escrow, broker fees, wallet
  // debits — is `marketProxyService.js`, registered as **"marketProxy"**.
  // Allowlisting "market" would produce a market page that renders perfectly
  // and is silently, permanently empty, which reads as a bridge bug. Only
  // marketProxy pairs are listed here, and "market" is deliberately absent.
  //
  // ⚠ EXTERNAL DEPENDENCY. marketProxy talks to an out-of-process market daemon
  // over TCP 127.0.0.1:40111 (marketDaemonClient). When that daemon is down,
  // every daemon-backed read throws MarketUnavailable rather than answering
  // empty — so a market panel with no rows means "no orders", and a market
  // panel with an error means "check the daemon", and the two are
  // distinguishable. The BFF surfaces the daemon failure as its own read error
  // instead of blanking the page.
  //
  // ⚠ EVERY marketProxy READ IS SESSION-SCOPED, and that is the security
  // property that matters: GetOrders scopes to session.regionid, GetCharOrders
  // /GetMarketOrderHistory/CharGetTransactions/GetCharEscrow to session.charid,
  // GetStationAsks to session.stationid, GetSystemAsks to session.solarsystemid2
  // and GetRegionBest to session.regionid. None of them take an owner or a
  // location argument, so a caller cannot point any of them at another
  // character, another station or another region. The only argument any read
  // takes is a typeID (or a fromDate), which selects WHAT to look at, never
  // WHOSE.
  //
  // StartupCheck() is the daemon liveness probe retail issues before it opens a
  // market window; it answers None when the daemon is reachable and throws
  // otherwise, which is exactly the signal the panel needs to tell the player
  // "the market is not answering right now" instead of "you have no orders".
  Object.freeze({ service: "marketProxy", method: "StartupCheck" }),
  // GetOrders(typeID) is THE order-book read: it answers a 2-tuple
  // [sellsRowset, buysRowset] of blue.DBRow rows for that type across the
  // session's own region, each row carrying price / volRemaining / stationID /
  // range / minVolume / jumps.
  Object.freeze({ service: "marketProxy", method: "GetOrders" }),
  // The player's OWN market position: open orders, closed-order history,
  // completed transactions, and how much ISK / how many items are locked in
  // escrow behind their open orders.
  Object.freeze({ service: "marketProxy", method: "GetCharOrders" }),
  Object.freeze({ service: "marketProxy", method: "GetMarketOrderHistory" }),
  Object.freeze({ service: "marketProxy", method: "CharGetTransactions" }),
  Object.freeze({ service: "marketProxy", method: "GetCharEscrow" }),
  // Price history for a type: the daily low/high/average and traded volume.
  // "Old" and "new" are the two halves retail's price graph draws (the daemon
  // answers one history and the service splits it), so both are listed.
  Object.freeze({ service: "marketProxy", method: "GetOldPriceHistory" }),
  Object.freeze({ service: "marketProxy", method: "GetNewPriceHistory" }),
  Object.freeze({ service: "marketProxy", method: "GetHistoryForManyTypeIDs" }),
  // The "what is cheapest near me" summaries: best ask at this station, in this
  // system, and across the region. All three scope off the session's own
  // location and take no arguments.
  Object.freeze({ service: "marketProxy", method: "GetStationAsks" }),
  Object.freeze({ service: "marketProxy", method: "GetSystemAsks" }),
  Object.freeze({ service: "marketProxy", method: "GetRegionBest" }),
  // ⚠ marketProxy.GetCorporationOrders / CorpGetTransactions were DELIBERATELY
  // ABSENT here (corp market scope out of R16's slice) — the R62 plumbing sweep
  // below now allowlists them as READS, so they moved to the R62 pairs list.
  //
  // ⚠ THE PLEX READS were DELIBERATELY ABSENT here too (GetPlexOrders /
  // GetPlexBest / GetPlexHistory / GetPlexOldPriceHistory / GetPlexNewPriceHistory)
  // — the R62 batch below allowlists all five (PLEX trades through a dedicated
  // service path but the reads are session-region-scoped like the order book).
  // The PLEX WRITES (PlacePlexSellOrder / ModifyPlexCharOrder — real-money-
  // adjacent) and the batch BuyMultipleItems stayed DELIBERATELY ABSENT here for
  // most of the sweep; the R106 FINANCIAL batch (see below) now allowlists all
  // three, BFF confirm-gated + never fired live.
  //
  // ⚠ marketProxy.marketQuote DOES NOT EXIST AND IS NOT MISSING. `marketQuote`
  // is a CLIENT-LOCAL retail service: caching, sorting, jump-distance filtering,
  // skill-based order limits and best-bid matching are all implemented in the
  // client, not the server. The browser implements that logic itself
  // (web/src/bridge/market.ts); there is no server call to allowlist.
  //
  // R16 market WRITES. These are the first calls in the whole web-client ladder
  // that SPEND THE PLAYER'S ISK, and they spend it for real: the handlers run
  // debitCharacterWallet / creditCharacterWallet, write escrow records, charge
  // a broker's fee and an SCC surcharge, and enforce skill-gated order limits.
  // They are fenced exactly as R12's DestroyFitting, R14's TrashItems and R15's
  // InstallJob are — the BFF refuses each route outright without an explicit
  // `confirm: true`, and the web UI puts a two-step confirm in front of that
  // showing the item, price x quantity, the ESTIMATED broker's fee and the
  // player's current ISK.
  //
  // ⚠ EXACT POSITIONAL SIGNATURES. Each of these reads its arguments by INDEX;
  // there are no kwargs anywhere in the market surface, and a mis-ordered
  // argument list is a silently different order, not an error.
  //
  // PlaceBuyOrder([stationID, typeID, price, quantity, orderRange, minVolume,
  //                duration, useCorp, expectedBrokersFee])
  //   The retail client rounds `price` to 2dp and REJECTS a price above
  //   MARKET_MAX_ORDER_PRICE before sending; the bridge does the same, so the
  //   player gets a clear message instead of an opaque server refusal.
  //   `useCorp` is always false — assertPersonalMarketOnly refuses otherwise,
  //   and corp market scope is out of slice.
  //
  // ⚠ `expectedBrokersFee` IS A RATE, NOT AN AMOUNT, and it is a CHECK, not a
  //   payment. validateExpectedBrokerFeePercentage compares it against the
  //   character's real brokerCommissionRate and REFUSES the whole order with
  //   MktBrokersFeeUnexpected2 if they differ — its purpose is to stop a player
  //   being charged a rate other than the one they were shown. The browser
  //   cannot compute that rate: it depends on the character's Broker Relations
  //   level and their standings toward the station's owner, and NO allowlisted
  //   read answers either. Sending a guess would refuse legitimate orders from
  //   any trained trader. So the bridge sends null (the documented "do not
  //   check" value) and the honesty is delivered the other way round: the panel
  //   labels its 3% figure an ESTIMATE and reports the amount the server
  //   ACTUALLY charged, from a wallet re-read, once the order lands.
  Object.freeze({ service: "marketProxy", method: "PlaceBuyOrder" }),
  // PlaceMultiSellOrder([itemList, useCorp, duration, expectedBrokersFee])
  //   Selling is item-based, not type-based: each itemList entry must carry
  //   {itemID, typeID, stationID, price, quantity} because the goods being sold
  //   are specific stacks out of a specific hangar, which the handler moves
  //   into escrow. There is no single-sell method — this one call is the whole
  //   sell surface.
  Object.freeze({ service: "marketProxy", method: "PlaceMultiSellOrder" }),
  // CancelCharOrder([orderID, regionID])
  //   ⚠ The server IGNORES regionID and reads only args[0]; it re-derives the
  //   region from the order it loads. The trailing argument is still sent
  //   because that is the retail shape. Cancelling a BUY order refunds the ISK
  //   held in escrow but NOT the broker's fee already paid; cancelling a SELL
  //   order moves the goods back to the seller.
  Object.freeze({ service: "marketProxy", method: "CancelCharOrder" }),
  // ModifyCharOrder([orderID, newPrice, bid, stationID, solarSystemID,
  //                  oldPrice, range, volRemaining, issueDate])
  //   ⚠ The server reads only args[0] and args[1] and RE-DERIVES everything
  //   else from the order it loads — so the seven trailing arguments cannot
  //   change the outcome, and a client that got one wrong would not be
  //   corrected by an error. They are sent anyway because the shape is the
  //   retail one. Repricing charges a modification fee and, on a buy order,
  //   adjusts the escrow up or down.
  Object.freeze({ service: "marketProxy", method: "ModifyCharOrder" }),
  // R106 (WB-MARKET, the LAST plumbing batch — CLOSES THE SWEEP). The three
  // FINANCIAL marketProxy writes deferred the whole sweep because they SPEND /
  // COMMIT real value. The operator EXPLICITLY authorized them on 2026-07-23.
  // Each is CONFIRM-GATED at the BFF (requireWriteConfirmation refuses 400
  // CONFIRMATION_REQUIRED with NO dispatch unless confirm:true) with an
  // extra-explicit financial confirm message, and NONE is ever fired live in
  // the plumbing pass — reachability-only.
  //   • PlacePlexSellOrder([entry{itemID,typeID,stationID,price,quantity},
  //     useCorp, durationDays, expectedBrokerFee]) — lists PLEX for sale on the
  //     live market. Session-scoped (executeSellEntry works from the session's
  //     own inventory; useCorp asserted personal-only).
  //   • ModifyPlexCharOrder([orderID, newPrice, ...retail-tail]) — re-prices one
  //     of the caller's own PLEX orders. Delegates to Handle_ModifyCharOrder,
  //     which loads the order via loadCharacterOrderOrThrow — an OWNER CHECK that
  //     throws unless order.owner_id === session characterID. Not a foreign-order
  //     mutator.
  //   • BuyMultipleItems([stationID, itemList, useCorp]) — batch instant-buy that
  //     SPENDS ISK immediately, once per list entry, from the SESSION char's
  //     wallet (characterID/regionID read from the session; useCorp asserted
  //     personal-only). The most consequential of the three. A stray click cannot
  //     fire it: the BFF confirm-gate stands in front.
  Object.freeze({ service: "marketProxy", method: "PlacePlexSellOrder" }),
  Object.freeze({ service: "marketProxy", method: "ModifyPlexCharOrder" }),
  Object.freeze({ service: "marketProxy", method: "BuyMultipleItems" }),
  //
  // R17 MAIL. The whole retail mail surface is TOP-LEVEL (sm.RemoteSvc('mailMgr'))
  // — no MachoBindObject step — so these four ride the ordinary callMethod seam
  // and add no bridge machinery.
  //
  // ⚠ THE INBOX IS A DELTA SYNC, NOT A LIST CALL. There is no "give me my mail"
  // method. SyncMail(firstID, lastID) takes the min and max messageID the CLIENT
  // already holds and answers only what changed on either side of that window:
  // {newMail, oldMail, mailStatus}. A cold client — which the browser always is,
  // because it caches nothing across a page load — passes [null, 0], and that
  // is the whole inbox. Passing the wrong pair silently returns a partial
  // mailbox rather than an error, so the BFF always cold-starts.
  Object.freeze({ service: "mailMgr", method: "SyncMail" }),
  // GetMailHeaders([[messageID, ...]]) backfills any messageID that appeared in
  // the sync's mailStatus rows but whose header the client does not hold. ⚠ The
  // argument is a LIST NESTED IN args[0], not a spread of ids.
  Object.freeze({ service: "mailMgr", method: "GetMailHeaders" }),
  // GetBody(messageID, shouldMarkAsRead) — the message text.
  //
  // ⚠ IT RETURNS A ZLIB-DEFLATED BUFFER, NOT TEXT. mailState.getCompressedBody
  // answers zlib.deflateSync(body), which crosses the bridge JSON-serialized as
  // {type:"Buffer", data:[...]}. The BFF inflates it (zlib.inflateSync) and
  // hands the browser plain text; the browser never sees a compressed byte.
  // Rendering the raw return would show the player a wall of numbers.
  //
  // ⚠ IT IS A WRITE WHEN shouldMarkAsRead IS 1: it clears the unread bit and
  // pushes OnMailUpdatedByExternal to the character's OTHER sessions. Opening a
  // message is the player's own deliberate act, so it needs no confirm gate —
  // but it is the reason this pair is not merely a read.
  Object.freeze({ service: "mailMgr", method: "GetBody" }),
  // SendMail([toCharacterIDs, toListID, toCorpOrAllianceID, title, body,
  //           isReplyTo, isForwardedFrom])
  //   ⚠ EXACT POSITIONAL SIGNATURE, read by index in Handle_SendMail; a
  //   mis-ordered list is a silently different message, not an error.
  //   ⚠ args[0] IS A LIST of characterIDs on the WAY IN (it runs through
  //   normalizePositiveIDList) even though the header rows read back a
  //   COMMA-JOINED STRING on the way out. The two shapes are not symmetric.
  //   The bridge only ever sends a character list: toListID and
  //   toCorpOrAllianceID are sent as null, because mailing lists are a separate
  //   service and corp/alliance-wide mail fans out to every member — neither is
  //   in this slice.
  Object.freeze({ service: "mailMgr", method: "SendMail" }),
  // R86 Phase-3 top-level WRITES — mail (W-MAIL) + mailing lists (W-MLIST), the
  // FIRST writes batch. Every one is confirm-gated at the BFF (a stray click or
  // stray POST cannot fire it) and every one derives its mailbox / membership
  // from the SESSION character (resolveSessionCharacterID) — no arg a browser
  // sends redirects the mutation at another character's mailbox. The two
  // permanent-delete writes (DeleteMail / EmptyTrash) are the extra-danger pair:
  // reachable and confirm-gated, but never fired on the live world.
  //
  // ⚠ ARG-INJECTION: these all take a caller-supplied messageID / labelID /
  // listID list. mailState scopes every mutation to the SESSION character's own
  // rows (a messageID the session does not own simply is not in its status
  // table, so the write is a silent no-op), so the mail writes are NOT a foreign
  // mutation. mailingListsMgr.Join/Leave take a listID the session does not
  // own — Join self-adds the session char, Leave self-removes; neither mutates
  // another character. Create allocates a new list owned by the session char.
  // None mutate a FOREIGN entity's state. Kept plumbed; see docs.
  Object.freeze({ service: "mailMgr", method: "MarkAsRead" }),
  Object.freeze({ service: "mailMgr", method: "MarkAsUnread" }),
  Object.freeze({ service: "mailMgr", method: "MoveToTrash" }),
  Object.freeze({ service: "mailMgr", method: "MoveFromTrash" }),
  Object.freeze({ service: "mailMgr", method: "MoveAllToTrash" }),
  Object.freeze({ service: "mailMgr", method: "MarkAllAsRead" }),
  Object.freeze({ service: "mailMgr", method: "DeleteMail" }),
  Object.freeze({ service: "mailMgr", method: "EmptyTrash" }),
  Object.freeze({ service: "mailMgr", method: "CreateLabel" }),
  Object.freeze({ service: "mailMgr", method: "EditLabel" }),
  Object.freeze({ service: "mailMgr", method: "DeleteLabel" }),
  Object.freeze({ service: "mailMgr", method: "AssignLabels" }),
  Object.freeze({ service: "mailMgr", method: "RemoveLabels" }),
  Object.freeze({ service: "mailingListsMgr", method: "Create" }),
  Object.freeze({ service: "mailingListsMgr", method: "Join" }),
  Object.freeze({ service: "mailingListsMgr", method: "Leave" }),
  // ⚠ mailMgr's REMAINING mutators stay absent (ReplaceLabels, the *ByLabel /
  // *ByList bulk variants, PokePlayerAboutChatMsgGm) and so do mailingListsMgr's
  // MODERATION writes (Delete, KickMembers, Set*Access, welcome-mail). The
  // allowlisted set above is exactly what the mail panel drives.
  //
  // R17 CONTRACTS (READS ONLY). Like mail and market, the whole contract
  // surface is TOP-LEVEL (sm.ProxySvc('contractProxy')) — no MachoBindObject
  // step — so these ride the ordinary callMethod seam.
  //
  // ⚠ THE SERVICE-NAME TRAP, AND IT IS THE SAME SHAPE AS R16's. There are TWO
  // contract services registered and the obvious one is the wrong one.
  // `contractMgrService.js` (service name "contractMgr") is 86 lines of DEAD
  // STUBS: GetLoginInfo answers three empty rowsets, SearchContracts answers an
  // empty list, NumOutstandingContracts answers 0 — every method is hardcoded
  // empty and the retail client never calls it. The live implementation —
  // escrow, item transfer, wallet debits, courier delivery — is
  // `contractProxyService.js`, registered as **"contractProxy"**. Allowlisting
  // "contractMgr" would produce a contracts page that renders perfectly and is
  // silently, permanently empty, which is INDISTINGUISHABLE from the empty
  // world described below. Only contractProxy pairs are listed here,
  // "contractMgr" is deliberately absent, and a test refuses it BY NAME.
  //
  // ⚠ A PUBLIC BROWSE IS LEGITIMATELY EMPTY, AND THAT IS NOT A BUG. There is
  // NO NPC/seed contract generator anywhere in the repo — `createContract`
  // exists only in contractRuntimeState.js and its own handler, and nothing
  // calls it at startup. So SearchContracts answers nothing until a player
  // creates a contract, and the panel says so in as many words rather than
  // looking broken. Do not go hunting for a bug here.
  //
  // ⚠ SearchContracts IS KWARGS-ONLY. Handle_SearchContracts ignores `args`
  // entirely and reads every filter off `kwargs` (contractType, availability,
  // startNum, ...). Passing filters positionally silently searches with NO
  // filters at all — a browse that answers everything instead of couriers.
  Object.freeze({ service: "contractProxy", method: "SearchContracts" }),
  // The player's OWN contracts, three ways. All three scope off the SESSION:
  // GetMyCurrentContractList(isAccepted, forCorp) and
  // GetMyExpiredContractList(forCorp) take no owner at all.
  //
  // ⚠ GetContractListForOwner([ownerID, filtStatus, contractType, issuedBy])
  // DOES take an ownerID, and the server reads only args[0..2] — the trailing
  // argument and both documented kwargs (num, startContractID) are ignored, so
  // a caller cannot page it and a caller that thinks it can gets the first page
  // every time. It is listed because it is the only way to filter one's own
  // contracts BY STATUS, and the BFF only ever passes the session's own
  // characterID; it is the one read here that could name another owner, so the
  // browser never chooses that argument.
  Object.freeze({ service: "contractProxy", method: "GetContractListForOwner" }),
  Object.freeze({ service: "contractProxy", method: "GetMyCurrentContractList" }),
  Object.freeze({ service: "contractProxy", method: "GetMyExpiredContractList" }),
  // The summary counts behind the panel's headline (assignedToMe /
  // needsAttention / inProgress) — both session-scoped, neither takes an
  // argument.
  Object.freeze({ service: "contractProxy", method: "GetLoginInfo" }),
  Object.freeze({ service: "contractProxy", method: "CollectMyPageInfo" }),
  // GetContract(contractID) — the detail bundle: the contract row, its items,
  // and its start/end route endpoints (which the panel renders as NAMES).
  Object.freeze({ service: "contractProxy", method: "GetContract" }),
  //
  // R91 Phase-3 top-level WRITES — contracts (W-CONTRACT, 11). Every one is
  // confirm-gated at the BFF (a stray click or stray POST cannot fire it). The
  // three ISK/item movers (AcceptContract, PlaceBid) and the four destructive
  // writes (DeleteContract, DeleteMultipleContracts + the two notification
  // deletes) plus the admin GM_ExpireContract are reachable + confirm-gated but
  // NEVER fired on the live world in the plumbing pass.
  //
  // ⚠ ARG-INJECTION — checked, GUARDED (unlike the contract READS): the write
  // handlers that take a caller-supplied contractID validate the contract's
  // party against the SESSION server-side. deleteContract throws unless
  // isIssuedBySession; acceptContract throws unless canAcceptContract (and
  // refuses "your own unassigned contract"); deleteMultipleContracts loops
  // deleteContract so inherits the guard. PlaceBid / FinishAuction / SplitStack /
  // the two notification deletes are SERVER-SIDE STUBS (return null/false) in
  // this world. GM_ExpireContract is GM-only and returns false for a normal
  // session (a 403-equivalent at the handler). Nothing added to
  // arg-injection-leak-handoff.md on the write side — the write guards hold.
  Object.freeze({ service: "contractProxy", method: "CreateContract" }),
  Object.freeze({ service: "contractProxy", method: "AcceptContract" }),
  Object.freeze({ service: "contractProxy", method: "CompleteContract" }),
  Object.freeze({ service: "contractProxy", method: "DeleteContract" }),
  Object.freeze({ service: "contractProxy", method: "DeleteMultipleContracts" }),
  Object.freeze({ service: "contractProxy", method: "PlaceBid" }),
  Object.freeze({ service: "contractProxy", method: "FinishAuction" }),
  Object.freeze({ service: "contractProxy", method: "SplitStack" }),
  Object.freeze({ service: "contractProxy", method: "DeleteNotification" }),
  Object.freeze({ service: "contractProxy", method: "DeleteContractNotification" }),
  Object.freeze({ service: "contractProxy", method: "GM_ExpireContract" }),
  //
  // ⚠ contractProxy's REMAINING mutator stays absent: SetContractExpired
  // (Handle_SetContractExpired -> false stub) is out of slice and a test refuses
  // it BY NAME. The reads above are unchanged.
  //
  // --- R23 targeting + module activation (the GENERIC in-space action layer) --
  //
  // These six dogmaIM pairs are NOT a mining feature. Locking a target and
  // switching a module on are the two verbs behind EVERY in-space action in
  // this game: a mining laser, a turret, a launcher, a salvager, a remote
  // repper and an ewar module are all the same two calls with a different
  // module itemID and a different effect name. They are listed here once, as a
  // primitive, so a later combat goal adds NO new pairs at all.
  //
  // All six are TOP-LEVEL calls on the live in-space session: each handler
  // resolves the character's active ship and scene from the session itself, so
  // there is no bind step (unlike invbroker/beyonce/reprocessingSvc).
  //
  // AddTarget(targetID) -> [pendingFlag, targetIDList]. The handler owns every
  // lock rule (max locked targets, targeting range, sensor strength, already
  // locked, invalid/absent ball) and raises its OWN UserError; the bridge
  // surfaces that reason verbatim and never pre-judges a lock.
  Object.freeze({ service: "dogmaIM", method: "AddTarget" }),
  // RemoveTarget(targetID) drops ONE lock; CancelAddTarget(targetID) aborts a
  // lock that is still in its pending/acquiring phase. Both return null, so the
  // BFF re-reads GetTargets to learn what actually happened.
  Object.freeze({ service: "dogmaIM", method: "RemoveTarget" }),
  Object.freeze({ service: "dogmaIM", method: "CancelAddTarget" }),
  // GetTargets() -> the flat list of currently locked target itemIDs. This is
  // the ONLY authority on what is locked: it is the read that turns a 200 from
  // AddTarget/RemoveTarget into proof.
  Object.freeze({ service: "dogmaIM", method: "GetTargets" }),
  //
  // ⚠ RemoveTargets, ClearTargets and GetTargeters are DELIBERATELY ABSENT and
  // sit on the SAME service — a service-granular allowlist would have handed
  // the browser a one-call "drop every lock" and a read of who is locking YOU.
  // The page unlocks one target at a time, by name, so a stray click can only
  // ever cost one lock. GetTargeters is a threat-intel read the page does not
  // offer. All three are refused before dispatch, and a test names them.
  //
  // Activate(moduleItemID, effectName, targetID, repeat) turns a module ON.
  // `repeat` is -1 for a continuous cycle and 0 for a single cycle, exactly as
  // the retail client sends it. An unknown effect name is lowercased by the
  // handler, and an EMPTY effect name falls back to the module's own default
  // activation effect resolved from its typeID — so the browser never has to
  // know, or guess, which effect a given module runs. The handler owns
  // target-required, target-locked, range, capacitor, charge/crystal
  // compatibility and module-not-online, and answers each with its own reason.
  Object.freeze({ service: "dogmaIM", method: "Activate" }),
  // Deactivate(moduleItemID, effectName) turns it back off.
  Object.freeze({ service: "dogmaIM", method: "Deactivate" }),
  //
  // ⚠ Activate/Deactivate ALSO accept the "online" effect name, which is the
  // second route to the online/offline toggle already covered by
  // SetModuleOnline/TakeModuleOffline above. That is the handler's own
  // behaviour, not a widening: the same gating and the same refusals apply.
  //
  // --- R29: ammo. The one place the claim above was WRONG -------------------
  //
  // The R23 note says a later combat goal "adds NO new pairs at all". Firing
  // needed none — Activate above really is the whole verb. AMMO needed two,
  // and R29 proved it on the live wire rather than by reading:
  //
  //   * Loading a charge into an EMPTY module DOES work through the existing
  //     invbroker Add path (destination = the ship, flag = the module's own
  //     slot flag). Measured: 1x EMP M moved into a 220mm AutoCannon's slot,
  //     hangar stack 500 -> 499. But Add moves ONE ITEM PER CALL, so filling a
  //     turret means one round-trip per round — not a usable weapon.
  //   * SWAPPING one charge type for another through that same Add is a SILENT
  //     DECLINE. Measured: Fusion M -> a slot already holding EMP M answered
  //     200 with a null body and NO reason; the slot still held EMP M and the
  //     Fusion M source stack was still 500. liveFittingState.js raises
  //     CHARGES_USE_LOAD_AMMO, a string produced in exactly one place and
  //     mapped nowhere, so nothing reaches the caller.
  //
  // LoadAmmo(shipID, moduleIDs[], chargeItemIDs[], ammoLocationID) is the only
  // call that loads a full stack in one go and the only one that can replace a
  // charge already in a module. It reads its source from the ship's cargo hold
  // when ammoLocationID is the ship and from the station hangar otherwise, and
  // it owns every refusal itself — wrong charge group, wrong size, module not
  // found, not owned, not on this ship — so the bridge pre-judges nothing.
  Object.freeze({ service: "dogmaIM", method: "LoadAmmo" }),
  // UnloadAmmo(shipID, moduleIDs[], destination) is the reverse, and is listed
  // WITH LoadAmmo deliberately: a rack that can only ever fill a module and
  // never empty one strands the charge, and the player's only way back would be
  // to unfit the weapon itself.
  Object.freeze({ service: "dogmaIM", method: "UnloadAmmo" }),
  //
  // ⚠ LoadAmmoToBank is DELIBERATELY ABSENT. It sits on the same service and
  // would load every weapon in a bank from one call; the rack loads one module
  // at a time, by name, so a stray click can only ever cost one module's
  // charge. Refused before dispatch, and a test names it.
  //
  // --- R23 slice B: the mining loop ----------------------------------------
  //
  // Slice B adds no ACTION pairs at all. Mining a rock is slice A's generic
  // AddTarget + Activate with a mining laser's itemID; hauling the ore home is
  // R3's invbroker.Add. What is missing is one READ and the refinery.
  //
  // miningScanMgr.perform_scan() -> [[entityID, yieldTypeID, remainingQuantity]]
  // for every mineable ball in survey range. The survey scanner, and the retail
  // read that says HOW MUCH ore a rock has left. Session-scoped, takes no
  // argument, and is side-effect free.
  Object.freeze({ service: "miningScanMgr", method: "perform_scan" }),
  // reprocessingSvc: the retail bound-object two-step at a docked station. The
  // moniker is Moniker('reprocessingSvc', stationID) via MachoBindObject;
  // GetQuotes and Reprocess dispatch on that bound object.
  //
  // GetQuotes(itemRefs) -> [tax, efficiencyByTypeID, quotesByItemID]. A pure
  // read, and the source of the ISK TAX figure the page must show BEFORE the
  // player commits — reprocessing DEBITS that tax from the wallet.
  Object.freeze({ service: "reprocessingSvc", method: "MachoBindObject" }),
  Object.freeze({ service: "reprocessingSvc", method: "GetQuotes" }),
  // ⚠ Reprocess CONSUMES THE INPUT ITEMS AND CHARGES ISK. It is listed because
  // it is the only way to turn ore into minerals, and the BFF gates it behind
  // an explicit `confirm: true` flag (and the page behind a two-step
  // confirmation) exactly like invbroker.DestroyFitting — neither a stray click
  // nor a stray POST can consume a hold full of ore.
  Object.freeze({ service: "reprocessingSvc", method: "Reprocess" }),
  //
  // --- In-space ore compression ----------------------------------------------
  //
  // inSpaceCompressionMgr.CompressItemInSpace(itemID, facilityBallID) — the
  // fleet mechanic: a mining support ship on grid running an Industrial Core and
  // a compression module is a FACILITY, and a fleet-mate inside its range can
  // compress ore that is sitting in their own ship.
  //
  // It is listed for the same reason Reprocess is: it is the only way to do the
  // thing, and every guard that matters is the SERVER's, not the caller's.
  // `resolveInSpaceCompressionContext` (services/mining/miningIndustry.js) checks,
  // in this order, that the caller is in space, that the named ball exists in the
  // caller's own scene, that it has live compression typelists (i.e. the modules
  // really are running), that it is either the caller's OWN ship or one flown by
  // a character in the same FLEET, and that it is inside the facility's range.
  // The handler then refuses any item the caller does not own or that is not in
  // their own ship. So a caller cannot point this at a stranger's Rorqual, at a
  // ball in another system, or at somebody else's ore.
  //
  // ⚠ IT REPLACES THE STACK IN PLACE: the ore becomes its compressed type at the
  // same quantity (`compressInventoryItem`), which in this build is ~100x less
  // volume. Not destructive — compressed ore reprocesses to the same minerals —
  // but it is a mutation, so the BFF gates it behind an explicit `confirm: true`
  // like every other write on that side.
  Object.freeze({ service: "inSpaceCompressionMgr", method: "CompressItemInSpace" }),
  //
  // --- R25 slice A: drones ---------------------------------------------------
  //
  // Drones are the first thing in this bridge that keeps FIGHTING once the
  // browser stops asking. That is not a gap — it is the whole point, and it is
  // the server's behaviour, not ours: an idle combat drone AUTO-ENGAGES whatever
  // shoots the ship it was launched from (`droneRuntime.noteIncomingAggression`,
  // driven from the space runtime's damage path, gated on the drone's own
  // `behaviorSettings.aggressive`, which DEFAULTS TRUE). So the minimum viable
  // defence for a miner is LAUNCHING, not commanding. CmdEngage below is for
  // CHOOSING a victim; it is not what makes a player defended.
  //
  // ⚠ THE SERVICE SPLIT IS REAL AND NON-OBVIOUS. Launching and scooping are
  // `ship` (services/ship/shipService.js); every in-space drone ORDER is
  // `entity` (services/drone/entityService.js). One feature, two services, and
  // a reader who assumes "drones live on one service" allowlists half of it.
  //
  // ship.LaunchDrones([[itemID, qty], …], whoseBehalfID, ignoreWarning) moves
  // drones out of the ship's drone bay (flag 87) and materializes them in space.
  //
  // ⚠ IT ANSWERS 200 WHEN IT REFUSES. Handle_LaunchDrones returns an EMPTY dict
  // on outright failure, and on partial failure returns a dict whose per-itemID
  // list holds an ERROR TUPLE instead of a launched droneID. Bandwidth
  // (attribute 1271), the active-drone cap (attribute 352), a wrong flag and a
  // missing stack are all reported that way. Neither the BFF nor the page may
  // read a 200 as "it launched": the authority is the SPACE SNAPSHOT, which
  // projects every drone in space with its controller and its owner.
  Object.freeze({ service: "ship", method: "LaunchDrones" }),
  // ship.ScoopDrone([droneItemIDs]) pulls drones back into the bay by hand.
  // CmdReturnBay below already scoops automatically once a returning drone is
  // within 2500 m, so this is the manual fallback for a drone that was
  // abandoned or left behind — not the normal recall path.
  Object.freeze({ service: "ship", method: "ScoopDrone" }),
  //
  // entity.CmdEngage([droneIDs], targetID) — attack that ball.
  //
  // ⚠ It does NOT require the ship to have the target locked; the drone's own
  // visibility check is the gate. The page still drives it from the R23 locked
  // target, because "shoot the thing you deliberately locked" is the only
  // version of this a player can reason about — but that is a UI choice, not a
  // server rule, and the BFF does not pretend otherwise.
  Object.freeze({ service: "entity", method: "CmdEngage" }),
  // entity.CmdReturnBay([droneIDs]) — come home. The runtime flies them back and
  // scoops them into the bay itself once they are inside 2500 m; there is no
  // second call to make.
  Object.freeze({ service: "entity", method: "CmdReturnBay" }),
  // entity.CmdMineRepeatedly([droneIDs], targetID) — mining drones on a rock,
  // cycling until the rock is gone. Free yield alongside the R23 mining loop,
  // and the same call the runtime accepts for salvage drones on a wreck.
  Object.freeze({ service: "entity", method: "CmdMineRepeatedly" }),
  //
  // ⚠ CmdAssist, CmdGuard AND CmdUnanchor DO NOT EXIST ON THIS SERVER. They are
  // real verbs in the retail CLIENT and they read as entirely plausible
  // siblings of the four listed above — which is exactly why they are named
  // here and refused BY NAME in a test. `entity` has no Handle_CmdAssist,
  // Handle_CmdGuard or Handle_CmdUnanchor at all, so allowlisting one would not
  // even fail loudly: BaseService.callMethod answers null for an unknown
  // method, and the browser would get a cheerful 200 for an order that was
  // never given. Deny-by-default is what keeps that from being buildable.
  //
  // ⚠ CmdAbandonDrone, CmdReconnectToDrones, CmdReturnHome and CmdSalvage DO
  // exist on `entity`. Through R101 they were DELIBERATELY ABSENT from the R25 UI
  // surface (a service-granular allowlist would have handed the browser
  // CmdAbandonDrone, which PERMANENTLY DISOWNS a player's drones — one stray click,
  // and a flight of drones becomes someone else's salvage). R102 plumbs all four
  // as Phase-4 BOUND WRITES off the entity bind (allowlisted below), reachable ONLY
  // via confirm-gated BFF POST routes — CmdAbandonDrone with an extra-explicit
  // confirm message. The R25 in-space UI still offers only launch, engage, mine
  // and recall; the destructive verbs stay behind a confirm gate, never a stray
  // click.
  //
  // --- R28: the skill queue ---------------------------------------------------
  //
  // skillMgr.SaveNewQueue(queue, activate=<bool>) is the retail in-session write
  // for the whole queue. It is the ONLY write here: adding a skill, removing
  // one and reordering are all "save this list", exactly as retail does it.
  //
  // ⚠ WHY THIS PAIR EXISTS AT ALL, GIVEN /skill-queue ALREADY DOES THIS.
  // The gateway's POST /skill-queue path runs SAVE_SKILL_QUEUE under
  // AUTHORIZATION_POLICIES.OFFLINE_COMPANION, and that policy requires the
  // character to be **offline** (characterCommandRuntime.authorizeInsideLane:
  // controlState === "offline" && online === false). A browser client that has
  // selected a character HOLDS A SESSION, so charService records a retail
  // session and the control state is `retail_client` — measured, not assumed.
  // The offline path is therefore structurally unreachable from a logged-in web
  // client; it is a companion-app surface for a character who is NOT playing.
  // A player looking at their own skill sheet in this client IS playing, so the
  // write has to be the retail one, on the live session, like every other panel.
  //
  // Both paths land in the SAME `skillQueueRuntime.saveQueue`, so the 11 public
  // refusal codes are identical — they simply arrive as CALL_REFUSED carrying
  // the bare code (these throwWrappedUserError sites pass no `info`/`notify`
  // prose, so readWrappedUserErrorRefusal falls through to the code) instead of
  // as a mapped command error.
  //
  // ⚠ NO READ PAIR IS LISTED. skillMgr.GetMySkillInfo / GetSkillQueue would
  // return the marshaled retail shapes; GET /skills below answers the same
  // authority (`skillQueueRuntime.getQueueSnapshot`) as plain JSON with the
  // names, groups and level thresholds already resolved, and needs no session.
  // One authority, read through the route that does not make the browser decode
  // a Rowset.
  //
  // ⚠ AbortTraining, InjectSkillpoints, ExtractSkills, PurchaseSkills,
  // ApplyFreeSkillPoints* and InjectSkillIntoBrain all exist on `skillMgr` and
  // are DELIBERATELY ABSENT. Every one of them spends something the player
  // cannot get back — ISK, an injector, an extractor, or unallocated SP that
  // can only be applied once. Pausing training is `SaveNewQueue([], ...)`, which
  // costs nothing and is reversible, so the page never needs AbortTraining.
  Object.freeze({ service: "skillMgr", method: "SaveNewQueue" }),
  //
  // --- R37 personal assets (READS ONLY) -------------------------------------
  //
  // "Where is my stuff, across the whole cluster." `charMgr` had ZERO pairs
  // before this goal, so these three are the entire charMgr surface the browser
  // can reach — and charMgr is a BIG service (character notes, public info,
  // clone/jump state, ...), which is exactly why the allowlist is pair-granular
  // rather than service-granular.
  //
  // The retail moniker is Moniker('charMgr', (charID, 10002)) — the global
  // ASSETS container — via MachoBindObject; ListStations and ListStationItems
  // dispatch on that bound object. charMgrService delegates all of it to
  // charMgrGlobalAssets.js, whose _parseBindContext REFUSES any containerID
  // that is not 10002, so this bind cannot be steered at another part of
  // charMgr even by a caller that tries.
  Object.freeze({ service: "charMgr", method: "MachoBindObject" }),
  // ListStations() -> a CRowset of every station holding this character's
  // items, with an itemCount per station. This one call IS the feature; the
  // browser must never aggregate assets itself by walking containers.
  //
  // ⚠ It scopes off the SESSION (or the bound charID), never off an argument —
  // there is no way to ask it about somebody else's assets.
  Object.freeze({ service: "charMgr", method: "ListStations" }),
  // ListStationItems(stationID) -> what is at ONE of those stations, as a list
  // of packedrows. Called only for a station the player has expanded, so the
  // panel does not fan out |stations| reads on first paint.
  Object.freeze({ service: "charMgr", method: "ListStationItems" }),
  //
  // ⚠ charMgr.List / ListIncludingContainers / GetAssetWorth ARE DELIBERATELY
  // ABSENT. They sit beside the two above on the same bound object and each
  // would be a strictly WIDER read: List and ListIncludingContainers answer
  // every item the character owns anywhere in one payload (the latter walking
  // into every container), and GetAssetWorth prices the lot. The panel asks
  // "which stations, and what is at the one I opened", which the two listed
  // pairs answer exactly; nothing on screen needs a cluster-wide item dump or a
  // net-worth figure. Refused before dispatch, and a test names them.
  //
  // ⚠ NO MUTATOR IS REACHABLE HERE. The global-assets object is read-only by
  // construction — charMgrGlobalAssets.js implements no write at all — but the
  // charMgr SERVICE around it does have writes (character notes, for one), and
  // a service-granular allowlist would have handed them to the browser. None is
  // listed.
  //
  // Setting a destination from an asset location adds NO pair: the route is
  // solved in the browser from the static map graph and flown with the beyonce
  // pairs R5a already listed.
  //
  // --- R38 player-structure NAMES (ONE READ) --------------------------------
  //
  // A player-owned Upwell structure is RUNTIME data. It exists only in the game
  // store, never in the static SDE, so both of the BFF's name paths
  // (/api/names kind:"station" and /api/map/resolve/:id) are structurally blind
  // to it and a docked Astrahus rendered as "an unnamed place". This is the one
  // pair that closes that hole, and it is the ENTIRE structureDirectory surface
  // the browser can reach.
  //
  // GetStructureInfo(structureID) -> util.KeyVal. For a structure the caller's
  // corporation does NOT own it returns buildBasicStructureInfoPayload: exactly
  // eight public keys (typeID, structureID, upkeepState, wars, ownerID,
  // solarSystemID, itemName, inSpace). `itemName` is the whole point; the rest
  // is what retail's own menu prefetch carries, pinned against the golden log
  // by structureDirectoryParity.test.js. A structure that does not exist
  // returns null — an honest "no such thing", not an empty name.
  Object.freeze({ service: "structureDirectory", method: "GetStructureInfo" }),
  //
  // ⚠ structureDirectory.GetStructures IS DELIBERATELY ABSENT, and NOT because
  // it is wider in the usual sense — it is the natural BATCH form of the pair
  // above (a list of IDs in, a dict out, one round trip instead of N) and was
  // the obvious thing to list. It is absent because of a real asymmetry in
  // eve.js: Handle_GetStructureInfo branches on ownership and hands non-owners
  // the basic eight-key payload, while Handle_GetStructures calls
  // buildStructureInfoPayload for EVERY requested ID with no ownership check at
  // all — fuel expiry, reinforcement timers, vulnerability schedule and core
  // state for structures the caller has nothing to do with. Allowlisting it
  // would put a defender's operational calendar behind an unauthenticated-by-
  // ownership browser read. The per-structure call costs round trips; the BFF
  // pays that with a cap and a short-lived cache rather than widening this.
  // Reported as a server defect, not fixed here (game mechanics are off-limits
  // to this client).
  //
  // ⚠ At THIS batch (R38 reads) no structure mutator was reachable. The wider
  // service tree carries RenameStructure, BoardStructure, EjectFromStructure and
  // the deployment/anchoring verbs, none listed here. (structureDirectory
  // .SetStructureDescription is later allowlisted by the R93 WRITES batch —
  // confirm-gated + canManageStructure-guarded; see the R93 block below.)
  //
  // --- R56 character sheet (READS ONLY) -------------------------------------
  //
  // "Who is this character." Four MORE charMgr pairs beside the three R37 asset
  // reads above — all TOP-LEVEL (sm.RemoteSvc("charMgr"), no MachoBindObject) —
  // and every one is side-effect free. The BFF (/api/bridge/character-sheet)
  // issues each with NO ARGUMENT, so resolveCharacterInfo falls through to
  // session.characterID and the read is scoped to the logged-in character, the
  // same way the retail charactersheet window reads its own sheet.
  //
  // GetPublicInfo3() -> {type:"list", items:[util.KeyVal{characterName,
  // corporationID, allianceID, securityStatus, ...}]}. PUBLIC identity (name,
  // corp, alliance, security status) — the same data any character can see about
  // another, which is why the shape carries no private field.
  Object.freeze({ service: "charMgr", method: "GetPublicInfo3" }),
  // GetCharacterDescription() -> a plain STRING (the bio). The simplest read on
  // the whole bridge: no marshaled wrapper, no id resolution.
  Object.freeze({ service: "charMgr", method: "GetCharacterDescription" }),
  // GetHomeStation() -> util.KeyVal carrying the medical-clone home station
  // (stationID + a redundant name/type/system set). The browser resolves the
  // stationID through /api/names (R7d), never rendering the number.
  Object.freeze({ service: "charMgr", method: "GetHomeStation" }),
  // GetCloneInfo() -> util.KeyVal{homeStationID, cloneStationID, clones(dict),
  // implants(dict of KeyVal{typeID, name, slot}), timeLastJump(long)}. The
  // implant typeIDs resolve to names through /api/names (R7d).
  Object.freeze({ service: "charMgr", method: "GetCloneInfo" }),
  //
  // ⚠ charMgr.GetPrivateInfo and charMgr.GetRecentShipKillsAndLosses are
  // DELIBERATELY ABSENT — left for a later goal, so the char-sheet batch stays
  // "who / home / clones". GetPrivateInfo carries balance + create date +
  // bloodline/race/ancestry (none of which has a name path), and the kills read
  // is a whole killmail surface of its own. charMgr's WRITES (character notes,
  // SetActiveShip, ...) remain absent for the same pair-granular reason the R37
  // block spells out; the refusal sweep in
  // server/tests/webGatewayServiceCall.test.js names GetPrivateInfo,
  // GetRecentShipKillsAndLosses and charMgr.MachoResolveObject to keep this a
  // fact. (charMgr.GetPublicInfo — the non-"3" sibling — WAS in that refusal
  // sweep; the R58 plumbing batch below allowlists it, so it moved to the pairs
  // list.)
  //
  // --- R57 plumbing sweep: top-level READS (fittings / kill rights / LP) -----
  //
  // The operator asked for these API calls PLUMBED (reachable + decodable) so
  // the UI is easy to build later; this batch adds NO UI, only the pipe. Every
  // pair below is a plain TOP-LEVEL read scoped server-side off the docked
  // session, side-effect free, with an existing Handle_* — no new handler is
  // added, and each mutating sibling on these services stays refused.
  //
  // charFittingMgr.GetFittings() -> {type:"dict", entries:[[fittingID,
  // util.KeyVal{name, description, shipTypeID, fitData(list of {type:"tuple",
  // items:[typeID, flagID, quantity]}), savedDate(long), ownerID}], ...]}. The
  // saved FITTING LIBRARY — distinct from the active-ship fit R12 reads. This is
  // the CHARACTER service (super("charFittingMgr")); corpFittingMgr and
  // allianceFittingMgr are DISTINCT services and are NOT listed. The handler
  // resolves the owner from the session (OWNER_SCOPE.CHARACTER,
  // assertSessionCanAccessOwner), so a browser cannot read another owner's
  // library. An empty library ({type:"dict", entries:[]}) is a REAL "no saved
  // fittings" answer, not a bug.
  //
  // R91 Phase-3 top-level WRITES — fittings (W-FIT, char side). SaveManyFittings
  // (bulk import), UpdateNameAndDescription (rename/redescribe), and the two
  // destructive deletes (DeleteFitting / DeleteManyFittings). Every one is
  // confirm-gated at the BFF; the deletes are reachable + confirm-gated but never
  // fired live in the plumbing pass. ⚠ ARG-INJECTION — GUARDED: every write
  // resolves the ownerID (resolveRequestedOwnerID) and then
  // assertSessionCanMutateOwner(session, ownerID, CHARACTER) BEFORE any store
  // mutation, so a caller-supplied foreign ownerID is a permission throw, never a
  // foreign mutation. SaveFitting / UpdateFitting (the singular siblings) stay
  // absent — the panel drives the bulk/rename/delete set only.
  Object.freeze({ service: "charFittingMgr", method: "GetFittings" }),
  Object.freeze({ service: "charFittingMgr", method: "SaveManyFittings" }),
  Object.freeze({ service: "charFittingMgr", method: "DeleteFitting" }),
  Object.freeze({ service: "charFittingMgr", method: "DeleteManyFittings" }),
  Object.freeze({ service: "charFittingMgr", method: "UpdateNameAndDescription" }),
  // bountyProxy.GetMyKillRights() -> {type:"list", items:[util.KeyVal{
  // killRightID, fromID, toID, expiryTime(long FILETIME), price(int|null),
  // restrictedTo(int|null)}]}. The kill rights this character HOLDS
  // (killRightState.listMyKillRights(session.characterID)) — a plain top-level
  // read scoped to the session, no args. fromID/toID/restrictedTo are entity ids
  // the browser resolves to names (R7d), never rendered as numbers. Every
  // mutating bountyProxy sibling (AddToBounty, SellKillRight, ActivateKillRight,
  // the transfer paths) stays refused. An empty list is a REAL "no kill rights"
  // answer. bountyProxy has no MachoBindObject — top-level only.
  Object.freeze({ service: "bountyProxy", method: "GetMyKillRights" }),
  // R57 LP store READS. LPSvc is already reached top-level for R6's
  // GetAllMyCharacterWalletLPBalances (proven live), so these three ride the
  // same seam. LPSvc does define MachoBindObject (a corp-scoped bound path), but
  // the character reads here are top-level and session-scoped exactly like the
  // R6 balances read; the bound path is not exercised.
  //
  // GetLPsForCharacter() -> {type:"list", items:[{type:"list", items:[
  // issuerCorpID, loyaltyPoints]}, ...]}. The character's per-issuer LP balances
  // as a list of [corpID, amount] pairs (getCharacterWalletLPBalances(
  // session.characterID)) — the SAME data as the R6 CRowset balances read but in
  // the retail LP-store list shape. issuerCorpID resolves to a name (R7d).
  Object.freeze({ service: "LPSvc", method: "GetLPsForCharacter" }),
  // GetLPExchangeRates() -> {type:"list", items:[]} and
  // GetAvailableOffersFromCorp() -> {type:"list", items:[]}. The LP-store
  // exchange-rate table and the offers a corp publishes for LP. Both are
  // currently EMPTY-BY-DESIGN in this world (the handlers return buildList([])
  // with no seed data); an empty list is a legitimate "no offers / no rates yet"
  // state, not a bridge bug — the plumbing is here for when data lands. The
  // mutating sibling TakeOffer (spends LP + ISK) stays refused.
  Object.freeze({ service: "LPSvc", method: "GetLPExchangeRates" }),
  Object.freeze({ service: "LPSvc", method: "GetAvailableOffersFromCorp" }),
  // --- R58 plumbing sweep: charMgr social/profile READS (no UI) -------------
  //
  // Second batch of the operator's plumbing sweep — the reads made reachable +
  // decodable so a later goal builds UI cheaply; NO panel/tab/store slice ships.
  // Eleven MORE charMgr pairs beside the three R37 asset reads and the four R56
  // char-sheet reads above — every one a plain TOP-LEVEL read (sm.RemoteSvc
  // "charMgr", no MachoBindObject; the R37 global-assets bind stays the ONLY
  // bound charMgr path), each with an existing Handle_* (no new handler is
  // added), and each mutating sibling on the service (AddContact / DeleteContacts
  // / BlockOwners, the note writers Add/Edit/Remove OwnerNote + SetNote, the
  // label editors, SetActivityStatus, SetCharacterDescription, ...) stays refused
  // before dispatch. Every read is scoped off the SESSION — resolveCharacterInfo
  // / sessionCharacterID fall through to session.characterID — and the BFF issues
  // each so scoped, so a browser cannot point one at another character.
  //
  // GetPublicInfo() -> util.KeyVal (the OLDER public-info shape; GetPublicInfo3
  // above wraps this same KeyVal in a list). Public identity fields.
  Object.freeze({ service: "charMgr", method: "GetPublicInfo" }),
  // GetHomeStationRow() -> util.KeyVal. The retail StarMap reads the home station
  // as a "row"; the handler delegates to GetHomeStation (the same KeyVal payload
  // GetHomeStation returns above), so the stationID resolves via /api/names (R7d).
  Object.freeze({ service: "charMgr", method: "GetHomeStationRow" }),
  // GetCharacterCreationDate() -> {type:"long"} FILETIME — the bigint-safe path.
  Object.freeze({ service: "charMgr", method: "GetCharacterCreationDate" }),
  // GetSettingsInfo() -> [<py2 codeobject buffer>, 0]: a marshaled tuple carrying
  // an opaque client-settings codeobject. The plumbing carries the bytes; no
  // decode of the codeobject is attempted (it is a client-side artifact, not data).
  Object.freeze({ service: "charMgr", method: "GetSettingsInfo" }),
  // GetContactList() -> util.KeyVal{addresses: Rowset, blocked: Rowset}: the
  // personal contacts / watchlist / blocked owners. Contact + blocked-owner IDs
  // stay as data for later name resolution (R7d), never forced into a label here.
  // Empty for Farmer (no contacts) is a legitimate empty state, not a bug.
  Object.freeze({ service: "charMgr", method: "GetContactList" }),
  // The character NOTES cluster. GetOwnerNoteLabels() -> Rowset[noteID, label]
  // (the note/folder index; the handler lazily seeds a default "S:Folders" note
  // so this is never empty). GetOwnerNote(noteID) -> list[util.KeyVal{noteID,
  // label, note}] (one owner note; the empty payload when the id is unknown).
  // GetNote(itemID) -> a bare STRING (a note the character keeps ABOUT an entity;
  // "" when none). The note WRITERS (Add/Edit/Remove OwnerNote, SetNote) stay
  // refused; only these three reads are listed.
  Object.freeze({ service: "charMgr", method: "GetOwnerNoteLabels" }),
  Object.freeze({ service: "charMgr", method: "GetOwnerNote" }),
  Object.freeze({ service: "charMgr", method: "GetNote" }),
  // GetPaperdollState() -> an INT (0..4, the recustomization state).
  // GetCohortsForCharacter() -> {type:"list", items:[]} — an empty-by-design stub
  // in this world (the handler always returns buildList([])); a legitimate empty
  // state, plumbing here for when cohort data lands.
  Object.freeze({ service: "charMgr", method: "GetPaperdollState" }),
  Object.freeze({ service: "charMgr", method: "GetCohortsForCharacter" }),
  // GetPrivateInfoOnCorpChange() -> a CachedMethodCallResult wrapping
  // util.KeyVal{corporationID, corporationDateTime(long)} — the corp the character
  // is in and when they joined. ⚠ THE KeyVal IS NESTED inside the cache wrapper's
  // substream (args[1].value), not at the top level; the decoder unwraps it.
  // corporationID resolves to a name (R7d). The cache-registration the handler
  // performs is versioning bookkeeping, not a game-state write (same as the
  // already-allowlisted map.GetStationInfo CachedMethodCallResult).
  Object.freeze({ service: "charMgr", method: "GetPrivateInfoOnCorpChange" }),
  //
  // ⚠ charMgr.GetRecentShipKillsAndLosses is DELIBERATELY LEFT UNWIRED. The
  // handler EXISTS (charMgrService.js:559) but is a whole killmail surface of its
  // own reserved for a later goal (the R56 note above marks it absent); this
  // batch honours that reservation. charMgr.GetPrivateInfo (balance + create date
  // + bloodline/race/ancestry, none with a name path) also stays absent. The
  // refusal sweep in webGatewayServiceCall.test.js names both, plus
  // MachoResolveObject.
  // --- R59 plumbing sweep: comms READS — mail aux / notifications / calendar --
  //
  // Third batch of the operator's plumbing sweep — the reads made reachable +
  // decodable so a later goal builds UI cheaply; NO panel/tab/store slice ships.
  // Eleven read-only pairs across four services, every one a plain TOP-LEVEL read
  // (machoNet binds each as ["<svc>", null] — unbound; no MachoBindObject), each
  // with an existing Handle_* (no new handler is added), and each mutating sibling
  // on these services stays refused before dispatch.
  //
  //   MAIL AUX. mailMgr's mailbox reads (SyncMail/GetMailHeaders/GetBody) are
  // already allowlisted in the R17 block above; these are the labels + mailing
  // lists that hang beside them.
  // mailMgr.GetLabels() -> {type:"dict", entries:[[labelID, util.KeyVal{id, name,
  //   color}], ...]}: the character's mail labels/folders, keyed by labelID.
  //   Session-scoped (resolveSessionCharacterID). The label WRITERS
  //   (CreateLabel/EditLabel/DeleteLabel/AssignLabels/RemoveLabels) stay refused.
  Object.freeze({ service: "mailMgr", method: "GetLabels" }),
  // mailingListsMgr is a DISTINCT service from mailMgr. All four reads scope off
  // the session character; the WRITERS (Create/Join/Leave/Delete/KickMembers/the
  // SetMembers* + SetDefaultAccess/SetEntitiesAccess editors) stay refused.
  // GetJoinedLists() -> {type:"dict", entries:[[listID, util.KeyVal{id, name,
  //   displayName, isMuted, isOperator, isOwner}], ...]}: the mailing lists this
  //   character has joined. Empty ({type:"dict", entries:[]}) for a character in
  //   no lists (Farmer) is a REAL empty state, not a bug.
  Object.freeze({ service: "mailingListsMgr", method: "GetJoinedLists" }),
  // GetInfo(listID) -> util.KeyVal{id, name, displayName, isMuted, isOperator,
  //   isOwner} | null. One list's summary; null for an unknown listID (the
  //   builder returns null when the summary is absent) — a legitimate "no such
  //   list" answer. listID is a mailing-list entity id kept as data (R7d).
  Object.freeze({ service: "mailingListsMgr", method: "GetInfo" }),
  // GetMembers(listID) -> {type:"dict", entries:[[memberID, accessLevel(int)],
  //   ...]}: the roster of a list as memberID -> access level. memberID stays a
  //   numeric entity id for later name resolution (R7d). Empty dict for an
  //   unknown/empty list is legitimate.
  Object.freeze({ service: "mailingListsMgr", method: "GetMembers" }),
  // GetSettings(listID) -> util.KeyVal{defaultAccess, defaultMemberAccess, cost,
  //   access:{type:"dict", entries:[[entityID, accessLevel], ...]}} | null. The
  //   list's access settings; null for an unknown list. entityIDs kept as data.
  Object.freeze({ service: "mailingListsMgr", method: "GetSettings" }),
  //
  //   NOTIFICATIONS. notificationMgr's three reads, all session-scoped
  // (getSessionCharacterID; characterID<=0 short-circuits to []). Each returns a
  // BARE JSON ARRAY of util.KeyVal notification DTOs {notificationID, typeID,
  // senderID, receiverID, processed(bool), created(long FILETIME), data} — NOT a
  // list wrapper (the handler returns the mapped array directly). senderID is an
  // entity id kept as data (R7d); the `data` payload is a per-type marshaled
  // dict/list carried through untouched. An empty array [] for a character with
  // no notifications (Farmer) is a REAL empty state. The notification WRITERS
  // (MarkGroupAsProcessed/MarkAllAsProcessed/MarkAsProcessed and the Delete* +
  // LogNotificationInteraction siblings) stay refused.
  // GetAllNotifications([fromID]) — every notification, optionally after fromID.
  Object.freeze({ service: "notificationMgr", method: "GetAllNotifications" }),
  // GetByGroupID(groupID) — the notifications in one group.
  Object.freeze({ service: "notificationMgr", method: "GetByGroupID" }),
  // GetUnprocessed() — the unread/unprocessed subset (no args).
  Object.freeze({ service: "notificationMgr", method: "GetUnprocessed" }),
  //
  //   CALENDAR. Two services. calendarMgr is a plain BaseService; calendarProxy
  // is ALSO a plain BaseService (extends baseService, super("calendarProxy"),
  // machoNet-bound ["calendarProxy", null] — top-level/unbound). ⚠ The sweep brief
  // flagged calendarProxy as a possible retail ProxySvc; in eve.js it is NOT — it
  // answers plain top-level /call exactly like calendarMgr, so it is wired here
  // (confirmed live). The event/response WRITERS on calendarMgr (Create*Event /
  // EditPersonalEvent / DeleteEvent / SendEventResponse / UpdateEventParticipants)
  // stay refused.
  // calendarMgr.GetResponsesForCharacter() -> {type:"list", items:[util.KeyVal{
  //   eventID, status(int)}, ...]}: this character's event responses. Empty list
  //   for a character with no invitations (Farmer) is a REAL empty state.
  Object.freeze({ service: "calendarMgr", method: "GetResponsesForCharacter" }),
  // calendarMgr.GetResponsesToEvent(eventID[, ownerID]) -> {type:"list", items:[
  //   util.KeyVal{characterID, status(int)}, ...]}: the responses TO one event.
  //   characterID kept as data (R7d). Empty for an unknown event is legitimate.
  Object.freeze({ service: "calendarMgr", method: "GetResponsesToEvent" }),
  // calendarProxy.GetEventList(month, year) -> [ {type:"list", items:[util.KeyVal{
  //   eventID, ownerID, eventDateTime(long), eventDuration, eventTitle,
  //   importance, dateModified(long), isDeleted, flag, autoEventType}, ...]},
  //   null, null ]: a 3-tuple whose first element is the month's events. ownerID
  //   kept as data (R7d). Empty events list for a month with none is legitimate.
  Object.freeze({ service: "calendarProxy", method: "GetEventList" }),
  // calendarProxy.GetEventDetails(eventID, ownerID) -> util.KeyVal{eventText,
  //   creatorID}: one event's body text + creator. creatorID kept as data (R7d).
  Object.freeze({ service: "calendarProxy", method: "GetEventDetails" }),
  // --- R60 plumbing sweep: lookup / presence / social READS (no UI) -----------
  //
  // Fourth batch of the operator's plumbing sweep — the reads made reachable +
  // decodable so a later goal builds UI cheaply; NO panel/tab/store slice ships.
  // Fourteen read-only pairs across four services, every one a plain TOP-LEVEL
  // read (each service `extends BaseService` with a plain `super("<name>")` and
  // NO MachoBindObject — confirmed unbound), each with an existing Handle_* (no
  // new handler is added), and each mutating sibling on these services stays
  // refused before dispatch.
  //
  //   LOOKUP. lookupSvc is the retail name/id SEARCH service (sm.RemoteSvc
  // "lookupSvc"). ⚠ THESE TAKE A QUERY ARG — a zero-arg call answers nothing
  // useful. The retail signatures (captured from ClientCodeGrabber) are
  // Lookup*(searchStr, exact) read POSITIONALLY by the handler: args[0] is the
  // search string, args[1] the exact-match flag (0 = PARTIAL_TERMS, the default;
  // 1..3 = exact variants). LookupKnownLocationsByGroup is the one exception —
  // its signature is (groupID, searchStr[, exact]). The BFF forwards the query +
  // flag; a too-short/empty query legitimately returns an EMPTY list (the search
  // filter drops everything), which is a real "no matches" answer, not a bug.
  // Every result is a buildList of util.KeyVal rows (or a bare-id list); the
  // rows carry entity ids the browser resolves to names (R7d), never rendered as
  // numbers. lookupSvc has NO mutating surface — it is a pure read service — so
  // the refusal here is just "only the nine listed methods".
  //
  // LookupCharacters(search, exact) -> buildList[util.KeyVal{characterID,
  //   characterName, ownerID, ownerName, typeID, groupID, corporationID,
  //   allianceID}]. Player-character search. LookupEvePlayerCharacters delegates
  //   to the same handler (same shape).
  Object.freeze({ service: "lookupSvc", method: "LookupCharacters" }),
  Object.freeze({ service: "lookupSvc", method: "LookupEvePlayerCharacters" }),
  // LookupCorporations(search, exact) -> buildList[util.KeyVal{corporationID,
  //   corporationName, ownerID, ownerName, typeID, groupID, tickerName,
  //   factionID, isNPC}].
  Object.freeze({ service: "lookupSvc", method: "LookupCorporations" }),
  // LookupFactions(search, exact) -> buildList[util.KeyVal{factionID, factionName,
  //   ownerID, ownerName, typeID, groupID}].
  Object.freeze({ service: "lookupSvc", method: "LookupFactions" }),
  // The three OWNER searches, all -> buildList[util.KeyVal{ownerID, ownerName,
  //   typeID, groupID, gender, + characterID/corporationID/allianceID/factionID/
  //   tickerName/isNPC where present}]. LookupOwners spans characters + corps +
  //   alliances + factions; LookupPCOwners excludes NPC corps (player-owned only);
  //   LookupNoneNPCAccountOwners is characters + non-NPC corps.
  Object.freeze({ service: "lookupSvc", method: "LookupOwners" }),
  Object.freeze({ service: "lookupSvc", method: "LookupPCOwners" }),
  Object.freeze({ service: "lookupSvc", method: "LookupNoneNPCAccountOwners" }),
  // LookupKnownLocationsByGroup(groupID, search[, exact]) -> buildList[util.KeyVal{
  //   itemID, itemName, typeID, groupID, solarSystemID, constellationID,
  //   regionID}]. Location search scoped by a groupID (5 solar system, 15 station,
  //   9 asteroid belt, 3 region, 4 constellation, ...). Delegates to
  //   Handle_LookupLocationsByGroup.
  Object.freeze({ service: "lookupSvc", method: "LookupKnownLocationsByGroup" }),
  // LookupWarableCorporationsOrAlliances(search, exact) -> buildList[util.KeyVal{
  //   ownerID, ownerName, typeID, warPermit}]. Owners a war can be declared
  //   against; scoped to the corporation/alliance runtime registry.
  Object.freeze({ service: "lookupSvc", method: "LookupWarableCorporationsOrAlliances" }),
  //
  //   PRESENCE. onlineStatus is the contact-online service (a plain BaseService,
  // super("onlineStatus"), no bind). All three reads scope off the SESSION
  // observer (getSessionCharacterID); no argument points them at another
  // observer. There is NO mutating sibling on this service.
  // GetOnlineStatus(targetID) -> a BARE BOOLEAN (is that character online, from
  //   this observer's view). targetID from the query; 0/absent answers false.
  Object.freeze({ service: "onlineStatus", method: "GetOnlineStatus" }),
  // GetInitialState() -> a Rowset[contactID, online] — the observer's whole
  //   contact-presence snapshot (arg-less). Empty for a character with no
  //   contacts (Farmer) is a REAL empty state.
  Object.freeze({ service: "onlineStatus", method: "GetInitialState" }),
  // Prime() -> ⚠ NOT a void/no-op here: Handle_Prime delegates to
  //   Handle_GetInitialState, so it returns the SAME Rowset[contactID, online].
  //   It is a real call (the retail client primes presence on login); wired for
  //   completeness, and the decoder treats it identically to GetInitialState.
  Object.freeze({ service: "onlineStatus", method: "Prime" }),
  //
  //   SOCIAL. Two unrelated reads on two services.
  // LSC.GetChannels() -> a Rowset with the 16 CHANNEL_HEADERS (channelID, ownerID,
  //   displayName, motd, comparisonKey, memberless, password, mailingList, cspa,
  //   temporary, languageRestriction, groupMessageID, channelMessageID, mode,
  //   subscribed, estimatedMemberCount), one line per channel the session is in
  //   (the docked Local channel). LSC (Large Scale Chat) is a plain BaseService
  //   (super("LSC"), no bind); the message/join/leave WRITERS (SendMessage,
  //   JoinChannel(s), LeaveChannel(s)) stay refused. ownerID kept as data (R7d).
  Object.freeze({ service: "LSC", method: "GetChannels" }),
  // account.GetDefaultContactCost() -> ⚠ returns null in this world (the handler
  //   is a `return null` stub — the CSPA contact charge is not modelled). A
  //   legitimate "no default cost" answer, not a bridge bug; the plumbing lands
  //   for when the value exists. account is already reached top-level (R6/R50/R54
  //   reads); its mutating siblings (SetContactCost, GiveCash, the transfers)
  //   stay refused.
  Object.freeze({ service: "account", method: "GetDefaultContactCost" }),
  // --- R61 plumbing sweep: corp READS — corpmgr / corp LP (no UI) -------------
  //
  // Fifth batch of the operator's plumbing sweep — the reads made reachable +
  // decodable so a later goal builds UI cheaply; NO panel/tab/store slice ships.
  // Eleven read-only pairs across three services, every one a plain TOP-LEVEL
  // read (machoNet binds corpmgr ["corpmgr", null] unbound, and LPSvc /
  // LPStoreMgr as ["<svc>", "station"] SESSION services reached by plain /call —
  // NOT a MachoBindObject two-step), each with an existing Handle_* (no new
  // handler is added), and each mutating sibling on these services stays refused
  // before dispatch.
  //
  // ⚠ corpmgr is the TOP-LEVEL corp service and is DISTINCT from corpRegistry —
  // the BOUND per-corp registry (eveMoniker.GetCorpRegistry) whose reads are a
  // later bound batch. Only corpmgr is listed here. corpmgr has no mutating
  // surface of its own (it is corp-info + corp-asset reads); the refusal here is
  // just "only the nine listed methods".
  //
  // GetPublicInfo(corporationID) -> util.KeyVal{corporationID, corporationName,
  //   ticker, ceoID, allianceID, warFactionID, description, taxRate, memberCount,
  //   isRecruiting, shape*/color*/typeface, ...}. Public corp identity. The corp/
  //   ceo/alliance ids resolve to names (R7d). Defaults to the session corp when
  //   the BFF passes no id.
  Object.freeze({ service: "corpmgr", method: "GetPublicInfo" }),
  // GetCorporations(corporationID) -> a SINGLE util.Row over the 51-column
  //   CORPORATION_ROW_HEADER (not a rowset — one row for the requested corp).
  Object.freeze({ service: "corpmgr", method: "GetCorporations" }),
  // GetCorporationIDForCharacter(charID) -> a BARE INT (the character's corp id).
  //   charID from the BFF (defaults to the session character); the id stays data.
  Object.freeze({ service: "corpmgr", method: "GetCorporationIDForCharacter" }),
  // GetAggressionSettings(corporationID) -> a named object
  //   crimewatch.corp_aggression.settings.AggressionSettings whose bare dict args
  //   carry {_enableAfter, _disableAfter} — each a {type:"long"} FILETIME or null
  //   (the friendly-fire schedule). GetAggressionSettingsForCorps([corpIDs]) ->
  //   {type:"dict", entries:[[corpID, AggressionSettings], ...]} — the same
  //   payload keyed per corp. Read-only; the RegisterNew* writers live on the
  //   BOUND corpRegistry (not here) and stay refused.
  Object.freeze({ service: "corpmgr", method: "GetAggressionSettings" }),
  Object.freeze({ service: "corpmgr", method: "GetAggressionSettingsForCorps" }),
  // AuditMember(memberID, fromDate, toDate, rowsPerPage) -> [eventCRowset,
  //   roleHistoryCRowset]: a 2-tuple of CRowsets (member event log +
  //   role-change history) for one member. ⚠ ACCESS-GATED: the handler returns
  //   the EMPTY pair unless the session has the corp DIRECTOR or AUDITOR role —
  //   a legitimate "no audit access / no events" answer, not a bridge bug. The
  //   memberID / char ids in the rows stay data (R7d); the changeTime/eventDateTime
  //   FILETIMEs are bigint-safe.
  Object.freeze({ service: "corpmgr", method: "AuditMember" }),
  // ⚠ THE TWO ASSET-INVENTORY READS WRAP A CRowset IN A CachedMethodCallResult —
  // the browser unwraps BOTH layers (the cache wrapper's substream member, then
  // the objectex2 CRowset whose rows live on `list`, exactly as R37 personalAssets
  // and R55 GetStandingCompositions do — the decoder reuses unwrapCachedResult +
  // readRowField, not a hand-rolled path). The cache-registration the handler
  // performs is versioning bookkeeping, not a game-state write (same as the
  // already-allowlisted map.GetStationInfo / charMgr.GetPrivateInfoOnCorpChange
  // CachedMethodCallResults).
  //
  // GetAssetInventory(corporationID, which) -> CachedMethodCallResult wrapping a
  //   CRowset of the corp's asset LOCATIONS for a bucket (`which`: offices /
  //   impounded / property / deliveries / capsuleerdeliveries / assetwraps;
  //   default offices). Rows: name-keyed packedrows [locationID, solarsystemID,
  //   typeID] (deliveries buckets add itemCount). ⚠ Farmer's player corp
  //   98000001 may have SPARSE corp assets — an empty CRowset is a legitimate
  //   "no corp assets in this bucket" state, not a bug. location/type ids stay
  //   data (R7d); locationID is int64 (bigint-safe).
  Object.freeze({ service: "corpmgr", method: "GetAssetInventory" }),
  // GetAssetInventoryForLocation(corporationID, locationID, which) ->
  //   CachedMethodCallResult wrapping a CRowset of the ITEMS at one location.
  //   Rows: name-keyed packedrows [itemID, typeID, ownerID, locationID, flagID,
  //   quantity, groupID, categoryID, customInfo, stacksize, singleton]. ⚠ quantity
  //   is -1 for an assembled singleton (the retail convention), so a UI reads
  //   stacksize/singleton, not the raw quantity. itemID/locationID are int64.
  Object.freeze({ service: "corpmgr", method: "GetAssetInventoryForLocation" }),
  // SearchAssets(which, categoryID, groupID, typeID, minimumQuantity) ->
  //   CachedMethodCallResult wrapping a CRowset of matching LOCATIONS (rows carry
  //   just [locationID]). ⚠ corporationID comes from the SESSION, not args — the
  //   filter tuple is (bucket + category/group/type/minimumQuantity). An empty
  //   result for a filter that matches nothing is legitimate.
  Object.freeze({ service: "corpmgr", method: "SearchAssets" }),
  //
  //   CORP LP. Two reads on two distinct services.
  // LPSvc.GetAllMyCorporationWalletLPBalances() -> a CRowset[issuerCorpID,
  //   loyaltyPoints] — the CORP's per-issuer LP balances (the SESSION corp scope;
  //   getCorporationWalletLPBalances(session.corporationID)). The exact sibling of
  //   the already-allowlisted GetAllMyCharacterWalletLPBalances (R6), same CRowset
  //   shape, corp side. issuerCorpID resolves to a name (R7d); loyaltyPoints stays
  //   bigint-safe. Empty for a corp with no LP is a REAL empty state. The LP
  //   TRANSFER writers (TransferLPFromMyWalletToOtherCorp / …CorpWallet… /
  //   ExchangeConcordLP) stay refused.
  Object.freeze({ service: "LPSvc", method: "GetAllMyCorporationWalletLPBalances" }),
  // LPStoreMgr.GetAvailableOffersFromCorp(corpID) -> {type:"list", items:[
  //   util.KeyVal{typeID, iskCost, akCost, reqItems(list of [typeID, qty]), offerID,
  //   qty, requiredStandings, corpID, lootItems, lpCost}, ...]}: the LP-store offers
  //   a corp publishes. ⚠ LPStoreMgr is a DISTINCT service from LPSvc
  //   (evermarks/lpStoreMgrService.js, super("LPStoreMgr")); machoNet lists it as a
  //   station SESSION service and ensureStructureLoyaltyStoreAccess is a no-op for a
  //   plain station dock (only a player STRUCTURE without the loyalty-store service
  //   refuses), so the docked read succeeds. corpID defaults to the Heraldry corp
  //   (emblem offers) when the BFF passes none. typeIDs stay data (R7d); costs are
  //   bigint-safe. The TakeOfferForCharacter / TakeOfferForCorporation writers
  //   (spend LP + ISK) stay refused.
  Object.freeze({ service: "LPStoreMgr", method: "GetAvailableOffersFromCorp" }),
  // --- R62 plumbing sweep: trading READS — market corp/PLEX + contract ------
  //
  // Sixth batch of the operator's plumbing sweep — the reads made reachable +
  // decodable so a later goal builds UI cheaply; NO panel/tab/store slice ships.
  // Fourteen read-only pairs across TWO already-established TOP-LEVEL ProxySvc
  // services (marketProxy + contractProxy — no MachoBindObject on either, proven
  // by the R16/R17 pairs above), each grep-confirmed to have an existing
  // Handle_* and each mutating sibling on these services staying refused.
  //
  // ⚠ THIS BATCH REVERSES A DELIBERATE R16/R17 READ EXCLUSION. The R16 block
  // above marked GetCorporationOrders / CorpGetTransactions and the ENTIRE PLEX
  // surface "deliberately absent", and R17 marked GetMyBids "nothing to
  // allowlist". Those exclusions were slice control, not a security property —
  // the operator's plumbing sweep now wants the READS reachable. This R62 batch
  // adds only READS: the market WRITES PlacePlexSellOrder / ModifyPlexCharOrder
  // (PLEX real-money-adjacent) and BuyMultipleItems (batch instant-buy) are NOT
  // here — they land in the R106 FINANCIAL batch above (BFF confirm-gated, never
  // fired live). Every contract mutator stays refused.
  //
  //   MARKET corp orders + transactions. Both session-scoped to the SESSION corp
  // (corpid), daemon-backed (marketDaemonClient), so a daemon outage throws
  // MarketUnavailable — the corp siblings of the already-allowlisted GetCharOrders
  // / CharGetTransactions.
  // GetCorporationOrders() -> CachedMethodCallResult wrapping the owner-orders
  //   Rowset (util.Row lines over OWNER_ORDER_HEADER — the SAME shape GetCharOrders
  //   answers, decoded by the same decodeOwnOrders path). Scoped to session.corpid;
  //   no owner argument. Empty for a corp with no open orders is a REAL state.
  Object.freeze({ service: "marketProxy", method: "GetCorporationOrders" }),
  // CorpGetTransactions(fromDate, accountKey) -> CachedMethodCallResult wrapping a
  //   list<util.KeyVal> of transactions (⚠ CACHED — unlike CharGetTransactions,
  //   which answers a BARE list). Session-scoped corpid; args read POSITIONALLY:
  //   args[0]=fromDate (0 = everything the server keeps), args[1]=accountKey (null
  //   = any division). ⚠ bigint ISK amounts — price/transactionID stay bigint-safe.
  Object.freeze({ service: "marketProxy", method: "CorpGetTransactions" }),
  //   PLEX reads. PLEX (typeID 44992) trades on the region market like any type,
  // but through a dedicated service path; all reads are session-scoped to the
  // SESSION region (regionid) or take no argument, and the daemon-backed ones
  // throw MarketUnavailable on outage. None takes an owner/location argument.
  // GetPlexOrders() -> CachedMethodCallResult wrapping the 2-tuple [sellsRowset,
  //   buysRowset] (blue.DBRow lines over ORDER_HEADER — the SAME shape GetOrders
  //   answers, decoded by the same decodeOrderBook path). Session region scope.
  Object.freeze({ service: "marketProxy", method: "GetPlexOrders" }),
  // GetPlexBest() -> CachedMethodCallResult wrapping a dict keyed by typeID ->
  //   util.KeyVal{price, volRemaining, typeID, stationID}: the best PLEX ask in the
  //   session region (the daemon's GetRegionBest filtered to PLEX). price is
  //   bigint-safe; stationID/typeID stay data (R7d).
  Object.freeze({ service: "marketProxy", method: "GetPlexBest" }),
  // The PLEX daily price history (low/high/avg + traded volume), THREE ways — the
  // PLEX equivalents of GetOldPriceHistory / GetNewPriceHistory. None is cached
  // and none takes an argument.
  // GetPlexHistory() -> a plain dict keyed by PLEX typeID -> [oldHistoryRowset,
  //   newHistoryRowset] (the whole split history for PLEX).
  Object.freeze({ service: "marketProxy", method: "GetPlexHistory" }),
  // GetPlexOldPriceHistory() / GetPlexNewPriceHistory() -> a single history Rowset
  //   (blue.DBRow over HISTORY_HEADER: historyDate(FILETIME long)/lowPrice/highPrice/
  //   avgPrice/volume/orders) — the "old" (all but the latest day) and "new" (the
  //   latest day) halves the retail price graph draws, decoded by the same
  //   decodePriceHistory path. Prices bigint-safe; historyDate a bigint FILETIME.
  Object.freeze({ service: "marketProxy", method: "GetPlexOldPriceHistory" }),
  Object.freeze({ service: "marketProxy", method: "GetPlexNewPriceHistory" }),
  //
  //   CONTRACT my-bids / escrow / items. All on contractProxy (the LIVE service —
  // contractMgr is the dead stub, see the R17 note above), each session-scoped;
  // every contract MUTATOR (Accept/Complete/Create/Delete*/PlaceBid/SplitStack/…)
  // stays refused. Contract data uses buildKeyVal (list rows) vs buildPackedRow
  // (detail/inventory rows), so rows are read through readRowField (R32); FILETIMEs
  // and large IDs arrive as bare decimal strings on the bigint-tolerant path.
  //
  // ⚠ GetMyContractEscrow IS NOT marketProxy.GetCharEscrow. It is a DIFFERENT
  // call on a DIFFERENT service: this is CONTRACT escrow (ISK + item count locked
  // behind the character's own outstanding contracts, contractRuntime.
  // getMyContractEscrow), NOT market-order escrow. It has nothing to do with the
  // known-failing webGatewayMarket/GetCharEscrow test, which is untouched.
  // GetMyContractEscrow() -> util.KeyVal{iskEscrow, itemsEscrow}. Session-scoped
  //   (issuer is the session char, or the session corp when forCorp). Empty (0/0)
  //   for a character issuing no contracts is a REAL state.
  Object.freeze({ service: "contractProxy", method: "GetMyContractEscrow" }),
  // GetMyBids() -> an EMPTY contract bundle ({contracts:[], items:{}}) — the
  //   auction/bid surface is a SERVER STUB (no bidding modelled; PlaceBid ->
  //   null). Wired for completeness; the empty bundle is the legitimate answer.
  Object.freeze({ service: "contractProxy", method: "GetMyBids" }),
  // NumOutstandingContracts() -> util.KeyVal{nonCorpForMyChar, myCorpTotal,
  //   nonCorpForMyCorp, myCharTotal}: the outstanding-contract counts (personal +
  //   corp) behind the panel headline. Session-scoped, no argument.
  Object.freeze({ service: "contractProxy", method: "NumOutstandingContracts" }),
  // The contract ITEM-SOURCE reads — what a player can PUT ON a contract, read
  // from their own hangar/containers. Each is ownership-gated: a container/location
  // that is not the session owner's answers empty (canReadContractContainer /
  // the HANGAR-flag scope), so no argument points one at another owner's items.
  // GetItemsInContainer(locationID, containerID[, forCorp, flagID]) -> a list of
  //   inventory packedrows [itemID, typeID, ownerID, locationID, flagID, quantity,
  //   groupID, categoryID, customInfo] + virtual [stacksize, singleton]. ⚠ Takes
  //   BOTH a locationID (args[0]) and a containerID (args[1]) — the retail
  //   signature, read positionally.
  Object.freeze({ service: "contractProxy", method: "GetItemsInContainer" }),
  // GetItemsInDockableLocation(locationID[, forCorp]) -> a `__builtin__.set`
  //   (objectex1) wrapping the SAME inventory packedrows for the items in a
  //   dockable hangar. ⚠ A SET wrapper, not a bare list — the item list rides
  //   args[0] of the set object. Session HANGAR flag (character) or corp division
  //   flags (forCorp).
  Object.freeze({ service: "contractProxy", method: "GetItemsInDockableLocation" }),
  // GetNumItemsInContainers(locationID, [containerIDs][, forCorp, flagID]) -> a
  //   dict keyed by containerID -> item count. ⚠ Takes a locationID (args[0]) and a
  //   LIST of containerIDs (args[1]); ownership-gated per container.
  Object.freeze({ service: "contractProxy", method: "GetNumItemsInContainers" }),
  // GetCourierContractFromItemID(itemID) -> the contract row (util.KeyVal via
  //   buildContractRow) a given crate item belongs to, or null. Args: args[0]=
  //   itemID. null for an item in no courier contract is a REAL "not on a
  //   contract" answer. contract/entity ids stay data (R7d); FILETIMEs bigint-safe.
  Object.freeze({ service: "contractProxy", method: "GetCourierContractFromItemID" }),
  // --- R63 plumbing sweep: structure directory READS (session/access-scoped) --
  //
  // Seventh batch of the operator's plumbing sweep — reads made reachable +
  // decodable so a later goal builds UI cheaply; NO panel/tab/store slice ships.
  // TEN read-only pairs on structureDirectory (a plain TOP-LEVEL BaseService,
  // super("structureDirectory") — no MachoBindObject), each grep-confirmed to
  // have an existing top-level Handle_* in
  // server/src/services/structure/structureDirectoryService.js. The wider
  // structureDeployment/structureControl verbs stay refused, named in the sweep
  // test below. (structureDirectory.SetStructureDescription — refused here through
  // R92 — is allowlisted by the R93 WRITES batch, confirm-gated + canManage
  // Structure-guarded, so it moved to the R93 block below.)
  // GetStructureInfo is already listed (R38) above and is NOT re-added here.
  //
  // ⚠ structureDirectory.GetStructures STAYS DELIBERATELY ABSENT — the R38
  // decision (see the GetStructureInfo note above) still holds and is REAFFIRMED
  // here: Handle_GetStructures runs buildStructureInfoDict over ARBITRARY caller-
  // supplied structure IDs with NO ownership check, and buildStructureDirectoryInfo
  // (structureState.js) surfaces fuelExpires / upkeepState / state / timerEnd /
  // reinforce_weekday+hour / next_reinforce_* / unanchoring / liquidOzoneQty — a
  // defender's fuel/reinforcement/vulnerability CALENDAR — for any structure asked
  // about. Listing it would put that operational calendar behind an
  // unauthenticated-by-ownership browser read. It remains named in the refusal
  // sweep. GetStructuresInSystem / GetSolarsystemStructures likewise stay absent:
  // they run the SAME buildStructureInfoDict for EVERY structure in a caller-named
  // system (no ownership gate), so they leak the same operational calendar for a
  // whole system — refused, and named in the sweep. This batch takes only the
  // session/access-SCOPED reads, where the RELATIONSHIP (owned-by / access-granted)
  // is what bounds what comes back.
  //
  // ⚠⚠ structureDirectory.GetMyCharacterStructures IS ALSO DELIBERATELY ABSENT,
  // and this was NOT obvious — the "My" prefix reads as session-scoped/safe. But
  // its handler is listDockableStructuresForCharacter, i.e. every structure the
  // character can DOCK AT, not only ones it OWNS, and it runs the same
  // buildStructureInfoDict — so it hands back the full operational calendar for
  // structures the character does not own. Captured LIVE from Farmer (corp
  // 98000001) on 2026-07-22: it returned "Allied Astrahus" (structureID
  // 1030000000000) owned by corp 980090001 / alliance 990091001 — NOT Farmer's
  // corp — carrying reinforce_weekday 5 / reinforce_hour 18 (its vulnerability
  // window), state 102, upkeepState, fuelExpires and liquidOzoneQty. That is
  // exactly the defender's-calendar leak R38 declined GetStructures for, only via
  // a dockable-access relationship instead of an arbitrary id. Refused, and named
  // in the sweep. The OWNED-corp directory read below (GetMyCorporationStructures,
  // listOwnedStructures — strictly ownerCorpID === session corp, role-gated) is the
  // safe way to read this same operational payload: your OWN corp's structures.
  //
  //   THE "MY" READS — scoped off the SESSION, never off an argument.
  // GetMyCorporationStructures() -> util.Dict of the SESSION corp's OWN owned
  //   structures (listOwnedStructures(session.corpid)), ROLE-GATED:
  //   canReadCorporationStructureDirectory throws CrpAccessDenied without Station
  //   Manager / Brand Manager. Own-corp + role — never an arbitrary corpID.
  Object.freeze({ service: "structureDirectory", method: "GetMyCorporationStructures" }),
  // GetCorporationStructures() -> the SAME handler: Handle_GetCorporationStructures
  //   DELEGATES to Handle_GetMyCorporationStructures (structureDirectoryService.js),
  //   so it IGNORES any argument and scopes to the session corp with the same role
  //   gate. It does NOT take an arbitrary corpID — verified in source — so it does
  //   not leak another corp's directory.
  Object.freeze({ service: "structureDirectory", method: "GetCorporationStructures" }),
  // GetMyDockableStructures([solarSystemID]) -> a bare LIST of structureIDs the
  //   SESSION character can dock at (in a given system, defaulting to the current
  //   one). ids only, session-scoped; a future UI resolves each id (R7d).
  Object.freeze({ service: "structureDirectory", method: "GetMyDockableStructures" }),
  //
  //   THE PUBLIC-ISH LOCATION READS — name / type / position only, NO operational
  // fields, so no ownership gate is needed (and none leaks).
  // GetStructureMapData([solarSystemID]) -> CachedMethodCallResult wrapping a
  //   CRowset (carbon...CRowset) of packedrows over
  //   [groupID, typeID, itemID, itemName, locationID, orbitID, connector, x, y, z,
  //   celestialIndex, orbitIndex] (buildStructureMapList). ⚠ This is the MAP shape,
  //   NOT buildStructureDirectoryInfo — it carries NO fuel/reinforce/vulnerability,
  //   only where a structure is and what it is called. Two wrappers to unpeel
  //   (cache result -> CRowset).
  Object.freeze({ service: "structureDirectory", method: "GetStructureMapData" }),
  // GetStructureDescription(structureID) -> a plain STRING (the structure bio,
  //   capped at 1000 chars), or "" if unknown. The simplest read here: no marshaled
  //   wrapper, no operational field. Args: args[0]=structureID.
  Object.freeze({ service: "structureDirectory", method: "GetStructureDescription" }),
  //
  //   THE ACCESS-SCOPED READS — bounded by what the SESSION character may do.
  // CheckMyDockingAccessToStructures([structureIDs]) -> a bare LIST of the subset
  //   of the requested ids the SESSION character can dock at (canCharacterDock...).
  //   Args: args[0]=list of ids to test — a pure access filter, no structure detail
  //   comes back, only which ids passed.
  Object.freeze({ service: "structureDirectory", method: "CheckMyDockingAccessToStructures" }),
  // GetMyAccessibleOnlineCynoBeaconStructures() -> a LIST of
  //   [structureID, typeID, ownerID, solarSystemID, state, itemName] entries, ONLY
  //   for online, non-jammed cyno beacons the SESSION character has service access
  //   to (characterHasStructureService). Access-gated; ids stay data (R7d).
  Object.freeze({ service: "structureDirectory", method: "GetMyAccessibleOnlineCynoBeaconStructures" }),
  // GetSolarSystemsWithBeacons() -> a bare LIST of solarSystemIDs that have an
  //   online, non-jammed cyno beacon. ⚠ NOT character-scoped, but it returns ONLY
  //   solar-system ids — no structure id, no owner, no operational field — so it is
  //   system-presence info, not a structure's operational calendar. ids as data.
  Object.freeze({ service: "structureDirectory", method: "GetSolarSystemsWithBeacons" }),
  // GetValidWarHQs(ownerID) -> a LIST of war-HQ KeyVal payloads (typeID, structureID,
  //   upkeepState, wars, ownerID, solarSystemID, itemName, inSpace), ACCESS-GATED:
  //   canRequestWarHQsForOwner returns empty unless ownerID is the SESSION corp or
  //   alliance — so a browser can only ask about its OWN corp/alliance HQs, never an
  //   arbitrary owner's. Args: args[0]=ownerID.
  Object.freeze({ service: "structureDirectory", method: "GetValidWarHQs" }),
  // GetJumpBridgesWithMyAccess() -> [pairsList, hasAccessIDs, hasNoAccessIDs]: the
  //   Ansiblex bridge pairs plus, split by the SESSION character's service access,
  //   which bridge ids they can/cannot use. Session-scoped; ids stay data (R7d).
  Object.freeze({ service: "structureDirectory", method: "GetJumpBridgesWithMyAccess" }),
  // --- R64 plumbing sweep: agent / mission READS (public NPC info + own progress) --
  //
  // Eighth batch of the operator's plumbing sweep — reads made reachable +
  // decodable so a later goal builds UI cheaply; NO panel/tab/store slice ships.
  // NINE read-only pairs on agentMgr, each grep-confirmed to have an existing
  // Handle_* in server/src/services/agent/agentMgrService.js. agentMgr is the one
  // service they all register under: the retail client-local `agents` service and
  // the `epicArcStatus`/`infosvc` accessors resolve to these agentMgr handlers
  // server-side. The R4/R6 agent pairs (GetAgents / MachoBindObject / DoAction /
  // GetMissionBriefingInfo / GetMissionObjectiveInfo / GetMissionKeywords /
  // GetAgentLocationWrap / GetStandingGainsForMission / GetMyJournalDetails) are
  // already listed above and are NOT re-added here. The agentMgr nav/journal
  // MUTATORS (RemoveOfferFromJournal / GotoLocation / WarpToLocation /
  // WarpToAgentInSpace) — refused here through R92 — are allowlisted by the R93
  // WRITES batch (confirm-gated; docked => nav returns not-in-space), so they
  // moved to the R93 block below.
  //
  //   OWNERSHIP-SAFETY (verified LIVE before listing — R63's lesson: a "safe" hint
  // is not a guarantee). The three agentID reads return PUBLIC NPC-agent reference
  // data (agentTypeID / divisionID / level / stationID / corporationID / factionID
  // — the same public fields the already-shipping Agent Finder exposes) and take an
  // arbitrary agentID BY DESIGN (retail resolves any NPC agent this way); no
  // player-private field is present. The four own-progress / own-journal reads are
  // scoped OFF THE SESSION (session.characterID, or the bound agent), never off a
  // caller argument, so a browser only ever reads its OWN journal / career / epic-
  // arc progress. GetDungeonShipRestrictions returns STATIC dungeon ship-restriction
  // reference data (allowed/restricted shipTypeIDs, resolveDungeonShipRestrictions),
  // reading no session and no bound agent — no entity's private state. None leaks
  // another entity's private data.
  //
  //   THE THREE PUBLIC NPC-AGENT READS — take an agentID, return public info.
  // GetAgentStaticInfo(agentID) -> the agent record marshaled (agentID / agentTypeID
  //   / divisionID / level / stationID / corporationID / factionID …). ⚠ Side effect:
  //   sendAgentAdded(session, agentID) pushes an OnAgentAdded NOTIFICATION (a client
  //   cache-prime, NOT a game-state write) — the retail client itself calls this as a
  //   read. Args: [agentID].
  Object.freeze({ service: "agentMgr", method: "GetAgentStaticInfo" }),
  // GetAgentByID(agentID) -> the same public agent record (retail's `agents` client
  //   service reads it to label an NPC agent); same public fields, same
  //   sendAgentAdded notification side effect. Args: [agentID].
  Object.freeze({ service: "agentMgr", method: "GetAgentByID" }),
  // GetSolarSystemOfAgent(agentID) -> the agent's solarSystemID (a bare int) or null:
  //   the public location of a public NPC agent. Args: [agentID].
  Object.freeze({ service: "agentMgr", method: "GetSolarSystemOfAgent" }),
  //
  //   THE OWN-PROGRESS / OWN-JOURNAL READS — scoped off the SESSION, never an arg.
  // GetMyEpicArcStatus() -> the character's OWN epic-arc mission-status map
  //   (getMyEpicArcStatus(session.characterID)); no args. Empty is legitimate (no
  //   epic arc started).
  Object.freeze({ service: "agentMgr", method: "GetMyEpicArcStatus" }),
  // GetCompletedCareerAgentIDs([agentIDs]) -> for the SESSION character, which of the
  //   passed career-agent ids it has completed ({agentID -> bool}). The only argument
  //   is the LIST of ids to CHECK; the completion set is read off session.characterID,
  //   so a caller cannot read another character's progress. ⚠ arg is a LIST in
  //   args[0]; an empty list returns {} (a real "asked about none"). Args: [[agentID, …]].
  Object.freeze({ service: "agentMgr", method: "GetCompletedCareerAgentIDs" }),
  //
  //   THE BOUND-AGENT READS — dispatched on the agent moniker (Moniker('agentMgr',
  // agentID) via MachoBindObject, the R4 two-step), each resolving the agentID from
  // the bound context and the characterID from the session, so they read the SESSION
  // character's own mission/agent relationship — never another char's. Like the R4
  // bound reads (GetMissionBriefingInfo …), they are listed once here and dispatched
  // through boundCall in the BFF.
  // GetMissionJournalInfo() -> the char's own journal detail for the bound agent's
  //   mission (getMissionJournalInfo(session.characterID, boundAgentID)); null when
  //   the char has no mission with that agent (a real state).
  Object.freeze({ service: "agentMgr", method: "GetMissionJournalInfo" }),
  // GetInfoServiceDetails() -> the bound agent's info-window service detail (agentID,
  //   stationID, level, services list) for the session char; the retail info panel
  //   reads it. Own-session scoped.
  Object.freeze({ service: "agentMgr", method: "GetInfoServiceDetails" }),
  // GetEntryPoint() -> the [x, y, z] entry point of the bound agent's mission dungeon
  //   for the session char, or null when there is no active dungeon (a real state).
  Object.freeze({ service: "agentMgr", method: "GetEntryPoint" }),
  //
  //   THE STATIC DUNGEON-RESTRICTION READ — reference data, no entity state.
  // GetDungeonShipRestrictions(dungeonID[, gateID]) -> {allowedShipTypes,
  //   restrictedShipTypes, nonDefaultShipRestrictions} for a dungeon, computed from
  //   static dungeon connection data + the ship-type registry (resolveDungeonShip
  //   Restrictions); it reads no session and no bound agent — a pure reference read.
  //   null when the dungeon is unknown or unrestricted (a real state). Args:
  //   [dungeonID, gateID].
  Object.freeze({ service: "agentMgr", method: "GetDungeonShipRestrictions" }),
  // --- R65 plumbing sweep: utility READS (insurance / corp+alliance fittings / bookmarks) --
  //
  // Ninth batch of the operator's plumbing sweep — reads made reachable +
  // decodable so a later goal builds UI cheaply; NO panel/tab/store slice ships.
  // TEN read-only pairs across three services, each grep-confirmed to have an
  // existing TOP-LEVEL Handle_* (never a new handler; every mutator sibling stays
  // refused, named in the sweep test below).
  //
  //   OWNERSHIP-SAFETY (verified LIVE before listing — R63's lesson: a "My"/"safe"
  // hint is not a guarantee). Every read below returns either the SESSION's own
  // data or genuinely PUBLIC / static reference data; none returns another entity's
  // private state. Verified live as Farmer (140000005 / corp 98000001) 2026-07-22.
  //
  //   INSURANCE (insurance/insuranceService.js) — the char's SHIP-insurance
  // policies + the public premium tables. These are ship-INSURANCE contracts, NOT
  // player contracts.
  // GetContracts([isCorp]) -> util.KeyVal list of the char's own active insurance
  //   policies (listContracts scopes the owner to session.characterID; the corp
  //   branch additionally requires the accountant role). Empty is legitimate (no
  //   ship insured). Called with no arg (char policies). Args: [] / [isCorp].
  Object.freeze({ service: "insuranceSvc", method: "GetContracts" }),
  // GetContractForShip(shipID) -> the one active policy for a ship, or null.
  //   canSessionSeeContract gates it: the contract is returned ONLY when its
  //   ownerID is the session char (or the session corp with the accountant role),
  //   so a shipID the caller does not own reads null — verified live (an un-owned
  //   shipID returned null, not another owner's policy). Args: [shipID].
  Object.freeze({ service: "insuranceSvc", method: "GetContractForShip" }),
  // GetInsurancePrice(shipTypeID) -> the full insurance base price for a ship TYPE
  //   (getFullInsurancePrice, static price authority). PUBLIC reference data keyed
  //   by typeID; no entity state. Args: [shipTypeID].
  Object.freeze({ service: "insuranceSvc", method: "GetInsurancePrice" }),
  // GetInsurancePrices([typeIDs]) -> {typeID -> full base price} for a list of ship
  //   TYPES. Same PUBLIC static table, batched. Args: [[typeID, …]].
  Object.freeze({ service: "insuranceSvc", method: "GetInsurancePrices" }),
  //
  //   CORP / ALLIANCE FITTING LIBRARIES (fitting/{corp,alliance}FittingMgrService.js)
  // — the shared saved-fitting libraries beside R57's CHAR library
  // (charFittingMgr.GetFittings, already listed above). assertSessionCanAccessOwner
  // gates each: with no owner arg the owner defaults to the SESSION's own corp /
  // alliance, and a foreign owner id throws OWNER_SCOPE_DENIED — so a browser only
  // ever reads its own corp/alliance library (verified live: a foreign corp id was
  // denied). Community fittings are public by design.
  //
  // R91 Phase-3 top-level WRITE — corpFittingMgr.SaveManyFittings (bulk import to
  // the corp library), confirm-gated at the BFF. ⚠ ARG-INJECTION — GUARDED: the
  // handler resolves the ownerID and then assertSessionCanMutateOwner(session,
  // ownerID, CORPORATION) before saving, so a foreign corp ownerID is a
  // permission throw. The corp DELETE/rename siblings (DeleteFitting /
  // DeleteManyFittings / UpdateNameAndDescription / SaveFitting / UpdateFitting)
  // stay absent this batch — only the char side + corp bulk-save are wired.
  // corpFittingMgr.GetFittings([ownerID]) -> a CachedMethodCallResult wrapping a
  //   {fittingID -> util.KeyVal} dict of the SESSION corp's saved fits. Empty is
  //   legitimate. Called with no arg (own corp). Args: [] / [corpID(self)].
  Object.freeze({ service: "corpFittingMgr", method: "GetFittings" }),
  Object.freeze({ service: "corpFittingMgr", method: "SaveManyFittings" }),
  // corpFittingMgr.GetCommunityFittings() -> a CachedMethodCallResult wrapping the
  //   PUBLIC community fitting library (owner 1000282); read-only, no entity state.
  Object.freeze({ service: "corpFittingMgr", method: "GetCommunityFittings" }),
  // allianceFittingMgr.GetFittings([ownerID]) -> a {fittingID -> util.KeyVal} dict
  //   (RAW, not cache-wrapped) of the SESSION alliance's saved fits. Same owner
  //   gate; a char with no alliance reads OWNER_SCOPE_DENIED (a real "no alliance"
  //   state, not a leak). Called with no arg (own alliance). Args: [] / [allianceID(self)].
  Object.freeze({ service: "allianceFittingMgr", method: "GetFittings" }),
  //
  //   BOOKMARKS (character/accessGroupBookmarkMgrService.js) — the char's own
  // location bookmarks + the folders it can administer. Every read scopes off
  // session.characterID and gates folder access through resolveFolderView (returns
  // null / throws FolderAccessDenied when the char has no access), so no other
  // character's private folders leak — verified live (a foreign folderID was
  // access-denied, not returned). Every bookmark/folder MUTATOR (AddFolder /
  // UpdateFolder / DeleteFolder / BookmarkLocation / DeleteBookmarks / … ) stays
  // refused.
  // GetMyActiveBookmarks() -> [folders, bookmarks, subfolders] lists for the
  //   session char's active folders. Empty is legitimate. No args.
  Object.freeze({ service: "accessGroupBookmarkMgr", method: "GetMyActiveBookmarks" }),
  // GetFolderInfo(folderID) -> one folder's KeyVal view IF the session char has at
  //   least view access (resolveFolderView gates it); a non-accessible / unknown
  //   folderID throws FolderAccessDenied / BookmarkFolderNoLongerThere rather than
  //   revealing it. Args: [folderID].
  Object.freeze({ service: "accessGroupBookmarkMgr", method: "GetFolderInfo" }),
  // SearchFoldersWithAdminAccess() -> the session char's personal folders + the
  //   shared folders it has ADMIN access to (listFoldersWithAdminAccess); scoped to
  //   the char, no caller argument. Empty is legitimate. No args.
  Object.freeze({ service: "accessGroupBookmarkMgr", method: "SearchFoldersWithAdminAccess" }),
  // --- R66 plumbing sweep: pvp-info READS (bounties / wars / killmail) ---------
  //
  // Tenth batch of the operator's plumbing sweep — reads made reachable +
  // decodable so a later goal builds UI cheaply; NO panel/tab/store slice ships.
  // FIFTEEN read-only pairs across three services, each grep-confirmed to have an
  // existing TOP-LEVEL Handle_* (never a new handler; every mutator sibling stays
  // refused, named in the sweep test below).
  //
  //   OWNERSHIP-SAFETY (verified LIVE before listing — R63's lesson: a "safe" hint
  // is not a guarantee). Bounties, wars and killmails are LARGELY PUBLIC data in
  // EVE (a placed bounty, a declared war and a killmail are all public knowledge),
  // so the leak risk is low — but every read below was still checked. The kill-
  // rights reads return ONLY rights that are FOR SALE and open (or restricted to
  // the SESSION's own char/corp/alliance): killRightState.hasSaleAccess gates each
  // to price !== null AND (restrictedTo === null OR restrictedTo ∈ the session's
  // own owner ids), so a browser never sees a private, not-for-sale right on
  // another character. Verified live as Farmer (140000005 / corp 98000001)
  // 2026-07-22.
  //
  //   BOUNTIES (bounty/bountyProxyService.js) — bountyProxy is a plain BaseService
  // (super("bountyProxy"), NO MachoBindObject — top-level only). GetMyKillRights is
  // already listed (R57) and NOT re-added. Every bountyProxy MUTATOR stays refused,
  // named in the sweep below: AddToBounty (spends ISK), SellKillRight,
  // CancelSellKillRight, and the GM_* siblings.
  // GetBounties([targetIDs]) -> {type:"list", items:[[targetID, util.KeyVal{targetID,
  //   bounty, corporationID, allianceID}], ...]}: the bounty POOLS on the requested
  //   targets (public). ⚠ With an EMPTY arg the handler resolves to buildKnown
  //   BountyOwnerIds — every known char/corp/alliance — so arg-less returns the whole
  //   public bounty board. bounty amounts are ISK (bigint-safe); target/corp/alliance
  //   ids stay data (R7d).
  Object.freeze({ service: "bountyProxy", method: "GetBounties" }),
  // GetMyBounties() -> {type:"list", items:[util.KeyVal{contributionID, targetID,
  //   amount, corporationID, allianceID}]}: the bounties THIS character has PLACED
  //   (listContributionsForContributor(session.characterID)) — session-scoped, no
  //   args. Empty is a REAL "placed no bounties" state. amount is bigint ISK.
  Object.freeze({ service: "bountyProxy", method: "GetMyBounties" }),
  // GetKillRightsOnCharacters([toIDs]) -> {type:"list", items:[util.KeyVal{killRightID,
  //   fromID, toID, expiryTime(long), price, restrictedTo}]}: the FOR-SALE kill rights
  //   on the requested characters the session may buy (hasSaleAccess gate above). ⚠ arg
  //   is a LIST of target ids in args[0]; an empty list returns [] (a real "asked about
  //   none"). Same row shape as R57's GetMyKillRights; ids stay data (R7d), price bigint.
  Object.freeze({ service: "bountyProxy", method: "GetKillRightsOnCharacters" }),
  // GetBountiesAndKillRights([bountyTargetIDs],[killRightTargetIDs]) -> [bountiesList,
  //   killRightsList]: the two reads above in one 2-tuple (public bounty pools + for-sale
  //   kill rights). bountyTargetIDs empty resolves to the whole board (as GetBounties);
  //   killRightTargetIDs empty returns [].
  Object.freeze({ service: "bountyProxy", method: "GetBountiesAndKillRights" }),
  // The RANKED BOUNTY LEADERBOARDS — the top 10 bounty pools by owner kind, each a
  //   [list<util.KeyVal{targetID, bounty, corporationID, allianceID}>, resultTime(long)]
  //   2-tuple. Public leaderboard data; no args, no session scope. Empty is legitimate.
  Object.freeze({ service: "bountyProxy", method: "GetTopPilotBounties" }),
  Object.freeze({ service: "bountyProxy", method: "GetTopCorpBounties" }),
  Object.freeze({ service: "bountyProxy", method: "GetTopAllianceBounties" }),
  // SearchCharBounties(targetID) -> {type:"list", items:[[rank, util.KeyVal{...pool}]]}
  //   | {type:"list", items:[]}: where a character sits in the ranked bounty pools (or
  //   empty when not ranked). Public; args[0]=targetID. targetID stays data (R7d).
  Object.freeze({ service: "bountyProxy", method: "SearchCharBounties" }),
  //
  //   WARS (corporation/warsInfoMgrService.js) — warsInfoMgr is a plain BaseService
  // (super("warsInfoMgr"), NO MachoBindObject — top-level only) and is READ-ONLY:
  // it defines only these six handlers, no mutator. The war WRITE surface is the
  // DISTINCT bound warRegistry service (CreateWarAllyOffer / AcceptSurrender / …) and
  // corpRegistry.DeclareWarAgainst — neither is on warsInfoMgr and neither is listed.
  // War records are PUBLIC (a war declaration is public knowledge); they carry warID,
  // declaredByID, againstID, the FILETIME timestamps, billID, mutual, openForAllies,
  // allies and reward — no operational-calendar field like the structure reads had.
  // GetWarsByOwnerID(ownerID) -> CachedMethodCallResult wrapping a CRowset over the
  //   17-column WAR header (warID, declaredByID, againstID, timeDeclared/Started/Finished
  //   FILETIMEs, retracted, retractedBy, billID, mutual, createdFromWarID, openForAllies,
  //   canBeRetracted, reasonEnded, warHQ, noOfAllies, reasonStarted). ⚠ TWO wrappers to
  //   unpeel (cache result -> CRowset), exactly as the R61 corp-asset reads. Public;
  //   entity ids stay data (R7d); FILETIMEs bigint.
  Object.freeze({ service: "warsInfoMgr", method: "GetWarsByOwnerID" }),
  // GetWarsByOwners([ownerIDs]) -> {type:"dict", entries:[[ownerID, {type:"dict",
  //   entries:[[warID, util.KeyVal{...war}]]}], ...]}: the wars for each requested owner,
  //   as a per-owner dict of warID -> war KeyVal. ⚠ arg is a LIST of owner ids in args[0].
  Object.freeze({ service: "warsInfoMgr", method: "GetWarsByOwners" }),
  // GetTop50([maxWarID]) -> CachedMethodCallResult wrapping the SAME war CRowset,
  //   the 50 most-recent wars below maxWarID (0 = newest 50). Public war board.
  Object.freeze({ service: "warsInfoMgr", method: "GetTop50" }),
  // GetWarsRequiringAssistance([ownerID]) -> {type:"list", items:[util.KeyVal{...war}]}:
  //   the wars where ownerID is the DEFENDER and openForAllies (the "help wanted" board);
  //   ownerID falls back to the SESSION alliance/corp when 0. Public.
  Object.freeze({ service: "warsInfoMgr", method: "GetWarsRequiringAssistance" }),
  // GetWarsForStructure(structureID) -> {type:"list", items:[util.KeyVal{...war}]}: the
  //   wars associated with a structure, newest first. Public; args[0]=structureID.
  Object.freeze({ service: "warsInfoMgr", method: "GetWarsForStructure" }),
  // GetPublicWarInfo(warID) -> util.KeyVal{...war} | null: one war's public detail (the
  //   handler is literally named "public"); null for an unknown warID (a real state).
  //   args[0]=warID.
  Object.freeze({ service: "warsInfoMgr", method: "GetPublicWarInfo" }),
  //
  //   KILLMAIL (corporation/warStatisticMgrService.js). ⚠ VERIFY-FIRST BINDING
  // (flagged in the worklist): warStatisticMgr defines MachoResolveObject /
  // MachoBindObject (it IS a bindable service, and GetBaseInfo/GetKills/GetKillsByGroup
  // are BOUND reads that resolve the warID from session._boundWarStatisticID). BUT
  // Handle_GetKillMail(args) reads killID straight from args[0] (normalizeKillmailIDArg)
  // and does NOT touch the bound context, so it answers a plain TOP-LEVEL /call — the
  // preferred binding per the worklist. Confirmed live: a top-level call to
  // warStatisticMgr.GetKillMail(killID) dispatched through the ordinary callMethod seam
  // and returned without any MachoBindObject step. Only GetKillMail is exposed; the
  // bound-only siblings (MachoBindObject / GetBaseInfo / GetKills / GetKillsByGroup) and
  // MachoResolveObject stay refused, named in the sweep below.
  // GetKillMail(killID[, hashValue]) -> util.KeyVal killmail payload | null: one public
  //   killmail by id (an optional hashValue verifies it; a mismatch or unknown id -> null,
  //   a real state). Killmails are public. victim/attacker/ship ids stay data (R7d); ISK
  //   damage/value fields are bigint-safe, killTime a bigint FILETIME.
  Object.freeze({ service: "warStatisticMgr", method: "GetKillMail" }),
  // --- R68 plumbing sweep: map / starmap READS (the whole map read set) --------
  //
  // Eleventh batch of the operator's plumbing sweep — reads made reachable +
  // decodable so a later goal builds UI cheaply; NO panel/tab/store slice ships.
  // SEVENTEEN read-only pairs on ONE service (map / services/map/mapService.js),
  // each grep-confirmed to have an existing TOP-LEVEL Handle_* (map extends
  // BaseService super("map") with NO MachoBindObject — the R1/R2 GetStationInfo
  // pair already dispatches top-level, proving the whole service is). Never a new
  // handler; the map mutating/config siblings stay refused before dispatch.
  //
  //   OWNERSHIP-SAFETY (verified LIVE as Farmer 140000005 / corp 98000001,
  // 2026-07-22 — R63's lesson: a "My"/"safe" hint is not a guarantee). Most map
  // reads are PUBLIC starmap/region data (sov, incursion, fac-war, beacon counts,
  // station counts) — no owner/location arg points them at another player. The
  // four flagged reads were each checked against the handler AND live:
  //   • GetMyExtraMapInfo / GetMyExtraMapInfoAgents — DESPITE the "My" prefix,
  //     both handlers return a HARDCODED buildEmptyRowset and read NOTHING from
  //     the session or any store, so there is no data to leak by construction;
  //     live they return an empty rowset. Safe.
  //   • GetSolarSystemVisits — session-scoped via getSessionCharacterID(session)
  //     with NO arg that can override the character, so it returns ONLY the
  //     session's own visit rows; a caller cannot point it at another character.
  //   • GetHistory — NOT session-scoped: keyed off (statID, hours) args, it
  //     answers GLOBAL aggregate map statistics (jumps/kills per system), never a
  //     personal history. Public.
  //
  // GetStationCount() -> {type:"list", items:[[solarSystemID, count], ...]} for
  //   EVERY known system (ignores args; built from worldData). Public/global.
  Object.freeze({ service: "map", method: "GetStationCount" }),
  // GetSolarsystemItems(solarSystemID) -> Rowset[groupID, typeID, itemID, itemName,
  //   locationID, orbitID, connector, x, y, z, celestialIndex, orbitIndex]: the
  //   celestials/belts/stations/gates/structures in one system. args[0]=systemID;
  //   an unknown/0 system answers an EMPTY rowset (a real state). Public; ids stay
  //   data (R7d), positions are reals.
  Object.freeze({ service: "map", method: "GetSolarsystemItems" }),
  // GetHistory(statID, hours) -> CachedMethodCallResult wrapping Rowset[solarSystemID,
  //   value1, value2, value3]: the aggregate map-stat history (statID 1=jumps,
  //   3=kills, 5=facwar kills) over `hours`. ⚠ TWO wrappers to unpeel (cache result
  //   -> Rowset). NOT session-scoped — global aggregate, never personal. Empty is a
  //   real "no activity in this seeded world" state.
  Object.freeze({ service: "map", method: "GetHistory" }),
  // GetSolarSystemVisits() -> Rowset[lastDateTime, solarSystemID, visits]: the
  //   SESSION character's own per-system visit tally (getSessionCharacterID; no arg
  //   override). lastDateTime is a FILETIME; empty is a real "no visits" state.
  Object.freeze({ service: "map", method: "GetSolarSystemVisits" }),
  // GetBeaconCount() -> {type:"dict", entries:[[solarSystemID, count], ...]}: the
  //   active FLEET-BEACON count per system (public/global; empty when no fleets have
  //   lit a beacon). No args, no session scope.
  Object.freeze({ service: "map", method: "GetBeaconCount" }),
  // GetCurrentSovData(locationID) -> Rowset[locationID, solarSystemID, constellationID,
  //   regionID, ownerID, allianceID, corporationID, claimStructureID, infrastructureHubID,
  //   stationID, claimTime(long)]: current sovereignty claims (locationID default 0 =
  //   all). Public; ids stay data (R7d), claimTime bigint FILETIME. Empty in highsec.
  Object.freeze({ service: "map", method: "GetCurrentSovData" }),
  // GetRecentSovActivity() -> Rowset[solarSystemID, ownerID, oldOwnerID, stationID,
  //   changeTime(long)]: recent sov ownership changes (public; argless). Empty is real.
  Object.freeze({ service: "map", method: "GetRecentSovActivity" }),
  // GetFacWarZoneInfo(factionID) -> util.KeyVal{factionID, systemUpgradeLevel:dict}:
  //   the faction-warfare contested-zone summary for a militia faction. Public;
  //   args[0]=factionID (an empty/0 dict is a real "no FW contest" state).
  Object.freeze({ service: "map", method: "GetFacWarZoneInfo" }),
  // GetDeadspaceAgentsMap(languageID) / GetDeadspaceComplexMap(languageID) -> null
  //   in this world (the static deadspace overlays are not modelled). A legitimate
  //   "no overlay" answer, not a failure; args[0]=languageID.
  Object.freeze({ service: "map", method: "GetDeadspaceAgentsMap" }),
  Object.freeze({ service: "map", method: "GetDeadspaceComplexMap" }),
  // GetMyExtraMapInfo() -> EMPTY Rowset[characterID, locationID];
  // GetMyExtraMapInfoAgents() -> EMPTY Rowset[fromID, rank]. ⚠ Both return a
  //   HARDCODED empty rowset and read NOTHING off the session (see ownership note
  //   above) — no cross-character leak is possible. Argless.
  Object.freeze({ service: "map", method: "GetMyExtraMapInfo" }),
  Object.freeze({ service: "map", method: "GetMyExtraMapInfoAgents" }),
  // GetConstellationLPData(constellationID) -> EMPTY Rowset[solarSystemID,
  //   loyaltyPoints] (the FW LP overlay is not seeded). Public; args[0]=constellationID.
  Object.freeze({ service: "map", method: "GetConstellationLPData" }),
  // GetAllRoamingWeatherSystems() -> EMPTY Rowset[locationID, sceneType] (no roaming
  //   weather seeded). Public/global; argless. Empty is a real state.
  Object.freeze({ service: "map", method: "GetAllRoamingWeatherSystems" }),
  // GetSecurityModifiedSystems() -> EMPTY Rowset[solarSystemID]: systems whose
  //   security was modified (e.g. Triglavian invasion). ⚠ This is the MAP read; the
  //   distinct securityMgr.get_modified_systems is NOT wired. Public; argless.
  Object.freeze({ service: "map", method: "GetSecurityModifiedSystems" }),
  // GetIncursionGlobalReport() -> {type:"list", items:[util.KeyVal{taleID,
  //   templateClassID, templateNameID, stagingSolarSystemID, aggressorFactionID, state,
  //   influence, hasFinalEncounter, effects, rewardGroupID, incursedSystems, severity,
  //   hasChat, ...}]} | []: every active incursion (public/global). Empty = no
  //   incursions seeded, a real state.
  Object.freeze({ service: "map", method: "GetIncursionGlobalReport" }),
  // GetSystemsInIncursions() -> Rowset[locationID, sceneType, templateNameID]: the
  //   systems currently under incursion (public/global; argless). Empty is real.
  Object.freeze({ service: "map", method: "GetSystemsInIncursions" }),
  // --- R69 plumbing sweep: in-space info-service READS (sov / ESS / pvp-filament / fleet ads) --
  //
  // Twelfth batch of the operator's plumbing sweep — reads made reachable +
  // decodable so a later goal builds UI cheaply; NO panel/tab/store slice ships.
  // EIGHTEEN read-only pairs across FOUR services, each grep-confirmed to have an
  // existing TOP-LEVEL Handle_* (every one of these services extends BaseService
  // with NO MachoBindObject — they dispatch top-level like map/agentMgr). Never a
  // new handler; every mutating/action sibling stays refused before dispatch (the
  // refusal sweep in webGatewayServiceCall.test.js names the notable ones).
  //
  //   OWNERSHIP-SAFETY (verified LIVE as Farmer 140000005 on 2026-07-22, and the
  // three flagged seams cross-checked against a SECOND session — R63's lesson: a
  // "My"/"safe" hint is not a guarantee, read the handler AND check live):
  //   • pvpFilamentMgr.GetCharacterStatistics — the flagged one — takes
  //     [matchTypeID, scheduleID], NOT a charID, and returns a HARDCODED all-zero
  //     statistics dict (CHARACTER_STATISTIC_FIELDS) that reads NOTHING off any
  //     character store. There is no charID parameter and no per-character data
  //     path, so no foreign character's stats can be requested or returned. Live:
  //     a second session got the identical zeroed dict. Safe by construction.
  //   • essMgr.GetMainBankTheftsForClientSolarSystem / GetReserveBank... — keyed by
  //     systemID (arg OR session), they answer the SYSTEM's ESS theft history
  //     (state.theftHistory{Main,Reserve}) — public in-space ESS broadcast events,
  //     not the requesting character's private ledger nor any single character's
  //     private data. A caller can only ever read a system's public event list.
  //     Live: empty for Farmer's highsec system (a real "no ESS theft" state).
  //   • fleetProxy.GetMyFleetFinderAdvert — DESPITE the "My" prefix, its handler
  //     derives the fleet purely from getSessionCharacterID(session) (no caller id)
  //     and returns ONLY the session's own fleet's registered advert (null when not
  //     in a fleet). Live: null for docked Farmer. Safe.
  //   • fleetProxy.GetAvailableFleetAds is the public fleet-finder listing, but
  //     session-FILTERED (isAdvertOpenToSession) so a caller sees only ads open to
  //     them. sovMgr's six reads are PUBLIC solar-system sovereignty data (structures/
  //     claim/hub/fuel-access-group) keyed by systemID or session — no owner arg
  //     points them at private data. essMgr.GetDataForClientSolarSystem is the public
  //     in-space ESS state; IsClientLinkedToReserveBank is a session-scoped boolean.
  //
  // sovMgr (services/map/sovMgrService.js). GetSovStructuresInfoForLocalSolarSystem()
  //   -> list<KeyVal{itemID,typeID,ownerID,corporationID,allianceID,solarSystemID,
  //   campaignState|null,vulnerabilityState|null,defenseMultiplier,isCapital}> for the
  //   SESSION's system; GetSovStructuresInfoForSolarSystem(systemID) is the SAME payload
  //   keyed by args[0]. Public; empty list in highsec (no sov structures) — a real state.
  Object.freeze({ service: "sovMgr", method: "GetSovStructuresInfoForLocalSolarSystem" }),
  Object.freeze({ service: "sovMgr", method: "GetSovStructuresInfoForSolarSystem" }),
  // GetSystemSovereigntyInfo(systemID) -> objectex1 SovClaimInfo[claimStructureID,
  //   corporationID, allianceID] | null; GetInfrastructureHubInfo(systemID) -> objectex1
  //   SovHubInfo[hubID, corporationID, allianceID, claimTime(long)] | null. Positional
  //   header args (header[1]); null in highsec. Public; ids stay data (R7d), claimTime bigint.
  Object.freeze({ service: "sovMgr", method: "GetSystemSovereigntyInfo" }),
  Object.freeze({ service: "sovMgr", method: "GetInfrastructureHubInfo" }),
  // GetSovHubFuelAccessGroup(systemID) -> the hub's fuel-access-group id | null (a system-
  //   scoped hub setting); IsOnLocalSovHubFuelAccessGroup() -> bool (session-derived). Both
  //   read-only; the SetSovHubFuelAccessGroup / Acquire/DestroySkyhooks WRITERS stay refused.
  Object.freeze({ service: "sovMgr", method: "GetSovHubFuelAccessGroup" }),
  Object.freeze({ service: "sovMgr", method: "IsOnLocalSovHubFuelAccessGroup" }),
  // essMgr (services/dynamic/essMgrService.js). GetDataForClientSolarSystem(systemID?) ->
  //   dict{essID,beaconID,typeID,solarSystemID,currentOutput,mainValue,reserveValue,
  //   mainBankLink|null,reserveBankLastPulseInitiated(long)|null,reserveBankPulsesRemaining,
  //   reserveBankPulsesTotal,reserveBankActiveLinks} | null (null when the system has no ESS —
  //   a real state). Public in-space ESS state; ISK values (main/reserveValue) bigint-safe.
  Object.freeze({ service: "essMgr", method: "GetDataForClientSolarSystem" }),
  // IsClientLinkedToReserveBank() -> bool for the SESSION character in the SESSION system.
  Object.freeze({ service: "essMgr", method: "IsClientLinkedToReserveBank" }),
  // GetMainBankTheftsForClientSolarSystem(systemID?) / GetReserveBankTheftsForClientSolarSystem
  //   (systemID?) -> list of the SYSTEM's public ESS theft events (empty when none). See the
  //   ownership note above: system-scoped public in-space data, not a private ledger. The ESS
  //   LINK/UNLINK/UNLOCK WRITERS on this service stay refused.
  Object.freeze({ service: "essMgr", method: "GetMainBankTheftsForClientSolarSystem" }),
  Object.freeze({ service: "essMgr", method: "GetReserveBankTheftsForClientSolarSystem" }),
  // pvpFilamentMgr (services/activity/pvpFilamentMgrService.js — the abyssal Proving Grounds
  //   event surface). GetAllEvents()/GetActiveEvents() -> empty dict; GetMostRecentEvent()/
  //   GetNextEventDate() -> null; all four are "no Proving Grounds event in this world" states.
  Object.freeze({ service: "pvpFilamentMgr", method: "GetAllEvents" }),
  Object.freeze({ service: "pvpFilamentMgr", method: "GetActiveEvents" }),
  Object.freeze({ service: "pvpFilamentMgr", method: "GetMostRecentEvent" }),
  Object.freeze({ service: "pvpFilamentMgr", method: "GetNextEventDate" }),
  // ⚠ GetLeaderboard(matchTypeID, scheduleID) and GetCharacterStatistics(matchTypeID,
  //   scheduleID) RETURN null and push the data as an OnPVPFilaments{Leaderboard,
  //   CharacterStatistics} NOTIFICATION — the gateway captures it in the response envelope's
  //   `notifications` array (drain-on-read), so the decoder reads it from there, not `result`.
  //   Both carry empty/zeroed data (leaderboard entries:[]; stats rank/wins/losses/draws all 0)
  //   in this world. GetCharacterStatistics takes NO charID (see ownership note) — safe. The
  //   JoinPVPQueue / LeavePVPQueue / AbyssalPVPEndGateActivation actions stay refused.
  Object.freeze({ service: "pvpFilamentMgr", method: "GetLeaderboard" }),
  Object.freeze({ service: "pvpFilamentMgr", method: "GetCharacterStatistics" }),
  // R92 Phase-3 top-level WRITES — in-space services: sovereignty-hub config +
  // skyhooks (sovMgr), ESS bank link/unlink/unlock (essMgr), abyssal deadspace
  // deploy/gate activations (abyssalMgr), and the abyssal PvP queue/end-gate
  // (pvpFilamentMgr). Every one is confirm-gated at the BFF (a stray click or
  // stray POST cannot fire it) and Farmer is DOCKED, so none is live-exercisable
  // in this pass — reachability + refuses-without-confirm only. The abyssal +
  // pvp actions are all rejection/no-op stubs server-side (no runtime abyssal
  // content in this world): AbyssalEntranceDeployment/GateActivation/…, JoinPVPQueue
  // and AbyssalPVPEndGateActivation THROW an abyss/UserError; ClientIsReady and
  // LeavePVPQueue return null. The ESS bank writes resolve their solarSystemID
  // from the SESSION (getSystemIDFromSession) and return null.
  //
  // ⚠ EXTRA-CARE, NEVER FIRED LIVE: DestroySkyhooks / AcquireSkyhooks (destructive
  // sovereignty mutations) and RequestUnlockReserveBank (ISK payout) are reachable
  // + confirm-gated but never fired on the live world in the plumbing pass.
  //
  // ⚠ ARG-INJECTION — flagged, kept plumbed (server-side fix + QA later). Unlike
  // the ESS/abyssal/pvp writes (session-scoped or pure rejects), THREE sovMgr
  // writes take a CALLER-SUPPLIED id with NO session scope check and NO admin gate
  // at the handler: SetSovHubFuelAccessGroup(solarSystemID, groupID) writes the
  // fuel-access group of ANY system id; DestroySkyhooks(skyhookIDs) deletes ANY
  // skyhook by id; AcquireSkyhooks(skyhookIDs, groupID) reassigns ANY skyhook into
  // the SESSION's own corp/system. The brief's "admin -> 403" does NOT hold at the
  // handler level (there is no role check) — the confirm-gate + never-fire-live is
  // the only protection. Appended to docs/arg-injection-leak-handoff.md.
  Object.freeze({ service: "sovMgr", method: "SetSovHubFuelAccessGroup" }),
  Object.freeze({ service: "sovMgr", method: "DestroySkyhooks" }),
  Object.freeze({ service: "sovMgr", method: "AcquireSkyhooks" }),
  Object.freeze({ service: "essMgr", method: "AttemptLinkToMainBank" }),
  Object.freeze({ service: "essMgr", method: "AttemptLinkToReserveBank" }),
  Object.freeze({ service: "essMgr", method: "RequestMainBankUnlink" }),
  Object.freeze({ service: "essMgr", method: "RequestReserveBankUnlink" }),
  Object.freeze({ service: "essMgr", method: "RequestUnlockReserveBank" }),
  Object.freeze({ service: "abyssalMgr", method: "AbyssalEntranceDeployment" }),
  Object.freeze({ service: "abyssalMgr", method: "AbyssalEntranceGateActivation" }),
  Object.freeze({ service: "abyssalMgr", method: "AbyssalGateActivation" }),
  Object.freeze({ service: "abyssalMgr", method: "AbyssalEndGateActivation" }),
  Object.freeze({ service: "abyssalMgr", method: "ClientIsReady" }),
  Object.freeze({ service: "pvpFilamentMgr", method: "JoinPVPQueue" }),
  Object.freeze({ service: "pvpFilamentMgr", method: "LeavePVPQueue" }),
  Object.freeze({ service: "pvpFilamentMgr", method: "AbyssalPVPEndGateActivation" }),
  // fleetProxy (services/fleets/fleetProxyService.js). GetAvailableFleetAds() -> dict keyed by
  //   fleetID -> advert (the session-filtered public fleet-finder listing; empty when no open
  //   ads). GetMyFleetFinderAdvert() -> the SESSION's own fleet advert | null (see ownership
  //   note). Both read-only; the Apply/Add/Remove/Update advert WRITERS stay refused.
  Object.freeze({ service: "fleetProxy", method: "GetAvailableFleetAds" }),
  Object.freeze({ service: "fleetProxy", method: "GetMyFleetFinderAdvert" }),
  // R93 Phase-3 top-level WRITES — misc utility across six services whose READS
  // were wired earlier (agentMgr R64 / petitioner R70 / industryManager R15 /
  // planetMgr + structureAssetSafety R71 / structureDirectory R63). Each is
  // confirm-gated at the BFF (a stray click or stray POST cannot fire it) and
  // Farmer is DOCKED, so the nav writes return not-in-space and NONE of the
  // consequential writes is live-exercisable in this pass — reachability +
  // refuses-without-confirm only.
  //
  //   • agentMgr nav/journal WRITES. RemoveOfferFromJournal drops the bound
  //     agent's declined offer; GotoLocation / WarpToLocation / WarpToAgentInSpace
  //     drive the ship toward a mission target (all return null; docked => the
  //     resolver finds no in-space target and no movement happens).
  Object.freeze({ service: "agentMgr", method: "RemoveOfferFromJournal" }),
  Object.freeze({ service: "agentMgr", method: "GotoLocation" }),
  Object.freeze({ service: "agentMgr", method: "WarpToLocation" }),
  Object.freeze({ service: "agentMgr", method: "WarpToAgentInSpace" }),
  //   • petitioner support WRITES. ⚠ EXTRA-CARE CreatePetition opens a support
  //     ticket (outward-ish) — in THIS stub world Handle_CreatePetition records an
  //     audit event and returns false (rejected), but it is confirm-gated + never
  //     fired live regardless. PetitionerChat posts a message (returns null),
  //     CancelPetition changes a ticket's state (returns null). The remaining
  //     petitioner writers (DeletePetition / ClosePetition / MarkAsRead / the
  //     rating writers) stay refused.
  Object.freeze({ service: "petitioner", method: "CreatePetition" }),
  Object.freeze({ service: "petitioner", method: "PetitionerChat" }),
  Object.freeze({ service: "petitioner", method: "CancelPetition" }),
  //   • industryManager.CompleteManyJobs — the BATCH delivery (grants products +
  //     marks each job delivered), the batch sibling of the already-allowed
  //     CompleteJob. Confirm-gated at the BFF (a batch delivery is exactly the kind
  //     of action a stray click should not fire across a whole job list).
  Object.freeze({ service: "industryManager", method: "CompleteManyJobs" }),
  //   • ⚠ EXTRA-CARE planetMgr.DeleteLaunch (destructive) — deletes a customs-office
  //     launch by id. deleteLaunch(launchID, session.characterID) scopes to the
  //     session character in the store. Reachable + confirm-gated but NEVER fired live.
  Object.freeze({ service: "planetMgr", method: "DeleteLaunch" }),
  //   • structureDirectory.SetStructureDescription — rewrites a structure's
  //     description. GUARDED: the handler calls canManageStructure(session, structure)
  //     and throws StructureManagementDenied for a structure the session cannot
  //     manage, so a foreign structureID cannot be re-described. Confirm-gated.
  Object.freeze({ service: "structureDirectory", method: "SetStructureDescription" }),
  //   • ⚠ EXTRA-CARE structureAssetSafety MOVE WRITES (consequential — they relocate
  //     assets). MovePersonalAssetsToSafety / MoveCorpAssetsToSafety create an
  //     asset-safety wrap from the session character's / session corp's assets in a
  //     system (owner resolved from the SESSION, not a caller-supplied id);
  //     MoveSafetyWrapToStructure delivers a wrap to a destination. All return null.
  //     Reachable + confirm-gated but NEVER fired live.
  Object.freeze({ service: "structureAssetSafety", method: "MovePersonalAssetsToSafety" }),
  Object.freeze({ service: "structureAssetSafety", method: "MoveCorpAssetsToSafety" }),
  Object.freeze({ service: "structureAssetSafety", method: "MoveSafetyWrapToStructure" }),
  // R94 Phase-3 top-level WRITES — fleet top-level (W-FLEETPROXY + W-FLEETMGR),
  // the LAST Phase-3 top-level writes batch (CLOSES Phase-3 top-level writes;
  // the 3 deferred PLEX writes aside). Eleven writes across three fleet services
  // whose seams were wired earlier (fleetProxy READS R69; fleetObjectHandler bind
  // R72 / bound reads R85). Each is confirm-gated at the BFF (a stray click or
  // stray POST cannot fire it) and Farmer is DOCKED + fleetless, so the fleet-
  // management writes return a not-in-fleet error and none is live-exercisable —
  // reachability + refuses-without-confirm only.
  //
  //   • fleetObjectHandler.CreateFleet — mints a NEW fleet for the session
  //     character (createFleetRecord(session), then binds it). Session-scoped;
  //     takes no caller id. Confirm-gated; NEVER fired live (it would actually
  //     create a fleet). The MachoBindObject bind was R72; the fleet BOUND writes
  //     are Phase-4/WB-FLEET, NOT this batch.
  Object.freeze({ service: "fleetObjectHandler", method: "CreateFleet" }),
  //   • fleetProxy fleet-finder WRITES (the mutators that sat on the SAME service
  //     as the R69 fleet-finder reads, refused since R69). ApplyToJoinFleet(fleetID,
  //     [autoAccept]) applies to a PUBLIC advertised fleet; AddFleetFinderAdvert
  //     (advertData) posts / RemoveFleetFinderAdvert() pulls the session fleet's
  //     public advert; UpdateAdvertInfo(numMembers, [allowedDiff]) edits it. The
  //     advert writes resolve the fleet from the SESSION (getSessionCharacterID),
  //     not a caller id. (⚠ ApplyToJoinFleet takes a caller-supplied fleetID — the
  //     TARGET fleet to apply to — but applying to a PUBLIC advert is the intended
  //     semantics, not a foreign-fleet mutation; see the R94 arg-injection note.)
  //     UpdateAdvertAllowedEntities / UpdateFleetAdvertWithNewLeader stay refused.
  Object.freeze({ service: "fleetProxy", method: "ApplyToJoinFleet" }),
  Object.freeze({ service: "fleetProxy", method: "AddFleetFinderAdvert" }),
  Object.freeze({ service: "fleetProxy", method: "RemoveFleetFinderAdvert" }),
  Object.freeze({ service: "fleetProxy", method: "UpdateAdvertInfo" }),
  //   • fleetMgr fleet-management WRITES. ForceLeaveFleet() removes the session
  //     char from its fleet; AddToWatchlist(charIDs, favorites) / RemoveFromWatchlist
  //     (charID, favorites) / RegisterForDamageUpdates(favorites) tune the session's
  //     own fleet watchlist. Each acts on the SESSION's fleet (session.fleetid), no
  //     caller-supplied fleetID. All return null; docked+fleetless => not-in-fleet.
  Object.freeze({ service: "fleetMgr", method: "ForceLeaveFleet" }),
  Object.freeze({ service: "fleetMgr", method: "AddToWatchlist" }),
  Object.freeze({ service: "fleetMgr", method: "RemoveFromWatchlist" }),
  Object.freeze({ service: "fleetMgr", method: "RegisterForDamageUpdates" }),
  //   • ⚠ EXTRA-CARE OUTWARD fleetMgr broadcasts. BroadcastToBubble / BroadcastToSystem
  //     send a message to every fleet member in the session char's bubble / system
  //     (sendBroadcast on session.fleetid). Reachable + confirm-gated but NEVER
  //     broadcast on the live world in this plumbing pass. The fleet is resolved
  //     from the SESSION (session.fleetid), not a caller id.
  Object.freeze({ service: "fleetMgr", method: "BroadcastToBubble" }),
  Object.freeze({ service: "fleetMgr", method: "BroadcastToSystem" }),
  // --- R70 plumbing sweep: character / account / support READS (no UI) --------
  //
  // Thirteenth batch of the operator's plumbing sweep — reads made reachable +
  // decodable so a later goal builds UI cheaply; NO panel/tab/store slice ships.
  // SIXTEEN read-only pairs across THREE services (charUnboundMgr / petitioner /
  // the charMgr straggler), each grep-confirmed to have an existing TOP-LEVEL
  // Handle_* (charService.js super("charUnboundMgr"); petitionerService.js
  // super("petitioner") — a plain BaseService, no MachoBindObject; charMgrService.js
  // super("charMgr")). Never a new handler; every mutating sibling stays refused.
  //
  //   OWNERSHIP-SAFETY (handler read + verified LIVE as Farmer 140000005 on
  // 2026-07-22, flagged seams cross-checked against a FOREIGN charID / second
  // session — R63's lesson: a "My"/"safe" hint is not a guarantee):
  //   • charUnboundMgr.GetCharacterInfo(charID) delegates to Handle_GetCharacterToSelect,
  //     which REJECTS a charID not on the requesting account (characterBelongsToAccount
  //     -> returns null). So it answers the account's OWN character's selection data
  //     (which does include balance — the account's own) or null; a FOREIGN charID
  //     returns null, never that character's private data. The PUBLIC identity read is
  //     the already-wired charMgr.GetPublicInfo/GetPublicInfo3; this is the account-scoped
  //     one. Live: Farmer's own id returned Farmer's sheet; a foreign id (Test Two)
  //     returned null. Account-scoped, safe.
  //   • charUnboundMgr.GetCharacterLockType() -> null (a stub in this world) and
  //     GetCohortsForUser() -> {type:"list", items:[]} (a stub) read NO per-entity store
  //     and take no charID — nothing to leak. GetNumCharacters() counts the SESSION
  //     account's own characters (characterBelongsToAccount), account-scoped.
  //   • charMgr.GetRecentShipKillsAndLosses derives charId from the SESSION
  //     (session.characterID), and its args are [limit, startKillID] — PAGINATION, NOT a
  //     charID. listKillmailsForCharacter reads the session character's own kills+losses
  //     index; a caller cannot request a foreign character's killboard. Live: empty for
  //     Farmer (a real "no recent kills/losses" state). Session-scoped, safe.
  //   • petitioner is a STUB support service: every read returns constant/empty data with
  //     no per-entity store lookup, so no foreign-id path exists. GetMyPetitionsEx /
  //     GetUnreadMessages / GetPetitionMessages(petitionID) all return buildList([])
  //     regardless of args — a foreign petitionID yields the SAME empty list, never
  //     another ticket's messages. GetCategories -> [], GetCategoryHierarchicalInfo ->
  //     4 empty dicts, MayPetition -> -4 (disabled), IsZendeskEnabled -> true.
  //   • ⚠ petitioner.GetZendeskJwtLink is treated as a CREDENTIAL by contract: the decoder
  //     passes the string through and NEVER logs it, never caches it cross-session. In
  //     THIS world the handler returns a plain PUBLIC help-center URL
  //     (support.eveonline.com/hc/en-us/requests/new, or .../requests/<ticketID> when a
  //     ticketID kwarg is supplied) — NOT an actual signed JWT, and it carries no session-
  //     private secret. It is not caller-identity-derived beyond an optional ticket number
  //     that only forms a public URL path. Still handled token-safe (no logging) so the
  //     shape holds if a real signed link ever replaces the stub.
  //
  // charUnboundMgr (services/character/charService.js). Char-select + creation reads.
  // GetNumCharacters() -> int (count of the session account's characters).
  Object.freeze({ service: "charUnboundMgr", method: "GetNumCharacters" }),
  // GetCharacterInfo(charID) -> buildKeyVal char-selection data (unreadMailCount,
  //   characterID, corporationID, allianceID|null, stationID, solarSystemID, regionID,
  //   raceID/bloodlineID/ancestryID, skillPoints, shipTypeID, securityStatus, balance,
  //   createDateTime/startDateTime/skillQueueEndTime(long), ...) | null for a foreign/
  //   unknown charID. Account-scoped (see ownership note). ids stay data (R7d); longs bigint.
  Object.freeze({ service: "charUnboundMgr", method: "GetCharacterInfo" }),
  // GetCharacterLockType() -> null (stub); GetCohortsForUser() -> {type:"list", items:[]}
  //   (stub); both empty-by-design, plumbed for when the data lands.
  Object.freeze({ service: "charUnboundMgr", method: "GetCharacterLockType" }),
  Object.freeze({ service: "charUnboundMgr", method: "GetCohortsForUser" }),
  // The char-CREATION helpers (config/validation, no character data).
  // GetValidRandomName(raceID) -> a bare name STRING; ValidateNameEx(name) -> an int
  //   validation code; GetQAStarterSystemIDs() -> a bare list of starter systemIDs.
  //   Every mutating charUnboundMgr sibling (CreateCharacterWithDoll, DeleteCharacter,
  //   PrepareCharacterForDelete, SelectCharacterID's siblings, the Update* writers) stays
  //   refused; a test names the destructive ones.
  Object.freeze({ service: "charUnboundMgr", method: "GetValidRandomName" }),
  Object.freeze({ service: "charUnboundMgr", method: "ValidateNameEx" }),
  Object.freeze({ service: "charUnboundMgr", method: "GetQAStarterSystemIDs" }),
  // petitioner (services/support/petitionerService.js — a plain BaseService stub). Eight
  // read-only pairs; every one returns constant/empty data (see ownership note). The
  // WRITERS DeletePetition / ClosePetition / ClaimPetition / EscalatePetition / MarkAsRead /
  // the rating writers stay refused. (CreatePetition / PetitionerChat / CancelPetition are
  // allowlisted by the R93 WRITES batch — confirm-gated; CreatePetition never fired live.)
  // GetMyPetitionsEx() -> {type:"list", items:[]} (the session's own tickets; empty here).
  Object.freeze({ service: "petitioner", method: "GetMyPetitionsEx" }),
  // GetCategories() -> {type:"list", items:[]}; GetCategoryHierarchicalInfo() -> a 4-tuple
  //   of empty dicts. The petition category taxonomy (empty-by-design in this world).
  Object.freeze({ service: "petitioner", method: "GetCategories" }),
  Object.freeze({ service: "petitioner", method: "GetCategoryHierarchicalInfo" }),
  // GetPetitionMessages(petitionID) -> {type:"list", items:[]} (a foreign petitionID
  //   yields the same empty list — no cross-ticket access). MayPetition(categoryID,
  //   oocCharacterID) -> -4 (petitioning disabled). IsZendeskEnabled() -> true.
  Object.freeze({ service: "petitioner", method: "GetPetitionMessages" }),
  Object.freeze({ service: "petitioner", method: "MayPetition" }),
  Object.freeze({ service: "petitioner", method: "IsZendeskEnabled" }),
  // ⚠ GetZendeskJwtLink() -> a support-link STRING. CREDENTIAL by contract: pass through,
  //   NEVER log/cache/cross-session-expose. Public help-center URL in this world (see note).
  Object.freeze({ service: "petitioner", method: "GetZendeskJwtLink" }),
  // GetUnreadMessages() -> {type:"list", items:[]} (the session's own unread support
  //   messages; empty here).
  Object.freeze({ service: "petitioner", method: "GetUnreadMessages" }),
  // charMgr straggler (services/character/charMgrService.js). GetRecentShipKillsAndLosses(
  //   limit, startKillID) -> {type:"list", items:[util.KeyVal killmail rows]} for the
  //   SESSION character (kills + losses), empty when none. Args are PAGINATION, not a charID
  //   (see ownership note). Each row: killID, killTime(long FILETIME), solarSystemID,
  //   victim*/final* entity ids (R7d, kept as data), iskLost/iskDestroyed (bigint-safe),
  //   warID, killBlob. R56/R58 reserved this for a later goal; R70 wires it. Every charMgr
  //   write + GetPrivateInfo + MachoResolveObject stay refused (the sweep still names them).
  Object.freeze({ service: "charMgr", method: "GetRecentShipKillsAndLosses" }),
  // --- R71 plumbing sweep: Phase-1 DATA finisher — PI + asset-safety + strays --
  //
  // Fourteenth batch of the operator's plumbing sweep — reads made reachable +
  // decodable so a later goal builds UI cheaply; NO panel/tab/store slice ships.
  // EIGHT read-only TOP-LEVEL pairs across FOUR services, each grep-confirmed to
  // have an existing top-level Handle_* (planetMgrService.js super("planetMgr");
  // structureAssetSafetyService.js super("structureAssetSafety");
  // beyonceService.js super("beyonce"); shipService.js super("ship")). Never a new
  // handler; every mutating sibling stays refused (named in the sweep test below).
  // This CLOSES the Phase-1 top-level DATA reads.
  //
  //   ⚠⚠ structureDirectory.GetNearbyJumpBridges STAYS DELIBERATELY ABSENT — R63
  // LEAK category, verified in the handler (structureDirectoryService.js:612). Unlike
  // its wired sibling GetJumpBridgesWithMyAccess (:607 → buildJumpBridgeAccessPayload,
  // which PARTITIONS bridges by characterHasStructureService(session,…) into
  // hasAccessTo / hasNoAccessTo), GetNearbyJumpBridges applies NO access gate at all:
  // it lists EVERY non-destroyed Ansiblex in the world (filter is only
  // typeID === TYPE_ANSIBLEX_JUMP_BRIDGE && !destroyedAt) and returns, per bridge,
  // ownerID (owning corp), structureName (the owner's custom name), solarSystemID AND
  // destinationSolarsystemID — the private jump-link TOPOLOGY of rival corps'
  // infrastructure the session has no access to. That is the exact R38/R63 line
  // (GetStructures / GetMyCharacterStructures leaked rivals' operational state); the
  // owner+name+destination of a bridge you cannot use is more than a name+dot already
  // on the public map. Refused, and named in the sweep below. The access-SCOPED read
  // (GetJumpBridgesWithMyAccess, R63) is the safe way to read this.
  //
  //   OWNERSHIP-SAFETY (handler read + verified LIVE as Farmer 140000005 on
  // 2026-07-22; flagged seams cross-checked against a FOREIGN charID / second session
  // — R63's lesson: a "My"/"safe"/id-arg hint is not a guarantee):
  //   • planetMgr.GetPlanetsForChar(args, session) IGNORES args entirely and scopes to
  //     session.characterID (getCharacterRecord + planetRuntimeStore.listColoniesFor
  //     Character both take session.characterID). Despite the "ForChar" name it does
  //     NOT take a charID selecting another char's colonies — a foreign id in args is
  //     dead. GetMyLaunchesDetails is likewise session.characterID-scoped
  //     (listLaunchesForCharacter). Live: both empty for Farmer (a real "no colonies /
  //     no launches" state). Session-scoped, safe.
  //   • structureAssetSafety.GetItemsInSafetyForCharacter IGNORES args, scopes to
  //     session.characterID (listWrapsForOwner("char", session.characterID)).
  //     GetItemsInSafetyForCorp IGNORES args, scopes to session.corporationID
  //     (listWrapsForOwner("corp", session.corporationID)) — own corp only, never an
  //     arbitrary corpID. GetStructuresICanDeliverTo(solarSystemID) computes targets via
  //     getDeliveryTargetsForSession(session,…) and returns structures ONLY when the
  //     SESSION has active own char/corp wraps in that system; the arg is a system
  //     selector, not an ownership selector. Live: all empty for Farmer (no wraps).
  //     Session/corp-scoped, safe.
  //   • structureAssetSafety.GetWrapNames(wrapIDs) is a pure NAME-RESOLUTION lookup:
  //     wrapID -> wrapName string (a low-sensitivity label, default "Asset Safety Wrap
  //     <id>"), no operational field, no session. It takes arbitrary wrapIDs BY DESIGN
  //     (the retail client resolves ids it already holds); an unknown/foreign wrapID
  //     yields null. Config/lookup, low-risk — no private infrastructure state.
  //   • ship.GetShipConfiguration(args, session) reads SMB / fleet-hangar / corp-access
  //     BOOLEAN sharing flags. Its arg is a shipID (or session's active ship when
  //     arg-less), and _getShipConfiguration does NOT ownership-check a supplied shipID —
  //     so the BFF route deliberately calls it ARG-LESS, exposing only the SESSION's own
  //     active ship config (never a foreign shipID). Session-scoped at the bridge boundary.
  //   • beyonce.GetFormations returns STATIC formation-shape reference data (Diamond /
  //     Arrow point offsets), reading no session and no per-entity store — nothing to leak.
  //
  // planetMgr (services/planet/planetMgrService.js). The TWO top-level PI reads.
  // GetPlanetsForChar() -> CRowset[solarSystemID, planetID, typeID, numberOfPins,
  //   celestialIndex] of the SESSION character's colonies (empty for Farmer). ids as data.
  Object.freeze({ service: "planetMgr", method: "GetPlanetsForChar" }),
  // GetMyLaunchesDetails() -> CRowset[launchID, solarSystemID, itemID, ownerID, planetID,
  //   status, launchTime(long FILETIME), x, y, z] of the SESSION character's customs-office
  //   launches (empty for Farmer). launchTime bigint; ids as data. (planetMgr.DeleteLaunch —
  //   destructive — is allowlisted by the R93 WRITES batch, confirm-gated + NEVER fired
  //   live; the GM* verbs stay refused.)
  Object.freeze({ service: "planetMgr", method: "GetMyLaunchesDetails" }),
  // structureAssetSafety (services/structure/structureAssetSafetyService.js). FOUR reads.
  // (The three asset-safety MOVE mutators — MovePersonalAssetsToSafety /
  // MoveCorpAssetsToSafety / MoveSafetyWrapToStructure — are allowlisted by the R93
  // WRITES batch, confirm-gated + NEVER fired live; owner resolved from the SESSION.)
  // GetItemsInSafetyForCharacter() -> {type:"list", items:[util.KeyVal{solarSystemID,
  //   assetWrapID, wrapName, ejectTime(long), daysUntilCanDeliverConst, daysUntilAutoMove
  //   Const, nearestNPCStationInfo(KeyVal|null)}]} — the SESSION char's own wraps (empty).
  Object.freeze({ service: "structureAssetSafety", method: "GetItemsInSafetyForCharacter" }),
  // GetItemsInSafetyForCorp() -> the SAME wrap-list, CachedMethodCallResult-wrapped, for
  //   the SESSION corp (listWrapsForOwner("corp", session.corporationID)) — own corp only.
  Object.freeze({ service: "structureAssetSafety", method: "GetItemsInSafetyForCorp" }),
  // GetWrapNames(wrapIDs) -> {type:"dict", entries:[[wrapID, name|null], …]} — a name
  //   lookup (see ownership note); ids/names kept as data (R7d).
  Object.freeze({ service: "structureAssetSafety", method: "GetWrapNames" }),
  // GetStructuresICanDeliverTo(solarSystemID) -> [ {type:"list", items:[KeyVal{itemID,
  //   typeID, solarSystemID, itemName}]} | empty, stationInfo(KeyVal)|null ] — the
  //   SESSION's own deliverable structures in a system, only when own wraps exist there.
  Object.freeze({ service: "structureAssetSafety", method: "GetStructuresICanDeliverTo" }),
  // beyonce (services/ship/beyonceService.js). GetFormations() -> CachedMethodCallResult
  //   wrapping [["Diamond",[[x,y,z],…]], ["Arrow",[…]]] — static formation reference data.
  //   Every beyonce Cmd* mutator is the AUTOPILOT movement surface (separately allowed
  //   above), not part of this read-only batch.
  Object.freeze({ service: "beyonce", method: "GetFormations" }),
  // ship (services/ship/shipService.js). GetShipConfiguration([shipID]) -> {type:"dict",
  //   entries:[[allowFleetSMBUsage,bool],[SMB_AllowFleetAccess,bool],[allowCorpSMBUsage,
  //   bool],[SMB_AllowCorpAccess,bool],[FleetHangar_AllowFleetAccess,bool],[FleetHangar_
  //   AllowCorpAccess,bool]]} — the ship's SMB / fleet-hangar sharing flags. The BFF route
  //   calls it ARG-LESS → the SESSION's own active ship (see ownership note). The write
  //   sibling ConfigureShip stays refused.
  Object.freeze({ service: "ship", method: "GetShipConfiguration" }),
  // R72 PLUMBING sweep — the five GATEWAY-BIND reads (the Phase-2 prerequisites).
  // Unlike every prior read batch these do NOT return decodable rows; each returns
  // a BOUND-OBJECT HANDLE (a Moniker or an OID substruct) that a later Phase-2
  // bound-read batch dispatches methods on. Only the bind/gateway pair is wired
  // here — NO bound method (each bound read is its own Phase-2 batch with its own
  // R63 ownership check). Mirrors the invbroker/ship/agentMgr MachoBindObject
  // two-step already established (the OID is confined to the gateway; the BFF
  // holds an opaque boundHandle). CLOSES Phase-1 top-level reads.
  //
  // skillMgr2.GetMySkillHandler() -> Moniker("skillHandler", null, <charID>, null)
  //   — the gateway all RB-SKILL reads hang off. NOT a MachoBindObject: a GetXxx
  //   that returns a Moniker whose bindParams is the SESSION's own characterID
  //   (skillMgr2Service.js:8 reads session.characterID||charid||userid and IGNORES
  //   args). SESSION-DERIVED — a caller cannot steer it at another character's
  //   skills. Because it returns a Moniker (not an "N=" OID substruct) it rides the
  //   ordinary top-level /call seam, not the /bound/bind two-step; the Phase-2
  //   skills reads address service "skillHandler" (own, session-keyed).
  Object.freeze({ service: "skillMgr2", method: "GetMySkillHandler" }),
  // dogmaIM.MachoBindObject(bindParams, [nestedCall]) — binds the ship/location
  //   dogma manager; gateway for RB-DOGMA (GetAllInfo, …). buildBoundObjectResponse
  //   registers the caller's bindParameter against the OID, BUT every dogma bound
  //   read resolves the active ship from the SESSION (_getShipID(session),
  //   dogmaService.js:1089) and never consults getBoundObjectParams/currentBound
  //   ObjectID — so the registered param is inert for reads. EFFECTIVELY SESSION-
  //   SCOPED. (GetAllInfo stays REFUSED as a top-level pair — it is the undock
  //   bootstrap; only the bind is opened here.)
  Object.freeze({ service: "dogmaIM", method: "MachoBindObject" }),
  // entity.MachoBindObject(bindParams, [nestedCall]) — binds an in-space entity;
  //   gateway for WB-ENTITY drone commands (Phase-4) + entity reads. The handler
  //   (entityService.js:25) IGNORES bindParams, mints a fresh boundId, and the
  //   bound Cmd* methods act on the SESSION's OWN in-space drones/scene. SESSION-
  //   SCOPED — no foreign OID is bound.
  Object.freeze({ service: "entity", method: "MachoBindObject" }),
  // R102 PLUMBING sweep — WB-ENTITY: the 4 Phase-4 BOUND drone-command WRITES that
  // hang off the SAME entity.MachoBindObject bind (above). Reachable only via
  // confirm-gated BFF POST routes (the browser must send `confirm:true` or the
  // route refuses before any dispatch); CmdAbandonDrone — which PERMANENTLY DISOWNS
  // a flight of drones — carries an extra-explicit confirm message. Dispatched as
  // BOUND methods off entityBindSpec() (mirrors the R100 dogma-write two-step).
  //
  // ⚠ OWNERSHIP: all four resolve the acting ship + scene from the SESSION
  // (getShipStateForSession) and every command validates each caller-supplied
  // droneID against the session ship's control — droneRuntime rejects any drone
  // whose controllerID !== the session ship's itemID ("not currently under this
  // ship's control"). SESSION-SCOPED — a foreign droneID cannot be commanded. No
  // handoff-doc flag.
  Object.freeze({ service: "entity", method: "CmdReturnHome" }),
  Object.freeze({ service: "entity", method: "CmdSalvage" }),
  Object.freeze({ service: "entity", method: "CmdAbandonDrone" }),
  Object.freeze({ service: "entity", method: "CmdReconnectToDrones" }),
  // scanMgr.GetSystemScanMgr() -> a bound-object substruct for the SESSION's own
  //   system scan manager; gateway for RB-SCAN. Handler (scanMgrService.js:1534)
  //   calls _ensureSystemParity(session) then buildBoundObjectSubstruct("scanMgr",
  //   session) — the target is the session's CURRENT system, derived server-side.
  //   SESSION-DERIVED. Like GetMySkillHandler it is a GetXxx (not MachoBindObject),
  //   but it returns a real "N=" OID substruct so it DOES ride the /bound/bind
  //   two-step. (scanMgr also defines MachoBindObject; that is NOT wired.)
  Object.freeze({ service: "scanMgr", method: "GetSystemScanMgr" }),
  // fleetObjectHandler.MachoBindObject(bindParams, [nestedCall]) — binds the fleet
  //   object; gateway for RB-FLEET. ⚠ BINDS-ARBITRARY-OID (see the handoff doc):
  //   the handler (fleetObjectHandlerService.js:106) takes bindParams[0] as the
  //   fleetID (fallback session.fleetid) with NO membership check and stores it in
  //   the bound context; the Phase-2 bound reads honor it via
  //   _resolveFleetIDFromSession, and fleetRuntime.getWings/getMotd/
  //   getFleetComposition take a bare fleetID and return that fleet's roster with
  //   no gate. The BIND is a retail prerequisite so it is wired, but the Phase-2
  //   RB-FLEET bound reads off it MUST each get a hard R63 ownership check (or the
  //   bind must reject a foreign fleetID). Flagged in docs/arg-injection-leak-
  //   handoff.md. The BFF binds it session-scoped (no caller fleetID), but
  //   /api/bridge/call forwards args verbatim, so a browser could still bind a
  //   foreign fleetID directly — the leak lives on the bound read, not the bind.
  Object.freeze({ service: "fleetObjectHandler", method: "MachoBindObject" }),
  // R73 PLUMBING sweep — the FIRST Phase-2 BOUND-READ batch: the 13 skill reads
  // (RB-SKILL) that hang off the R72 skill-handler gateway. skillMgr2.
  // GetMySkillHandler (allowlisted R72) returns Moniker("skillHandler", null,
  // <session charID>, null); because that is a Moniker (not an "N=" OID
  // substruct) the retail client addresses these reads on the ORDINARY top-level
  // /call seam with service string "skillHandler" — NOT a /bound/bind two-step.
  // "skillHandler" is a real registered service (skillHandlerService.js: class
  // SkillHandlerService extends SkillMgrService, this._name = "skillHandler"), so
  // serviceManager.lookup("skillHandler") resolves to a SkillMgrService instance
  // and dispatches these inherited Handle_* — the SAME handlers as skillMgr, but
  // under the distinct service name the moniker actually names. Wiring them here
  // (not on skillMgr) keeps skillMgr's browser surface exactly its one WRITE
  // (SaveNewQueue) and leaves every skillMgr read still refused.
  //
  // ⚠ OWNERSHIP (R63 + the 2026-07-22 arg-injection audit): every one of these 13
  // derives the character from the SESSION via SkillMgrService._getCharacterId ->
  // getCharacterIDFromSession(session) (session.characterID||charid||userid) and
  // NONE reads a caller-supplied charID from args. The two that DO read args —
  // CheckInjectionConstraints(itemID, qty) and GetDiminishedSpFromInjectors(
  // typeID, qty, nonDiminishing) — take an injector ITEM/TYPE id and counts, not a
  // character id, and CheckInjectionConstraints resolves the injector against the
  // SESSION's own items (throws if not owned). So a browser injecting a foreign
  // charID via /api/bridge/call cannot steer any of these at another character's
  // skills — verified live cross-account (Farmer vs Test Two). Own-skills-only; no
  // handoff-doc flag needed. Skills are PRIVATE (SP, queue, implants, attributes,
  // respec), so this session-scoping is the whole safety story for the batch.
  //
  // ⚠ READS ONLY. Every SP-SPENDING sibling on this same (inherited) surface —
  // SaveNewQueue/AbortTraining/InjectSkillpoints/InjectSkillIntoBrain/ExtractSkills/
  // PurchaseSkills/ApplyFreeSkillPoints*/Split/CombineSkillInjector — is
  // DELIBERATELY ABSENT under "skillHandler" too; only these 13 reads are opened.
  Object.freeze({ service: "skillHandler", method: "GetSkills" }),
  Object.freeze({ service: "skillHandler", method: "GetAllSkills" }),
  Object.freeze({ service: "skillHandler", method: "GetAttributes" }),
  Object.freeze({ service: "skillHandler", method: "GetSkillHistory" }),
  Object.freeze({ service: "skillHandler", method: "GetSkillChangesForISIS" }),
  Object.freeze({ service: "skillHandler", method: "GetRespecInfo" }),
  Object.freeze({ service: "skillHandler", method: "GetFreeSkillPoints" }),
  Object.freeze({ service: "skillHandler", method: "GetBoosters" }),
  Object.freeze({ service: "skillHandler", method: "GetImplants" }),
  Object.freeze({ service: "skillHandler", method: "CheckInjectionConstraints" }),
  Object.freeze({ service: "skillHandler", method: "GetSkillPoints" }),
  Object.freeze({ service: "skillHandler", method: "GetDiminishedSpFromInjectors" }),
  Object.freeze({ service: "skillHandler", method: "GetSkillQueue" }),
  // R74 PLUMBING sweep — the SECOND Phase-2 BOUND-READ batch: the 11 RB-DOGMA
  // reads (ship / char / item dogma) that hang off the R72 dogma bind
  // (dogmaIM.MachoBindObject, allowlisted above). These ride the /bound/bind
  // two-step (the bind mints an "N=" OID handle; the reads dispatch as bound
  // methods on service "dogmaIM"), but EVERY one of these handlers resolves its
  // target from the SESSION and ignores the bound OID — dogmaService never reads
  // getBoundObjectParams/currentBoundObjectID for a read — so top-level and bound
  // dispatch return the SAME session-scoped data. The pair-granular allowlist is
  // shared by both seams, so these 11 are reachable either way; dogma being
  // session-scoped is what makes that safe.
  //
  // ⚠ OWNERSHIP (R63 + the 2026-07-22 arg-injection audit). /api/bridge/call
  // forwards args verbatim, so each read is checked under attacker-chosen args:
  //  - Session-derived (ignore any id in args): GetAllInfo (charID/shipID from
  //    session; args are only the char/ship/structure BOOL toggles), GetTargeters
  //    (spaceRuntime.getTargeters(session)), GetCharacterAttributes
  //    (_getCharacterRecord(session)), GetDroneSettingAttributes (voids args,
  //    session payload), GetLocationInfo ([session.userid, _getLocationID(session),
  //    0]). No id override.
  //  - Item reads that take a caller itemID but COERCE a foreign/unknown id to the
  //    SESSION'S OWN SHIP (never the foreign item): ItemGetInfo(itemID),
  //    QueryAllAttributesForItem(itemID), QueryAttributeValue(itemID, attrID),
  //    FullyDescribeAttribute(itemID, attrID, reason). _findInventoryItemContext
  //    (dogmaService.js:3462) rejects any item whose ownerID !== session charID
  //    (returns null), and _resolveItemAttributeContext (:4867) then falls back to
  //    the session's active ship — so a foreign itemID reads the caller's OWN ship,
  //    not the target's item. Own/scene data only.
  //  - GetLayerDamageValuesByItems([itemIDs]) has an EXPLICIT ownership guard
  //    (dogmaService.js:5440 `ownedByOther = ownerID>0 && ownerID!==charID &&
  //    locationID!==shipID`): a foreign item returns a ZEROED sentinel, never the
  //    target's real hp/damage. Own/scene data only.
  //  - GetRequiredSkillLevels(typeID) is STATIC public type metadata
  //    (getRequiredSkillRequirements(typeID) — no session, no owner) — same for
  //    everyone. Safe.
  // Verified live cross-account (Farmer 140000005 vs Test Two): injecting a
  // foreign itemID returns Farmer's own-ship data / a zeroed sentinel, never the
  // foreign item. No handoff-doc flag needed for this batch.
  //
  // ⚠ READS ONLY. Every dogma WRITE/action sibling (Activate/Deactivate/
  // SetModuleOnline/…/AddTarget/…/ChangeDroneSettings/InjectSkillIntoBrain/
  // InjectImplant/…) is either already gated elsewhere or stays DELIBERATELY
  // ABSENT; only these 11 reads are opened here.
  Object.freeze({ service: "dogmaIM", method: "GetAllInfo" }),
  Object.freeze({ service: "dogmaIM", method: "ItemGetInfo" }),
  Object.freeze({ service: "dogmaIM", method: "GetTargeters" }),
  Object.freeze({ service: "dogmaIM", method: "GetDroneSettingAttributes" }),
  Object.freeze({ service: "dogmaIM", method: "GetCharacterAttributes" }),
  Object.freeze({ service: "dogmaIM", method: "GetRequiredSkillLevels" }),
  Object.freeze({ service: "dogmaIM", method: "GetLayerDamageValuesByItems" }),
  Object.freeze({ service: "dogmaIM", method: "QueryAllAttributesForItem" }),
  Object.freeze({ service: "dogmaIM", method: "QueryAttributeValue" }),
  Object.freeze({ service: "dogmaIM", method: "FullyDescribeAttribute" }),
  Object.freeze({ service: "dogmaIM", method: "GetLocationInfo" }),
  // R100 PLUMBING sweep — WB-DOGMA batch A: the 11 Phase-4 BOUND WRITES (ship-
  // module ops) that hang off the SAME dogmaIM.MachoBindObject bind (allowlisted
  // above). Reversible-ish in-space actions — overload / stop-overload, nanite
  // module-repair, target-drop, and weapon-bank link/merge; no ISK, no permanent
  // asset destruction. Reachable via confirm-gated BFF POST routes (the browser
  // must send `confirm:true` or the route refuses before any dispatch). The pair-
  // granular allowlist is shared by the top-level and bound seams; these dispatch
  // as BOUND methods off dogmaBindSpec() (mirrors the R74 reads).
  //
  // ⚠ OWNERSHIP: the target-drop pair (RemoveTargets/ClearTargets) and the module
  // ops resolve their target from the SESSION (spaceRuntime.<op>(session, …) /
  // _startModuleRepair(session, itemID)); a caller itemID is looked up and the
  // space runtime validates it against the session ship. LinkWeapons /
  // MergeModuleGroups accept a caller-supplied shipID (args[0], falling back to
  // _getShipID(session)) — flagged in docs/arg-injection-leak-handoff.md for a
  // server-side session-scoping fix + QA (kept plumbed, confirm-gated).
  Object.freeze({ service: "dogmaIM", method: "RemoveTargets" }),
  Object.freeze({ service: "dogmaIM", method: "ClearTargets" }),
  Object.freeze({ service: "dogmaIM", method: "Overload" }),
  Object.freeze({ service: "dogmaIM", method: "OverloadRack" }),
  Object.freeze({ service: "dogmaIM", method: "StopOverload" }),
  Object.freeze({ service: "dogmaIM", method: "StopOverloadRack" }),
  Object.freeze({ service: "dogmaIM", method: "InitiateModuleRepair" }),
  Object.freeze({ service: "dogmaIM", method: "InitiateModuleRepairMany" }),
  Object.freeze({ service: "dogmaIM", method: "StopModuleRepair" }),
  Object.freeze({ service: "dogmaIM", method: "LinkWeapons" }),
  Object.freeze({ service: "dogmaIM", method: "MergeModuleGroups" }),
  // R101 PLUMBING sweep — WB-DOGMA batch B (CLOSES WB-DOGMA, 22/22): the 11
  // remaining Phase-4 BOUND WRITES — weapon-bank link/unlink/destroy, probe
  // launch, drone settings, and the char-brain implant/booster/skill ops. All
  // ride the SAME dogmaIM.MachoBindObject bind and dispatch as BOUND methods off
  // dogmaBindSpec(). Reachable via confirm-gated BFF POST routes (the browser must
  // send `confirm:true` or the route refuses before any dispatch); the destructive
  // / consumable ones (DestroyWeaponBank / InjectSkillIntoBrain / InjectImplant /
  // DestroyImplant / UseBooster) carry an extra-explicit confirm message.
  //
  // ⚠ OWNERSHIP: LaunchProbes / ChangeDroneSettings resolve ship+char from the
  // SESSION (args are the probe launcher moduleID+count / a drone-settings dict).
  // InjectSkillIntoBrain / InjectImplant / DestroyImplant / UseBooster act on the
  // SESSION char (_getCharID(session)); the caller supplies only item ids. The
  // weapon-bank quartet+destroy (PeelAndLink / UnlinkModule / LinkAllWeapons /
  // UnlinkAllModules / DestroyWeaponBank) accept a caller-supplied shipID (args[0],
  // falling back to _getShipID(session)) — same pattern as LinkWeapons /
  // MergeModuleGroups, flagged in docs/arg-injection-leak-handoff.md for a
  // server-side session-scoping fix + QA (kept plumbed, confirm-gated).
  Object.freeze({ service: "dogmaIM", method: "PeelAndLink" }),
  Object.freeze({ service: "dogmaIM", method: "UnlinkModule" }),
  Object.freeze({ service: "dogmaIM", method: "LinkAllWeapons" }),
  Object.freeze({ service: "dogmaIM", method: "UnlinkAllModules" }),
  Object.freeze({ service: "dogmaIM", method: "DestroyWeaponBank" }),
  Object.freeze({ service: "dogmaIM", method: "LaunchProbes" }),
  Object.freeze({ service: "dogmaIM", method: "ChangeDroneSettings" }),
  Object.freeze({ service: "dogmaIM", method: "InjectSkillIntoBrain" }),
  Object.freeze({ service: "dogmaIM", method: "InjectImplant" }),
  Object.freeze({ service: "dogmaIM", method: "DestroyImplant" }),
  Object.freeze({ service: "dogmaIM", method: "UseBooster" }),
  // R75 PLUMBING sweep — the THIRD Phase-2 BOUND-READ batch: the 8 RB-INV reads
  // (inventory items / bays / descriptors) that hang off the ALREADY-WIRED
  // invbroker bind (invbroker.MachoBindObject / GetInventory / GetInventoryFromId,
  // allowlisted since R3/R37). They dispatch as BOUND methods on service
  // "invbroker" against the inventory-MANAGER moniker
  // (Moniker("invbroker", (stationID, groupStation)) — the same handle TrashItems
  // uses); the pair-granular allowlist governs the bound seam exactly as the
  // top-level one (a bound-method call whose (service, method) is unlisted is
  // refused before dispatch — webGatewayInventoryDepth.test.js proves it).
  //
  // ⚠ OWNERSHIP / ARG-INJECTION (R63 + the 2026-07-22 audit — MANDATORY).
  // /api/bridge/call forwards args verbatim, so each id-taking read is judged
  // under attacker-chosen args, verified LIVE cross-account (Farmer 140000005 vs
  // Test Two 140000002). SPLIT VERDICT:
  //  - SESSION-SCOPED, SAFE (no id in args or an explicit owner guard):
  //    ListDroneBay / ListFighterBay VOID their args and read the SESSION's active
  //    ship bay (_listShipInventoryFlagContents → _getShipId(session)).
  //    GetAvailableTurretSlots reads the session's active-ship fitting snapshot,
  //    args ignored. GetItemDescriptor returns a STATIC blue.DBRowDescriptor
  //    schema (column names/typecodes) — no per-entity data at all.
  //    GetDamageForCrystals([itemIDs]) has an EXPLICIT owner guard
  //    (_getCrystalDamageRatioForItem: `Number(item.ownerID) !== characterID` →
  //    null), so a foreign crystal id is dropped, never its damage.
  //  - ARG-INJECTION LEAK, KEPT PLUMBED + FLAGGED (docs/arg-injection-leak-
  //    handoff.md — operator's flag-only decision; do NOT de-allowlist): GetItem /
  //    GetItems / GetContainerContents take a caller item/container id and build
  //    the row straight from the found record via _buildInventoryItemOverrides /
  //    _itemOverridesFromId, which copy the record's OWN ownerID/typeID/location/
  //    quantity with NO check against the session. findItemById / findShipItemById
  //    are not owner-scoped, and GetContainerContents' generic-container branch
  //    calls listContainerItems(null, containerID) (_getGenericContainerContents
  //    OwnerID returns null for a plain container) — an UNFILTERED contents read.
  //    So a foreign item/container id returns that entity's private descriptor /
  //    contents. The fix is a handler-layer ownership check (see the handoff doc);
  //    the pairs stay pre-plumbed so the web client can consume them once scoped.
  //
  // ⚠ READS ONLY. Every invbroker WRITE/mutator sibling (Add / MultiAdd /
  // MultiMerge / TrashItems / DestroyFitting / StackAll — those already listed are
  // fenced; DestroyItem / SetLabel / TrashItemsWithReason / MultiSplit /
  // DeliverToCorpHangar stay DELIBERATELY ABSENT) is unaffected; only these 8
  // reads are opened here.
  Object.freeze({ service: "invbroker", method: "GetContainerContents" }),
  Object.freeze({ service: "invbroker", method: "GetItem" }),
  Object.freeze({ service: "invbroker", method: "GetItems" }),
  Object.freeze({ service: "invbroker", method: "ListDroneBay" }),
  Object.freeze({ service: "invbroker", method: "ListFighterBay" }),
  Object.freeze({ service: "invbroker", method: "GetItemDescriptor" }),
  Object.freeze({ service: "invbroker", method: "GetAvailableTurretSlots" }),
  Object.freeze({ service: "invbroker", method: "GetDamageForCrystals" }),
  // R102 PLUMBING sweep — WB-INV: the 7 Phase-4 BOUND inventory WRITES off the SAME
  // invbroker inventory-MANAGER moniker (Moniker("invbroker", (stationID,
  // groupStation)) — the TrashItems handle) the R75 reads use. Label / fit / unfit
  // / container / corp-delivery ops. Reachable ONLY via confirm-gated BFF POST
  // routes (the browser must send `confirm:true` or the route refuses before any
  // dispatch); StripFitting — which UNFITS a whole ship — carries an extra-explicit
  // confirm message. Dispatched as BOUND methods on service "invbroker" against the
  // manager bind (mirrors the R75 reads; the pair-granular allowlist governs the
  // bound seam exactly like the top-level one).
  //
  // ⚠ OWNERSHIP / ARG-INJECTION: SetLabel has an EXPLICIT owner guard
  // (item.ownerID !== session characterID → throwWrappedUserError("ItemNotYours"))
  // — SAFE. StripFitting resolves the ship from the SESSION bound context
  // (_getShipInventoryRecord(session, boundContext)), takes no caller itemID —
  // SESSION-SCOPED. AssembleCargoContainer / BreakPlasticWrap are server-side
  // NO-OPS (Handle returns null). FitFitting (caller shipID → findCharacterShip
  // scoped to the session char, but FALLS BACK to findShipItemById(shipID) / a
  // structure host — a foreign ship id can slip the char scope) and DeliverToCorp
  // Hangar / DeliverToCorpMember (caller itemIDs → _findTransferSourceItem →
  // findItemById with NO owner check, then _moveSourceItemToDestination which does
  // NOT verify sourceItem.ownerID against the session) mutate a caller-supplied
  // item/ship with NO session-ownership gate — an ARG-INJECTION WRITE LEAK, kept
  // plumbed + confirm-gated and FLAGGED in docs/arg-injection-leak-handoff.md
  // (server-side session-scoping fix + QA later; operator flag-only, NOT
  // de-allowlisted).
  Object.freeze({ service: "invbroker", method: "SetLabel" }),
  Object.freeze({ service: "invbroker", method: "StripFitting" }),
  Object.freeze({ service: "invbroker", method: "FitFitting" }),
  Object.freeze({ service: "invbroker", method: "AssembleCargoContainer" }),
  Object.freeze({ service: "invbroker", method: "BreakPlasticWrap" }),
  Object.freeze({ service: "invbroker", method: "DeliverToCorpHangar" }),
  Object.freeze({ service: "invbroker", method: "DeliverToCorpMember" }),
  // R76 PLUMBING sweep — the FOURTH Phase-2 BOUND-READ batch: the 6 RB-CLONE reads
  // (jump-clone state / station+ship clones / structure clone count / install
  // price / install validator) on service "jumpCloneSvc". machoNet's serviceInfo
  // keys "jumpCloneSvc" as null (machoNetService.js:302) — session-global, NOT
  // station-keyed — exactly like "skillHandler" (R73). So although JumpCloneService
  // also defines Handle_MachoBindObject/MachoResolveObject (retail binds it once at
  // the char sheet, with an immediately-nested ValidateInstallJumpClone whose null
  // result the bind back-fills to []), the reads themselves ride the ORDINARY
  // top-level /call seam: "jumpCloneSvc" is a real registered service
  // (jumpCloneService.js: class JumpCloneService extends BaseService,
  // super("jumpCloneSvc")), so serviceManager.lookup dispatches these Handle_*
  // directly — NO /bound/bind two-step, and NO MachoBindObject pair is opened
  // (mirrors R73 skillHandler). Verified LIVE: heldTopLevelCall("jumpCloneSvc",…)
  // returns real rows.
  //
  // ⚠ OWNERSHIP (R63 + the 2026-07-22 arg-injection audit). /api/bridge/call
  // forwards args verbatim, but every one of these SIX handlers takes (args,
  // session) and forwards ONLY session to jumpCloneRuntime — the caller's args are
  // DROPPED server-side. The location filter is the SESSION's OWN docked location
  // (getCurrentDockedLocation(session) → session-derived station/structure), never
  // a caller-supplied id:
  //  - GetCloneState → buildCloneStatePayload(session): session.characterID only.
  //  - GetStationCloneState → buildStationCloneStatePayload(session): own clones
  //    filtered to getCurrentDockedLocation(session).locationID (the session's OWN
  //    docked station/structure), NOT a caller stationID.
  //  - GetShipCloneState → buildShipCloneStatePayload(session): session.shipid, own
  //    character.
  //  - GetNumClonesInPilotsStructure → getNumClonesInPilotsStructure(session):
  //    session.structureid || session.shipid — a bare count.
  //  - GetPriceForClone → getCurrentCloneServiceCost(session): the session's current
  //    docked location's clone-bay fee — a bare number.
  //  - ValidateInstallJumpClone → validateInstallJumpClone(session): the session's
  //    char + current docked location.
  // A browser injecting a foreign stationID/structureID/charID cannot steer any of
  // them at another character's clones — args never reach the runtime. Verified LIVE
  // cross-account (Farmer 140000005 vs Test Two 140000002): a foreign location/char
  // id returns FARMER's own clone state, never Test Two's. Own-clones-only; no
  // handoff-doc flag needed. Clones/implants are PRIVATE (SP-adjacent), so this
  // session-scoping is the whole safety story for the batch.
  //
  // ⚠ ValidateInstallJumpClone is a NON-MUTATING read-style validator: it reads the
  // clone count / skill limit / structure-service access and returns an ARRAY of
  // error labels (empty array = install allowed). It writes nothing (contrast the
  // mutating installCloneAtCurrentLocation, which it is merely a pre-check for).
  //
  // ⚠ READS ONLY. Every jumpCloneSvc WRITE/mutator sibling (InstallCloneInStation /
  // InstallCloneInStructure / CloneJump / DestroyInstalledClone / SetJumpCloneName /
  // OfferShipCloneInstallation / AcceptShipCloneInstallation /
  // CancelShipCloneInstallation / ResetLastCloneJumpTime) plus MachoBindObject /
  // MachoResolveObject stay DELIBERATELY ABSENT; only these 6 reads are opened.
  Object.freeze({ service: "jumpCloneSvc", method: "GetCloneState" }),
  Object.freeze({ service: "jumpCloneSvc", method: "GetStationCloneState" }),
  Object.freeze({ service: "jumpCloneSvc", method: "GetShipCloneState" }),
  Object.freeze({ service: "jumpCloneSvc", method: "GetNumClonesInPilotsStructure" }),
  Object.freeze({ service: "jumpCloneSvc", method: "GetPriceForClone" }),
  Object.freeze({ service: "jumpCloneSvc", method: "ValidateInstallJumpClone" }),
  // R77 PLUMBING sweep — the FIFTH Phase-2 BOUND-READ batch: the 7 RB-PI reads
  // (planetary-industry colony + resource geography) that bind to a planetID.
  // Retail addresses these on a Moniker: eveMoniker.GetPlanet(planetID) ->
  // Moniker("planetMgr", planetID) (client/.../eveMoniker.py:211), then calls
  // e.g. remotePlanet.GetFullNetworkForOwner(planetID, characterID). That is a
  // genuine BOUND two-step (planetMgr defines Handle_MachoBindObject /
  // MachoResolveObject and reuseBoundObjectForSession=true), so — unlike R73's
  // skillHandler / R76's jumpCloneSvc (session-global monikers that ride the
  // top-level /call seam) — these ride the /bound/bind seam off a
  // planetMgr.MachoBindObject bind, mirroring R74's dogmaIM bind. The BIND pair
  // is opened here as the gateway; the OID never leaves the gateway.
  //
  //   ⚠ WHY THE BIND IS NEEDED (not just top-level /call). Six of the seven reads
  // call _resolvePlanetID(args, session, {allowArgs:true}) and so ALSO accept the
  // planetID as args[0] — but TWO (GetResourceData, GetProgramResultInfo) use
  // {allowArgs:false} and can only recover the planetID from the SESSION bind
  // state (_planetMgrBindingPlanetID during the bind, bindingMap[currentBound
  // ObjectID] during a bound dispatch, or the persisted _planetMgrLastPlanetID
  // that MachoBindObject sets, planetMgrService.js:892). So the bind is a real
  // prerequisite for those two, and the batch dispatches all seven as bound
  // methods on the planetMgr handle (planetID passed explicitly where accepted).
  //
  //   ⚠ MachoBindObject is a READ-SAFE bind: it mints a handle keyed on a
  // planetID (public celestial geography — the same id GetPlanetsForChar already
  // returns) and reads NO colony data. It binds a caller-supplied planetID with
  // no ownership check, but a planetID is not private, so the bind itself leaks
  // nothing; the ownership question lives entirely on the reads below.
  Object.freeze({ service: "planetMgr", method: "MachoBindObject" }),
  //
  // ⚠ OWNERSHIP / ARG-INJECTION (R63 + the 2026-07-22 audit — MANDATORY, HIGH
  // SCRUTINY: PI colony layout — pins, extractors, routes, schematics — is PRIVATE
  // operational intel). /api/bridge/call forwards args verbatim, so each read is
  // judged under attacker-chosen planetID/ownerID, verified LIVE cross-account
  // (Farmer 140000005 owns colony planetID 40009077; probed from a SECOND session
  // test2 → Test Two 140000002). SPLIT VERDICT:
  //
  //  - SESSION-SCOPED or STATIC PUBLIC GEOGRAPHY — SAFE:
  //    • GetPlanetInfo(planetID): getPlanetMeta(planetID) is STATIC celestial
  //      geography (solarSystemID/typeID/radius/celestialIndex); the colony body it
  //      appends is planetRuntimeStore.getColony(planetID, session.characterID) —
  //      scoped to the SESSION char, NOT a caller ownerID. A foreign planetID
  //      returns public geography + the CALLER's own colony there (or none). Live:
  //      as Test Two, GetPlanetInfo(40009077) returned the planet geography with NO
  //      colony body (Test Two owns none) — never Farmer's colony.
  //    • GetPlanetResourceInfo(planetID): buildResourceInfoForPlanet — a per-planet
  //      resourceTypeID->quality dict from static resource geography; no colony, no
  //      session, no owner. Same for everyone.
  //    • GetResourceData(planetID-via-bind, {resourceTypeID,oldBand,newBand}): the
  //      per-planet resource DISTRIBUTION band bytes — static planet geography, no
  //      colony/owner read.
  //    • GetProgramResultInfo(planetID-via-bind, resourceTypeID, heads, headRadius):
  //      estimateProgramResult — a COMPUTED extractor-yield estimate (qty/cycleTime/
  //      numCycles) from the static resource field + caller-supplied head positions;
  //      reads no colony ownership. A rival learns only what a hypothetical extractor
  //      WOULD yield on public terrain, not any existing colony.
  //
  //  - ARG-INJECTION LEAK, KEPT PLUMBED + FLAGGED (docs/arg-injection-leak-
  //    handoff.md — operator's flag-only decision; do NOT de-allowlist):
  //    • GetFullNetworkForOwner(planetID, ownerID) — the "ForOwner" red flag is
  //      real. It calls planetRuntimeStore.getColony(planetID, ownerID) keyed on the
  //      CALLER-SUPPLIED (planetID, ownerID) with NO session check and returns THAT
  //      owner's FULL colony network (every pin with full detail — extractors,
  //      processors, storage contents, cycle times, schematics — plus links). Live:
  //      as Test Two, GetFullNetworkForOwner(40009077, 140000005) returned FARMER's
  //      complete 4-pin network. (Retail itself uses this cross-owner — planetSvc.py
  //      GetColonyForCharacter caches it under foreignColoniesByPlanet — but the
  //      full private layout is exactly the R63 line.) LEAK.
  //    • GetCommandPinsForPlanet(planetID) / GetExtractorsForPlanet(planetID) — both
  //      iterate planetRuntimeStore.listColoniesForPlanet(planetID) across ALL
  //      owners (no session filter) and return every owner's command-center /
  //      extractor summary (pinID, typeID, ownerID, lat/long). Live: as Test Two,
  //      both returned FARMER's pins on 40009077. Lower-sensitivity than the full
  //      network (position + owner of surface structures, which retail renders on
  //      the planet), but still cross-owner colony presence → FLAGGED alongside.
  //
  // ⚠ READS ONLY here. The planetMgr colony-op WRITE siblings (UserUpdateNetwork /
  // UserLaunchCommodities / UserTransferCommodities / UserAbandonPlanet) are
  // allowlisted by the R103 WB-PI block below; the GM* verbs plus
  // MachoResolveObject stay DELIBERATELY ABSENT. (planetMgr.DeleteLaunch —
  // destructive — was allowlisted by the R93 WRITES batch.)
  Object.freeze({ service: "planetMgr", method: "GetPlanetInfo" }),
  Object.freeze({ service: "planetMgr", method: "GetPlanetResourceInfo" }),
  Object.freeze({ service: "planetMgr", method: "GetResourceData" }),
  Object.freeze({ service: "planetMgr", method: "GetFullNetworkForOwner" }),
  Object.freeze({ service: "planetMgr", method: "GetCommandPinsForPlanet" }),
  Object.freeze({ service: "planetMgr", method: "GetExtractorsForPlanet" }),
  Object.freeze({ service: "planetMgr", method: "GetProgramResultInfo" }),
  // R103 PLUMBING sweep — WB-PI: the 4 Phase-4 BOUND colony-op WRITES that hang off
  // the SAME planetMgr.MachoBindObject(planetID) bind (allowlisted above, R77). The
  // browser sends the target planetID; the BFF binds it and dispatches these as
  // BOUND methods off planetBindSpec(planetID). Colony network edit / commodity
  // launch / commodity transfer / colony abandon. Reachable ONLY via confirm-gated
  // BFF POST routes (the browser must send `confirm:true` or the route refuses
  // before any dispatch); UserAbandonPlanet — which DESTROYS the colony — carries
  // an extra-explicit confirm message. FAST-MODE: none fired live (operator owns
  // EveJS); the handlers return a serialized colony / launch triple / null, carried
  // through the ack for a future PI UI to decode.
  //
  // ⚠ OWNERSHIP: the planetID is caller-supplied via the bind (_resolvePlanetID,
  // allowArgs:false → session._planetMgrLastPlanetID), BUT every write forces
  // ownerID = getSessionCharacterID(session) (UserAbandonPlanet →
  // abandonColony(planetID, session.characterID)). The colony operated on is always
  // (planetID, SESSION-char), so unlike the R77 READ leak #18-#20 —
  // GetFullNetworkForOwner took a caller-supplied ownerID and returned a FOREIGN
  // owner's colony — these writes CANNOT mutate or abandon another player's colony;
  // they only ever touch the caller's OWN colony on the chosen planet. Owner-gated,
  // so NOT the write realization of #18-#20 — no new handoff-doc flag.
  Object.freeze({ service: "planetMgr", method: "UserUpdateNetwork" }),
  Object.freeze({ service: "planetMgr", method: "UserLaunchCommodities" }),
  Object.freeze({ service: "planetMgr", method: "UserTransferCommodities" }),
  Object.freeze({ service: "planetMgr", method: "UserAbandonPlanet" }),
  // R78 PLUMBING sweep — the SIXTH Phase-2 BOUND-READ batch: the 4 RB-CRIME reads
  // (client crimewatch states / own + any-char security status / sec-status
  // transaction history) on service "crimewatch". Retail obtains crimewatch as a
  // BOUND Moniker (CrimewatchService defines Handle_MachoBindObject /
  // MachoResolveObject and reuseBoundObjectForSession=true) — and "crimewatch" is
  // NOT in machoNet's serviceInfo table (machoNetService.js), so the retail CLIENT
  // cannot address it top-level; it binds first. BUT the gateway does not route via
  // serviceInfo: callServiceMethod dispatches serviceManager.lookup(service).
  // callMethod(...), and "crimewatch" IS a real registered service (crimewatchService
  // .js: class CrimewatchService extends BaseService, super("crimewatch"), auto-
  // registered by server/index.js loadServices directory scan). All FOUR handlers
  // resolve their target from the SESSION (or take a public charID / no args) and
  // depend on NO bound state, so they ride the ORDINARY top-level /call seam — NO
  // MachoBindObject pair is opened (mirrors R73 skillHandler / R76 jumpCloneSvc, NOT
  // R74/R77's two-step). Verified LIVE: heldTopLevelCall("crimewatch", …) returns
  // real values.
  //
  // ⚠ OWNERSHIP / ARG-INJECTION (R63 + the 2026-07-22 audit). /api/bridge/call
  // forwards args verbatim; each read judged under attacker-chosen args, verified
  // LIVE cross-account (Farmer 140000005 vs Test Two 140000002). ALL SESSION-SCOPED
  // or STATIC-PUBLIC — SAFE, no handoff-doc flag:
  //  - GetClientStates → crimewatchState.buildClientStatesForSession(session): the
  //    SESSION char's own combat timers, flagged-characters list and safety level;
  //    resolveSessionCharacterID(session) only, NO caller charID path.
  //  - GetMySecurityStatus → charID from session ONLY (session.characterID ||
  //    charid || userid); a caller-supplied charID in args is IGNORED. Returns the
  //    session char's own sec-status float.
  //  - GetCharacterSecurityStatus(charID) → the ONE read that takes args[0] as a
  //    charID. It returns ONLY getCharacterRecord(charID).securityStatus — a public
  //    sec-status FLOAT (−10.0..+5.0, rendered on every EVE overview), NOT any
  //    private crimewatch state (no timers, kill rights, suspect/criminal flags).
  //    Public-by-design; a foreign charID returns that char's public sec status,
  //    which leaks nothing private. Live: as Test Two, GetCharacterSecurityStatus
  //    (140000005) returned Farmer's public sec float only.
  //  - GetSecurityStatusTransactions → takes NO args at all and returns buildList([])
  //    unconditionally (no sec-change history is persisted) — a legitimately EMPTY
  //    private-history read; nothing to steer or leak.
  //
  // ⚠ READS ONLY. Every crimewatch WRITE/mutator sibling (SetSafetyLevel) plus the
  // bind verbs (MachoBindObject / MachoResolveObject) and GetSafetyLevel stay
  // DELIBERATELY ABSENT; only these 4 reads are opened here.
  Object.freeze({ service: "crimewatch", method: "GetClientStates" }),
  Object.freeze({ service: "crimewatch", method: "GetMySecurityStatus" }),
  Object.freeze({ service: "crimewatch", method: "GetCharacterSecurityStatus" }),
  Object.freeze({ service: "crimewatch", method: "GetSecurityStatusTransactions" }),
  // R79 PLUMBING sweep — the SEVENTH Phase-2 BOUND-READ batch: the small-service
  // TAIL — 8 reads across FOUR distinct bound services (wars / scan / PI-tax /
  // corp-station). Retail addresses each as a bound Moniker (warRegistry via
  // eveMoniker.GetWar keyed on owner; scanMgr via GetSystemScanMgr; planetOrbital
  // RegistryBroker + corpStationMgr via MachoBindObject) — but, as with R73/R76/R78,
  // every handler here resolves its target from the SESSION or from plain caller
  // args with NO bound-state dependency, and each is a real registered BaseService
  // (serviceManager.lookup dispatches it directly), so all 8 ride the ORDINARY
  // top-level /call seam (heldTopLevelCall(<svc>, <method>)); NO MachoBindObject pair
  // is opened. scanMgr's GetSystemScanMgr bind (R72) is a retail prerequisite already
  // wired but is NOT needed by these two reads (GetFullState/GetScanTargetID both
  // recover the system from the session directly). Verified LIVE:
  // heldTopLevelCall(<svc>, …) returns real values for every one.
  //
  // ⚠ OWNERSHIP / ARG-INJECTION (R63 + the 2026-07-22 audit). /api/bridge/call
  // forwards args verbatim; each read judged under attacker-chosen args, verified
  // LIVE cross-account (Farmer 140000005 / corp 98000001 vs Test Two 140000002 /
  // corp 98000000). SPLIT VERDICT:
  //
  //  SAFE (session-scoped or genuinely public):
  //   - scanMgr.GetFullState → args IGNORED; returns the session's OWN system signal-
  //     tracker state via _getSystemID(session) (empty [dict×4] when no system).
  //     Live: Farmer docked → an all-empty full-state; an injected foreign systemID
  //     is impossible (no system arg exists).
  //   - scanMgr.GetScanTargetID(siteID) → the SYSTEM is session-derived; siteID is a
  //     site id within the session's OWN system (no foreign-system path).
  //   - warRegistry.GetWars([ownerID]) → PUBLIC per-owner war declarations (the same
  //     data class as warsInfoMgr.GetWarsByOwnerID wired R66; reward / allies /
  //     openForAllies are public war-report fields). A foreign ownerID returns that
  //     owner's PUBLIC war list only. Live: Farmer's corp is in no war → empty dict;
  //     injecting Test Two's corp 98000000 → also empty (neither is at war).
  //   - warRegistry.GetNegotiations → resolveWarEntityID(SESSION) ONLY; args are
  //     IGNORED → the session corp/alliance's own negotiations (empty this world).
  //   - warRegistry.IsAllianceOrCorpLocal → a CONSTANT (returns 1); no args, no session.
  //   - planetOrbitalRegistryBroker.GetTaxRate(orbitalID) → the customs-office tax-rate
  //     FLOAT everyone pays (public per-office); no session, no ownership check. Live:
  //     returns the corporation tax rate (default 0.05) for any orbital id.
  //
  //  ⚠ FLAGGED arg-injection leaks — kept pre-plumbed, NOT de-allowlisted (operator
  //  flag-only), documented in docs/arg-injection-leak-handoff.md:
  //   - warRegistry.GetWarNegotiation(warNegotiationID) → getNegotiationRecord(id)
  //     with NO session check; returns the negotiation's PRIVATE terms (iskValue of a
  //     surrender/ally offer, description, ownerID1/ownerID2, declaredBy/against,
  //     state, times) for ANY caller-supplied id. A surrender/ally offer is private
  //     between the warring parties. (No negotiation is seeded in this world — Farmer's
  //     corp is in no war — so the leak is a STATIC reading of the handler + an empty
  //     live probe, same confidence as the R72/R75/R77 handoff-doc addenda.)
  //   - corpStationMgr.DoStandingCheckForStationService(serviceID[, charID]) → args[1]
  //     is a caller-chosen charID that drives getCharacterEffectiveStanding(charID,
  //     stationOwner) + getCharacterRecord(charID).securityStatus; a foreign charID
  //     turns the read into a STANDING / SECURITY-GATE ORACLE for another character
  //     (pass → null, fail → a typed CustomNotify naming which threshold). Low
  //     sensitivity (sec status is public; the standing comparison is a boolean oracle,
  //     not the value) but UNOWNED — flagged.
  //
  // ⚠ READS ONLY here. The warRegistry negotiation verbs + SetOpenForAllies and
  // corpStationMgr.MoveCorpHQHere moved to the pairs list with the R99 batch;
  // scanMgr's probe/scan-control WRITES (SetProbeDestination / RequestScans /
  // DestroyProbe / …) moved to the pairs list with the R104 WB-SCAN batch below —
  // all confirm-gated at the BFF, never fired live. Still refused before dispatch:
  // planetOrbitalRegistryBroker.UpdateSettings / RevertOrbitalsToInterBus — plus each
  // service's MachoBindObject / MachoResolveObject (scanMgr's GetSystemScanMgr, R72,
  // stays the only scanMgr bind). Only these 8 reads are opened in THIS block.
  Object.freeze({ service: "scanMgr", method: "GetFullState" }),
  Object.freeze({ service: "scanMgr", method: "GetScanTargetID" }),
  Object.freeze({ service: "warRegistry", method: "GetWars" }),
  Object.freeze({ service: "warRegistry", method: "GetNegotiations" }),
  Object.freeze({ service: "warRegistry", method: "GetWarNegotiation" }),
  Object.freeze({ service: "warRegistry", method: "IsAllianceOrCorpLocal" }),
  Object.freeze({ service: "planetOrbitalRegistryBroker", method: "GetTaxRate" }),
  Object.freeze({ service: "corpStationMgr", method: "DoStandingCheckForStationService" }),
  // R104 PLUMBING sweep — WB-SCAN: the 9 Phase-4 BOUND probe/scan-control WRITES that
  // hang off the SAME scanMgr.GetSystemScanMgr bind (R72, allowlisted above). Unlike a
  // MachoBindObject bind, GetSystemScanMgr takes NO caller args — it always binds the
  // SESSION's OWN current-system scan manager (server-derived via _ensureSystemParity),
  // so the bind CANNOT be pointed at a foreign system. The BFF dispatches these as BOUND
  // methods off systemScanBindSpec() (dispatchBoundScanWrite in server.js). Reachable
  // ONLY via confirm-gated BFF POST routes (the browser must send `confirm:true` or the
  // route refuses before any dispatch); DestroyProbe — which destroys a launched probe —
  // carries an extra-explicit confirm message. FAST-MODE: none fired live (operator owns
  // EveJS; no server restart) — the handlers return null / a directional-scan list / a
  // recovered-probeID list, carried through the ack.
  //
  // ⚠ OWNERSHIP: the bind is session-scoped (no caller args → session's own system),
  // AND every handler resolves characterID = this._getCharacterID(session) and operates
  // on probeRuntimeState keyed on THAT characterID. The caller-supplied probeIDs
  // (SetProbeDestination / SetProbeRangeStep / DestroyProbe / RecoverProbes /
  // SetActivityState) only ever SELECT among the SESSION char's OWN probes —
  // getCharacterSystemProbes / removeCharacterProbes / synchronizeCharacterProbeGeometry
  // are all characterID-scoped, so a foreign probeID launched by another char simply
  // MISSES (returns null / an empty removed list). Probes are inherently session-scoped;
  // a caller cannot mutate or destroy another player's probes — no handoff-doc flag.
  Object.freeze({ service: "scanMgr", method: "SignalTrackerRegister" }),
  Object.freeze({ service: "scanMgr", method: "SetProbeDestination" }),
  Object.freeze({ service: "scanMgr", method: "SetProbeRangeStep" }),
  Object.freeze({ service: "scanMgr", method: "ConeScan" }),
  Object.freeze({ service: "scanMgr", method: "RequestScans" }),
  Object.freeze({ service: "scanMgr", method: "ReconnectToLostProbes" }),
  Object.freeze({ service: "scanMgr", method: "DestroyProbe" }),
  Object.freeze({ service: "scanMgr", method: "RecoverProbes" }),
  Object.freeze({ service: "scanMgr", method: "SetActivityState" }),
  // R80 PLUMBING sweep — Phase-2 bound-read batch, corpRegistry split A (member /
  // info core, 11 reads). Retail addresses these on a per-corp Moniker
  // (eveMoniker.GetCorpRegistry(corpID) -> Moniker("corpRegistry", corpID) ->
  // MachoBindObject), but — exactly like corpRegistry.GetCorporation (R37, listed
  // far above) — the eve.js handlers do NOT trust a bind param: every read resolves
  // its corp from resolveCorporationID(session) (session.corporationID), or, for the
  // two that call resolveBoundCorporationID (GetEveOwners / GetCorporation), from a
  // bound object that is UNSET here because corpRegistry.MachoBindObject is NOT
  // allowlisted — so it falls through to the session corp too. All 11 therefore ride
  // the ordinary top-level /call seam (heldTopLevelCall("corpRegistry", …)); NO
  // MachoBindObject pair is opened, so the browser cannot bind a FOREIGN corp.
  //
  // ⚠ OWNERSHIP / ARG-INJECTION (R63 + the 2026-07-22 audit) — MAXIMUM SCRUTINY.
  // /api/bridge/call forwards args verbatim; each read judged under attacker-chosen
  // args and verified LIVE cross-account (Farmer 140000005 / corp 98000001 vs Test
  // Two 140000002 / corp 98000000). SPLIT VERDICT:
  //
  //  SESSION-CORP-SCOPED (SAFE — corp resolved from the session, args cannot
  //  redirect it to a foreign corp; foreign memberIDs simply miss the session
  //  corp's member table):
  //   - GetMembersPaged(page)        → resolveCorporationID(session); args[0] is a
  //     PAGE number, never a corpID.
  //   - GetMembersByIds([memberIDs]) → session corp; each id looked up in the SESSION
  //     corp only (getCorporationMember(sessionCorp, id)); a foreign id → dropped.
  //     Live: injecting Test Two's member 140000002 as Farmer → empty list.
  //   - GetMember(memberID)          → session corp; a foreign memberID → null.
  //   - GetMemberTrackingInfo / …Simple → args IGNORED; the session corp's OWN member
  //     tracking (last-login FILETIME, locationID). ⚠ NOT role-gated in eve.js (retail
  //     gates it to directors) — but still OWN-corp only, so no foreign-corp leak.
  //   - GetTitles / GetLabels / GetCorporateContacts / GetBulletins → args IGNORED;
  //     the session corp's own title scheme / contact labels / contacts / bulletins.
  //   - GetEveOwners → resolveBoundCorporationID(session) with NO bind wired → session
  //     corp; name-resolution rows (ownerID/name/typeID/gender) for the caller's OWN
  //     corp members. Public-class data, own-corp scoped.
  //
  //  ⚠ FLAGGED arg-injection leak — kept pre-plumbed, NOT de-allowlisted (operator
  //  flag-only), documented in docs/arg-injection-leak-handoff.md:
  //   - GetInfoWindowDataForChar([charID]) → resolveCharacterID(session, args) takes
  //     args[0] as a CALLER-CHOSEN charID, derives that char's corp from
  //     getCharacterRecord(charID).corporationID, and returns corpID/allianceID/
  //     factionID/the char's corp title PLUS the foreign corp's title1..title16 NAMES.
  //     A foreign charID turns it into a cross-corp title-scheme oracle. Live: as
  //     Farmer, GetInfoWindowDataForChar(140000002) returned corp 98000000 and its
  //     title-scheme names. (corpID/allianceID/factionID/the char's own title are
  //     retail-public info-window fields; the full 16-title-name dump of the foreign
  //     corp is the sensitive part — flagged.)
  //
  // ⚠ READS ONLY. Every corpRegistry write/mutator sibling stays refused before
  // dispatch (Update/Create/Delete Member/Title/Label/Bulletin/Contact, share moves,
  // division-name edits, …), and corpRegistry.MachoBindObject / MachoResolveObject are
  // DELIBERATELY ABSENT — GetCorporation (R37) plus these 11 reads are the only
  // corpRegistry surface opened.
  Object.freeze({ service: "corpRegistry", method: "GetInfoWindowDataForChar" }),
  Object.freeze({ service: "corpRegistry", method: "GetEveOwners" }),
  Object.freeze({ service: "corpRegistry", method: "GetMember" }),
  Object.freeze({ service: "corpRegistry", method: "GetMembersPaged" }),
  Object.freeze({ service: "corpRegistry", method: "GetMembersByIds" }),
  Object.freeze({ service: "corpRegistry", method: "GetMemberTrackingInfo" }),
  Object.freeze({ service: "corpRegistry", method: "GetMemberTrackingInfoSimple" }),
  Object.freeze({ service: "corpRegistry", method: "GetTitles" }),
  Object.freeze({ service: "corpRegistry", method: "GetLabels" }),
  Object.freeze({ service: "corpRegistry", method: "GetCorporateContacts" }),
  Object.freeze({ service: "corpRegistry", method: "GetBulletins" }),
  // R81 PLUMBING sweep — Phase-2 bound-read batch, corpRegistry split B (shares /
  // applications / welcome mail, 12 reads). Same dispatch as split A: retail
  // addresses these on a per-corp Moniker (eveMoniker.GetCorpRegistry(corpID)), but
  // the eve.js handlers do NOT trust a bind param — every read resolves its corp (or
  // char) from resolveCorporationID(session) / resolveCharacterID(session, []). All 12
  // ride the ordinary top-level /call seam; corpRegistry.MachoBindObject is STILL NOT
  // allowlisted, so a browser cannot bind a FOREIGN corp.
  //
  // ⚠ OWNERSHIP / ARG-INJECTION (R63 + the 2026-07-22 audit). /api/bridge/call forwards
  // args verbatim; each read judged under attacker-chosen args and verified LIVE cross-
  // account (Farmer 140000005 / corp 98000001 vs Test Two 140000002 / corp 98000000).
  // SPLIT VERDICT:
  //
  //  SESSION-CORP / SESSION-CHAR-SCOPED (SAFE — corp/char resolved from the session,
  //  args cannot redirect it to a foreign entity):
  //   - GetSharesByShareholder([flag]) → corp = resolveCorporationID(session);
  //     shareholderID = (normalizeInteger(args[0],0) === 1 ? sessionCorp : sessionChar).
  //     ⚠ args[0] is a COMPANY-vs-PERSONAL 1/0 FLAG, NOT a caller shareholderID lookup
  //     key — a foreign id injected as args[0] does NOT become the shareholder; it
  //     just fails the ===1 test and falls to the session char. Despite the retail name
  //     this cannot read a foreign holder's shares. SAFE.
  //   - GetMemberIDsByQuery(query,…) → corp from session; args are a search spec applied
  //     WITHIN the session corp's member table. Cannot redirect the corp.
  //   - GetMemberIDsWithMoreThanAvgShares / GetPendingAutoKicks / GetNumberOfPotentialCEOs
  //     → args IGNORED; the session corp's own members / auto-kick queue / potential-CEO
  //     member ids.
  //   - GetApplications / GetOldApplications → args IGNORED; the session corp's own
  //     incoming applications (current / archived). ⚠ NOT role-gated in eve.js (retail
  //     gates these to directors) — but still OWN-corp only, so no foreign-corp leak.
  //   - GetMyApplications / GetMyOldApplications → resolveCharacterID(session, []); the
  //     SESSION char's own applications across corps (current / archived). Session-char
  //     scoped; args ignored.
  //   - GetAllianceApplications → args IGNORED; the session corp's own outgoing alliance
  //     applications.
  //   - GetCorpWelcomeMail → args IGNORED; the session corp's own welcome-mail string.
  //
  //  ⚠ FLAGGED arg-injection leak — kept pre-plumbed, NOT de-allowlisted (operator
  //  flag-only), documented in docs/arg-injection-leak-handoff.md:
  //   - GetShareholders([corpID]) → corporationID = normalizePositiveInteger(args[0],
  //     resolveCorporationID(session)). args[0] IS a caller-chosen corpID; a foreign
  //     corpID returns THAT corp's full shareholder ledger (shareholderID / corpID /
  //     share count per holder) with no session check. Corp shareholdings are private
  //     corp intel. Live: as Farmer, GetShareholders(98000000) returned corp 98000000's
  //     shareholder rows. (The list form is the unguarded one; GetSharesByShareholder,
  //     the single-record sibling, is correctly session-scoped — that asymmetry is the
  //     tell.)
  //
  // ⚠ READS ONLY. Every corpRegistry write/mutator sibling stays refused before dispatch
  // (InsertApplication / UpdateApplicationOffer / SetCorpWelcomeMail / MoveCompanyShares /
  // MovePrivateShares / PayoutDividend / DeleteAllianceApplication / …), and corpRegistry.
  // MachoBindObject / MachoResolveObject remain DELIBERATELY ABSENT.
  Object.freeze({ service: "corpRegistry", method: "GetShareholders" }),
  Object.freeze({ service: "corpRegistry", method: "GetSharesByShareholder" }),
  Object.freeze({ service: "corpRegistry", method: "GetMemberIDsByQuery" }),
  Object.freeze({ service: "corpRegistry", method: "GetMemberIDsWithMoreThanAvgShares" }),
  Object.freeze({ service: "corpRegistry", method: "GetPendingAutoKicks" }),
  Object.freeze({ service: "corpRegistry", method: "GetNumberOfPotentialCEOs" }),
  Object.freeze({ service: "corpRegistry", method: "GetApplications" }),
  Object.freeze({ service: "corpRegistry", method: "GetMyApplications" }),
  Object.freeze({ service: "corpRegistry", method: "GetMyOldApplications" }),
  Object.freeze({ service: "corpRegistry", method: "GetOldApplications" }),
  Object.freeze({ service: "corpRegistry", method: "GetAllianceApplications" }),
  Object.freeze({ service: "corpRegistry", method: "GetCorpWelcomeMail" }),
  // R82 PLUMBING sweep — Phase-2 bound-read batch, corpRegistry split C (kills /
  // settings / checks / name suggestions, 11 reads — CLOSES corpRegistry at 34/34).
  // Same top-level dispatch as splits A/B: retail addresses corpRegistry on a per-corp
  // Moniker (eveMoniker.GetCorpRegistry(corpID)) but the eve.js handlers do NOT trust a
  // bind param — corp/char are resolved from resolveCorporationID(session) /
  // resolveCharacterID(session, []). corpRegistry.MachoBindObject is STILL NOT
  // allowlisted, so a browser cannot bind a FOREIGN corp.
  //
  // ⚠ OWNERSHIP / ARG-INJECTION (R63 + the 2026-07-22 audit). /api/bridge/call forwards
  // args verbatim; each read judged under attacker-chosen args and verified LIVE cross-
  // account (Farmer 140000005 / corp 98000001 vs Test Two 140000002 / corp 98000000).
  // SPLIT VERDICT:
  //
  //  SESSION-CORP / SESSION-CHAR-SCOPED (SAFE — corp/char from the session, args cannot
  //  redirect it to a foreign entity):
  //   - GetRecentKills / GetRecentLosses([limit, startKillID]) → corp =
  //     resolveCorporationID(session); args[0]/args[1] are a paging LIMIT + cursor, NOT
  //     a corpID. A browser can only ever read the SESSION corp's own killboard — it
  //     cannot even name a foreign corp. SAFE (tighter than retail's semi-public board).
  //   - GetAggressionSettings → resolveBoundCorporationID(session) (no bind wired →
  //     session corp); friendly-fire enable/disable schedule for the OWN corp.
  //   - GetStructureReinforceDefault / DoesMyCorpAcceptStructures / DoesCorpRestrictCorpMails
  //     → getCorporationRuntime(resolveCorporationID(session)); OWN-corp settings, args
  //     ignored (reinforce hour; two booleans).
  //   - CanLeaveCurrentCorporation → corp AND char both from the session
  //     (resolveCharacterID(session, []) IGNORES args); a [flag, errorCode, details] triple
  //     about the SESSION char's own ability to leave. Session-scoped.
  //   - CanBeKickedOut([charID]) → corp = resolveCorporationID(session); the member lookup
  //     getCorporationMember(sessionCorp, args[0]) is scoped to the SESSION corp, so a
  //     foreign charID that is not a member of the session corp just returns 0 (member
  //     null). Reveals only whether a char is a kickable member of the caller's OWN corp.
  //     SAFE.
  //   - GetSuggestedTickerNames → NO session/corp; a random 4-letter ticker generator.
  //     PUBLIC (no private data).
  //   - GetSuggestedAllianceShortNames([name]) → NO session/corp; deterministic short-name
  //     variants of a caller-supplied base name string. PUBLIC (no private data).
  //
  //  ⚠ FLAGGED arg-injection leak — kept pre-plumbed, NOT de-allowlisted (operator
  //  flag-only), documented in docs/arg-injection-leak-handoff.md:
  //   - CharGetAllyBaseCost([charID]) → getCharacterAllyBaseCost(resolveCharacterID(session,
  //     args)). args[0] IS a caller-chosen charID (fallback session char). The returned
  //     war-ally base cost is a deterministic function of that char's Diplomatic Relations
  //     skill level (baseCost × (1 + modifierPerLevel × skillLevel/100); baseCost and the
  //     modifier are public dogma constants), so a foreign charID leaks that char's private
  //     Diplomatic Relations skill level via the derived ISK figure. Low sensitivity (one
  //     skill level, an ISK number) but UNOWNED — flagged conservatively.
  //
  // ⚠ READS ONLY. Every corpRegistry write/mutator sibling stays refused before dispatch
  // (RegisterNewAggressionSettings / RegisterNewAcceptStructureSettings / RegisterNewCorp
  // MailRestrictionSettings / SetStructureReinforceDefault / DeclareWarAgainst / KickOut
  // Member / AddCorporation / …), and corpRegistry.MachoBindObject / MachoResolveObject
  // remain DELIBERATELY ABSENT. corpRegistry is now COMPLETE (34/34 reads).
  Object.freeze({ service: "corpRegistry", method: "GetRecentKills" }),
  Object.freeze({ service: "corpRegistry", method: "GetRecentLosses" }),
  Object.freeze({ service: "corpRegistry", method: "GetAggressionSettings" }),
  Object.freeze({ service: "corpRegistry", method: "GetSuggestedTickerNames" }),
  Object.freeze({ service: "corpRegistry", method: "GetSuggestedAllianceShortNames" }),
  Object.freeze({ service: "corpRegistry", method: "GetStructureReinforceDefault" }),
  Object.freeze({ service: "corpRegistry", method: "DoesMyCorpAcceptStructures" }),
  Object.freeze({ service: "corpRegistry", method: "DoesCorpRestrictCorpMails" }),
  Object.freeze({ service: "corpRegistry", method: "CanLeaveCurrentCorporation" }),
  Object.freeze({ service: "corpRegistry", method: "CanBeKickedOut" }),
  Object.freeze({ service: "corpRegistry", method: "CharGetAllyBaseCost" }),
  // R83 PLUMBING sweep — Phase-2 bound-read batch, allianceRegistry split A (alliance
  // info / members / relationships, 8 reads). allianceRegistry is retail-bound to an
  // allianceID exactly like corpRegistry→corpID (eveMoniker.GetAllianceRegistry /
  // Moniker("allianceRegistry", allianceID) -> MachoBindObject). As with corpRegistry,
  // the eve.js handlers do NOT depend on a bound object: they resolve the alliance from
  // resolveAllianceIDFromArgs(args, session) (an explicit args[0] allianceID, else the
  // SESSION alliance) or resolveAllianceIDFromSession(session). All 8 ride the ordinary
  // top-level /call seam; allianceRegistry.MachoBindObject is NOT allowlisted, so a
  // browser cannot BIND a foreign alliance — but note that, unlike corpRegistry, most of
  // these DO accept an explicit args[0] allianceID. That is safe here only because the
  // data they expose is alliance-PUBLIC (identity, member corps, tenure), verified below.
  //
  // ⚠ OWNERSHIP / ARG-INJECTION (R63 + the 2026-07-22 audit). /api/bridge/call forwards
  // args verbatim; each read judged under attacker-chosen args and verified LIVE as
  // Farmer (140000005 / corp 98000001) injecting a foreign allianceID (99000000) and a
  // foreign charID/corpID (140000002 / 98000000). VERDICT — all 8 SAFE (PUBLIC or
  // session-alliance-scoped); no private-data leak, nothing flagged into the handoff doc:
  //
  //  PUBLIC (return only alliance-public fields even for an injected foreign allianceID —
  //  in EVE alliance identity, the member-corp roster and membership tenure are public):
  //   - GetAlliance / GetAlliancePublicInfo([allianceID?]) → buildAllianceKeyValPayload:
  //     allianceID / name / shortName / executor+creator corp / description / url /
  //     memberCount / sovereignty prime+capital info. All public info-panel fields.
  //   - GetRankedAlliances([maxLen]) → NO session; a public list of alliance identity
  //     rows (the alliance browser). Public by construction.
  //   - GetAllianceMembers([allianceID?]) → a Rowset of the alliance's member CORPORATIONS
  //     (corporationID / allianceID / chosenExecutorID / join FILETIME). Member corps are
  //     public.
  //   - GetEmploymentRecord([corporationID?]) → a corp's ALLIANCE history rowset
  //     (allianceID / startDate / deleted). args[0] is a corpID; corp alliance history is
  //     public. Falls back to the session alliance's single-row history when args[0] is
  //     not a known corp.
  //   - GetDaysInAlliance([allianceID?, corporationID?]) → an integer day count derived
  //     from the public membership join date; returns 0 unless the corp is actually a
  //     member of that alliance. Public/derived.
  //   - GetAllianceMembersOlderThan([allianceID?, minDays]) → a list of member corpIDs
  //     whose tenure ≥ minDays; derived from the same public membership+join data. Public.
  //
  //  SESSION-ALLIANCE-SCOPED (SAFE — alliance from the session only; args cannot redirect):
  //   - GetRelationships → resolveAllianceIDFromSession(session) IGNORES args entirely and
  //     returns the SESSION alliance's standings dict {ownerID -> relationship}. A browser
  //     can only ever read its own alliance's standings; empty {} when the session char's
  //     corp is alliance-less (Farmer's case — verified live).
  //
  // ⚠ READS ONLY. Every allianceRegistry write/mutator sibling stays refused before
  // dispatch (UpdateAlliance / SetRelationship / DeleteRelationship / CreateAlliance /
  // DeclareStandings…), and allianceRegistry.MachoBindObject / MachoResolveObject remain
  // DELIBERATELY ABSENT (the ownership control — no foreign alliance is bindable).
  Object.freeze({ service: "allianceRegistry", method: "GetAlliance" }),
  Object.freeze({ service: "allianceRegistry", method: "GetAlliancePublicInfo" }),
  Object.freeze({ service: "allianceRegistry", method: "GetRankedAlliances" }),
  Object.freeze({ service: "allianceRegistry", method: "GetAllianceMembers" }),
  Object.freeze({ service: "allianceRegistry", method: "GetAllianceMembersOlderThan" }),
  Object.freeze({ service: "allianceRegistry", method: "GetDaysInAlliance" }),
  Object.freeze({ service: "allianceRegistry", method: "GetEmploymentRecord" }),
  Object.freeze({ service: "allianceRegistry", method: "GetRelationships" }),
  // R84 PLUMBING sweep — Phase-2 bound-read batch, allianceRegistry split B (contacts /
  // applications / bulletins / bills / sovereignty config, 7 reads). CLOSES allianceRegistry
  // (15/15). Same top-level seam as R83: allianceRegistry is retail-bound to an allianceID
  // (eveMoniker.GetAllianceRegistry -> MachoBindObject), but the handlers do NOT depend on a
  // bound object and allianceRegistry.MachoBindObject stays UN-allowlisted, so a browser
  // cannot BIND a foreign alliance. Unlike R83's split A (several of which accept an explicit
  // args[0] allianceID), EVERY read in this batch is STRICTLY SESSION-SCOPED and IGNORES args
  // — the alliance is resolved from resolveAllianceIDFromSession(session) (or, for
  // GetBillBalance, from the session corporationID / accountKey). There is no args path by
  // which a caller can redirect any of these to a foreign alliance.
  //
  // ⚠ OWNERSHIP / ARG-INJECTION (R63 + the 2026-07-22 audit). /api/bridge/call forwards args
  // verbatim; each read judged under attacker-chosen args and verified LIVE — as Test Two
  // (140000002 / corp 98000000, a MEMBER of Elysian 99000000) for the populated session shape,
  // and as Farmer (140000005 / corp 98000001, ALLIANCE-LESS) INJECTING a foreign allianceID
  // 99000000 (and charID/corpID 140000002 / 98000000). VERDICT — all 7 SAFE, session-scoped;
  // Farmer's injected 99000000 changes NOTHING (empty/zero every time — the handler never
  // reads args), so no foreign alliance's private contacts / applications / bulletins / bills
  // are reachable. Nothing flagged into the arg-injection handoff doc:
  //
  //  SESSION-ALLIANCE-SCOPED (alliance from the session ONLY; args cannot redirect):
  //   - GetAllianceContacts → getAllianceRuntime(resolveAllianceIDFromSession(session)).contacts
  //     -> a dict {contactID -> KeyVal(contactID / relationshipID / labelMask)}. The SESSION
  //     alliance's own standings-contact list; empty {} when alliance-less.
  //   - GetApplications → buildAllianceApplicationsIndexRowset(resolveAllianceIDFromSession(
  //     session)) -> an IndexRowset (keyed by corporationID) of the SESSION alliance's INCOMING
  //     corp applications (allianceID / corporationID / applicationText / state / FILETIME).
  //   - GetBulletins → getAllianceRuntime(resolveAllianceIDFromSession(session)).bulletins ->
  //     a list of packed bulletin rows (bulletinID / ownerID / create+edit FILETIME /
  //     editCharacterID / title / body / sortOrder) for the SESSION alliance.
  //   - GetBills → listBillsForDebtor(resolveAllianceIDFromSession(session)) -> a list of the
  //     SESSION alliance's OWED bills (billID / billTypeID / amount / interest / debtor /
  //     creditor / due FILETIME / paid). Alliance financials, but only ever the OWN alliance's.
  //   - GetCapitalSystemInfo / GetPrimeTimeInfo → the SESSION alliance's sovereignty capital /
  //     prime-time config KeyVal (systemID + FILETIME validity / prime hour int). Alliance
  //     config; session-scoped.
  //   - GetBillBalance → the SESSION corp's wallet balance for its default account key
  //     (getCorporationWalletBalance(session.corporationID, session.corpAccountKey)); derives
  //     BOTH ids from the session and IGNORES args entirely. Returns 0 when corp-less.
  //
  // ⚠ READS ONLY. Every allianceRegistry write/mutator sibling stays refused before dispatch
  // (AddAllianceContact / AddBulletin / DeleteBulletin / SetPrimeHour / SetCapitalSystem /
  // PayBill / UpdateApplication…), and allianceRegistry.MachoBindObject / MachoResolveObject
  // remain DELIBERATELY ABSENT (the ownership control — no foreign alliance is bindable).
  Object.freeze({ service: "allianceRegistry", method: "GetAllianceContacts" }),
  Object.freeze({ service: "allianceRegistry", method: "GetApplications" }),
  Object.freeze({ service: "allianceRegistry", method: "GetBulletins" }),
  Object.freeze({ service: "allianceRegistry", method: "GetBills" }),
  Object.freeze({ service: "allianceRegistry", method: "GetBillBalance" }),
  Object.freeze({ service: "allianceRegistry", method: "GetCapitalSystemInfo" }),
  Object.freeze({ service: "allianceRegistry", method: "GetPrimeTimeInfo" }),
  // R85 PLUMBING sweep — the FINAL Phase-2 BOUND-READ batch: the 5 RB-FLEET reads
  // (roster / wings / MOTD / join-requests / composition) that hang off the R72
  // fleet bind (fleetObjectHandler.MachoBindObject, allowlisted above). This CLOSES
  // Phase-2 bound reads (111/111). These ride the /bound/bind two-step: the bind
  // mints an "N=" OID handle and the reads dispatch as bound methods on service
  // "fleetObjectHandler". Each handler resolves the fleetID via
  // _resolveFleetIDFromSession (fleetObjectHandlerService.js:35), which honors the
  // fleetID stored on the bound context by Handle_MachoBindObject.
  //
  // ⚠ OWNERSHIP (R63 + the 2026-07-22 arg-injection audit + the R72 fleet addendum):
  // ALL FIVE are FLAGGED as arg-injection leaks (docs/arg-injection-leak-handoff.md).
  // The bind (R72) is BINDS-ARBITRARY-OID — Handle_MachoBindObject takes bindParams[0]
  // as the fleetID with NO membership check — and each of these reads honors that
  // caller-bound fleetID with no gate: fleetRuntime.getFleetState/getWings/getMotd/
  // getJoinRequests/getFleetComposition (fleetRuntime.js:1159-1194) take a BARE fleetID
  // and return that fleet's roster (member charIDs, ship types, systems/stations),
  // wings/squads, MOTD, join-request roster, and composition — none calls
  // ensureFleetMembership (that gate guards only the fleet WRITES). The BFF binds the
  // session's OWN fleet (fleetBindSpec passes NO fleetID → session.fleetid), so
  // /api/bridge/bound-fleet does NOT leak; the leak is via /api/bridge/call forwarding
  // a foreign fleetID in args verbatim (server.js:281), exactly as for the R72 bind.
  // Kept pre-plumbed (operator flag-only decision); NOT de-allowlisted. The fix is a
  // hard membership check on the bind or on each read (see the handoff doc).
  //
  // ⚠ READS ONLY. Every fleet WRITE/mutator sibling on this same bound surface —
  // Init / CreateWing / DeleteWing / MoveMember / KickMember / MakeLeader / LeaveFleet /
  // DisbandFleet / SetMotdEx / Invite / SendBroadcast / … — stays refused before
  // dispatch (Phase-4). Only these 5 reads are opened.
  Object.freeze({ service: "fleetObjectHandler", method: "GetInitState" }),
  Object.freeze({ service: "fleetObjectHandler", method: "GetWings" }),
  Object.freeze({ service: "fleetObjectHandler", method: "GetMotd" }),
  Object.freeze({ service: "fleetObjectHandler", method: "GetJoinRequests" }),
  Object.freeze({ service: "fleetObjectHandler", method: "GetFleetComposition" }),
  // R87 Phase-3 top-level WRITES — notifications (W-NOTIF, 7) + calendar
  // (W-CAL, 7) + bookmarks (W-BM, 7), the "personal + org" writes batch (follows
  // the R86 mail pattern). Every one is CONFIRM-GATED at the BFF (a stray click /
  // stray POST refuses without confirm: true) and every one is SESSION / ACCESS
  // scoped — no arg a browser sends redirects the mutation at a FOREIGN entity:
  //
  //   • notificationMgr Mark*/Delete*/LogNotificationInteraction resolve the
  //     mailbox from the SESSION character (getSessionCharacterID); a group/id the
  //     session does not own is absent from its rows, so the write is a silent
  //     no-op. Delete{Group,All,}Notifications are the destructive trio.
  //   • calendarMgr Edit/Delete/Respond/UpdateParticipants all pass through
  //     access.canEditOrDeleteEvent(event, session) server-side — a foreign
  //     eventID is a permission error (CustomNotify), never a foreign mutation.
  //     Create{Corporation,Alliance}Event + UpdateEventParticipants are role /
  //     scope gated (a normal member is refused server-side — correct). DeleteEvent
  //     is destructive.
  //   • accessGroupBookmarkMgr folder/bookmark CRUD (reads were R65) resolves the
  //     folder via resolveFolderView against the SESSION character's access level
  //     and gates on canWriteFolder / canManageFolder / ACCESS_ADMIN — a foreign
  //     folderID is FolderAccessDenied. DeleteFolder / DeleteBookmarks are
  //     destructive. (BookmarkLocation — the in-space variant — stays OUT of slice;
  //     only BookmarkStaticLocation is wired.)
  //
  // ⚠ The destructive writes (Delete* notifications, DeleteEvent, DeleteFolder,
  // DeleteBookmarks) are reachable + confirm-gated but NEVER fired on the live
  // world in the plumbing pass. No arg-injection flagged: every write is
  // session/access-guarded server-side (audit 2026-07-22).
  Object.freeze({ service: "notificationMgr", method: "MarkGroupAsProcessed" }),
  Object.freeze({ service: "notificationMgr", method: "MarkAllAsProcessed" }),
  Object.freeze({ service: "notificationMgr", method: "MarkAsProcessed" }),
  Object.freeze({ service: "notificationMgr", method: "DeleteGroupNotifications" }),
  Object.freeze({ service: "notificationMgr", method: "DeleteAllNotifications" }),
  Object.freeze({ service: "notificationMgr", method: "DeleteNotifications" }),
  Object.freeze({ service: "notificationMgr", method: "LogNotificationInteraction" }),
  Object.freeze({ service: "calendarMgr", method: "CreatePersonalEvent" }),
  Object.freeze({ service: "calendarMgr", method: "CreateCorporationEvent" }),
  Object.freeze({ service: "calendarMgr", method: "CreateAllianceEvent" }),
  Object.freeze({ service: "calendarMgr", method: "EditPersonalEvent" }),
  Object.freeze({ service: "calendarMgr", method: "DeleteEvent" }),
  Object.freeze({ service: "calendarMgr", method: "SendEventResponse" }),
  Object.freeze({ service: "calendarMgr", method: "UpdateEventParticipants" }),
  Object.freeze({ service: "accessGroupBookmarkMgr", method: "AddFolder" }),
  Object.freeze({ service: "accessGroupBookmarkMgr", method: "UpdateFolder" }),
  Object.freeze({ service: "accessGroupBookmarkMgr", method: "DeleteFolder" }),
  Object.freeze({ service: "accessGroupBookmarkMgr", method: "BookmarkStaticLocation" }),
  Object.freeze({ service: "accessGroupBookmarkMgr", method: "UpdateBookmark" }),
  Object.freeze({ service: "accessGroupBookmarkMgr", method: "DeleteBookmarks" }),
  Object.freeze({ service: "accessGroupBookmarkMgr", method: "MoveBookmarksToFolderAndSubfolder" }),
  // R88 Phase-3 top-level WRITES — character (charMgr, 12) + charUnboundMgr (5) +
  // LSC (1), the "character + social" writes batch (follows the R86/R87 pattern).
  // Every one is CONFIRM-GATED at the BFF (a stray click / stray POST refuses
  // without confirm: true).
  //
  //   • charMgr Set*/Log*/Add/Delete/Block/Unblock/*Note resolve the acting
  //     character from the SESSION (sessionCharacterID) — the contact/block/note
  //     stores are keyed by the session character, so no browser arg redirects the
  //     mutation at a FOREIGN character's list. AddOwnerNote answers the new noteID;
  //     the rest answer null.
  //   • charUnboundMgr CancelCharacterDeletePrepare(charId) is guarded by
  //     session.userid (⚠ char-lifecycle — never fired live); ToggleValidation is a
  //     debug-only session flag (a normal session no-ops, returns true);
  //     CreateCharacterWithDoll (⚠ creates a whole character — never fired live)
  //     answers the new characterID.
  //   • ⚠ charUnboundMgr UpdateCharacterGender(charId,...) /
  //     UpdateCharacterBloodline(charId,...) take a CALLER-SUPPLIED charId and
  //     mutate that character record directly with no ownership check on the record
  //     write (only the session gender-mirror is account-scoped). These are
  //     creation-flow writes (a pre-birth doll) but the handler trusts the arg —
  //     WRITE-SIDE ARG-INJECTION, flagged in evejs-web-poc/docs/
  //     arg-injection-leak-handoff.md (server-side fix + QA later). Kept plumbed +
  //     confirm-gated.
  //   • ⚠ LSC.SendMessage(channelID, message) sends an OUTWARD chat message — never
  //     fired live in the plumbing pass.
  Object.freeze({ service: "charMgr", method: "SetCharacterDescription" }),
  Object.freeze({ service: "charMgr", method: "SetActivityStatus" }),
  Object.freeze({ service: "charMgr", method: "LogSettings" }),
  Object.freeze({ service: "charMgr", method: "AddContact" }),
  Object.freeze({ service: "charMgr", method: "DeleteContacts" }),
  Object.freeze({ service: "charMgr", method: "EditContactsRelationshipID" }),
  Object.freeze({ service: "charMgr", method: "BlockOwners" }),
  Object.freeze({ service: "charMgr", method: "UnblockOwners" }),
  Object.freeze({ service: "charMgr", method: "SetNote" }),
  Object.freeze({ service: "charMgr", method: "AddOwnerNote" }),
  Object.freeze({ service: "charMgr", method: "EditOwnerNote" }),
  Object.freeze({ service: "charMgr", method: "RemoveOwnerNote" }),
  Object.freeze({ service: "charUnboundMgr", method: "CancelCharacterDeletePrepare" }),
  Object.freeze({ service: "charUnboundMgr", method: "ToggleValidation" }),
  Object.freeze({ service: "charUnboundMgr", method: "CreateCharacterWithDoll" }),
  Object.freeze({ service: "charUnboundMgr", method: "UpdateCharacterGender" }),
  Object.freeze({ service: "charUnboundMgr", method: "UpdateCharacterBloodline" }),
  Object.freeze({ service: "LSC", method: "SendMessage" }),
  // R89 Phase-3 top-level WRITES — the FINANCIAL cluster (ISK / LP / insurance /
  // bounty + kill rights), 15 pairs across account (3), LPSvc (3), LPStoreMgr (2),
  // insuranceSvc (2), bountyProxy (3) and killRightMgr (2). Follows the R86–R88
  // pattern. ⚠⚠ EVERY one of these SPENDS/TRANSFERS ISK or LP or affects a kill
  // right, so every BFF route is CONFIRM-GATED and NONE is ever fired on the live
  // world in the plumbing pass — allowlist landing is proven only via a call the
  // server refuses for another reason (no target / no funds / no live session).
  //
  //   • account.GiveCash / GiveCashFromCorpAccount / SetContactCost: the FUNDING
  //     SOURCE is always resolved from the SESSION — GiveCash debits
  //     session.characterID; GiveCashFromCorpAccount debits the session's corp
  //     wallet (resolveSessionCorporationID) with the division key only choosing a
  //     division WITHIN that corp. The caller picks destination + amount, never a
  //     foreign source. No foreign-source arg-injection.
  //   • LPSvc.TransferLPFromMyWalletToOtherCorp / TransferLPFromMyCorpWalletToOtherCorp
  //     resolve the source from the SESSION (character wallet / session.corporationID
  //     with a corp-role check); args[0] is the RECEIVER corp, args[1] the LP issuer
  //     namespace — not the source. ExchangeConcordLP is a stub. No foreign source.
  //   • LPStoreMgr.TakeOfferForCharacter spends the SESSION char's LP (corpID selects
  //     the STORE, not the funding wallet); TakeOfferForCorporation is a stub.
  //   • insuranceSvc.InsureShip / UnInsureShip: premium debited from the session;
  //     itemID is the ship to (un)insure.
  //   • bountyProxy.AddToBounty debits the session char's wallet (target is the
  //     bounty subject); SellKillRight / CancelSellKillRight list/withdraw a kill
  //     right the session owns.
  //   • killRightMgr.ActivateKillRight / BuyKillRight act on the session character
  //     (activateOwnedKillRight / buyKillRight fund from session.characterID).
  //
  // No caller-supplied FOREIGN source was found on any of the 15 — every financial
  // debit is session-scoped (see arg-injection-leak-handoff.md note; nothing to add).
  Object.freeze({ service: "account", method: "SetContactCost" }),
  Object.freeze({ service: "account", method: "GiveCash" }),
  Object.freeze({ service: "account", method: "GiveCashFromCorpAccount" }),
  Object.freeze({ service: "LPSvc", method: "ExchangeConcordLP" }),
  Object.freeze({ service: "LPSvc", method: "TransferLPFromMyWalletToOtherCorp" }),
  Object.freeze({ service: "LPSvc", method: "TransferLPFromMyCorpWalletToOtherCorp" }),
  Object.freeze({ service: "LPStoreMgr", method: "TakeOfferForCharacter" }),
  Object.freeze({ service: "LPStoreMgr", method: "TakeOfferForCorporation" }),
  Object.freeze({ service: "insuranceSvc", method: "InsureShip" }),
  Object.freeze({ service: "insuranceSvc", method: "UnInsureShip" }),
  Object.freeze({ service: "bountyProxy", method: "AddToBounty" }),
  Object.freeze({ service: "bountyProxy", method: "SellKillRight" }),
  Object.freeze({ service: "bountyProxy", method: "CancelSellKillRight" }),
  Object.freeze({ service: "killRightMgr", method: "ActivateKillRight" }),
  Object.freeze({ service: "killRightMgr", method: "BuyKillRight" }),
  // R90 Phase-3 top-level WRITES — ship + fighter IN-SPACE ops (W-SHIP 14 +
  // W-FIGHTER 9). Follows the R86–R89 pattern. Every BFF route is CONFIRM-GATED
  // and Farmer is DOCKED, so most of these return a not-in-space error and are
  // NOT live-exercisable; the batch is verified for reachability + refuses-
  // without-confirm only. ⚠ EXTRA-CARE (never fired live even where reachable):
  // ship.Eject / ship.SafeLogoff (change session state), ship.Jettison /
  // ship.Drop (dump cargo to space — could lose items) and
  // fighterMgr.CmdAbandonFighter (abandons a fighter).
  //
  //   • Every ship write resolves the ACTIVE ship / capsule from the SESSION
  //     (this._getShipID(session) / ejectSession(session) /
  //     getActiveShipRecord(session.characterID)). AssembleShip / FitShips list
  //     the packaged ships by session characterID (findCharacterShip / the
  //     char-scoped multifit lister — ownership-checked). The itemID/objectID-
  //     taking ops (Scoop / ScoopToMobileDepotHold / Jettison / LaunchFromShip /
  //     LaunchFromContainer / Drop) act on space objects near the session's ship
  //     and the underlying helpers gate on proximity / owner — no caller-supplied
  //     FOREIGN ship is boarded or mutated. No new arg-injection flag.
  //   • Every fighterMgr write resolves the controller HOST from the SESSION
  //     (_getFighterControllerHost(session)) and validates each fighter against
  //     that host + session before moving it; a fighterID the host does not own
  //     is a no-op. Session-scoped, no foreign mutation.
  Object.freeze({ service: "ship", method: "Eject" }),
  Object.freeze({ service: "ship", method: "LeaveShip" }),
  Object.freeze({ service: "ship", method: "BoardStoredShip" }),
  Object.freeze({ service: "ship", method: "StoreVessel" }),
  Object.freeze({ service: "ship", method: "AssembleShip" }),
  Object.freeze({ service: "ship", method: "FitShips" }),
  Object.freeze({ service: "ship", method: "ConfigureShip" }),
  Object.freeze({ service: "ship", method: "Scoop" }),
  Object.freeze({ service: "ship", method: "ScoopToMobileDepotHold" }),
  Object.freeze({ service: "ship", method: "Jettison" }),
  Object.freeze({ service: "ship", method: "LaunchFromShip" }),
  Object.freeze({ service: "ship", method: "LaunchFromContainer" }),
  Object.freeze({ service: "ship", method: "Drop" }),
  Object.freeze({ service: "ship", method: "SafeLogoff" }),
  // The station-services "Board my Corvette" write. Fully session-scoped like
  // the W-SHIP batch above: Handle_CreateNewbieShip resolves the character and
  // docked station from the SESSION (its two optional args are logging-only),
  // refuses when not docked (MustBeDocked) or already in a corvette
  // (AlreadyInNewbieShip), and boardRookieShipForSession spawns/repairs/fits
  // the race corvette in the session's OWN hangar — no caller-supplied foreign
  // id is honored. CONFIRM-GATED at the BFF (POST /api/bridge/ship/board-corvette).
  Object.freeze({ service: "dogmaIM", method: "CreateNewbieShip" }),
  Object.freeze({ service: "fighterMgr", method: "LoadFightersToTube" }),
  Object.freeze({ service: "fighterMgr", method: "UnloadTubeToFighterBay" }),
  Object.freeze({ service: "fighterMgr", method: "LaunchFightersFromTubes" }),
  Object.freeze({ service: "fighterMgr", method: "RecallFightersToTubes" }),
  Object.freeze({ service: "fighterMgr", method: "ExecuteMovementCommandOnFighters" }),
  Object.freeze({ service: "fighterMgr", method: "CmdActivateAbilitySlots" }),
  Object.freeze({ service: "fighterMgr", method: "CmdDeactivateAbilitySlots" }),
  Object.freeze({ service: "fighterMgr", method: "CmdAbandonFighter" }),
  Object.freeze({ service: "fighterMgr", method: "CmdScoopAbandonedFighterFromSpace" }),
  // R95 Phase-4 top-level WRITES — the FIRST Phase-4 batch: skills (WB-SKILL) +
  // clones (WB-CLONE) + safety (WB-CRIME), 17 writes across the SAME three
  // session-scoped services the R73/R76/R78 reads opened — "skillHandler",
  // "jumpCloneSvc", "crimewatch". Each dispatches on the ORDINARY top-level /call
  // seam (heldTopLevelCall(<svc>, <method>)); NO MachoBindObject two-step — these
  // WRITES ride exactly the same seam their sibling reads proved. Every handler
  // derives the character from the SESSION (this._getCharacterId(session) /
  // session.characterID); none accepts a caller-supplied charID that steers a
  // FOREIGN character's skills/clones/safety — the id args they DO take (injector
  // itemID, jumpCloneID, safety level) are resolved against the session's OWN
  // records (findItemById / updateCharacterRecord(session charID) / the session's
  // own clone list), so a foreign id simply misses ("not found"), never mutates
  // another char. Each is CONFIRM-GATED at the BFF (requireWriteConfirmation);
  // the destructive/financial ones (ExtractSkills, InjectSkillIntoBrain,
  // InstallCloneInStation/Structure, CloneJump, DestroyInstalledClone) are
  // reachable + refused-without-confirm only — NEVER fired on the live world in
  // this plumbing pass. Every Handle_* grep-confirmed to exist.
  //
  // WB-SKILL (8) — skillMgrService.js Handle_* inherited under "skillHandler".
  Object.freeze({ service: "skillHandler", method: "CharStartTrainingSkill" }),
  Object.freeze({ service: "skillHandler", method: "AbortTraining" }),
  Object.freeze({ service: "skillHandler", method: "ApplyFreeSkillPoints" }),
  Object.freeze({ service: "skillHandler", method: "ExtractSkills" }),
  Object.freeze({ service: "skillHandler", method: "InjectSkillpoints" }),
  Object.freeze({ service: "skillHandler", method: "SplitSkillInjector" }),
  Object.freeze({ service: "skillHandler", method: "CombineSkillInjector" }),
  Object.freeze({ service: "skillHandler", method: "InjectSkillIntoBrain" }),
  // WB-CLONE (8) — jumpCloneService.js Handle_* on "jumpCloneSvc".
  Object.freeze({ service: "jumpCloneSvc", method: "InstallCloneInStation" }),
  Object.freeze({ service: "jumpCloneSvc", method: "InstallCloneInStructure" }),
  Object.freeze({ service: "jumpCloneSvc", method: "CloneJump" }),
  Object.freeze({ service: "jumpCloneSvc", method: "DestroyInstalledClone" }),
  Object.freeze({ service: "jumpCloneSvc", method: "SetJumpCloneName" }),
  Object.freeze({ service: "jumpCloneSvc", method: "OfferShipCloneInstallation" }),
  Object.freeze({ service: "jumpCloneSvc", method: "AcceptShipCloneInstallation" }),
  Object.freeze({ service: "jumpCloneSvc", method: "CancelShipCloneInstallation" }),
  // WB-CRIME (1) — crimewatchService.js Handle_SetSafetyLevel on "crimewatch".
  Object.freeze({ service: "crimewatch", method: "SetSafetyLevel" }),
  // R96 Phase-4 top-level WRITES — corpRegistry batch A (WB-CORPREG split 1 of ~3):
  // bulletins + labels + contacts + titles, 15 writes on the SAME "corpRegistry"
  // service the R80/R81/R82 reads opened. Retail addresses corpRegistry per-corp via
  // eveMoniker.GetCorpRegistry(corpID) -> Moniker("corpRegistry", corpID) ->
  // MachoBindObject, but — exactly like the R80-82 reads and corpRegistry.
  // GetCorporation (R37) — every Handle_* here resolves the corp from the SESSION
  // (resolveCorporationID(session)), never from a bound context, so they ride the
  // ORDINARY top-level /call seam (heldTopLevelCall("corpRegistry", <method>)); NO
  // MachoBindObject two-step. corpRegistry.MachoBindObject is STILL NOT listed — a
  // browser cannot BIND a FOREIGN corp, so these writes act ONLY on the session's
  // own corp; a caller-supplied bulletinID/labelID/titleID/contactID that is not in
  // the session-corp table simply MISSES (no-op), never mutating another corp.
  //
  // ⚠ ROLE-GATED: corpRegistry writes are CEO/director-role-gated server-side; a
  // session lacking the role gets a role refusal / error return — CORRECT server
  // behavior, not a bridge bug. Each is CONFIRM-GATED at the BFF
  // (requireWriteConfirmation). ⚠ EXTRA-CARE destructive (reachable + refused-
  // without-confirm ONLY, NEVER fired live): DeleteBulletin, DeleteLabel,
  // RemoveCorporateContacts. Every Handle_* grep-confirmed to exist in
  // corpRegistryRuntime.js. This flips these writes from refused (through R95) to
  // allowed.
  //
  // Bulletins (4) — corpRegistryRuntime.js Handle_* on "corpRegistry".
  Object.freeze({ service: "corpRegistry", method: "AddBulletin" }),
  Object.freeze({ service: "corpRegistry", method: "UpdateBulletin" }),
  Object.freeze({ service: "corpRegistry", method: "UpdateBulletinOrder" }),
  Object.freeze({ service: "corpRegistry", method: "DeleteBulletin" }),
  // Contact labels (5).
  Object.freeze({ service: "corpRegistry", method: "CreateLabel" }),
  Object.freeze({ service: "corpRegistry", method: "EditLabel" }),
  Object.freeze({ service: "corpRegistry", method: "DeleteLabel" }),
  Object.freeze({ service: "corpRegistry", method: "AssignLabels" }),
  Object.freeze({ service: "corpRegistry", method: "RemoveLabels" }),
  // Corporate contacts (4).
  Object.freeze({ service: "corpRegistry", method: "AddCorporateContact" }),
  Object.freeze({ service: "corpRegistry", method: "EditCorporateContact" }),
  Object.freeze({ service: "corpRegistry", method: "RemoveCorporateContacts" }),
  Object.freeze({ service: "corpRegistry", method: "EditContactsRelationshipID" }),
  // Titles (2).
  Object.freeze({ service: "corpRegistry", method: "UpdateTitle" }),
  Object.freeze({ service: "corpRegistry", method: "UpdateTitles" }),
  // R97 Phase-4 top-level WRITES — corpRegistry batch B (WB-CORPREG split 2 of ~3):
  // member/corp config + settings (14 writes). Same dispatch as batch A — every
  // Handle_* resolves the corp from the SESSION (resolveCorporationID(session)) and
  // rides the ORDINARY top-level /call seam; corpRegistry.MachoBindObject is STILL
  // NOT listed, so a browser cannot bind a FOREIGN corp and every write acts only on
  // the session's own corp (UpdateMember/UpdateMembers scope the member to the
  // session-corp runtime — a member not in this corp simply MISSES). Confirm-gated
  // at the BFF; role-gated server-side (CEO/director) — a role refusal is correct.
  // ⚠ EXTRA-CARE (reachable + refused-without-confirm ONLY, never fired live):
  // DeleteTitle (destructive) and ExecuteActions (a generic corp-action executor
  // that can drive multiple role-gated mutations). Every Handle_* grep-confirmed in
  // corpRegistryRuntime.js. This flips these writes from refused (through R96) to
  // allowed.
  Object.freeze({ service: "corpRegistry", method: "UpdateMember" }),
  Object.freeze({ service: "corpRegistry", method: "UpdateMembers" }),
  Object.freeze({ service: "corpRegistry", method: "UpdateCorporation" }),
  Object.freeze({ service: "corpRegistry", method: "UpdateCorporationAbilities" }),
  Object.freeze({ service: "corpRegistry", method: "UpdateLogo" }),
  Object.freeze({ service: "corpRegistry", method: "UpdateDivisionNames" }),
  Object.freeze({ service: "corpRegistry", method: "SetAccountKey" }),
  Object.freeze({ service: "corpRegistry", method: "SetCorpWelcomeMail" }),
  Object.freeze({ service: "corpRegistry", method: "SetStructureReinforceDefault" }),
  Object.freeze({ service: "corpRegistry", method: "RegisterNewAggressionSettings" }),
  Object.freeze({ service: "corpRegistry", method: "RegisterNewAcceptStructureSettings" }),
  Object.freeze({ service: "corpRegistry", method: "RegisterNewCorpMailRestrictionSettings" }),
  Object.freeze({ service: "corpRegistry", method: "DeleteTitle" }),
  Object.freeze({ service: "corpRegistry", method: "ExecuteActions" }),
  // R98 Phase-4 top-level WRITES — corpRegistry batch C (WB-CORPREG split 3 of 3,
  // CLOSES corpRegistry writes at 43/43): shares / dividend / kicks / applications /
  // alliance / war (14 writes). Same dispatch as batches A/B — every Handle_* rides
  // the ORDINARY top-level /call seam and the DECLARER/ACTOR/SPENDER is derived from
  // the SESSION (resolveCorporationID / resolveCharacterID), NOT a bound context;
  // corpRegistry.MachoBindObject is STILL NOT listed. Confirm-gated at the BFF;
  // role-gated server-side (CEO/director) — a role refusal is correct.
  // ⚠⚠ EVERY ONE is FINANCIAL or DESTRUCTIVE — reachable + refused-without-confirm
  // ONLY, NEVER fired live: PayoutDividend/AddCorporation/CreateAlliance/
  // DeclareWarAgainst (spend ISK), KickOutMember/KickOutMembers/ResignFromCEO
  // (destructive), the share moves and the application/alliance writes.
  // ⚠ ARG-INJECTION (flagged, not fixed here): _MoveShares (MoveCompanyShares/
  // MovePrivateShares) reads args[0] as a caller-supplied corporationID (defaults to
  // the session corp) — the dedicated BFF routes pass null so it resolves to the
  // SESSION corp, but the generic /api/bridge/call seam could still steer a foreign
  // corp's company-share treasury (see docs/arg-injection-leak-handoff.md).
  // Every Handle_* grep-confirmed in corpRegistryRuntime.js.
  Object.freeze({ service: "corpRegistry", method: "MoveCompanyShares" }),
  Object.freeze({ service: "corpRegistry", method: "MovePrivateShares" }),
  Object.freeze({ service: "corpRegistry", method: "PayoutDividend" }),
  Object.freeze({ service: "corpRegistry", method: "KickOutMember" }),
  Object.freeze({ service: "corpRegistry", method: "KickOutMembers" }),
  Object.freeze({ service: "corpRegistry", method: "ResignFromCEO" }),
  Object.freeze({ service: "corpRegistry", method: "InsertApplication" }),
  Object.freeze({ service: "corpRegistry", method: "InsertInvitation" }),
  Object.freeze({ service: "corpRegistry", method: "UpdateApplicationOffer" }),
  Object.freeze({ service: "corpRegistry", method: "AddCorporation" }),
  Object.freeze({ service: "corpRegistry", method: "CreateAlliance" }),
  Object.freeze({ service: "corpRegistry", method: "ApplyToJoinAlliance" }),
  Object.freeze({ service: "corpRegistry", method: "DeleteAllianceApplication" }),
  Object.freeze({ service: "corpRegistry", method: "DeclareWarAgainst" }),
  // R99 Phase-4 top-level WRITES — allianceRegistry + warRegistry + corpStationMgr
  // (WB-ALLYREG + WB-WARREG + WB-CORPSTN, 20 writes). Like the R83/R84 allianceRegistry
  // reads and the R79 warRegistry/corpStationMgr reads, each of these services dispatches
  // on the ORDINARY top-level /call seam; the acting ALLIANCE derives from the SESSION
  // (resolveAllianceIDFromSession) and the acting WAR ENTITY / CORP from the SESSION
  // (resolveWarEntityID / resolveCorporationID). NONE of the three MachoBindObject pairs
  // is listed, so a browser cannot bind a FOREIGN alliance/war/corp as the acting party.
  // Confirm-gated at the BFF; allianceRegistry/warRegistry writes are exec-role-gated
  // server-side — a role refusal is CORRECT.
  // ⚠⚠ FINANCIAL / DESTRUCTIVE / CONSEQUENTIAL (reachable + refused-without-confirm ONLY,
  // NEVER fired live): PayBill / MoveCorpHQHere (spend ISK), DeleteRelationship
  // (destroys), AcceptAllyNegotiation / AcceptSurrender / DeclineSurrender (change war
  // state). The rest are governance writes.
  // ⚠ ARG-INJECTION (flagged, not fixed here — see docs/arg-injection-leak-handoff.md):
  // the warRegistry accept/decline/retract/set verbs and allianceRegistry.UpdateAlliance
  // act on a CALLER-SUPPLIED warNegotiationID / warID / allianceID with no session-party
  // gate. Every Handle_* grep-confirmed in allianceRegistryRuntime.js /
  // warRegistryService.js / corpStationMgrService.js.
  Object.freeze({ service: "allianceRegistry", method: "SetRelationship" }),
  Object.freeze({ service: "allianceRegistry", method: "DeleteRelationship" }),
  Object.freeze({ service: "allianceRegistry", method: "AddAllianceContact" }),
  Object.freeze({ service: "allianceRegistry", method: "AddBulletin" }),
  Object.freeze({ service: "allianceRegistry", method: "UpdateApplication" }),
  Object.freeze({ service: "allianceRegistry", method: "PayBill" }),
  Object.freeze({ service: "allianceRegistry", method: "SetPrimeHour" }),
  Object.freeze({ service: "allianceRegistry", method: "SetCapitalSystem" }),
  Object.freeze({ service: "allianceRegistry", method: "DeclareExecutorSupport" }),
  Object.freeze({ service: "allianceRegistry", method: "UpdateAlliance" }),
  Object.freeze({ service: "warRegistry", method: "CreateWarAllyOffer" }),
  Object.freeze({ service: "warRegistry", method: "RetractWarAllyOffer" }),
  Object.freeze({ service: "warRegistry", method: "CreateSurrenderNegotiation" }),
  Object.freeze({ service: "warRegistry", method: "AcceptAllyNegotiation" }),
  Object.freeze({ service: "warRegistry", method: "DeclineAllyOffer" }),
  Object.freeze({ service: "warRegistry", method: "AcceptSurrender" }),
  Object.freeze({ service: "warRegistry", method: "DeclineSurrender" }),
  Object.freeze({ service: "warRegistry", method: "RetractMutualWar" }),
  Object.freeze({ service: "warRegistry", method: "SetOpenForAllies" }),
  Object.freeze({ service: "corpStationMgr", method: "MoveCorpHQHere" }),
  // R105 PLUMBING sweep — WB-FLEET: the 16 Phase-4 BOUND fleet composition / membership /
  // broadcast WRITES that hang off the SAME fleetObjectHandler.MachoBindObject bind (R72,
  // allowlisted above). CLOSES WB-FLEET (21/21 across the R95 top-level + these 16 bound)
  // and brings the writes phase to 298/301. Unlike the scanMgr bind, MachoBindObject
  // ACCEPTS a caller fleetID — but the BFF dispatches these off fleetBindSpec() with args:[]
  // (dispatchBoundFleetWrite in server.js), so the server binds the SESSION's OWN fleet
  // (session.fleetid; documented "never leaks"). The dedicated routes NEVER pass a caller
  // fleetID; the caller-fleetID path lives only on the generic /api/bridge/call seam (the
  // #26-#30 bind-gateway leak, flagged separately). Reachable ONLY via confirm-gated BFF
  // POST routes (the browser must send `confirm:true` or the route refuses before any
  // dispatch); DisbandFleet (destroys the whole fleet) and KickMember (removes another
  // char) carry extra-explicit confirm messages. FAST-MODE: none fired live (operator owns
  // EveJS; no server restart) — the handlers return true / null / an ack, carried through.
  //
  // ⚠ ROLE-GATE (checked, NOT flagged): every roster mutator is role-gated server-side by
  // the session char's fleet job/role BEFORE it touches the roster —
  // KickMember/MoveMember/CreateSquad → ensureCommanderOrBoss; DisbandFleet/MakeLeader/
  // CreateWing/SetOptions → ensureFleetBoss (creator); LeaveFleet/SetMotdEx/SendBroadcast/
  // Invite/MassInvite/AcceptInvite/RejectInvite/Reconnect → ensureFleetMembership.
  // UpdateMemberInfo operates on the SESSION char only (args[0] is a shipTypeID, NOT a
  // memberID). A non-boss/non-member cannot kick/disband/promote — throwWrappedUserError
  // ("FleetNotCreator"/"FleetNotCommanderOrBoss"/"FleetNotInFleet") fires first. No
  // privilege-escalation-within-fleet path; no handoff-doc flag added.
  Object.freeze({ service: "fleetObjectHandler", method: "CreateWing" }),
  Object.freeze({ service: "fleetObjectHandler", method: "CreateSquad" }),
  Object.freeze({ service: "fleetObjectHandler", method: "MoveMember" }),
  Object.freeze({ service: "fleetObjectHandler", method: "KickMember" }),
  Object.freeze({ service: "fleetObjectHandler", method: "MakeLeader" }),
  Object.freeze({ service: "fleetObjectHandler", method: "LeaveFleet" }),
  Object.freeze({ service: "fleetObjectHandler", method: "DisbandFleet" }),
  Object.freeze({ service: "fleetObjectHandler", method: "SetOptions" }),
  Object.freeze({ service: "fleetObjectHandler", method: "SetMotdEx" }),
  Object.freeze({ service: "fleetObjectHandler", method: "UpdateMemberInfo" }),
  Object.freeze({ service: "fleetObjectHandler", method: "SendBroadcast" }),
  Object.freeze({ service: "fleetObjectHandler", method: "Invite" }),
  Object.freeze({ service: "fleetObjectHandler", method: "MassInvite" }),
  Object.freeze({ service: "fleetObjectHandler", method: "AcceptInvite" }),
  Object.freeze({ service: "fleetObjectHandler", method: "RejectInvite" }),
  Object.freeze({ service: "fleetObjectHandler", method: "Reconnect" }),
]);
const WEB_CALL_ALLOWLIST_KEYS = new Set(
  WEB_CALL_ALLOWLIST.map((pair) => `${pair.service} ${pair.method}`),
);
const WEB_CALL_ERROR_STATUS_CODES = Object.freeze({
  CALL_INVALID: 400,
  CALL_NOT_ALLOWED: 403,
  CALL_SERVICE_UNAVAILABLE: 503,
  CALL_FAILED: 502,
  CALL_REFUSED: 409,
  SESSION_NOT_FOUND: 404,
  SESSION_SELECT_FAILED: 502,
  // R3 bound-object bridge.
  BOUND_HANDLE_NOT_FOUND: 404,
  BOUND_NO_OBJECT: 502,
  // R4 deferred call responses: a handler that returns
  // buildDeferredCallResponse whose completion genuinely needs a client
  // round-trip the synchronous bridge cannot service (e.g. a still-pending
  // OnAgentProvisionalResponse confirmation). Refused as a typed error rather
  // than emitting the broken deferred wrapper as a result. 501 Not Implemented:
  // the bridge does not implement the client round-trip this flow requires.
  CALL_DEFERRED_UNSUPPORTED: 501,
});
const WEB_CALL_FAILURE_DETAIL_LIMIT = 300;
// Persistent browser-backed sessions (web-client goal R2): the select call
// pins this pair, an idle TTL reaps abandoned sessions (generous — this is a
// dev emulator), and minted bridgeSessionIDs are opaque tokens that live only
// between the gateway and the BFF (never in browser JS).
const WEB_SELECT_CHARACTER_CALL = Object.freeze({
  service: "charUnboundMgr",
  method: "SelectCharacterID",
});
const DEFAULT_BROWSER_SESSION_IDLE_TTL_MS = 30 * 60_000;
const DEFAULT_BROWSER_SESSION_SWEEP_INTERVAL_MS = 60_000;
// clientIDs for persistent browser sessions: unique per process, numerically
// far from the retail clientID space used by tests/fixtures.
const BROWSER_SESSION_CLIENT_ID_BASE = 2_000_000_000;
const CHARACTER_COMMAND_TYPES = Object.freeze({
  SAVE_SKILL_QUEUE: "offline.skill_queue.save",
  RESTART_PI_EXTRACTORS: "offline.pi.extractors.restart",
});
const PUBLIC_SKILL_QUEUE_ERROR_CODES = new Set([
  "QueueTooManySkills",
  "QueueTooLong",
  "QueueSkillNotUploaded",
  "QueueCannotTrainPastMaximumLevel",
  "QueueCannotTrainOmegaRestrictedSkill",
  "QueueCannotTrainPreviouslyTrainedSkills",
  "QueueCannotPlaceSkillLevelsOutOfOrder",
  "QueueCannotPlaceSkillBeforeRequirements",
  "UserAlreadyHasSkillInTraining",
  "SkillInQueueRequiresOmegaCloneState",
  "SkillInQueueOverAlphaSpTrainingSize",
]);
const PUBLIC_PI_RESTART_ERROR_CODES = new Set([
  "CannotManagePlanetWithoutCommandCenter",
  "PinDoesNotExist",
  "PinDoesNotHaveHeads",
  "CannotPlaceHeadTooFarAway",
]);

let defaultCharacterRuntimes = null;

function cloneValue(value) {
  return value === undefined || value === null
    ? value
    : JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value, expectedKeys) {
  return isPlainObject(value) &&
    Object.keys(value).sort().join("\u0000") === [...expectedKeys].sort().join("\u0000");
}

function normalizeSkillQueueCommandPayload(payload) {
  if (
    !hasExactKeys(payload, ["entries", "activate"]) ||
    !Array.isArray(payload.entries) ||
    typeof payload.activate !== "boolean" ||
    payload.entries.length > skillQueueRuntime.SKILLQUEUE_MAX_NUM_SKILLS
  ) {
    throw new TypeError("invalid skill queue command payload");
  }
  const entries = payload.entries.map((entry) => {
    if (!hasExactKeys(entry, ["typeID", "toLevel"])) {
      throw new TypeError("invalid skill queue command entry");
    }
    const typeID = entry.typeID;
    const toLevel = entry.toLevel;
    if (
      typeof typeID !== "number" ||
      !Number.isSafeInteger(typeID) ||
      typeID <= 0 ||
      typeof toLevel !== "number" ||
      !Number.isSafeInteger(toLevel) ||
      toLevel < 1 ||
      toLevel > 5
    ) {
      throw new TypeError("invalid skill queue command entry");
    }
    return { typeID, toLevel };
  });
  return { entries, activate: payload.activate };
}

function webCallError(code, message) {
  const error = new Error(message);
  error.name = "WebGatewayCallError";
  error.code = code;
  error.statusCode = WEB_CALL_ERROR_STATUS_CODES[code] || 502;
  return error;
}

function isAllowlistedWebCall(service, method) {
  return WEB_CALL_ALLOWLIST_KEYS.has(`${service} ${method}`);
}

// The BFF sends session state as plain JSON scalars (`userid`, and later
// `characterID`/`charid`, `stationid`, ...). The gateway materializes the
// duck-typed browser-backed session object around them server-side; a live
// session object never crosses HTTP.
function normalizeWebCallSessionFields(sessionFields) {
  if (!isPlainObject(sessionFields)) {
    throw webCallError(
      "CALL_INVALID",
      "Call session must be a JSON object of session fields.",
    );
  }
  const normalized = {};
  for (const [key, value] of Object.entries(sessionFields)) {
    const valueType = typeof value;
    if (
      value !== null &&
      valueType !== "number" &&
      valueType !== "string" &&
      valueType !== "boolean"
    ) {
      throw webCallError(
        "CALL_INVALID",
        `Call session field "${key}" must be a JSON scalar.`,
      );
    }
    normalized[key] = value;
  }
  const userid = Number(normalized.userid);
  if (!Number.isSafeInteger(userid) || userid <= 0) {
    throw webCallError(
      "CALL_INVALID",
      "Call session requires a positive integer userid.",
    );
  }
  normalized.userid = userid;
  return normalized;
}

function normalizeWebCallRequest(request) {
  const call = isPlainObject(request) ? request : {};
  const service = typeof call.service === "string" ? call.service.trim() : "";
  const method = typeof call.method === "string" ? call.method.trim() : "";
  if (!service || !method) {
    throw webCallError(
      "CALL_INVALID",
      "Call requires non-empty service and method names.",
    );
  }
  if (call.args !== undefined && !Array.isArray(call.args)) {
    throw webCallError("CALL_INVALID", "Call args must be an array.");
  }
  if (
    call.kwargs !== undefined &&
    call.kwargs !== null &&
    !isPlainObject(call.kwargs)
  ) {
    throw webCallError(
      "CALL_INVALID",
      "Call kwargs must be a JSON object or null.",
    );
  }
  return {
    service,
    method,
    args: call.args === undefined ? [] : call.args,
    kwargs: call.kwargs === undefined || call.kwargs === null ? null : call.kwargs,
    sessionFields: normalizeWebCallSessionFields(
      call.session === undefined ? {} : call.session,
    ),
  };
}

// Retail-shaped handler results may carry BigInt longs (e.g. cached-call
// version FILETIMEs) that plain JSON cannot represent without precision loss.
// The bridge wire encoding is: BigInt -> decimal string; Buffers use Node's
// default {type:"Buffer",data:[...]} JSON form. Documented in the web repo's
// docs/bridge-wire-contract.md.
function encodeJsonSafeCallValue(value) {
  if (value === undefined || value === null) {
    return value;
  }
  return JSON.parse(JSON.stringify(value, (key, fieldValue) => (
    typeof fieldValue === "bigint" ? fieldValue.toString() : fieldValue
  )));
}

// Extract the bound-object OID strings ("N=<node>:<id>") a Handle_ returned.
// Mirrors network/packetDispatcher._scanAndRegisterOIDs: a bound object is a
// { type:"substruct", value:{ type:"substream", value:[oidString, filetime] } }
// carried directly, or nested inside a MachoBindObject 2-tuple
// [oidSubstruct, callResult]. The first OID discovered depth-first is the
// primary handle the browser (via the BFF) will address; any additional OIDs
// (e.g. a nested GetInventory bound object) are registered too so a stale
// second-level reference still resolves. Order-preserving and de-duplicated.
function extractBoundObjectOIDs(value, output = [], seen = new Set(), depth = 0) {
  if (depth > 8 || value === null || typeof value !== "object") {
    return output;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      extractBoundObjectOIDs(entry, output, seen, depth + 1);
    }
    return output;
  }
  if (value.type === "substruct" && value.value) {
    const substream =
      value.value.type === "substream" ? value.value.value : value.value;
    if (
      Array.isArray(substream) &&
      typeof substream[0] === "string" &&
      substream[0].startsWith("N=") &&
      !seen.has(substream[0])
    ) {
      seen.add(substream[0]);
      output.push(substream[0]);
    }
  }
  for (const entryValue of Object.values(value)) {
    if (entryValue && typeof entryValue === "object") {
      extractBoundObjectOIDs(entryValue, output, seen, depth + 1);
    }
  }
  return output;
}

// Duck-typed browser-backed session: the same plain-object shape the parity
// tests under server/tests/ hand to Handle_* directly, with a capture hook
// mirroring ClientSession.sendServiceNotification(serviceName, methodName,
// payloadTuple, kwargs). Captured notifications are returned in the call
// response; event-channel forwarding is a later goal.
function materializeBrowserBackedSession(sessionFields, notifications) {
  return {
    ...sessionFields,
    sendServiceNotification(serviceName, methodName, payloadTuple = [], kwargs = null) {
      notifications.push({
        service: serviceName === undefined ? null : serviceName,
        method: methodName === undefined ? null : methodName,
        args: Array.isArray(payloadTuple) ? payloadTuple : [payloadTuple],
        kwargs: kwargs === undefined ? null : kwargs,
      });
    },
  };
}

// Persistent browser-backed session (web-client goal R2): the same duck-typed
// plain-object session shape the parity tests hand to Handle_SelectCharacterID
// (see server/tests/characterControlLifecycle.test.js buildSession), with all
// three ClientSession notification surfaces captured into the session's
// accumulating backlog. The session is registered in the live session
// registry, so EveJS's own duplicate-login and character-control rules treat
// it exactly like a retail client session.
// A late-bound push sink for the notification capture stubs. The session object
// must exist before SelectCharacterID runs, but the bridgeSessionID that keys
// the push stream is only minted after it succeeds — so the stubs write through
// this indirection, which is a no-op until the stream is bound. Notifications
// captured before binding are still on `notifications` and still drain onto the
// select response, so nothing is lost.
function createNotificationSink() {
  let publish = null;
  return {
    bind(fn) {
      publish = typeof fn === "function" ? fn : null;
    },
    emit(notification) {
      if (!publish) {
        return;
      }
      try {
        publish(notification);
      } catch {
        // Push delivery is best effort and must never affect the authoritative
        // handler call or the response drain.
      }
    },
  };
}

function materializePersistentBrowserSession(
  sessionFields,
  notifications,
  clientID,
  notificationSink = null,
) {
  const sink = notificationSink || { emit() {} };
  return {
    ...sessionFields,
    userName:
      (typeof sessionFields.userName === "string" && sessionFields.userName) ||
      `web:${sessionFields.userid}`,
    clientID,
    characterID: 0,
    charid: null,
    characterName: "",
    stationid: null,
    stationID: null,
    structureid: null,
    structureID: null,
    connectTime: Date.now(),
    lastActivity: Date.now(),
    // Duck socket: marks the session live for the session registry; retail
    // takeover (evictPriorSession) destroys it like a real socket.
    socket: {
      destroyed: false,
      destroy() {
        this.destroyed = true;
      },
    },
    // ClientSession.sendServiceNotification(serviceName, methodName, payloadTuple, kwargs)
    sendServiceNotification(serviceName, methodName, payloadTuple = [], kwargs = null) {
      const notification = {
        kind: "service",
        service: serviceName === undefined ? null : serviceName,
        method: methodName === undefined ? null : methodName,
        args: Array.isArray(payloadTuple) ? payloadTuple : [payloadTuple],
        kwargs: kwargs === undefined ? null : kwargs,
      };
      notifications.push(notification);
      sink.emit(notification);
    },
    // ClientSession.sendNotification(notifyType, idType, payloadTuple)
    sendNotification(notifyType, idType, payloadTuple = []) {
      const notification = {
        kind: "client",
        service: null,
        method: notifyType === undefined ? null : String(notifyType),
        idType: idType === undefined ? null : idType,
        args: Array.isArray(payloadTuple) ? payloadTuple : [payloadTuple],
        kwargs: null,
      };
      notifications.push(notification);
      sink.emit(notification);
    },
    // ClientSession.sendSessionChange(changes, options)
    sendSessionChange(changes) {
      const notification = {
        kind: "sessionchange",
        service: null,
        method: "OnSessionChanged",
        args: [changes === undefined ? null : changes],
        kwargs: null,
      };
      notifications.push(notification);
      sink.emit(notification);
    },
  };
}

// A handler refusal thrown as a macho-wrapped eveexceptions.UserError (the
// retail refusal shape, e.g. "<name> is already online." from
// Handle_SelectCharacterID). Returns the user-facing text, or "" when the
// error is not a wrapped user error.
function readWrappedUserErrorRefusal(error) {
  const payload = error && error.machoErrorResponse &&
    error.machoErrorResponse.payload;
  const header = payload && Array.isArray(payload.header)
    ? payload.header
    : [];
  const className = String(header[0] && header[0].value || "");
  if (className !== "eveexceptions.UserError") {
    return "";
  }
  const args = Array.isArray(header[1]) ? header[1] : [];
  const code = typeof args[0] === "string" ? args[0] : "";
  const dict = args[1];
  const entries = dict && Array.isArray(dict.entries) ? dict.entries : [];
  // The prose the handler refused with. `info` is the classic UserError key;
  // `notify` is the CustomNotify shape —
  // throwWrappedUserError("CustomNotify", { notify: "<sentence>" }) — which
  // over 130 handlers across the services use, industry's deliver and cancel
  // among them ("That industry job is not ready yet.", "You do not have access
  // to that industry job."). Reading only `info` threw all of that away and
  // surfaced the bare code "CustomNotify" to the player, which is both jargon
  // and useless; the whole point of CALL_REFUSED is to carry the handler's OWN
  // words, so both keys are read here.
  const proseEntry = entries.find(
    (entry) =>
      Array.isArray(entry) && (entry[0] === "info" || entry[0] === "notify") && entry[1],
  );
  if (proseEntry) {
    return String(proseEntry[1]);
  }
  // A STRUCTURED refusal: some handlers refuse with a machine-readable list of
  // reasons instead of a prose `info` string. industry's
  // throwIndustryValidationError is the case that matters here — it raises a
  // UserError whose code is a bare "IndustryValidationError" and whose real
  // content is an `errors` list of (KeyVal{value,name}, args) tuples. Without
  // this branch the caller receives that bare code and knows only THAT the
  // install was refused, not WHY — so a client would have to invent a cause or
  // say nothing useful.
  //
  // The names appended here are the SERVER'S OWN (MISSING_MATERIAL,
  // ACCOUNT_FUNDS, SLOTS_FULL, ...). Nothing is interpreted or reworded: the
  // refusal reads "IndustryValidationError: MISSING_MATERIAL, ACCOUNT_FUNDS",
  // and turning those names into a player-facing sentence is the client's
  // presentation job.
  const reasons = readStructuredRefusalReasons(entries);
  return reasons.length > 0 ? `${code}: ${reasons.join(", ")}` : code;
}

/**
 * Pull the `name` out of each entry of a UserError's `errors` list. Each entry
 * is a tuple whose first element is a util.KeyVal carrying {value, name}; a
 * malformed or unnamed entry is skipped rather than guessed at. Capped so a
 * pathological error list can never blow up the refusal message.
 */
const STRUCTURED_REFUSAL_REASON_LIMIT = 8;

function readStructuredRefusalReasons(entries) {
  const errorsEntry = entries.find(
    (entry) => Array.isArray(entry) && entry[0] === "errors" && entry[1],
  );
  const errorList = errorsEntry && errorsEntry[1];
  const items =
    errorList && Array.isArray(errorList.items) ? errorList.items : [];
  const names = [];
  for (const item of items) {
    if (names.length >= STRUCTURED_REFUSAL_REASON_LIMIT) {
      break;
    }
    const tupleItems = item && Array.isArray(item.items) ? item.items : [];
    const keyVal = tupleItems[0];
    const keyValEntries =
      keyVal && keyVal.args && Array.isArray(keyVal.args.entries)
        ? keyVal.args.entries
        : [];
    const nameEntry = keyValEntries.find(
      (entry) => Array.isArray(entry) && entry[0] === "name" && entry[1],
    );
    if (nameEntry && !names.includes(String(nameEntry[1]))) {
      names.push(String(nameEntry[1]));
    }
  }
  return names;
}

// Map a handler dispatch failure to a typed wire error: retail user-facing
// refusals surface as CALL_REFUSED with the handler's own message (never
// pre-empted or reimplemented — the handler already ran and refused);
// everything else is CALL_FAILED with a truncated detail.
function toWebCallDispatchError(error, service, method) {
  const refusal = readWrappedUserErrorRefusal(error);
  if (refusal) {
    return webCallError("CALL_REFUSED", refusal);
  }
  const detail = String(error && error.message ? error.message : error)
    .slice(0, WEB_CALL_FAILURE_DETAIL_LIMIT);
  return webCallError("CALL_FAILED", `${service}.${method} failed: ${detail}`);
}

// R7 chat: normalize the requested channel ("local"|"corp") to a typed
// CALL_INVALID before touching the held session, and map a chat helper error to
// a typed wire error. A malformed channel/message is CALL_INVALID; a channel
// access failure or mute (the helper marks these chatRefusal) is CALL_REFUSED
// with the core handler's own message; anything else is CALL_FAILED.
function normalizeChatChannel(channel) {
  try {
    return webChatGatewayService.normalizeChannel(channel);
  } catch (error) {
    throw webCallError(
      "CALL_INVALID",
      error && error.message ? error.message : "Invalid chat channel.",
    );
  }
}

function toWebChatError(error) {
  if (error && error.code && WEB_CALL_ERROR_STATUS_CODES[error.code]) {
    // Already a typed gateway error (e.g. re-thrown from a nested dispatch).
    return error;
  }
  if (error && error.chatInvalid) {
    return webCallError(
      "CALL_INVALID",
      error.message || "Invalid chat request.",
    );
  }
  if (error && error.chatRefusal) {
    return webCallError(
      "CALL_REFUSED",
      error.message || "Chat message refused.",
    );
  }
  const detail = String(error && error.message ? error.message : error).slice(
    0,
    WEB_CALL_FAILURE_DETAIL_LIMIT,
  );
  return webCallError("CALL_FAILED", `chat request failed: ${detail}`);
}

// --- R11 space snapshot projection ----------------------------------------
// Pure read-side helpers for the overview + ship HUD. They only READ space
// entities the runtime handed us and copy scalars into a flat JSON row; they
// never mutate game state and nothing here is a game mechanic. The gateway
// calls space/runtime.js + space/combat/damage.js; it must never modify them.

/** A finite number, or `fallback`. */
function spaceNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

/** A finite 0-1 ratio, or null when the entity does not carry one. */
function spaceRatio(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return null;
  }
  return Math.min(1, Math.max(0, numeric));
}

/** A {x,y,z} vector projected as plain finite numbers. */
function spaceVector(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    x: spaceNumber(source.x, 0),
    y: spaceNumber(source.y, 0),
    z: spaceNumber(source.z, 0),
  };
}

/**
 * The three health layers as REMAINING fractions (0-1), the same convention
 * retail's ballpark `damageState` uses: shield is the stored charge fraction,
 * armor and hull are 1 - their damage fractions. Entities with no condition
 * state (a stargate, a planet) get nulls, and the UI simply shows no bars.
 */
function spaceHealthRatios(entity) {
  const condition =
    entity && entity.conditionState && typeof entity.conditionState === "object"
      ? entity.conditionState
      : null;
  if (!condition) {
    return { shield: null, armor: null, hull: null };
  }
  const armorDamage = spaceRatio(condition.armorDamage);
  const hullDamage = spaceRatio(condition.damage);
  return {
    shield: spaceRatio(condition.shieldCharge),
    armor: armorDamage === null ? null : 1 - armorDamage,
    hull: hullDamage === null ? null : 1 - hullDamage,
  };
}

/**
 * Refresh presentation fields before projecting, exactly as the runtime's own
 * ensureInitialBallpark does before it builds a slim payload. The runtime
 * exposes these helpers only through its `_testing` bag; since the gateway may
 * CALL the space runtime but never modify it, we use the handles that exist and
 * treat their absence as "project what we already have".
 */
function refreshSpacePresentationFields(spaceRuntime, egoEntity, entities) {
  const testing =
    spaceRuntime && spaceRuntime._testing && typeof spaceRuntime._testing === "object"
      ? spaceRuntime._testing
      : null;
  if (!testing) {
    return;
  }
  try {
    if (egoEntity && typeof testing.refreshShipPresentationFieldsForTesting === "function") {
      testing.refreshShipPresentationFieldsForTesting(egoEntity);
    }
    if (
      Array.isArray(entities) &&
      typeof testing.refreshEntitiesForSlimPayloadForTesting === "function"
    ) {
      testing.refreshEntitiesForSlimPayloadForTesting(entities);
    }
  } catch {
    // A refresh failure must not fail the read — the projection below still
    // reports the last integrated position/identity for every ball.
  }
}

/**
 * R25 slice A: what a drone in space is DOING, as a word rather than a number.
 *
 * The activity numbers (0 idle, 1 combat, 2 mining, …) belong to the drone
 * runtime, so they are read FROM IT — `droneRuntime` exports every STATE_*
 * constant, and this map is keyed off those exports rather than off literals
 * copied out of it. If the runtime is not loadable in this process the drone
 * still projects; it simply reports a null activity ("unknown"), never "idle",
 * because telling a player their drones are idle when we could not look is
 * exactly the lie that gets a ship killed.
 */
function droneActivityWord(entity) {
  let states = null;
  try {
    states = require(path.join(__dirname, "../../services/drone/droneRuntime"));
  } catch {
    return null;
  }
  if (!states) {
    return null;
  }
  const raw = Number(entity && entity.activityState);
  if (!Number.isFinite(raw)) {
    return null;
  }
  const byState = new Map([
    [Number(states.STATE_IDLE), "idle"],
    [Number(states.STATE_COMBAT), "fighting"],
    [Number(states.STATE_MINING), "mining"],
    [Number(states.STATE_APPROACHING), "approaching"],
    [Number(states.STATE_DEPARTING), "returning"],
    [Number(states.STATE_PURSUIT), "chasing"],
    [Number(states.STATE_SALVAGING), "salvaging"],
  ]);
  return byState.has(raw) ? byState.get(raw) : null;
}

/**
 * One overview row: the identity/position fields retail pairs a ball with its
 * slimItem for, plus the ship-ish fields when the ball is a ship. Distance,
 * sorting and filtering are deliberately NOT computed here — the browser does
 * that from `position`, exactly as the retail client does.
 */
function projectSpaceEntity(entity, egoItemID = 0, mineableStateFor = null) {
  if (!entity || typeof entity !== "object") {
    return null;
  }
  const itemID = spaceNumber(entity.itemID, 0);
  if (itemID <= 0) {
    return null;
  }
  const health = spaceHealthRatios(entity);
  const row = {
    kind: typeof entity.kind === "string" ? entity.kind : null,
    itemID,
    typeID: spaceNumber(entity.slimTypeID, spaceNumber(entity.typeID, 0)) || null,
    groupID: spaceNumber(entity.slimGroupID, spaceNumber(entity.groupID, 0)) || null,
    categoryID:
      spaceNumber(entity.slimCategoryID, spaceNumber(entity.categoryID, 0)) || null,
    // The runtime's own display name for the ball (a celestial's itemName, a
    // ship's slimName). The browser still resolves TYPE/GROUP names through the
    // name cache; this is the per-object name where one exists.
    name: String(entity.slimName || entity.itemName || "") || null,
    ownerID: spaceNumber(entity.ownerID, 0) || null,
    radius: spaceNumber(entity.radius, 0),
    position: spaceVector(entity.position),
    velocity: spaceVector(entity.velocity),
    // True for the player's own ship, so the overview can mark/skip itself.
    isSelf: egoItemID > 0 && itemID === egoItemID,
    shieldRatio: health.shield,
    armorRatio: health.armor,
    hullRatio: health.hull,
  };
  if (entity.kind === "ship" || entity.kind === "structure") {
    row.characterID = spaceNumber(entity.characterID, 0) || null;
    row.corporationID = spaceNumber(entity.corporationID, 0) || null;
    row.allianceID = spaceNumber(entity.allianceID, 0) || null;
    row.securityStatus = Number.isFinite(Number(entity.securityStatus))
      ? Number(entity.securityStatus)
      : null;
    row.maxVelocity = spaceNumber(entity.maxVelocity, 0) || null;
    row.mode = typeof entity.mode === "string" ? entity.mode : null;
    row.targetEntityID = spaceNumber(entity.targetEntityID, 0) || null;
    row.capacitorRatio = spaceRatio(entity.capacitorChargeRatio);
    // R25 slice B: IS THIS A PERSON OR A PIRATE?
    //
    // ⚠ A belt rat is `kind: "ship"`. Not "npc", not "rat" — the SAME kind as
    // the player parked next to you, built through the same buildShipEntity*
    // path, carrying the same position/health/velocity fields. Nothing already
    // in this row separates them, which is why these two are the only new
    // projected fields in R25 and why they are projected at all.
    //
    // `nativeNpc` is the flag the NPC service stamps on every entity it
    // materializes (nativeNpcService.applyNativeRuntimeNpcPresentation), and it
    // is the honest, whole answer to "is a person flying this?".
    //
    // ⚠ characterID === 0 would ALMOST work and is the trap: a structure and a
    // corp-owned ball also carry characterID 0, so a page built on it labels
    // harmless things as threats and eventually gets ignored.
    row.isNpc = entity.nativeNpc === true;
    // WHICH KIND of NPC, because "not a player" is not the same as "hostile".
    // The runtime's own enum: "npc" (pirates and the like — the thing that
    // shoots a miner), "concord" (law enforcement, which does not), "drifter".
    // Passed through verbatim; the browser owns the player-facing wording, so
    // the word "Pirate" is decided once, where a player can read it, rather
    // than being invented here and again downstream.
    row.npcEntityType =
      typeof entity.npcEntityType === "string" && entity.npcEntityType.length > 0
        ? entity.npcEntityType
        : null;
    // IS THIS SHIP AN ORE-COMPRESSION FACILITY RIGHT NOW?
    //
    // ⚠ THIS IS PARITY, NOT A NEW IDEA. The retail client is already told: the
    // ship's slim item carries `compression_facility_typelists`
    // (space/destiny/index.js) whenever the hull is running an Industrial Core
    // plus a compression module, which is exactly what makes it a facility for
    // `inSpaceCompressionMgr.CompressItemInSpace`. Without it here, a web client
    // could only find a facility by TRYING the call against every ship on grid
    // and reading the silence — and the server answers a refusal and a
    // not-compressible item identically (both null), so it could never say why.
    //
    // `rangeMeters` is the widest range across the live typelists, which is the
    // number the server's own range check uses; the typelist ids ride along so a
    // caller can tell WHICH families a facility handles. Null (field absent) means
    // "not a facility", never "range unknown" — a caller must not read a missing
    // reading as an open door.
    const compressionTypelists = Array.isArray(entity.compressionFacilityTypelists)
      ? entity.compressionFacilityTypelists
      : null;
    if (compressionTypelists && compressionTypelists.length > 0) {
      const ranges = compressionTypelists.map((entry) => spaceNumber(entry && entry[1], 0));
      row.compressionFacility = {
        rangeMeters: Math.max(0, ...ranges) || null,
        typeListIDs: compressionTypelists
          .map((entry) => spaceNumber(entry && entry[0], 0))
          .filter((id) => id > 0),
      };
    } else {
      row.compressionFacility = null;
    }
  }
  // R25 slice A: a drone in space. The generic row above already carries the
  // drone's NAME and its `ownerID` (the character it belongs to); what is
  // missing is which SHIP is flying it and what it is doing right now.
  //
  // `controllerID` is the authority on "is this mine": ownerID says who owns
  // the drone, controllerID says which hull is commanding it, and after a
  // ship swap those are not the same question. Both are projected so the
  // caller can ask either.
  if (entity.kind === "drone") {
    row.controllerID = spaceNumber(entity.controllerID, 0) || null;
    row.controllerOwnerID = spaceNumber(entity.controllerOwnerID, 0) || null;
    // What it is doing, as a word (see droneActivityWord). NULL means "we could
    // not tell", never "idle".
    row.droneActivity = droneActivityWord(entity);
    // The ball it is acting ON, so the page can name the rock or the rat a
    // drone is busy with instead of reporting a bare "mining".
    row.targetEntityID = spaceNumber(entity.targetID, 0) || null;
  }
  // R23 slice B: a rock is a mining target, so the overview needs three fields
  // the generic row above does not carry. `name`/`typeID` already resolve to the
  // ORE (slimName is "Veldspar", slimTypeID is the ore typeID) because the
  // asteroid entity stamps them that way; what is missing is which ore the laser
  // actually yields, which belt the rock belongs to, and HOW MUCH IS LEFT.
  //
  // remainingQuantity lives in the scene's mining runtime state, not on the
  // ball, so it arrives through a lookup the caller supplies. When that lookup
  // is absent, or has no record for this rock, the field stays NULL and the page
  // renders "unknown". A zero here would be a LIE — it reads as a mined-out
  // rock, and would send a player past a full belt.
  if (entity.kind === "asteroid") {
    row.miningYieldTypeID = spaceNumber(entity.miningYieldTypeID, 0) || null;
    row.beltID = spaceNumber(entity.beltID, 0) || null;
    let remaining = null;
    if (typeof mineableStateFor === "function") {
      const state = mineableStateFor(itemID);
      if (state && Number.isFinite(Number(state.remainingQuantity))) {
        remaining = Math.max(0, Math.trunc(Number(state.remainingQuantity)));
      }
    }
    row.remainingQuantity = remaining;
  }
  return row;
}

/**
 * A read-only `itemID -> mineable state` lookup for the scene being projected.
 *
 * This CALLS the mining runtime's own state reader — the same one the survey
 * scanner (`miningScanMgr.perform_scan`) uses — and never reimplements or
 * mutates any of it. If the mining runtime is not present in this process, or
 * the read throws, the lookup answers null for every rock and the projection
 * reports `remainingQuantity: null` (unknown) rather than a made-up number.
 */
function buildMineableStateLookup(scene) {
  if (!scene) {
    return null;
  }
  let miningRuntimeState = null;
  try {
    miningRuntimeState = require(
      path.join(__dirname, "../../services/mining/miningRuntimeState"),
    );
  } catch {
    return null;
  }
  if (!miningRuntimeState || typeof miningRuntimeState.getMineableState !== "function") {
    return null;
  }
  return (itemID) => {
    try {
      return miningRuntimeState.getMineableState(scene, itemID);
    } catch {
      return null;
    }
  };
}

/**
 * The active ship's HUD numbers: max shield/armor/hull capacities from the
 * combat helper (`getEntityMaxHealthLayers`, the dogma-backed capacities) paired
 * with the live remaining fractions on the ship's condition state, plus the
 * capacitor charge ratio. This is the retail split — the HUD reads the ship
 * item, not the ballpark.
 */
function projectActiveShipStatus(entity) {
  if (!entity || typeof entity !== "object") {
    return null;
  }
  let maxLayers = null;
  try {
    const damage = require(path.join(__dirname, "../../space/combat/damage"));
    if (damage && typeof damage.getEntityMaxHealthLayers === "function") {
      maxLayers = damage.getEntityMaxHealthLayers(entity);
    }
  } catch {
    // No capacities available: the ratios below are still the real HUD bars.
  }
  const health = spaceHealthRatios(entity);
  return {
    itemID: spaceNumber(entity.itemID, 0) || null,
    typeID: spaceNumber(entity.slimTypeID, spaceNumber(entity.typeID, 0)) || null,
    name: String(entity.slimName || entity.itemName || "") || null,
    mode: typeof entity.mode === "string" ? entity.mode : null,
    maxVelocity: spaceNumber(entity.maxVelocity, 0) || null,
    // R13: the ship's own hull radius, so the browser can compute the SURFACE
    // distance the server measures with — max(0, centre-to-centre - rA - rB),
    // the same formula as services/drone/droneRuntime.js. Without the ego
    // radius the browser can only measure centre-to-centre and would decide
    // jump/dock/approach at slightly the wrong ranges.
    radius: spaceNumber(entity.radius, 0),
    position: spaceVector(entity.position),
    velocity: spaceVector(entity.velocity),
    shieldRatio: health.shield,
    armorRatio: health.armor,
    hullRatio: health.hull,
    capacitorRatio: spaceRatio(entity.capacitorChargeRatio),
    shieldCapacity: maxLayers ? spaceNumber(maxLayers.shield, 0) : null,
    armorCapacity: maxLayers ? spaceNumber(maxLayers.armor, 0) : null,
    hullCapacity: maxLayers ? spaceNumber(maxLayers.structure, 0) : null,
    // R23: which fitted modules are CYCLING right now, straight off the ship
    // entity's own active-effect map. This is the server's truth, not the
    // browser's memory of what it clicked — without it the page could only show
    // "you pressed the button", which would keep claiming a laser is running
    // after the server short-cycled it (target lost, hold full, out of range).
    // Empty list = nothing running; the field is never absent while in space.
    activeModuleIDs:
      entity.activeModuleEffects instanceof Map
        ? [...entity.activeModuleEffects.keys()]
            .map((moduleID) => spaceNumber(moduleID, 0))
            .filter((moduleID) => moduleID > 0)
            .sort((left, right) => left - right)
        : [],
  };
}

// R4 deferred call responses. Some handlers (agentMgr.Handle_DoAction on a
// decline) do not return a value; they return buildDeferredCallResponse(startFn)
// and let the packet dispatcher drive completion by calling startFn with the
// live dispatcher + packet, so the handler can send its own call/error
// response(s) — often only after a client round-trip (the
// OnAgentProvisionalResponse YesNo confirmation). The synchronous browser
// bridge has no packet or dispatcher, so it supplies an ADAPTER dispatcher that
// captures whatever response(s) the handler emits and drives the deferred to
// completion in-process. The browser-backed session has no
// sendClientCallRequest, so a decline degrades to the handler's own
// no-client-available fallback (a direct decline) and completes synchronously.
// If a deferred flow emits only an interim provisional placeholder and no final
// response (it is genuinely still waiting on a client round-trip the bridge
// cannot service), the caller refuses it with CALL_DEFERRED_UNSUPPORTED rather
// than returning the broken deferred wrapper as a result.
async function driveDeferredCallResponse(deferred, context) {
  const captured = [];
  const adapterDispatcher = {
    serviceManager: context.serviceManager,
    _sendCallResponse(
      _packet,
      result,
      _session,
      _responseServiceName,
      _responsePerfMeta,
      responseOptions = {},
    ) {
      captured.push({
        kind: "call",
        result,
        responseOptions: isPlainObject(responseOptions) ? responseOptions : {},
      });
    },
    _sendErrorResponse(_packet, machoError) {
      captured.push({ kind: "error", machoError });
    },
  };
  const adapterPacket = {
    source: { callID: 0 },
    dest: {},
    oob: null,
    userID: (context.session && context.session.userid) || null,
  };
  if (typeof deferred.start === "function") {
    await Promise.resolve(
      deferred.start({
        dispatcher: adapterDispatcher,
        packet: adapterPacket,
        session: context.session,
        service: context.serviceInstance,
        call: context.call,
        responseServiceName: context.serviceName,
        responsePerfMeta: null,
      }),
    );
  }
  return captured;
}

// An emitted response carrying a "provisional" named-payload entry is the
// interim OnAgentProvisionalResponse placeholder retail sends before the client
// round-trip resolves — not the final result.
function isProvisionalDeferredResponse(entry) {
  const namedPayloadEntries =
    entry &&
    entry.responseOptions &&
    Array.isArray(entry.responseOptions.namedPayloadEntries)
      ? entry.responseOptions.namedPayloadEntries
      : [];
  return namedPayloadEntries.some(
    (pair) => Array.isArray(pair) && String(pair[0]) === "provisional",
  );
}

// The real result of a driven deferred call is the LAST non-provisional call
// response the handler emitted. If it emitted only a provisional (or nothing),
// the flow is still waiting on a client round-trip the synchronous bridge
// cannot service -> typed CALL_DEFERRED_UNSUPPORTED refusal (never a broken
// deferred wrapper).
function resolveDeferredCallResult(captured, serviceName, method) {
  const finalResponses = captured.filter(
    (entry) => entry.kind === "call" && !isProvisionalDeferredResponse(entry),
  );
  if (finalResponses.length > 0) {
    return finalResponses[finalResponses.length - 1].result;
  }
  throw webCallError(
    "CALL_DEFERRED_UNSUPPORTED",
    `${serviceName}.${method} returned a deferred response that requires a ` +
      "client round-trip the browser bridge cannot service.",
  );
}

// Faithful retail afterCallResponse (network/packetDispatcher.js): after a
// successful, NON-deferred dispatch the dispatcher invokes
// service.afterCallResponse so a service can run post-response side effects
// (invbroker's docked-fitting bootstrap + deferred session-change flush, ship's
// safe-logoff completion). The browser bridge previously skipped this; mirror
// it here in a try/catch so a post-response side effect can never turn a good
// call into a failure. Ordering matches retail's "after the response is
// composed": any notifications afterCallResponse queues on a persistent session
// land in the next drain, not this response.
async function invokeAfterCallResponse(serviceInstance, call, session, result) {
  if (
    !serviceInstance ||
    typeof serviceInstance.afterCallResponse !== "function"
  ) {
    return;
  }
  try {
    await Promise.resolve(
      serviceInstance.afterCallResponse(call.method, session, {
        args: call.args,
        kwargs: call.kwargs,
        result,
      }),
    );
  } catch (error) {
    log.warn(
      `[EvejsWebGateway] afterCallResponse failed for ` +
        `${call.service}.${call.method}: ${error && error.message}`,
    );
  }
}

function normalizePiRestartCommandPayload(payload) {
  if (!hasExactKeys(payload, ["planetID"])) {
    throw new TypeError("invalid PI restart command payload");
  }
  const planetID = payload.planetID;
  if (
    typeof planetID !== "number" ||
    !Number.isSafeInteger(planetID) ||
    planetID < 0
  ) {
    throw new TypeError("invalid PI restart command payload");
  }
  return { planetID };
}

function readWrappedUserErrorCode(error) {
  const payload = error && error.machoErrorResponse &&
    error.machoErrorResponse.payload;
  const header = payload && Array.isArray(payload.header)
    ? payload.header
    : [];
  const className = String(header[0] && header[0].value || "");
  const args = Array.isArray(header[1]) ? header[1] : [];
  const code = typeof args[0] === "string" ? args[0] : "";
  return className === "eveexceptions.UserError" &&
    PUBLIC_SKILL_QUEUE_ERROR_CODES.has(code)
    ? code
    : "";
}

function mapSkillQueuePublicError(error) {
  const code = readWrappedUserErrorCode(error);
  return code
    ? {
        code,
        message: `Skill queue command was rejected: ${code}.`,
        statusCode: 400,
      }
    : null;
}

function mapPiRestartPublicError(error) {
  const code = String(error && (error.code || error.message) || "");
  return PUBLIC_PI_RESTART_ERROR_CODES.has(code)
    ? {
        code,
        message: `PI extractor restart command was rejected: ${code}.`,
        statusCode: 400,
      }
    : null;
}

function requireSuccessfulFlush(result, label) {
  if (!result || result.success !== true) {
    log.error(`[EvejsWebGateway] ${label} durable flush failed`);
    throw new Error(`${label} durable flush failed`);
  }
}

function readRootTable(table) {
  const result = gameStore.read(table, "/");
  return result.success && result.data && typeof result.data === "object"
    ? result.data
    : {};
}

function readTableEntry(table, key) {
  const result = gameStore.read(table, `/${key}`);
  return result.success ? result.data : null;
}

function normalizeAccountRecord(username, record) {
  if (!record || typeof record !== "object") {
    return null;
  }
  const accountID = Number(record.id || record.accountID || 0);
  if (accountID <= 0) {
    return null;
  }
  return {
    username: String(username || record.username || ""),
    accountID,
    role: String(record.role || "0"),
    chatRole: String(record.chatRole || record.role || "0"),
    banned: record.banned === true,
  };
}

function listAccounts() {
  return Object.entries(readRootTable("accounts"))
    .map(([username, record]) => normalizeAccountRecord(username, record))
    .filter(Boolean)
    .sort((left, right) => left.username.localeCompare(right.username));
}

function getAccountByUsername(username) {
  const normalizedUsername = String(username || "").trim();
  return normalizedUsername
    ? normalizeAccountRecord(
      normalizedUsername,
      readTableEntry("accounts", normalizedUsername),
    )
    : null;
}

function getAccountByID(accountID) {
  const numericAccountID = Number(accountID);
  return numericAccountID > 0
    ? listAccounts().find((account) => account.accountID === numericAccountID) || null
    : null;
}

function normalizeCharacterRecord(characterID, record) {
  if (!record || typeof record !== "object") {
    return null;
  }
  const numericCharacterID = Number(
    characterID || record.characterID || record.charID || 0,
  );
  const accountID = Number(record.accountId || record.accountID || record.userid || 0);
  if (numericCharacterID <= 0 || accountID <= 0) {
    return null;
  }
  return {
    key: String(numericCharacterID),
    value: {
      ...cloneValue(record),
      characterID: numericCharacterID,
    },
    accountID,
    characterID: numericCharacterID,
    characterName: String(
      record.characterName || `Character ${numericCharacterID}`,
    ),
  };
}

function getCharacter(characterID) {
  const numericCharacterID = Number(characterID);
  return numericCharacterID > 0
    ? normalizeCharacterRecord(
      numericCharacterID,
      readTableEntry("characters", numericCharacterID),
    )
    : null;
}

function listCharacters(accountID) {
  const numericAccountID = Number(accountID);
  if (numericAccountID <= 0) {
    return [];
  }
  return Object.entries(readRootTable("characters"))
    .map(([characterID, record]) => normalizeCharacterRecord(characterID, record))
    .filter((entry) => entry && entry.accountID === numericAccountID)
    .sort((left, right) => left.characterName.localeCompare(right.characterName))
    .map((entry) => entry.value);
}

function getNumericID(record, keys) {
  for (const key of keys) {
    const value = Number(record && record[key]);
    if (value > 0) {
      return value;
    }
  }
  return 0;
}

function listItemsForCharacter(characterID) {
  const allItems = Object.values(readRootTable("items"))
    .filter((record) => record && typeof record === "object");
  const byItemID = new Map();
  for (const item of allItems) {
    const itemID = getNumericID(item, ["itemID", "shipID"]);
    if (itemID > 0) {
      byItemID.set(itemID, item);
    }
  }
  const selected = new Map();
  for (const item of allItems) {
    if (getNumericID(item, ["ownerID", "ownerid"]) === characterID) {
      const itemID = getNumericID(item, ["itemID", "shipID"]);
      if (itemID > 0) {
        selected.set(itemID, item);
      }
    }
  }
  const queue = [...selected.values()];
  for (let index = 0; index < queue.length && selected.size < SNAPSHOT_ITEM_LIMIT; index += 1) {
    const parent = byItemID.get(
      getNumericID(queue[index], ["locationID", "locationid"]),
    );
    const parentID = getNumericID(parent, ["itemID", "shipID"]);
    if (parentID > 0 && !selected.has(parentID)) {
      selected.set(parentID, parent);
      queue.push(parent);
    }
  }
  return Object.fromEntries(
    [...selected.entries()].map(([itemID, item]) => [String(itemID), cloneValue(item)]),
  );
}

function buildIndustryJobsForCharacter(characterID) {
  const state = readRootTable("industryJobs");
  const jobs = state.jobs && typeof state.jobs === "object" ? state.jobs : state;
  return {
    jobs: Object.fromEntries(
      Object.entries(jobs || {})
        .filter(([, job]) => (
          Number(job && job.ownerID) === characterID ||
          Number(job && job.installerID) === characterID
        ))
        .map(([jobID, job]) => [jobID, cloneValue(job)]),
    ),
  };
}

function buildPlanetRuntimeForCharacter(characterID) {
  const state = readRootTable("planetRuntimeState");
  const coloniesByKey = {};
  const launchesByID = {};
  const resourcesByPlanetID = {};
  for (const [key, colony] of Object.entries(state.coloniesByKey || {})) {
    if (Number(colony && colony.ownerID) !== characterID) {
      continue;
    }
    coloniesByKey[key] = cloneValue(colony);
    const planetID = Number(colony && colony.planetID) || 0;
    if (planetID > 0 && state.resourcesByPlanetID && state.resourcesByPlanetID[String(planetID)]) {
      resourcesByPlanetID[String(planetID)] = cloneValue(
        state.resourcesByPlanetID[String(planetID)],
      );
    }
  }
  for (const [launchID, launch] of Object.entries(state.launchesByID || {})) {
    if (Number(launch && launch.ownerID) === characterID) {
      launchesByID[launchID] = cloneValue(launch);
    }
  }
  return {
    schemaVersion: Number(state.schemaVersion || 1),
    resourcesByPlanetID,
    coloniesByKey,
    launchesByID,
    acceptedNetworkEditsByKey: {},
    nextIDs: cloneValue(state.nextIDs || {}),
  };
}

function sanitizeQueueEntry(entry) {
  return {
    queuePosition: Number(entry && entry.queuePosition) || 0,
    trainingTypeID: Number(entry && entry.trainingTypeID) || 0,
    trainingToLevel: Number(entry && entry.trainingToLevel) || 0,
    trainingStartSP: Number(entry && entry.trainingStartSP) || 0,
    trainingDestinationSP: Number(entry && entry.trainingDestinationSP) || 0,
    trainingStartTime: entry && entry.trainingStartTime
      ? String(entry.trainingStartTime)
      : null,
    trainingEndTime: entry && entry.trainingEndTime
      ? String(entry.trainingEndTime)
      : null,
    skillPointsPerMinute: Number(entry && entry.skillPointsPerMinute) || 0,
  };
}

function sanitizeQueueSnapshot(snapshot) {
  return {
    characterID: Number(snapshot && snapshot.characterID) || 0,
    accountID: Number(snapshot && snapshot.accountID) || 0,
    active: Boolean(snapshot && snapshot.active),
    queueEntries: Array.isArray(snapshot && snapshot.queueEntries)
      ? snapshot.queueEntries.map(sanitizeQueueEntry)
      : [],
    queueEndTime: snapshot && snapshot.queueEndTime
      ? String(snapshot.queueEndTime)
      : null,
    currentEntry: snapshot && snapshot.currentEntry
      ? sanitizeQueueEntry(snapshot.currentEntry)
      : null,
    freeSkillPoints: Math.max(0, Number(snapshot && snapshot.freeSkillPoints) || 0),
  };
}

// --- R28: the skill sheet ---------------------------------------------------
//
// A purpose-built read for the browser's Skills panel, in the same spirit as
// /space/snapshot and /market/station-asks: the authority the client needs,
// already resolved, so the browser is never handed a marshaled Rowset to decode
// or — far worse — a formula to re-implement.
//
// EVERY NUMBER HERE IS THE SERVER'S. Level thresholds come from
// skillTrainingMath.getSkillPointsForLevel (CALLED, never copied: the classic
// round(rank * 250 * sqrt(32)^(level-1)) curve lives in exactly one place and
// this is not it). Current SP comes from getQueueSnapshot's `projectedSkills`,
// which already overlays the live progress of whatever is training, so the
// skill in training reports the SP it has THIS INSTANT rather than the SP it
// had when training began. Queue times come from the queue itself.
//
// TIME IS CONVERTED, NOT INVENTED. Every instant leaves here as epoch
// milliseconds converted from the server's own Win32 FILETIME, and `serverNowMs`
// is that same clock sampled in the same read. A client can therefore measure
// its own offset from the server once per read and interpolate a countdown
// between reads without ever guessing what "now" means on this machine.
const FILETIME_EPOCH_TICKS = 116444736000000000n;
const SKILL_SHEET_MAX_LEVEL = 5;

function fileTimeToEpochMs(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  let ticks;
  try {
    ticks = typeof value === "bigint" ? value : BigInt(String(value));
  } catch {
    return null;
  }
  if (ticks <= 0n) {
    return null;
  }
  return Number((ticks - FILETIME_EPOCH_TICKS) / 10000n);
}

function skillSheetQueueEntry(entry, rate) {
  return {
    queuePosition: Number(entry && entry.queuePosition) || 0,
    typeID: Number(entry && entry.trainingTypeID) || 0,
    toLevel: Number(entry && entry.trainingToLevel) || 0,
    startSP: Number(entry && entry.trainingStartSP) || 0,
    destinationSP: Number(entry && entry.trainingDestinationSP) || 0,
    startTimeMs: fileTimeToEpochMs(entry && entry.trainingStartTime),
    endTimeMs: fileTimeToEpochMs(entry && entry.trainingEndTime),
    // Only the CURRENT entry carries a rate on the runtime snapshot; a later
    // entry reports 0 rather than a rate borrowed from the head of the queue,
    // because its attributes-at-the-time are not knowable now.
    skillPointsPerMinute: Number(rate) || 0,
  };
}

function buildSkillSheet(accountID, characterID) {
  const account = getAccountByID(accountID);
  const character = getCharacter(characterID);
  if (!account || !character || character.accountID !== account.accountID) {
    return null;
  }
  const numericCharacterID = character.characterID;
  const skillsTable = readTableEntry("skills", numericCharacterID) || {};

  let queue = null;
  let queueWarning = null;
  let projectedByTypeID = new Map();
  try {
    const snapshot = skillQueueRuntime.getQueueSnapshot(numericCharacterID);
    const currentRate = snapshot && snapshot.currentEntry
      ? Number(snapshot.currentEntry.skillPointsPerMinute) || 0
      : 0;
    const entries = Array.isArray(snapshot && snapshot.queueEntries)
      ? snapshot.queueEntries
      : [];
    queue = {
      active: Boolean(snapshot && snapshot.active),
      entries: entries.map((entry, index) =>
        skillSheetQueueEntry(entry, index === 0 ? currentRate : 0),
      ),
      endTimeMs: fileTimeToEpochMs(snapshot && snapshot.queueEndTime),
      maxEntries: Number(skillQueueRuntime.SKILLQUEUE_MAX_NUM_SKILLS) || 0,
    };
    projectedByTypeID = new Map(
      (Array.isArray(snapshot && snapshot.projectedSkills) ? snapshot.projectedSkills : [])
        .map((record) => [Number(record && record.typeID) || 0, record]),
    );
  } catch (error) {
    queueWarning = error && error.message ? error.message : "skill queue unavailable";
  }

  const skills = [];
  for (const [key, record] of Object.entries(skillsTable)) {
    const typeID = Number(record && record.typeID) || Number(key) || 0;
    if (typeID <= 0) {
      continue;
    }
    const projected = projectedByTypeID.get(typeID) || null;
    const rank = skillTrainingMath.normalizeSkillRank(
      record && record.skillRank,
    );
    const levelSkillPoints = [];
    for (let level = 1; level <= SKILL_SHEET_MAX_LEVEL; level += 1) {
      levelSkillPoints.push(
        Number(skillTrainingMath.getSkillPointsForLevel(rank, level)) || 0,
      );
    }
    skills.push({
      typeID,
      name: String((record && record.itemName) || ""),
      groupName: String((record && record.groupName) || ""),
      // The TRAINED level is what the player has; a partially-trained level is
      // reported by skillPoints sitting between two thresholds, never by
      // rounding the level up.
      level: Number(
        (projected && projected.trainedSkillLevel) ?? (record && record.trainedSkillLevel) ?? 0,
      ) || 0,
      rank,
      skillPoints: Number(
        (projected && projected.skillPoints) ?? (record && record.skillPoints) ?? 0,
      ) || 0,
      levelSkillPoints,
      inTraining: Boolean(projected && projected.inTraining),
    });
  }
  skills.sort((left, right) => left.name.localeCompare(right.name));

  return {
    characterID: numericCharacterID,
    characterName: String(character.value.characterName || ""),
    totalSkillPoints: Math.max(0, Number(character.value.skillPoints) || 0),
    freeSkillPoints: Math.max(0, Number(character.value.freeSkillPoints) || 0),
    serverNowMs: fileTimeToEpochMs(skillTrainingMath.getNowFileTime()),
    skills,
    queue,
    queueWarning,
  };
}

function sanitizeCharacterControlSnapshot(snapshot, characterID = 0, stateVersion = "") {
  const normalizedState = String(snapshot && snapshot.controlState || "");
  const normalizedStateVersion = typeof stateVersion === "string"
    ? stateVersion
    : "";
  if (
    !["offline", "retail_client", "browser_pilot"].includes(normalizedState) ||
    !normalizedStateVersion ||
    normalizedStateVersion.length > 512
  ) {
    const error = new Error("Authoritative character control is unavailable.");
    error.name = "CharacterControlError";
    error.code = "CHARACTER_CONTROL_UNAVAILABLE";
    error.statusCode = 503;
    throw error;
  }
  const controlState = normalizedState;
  const transport = controlState === "retail_client"
    ? "tcp"
    : controlState === "browser_pilot"
      ? "web"
      : null;
  return {
    characterID: Number(snapshot && snapshot.characterID) || Number(characterID) || 0,
    online: controlState !== "offline",
    controlState,
    transport,
    leaseExpiresAt:
      controlState === "browser_pilot" && snapshot && snapshot.leaseExpiresAt
        ? String(snapshot.leaseExpiresAt)
        : null,
    stateVersion: normalizedStateVersion,
  };
}

function buildSnapshot(accountID, characterID, stateVersion) {
  const account = getAccountByID(accountID);
  const character = getCharacter(characterID);
  if (!account || !character || character.accountID !== account.accountID) {
    return null;
  }
  let queueSnapshot = null;
  let queueSnapshotWarning = null;
  try {
    queueSnapshot = sanitizeQueueSnapshot(
      skillQueueRuntime.getQueueSnapshot(character.characterID),
    );
  } catch (error) {
    queueSnapshotWarning = error && error.message
      ? error.message
      : "skill queue unavailable";
  }
  return {
    source: "evejs-web-gateway",
    apiVersion: 1,
    stateVersion,
    account,
    accounts: { [account.username]: account },
    characters: { [String(character.characterID)]: cloneValue(character.value) },
    skills: {
      [String(character.characterID)]: cloneValue(
        readTableEntry("skills", character.characterID) || {},
      ),
    },
    skillQueues: {
      [String(character.characterID)]: cloneValue(
        readTableEntry("skillQueues", character.characterID) || {},
      ),
    },
    queueSnapshot,
    queueSnapshotWarning,
    items: listItemsForCharacter(character.characterID),
    industryJobs: buildIndustryJobsForCharacter(character.characterID),
    planetRuntimeState: buildPlanetRuntimeForCharacter(character.characterID),
  };
}

function getDefaultCharacterRuntimes() {
  if (defaultCharacterRuntimes) {
    return defaultCharacterRuntimes;
  }
  let characterEvents = null;
  const characterCommands = createCharacterCommandRuntime({
    controlRuntime: characterControlRuntime,
    isCommandIDRetained(characterID, commandID) {
      return Boolean(
        characterEvents &&
        characterEvents.hasRetainedCommandID(characterID, commandID)
      );
    },
    onReceiptCached(settlement) {
      if (characterEvents) {
        characterEvents.publishCommandSettlement(settlement);
      }
    },
    commandDefinitions: {
      [CHARACTER_COMMAND_TYPES.SAVE_SKILL_QUEUE]: {
        authorizationPolicy: AUTHORIZATION_POLICIES.OFFLINE_COMPANION,
        normalizePayload: normalizeSkillQueueCommandPayload,
        mapPublicError: mapSkillQueuePublicError,
        handler({ characterID, payload }) {
          const snapshot = skillQueueRuntime.saveQueue(
            characterID,
            payload.entries,
            {
              activate: payload.activate,
              emitNotifications: true,
            },
          );
          requireSuccessfulFlush(
            gameStore.flushTablesSync(["skillQueues", "skills", "characters"]),
            "skill queue",
          );
          const sanitized = sanitizeQueueSnapshot(snapshot);
          log.info(
            `[EvejsWebGateway] skill queue saved characterID=${characterID} ` +
              `entries=${payload.entries.length} active=${sanitized.active}`,
          );
          return sanitized;
        },
      },
      [CHARACTER_COMMAND_TYPES.RESTART_PI_EXTRACTORS]: {
        authorizationPolicy: AUTHORIZATION_POLICIES.OFFLINE_COMPANION,
        normalizePayload: normalizePiRestartCommandPayload,
        mapPublicError: mapPiRestartPublicError,
        handler({ characterID, payload }) {
          const summary = planetRuntime.restartExtractorsForCharacter(characterID, {
            planetID: payload.planetID,
          });
          requireSuccessfulFlush(
            gameStore.flushTablesSync(["planetRuntimeState"]),
            "PI extractor restart",
          );
          log.info(
            `[EvejsWebGateway] PI extractors restarted characterID=${characterID} ` +
              `colonies=${summary.colonyCount} restarted=${summary.restartedCount}`,
          );
          return summary;
        },
      },
    },
  });
  characterEvents = createCharacterEventRuntime({
    controlRuntime: characterControlRuntime,
    getStateVersion: characterCommands.getStateVersion,
  });
  defaultCharacterRuntimes = Object.freeze({
    characterCommands,
    characterEvents,
  });
  return defaultCharacterRuntimes;
}

function createEvejsWebGatewayRuntime({
  serviceManager,
  characterCommandRuntime,
  characterEventRuntime,
  browserSessionIdleTtlMs,
  browserSessionSweepIntervalMs,
  sessionEventRuntime,
  now,
} = {}) {
  if (Boolean(characterCommandRuntime) !== Boolean(characterEventRuntime)) {
    throw new TypeError(
      "custom gateway command and event runtimes must be supplied together",
    );
  }
  const defaults = characterCommandRuntime
    ? null
    : getDefaultCharacterRuntimes();
  const usesDefaultRuntimes = Boolean(defaults);
  const characterCommands = characterCommandRuntime || defaults.characterCommands;
  const characterEvents = characterEventRuntime || defaults.characterEvents;
  const dependencies = Object.freeze({
    serviceManager: Boolean(serviceManager && typeof serviceManager.lookup === "function"),
    gameStore: Boolean(
      gameStore &&
      typeof gameStore.read === "function" &&
      typeof gameStore.flushTablesSync === "function"
    ),
    skillQueue: Boolean(
      typeof skillQueueRuntime.getQueueSnapshot === "function" &&
      typeof skillQueueRuntime.normalizeQueueInput === "function" &&
      typeof skillQueueRuntime.saveQueue === "function"
    ),
    // R28: the skill SHEET needs the SP curve and the server clock on top of
    // the queue runtime. Reported separately so a client can tell "no queue
    // runtime" from "no training maths" instead of guessing.
    skillSheet: Boolean(
      typeof skillTrainingMath.getSkillPointsForLevel === "function" &&
      typeof skillTrainingMath.normalizeSkillRank === "function" &&
      typeof skillTrainingMath.getNowFileTime === "function"
    ),
    planetaryInteraction: typeof planetRuntime.restartExtractorsForCharacter === "function",
    onlinePresence: typeof onlineRuntime.isCharacterOnline === "function",
    characterControl: Boolean(
      characterControlRuntime &&
      typeof characterControlRuntime.getCharacterControlSnapshot === "function" &&
      typeof characterControlRuntime.claimBrowserControl === "function" &&
      typeof characterControlRuntime.renewBrowserControl === "function" &&
      typeof characterControlRuntime.releaseBrowserControl === "function" &&
      characterCommands &&
      typeof characterCommands.getStateVersion === "function" &&
      typeof characterCommands.submitCommand === "function" &&
      typeof characterCommands.shutdown === "function"
    ),
    characterEvents: Boolean(
      characterEvents &&
      typeof characterEvents.subscribe === "function" &&
      typeof characterEvents.hasRetainedCommandID === "function" &&
      typeof characterEvents.getDiagnostics === "function" &&
      typeof characterEvents.shutdown === "function"
    ),
    market: Boolean(
      marketDaemonClient &&
      typeof marketDaemonClient.startupCheck === "function" &&
      typeof marketDaemonClient.call === "function"
    ),
  });
  if (!Object.values(dependencies).every(Boolean)) {
    throw new TypeError("gateway runtime requires all authoritative dependencies");
  }

  let stopped = false;

  // --- Persistent browser-backed session store (web-client goal R2) --------
  // Keyed by an opaque gateway-minted bridgeSessionID; each entry maps to a
  // live registered session object plus its accumulating notification
  // backlog. The store lives only in this runtime's process memory.
  const browserSessions = new Map();
  const idleTtlMs =
    Number.isSafeInteger(browserSessionIdleTtlMs) && browserSessionIdleTtlMs > 0
      ? browserSessionIdleTtlMs
      : DEFAULT_BROWSER_SESSION_IDLE_TTL_MS;
  const sweepIntervalMs =
    Number.isSafeInteger(browserSessionSweepIntervalMs) &&
    browserSessionSweepIntervalMs > 0
      ? browserSessionSweepIntervalMs
      : DEFAULT_BROWSER_SESSION_SWEEP_INTERVAL_MS;
  const nowMs = typeof now === "function" ? now : Date.now;
  let browserSessionClientIDCounter = 0;
  let sweepHandle = null;

  // --- Bridge-session push stream (goal R10 / roadmap G6) ------------------
  // One epoch/sequence stream per bridgeSessionID carrying the notifications
  // the capture stubs record and the chat messages the chat emitters publish.
  // ADDITIVE ONLY: every `notifications.splice(0)` drain below is untouched, so
  // a browser with no push connection behaves exactly as before and a reconnect
  // gap can never lose data the next response would have carried.
  const sessionEvents = sessionEventRuntime || createSessionEventRuntime();

  // Chat is the one server->browser signal that bypasses session capture
  // entirely (it never reaches sendServiceNotification), which is why the Chat
  // panel had to poll. chatRuntime's module-level `channel-message` fires on
  // every backlog append — Local via broadcastLocalMessage and Corp via the
  // session-derived corp broadcast — so one read-only subscription here feeds
  // both channels. Nothing in chat mechanics is modified.
  function roomNamesForEntry(entry) {
    const session = entry.session;
    let localRoomName = "";
    try {
      localRoomName = String(getLocalChatRoomNameForSession(session) || "");
    } catch {
      // A session mid-transition has no derivable local room; corp still works.
    }
    const corporationID = Number(session.corporationID || session.corpid || 0) || 0;
    return {
      localRoomName,
      corpRoomName: corporationID > 0 ? `corp_${corporationID}` : "",
    };
  }

  function onChatChannelMessage(payload) {
    if (stopped || !payload || typeof payload !== "object") {
      return;
    }
    const roomName = String(payload.roomName || "");
    const entryValue = payload.entry;
    if (!roomName || !entryValue || typeof entryValue !== "object") {
      return;
    }
    for (const entry of browserSessions.values()) {
      const { localRoomName, corpRoomName } = roomNamesForEntry(entry);
      const channel = roomName === localRoomName
        ? "local"
        : roomName === corpRoomName
          ? "corp"
          : "";
      if (!channel) {
        continue;
      }
      sessionEvents.publish(entry.bridgeSessionID, {
        kind: "chat",
        channel,
        roomName,
        // The same backlog-entry shape the chat READ path returns, so the
        // browser decodes a pushed message with the identical decoder.
        entry: encodeJsonSafeCallValue(entryValue),
      });
    }
  }

  chatRuntime.on("channel-message", onChatChannelMessage);

  function stopBrowserSessionSweep() {
    if (sweepHandle !== null) {
      clearInterval(sweepHandle);
      sweepHandle = null;
    }
  }

  function startBrowserSessionSweep() {
    if (sweepHandle !== null || stopped || browserSessions.size === 0) {
      return;
    }
    sweepHandle = setInterval(expireIdleBrowserSessions, sweepIntervalMs);
    if (sweepHandle && typeof sweepHandle.unref === "function") {
      sweepHandle.unref();
    }
  }

  // A session evicted by EveJS's own mechanics (retail login takeover runs
  // evictPriorSession -> disconnectCharacterSession on it) is already offline;
  // the store entry just needs to be dropped.
  function isDefunctBrowserSession(entry) {
    return (
      entry.session._characterControlDisconnected === true ||
      Boolean(entry.session.socket && entry.session.socket.destroyed === true)
    );
  }

  // End a persistent session the same way a retail socket close ends one:
  // services/_shared/sessionDisconnect runs the canonical logoff persistence,
  // guest-list departure, space/trade/chat cleanup, and character-control
  // release. Calling the existing mechanic is bridge glue; nothing here
  // reimplements it.
  function teardownBrowserSession(entry, lifecycleReason) {
    browserSessions.delete(entry.bridgeSessionID);
    // Close the push stream with the session: a subscriber still attached is
    // told the session ended rather than being left on a stream that can never
    // produce another frame.
    try {
      sessionEvents.dropStream(entry.bridgeSessionID, lifecycleReason);
    } catch {
      // Stream teardown must never block the authoritative disconnect path.
    }
    const session = entry.session;
    const characterID = Number(session.characterID || session.charid || 0) || 0;
    try {
      if (characterID > 0 && session._characterControlDisconnected !== true) {
        // Lazy require mirrors charService's evictPriorSession pattern and
        // keeps this module's load graph unchanged for proxy-only processes.
        const { disconnectCharacterSession } = require(path.join(
          __dirname,
          "../../services/_shared/sessionDisconnect",
        ));
        disconnectCharacterSession(session, {
          broadcast: true,
          clearSession: true,
          lifecycleReason,
        });
        log.info(
          `[EvejsWebGateway] Browser session ended characterID=${characterID} ` +
            `reason=${lifecycleReason}`,
        );
      }
    } finally {
      // Release the bound-object OIDs this session held from the shared
      // service-manager registry (retail does this via the client's
      // ClientHasReleasedTheseObjects on disconnect). Nothing else references
      // them once the session is gone.
      if (entry.boundHandles instanceof Map) {
        for (const handleEntry of entry.boundHandles.values()) {
          const oids = Array.isArray(handleEntry.oids)
            ? handleEntry.oids
            : [handleEntry.oid];
          for (const oid of oids) {
            try {
              if (typeof serviceManager.unregisterBoundObject === "function") {
                serviceManager.unregisterBoundObject(oid, { session });
              }
            } catch {
              // Best-effort release; teardown must complete for every handle.
            }
          }
        }
        entry.boundHandles.clear();
      }
      sessionRegistry.unregister(session);
      if (session.socket && typeof session.socket.destroy === "function") {
        session.socket.destroy();
      } else if (session.socket) {
        session.socket.destroyed = true;
      }
      if (browserSessions.size === 0) {
        stopBrowserSessionSweep();
      }
    }
    return characterID;
  }

  function expireIdleBrowserSessions() {
    const cutoffMs = nowMs() - idleTtlMs;
    let reaped = 0;
    for (const entry of [...browserSessions.values()]) {
      if (isDefunctBrowserSession(entry)) {
        teardownBrowserSession(entry, "browser_session_defunct");
        reaped += 1;
      } else if (entry.lastUsedAtMs <= cutoffMs) {
        teardownBrowserSession(entry, "browser_session_expired");
        reaped += 1;
      }
    }
    return reaped;
  }

  // Resolve a bridgeSessionID to its live entry. Expired or externally-evicted
  // entries are torn down on access and reported as SESSION_NOT_FOUND, as is a
  // userid that does not match the entry (opaque on purpose).
  function getBrowserSessionEntry(bridgeSessionID, userid) {
    const entry = browserSessions.get(bridgeSessionID);
    if (!entry) {
      throw webCallError(
        "SESSION_NOT_FOUND",
        "Unknown, expired, or released bridge session.",
      );
    }
    if (isDefunctBrowserSession(entry)) {
      teardownBrowserSession(entry, "browser_session_defunct");
      throw webCallError(
        "SESSION_NOT_FOUND",
        "Unknown, expired, or released bridge session.",
      );
    }
    if (nowMs() - entry.lastUsedAtMs > idleTtlMs) {
      teardownBrowserSession(entry, "browser_session_expired");
      throw webCallError(
        "SESSION_NOT_FOUND",
        "Unknown, expired, or released bridge session.",
      );
    }
    if (userid !== undefined && Number(userid) !== entry.userid) {
      throw webCallError(
        "SESSION_NOT_FOUND",
        "Unknown, expired, or released bridge session.",
      );
    }
    return entry;
  }

  function normalizeBridgeSessionID(value) {
    if (typeof value !== "string" || !value.trim()) {
      throw webCallError(
        "CALL_INVALID",
        "bridgeSessionID must be a non-empty string.",
      );
    }
    return value.trim();
  }

  function normalizeBoundHandle(value) {
    if (typeof value !== "string" || !value.trim()) {
      throw webCallError(
        "CALL_INVALID",
        "boundHandle must be a non-empty string.",
      );
    }
    return value.trim();
  }

  function discardMintedSession(session) {
    sessionRegistry.unregister(session);
    if (session.socket) {
      session.socket.destroyed = true;
    }
  }

  return Object.freeze({
    dependencies,
    getStatus() {
      const accounts = listAccounts();
      return {
        hasAccounts: true,
        hasCharacters: true,
        hasSkills: true,
        accountCount: accounts.length,
        characterCount: Object.keys(readRootTable("characters")).length,
      };
    },
    listAccounts,
    getAccountByUsername,
    getAccountByID,
    listCharacters,
    getCharacter,
    buildSnapshot(accountID, characterID) {
      return buildSnapshot(
        accountID,
        characterID,
        characterCommands.getStateVersion(characterID),
      );
    },
    // R28: the skill sheet + queue as plain JSON, with the SP thresholds and
    // the server's clock resolved. Ownership is the caller's to check (the
    // route does it, exactly like /snapshot); a mismatch answers null.
    buildSkillSheet(accountID, characterID) {
      return buildSkillSheet(accountID, characterID);
    },
    isCharacterOnline(characterID) {
      return Boolean(onlineRuntime.isCharacterOnline(characterID));
    },
    getCharacterControlStatus(characterID) {
      return sanitizeCharacterControlSnapshot(
        characterControlRuntime.getCharacterControlSnapshot(characterID),
        characterID,
        characterCommands.getStateVersion(characterID),
      );
    },
    claimBrowserControl(characterID, controllerID) {
      const result = characterControlRuntime.claimBrowserControl(
        characterID,
        controllerID,
      );
      return {
        control: sanitizeCharacterControlSnapshot(
          result.control,
          characterID,
          characterCommands.getStateVersion(characterID),
        ),
        credentials: {
          leaseID: result.credentials.leaseID,
          leaseSecret: result.credentials.leaseSecret,
        },
      };
    },
    renewBrowserControl(characterID, controllerID, leaseID, leaseSecret) {
      const result = characterControlRuntime.renewBrowserControl(
        characterID,
        controllerID,
        leaseID,
        leaseSecret,
      );
      return {
        control: sanitizeCharacterControlSnapshot(
          result.control,
          characterID,
          characterCommands.getStateVersion(characterID),
        ),
      };
    },
    releaseBrowserControl(characterID, controllerID, leaseID, leaseSecret) {
      const result = characterControlRuntime.releaseBrowserControl(
        characterID,
        controllerID,
        leaseID,
        leaseSecret,
      );
      return {
        control: sanitizeCharacterControlSnapshot(
          result.control,
          characterID,
          characterCommands.getStateVersion(characterID),
        ),
      };
    },
    async submitSkillQueueSaveCommand(characterID, envelope) {
      const outcome = await characterCommands.submitCommand(characterID, envelope, {
        requiredType: CHARACTER_COMMAND_TYPES.SAVE_SKILL_QUEUE,
      });
      return {
        snapshot: sanitizeQueueSnapshot(outcome.result),
        stateVersion: outcome.stateVersion,
      };
    },
    async submitPiRestartExtractorsCommand(characterID, envelope) {
      const outcome = await characterCommands.submitCommand(characterID, envelope, {
        requiredType: CHARACTER_COMMAND_TYPES.RESTART_PI_EXTRACTORS,
      });
      return {
        summary: cloneValue(outcome.result),
        stateVersion: outcome.stateVersion,
      };
    },
    subscribeCharacterEvents(characterID, cursor, handlers) {
      if (stopped) {
        throw new Error("Character event stream is unavailable.");
      }
      return characterEvents.subscribe(characterID, cursor, handlers);
    },
    getCharacterEventDiagnostics() {
      return characterEvents.getDiagnostics();
    },
    // --- Bridge-session push stream (goal R10) -----------------------------
    /**
     * Subscribe to a held bridge session's push stream. Authorization is the
     * same rule every other bridge route uses: the bridgeSessionID must resolve
     * to a live entry owned by `userid`, and a foreign or unknown handle is
     * opaquely SESSION_NOT_FOUND. `cursor` ({epoch, sequence}) resumes a prior
     * connection; without a replayable cursor the subscriber gets a snapshot
     * frame telling it to resynchronize by reading.
     */
    /**
     * Resolve + ownership-check a bridge session without subscribing, so the
     * gateway can refuse an unauthorized upgrade with a readable HTTP status
     * before the WebSocket handshake completes. Throws the same opaque
     * SESSION_NOT_FOUND the bridge routes throw.
     */
    authorizeSessionEvents(bridgeSessionID, userid) {
      if (stopped) {
        throw new Error("Bridge session event stream is unavailable.");
      }
      getBrowserSessionEntry(normalizeBridgeSessionID(bridgeSessionID), userid);
      return true;
    },
    subscribeSessionEvents(bridgeSessionID, userid, cursor, handlers) {
      if (stopped) {
        throw new Error("Bridge session event stream is unavailable.");
      }
      const entry = getBrowserSessionEntry(
        normalizeBridgeSessionID(bridgeSessionID),
        userid,
      );
      return sessionEvents.subscribe(entry.bridgeSessionID, cursor, handlers);
    },
    getSessionEventDiagnostics() {
      return sessionEvents.getDiagnostics();
    },
    // The thin-bridge invocation path: (service, method, args, kwargs) plus
    // JSON session fields -> the same dispatch seam the retail client hits,
    // `serviceManager.lookup(service).callMethod(method, args, session, kwargs)`,
    // against a gateway-materialized browser-backed session. Deny by default:
    // only explicit WEB_CALL_ALLOWLIST pairs dispatch, and refusal happens
    // before any service lookup.
    async callServiceMethod(request) {
      const call = normalizeWebCallRequest(request);
      if (!isAllowlistedWebCall(call.service, call.method)) {
        throw webCallError(
          "CALL_NOT_ALLOWED",
          `${call.service}.${call.method} is not on the web-call allowlist.`,
        );
      }
      const serviceInstance = serviceManager.lookup(call.service);
      if (!serviceInstance || typeof serviceInstance.callMethod !== "function") {
        throw webCallError(
          "CALL_SERVICE_UNAVAILABLE",
          `${call.service} is not available in this process.`,
        );
      }
      // With a bridgeSessionID the call runs on the stored persistent live
      // session (goal R2); without one it runs on a per-call materialized
      // session exactly as in R1.
      const rawBridgeSessionID =
        request && typeof request === "object" ? request.bridgeSessionID : undefined;
      let entry = null;
      let session;
      let notifications;
      if (rawBridgeSessionID !== undefined && rawBridgeSessionID !== null) {
        entry = getBrowserSessionEntry(
          normalizeBridgeSessionID(rawBridgeSessionID),
          call.sessionFields.userid,
        );
        session = entry.session;
        notifications = entry.notifications;
        entry.lastUsedAtMs = nowMs();
        session.lastActivity = Date.now();
      } else {
        notifications = [];
        session = materializeBrowserBackedSession(call.sessionFields, notifications);
      }
      let result;
      // A deferred result carries the captured emissions from driving it (an
      // array, possibly empty); null means the dispatch was synchronous.
      let deferredCaptured = null;
      try {
        result = await Promise.resolve(
          serviceInstance.callMethod(call.method, call.args, session, call.kwargs),
        );
        if (isDeferredCallResponse(result)) {
          deferredCaptured = await driveDeferredCallResponse(result, {
            serviceManager,
            session,
            serviceInstance,
            call,
            serviceName: call.service,
          });
        }
      } catch (error) {
        throw toWebCallDispatchError(error, call.service, call.method);
      }
      // Resolving a driven deferred can raise CALL_DEFERRED_UNSUPPORTED; do it
      // outside the dispatch try so that typed refusal is not remapped to
      // CALL_FAILED.
      if (deferredCaptured) {
        result = resolveDeferredCallResult(
          deferredCaptured,
          call.service,
          call.method,
        );
      }
      let response;
      try {
        response = {
          service: call.service,
          method: call.method,
          result: encodeJsonSafeCallValue(result),
          // Persistent sessions accumulate notifications between calls;
          // returning them drains the backlog (drain-on-read).
          notifications: encodeJsonSafeCallValue(
            entry ? notifications.splice(0) : notifications,
          ),
        };
      } catch {
        throw webCallError(
          "CALL_FAILED",
          `${call.service}.${call.method} returned a result that is not JSON-serializable.`,
        );
      }
      // Retail runs afterCallResponse only for non-deferred dispatches (the
      // packet dispatcher returns before it on a deferred). Mirror that.
      if (!deferredCaptured) {
        await invokeAfterCallResponse(serviceInstance, call, session, result);
      }
      return response;
    },
    // Mint a persistent browser-backed session and bring a character online on
    // it by dispatching the retail tuple charUnboundMgr.SelectCharacterID
    // through the same allowlisted callMethod seam. On success the session
    // stays live in the store under an opaque bridgeSessionID; on refusal or
    // failure the minted session is discarded and nothing leaks.
    async selectCharacter(request) {
      const call = normalizeWebCallRequest({
        service: WEB_SELECT_CHARACTER_CALL.service,
        method: WEB_SELECT_CHARACTER_CALL.method,
        args: request && request.args,
        kwargs: request && request.kwargs,
        session: request && request.session,
      });
      if (!isAllowlistedWebCall(call.service, call.method)) {
        throw webCallError(
          "CALL_NOT_ALLOWED",
          `${call.service}.${call.method} is not on the web-call allowlist.`,
        );
      }
      const serviceInstance = serviceManager.lookup(call.service);
      if (!serviceInstance || typeof serviceInstance.callMethod !== "function") {
        throw webCallError(
          "CALL_SERVICE_UNAVAILABLE",
          `${call.service} is not available in this process.`,
        );
      }
      const notifications = [];
      const notificationSink = createNotificationSink();
      browserSessionClientIDCounter += 1;
      const session = materializePersistentBrowserSession(
        call.sessionFields,
        notifications,
        BROWSER_SESSION_CLIENT_ID_BASE + browserSessionClientIDCounter,
        notificationSink,
      );
      // Registering makes this a live client session: the duplicate-login
      // guard and the character-control runtime now arbitrate it exactly like
      // a retail session.
      sessionRegistry.register(session);
      let result;
      try {
        result = await Promise.resolve(
          serviceInstance.callMethod(call.method, call.args, session, call.kwargs),
        );
      } catch (error) {
        discardMintedSession(session);
        throw toWebCallDispatchError(error, call.service, call.method);
      }
      const characterID = Number(session.characterID || session.charid || 0) || 0;
      if (!(characterID > 0)) {
        // Handle_SelectCharacterID returns null on both success and
        // apply-failure; the truthful success signal is the character bound to
        // the session (applyCharacterToSession sets it).
        discardMintedSession(session);
        throw webCallError(
          "SESSION_SELECT_FAILED",
          `${call.service}.${call.method} completed without bringing a character online.`,
        );
      }
      const bridgeSessionID = crypto.randomBytes(24).toString("base64url");
      const entry = {
        bridgeSessionID,
        session,
        notifications,
        userid: call.sessionFields.userid,
        createdAtMs: nowMs(),
        lastUsedAtMs: nowMs(),
        // R3 bound-object handles held on this persistent session only:
        // opaque handle token -> { oid, serviceName, oids }. Like the
        // bridgeSessionID these are BFF<->gateway only and never reach the
        // browser; a handle minted here is not visible to any other session.
        boundHandles: new Map(),
      };
      browserSessions.set(bridgeSessionID, entry);
      // The stream key exists now, so every later notification the capture
      // stubs record is ALSO pushed. They keep accumulating on `notifications`
      // for the response drain — this is a tee, not a redirect.
      notificationSink.bind((notification) => {
        sessionEvents.publish(bridgeSessionID, {
          kind: "notification",
          notification: encodeJsonSafeCallValue(notification),
        });
      });
      startBrowserSessionSweep();
      // R7 chat presence: join Local + ensure Corp channel as a gateway
      // side-effect on select (the browser session's sendSessionChange is a
      // capture stub, so retail's auto chat-sync never fires). Best-effort — a
      // chat sync failure must never break bringing the character online.
      try {
        webChatGatewayService.syncPresence(session);
      } catch (error) {
        log.debug(
          `[EvejsWebGateway] chat presence sync on select skipped: ${error.message}`,
        );
      }
      log.info(
        `[EvejsWebGateway] Browser session started characterID=${characterID} ` +
          `userid=${entry.userid}`,
      );
      try {
        return {
          bridgeSessionID,
          service: call.service,
          method: call.method,
          result: encodeJsonSafeCallValue(result === undefined ? null : result),
          notifications: encodeJsonSafeCallValue(notifications.splice(0)),
          session: {
            userid: entry.userid,
            characterID,
            characterName: String(session.characterName || ""),
            stationID: Number(session.stationid || session.stationID || 0) || null,
            structureID: Number(session.structureid || session.structureID || 0) || null,
            solarSystemID:
              Number(session.solarsystemid2 || session.solarsystemid || 0) || null,
            corporationID: Number(session.corporationID || 0) || null,
            // Active ship the docked entry put on the session (R3): the browser
            // (via the BFF) binds its cargo with invbroker.GetInventoryFromId.
            shipID: Number(session.shipid || session.shipID || 0) || null,
          },
        };
      } catch {
        teardownBrowserSession(entry, "browser_session_select_encode_failed");
        throw webCallError(
          "CALL_FAILED",
          `${call.service}.${call.method} returned a result that is not JSON-serializable.`,
        );
      }
    },
    // Explicit release: runs the same disconnect path a retail socket close
    // runs, so the character goes offline and control releases cleanly.
    releaseBrowserSession(request) {
      const bridgeSessionID = normalizeBridgeSessionID(
        request && typeof request === "object" ? request.bridgeSessionID : request,
      );
      const sessionFields =
        request && typeof request === "object" && isPlainObject(request.session)
          ? request.session
          : null;
      const entry = getBrowserSessionEntry(
        bridgeSessionID,
        sessionFields && sessionFields.userid !== undefined
          ? Number(sessionFields.userid)
          : undefined,
      );
      const characterID = teardownBrowserSession(entry, "browser_session_released");
      return {
        released: true,
        characterID: characterID > 0 ? characterID : null,
      };
    },
    // R5a flight status. A read-only snapshot of the held persistent session's
    // current location and (when in space) ship movement state, plus the
    // drained notification backlog. Reads the live session scalars the gateway
    // already holds — the same fields undock/jump/dock mutate — so the browser
    // can poll flight status manually between movement steps without full push
    // streaming (G6). The ship movement mode is a best-effort read of the scene
    // entity via the space runtime (lazy require keeps the module load graph
    // unchanged for proxy-only processes, mirroring teardownBrowserSession).
    readFlightStatus(request) {
      const bridgeSessionID = normalizeBridgeSessionID(
        request && typeof request === "object" ? request.bridgeSessionID : request,
      );
      const sessionFields =
        request && typeof request === "object" && isPlainObject(request.session)
          ? request.session
          : null;
      const entry = getBrowserSessionEntry(
        bridgeSessionID,
        sessionFields && sessionFields.userid !== undefined
          ? Number(sessionFields.userid)
          : undefined,
      );
      const session = entry.session;
      entry.lastUsedAtMs = nowMs();
      session.lastActivity = Date.now();
      const space =
        session._space && typeof session._space === "object" ? session._space : null;
      const inSpace = Boolean(space);
      const stationID = Number(session.stationid || session.stationID || 0) || null;
      const structureID = Number(session.structureid || session.structureID || 0) || null;
      const solarSystemID =
        Number(
          (space && space.systemID) ||
            session.solarsystemid2 ||
            session.solarsystemid ||
            0,
        ) || null;
      const shipID =
        Number((space && space.shipID) || session.shipid || session.shipID || 0) ||
        null;
      let shipMode = null;
      let shipSpeedFraction = null;
      if (inSpace && shipID) {
        try {
          const spaceRuntime = require(path.join(__dirname, "../../space/runtime"));
          const entity =
            typeof spaceRuntime.getEntity === "function"
              ? spaceRuntime.getEntity(session, shipID)
              : null;
          if (entity) {
            shipMode =
              (typeof entity.mode === "string" && entity.mode) ||
              (entity.spaceState &&
                typeof entity.spaceState.mode === "string" &&
                entity.spaceState.mode) ||
              null;
            const fraction = Number(
              entity.speedFraction !== undefined
                ? entity.speedFraction
                : entity.spaceState && entity.spaceState.speedFraction,
            );
            shipSpeedFraction = Number.isFinite(fraction) ? fraction : null;
          }
        } catch {
          // Best-effort: a proxy-only process (or a scene already gone) simply
          // yields no movement mode; the location scalars above still hold.
        }
      }
      const flight = {
        inSpace,
        docked: !inSpace && Boolean(stationID || structureID),
        solarSystemID,
        stationID,
        structureID,
        shipID,
        shipMode,
        shipSpeedFraction,
      };
      return {
        flight,
        notifications: encodeJsonSafeCallValue(entry.notifications.splice(0)),
      };
    },
    // R11 space snapshot. A read-only projection of what the held session can
    // actually SEE right now: the scene's visible entities (statics + dynamics,
    // already cloak-filtered by the runtime) plus the active ship's health and
    // capacitor. Mirrors readFlightStatus exactly — hold the session, reach into
    // the space runtime, return JSON, drain the notification backlog.
    //
    // This is the same structure retail reads: the client's overview enumerates
    // the destiny Ballpark balls and computes distance/sorting/filtering
    // CLIENT-side from the positions, re-rendering every 0.5-1.0s. So the
    // browser polling this ~1s is faithful to retail's own cadence, not a
    // compromise — and distance math stays in the browser, exactly as it does in
    // the real client. The HUD is a DIFFERENT source: shield/armor/hull/cap for
    // the ACTIVE ship come from the ship item's dogma-backed condition state
    // (godma.GetItem(shipID) in retail), not from the ballpark; other entities
    // carry only their damageState fractions, which is what we project per row.
    //
    // Read-only: this calls the space runtime, it never mutates it. Positions
    // are integrated server-side every tick (RUNTIME_TICK_INTERVAL_MS = 100), so
    // each poll sees a freshly integrated scene without the gateway stepping it.
    readSpaceSnapshot(request) {
      const bridgeSessionID = normalizeBridgeSessionID(
        request && typeof request === "object" ? request.bridgeSessionID : request,
      );
      const sessionFields =
        request && typeof request === "object" && isPlainObject(request.session)
          ? request.session
          : null;
      const entry = getBrowserSessionEntry(
        bridgeSessionID,
        sessionFields && sessionFields.userid !== undefined
          ? Number(sessionFields.userid)
          : undefined,
      );
      const session = entry.session;
      entry.lastUsedAtMs = nowMs();
      session.lastActivity = Date.now();
      const space =
        session._space && typeof session._space === "object" ? session._space : null;
      const inSpace = Boolean(space);
      const solarSystemID =
        Number(
          (space && space.systemID) ||
            session.solarsystemid2 ||
            session.solarsystemid ||
            0,
        ) || null;
      const shipID =
        Number((space && space.shipID) || session.shipid || session.shipID || 0) ||
        null;
      const snapshot = {
        inSpace,
        solarSystemID,
        shipID,
        // Server sim time the projection was taken at, so the browser can tell
        // two polls apart (and, later, dead-reckon between them like retail).
        sampledAtMs: Date.now(),
        entities: [],
        ship: null,
      };
      if (inSpace) {
        try {
          const spaceRuntime = require(path.join(__dirname, "../../space/runtime"));
          const scene =
            typeof spaceRuntime.getSceneForSession === "function"
              ? spaceRuntime.getSceneForSession(session)
              : null;
          if (scene) {
            const egoEntity =
              typeof scene.getShipEntityForSession === "function"
                ? scene.getShipEntityForSession(session)
                : null;
            const visible =
              typeof scene.getVisibleEntitiesForSession === "function"
                ? scene.getVisibleEntitiesForSession(session)
                : [];
            // Refresh presentation fields before projecting, exactly as
            // ensureInitialBallpark does before it builds a slim payload —
            // otherwise condition/capacitor/name fields can be a tick stale.
            // The runtime exposes these two helpers only through its `_testing`
            // bag; the gateway must CALL the space runtime and never modify it,
            // so we use the handles that exist and tolerate their absence.
            refreshSpacePresentationFields(spaceRuntime, egoEntity, visible);
            snapshot.sampledAtMs =
              typeof scene.getCurrentSimTimeMs === "function"
                ? Number(scene.getCurrentSimTimeMs()) || snapshot.sampledAtMs
                : snapshot.sampledAtMs;
            const egoItemID = Number(egoEntity && egoEntity.itemID) || 0;
            // R23: rocks carry how much ore is left, which lives in the scene's
            // mining state rather than on the ball. Built once per snapshot.
            const mineableStateFor = buildMineableStateLookup(scene);
            snapshot.entities = (Array.isArray(visible) ? visible : [])
              .map((entity) => projectSpaceEntity(entity, egoItemID, mineableStateFor))
              .filter((row) => row !== null);
            snapshot.ship = projectActiveShipStatus(egoEntity);
            if (egoItemID > 0) {
              snapshot.shipID = egoItemID;
            }
          }
        } catch {
          // Best-effort, like readFlightStatus: a proxy-only process (or a scene
          // already gone) simply yields an empty overview; the location scalars
          // above still hold and the page shows "nothing in range" rather than
          // failing the read.
        }
      }
      return {
        space: encodeJsonSafeCallValue(snapshot),
        notifications: encodeJsonSafeCallValue(entry.notifications.splice(0)),
      };
    },
    // R7 chat read. Re-syncs the held session's Local/Corp presence (join on
    // first read, move Local room after a dock/system-change — the browser
    // session's sendSessionChange is a capture stub so retail auto-sync never
    // fires), then returns the current member roster + recent backlog for the
    // requested channel. READ is a backlog poll because chat delivery bypasses
    // the notification drain (survey ground truth). The accumulated notification
    // backlog is drained alongside (drain-on-read) like the other routes.
    readChat(request) {
      const bridgeSessionID = normalizeBridgeSessionID(
        request && typeof request === "object" ? request.bridgeSessionID : request,
      );
      const sessionFields =
        request && typeof request === "object" && isPlainObject(request.session)
          ? request.session
          : null;
      const channel = normalizeChatChannel(request && request.channel);
      const limit = request && request.limit;
      const entry = getBrowserSessionEntry(
        bridgeSessionID,
        sessionFields && sessionFields.userid !== undefined
          ? Number(sessionFields.userid)
          : undefined,
      );
      const session = entry.session;
      entry.lastUsedAtMs = nowMs();
      session.lastActivity = Date.now();
      webChatGatewayService.syncPresence(session);
      let chat;
      try {
        chat = webChatGatewayService.readChannel(session, channel, limit);
      } catch (error) {
        throw toWebChatError(error);
      }
      return {
        chat: encodeJsonSafeCallValue(chat),
        notifications: encodeJsonSafeCallValue(entry.notifications.splice(0)),
      };
    },
    // R7 chat send. Re-syncs presence, then broadcasts to Local
    // (chatRuntime.broadcastLocalMessage) or Corp (the session-derived corp
    // broadcast — writes the corp_<id> backlog + emits a corp-message event,
    // NOT an XMPP send). A channel access failure or mute surfaces as
    // CALL_REFUSED with the core handler's own message.
    sendChat(request) {
      const bridgeSessionID = normalizeBridgeSessionID(
        request && typeof request === "object" ? request.bridgeSessionID : request,
      );
      const sessionFields =
        request && typeof request === "object" && isPlainObject(request.session)
          ? request.session
          : null;
      const channel = normalizeChatChannel(request && request.channel);
      const entry = getBrowserSessionEntry(
        bridgeSessionID,
        sessionFields && sessionFields.userid !== undefined
          ? Number(sessionFields.userid)
          : undefined,
      );
      const session = entry.session;
      entry.lastUsedAtMs = nowMs();
      session.lastActivity = Date.now();
      webChatGatewayService.syncPresence(session);
      let sent;
      try {
        sent = webChatGatewayService.sendChannel(
          session,
          channel,
          request && request.message,
        );
      } catch (error) {
        throw toWebChatError(error);
      }
      return {
        chat: encodeJsonSafeCallValue({
          channel: sent.channel,
          roomName: sent.roomName,
          sent: true,
          entry: sent.entry,
        }),
        notifications: encodeJsonSafeCallValue(entry.notifications.splice(0)),
      };
    },
    // R3 bound-object bridge — step 1 of the retail two-step. Dispatch an
    // allowlisted bind method (e.g. invbroker.GetInventory / GetInventoryFromId
    // / MachoBindObject, ship.MachoBindObject) on the persistent live session;
    // the handler returns a bound-object substruct carrying an OID. The OID is
    // registered on the shared service manager (as network/packetDispatcher
    // does after a real MachoBindObject) so later calls resolve back to the
    // creating service, and an opaque boundHandle is stored on this session and
    // returned to the BFF. The OID itself never leaves the gateway. Deny by
    // default: the (service, method) bind pair is refused before any service
    // lookup exactly like a top-level call.
    async bindBoundObject(request) {
      const call = normalizeWebCallRequest(request);
      const rawBridgeSessionID =
        request && typeof request === "object" ? request.bridgeSessionID : undefined;
      if (rawBridgeSessionID === undefined || rawBridgeSessionID === null) {
        throw webCallError(
          "CALL_INVALID",
          "A bound-object bind requires a bridgeSessionID.",
        );
      }
      if (!isAllowlistedWebCall(call.service, call.method)) {
        throw webCallError(
          "CALL_NOT_ALLOWED",
          `${call.service}.${call.method} is not on the web-call allowlist.`,
        );
      }
      const entry = getBrowserSessionEntry(
        normalizeBridgeSessionID(rawBridgeSessionID),
        call.sessionFields.userid,
      );
      const serviceInstance = serviceManager.lookup(call.service);
      if (!serviceInstance || typeof serviceInstance.callMethod !== "function") {
        throw webCallError(
          "CALL_SERVICE_UNAVAILABLE",
          `${call.service} is not available in this process.`,
        );
      }
      const session = entry.session;
      const notifications = entry.notifications;
      entry.lastUsedAtMs = nowMs();
      session.lastActivity = Date.now();
      // A bind is a fresh top-level bind, not nested inside another bound
      // object, so currentBoundObjectID is cleared for the dispatch (matching
      // the packet dispatcher, which only sets it for OID-addressed calls).
      const previousBoundObjectID = session.currentBoundObjectID || null;
      session.currentBoundObjectID = null;
      let result;
      try {
        result = await Promise.resolve(
          serviceInstance.callMethod(call.method, call.args, session, call.kwargs),
        );
      } catch (error) {
        throw toWebCallDispatchError(error, call.service, call.method);
      } finally {
        session.currentBoundObjectID = previousBoundObjectID;
      }
      const oids = extractBoundObjectOIDs(result);
      if (oids.length === 0) {
        throw webCallError(
          "BOUND_NO_OBJECT",
          `${call.service}.${call.method} did not return a bound object.`,
        );
      }
      for (const oid of oids) {
        serviceManager.registerBoundObject(oid, serviceInstance);
      }
      const boundHandle = crypto.randomBytes(24).toString("base64url");
      entry.boundHandles.set(boundHandle, {
        oid: oids[0],
        oids,
        serviceName: call.service,
      });
      try {
        return {
          boundHandle,
          service: call.service,
          method: call.method,
          notifications: encodeJsonSafeCallValue(notifications.splice(0)),
        };
      } catch {
        entry.boundHandles.delete(boundHandle);
        for (const oid of oids) {
          try {
            serviceManager.unregisterBoundObject(oid, { session });
          } catch {
            // Best-effort rollback of the registrations for a failed bind.
          }
        }
        throw webCallError(
          "CALL_FAILED",
          `${call.service}.${call.method} bind returned an unserializable notification.`,
        );
      }
    },
    // R3 bound-object bridge — step 2. Dispatch a bound method on a handle held
    // by this persistent session. The handle is resolved to its OID and
    // creating service on THIS session only (handles are confined: a handle
    // from another session is unknown here), then deny-by-default is enforced
    // on the (service, method) pair BEFORE the OID is resolved through the
    // service manager — a non-allowlisted bound method is refused before any
    // dispatch. currentBoundObjectID is set to the OID so the handler resolves
    // its bound context exactly as it does on a real socket.
    async callBoundMethod(request) {
      const call = normalizeWebCallRequest(request);
      const rawBridgeSessionID =
        request && typeof request === "object" ? request.bridgeSessionID : undefined;
      if (rawBridgeSessionID === undefined || rawBridgeSessionID === null) {
        throw webCallError(
          "CALL_INVALID",
          "A bound-object call requires a bridgeSessionID.",
        );
      }
      const boundHandle = normalizeBoundHandle(
        request && typeof request === "object" ? request.boundHandle : undefined,
      );
      const entry = getBrowserSessionEntry(
        normalizeBridgeSessionID(rawBridgeSessionID),
        call.sessionFields.userid,
      );
      const handleEntry = entry.boundHandles.get(boundHandle);
      if (!handleEntry) {
        throw webCallError(
          "BOUND_HANDLE_NOT_FOUND",
          "Unknown bound-object handle for this session.",
        );
      }
      // The BFF must address the handle with its own service; a mismatch is a
      // programming error and is treated as an unknown handle (opaque).
      if (call.service !== handleEntry.serviceName) {
        throw webCallError(
          "BOUND_HANDLE_NOT_FOUND",
          "Bound-object handle does not belong to the requested service.",
        );
      }
      // Deny by default on the bound method, before any service lookup.
      if (!isAllowlistedWebCall(handleEntry.serviceName, call.method)) {
        throw webCallError(
          "CALL_NOT_ALLOWED",
          `${handleEntry.serviceName}.${call.method} is not on the web-call allowlist.`,
        );
      }
      const serviceInstance = serviceManager.lookup(handleEntry.oid);
      if (!serviceInstance || typeof serviceInstance.callMethod !== "function") {
        // The OID was released or evicted out from under the handle.
        entry.boundHandles.delete(boundHandle);
        throw webCallError(
          "BOUND_HANDLE_NOT_FOUND",
          "Bound-object handle is no longer resolvable.",
        );
      }
      const session = entry.session;
      const notifications = entry.notifications;
      entry.lastUsedAtMs = nowMs();
      session.lastActivity = Date.now();
      const previousBoundObjectID = session.currentBoundObjectID || null;
      session.currentBoundObjectID = handleEntry.oid;
      let result;
      let deferredCaptured = null;
      try {
        result = await Promise.resolve(
          serviceInstance.callMethod(call.method, call.args, session, call.kwargs),
        );
        // A bound DoAction(decline) returns a deferred; drive it to completion
        // while the bound context (currentBoundObjectID) is still set so the
        // handler resolves its agent exactly as on a socket.
        if (isDeferredCallResponse(result)) {
          deferredCaptured = await driveDeferredCallResponse(result, {
            serviceManager,
            session,
            serviceInstance,
            call,
            serviceName: handleEntry.serviceName,
          });
        }
      } catch (error) {
        throw toWebCallDispatchError(error, handleEntry.serviceName, call.method);
      } finally {
        session.currentBoundObjectID = previousBoundObjectID;
      }
      // CALL_DEFERRED_UNSUPPORTED must propagate untouched (not remap to
      // CALL_FAILED), so resolve the driven deferred outside the dispatch try.
      if (deferredCaptured) {
        result = resolveDeferredCallResult(
          deferredCaptured,
          handleEntry.serviceName,
          call.method,
        );
      }
      let response;
      try {
        response = {
          service: handleEntry.serviceName,
          method: call.method,
          result: encodeJsonSafeCallValue(result),
          notifications: encodeJsonSafeCallValue(notifications.splice(0)),
        };
      } catch {
        throw webCallError(
          "CALL_FAILED",
          `${handleEntry.serviceName}.${call.method} returned a result that is not JSON-serializable.`,
        );
      }
      if (!deferredCaptured) {
        await invokeAfterCallResponse(
          serviceInstance,
          { ...call, service: handleEntry.serviceName },
          session,
          result,
        );
      }
      return response;
    },
    // TTL sweep entry point: the interval calls this, and tests/operators can
    // invoke it directly for deterministic expiry.
    expireIdleBrowserSessions,
    async getStationAsks(stationID) {
      await marketDaemonClient.startupCheck();
      const rows = await marketDaemonClient.call("GetStationAsks", {
        station_id: stationID,
      });
      return Array.isArray(rows) ? rows : [];
    },
    shutdown() {
      if (stopped) {
        return;
      }
      stopped = true;
      stopBrowserSessionSweep();
      // Release the read-only chat subscription before tearing sessions down so
      // a teardown-triggered chat event cannot re-enter the push path.
      try {
        chatRuntime.off("channel-message", onChatChannelMessage);
      } catch {
        // Best effort; shutdown must continue.
      }
      for (const entry of [...browserSessions.values()]) {
        try {
          teardownBrowserSession(entry, "gateway_shutdown");
        } catch {
          // Shutdown must tear down every remaining browser session.
        }
      }
      sessionEvents.shutdown();
      characterEvents.shutdown();
      characterCommands.shutdown();
      if (usesDefaultRuntimes && defaultCharacterRuntimes === defaults) {
        defaultCharacterRuntimes = null;
      }
    },
  });
}

module.exports = {
  createEvejsWebGatewayRuntime,
  sanitizeCharacterControlSnapshot,
  sanitizeQueueSnapshot,
  WEB_CALL_ALLOWLIST,
  // Exported for focused unit tests of the R4 deferred-call-response handling.
  driveDeferredCallResponse,
  resolveDeferredCallResult,
  // Exported so the per-field projection can be tested against a plain entity,
  // without standing up a scene: the full snapshot path is covered by the
  // in-process gateway tests, but a field that is only ever set on a hull running
  // two specific modules is far cheaper to pin here than to stage in a fixture.
  projectSpaceEntity,
};
