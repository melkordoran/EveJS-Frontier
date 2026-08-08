"use strict";

const path = require("path");

const CairnService = require("./cairnService");
const log = require(path.join(__dirname, "../../utils/logger"));
const {
  buildDict,
  buildList,
  unwrapMarshalValue,
} = require(path.join(__dirname, "../_shared/serviceHelpers"));
const iffRuntime = require(path.join(__dirname, "./iffRuntime"));
const {
  notifyIffStateChanged,
} = require(path.join(__dirname, "./iffAbilityHandlers"));
const { findItemById } = require(path.join(__dirname, "../inventory/itemStore"));

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function resolveSessionCharacterID(session) {
  return toInt(session && (session.charid || session.characterID), 0);
}

function resolveSessionSolarSystemID(session) {
  return toInt(
    session && (session.solarsystemid2 || session.solarsystemid || session.locationid),
    0,
  );
}

function buildBeaconRow(row) {
  return buildDict([
    ["beacon_id", row.beacon_id],
    ["type_id", row.type_id],
    ["position", row.position],
    ["is_mine", row.is_mine],
    ["transponder_channel", row.transponder_channel],
    ["transponder_code", row.transponder_code],
  ]);
}

class IffMapService extends CairnService {
  constructor() {
    super("iffMapService");
  }

  /**
   * Beacon rows for the requesting pilot. Always returns a marshalled list —
   * an empty one when nothing is visible — matching the client's
   * `for entry in remote.get_visible_beacons()` consumption.
   */
  Handle_get_visible_beacons(args, session) {
    const characterID = resolveSessionCharacterID(session);
    const solarSystemID = resolveSessionSolarSystemID(session);
    const shipID = toInt(
      session && (session.activeShipID || session.shipid || session.shipID),
      0,
    );
    const viewer = {
      characterID,
      solarSystemID,
      corporationID: toInt(session && session.corpid, 0),
      transponder: shipID > 0
        ? iffRuntime.resolveActiveTransponder(characterID, shipID)
        : null,
    };
    const rows = iffRuntime.listVisibleBeacons(viewer);
    log.debug(
      `[iffMap] get_visible_beacons char=${characterID} system=${solarSystemID} rows=${rows.length}`,
    );
    return buildList(rows.map(buildBeaconRow));
  }

  /**
   * set_transponder(item_id, channel, code): channel None turns the
   * transponder off; the code argument is only meaningful on the "code"
   * channel. Applies to an owned transponder-capable item (the client uses
   * this surface for cairn transponders). The client discards the return
   * value and refetches after OnIffMapChanged.
   */
  Handle_set_transponder(args, session) {
    const values = unwrapMarshalValue(args);
    const list = Array.isArray(values) ? values : [values];
    const itemID = toInt(list[0], 0);
    const rawChannel = list.length > 1 ? unwrapMarshalValue(list[1]) : null;
    const rawCode = list.length > 2 ? unwrapMarshalValue(list[2]) : null;
    const characterID = resolveSessionCharacterID(session);

    const item = itemID > 0 ? findItemById(itemID) : null;
    if (!item || toInt(item.ownerID, 0) !== characterID || characterID <= 0) {
      log.warn(
        `[iffMap] set_transponder rejected item=${itemID} char=${characterID} reason=ITEM_NOT_OWNED`,
      );
      return false;
    }

    const configuration = iffRuntime.normalizeIffConfiguration(
      rawChannel,
      rawCode,
      iffRuntime.IFF_TRANSPONDER_CHANNELS,
    );
    if (configuration.errorMsg) {
      log.warn(
        `[iffMap] set_transponder rejected item=${itemID} reason=${configuration.errorMsg}`,
      );
      return false;
    }

    const writeResult = iffRuntime.writeTransponderState(itemID, configuration);
    if (!writeResult || writeResult.success !== true) {
      log.warn(
        `[iffMap] set_transponder write failed item=${itemID} ` +
        `reason=${(writeResult && writeResult.errorMsg) || "WRITE_FAILED"}`,
      );
      return false;
    }

    const solarSystemID = resolveSessionSolarSystemID(session);
    if (solarSystemID > 0) {
      notifyIffStateChanged(solarSystemID, "cairn-transponder");
    }
    log.info(
      `[iffMap] set_transponder item=${itemID} channel=${configuration.channel || "off"} ` +
      `hasCode=${Boolean(configuration.code)}`,
    );
    return true;
  }
}

module.exports = IffMapService;
