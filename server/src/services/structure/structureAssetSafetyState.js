const path = require("path");

const config = require(path.join(__dirname, "../../config"));
const database = require(path.join(__dirname, "../../gameStore"));
const log = require(path.join(__dirname, "../../utils/logger"));
const worldData = require(path.join(__dirname, "../../space/worldData"));
const {
  ITEM_FLAGS,
  createSpaceItemForOwner,
  findItemById,
  getAllItems,
  grantItemToOwnerLocation,
  listContainerItems,
  moveItemToLocation,
  removeInventoryItem,
  updateInventoryItem,
} = require(path.join(__dirname, "../inventory/itemStore"));
const {
  resolveItemByTypeID,
} = require(path.join(__dirname, "../inventory/itemTypeRegistry"));
const {
  TABLE,
  readStaticRows,
} = require(path.join(__dirname, "../_shared/referenceData"));
const {
  NEXT_ASSET_WRAP_ID_START,
  STRUCTURE_UPKEEP_STATE,
} = require(path.join(__dirname, "./structureConstants"));
const {
  getCharacterIDsInCorporation,
} = require(path.join(__dirname, "../corporation/corporationState"));
const {
  NOTIFICATION_GROUP,
  NOTIFICATION_TYPE,
} = require(path.join(__dirname, "../notifications/notificationConstants"));
const {
  createNotification,
} = require(path.join(__dirname, "../notifications/notificationState"));
const {
  buildStructureScatterPosition,
  getStructureSpaceDirection,
} = require(path.join(__dirname, "./structureSpaceInterop"));

const STRUCTURE_ASSET_SAFETY_TABLE = "structureAssetSafety";
const ASSET_SAFETY_FLAG_ID = 36;
const ASSET_SAFETY_WRAP_TYPE_ID = 60;
const OFFICE_EJECT_CONTAINER_TYPE_ID = 10167;
const CATEGORY_STRUCTURE = 65;
const STRUCTURE_UNANCHOR_ARTIFACT_PREFIX = "evejs:structure-unanchor";
const STRUCTURE_RIG_SLOT_FLAGS = Object.freeze(new Set([92, 93, 94, 95, 96, 97, 98, 99]));
const STRUCTURE_ATTACHED_ITEM_FLAGS = Object.freeze(new Set([
  ...Array.from({ length: 24 }, (_, index) => 11 + index),
  ...Array.from({ length: 8 }, (_, index) => 125 + index),
  ...Array.from({ length: 8 }, (_, index) => 164 + index),
  ITEM_FLAGS.FIGHTER_BAY,
  ITEM_FLAGS.FIGHTER_TUBE_0,
  ITEM_FLAGS.FIGHTER_TUBE_1,
  ITEM_FLAGS.FIGHTER_TUBE_2,
  ITEM_FLAGS.FIGHTER_TUBE_3,
  ITEM_FLAGS.FIGHTER_TUBE_4,
  ITEM_FLAGS.STRUCTURE_FUEL_BAY,
  ITEM_FLAGS.STRUCTURE_DEED,
]));
const CORPORATION_HANGAR_FLAGS = Object.freeze(new Set([
  115, // flagCorpSAG1
  116, // flagCorpSAG2
  117, // flagCorpSAG3
  118, // flagCorpSAG4
  119, // flagCorpSAG5
  120, // flagCorpSAG6
  121, // flagCorpSAG7
  184, // flagCorpGoalDeliveries
]));
const STRUCTURE_DELIVERY_FLAGS = Object.freeze(new Set([
  ITEM_FLAGS.CORP_DELIVERIES,
  ITEM_FLAGS.DELIVERIES,
  ITEM_FLAGS.CAPSULEER_DELIVERIES,
]));
const STRUCTURE_RECOVERABLE_ASSET_FLAGS = Object.freeze(new Set([
  ITEM_FLAGS.HANGAR,
  ITEM_FLAGS.CARGO_HOLD,
  186, // flagMoonMaterialBay
]));
const DAYS_UNTIL_CAN_DELIVER = 5;
const DAYS_UNTIL_AUTO_MOVE = 20;
const DAY_MS = 24 * 60 * 60 * 1000;
const FILETIME_EPOCH_OFFSET = 116444736000000000n;
const FILETIME_TICKS_PER_MS = 10000n;

let wrapCache = null;
let stationCache = null;

function cloneValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function getCorporationRuntimeState() {
  return require(path.join(
    __dirname,
    "../corporation/corporationRuntimeState",
  ));
}

function getOfficeRentalBilling() {
  return require(path.join(
    __dirname,
    "../corporation/officeRentalBilling",
  ));
}

function getCorporationNotifications() {
  return require(path.join(
    __dirname,
    "../corporation/corporationNotifications",
  ));
}

function normalizeInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function normalizePositiveInt(value, fallback = 0) {
  const numeric = normalizeInt(value, fallback);
  return numeric > 0 ? numeric : fallback;
}

function normalizeTimestampMs(value, fallback = null) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.trunc(numeric) : fallback;
}

function readWrapTable() {
  const result = database.read(STRUCTURE_ASSET_SAFETY_TABLE, "/");
  if (!result.success || !result.data || typeof result.data !== "object") {
    return {
      _meta: {
        nextWrapID: NEXT_ASSET_WRAP_ID_START,
        generatedAt: null,
        lastUpdatedAt: null,
      },
      wraps: [],
    };
  }
  return cloneValue(result.data);
}

function writeWrapTable(payload) {
  const result = database.write(STRUCTURE_ASSET_SAFETY_TABLE, "/", payload);
  if (!result.success) {
    return {
      success: false,
      errorMsg: result.errorMsg || "WRITE_FAILED",
    };
  }
  wrapCache = null;
  return { success: true };
}

function getStaticStations() {
  if (stationCache) {
    return stationCache;
  }

  stationCache = readStaticRows(TABLE.STATIONS)
    .map((station) => ({
      itemID: normalizePositiveInt(station && station.stationID, 0),
      typeID: normalizePositiveInt(station && station.stationTypeID, 0),
      solarSystemID: normalizePositiveInt(station && station.solarSystemID, 0),
      constellationID: normalizePositiveInt(station && station.constellationID, 0),
      regionID: normalizePositiveInt(station && station.regionID, 0),
      itemName: String(
        station && (station.stationName || station.itemName || `Station ${station.stationID}`),
      ),
    }))
    .filter((station) => station.itemID > 0)
    .sort((left, right) => left.itemID - right.itemID);

  return stationCache;
}

function normalizeStationInfo(value) {
  if (!value || typeof value !== "object") {
    return null;
  }

  const itemID = normalizePositiveInt(value.itemID || value.stationID, 0);
  if (!itemID) {
    return null;
  }

  return {
    itemID,
    typeID: normalizePositiveInt(value.typeID || value.stationTypeID, 0),
    solarSystemID: normalizePositiveInt(value.solarSystemID, 0),
    itemName: String(value.itemName || value.stationName || `Station ${itemID}`),
  };
}

function normalizeWrapRecord(entry = {}) {
  const assetWrapID = normalizePositiveInt(entry.assetWrapID, 0);
  const ownerKind = String(entry.ownerKind || "char").trim().toLowerCase() === "corp"
    ? "corp"
    : "char";
  const nearestNPCStationInfo = normalizeStationInfo(entry.nearestNPCStationInfo);
  const createdAt = normalizeTimestampMs(entry.createdAt, null) || Date.now();
  const ejectTimeMs =
    normalizeTimestampMs(entry.ejectTimeMs, null) ||
    normalizeTimestampMs(entry.ejectTime, null) ||
    createdAt;

  return {
    assetWrapID,
    ownerID: normalizePositiveInt(entry.ownerID, 0),
    ownerKind,
    sourceStructureID: normalizePositiveInt(entry.sourceStructureID, 0),
    solarSystemID: normalizePositiveInt(entry.solarSystemID, 0),
    wrapName: String(entry.wrapName || `Asset Safety Wrap ${assetWrapID}`),
    lifecycleKey:
      String(entry.lifecycleKey || "").trim() || null,
    wrapTypeID: ASSET_SAFETY_WRAP_TYPE_ID,
    itemIDs: [...new Set((Array.isArray(entry.itemIDs) ? entry.itemIDs : []).map((itemID) => normalizePositiveInt(itemID, 0)).filter(Boolean))].sort((left, right) => left - right),
    createdAt,
    ejectTimeMs,
    daysUntilCanDeliverConst: DAYS_UNTIL_CAN_DELIVER,
    daysUntilAutoMoveConst: DAYS_UNTIL_AUTO_MOVE,
    nearestNPCStationInfo,
    destinationID: normalizePositiveInt(entry.destinationID, 0) || null,
    destinationKind: entry.destinationKind ? String(entry.destinationKind) : null,
    deliveredAt: normalizeTimestampMs(entry.deliveredAt, null),
    autoMovedAt: normalizeTimestampMs(entry.autoMovedAt, null),
    assetSafetyDisabled: Boolean(entry.assetSafetyDisabled),
  };
}

function ensureWrapCache() {
  if (wrapCache) {
    return wrapCache;
  }

  const payload = readWrapTable();
  const wraps = Array.isArray(payload.wraps)
    ? payload.wraps.map((entry) => normalizeWrapRecord(entry))
    : [];
  wrapCache = {
    meta: {
      nextWrapID: Math.max(
        NEXT_ASSET_WRAP_ID_START,
        normalizePositiveInt(payload._meta && payload._meta.nextWrapID, NEXT_ASSET_WRAP_ID_START),
      ),
      generatedAt: payload._meta && payload._meta.generatedAt ? String(payload._meta.generatedAt) : null,
      lastUpdatedAt: payload._meta && payload._meta.lastUpdatedAt ? String(payload._meta.lastUpdatedAt) : null,
    },
    wraps,
    byWrapID: new Map(wraps.map((wrap) => [wrap.assetWrapID, wrap])),
  };
  return wrapCache;
}

function persistWraps(wraps, metaOverrides = {}) {
  const normalizedWraps = wraps.map((wrap) => normalizeWrapRecord(wrap));
  const nextWrapID = Math.max(
    NEXT_ASSET_WRAP_ID_START,
    ...normalizedWraps.map((wrap) => normalizePositiveInt(wrap.assetWrapID, 0) + 1),
    NEXT_ASSET_WRAP_ID_START,
  );
  return writeWrapTable({
    _meta: {
      ...(ensureWrapCache().meta || {}),
      nextWrapID,
      lastUpdatedAt: new Date().toISOString(),
      ...metaOverrides,
    },
    wraps: normalizedWraps,
  });
}

function updateWrap(assetWrapID, updater) {
  const targetID = normalizePositiveInt(assetWrapID, 0);
  if (!targetID || typeof updater !== "function") {
    return {
      success: false,
      errorMsg: "WRAP_NOT_FOUND",
    };
  }

  const cache = ensureWrapCache();
  const current = cache.byWrapID.get(targetID);
  if (!current) {
    return {
      success: false,
      errorMsg: "WRAP_NOT_FOUND",
    };
  }

  const next = normalizeWrapRecord(updater(cloneValue(current)) || current);
  const writeResult = persistWraps(
    cache.wraps.map((wrap) => (wrap.assetWrapID === targetID ? next : wrap)),
  );
  if (!writeResult.success) {
    return writeResult;
  }

  return {
    success: true,
    data: next,
  };
}

function createWrap(record) {
  const cache = ensureWrapCache();
  const assetWrapID = Math.max(NEXT_ASSET_WRAP_ID_START, cache.meta.nextWrapID || NEXT_ASSET_WRAP_ID_START);
  const next = normalizeWrapRecord({
    ...record,
    assetWrapID,
  });
  const writeResult = persistWraps([...cache.wraps, next], {
    nextWrapID: assetWrapID + 1,
    generatedAt: cache.meta.generatedAt || new Date().toISOString(),
  });
  if (!writeResult.success) {
    return writeResult;
  }

  return {
    success: true,
    data: next,
  };
}

function listWraps(options = {}) {
  if (options.refresh !== false) {
    tickAssetSafetyWraps(options.nowMs);
  }
  const includeDelivered = options.includeDelivered === true;
  return ensureWrapCache().wraps
    .filter((wrap) => includeDelivered || !wrap.deliveredAt)
    .map((wrap) => cloneValue(wrap));
}

function getWrapByID(assetWrapID, options = {}) {
  if (options.refresh !== false) {
    tickAssetSafetyWraps(options.nowMs);
  }
  return ensureWrapCache().byWrapID.get(normalizePositiveInt(assetWrapID, 0)) || null;
}

function getWrapNames(wrapIDs = []) {
  return Object.fromEntries(
    (Array.isArray(wrapIDs) ? wrapIDs : [wrapIDs])
      .map((wrapID) => normalizePositiveInt(wrapID, 0))
      .filter(Boolean)
      .map((wrapID) => {
        const wrap = getWrapByID(wrapID);
        return [wrapID, wrap ? wrap.wrapName : null];
      }),
  );
}

function listWrapsForOwner(ownerKind, ownerID, options = {}) {
  const normalizedOwnerKind = String(ownerKind || "char").trim().toLowerCase() === "corp"
    ? "corp"
    : "char";
  const normalizedOwnerID = normalizePositiveInt(ownerID, 0);
  if (!normalizedOwnerID) {
    return [];
  }

  return listWraps(options).filter(
    (wrap) =>
      wrap.ownerKind === normalizedOwnerKind &&
      normalizePositiveInt(wrap.ownerID, 0) === normalizedOwnerID,
  );
}

function getSessionCharacterID(session) {
  return normalizePositiveInt(
    session && (session.characterID || session.charid || session.userid),
    0,
  );
}

function getSessionCorporationID(session) {
  return normalizePositiveInt(
    session && (session.corporationID || session.corpid),
    0,
  );
}

function sessionCanManageWrap(session, wrap) {
  if (!wrap) {
    return false;
  }
  if (config.devBypassAssetSafetyWrapAccess === true) {
    return true;
  }

  const structureState = require(path.join(__dirname, "./structureState"));
  if (structureState.hasStructureGmBypass(session)) {
    return true;
  }

  return (
    (wrap.ownerKind === "char" && wrap.ownerID === getSessionCharacterID(session)) ||
    (wrap.ownerKind === "corp" && wrap.ownerID === getSessionCorporationID(session))
  );
}

function getFallbackNpcStationInfo(solarSystemID) {
  const stations = getStaticStations();
  if (stations.length === 0) {
    return null;
  }

  const numericSystemID = normalizePositiveInt(solarSystemID, 0);
  const systemRecord = worldData.getSolarSystemByID(numericSystemID);
  const sameSystem = stations.find((station) => station.solarSystemID === numericSystemID);
  if (sameSystem) {
    return cloneValue(sameSystem);
  }

  if (systemRecord) {
    const sameConstellation = stations.find(
      (station) =>
        normalizePositiveInt(station.constellationID, 0) > 0 &&
        station.constellationID === normalizePositiveInt(systemRecord.constellationID, 0),
    );
    if (sameConstellation) {
      return cloneValue(sameConstellation);
    }

    const sameRegion = stations.find(
      (station) =>
        normalizePositiveInt(station.regionID, 0) > 0 &&
        station.regionID === normalizePositiveInt(systemRecord.regionID, 0),
    );
    if (sameRegion) {
      return cloneValue(sameRegion);
    }
  }

  return cloneValue(stations[0]);
}

function isAssetSafetyDisabledSolarSystem(solarSystemID) {
  const numericSystemID = normalizePositiveInt(solarSystemID, 0);
  const systemRecord = worldData.getSolarSystemByID(numericSystemID);
  if (!systemRecord) {
    return false;
  }

  if (numericSystemID >= 31000000) {
    return true;
  }

  if (normalizePositiveInt(systemRecord.regionID, 0) === 10000070) {
    return true;
  }

  return /^J\d+/i.test(String(systemRecord.solarSystemName || "").trim());
}

function getWrapUnlockTimeMs(wrap) {
  return normalizeTimestampMs(wrap && wrap.ejectTimeMs, 0) + DAYS_UNTIL_CAN_DELIVER * DAY_MS;
}

function getWrapAutoMoveTimeMs(wrap) {
  return normalizeTimestampMs(wrap && wrap.ejectTimeMs, 0) + DAYS_UNTIL_AUTO_MOVE * DAY_MS;
}

function listTopLevelStructureItems(ownerID, structureID, options = {}) {
  const excludedItemIDs = new Set(
    (Array.isArray(options.excludeItemIDs) ? options.excludeItemIDs : [])
      .map((itemID) => normalizePositiveInt(itemID, 0))
      .filter(Boolean),
  );

  return listContainerItems(normalizePositiveInt(ownerID, 0), normalizePositiveInt(structureID, 0), null)
    .filter((item) => item && !excludedItemIDs.has(normalizePositiveInt(item.itemID, 0)));
}

function getOwnerKindForAssetSafety(ownerID) {
  const numericOwnerID = normalizePositiveInt(ownerID, 0);
  return numericOwnerID >= 140000000 && numericOwnerID < 200000000
    ? "char"
    : "corp";
}

function isStructureHangarAssetItem(item) {
  const flagID = normalizePositiveInt(item && item.flagID, 0);
  return (
    STRUCTURE_RECOVERABLE_ASSET_FLAGS.has(flagID) ||
    CORPORATION_HANGAR_FLAGS.has(flagID) ||
    STRUCTURE_DELIVERY_FLAGS.has(flagID)
  );
}

function listTopLevelStructureHangarItems(ownerID, structureID, options = {}) {
  return listTopLevelStructureItems(ownerID, structureID, options)
    .filter(isStructureHangarAssetItem);
}

function listTopLevelCorporationOfficeItems(corporationID, office) {
  const numericCorporationID = normalizePositiveInt(corporationID, 0);
  if (!numericCorporationID || !office || typeof office !== "object") {
    return [];
  }

  const officeLocationIDs = [
    office.officeID,
    office.officeFolderID,
    office.itemID,
  ]
    .map((locationID) => normalizePositiveInt(locationID, 0))
    .filter(Boolean);
  const seenItemIDs = new Set();
  const items = [];
  for (const locationID of officeLocationIDs) {
    for (const item of listContainerItems(numericCorporationID, locationID, null)) {
      const itemID = normalizePositiveInt(item && item.itemID, 0);
      if (!itemID || seenItemIDs.has(itemID)) {
        continue;
      }
      seenItemIDs.add(itemID);
      items.push(item);
    }
  }
  return items;
}

function buildOfficeEjectContainerName(structure) {
  const structureName = String(
    structure && (structure.itemName || structure.name || `Structure ${structure.structureID}`),
  );
  return `${structureName} Office Assets`;
}

function buildStructureEjectContainerName(structure) {
  const structureName = String(
    structure && (structure.itemName || structure.name || `Structure ${structure.structureID}`),
  );
  return `${structureName} Asset Safety Container`;
}

function buildStructureDecommissionContainerName(structure) {
  const structureName = String(
    structure && (structure.itemName || structure.name || `Structure ${structure.structureID}`),
  );
  return `${structureName} Decommissioned Fittings`;
}

function buildStructureUnanchorHullMarker(structureID) {
  return `${STRUCTURE_UNANCHOR_ARTIFACT_PREFIX}:hull:${structureID}`;
}

function buildStructureUnanchorFittingsMarker(structureID, coreComplete = false) {
  const marker = `${STRUCTURE_UNANCHOR_ARTIFACT_PREFIX}:fittings:${structureID}`;
  return coreComplete ? `${marker}:core-complete` : marker;
}

function buildStructureUnanchorAssetsMarker(structureID, ownerID) {
  return (
    `${STRUCTURE_UNANCHOR_ARTIFACT_PREFIX}:assets:${structureID}:owner:${ownerID}`
  );
}

function buildStructureUnanchorOfficeMarker(structureID, officeID) {
  return (
    `${STRUCTURE_UNANCHOR_ARTIFACT_PREFIX}:office:${structureID}:office:${officeID}`
  );
}

function normalizeAllInventoryItems() {
  const items = getAllItems();
  return (Array.isArray(items) ? items : Object.values(items || {}))
    .filter(Boolean)
    .sort(
      (left, right) =>
        normalizePositiveInt(left && left.itemID, 0) -
        normalizePositiveInt(right && right.itemID, 0),
    );
}

function isCanonicalStructureUnanchorSpaceArtifact(
  item,
  structure,
  ownerID,
) {
  const solarSystemID = normalizePositiveInt(
    structure && structure.solarSystemID,
    0,
  );
  return Boolean(
    item &&
    normalizePositiveInt(item.ownerID, 0) ===
      normalizePositiveInt(ownerID, 0) &&
    normalizePositiveInt(item.locationID, 0) === solarSystemID &&
    normalizeInt(item.flagID, -1) === 0 &&
    item.spaceState &&
    normalizePositiveInt(item.spaceState.systemID, 0) === solarSystemID
  );
}

function findStructureUnanchorHull(
  structure,
  allItems,
  hullMarker,
) {
  const structureID = normalizePositiveInt(structure && structure.structureID, 0);
  const structureTypeID = normalizePositiveInt(structure && structure.typeID, 0);
  return allItems.find(
    (item) =>
      normalizePositiveInt(item && item.typeID, 0) === structureTypeID &&
      normalizePositiveInt(item && item.categoryID, 0) === CATEGORY_STRUCTURE &&
      normalizePositiveInt(item && item.launcherID, 0) === structureID &&
      normalizeInt(item && item.singleton, 0) === 1 &&
      String(item && item.customInfo || "") === hullMarker,
  ) || null;
}

function findStructureUnanchorFittingsContainers(
  structure,
  ownerID,
  allItems,
  fittingsMarker,
  coreCompleteMarker,
) {
  const structureID = normalizePositiveInt(structure && structure.structureID, 0);
  const solarSystemID = normalizePositiveInt(structure && structure.solarSystemID, 0);
  const legacyName = buildStructureDecommissionContainerName(structure);
  return allItems
    .filter((item) => {
      if (
        normalizePositiveInt(item && item.typeID, 0) !== OFFICE_EJECT_CONTAINER_TYPE_ID ||
        normalizePositiveInt(item && item.launcherID, 0) !== structureID ||
        normalizeInt(item && item.singleton, 0) !== 1
      ) {
        return false;
      }
      const customInfo = String(item && item.customInfo || "");
      if (customInfo === fittingsMarker || customInfo === coreCompleteMarker) {
        return true;
      }
      return (
        normalizePositiveInt(item && item.ownerID, 0) === ownerID &&
        normalizePositiveInt(item && item.locationID, 0) === solarSystemID &&
        normalizeInt(item && item.flagID, -1) === 0 &&
        String(item && item.itemName || "") === legacyName
      );
    })
    .sort((left, right) => {
      const leftMarked = [
        fittingsMarker,
        coreCompleteMarker,
      ].includes(String(left && left.customInfo || ""));
      const rightMarked = [
        fittingsMarker,
        coreCompleteMarker,
      ].includes(String(right && right.customInfo || ""));
      if (leftMarked !== rightMarked) {
        return leftMarked ? -1 : 1;
      }
      return (
        normalizePositiveInt(left && left.itemID, 0) -
        normalizePositiveInt(right && right.itemID, 0)
      );
    });
}

function findStructureUnanchorEjectContainer(
  structure,
  ownerID,
  allItems,
  marker,
) {
  const structureID = normalizePositiveInt(structure && structure.structureID, 0);
  const markedItems = allItems.filter(
    (item) => String(item && item.customInfo || "") === marker,
  );
  const matchingItems = markedItems.filter(
    (item) =>
      normalizePositiveInt(item && item.typeID, 0) ===
        OFFICE_EJECT_CONTAINER_TYPE_ID &&
      normalizePositiveInt(item && item.launcherID, 0) === structureID &&
      normalizeInt(item && item.singleton, 0) === 1 &&
      isCanonicalStructureUnanchorSpaceArtifact(
        item,
        structure,
        ownerID,
      ),
  );
  if (markedItems.length > 1 || markedItems.length !== matchingItems.length) {
    return {
      success: false,
      errorMsg: "INVALID_STRUCTURE_UNANCHOR_EJECT_ARTIFACT",
      data: null,
    };
  }
  return {
    success: true,
    data: matchingItems[0] || null,
  };
}

function isStructureRigSlotItem(item) {
  return STRUCTURE_RIG_SLOT_FLAGS.has(normalizePositiveInt(item && item.flagID, 0));
}

function isStructureAttachedItemForUnanchor(item) {
  return STRUCTURE_ATTACHED_ITEM_FLAGS.has(normalizePositiveInt(item && item.flagID, 0));
}

function msToFiletimeLong(value) {
  const timestampMs = normalizeTimestampMs(value, Date.now()) || Date.now();
  return {
    type: "long",
    value: String(BigInt(timestampMs) * FILETIME_TICKS_PER_MS + FILETIME_EPOCH_OFFSET),
  };
}

function durationMsToLong(value) {
  const durationMs = Math.max(0, normalizeInt(value, 0));
  return {
    type: "long",
    value: String(BigInt(durationMs) * FILETIME_TICKS_PER_MS),
  };
}

function buildAssetSafetyMovedNotificationData(structure, wrap) {
  const structureID = normalizePositiveInt(structure && structure.structureID, 0);
  const structureTypeID = normalizePositiveInt(structure && structure.typeID, 0);
  const solarSystemID = normalizePositiveInt(structure && structure.solarSystemID, 0);
  const structureName = String(
    structure && (structure.itemName || structure.name || `Structure ${structureID}`),
  );
  const minimumDurationMs = DAYS_UNTIL_CAN_DELIVER * DAY_MS;
  const fullDurationMs = DAYS_UNTIL_AUTO_MOVE * DAY_MS;
  const ejectTimeMs = normalizeTimestampMs(wrap && wrap.ejectTimeMs, Date.now()) || Date.now();
  return {
    structureID,
    structureShowInfoData: ["showinfo", structureTypeID, structureID],
    solarsystemID: solarSystemID,
    structureTypeID,
    assetSafetyDurationMinimum: durationMsToLong(minimumDurationMs),
    assetSafetyMinimumTimestamp: msToFiletimeLong(ejectTimeMs + minimumDurationMs),
    assetSafetyDurationFull: durationMsToLong(fullDurationMs),
    assetSafetyFullTimestamp: msToFiletimeLong(ejectTimeMs + fullDurationMs),
    isCorpOwned: wrap && wrap.ownerKind === "corp",
    structureLink: `<a href="showinfo:${structureTypeID}//${structureID}">${structureName}</a>`,
    newStationID:
      normalizePositiveInt(
        wrap && wrap.nearestNPCStationInfo && wrap.nearestNPCStationInfo.itemID,
        0,
      ) || null,
  };
}

function buildStructureItemsNeedAttentionNotificationData(structure) {
  const structureID = normalizePositiveInt(structure && structure.structureID, 0);
  const structureTypeID = normalizePositiveInt(structure && structure.typeID, 0);
  const solarSystemID = normalizePositiveInt(structure && structure.solarSystemID, 0);
  return {
    structureID,
    structureShowInfoData: ["showinfo", structureTypeID, structureID],
    solarsystemID: solarSystemID,
    structureTypeID,
  };
}

function collectAssetSafetyNotificationRecipients(wrap) {
  if (!wrap) {
    return [];
  }
  const ownerID = normalizePositiveInt(wrap.ownerID, 0);
  if (!ownerID) {
    return [];
  }
  if (wrap.ownerKind === "corp") {
    return [...new Set(getCharacterIDsInCorporation(ownerID))];
  }
  return [ownerID];
}

function collectStructureOwnerNotificationRecipients(ownerID) {
  const numericOwnerID = normalizePositiveInt(ownerID, 0);
  if (!numericOwnerID) {
    return [];
  }
  if (getOwnerKindForAssetSafety(numericOwnerID) === "corp") {
    return [...new Set(getCharacterIDsInCorporation(numericOwnerID))];
  }
  return [numericOwnerID];
}

function createAssetSafetyMovedNotifications(structure, wrap) {
  const recipients = collectAssetSafetyNotificationRecipients(wrap);
  if (recipients.length <= 0) {
    return;
  }
  const senderID = normalizePositiveInt(
    structure && (structure.ownerCorpID || structure.ownerID),
    0,
  );
  const data = buildAssetSafetyMovedNotificationData(structure, wrap);
  for (const characterID of recipients) {
    const result = createNotification(characterID, {
      typeID: NOTIFICATION_TYPE.STRUCTURE_ITEMS_TO_ASSET_SAFETY,
      senderID,
      groupID: NOTIFICATION_GROUP.STRUCTURES,
      processed: false,
      data,
      emitLive: false,
    });
    if (!result || result.success !== true) {
      log.warn(
        `[StructureAssetSafety] Failed to create asset-safety notification ` +
        `structure=${data.structureID} wrap=${wrap.assetWrapID} ` +
        `character=${characterID}: ${result && result.errorMsg ? result.errorMsg : "UNKNOWN"}`,
      );
    }
  }
}

function createStructureItemsNeedAttentionNotifications(structure, ownerID) {
  const recipients = collectStructureOwnerNotificationRecipients(ownerID);
  if (recipients.length <= 0) {
    return;
  }
  const senderID = normalizePositiveInt(
    structure && (structure.ownerCorpID || structure.ownerID),
    0,
  );
  const data = buildStructureItemsNeedAttentionNotificationData(structure);
  for (const characterID of recipients) {
    const result = createNotification(characterID, {
      typeID: NOTIFICATION_TYPE.STRUCTURE_ITEMS_NEED_ATTENTION,
      senderID,
      groupID: NOTIFICATION_GROUP.STRUCTURES,
      processed: false,
      data,
      emitLive: false,
    });
    if (!result || result.success !== true) {
      log.warn(
        `[StructureAssetSafety] Failed to create items-need-attention notification ` +
        `structure=${data.structureID} owner=${ownerID} ` +
        `character=${characterID}: ${result && result.errorMsg ? result.errorMsg : "UNKNOWN"}`,
      );
    }
  }
}

function ejectStructureAssetsToSpace(ownerID, structure, items, index, options = {}) {
  const numericOwnerID = normalizePositiveInt(ownerID, 0);
  const solarSystemID = normalizePositiveInt(structure && structure.solarSystemID, 0);
  const structureItems = Array.isArray(items) ? items : [];
  if (!numericOwnerID || !solarSystemID) {
    return {
      success: false,
      errorMsg: "STRUCTURE_NOT_FOUND",
    };
  }
  if (structureItems.length === 0) {
    return {
      success: true,
      data: {
        ejectedContainer: null,
        movedItemIDs: [],
      },
    };
  }

  const containerType = resolveItemByTypeID(OFFICE_EJECT_CONTAINER_TYPE_ID);
  if (!containerType) {
    return {
      success: false,
      errorMsg: "DROP_CONTAINER_TYPE_NOT_FOUND",
    };
  }

  const structureID = normalizePositiveInt(structure && structure.structureID, 0);
  const marker = buildStructureUnanchorAssetsMarker(
    structureID,
    numericOwnerID,
  );
  const existingContainerResult = findStructureUnanchorEjectContainer(
    structure,
    numericOwnerID,
    normalizeAllInventoryItems(),
    marker,
  );
  if (!existingContainerResult.success) {
    return existingContainerResult;
  }
  let container = existingContainerResult.data;
  if (!container) {
    const position = buildStructureScatterPosition(structure, index, options);
    const createContainerResult = createSpaceItemForOwner(
      numericOwnerID,
      solarSystemID,
      containerType,
      {
        itemName: buildStructureEjectContainerName(structure),
        position,
        direction: getStructureSpaceDirection(structure),
        targetPoint: position,
        createdAtMs: options.nowMs ?? Date.now(),
        launcherID: structureID,
        customInfo: marker,
      },
    );
    if (!createContainerResult.success || !createContainerResult.data) {
      return createContainerResult;
    }
    container = createContainerResult.data;
  }

  const movedItemIDs = [];
  for (const item of structureItems) {
    const itemID = normalizePositiveInt(item && item.itemID, 0);
    if (!itemID) {
      continue;
    }
    const moveResult = moveItemToLocation(itemID, container.itemID, ITEM_FLAGS.HANGAR);
    if (!moveResult.success) {
      log.warn(
        `[StructureAssetSafety] Failed to eject structure item ${itemID} into container ${container.itemID}: ${moveResult.errorMsg}`,
      );
      if (movedItemIDs.length > 0) {
        createStructureItemsNeedAttentionNotifications(
          structure,
          numericOwnerID,
        );
      }
      return {
        ...moveResult,
        data: {
          ejectedContainer: findItemById(container.itemID) || container,
          movedItemIDs,
        },
      };
    }
    movedItemIDs.push(itemID);
  }

  if (movedItemIDs.length > 0) {
    createStructureItemsNeedAttentionNotifications(structure, numericOwnerID);
  }

  return {
    success: true,
    data: {
      ejectedContainer: findItemById(container.itemID) || container,
      movedItemIDs,
    },
  };
}

function handOffStructureAttachedItemsForUnanchor(structure, options = {}) {
  const structureID = normalizePositiveInt(structure && structure.structureID, 0);
  const solarSystemID = normalizePositiveInt(structure && structure.solarSystemID, 0);
  const ownerID = normalizePositiveInt(
    structure && (structure.ownerCorpID || structure.ownerID),
    0,
  );
  if (!structureID || !solarSystemID || !ownerID) {
    return {
      success: false,
      errorMsg: "STRUCTURE_NOT_FOUND",
    };
  }

  const structureType = resolveItemByTypeID(structure.typeID);
  if (!structureType) {
    return {
      success: false,
      errorMsg: "STRUCTURE_HULL_TYPE_NOT_FOUND",
    };
  }
  if (
    normalizePositiveInt(structureType.categoryID, 0) !== CATEGORY_STRUCTURE
  ) {
    return {
      success: false,
      errorMsg: "STRUCTURE_HULL_TYPE_NOT_STRUCTURE",
    };
  }

  const topLevelItems = listContainerItems(null, structureID, null)
    .filter((item) => normalizePositiveInt(item && item.locationID, 0) === structureID);
  const rigItems = topLevelItems.filter(isStructureRigSlotItem);
  const attachedItems = topLevelItems.filter((item) =>
    !isStructureRigSlotItem(item) && isStructureAttachedItemForUnanchor(item),
  );
  const quantumCoreItemTypeID = normalizePositiveInt(
    structure && structure.quantumCoreItemTypeID,
    0,
  );
  const existingTopLevelCoreItem = attachedItems.find(
    (item) =>
      normalizePositiveInt(item && item.flagID, 0) === ITEM_FLAGS.STRUCTURE_DEED &&
      normalizeInt(item && item.singleton, 0) === 1 &&
      normalizePositiveInt(item && item.typeID, 0) ===
        quantumCoreItemTypeID,
  );
  const allItems = normalizeAllInventoryItems();
  const hullMarker = buildStructureUnanchorHullMarker(structureID);
  const fittingsMarker = buildStructureUnanchorFittingsMarker(structureID);
  const coreCompleteMarker = buildStructureUnanchorFittingsMarker(structureID, true);
  const markedHullArtifacts = allItems.filter(
    (item) => String(item && item.customInfo || "") === hullMarker,
  );
  const markedFittingsArtifacts = allItems.filter((item) =>
    [fittingsMarker, coreCompleteMarker].includes(
      String(item && item.customInfo || ""),
    ));
  const validMarkedFittingsArtifacts = markedFittingsArtifacts.filter(
    (item) =>
      normalizePositiveInt(item && item.typeID, 0) ===
        OFFICE_EJECT_CONTAINER_TYPE_ID &&
      normalizePositiveInt(item && item.launcherID, 0) === structureID &&
      normalizeInt(item && item.singleton, 0) === 1,
  );
  let unanchoredHull = findStructureUnanchorHull(
    structure,
    allItems,
    hullMarker,
  );
  if (
    markedHullArtifacts.length > 1 ||
    (
      markedHullArtifacts.length === 1 &&
      !unanchoredHull
    )
  ) {
    return {
      success: false,
      errorMsg: "INVALID_STRUCTURE_UNANCHOR_HULL_ARTIFACT",
    };
  }
  if (
    markedFittingsArtifacts.length > 1 ||
    markedFittingsArtifacts.length !== validMarkedFittingsArtifacts.length
  ) {
    return {
      success: false,
      errorMsg: "INVALID_STRUCTURE_UNANCHOR_FITTINGS_ARTIFACT",
    };
  }
  const existingFittingsContainers = findStructureUnanchorFittingsContainers(
    structure,
    ownerID,
    allItems,
    fittingsMarker,
    coreCompleteMarker,
  );
  if (existingFittingsContainers.length > 1) {
    return {
      success: false,
      errorMsg: "INVALID_STRUCTURE_UNANCHOR_FITTINGS_ARTIFACT",
    };
  }
  let decommissionContainer = existingFittingsContainers[0] || null;
  const fittingsContainerIDs = new Set(
    existingFittingsContainers.map((item) =>
      normalizePositiveInt(item && item.itemID, 0),
    ),
  );
  const existingContainedCoreItem = quantumCoreItemTypeID > 0
    ? allItems.find(
      (item) =>
        fittingsContainerIDs.has(normalizePositiveInt(item && item.locationID, 0)) &&
        normalizePositiveInt(item && item.flagID, 0) === ITEM_FLAGS.HANGAR &&
        normalizeInt(item && item.singleton, 0) === 1 &&
        normalizePositiveInt(item && item.typeID, 0) === quantumCoreItemTypeID,
    )
    : null;
  const coreCompletionRecorded = existingFittingsContainers.some(
    (item) => String(item && item.customInfo || "") === coreCompleteMarker,
  );
  const requiresQuantumCore =
    structure &&
    structure.hasQuantumCore === true &&
    quantumCoreItemTypeID > 0;
  const shouldCreateCore =
    requiresQuantumCore &&
    !existingTopLevelCoreItem &&
    !existingContainedCoreItem &&
    !coreCompletionRecorded;
  const needsFittingsContainer = attachedItems.length > 0 || shouldCreateCore;
  const trackedStructure = require(path.join(__dirname, "./structureState"))
    .getStructureByID(structureID, { refresh: false });
  if (
    trackedStructure &&
    unanchoredHull &&
    !isCanonicalStructureUnanchorSpaceArtifact(
      unanchoredHull,
      structure,
      ownerID,
    )
  ) {
    return {
      success: false,
      errorMsg: "INVALID_STRUCTURE_UNANCHOR_HULL_ARTIFACT",
    };
  }
  if (
    trackedStructure &&
    decommissionContainer &&
    !isCanonicalStructureUnanchorSpaceArtifact(
      decommissionContainer,
      structure,
      ownerID,
    )
  ) {
    return {
      success: false,
      errorMsg: "INVALID_STRUCTURE_UNANCHOR_FITTINGS_ARTIFACT",
    };
  }

  let containerType = null;
  if (!decommissionContainer && needsFittingsContainer) {
    containerType = resolveItemByTypeID(OFFICE_EJECT_CONTAINER_TYPE_ID);
    if (!containerType) {
      return {
        success: false,
        errorMsg: "DROP_CONTAINER_TYPE_NOT_FOUND",
      };
    }
  }

  let coreType = null;
  if (shouldCreateCore) {
    coreType = resolveItemByTypeID(quantumCoreItemTypeID);
    if (!coreType) {
      return {
        success: false,
        errorMsg: "QUANTUM_CORE_TYPE_NOT_FOUND",
      };
    }
  }

  if (
    decommissionContainer &&
    ![fittingsMarker, coreCompleteMarker].includes(
      String(decommissionContainer.customInfo || ""),
    )
  ) {
    const adoptLegacyContainerResult = updateInventoryItem(
      decommissionContainer.itemID,
      (current) => ({
        ...current,
        customInfo: fittingsMarker,
      }),
    );
    if (!adoptLegacyContainerResult.success) {
      return adoptLegacyContainerResult;
    }
    decommissionContainer = adoptLegacyContainerResult.data;
  }

  const hullWasCreated = !unanchoredHull;
  if (!unanchoredHull) {
    const position = structure.position || { x: 0, y: 0, z: 0 };
    const createHullResult = createSpaceItemForOwner(
      ownerID,
      solarSystemID,
      structureType,
      {
        itemName:
          structure.itemName ||
          structure.name ||
          structureType.name ||
          `Structure ${structureID}`,
        position,
        direction: getStructureSpaceDirection(structure),
        targetPoint: position,
        createdAtMs: options.nowMs ?? Date.now(),
        launcherID: structureID,
        customInfo: hullMarker,
      },
    );
    if (!createHullResult.success || !createHullResult.data) {
      return createHullResult;
    }
    unanchoredHull = createHullResult.data;
  }

  if (!decommissionContainer && needsFittingsContainer) {
    const position = buildStructureScatterPosition(structure, 0, options);
    const createContainerResult = createSpaceItemForOwner(
      ownerID,
      solarSystemID,
      containerType,
      {
        itemName: buildStructureDecommissionContainerName(structure),
        position,
        direction: getStructureSpaceDirection(structure),
        targetPoint: position,
        createdAtMs: options.nowMs ?? Date.now(),
        launcherID: structureID,
        customInfo: fittingsMarker,
      },
    );
    if (!createContainerResult.success || !createContainerResult.data) {
      return createContainerResult;
    }
    decommissionContainer = createContainerResult.data;
  }

  const movedItemIDs = [];
  for (const item of attachedItems) {
    const itemID = normalizePositiveInt(item && item.itemID, 0);
    if (!itemID) {
      continue;
    }
    const moveResult = moveItemToLocation(
      itemID,
      decommissionContainer.itemID,
      ITEM_FLAGS.HANGAR,
    );
    if (!moveResult.success) {
      return moveResult;
    }
    movedItemIDs.push(itemID);
  }

  let createdCoreItemID = null;
  if (shouldCreateCore) {
    const coreGrantResult = grantItemToOwnerLocation(
      ownerID,
      decommissionContainer.itemID,
      ITEM_FLAGS.HANGAR,
      coreType,
      1,
      {
        itemName: coreType.name,
        singleton: 1,
      },
    );
    if (!coreGrantResult.success) {
      return coreGrantResult;
    }
    const coreItem =
      coreGrantResult.data &&
      Array.isArray(coreGrantResult.data.items) &&
      coreGrantResult.data.items[0];
    createdCoreItemID = normalizePositiveInt(coreItem && coreItem.itemID, 0);
    if (createdCoreItemID) {
      movedItemIDs.push(createdCoreItemID);
    }
  }

  const completedCoreItemID =
    createdCoreItemID ||
    normalizePositiveInt(existingTopLevelCoreItem && existingTopLevelCoreItem.itemID, 0) ||
    normalizePositiveInt(existingContainedCoreItem && existingContainedCoreItem.itemID, 0) ||
    null;
  const quantumCoreHandoffComplete =
    requiresQuantumCore &&
    (Boolean(completedCoreItemID) || coreCompletionRecorded);
  if (
    decommissionContainer &&
    quantumCoreHandoffComplete &&
    String(decommissionContainer.customInfo || "") !== coreCompleteMarker
  ) {
    const markCoreCompleteResult = updateInventoryItem(
      decommissionContainer.itemID,
      (current) => ({
        ...current,
        customInfo: coreCompleteMarker,
      }),
    );
    if (!markCoreCompleteResult.success) {
      return markCoreCompleteResult;
    }
    decommissionContainer = markCoreCompleteResult.data;
  }

  return {
    success: true,
    data: {
      unanchoredHull: findItemById(unanchoredHull.itemID) || unanchoredHull,
      hull: {
        created: hullWasCreated,
        itemID: normalizePositiveInt(unanchoredHull && unanchoredHull.itemID, 0),
      },
      decommissionContainer: decommissionContainer
        ? findItemById(decommissionContainer.itemID) || decommissionContainer
        : null,
      movedItemIDs,
      destroyedRigItemIDs: [],
      pendingRigItemIDs: rigItems
        .map((item) => normalizePositiveInt(item && item.itemID, 0))
        .filter(Boolean),
      quantumCore: {
        movedExisting: Boolean(existingTopLevelCoreItem),
        created: Boolean(createdCoreItemID),
        itemID: completedCoreItemID,
      },
    },
  };
}

function ejectCorporationOfficeAssetsToSpace(corporationID, structure, office, items, options = {}) {
  const corpID = normalizePositiveInt(corporationID, 0);
  const solarSystemID = normalizePositiveInt(structure && structure.solarSystemID, 0);
  const officeItems = Array.isArray(items) ? items : [];
  if (!corpID || !solarSystemID) {
    return {
      success: false,
      errorMsg: "STRUCTURE_NOT_FOUND",
    };
  }
  if (officeItems.length === 0) {
    return {
      success: true,
      data: {
        createdWrap: null,
        ejectedContainer: null,
        movedItemIDs: [],
      },
    };
  }

  const containerType = resolveItemByTypeID(OFFICE_EJECT_CONTAINER_TYPE_ID);
  if (!containerType) {
    return {
      success: false,
      errorMsg: "DROP_CONTAINER_TYPE_NOT_FOUND",
    };
  }

  const structureID = normalizePositiveInt(structure && structure.structureID, 0);
  const officeID = normalizePositiveInt(
    office && (office.officeID || office.officeFolderID || office.itemID),
    0,
  );
  if (!officeID) {
    return {
      success: false,
      errorMsg: "CORPORATION_OFFICE_NOT_FOUND",
    };
  }
  const structureUnanchor = options.structureUnanchor === true;
  const marker = structureUnanchor
    ? buildStructureUnanchorOfficeMarker(structureID, officeID)
    : "";
  const existingContainerResult = structureUnanchor
    ? findStructureUnanchorEjectContainer(
      structure,
      corpID,
      normalizeAllInventoryItems(),
      marker,
    )
    : {
      success: true,
      data: null,
    };
  if (!existingContainerResult.success) {
    return existingContainerResult;
  }
  let container = existingContainerResult.data;
  if (!container) {
    const position = buildStructureScatterPosition(
      structure,
      normalizeInt(options.scatterIndex, 0),
      options,
    );
    const createContainerResult = createSpaceItemForOwner(
      corpID,
      solarSystemID,
      containerType,
      {
        itemName: buildOfficeEjectContainerName(structure),
        position,
        direction: getStructureSpaceDirection(structure),
        targetPoint: position,
        createdAtMs: options.nowMs ?? Date.now(),
        launcherID: structureID,
        customInfo: marker,
      },
    );
    if (!createContainerResult.success || !createContainerResult.data) {
      return createContainerResult;
    }
    container = createContainerResult.data;
  }

  const movedItemIDs = [];
  for (const item of officeItems) {
    const itemID = normalizePositiveInt(item && item.itemID, 0);
    if (!itemID) {
      continue;
    }
    const moveResult = moveItemToLocation(itemID, container.itemID, ITEM_FLAGS.HANGAR);
    if (!moveResult.success) {
      log.warn(
        `[StructureAssetSafety] Failed to eject office item ${itemID} into container ${container.itemID}: ${moveResult.errorMsg}`,
      );
      if (movedItemIDs.length > 0) {
        createStructureItemsNeedAttentionNotifications(structure, corpID);
      }
      return {
        ...moveResult,
        data: {
          createdWrap: null,
          ejectedContainer: findItemById(container.itemID) || container,
          movedItemIDs,
          officeID,
        },
      };
    }
    movedItemIDs.push(itemID);
  }

  if (movedItemIDs.length > 0) {
    createStructureItemsNeedAttentionNotifications(structure, corpID);
  }

  return {
    success: true,
    data: {
      createdWrap: null,
      ejectedContainer: findItemById(container.itemID) || container,
      movedItemIDs,
      officeID,
    },
  };
}

function createWrapFromItems(ownerKind, ownerID, structure, items = [], options = {}) {
  const topLevelItems = (Array.isArray(items) ? items : [])
    .map((item) => {
      const itemID = normalizePositiveInt(item && item.itemID, 0);
      return itemID > 0 ? (findItemById(itemID) || item) : null;
    })
    .filter(Boolean);

  if (topLevelItems.length === 0) {
    return {
      success: true,
      data: {
        createdWrap: null,
        movedItemIDs: [],
      },
    };
  }

  const structureName = String(
    structure && (structure.itemName || structure.name || `Structure ${structure.structureID}`),
  );
  const numericOwnerID = normalizePositiveInt(ownerID, 0);
  const normalizedOwnerKind =
    String(ownerKind || "char").trim().toLowerCase() === "corp"
      ? "corp"
      : "char";
  const structureID = normalizePositiveInt(
    structure && structure.structureID,
    0,
  );
  const wrapName = options.wrapName || `${structureName} Asset Safety`;
  const lifecycleKey = String(options.lifecycleKey || "").trim() || null;
  const existingWrap = lifecycleKey
    ? ensureWrapCache().wraps.find(
      (wrap) =>
        !wrap.deliveredAt &&
        normalizePositiveInt(wrap.ownerID, 0) === numericOwnerID &&
        String(wrap.ownerKind || "") === normalizedOwnerKind &&
        normalizePositiveInt(wrap.sourceStructureID, 0) === structureID &&
        String(wrap.lifecycleKey || "") === lifecycleKey,
    ) || null
    : null;
  const wrapCreateResult = existingWrap
    ? {
      success: true,
      data: existingWrap,
    }
    : createWrap({
      ownerID: numericOwnerID,
      ownerKind: normalizedOwnerKind,
      sourceStructureID: structureID,
      solarSystemID: normalizePositiveInt(structure && structure.solarSystemID, 0),
      wrapName,
      lifecycleKey,
      itemIDs: topLevelItems
        .map((item) => normalizePositiveInt(item && item.itemID, 0))
        .filter(Boolean)
        .sort((left, right) => left - right),
      createdAt: normalizeTimestampMs(options.nowMs, Date.now()) || Date.now(),
      ejectTimeMs: normalizeTimestampMs(options.nowMs, Date.now()) || Date.now(),
      nearestNPCStationInfo:
        normalizeStationInfo(options.nearestNPCStationInfo) ||
        getFallbackNpcStationInfo(structure && structure.solarSystemID),
      assetSafetyDisabled: Boolean(options.assetSafetyDisabled),
    });
  if (!wrapCreateResult.success) {
    return wrapCreateResult;
  }

  const wrapID = normalizePositiveInt(
    wrapCreateResult.data && wrapCreateResult.data.assetWrapID,
    0,
  );
  const recordedItemIDs = new Set(
    listContainerItems(numericOwnerID, wrapID, ASSET_SAFETY_FLAG_ID)
      .map((item) => normalizePositiveInt(item && item.itemID, 0))
      .filter(Boolean),
  );
  const movedItemIDs = [];
  for (const item of topLevelItems) {
    const moveResult = moveItemToLocation(
      item.itemID,
      wrapID,
      ASSET_SAFETY_FLAG_ID,
    );
    if (!moveResult.success) {
      log.warn(
        `[StructureAssetSafety] Failed to move item ${item.itemID} into wrap ${wrapID}: ${moveResult.errorMsg}`,
      );
      const refreshResult = updateWrap(wrapID, (current) => ({
        ...current,
        itemIDs: [...recordedItemIDs].sort((left, right) => left - right),
      }));
      if (!refreshResult.success) {
        return refreshResult;
      }
      if (movedItemIDs.length > 0) {
        createAssetSafetyMovedNotifications(structure, refreshResult.data);
      }
      return {
        ...moveResult,
        data: {
          createdWrap: refreshResult.data,
          movedItemIDs,
        },
      };
    }
    const itemID = normalizePositiveInt(item.itemID, 0);
    recordedItemIDs.add(itemID);
    movedItemIDs.push(itemID);
  }

  const refreshResult = updateWrap(wrapID, (current) => ({
    ...current,
    itemIDs: [...recordedItemIDs].sort((left, right) => left - right),
  }));
  if (!refreshResult.success) {
    if (movedItemIDs.length > 0) {
      createAssetSafetyMovedNotifications(
        structure,
        wrapCreateResult.data,
      );
    }
    return refreshResult;
  }
  if (movedItemIDs.length > 0) {
    createAssetSafetyMovedNotifications(structure, refreshResult.data);
  }
  return {
    success: true,
    data: {
      createdWrap: refreshResult.data,
      movedItemIDs,
    },
  };
}

function destroyStructureRigsAfterUnanchorHandoffs(rigItemIDs) {
  const destroyedRigItemIDs = [];
  for (const itemID of [...new Set(
    (Array.isArray(rigItemIDs) ? rigItemIDs : [])
      .map((value) => normalizePositiveInt(value, 0))
      .filter(Boolean),
  )]) {
    if (!findItemById(itemID)) {
      continue;
    }
    const removeResult = removeInventoryItem(itemID, {
      removeContents: true,
    });
    if (!removeResult.success) {
      return {
        ...removeResult,
        data: {
          destroyedRigItemIDs,
        },
      };
    }
    destroyedRigItemIDs.push(itemID);
  }
  return {
    success: true,
    data: {
      destroyedRigItemIDs,
    },
  };
}

function listItemsInsideWrap(wrap) {
  if (!wrap) {
    return [];
  }
  return listContainerItems(
    normalizePositiveInt(wrap.ownerID, 0),
    normalizePositiveInt(wrap.assetWrapID, 0),
    ASSET_SAFETY_FLAG_ID,
  );
}

function deliverWrapToDestination(assetWrapID, destinationID, options = {}) {
  // Automatic delivery already runs inside tickAssetSafetyWraps. Refreshing
  // here would re-enter the tick before the current wrap can be delivered.
  const wrap = getWrapByID(assetWrapID, { refresh: false });
  if (!wrap) {
    return {
      success: false,
      errorMsg: "WRAP_NOT_FOUND",
    };
  }
  if (wrap.deliveredAt) {
    return {
      success: false,
      errorMsg: "WRAP_ALREADY_DELIVERED",
    };
  }

  const session = options.session || null;
  if (options.skipAccessCheck !== true && !sessionCanManageWrap(session, wrap)) {
    return {
      success: false,
      errorMsg: "WRAP_ACCESS_DENIED",
    };
  }

  const nowMs = normalizeTimestampMs(options.nowMs, Date.now()) || Date.now();
  const structureState = require(path.join(__dirname, "./structureState"));
  const bypass = Boolean(
    options.ignoreTimer === true || structureState.hasStructureGmBypass(session),
  );
  if (!bypass && nowMs < getWrapUnlockTimeMs(wrap)) {
    return {
      success: false,
      errorMsg: "WRAP_NOT_READY",
    };
  }

  const numericDestinationID = normalizePositiveInt(destinationID, 0) ||
    normalizePositiveInt(
      wrap.nearestNPCStationInfo && wrap.nearestNPCStationInfo.itemID,
      0,
    );
  if (!numericDestinationID) {
    return {
      success: false,
      errorMsg: "DESTINATION_NOT_FOUND",
    };
  }

  let destinationKind = "station";
  const destinationStructure = worldData.getStructureByID(numericDestinationID);
  if (destinationStructure) {
    destinationKind = "structure";
    if (
      destinationStructure.destroyedAt ||
      destinationStructure.solarSystemID !== wrap.solarSystemID
    ) {
      return {
        success: false,
        errorMsg: "INVALID_DESTINATION_STRUCTURE",
      };
    }

    const accessResult = structureState.canCharacterDockAtStructure(
      session,
      destinationStructure,
      {
        ignoreRestrictions: structureState.hasStructureGmBypass(session),
      },
    );
    if (!accessResult.success) {
      return {
        success: false,
        errorMsg: accessResult.errorMsg || "DESTINATION_ACCESS_DENIED",
      };
    }
  } else {
    const destinationStation = worldData.getStationByID(numericDestinationID);
    if (!destinationStation) {
      return {
        success: false,
        errorMsg: "DESTINATION_NOT_FOUND",
      };
    }
    if (
      normalizePositiveInt(destinationStation.solarSystemID, 0) !== wrap.solarSystemID &&
      numericDestinationID !== normalizePositiveInt(
        wrap.nearestNPCStationInfo && wrap.nearestNPCStationInfo.itemID,
        0,
      )
    ) {
      return {
        success: false,
        errorMsg: "INVALID_DESTINATION_STATION",
      };
    }
  }

  const movedItemIDs = [];
  for (const item of listItemsInsideWrap(wrap)) {
    const moveResult = moveItemToLocation(item.itemID, numericDestinationID, ITEM_FLAGS.HANGAR);
    if (!moveResult.success) {
      return moveResult;
    }
    movedItemIDs.push(normalizePositiveInt(item.itemID, 0));
  }

  return updateWrap(wrap.assetWrapID, (current) => ({
    ...current,
    destinationID: numericDestinationID,
    destinationKind,
    deliveredAt: nowMs,
    autoMovedAt: options.autoMove === true ? nowMs : current.autoMovedAt,
    itemIDs: movedItemIDs.length > 0 ? movedItemIDs : current.itemIDs,
  }));
}

function tickAssetSafetyWraps(nowMs = Date.now()) {
  const normalizedNowMs = normalizeTimestampMs(nowMs, Date.now()) || Date.now();
  const wraps = ensureWrapCache().wraps;
  let changed = false;

  for (const wrap of wraps) {
    if (wrap.deliveredAt || !wrap.nearestNPCStationInfo) {
      continue;
    }
    if (normalizedNowMs < getWrapAutoMoveTimeMs(wrap)) {
      continue;
    }

    const deliverResult = deliverWrapToDestination(
      wrap.assetWrapID,
      wrap.nearestNPCStationInfo.itemID,
      {
        session: null,
        skipAccessCheck: true,
        ignoreTimer: true,
        autoMove: true,
        nowMs: normalizedNowMs,
      },
    );
    if (!deliverResult.success) {
      log.warn(
        `[StructureAssetSafety] Auto-move failed for wrap ${wrap.assetWrapID}: ${deliverResult.errorMsg}`,
      );
      continue;
    }
    changed = true;
  }

  if (changed) {
    wrapCache = null;
  }
  return listWraps({
    includeDelivered: true,
    nowMs: normalizedNowMs,
    refresh: false,
  });
}

function movePersonalAssetsToSafety(session, solarSystemID, structureID, options = {}) {
  const structureState = require(path.join(__dirname, "./structureState"));
  const charID = getSessionCharacterID(session);
  const structure = worldData.getStructureByID(structureID);
  if (!charID || !structure) {
    return {
      success: false,
      errorMsg: "STRUCTURE_NOT_FOUND",
    };
  }
  if (
    normalizePositiveInt(solarSystemID, structure.solarSystemID) !==
    normalizePositiveInt(structure.solarSystemID, 0)
  ) {
    return {
      success: false,
      errorMsg: "SOLAR_SYSTEM_MISMATCH",
    };
  }

  const assetSafetyDisabled =
    isAssetSafetyDisabledSolarSystem(structure.solarSystemID) &&
    !structureState.hasStructureGmBypass(session);
  if (assetSafetyDisabled) {
    return {
      success: false,
      errorMsg: "ASSET_SAFETY_DISABLED",
    };
  }

  const activeShipID = normalizePositiveInt(
    options.excludeActiveShipID ||
      (session && session.structureID === structure.structureID && (session.activeShipID || session.shipID || session.shipid)),
    0,
  );
  return createWrapFromItems(
    "char",
    charID,
    structure,
    listTopLevelStructureItems(charID, structure.structureID, {
      excludeItemIDs: activeShipID ? [activeShipID] : [],
    }),
    options,
  );
}

function moveCorporationAssetsToSafety(session, solarSystemID, structureID, options = {}) {
  const structureState = require(path.join(__dirname, "./structureState"));
  const corpID = getSessionCorporationID(session);
  const structure = worldData.getStructureByID(structureID);
  if (!corpID || !structure) {
    return {
      success: false,
      errorMsg: "STRUCTURE_NOT_FOUND",
    };
  }
  if (
    normalizePositiveInt(solarSystemID, structure.solarSystemID) !==
    normalizePositiveInt(structure.solarSystemID, 0)
  ) {
    return {
      success: false,
      errorMsg: "SOLAR_SYSTEM_MISMATCH",
    };
  }

  const assetSafetyDisabled =
    isAssetSafetyDisabledSolarSystem(structure.solarSystemID) &&
    !structureState.hasStructureGmBypass(session);
  if (assetSafetyDisabled) {
    return {
      success: false,
      errorMsg: "ASSET_SAFETY_DISABLED",
    };
  }

  return createWrapFromItems(
    "corp",
    corpID,
    structure,
    listTopLevelStructureItems(corpID, structure.structureID),
    options,
  );
}

function moveCorporationOfficeAssetsToSafety(corporationID, structure, office, options = {}) {
  const corpID = normalizePositiveInt(corporationID, 0);
  const structureID = normalizePositiveInt(structure && structure.structureID, 0);
  if (!corpID || !structureID || !office) {
    return {
      success: false,
      errorMsg: "STRUCTURE_NOT_FOUND",
    };
  }

  const officeItems = listTopLevelCorporationOfficeItems(corpID, office);
  if (officeItems.length === 0) {
    return {
      success: true,
      data: {
        createdWrap: null,
        movedItemIDs: [],
      },
    };
  }

  const structureState = require(path.join(__dirname, "./structureState"));
  const assetSafetyDisabled =
    isAssetSafetyDisabledSolarSystem(structure.solarSystemID) &&
    !structureState.hasStructureGmBypass(options.session);
  if (assetSafetyDisabled) {
    return ejectCorporationOfficeAssetsToSpace(
      corpID,
      structure,
      office,
      officeItems,
      options,
    );
  }

  const structureName = String(
    structure && (structure.itemName || structure.name || `Structure ${structureID}`),
  );
  const officeID = normalizePositiveInt(
    office && (office.officeID || office.officeFolderID || office.itemID),
    0,
  );
  return createWrapFromItems(
    "corp",
    corpID,
    structure,
    officeItems,
    {
      ...options,
      lifecycleKey:
        options.lifecycleKey ||
        (
          options.structureUnanchor === true && officeID
            ? buildStructureUnanchorOfficeMarker(structureID, officeID)
            : null
        ),
      wrapName: options.wrapName || `${structureName} Office Asset Safety`,
    },
  );
}

function removeCorporationOfficesAfterStructureUnanchor(
  structureID,
  offices,
) {
  const numericStructureID = normalizePositiveInt(structureID, 0);
  const officeKeys = new Set(
    (Array.isArray(offices) ? offices : [])
      .map((office) => {
        const corporationID = normalizePositiveInt(
          office && office.corporationID,
          0,
        );
        const officeID = normalizePositiveInt(
          office && (office.officeID || office.officeFolderID || office.itemID),
          0,
        );
        return corporationID && officeID
          ? `${corporationID}:${officeID}`
          : null;
      })
      .filter(Boolean),
  );
  if (!numericStructureID || officeKeys.size === 0) {
    return {
      success: true,
      data: {
        removedOfficeIDs: [],
      },
    };
  }

  const targetOffices = (Array.isArray(offices) ? offices : [])
    .map((office) => {
      const corporationID = normalizePositiveInt(
        office && office.corporationID,
        0,
      );
      const officeID = normalizePositiveInt(
        office && (office.officeID || office.officeFolderID || office.itemID),
        0,
      );
      return corporationID && officeID
        ? {
          corporationID,
          officeID,
          office,
        }
        : null;
    })
    .filter(Boolean);
  const cancelledBillIDs = [];
  try {
    const { cancelOfficeRentalBillsForOffice } = getOfficeRentalBilling();
    for (const target of targetOffices) {
      const cancelledBills = cancelOfficeRentalBillsForOffice(
        target.corporationID,
        numericStructureID,
      );
      if (
        cancelledBills.some(
          (bill) =>
            String(bill && bill.processingStatus || "") !==
            "cancelled",
        )
      ) {
        return {
          success: false,
          errorMsg: "CORPORATION_OFFICE_BILL_CANCEL_FAILED",
        };
      }
      for (const cancelledBill of cancelledBills) {
        const billID = normalizePositiveInt(
          cancelledBill && cancelledBill.billID,
          0,
        );
        if (billID) {
          cancelledBillIDs.push(billID);
        }
      }
    }
  } catch (error) {
    return {
      success: false,
      errorMsg:
        error && error.message ||
        "CORPORATION_OFFICE_BILL_CANCEL_FAILED",
    };
  }

  const removedOfficeIDs = [];
  const removedOfficeKeys = new Set();
  const updateResult = getCorporationRuntimeState().updateRuntimeState(
    (runtimeTable) => {
      const nextRuntimeTable = cloneValue(runtimeTable);
      for (const [corporationKey, corporationRuntime] of Object.entries(
        nextRuntimeTable.corporations || {},
      )) {
        const corporationID = normalizePositiveInt(corporationKey, 0);
        if (
          !corporationID ||
          !corporationRuntime ||
          !corporationRuntime.offices
        ) {
          continue;
        }
        for (const [officeKey, office] of Object.entries(
          corporationRuntime.offices,
        )) {
          const officeID = normalizePositiveInt(
            office && (
              office.officeID ||
              office.officeFolderID ||
              office.itemID
            ),
            normalizePositiveInt(officeKey, 0),
          );
          const officeIdentity = `${corporationID}:${officeID}`;
          if (
            normalizePositiveInt(office && office.stationID, 0) !==
              numericStructureID ||
            !officeKeys.has(officeIdentity)
          ) {
            continue;
          }
          delete corporationRuntime.offices[officeKey];
          removedOfficeIDs.push(officeID);
          removedOfficeKeys.add(officeIdentity);
        }
      }
      return nextRuntimeTable;
    },
  );
  if (!updateResult || updateResult.success !== true) {
    return {
      success: false,
      errorMsg:
        updateResult && updateResult.errorMsg ||
        "CORPORATION_OFFICE_REMOVE_FAILED",
    };
  }
  try {
    const {
      notifyOfficeBillRefresh,
      notifyOfficeRentalChange,
    } = getCorporationNotifications();
    const affectedCorporationIDs = new Set();
    for (const target of targetOffices) {
      if (
        removedOfficeKeys.has(
          `${target.corporationID}:${target.officeID}`,
        )
      ) {
        notifyOfficeRentalChange(target.corporationID, target.office);
        affectedCorporationIDs.add(target.corporationID);
      }
    }
    for (const corporationID of affectedCorporationIDs) {
      notifyOfficeBillRefresh(corporationID);
    }
  } catch (error) {
    log.warn(
      `[StructureAssetSafety] Failed to notify corporation office removal ` +
      `structure=${numericStructureID}: ${error && error.message || error}`,
    );
  }
  return {
    success: true,
    data: {
      cancelledBillIDs: [...new Set(cancelledBillIDs)]
        .sort((left, right) => left - right),
      removedOfficeIDs: [...new Set(removedOfficeIDs)]
        .sort((left, right) => left - right),
    },
  };
}

function handleStructureDestroyed(structure, options = {}) {
  if (!structure || normalizePositiveInt(structure.structureID, 0) <= 0) {
    return {
      success: false,
      errorMsg: "STRUCTURE_NOT_FOUND",
    };
  }

  const structureState = require(path.join(__dirname, "./structureState"));
  const bypass = structureState.hasStructureGmBypass(options.session);
  const assetSafetyDisabled = (
    isAssetSafetyDisabledSolarSystem(structure.solarSystemID) ||
    Number(structure.upkeepState || 0) === STRUCTURE_UPKEEP_STATE.ABANDONED
  ) && !bypass;
  if (assetSafetyDisabled) {
    log.warn(
      `[StructureAssetSafety] Asset safety is disabled for destroyed structure ${structure.structureID}; structure contents must be handled by the destruction-loot path instead.`,
    );
    return {
      success: false,
      errorMsg: "ASSET_SAFETY_DISABLED",
    };
  }

  const ownerIDs = new Set();
  for (const item of listContainerItems(null, structure.structureID, null)) {
    ownerIDs.add(normalizePositiveInt(item && item.ownerID, 0));
  }

  const createdWraps = [];
  for (const ownerID of ownerIDs) {
    if (!ownerID) {
      continue;
    }
    const ownerKind = getOwnerKindForAssetSafety(ownerID);
    const wrapResult = createWrapFromItems(
      ownerKind,
      ownerID,
      structure,
      listTopLevelStructureItems(ownerID, structure.structureID),
      {
        nowMs: options.nowMs,
      },
    );
    if (!wrapResult.success) {
      log.warn(
        `[StructureAssetSafety] Failed to create ${ownerKind} wrap for owner ${ownerID} on structure ${structure.structureID}: ${wrapResult.errorMsg}`,
      );
      return {
        success: false,
        errorMsg: "ASSET_SAFETY_DISABLED",
        data: {
          fallbackReason:
            wrapResult.errorMsg || "ASSET_SAFETY_HANDOFF_FAILED",
          partialWrap:
            wrapResult.data && wrapResult.data.createdWrap || null,
          movedItemIDs:
            wrapResult.data &&
            Array.isArray(wrapResult.data.movedItemIDs)
              ? wrapResult.data.movedItemIDs
              : [],
        },
      };
    }
    if (wrapResult.data && wrapResult.data.createdWrap) {
      createdWraps.push(wrapResult.data.createdWrap);
    }
  }

  return {
    success: true,
    data: {
      createdWraps,
    },
  };
}

function handleStructureUnanchored(structure, options = {}) {
  const structureID = normalizePositiveInt(
    structure && structure.structureID,
    0,
  );
  if (!structure || structureID <= 0) {
    return {
      success: false,
      errorMsg: "STRUCTURE_NOT_FOUND",
    };
  }

  const structureState = require(path.join(__dirname, "./structureState"));
  const bypass = structureState.hasStructureGmBypass(options.session);
  const assetSafetyDisabled =
    isAssetSafetyDisabledSolarSystem(structure.solarSystemID) && !bypass;
  const structureOffices = getCorporationRuntimeState()
    .getOfficesAtStation(structureID)
    .filter(
      (office) =>
        normalizePositiveInt(office && office.stationID, 0) === structureID,
    );

  const ownerIDs = new Set();
  for (const item of listContainerItems(null, structure.structureID, null)) {
    if (!isStructureHangarAssetItem(item)) {
      continue;
    }
    const ownerID = normalizePositiveInt(item && item.ownerID, 0);
    if (ownerID) {
      ownerIDs.add(ownerID);
    }
  }

  const createdWraps = [];
  const ejectedContainers = [];
  const movedItemIDs = [];
  const attachedHandoffResult = handOffStructureAttachedItemsForUnanchor(
    structure,
    options,
  );
  if (!attachedHandoffResult.success) {
    return attachedHandoffResult;
  }
  let ownerIndex =
    attachedHandoffResult.data && attachedHandoffResult.data.decommissionContainer ? 1 : 0;
  for (const ownerID of ownerIDs) {
    const ownerItems = listTopLevelStructureHangarItems(ownerID, structure.structureID);
    if (ownerItems.length === 0) {
      continue;
    }

    if (assetSafetyDisabled) {
      const ejectResult = ejectStructureAssetsToSpace(
        ownerID,
        structure,
        ownerItems,
        ownerIndex,
        options,
      );
      ownerIndex += 1;
      if (!ejectResult.success) {
        return ejectResult;
      }
      if (ejectResult.data && ejectResult.data.ejectedContainer) {
        ejectedContainers.push(ejectResult.data.ejectedContainer);
      }
      if (ejectResult.data && Array.isArray(ejectResult.data.movedItemIDs)) {
        movedItemIDs.push(...ejectResult.data.movedItemIDs);
      }
      continue;
    }

    const ownerKind = getOwnerKindForAssetSafety(ownerID);
    const wrapResult = createWrapFromItems(
      ownerKind,
      ownerID,
      structure,
      ownerItems,
      {
        lifecycleKey: buildStructureUnanchorAssetsMarker(
          structureID,
          ownerID,
        ),
        nowMs: options.nowMs,
      },
    );
    if (!wrapResult.success) {
      return wrapResult;
    }
    if (wrapResult.data && wrapResult.data.createdWrap) {
      createdWraps.push(wrapResult.data.createdWrap);
    }
    if (wrapResult.data && Array.isArray(wrapResult.data.movedItemIDs)) {
      movedItemIDs.push(...wrapResult.data.movedItemIDs);
    }
  }

  for (const office of structureOffices) {
    const corporationID = normalizePositiveInt(
      office && office.corporationID,
      0,
    );
    if (!corporationID) {
      return {
        success: false,
        errorMsg: "CORPORATION_OFFICE_NOT_FOUND",
      };
    }
    const officeResult = moveCorporationOfficeAssetsToSafety(
      corporationID,
      structure,
      office,
      {
        ...options,
        scatterIndex: ownerIndex,
        structureUnanchor: true,
      },
    );
    ownerIndex += 1;
    if (!officeResult.success) {
      return officeResult;
    }
    if (officeResult.data && officeResult.data.createdWrap) {
      createdWraps.push(officeResult.data.createdWrap);
    }
    if (officeResult.data && officeResult.data.ejectedContainer) {
      ejectedContainers.push(officeResult.data.ejectedContainer);
    }
    if (
      officeResult.data &&
      Array.isArray(officeResult.data.movedItemIDs)
    ) {
      movedItemIDs.push(...officeResult.data.movedItemIDs);
    }
  }

  const officeRemovalResult =
    removeCorporationOfficesAfterStructureUnanchor(
      structureID,
      structureOffices,
    );
  if (!officeRemovalResult.success) {
    return officeRemovalResult;
  }
  const rigDestructionResult = destroyStructureRigsAfterUnanchorHandoffs(
    attachedHandoffResult.data &&
      attachedHandoffResult.data.pendingRigItemIDs,
  );
  if (!rigDestructionResult.success) {
    return rigDestructionResult;
  }
  const attachedHandoff = {
    ...(attachedHandoffResult.data || {}),
    destroyedRigItemIDs:
      rigDestructionResult.data &&
      rigDestructionResult.data.destroyedRigItemIDs || [],
    pendingRigItemIDs: [],
  };

  return {
    success: true,
    data: {
      assetSafetyDisabled,
      createdWraps,
      ejectedContainers,
      movedItemIDs,
      removedOfficeIDs:
        officeRemovalResult.data &&
        officeRemovalResult.data.removedOfficeIDs || [],
      attachedHandoff,
    },
  };
}

function getDeliveryTargetsForSession(session, solarSystemID) {
  const structureState = require(path.join(__dirname, "./structureState"));
  const numericSystemID = normalizePositiveInt(solarSystemID, 0);
  const structures = structureState.listDockableStructuresForCharacter(session, {
    solarSystemID: numericSystemID,
  }).map((structure) => ({
    itemID: structure.structureID,
    typeID: structure.typeID,
    solarSystemID: structure.solarSystemID,
    itemName: structure.itemName || structure.name || `Structure ${structure.structureID}`,
  }));
  return {
    structures,
    nearestNPCStationInfo: getFallbackNpcStationInfo(numericSystemID),
  };
}

function shiftWrapEjectTimeGM(assetWrapID, daysDelta) {
  const normalizedDays = Number(daysDelta) || 0;
  return updateWrap(assetWrapID, (current) => ({
    ...current,
    ejectTimeMs: normalizeTimestampMs(current.ejectTimeMs, Date.now()) + Math.round(normalizedDays * DAY_MS),
  }));
}

function resetStructureAssetSafetyStateForTests() {
  wrapCache = null;
  stationCache = null;
}

module.exports = {
  STRUCTURE_ASSET_SAFETY_TABLE,
  ASSET_SAFETY_FLAG_ID,
  ASSET_SAFETY_WRAP_TYPE_ID,
  DAYS_UNTIL_CAN_DELIVER,
  DAYS_UNTIL_AUTO_MOVE,
  listWraps,
  getWrapByID,
  getWrapNames,
  listWrapsForOwner,
  movePersonalAssetsToSafety,
  moveCorporationAssetsToSafety,
  moveCorporationOfficeAssetsToSafety,
  getDeliveryTargetsForSession,
  deliverWrapToDestination,
  shiftWrapEjectTimeGM,
  tickAssetSafetyWraps,
  handleStructureDestroyed,
  handleStructureUnanchored,
  isAssetSafetyDisabledSolarSystem,
  resetStructureAssetSafetyStateForTests,
};
