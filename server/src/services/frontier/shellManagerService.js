const BaseService = require("../baseService");
const log = require("../../utils/logger");
const { throwWrappedUserError } = require("../../common/machoErrors");
const {
  buildDict,
  buildList,
  unwrapMarshalValue,
} = require("../_shared/serviceHelpers");
const {
  syncInventoryItemForSession,
} = require("../character/characterState");
const {
  ITEM_FLAGS,
  findItemById,
  grantItemToCharacterLocation,
  listCharacterItems,
  updateInventoryItem,
} = require("../inventory/itemStore");

const SHELL_CATEGORY_ID = 2153;
const DEFAULT_SHELL_TYPE_ID = 91969;
// frontier/character/client/shell/integration.pyc, _change_shell_name().
const MAX_SHELL_NAME_LENGTH = 100;
const UNSUPPORTED_SHELL_MUTATION_NOTIFY =
  "Shell implants and ascension mutations are not available yet.";

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

function throwShellNotify(notify) {
  throwWrappedUserError("CustomNotify", {
    notify: String(notify || UNSUPPORTED_SHELL_MUTATION_NOTIFY),
  });
}

function normalizeShellName(value) {
  const unwrapped = unwrapMarshalValue(value);
  if (typeof unwrapped !== "string" || unwrapped.trim().length === 0) {
    throwShellNotify("Enter a name for this shell.");
  }
  if ([...unwrapped].length > MAX_SHELL_NAME_LENGTH) {
    throwShellNotify(
      `Shell names may contain at most ${MAX_SHELL_NAME_LENGTH} characters.`,
    );
  }
  return unwrapped;
}

function renameOwnedShell(session, shellID, rawName) {
  const characterID = getSessionCharacterID(session);
  const item = findItemById(Number(shellID));
  if (
    characterID <= 0 ||
    !item ||
    Number(item.ownerID) !== characterID ||
    Number(item.categoryID) !== SHELL_CATEGORY_ID
  ) {
    throwShellNotify("You do not own this shell.");
  }

  const shellName = normalizeShellName(rawName);
  const update = updateInventoryItem(item.itemID, (current) => ({
    ...current,
    itemName: shellName,
  }));
  if (!update || update.success !== true) {
    throwShellNotify("The shell name could not be saved.");
  }

  syncInventoryItemForSession(
    session,
    update.data,
    update.previousData || {},
    { emitCfgLocation: false },
  );
  if (session && typeof session.sendNotification === "function") {
    session.sendNotification("OnShellChangedName", "charid", [
      Number(update.data.itemID),
      shellName,
    ]);
  }
  log.info(
    `[shellManager] Renamed shell=${Number(update.data.itemID)} char=${characterID}`,
  );
  return true;
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

  Handle_set_active_shell_name(args, session) {
    const shell = ensureActiveShell(session);
    if (!shell) {
      throwShellNotify("No active shell is available.");
    }
    const values = unwrapMarshalValue(args);
    return renameOwnedShell(session, shell.itemID, values && values[0]);
  }

  Handle_set_shell_name(args, session) {
    const values = unwrapMarshalValue(args);
    return renameOwnedShell(
      session,
      values && values[0],
      values && values[1],
    );
  }

  _rejectUnsupportedMutation(methodName) {
    log.debug(`[shellManager] ${methodName} rejected: progression mutation unavailable`);
    throwShellNotify(UNSUPPORTED_SHELL_MUTATION_NOTIFY);
  }

  Handle_create_crown() {
    return this._rejectUnsupportedMutation("create_crown");
  }

  Handle_implant_crown() {
    return this._rejectUnsupportedMutation("implant_crown");
  }

  Handle_delete_active_crown() {
    return this._rejectUnsupportedMutation("delete_active_crown");
  }

  Handle_implant_implant() {
    return this._rejectUnsupportedMutation("implant_implant");
  }

  Handle_delete_active_implant() {
    return this._rejectUnsupportedMutation("delete_active_implant");
  }

  Handle_admin_create_and_implant_implant() {
    return this._rejectUnsupportedMutation("admin_create_and_implant_implant");
  }

  Handle_admin_create_crown_without_cooldown() {
    return this._rejectUnsupportedMutation("admin_create_crown_without_cooldown");
  }

  Handle_clear_medical_trait_implants() {
    return this._rejectUnsupportedMutation("clear_medical_trait_implants");
  }

  Handle_admin_grant_medical_trait_implant() {
    return this._rejectUnsupportedMutation("admin_grant_medical_trait_implant");
  }

  Handle_use_medical_kit() {
    return this._rejectUnsupportedMutation("use_medical_kit");
  }

  Handle_use_status_effect_remedy() {
    return this._rejectUnsupportedMutation("use_status_effect_remedy");
  }

  Handle_admin_add_reignment_to_inventory() {
    return this._rejectUnsupportedMutation("admin_add_reignment_to_inventory");
  }

  Handle_admin_add_medical_kit_to_inventory() {
    return this._rejectUnsupportedMutation("admin_add_medical_kit_to_inventory");
  }

  Handle_create_and_activate_shell() {
    return this._rejectUnsupportedMutation("create_and_activate_shell");
  }

  Handle_activate_shell() {
    return this._rejectUnsupportedMutation("activate_shell");
  }
}

module.exports = ShellManagerService;
module.exports._testing = {
  DEFAULT_SHELL_TYPE_ID,
  MAX_SHELL_NAME_LENGTH,
  SHELL_CATEGORY_ID,
  UNSUPPORTED_SHELL_MUTATION_NOTIFY,
  buildShellDbData,
  ensureActiveShell,
  listOwnedShells,
  normalizeShellName,
  renameOwnedShell,
};
