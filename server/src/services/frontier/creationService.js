const path = require("path");

const BaseService = require(path.join(__dirname, "../baseService"));
const log = require(path.join(__dirname, "../../utils/logger"));
const {
  buildCreationDiagnostic,
  buildCreationSnapshot,
  normalizePositiveInteger,
  resolveSessionCharacterID,
} = require(path.join(__dirname, "./creationCompatibility"));
const {
  buildDict,
  buildList,
  currentFileTime,
  unwrapMarshalValue,
} = require(path.join(__dirname, "../_shared/serviceHelpers"));
const {
  commitCreationDraft,
  ensureCreationState,
  setCreationPowerState,
} = require(path.join(__dirname, "./creationRuntime"));
const {
  dispatchCreationAbility,
  normalizeAbilityId,
} = require(path.join(__dirname, "./creationAbilityRuntime"));
const {
  registerFallbackCreationAbilityHandlers,
} = require(path.join(__dirname, "./creationAbilityHandlers"));
const {
  registerCreationChargeAbilityHandlers,
} = require(path.join(__dirname, "./creationChargeAbilityHandlers"));
const {
  getCreationModuleChargeState,
} = require(path.join(__dirname, "./creationChargeRuntime"));
const {
  registerIffAbilityHandlers,
} = require(path.join(__dirname, "./iffAbilityHandlers"));
const {
  registerScanningAbilityHandlers,
} = require(path.join(__dirname, "./scanningAbilityHandlers"));

// Behavior handlers must be registered before any get_creation snapshot is
// built: module ability advertisement reads the handler registry.
registerFallbackCreationAbilityHandlers();
registerCreationChargeAbilityHandlers();
registerIffAbilityHandlers();
registerScanningAbilityHandlers();

/**
 * Marshalled kwargs arrive as a dict wrapper; ability handlers expect a
 * plain object keyed by the client's parameter names.
 */
function normalizeAbilityKwargs(kwargs) {
  const unwrapped = unwrapMarshalValue(kwargs);
  if (!unwrapped || typeof unwrapped !== "object" || Array.isArray(unwrapped)) {
    return {};
  }
  return unwrapped;
}
const {
  findShipItemById,
} = require(path.join(__dirname, "../inventory/itemStore"));

function resolveOwnedCreationItem(requestedItemID, session) {
  const itemID = normalizePositiveInteger(requestedItemID);
  const characterID = resolveSessionCharacterID(session);
  if (!itemID || !characterID) {
    return null;
  }

  const item = findShipItemById(itemID);
  if (!item || normalizePositiveInteger(item.ownerID) !== characterID) {
    return null;
  }

  return { item, characterID };
}

function resolveOwnedCreation(requestedItemID, session) {
  const owned = resolveOwnedCreationItem(requestedItemID, session);
  if (!owned) {
    return null;
  }

  const ensured = ensureCreationState(owned.item, owned.characterID);
  if (!ensured.success) {
    log.warn(
      `[creation] get_creation failed ship=${owned.item.itemID} ` +
      `type=${owned.item.typeID} reason=${ensured.errorMsg || "unknown"}`,
    );
    return null;
  }

  if (ensured.data.seeded) {
    log.info(
      `[creation] Seeded ship=${owned.item.itemID} type=${owned.item.typeID} ` +
      `modules=${ensured.data.state.modules.length} ` +
      `hardpoints=${ensured.data.state.hardpoints.length}`,
    );
  }

  return buildCreationSnapshot(
    ensured.data.item,
    owned.characterID,
    ensured.data.state,
    ensured.data.template,
    {
      getLoadedCharge(moduleItemID) {
        const loaded = getCreationModuleChargeState(
          owned.characterID,
          moduleItemID,
        );
        if (!loaded.success || !loaded.data.item) {
          return null;
        }
        return {
          count: loaded.data.quantity,
          typeID: loaded.data.item.typeID,
        };
      },
    },
  );
}

function unpackArgs(args) {
  const unpacked = unwrapMarshalValue(args);
  return Array.isArray(unpacked) ? unpacked : [unpacked];
}

function diagnosticList(diagnostics) {
  return buildList((Array.isArray(diagnostics) ? diagnostics : [])
    .map((diagnostic) => buildCreationDiagnostic(diagnostic)));
}

function getSessionFileTime(session) {
  return (
    session &&
    session._space &&
    typeof session._space.simFileTime === "bigint"
  ) ? session._space.simFileTime : currentFileTime();
}

function buildServerTimeResult(serverTime) {
  return buildDict([["server_time", serverTime || currentFileTime()]]);
}

class CreationService extends BaseService {
  constructor() {
    super("creation");
  }

  Handle_get_creation(args, session) {
    const [requestedItemID] = unpackArgs(args);
    return resolveOwnedCreation(requestedItemID, session);
  }

  Handle_commit_management_draft(args, session) {
    const [requestedItemID, changes] = unpackArgs(args);
    const owned = resolveOwnedCreationItem(requestedItemID, session);
    if (!owned) {
      return diagnosticList([{
        code: "item_unavailable",
        severity: "blocker",
        params: { reason: "CREATION_NOT_FOUND" },
      }]);
    }

    const result = commitCreationDraft(
      owned.item,
      owned.characterID,
      changes,
      session,
    );
    log.info(
      `[creation] commit_management_draft ship=${owned.item.itemID} ` +
      `changes=${Array.isArray(changes) ? changes.length : 0} ` +
      `accepted=${result.success === true} diagnostics=${result.diagnostics.length}`,
    );
    return diagnosticList(result.diagnostics);
  }

  Handle_take_command(args, session) {
    const [requestedItemID] = unpackArgs(args);
    const owned = resolveOwnedCreationItem(requestedItemID, session);
    log.info(
      `[creation] take_command ship=${normalizePositiveInteger(requestedItemID)} ` +
      `accepted=${Boolean(owned)}`,
    );
    return Boolean(owned);
  }

  Handle_set_power_state(args, session) {
    const [requestedItemID, poweredOff] = unpackArgs(args);
    const owned = resolveOwnedCreationItem(requestedItemID, session);
    if (!owned) {
      return false;
    }
    const result = setCreationPowerState(
      owned.item,
      owned.characterID,
      poweredOff === true,
    );
    log.info(
      `[creation] set_power_state ship=${owned.item.itemID} ` +
      `poweredOff=${poweredOff === true} accepted=${result.success === true}`,
    );
    return result.success === true
      ? buildServerTimeResult(getSessionFileTime(session))
      : false;
  }

  /**
   * activate_ability(creation_id, module_item_id, ability_id, **params).
   * Ability arguments arrive as marshalled kwargs; dispatch is registry
   * driven so only abilities with a complete handler (and advertised on the
   * module) can execute. Successful abilities return a dict carrying
   * server_time plus any ability-specific payload (e.g. scan_response).
   */
  Handle_activate_ability(args, session, kwargs) {
    const values = unpackArgs(args);
    const requestedItemID = normalizePositiveInteger(values[0]);
    const moduleItemID = normalizePositiveInteger(values[1]);
    const ability = normalizeAbilityId(values[2]);
    const owned = resolveOwnedCreationItem(requestedItemID, session);
    if (!owned) {
      log.warn(
        `[creation] activate_ability rejected ship=${requestedItemID} ` +
        `module=${moduleItemID} ability=${ability || "<empty>"} reason=CREATION_NOT_FOUND`,
      );
      return false;
    }

    const ensured = ensureCreationState(owned.item, owned.characterID);
    if (!ensured.success) {
      log.warn(
        `[creation] activate_ability rejected ship=${requestedItemID} ` +
        `module=${moduleItemID} ability=${ability} ` +
        `reason=${ensured.errorMsg || "CREATION_STATE_UNAVAILABLE"}`,
      );
      return false;
    }

    const result = dispatchCreationAbility({
      ability,
      kwargs: normalizeAbilityKwargs(kwargs),
      session,
      creationContext: {
        item: ensured.data.item,
        state: ensured.data.state,
        template: ensured.data.template,
        characterID: owned.characterID,
      },
      moduleItemID,
    });
    log.info(
      `[creation] activate_ability ship=${requestedItemID} ` +
      `module=${moduleItemID} ability=${ability} accepted=${result.success === true} ` +
      `reason=${result.success ? "OK" : result.errorMsg || "UNKNOWN"}`,
    );
    if (result.success !== true) {
      return false;
    }
    const data = result.data || {};
    const entries = [[
      "server_time",
      data.serverTime || getSessionFileTime(session),
    ]];
    for (const [key, value] of Object.entries(data)) {
      if (key !== "serverTime") {
        entries.push([key, value]);
      }
    }
    return buildDict(entries);
  }
}

module.exports = CreationService;
module.exports.buildCreationSnapshot = buildCreationSnapshot;
module.exports.resolveOwnedCreation = resolveOwnedCreation;
module.exports.resolveOwnedCreationItem = resolveOwnedCreationItem;
module.exports.resolveSessionCharacterID = resolveSessionCharacterID;
