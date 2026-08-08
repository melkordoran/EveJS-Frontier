const BaseService = require("../baseService");
const log = require("../../utils/logger");
const { buildDict, buildList } = require("../_shared/serviceHelpers");
const {
  syncInventoryItemForSession,
} = require("../character/characterState");
const {
  ITEM_FLAGS,
  grantItemToCharacterLocation,
  listCharacterItems,
} = require("../inventory/itemStore");

const SHELL_CATEGORY_ID = 2153;
const DEFAULT_SHELL_TYPE_ID = 91969;

function getSessionCharacterID(session) {
  return Number(session && (session.characterID || session.charid)) || 0;
}

function listOwnedShells(characterID) {
  if (characterID <= 0) {
    return [];
  }
  return listCharacterItems(characterID)
    .filter((item) => Number(item && item.categoryID) === SHELL_CATEGORY_ID)
    .sort((left, right) => Number(left.itemID) - Number(right.itemID));
}

function buildShellDbData(item) {
  if (!item) {
    return null;
  }
  return buildDict([
    ["shellID", Number(item.itemID)],
    ["shellUniqueID", String(item.itemID)],
    ["shellName", String(item.itemName || "Blank Shell")],
    ["shellCrownID", null],
    ["implants", buildList([])],
  ]);
}

function ensureActiveShell(session) {
  const characterID = getSessionCharacterID(session);
  const existing = listOwnedShells(characterID)[0] || null;
  if (existing) {
    return existing;
  }
  if (characterID <= 0) {
    return null;
  }

  const grant = grantItemToCharacterLocation(
    characterID,
    characterID,
    ITEM_FLAGS.HANGAR,
    DEFAULT_SHELL_TYPE_ID,
    1,
    {
      individualItems: true,
      itemName: "Blank Shell",
      singleton: 1,
    },
  );
  if (!grant || grant.success !== true) {
    log.warn(
      `[shellManager] Failed to provision active shell for char=${characterID} ` +
        `reason=${grant && grant.errorMsg || "UNKNOWN"}`,
    );
    return null;
  }

  const item = grant.data && Array.isArray(grant.data.items)
    ? grant.data.items[0] || null
    : null;
  const change = grant.data && Array.isArray(grant.data.changes)
    ? grant.data.changes[0] || null
    : null;
  if (item) {
    syncInventoryItemForSession(
      session,
      item,
      change && change.previousState ? change.previousState : {},
      { emitCfgLocation: false },
    );
    log.info(
      `[shellManager] Provisioned Blank Shell item=${item.itemID} for char=${characterID}`,
    );
  }
  return item;
}

class ShellManagerService extends BaseService {
  constructor() {
    super("shellManager");
  }

  Handle_get_active_shell_db_data(_args, session) {
    return buildShellDbData(ensureActiveShell(session));
  }

  Handle_get_medical_trait_shell_points() {
    return [0, 0];
  }

  Handle_get_medical_trait_breakdown() {
    return buildList([]);
  }

  Handle_get_last_crown_created_time() {
    return null;
  }

  Handle_get_shells_db_data_basic(args, session) {
    const requested = args && Array.isArray(args[0])
      ? new Set(args[0].map((value) => Number(value)))
      : null;
    const entries = listOwnedShells(getSessionCharacterID(session))
      .filter((item) => !requested || requested.has(Number(item.itemID)))
      .map((item) => [Number(item.itemID), buildShellDbData(item)]);
    return buildDict(entries);
  }

  Handle_get_active_implant() {
    return null;
  }

  Handle_has_reignment() {
    return false;
  }
}

module.exports = ShellManagerService;
module.exports._testing = {
  DEFAULT_SHELL_TYPE_ID,
  SHELL_CATEGORY_ID,
  buildShellDbData,
  ensureActiveShell,
  listOwnedShells,
};
