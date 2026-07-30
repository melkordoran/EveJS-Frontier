const path = require("path");

const worldData = require(path.join(__dirname, "../../space/worldData"));
const sessionRegistry = require(path.join(__dirname, "../chat/sessionRegistry"));
const {
  buildDict,
  buildFiletimeLong,
  buildKeyVal,
  buildList,
  buildMarshalReal,
  currentFileTime,
} = require(path.join(__dirname, "../_shared/serviceHelpers"));
const {
  TABLE,
  readStaticRows,
} = require(path.join(__dirname, "../_shared/referenceData"));
const {
  getAgentByID,
  listMissionTemplateIDsForAgent,
} = require(path.join(__dirname, "./agentAuthority"));
const {
  getMissionByID,
  getMissionArcInfo,
  isMissionOfferAllowedForAgent,
  isOrdinarySecurityAgent,
  isSupportedLevelOneClientDungeonID,
  listMissionIDsByTemplate,
  listMissionIDsForAgent: listClientMissionIDsForAgent,
  pickMissionForAgent,
} = require(path.join(__dirname, "./missionAuthority"));
const {
  getClientDungeonTemplate,
  getTemplateByID,
} = require(path.join(__dirname, "../dungeon/dungeonAuthority"));
const dungeonRuntime = require(path.join(__dirname, "../dungeon/dungeonRuntime"));
const dungeonTrackingRuntime = require(path.join(
  __dirname,
  "../dungeon/dungeonTrackingRuntime",
));
// TEMP DEBUG HOOK (EveAnomUtility content testing): lightweight logger so the accept path can
// report the mission's deadspace fields. Remove with the other EVEJS_FORCE_* hooks.
const log = require(path.join(__dirname, "../../utils/logger"));
const {
  getCharacterRecord,
  syncInventoryItemForSession,
} = require(path.join(__dirname, "../character/characterState"));
const {
  adjustCharacterBalance,
} = require(path.join(__dirname, "../account/walletState"));
const {
  adjustCharacterWalletLPBalance,
} = require(path.join(__dirname, "../corporation/lpWalletState"));
const {
  mutateCharacterState,
  getCharacterStateSnapshot,
  OFFER_EXPIRY_MS,
  REPLAY_DELAY_MS,
  currentFileTimeString,
  futureFileTimeString,
  normalizeEpicArcProgress,
  recordEpicArcCompletion,
  recordEpicArcMissionStatus,
  recordStorylineQualifyingCompletion,
} = require(path.join(__dirname, "./missionRuntimeState"));
const {
  resolveItemByTypeID,
} = require(path.join(__dirname, "../inventory/itemTypeRegistry"));
const {
  getActiveShipItem,
  grantItemsToCharacterStationHangar,
  listContainerItems,
  takeItemTypeFromCharacterLocation,
  ITEM_FLAGS,
  buildRemovedItemNotificationState,
} = require(path.join(__dirname, "../inventory/itemStore"));
const {
  notifyInventoryChangesToCharacter,
} = require(path.join(__dirname, "../raffles/raffleInventory"));
const {
  getDockedLocationID,
} = require(path.join(__dirname, "../structure/structureLocation"));
const bookmarkRuntime = require(path.join(
  __dirname,
  "../bookmark/bookmarkRuntimeState",
));
const {
  TYPE_SOLAR_SYSTEM,
} = require(path.join(__dirname, "../bookmark/bookmarkConstants"));
const standingRuntime = require(path.join(
  __dirname,
  "../character/standingRuntime",
));
const config = require(path.join(__dirname, "../../config"));

const AGENT_DIALOGUE_BUTTON_VIEW_MISSION = 1;
const AGENT_DIALOGUE_BUTTON_REQUEST_MISSION = 2;
const AGENT_DIALOGUE_BUTTON_ACCEPT = 3;
const AGENT_DIALOGUE_BUTTON_ACCEPT_REMOTELY = 5;
const AGENT_DIALOGUE_BUTTON_COMPLETE = 6;
const AGENT_DIALOGUE_BUTTON_COMPLETE_REMOTELY = 7;
const AGENT_DIALOGUE_BUTTON_DECLINE = 9;
const AGENT_DIALOGUE_BUTTON_DEFER = 10;
const AGENT_DIALOGUE_BUTTON_QUIT = 11;

// The legacy agent window sends the first action-tuple value back to DoAction;
// the second value selects the client button presentation.
const AGENT_DIALOGUE_ACTION_TOKEN_REQUEST = 815;
const AGENT_DIALOGUE_ACTION_TOKEN_ACCEPT = 816;
const AGENT_DIALOGUE_ACTION_TOKEN_DECLINE = 817;
const AGENT_DIALOGUE_ACTION_TOKEN_DEFER = 818;
const AGENT_DIALOGUE_ACTION_TOKEN_COMPLETE = 819;
const AGENT_DIALOGUE_ACTION_TOKEN_QUIT = 820;
const AGENT_DIALOGUE_ACTION_TOKEN_COMPLETE_READY = 821;
const AGENT_DIALOGUE_ACTION_TOKEN_QUIT_READY = 822;
const AGENT_DIALOGUE_ACTION_TOKEN_REQUEST_AFTER_COMPLETION = 823;
const AGENT_DIALOGUE_ACTION_BUTTON_BY_TOKEN = Object.freeze({
  [AGENT_DIALOGUE_ACTION_TOKEN_REQUEST]: AGENT_DIALOGUE_BUTTON_REQUEST_MISSION,
  [AGENT_DIALOGUE_ACTION_TOKEN_ACCEPT]: AGENT_DIALOGUE_BUTTON_ACCEPT,
  [AGENT_DIALOGUE_ACTION_TOKEN_DECLINE]: AGENT_DIALOGUE_BUTTON_DECLINE,
  [AGENT_DIALOGUE_ACTION_TOKEN_DEFER]: AGENT_DIALOGUE_BUTTON_DEFER,
  [AGENT_DIALOGUE_ACTION_TOKEN_COMPLETE]: AGENT_DIALOGUE_BUTTON_COMPLETE,
  [AGENT_DIALOGUE_ACTION_TOKEN_QUIT]: AGENT_DIALOGUE_BUTTON_QUIT,
  [AGENT_DIALOGUE_ACTION_TOKEN_COMPLETE_READY]: AGENT_DIALOGUE_BUTTON_COMPLETE,
  [AGENT_DIALOGUE_ACTION_TOKEN_QUIT_READY]: AGENT_DIALOGUE_BUTTON_QUIT,
  [AGENT_DIALOGUE_ACTION_TOKEN_REQUEST_AFTER_COMPLETION]:
    AGENT_DIALOGUE_BUTTON_REQUEST_MISSION,
});

const AGENT_MISSION_STATE_OFFERED = 1;
const AGENT_MISSION_STATE_ACCEPTED = 2;
const AGENT_MISSION_STATE_COMPLETED = 4;
const AGENT_MISSION_STATE_CANT_REPLAY = 7;

const AGENT_MISSION_ACCEPTED = "accepted";
const AGENT_MISSION_COMPLETED = "completed";
const AGENT_MISSION_OFFERED = "offered";
const AGENT_MISSION_MODIFIED = "modified";
const AGENT_MISSION_OFFER_DECLINED = "offer_declined";
const AGENT_MISSION_OFFER_EXPIRED = "offer_expired";
const AGENT_MISSION_OFFER_REMOVED = "offer_removed";
const AGENT_MISSION_RESET = "reset";
const AGENT_MISSION_QUIT = "quit";

const MISSION_KIND_COURIER = "courier";
const MISSION_KIND_DISTRIBUTION = "distribution";
const MISSION_KIND_MINING = "mining";
const OBJECTIVE_TYPE_AGENT = "agent";
const OBJECTIVE_TYPE_DUNGEON = "dungeon";
const OBJECTIVE_TYPE_FETCH = "fetch";
const OBJECTIVE_TYPE_TRANSPORT = "transport";
const PLACEHOLDER_CARGO_TYPE_ID = 16135;
const PLACEHOLDER_CARGO_QUANTITY = 1;
const PLACEHOLDER_DUNGEON_ID_OFFSET = 930000000;
const MISSION_SITE_ID_OFFSET = 9700000000000;
const MISSION_SITE_DISTANCE_METERS = 5500000000;
const MISSION_SITE_DISTANCE_JITTER_METERS = 350000000;
const MISSION_SITE_VERTICAL_JITTER_METERS = 180000000;
const MISSION_IN_DUNGEON_DISTANCE_METERS = 500000;
const MISSION_BOOKMARK_FOLDER_NAME = "Agent Missions";
const MISSION_BOOKMARK_FOLDER_DESCRIPTION =
  "System-managed mission bookmarks used by agent mission warp/location flows.";
const FILETIME_EPOCH = 116444736000000000n;
const AGENT_INTERACTION_ACTION_ID_BASE = 10000;
const ISK_REWARD_TYPE_ID = 29;
const ISK_DISPLAY_TYPE_ID = ISK_REWARD_TYPE_ID;
const MISSION_REWARD_ENTRY_TYPE = 3;
const MISSION_PLACEHOLDER_NOTE =
  "Proceed to the assigned destination, complete the listed objectives, and return to your agent for debriefing.";
const MISSION_PLACEHOLDER_COMPLETE_NOTE =
  "Objective complete. Return to your agent for final debriefing and reward collection.";

// Loyalty point payout on TQ is LP = baseLP * (1.6288 - systemSecurity), so an agent in 0.5
// space pays roughly 55% more than one in 0.9. The table below stores the pre-scaling baseLP.
const LP_SECURITY_CONSTANT = 1.6288;
const LP_SECURITY_MULTIPLIER_FLOOR = 0.1;
// Captured TQ reward presentations put the timed bonus at 1.230-1.237x the base reward, not
// the fraction-of-base this table used to assume.
const MISSION_BONUS_ISK_RATIO = 1.23;

const REWARD_SCALE_SECURITY = "security";
const REWARD_SCALE_DISTRIBUTION = "distribution";

// Two distinct pay curves, not one curve with a discount. Distribution missions are short and
// low-risk and TQ pays them on a far flatter scale than combat — modelling them as
// "security * 0.85" overpaid a level 4 courier by roughly 12x.
//
// Security anchors: the four level-1 reward presentations captured from TQ logs (33k/38k/77k/113k
// base ISK, 35/48/103/141 LP in 0.7-0.9 space) and community reports of ~1.5M ISK base+bonus at
// level 4. Distribution anchors: EVE University's ~400,000 ISK per level 4 mission including the
// time bonus with Negotiation V, and 450-1,050 LP per mission in high security space.
const REWARD_BY_SCALE_AND_LEVEL = Object.freeze({
  [REWARD_SCALE_SECURITY]: Object.freeze({
    1: { isk: 65000, bonusIsk: 80000, baseLoyaltyPoints: 105, bonusTimeIntervalMinutes: 120, corpRaw: 0.018, agentRaw: 0.01, factionRaw: 0.0 },
    2: { isk: 142000, bonusIsk: 175000, baseLoyaltyPoints: 250, bonusTimeIntervalMinutes: 150, corpRaw: 0.026, agentRaw: 0.014, factionRaw: 0.0 },
    3: { isk: 310000, bonusIsk: 381000, baseLoyaltyPoints: 600, bonusTimeIntervalMinutes: 180, corpRaw: 0.038, agentRaw: 0.02, factionRaw: 0.0 },
    4: { isk: 675000, bonusIsk: 830000, baseLoyaltyPoints: 1450, bonusTimeIntervalMinutes: 240, corpRaw: 0.055, agentRaw: 0.028, factionRaw: 0.0 },
    5: { isk: 1470000, bonusIsk: 1808000, baseLoyaltyPoints: 3500, bonusTimeIntervalMinutes: 300, corpRaw: 0.072, agentRaw: 0.036, factionRaw: 0.0 },
  }),
  [REWARD_SCALE_DISTRIBUTION]: Object.freeze({
    1: { isk: 13800, bonusIsk: 17000, baseLoyaltyPoints: 53, bonusTimeIntervalMinutes: 60, corpRaw: 0.018, agentRaw: 0.01, factionRaw: 0.0 },
    2: { isk: 30000, bonusIsk: 37000, baseLoyaltyPoints: 125, bonusTimeIntervalMinutes: 75, corpRaw: 0.026, agentRaw: 0.014, factionRaw: 0.0 },
    3: { isk: 65500, bonusIsk: 81000, baseLoyaltyPoints: 310, bonusTimeIntervalMinutes: 90, corpRaw: 0.038, agentRaw: 0.02, factionRaw: 0.0 },
    4: { isk: 143000, bonusIsk: 176000, baseLoyaltyPoints: 730, bonusTimeIntervalMinutes: 120, corpRaw: 0.055, agentRaw: 0.028, factionRaw: 0.0 },
    5: { isk: 312000, bonusIsk: 384000, baseLoyaltyPoints: 1750, bonusTimeIntervalMinutes: 150, corpRaw: 0.072, agentRaw: 0.036, factionRaw: 0.0 },
  }),
});

let cachedStationsByCorporationID = null;
const cachedMissionTemplateSelections = new Map();

function cloneValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeInteger(value, fallback = 0) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return fallback;
  }
  return Math.trunc(numericValue);
}

function normalizePositiveInteger(value, fallback = 0) {
  const numericValue = normalizeInteger(value, 0);
  return numericValue > 0 ? numericValue : fallback;
}

function normalizeText(value, fallback = "") {
  const text = String(value || "").trim();
  return text.length > 0 ? text : fallback;
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function buildDefaultMissionLastActionInfo(overrides = {}) {
  return {
    missionCompleted: null,
    missionQuit: null,
    missionCantReplay: null,
    loyaltyPoints: 0,
    missionDeclined: null,
    ...normalizeObject(overrides),
  };
}

function normalizeAgentDialogueActionID(value) {
  const actionID = normalizeInteger(value, 0);
  return AGENT_DIALOGUE_ACTION_BUTTON_BY_TOKEN[actionID] || actionID;
}

function buildActiveMissionLastActionInfo(overrides = {}) {
  return buildDefaultMissionLastActionInfo({
    missionCompleted: false,
    missionQuit: false,
    missionDeclined: false,
    ...normalizeObject(overrides),
  });
}

function normalizeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function normalizeMissionContentID(value, fallback = null) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }

  const text = normalizeText(value, "");
  if (!text) {
    return fallback;
  }
  if (/^-?\d+$/.test(text)) {
    return Number.parseInt(text, 10);
  }
  return text;
}

function missionContentIDToText(value, fallback = "") {
  const normalized = normalizeMissionContentID(value, null);
  if (normalized === null || normalized === undefined) {
    return fallback;
  }
  return String(normalized);
}

function humanizeClientMissionContentTemplate(contentTemplateID) {
  const suffix = normalizeText(contentTemplateID, "")
    .replace(/^agent\.missionTemplatizedContent_/i, "");
  if (!suffix) {
    return "";
  }
  return suffix
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeBoolean(value, fallback = false) {
  if (value === undefined || value === null) {
    return fallback;
  }
  return value === true;
}

function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function clonePosition(value) {
  return {
    x: Number(value && value.x) || 0,
    y: Number(value && value.y) || 0,
    z: Number(value && value.z) || 0,
  };
}

function buildMarshalTuple(items = []) {
  return {
    type: "tuple",
    items: Array.isArray(items) ? items : [items],
  };
}

function addVectors(left, right) {
  return {
    x: (Number(left && left.x) || 0) + (Number(right && right.x) || 0),
    y: (Number(left && left.y) || 0) + (Number(right && right.y) || 0),
    z: (Number(left && left.z) || 0) + (Number(right && right.z) || 0),
  };
}

function subtractVectors(left, right) {
  return {
    x: (Number(left && left.x) || 0) - (Number(right && right.x) || 0),
    y: (Number(left && left.y) || 0) - (Number(right && right.y) || 0),
    z: (Number(left && left.z) || 0) - (Number(right && right.z) || 0),
  };
}

function vectorMagnitude(vector) {
  const x = Number(vector && vector.x) || 0;
  const y = Number(vector && vector.y) || 0;
  const z = Number(vector && vector.z) || 0;
  return Math.sqrt((x * x) + (y * y) + (z * z));
}

function hashText(value) {
  const normalized = normalizeText(value, "");
  let state = 0;
  for (let index = 0; index < normalized.length; index += 1) {
    state = Math.imul(state ^ normalized.charCodeAt(index), 0x45d9f3b);
    state ^= state >>> 16;
  }
  state = Math.imul(state ^ (state >>> 16), 0x45d9f3b);
  state ^= state >>> 16;
  return state >>> 0;
}

function getSpaceRuntime() {
  return require(path.join(__dirname, "../../space/runtime"));
}

function roundMoney(value) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return 0;
  }
  return Math.round(numericValue * 100) / 100;
}

function fileTimeStringToBigInt(value) {
  try {
    return BigInt(String(value || "0"));
  } catch (_error) {
    return 0n;
  }
}

function fileTimeBigIntToLong(fileTimeValue) {
  return buildFiletimeLong(fileTimeValue > 0n ? fileTimeValue : currentFileTime());
}

function nowFileTimeBigInt() {
  return currentFileTime();
}

function intervalMsToTicks(deltaMs) {
  const safeDeltaMs = Math.max(0, Number(deltaMs) || 0);
  return Math.trunc(safeDeltaMs * 10000);
}

function resolveReplayRemainingTicks(rawReplayUntilFileTime) {
  const replayUntil = fileTimeStringToBigInt(rawReplayUntilFileTime);
  if (replayUntil <= 0n) {
    return 0;
  }
  const delta = replayUntil - nowFileTimeBigInt();
  if (delta <= 0n) {
    return 0;
  }
  return Number(delta);
}

function getAgentRecord(agentID) {
  const agentRecord = getAgentByID(agentID);
  return agentRecord && typeof agentRecord === "object" ? agentRecord : null;
}

function getMissionTemplateRecord(missionTemplateID) {
  const template = getTemplateByID(missionTemplateID);
  return template && typeof template === "object" ? template : null;
}

function getRuntimeMissionTemplateRecord(missionRecord = null) {
  return getMissionTemplateRecord(
    normalizeText(missionRecord && missionRecord.missionTemplateID, ""),
  );
}

function getDungeonMissionTemplateRecord(missionRecord = null) {
  return getMissionTemplateRecord(
    normalizeText(missionRecord && missionRecord.dungeonTemplateID, ""),
  );
}

function getMissionInstanceTemplateRecord(missionRecord = null) {
  const runtimeMissionTemplate = getRuntimeMissionTemplateRecord(missionRecord);
  if (
    runtimeMissionTemplate &&
    normalizeText(runtimeMissionTemplate && runtimeMissionTemplate.siteFamily, "").toLowerCase() === "mission"
  ) {
    return runtimeMissionTemplate;
  }
  return getDungeonMissionTemplateRecord(missionRecord) || runtimeMissionTemplate || null;
}

function getMissionTemplatePool(agentID) {
  return listMissionTemplateIDsForAgent(agentID)
    .map((missionTemplateID) => normalizeText(missionTemplateID, ""))
    .filter(Boolean)
    .filter((missionTemplateID) => {
      const template = getMissionTemplateRecord(missionTemplateID);
      return (
        template &&
        normalizeText(template.siteFamily, "unknown") === "mission" &&
        !/^eve-survival:category/i.test(missionTemplateID)
      );
    });
}

function normalizeMissionTemplateMatchKey(value) {
  return normalizeText(value, "")
    .toLowerCase()
    .replace(/\b(?:lvl|level)\s*\d+\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractMissionTemplateLevel(template = null) {
  const explicitLevel = normalizePositiveInteger(template && template.level, 0);
  if (explicitLevel > 0) {
    return explicitLevel;
  }
  const titleMatch = normalizeText(template && template.title, "").match(
    /\b(?:lvl|level)\s*(\d+)\b/i,
  );
  return titleMatch ? normalizePositiveInteger(titleMatch[1], 0) : 0;
}

function buildMissionTemplateMatchCandidates(
  clientMissionRecord,
  runtimeDungeonTemplate,
) {
  const candidates = new Set();
  const pushCandidate = (value) => {
    const normalized = normalizeMissionTemplateMatchKey(value);
    if (normalized) {
      candidates.add(normalized);
    }
  };

  pushCandidate(getMissionLocalizedNameText(clientMissionRecord));
  pushCandidate(clientMissionRecord && clientMissionRecord.name);
  pushCandidate(clientMissionRecord && clientMissionRecord.contentTemplate);
  pushCandidate(runtimeDungeonTemplate && runtimeDungeonTemplate.title);
  pushCandidate(runtimeDungeonTemplate && runtimeDungeonTemplate.resolvedName);

  return Array.from(candidates);
}

function getExplicitMissionTemplateForClientMission(clientMissionRecord = null) {
  const explicitTemplateIDs = [
    normalizeText(clientMissionRecord && clientMissionRecord.dungeonTemplateID, ""),
    normalizeText(clientMissionRecord && clientMissionRecord.missionTemplateID, ""),
    normalizeText(clientMissionRecord && clientMissionRecord.generatedFromTemplateID, ""),
  ].filter(Boolean);
  for (const templateID of explicitTemplateIDs) {
    const template = getMissionTemplateRecord(templateID);
    if (
      template &&
      normalizeText(template && template.siteFamily, "").toLowerCase() === "mission"
    ) {
      return template;
    }
  }
  return null;
}

function scoreMissionTemplateCandidate(
  template,
  agentRecord,
  clientMissionRecord,
  runtimeDungeonTemplate,
  fallbackMissionTemplate = null,
) {
  if (!template || typeof template !== "object") {
    return Number.NEGATIVE_INFINITY;
  }

  const candidateKeys = buildMissionTemplateMatchCandidates(
    clientMissionRecord,
    runtimeDungeonTemplate,
  );
  const templateKey = normalizeMissionTemplateMatchKey(
    template.title || template.resolvedName || template.templateID,
  );
  const templateTokens = new Set(templateKey.split(" ").filter(Boolean));
  let score = 0;

  for (const candidateKey of candidateKeys) {
    if (!candidateKey) {
      continue;
    }
    if (templateKey === candidateKey) {
      score = Math.max(score, 700);
      continue;
    }
    if (templateKey && (templateKey.includes(candidateKey) || candidateKey.includes(templateKey))) {
      score = Math.max(score, 520);
      continue;
    }
    const overlapCount = candidateKey
      .split(" ")
      .filter(Boolean)
      .filter((token) => templateTokens.has(token)).length;
    if (overlapCount > 0) {
      score = Math.max(score, overlapCount * 70);
    }
  }

  const templateSourceDungeonID = normalizePositiveInteger(
    template && template.sourceDungeonID,
    0,
  );
  const runtimeSourceDungeonID = normalizePositiveInteger(
    runtimeDungeonTemplate &&
      (runtimeDungeonTemplate.sourceDungeonID || runtimeDungeonTemplate.dungeonID),
    0,
  );
  if (templateSourceDungeonID > 0 && templateSourceDungeonID === runtimeSourceDungeonID) {
    score += 240;
  }

  // Mining missions: the client-dungeon extract holds the actual mineable rocks; an eve-survival scrape
  // does not (it would materialize an empty site). Strongly prefer a template that has miningRocks and
  // whose source dungeon matches the mission's killMission dungeon. Verified Level 1 combat dungeons are
  // resolved directly to the client extract before scoring, because those templates now carry the TQ room,
  // gate, and spawn layout.
  const candidateKillMission = clientMissionRecord && clientMissionRecord.killMission;
  const isMiningMission =
    normalizeText(clientMissionRecord && clientMissionRecord.missionKind, "").toLowerCase() === "mining" &&
    normalizePositiveInteger(candidateKillMission && candidateKillMission.objectiveTypeID, 0) > 0;
  if (isMiningMission) {
    if (
      template.populationHints &&
      Array.isArray(template.populationHints.miningRocks) &&
      template.populationHints.miningRocks.length > 0
    ) {
      score += 600;
    }
    if (
      templateSourceDungeonID > 0 &&
      templateSourceDungeonID === normalizePositiveInteger(candidateKillMission && candidateKillMission.dungeonID, 0)
    ) {
      score += 300;
    }
  }

  if (
    normalizeText(template && template.siteFamily, "").toLowerCase() === "mission"
  ) {
    score += 120;
  }

  const desiredLevel = normalizePositiveInteger(agentRecord && agentRecord.level, 0);
  const templateLevel = extractMissionTemplateLevel(template);
  if (desiredLevel > 0 && templateLevel > 0 && desiredLevel === templateLevel) {
    score += 40;
  }

  if (
    fallbackMissionTemplate &&
    normalizeText(template && template.templateID, "") ===
      normalizeText(fallbackMissionTemplate && fallbackMissionTemplate.templateID, "")
  ) {
    score += 10;
  }

  return score;
}

function resolveMissionTemplateForClientMission(
  agentRecord,
  clientMissionRecord,
  fallbackMissionTemplate = null,
  runtimeDungeonTemplate = null,
) {
  const selectionCacheKey = [
    normalizePositiveInteger(agentRecord && agentRecord.agentID, 0),
    missionContentIDToText(clientMissionRecord && clientMissionRecord.missionID, ""),
    normalizePositiveInteger(
      clientMissionRecord &&
        clientMissionRecord.killMission &&
        clientMissionRecord.killMission.dungeonID,
      0,
    ),
  ].join(":");
  if (selectionCacheKey && cachedMissionTemplateSelections.has(selectionCacheKey)) {
    const cachedTemplateID = cachedMissionTemplateSelections.get(selectionCacheKey);
    return cachedTemplateID ? getMissionTemplateRecord(cachedTemplateID) : null;
  }

  const candidateTemplates = [];
  const seenTemplateIDs = new Set();
  const pushTemplate = (template) => {
    const templateID = normalizeText(template && template.templateID, "");
    if (!templateID || seenTemplateIDs.has(templateID)) {
      return;
    }
    seenTemplateIDs.add(templateID);
    candidateTemplates.push(template);
  };

  const explicitMissionTemplate = getExplicitMissionTemplateForClientMission(clientMissionRecord);
  if (explicitMissionTemplate) {
    cachedMissionTemplateSelections.set(
      selectionCacheKey,
      normalizeText(explicitMissionTemplate && explicitMissionTemplate.templateID, ""),
    );
    return explicitMissionTemplate;
  }

  const agentID = normalizePositiveInteger(agentRecord && agentRecord.agentID, 0);
  for (const missionTemplateID of getMissionTemplatePool(agentID)) {
    pushTemplate(getMissionTemplateRecord(missionTemplateID));
  }
  pushTemplate(fallbackMissionTemplate);
  // Mining missions need the authoritative client-dungeon extract because it holds the mineable
  // rocks an eve-survival scrape lacks. Combat missions keep their authored runtime templates.
  const killMissionDungeonID = resolveClientMissionDungeonID(clientMissionRecord);
  const shouldPreferClientDungeonTemplate =
    killMissionDungeonID > 0 &&
    isSupportedLevelOneClientDungeonID(killMissionDungeonID) &&
    Boolean(runtimeDungeonTemplate);
  const isMiningMission =
    normalizeText(clientMissionRecord && clientMissionRecord.missionKind, "").toLowerCase() === "mining" &&
    normalizePositiveInteger(
      clientMissionRecord &&
        clientMissionRecord.killMission &&
        clientMissionRecord.killMission.objectiveTypeID,
      0,
    ) > 0;
  if (shouldPreferClientDungeonTemplate || (isMiningMission && killMissionDungeonID > 0)) {
    pushTemplate(runtimeDungeonTemplate || getMissionTemplateRecord(`client-dungeon:${killMissionDungeonID}`));
  }

  if (shouldPreferClientDungeonTemplate) {
    cachedMissionTemplateSelections.set(
      selectionCacheKey,
      normalizeText(runtimeDungeonTemplate && runtimeDungeonTemplate.templateID, ""),
    );
    return runtimeDungeonTemplate;
  }

  let bestTemplate = null;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const template of candidateTemplates) {
    const candidateScore = scoreMissionTemplateCandidate(
      template,
      agentRecord,
      clientMissionRecord,
      runtimeDungeonTemplate,
      fallbackMissionTemplate,
    );
    if (candidateScore > bestScore) {
      bestScore = candidateScore;
      bestTemplate = template;
    }
  }

  if (bestTemplate && bestScore >= 150) {
    cachedMissionTemplateSelections.set(
      selectionCacheKey,
      normalizeText(bestTemplate && bestTemplate.templateID, ""),
    );
    return bestTemplate;
  }
  if (
    runtimeDungeonTemplate &&
    normalizeText(runtimeDungeonTemplate && runtimeDungeonTemplate.siteFamily, "").toLowerCase() === "mission"
  ) {
    cachedMissionTemplateSelections.set(
      selectionCacheKey,
      normalizeText(runtimeDungeonTemplate && runtimeDungeonTemplate.templateID, ""),
    );
    return runtimeDungeonTemplate;
  }
  cachedMissionTemplateSelections.set(selectionCacheKey, "");
  return null;
}

function getPlausibleMissionIDs(agentID) {
  const agentRecord = getAgentRecord(agentID);
  if (!agentRecord) {
    return [];
  }
  return listClientMissionIDsForAgent(agentRecord);
}

function getStationsByCorporationID() {
  if (cachedStationsByCorporationID) {
    return cachedStationsByCorporationID;
  }

  const nextIndex = new Map();
  for (const station of readStaticRows(TABLE.STATIONS)) {
    const corporationID = normalizePositiveInteger(
      station && (station.corporationID || station.ownerID),
      0,
    );
    if (!corporationID) {
      continue;
    }
    if (!nextIndex.has(corporationID)) {
      nextIndex.set(corporationID, []);
    }
    nextIndex.get(corporationID).push(cloneValue(station));
  }

  for (const stations of nextIndex.values()) {
    stations.sort(
      (left, right) =>
        normalizePositiveInteger(left && left.solarSystemID, 0) -
          normalizePositiveInteger(right && right.solarSystemID, 0) ||
        normalizePositiveInteger(left && left.stationID, 0) -
          normalizePositiveInteger(right && right.stationID, 0),
    );
  }

  cachedStationsByCorporationID = nextIndex;
  return cachedStationsByCorporationID;
}

function getMissionStateFromRecord(record = null) {
  if (!record) {
    return null;
  }
  switch (normalizeText(record.runtimeStatus, "offered")) {
    case "accepted":
      return AGENT_MISSION_STATE_ACCEPTED;
    case "completed":
      return AGENT_MISSION_STATE_COMPLETED;
    case "offered":
    default:
      return AGENT_MISSION_STATE_OFFERED;
  }
}

function isCourierMission(agentRecord = null, missionTemplate = null) {
  const missionKind = normalizeText(agentRecord && agentRecord.missionKind, "");
  if (
    missionKind === MISSION_KIND_COURIER ||
    missionKind === MISSION_KIND_DISTRIBUTION
  ) {
    return true;
  }

  const typeLabel = normalizeText(
    agentRecord && agentRecord.missionTypeLabel,
    "",
  ).toLowerCase();
  if (typeLabel.includes("courier") || typeLabel.includes("distribution")) {
    return true;
  }

  const missionTitle = normalizeText(
    missionTemplate && missionTemplate.title,
    "",
  ).toLowerCase();
  return missionTitle.includes("courier");
}

function isMiningAgent(agentRecord = null) {
  const missionKind = normalizeText(agentRecord && agentRecord.missionKind, "");
  if (missionKind === MISSION_KIND_MINING) {
    return true;
  }
  return normalizeText(agentRecord && agentRecord.missionTypeLabel, "")
    .toLowerCase()
    .includes("mining");
}

// Distribution and mining agents hand out short, low-risk work and TQ pays them on their own
// curve. Everything else (encounter/security, research, career) rides the combat curve.
function resolveRewardScale(agentRecord = null) {
  return isCourierMission(agentRecord, null) || isMiningAgent(agentRecord)
    ? REWARD_SCALE_DISTRIBUTION
    : REWARD_SCALE_SECURITY;
}

function resolveAgentSystemSecurity(agentRecord = null) {
  const solarSystemID = normalizePositiveInteger(
    agentRecord && agentRecord.solarSystemID,
    0,
  );
  if (!solarSystemID) {
    return null;
  }
  const solarSystem = worldData.getSolarSystemByID(solarSystemID);
  const security = Number(solarSystem && solarSystem.security);
  return Number.isFinite(security) ? security : null;
}

// LP = baseLP * (1.6288 - systemSecurity). Nullsec/lowsec agents pay more; the floor keeps a
// negative-security system from inflating the payout without bound.
function resolveLoyaltyPointSecurityMultiplier(agentRecord = null) {
  const security = resolveAgentSystemSecurity(agentRecord);
  if (security === null) {
    return 1;
  }
  return Math.max(
    LP_SECURITY_MULTIPLIER_FLOOR,
    LP_SECURITY_CONSTANT - Math.max(0, security),
  );
}

// TQ awards no loyalty points for storyline, epic arc or R&D missions even though they still
// move standings. Keyed off the mission record only: isCareerAgent() tests careerID > 0, which
// is the character-creation career field and is set on every agent, so it cannot gate this.
function isLoyaltyPointExemptMission(clientMissionRecord = null) {
  if (!clientMissionRecord || typeof clientMissionRecord !== "object") {
    return false;
  }
  return (
    clientMissionRecord.isStoryline === true ||
    clientMissionRecord.isGenericStoryline === true ||
    clientMissionRecord.isEpicArc === true ||
    clientMissionRecord.isResearch === true
  );
}

function isResearchAgent(agentRecord = null) {
  const missionKind = normalizeText(agentRecord && agentRecord.missionKind, "");
  const missionTypeLabel = normalizeText(
    agentRecord && agentRecord.missionTypeLabel,
    "",
  ).toLowerCase();
  return missionKind === "research" || missionTypeLabel.includes("research");
}

function isCareerAgent(agentRecord = null) {
  return normalizePositiveInteger(agentRecord && agentRecord.careerID, 0) > 0;
}

function canUseAgent(characterID, agentRecord) {
  const normalizedCharacterID = normalizePositiveInteger(characterID, 0);
  return Boolean(
    normalizedCharacterID &&
      standingRuntime.canCharacterUseAgent(
        normalizedCharacterID,
        agentRecord,
      ),
  );
}

function buildMissionTypeLabel(agentRecord = null) {
  const explicitLabel = normalizeText(agentRecord && agentRecord.missionTypeLabel, "");
  if (explicitLabel) {
    return explicitLabel;
  }

  if (isCourierMission(agentRecord, null)) {
    return "UI/Agents/MissionTypes/Courier";
  }
  return "UI/Agents/MissionTypes/Encounter";
}

function buildStorylineMissionTypeLabel(agentRecord = null, clientMissionRecord = null) {
  const contentTemplate = normalizeText(
    clientMissionRecord && clientMissionRecord.contentTemplate,
    "",
  );
  const missionKind = normalizeText(
    clientMissionRecord && clientMissionRecord.missionKind,
    "",
  ).toLowerCase();
  if (/storylinemining/i.test(contentTemplate) || missionKind === "mining") {
    return "UI/Agents/MissionTypes/StorylineMining";
  }
  if (/storylinetrade/i.test(contentTemplate) || missionKind === "trade") {
    return "UI/Agents/MissionTypes/StorylineTrade";
  }
  if (/storylinecourier/i.test(contentTemplate) || missionKind === "courier") {
    return "UI/Agents/MissionTypes/StorylineCourier";
  }
  if (
    missionKind === "talktoagent" ||
    normalizeBoolean(clientMissionRecord && clientMissionRecord.isTalkToAgent, false)
  ) {
    return "UI/Agents/MissionTypes/EpicArcTalkToAgent";
  }
  if (
    /storylineagentinteraction/i.test(contentTemplate) ||
    missionKind === "agentinteraction"
  ) {
    return "UI/Agents/MissionTypes/StorylineAgentInteraction";
  }
  if (/storylinekill/i.test(contentTemplate) || missionKind === "encounter") {
    return "UI/Agents/MissionTypes/StorylineEncounter";
  }
  const fallbackMissionKind = normalizeText(
    agentRecord && agentRecord.missionKind,
    "",
  ).toLowerCase();
  if (fallbackMissionKind === "mining") {
    return "UI/Agents/MissionTypes/StorylineMining";
  }
  if (fallbackMissionKind === "trade") {
    return "UI/Agents/MissionTypes/StorylineTrade";
  }
  if (fallbackMissionKind === "courier" || fallbackMissionKind === "distribution") {
    return "UI/Agents/MissionTypes/StorylineCourier";
  }
  if (fallbackMissionKind === "agentinteraction" || fallbackMissionKind === "talktoagent") {
    return "UI/Agents/MissionTypes/StorylineAgentInteraction";
  }
  if (fallbackMissionKind === "encounter") {
    return "UI/Agents/MissionTypes/StorylineEncounter";
  }
  return "UI/Agents/MissionTypes/Storyline";
}

function normalizeMissionRewardItem(rewardRecord = null) {
  const typeID = normalizePositiveInteger(
    rewardRecord && (rewardRecord.rewardTypeID || rewardRecord.typeID),
    0,
  );
  const quantity = Math.max(
    0,
    normalizeInteger(
      rewardRecord && (rewardRecord.rewardQuantity || rewardRecord.quantity),
      0,
    ),
  );
  if (!typeID || quantity <= 0) {
    return null;
  }
  return {
    typeID,
    quantity,
    extra: null,
  };
}

function buildMissionRewards(
  agentRecord,
  importantMission = false,
  clientMissionRecord = null,
  characterID = null,
  presentationTemplate = null,
  contentID = null,
) {
  const rewardScale = REWARD_BY_SCALE_AND_LEVEL[resolveRewardScale(agentRecord)];
  const base =
    rewardScale[normalizeInteger(agentRecord && agentRecord.level, 1)] || rewardScale[1];
  const importantMultiplier = importantMission ? 1.3 : 1.0;
  const missionRewards =
    clientMissionRecord &&
    clientMissionRecord.missionRewards &&
    typeof clientMissionRecord.missionRewards === "object"
      ? clientMissionRecord.missionRewards
      : null;
  const primaryReward = normalizeMissionRewardItem(missionRewards && missionRewards.reward);
  const bonusReward = normalizeMissionRewardItem(missionRewards && missionRewards.bonusReward);
  const capturedRewardPresentation = missionRewards
    ? null
    : resolveCapturedMissionRewardPresentation(
        presentationTemplate,
        contentID === null || contentID === undefined
          ? clientMissionRecord && clientMissionRecord.missionID
          : contentID,
        agentRecord,
      );
  const capturedPrimaryReward = normalizeMissionRewardItem(
    capturedRewardPresentation && capturedRewardPresentation.normalReward,
  );
  const capturedBonusReward = normalizeMissionRewardItem(
    capturedRewardPresentation && capturedRewardPresentation.bonusReward,
  );
  const itemRewards = [];
  const bonusItemRewards = [];
  let isk = roundMoney(base.isk * importantMultiplier);
  let bonusIsk = roundMoney(base.bonusIsk * importantMultiplier);

  if (primaryReward) {
    isk = 0;
    if (primaryReward.typeID === ISK_REWARD_TYPE_ID) {
      isk = primaryReward.quantity;
    } else {
      itemRewards.push(primaryReward);
    }
  }

  if (bonusReward) {
    bonusIsk = 0;
    if (bonusReward.typeID === ISK_REWARD_TYPE_ID) {
      bonusIsk = bonusReward.quantity;
    } else {
      bonusItemRewards.push(bonusReward);
    }
  }

  const negotiationMultiplier = normalizePositiveInteger(characterID, 0) > 0
    ? standingRuntime.getCharacterNegotiationRewardMultiplier(characterID)
    : 1;
  if (negotiationMultiplier !== 1) {
    isk = roundMoney(isk * negotiationMultiplier);
    bonusIsk = roundMoney(bonusIsk * negotiationMultiplier);
  }

  const fixedLpReward = Math.max(
    normalizeInteger(clientMissionRecord && clientMissionRecord.fixedLpRewardOmega, 0),
    normalizeInteger(clientMissionRecord && clientMissionRecord.fixedLpRewardAlpha, 0),
  );
  // Fall back to the level's window rather than 0: a 0 interval means "no timed bonus", which
  // makes isMissionBonusRewardAvailable() pay the bonus unconditionally on every turn-in.
  // Authored data uses null for "unspecified", which normalizeInteger would coerce to 0, so
  // only a positive authored interval wins over the level default.
  let bonusTimeIntervalMinutes = normalizePositiveInteger(
    missionRewards && missionRewards.bonusTimeInterval,
    Math.max(0, normalizeInteger(base.bonusTimeIntervalMinutes, 0)),
  );
  const loyaltyPointSecurityMultiplier =
    resolveLoyaltyPointSecurityMultiplier(agentRecord);
  const divisionConnectionsMultiplier =
    normalizePositiveInteger(characterID, 0) > 0
      ? standingRuntime.getCharacterDivisionConnectionsLpMultiplier(
          characterID,
          agentRecord && agentRecord.missionKind,
        )
      : 1;
  // An authored LP amount is an explicit statement about what the mission pays, so it outranks
  // the exemption; the exemption only suppresses the computed level fallback.
  let loyaltyPoints = Math.max(
    0,
    fixedLpReward ||
      (isLoyaltyPointExemptMission(clientMissionRecord)
        ? 0
        : Math.round(
            base.baseLoyaltyPoints *
              loyaltyPointSecurityMultiplier *
              divisionConnectionsMultiplier *
              importantMultiplier,
          )),
  );

  // Captured setup rewards are exact presentation values for the matching source context.
  // Apply them only to fallback fields; authored missionRewards remain authoritative.
  if (capturedPrimaryReward) {
    isk = 0;
    itemRewards.length = 0;
    if (capturedPrimaryReward.typeID === ISK_REWARD_TYPE_ID) {
      isk = capturedPrimaryReward.quantity;
    } else {
      itemRewards.push(capturedPrimaryReward);
    }
  }
  if (capturedBonusReward) {
    bonusIsk = 0;
    bonusItemRewards.length = 0;
    if (capturedBonusReward.typeID === ISK_REWARD_TYPE_ID) {
      bonusIsk = capturedBonusReward.quantity;
    } else {
      bonusItemRewards.push(capturedBonusReward);
    }
    bonusTimeIntervalMinutes = Math.max(
      0,
      normalizeInteger(
        capturedRewardPresentation &&
          capturedRewardPresentation.bonusReward &&
          capturedRewardPresentation.bonusReward.timeIntervalMinutes,
        0,
      ),
    );
  }
  if (
    capturedRewardPresentation &&
    Object.prototype.hasOwnProperty.call(capturedRewardPresentation, "loyaltyPoints")
  ) {
    loyaltyPoints = Math.max(
      0,
      normalizeInteger(capturedRewardPresentation.loyaltyPoints, 0),
    );
  }

  return {
    isk,
    bonusIsk,
    itemRewards,
    bonusItemRewards,
    bonusTimeIntervalMinutes,
    loyaltyPoints,
    researchPoints: 0,
    rawStandings: {
      corporation: Number(base.corpRaw || 0),
      faction: importantMission ? Number(base.factionRaw || 0.012) : 0,
      agent: Number(base.agentRaw || 0),
    },
    standingEvents: {
      completed: {
        corporation: Number(base.corpRaw || 0),
        faction: importantMission ? Number(base.factionRaw || 0.012) : 0,
        agent: Number(base.agentRaw || 0),
        applySocial: true,
      },
      declined: {
        // TQ parity (golden: Starting Simple L1 declines) — a penalized decline is a two-event hit:
        // a DIRECT change to the agent and its corp (= agent/10), then a DERIVED faction ripple.
        // We emit only the direct agent+corp change here (faction: 0 → no direct faction change,
        // matching the golden); the faction ripple is produced by standingRuntime's derived
        // propagation. Magnitude = the mission's would-be agent reward negated. The golden shows the
        // true value runs ~1.2-1.5x higher and varies per mission — needs more decline logs to source.
        corporation: -Number(base.agentRaw || 0) / 10,
        faction: 0,
        agent: -Number(base.agentRaw || 0),
        applySocial: false,
      },
      failed: {
        corporation: 0,
        faction: 0,
        agent: 0,
        applySocial: false,
      },
      offerExpired: {
        corporation: 0,
        faction: 0,
        agent: 0,
        applySocial: false,
      },
      bonus: {
        corporation: 0,
        faction: 0,
        agent: 0,
        applySocial: true,
      },
    },
  };
}

function resolvePlaceholderCargo() {
  const itemRecord = resolveItemByTypeID(PLACEHOLDER_CARGO_TYPE_ID);
  return {
    typeID: PLACEHOLDER_CARGO_TYPE_ID,
    quantity: PLACEHOLDER_CARGO_QUANTITY,
    volume: Number(itemRecord && itemRecord.volume) || 1,
    hasCargo: false,
  };
}

function buildLocationWrapForStation(stationID) {
  const station = worldData.getStationByID(stationID);
  if (!station) {
    return {
      typeID: 1531,
      solarsystemID: 0,
      locationID: normalizePositiveInteger(stationID, 0),
    };
  }

  return {
    typeID: normalizePositiveInteger(station.stationTypeID, 1531),
    solarsystemID: normalizePositiveInteger(station.solarSystemID, 0),
    locationID: normalizePositiveInteger(station.stationID, 0),
  };
}

function resolveDropoffStation(agentRecord) {
  const candidateStations =
    getStationsByCorporationID().get(
      normalizePositiveInteger(agentRecord && agentRecord.corporationID, 0),
    ) || [];
  const sourceStationID = normalizePositiveInteger(agentRecord && agentRecord.stationID, 0);
  const alternativeStation = candidateStations.find(
    (station) =>
      normalizePositiveInteger(station && station.stationID, 0) !== sourceStationID,
  );

  if (alternativeStation) {
    return alternativeStation;
  }

  return worldData.getStationByID(sourceStationID) || null;
}

function getClientMissionRecord(input) {
  const missionRecord =
    input && typeof input === "object"
      ? input
      : { contentID: normalizeMissionContentID(input, null) };
  const directMissionID = normalizeMissionContentID(
    missionRecord && missionRecord.contentID,
    null,
  );
  const directMissionRecord =
    directMissionID === null ? null : getMissionByID(directMissionID);
  if (directMissionRecord) {
    return directMissionRecord;
  }

  const agentRecord = getAgentRecord(missionRecord && missionRecord.agentID);
  const missionContentTemplateID = normalizeText(
    missionRecord && missionRecord.missionContentTemplateID,
    "",
  );
  const missionTemplateID = normalizeText(
    missionRecord && missionRecord.missionTemplateID,
    "",
  );
  const desiredMissionKind = normalizeText(
    missionRecord && missionRecord.missionKind,
    "",
  ).toLowerCase();
  const objectiveMode = normalizeText(
    missionRecord && missionRecord.objectiveMode,
    "",
  ).toLowerCase();
  const desiredNameID = normalizePositiveInteger(
    missionRecord && missionRecord.missionNameID,
    0,
  );
  const candidateMissionIDs = [];
  const seenMissionIDs = new Set();
  const pushCandidateMissionID = (missionID) => {
    const normalizedMissionID = normalizeMissionContentID(missionID, null);
    const missionKey =
      normalizedMissionID === null ? "" : String(normalizedMissionID);
    if (!missionKey || seenMissionIDs.has(missionKey)) {
      return;
    }
    seenMissionIDs.add(missionKey);
    candidateMissionIDs.push(normalizedMissionID);
  };

  if (missionContentTemplateID) {
    for (const missionID of listMissionIDsByTemplate(missionContentTemplateID)) {
      pushCandidateMissionID(missionID);
    }
  }

  const clientMissionTemplateMatch = missionTemplateID.match(/^client-mission:(.+)$/i);
  if (clientMissionTemplateMatch) {
    pushCandidateMissionID(clientMissionTemplateMatch[1]);
  }

  if (agentRecord) {
    for (const missionID of listClientMissionIDsForAgent(agentRecord)) {
      pushCandidateMissionID(missionID);
    }
  }

  const candidateMissionRecords = candidateMissionIDs
    .map((missionID) => getMissionByID(missionID))
    .filter(Boolean);
  if (!candidateMissionRecords.length) {
    return null;
  }

  const missionKindMatches = (clientMissionRecord) => {
    const clientMissionKind = normalizeText(
      clientMissionRecord && clientMissionRecord.missionKind,
      "",
    ).toLowerCase();
    if (!desiredMissionKind) {
      return true;
    }
    if (clientMissionKind === desiredMissionKind) {
      return true;
    }
    const normalizedKinds = new Set([clientMissionKind, desiredMissionKind]);
    return (
      normalizedKinds.has("courier") &&
      normalizedKinds.has("distribution")
    );
  };

  const objectiveModeMatches = (clientMissionRecord) => {
    if (!objectiveMode) {
      return true;
    }
    if (objectiveMode === OBJECTIVE_TYPE_DUNGEON) {
      return resolveClientMissionDungeonID(clientMissionRecord) > 0;
    }
    if (objectiveMode === OBJECTIVE_TYPE_TRANSPORT) {
      return Boolean(
        clientMissionRecord &&
        clientMissionRecord.courierMission &&
        Object.keys(clientMissionRecord.courierMission).length > 0,
      );
    }
    if (objectiveMode === OBJECTIVE_TYPE_FETCH) {
      return normalizeText(
        clientMissionRecord && clientMissionRecord.missionKind,
        "",
      ).toLowerCase() === "trade";
    }
    if (objectiveMode === OBJECTIVE_TYPE_AGENT) {
      return (
        normalizeBoolean(clientMissionRecord && clientMissionRecord.isTalkToAgent, false) ||
        normalizeBoolean(clientMissionRecord && clientMissionRecord.isAgentInteraction, false) ||
        normalizeText(clientMissionRecord && clientMissionRecord.missionKind, "").toLowerCase() ===
          "talktoagent"
      );
    }
    return true;
  };

  const scoredCandidates = candidateMissionRecords
    .map((clientMissionRecord) => {
      let score = 0;
      if (
        missionContentTemplateID &&
        normalizeText(clientMissionRecord && clientMissionRecord.contentTemplate, "") ===
          missionContentTemplateID
      ) {
        score += 100;
      }
      if (
        desiredNameID > 0 &&
        normalizePositiveInteger(clientMissionRecord && clientMissionRecord.nameID, 0) ===
          desiredNameID
      ) {
        score += 50;
      }
      if (missionKindMatches(clientMissionRecord)) {
        score += 20;
      }
      if (objectiveModeMatches(clientMissionRecord)) {
        score += 20;
      }
      return { score, clientMissionRecord };
    })
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return normalizePositiveInteger(
        left.clientMissionRecord && left.clientMissionRecord.missionID,
        0,
      ) - normalizePositiveInteger(
        right.clientMissionRecord && right.clientMissionRecord.missionID,
        0,
      );
    });

  return scoredCandidates[0].clientMissionRecord || null;
}

function isEpicArcClientMissionRecord(clientMissionRecord) {
  return Boolean(
    clientMissionRecord &&
    (
      clientMissionRecord.isEpicArc === true ||
      normalizeText(clientMissionRecord.missionFlavor, "").toLowerCase() === "epicarc" ||
      normalizePositiveInteger(clientMissionRecord.epicArcID, 0) > 0
    )
  );
}

function resolveEpicArcMissionInfo(missionRecord) {
  const clientMissionRecord = getClientMissionRecord(missionRecord);
  if (!isEpicArcClientMissionRecord(clientMissionRecord)) {
    return null;
  }

  return {
    epicArcID: normalizePositiveInteger(clientMissionRecord.epicArcID, 0),
    missionID: normalizeMissionContentID(clientMissionRecord.missionID, null),
    nameID: normalizePositiveInteger(
      missionRecord && missionRecord.missionNameID,
      normalizePositiveInteger(clientMissionRecord.nameID, 0),
    ) || null,
    clientMissionRecord,
  };
}

function buildEpicArcMissionStatusRecord(
  missionRecord,
  overrides = {},
) {
  const epicArcInfo = resolveEpicArcMissionInfo(missionRecord);
  if (!epicArcInfo || !epicArcInfo.epicArcID || epicArcInfo.missionID === null) {
    return null;
  }

  return {
    epicArcID: epicArcInfo.epicArcID,
    missionID: epicArcInfo.missionID,
    acceptedDate: normalizeText(
      overrides.acceptedDate ?? missionRecord.acceptedAtFileTime,
      "",
    ),
    completedDate: normalizeText(overrides.completedDate, ""),
    quitDate: normalizeText(overrides.quitDate, ""),
    nameID: normalizePositiveInteger(overrides.nameID, epicArcInfo.nameID) || null,
    agentID: normalizePositiveInteger(missionRecord.agentID, 0) || null,
    missionSequence: normalizePositiveInteger(missionRecord.missionSequence, 0) || null,
    missionTemplateID: normalizeText(missionRecord.missionTemplateID, ""),
  };
}

function isEpicArcEndMission(missionRecord) {
  const epicArcInfo = resolveEpicArcMissionInfo(missionRecord);
  if (!epicArcInfo) {
    return false;
  }
  return Array.isArray(epicArcInfo.clientMissionRecord.nextMissionIDs) &&
    epicArcInfo.clientMissionRecord.nextMissionIDs.length === 0;
}

function setEpicArcStatus(
  statusByArcID,
  statusRecord,
) {
  if (!statusRecord) {
    return;
  }
  const epicArcID = normalizePositiveInteger(statusRecord.epicArcID, 0);
  const missionID = normalizeMissionContentID(statusRecord.missionID, null);
  if (!epicArcID || missionID === null) {
    return;
  }
  const arcKey = String(epicArcID);
  const missionKey = String(missionID);
  if (!statusByArcID[arcKey]) {
    statusByArcID[arcKey] = {};
  }
  statusByArcID[arcKey][missionKey] = {
    ...(statusByArcID[arcKey][missionKey] || {}),
    ...statusRecord,
    epicArcID,
    missionID,
  };
}

function buildEpicArcStatusKeyVal(statusRecord) {
  return buildKeyVal([
    [
      "acceptedDate",
      statusRecord && statusRecord.acceptedDate
        ? buildFiletimeLong(statusRecord.acceptedDate)
        : null,
    ],
    [
      "completedDate",
      statusRecord && statusRecord.completedDate
        ? buildFiletimeLong(statusRecord.completedDate)
        : null,
    ],
    [
      "quitDate",
      statusRecord && statusRecord.quitDate
        ? buildFiletimeLong(statusRecord.quitDate)
        : null,
    ],
    ["nameID", normalizePositiveInteger(statusRecord && statusRecord.nameID, 0) || null],
  ]);
}

function buildEpicArcStatusPayloadFromCharacterState(characterState) {
  if (!characterState || typeof characterState !== "object") {
    return buildDict([]);
  }

  const statusByArcID = {};
  const progress = normalizeEpicArcProgress(characterState.epicArcProgress);
  for (const [arcKey, missionMap] of Object.entries(progress.missionStatusByArcID || {})) {
    for (const statusRecord of Object.values(missionMap || {})) {
      setEpicArcStatus(statusByArcID, {
        ...statusRecord,
        epicArcID: normalizePositiveInteger(arcKey, 0),
      });
    }
  }

  for (const missionRecord of Object.values(characterState.missionsByAgentID || {})) {
    const runtimeStatus = normalizeText(missionRecord && missionRecord.runtimeStatus, "offered");
    const activeStatus = buildEpicArcMissionStatusRecord(missionRecord, {
      acceptedDate: runtimeStatus === "accepted"
        ? normalizeText(missionRecord && missionRecord.acceptedAtFileTime, "")
        : "",
      completedDate: runtimeStatus === "completed"
        ? normalizeText(missionRecord && missionRecord.completedAtFileTime, "")
        : "",
      nameID: normalizePositiveInteger(missionRecord && missionRecord.missionNameID, 0),
    });
    setEpicArcStatus(statusByArcID, activeStatus);
  }

  return buildDict(
    Object.entries(statusByArcID)
      .map(([arcKey, missionMap]) => [
        normalizePositiveInteger(arcKey, 0),
        buildDict(
          Object.entries(missionMap || {})
            .map(([missionKey, statusRecord]) => [
              normalizeMissionContentID(missionKey, missionKey),
              buildEpicArcStatusKeyVal(statusRecord),
            ]),
        ),
      ])
      .filter(([epicArcID]) => epicArcID > 0),
  );
}

function resolveClientMissionContentID(missionRecord, agentRecord = null) {
  const directMissionID = normalizeMissionContentID(
    missionRecord && missionRecord.contentID,
    null,
  );
  if (directMissionID !== null && getMissionByID(directMissionID)) {
    return directMissionID;
  }
  const clientMissionRecord = getClientMissionRecord({
    ...(missionRecord && typeof missionRecord === "object" ? missionRecord : {}),
    agentID:
      normalizePositiveInteger(missionRecord && missionRecord.agentID, 0) ||
      normalizePositiveInteger(agentRecord && agentRecord.agentID, 0),
  });
  return normalizeMissionContentID(
    clientMissionRecord && clientMissionRecord.missionID,
    directMissionID,
  );
}

function isFetchMissionRecord(missionRecord) {
  return normalizeText(missionRecord && missionRecord.objectiveMode, "") === OBJECTIVE_TYPE_FETCH;
}

function isDungeonFetchMissionRecord(missionRecord) {
  return (
    normalizeText(missionRecord && missionRecord.objectiveMode, "") === OBJECTIVE_TYPE_DUNGEON &&
    !isMiningMissionRecord(missionRecord) &&
    Boolean(resolvePrimaryMissionItemSpec(missionRecord))
  );
}

function hasDungeonItemPresentationAxis(missionRecord) {
  return (
    normalizeText(missionRecord && missionRecord.objectiveMode, "") === OBJECTIVE_TYPE_DUNGEON &&
    Boolean(resolvePrimaryMissionItemSpec(missionRecord))
  );
}

function isAgentObjectiveMissionRecord(missionRecord) {
  return normalizeText(missionRecord && missionRecord.objectiveMode, "") === OBJECTIVE_TYPE_AGENT;
}

function getMissionArcDataRecord(missionRecord) {
  const clientMissionRecord = getClientMissionRecord(missionRecord);
  if (!clientMissionRecord) {
    return null;
  }
  return getMissionArcInfo(clientMissionRecord.missionID);
}

function getMissionNextMissionIDs(missionRecord) {
  const clientMissionRecord = getClientMissionRecord(missionRecord);
  if (clientMissionRecord && Array.isArray(clientMissionRecord.nextMissionIDs)) {
    return clientMissionRecord.nextMissionIDs
      .map((entry) => normalizeMissionContentID(entry, null))
      .filter((entry) => entry !== null);
  }
  const arcInfo = getMissionArcDataRecord(missionRecord);
  return Array.isArray(arcInfo && arcInfo.nextMissionIDs)
    ? arcInfo.nextMissionIDs
      .map((entry) => normalizeMissionContentID(entry, null))
      .filter((entry) => entry !== null)
    : [];
}

function getMissionConversationTargetAgentID(missionRecord, fallbackAgentID = 0) {
  const clientMissionRecord = getClientMissionRecord(missionRecord);
  const fallbackSourceAgentID = normalizePositiveInteger(
    clientMissionRecord && clientMissionRecord.sourceAgentID,
    normalizePositiveInteger(fallbackAgentID, 0),
  );
  const targetAgentID = normalizePositiveInteger(
    clientMissionRecord && clientMissionRecord.targetAgentID,
    0,
  );
  if (targetAgentID > 0) {
    return targetAgentID;
  }
  if (normalizeBoolean(clientMissionRecord && clientMissionRecord.isAgentInteraction, false)) {
    return fallbackSourceAgentID;
  }
  return 0;
}

function getMissionConversationTargetRecord(missionRecord, fallbackAgentID = 0) {
  const targetAgentID = getMissionConversationTargetAgentID(missionRecord, fallbackAgentID);
  return targetAgentID > 0 ? getAgentRecord(targetAgentID) : null;
}

function buildMissionConversationTargetLocationWrap(missionRecord, fallbackAgentRecord = null) {
  const targetAgentRecord = getMissionConversationTargetRecord(
    missionRecord,
    normalizePositiveInteger(fallbackAgentRecord && fallbackAgentRecord.agentID, 0),
  );
  if (targetAgentRecord) {
    const location = buildAgentLocationWrap(targetAgentRecord);
    if (normalizeText(location && location.locationType, "").toLowerCase() !== "agentinspace") {
      return location;
    }
    const solarSystemID = normalizePositiveInteger(location.solarsystemID, 0);
    const inSpace = normalizeObject(targetAgentRecord.agentInSpace);
    const spaceRuntime = getSpaceRuntime();
    const scene =
      spaceRuntime &&
      spaceRuntime.scenes instanceof Map &&
      solarSystemID > 0
        ? spaceRuntime.scenes.get(solarSystemID)
        : null;
    const targetAgentID = normalizePositiveInteger(targetAgentRecord.agentID, 0);
    const liveEntity =
      getSceneEntityByID(scene, targetAgentID) ||
      listSceneEntities(scene).find((entity) => (
        normalizePositiveInteger(entity && (entity.agentID || entity.ownerID), 0) ===
          targetAgentID
      )) ||
      null;
    const positionSources = [
      liveEntity && liveEntity.position,
      inSpace.position,
      inSpace,
      targetAgentRecord.position,
    ];
    const position = positionSources.find((candidate) => (
      candidate &&
      ["x", "y", "z"].every((axis) => (
        candidate[axis] !== null &&
        candidate[axis] !== undefined &&
        Number.isFinite(Number(candidate[axis]))
      ))
    ));
    if (!position) {
      return location;
    }
    return {
      ...location,
      x: Number(position.x),
      y: Number(position.y),
      z: Number(position.z),
    };
  }
  return null;
}

function translateMissionRewardTypeForDisplay(typeID) {
  const normalizedTypeID = normalizePositiveInteger(typeID, 0);
  return normalizedTypeID === ISK_REWARD_TYPE_ID
    ? ISK_DISPLAY_TYPE_ID
    : normalizedTypeID;
}

function buildMissionRewardDisplayEntry(rewardRecord = null) {
  const typeID = translateMissionRewardTypeForDisplay(rewardRecord && rewardRecord.typeID);
  const quantity = Math.max(0, normalizeInteger(rewardRecord && rewardRecord.quantity, 0));
  if (!typeID || quantity <= 0) {
    return null;
  }
  return buildMarshalTuple([
    typeID,
    quantity,
    rewardRecord && Object.prototype.hasOwnProperty.call(rewardRecord, "extra")
      ? cloneValue(rewardRecord.extra)
      : null,
  ]);
}

function resolveMissionBonusTimeRemainingTicks(missionRecord) {
  const rewards =
    missionRecord && missionRecord.rewards && typeof missionRecord.rewards === "object"
      ? missionRecord.rewards
      : {};
  const intervalMinutes = Math.max(0, normalizeInteger(rewards.bonusTimeIntervalMinutes, 0));
  if (intervalMinutes <= 0) {
    return 0;
  }

  const acceptedAt = fileTimeStringToBigInt(missionRecord && missionRecord.acceptedAtFileTime);
  if (acceptedAt <= 0n) {
    return intervalMsToTicks(intervalMinutes * 60 * 1000);
  }

  const deadline = acceptedAt + BigInt(intervalMsToTicks(intervalMinutes * 60 * 1000));
  const remaining = deadline - nowFileTimeBigInt();
  if (remaining <= 0n) {
    return 0;
  }
  return Number(remaining);
}

function isMissionBonusRewardAvailable(missionRecord) {
  const rewards =
    missionRecord && missionRecord.rewards && typeof missionRecord.rewards === "object"
      ? missionRecord.rewards
      : {};
  const hasTimedBonus = Math.max(0, normalizeInteger(rewards.bonusTimeIntervalMinutes, 0)) > 0;
  if (!hasTimedBonus) {
    return true;
  }
  return resolveMissionBonusTimeRemainingTicks(missionRecord) > 0;
}

function buildClientMissionObjectiveContext(clientMissionRecord) {
  const context = {};
  const clientObjectives = normalizeObject(
    clientMissionRecord && clientMissionRecord.clientObjectives,
  );
  for (const parameter of normalizeArray(clientObjectives.contextParameters)) {
    const parameterKey = normalizeText(
      parameter && (parameter.key || parameter.parameterKey),
      "",
    );
    if (
      !parameterKey ||
      !parameter ||
      !Object.prototype.hasOwnProperty.call(parameter, "value")
    ) {
      continue;
    }
    context[parameterKey] = cloneValue(parameter.value);
  }
  return context;
}

function resolveClientMissionDungeonID(clientMissionRecord) {
  const objectiveContext = buildClientMissionObjectiveContext(clientMissionRecord);
  return (
    normalizePositiveInteger(objectiveContext.dungeon_id, 0) ||
    normalizePositiveInteger(
      clientMissionRecord &&
        clientMissionRecord.killMission &&
        clientMissionRecord.killMission.dungeonID,
      0,
    )
  );
}

function resolveMissionExpirationDurationMs(clientMissionRecord) {
  if (
    clientMissionRecord &&
    clientMissionRecord.expirationTime !== undefined &&
    clientMissionRecord.expirationTime !== null
  ) {
    const authoredExpirationMinutes = Math.max(
      0,
      normalizeInteger(clientMissionRecord.expirationTime, 0),
    );
    return authoredExpirationMinutes * 60 * 1000;
  }
  return OFFER_EXPIRY_MS;
}

function buildMissionItemSpec(value, fallbackTypeID = 0, fallbackQuantity = 1) {
  const candidates = Array.isArray(value) ? value : [value];
  for (const candidate of candidates) {
    const source = normalizeObject(candidate);
    const typeID = normalizePositiveInteger(
      source.typeID || source.type_id || source.objectiveTypeID,
      0,
    );
    const groupID = normalizePositiveInteger(
      source.groupID || source.group_id,
      0,
    );
    const quantity = Math.max(
      1,
      normalizeInteger(
        source.quantity || source.objectiveQuantity,
        fallbackQuantity,
      ),
    );
    if (typeID > 0 || groupID > 0) {
      return { typeID, groupID, quantity };
    }
  }

  const normalizedFallbackTypeID = normalizePositiveInteger(fallbackTypeID, 0);
  if (normalizedFallbackTypeID > 0) {
    return {
      typeID: normalizedFallbackTypeID,
      groupID: 0,
      quantity: Math.max(1, normalizeInteger(fallbackQuantity, 1)),
    };
  }
  return null;
}

function resolvePrimaryMissionItemSpec(missionRecord) {
  if (missionRecord && missionRecord.cargo) {
    return buildMissionItemSpec(missionRecord.cargo);
  }

  const clientMissionRecord = getClientMissionRecord(missionRecord);
  const courierMission = normalizeObject(
    clientMissionRecord && clientMissionRecord.courierMission,
  );
  const killMission = normalizeObject(
    clientMissionRecord && clientMissionRecord.killMission,
  );

  if (normalizePositiveInteger(courierMission.objectiveTypeID, 0) > 0) {
    return buildMissionItemSpec({
      typeID: courierMission.objectiveTypeID,
      quantity: courierMission.objectiveQuantity,
    });
  }

  if (normalizePositiveInteger(killMission.objectiveTypeID, 0) > 0) {
    return buildMissionItemSpec({
      typeID: killMission.objectiveTypeID,
      quantity: killMission.objectiveQuantity,
    });
  }

  return null;
}

function getMissionMessageID(clientMissionRecord, messageKey) {
  return normalizePositiveInteger(
    clientMissionRecord &&
      clientMissionRecord.messages &&
      clientMissionRecord.messages[messageKey],
    0,
  );
}

function getMissionLocalizedMessageEntry(clientMissionRecord, messageKey) {
  const entry =
    clientMissionRecord &&
    clientMissionRecord.localizedMessages &&
    clientMissionRecord.localizedMessages[messageKey];
  return entry && typeof entry === "object" ? entry : null;
}

function getMissionLocalizedMessageText(clientMissionRecord, messageKey) {
  const entry = getMissionLocalizedMessageEntry(clientMissionRecord, messageKey);
  return normalizeText(
    entry && entry.text,
    "",
  );
}

function getFirstMissionMessageID(clientMissionRecord, messageKeys) {
  const keys = Array.isArray(messageKeys) ? messageKeys : [messageKeys];
  for (const key of keys) {
    const messageID = getMissionMessageID(clientMissionRecord, key);
    if (messageID > 0) {
      return messageID;
    }
  }
  return 0;
}

function getFirstMissionLocalizedMessageText(clientMissionRecord, messageKeys) {
  const keys = Array.isArray(messageKeys) ? messageKeys : [messageKeys];
  for (const key of keys) {
    const text = getMissionLocalizedMessageText(clientMissionRecord, key);
    if (text) {
      return text;
    }
  }
  return "";
}

function getMissionLocalizedNameText(clientMissionRecord) {
  return normalizeText(
    clientMissionRecord &&
      clientMissionRecord.localizedName &&
      clientMissionRecord.localizedName.text,
    "",
  );
}

function buildMissionMessageReference(missionRecord, messageID) {
  const normalizedMessageID = normalizePositiveInteger(messageID, 0);
  if (!normalizedMessageID) {
    return null;
  }
  return normalizedMessageID;
}

function buildMissionProcessMessageReference(missionRecord, messageID) {
  const normalizedMessageID = normalizePositiveInteger(messageID, 0);
  if (!normalizedMessageID) {
    return null;
  }
  return buildMarshalTuple([
    normalizedMessageID,
    resolveClientMissionContentID(missionRecord),
  ]);
}

function buildMissionMessageReferenceByKeys(
  missionRecord,
  clientMissionRecord,
  messageKeys,
) {
  return buildMissionMessageReference(
    missionRecord,
    getFirstMissionMessageID(clientMissionRecord, messageKeys),
  );
}

function buildMissionProcessMessageReferenceByKeys(
  missionRecord,
  clientMissionRecord,
  messageKeys,
) {
  return buildMissionProcessMessageReference(
    missionRecord,
    getFirstMissionMessageID(clientMissionRecord, messageKeys),
  );
}

function buildConversationAgentSays(missionRecord, clientMissionRecord, messageKeys, fallbackText) {
  const keys = Array.isArray(messageKeys) ? messageKeys : [messageKeys];
  for (const key of keys) {
    const messageID = getMissionMessageID(clientMissionRecord, key);
    if (messageID > 0) {
      return [
        buildMissionMessageReference(missionRecord, messageID),
        resolveClientMissionContentID(missionRecord),
      ];
    }
  }
  const localizedText = getFirstMissionLocalizedMessageText(
    clientMissionRecord,
    keys,
  );
  if (localizedText) {
    return [
      localizedText,
      resolveClientMissionContentID(missionRecord),
    ];
  }
  return [
    normalizeText(fallbackText, ""),
    resolveClientMissionContentID(missionRecord),
  ];
}

function resolveMissionSiteSeed(missionRecord, agentRecord) {
  return [
    normalizePositiveInteger(missionRecord && missionRecord.missionSequence, 0),
    normalizePositiveInteger(agentRecord && agentRecord.agentID, 0),
    missionContentIDToText(missionRecord && missionRecord.contentID, ""),
  ].join(":");
}

function buildMissionDungeonSiteKey(characterID, missionRecord) {
  return `mission:${normalizePositiveInteger(characterID, 0)}:${normalizePositiveInteger(
    missionRecord && missionRecord.missionSequence,
    0,
  )}`;
}

function resolveMissionAnchorCelestial(solarSystemID, seed) {
  const celestials = worldData.getCelestialsForSystem(solarSystemID);
  const candidates = celestials.filter((celestial) => (
    celestial &&
    celestial.position &&
    normalizeText(celestial.kind, "").toLowerCase() !== "sun"
  ));
  if (candidates.length > 0) {
    return candidates[hashText(`${seed}:anchor`) % candidates.length];
  }
  return celestials.find((celestial) => celestial && celestial.position) || null;
}

function buildMissionSitePosition(solarSystemID, missionRecord, agentRecord) {
  const seed = resolveMissionSiteSeed(missionRecord, agentRecord);
  const anchor = resolveMissionAnchorCelestial(solarSystemID, seed);
  const base = anchor && anchor.position ? clonePosition(anchor.position) : { x: 0, y: 0, z: 0 };
  const angle = ((hashText(`${seed}:angle`) % 3600) / 3600) * Math.PI * 2;
  const distance =
    MISSION_SITE_DISTANCE_METERS +
    ((hashText(`${seed}:distance`) % (MISSION_SITE_DISTANCE_JITTER_METERS * 2 + 1)) -
      MISSION_SITE_DISTANCE_JITTER_METERS);
  const vertical =
    ((hashText(`${seed}:vertical`) % (MISSION_SITE_VERTICAL_JITTER_METERS * 2 + 1)) -
      MISSION_SITE_VERTICAL_JITTER_METERS);
  return addVectors(base, {
    x: Math.cos(angle) * distance,
    y: vertical,
    z: Math.sin(angle) * distance,
  });
}

function buildMissionSiteLocationWrap(agentRecord, missionRecord, missionTemplate = null) {
  const solarSystemID =
    normalizePositiveInteger(missionRecord && missionRecord.missionSystemID, 0) ||
    normalizePositiveInteger(agentRecord && agentRecord.solarSystemID, 0);
  const position = clonePosition(missionRecord && missionRecord.missionPosition);
  return {
    typeID: TYPE_SOLAR_SYSTEM,
    coords: buildMarshalTuple([position.x, position.y, position.z]),
    locationID: solarSystemID,
    shipTypeID: null,
    locationType: "dungeon",
    solarsystemID: solarSystemID,
    agentID: normalizePositiveInteger(agentRecord && agentRecord.agentID, 0),
    locationNumber: 0,
  };
}

function buildMissionBookmarkPayload(bookmarkRecord) {
  if (!bookmarkRecord || typeof bookmarkRecord !== "object") {
    return null;
  }
  const metadata =
    bookmarkRecord.metadata && typeof bookmarkRecord.metadata === "object"
      ? bookmarkRecord.metadata
      : {};
  const solarSystemID =
    normalizePositiveInteger(metadata.solarsystemID, 0) ||
    normalizePositiveInteger(bookmarkRecord.locationID, 0);
  const role = normalizeText(metadata.role, "").toLowerCase();
  const hasSpatialCoordinates = ["x", "y", "z"].every((axis) => (
    bookmarkRecord[axis] !== null &&
    bookmarkRecord[axis] !== undefined &&
    Number.isFinite(Number(bookmarkRecord[axis]))
  ));
  const fields = [
    ["itemID", normalizePositiveInteger(bookmarkRecord.itemID, 0) || null],
    ["typeID", normalizePositiveInteger(bookmarkRecord.typeID, TYPE_SOLAR_SYSTEM)],
    ["agentID", normalizePositiveInteger(metadata.agentID, 0) || null],
    ["hint", normalizeText(metadata.hint, "")],
    ["locationType", normalizeText(metadata.locationType, "")],
    ["memo", ""],
    ["isAgentBase", metadata.isAgentBase === true ? 1 : 0],
    ["locationNumber", role === "agenthomebase" ? -1 : 0],
  ];
  if (metadata.deadspace === true) {
    fields.push(["deadspace", true]);
  }
  fields.push(
    ["created", buildFiletimeLong(fileTimeStringToBigInt(bookmarkRecord.created))],
    ["flag", null],
    ["locationID", normalizePositiveInteger(bookmarkRecord.locationID, 0)],
    ["ownerID", normalizePositiveInteger(bookmarkRecord.creatorID, 0) || null],
    ["y", hasSpatialCoordinates ? buildMarshalReal(bookmarkRecord.y, 0) : 0],
    ["x", hasSpatialCoordinates ? buildMarshalReal(bookmarkRecord.x, 0) : 0],
    ["solarsystemID", solarSystemID],
    ["z", hasSpatialCoordinates ? buildMarshalReal(bookmarkRecord.z, 0) : 0],
  );
  return buildKeyVal(fields);
}

function listMissionBookmarks(characterID, missionRecord) {
  const bookmarkIDsByRole =
    missionRecord && missionRecord.bookmarkIDsByRole && typeof missionRecord.bookmarkIDsByRole === "object"
      ? missionRecord.bookmarkIDsByRole
      : {};
  return Object.values(bookmarkIDsByRole)
    .map((bookmarkID) => bookmarkRuntime.getBookmarkForCharacter(characterID, bookmarkID))
    .filter(Boolean)
    .map((bookmarkInfo) => buildMissionBookmarkPayload(bookmarkInfo.bookmark))
    .filter(Boolean);
}

function resolveStaticBookmarkTarget(stationID) {
  const station = worldData.getStationByID(stationID);
  if (!station) {
    return null;
  }
  return {
    itemID: normalizePositiveInteger(station.stationID, 0),
    typeID: normalizePositiveInteger(station.stationTypeID, TYPE_SOLAR_SYSTEM),
    locationID: normalizePositiveInteger(station.solarSystemID, 0),
    solarsystemID: normalizePositiveInteger(station.solarSystemID, 0),
  };
}

function ensureMissionBookmarkFolder(characterID) {
  const existingView = bookmarkRuntime.listFolderViews(characterID).find((view) => (
    view &&
    view.folder &&
    view.folder.isPersonal === true &&
    normalizeText(view.folder.folderName, "").toLowerCase() ===
      MISSION_BOOKMARK_FOLDER_NAME.toLowerCase()
  ));
  if (existingView && existingView.folder) {
    if (existingView.isActive === true) {
      try {
        bookmarkRuntime.updateKnownFolderState(
          characterID,
          existingView.folder.folderID,
          false,
        );
      } catch (_error) {
        // Ignore folder-state races and keep using the existing folder.
      }
    }
    return existingView.folder;
  }

  try {
    const createdView = bookmarkRuntime.addFolder(characterID, {
      folderName: MISSION_BOOKMARK_FOLDER_NAME,
      description: MISSION_BOOKMARK_FOLDER_DESCRIPTION,
      isPersonal: true,
    });
    if (createdView && createdView.folder) {
      try {
        bookmarkRuntime.updateKnownFolderState(
          characterID,
          createdView.folder.folderID,
          false,
        );
      } catch (_error) {
        // Folder was created; staying active is still better than failing hard.
      }
      return createdView.folder;
    }
  } catch (_error) {
    // Fall through to the normal personal folder as a safe fallback.
  }

  return bookmarkRuntime.ensureDefaultPersonalFolder(characterID);
}

function collectBookmarkIDsByFolder(bookmarks = []) {
  const bookmarkIDsByFolderID = new Map();
  for (const bookmark of Array.isArray(bookmarks) ? bookmarks : []) {
    const bookmarkID = normalizePositiveInteger(bookmark && bookmark.bookmarkID, 0);
    const folderID = normalizePositiveInteger(bookmark && bookmark.folderID, 0);
    if (!bookmarkID || !folderID) {
      continue;
    }
    if (!bookmarkIDsByFolderID.has(folderID)) {
      bookmarkIDsByFolderID.set(folderID, []);
    }
    bookmarkIDsByFolderID.get(folderID).push(bookmarkID);
  }
  return bookmarkIDsByFolderID;
}

function cleanupVisibleLegacyMissionBookmarks(characterID, agentRecord, missionRecord) {
  const activeBookmarkState = bookmarkRuntime.getMyActiveBookmarks(characterID);
  const visibleBookmarks = Array.isArray(activeBookmarkState && activeBookmarkState.bookmarks)
    ? activeBookmarkState.bookmarks
    : [];
  const expectedAgentID = normalizePositiveInteger(agentRecord && agentRecord.agentID, 0);
  const expectedMissionSiteID = normalizePositiveInteger(
    missionRecord && missionRecord.missionSiteID,
    0,
  );
  const expectedMissionInstanceID = normalizePositiveInteger(
    missionRecord && missionRecord.dungeonInstanceID,
    0,
  );
  const expectedMissionTitle = normalizeText(
    missionRecord && missionRecord.missionTitle,
    "",
  ).toLowerCase();
  const missionBookmarkFolderID = normalizePositiveInteger(
    ensureMissionBookmarkFolder(characterID).folderID,
    0,
  );

  const staleMissionBookmarks = visibleBookmarks.filter((bookmark) => {
    const metadata =
      bookmark && bookmark.metadata && typeof bookmark.metadata === "object"
        ? bookmark.metadata
        : {};
    const locationType = normalizeText(metadata.locationType, "");
    if (
      !["agenthomebase", "objective", "objective.source", "objective.destination", "dungeon"].includes(
        locationType,
      )
    ) {
      return false;
    }
    if (normalizePositiveInteger(bookmark && bookmark.folderID, 0) === missionBookmarkFolderID) {
      return false;
    }

    const bookmarkAgentID = normalizePositiveInteger(metadata.agentID, 0);
    const bookmarkReferringAgentID = normalizePositiveInteger(
      metadata.referringAgentID,
      0,
    );
    const bookmarkMissionSiteID = normalizePositiveInteger(metadata.missionSiteID, 0);
    const bookmarkMissionInstanceID = normalizePositiveInteger(metadata.missionInstanceID, 0);
    const bookmarkTitle = normalizeText(
      bookmark && (bookmark.memo || metadata.hint),
      "",
    ).toLowerCase();

    return (
      (expectedAgentID > 0 &&
        (bookmarkAgentID === expectedAgentID || bookmarkReferringAgentID === expectedAgentID)) ||
      (expectedMissionSiteID > 0 && bookmarkMissionSiteID === expectedMissionSiteID) ||
      (expectedMissionInstanceID > 0 && bookmarkMissionInstanceID === expectedMissionInstanceID) ||
      (expectedMissionTitle &&
        bookmarkTitle &&
        (bookmarkTitle.includes(expectedMissionTitle) ||
          expectedMissionTitle.includes(bookmarkTitle)))
    );
  });

  for (const [folderID, bookmarkIDs] of collectBookmarkIDsByFolder(staleMissionBookmarks).entries()) {
    try {
      bookmarkRuntime.deleteBookmarks(characterID, folderID, bookmarkIDs);
    } catch (_error) {
      // Ignore best-effort cleanup failures and proceed with fresh mission bookmarks.
    }
  }
}

function resolveMissionDungeonBookmarkPresentation(missionRecord, missionTemplate = null) {
  const dungeonTemplate = getDungeonMissionTemplateRecord(missionRecord);
  const presentationTemplate = dungeonTemplate || missionTemplate || null;
  const populationHints = normalizeObject(
    presentationTemplate && presentationTemplate.populationHints,
  );
  const missionPresentation = normalizeObject(
    (presentationTemplate && presentationTemplate.missionPresentation) ||
      populationHints.missionPresentation,
  );
  const explicitDeadspaceValues = normalizeArray(populationHints.encounters)
    .filter((encounter) => (
      encounter && Object.prototype.hasOwnProperty.call(encounter, "deadspace")
    ))
    .map((encounter) => encounter.deadspace === true);
  const hasAccelerationGate = normalizeArray(
    presentationTemplate &&
      presentationTemplate.siteSceneProfile &&
      presentationTemplate.siteSceneProfile.gateProfiles,
  ).length > 0;
  const deadspace = typeof missionPresentation.bookmarkDeadspace === "boolean"
    ? missionPresentation.bookmarkDeadspace
    : explicitDeadspaceValues.includes(true) || hasAccelerationGate;
  const category = normalizeText(
    missionPresentation.bookmarkCategory,
    isMiningMissionRecord(missionRecord) ? "Mining" : "Encounter",
  );
  return {
    deadspace,
    hint: normalizeText(
      missionPresentation.bookmarkHint,
      `UI/Agents/Bookmarks/${category}/${deadspace ? "Deadspace" : category}`,
    ),
  };
}

function ensureMissionBookmarks(characterID, agentRecord, missionRecord, missionTemplate = null) {
  cleanupMissionBookmarks(characterID, missionRecord);
  cleanupVisibleLegacyMissionBookmarks(characterID, agentRecord, missionRecord);

  const folder = ensureMissionBookmarkFolder(characterID);
  const bookmarkIDsByRole = {};
  const sourceAgentID = normalizePositiveInteger(agentRecord && agentRecord.agentID, 0);
  const addBookmark = (role, data) => {
    const result = bookmarkRuntime.createBookmark(characterID, {
      folderID: folder.folderID,
      memo: "",
      note: "",
      ...data,
      metadata: {
        ...(data && data.metadata && typeof data.metadata === "object"
          ? data.metadata
          : {}),
        role,
        agentID: sourceAgentID,
        referringAgentID: sourceAgentID,
      },
    });
    const bookmarkID = normalizePositiveInteger(
      result && result.bookmark && result.bookmark.bookmarkID,
      0,
    );
    if (bookmarkID > 0) {
      bookmarkIDsByRole[role] = bookmarkID;
    }
  };
  const addLocationBookmark = (role, location, options = {}) => {
    const locationID = normalizePositiveInteger(location && location.locationID, 0);
    if (!locationID) {
      return;
    }
    const station = worldData.getStationByID(locationID);
    const solarSystemID = normalizePositiveInteger(
      location && location.solarsystemID,
      normalizePositiveInteger(station && station.solarSystemID, 0),
    );
    const hasCoordinates = options.includeCoordinates !== false &&
      ["x", "y", "z"].every((axis) => (
        location[axis] !== null &&
        location[axis] !== undefined &&
        Number.isFinite(Number(location && location[axis]))
      ));
    addBookmark(role, {
      itemID:
        normalizePositiveInteger(options.itemID, 0) ||
        normalizePositiveInteger(station && station.stationID, 0) ||
        locationID,
      typeID:
        normalizePositiveInteger(station && station.stationTypeID, 0) ||
        normalizePositiveInteger(location && location.typeID, TYPE_SOLAR_SYSTEM),
      locationID: solarSystemID,
      ...(hasCoordinates
        ? {
            x: Number(location.x),
            y: Number(location.y),
            z: Number(location.z),
          }
        : {}),
      metadata: {
        locationType: options.locationType,
        hint: options.hint,
        solarsystemID: solarSystemID,
        isAgentBase: options.isAgentBase === true,
      },
    });
  };

  if (missionRecord.objectiveMode === OBJECTIVE_TYPE_TRANSPORT) {
    addLocationBookmark("source", missionRecord.pickupLocation, {
      locationType: "objective.source",
      hint: "UI/Agents/Bookmarks/Objective/Pickup",
      isAgentBase: false,
    });
    addLocationBookmark("destination", missionRecord.dropoffLocation, {
      locationType: "objective.destination",
      hint: "UI/Agents/Bookmarks/Objective/DropOffAgentBase",
      isAgentBase: true,
    });
  } else if (
    isFetchMissionRecord(missionRecord) ||
    isAgentObjectiveMissionRecord(missionRecord) ||
    isDungeonFetchMissionRecord(missionRecord) ||
    isMiningMissionRecord(missionRecord)
  ) {
    const targetAgentID = isAgentObjectiveMissionRecord(missionRecord)
      ? getMissionConversationTargetAgentID(missionRecord, sourceAgentID)
      : 0;
    addLocationBookmark("objective", missionRecord.dropoffLocation, {
      locationType: "objective",
      hint: "UI/Agents/Bookmarks/Objective/AgentBase",
      isAgentBase: true,
      includeCoordinates: !isAgentObjectiveMissionRecord(missionRecord),
      itemID:
        targetAgentID > 0 &&
        !worldData.getStationByID(
          missionRecord &&
            missionRecord.dropoffLocation &&
            missionRecord.dropoffLocation.locationID,
        )
          ? targetAgentID
          : 0,
    });
  }

  if (
    missionRecord.objectiveMode === OBJECTIVE_TYPE_DUNGEON &&
    missionRecord.missionPosition
  ) {
    const dungeonPresentation = resolveMissionDungeonBookmarkPresentation(
      missionRecord,
      missionTemplate,
    );
    addBookmark("dungeon", {
      itemID: normalizePositiveInteger(missionRecord.missionSystemID, 0),
      typeID: TYPE_SOLAR_SYSTEM,
      locationID: normalizePositiveInteger(missionRecord.missionSystemID, 0),
      x: missionRecord.missionPosition.x,
      y: missionRecord.missionPosition.y,
      z: missionRecord.missionPosition.z,
      metadata: {
        locationType: "dungeon",
        hint: dungeonPresentation.hint,
        deadspace: dungeonPresentation.deadspace,
        solarsystemID: normalizePositiveInteger(missionRecord.missionSystemID, 0),
        isAgentBase: false,
        missionInstanceID:
          normalizePositiveInteger(missionRecord.dungeonInstanceID, 0) || null,
        missionSiteID: normalizePositiveInteger(missionRecord.missionSiteID, 0) || null,
      },
    });
  }

  addLocationBookmark("agenthomebase", buildAgentLocationWrap(agentRecord), {
    locationType: "agenthomebase",
    hint: "UI/Agents/Bookmarks/AgentBase",
    isAgentBase: true,
  });

  return bookmarkIDsByRole;
}

function cleanupMissionBookmarks(characterID, missionRecord) {
  const bookmarkIDs = Object.values(
    missionRecord && missionRecord.bookmarkIDsByRole && typeof missionRecord.bookmarkIDsByRole === "object"
      ? missionRecord.bookmarkIDsByRole
      : {},
  )
    .map((bookmarkID) => normalizePositiveInteger(bookmarkID, 0))
    .filter(Boolean);
  for (const bookmarkID of bookmarkIDs) {
    const bookmarkInfo = bookmarkRuntime.getBookmarkForCharacter(characterID, bookmarkID);
    if (!bookmarkInfo || !bookmarkInfo.folder) {
      continue;
    }
    try {
      bookmarkRuntime.deleteBookmarks(
        characterID,
        bookmarkInfo.folder.folderID,
        [bookmarkID],
      );
    } catch (_error) {
      // Mission cleanup should not fail hard if a bookmark was already removed.
    }
  }
}

function ensureMissionSiteState(characterID, agentRecord, missionRecord, missionTemplate = null) {
  const nextRecord = cloneValue(missionRecord);
  if (nextRecord.objectiveMode === OBJECTIVE_TYPE_TRANSPORT) {
    if (
      nextRecord.cargo &&
      nextRecord.pickupLocation &&
      normalizePositiveInteger(nextRecord.pickupLocation.locationID, 0) > 0 &&
      nextRecord.cargo.granted !== true
    ) {
      const grantResult = grantItemsToCharacterStationHangar(
        characterID,
        nextRecord.pickupLocation.locationID,
        [{
          itemType: nextRecord.cargo.typeID,
          quantity: nextRecord.cargo.quantity,
        }],
      );
      if (grantResult && grantResult.success === true) {
        nextRecord.cargo.granted = true;
        notifyMissionInventoryChanges(
          characterID,
          (grantResult.data && grantResult.data.changes) || [],
        );
      }
    }
    nextRecord.bookmarkIDsByRole = ensureMissionBookmarks(
      characterID,
      agentRecord,
      nextRecord,
      missionTemplate,
    );
    return nextRecord;
  }

  if (isFetchMissionRecord(nextRecord) || isAgentObjectiveMissionRecord(nextRecord)) {
    nextRecord.bookmarkIDsByRole = ensureMissionBookmarks(
      characterID,
      agentRecord,
      nextRecord,
      missionTemplate,
    );
    return nextRecord;
  }

  const missionSystemID =
    normalizePositiveInteger(nextRecord.missionSystemID, 0) ||
    normalizePositiveInteger(agentRecord && agentRecord.solarSystemID, 0);
  const missionPosition =
    nextRecord.missionPosition && typeof nextRecord.missionPosition === "object"
      ? clonePosition(nextRecord.missionPosition)
      : buildMissionSitePosition(missionSystemID, nextRecord, agentRecord);
  const missionSiteID =
    normalizePositiveInteger(nextRecord.missionSiteID, 0) ||
    (MISSION_SITE_ID_OFFSET + normalizePositiveInteger(nextRecord.missionSequence, 0));
  let dungeonInstanceID = normalizePositiveInteger(nextRecord.dungeonInstanceID, 0) || null;

  const runtimeInstanceTemplate = getMissionInstanceTemplateRecord(nextRecord);
  const runtimeInstanceTemplateID = normalizeText(
    runtimeInstanceTemplate && runtimeInstanceTemplate.templateID,
    normalizeText(nextRecord.dungeonTemplateID, ""),
  );
  if (dungeonInstanceID) {
    const existingInstance = dungeonRuntime.getInstance(dungeonInstanceID);
    if (!existingInstance) {
      dungeonInstanceID = null;
    } else if (
      runtimeInstanceTemplateID &&
      normalizeText(existingInstance && existingInstance.templateID, "") !== runtimeInstanceTemplateID
    ) {
      try {
        dungeonRuntime.purgeInstance(dungeonInstanceID);
      } catch (error) {
        // Ignore stale runtime rows that may already have been cleaned up elsewhere.
      }
      dungeonInstanceID = null;
    }
  }

  if (!dungeonInstanceID && runtimeInstanceTemplateID) {
    const existingInstance = dungeonRuntime.findInstanceBySiteKey(
      buildMissionDungeonSiteKey(characterID, nextRecord),
      {
        activeOnly: true,
        full: true,
      },
    );
    const existingInstanceTemplateID = normalizeText(
      existingInstance && existingInstance.templateID,
      "",
    );
    if (
      existingInstance &&
      runtimeInstanceTemplateID &&
      existingInstanceTemplateID &&
      existingInstanceTemplateID !== runtimeInstanceTemplateID
    ) {
      try {
        dungeonRuntime.purgeInstance(
          normalizePositiveInteger(existingInstance && existingInstance.instanceID, 0),
        );
      } catch (_error) {
        // Ignore stale mission-pocket rows that were already partially cleaned up.
      }
      dungeonInstanceID = null;
    } else {
      dungeonInstanceID =
        normalizePositiveInteger(existingInstance && existingInstance.instanceID, 0) || null;
    }
  }

  if (!dungeonInstanceID && runtimeInstanceTemplateID) {
    const createdInstance = dungeonRuntime.createInstance({
      templateID: runtimeInstanceTemplateID,
      solarSystemID: missionSystemID,
      position: missionPosition,
      lifecycleState: "active",
      siteKey: buildMissionDungeonSiteKey(characterID, nextRecord),
      siteKind: "mission",
      siteOrigin: "agentMission",
      instanceScope: "private",
      ownership: {
        visibilityScope: "private",
        characterID,
        missionOwnerCharacterID: characterID,
      },
      metadata: {
        siteID: missionSiteID,
        label: normalizeText(nextRecord.missionTitle, "Mission Site"),
        missionRuntime: true,
        missionAgentID: normalizePositiveInteger(agentRecord && agentRecord.agentID, 0),
        missionSequence: normalizePositiveInteger(nextRecord.missionSequence, 0),
        missionCharacterID: characterID,
        missionContentID: normalizeMissionContentID(nextRecord.contentID, null),
        missionPresentationTemplateID: normalizeText(nextRecord.missionTemplateID, "") ||
          normalizeText(nextRecord.dungeonTemplateID, "") ||
          null,
        missionRuntimeTemplateID: runtimeInstanceTemplateID || null,
      },
      runtimeFlags: {
        missionRuntime: true,
      },
    });
    dungeonInstanceID = normalizePositiveInteger(createdInstance && createdInstance.instanceID, 0) || null;
  }

  nextRecord.missionSystemID = missionSystemID;
  nextRecord.missionPosition = missionPosition;
  nextRecord.missionSiteID = missionSiteID;
  nextRecord.dungeonInstanceID = dungeonInstanceID;
  nextRecord.bookmarkIDsByRole = ensureMissionBookmarks(
    characterID,
    agentRecord,
    nextRecord,
    missionTemplate,
  );
  return nextRecord;
}

function listCharacterCargoStacks(characterID, locationID, flagID, typeID) {
  return listContainerItems(characterID, locationID, flagID)
    .filter((item) => normalizePositiveInteger(item && item.typeID, 0) === normalizePositiveInteger(typeID, 0));
}

function sumItemStackQuantity(items = []) {
  return (Array.isArray(items) ? items : []).reduce((sum, item) => (
    sum + (normalizePositiveInteger(item && item.singleton, 0) === 1
      ? 1
      : Math.max(0, normalizeInteger(item && (item.stacksize || item.quantity), 0)))
  ), 0);
}

function getCourierProgress(characterID, missionRecord) {
  const cargo = missionRecord && missionRecord.cargo ? missionRecord.cargo : null;
  if (!cargo) {
    return {
      sourceHangarQuantity: 0,
      shipCargoQuantity: 0,
      destinationHangarQuantity: 0,
    };
  }
  const pickupLocationID = normalizePositiveInteger(
    missionRecord && missionRecord.pickupLocation && missionRecord.pickupLocation.locationID,
    0,
  );
  const dropoffLocationID = normalizePositiveInteger(
    missionRecord && missionRecord.dropoffLocation && missionRecord.dropoffLocation.locationID,
    0,
  );
  const activeShip = getActiveShipItem(characterID);
  return {
    sourceHangarQuantity: pickupLocationID > 0
      ? sumItemStackQuantity(
          listCharacterCargoStacks(
            characterID,
            pickupLocationID,
            ITEM_FLAGS.HANGAR,
            cargo.typeID,
          ),
        )
      : 0,
    shipCargoQuantity:
      activeShip && normalizePositiveInteger(activeShip.itemID, 0) > 0
        ? sumItemStackQuantity(
            listCharacterCargoStacks(
              characterID,
              activeShip.itemID,
              ITEM_FLAGS.CARGO_HOLD,
              cargo.typeID,
            ),
          )
        : 0,
    destinationHangarQuantity: dropoffLocationID > 0
      ? sumItemStackQuantity(
          listCharacterCargoStacks(
            characterID,
            dropoffLocationID,
            ITEM_FLAGS.HANGAR,
            cargo.typeID,
          ),
        )
      : 0,
  };
}

function notifyMissionInventoryChanges(characterID, changes = []) {
  const normalizedCharacterID = normalizePositiveInteger(characterID, 0);
  const liveSession = getPreferredCharacterSession(normalizedCharacterID);
  if (!liveSession) {
    notifyInventoryChangesToCharacter(normalizedCharacterID, changes);
    return;
  }

  notifyInventoryChangesToCharacter(normalizedCharacterID, changes, {
    excludeSession: liveSession,
  });

  const dockedLocationID = normalizePositiveInteger(
    getDockedLocationID(liveSession),
    0,
  );
  for (const change of Array.isArray(changes) ? changes : []) {
    const previousState = normalizeObject(
      change && (change.previousData || change.previousState),
    );
    const notificationItem =
      change && change.item
        ? change.item
        : (
          change &&
          change.removed === true &&
          Object.keys(previousState).length > 0
        )
          ? buildRemovedItemNotificationState(previousState)
          : null;
    if (!notificationItem) {
      continue;
    }
    const currentLocationID = normalizePositiveInteger(notificationItem.locationID, 0);
    const previousLocationID = normalizePositiveInteger(previousState.locationID, 0);
    const currentFlagID = normalizeInteger(notificationItem.flagID, 0);
    const previousFlagID = normalizeInteger(previousState.flagID, 0);
    const touchesDockedHangar =
      dockedLocationID > 0 &&
      (
        (currentLocationID === dockedLocationID && currentFlagID === ITEM_FLAGS.HANGAR) ||
        (previousLocationID === dockedLocationID && previousFlagID === ITEM_FLAGS.HANGAR)
      );
    syncInventoryItemForSession(
      liveSession,
      notificationItem,
      previousState,
      {
        emitCfgLocation: touchesDockedHangar,
      },
    );
  }
}

function isMissionDungeonObjectiveSatisfied(missionRecord) {
  const instance = normalizePositiveInteger(missionRecord && missionRecord.dungeonInstanceID, 0)
    ? dungeonRuntime.getInstance(missionRecord.dungeonInstanceID)
    : null;
  const objectiveState = normalizeObject(instance && instance.objectiveState);
  return Boolean(
    instance &&
    (
      normalizeText(objectiveState.state, "").toLowerCase() === "completed" ||
      normalizePositiveInteger(objectiveState.completedAtMs, 0) > 0 ||
      normalizeText(instance.lifecycleState, "").toLowerCase() === "completed" ||
      normalizePositiveInteger(instance.objectiveSatisfiedAtMs, 0) > 0
    )
  );
}

function evaluateMissionProgress(characterID, missionRecord) {
  const nextRecord = cloneValue(missionRecord);
  if (!nextRecord) {
    return null;
  }

  if (normalizeBoolean(nextRecord.gmCompleted, false)) {
    if (nextRecord.cargo && typeof nextRecord.cargo === "object") {
      nextRecord.cargo = {
        ...nextRecord.cargo,
        hasCargo: true,
        granted: nextRecord.cargo.granted === true,
      };
    }
    nextRecord.objectiveCompleted = true;
    return nextRecord;
  }

  if (nextRecord.objectiveMode === OBJECTIVE_TYPE_TRANSPORT) {
    const progress = getCourierProgress(characterID, nextRecord);
    const requiredQuantity = Math.max(1, normalizeInteger(nextRecord.cargo && nextRecord.cargo.quantity, 1));
    const currentDockedLocationID = normalizePositiveInteger(
      getDockedLocationID(getPreferredCharacterSession(characterID)),
      0,
    );
    const dropoffLocationID = normalizePositiveInteger(
      nextRecord &&
        nextRecord.dropoffLocation &&
        nextRecord.dropoffLocation.locationID,
      0,
    );
    const dockedAtDropoff =
      currentDockedLocationID > 0 &&
      currentDockedLocationID === dropoffLocationID;
    const hasCargo =
      progress.shipCargoQuantity >= requiredQuantity ||
      progress.destinationHangarQuantity >= requiredQuantity;
    nextRecord.cargo = {
      ...(nextRecord.cargo || resolvePlaceholderCargo()),
      hasCargo,
      granted: nextRecord.cargo && nextRecord.cargo.granted === true,
    };
    nextRecord.objectiveCompleted =
      progress.destinationHangarQuantity >= requiredQuantity ||
      (dockedAtDropoff && progress.shipCargoQuantity >= requiredQuantity);
    return nextRecord;
  }

  if (isFetchMissionRecord(nextRecord)) {
    const itemSpec = nextRecord.cargo || resolvePlaceholderCargo();
    const progress = buildMissionItemProgressSnapshot(characterID, nextRecord, itemSpec, {
      destinationLocationID: normalizePositiveInteger(
        nextRecord &&
          nextRecord.dropoffLocation &&
          nextRecord.dropoffLocation.locationID,
        0,
      ),
      currentStationID: normalizePositiveInteger(
        nextRecord &&
          nextRecord.dropoffLocation &&
          nextRecord.dropoffLocation.locationID,
        0,
      ),
    });
    const requiredQuantity = Math.max(1, normalizeInteger(itemSpec && itemSpec.quantity, 1));
    const currentDockedLocationID = normalizePositiveInteger(
      getDockedLocationID(getPreferredCharacterSession(characterID)),
      0,
    );
    const dropoffLocationID = normalizePositiveInteger(
      nextRecord &&
        nextRecord.dropoffLocation &&
        nextRecord.dropoffLocation.locationID,
      0,
    );
    const dockedAtDropoff =
      currentDockedLocationID > 0 &&
      currentDockedLocationID === dropoffLocationID;
    nextRecord.cargo = {
      ...itemSpec,
      hasCargo:
        progress.shipCargoQuantity >= requiredQuantity ||
        progress.destinationHangarQuantity >= requiredQuantity,
      granted: false,
    };
    nextRecord.objectiveCompleted =
      progress.destinationHangarQuantity >= requiredQuantity ||
      (dockedAtDropoff && progress.shipCargoQuantity >= requiredQuantity);
    return nextRecord;
  }

  if (isAgentObjectiveMissionRecord(nextRecord)) {
    return nextRecord;
  }

  // Explicit satisfaction (objective-target destroyed, mining reached, fetch items granted)
  // is honored immediately, without waiting for a later behavior tick to promote the instance.
  const dungeonObjectiveCompleted = isMissionDungeonObjectiveSatisfied(nextRecord);

  // Dungeon-fetch missions (cargo spec stamped from killMission.objectiveTypeID) additionally
  // require the objective items delivered to the dropoff before the journal completes —
  // TQ contract: MissionFetch -> FetchObjectAcquiredDungeonDone -> AllObjectivesComplete.
  if (nextRecord.cargo && typeof nextRecord.cargo === "object") {
    const itemSpec = nextRecord.cargo;
    const dropoffLocationID = normalizePositiveInteger(
      nextRecord &&
        nextRecord.dropoffLocation &&
        nextRecord.dropoffLocation.locationID,
      0,
    );
    const progress = buildMissionItemProgressSnapshot(characterID, nextRecord, itemSpec, {
      destinationLocationID: dropoffLocationID,
      currentStationID: dropoffLocationID,
    });
    const requiredQuantity = Math.max(1, normalizeInteger(itemSpec && itemSpec.quantity, 1));
    const currentDockedLocationID = normalizePositiveInteger(
      getDockedLocationID(getPreferredCharacterSession(characterID)),
      0,
    );
    const dockedAtDropoff =
      currentDockedLocationID > 0 &&
      currentDockedLocationID === dropoffLocationID;
    nextRecord.cargo = {
      ...itemSpec,
      hasCargo:
        progress.shipCargoQuantity >= requiredQuantity ||
        progress.destinationHangarQuantity >= requiredQuantity,
      granted: itemSpec.granted === true,
    };
    nextRecord.objectiveCompleted =
      dungeonObjectiveCompleted &&
      (
        progress.destinationHangarQuantity >= requiredQuantity ||
        (dockedAtDropoff && progress.shipCargoQuantity >= requiredQuantity)
      );
    return nextRecord;
  }

  nextRecord.objectiveCompleted = dungeonObjectiveCompleted;
  return nextRecord;
}

function syncMissionRecordState(characterID, agentID, options = {}) {
  const missionRecord = getMissionRecord(characterID, agentID);
  if (!missionRecord) {
    return null;
  }
  const updatedMissionRecord = evaluateMissionProgress(characterID, missionRecord);
  if (!updatedMissionRecord) {
    return null;
  }
  const changed =
    JSON.stringify({
      objectiveCompleted: missionRecord.objectiveCompleted,
      cargo: missionRecord.cargo || null,
    }) !== JSON.stringify({
      objectiveCompleted: updatedMissionRecord.objectiveCompleted,
      cargo: updatedMissionRecord.cargo || null,
    });
  if (!changed) {
    return updatedMissionRecord;
  }
  const completionChanged =
    normalizeBoolean(missionRecord && missionRecord.objectiveCompleted, false) !==
    normalizeBoolean(updatedMissionRecord && updatedMissionRecord.objectiveCompleted, false);
  mutateCharacterState(characterID, (characterState) => {
    const storedMission = characterState.missionsByAgentID[String(agentID)];
    if (!storedMission) {
      return null;
    }
    storedMission.objectiveCompleted = updatedMissionRecord.objectiveCompleted;
    storedMission.cargo = cloneValue(updatedMissionRecord.cargo || null);
    storedMission.lastUpdatedAtMs = Date.now();
    return cloneValue(storedMission);
  });
  if (options.notifyTracker !== false) {
    notifyMissionTrackerUpdate(characterID, agentID);
  }
  if (completionChanged && options.notifyMissionChange !== false) {
    notifyMissionChange(characterID, AGENT_MISSION_MODIFIED, agentID);
  }
  return getMissionRecord(characterID, agentID) || updatedMissionRecord;
}

function syncMissionRecordForDungeonInstance(instanceOrID, options = {}) {
  const instance = instanceOrID && typeof instanceOrID === "object"
    ? instanceOrID
    : dungeonRuntime.getInstance(normalizePositiveInteger(instanceOrID, 0));
  if (!instance) {
    return null;
  }
  const metadata = normalizeObject(instance.metadata);
  const ownership = normalizeObject(instance.ownership);
  const characterID =
    normalizePositiveInteger(options.characterID, 0) ||
    normalizePositiveInteger(metadata.missionCharacterID, 0) ||
    normalizePositiveInteger(ownership.missionOwnerCharacterID, 0) ||
    normalizePositiveInteger(ownership.characterID, 0);
  const agentID =
    normalizePositiveInteger(options.agentID, 0) ||
    normalizePositiveInteger(metadata.missionAgentID, 0);
  const instanceID = normalizePositiveInteger(instance.instanceID, 0);
  if (!characterID || !agentID || !instanceID) {
    return null;
  }
  const missionRecord = getMissionRecord(characterID, agentID);
  if (
    !missionRecord ||
    normalizeText(missionRecord.runtimeStatus, "offered") !== "accepted" ||
    normalizePositiveInteger(missionRecord.dungeonInstanceID, 0) !== instanceID
  ) {
    return null;
  }
  return syncMissionRecordState(characterID, agentID, {
    notifyTracker: options.notifyTracker !== false,
    notifyMissionChange: options.notifyMissionChange === true,
  });
}

function buildMissionTrackerInfoTuple(characterID, missionRecord, options = {}) {
  const currentTuple = resolveMissionObjectiveState(
    characterID,
    missionRecord,
    options,
  ).current;
  const items = getTupleItems(currentTuple);
  if (items.length <= 0) {
    return null;
  }
  return buildMarshalTuple(items.map((item, index) => (
    index === 0 || item === null || item === undefined ? item : String(item)
  )));
}

function getTupleItems(tupleValue) {
  if (
    tupleValue &&
    ["tuple", "list"].includes(tupleValue.type) &&
    Array.isArray(tupleValue.items)
  ) {
    return tupleValue.items;
  }
  return Array.isArray(tupleValue) ? tupleValue : [];
}

function getTupleKey(tupleValue) {
  return normalizeText(getTupleItems(tupleValue)[0], "");
}

function buildMissionItemProgressSnapshot(characterID, missionRecord, itemSpec, options = {}) {
  if (!itemSpec || normalizePositiveInteger(itemSpec.typeID, 0) <= 0) {
    return {
      sourceHangarQuantity: 0,
      destinationHangarQuantity: 0,
      currentStationHangarQuantity: 0,
      shipCargoQuantity: 0,
      totalQuantity: 0,
    };
  }

  const sourceLocationID = normalizePositiveInteger(options.sourceLocationID, 0);
  const destinationLocationID = normalizePositiveInteger(options.destinationLocationID, 0);
  const currentStationID = normalizePositiveInteger(options.currentStationID, 0);
  const typeID = normalizePositiveInteger(itemSpec.typeID, 0);
  const activeShip = getActiveShipItem(characterID);

  const countHangarStacks = (locationID) => (
    locationID > 0
      ? sumItemStackQuantity(
          listCharacterCargoStacks(
            characterID,
            locationID,
            ITEM_FLAGS.HANGAR,
            typeID,
          ),
        )
      : 0
  );

  const sourceHangarQuantity = countHangarStacks(sourceLocationID);
  const destinationHangarQuantity = countHangarStacks(destinationLocationID);
  const currentStationHangarQuantity = countHangarStacks(currentStationID);
  const shipCargoQuantity =
    activeShip && normalizePositiveInteger(activeShip.itemID, 0) > 0
      ? sumItemStackQuantity(
          listCharacterCargoStacks(
            characterID,
            activeShip.itemID,
            ITEM_FLAGS.CARGO_HOLD,
            typeID,
          ),
        )
      : 0;
  const uniqueHangarLocations = [...new Set(
    [sourceLocationID, destinationLocationID, currentStationID].filter(Boolean),
  )];
  const totalQuantity = shipCargoQuantity + uniqueHangarLocations.reduce(
    (sum, locationID) => sum + countHangarStacks(locationID),
    0,
  );

  return {
    sourceHangarQuantity,
    destinationHangarQuantity,
    currentStationHangarQuantity,
    shipCargoQuantity,
    totalQuantity,
  };
}

function resolveMissionTrackerDungeonContext(characterID, missionRecord, options = {}) {
  const session = options.session || getPreferredCharacterSession(characterID);
  const spaceRuntime = getSpaceRuntime();
  const scene =
    session && spaceRuntime && typeof spaceRuntime.getSceneForSession === "function"
      ? spaceRuntime.getSceneForSession(session)
      : null;
  const tracked =
    scene && session
      ? dungeonTrackingRuntime.resolveTrackedDungeonForSession(scene, session)
      : null;
  const missionInstanceID = normalizePositiveInteger(
    missionRecord && missionRecord.dungeonInstanceID,
    0,
  );
  return {
    session,
    scene,
    tracked:
      tracked &&
      normalizePositiveInteger(tracked.instance && tracked.instance.instanceID, 0) ===
        missionInstanceID
        ? tracked
        : null,
  };
}

function listSceneStaticEntities(scene) {
  const entities = [];
  const seenIDs = new Set();
  const addEntity = (entity) => {
    if (!entity || typeof entity !== "object") {
      return;
    }
    const itemID = normalizePositiveInteger(entity.itemID, 0);
    const identity = itemID > 0 ? `item:${itemID}` : entity;
    if (seenIDs.has(identity)) {
      return;
    }
    seenIDs.add(identity);
    entities.push(entity);
  };
  for (const entity of normalizeArray(scene && scene.staticEntities)) {
    addEntity(entity);
  }
  if (scene && scene.staticEntitiesByID instanceof Map) {
    for (const entity of scene.staticEntitiesByID.values()) {
      addEntity(entity);
    }
  }
  return entities;
}

function getSceneEntityByID(scene, entityID) {
  const normalizedEntityID = normalizePositiveInteger(entityID, 0);
  if (!scene || normalizedEntityID <= 0) {
    return null;
  }
  if (typeof scene.getEntityByID === "function") {
    const entity = scene.getEntityByID(normalizedEntityID);
    if (entity) {
      return entity;
    }
  }
  if (scene.dynamicEntities instanceof Map) {
    const entity = scene.dynamicEntities.get(normalizedEntityID);
    if (entity) {
      return entity;
    }
  }
  if (scene.staticEntitiesByID instanceof Map) {
    const entity = scene.staticEntitiesByID.get(normalizedEntityID);
    if (entity) {
      return entity;
    }
  }
  return listSceneStaticEntities(scene).find((entity) => (
    normalizePositiveInteger(entity && entity.itemID, 0) === normalizedEntityID
  )) || null;
}

function listSceneEntities(scene) {
  const entities = [...listSceneStaticEntities(scene)];
  const seenIDs = new Set(
    entities
      .map((entity) => normalizePositiveInteger(entity && entity.itemID, 0))
      .filter(Boolean),
  );
  if (scene && scene.dynamicEntities instanceof Map) {
    for (const entity of scene.dynamicEntities.values()) {
      const itemID = normalizePositiveInteger(entity && entity.itemID, 0);
      if (itemID > 0 && !seenIDs.has(itemID)) {
        seenIDs.add(itemID);
        entities.push(entity);
      }
    }
  }
  return entities;
}

function listActiveMissionEncounterEntityIDs(instance, tracked = null) {
  const objectiveState = normalizeObject(instance && instance.objectiveState);
  const objectiveMetadata = normalizeObject(objectiveState.metadata);
  const objectiveCounters = normalizeObject(objectiveState.counters);
  const currentRoomKey = normalizeText(
    (tracked && tracked.roomKey) || objectiveMetadata.currentRoomKey,
    "",
  );
  const currentWave = Math.max(
    0,
    normalizeInteger(
      objectiveMetadata.currentWave,
      normalizeInteger(objectiveCounters.current_wave, 0),
    ),
  );
  const encounterStates = Object.values(normalizeObject(
    instance &&
      instance.spawnState &&
      instance.spawnState.encounterStatesByKey,
  ))
    .map((encounterState, index) => ({
      encounterState: normalizeObject(encounterState),
      index,
    }))
    .filter(({ encounterState }) => (
      normalizeArray(encounterState.remainingEntityIDs).some(
        (entityID) => normalizePositiveInteger(entityID, 0) > 0,
      )
    ))
    .sort((left, right) => {
      const leftRoomKey = normalizeText(left.encounterState.roomKey, "");
      const rightRoomKey = normalizeText(right.encounterState.roomKey, "");
      const leftRoomMatch = currentRoomKey && leftRoomKey === currentRoomKey ? 1 : 0;
      const rightRoomMatch = currentRoomKey && rightRoomKey === currentRoomKey ? 1 : 0;
      const leftWave = Math.max(0, normalizeInteger(left.encounterState.waveIndex, 0));
      const rightWave = Math.max(0, normalizeInteger(right.encounterState.waveIndex, 0));
      const leftWaveMatch = currentWave > 0 && leftWave === currentWave ? 1 : 0;
      const rightWaveMatch = currentWave > 0 && rightWave === currentWave ? 1 : 0;
      return (
        rightRoomMatch - leftRoomMatch ||
        rightWaveMatch - leftWaveMatch ||
        rightWave - leftWave ||
        Math.max(0, normalizeInteger(right.encounterState.spawnedAtMs, 0)) -
          Math.max(0, normalizeInteger(left.encounterState.spawnedAtMs, 0)) ||
        left.index - right.index
      );
    });

  const entityIDs = [];
  for (const { encounterState } of encounterStates) {
    for (const entityID of [
      ...normalizeArray(encounterState.objectiveBlockingEntityIDs),
      ...normalizeArray(encounterState.remainingEntityIDs),
    ]) {
      const normalizedEntityID = normalizePositiveInteger(entityID, 0);
      if (normalizedEntityID > 0 && !entityIDs.includes(normalizedEntityID)) {
        entityIDs.push(normalizedEntityID);
      }
    }
  }
  return entityIDs;
}

function findNextMissionGateEntityID(characterID, missionRecord, options = {}) {
  const explicitGateEntityID = normalizePositiveInteger(options.gateEntityID, 0);
  if (explicitGateEntityID > 0) {
    return explicitGateEntityID;
  }
  const instanceID = normalizePositiveInteger(
    missionRecord && missionRecord.dungeonInstanceID,
    0,
  );
  const instance = instanceID > 0 ? dungeonRuntime.getInstance(instanceID) : null;
  if (!instance) {
    return 0;
  }
  const { scene, tracked } = resolveMissionTrackerDungeonContext(
    characterID,
    missionRecord,
    options,
  );
  const currentRoomKey = normalizeText(tracked && tracked.roomKey, "");
  const gateStatesByKey = normalizeObject(instance.gateStatesByKey);
  const candidateGateKeys = Object.entries(gateStatesByKey)
    .filter(([, gateState]) => {
      if (
        Math.max(0, normalizeInteger(gateState && gateState.usesCount, 0)) > 0 ||
        Math.max(0, normalizeInteger(gateState && gateState.lastUsedAtMs, 0)) > 0
      ) {
        return false;
      }
      const sourceRoomKey = normalizeText(
        gateState &&
          gateState.metadata &&
          gateState.metadata.rawGateProfile &&
          gateState.metadata.rawGateProfile.roomKey,
        "",
      );
      return !currentRoomKey || !sourceRoomKey || sourceRoomKey === currentRoomKey;
    })
    .map(([gateKey]) => gateKey);
  if (!scene || candidateGateKeys.length <= 0) {
    return 0;
  }
  const gateEntity = listSceneStaticEntities(scene)
    .find((entity) => (
      entity &&
      entity.dungeonMaterializedGate === true &&
      normalizePositiveInteger(entity.dungeonSiteInstanceID, 0) === instanceID &&
      candidateGateKeys.includes(normalizeText(entity.dungeonGateKey, ""))
    ));
  return normalizePositiveInteger(gateEntity && gateEntity.itemID, 0);
}

function buildEncounterDestroyAllObjectiveTuple(characterID, missionRecord, options = {}) {
  const template = getMissionInstanceTemplateRecord(missionRecord);
  const populationHints = normalizeObject(template && template.populationHints);
  const completion = normalizeObject(populationHints.completion);
  const trackerHints = normalizeObject(
    populationHints.missionTracker || populationHints.tracker,
  );
  const anchor = normalizeObject(
    trackerHints.destroyAllAnchor ||
      completion.destroyAllAnchor ||
      completion.trackerAnchor,
  );
  const anchorTypeID = normalizePositiveInteger(anchor.typeID, 0);
  const anchorDunObjectID = normalizePositiveInteger(anchor.dunObjectID, 0);
  const anchorNameID = normalizePositiveInteger(
    anchor.nameID || anchor.dunObjectNameID,
    0,
  );
  const instanceID = normalizePositiveInteger(
    missionRecord && missionRecord.dungeonInstanceID,
    0,
  );
  const instance = instanceID > 0 ? dungeonRuntime.getInstance(instanceID) : null;
  const { scene, tracked } = resolveMissionTrackerDungeonContext(
    characterID,
    missionRecord,
    options,
  );
  const matchesAnchor = (entity) => (
    entity &&
      normalizePositiveInteger(entity && entity.itemID, 0) > 0 &&
      (anchorTypeID <= 0 || normalizePositiveInteger(entity && entity.typeID, 0) === anchorTypeID) &&
      (
        anchorDunObjectID <= 0 ||
        normalizePositiveInteger(entity && entity.dunObjectID, 0) === anchorDunObjectID
      ) &&
      (
        anchorNameID <= 0 ||
        normalizePositiveInteger(
          entity && (entity.nameID || entity.dunObjectNameID),
          0,
        ) === anchorNameID
      )
  );
  const activeEntityIDs = listActiveMissionEncounterEntityIDs(instance, tracked);
  let anchorEntity = activeEntityIDs
    .map((entityID) => getSceneEntityByID(scene, entityID))
    .find(matchesAnchor);
  if (
    !anchorEntity &&
    (anchorTypeID > 0 || anchorDunObjectID > 0 || anchorNameID > 0)
  ) {
    anchorEntity = listSceneEntities(scene).find((entity) => (
      matchesAnchor(entity) &&
      (
        instanceID <= 0 ||
        normalizePositiveInteger(entity && entity.dungeonSiteInstanceID, 0) === instanceID
      )
    ));
  }
  const anchorEntityID = normalizePositiveInteger(anchorEntity && anchorEntity.itemID, 0);
  if (anchorEntityID > 0) {
    return buildMarshalTuple([
      "DestroyAll",
      normalizePositiveInteger(anchorEntity && anchorEntity.typeID, anchorTypeID),
      anchorEntityID,
    ]);
  }
  return buildMarshalTuple(["DestroyAll", 0]);
}

function buildDungeonFetchReturnTuple(missionRecord, itemSpec) {
  return buildList([
    "FetchObjectAcquiredDungeonDone",
    normalizePositiveInteger(itemSpec && itemSpec.typeID, 0),
    normalizePositiveInteger(missionRecord && missionRecord.agentID, 0),
    normalizePositiveInteger(
      missionRecord &&
        missionRecord.dropoffLocation &&
        missionRecord.dropoffLocation.locationID,
      0,
    ),
    Math.max(1, normalizeInteger(itemSpec && itemSpec.quantity, 1)),
  ]);
}

function buildDungeonFetchObjectiveState(characterID, missionRecord, options = {}) {
  const itemSpec = resolvePrimaryMissionItemSpec(missionRecord) || resolvePlaceholderCargo();
  const requiredQuantity = Math.max(1, normalizeInteger(itemSpec.quantity, 1));
  const progress = buildMissionItemProgressSnapshot(characterID, missionRecord, itemSpec, {
    destinationLocationID: normalizePositiveInteger(
      missionRecord &&
        missionRecord.dropoffLocation &&
        missionRecord.dropoffLocation.locationID,
      0,
    ),
    currentStationID: normalizePositiveInteger(options.currentStationID, 0),
  });
  const returnTuple = buildDungeonFetchReturnTuple(missionRecord, itemSpec);
  const completeTuple = buildList([
    "AllObjectivesComplete",
    normalizePositiveInteger(missionRecord && missionRecord.agentID, 0),
  ]);

  let current = null;
  if (normalizeBoolean(missionRecord && missionRecord.objectiveCompleted, false)) {
    current = completeTuple;
  } else if (
    isMissionDungeonObjectiveSatisfied(missionRecord) &&
    progress.totalQuantity >= requiredQuantity
  ) {
    current = returnTuple;
  } else if (options.inActiveDungeon === true) {
    const gateEntityID = findNextMissionGateEntityID(
      characterID,
      missionRecord,
      options,
    );
    current = gateEntityID > 0
      ? buildMarshalTuple(["GoToGate", gateEntityID])
      : buildMissionFetchTuple("MissionFetch", itemSpec);
  } else {
    current = buildMarshalTuple([
      "TravelTo",
      normalizePositiveInteger(missionRecord && missionRecord.missionSystemID, 0),
    ]);
  }

  return {
    current,
    all: [
      normalizeBoolean(missionRecord && missionRecord.objectiveCompleted, false)
        ? returnTuple
        : current,
      completeTuple,
    ],
  };
}

function buildMiningObjectiveState(characterID, missionRecord, options = {}) {
  const itemSpec = resolvePrimaryMissionItemSpec(missionRecord) || resolvePlaceholderCargo();
  const requiredQuantity = Math.max(1, normalizeInteger(itemSpec.quantity, 1));
  const progress = buildMissionItemProgressSnapshot(characterID, missionRecord, itemSpec, {
    destinationLocationID: normalizePositiveInteger(
      missionRecord &&
        missionRecord.dropoffLocation &&
        missionRecord.dropoffLocation.locationID,
      0,
    ),
    currentStationID: normalizePositiveInteger(options.currentStationID, 0),
  });
  const returnTuple = buildDungeonFetchReturnTuple(missionRecord, itemSpec);
  const completeTuple = buildList([
    "AllObjectivesComplete",
    normalizePositiveInteger(missionRecord && missionRecord.agentID, 0),
  ]);

  let current = null;
  if (normalizeBoolean(missionRecord && missionRecord.objectiveCompleted, false)) {
    current = completeTuple;
  } else if (
    isMissionDungeonObjectiveSatisfied(missionRecord) &&
    progress.totalQuantity >= requiredQuantity
  ) {
    current = returnTuple;
  } else if (options.inActiveDungeon === true) {
    current = buildMarshalTuple([
      "MissionFetchMineTrigger",
      normalizePositiveInteger(itemSpec && itemSpec.typeID, 0),
    ]);
  } else {
    current = buildMarshalTuple([
      "TravelTo",
      normalizePositiveInteger(missionRecord && missionRecord.missionSystemID, 0),
    ]);
  }

  return {
    current,
    all: [
      normalizeBoolean(missionRecord && missionRecord.objectiveCompleted, false)
        ? returnTuple
        : current,
      completeTuple,
    ],
  };
}

function buildAgentObjectiveState(missionRecord) {
  const targetAgentID = getMissionConversationTargetAgentID(
    missionRecord,
    normalizePositiveInteger(missionRecord && missionRecord.agentID, 0),
  );
  const talkTuple = targetAgentID > 0
    ? buildMarshalTuple(["TalkToAgent", targetAgentID])
    : null;
  const completeTuple = buildList([
    "AllObjectivesComplete",
    normalizePositiveInteger(missionRecord && missionRecord.agentID, 0),
  ]);
  const completed = normalizeBoolean(
    missionRecord && missionRecord.objectiveCompleted,
    false,
  );
  return {
    current: completed ? completeTuple : talkTuple,
    all: completed
      ? [talkTuple, completeTuple].filter(Boolean)
      : [talkTuple, completeTuple].filter(Boolean),
  };
}

function buildCourierObjectiveState(characterID, missionRecord) {
  const tuples = buildTransportObjectiveTuples(missionRecord);
  const progress = getCourierProgress(characterID, missionRecord);
  const requiredQuantity = Math.max(
    1,
    normalizeInteger(
      missionRecord && missionRecord.cargo && missionRecord.cargo.quantity,
      1,
    ),
  );
  const current = normalizeBoolean(missionRecord && missionRecord.objectiveCompleted, false)
    ? tuples.complete
    : progress.shipCargoQuantity >= requiredQuantity ||
      progress.destinationHangarQuantity >= requiredQuantity
    ? tuples.present
    : tuples.missing;
  return {
    current,
    all: [tuples.missing, tuples.present, tuples.complete],
  };
}

function buildEncounterObjectiveState(characterID, missionRecord, options = {}) {
  const tuples = buildEncounterObjectiveTuples(missionRecord);
  if (normalizeBoolean(missionRecord && missionRecord.objectiveCompleted, false)) {
    return {
      current: tuples.complete,
      all: [tuples.complete],
    };
  }
  let current = tuples.travel;
  if (options.inActiveDungeon === true) {
    const gateEntityID = findNextMissionGateEntityID(
      characterID,
      missionRecord,
      options,
    );
    current = gateEntityID > 0
      ? buildMarshalTuple(["GoToGate", gateEntityID])
      : buildEncounterDestroyObjectiveTuple(characterID, missionRecord, options) ||
        buildEncounterDestroyAllObjectiveTuple(characterID, missionRecord, options);
  }
  return {
    current,
    all: [current, tuples.complete],
  };
}

function buildMissionFetchTuple(tupleKey, itemSpec) {
  const normalizedTypeID = normalizePositiveInteger(itemSpec && itemSpec.typeID, 0);
  if (!normalizedTypeID) {
    return null;
  }
  const quantity = Math.max(1, normalizeInteger(itemSpec && itemSpec.quantity, 1));
  return buildMarshalTuple([
    tupleKey,
    normalizedTypeID,
    quantity > 1 ? quantity : null,
  ]);
}

function buildMissionDeliveryTuple(missionRecord, itemSpec, itemProgress, options = {}) {
  const normalizedTypeID = normalizePositiveInteger(itemSpec && itemSpec.typeID, 0);
  if (!normalizedTypeID) {
    return null;
  }
  const requiredQuantity = Math.max(1, normalizeInteger(itemSpec && itemSpec.quantity, 1));
  const destinationLocationID = normalizePositiveInteger(
    options.destinationLocationID,
    0,
  );
  const atDestination =
    destinationLocationID > 0 &&
    normalizePositiveInteger(options.currentLocationID, 0) === destinationLocationID &&
    normalizePositiveInteger(options.currentStationID, 0) === destinationLocationID;

  if (itemProgress.destinationHangarQuantity >= requiredQuantity) {
    return buildList(["MissionTransport", normalizedTypeID]);
  }
  if (itemProgress.shipCargoQuantity >= requiredQuantity && atDestination) {
    return buildList(["MissionTransport", normalizedTypeID]);
  }
  if (itemProgress.shipCargoQuantity >= requiredQuantity || itemProgress.totalQuantity >= requiredQuantity) {
    return buildList([
      "TransportItemsPresent",
      normalizedTypeID,
      destinationLocationID || null,
      requiredQuantity,
    ]);
  }
  if (itemProgress.sourceHangarQuantity >= requiredQuantity) {
    return buildList(["TransportItemsMissing", normalizedTypeID, requiredQuantity]);
  }
  return buildList(["DropOffItemsMissing", normalizedTypeID, requiredQuantity]);
}

function dedupeObjectiveTuples(tuples = []) {
  const result = [];
  let previousFingerprint = "";
  for (const tupleValue of tuples) {
    const items = getTupleItems(tupleValue);
    if (items.length <= 0) {
      continue;
    }
    const fingerprint = JSON.stringify(items);
    if (fingerprint === previousFingerprint) {
      continue;
    }
    previousFingerprint = fingerprint;
    result.push(tupleValue);
  }
  return result;
}

function isMiningMissionRecord(missionRecord) {
  return normalizeText(missionRecord && missionRecord.missionKind, "") === "mining";
}

function buildTransportObjectiveTuples(missionRecord) {
  const cargo = missionRecord && missionRecord.cargo ? missionRecord.cargo : resolvePlaceholderCargo();
  const typeID = normalizePositiveInteger(cargo && cargo.typeID, PLACEHOLDER_CARGO_TYPE_ID);
  const quantity = Math.max(1, normalizeInteger(cargo && cargo.quantity, PLACEHOLDER_CARGO_QUANTITY));
  const destinationLocationID = normalizePositiveInteger(
    missionRecord && missionRecord.dropoffLocation && missionRecord.dropoffLocation.locationID,
    0,
  );
  return {
    missing: buildList(["TransportItemsMissing", typeID, quantity]),
    present: buildList(["TransportItemsPresent", typeID, destinationLocationID || null, quantity]),
    transport: buildList(["MissionTransport", typeID]),
    complete: buildList([
      "AllObjectivesComplete",
      normalizePositiveInteger(missionRecord && missionRecord.agentID, 0),
    ]),
  };
}

function buildFetchObjectiveTuples(missionRecord) {
  const itemSpec = resolvePrimaryMissionItemSpec(missionRecord) || {
    typeID: PLACEHOLDER_CARGO_TYPE_ID,
    quantity: PLACEHOLDER_CARGO_QUANTITY,
  };
  return {
    fetch: buildMissionFetchTuple("MissionFetch", itemSpec),
    complete: buildList([
      "AllObjectivesComplete",
      normalizePositiveInteger(missionRecord && missionRecord.agentID, 0),
    ]),
  };
}

function buildMiningObjectiveTuples(missionRecord) {
  const itemSpec = resolvePrimaryMissionItemSpec(missionRecord) || {
    typeID: PLACEHOLDER_CARGO_TYPE_ID,
    quantity: PLACEHOLDER_CARGO_QUANTITY,
  };
  return {
    travel: buildMarshalTuple([
      "TravelTo",
      normalizePositiveInteger(missionRecord && missionRecord.missionSystemID, 0),
    ]),
    mine: buildMissionFetchTuple("MissionFetchMine", itemSpec),
    complete: buildList([
      "AllObjectivesComplete",
      normalizePositiveInteger(missionRecord && missionRecord.agentID, 0),
    ]),
  };
}

function buildEncounterObjectiveTuples(missionRecord) {
  // Dungeon-fetch encounter missions surface the item objective in the tracker
  // (TQ shows MissionFetch <typeID> <qty> alongside the travel/kill steps).
  const cargo = missionRecord && missionRecord.cargo && typeof missionRecord.cargo === "object"
    ? missionRecord.cargo
    : null;
  return {
    travel: buildMarshalTuple([
      "TravelTo",
      normalizePositiveInteger(missionRecord && missionRecord.missionSystemID, 0),
    ]),
    fetch: cargo
      ? buildMissionFetchTuple("MissionFetch", {
          typeID: normalizePositiveInteger(cargo.typeID, PLACEHOLDER_CARGO_TYPE_ID),
          quantity: Math.max(1, normalizeInteger(cargo.quantity, 1)),
        })
      : null,
    complete: buildList([
      "AllObjectivesComplete",
      normalizePositiveInteger(missionRecord && missionRecord.agentID, 0),
    ]),
  };
}

function normalizeObjectiveTargetDescriptor(target) {
  if (!target || typeof target !== "object") {
    return null;
  }
  const typeID = normalizePositiveInteger(target.typeID || target.type_id, 0);
  const nameID = normalizePositiveInteger(
    target.nameID || target.name_id,
    normalizePositiveInteger(target.dunObjectNameID || target.dun_object_name_id, 0),
  );
  if (!typeID) {
    return null;
  }
  return {
    typeID,
    nameID: nameID || null,
    itemID: normalizePositiveInteger(target.itemID || target.item_id, 0) || null,
  };
}

function listSpawnedMissionObjectiveTargetIDs(instance) {
  const encounterStatesByKey = normalizeObject(
    instance &&
      instance.spawnState &&
      instance.spawnState.encounterStatesByKey,
  );
  const entityIDs = [];
  for (const encounterState of Object.values(encounterStatesByKey)) {
    for (const entityID of normalizeArray(
      encounterState && encounterState.objectiveBlockingEntityIDs,
    )) {
      const normalizedEntityID = normalizePositiveInteger(entityID, 0);
      if (normalizedEntityID > 0 && !entityIDs.includes(normalizedEntityID)) {
        entityIDs.push(normalizedEntityID);
      }
    }
  }
  return entityIDs;
}

function buildEncounterDestroyObjectiveTuple(characterID, missionRecord, options = {}) {
  const instanceID = normalizePositiveInteger(missionRecord && missionRecord.dungeonInstanceID, 0);
  if (!instanceID) {
    return null;
  }
  const instance = dungeonRuntime.getInstance(instanceID);
  if (!instance) {
    return null;
  }
  const templateID = normalizeText(
    instance && instance.templateID,
    normalizeText(missionRecord && missionRecord.dungeonTemplateID, ""),
  );
  const template = templateID ? getTemplateByID(templateID) : null;
  const completion = normalizeObject(
    template &&
      template.populationHints &&
      template.populationHints.completion,
  );
  const authoredTargets = normalizeArray(options.objectiveTargets)
    .map((target) => normalizeObjectiveTargetDescriptor(target))
    .filter(Boolean);
  const targets = (
    authoredTargets.length > 0
      ? authoredTargets
      : normalizeArray(completion.objectiveTargets)
        .map((target) => normalizeObjectiveTargetDescriptor(target))
        .filter(Boolean)
  );
  if (targets.length <= 0) {
    return null;
  }
  const targetEntityIDs = Array.from(new Set([
    ...targets.map((target) => normalizePositiveInteger(target.itemID, 0)),
    ...listSpawnedMissionObjectiveTargetIDs(instance),
    ...listActiveMissionEncounterEntityIDs(instance),
  ].filter((entityID) => entityID > 0)));
  if (targetEntityIDs.length <= 0) {
    return null;
  }
  const { scene } = resolveMissionTrackerDungeonContext(
    characterID,
    missionRecord,
    options,
  );
  let resolvedLiveEntity = false;
  for (const targetEntityID of targetEntityIDs) {
    const entity = getSceneEntityByID(scene, targetEntityID);
    if (!entity) {
      continue;
    }
    resolvedLiveEntity = true;
    const entityTypeID = normalizePositiveInteger(entity.typeID, 0);
    const entityNameID = normalizePositiveInteger(
      entity.nameID || entity.dunObjectNameID,
      0,
    );
    const target = targets.find((candidate) => (
      (!candidate.itemID || candidate.itemID === targetEntityID) &&
      candidate.typeID === entityTypeID &&
      (
        !candidate.nameID ||
        !entityNameID ||
        candidate.nameID === entityNameID
      )
    ));
    if (target) {
      return buildMarshalTuple([
        "Destroy",
        target.typeID,
        targetEntityID,
        target.nameID,
      ]);
    }
  }
  if (resolvedLiveEntity) {
    return null;
  }
  const target = targets[0];
  const targetEntityID = targetEntityIDs[0];
  return buildMarshalTuple([
    "Destroy",
    target.typeID,
    targetEntityID,
    target.nameID,
  ]);
}

function resolveMissionObjectiveState(characterID, missionRecord, options = {}) {
  const currentRecord = evaluateMissionProgress(characterID, missionRecord);
  const agentRecord = getAgentRecord(currentRecord && currentRecord.agentID);
  if (!currentRecord || !agentRecord) {
    return { current: null, all: [] };
  }

  // Authored objective chains are client presentation graphs. They consume
  // these canonical tracker keys; their leaf objective names are not wire
  // states and must never take precedence over the authoritative reducer.
  if (isDungeonFetchMissionRecord(currentRecord)) {
    return buildDungeonFetchObjectiveState(
      characterID,
      currentRecord,
      options,
    );
  }

  if (isMiningMissionRecord(currentRecord)) {
    return buildMiningObjectiveState(
      characterID,
      currentRecord,
      options,
    );
  }

  if (isAgentObjectiveMissionRecord(currentRecord)) {
    return buildAgentObjectiveState(currentRecord);
  }

  if (currentRecord.objectiveMode === OBJECTIVE_TYPE_TRANSPORT) {
    return buildCourierObjectiveState(
      characterID,
      currentRecord,
    );
  }

  if (isFetchMissionRecord(currentRecord)) {
    const itemSpec = resolvePrimaryMissionItemSpec(currentRecord) || resolvePlaceholderCargo();
    const progress = buildMissionItemProgressSnapshot(characterID, currentRecord, itemSpec, {
      destinationLocationID: normalizePositiveInteger(
        currentRecord &&
          currentRecord.dropoffLocation &&
          currentRecord.dropoffLocation.locationID,
        0,
      ),
      currentStationID: normalizePositiveInteger(options.currentStationID, 0),
    });
    const fetchTuple = buildMissionFetchTuple("MissionFetch", itemSpec);
    const deliveryTuple = buildMissionDeliveryTuple(currentRecord, itemSpec, progress, {
      currentLocationID: normalizePositiveInteger(options.currentLocationID, 0),
      currentStationID: normalizePositiveInteger(options.currentStationID, 0),
      destinationLocationID: normalizePositiveInteger(
        currentRecord &&
          currentRecord.dropoffLocation &&
          currentRecord.dropoffLocation.locationID,
        0,
      ),
    });
    const tuples = buildFetchObjectiveTuples(currentRecord);
    let all = [];
    if (currentRecord.objectiveCompleted === true) {
      all = dedupeObjectiveTuples([fetchTuple, deliveryTuple, tuples.complete].filter(Boolean));
    } else if (
      progress.totalQuantity >= Math.max(1, normalizeInteger(itemSpec && itemSpec.quantity, 1))
    ) {
      all = dedupeObjectiveTuples([fetchTuple, deliveryTuple].filter(Boolean));
    } else {
      all = dedupeObjectiveTuples([fetchTuple].filter(Boolean));
    }
    return {
      current: all.length > 0 ? all[all.length - 1] : null,
      all,
    };
  }

  return buildEncounterObjectiveState(characterID, currentRecord, options);
}

function buildMissionObjectiveSequence(characterID, missionRecord, options = {}) {
  return resolveMissionObjectiveState(characterID, missionRecord, options).all;
}

function isSessionInActiveMissionDungeon(session, missionRecord) {
  if (!session || !missionRecord) {
    return false;
  }
  const missionSystemID = normalizePositiveInteger(missionRecord.missionSystemID, 0);
  const missionPosition =
    missionRecord.missionPosition && typeof missionRecord.missionPosition === "object"
      ? clonePosition(missionRecord.missionPosition)
      : null;
  if (!missionSystemID || !missionPosition) {
    return false;
  }
  const spaceRuntime = getSpaceRuntime();
  const scene =
    spaceRuntime && typeof spaceRuntime.getSceneForSession === "function"
      ? spaceRuntime.getSceneForSession(session)
      : null;
  const currentSystemID = normalizePositiveInteger(scene && scene.systemID, 0);
  if (currentSystemID !== missionSystemID) {
    return false;
  }
  const shipEntity =
    scene && typeof scene.getShipEntityForSession === "function"
      ? scene.getShipEntityForSession(session)
      : null;
  if (!shipEntity || !shipEntity.position) {
    return null;
  }
  if (shipEntity.mode === "WARP" || shipEntity.pendingWarp || shipEntity.warpState) {
    return null;
  }
  const missionInstanceID = normalizePositiveInteger(
    missionRecord && missionRecord.dungeonInstanceID,
    0,
  );
  if (missionInstanceID > 0) {
    const tracked = dungeonTrackingRuntime.resolveTrackedDungeonForSession(
      scene,
      session,
    );
    if (tracked && tracked.instance) {
      return normalizePositiveInteger(tracked.instance.instanceID, 0) === missionInstanceID;
    }
  }
  return vectorMagnitude(subtractVectors(shipEntity.position, missionPosition)) <=
    MISSION_IN_DUNGEON_DISTANCE_METERS;
}

function expireMissionIfNeeded(characterID, agentID, missionRecord) {
  if (!missionRecord) {
    return false;
  }
  const expectedRuntimeStatus = normalizeText(
    missionRecord.runtimeStatus,
    "offered",
  ).toLowerCase();
  if (!["offered", "accepted"].includes(expectedRuntimeStatus)) {
    return false;
  }
  const expiresAt = fileTimeStringToBigInt(missionRecord.expiresAtFileTime);
  if (expiresAt <= 0n || expiresAt > nowFileTimeBigInt()) {
    return false;
  }
  const expectedMissionSequence = normalizePositiveInteger(
    missionRecord.missionSequence,
    0,
  );
  const result = mutateCharacterState(characterID, (characterState) => {
    const storedMission = characterState.missionsByAgentID[String(agentID)];
    if (
      !storedMission ||
      normalizeText(storedMission.runtimeStatus, "offered").toLowerCase() !==
        expectedRuntimeStatus ||
      normalizePositiveInteger(storedMission.missionSequence, 0) !== expectedMissionSequence
    ) {
      return { expired: false };
    }
    delete characterState.missionsByAgentID[String(agentID)];
    const closedAtFileTime = currentFileTimeString();
    characterState.history.unshift({
      missionSequence: storedMission.missionSequence,
      agentID: storedMission.agentID,
      contentID: storedMission.contentID,
      missionTemplateID: storedMission.missionTemplateID,
      runtimeStatus: "expired",
      completedAtFileTime: closedAtFileTime,
      lastUpdatedAtMs: Date.now(),
    });
    characterState.history = characterState.history.slice(0, 128);
    recordEpicArcMissionStatus(
      characterState,
      buildEpicArcMissionStatusRecord(storedMission, {
        quitDate: closedAtFileTime,
      }),
      { nowMs: Date.now() },
    );
    return {
      expired: true,
      missionRecord: cloneValue(storedMission),
    };
  });
  if (!(result && result.success && result.data && result.data.expired === true)) {
    return false;
  }
  const expiredMissionRecord = result.data.missionRecord || missionRecord;
  cleanupMissionBookmarks(characterID, expiredMissionRecord);
  const dungeonInstanceID = normalizePositiveInteger(
    expiredMissionRecord && expiredMissionRecord.dungeonInstanceID,
    0,
  );
  if (dungeonInstanceID > 0) {
    try {
      dungeonRuntime.purgeInstance(dungeonInstanceID);
    } catch (_error) {
      // Expiration should still close the mission if its site already despawned.
    }
  }
  notifyMissionChange(characterID, AGENT_MISSION_OFFER_EXPIRED, agentID);
  return true;
}

function getMissionRecordForRead(characterID, agentID) {
  const missionRecord = getMissionRecord(characterID, agentID);
  if (!missionRecord) {
    return null;
  }
  if (expireMissionIfNeeded(characterID, agentID, missionRecord)) {
    return null;
  }
  if (normalizeText(missionRecord.runtimeStatus, "offered") === "accepted") {
    return syncMissionRecordState(characterID, agentID) || missionRecord;
  }
  return missionRecord;
}

function getMissionInfoItems(characterID, agentID, options = {}) {
  const missionRecord = getMissionRecordForRead(characterID, agentID);
  if (!missionRecord || normalizeText(missionRecord.runtimeStatus, "offered") !== "accepted") {
    return null;
  }
  return buildMissionTrackerInfoTuple(characterID, missionRecord, {
    session: options.session || null,
    currentLocationID: normalizePositiveInteger(options.currentLocationID, 0),
    currentStationID: normalizePositiveInteger(options.currentStationID, 0),
    inActiveDungeon: options.inActiveDungeon === true,
  });
}

function getAllMissionObjectives(characterID, agentID, options = {}) {
  const missionRecord = getMissionRecordForRead(characterID, agentID);
  if (!missionRecord || normalizeText(missionRecord.runtimeStatus, "offered") !== "accepted") {
    return [];
  }
  return buildMissionObjectiveSequence(characterID, missionRecord, {
    session: options.session || null,
    currentLocationID: normalizePositiveInteger(options.currentLocationID, 0),
    currentStationID: normalizePositiveInteger(options.currentStationID, 0),
    inActiveDungeon: options.inActiveDungeon === true,
  });
}

function buildPlaceholderBriefing(agentRecord, missionRecord, missionTemplate) {
  const missionTitle = normalizeText(
    missionRecord && missionRecord.missionTitle,
    normalizeText(missionTemplate && missionTemplate.title, "Placeholder Mission"),
  );
  const advisory = missionTemplate && typeof missionTemplate.advisory === "object"
    ? missionTemplate.advisory
    : {};
  const rawRooms = Array.isArray(missionTemplate && missionTemplate.rooms)
    ? missionTemplate.rooms
    : [];
  const gateHints = [
    ...new Set([
      ...((missionTemplate &&
        missionTemplate.siteSceneProfile &&
        Array.isArray(missionTemplate.siteSceneProfile.gateProfiles)
          ? missionTemplate.siteSceneProfile.gateProfiles
          : [])
        .map((gateProfile) => normalizeText(gateProfile && gateProfile.label, ""))
        .filter(Boolean)),
      ...rawRooms
        .map((room) => normalizeText(room && room.gateHint, ""))
        .filter(Boolean),
    ]),
  ].slice(0, 3);
  const objectiveHints = [
    ...new Set(
      (Array.isArray(missionTemplate && missionTemplate.objectiveHints)
        ? missionTemplate.objectiveHints
        : [])
        .map((entry) => normalizeText(entry, ""))
        .filter(Boolean),
    ),
  ].slice(0, 3);
  const triggerHints = [
    ...new Set(
      (Array.isArray(missionTemplate && missionTemplate.triggerHints)
        ? missionTemplate.triggerHints
        : [])
        .map((entry) => normalizeText(entry, ""))
        .filter(Boolean),
    ),
  ].slice(0, 3);
  const transportHints = [
    ...new Set(
      (Array.isArray(missionTemplate && missionTemplate.transportHints)
        ? missionTemplate.transportHints
        : [])
        .map((entry) => normalizeText(entry, ""))
        .filter(Boolean),
    ),
  ].slice(0, 3);
  const roomNotes = rawRooms
    .slice(0, 3)
    .map((room) => {
      const label = normalizeText(room && room.title, "");
      const note = normalizeText(
        Array.isArray(room && room.notes) ? room.notes[0] : "",
        "",
      );
      if (!label || !note) {
        return "";
      }
      return `${label}: ${note}`;
    })
    .filter(Boolean);
  const advisoryLines = [
    normalizeText(missionTemplate && missionTemplate.faction, "")
      ? `Faction: ${normalizeText(missionTemplate && missionTemplate.faction, "")}`
      : "",
    normalizeText(
      missionTemplate &&
        missionTemplate.spaceType &&
        missionTemplate.spaceType.raw,
      "",
    )
      ? `Space: ${normalizeText(missionTemplate.spaceType.raw, "")}`
      : "",
    normalizeText(advisory.damageDealt, "")
      ? `Damage dealt: ${normalizeText(advisory.damageDealt, "")}`
      : "",
    normalizeText(advisory.recommendedDamage, "")
      ? `Recommended damage: ${normalizeText(advisory.recommendedDamage, "")}`
      : "",
    normalizeText(advisory.webScramble, "")
      ? `EWAR: ${normalizeText(advisory.webScramble, "")}`
      : "",
    normalizeText(advisory.recommendedShips, "")
      ? `Recommended ships: ${normalizeText(advisory.recommendedShips, "")}`
      : "",
  ].filter(Boolean);
  const chainSummary = Array.isArray(missionTemplate && missionTemplate.missionParts) &&
    missionTemplate.missionParts.length > 1
    ? `Mission chain intelligence includes ${missionTemplate.missionParts.length} linked stages.`
    : "";
  const sections = [];

  const pushSection = (title, values) => {
    const lines = (Array.isArray(values) ? values : [])
      .map((entry) => normalizeText(entry, ""))
      .filter(Boolean);
    if (lines.length <= 0) {
      return;
    }
    sections.push(`<br><br><b>${escapeHtml(title)}</b>`);
    for (const line of lines) {
      sections.push(`<br>${escapeHtml(line)}`);
    }
  };

  pushSection("Operational Intel", [
    ...advisoryLines,
    normalizePositiveInteger(missionTemplate && missionTemplate.missionLevel, 0) > 0
      ? `Mission level: ${normalizePositiveInteger(missionTemplate.missionLevel, 0)}`
      : "",
    chainSummary,
  ]);
  pushSection(
    "Objective Intel",
    objectiveHints.length > 0
      ? objectiveHints
      : transportHints,
  );
  pushSection("Pocket Notes", roomNotes);
  pushSection("Acceleration Gates", gateHints);
  pushSection("Trigger Notes", triggerHints);

  if (sections.length > 0) {
    return [
      `<b>${escapeHtml(missionTitle)}</b>`,
      `<br><br>Review the following operational briefing before departure.`,
      ...sections,
    ].join("");
  }

  const missionType = isCourierMission(agentRecord, missionTemplate)
    ? "courier"
    : "encounter";
  return [
    `<b>${escapeHtml(missionTitle)}</b>`,
    `<br><br>Your ${escapeHtml(missionType)} assignment is ready for review.`,
    `<br>Agent: ${escapeHtml(normalizeText(agentRecord && agentRecord.ownerName, "Unknown Agent"))}`,
    `<br><br>${escapeHtml(MISSION_PLACEHOLDER_NOTE)}`,
  ].join("");
}

function buildMissionKeywords(agentRecord, missionRecord, missionTemplate) {
  const clientMissionRecord = getClientMissionRecord(missionRecord);
  if (!clientMissionRecord) {
    return {
      agentName: normalizeText(agentRecord && agentRecord.ownerName, "Unknown Agent"),
      missionName: normalizeText(
        missionRecord && missionRecord.missionTitle,
        normalizeText(missionTemplate && missionTemplate.title, "Placeholder Mission"),
      ),
      missionTypeLabel: buildMissionTypeLabel(agentRecord),
    };
  }

  const itemSpec = resolvePrimaryMissionItemSpec(missionRecord);
  const rewards = normalizeObject(missionRecord && missionRecord.rewards);
  const rewardFields = {
    rewardTypeID: ISK_REWARD_TYPE_ID,
    rewardQuantity: Math.max(0, Math.round(Number(rewards.isk) || 0)),
  };
  const missionSystemID = normalizePositiveInteger(
    missionRecord && missionRecord.missionSystemID,
    normalizePositiveInteger(agentRecord && agentRecord.solarSystemID, 0),
  );
  const dropoffLocation = normalizeObject(missionRecord && missionRecord.dropoffLocation);
  const pickupLocation = normalizeObject(missionRecord && missionRecord.pickupLocation);

  if (missionRecord.objectiveMode === OBJECTIVE_TYPE_TRANSPORT) {
    return {
      objectiveLocationID: normalizePositiveInteger(pickupLocation.locationID, 0),
      objectiveDestinationID: normalizePositiveInteger(dropoffLocation.locationID, 0),
      objectiveQuantity: Math.max(1, normalizeInteger(itemSpec && itemSpec.quantity, 1)),
      objectiveDestinationSystemID: normalizePositiveInteger(
        dropoffLocation.solarsystemID,
        0,
      ),
      objectiveTypeID: normalizePositiveInteger(itemSpec && itemSpec.typeID, 0),
      objectiveLocationSystemID: normalizePositiveInteger(
        pickupLocation.solarsystemID,
        0,
      ),
      ...rewardFields,
    };
  }

  if (
    isDungeonFetchMissionRecord(missionRecord) ||
    isMiningMissionRecord(missionRecord) ||
    isFetchMissionRecord(missionRecord)
  ) {
    return {
      objectiveLocationID: normalizePositiveInteger(dropoffLocation.locationID, 0),
      ...(missionRecord.objectiveMode === OBJECTIVE_TYPE_DUNGEON
        ? { dungeonSolarSystemID: missionSystemID }
        : {}),
      objectiveQuantity: Math.max(1, normalizeInteger(itemSpec && itemSpec.quantity, 1)),
      objectiveTypeID: normalizePositiveInteger(itemSpec && itemSpec.typeID, 0),
      ...(missionRecord.objectiveMode === OBJECTIVE_TYPE_DUNGEON
        ? {
            dungeonLocationID:
              normalizePositiveInteger(pickupLocation.locationID, 0) || missionSystemID,
          }
        : {}),
      objectiveLocationSystemID: normalizePositiveInteger(
        dropoffLocation.solarsystemID,
        0,
      ),
      ...rewardFields,
    };
  }

  return {
    dungeonSolarSystemID: missionSystemID,
    ...rewardFields,
    dungeonLocationID:
      normalizePositiveInteger(pickupLocation.locationID, 0) || missionSystemID,
  };
}

function buildMissionImage(missionRecord) {
  const imageName = isMiningMissionRecord(missionRecord)
    ? "miningmission.png"
    : (
      missionRecord &&
      [OBJECTIVE_TYPE_TRANSPORT, OBJECTIVE_TYPE_FETCH, OBJECTIVE_TYPE_AGENT].includes(
        missionRecord.objectiveMode,
      )
    )
    ? "couriermission.png"
    : "killmission.png";
  return `<img src="res:/UI/netres/mission_content/${imageName}" align=center hspace=4 vspace=4>`;
}

function resolveMissionEnemyOwnerID(...missionTemplates) {
  for (const missionTemplate of missionTemplates) {
    const factionID = normalizePositiveInteger(missionTemplate && missionTemplate.factionID, 0);
    if (factionID > 0) {
      return factionID;
    }
  }
  return null;
}

function hasMissionShipRestrictions(...missionTemplates) {
  return missionTemplates.some((missionTemplate) => {
    const gateProfiles = Array.isArray(
      missionTemplate &&
      missionTemplate.siteSceneProfile &&
      missionTemplate.siteSceneProfile.gateProfiles,
    )
      ? missionTemplate.siteSceneProfile.gateProfiles
      : [];
    const connections = Array.isArray(missionTemplate && missionTemplate.connections)
      ? missionTemplate.connections
      : [];
    return [...gateProfiles, ...connections].some((gateProfile) => (
      normalizePositiveInteger(gateProfile && gateProfile.allowedShipsList, 0) > 0
    ));
  });
}

function resolveMissionTitleValue(missionRecord, missionTemplate) {
  const missionNameID = normalizePositiveInteger(
    missionRecord && missionRecord.missionNameID,
    0,
  );
  if (missionNameID > 0) {
    return missionNameID;
  }
  return normalizeText(
    missionRecord && missionRecord.missionTitle,
    normalizeText(missionTemplate && missionTemplate.title, "Placeholder Mission"),
  );
}

function resolveMissionBriefingValue(
  agentRecord,
  missionRecord,
  missionTemplate,
  clientMissionRecord,
  messageKeys,
) {
  const messageID = getFirstMissionMessageID(clientMissionRecord, messageKeys);
  if (messageID > 0) {
    return messageID;
  }
  const localizedText = getFirstMissionLocalizedMessageText(
    clientMissionRecord,
    messageKeys,
  );
  if (localizedText) {
    return localizedText;
  }
  return buildPlaceholderBriefing(
    agentRecord,
    missionRecord,
    missionTemplate,
  );
}

function buildEncounterObjectiveBriefingMessage(
  agentRecord,
  missionRecord,
  presentationTemplate,
  dungeonTemplate,
  clientMissionRecord,
) {
  const dungeonBriefingID = normalizePositiveInteger(
    dungeonTemplate && dungeonTemplate.missionBriefingID,
    normalizePositiveInteger(
      presentationTemplate && presentationTemplate.missionBriefingID,
      0,
    ),
  );
  if (dungeonBriefingID > 0) {
    return buildMissionProcessMessageReference(missionRecord, dungeonBriefingID);
  }
  const authoredBriefing = buildMissionProcessMessageReferenceByKeys(
    missionRecord,
    clientMissionRecord,
    [
      "messages.mission.briefing",
      "messages.mission.extrainfo.body",
      "messages.mission.accepted.agentsays",
      "messages.root.missioninprogress.agentsays",
    ],
  );
  if (authoredBriefing) {
    return authoredBriefing;
  }
  const localizedBriefing = getFirstMissionLocalizedMessageText(
    clientMissionRecord,
    [
      "messages.mission.briefing",
      "messages.mission.extrainfo.body",
      "messages.mission.accepted.agentsays",
      "messages.root.missioninprogress.agentsays",
    ],
  );
  if (localizedBriefing) {
    return localizedBriefing;
  }
  const derivedBriefing = buildPlaceholderBriefing(
    agentRecord,
    missionRecord,
    presentationTemplate || dungeonTemplate || null,
  );
  const hasDerivedIntel = !derivedBriefing.includes(MISSION_PLACEHOLDER_NOTE);
  if (hasDerivedIntel) {
    return derivedBriefing;
  }
  return normalizeBoolean(missionRecord && missionRecord.objectiveCompleted, false)
    ? MISSION_PLACEHOLDER_COMPLETE_NOTE
    : MISSION_PLACEHOLDER_NOTE;
}

function resolveCapturedMissionSetup(presentationTemplate, contentID, agentRecord) {
  const setupByMissionID = normalizeObject(
    presentationTemplate && presentationTemplate.missionSetupByMissionID,
  );
  const contentKey = missionContentIDToText(contentID, "");
  const missionSetup = normalizeObject(contentKey ? setupByMissionID[contentKey] : null);
  const sourceAgentID = normalizePositiveInteger(missionSetup.sourceAgentID, 0);
  const sourceSolarSystemID = normalizePositiveInteger(
    missionSetup.sourceSolarSystemID,
    0,
  );
  if (
    sourceAgentID <= 0 ||
    sourceSolarSystemID <= 0 ||
    sourceAgentID !== normalizePositiveInteger(agentRecord && agentRecord.agentID, 0) ||
    sourceSolarSystemID !==
      normalizePositiveInteger(agentRecord && agentRecord.solarSystemID, 0)
  ) {
    return null;
  }
  return missionSetup;
}

function resolveCapturedMissionSystemID(presentationTemplate, contentID, agentRecord) {
  const missionSetup = resolveCapturedMissionSetup(
    presentationTemplate,
    contentID,
    agentRecord,
  );
  return normalizePositiveInteger(
    missionSetup && missionSetup.missionSolarSystemID,
    0,
  );
}

function resolveCapturedMissionPosition(presentationTemplate, contentID, agentRecord) {
  const missionSetup = resolveCapturedMissionSetup(
    presentationTemplate,
    contentID,
    agentRecord,
  );
  const missionPosition = normalizeObject(missionSetup && missionSetup.missionPosition);
  if (!["x", "y", "z"].every((axis) => (
    missionPosition[axis] !== null &&
    missionPosition[axis] !== undefined &&
    Number.isFinite(Number(missionPosition[axis]))
  ))) {
    return null;
  }
  return {
    x: Number(missionPosition.x),
    y: Number(missionPosition.y),
    z: Number(missionPosition.z),
  };
}

function resolveCapturedMissionRewardPresentation(
  presentationTemplate,
  contentID,
  agentRecord,
) {
  const missionSetup = resolveCapturedMissionSetup(
    presentationTemplate,
    contentID,
    agentRecord,
  );
  const reward = normalizeObject(missionSetup && missionSetup.reward);
  return Object.keys(reward).length > 0 ? reward : null;
}

function buildMissionRecord(
  state,
  characterState,
  agentRecord,
  missionTemplate,
  selectionCursor = 0,
  explicitClientMissionRecord = null,
  advanceSelectionCursor = true,
) {
  const agentID = normalizePositiveInteger(agentRecord && agentRecord.agentID, 0);
  const missionSequence = normalizePositiveInteger(state.nextMissionSequence, 1);
  const clientMissionRecord = explicitClientMissionRecord || pickMissionForAgent(agentRecord, selectionCursor);
  const fallbackMissionTemplateID = normalizeText(
    missionTemplate && missionTemplate.templateID,
    "",
  );
  const contentID = normalizeMissionContentID(
    clientMissionRecord && clientMissionRecord.missionID,
    fallbackMissionTemplateID,
  );
  const clientKillMission =
    clientMissionRecord &&
    clientMissionRecord.killMission &&
    typeof clientMissionRecord.killMission === "object" &&
    Object.keys(clientMissionRecord.killMission).length > 0
      ? clientMissionRecord.killMission
      : null;
  const clientCourierMission =
    clientMissionRecord &&
    clientMissionRecord.courierMission &&
    typeof clientMissionRecord.courierMission === "object" &&
    Object.keys(clientMissionRecord.courierMission).length > 0
      ? clientMissionRecord.courierMission
      : null;
  const clientObjectiveContext = buildClientMissionObjectiveContext(clientMissionRecord);
  const clientDungeonID = resolveClientMissionDungeonID(clientMissionRecord);
  const runtimeDungeonTemplate =
    clientDungeonID > 0
      ? getClientDungeonTemplate(clientDungeonID)
      : null;
  const matchedMissionTemplate = resolveMissionTemplateForClientMission(
    agentRecord,
    clientMissionRecord,
    missionTemplate,
    runtimeDungeonTemplate,
  );
  const importantMission = normalizeBoolean(
    agentRecord && agentRecord.importantMission,
    false,
  );
  const clientMissionKind = normalizeText(
    clientMissionRecord && clientMissionRecord.missionKind,
    "",
  );
  const sourceStationID = normalizePositiveInteger(agentRecord && agentRecord.stationID, 0);
  const objectiveMode = clientMissionRecord
    ? (
      normalizeBoolean(clientMissionRecord && clientMissionRecord.isTalkToAgent, false) ||
      clientMissionKind === "talkToAgent" ||
      normalizeBoolean(clientMissionRecord && clientMissionRecord.isAgentInteraction, false) ||
      clientMissionKind === "agentInteraction"
        ? OBJECTIVE_TYPE_AGENT
        : clientDungeonID > 0
        ? OBJECTIVE_TYPE_DUNGEON
        : clientMissionKind === "trade"
        ? OBJECTIVE_TYPE_FETCH
        : clientCourierMission
        ? OBJECTIVE_TYPE_TRANSPORT
        : OBJECTIVE_TYPE_DUNGEON
    )
    : (
      normalizeText(agentRecord && agentRecord.missionKind, "") === "trade"
        ? OBJECTIVE_TYPE_FETCH
        : isCourierMission(agentRecord, missionTemplate)
        ? OBJECTIVE_TYPE_TRANSPORT
        : OBJECTIVE_TYPE_DUNGEON
    );
  const dropoffStation = resolveDropoffStation(agentRecord);
  const fetchDropoffStationID = sourceStationID;
  // Dungeon missions with an objective item keep objectiveMode "dungeon" for site
  // creation/tracking, while the cargo spec drives the return and hand-in axis.
  // This covers encounter-fetch, mining, and authored exploration/trade chains.
  const clientDungeonItemSpec =
    objectiveMode === OBJECTIVE_TYPE_DUNGEON &&
    clientKillMission &&
    normalizePositiveInteger(clientKillMission.objectiveTypeID, 0) > 0 &&
    normalizePositiveInteger(clientKillMission.objectiveQuantity, 0) > 0
      ? clientKillMission
      : objectiveMode === OBJECTIVE_TYPE_DUNGEON &&
        clientCourierMission &&
        normalizePositiveInteger(clientCourierMission.objectiveTypeID, 0) > 0 &&
        normalizePositiveInteger(clientCourierMission.objectiveQuantity, 0) > 0
      ? clientCourierMission
      : null;
  const cargo =
    objectiveMode === OBJECTIVE_TYPE_TRANSPORT || objectiveMode === OBJECTIVE_TYPE_FETCH
    ? (() => {
        const typeID = normalizePositiveInteger(
          clientCourierMission && clientCourierMission.objectiveTypeID,
          PLACEHOLDER_CARGO_TYPE_ID,
        );
        const quantity = Math.max(
          1,
          normalizeInteger(
            clientCourierMission && clientCourierMission.objectiveQuantity,
            PLACEHOLDER_CARGO_QUANTITY,
          ),
        );
        const itemRecord = resolveItemByTypeID(typeID);
        return {
          typeID,
          quantity,
          volume: (Number(itemRecord && itemRecord.volume) || 1) * quantity,
          hasCargo: false,
          granted: false,
        };
      })()
    : clientDungeonItemSpec
    ? (() => {
        const typeID = normalizePositiveInteger(clientDungeonItemSpec.objectiveTypeID, 0);
        const quantity = Math.max(1, normalizeInteger(clientDungeonItemSpec.objectiveQuantity, 1));
        const itemRecord = resolveItemByTypeID(typeID);
        return {
          typeID,
          quantity,
          volume: (Number(itemRecord && itemRecord.volume) || 1) * quantity,
          hasCargo: false,
          granted: false,
        };
      })()
    : null;
  const presentationMissionTemplate =
    matchedMissionTemplate || runtimeDungeonTemplate || missionTemplate || null;
  const capturedMissionSystemID = resolveCapturedMissionSystemID(
    presentationMissionTemplate,
    contentID,
    agentRecord,
  );
  const capturedMissionPosition = resolveCapturedMissionPosition(
    presentationMissionTemplate,
    contentID,
    agentRecord,
  );
  const runtimeMissionTemplate =
    matchedMissionTemplate &&
    normalizeText(matchedMissionTemplate && matchedMissionTemplate.siteFamily, "").toLowerCase() === "mission"
      ? matchedMissionTemplate
      : runtimeDungeonTemplate || matchedMissionTemplate || missionTemplate || null;
  const conversationTargetLocation = buildMissionConversationTargetLocationWrap(
    {
      contentID,
      agentID,
    },
    agentRecord,
  );
  const missionTemplateID =
    objectiveMode === OBJECTIVE_TYPE_TRANSPORT || objectiveMode === OBJECTIVE_TYPE_FETCH || objectiveMode === OBJECTIVE_TYPE_AGENT
    ? `client-mission:${missionContentIDToText(contentID, "unknown")}`
    : normalizeText(
        presentationMissionTemplate && presentationMissionTemplate.templateID,
        fallbackMissionTemplateID || `client-mission:${missionContentIDToText(contentID, "unknown")}`,
      );
  const clientMissionTitle = normalizeText(
    getMissionLocalizedNameText(clientMissionRecord),
    humanizeClientMissionContentTemplate(
      clientMissionRecord && clientMissionRecord.contentTemplate,
    ),
  );
  const missionTitle =
    objectiveMode === OBJECTIVE_TYPE_TRANSPORT ||
    objectiveMode === OBJECTIVE_TYPE_FETCH ||
    objectiveMode === OBJECTIVE_TYPE_AGENT
    ? normalizeText(
        clientMissionTitle,
        missionContentIDToText(contentID, missionTemplateID),
      )
    : normalizeText(
        presentationMissionTemplate && presentationMissionTemplate.title,
        normalizeText(
          clientMissionTitle,
          missionContentIDToText(contentID, missionTemplateID),
        ),
      );
  const missionSystemID =
    objectiveMode === OBJECTIVE_TYPE_AGENT
      ? normalizePositiveInteger(
          conversationTargetLocation && conversationTargetLocation.solarsystemID,
          normalizePositiveInteger(agentRecord && agentRecord.solarSystemID, 0),
        )
      : objectiveMode === OBJECTIVE_TYPE_FETCH
      ? normalizePositiveInteger(
          agentRecord && agentRecord.solarSystemID,
          normalizePositiveInteger(agentRecord && agentRecord.solarSystemID, 0),
        )
      : objectiveMode === OBJECTIVE_TYPE_TRANSPORT
      ? normalizePositiveInteger(
          dropoffStation && dropoffStation.solarSystemID,
          normalizePositiveInteger(agentRecord && agentRecord.solarSystemID, 0),
        )
      : objectiveMode === OBJECTIVE_TYPE_DUNGEON
      ? capturedMissionSystemID || normalizePositiveInteger(
        clientObjectiveContext.dungeon_location_id,
        normalizePositiveInteger(agentRecord && agentRecord.solarSystemID, 0),
      )
      : normalizePositiveInteger(agentRecord && agentRecord.solarSystemID, 0);
  const missionPosition =
    objectiveMode === OBJECTIVE_TYPE_TRANSPORT ||
    objectiveMode === OBJECTIVE_TYPE_FETCH ||
    objectiveMode === OBJECTIVE_TYPE_AGENT
    ? null
    : capturedMissionPosition || buildMissionSitePosition(missionSystemID, {
        missionSequence,
        contentID,
      }, agentRecord);
  const offerExpirationMs = resolveMissionExpirationDurationMs(clientMissionRecord);

  state.nextMissionSequence = missionSequence + 1;
  if (advanceSelectionCursor) {
    characterState.missionSelectionCursorByAgentID[String(agentID)] =
      (normalizeInteger(
        characterState.missionSelectionCursorByAgentID[String(agentID)],
        0,
      ) + 1);
  }

  return {
    missionSequence,
    agentID,
    contentID,
    missionTemplateID,
    missionContentTemplateID: normalizeText(
      clientMissionRecord && clientMissionRecord.contentTemplate,
      "",
    ),
    missionNameID: normalizePositiveInteger(
      clientMissionRecord && clientMissionRecord.nameID,
      0,
    ),
    missionPoolKey: normalizeText(agentRecord && agentRecord.missionPoolKey, ""),
    missionKind: normalizeText(
      clientMissionKind,
      normalizeText(agentRecord && agentRecord.missionKind, "encounter"),
    ),
    missionTypeLabel:
      objectiveMode === OBJECTIVE_TYPE_AGENT &&
      (
        clientMissionKind.toLowerCase() === "talktoagent" ||
        normalizeBoolean(clientMissionRecord && clientMissionRecord.isTalkToAgent, false)
      )
        ? "UI/Agents/MissionTypes/EpicArcTalkToAgent"
        : buildMissionTypeLabel(agentRecord),
    missionTitle,
    importantMission,
    runtimeStatus: "offered",
    placeholder: false,
    objectiveMode,
    objectiveCompleted: false,
    gmCompleted: false,
    remoteCompletable:
      clientMissionRecord && clientMissionRecord.remoteCompletable !== undefined &&
      clientMissionRecord.remoteCompletable !== null
        ? normalizeBoolean(clientMissionRecord.remoteCompletable, false)
        : null,
    offeredAtFileTime: currentFileTimeString(),
    acceptedAtFileTime: null,
    expiresAtFileTime:
      offerExpirationMs > 0 ? futureFileTimeString(offerExpirationMs) : "0",
    lastUpdatedAtMs: Date.now(),
    dungeonTemplateID:
      objectiveMode === OBJECTIVE_TYPE_DUNGEON
        ? normalizeText(
            runtimeMissionTemplate && runtimeMissionTemplate.templateID,
            missionTemplateID,
          )
        : "",
    dungeonID:
      objectiveMode === OBJECTIVE_TYPE_DUNGEON
        ? // The retail client's GetDungeon() only resolves real catalog dungeon ids; a synthetic/placeholder
          // id returns None and crashes agentDialogueUtil._ProcessDungeonData (empty agent window). Prefer
          // the matched template's source dungeon, then the mission's authoritative catalog dungeon.
          normalizePositiveInteger(runtimeMissionTemplate && runtimeMissionTemplate.sourceDungeonID, 0) ||
          normalizePositiveInteger(
            clientDungeonID,
            0,
          ) ||
          PLACEHOLDER_DUNGEON_ID_OFFSET + missionSequence
        : null,
    dungeonInstanceID: null,
    missionSiteID:
      objectiveMode === OBJECTIVE_TYPE_DUNGEON
        ? MISSION_SITE_ID_OFFSET + missionSequence
        : null,
    missionSystemID,
    missionPosition,
    bookmarkIDsByRole: {},
    cargo,
    pickupLocation:
      objectiveMode === OBJECTIVE_TYPE_TRANSPORT
        ? buildLocationWrapForStation(sourceStationID)
        : objectiveMode === OBJECTIVE_TYPE_FETCH
        ? null
        : objectiveMode === OBJECTIVE_TYPE_AGENT
        ? buildAgentLocationWrap(agentRecord)
        : buildMissionSiteLocationWrap(agentRecord, {
            missionSystemID,
            missionPosition,
          }, runtimeMissionTemplate || presentationMissionTemplate),
    dropoffLocation:
      objectiveMode === OBJECTIVE_TYPE_AGENT
        ? conversationTargetLocation
        : objectiveMode === OBJECTIVE_TYPE_FETCH
        ? buildLocationWrapForStation(fetchDropoffStationID)
        : objectiveMode === OBJECTIVE_TYPE_DUNGEON
        ? buildLocationWrapForStation(sourceStationID)
        : buildLocationWrapForStation(
            normalizePositiveInteger(dropoffStation && dropoffStation.stationID, sourceStationID),
          ),
    rewards: buildMissionRewards(
      agentRecord,
      importantMission,
      clientMissionRecord,
      characterState && characterState.characterID,
      presentationMissionTemplate,
      contentID,
    ),
  };
}

function buildPendingStorylineOfferMissionRecord(agentRecord, offerRecord) {
  const agentID = normalizePositiveInteger(agentRecord && agentRecord.agentID, 0);
  const offerAgentID = normalizePositiveInteger(offerRecord && offerRecord.agentID, 0);
  if (!agentID || agentID !== offerAgentID) {
    return null;
  }

  const directContentID = normalizeMissionContentID(
    offerRecord && offerRecord.contentID,
    null,
  );
  const missionTemplateID = normalizeText(
    offerRecord && offerRecord.missionTemplateID,
    "",
  );
  if (directContentID === null && !missionTemplateID) {
    return null;
  }

  const directClientMissionRecord =
    directContentID === null ? null : getMissionByID(directContentID);
  const clientMissionRecord = directClientMissionRecord || getClientMissionRecord({
    contentID: directContentID,
    agentID,
    missionTemplateID,
  });
  const clientMissionKind = normalizeText(
    clientMissionRecord && clientMissionRecord.missionKind,
    "",
  );
  const clientCourierMission =
    clientMissionRecord &&
    clientMissionRecord.courierMission &&
    typeof clientMissionRecord.courierMission === "object" &&
    Object.keys(clientMissionRecord.courierMission).length > 0
      ? clientMissionRecord.courierMission
      : null;
  const objectiveMode = clientMissionRecord
    ? (
      normalizeBoolean(clientMissionRecord && clientMissionRecord.isTalkToAgent, false) ||
      clientMissionKind === "talkToAgent" ||
      normalizeBoolean(clientMissionRecord && clientMissionRecord.isAgentInteraction, false) ||
      clientMissionKind === "agentInteraction"
        ? OBJECTIVE_TYPE_AGENT
        : clientMissionKind === "trade"
        ? OBJECTIVE_TYPE_FETCH
        : clientCourierMission
        ? OBJECTIVE_TYPE_TRANSPORT
        : OBJECTIVE_TYPE_DUNGEON
    )
    : OBJECTIVE_TYPE_DUNGEON;
  const contentID = resolveClientMissionContentID(
    {
      contentID: directContentID,
      agentID,
      missionTemplateID,
      missionKind: clientMissionKind,
    },
    agentRecord,
  );
  const clientMissionTitle = normalizeText(
    getMissionLocalizedNameText(clientMissionRecord),
    humanizeClientMissionContentTemplate(
      clientMissionRecord && clientMissionRecord.contentTemplate,
    ),
  );
  const fallbackTitle = normalizeText(
    offerRecord && offerRecord.missionTitle,
    missionContentIDToText(contentID, "Storyline Mission"),
  );

  return {
    missionSequence: normalizePositiveInteger(
      offerRecord && offerRecord.missionSequence,
      0,
    ),
    agentID,
    contentID,
    missionTemplateID: normalizeText(
      missionTemplateID,
      `client-mission:${missionContentIDToText(contentID, "storyline-pending")}`,
    ),
    missionContentTemplateID: normalizeText(
      clientMissionRecord && clientMissionRecord.contentTemplate,
      "",
    ),
    missionNameID: normalizePositiveInteger(
      clientMissionRecord && clientMissionRecord.nameID,
      0,
    ),
    missionKind: normalizeText(
      clientMissionKind,
      normalizeText(agentRecord && agentRecord.missionKind, "encounter"),
    ),
    missionTypeLabel: buildStorylineMissionTypeLabel(agentRecord, clientMissionRecord),
    missionTitle: normalizeText(clientMissionTitle, fallbackTitle),
    importantMission: true,
    runtimeStatus: AGENT_MISSION_OFFERED,
    objectiveMode,
    objectiveCompleted: false,
    gmCompleted: false,
    remoteCompletable:
      clientMissionRecord && clientMissionRecord.remoteCompletable !== undefined &&
      clientMissionRecord.remoteCompletable !== null
        ? normalizeBoolean(clientMissionRecord.remoteCompletable, false)
        : null,
    offeredAtFileTime: normalizeText(offerRecord && offerRecord.offeredAtFileTime, ""),
    acceptedAtFileTime: null,
    expiresAtFileTime: normalizeText(offerRecord && offerRecord.expiresAtFileTime, ""),
    lastUpdatedAtMs: Number(offerRecord && offerRecord.lastUpdatedAtMs) || null,
    bookmarkIDsByRole: {},
    cargo: null,
    pickupLocation: null,
    dropoffLocation: null,
    rewards: buildMissionRewards(agentRecord, true, clientMissionRecord),
    storylineOfferProjection: true,
  };
}

function buildStandingPreview(characterID, agentRecord, missionRecord) {
  return standingRuntime.buildStandingPreview(
    normalizePositiveInteger(characterID, 0),
    standingRuntime.buildMissionRewardStandingChanges(agentRecord, missionRecord),
  );
}

// A mission "grants items on accept" when accepting it deposits goods into the player's
// hangar: an initial agent gift dropped in the agent's station (grantMissionInitialAgentGift)
// or courier cargo staged in the pickup hangar (ensureMissionSiteState). Those goods land at
// a fixed station, so the player must be there in person to receive them.
function missionGrantsItemsOnAccept(missionRecord) {
  const clientMissionRecord = getClientMissionRecord(missionRecord);
  if (
    normalizePositiveInteger(
      clientMissionRecord && clientMissionRecord.initialAgentGiftTypeID,
      0,
    ) > 0
  ) {
    return true;
  }
  // Every courier/transport mission stages haulable cargo in the pickup hangar the moment it
  // is accepted, regardless of whether the offer projection has populated the cargo record yet.
  return (
    normalizeText(missionRecord && missionRecord.objectiveMode, "") === OBJECTIVE_TYPE_TRANSPORT
  );
}

// Remote offering lets the player accept an offered mission from the journal without docking at
// the agent. It is allowed by default, except for missions that must be transacted in person:
// talk-to-agent conversations and anything that hands the player items on accept. An explicit
// per-mission authoring flag (remoteOfferable) overrides the derived decision when present.
function isMissionRemoteOfferable(missionRecord) {
  const clientMissionRecord = getClientMissionRecord(missionRecord);
  if (
    clientMissionRecord &&
    clientMissionRecord.remoteOfferable !== null &&
    clientMissionRecord.remoteOfferable !== undefined
  ) {
    return normalizeBoolean(clientMissionRecord.remoteOfferable, false);
  }
  if (isAgentObjectiveMissionRecord(missionRecord)) {
    return false;
  }
  return !missionGrantsItemsOnAccept(missionRecord);
}

function getPreferredCharacterSession(characterID) {
  const normalizedCharacterID = normalizePositiveInteger(characterID, 0);
  if (!normalizedCharacterID) {
    return null;
  }
  return sessionRegistry.findSessionByCharacterID(normalizedCharacterID) || null;
}

function isCharacterAtAgentLocation(characterID, agentRecord) {
  const session = getPreferredCharacterSession(characterID);
  if (!session || !agentRecord) {
    return false;
  }
  const agentStationID = normalizePositiveInteger(agentRecord.stationID, 0);
  if (agentStationID > 0) {
    return normalizePositiveInteger(session.stationid, 0) === agentStationID;
  }
  const agentSolarSystemID = normalizePositiveInteger(agentRecord.solarSystemID, 0);
  return agentSolarSystemID > 0 &&
    normalizePositiveInteger(session.locationid, 0) === agentSolarSystemID;
}

function isCharacterAtMissionCompletionLocation(characterID, agentRecord, missionRecord) {
  const session = getPreferredCharacterSession(characterID);
  if (!session || !agentRecord) {
    return false;
  }
  const dropoffStationID = normalizePositiveInteger(
    missionRecord &&
      missionRecord.dropoffLocation &&
      missionRecord.dropoffLocation.locationID,
    0,
  );
  const completesAtDropoff = dropoffStationID > 0 && (
    missionRecord.objectiveMode === OBJECTIVE_TYPE_TRANSPORT ||
    Boolean(missionRecord.cargo)
  );
  if (completesAtDropoff) {
    return normalizePositiveInteger(session.stationid, 0) === dropoffStationID;
  }
  return isCharacterAtAgentLocation(characterID, agentRecord);
}

function isMissionRemoteCompletable(missionRecord, options = {}) {
  const clientMissionRecord = getClientMissionRecord(missionRecord);
  const explicitRemoteCompletable = normalizeBoolean(
    missionRecord && missionRecord.remoteCompletable,
    normalizeBoolean(
      clientMissionRecord && clientMissionRecord.remoteCompletable,
      false,
    ),
  );
  if (!explicitRemoteCompletable) {
    return false;
  }
  const agentRecord =
    options.agentRecord || getAgentRecord(missionRecord && missionRecord.agentID);
  const characterID = normalizePositiveInteger(options.characterID, 0);
  if (!characterID || !agentRecord) {
    return true;
  }
  return !isCharacterAtAgentLocation(characterID, agentRecord);
}

function buildMissionJournalRow(characterID, agentRecord, missionRecord) {
  const bookmarks = listMissionBookmarks(characterID, missionRecord);
  const missionTypeLabel = normalizeText(
    missionRecord && missionRecord.missionTypeLabel,
    buildMissionTypeLabel(agentRecord),
  );
  return [
    getMissionStateFromRecord(missionRecord),
    normalizeBoolean(missionRecord && missionRecord.importantMission, false) ? 1 : 0,
    missionTypeLabel,
    resolveMissionTitleValue(missionRecord, null),
    normalizePositiveInteger(agentRecord && agentRecord.agentID, 0),
    fileTimeBigIntToLong(fileTimeStringToBigInt(missionRecord && missionRecord.expiresAtFileTime)),
    bookmarks,
    isMissionRemoteOfferable(missionRecord) ? 1 : 0,
    isMissionRemoteCompletable(missionRecord, {
      characterID,
      agentRecord,
    }) ? 1 : 0,
    resolveClientMissionContentID(missionRecord, agentRecord),
  ];
}

function buildPendingStorylineOfferJournalRows(
  characterID,
  characterState,
  activeAgentIDs = new Set(),
) {
  const pendingOffers =
    characterState &&
    characterState.storylineProgress &&
    characterState.storylineProgress.pendingOffersByAgentID &&
    typeof characterState.storylineProgress.pendingOffersByAgentID === "object"
      ? characterState.storylineProgress.pendingOffersByAgentID
      : {};
  return Object.values(pendingOffers)
    .map((offerRecord) => {
      const agentID = normalizePositiveInteger(offerRecord && offerRecord.agentID, 0);
      if (
        !agentID ||
        activeAgentIDs.has(agentID) ||
        normalizeText(offerRecord && offerRecord.status, "pending") !== "pending"
      ) {
        return null;
      }
      const agentRecord = getAgentRecord(agentID);
      const projectedMissionRecord = buildPendingStorylineOfferMissionRecord(
        agentRecord,
        offerRecord,
      );
      return agentRecord && projectedMissionRecord
        ? buildMissionJournalRow(characterID, agentRecord, projectedMissionRecord)
        : null;
    })
    .filter(Boolean);
}

function buildMissionBriefingInfo(
  characterID,
  agentRecord,
  missionRecord,
  missionTemplate,
) {
  const clientMissionRecord = getClientMissionRecord(missionRecord);
  const accepted = normalizeText(
    missionRecord && missionRecord.runtimeStatus,
    "offered",
  ) === "accepted";
  const hasAuthoredOfferExpiration = normalizePositiveInteger(
    clientMissionRecord && clientMissionRecord.expirationTime,
    0,
  ) > 0;
  const expirationFileTime = fileTimeStringToBigInt(
    missionRecord && missionRecord.expiresAtFileTime,
  );
  const declineUntilFileTime = fileTimeStringToBigInt(
    getReplayUntilFileTime(characterID, agentRecord && agentRecord.agentID),
  );
  const declineTime = accepted
    ? null
    : declineUntilFileTime > nowFileTimeBigInt()
    ? fileTimeBigIntToLong(declineUntilFileTime)
    : -1;
  return {
    "Mission Keywords": buildMissionKeywords(
      agentRecord,
      missionRecord,
      missionTemplate,
    ),
    "Mission Title ID": resolveMissionTitleValue(missionRecord, missionTemplate),
    "ContentID": null,
    "Mission Image": buildMissionImage(missionRecord),
    "Decline Time": declineTime,
    "AcceptTimestamp":
      accepted && missionRecord && missionRecord.acceptedAtFileTime
        ? fileTimeBigIntToLong(
            fileTimeStringToBigInt(missionRecord.acceptedAtFileTime),
          )
        : null,
    "Expiration Time":
      expirationFileTime > 0n && (accepted || hasAuthoredOfferExpiration)
        ? fileTimeBigIntToLong(expirationFileTime)
        : null,
    "Mission Briefing ID": resolveMissionBriefingValue(
      agentRecord,
      missionRecord,
      missionTemplate,
      clientMissionRecord,
      [
        "messages.mission.briefing",
        "messages.mission.extrainfo.body",
        "messages.mission.offered.agentsays",
      ],
    ),
  };
}

function buildMissionObjectiveLocationWrap(location) {
  const normalizedLocation = normalizeObject(location);
  return {
    typeID: normalizePositiveInteger(normalizedLocation.typeID, 1531),
    solarsystemID: normalizePositiveInteger(normalizedLocation.solarsystemID, 0),
    locationID: normalizePositiveInteger(normalizedLocation.locationID, 0),
  };
}

function buildMissionObjectiveCargo(cargo) {
  const normalizedCargo = normalizeObject(cargo);
  const itemSpec = buildMissionItemSpec(
    normalizedCargo,
    PLACEHOLDER_CARGO_TYPE_ID,
    PLACEHOLDER_CARGO_QUANTITY,
  );
  const typeID = normalizePositiveInteger(
    itemSpec && itemSpec.typeID,
    PLACEHOLDER_CARGO_TYPE_ID,
  );
  const quantity = Math.max(1, normalizeInteger(itemSpec && itemSpec.quantity, 1));
  const itemRecord = resolveItemByTypeID(typeID);
  const explicitVolume = Number(normalizedCargo.volume);
  return {
    volume:
      Number.isFinite(explicitVolume) && explicitVolume > 0
        ? explicitVolume
        : (Number(itemRecord && itemRecord.volume) || 1) * quantity,
    typeID,
    hasCargo: normalizeBoolean(normalizedCargo.hasCargo, false),
    quantity,
  };
}

function resolveMissionObjectiveLocationOwnerID(location, fallbackOwnerID = 0) {
  const station = worldData.getStationByID(
    location && location.locationID,
  );
  return normalizePositiveInteger(
    station && station.corporationID,
    normalizePositiveInteger(fallbackOwnerID, 0),
  );
}

function buildMissionObjectivePayload(agentRecord, missionRecord, missionTemplate) {
  if (!agentRecord || !missionRecord) {
    return {
      completionStatus: 0,
      collateral: [],
      dungeons: [],
      objectives: [],
      locations: [],
      importantStandings: 0,
      missionExtra: null,
      contentID: null,
      agentGift: [],
      normalRewards: [],
      bonusRewards: [],
      researchPoints: 0,
      missionState: null,
      loyaltyPoints: 0,
      missionTitleID: null,
    };
  }

  const objectiveCompleted = normalizeBoolean(
    missionRecord && missionRecord.objectiveCompleted,
    false,
  );
  const clientMissionRecord = getClientMissionRecord(missionRecord);
  const dungeonTemplate = getDungeonMissionTemplateRecord(missionRecord);
  const presentationTemplate = missionTemplate || dungeonTemplate || null;
  const completionStatus = objectiveCompleted
    ? (normalizeBoolean(missionRecord && missionRecord.gmCompleted, false) ? 2 : 1)
    : 0;
  const missionState = getMissionStateFromRecord(missionRecord);
  const rewards = missionRecord.rewards || {};
  const clientFacingContentID = resolveClientMissionContentID(
    missionRecord,
    agentRecord,
  );
  const objectives = [];
  const dungeons = [];
  const isCourier = missionRecord.objectiveMode === OBJECTIVE_TYPE_TRANSPORT;
  const isFetch = isFetchMissionRecord(missionRecord);
  const hasDungeonItemAxis = hasDungeonItemPresentationAxis(missionRecord);
  const isAgentObjective = isAgentObjectiveMissionRecord(missionRecord);
  const pickupSystemID = normalizePositiveInteger(
    missionRecord && missionRecord.pickupLocation && missionRecord.pickupLocation.solarsystemID,
    0,
  );
  const dropoffSystemID = normalizePositiveInteger(
    missionRecord && missionRecord.dropoffLocation && missionRecord.dropoffLocation.solarsystemID,
    0,
  );
  const missionSystemID = normalizePositiveInteger(
    missionRecord && missionRecord.missionSystemID,
    0,
  );
  const missionLocations = isCourier
    ? [pickupSystemID, dropoffSystemID]
    : missionRecord.objectiveMode === OBJECTIVE_TYPE_DUNGEON
    ? (hasDungeonItemAxis
        ? [dropoffSystemID, missionSystemID]
        : [missionSystemID])
    : [dropoffSystemID || pickupSystemID || missionSystemID];

  if (isCourier) {
    const pickupLocation =
      missionRecord.pickupLocation || buildLocationWrapForStation(agentRecord.stationID);
    const dropoffLocation =
      missionRecord.dropoffLocation || buildLocationWrapForStation(agentRecord.stationID);
    objectives.push(buildMarshalTuple([
      OBJECTIVE_TYPE_TRANSPORT,
      buildMarshalTuple([
        resolveMissionObjectiveLocationOwnerID(
          pickupLocation,
          agentRecord.corporationID,
        ),
        buildMissionObjectiveLocationWrap(pickupLocation),
        resolveMissionObjectiveLocationOwnerID(
          dropoffLocation,
          agentRecord.corporationID,
        ),
        buildMissionObjectiveLocationWrap(dropoffLocation),
        buildMissionObjectiveCargo(missionRecord.cargo || resolvePlaceholderCargo()),
      ]),
    ]));
  }

  if (!isCourier && (isFetch || hasDungeonItemAxis)) {
    const objectiveLocation =
      missionRecord.dropoffLocation || buildLocationWrapForStation(agentRecord.stationID);
    const itemSpec = resolvePrimaryMissionItemSpec(missionRecord);
    const objectiveCargo = missionRecord.cargo || {
      ...(itemSpec || resolvePlaceholderCargo()),
      hasCargo: false,
    };
    objectives.push(buildMarshalTuple([
      OBJECTIVE_TYPE_FETCH,
      buildMarshalTuple([
        resolveMissionObjectiveLocationOwnerID(
          objectiveLocation,
          agentRecord.corporationID,
        ),
        buildMissionObjectiveLocationWrap(objectiveLocation),
        buildMissionObjectiveCargo(objectiveCargo),
      ]),
    ]));
  }

  if (!isCourier && isAgentObjective) {
    const targetAgentID = getMissionConversationTargetAgentID(
      missionRecord,
      normalizePositiveInteger(agentRecord && agentRecord.agentID, 0),
    );
    const targetLocation = buildMissionConversationTargetLocationWrap(
      missionRecord,
      agentRecord,
    );
    if (targetAgentID > 0 && targetLocation) {
      objectives.push(buildMarshalTuple([
        OBJECTIVE_TYPE_AGENT,
        buildMarshalTuple([
          targetAgentID,
          cloneValue(targetLocation),
        ]),
      ]));
    }
  }

  if (!isCourier && !isFetch && !isAgentObjective) {
    const dungeonID =
        // The stored runtime record may carry a placeholder id (>= PLACEHOLDER_DUNGEON_ID_OFFSET) the retail
        // client's GetDungeon() can't resolve (-> agentDialogueUtil._ProcessDungeonData crash / empty agent
        // window). Resolve a REAL catalog dungeon id at render time: the stored id only if it's already a
        // real catalog id, else the matched dungeon template's source, else the mission's authoritative
        // killMission dungeon, else the placeholder.
        (normalizePositiveInteger(missionRecord.dungeonID, 0) < PLACEHOLDER_DUNGEON_ID_OFFSET
          ? normalizePositiveInteger(missionRecord.dungeonID, 0)
          : 0) ||
        normalizePositiveInteger(dungeonTemplate && dungeonTemplate.sourceDungeonID, 0) ||
        normalizePositiveInteger(
          clientMissionRecord && clientMissionRecord.killMission && clientMissionRecord.killMission.dungeonID,
          0,
        ) ||
        PLACEHOLDER_DUNGEON_ID_OFFSET + normalizePositiveInteger(missionRecord.missionSequence, 0);
    const dungeonLocation = cloneValue(
        missionRecord.pickupLocation || buildMissionSiteLocationWrap(
          agentRecord,
          missionRecord,
          dungeonTemplate || presentationTemplate,
        ),
      );
    const briefingMessage = buildEncounterObjectiveBriefingMessage(
      agentRecord,
      missionRecord,
      presentationTemplate,
      dungeonTemplate,
      clientMissionRecord,
    );
    const miningMission = isMiningMissionRecord(missionRecord);
    const dungeonObjective = {
      // Match the legacy agent-service dictionary order. The client treats this
      // as a normal dict, but preserving the captured order keeps every dungeon
      // family on the protocol-faithful wire shape established by the golden.
      briefingMessage,
      dungeonID,
      ...(objectiveCompleted ? { completed: 1 } : {}),
      ...(!miningMission && hasMissionShipRestrictions(presentationTemplate, dungeonTemplate)
        ? { shipRestrictions: 1 }
        : {}),
      location: dungeonLocation,
      objectiveCompleted: objectiveCompleted ? 1 : null,
      ...(!miningMission
        ? { ownerID: resolveMissionEnemyOwnerID(presentationTemplate, dungeonTemplate) }
        : {}),
      optional: false,
    };
    dungeons.push(dungeonObjective);
  }

  const normalRewards = [
    rewards.isk
      ? buildMarshalTuple([
          ISK_DISPLAY_TYPE_ID,
          Math.max(1, Math.round(Number(rewards.isk) || 0)),
          null,
        ])
      : null,
    ...normalizeArray(rewards.itemRewards)
      .map((rewardRecord) => buildMissionRewardDisplayEntry(rewardRecord))
      .filter(Boolean),
  ].filter(Boolean);
  const bonusTimeRemainingTicks = resolveMissionBonusTimeRemainingTicks(missionRecord);
  const bonusIntervalMinutes = Math.max(
    0,
    normalizeInteger(rewards.bonusTimeIntervalMinutes, 0),
  );
  if (bonusIntervalMinutes <= 0) {
    if (rewards.bonusIsk) {
      normalRewards.push(buildMarshalTuple([
        ISK_DISPLAY_TYPE_ID,
        Math.max(1, Math.round(Number(rewards.bonusIsk) || 0)),
        null,
      ]));
    }
    normalRewards.push(
      ...normalizeArray(rewards.bonusItemRewards)
        .map((rewardRecord) => buildMissionRewardDisplayEntry(rewardRecord))
        .filter(Boolean),
    );
  }
  const bonusRewards = bonusIntervalMinutes > 0
    ? [
        rewards.bonusIsk
          ? buildMarshalTuple([
              bonusTimeRemainingTicks,
              ISK_DISPLAY_TYPE_ID,
              Math.max(1, Math.round(Number(rewards.bonusIsk) || 0)),
              null,
              bonusIntervalMinutes,
            ])
          : null,
        ...normalizeArray(rewards.bonusItemRewards)
          .map((rewardRecord) => {
            const rewardEntry = buildMissionRewardDisplayEntry(rewardRecord);
            if (!rewardEntry) {
              return null;
            }
            const rewardItems = getTupleItems(rewardEntry);
            return buildMarshalTuple([
              bonusTimeRemainingTicks,
              rewardItems[0],
              rewardItems[1],
              rewardItems[2],
              bonusIntervalMinutes,
            ]);
          })
          .filter(Boolean),
      ].filter(Boolean)
    : [];
  const missionExtraHeaderID = getMissionMessageID(
    clientMissionRecord,
    "messages.mission.extrainfo.header",
  );
  const missionExtraBodyID = getMissionMessageID(
    clientMissionRecord,
    "messages.mission.extrainfo.body",
  );
  const missionExtra = missionExtraHeaderID > 0 || missionExtraBodyID > 0
    ? buildMarshalTuple([
        missionExtraHeaderID > 0
          ? missionExtraHeaderID
          : resolveMissionTitleValue(missionRecord, presentationTemplate),
        missionExtraBodyID > 0
          ? missionExtraBodyID
          : getMissionMessageID(clientMissionRecord, "messages.mission.briefing") ||
            resolveMissionTitleValue(missionRecord, presentationTemplate),
      ])
    : null;

  return {
    completionStatus,
    collateral: [],
    dungeons,
    objectives,
    locations: missionLocations.filter(Boolean),
    importantStandings: normalizeBoolean(missionRecord.importantMission, false) ? 1 : 0,
    ...(missionExtra ? { missionExtra } : {}),
    contentID: clientFacingContentID,
    agentGift:
      normalizePositiveInteger(clientMissionRecord && clientMissionRecord.initialAgentGiftTypeID, 0) > 0
        ? [buildMarshalTuple([
            normalizePositiveInteger(clientMissionRecord.initialAgentGiftTypeID, 0),
            Math.max(
              1,
              normalizeInteger(clientMissionRecord.initialAgentGiftQuantity, 1),
            ),
            null,
          ])]
        : [],
    normalRewards,
    bonusRewards,
    researchPoints: Math.max(0, normalizeInteger(rewards.researchPoints, 0)),
    missionState,
    loyaltyPoints: Math.max(0, normalizeInteger(rewards.loyaltyPoints, 0)),
    missionTitleID: resolveMissionTitleValue(missionRecord, presentationTemplate),
  };
}

function buildMissionJournalInfo(characterID, agentRecord, missionRecord, missionTemplate) {
  const clientMissionRecord = getClientMissionRecord(missionRecord);
  const clientFacingContentID = resolveClientMissionContentID(
    missionRecord,
    agentRecord,
  );
  return {
    missionNameID: resolveMissionTitleValue(missionRecord, missionTemplate),
    contentID: clientFacingContentID,
    briefingTextID: resolveMissionBriefingValue(
      agentRecord,
      missionRecord,
      missionTemplate,
      clientMissionRecord,
      [
        "messages.mission.briefing",
        "messages.mission.extrainfo.body",
        "messages.mission.offered.agentsays",
      ],
    ),
    missionImage: buildMissionImage(missionRecord),
    expirationTime: fileTimeBigIntToLong(
      fileTimeStringToBigInt(missionRecord && missionRecord.expiresAtFileTime),
    ),
    missionState: getMissionStateFromRecord(missionRecord),
    objectives: buildMissionObjectivePayload(
      agentRecord,
      missionRecord,
      missionTemplate,
    ),
    bookmarks: listMissionBookmarks(characterID, missionRecord),
    iconID:
      missionRecord && missionRecord.objectiveMode === OBJECTIVE_TYPE_TRANSPORT
        ? 16
        : null,
  };
}

function buildAgentLocationWrap(agentRecord) {
  const stationID = normalizePositiveInteger(agentRecord && agentRecord.stationID, 0);
  if (stationID) {
    return buildLocationWrapForStation(stationID);
  }
  const inSpace = agentRecord && agentRecord.agentInSpace;
  if (
    agentRecord &&
    agentRecord.isInSpace === true &&
    inSpace &&
    normalizePositiveInteger(inSpace.solarSystemID, 0) > 0
  ) {
    const solarSystemID = normalizePositiveInteger(inSpace.solarSystemID, 0);
    return {
      locationID: solarSystemID,
      typeID: 5,
      solarsystemID: solarSystemID,
      locationType: "agentinspace",
      agentInSpaceTypeID: normalizePositiveInteger(inSpace.typeID, 0) || null,
      dungeonID: normalizePositiveInteger(inSpace.dungeonID, 0) || null,
      spawnPointID: normalizePositiveInteger(inSpace.spawnPointID, 0) || null,
      source: normalizeText(inSpace.source, "sde:agentsInSpace"),
      sourceBuild: normalizePositiveInteger(inSpace.sourceBuild, 0) || null,
    };
  }
  return {
    locationID: normalizePositiveInteger(agentRecord && agentRecord.solarSystemID, 0),
    typeID: 5,
    solarsystemID: normalizePositiveInteger(agentRecord && agentRecord.solarSystemID, 0),
    locationType: "solarsystem",
  };
}

function getAgentLocationWrap(agentID) {
  return buildAgentLocationWrap(getAgentRecord(agentID));
}

function buildMissionServiceDetails(characterID, agentRecord) {
  const activeMission = getMissionRecord(characterID, agentRecord && agentRecord.agentID);
  return buildKeyVal([
    ["agentServiceType", "mission"],
    [
      "available",
      canUseAgent(characterID, agentRecord) &&
      !activeMission,
    ],
  ]);
}

function buildLocateServiceDetails(agentRecord) {
  if (!normalizeBoolean(agentRecord && agentRecord.isLocator, false)) {
    return null;
  }

  return buildKeyVal([
    ["agentServiceType", "locate"],
    ["frequency", intervalMsToTicks(5 * 60 * 1000)],
    ["delays", [
      [0, 0, 0],
      [1, 60, 5000],
      [2, 120, 15000],
      [3, 240, 35000],
    ]],
    ["callbackID", null],
    ["lastUsed", null],
  ]);
}

function notifyMissionChange(characterID, eventName, agentID) {
  const normalizedCharacterID = normalizePositiveInteger(characterID, 0);
  const normalizedAgentID = normalizePositiveInteger(agentID, 0);
  if (!normalizedCharacterID || !normalizedAgentID) {
    return;
  }

  for (const session of sessionRegistry.getSessions()) {
    if (
      Number(session && session.characterID) !== normalizedCharacterID ||
      typeof session.sendNotification !== "function"
    ) {
      continue;
    }
    session.sendNotification("OnAgentMissionChange", "charid", [
      eventName,
      normalizedAgentID,
    ]);
  }
}

function notifyStorylineOfferLifecycleChange(characterID, agentID, status = "pending") {
  const normalizedStatus = normalizeText(status, "pending").toLowerCase();
  const eventName =
    normalizedStatus === "pending" || normalizedStatus === "offered"
      ? AGENT_MISSION_OFFERED
      : normalizedStatus === "declined"
      ? AGENT_MISSION_OFFER_DECLINED
      : normalizedStatus === "expired"
      ? AGENT_MISSION_OFFER_EXPIRED
      : normalizedStatus === "removed"
      ? AGENT_MISSION_OFFER_REMOVED
      : "";
  if (!eventName) {
    return null;
  }
  notifyMissionChange(characterID, eventName, agentID);
  return eventName;
}

function notifyMissionTrackerUpdate(characterID, agentID) {
  const normalizedCharacterID = normalizePositiveInteger(characterID, 0);
  const normalizedAgentID = normalizePositiveInteger(agentID, 0);
  if (!normalizedCharacterID || !normalizedAgentID) {
    return;
  }

  for (const session of sessionRegistry.getSessions()) {
    if (
      Number(session && session.characterID) !== normalizedCharacterID ||
      typeof session.sendNotification !== "function"
    ) {
      continue;
    }

    const missionRecord = getMissionRecord(normalizedCharacterID, normalizedAgentID);
    const info = getMissionInfoItems(normalizedCharacterID, normalizedAgentID, {
      session,
      currentLocationID: normalizePositiveInteger(session && session.locationid, 0),
      currentStationID: normalizePositiveInteger(session && session.stationid, 0),
      inActiveDungeon: isSessionInActiveMissionDungeon(session, missionRecord),
    });
    const infoList = info && info.type === "tuple" && Array.isArray(info.items)
      ? buildList(info.items)
      : Array.isArray(info)
        ? buildList(info)
        : info;
    const updates = [buildDict([
      ["info", infoList],
      ["agentID", normalizedAgentID],
    ])];
    session.sendNotification("OnMissionsUpdated", "charid", [updates]);
  }
}

function getMissionRecord(characterID, agentID) {
  const characterState = getCharacterStateSnapshot(characterID);
  if (!characterState || !characterState.missionsByAgentID) {
    return null;
  }
  const missionRecord = characterState.missionsByAgentID[String(normalizePositiveInteger(agentID, 0))];
  return missionRecord ? cloneValue(missionRecord) : null;
}

function getReplayUntilFileTime(characterID, agentID) {
  const characterState = getCharacterStateSnapshot(characterID);
  if (!characterState || !characterState.declineTimersByAgentID) {
    return null;
  }
  return normalizeText(
    characterState.declineTimersByAgentID[String(normalizePositiveInteger(agentID, 0))],
    "",
  );
}

function offerMission(characterID, agentRecord) {
  const normalizedCharacterID = normalizePositiveInteger(characterID, 0);
  const normalizedAgentID = normalizePositiveInteger(agentRecord && agentRecord.agentID, 0);
  if (!normalizedCharacterID || !normalizedAgentID) {
    return { success: false, errorMsg: "INVALID_AGENT_OR_CHARACTER" };
  }

  return mutateCharacterState(normalizedCharacterID, (characterState, state) => {
    const existingMissionRecord = characterState.missionsByAgentID[String(normalizedAgentID)];
    if (existingMissionRecord) {
      return { kind: "existing", missionRecord: cloneValue(existingMissionRecord) };
    }

    // TEMP DEBUG HOOK (EveAnomUtility): force this agent to offer a specific mission id (e.g. 2391 The Score)
    // so the authored mission can be tested through the real agent flow. Unset EVEJS_FORCE_MISSION_ID to disable.
    const forcedMissionID = normalizePositiveInteger(process.env.EVEJS_FORCE_MISSION_ID, 0);
    if (forcedMissionID) {
      const forcedClientMission = getMissionByID(forcedMissionID);
      if (isMissionOfferAllowedForAgent(agentRecord, forcedClientMission)) {
        const forcedRecord = buildMissionRecord(
          state,
          characterState,
          agentRecord,
          null,
          0,
          forcedClientMission,
          false,
        );
        characterState.missionsByAgentID[String(normalizedAgentID)] = forcedRecord;
        return { kind: "offered", missionRecord: cloneValue(forcedRecord) };
      }
    }

    // Ordinary Security agents must be backed by an allowlisted client mission.
    // Their scraped template pools are intentionally not a fallback offer source.
    const pool = isOrdinarySecurityAgent(agentRecord)
      ? []
      : getMissionTemplatePool(normalizedAgentID);
    const availableClientMission = pickMissionForAgent(agentRecord, normalizeInteger(
      characterState.missionSelectionCursorByAgentID[String(normalizedAgentID)],
      0,
    ));
    if (!pool.length && !availableClientMission) {
      return { kind: "unavailable" };
    }

    const cursor = normalizeInteger(
      characterState.missionSelectionCursorByAgentID[String(normalizedAgentID)],
      0,
    );
    const selectedMissionTemplateID = pool.length > 0
      ? pool[cursor % pool.length]
      : "";
    const missionTemplate = selectedMissionTemplateID
      ? getMissionTemplateRecord(selectedMissionTemplateID)
      : null;
    const missionRecord = buildMissionRecord(
      state,
      characterState,
      agentRecord,
      missionTemplate,
      cursor,
    );
    characterState.missionsByAgentID[String(normalizedAgentID)] = missionRecord;
    return { kind: "offered", missionRecord: cloneValue(missionRecord) };
  });
}

function offerSpecificMission(characterID, agentRecord, clientMissionRecord) {
  const normalizedCharacterID = normalizePositiveInteger(characterID, 0);
  const normalizedAgentID = normalizePositiveInteger(agentRecord && agentRecord.agentID, 0);
  if (!normalizedCharacterID || !normalizedAgentID || !clientMissionRecord) {
    return { success: false, errorMsg: "INVALID_AGENT_OR_MISSION" };
  }

  return mutateCharacterState(normalizedCharacterID, (characterState, state) => {
    const existingMissionRecord = characterState.missionsByAgentID[String(normalizedAgentID)];
    if (existingMissionRecord) {
      return { kind: "existing", missionRecord: cloneValue(existingMissionRecord) };
    }

    const missionRecord = buildMissionRecord(
      state,
      characterState,
      agentRecord,
      null,
      0,
      clientMissionRecord,
      false,
    );
    characterState.missionsByAgentID[String(normalizedAgentID)] = missionRecord;
    return { kind: "offered", missionRecord: cloneValue(missionRecord) };
  });
}

function grantMissionInitialAgentGift(characterID, agentRecord, missionRecord) {
  const clientMissionRecord = getClientMissionRecord(missionRecord);
  const typeID = normalizePositiveInteger(
    clientMissionRecord && clientMissionRecord.initialAgentGiftTypeID,
    0,
  );
  if (!typeID) {
    return { success: true, data: { granted: false } };
  }

  const quantity = Math.max(
    1,
    normalizeInteger(clientMissionRecord && clientMissionRecord.initialAgentGiftQuantity, 1),
  );
  const stationID = normalizePositiveInteger(agentRecord && agentRecord.stationID, 0);
  if (!stationID) {
    return { success: true, data: { granted: false } };
  }

  const grantResult = grantItemsToCharacterStationHangar(characterID, stationID, [{
    itemType: typeID,
    quantity,
  }]);
  if (grantResult && grantResult.success === true) {
    notifyMissionInventoryChanges(
      characterID,
      (grantResult.data && grantResult.data.changes) || [],
    );
  }
  return grantResult;
}

function acceptMission(characterID, agentRecord) {
  const existingMissionRecord = getMissionRecord(characterID, agentRecord && agentRecord.agentID);
  if (!existingMissionRecord) {
    return {
      success: false,
      errorMsg: "MISSION_NOT_FOUND",
    };
  }
  if (normalizeText(existingMissionRecord.runtimeStatus, "").toLowerCase() !== "offered") {
    return {
      success: true,
      data: cloneValue(existingMissionRecord),
      acceptedNow: false,
    };
  }
  const missionTemplate = getRuntimeMissionTemplateRecord(existingMissionRecord);
  const preparedMissionRecord = ensureMissionSiteState(
    characterID,
    agentRecord,
    existingMissionRecord,
    missionTemplate,
  );
  // TEMP DEBUG HOOK (EveAnomUtility): report whether the accepted mission produced a warpable
  // deadspace site (objectiveMode/system/position/instance). If objectiveMode!="dungeon" or
  // dungeonInstanceID=0, there is no acceleration-gate site to warp to. Remove with the force hooks.
  try {
    const dbgPos = preparedMissionRecord && preparedMissionRecord.missionPosition;
    log.info(
      `[MissionDebug] accept char=${characterID} agent=${normalizePositiveInteger(agentRecord && agentRecord.agentID, 0)} ` +
      `title="${normalizeText(preparedMissionRecord && preparedMissionRecord.missionTitle, "")}" ` +
      `objectiveMode=${normalizeText(preparedMissionRecord && preparedMissionRecord.objectiveMode, "?")} ` +
      `missionSystemID=${normalizePositiveInteger(preparedMissionRecord && preparedMissionRecord.missionSystemID, 0)} ` +
      `dungeonInstanceID=${normalizePositiveInteger(preparedMissionRecord && preparedMissionRecord.dungeonInstanceID, 0)} ` +
      `missionSiteID=${normalizePositiveInteger(preparedMissionRecord && preparedMissionRecord.missionSiteID, 0)} ` +
      `runtimeTemplateID="${normalizeText(getMissionInstanceTemplateRecord(preparedMissionRecord) && getMissionInstanceTemplateRecord(preparedMissionRecord).templateID, "")}" ` +
      `pos=${dbgPos ? `${Math.round(dbgPos.x)},${Math.round(dbgPos.y)},${Math.round(dbgPos.z)}` : "none"} ` +
      `forceID=${normalizePositiveInteger(process.env.EVEJS_FORCE_MISSION_ID, 0)}`,
    );
  } catch (debugError) {
    log.warn(`[MissionDebug] accept logging failed: ${debugError.message}`);
  }
  const giftResult = grantMissionInitialAgentGift(
    characterID,
    agentRecord,
    preparedMissionRecord,
  );
  if (giftResult && giftResult.success === false) {
    return giftResult;
  }
  const acceptResult = mutateCharacterState(characterID, (characterState) => {
    const missionRecord = characterState.missionsByAgentID[String(agentRecord.agentID)];
    if (
      !missionRecord ||
      normalizeText(missionRecord.runtimeStatus, "").toLowerCase() !== "offered"
    ) {
      return null;
    }
    Object.assign(missionRecord, cloneValue(preparedMissionRecord));
    missionRecord.runtimeStatus = "accepted";
    missionRecord.acceptedAtFileTime = currentFileTimeString();
    const expirationDurationMs = resolveMissionExpirationDurationMs(
      getClientMissionRecord(missionRecord),
    );
    missionRecord.expiresAtFileTime = expirationDurationMs > 0
      ? futureFileTimeString(expirationDurationMs)
      : "0";
    missionRecord.lastUpdatedAtMs = Date.now();
    return cloneValue(missionRecord);
  });
  return {
    ...acceptResult,
    acceptedNow: Boolean(acceptResult && acceptResult.success && acceptResult.data),
  };
}

function clearMissionWithCooldown(characterID, agentRecord, runtimeStatus = "declined") {
  return mutateCharacterState(characterID, (characterState) => {
    const missionRecord = characterState.missionsByAgentID[String(agentRecord.agentID)];
    if (missionRecord) {
      delete characterState.missionsByAgentID[String(agentRecord.agentID)];
    }
    characterState.declineTimersByAgentID[String(agentRecord.agentID)] =
      futureFileTimeString(REPLAY_DELAY_MS);
    if (missionRecord) {
      characterState.history.unshift({
        missionSequence: missionRecord.missionSequence,
        agentID: missionRecord.agentID,
        contentID: missionRecord.contentID,
        missionTemplateID: missionRecord.missionTemplateID,
        runtimeStatus,
        completedAtFileTime: currentFileTimeString(),
        lastUpdatedAtMs: Date.now(),
      });
      characterState.history = characterState.history.slice(0, 128);
      const closedAtFileTime = currentFileTimeString();
      recordEpicArcMissionStatus(
        characterState,
        buildEpicArcMissionStatusRecord(missionRecord, {
          quitDate: closedAtFileTime,
        }),
        { nowMs: Date.now() },
      );
    }
    return {
      replayUntilFileTime: characterState.declineTimersByAgentID[String(agentRecord.agentID)],
      missionRecord: missionRecord ? cloneValue(missionRecord) : null,
    };
  });
}

function quitMission(characterID, agentRecord) {
  const agentID = normalizePositiveInteger(agentRecord && agentRecord.agentID, 0);
  const activeMission = getMissionRecord(characterID, agentID);
  if (
    !activeMission ||
    normalizeText(activeMission.runtimeStatus, "").toLowerCase() !== "accepted"
  ) {
    return { success: false, errorMsg: "MISSION_NOT_ACCEPTED" };
  }
  const expectedMissionSequence = normalizePositiveInteger(
    activeMission.missionSequence,
    0,
  );
  const quitResult = mutateCharacterState(characterID, (characterState) => {
    const missionRecord = characterState.missionsByAgentID[String(agentID)];
    if (
      !missionRecord ||
      normalizeText(missionRecord.runtimeStatus, "").toLowerCase() !== "accepted" ||
      normalizePositiveInteger(missionRecord.missionSequence, 0) !== expectedMissionSequence
    ) {
      return { quit: false, missionRecord: null };
    }
    delete characterState.missionsByAgentID[String(agentID)];
    const quitAtFileTime = currentFileTimeString();
    characterState.history.unshift({
      missionSequence: missionRecord.missionSequence,
      agentID: missionRecord.agentID,
      contentID: missionRecord.contentID,
      missionTemplateID: missionRecord.missionTemplateID,
      runtimeStatus: "quit",
      completedAtFileTime: quitAtFileTime,
      lastUpdatedAtMs: Date.now(),
    });
    characterState.history = characterState.history.slice(0, 128);
    recordEpicArcMissionStatus(
      characterState,
      buildEpicArcMissionStatusRecord(missionRecord, {
        quitDate: quitAtFileTime,
      }),
      { nowMs: Date.now() },
    );
    return {
      quit: true,
      missionRecord: cloneValue(missionRecord),
    };
  });
  if (
    !quitResult.success ||
    !quitResult.data ||
    quitResult.data.quit !== true ||
    !quitResult.data.missionRecord
  ) {
    return quitResult.success
      ? { success: false, errorMsg: "MISSION_NOT_ACCEPTED" }
      : quitResult;
  }

  const missionRecord = quitResult.data.missionRecord;
  cleanupMissionBookmarks(characterID, missionRecord);
  const dungeonInstanceID = normalizePositiveInteger(
    missionRecord.dungeonInstanceID,
    0,
  );
  if (dungeonInstanceID > 0) {
    try {
      dungeonRuntime.purgeInstance(dungeonInstanceID);
    } catch (_error) {
      // Quitting remains successful if the private mission instance already despawned.
    }
  }
  return { success: true, data: { missionRecord } };
}

function applyMissionRewards(characterID, agentRecord, missionRecord) {
  const rewards =
    missionRecord && missionRecord.rewards && typeof missionRecord.rewards === "object"
      ? missionRecord.rewards
      : {};
  const standingsRaw =
    rewards.rawStandings && typeof rewards.rawStandings === "object"
      ? rewards.rawStandings
      : {};
  const bonusAvailable = isMissionBonusRewardAvailable(missionRecord);
  const totalWalletReward = roundMoney(
    Number(rewards.isk || 0) +
      (bonusAvailable ? Number(rewards.bonusIsk || 0) : 0),
  );

  const walletResult = adjustCharacterBalance(
    characterID,
    totalWalletReward,
    {
      description: `Agent mission reward: ${normalizeText(missionRecord && missionRecord.missionTitle, missionContentIDToText(missionRecord && missionRecord.contentID, ""))}`,
      ownerID1: normalizePositiveInteger(agentRecord && agentRecord.corporationID, 0),
      ownerID2: normalizePositiveInteger(characterID, 0),
      referenceID: normalizePositiveInteger(agentRecord && agentRecord.agentID, 0),
      entryTypeID: MISSION_REWARD_ENTRY_TYPE,
    },
  );
  if (!walletResult.success) {
    return walletResult;
  }

  const rewardItems = [
    ...normalizeArray(rewards.itemRewards),
    ...(bonusAvailable ? normalizeArray(rewards.bonusItemRewards) : []),
  ].filter(
    (rewardRecord) =>
      normalizePositiveInteger(rewardRecord && rewardRecord.typeID, 0) > 0 &&
      Math.max(0, normalizeInteger(rewardRecord && rewardRecord.quantity, 0)) > 0,
  );
  if (rewardItems.length > 0) {
    const rewardStationID = normalizePositiveInteger(
      missionRecord &&
        missionRecord.dropoffLocation &&
        missionRecord.dropoffLocation.locationID,
      normalizePositiveInteger(agentRecord && agentRecord.stationID, 0),
    );
    if (rewardStationID > 0) {
      const grantResult = grantItemsToCharacterStationHangar(
        characterID,
        rewardStationID,
        rewardItems.map((rewardRecord) => ({
          itemType: normalizePositiveInteger(rewardRecord && rewardRecord.typeID, 0),
          quantity: Math.max(1, normalizeInteger(rewardRecord && rewardRecord.quantity, 1)),
        })),
      );
      if (!grantResult || grantResult.success !== true) {
        return grantResult || { success: false, errorMsg: "MISSION_REWARD_GRANT_FAILED" };
      }
      notifyMissionInventoryChanges(
        characterID,
        (grantResult.data && grantResult.data.changes) || [],
      );
    }
  }

  if (normalizeInteger(rewards.loyaltyPoints, 0) > 0) {
    const lpResult = adjustCharacterWalletLPBalance(
      characterID,
      normalizePositiveInteger(agentRecord && agentRecord.corporationID, 0),
      normalizeInteger(rewards.loyaltyPoints, 0),
      { changeType: "mission_reward" },
    );
    if (!lpResult.success) {
      return lpResult;
    }
  }

  const standingWriteResult = standingRuntime.applyMissionStandingChanges(
    characterID,
    agentRecord,
    missionRecord,
    "completed",
  );
  if (!standingWriteResult.success) {
    return standingWriteResult;
  }

  return {
    success: true,
    data: {
      wallet: walletResult.data,
      bonusAvailable,
      modifications: standingWriteResult.data.modifications,
    },
  };
}

function completeMission(characterID, agentRecord) {
  const missionRecord = syncMissionRecordState(characterID, agentRecord.agentID);
  if (!missionRecord) {
    return { success: false, errorMsg: "MISSION_NOT_FOUND" };
  }
  if (!missionRecord.objectiveCompleted) {
    return { success: false, errorMsg: "OBJECTIVES_NOT_COMPLETE" };
  }

  if (
    (
      missionRecord.objectiveMode === OBJECTIVE_TYPE_TRANSPORT ||
      isFetchMissionRecord(missionRecord) ||
      // dungeon-fetch: encounter missions with an objective-item cargo spec consume it too
      missionRecord.objectiveMode === OBJECTIVE_TYPE_DUNGEON
    ) &&
    missionRecord.cargo &&
    normalizeBoolean(missionRecord.gmCompleted, false) !== true
  ) {
    const dropoffLocationID = normalizePositiveInteger(
      missionRecord.dropoffLocation && missionRecord.dropoffLocation.locationID,
      0,
    );
    if (dropoffLocationID > 0) {
      const preferredSession = getPreferredCharacterSession(characterID);
      const currentDockedLocationID = normalizePositiveInteger(
        getDockedLocationID(preferredSession),
        0,
      );
      let takeResult = takeItemTypeFromCharacterLocation(
        characterID,
        dropoffLocationID,
        ITEM_FLAGS.HANGAR,
        missionRecord.cargo.typeID,
        missionRecord.cargo.quantity,
      );
      if (
        (!takeResult || takeResult.success !== true) &&
        currentDockedLocationID === dropoffLocationID
      ) {
        const activeShip = getActiveShipItem(characterID);
        const activeShipID = normalizePositiveInteger(activeShip && activeShip.itemID, 0);
        if (activeShipID > 0) {
          takeResult = takeItemTypeFromCharacterLocation(
            characterID,
            activeShipID,
            ITEM_FLAGS.CARGO_HOLD,
            missionRecord.cargo.typeID,
            missionRecord.cargo.quantity,
          );
        }
      }
      if (!takeResult || takeResult.success !== true) {
        return takeResult || { success: false, errorMsg: "MISSION_CARGO_NOT_FOUND" };
      }
      notifyMissionInventoryChanges(
        characterID,
        (takeResult.data && takeResult.data.changes) || [],
      );
    }
  }

  const rewardResult = applyMissionRewards(characterID, agentRecord, missionRecord);
  if (!rewardResult.success) {
    return rewardResult;
  }

  const cleanupResult = mutateCharacterState(characterID, (characterState) => {
    delete characterState.missionsByAgentID[String(agentRecord.agentID)];
    if (isCareerAgent(agentRecord)) {
      characterState.completedCareerAgentIDs[String(agentRecord.agentID)] = true;
    }
    const completedAtFileTime = currentFileTimeString();
    characterState.history.unshift({
      missionSequence: missionRecord.missionSequence,
      agentID: missionRecord.agentID,
      contentID: missionRecord.contentID,
      missionTemplateID: missionRecord.missionTemplateID,
      runtimeStatus: "completed",
      completedAtFileTime,
      lastUpdatedAtMs: Date.now(),
    });
    characterState.history = characterState.history.slice(0, 128);
    const completedEpicArcStatus = buildEpicArcMissionStatusRecord(missionRecord, {
      completedDate: completedAtFileTime,
    });
    const epicArcStatusResult = recordEpicArcMissionStatus(
      characterState,
      completedEpicArcStatus,
      { nowMs: Date.now() },
    );
    if (
      epicArcStatusResult.recorded &&
      isEpicArcEndMission(missionRecord)
    ) {
      recordEpicArcCompletion(
        characterState,
        {
          epicArcID: completedEpicArcStatus.epicArcID,
          completedMissionID: completedEpicArcStatus.missionID,
          completedAtFileTime,
          agentID: missionRecord.agentID,
          missionSequence: missionRecord.missionSequence,
          missionTemplateID: missionRecord.missionTemplateID,
        },
        { nowMs: Date.now() },
      );
    }
    recordStorylineQualifyingCompletion(characterState, agentRecord, missionRecord, {
      completedAtFileTime,
    });
    return cloneValue(missionRecord);
  });

  if (!cleanupResult.success) {
    return cleanupResult;
  }

  cleanupMissionBookmarks(characterID, missionRecord);
  if (normalizePositiveInteger(missionRecord.dungeonInstanceID, 0) > 0) {
    try {
      dungeonRuntime.purgeInstance(missionRecord.dungeonInstanceID);
    } catch (_error) {
      // Mission completion should still succeed if the instance already despawned.
    }
  }

  return { success: true, data: { missionRecord, rewardResult: rewardResult.data } };
}

function getJournalDetails(characterID) {
  const characterState = getCharacterStateSnapshot(characterID);
  if (!characterState) {
    return [[], []];
  }

  const missionRows = Object.values(characterState.missionsByAgentID || {})
    .map((missionRecord) => {
      const syncedMissionRecord = getMissionRecordForRead(
        characterID,
        missionRecord && missionRecord.agentID,
      );
      const agentRecord = getAgentRecord(missionRecord && missionRecord.agentID);
      return agentRecord && syncedMissionRecord
        ? buildMissionJournalRow(characterID, agentRecord, syncedMissionRecord)
        : null;
    })
    .filter(Boolean);
  const activeAgentIDs = new Set(
    missionRows.map((row) => normalizePositiveInteger(row && row[4], 0)),
  );
  const pendingStorylineRows = buildPendingStorylineOfferJournalRows(
    characterID,
    characterState,
    activeAgentIDs,
  );

  return [missionRows.concat(pendingStorylineRows), []];
}

function getMyEpicArcStatus(characterID) {
  return buildEpicArcStatusPayloadFromCharacterState(
    getCharacterStateSnapshot(characterID),
  );
}

function getCompletedCareerAgentMap(characterID, agentIDs = []) {
  const characterState = getCharacterStateSnapshot(characterID);
  const completedByID =
    characterState &&
    characterState.completedCareerAgentIDs &&
    typeof characterState.completedCareerAgentIDs === "object"
      ? characterState.completedCareerAgentIDs
      : {};

  const response = {};
  for (const agentID of Array.isArray(agentIDs) ? agentIDs : []) {
    const normalizedAgentID = normalizePositiveInteger(agentID, 0);
    if (!normalizedAgentID) {
      continue;
    }
    response[normalizedAgentID] =
      completedByID[String(normalizedAgentID)] === true;
  }
  return response;
}

function getInfoServiceDetails(characterID, agentID) {
  const agentRecord = getAgentRecord(agentID);
  if (!agentRecord) {
    return null;
  }

  const normalizedCharacterID = normalizePositiveInteger(characterID, 0);
  const services = [buildMissionServiceDetails(normalizedCharacterID, agentRecord)];
  const locateService = buildLocateServiceDetails(agentRecord);
  if (locateService) {
    services.push(locateService);
  }

  return buildKeyVal([
    ["agentID", normalizePositiveInteger(agentRecord.agentID, 0)],
    ["stationID", normalizePositiveInteger(agentRecord.stationID, 0) || null],
    ["level", normalizeInteger(agentRecord.level, 1)],
    ["services", services],
    ["incompatible", null],
  ]);
}

function getMissionBriefingInfo(characterID, agentID) {
  const agentRecord = getAgentRecord(agentID);
  const missionRecord = getMissionRecordForRead(characterID, agentID);
  if (!agentRecord || !missionRecord) {
    return null;
  }

  return buildMissionBriefingInfo(
    characterID,
    agentRecord,
    missionRecord,
    getRuntimeMissionTemplateRecord(missionRecord),
  );
}

function getMissionJournalInfo(characterID, agentID) {
  const agentRecord = getAgentRecord(agentID);
  const missionRecord = getMissionRecordForRead(characterID, agentID);
  if (!agentRecord || !missionRecord) {
    return null;
  }

  return buildMissionJournalInfo(
    normalizePositiveInteger(characterID, 0),
    agentRecord,
    missionRecord,
    getRuntimeMissionTemplateRecord(missionRecord),
  );
}

function getMissionObjectiveInfo(characterID, agentID) {
  const agentRecord = getAgentRecord(agentID);
  const missionRecord = getMissionRecordForRead(characterID, agentID);
  if (!agentRecord || !missionRecord) {
    return null;
  }

  return buildMissionObjectivePayload(
    agentRecord,
    missionRecord,
    getRuntimeMissionTemplateRecord(missionRecord),
  );
}

function getMissionKeywords(characterID, agentID, contentID = null) {
  const agentRecord = getAgentRecord(agentID);
  if (!agentRecord) {
    return {};
  }
  const missionRecord =
    getMissionRecordForRead(characterID, agentID) ||
    (contentID
      ? {
          contentID: normalizeMissionContentID(contentID, null),
          missionTitle: missionContentIDToText(contentID, "Placeholder Mission"),
        }
      : null);
  return buildMissionKeywords(
    agentRecord,
    missionRecord,
    getRuntimeMissionTemplateRecord(missionRecord),
  );
}

function getStandingGainsForMission(characterID, agentID, contentID = null) {
  const agentRecord = getAgentRecord(agentID);
  const missionRecord =
    getMissionRecordForRead(characterID, agentID) ||
    (contentID
      ? {
          contentID: normalizeMissionContentID(contentID, null),
          rewards: buildMissionRewards(
            agentRecord,
            normalizeBoolean(agentRecord && agentRecord.importantMission, false),
            null,
            characterID,
          ),
        }
      : null);
  if (!agentRecord || !missionRecord || !getCharacterRecord(characterID)) {
    return {};
  }
  return buildStandingPreview(characterID, agentRecord, missionRecord);
}

function getReplayTimestamp(characterID, agentID) {
  const replayUntil = fileTimeStringToBigInt(getReplayUntilFileTime(characterID, agentID));
  return replayUntil > 0n ? fileTimeBigIntToLong(replayUntil) : buildFiletimeLong(0n);
}

function markMissionObjectiveComplete(characterID, options = {}) {
  const normalizedCharacterID = normalizePositiveInteger(characterID, 0);
  if (!normalizedCharacterID) {
    return { success: false, errorMsg: "CHARACTER_NOT_FOUND" };
  }

  const requestedAgentID = normalizeText(options.agentID, "").toLowerCase();
  const completeAll = requestedAgentID === "all";
  const normalizedAgentID = completeAll
    ? 0
    : normalizePositiveInteger(options.agentID, 0);

  const characterState = getCharacterStateSnapshot(normalizedCharacterID);
  const missionRecords = Object.values(
    (characterState && characterState.missionsByAgentID) || {},
  ).filter(
    (missionRecord) =>
      normalizeText(missionRecord && missionRecord.runtimeStatus, "offered") ===
      "accepted",
  );

  const targets = completeAll
    ? missionRecords
    : missionRecords.filter(
        (missionRecord) =>
          normalizePositiveInteger(missionRecord && missionRecord.agentID, 0) ===
          normalizedAgentID,
      );

  if (!targets.length) {
    return { success: false, errorMsg: "MISSION_NOT_FOUND" };
  }

  const markedAgentIDs = [];
  const result = mutateCharacterState(normalizedCharacterID, (mutableCharacterState) => {
    for (const missionRecord of targets) {
      const storedMission =
        mutableCharacterState.missionsByAgentID[String(missionRecord.agentID)];
      if (!storedMission) {
        continue;
      }
      storedMission.objectiveCompleted = true;
      storedMission.gmCompleted = true;
      if (storedMission.cargo && typeof storedMission.cargo === "object") {
        storedMission.cargo.hasCargo = true;
      }
      storedMission.lastUpdatedAtMs = Date.now();
      markedAgentIDs.push(storedMission.agentID);
    }
    return markedAgentIDs.slice();
  });

  if (!result.success) {
    return result;
  }

  for (const agentID of markedAgentIDs) {
    notifyMissionChange(normalizedCharacterID, AGENT_MISSION_MODIFIED, agentID);
  }

  return { success: true, data: { markedAgentIDs } };
}

function removeOfferFromJournal(characterID, agentID) {
  const missionRecord = getMissionRecord(characterID, agentID);
  if (
    !missionRecord ||
    normalizeText(missionRecord.runtimeStatus, "offered") !== "offered"
  ) {
    return null;
  }

  mutateCharacterState(characterID, (characterState) => {
    delete characterState.missionsByAgentID[String(agentID)];
    return true;
  });
  notifyMissionChange(characterID, AGENT_MISSION_OFFER_REMOVED, agentID);
  return null;
}

function setMissionObjectiveCompleted(characterID, agentID) {
  return mutateCharacterState(characterID, (characterState) => {
    const missionRecord = characterState.missionsByAgentID[String(agentID)];
    if (!missionRecord) {
      return null;
    }
    missionRecord.objectiveCompleted = true;
    missionRecord.gmCompleted = false;
    missionRecord.lastUpdatedAtMs = Date.now();
    return cloneValue(missionRecord);
  });
}

function findReferredConversationMission(characterID, targetAgentID) {
  const normalizedCharacterID = normalizePositiveInteger(characterID, 0);
  const normalizedTargetAgentID = normalizePositiveInteger(targetAgentID, 0);
  if (!normalizedCharacterID || !normalizedTargetAgentID) {
    return null;
  }
  const characterState = getCharacterStateSnapshot(normalizedCharacterID);
  const acceptedMissions = Object.values(
    (characterState && characterState.missionsByAgentID) || {},
  ).filter((missionRecord) => (
    normalizeText(missionRecord && missionRecord.runtimeStatus, "offered") === "accepted" &&
    isAgentObjectiveMissionRecord(missionRecord) &&
    normalizePositiveInteger(missionRecord && missionRecord.agentID, 0) !== normalizedTargetAgentID
  ));

  return acceptedMissions.find((missionRecord) => (
    getMissionConversationTargetAgentID(missionRecord) === normalizedTargetAgentID
  )) || null;
}

function buildAgentInteractionActionPayload(agentRecord, missionRecord, nextMissionID, optionIndex = 0) {
  const clientMissionRecord = getClientMissionRecord(missionRecord);
  const nextMissionRecord = getMissionByID(nextMissionID);
  const optionMessageID = getMissionMessageID(
    clientMissionRecord,
    `messages.mission.option${optionIndex + 1}.charsays`,
  );
  const titleID = optionMessageID > 0
    ? optionMessageID
    : normalizePositiveInteger(nextMissionRecord && nextMissionRecord.nameID, 0);
  if (titleID <= 0) {
    return null;
  }
  return {
    "Mission ID": normalizeMissionContentID(missionRecord && missionRecord.contentID, null),
    "Mission Keywords": buildMissionKeywords(
      agentRecord,
      missionRecord,
      getRuntimeMissionTemplateRecord(missionRecord),
    ),
    "Mission Title ID": titleID,
    "Mission Briefing ID":
      getMissionMessageID(clientMissionRecord, "messages.mission.extrainfo.body") ||
      getMissionMessageID(nextMissionRecord, "messages.mission.briefing") ||
      null,
  };
}

function buildAgentInteractionActions(agentRecord, missionRecord) {
  if (!isAgentObjectiveMissionRecord(missionRecord)) {
    return [];
  }
  const clientMissionRecord = getClientMissionRecord(missionRecord);
  if (!normalizeBoolean(clientMissionRecord && clientMissionRecord.isAgentInteraction, false)) {
    return [];
  }
  const nextMissionIDs = getMissionNextMissionIDs(missionRecord);
  return nextMissionIDs
    .map((nextMissionID, index) => {
      const payload = buildAgentInteractionActionPayload(
        agentRecord,
        missionRecord,
        nextMissionID,
        index,
      );
      if (!payload) {
        return null;
      }
      return [
        AGENT_INTERACTION_ACTION_ID_BASE + index,
        payload,
      ];
    })
    .filter(Boolean);
}

function advanceConversationMission(characterID, sourceMissionRecord, nextMissionID) {
  const normalizedCharacterID = normalizePositiveInteger(characterID, 0);
  const normalizedNextMissionID = normalizeMissionContentID(nextMissionID, null);
  const sourceAgentRecord = getAgentRecord(sourceMissionRecord && sourceMissionRecord.agentID);
  if (!normalizedCharacterID || !sourceMissionRecord || !sourceAgentRecord) {
    return { success: false, errorMsg: "MISSION_NOT_FOUND" };
  }

  const markResult = setMissionObjectiveCompleted(
    normalizedCharacterID,
    sourceMissionRecord.agentID,
  );
  if (!markResult.success || !markResult.data) {
    return markResult.success ? { success: false, errorMsg: "MISSION_NOT_FOUND" } : markResult;
  }

  const completionResult = completeMission(normalizedCharacterID, sourceAgentRecord);
  if (!completionResult.success) {
    return completionResult;
  }

  notifyMissionChange(
    normalizedCharacterID,
    AGENT_MISSION_COMPLETED,
    normalizePositiveInteger(sourceMissionRecord.agentID, 0),
  );

  if (normalizedNextMissionID === null) {
    return {
      success: true,
      data: buildCompletedConversation(
        sourceAgentRecord,
        completionResult.data.missionRecord,
        getRuntimeMissionTemplateRecord(completionResult.data.missionRecord),
      ),
    };
  }

  const nextMissionRecord = getMissionByID(normalizedNextMissionID);
  const nextAgentID = normalizePositiveInteger(
    nextMissionRecord &&
      (nextMissionRecord.sourceAgentID || nextMissionRecord.targetAgentID),
    0,
  );
  const nextAgentRecord = getAgentRecord(nextAgentID);
  if (!nextMissionRecord || !nextAgentRecord) {
    return {
      success: true,
      data: buildCompletedConversation(
        sourceAgentRecord,
        completionResult.data.missionRecord,
        getRuntimeMissionTemplateRecord(completionResult.data.missionRecord),
      ),
    };
  }

  const offerResult = offerSpecificMission(
    normalizedCharacterID,
    nextAgentRecord,
    nextMissionRecord,
  );
  if (!offerResult.success || !offerResult.data || !offerResult.data.missionRecord) {
    return offerResult.success
      ? {
          success: true,
          data: buildIdleConversation(nextAgentRecord, normalizedCharacterID),
        }
      : offerResult;
  }

  notifyMissionChange(normalizedCharacterID, AGENT_MISSION_OFFERED, nextAgentID);
  return {
    success: true,
    data: buildOfferedConversation(
      nextAgentRecord,
      offerResult.data.missionRecord,
      getRuntimeMissionTemplateRecord(offerResult.data.missionRecord),
    ),
  };
}

function resolveIdleConversationContentID(agentRecord, characterID) {
  const agentID = normalizePositiveInteger(agentRecord && agentRecord.agentID, 0);
  const activeMission = getMissionRecord(characterID, agentID);
  const activeContentID = normalizeMissionContentID(
    activeMission && activeMission.contentID,
    null,
  );
  if (activeContentID !== null) {
    return activeContentID;
  }

  const forcedMissionID = normalizePositiveInteger(process.env.EVEJS_FORCE_MISSION_ID, 0);
  const forcedMission = forcedMissionID > 0 ? getMissionByID(forcedMissionID) : null;
  if (forcedMission && isMissionOfferAllowedForAgent(agentRecord, forcedMission)) {
    return normalizeMissionContentID(forcedMission.missionID, null);
  }

  const characterState = getCharacterStateSnapshot(characterID);
  const selectionCursor = normalizeInteger(
    characterState &&
      characterState.missionSelectionCursorByAgentID &&
      characterState.missionSelectionCursorByAgentID[String(agentID)],
    0,
  );
  const selectedMission = pickMissionForAgent(agentRecord, selectionCursor);
  return normalizeMissionContentID(selectedMission && selectedMission.missionID, null);
}

function buildIdleGreeting(agentRecord, characterID) {
  return [
    buildMarshalTuple([
      "UI/Agents/DefaultMessages/RootAgentSays/GenericGreetings",
      buildDict([]),
    ]),
    resolveIdleConversationContentID(agentRecord, characterID),
  ];
}

function buildIdleConversation(agentRecord, characterID) {
  if (!canUseAgent(characterID, agentRecord)) {
    return {
      agentSays: [
        "Your current standings are not high enough for this agent to issue you a mission yet.",
        null,
      ],
      actions: [],
      lastActionInfo: buildDefaultMissionLastActionInfo(),
    };
  }

  return {
    agentSays: buildIdleGreeting(agentRecord, characterID),
    actions: [
      [AGENT_DIALOGUE_ACTION_TOKEN_REQUEST, AGENT_DIALOGUE_BUTTON_REQUEST_MISSION],
    ],
    lastActionInfo: buildDefaultMissionLastActionInfo(),
  };
}

function buildOfferedConversation(agentRecord, missionRecord, missionTemplate) {
  const clientMissionRecord = getClientMissionRecord(missionRecord);
  return {
    agentSays: buildConversationAgentSays(
      missionRecord,
      clientMissionRecord,
      [
        "messages.mission.offered.agentsays",
        "messages.mission.briefing",
      ],
      buildPlaceholderBriefing(agentRecord, missionRecord, missionTemplate),
    ),
    actions: [
      [AGENT_DIALOGUE_ACTION_TOKEN_ACCEPT, AGENT_DIALOGUE_BUTTON_ACCEPT],
      [AGENT_DIALOGUE_ACTION_TOKEN_DECLINE, AGENT_DIALOGUE_BUTTON_DECLINE],
      [AGENT_DIALOGUE_ACTION_TOKEN_DEFER, AGENT_DIALOGUE_BUTTON_DEFER],
    ],
    lastActionInfo: buildActiveMissionLastActionInfo(),
  };
}

function buildAcceptedConversation(
  characterID,
  agentRecord,
  missionRecord,
  missionTemplate,
  options = {},
) {
  const clientMissionRecord = getClientMissionRecord(missionRecord);
  const actions = [];
  const interactionActions = buildAgentInteractionActions(agentRecord, missionRecord);
  const actionResponse = options.actionResponse === true;
  const remotelyCompletable = isMissionRemoteCompletable(missionRecord, {
    characterID,
    agentRecord,
  });
  const atCompletionLocation = isCharacterAtMissionCompletionLocation(
    characterID,
    agentRecord,
    missionRecord,
  );
  const showCompletionActions = actionResponse || remotelyCompletable || atCompletionLocation;
  const objectiveReady = normalizeBoolean(
    missionRecord && missionRecord.objectiveCompleted,
    false,
  );
  const completeActionToken = objectiveReady
    ? AGENT_DIALOGUE_ACTION_TOKEN_COMPLETE_READY
    : AGENT_DIALOGUE_ACTION_TOKEN_COMPLETE;
  const quitActionToken = objectiveReady
    ? AGENT_DIALOGUE_ACTION_TOKEN_QUIT_READY
    : AGENT_DIALOGUE_ACTION_TOKEN_QUIT;
  if (showCompletionActions) {
    if (remotelyCompletable) {
      actions.push([
        completeActionToken,
        AGENT_DIALOGUE_BUTTON_COMPLETE_REMOTELY,
      ]);
    } else {
      actions.push([completeActionToken, AGENT_DIALOGUE_BUTTON_COMPLETE]);
    }
  }
  if (interactionActions.length > 0) {
    actions.push(...interactionActions);
  }
  if (showCompletionActions) {
    actions.push([quitActionToken, AGENT_DIALOGUE_BUTTON_QUIT]);
  }

  return {
    agentSays: normalizeBoolean(missionRecord.objectiveCompleted, false)
      ? buildConversationAgentSays(
          missionRecord,
          clientMissionRecord,
          [
            "messages.mission.completed.agentsays",
            "messages.mission.completed.nextmission.agentsays",
            "messages.root.missioninprogress.agentsays",
            "messages.mission.accepted.agentsays",
          ],
          `${buildPlaceholderBriefing(agentRecord, missionRecord, missionTemplate)}<br><br>${MISSION_PLACEHOLDER_COMPLETE_NOTE}`,
        )
      : buildConversationAgentSays(
          missionRecord,
          clientMissionRecord,
          [
            "messages.root.missioninprogress.agentsays",
            "messages.mission.accepted.agentsays",
            "messages.mission.briefing",
          ],
          buildPlaceholderBriefing(agentRecord, missionRecord, missionTemplate),
        ),
    actions,
    lastActionInfo: actionResponse
      ? buildActiveMissionLastActionInfo()
      : buildDefaultMissionLastActionInfo(),
  };
}

function buildCompletedConversation(agentRecord, missionRecord, missionTemplate) {
  const clientMissionRecord = getClientMissionRecord(missionRecord);
  return {
    agentSays: buildConversationAgentSays(
      missionRecord,
      clientMissionRecord,
      [
        "messages.mission.completed.agentsays",
        "messages.mission.completed.nextmission.agentsays",
      ],
      `Mission complete. Rewards and standings have been applied for ${normalizeText(
        missionRecord && missionRecord.missionTitle,
        missionContentIDToText(missionRecord && missionRecord.contentID, ""),
      )}.`,
    ),
    actions: [
      [
        AGENT_DIALOGUE_ACTION_TOKEN_REQUEST_AFTER_COMPLETION,
        AGENT_DIALOGUE_BUTTON_REQUEST_MISSION,
      ],
    ],
    lastActionInfo: buildActiveMissionLastActionInfo({
      missionCompleted: true,
    }),
  };
}

function doAgentAction(characterID, agentID, actionID = null) {
  const normalizedCharacterID = normalizePositiveInteger(characterID, 0);
  const agentRecord = getAgentRecord(agentID);
  const characterRecord = getCharacterRecord(normalizedCharacterID);
  if (!normalizedCharacterID || !agentRecord || !characterRecord) {
    return {
      success: true,
      data: {
        agentSays: ["This agent is unavailable right now.", null],
        actions: [],
        lastActionInfo: buildDefaultMissionLastActionInfo(),
      },
    };
  }

  const rawActionID =
    actionID === null || actionID === undefined
      ? null
      : normalizeInteger(actionID, 0);
  let normalizedActionID = rawActionID === null
    ? null
    : normalizeAgentDialogueActionID(rawActionID);
  const rawMission = getMissionRecord(normalizedCharacterID, agentID);
  const rawMissionExpiry = fileTimeStringToBigInt(
    rawMission && rawMission.expiresAtFileTime,
  );
  const isIdempotentAcceptedAction =
    (
      normalizedActionID === AGENT_DIALOGUE_BUTTON_ACCEPT ||
      normalizedActionID === AGENT_DIALOGUE_BUTTON_ACCEPT_REMOTELY
    ) &&
    normalizeText(rawMission && rawMission.runtimeStatus, "").toLowerCase() === "accepted" &&
    (rawMissionExpiry <= 0n || rawMissionExpiry > nowFileTimeBigInt());
  const syncedMission = isIdempotentAcceptedAction
    ? rawMission
    : getMissionRecordForRead(normalizedCharacterID, agentID);
  if (
    (
      rawActionID === AGENT_DIALOGUE_ACTION_TOKEN_COMPLETE ||
      rawActionID === AGENT_DIALOGUE_ACTION_TOKEN_COMPLETE_READY
    ) &&
    syncedMission &&
    isMissionRemoteCompletable(syncedMission, {
      characterID: normalizedCharacterID,
      agentRecord,
    })
  ) {
    normalizedActionID = AGENT_DIALOGUE_BUTTON_COMPLETE_REMOTELY;
  }
  const referredMission =
    !syncedMission
      ? findReferredConversationMission(normalizedCharacterID, agentID)
      : null;

  if (normalizedActionID === null) {
    if (referredMission) {
      return advanceConversationMission(
        normalizedCharacterID,
        referredMission,
        getMissionNextMissionIDs(referredMission)[0] ?? null,
      );
    }
    if (syncedMission) {
      const missionTemplate = getRuntimeMissionTemplateRecord(syncedMission);
      return {
        success: true,
        data:
          normalizeText(syncedMission.runtimeStatus, "offered") === "accepted"
            ? buildAcceptedConversation(
                normalizedCharacterID,
                agentRecord,
                syncedMission,
                missionTemplate,
              )
            : buildOfferedConversation(agentRecord, syncedMission, missionTemplate),
      };
    }
    return { success: true, data: buildIdleConversation(agentRecord, normalizedCharacterID) };
  }

  if (
    normalizedActionID === AGENT_DIALOGUE_BUTTON_REQUEST_MISSION ||
    normalizedActionID === AGENT_DIALOGUE_BUTTON_VIEW_MISSION
  ) {
    if (referredMission) {
      return advanceConversationMission(
        normalizedCharacterID,
        referredMission,
        getMissionNextMissionIDs(referredMission)[0] ?? null,
      );
    }
    if (syncedMission) {
      const missionTemplate = getRuntimeMissionTemplateRecord(syncedMission);
      return {
        success: true,
        data:
          normalizeText(syncedMission.runtimeStatus, "offered") === "accepted"
            ? buildAcceptedConversation(
                normalizedCharacterID,
                agentRecord,
                syncedMission,
                missionTemplate,
              )
            : buildOfferedConversation(agentRecord, syncedMission, missionTemplate),
      };
    }
    const offerResult = offerMission(normalizedCharacterID, agentRecord);
    const offeredPayload = offerResult.success ? offerResult.data : null;
    if (!offeredPayload || !offeredPayload.missionRecord) {
      return { success: true, data: buildIdleConversation(agentRecord, normalizedCharacterID) };
    }
    notifyMissionChange(normalizedCharacterID, AGENT_MISSION_OFFERED, agentID);
    return {
      success: true,
      data: buildOfferedConversation(
        agentRecord,
        offeredPayload.missionRecord,
        getRuntimeMissionTemplateRecord(offeredPayload.missionRecord),
      ),
    };
  }

  if (normalizedActionID === AGENT_DIALOGUE_BUTTON_DEFER) {
    if (!syncedMission) {
      return { success: true, data: buildIdleConversation(agentRecord, normalizedCharacterID) };
    }
    const missionTemplate = getRuntimeMissionTemplateRecord(syncedMission);
    return {
      success: true,
      data:
        normalizeText(syncedMission.runtimeStatus, "").toLowerCase() === "accepted"
          ? buildAcceptedConversation(
              normalizedCharacterID,
              agentRecord,
              syncedMission,
              missionTemplate,
            )
          : buildOfferedConversation(agentRecord, syncedMission, missionTemplate),
    };
  }

  if (
    normalizedActionID === AGENT_DIALOGUE_BUTTON_ACCEPT ||
    normalizedActionID === AGENT_DIALOGUE_BUTTON_ACCEPT_REMOTELY
  ) {
    // A remote-accept action is only honored for missions that are actually remote-offerable.
    // Missions that must be transacted in person (agent gift, courier cargo, talk-to-agent) are
    // refused when requested remotely; the player is returned to the offered conversation so they
    // can travel to the agent and accept there in person.
    if (
      normalizedActionID === AGENT_DIALOGUE_BUTTON_ACCEPT_REMOTELY &&
      syncedMission &&
      !isMissionRemoteOfferable(syncedMission)
    ) {
      return {
        success: true,
        data: buildOfferedConversation(
          agentRecord,
          syncedMission,
          getRuntimeMissionTemplateRecord(syncedMission),
        ),
      };
    }
    const acceptResult = acceptMission(normalizedCharacterID, agentRecord);
    if (!acceptResult.success || !acceptResult.data) {
      return { success: true, data: buildIdleConversation(agentRecord, normalizedCharacterID) };
    }
    if (acceptResult.acceptedNow === true) {
      notifyMissionChange(normalizedCharacterID, AGENT_MISSION_ACCEPTED, agentID);
    }
    return {
      success: true,
      data: buildAcceptedConversation(
        normalizedCharacterID,
        agentRecord,
        acceptResult.data,
        getRuntimeMissionTemplateRecord(acceptResult.data),
        { actionResponse: acceptResult.acceptedNow === true },
      ),
    };
  }

  if (normalizedActionID === AGENT_DIALOGUE_BUTTON_DECLINE) {
    if (
      !syncedMission ||
      normalizeText(syncedMission.runtimeStatus, "").toLowerCase() !== "offered"
    ) {
      return syncedMission
        ? {
            success: true,
            data: buildAcceptedConversation(
              normalizedCharacterID,
              agentRecord,
              syncedMission,
              getRuntimeMissionTemplateRecord(syncedMission),
            ),
          }
        : { success: true, data: buildIdleConversation(agentRecord, normalizedCharacterID) };
    }
    // TQ parity: the first decline per agent per 4h is free; declining again while the per-agent
    // decline timer is still active is penalized (agent + corp = agent/10 + derived faction ripple).
    // Read the timer BEFORE clearMissionWithCooldown re-arms it. This mirrors the informational
    // declineTime the briefing already surfaces (buildMissionBriefingInfo). Best-effort — a standing
    // failure must never block the decline itself.
    if (
      config.missionDeclinePenaltyEnabled === true &&
      fileTimeStringToBigInt(
        getReplayUntilFileTime(normalizedCharacterID, agentID),
      ) > nowFileTimeBigInt()
    ) {
      try {
        standingRuntime.applyMissionStandingChanges(
          normalizedCharacterID,
          agentRecord,
          syncedMission,
          "declined",
        );
      } catch (error) {
        /* decline standing penalty is best-effort; the decline must still proceed */
      }
    }
    clearMissionWithCooldown(
      normalizedCharacterID,
      agentRecord,
      "declined",
    );
    notifyMissionChange(normalizedCharacterID, AGENT_MISSION_RESET, agentID);
    const idleConversation = buildIdleConversation(agentRecord, normalizedCharacterID);
    return {
      success: true,
      data: {
        ...idleConversation,
        lastActionInfo: buildActiveMissionLastActionInfo({
          missionDeclined: true,
        }),
      },
    };
  }

  if (normalizedActionID === AGENT_DIALOGUE_BUTTON_QUIT) {
    if (
      !syncedMission ||
      normalizeText(syncedMission.runtimeStatus, "").toLowerCase() !== "accepted"
    ) {
      return syncedMission
        ? {
            success: true,
            data: buildOfferedConversation(
              agentRecord,
              syncedMission,
              getRuntimeMissionTemplateRecord(syncedMission),
            ),
          }
        : { success: true, data: buildIdleConversation(agentRecord, normalizedCharacterID) };
    }
    const quitResult = quitMission(normalizedCharacterID, agentRecord);
    if (!quitResult.success) {
      const activeMission = getMissionRecord(normalizedCharacterID, agentID);
      return activeMission
        ? {
            success: true,
            data: buildAcceptedConversation(
              normalizedCharacterID,
              agentRecord,
              activeMission,
              getRuntimeMissionTemplateRecord(activeMission),
            ),
          }
        : { success: true, data: buildIdleConversation(agentRecord, normalizedCharacterID) };
    }
    notifyMissionChange(normalizedCharacterID, AGENT_MISSION_QUIT, agentID);
    const idleConversation = buildIdleConversation(agentRecord, normalizedCharacterID);
    return {
      success: true,
      data: {
        ...idleConversation,
        lastActionInfo: buildActiveMissionLastActionInfo({
          missionQuit: true,
        }),
      },
    };
  }

  if (
    syncedMission &&
    normalizedActionID >= AGENT_INTERACTION_ACTION_ID_BASE &&
    normalizedActionID < (AGENT_INTERACTION_ACTION_ID_BASE + 16)
  ) {
    const nextMissionIDs = getMissionNextMissionIDs(syncedMission);
    const nextMissionID = nextMissionIDs[normalizedActionID - AGENT_INTERACTION_ACTION_ID_BASE] ?? null;
    if (nextMissionID !== null) {
      return advanceConversationMission(
        normalizedCharacterID,
        syncedMission,
        nextMissionID,
      );
    }
  }

  if (
    normalizedActionID === AGENT_DIALOGUE_BUTTON_COMPLETE ||
    normalizedActionID === AGENT_DIALOGUE_BUTTON_COMPLETE_REMOTELY
  ) {
    if (
      normalizedActionID === AGENT_DIALOGUE_BUTTON_COMPLETE_REMOTELY &&
      !isMissionRemoteCompletable(syncedMission, {
        characterID: normalizedCharacterID,
        agentRecord,
      })
    ) {
      return syncedMission
        ? {
            success: true,
            data: buildAcceptedConversation(
              normalizedCharacterID,
              agentRecord,
              syncedMission,
              getRuntimeMissionTemplateRecord(syncedMission),
            ),
          }
        : { success: true, data: buildIdleConversation(agentRecord, normalizedCharacterID) };
    }
    if (
      normalizedActionID === AGENT_DIALOGUE_BUTTON_COMPLETE &&
      !isCharacterAtMissionCompletionLocation(
        normalizedCharacterID,
        agentRecord,
        syncedMission,
      )
    ) {
      return syncedMission
        ? {
            success: true,
            data: buildAcceptedConversation(
              normalizedCharacterID,
              agentRecord,
              syncedMission,
              getRuntimeMissionTemplateRecord(syncedMission),
            ),
          }
        : { success: true, data: buildIdleConversation(agentRecord, normalizedCharacterID) };
    }
    const completeResult = completeMission(normalizedCharacterID, agentRecord);
    if (!completeResult.success) {
      const activeMission = getMissionRecord(normalizedCharacterID, agentID);
      if (activeMission) {
        return {
          success: true,
          data: buildAcceptedConversation(
            normalizedCharacterID,
            agentRecord,
            activeMission,
            getRuntimeMissionTemplateRecord(activeMission),
          ),
        };
      }
      return { success: true, data: buildIdleConversation(agentRecord, normalizedCharacterID) };
    }
    notifyMissionChange(normalizedCharacterID, AGENT_MISSION_COMPLETED, agentID);
    const completedMissionRecord = completeResult.data.missionRecord;
    return {
      success: true,
      data: buildCompletedConversation(
        agentRecord,
        completedMissionRecord,
        getRuntimeMissionTemplateRecord(completedMissionRecord),
      ),
    };
  }

  return { success: true, data: buildIdleConversation(agentRecord, normalizedCharacterID) };
}

module.exports = {
  buildMissionRewards,
  resolveRewardScale,
  resolveLoyaltyPointSecurityMultiplier,
  resolveMissionTemplateForClientMission,
  AGENT_MISSION_ACCEPTED,
  AGENT_MISSION_COMPLETED,
  AGENT_MISSION_MODIFIED,
  AGENT_MISSION_OFFERED,
  AGENT_MISSION_OFFER_DECLINED,
  AGENT_MISSION_OFFER_EXPIRED,
  AGENT_MISSION_OFFER_REMOVED,
  AGENT_MISSION_QUIT,
  AGENT_MISSION_RESET,
  AGENT_MISSION_STATE_ACCEPTED,
  AGENT_MISSION_STATE_CANT_REPLAY,
  AGENT_MISSION_STATE_COMPLETED,
  AGENT_MISSION_STATE_OFFERED,
  AGENT_DIALOGUE_ACTION_TOKEN_ACCEPT,
  AGENT_DIALOGUE_ACTION_TOKEN_COMPLETE,
  AGENT_DIALOGUE_ACTION_TOKEN_COMPLETE_READY,
  AGENT_DIALOGUE_ACTION_TOKEN_DECLINE,
  AGENT_DIALOGUE_ACTION_TOKEN_DEFER,
  AGENT_DIALOGUE_ACTION_TOKEN_QUIT,
  AGENT_DIALOGUE_ACTION_TOKEN_QUIT_READY,
  AGENT_DIALOGUE_ACTION_TOKEN_REQUEST,
  AGENT_DIALOGUE_ACTION_TOKEN_REQUEST_AFTER_COMPLETION,
  AGENT_DIALOGUE_BUTTON_ACCEPT,
  AGENT_DIALOGUE_BUTTON_ACCEPT_REMOTELY,
  AGENT_DIALOGUE_BUTTON_COMPLETE,
  AGENT_DIALOGUE_BUTTON_COMPLETE_REMOTELY,
  AGENT_DIALOGUE_BUTTON_DECLINE,
  AGENT_DIALOGUE_BUTTON_DEFER,
  AGENT_DIALOGUE_BUTTON_QUIT,
  AGENT_DIALOGUE_BUTTON_REQUEST_MISSION,
  AGENT_DIALOGUE_BUTTON_VIEW_MISSION,
  MISSION_PLACEHOLDER_COMPLETE_NOTE,
  MISSION_PLACEHOLDER_NOTE,
  canUseAgent,
  doAgentAction,
  isMissionRemoteOfferable,
  isMissionRemoteCompletable,
  missionGrantsItemsOnAccept,
  getAgentLocationWrap,
  getCompletedCareerAgentMap,
  getInfoServiceDetails,
  getJournalDetails,
  getMissionBriefingInfo,
  getMissionJournalInfo,
  getMissionKeywords,
  getMissionInfoItems,
  getMissionObjectiveInfo,
  getMyEpicArcStatus,
  getMissionRecord,
  getMissionStateFromRecord,
  getMissionTemplatePool,
  getAllMissionObjectives,
  getPlausibleMissionIDs,
  normalizeAgentDialogueActionID,
  getReplayTimestamp,
  isSessionInActiveMissionDungeon,
  getSolarSystemOfAgent(agentID) {
    const agentRecord = getAgentRecord(agentID);
    return normalizePositiveInteger(agentRecord && agentRecord.solarSystemID, 0) || null;
  },
  getStandingGainsForMission,
  markMissionObjectiveComplete,
  notifyStorylineOfferLifecycleChange,
  removeOfferFromJournal,
  syncMissionRecordForDungeonInstance,
  notifyMissionInventoryChanges,
  offerSpecificMission,
  evaluateMissionProgress,
};
