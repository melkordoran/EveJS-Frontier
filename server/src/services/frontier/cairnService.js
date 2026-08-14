const BaseService = require("../baseService");
const { buildDict, buildList } = require("../_shared/serviceHelpers");
const database = require("../../gameStore");
const iffRuntime = require("./iffRuntime");
const { findItemById } = require("../inventory/itemStore");

const TYPE_CAIRN = 88400;
const TYPE_FIELD_CAIRN = 93141;
const CAIRN_TYPE_IDS = new Set([TYPE_CAIRN, TYPE_FIELD_CAIRN]);

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function resolveSessionCharacterID(session) {
  return toInt(session && (session.characterID || session.charid), 0);
}

function resolveSessionCorporationID(session) {
  return toInt(
    session && (session.corporationID || session.corpid || session.corpID),
    0,
  );
}

function resolveSessionShipID(session) {
  return toInt(
    session && (
      session.activeShipID ||
      session.shipid ||
      session.shipID ||
      (session._space && session._space.shipID)
    ),
    0,
  );
}

function normalizePosition(position) {
  const values = Array.isArray(position)
    ? position.slice(0, 3)
    : position && typeof position === "object"
      ? [position.x, position.y, position.z]
      : [];
  if (values.length !== 3 || values.some((value) => !Number.isFinite(Number(value)))) {
    return null;
  }
  return values.map(Number);
}

function defaultGetSceneForSession(session) {
  return require("../../space/runtime").getSceneForSession(session);
}

function defaultGetCharacterCorporationID(characterID) {
  const result = database.read("characters", `/${toInt(characterID, 0)}`);
  const record = result && result.success ? result.data : null;
  return toInt(
    record && (record.corporationID || record.corpid || record.corpID),
    0,
  );
}

function listRuntimeCairnEntities(scene) {
  if (!scene) {
    return [];
  }
  const dynamicEntities = scene.dynamicEntities instanceof Map
    ? [...scene.dynamicEntities.values()]
    : Array.isArray(scene.dynamicEntities)
      ? scene.dynamicEntities
      : [];
  return dynamicEntities.filter((entity) => (
    CAIRN_TYPE_IDS.has(toInt(entity && entity.typeID, 0))
  ));
}

function cairnVisibleToViewer(cairn, viewer) {
  if (!cairn || !viewer) {
    return false;
  }
  if (
    viewer.characterID > 0 &&
    viewer.characterID === toInt(cairn.ownerID, 0)
  ) {
    return true;
  }
  const channel = cairn.transponderChannel;
  const transponder = viewer.transponder;
  if (!channel || !transponder || !transponder.channel) {
    return false;
  }
  if (channel === iffRuntime.IFF_CHANNEL_TRIBE) {
    return (
      transponder.channel === iffRuntime.IFF_CHANNEL_TRIBE &&
      viewer.corporationID > 0 &&
      viewer.corporationID === cairn.ownerCorporationID
    );
  }
  if (channel === iffRuntime.IFF_CHANNEL_CODE) {
    return (
      transponder.channel === iffRuntime.IFF_CHANNEL_CODE &&
      typeof transponder.code === "string" &&
      transponder.code.length > 0 &&
      transponder.code === cairn.transponderCode
    );
  }
  return false;
}

function buildCairnRow(cairn) {
  return buildDict([
    ["item_id", cairn.itemID],
    ["type_id", cairn.typeID],
    ["name", cairn.name],
    ["position", cairn.position],
    ["is_mine", cairn.isMine],
    ["transponder_channel", cairn.transponderChannel],
    ["transponder_code", cairn.transponderCode],
  ]);
}

function listVisibleCairns(session, options = {}) {
  const characterID = resolveSessionCharacterID(session);
  if (characterID <= 0) {
    return [];
  }
  const getSceneForSession = typeof options.getSceneForSession === "function"
    ? options.getSceneForSession
    : defaultGetSceneForSession;
  const scene = getSceneForSession(session);
  if (!scene) {
    return [];
  }
  const findItem = typeof options.findItemById === "function"
    ? options.findItemById
    : findItemById;
  const readTransponder = typeof options.readTransponderState === "function"
    ? options.readTransponderState
    : iffRuntime.readTransponderState;
  const getCharacterCorporationID =
    typeof options.getCharacterCorporationID === "function"
      ? options.getCharacterCorporationID
      : defaultGetCharacterCorporationID;
  const resolveTransponder = typeof options.resolveActiveTransponder === "function"
    ? options.resolveActiveTransponder
    : iffRuntime.resolveActiveTransponder;
  const viewer = {
    characterID,
    corporationID: resolveSessionCorporationID(session),
    transponder: resolveTransponder(characterID, resolveSessionShipID(session)),
  };
  const seenItemIDs = new Set();
  const visible = [];

  // Cairns are map/IFF objects, so they are intentionally considered across
  // the current scene rather than only the pilot's nearby destiny grid.  The
  // mutual tribe/code gate below is the system-wide visibility authority.
  for (const entity of listRuntimeCairnEntities(scene)) {
    const itemID = toInt(entity && entity.itemID, 0);
    const typeID = toInt(entity && entity.typeID, 0);
    const position = normalizePosition(entity && entity.position);
    if (itemID <= 0 || !CAIRN_TYPE_IDS.has(typeID) || !position || seenItemIDs.has(itemID)) {
      continue;
    }
    seenItemIDs.add(itemID);
    const item = findItem(itemID);
    const transponder = item
      ? readTransponder(item)
      : { channel: null, code: null };
    const ownerID = toInt(
      (item && item.ownerID) || (entity && entity.ownerID),
      0,
    );
    let ownerCorporationID = toInt(
      (item && item.corporationID) || (entity && entity.corporationID),
      0,
    );
    if (ownerCorporationID <= 0 && ownerID > 0) {
      ownerCorporationID = getCharacterCorporationID(ownerID);
    }
    const cairn = {
      itemID,
      typeID,
      name: String(
        (item && item.itemName) ||
        (entity && (entity.itemName || entity.name)) ||
        (typeID === TYPE_FIELD_CAIRN ? "Field Cairn" : "Cairn"),
      ),
      position,
      ownerID,
      ownerCorporationID,
      transponderChannel: transponder && transponder.channel || null,
      transponderCode: transponder && transponder.code || null,
    };
    if (!cairnVisibleToViewer(cairn, viewer)) {
      continue;
    }
    cairn.isMine = ownerID === characterID;
    visible.push(cairn);
  }

  return visible.sort((left, right) => left.itemID - right.itemID);
}

class CairnService extends BaseService {
  constructor(serviceName = "cairnService", options = {}) {
    super(serviceName);
    this.options = options;
  }

  Handle_get_visible_cairns(args, session) {
    return buildList(
      listVisibleCairns(session, this.options).map(buildCairnRow),
    );
  }
}

module.exports = CairnService;
module.exports.CAIRN_TYPE_IDS = CAIRN_TYPE_IDS;
module.exports.TYPE_CAIRN = TYPE_CAIRN;
module.exports.TYPE_FIELD_CAIRN = TYPE_FIELD_CAIRN;
module.exports._testing = {
  cairnVisibleToViewer,
  listRuntimeCairnEntities,
  listVisibleCairns,
  normalizePosition,
};
