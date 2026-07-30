const path = require("path");

const log = require(path.join(__dirname, "../../utils/logger"));
const {
  extractDictEntries,
  extractList,
  normalizeNumber,
  normalizeText,
} = require(path.join(__dirname, "../_shared/serviceHelpers"));
const {
  ITEM_FLAGS,
  SHIP_CATEGORY_ID,
  findItemById,
  getActiveShipItem,
  listContainerItems,
  moveItemsAndSetShipPackagingState,
  setItemPackagingState,
  setShipPackagingState,
} = require(path.join(__dirname, "../inventory/itemStore"));
const {
  emitFittingTransactionForSession,
  syncInventoryItemForSession,
} = require(path.join(__dirname, "../character/characterState"));
const {
  isShipFittingFlag,
  isStrategicCruiserType,
} = require(path.join(__dirname, "../fitting/liveFittingState"));
const {
  refreshShipFittingSnapshot,
} = require(path.join(__dirname, "../../_secondary/fitting/fittingRuntime"));

function extractTupleValues(value) {
  if (Array.isArray(value)) {
    return value;
  }

  if (value && value.type === "tuple" && Array.isArray(value.items)) {
    return value.items;
  }

  if (value && value.type === "list" && Array.isArray(value.items)) {
    return value.items;
  }

  return [];
}

function extractRepackageRequests(rawValue) {
  const requests = [];
  for (const [stationKey, shipList] of extractDictEntries(rawValue)) {
    const stationID = normalizeNumber(stationKey, 0);
    for (const tupleValue of extractList(shipList)) {
      const tupleItems = extractTupleValues(tupleValue);
      const itemID = normalizeNumber(tupleItems[0], 0);
      const itemStationID = normalizeNumber(tupleItems[1], stationID);
      if (itemID > 0 && itemStationID > 0) {
        requests.push({
          itemID,
          stationID: itemStationID,
        });
      }
    }
  }

  return requests;
}

function repackageItemsForSession(session, requests, sourceLabel = "RepackagingSvc") {
  const stationID = normalizeNumber(
    session && (session.stationid || session.stationID),
    0,
  );
  const charID = normalizeNumber(session && session.characterID, 0);
  const activeShip = charID > 0 ? getActiveShipItem(charID) : null;

  log.info(
    `[${sourceLabel}] RepackageItems station=${stationID} requests=${JSON.stringify(requests)}`,
  );

  for (const request of requests) {
    if (request.stationID !== stationID || charID <= 0) {
      continue;
    }

    const item = findItemById(request.itemID);
    if (!item) {
      continue;
    }

    if (normalizeNumber(item.ownerID, 0) !== charID) {
      log.debug(
        `[${sourceLabel}] Refusing to repackage item ${item.itemID} not owned by character ${charID}`,
      );
      continue;
    }

    if (
      normalizeNumber(item.locationID, 0) !== stationID ||
      normalizeNumber(item.flagID, 0) !== ITEM_FLAGS.HANGAR
    ) {
      log.debug(
        `[${sourceLabel}] Refusing to repackage item ${item.itemID} outside station hangar`,
      );
      continue;
    }

    const isShip = normalizeNumber(item.categoryID, 0) === SHIP_CATEGORY_ID;
    const isStrategicCruiser = isShip && isStrategicCruiserType(item.typeID);
    let updateResult;

    if (isShip) {
      if (
        activeShip &&
        normalizeNumber(activeShip.itemID, 0) === normalizeNumber(item.itemID, 0)
      ) {
        log.debug(
          `[${sourceLabel}] Refusing to repackage active ship ${item.itemID}`,
        );
        continue;
      }

      const nestedItems = listContainerItems(null, item.itemID, null);
      let fittingMoveRequests = [];
      if (nestedItems.length > 0) {
        const canAutoStrip =
          isStrategicCruiser &&
          nestedItems.every((nestedItem) => (
            normalizeNumber(nestedItem && nestedItem.ownerID, 0) === charID &&
            isShipFittingFlag(nestedItem && nestedItem.flagID)
          ));
        if (!canAutoStrip) {
          log.debug(
            `[${sourceLabel}] Refusing to repackage item ${item.itemID} with ${nestedItems.length} contained items`,
          );
          continue;
        }
        fittingMoveRequests = nestedItems
          .sort(
            (left, right) =>
              normalizeNumber(left && left.itemID, 0) -
              normalizeNumber(right && right.itemID, 0),
          )
          .map((nestedItem) => ({
            itemID: nestedItem.itemID,
            destinationLocationID: stationID,
            destinationFlagID: ITEM_FLAGS.HANGAR,
          }));
      }

      const previousFittingSnapshot = isStrategicCruiser
        ? refreshShipFittingSnapshot(charID, item.itemID, {
            shipItem: item,
            reason: "strategic-cruiser-repackage.before",
          })
        : null;
      updateResult = isStrategicCruiser
        ? moveItemsAndSetShipPackagingState(
            item.itemID,
            fittingMoveRequests,
            true,
          )
        : setShipPackagingState(item.itemID, true);
      if (!updateResult.success) {
        log.warn(
          `[${sourceLabel}] Failed to ${isStrategicCruiser ? "atomically strip/" : ""}` +
          `repackage ship ${item.itemID}: ` +
          `${normalizeText(updateResult.errorMsg, "WRITE_ERROR")}`,
        );
        continue;
      }
      if (isStrategicCruiser) {
        emitFittingTransactionForSession(
          session,
          item.itemID,
          updateResult.changes,
          {
            shipItem: updateResult.data,
            previousSnapshot: previousFittingSnapshot,
          },
        );
      }
    } else {
      const nestedItems = listContainerItems(null, item.itemID, null);
      if (nestedItems.length > 0) {
        log.debug(
          `[${sourceLabel}] Refusing to repackage item ${item.itemID} with ${nestedItems.length} contained items`,
        );
        continue;
      }
      if (normalizeNumber(item.singleton, 0) !== 1) {
        log.debug(
          `[${sourceLabel}] Refusing to repackage item ${item.itemID}: already stackable`,
        );
        continue;
      }

      updateResult = setItemPackagingState(item.itemID, true);
      if (!updateResult.success) {
        log.warn(
          `[${sourceLabel}] Failed to repackage item ${item.itemID}: ${normalizeText(updateResult.errorMsg, "WRITE_ERROR")}`,
        );
        continue;
      }
    }

    if (!isShip || !isStrategicCruiser) {
      syncInventoryItemForSession(
        session,
        updateResult.data,
        {
          locationID: updateResult.previousData.locationID,
          flagID: updateResult.previousData.flagID,
          quantity: updateResult.previousData.quantity,
          singleton: updateResult.previousData.singleton,
          stacksize: updateResult.previousData.stacksize,
        },
        {
          emitCfgLocation: false,
        },
      );
    }
  }
}

module.exports = {
  extractRepackageRequests,
  repackageItemsForSession,
};
