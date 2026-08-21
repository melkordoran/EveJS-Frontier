"use strict";

/**
 * Creation-native charge custody.
 *
 * Frontier Creation modules do not use the conventional ship-slot charge
 * representation. The retail client stores a loaded charge as a real
 * inventory row beneath the module item itself:
 *
 *   locationID = Creation module itemID
 *   flagID     = 184 (flagCreationModuleCharge)
 *
 * Reload/unload therefore cannot delegate to DogmaIM.LoadAmmo, whose charge
 * identity is keyed by (shipID, fittingFlagID, typeID).
 */

const path = require("path");

const log = require(path.join(__dirname, "../../utils/logger"));
const {
  currentFileTime,
} = require(path.join(__dirname, "../_shared/serviceHelpers"));
const {
  syncChargeGodmaPrimeForSession,
  syncInventoryItemForSession,
} = require(path.join(__dirname, "../character/characterState"));
const itemStore = require(path.join(__dirname, "../inventory/itemStore"));
const {
  buildEffectiveItemAttributeMap,
  buildShipResourceState,
  evaluateModuleChargeCompatibility,
  getAttributeIDByNames,
  getTypeAttributeValue,
} = require(path.join(__dirname, "../fitting/liveFittingState"));
const {
  CREATION_FITTING_FLAG_ID,
  getCreationDogmaContext,
} = require(path.join(__dirname, "./creationRuntime"));
const {
  buildCreationSnapshot,
} = require(path.join(__dirname, "./creationCompatibility"));

const CREATION_MODULE_CHARGE_FLAG_ID = 184;
const CHARGE_CATEGORY_ID = 8;
const DEPLOYABLE_CATEGORY_ID = 22;
const LOADABLE_CATEGORY_IDS = new Set([
  CHARGE_CATEGORY_ID,
  DEPLOYABLE_CATEGORY_ID,
]);
const FILETIME_TICKS_PER_MILLISECOND = 10000n;
const CAPACITY_EPSILON = 1.0e-6;
const ATTRIBUTE_RELOAD_TIME = getAttributeIDByNames("reloadTime") || 1795;

function toPositiveSafeInteger(value) {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : 0;
}

function itemQuantity(item) {
  const quantity = Number(item && (item.stacksize ?? item.quantity));
  return Number.isSafeInteger(quantity) && quantity > 0 ? quantity : 0;
}

function isLoadableCategory(item) {
  return LOADABLE_CATEGORY_IDS.has(Number(item && item.categoryID));
}

function getSessionCharacterID(session) {
  return toPositiveSafeInteger(
    session && (session.characterID || session.charID || session.charid),
  );
}

function getSessionActiveShipID(session) {
  return toPositiveSafeInteger(
    session && session._space && session._space.shipID,
  ) || toPositiveSafeInteger(
    session && (session.activeShipID || session.shipID || session.shipid),
  );
}

function getSessionFileTime(session) {
  return (
    session &&
    session._space &&
    typeof session._space.simFileTime === "bigint"
  ) ? session._space.simFileTime : currentFileTime();
}

function getReloadTimeMs(moduleItem) {
  const attributes = buildEffectiveItemAttributeMap(moduleItem || {});
  const effectiveReloadTime = Number(
    attributes && attributes[ATTRIBUTE_RELOAD_TIME],
  );
  const staticReloadTime = Number(
    getTypeAttributeValue(moduleItem && moduleItem.typeID, "reloadTime"),
  );
  const reloadTime = Number.isFinite(effectiveReloadTime)
    ? effectiveReloadTime
    : staticReloadTime;
  return Number.isFinite(reloadTime) && reloadTime > 0
    ? Math.max(0, Math.round(reloadTime))
    : 0;
}

function getReadyFileTime(session, moduleItem) {
  return getSessionFileTime(session) + (
    BigInt(getReloadTimeMs(moduleItem)) * FILETIME_TICKS_PER_MILLISECOND
  );
}

function getCreationModuleChargeState(characterID, moduleItemID) {
  const numericCharacterID = toPositiveSafeInteger(characterID);
  const numericModuleItemID = toPositiveSafeInteger(moduleItemID);
  if (numericCharacterID <= 0 || numericModuleItemID <= 0) {
    return { success: false, errorMsg: "CREATION_CHARGE_CONTEXT_INVALID" };
  }
  const rows = itemStore.listContainerItems(
    null,
    numericModuleItemID,
    CREATION_MODULE_CHARGE_FLAG_ID,
  );
  if (rows.length === 0) {
    return { success: true, data: { item: null, quantity: 0 } };
  }
  if (rows.length !== 1) {
    return { success: false, errorMsg: "CREATION_CHARGE_STATE_INVALID" };
  }
  const item = rows[0];
  const quantity = itemQuantity(item);
  if (
    toPositiveSafeInteger(item.ownerID) !== numericCharacterID ||
    toPositiveSafeInteger(item.locationID) !== numericModuleItemID ||
    Number(item.flagID) !== CREATION_MODULE_CHARGE_FLAG_ID ||
    !isLoadableCategory(item) ||
    Number(item.singleton) !== 0 ||
    quantity <= 0
  ) {
    return { success: false, errorMsg: "CREATION_CHARGE_STATE_INVALID" };
  }
  return { success: true, data: { item, quantity } };
}

function resolveCreationChargeContext(context) {
  const characterID = toPositiveSafeInteger(context && context.characterID);
  const creationID = toPositiveSafeInteger(
    context && context.creationItem && context.creationItem.itemID,
  );
  const moduleItemID = toPositiveSafeInteger(context && context.moduleItemID);
  const moduleTypeID = toPositiveSafeInteger(
    context && context.moduleEntry && context.moduleEntry.typeID,
  );
  const session = context && context.session;
  if (
    characterID <= 0 ||
    characterID !== getSessionCharacterID(session) ||
    creationID <= 0 ||
    creationID !== getSessionActiveShipID(session) ||
    moduleItemID <= 0 ||
    moduleTypeID <= 0
  ) {
    return { success: false, errorMsg: "CREATION_CHARGE_CONTEXT_INVALID" };
  }

  const creationItem = itemStore.findShipItemById(creationID);
  const moduleItem = itemStore.findItemById(moduleItemID);
  if (
    !creationItem ||
    toPositiveSafeInteger(creationItem.ownerID) !== characterID ||
    !moduleItem ||
    toPositiveSafeInteger(moduleItem.ownerID) !== characterID ||
    toPositiveSafeInteger(moduleItem.locationID) !== creationID ||
    Number(moduleItem.flagID) !== CREATION_FITTING_FLAG_ID ||
    Number(moduleItem.singleton) !== 1 ||
    toPositiveSafeInteger(moduleItem.typeID) !== moduleTypeID
  ) {
    return { success: false, errorMsg: "CREATION_MODULE_NOT_AVAILABLE" };
  }

  const loaded = getCreationModuleChargeState(characterID, moduleItemID);
  if (!loaded.success) {
    return loaded;
  }
  return {
    success: true,
    data: {
      characterID,
      creationID,
      creationItem,
      creationState: context.creationState,
      creationTemplate: context.creationTemplate,
      loadedItem: loaded.data.item,
      loadedQuantity: loaded.data.quantity,
      moduleItem,
      moduleItemID,
      moduleTypeID,
      session,
    },
  };
}

function getCreationCargoCapacity(characterID, creationItem) {
  const dogmaContext = getCreationDogmaContext(creationItem, characterID);
  if (!dogmaContext || dogmaContext.success !== true) {
    return 0;
  }
  const resourceState = buildShipResourceState(
    characterID,
    dogmaContext.data.item,
    {
      additionalAttributeModifierEntries:
        dogmaContext.data.shipAttributeModifierEntries || [],
    },
  );
  const capacity = Number(resourceState && resourceState.cargoCapacity);
  return Number.isFinite(capacity) && capacity > 0 ? capacity : 0;
}

function getCargoUsedVolume(characterID, creationID) {
  return itemStore.listContainerItems(
    characterID,
    creationID,
    itemStore.ITEM_FLAGS.CARGO_HOLD,
  ).reduce((total, item) => (
    total + (
      Math.max(0, itemStore.getInventoryItemUnitVolume(item)) *
      itemQuantity(item)
    )
  ), 0);
}

function validateCargoCapacityAfterExchange(
  resolved,
  outgoingCargoVolume,
  incomingCargoVolume,
) {
  const capacity = getCreationCargoCapacity(
    resolved.characterID,
    resolved.creationItem,
  );
  const used = getCargoUsedVolume(
    resolved.characterID,
    resolved.creationID,
  );
  const nextUsed = Math.max(0, used - outgoingCargoVolume + incomingCargoVolume);
  if (
    nextUsed > used + CAPACITY_EPSILON &&
    nextUsed > capacity + CAPACITY_EPSILON
  ) {
    return {
      success: false,
      errorMsg: "CREATION_CARGO_CAPACITY_EXCEEDED",
      params: { capacity, used, required: nextUsed },
    };
  }
  return { success: true, data: { capacity, nextUsed, used } };
}

function notifyInventoryChanges(session, changes, loadedItem = null) {
  for (const change of Array.isArray(changes) ? changes : []) {
    if (!change || !change.item) {
      continue;
    }
    try {
      syncInventoryItemForSession(
        session,
        change.item,
        change.previousData || {},
        { emitCfgLocation: false },
      );
    } catch (error) {
      log.warn(
        `[CreationCharge] Inventory notification failed item=${
          toPositiveSafeInteger(change.item.itemID)
        }: ${error && error.message ? error.message : error}`,
      );
    }
  }
  if (loadedItem) {
    try {
      syncChargeGodmaPrimeForSession(session, loadedItem.locationID, loadedItem, {
        description: "charge",
        includeInvItem: true,
      });
    } catch (error) {
      log.warn(
        `[CreationCharge] Dogma notification failed module=${
          toPositiveSafeInteger(loadedItem.locationID)
        }: ${error && error.message ? error.message : error}`,
      );
    }
  }
}

function notifyCreationChanged(resolved) {
  if (
    !resolved ||
    !resolved.session ||
    typeof resolved.session.sendNotification !== "function"
  ) {
    return;
  }
  try {
    const snapshot = buildCreationSnapshot(
      resolved.creationItem,
      resolved.characterID,
      resolved.creationState,
      resolved.creationTemplate,
      {
        getLoadedCharge(moduleItemID) {
          const loaded = getCreationModuleChargeState(
            resolved.characterID,
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
    resolved.session.sendNotification(
      "OnCreationChanged",
      "clientID",
      [resolved.creationID, snapshot],
    );
  } catch (error) {
    log.warn(
      `[CreationCharge] Creation snapshot notification failed ship=${
        toPositiveSafeInteger(resolved.creationID)
      }: ${error && error.message ? error.message : error}`,
    );
  }
}

function normalizeAmmoItemIDs(value) {
  const source = Array.isArray(value)
    ? value
    : value instanceof Set
      ? [...value]
      : [];
  const itemIDs = [];
  const seen = new Set();
  for (const valueItemID of source) {
    const itemID = toPositiveSafeInteger(valueItemID);
    if (itemID <= 0 || seen.has(itemID)) {
      return null;
    }
    seen.add(itemID);
    itemIDs.push(itemID);
  }
  return itemIDs.length > 0 ? itemIDs : null;
}

function resolveReloadSources(resolved, requestedTypeID, ammoItemIDs, neededQuantity) {
  const sourceItems = [];
  let availableQuantity = 0;
  for (const itemID of ammoItemIDs) {
    const item = itemStore.findItemById(itemID);
    const quantity = itemQuantity(item);
    if (
      !item ||
      toPositiveSafeInteger(item.ownerID) !== resolved.characterID ||
      toPositiveSafeInteger(item.locationID) !== resolved.creationID ||
      Number(item.flagID) !== itemStore.ITEM_FLAGS.CARGO_HOLD ||
      !isLoadableCategory(item) ||
      Number(item.singleton) !== 0 ||
      toPositiveSafeInteger(item.typeID) !== requestedTypeID ||
      quantity <= 0
    ) {
      return { success: false, errorMsg: "CREATION_CHARGE_SOURCE_INVALID" };
    }
    sourceItems.push({ item, quantity });
    availableQuantity += quantity;
  }
  if (availableQuantity < neededQuantity) {
    return { success: false, errorMsg: "CREATION_CHARGE_SOURCE_INSUFFICIENT" };
  }

  let remaining = neededQuantity;
  const moveRequests = [];
  for (const source of sourceItems) {
    if (remaining <= 0) {
      break;
    }
    const quantity = Math.min(remaining, source.quantity);
    moveRequests.push({ itemID: source.item.itemID, quantity });
    remaining -= quantity;
  }
  return { success: true, data: { moveRequests } };
}

function reloadCreationModule(context) {
  const common = resolveCreationChargeContext(context);
  if (!common.success) {
    return common;
  }
  const resolved = common.data;
  const kwargs = context && context.kwargs && typeof context.kwargs === "object"
    ? context.kwargs
    : {};
  const requestedTypeID = toPositiveSafeInteger(kwargs.type_id);
  const ammoLocationID = toPositiveSafeInteger(kwargs.ammo_location_id);
  const ammoItemIDs = normalizeAmmoItemIDs(kwargs.ammo_item_ids);
  if (
    requestedTypeID <= 0 ||
    ammoLocationID !== resolved.creationID ||
    !ammoItemIDs
  ) {
    return { success: false, errorMsg: "CREATION_RELOAD_REQUEST_INVALID" };
  }

  const compatibility = evaluateModuleChargeCompatibility(
    resolved.moduleTypeID,
    requestedTypeID,
  );
  const maximumQuantity = toPositiveSafeInteger(
    compatibility && compatibility.maximumQuantity,
  );
  if (!compatibility.accepted || maximumQuantity <= 0) {
    return { success: false, errorMsg: "CREATION_CHARGE_INCOMPATIBLE" };
  }

  const loadedTypeID = toPositiveSafeInteger(
    resolved.loadedItem && resolved.loadedItem.typeID,
  );
  if (
    resolved.loadedItem &&
    loadedTypeID === requestedTypeID &&
    resolved.loadedQuantity > maximumQuantity
  ) {
    return { success: false, errorMsg: "CREATION_CHARGE_STATE_INVALID" };
  }
  if (
    resolved.loadedItem &&
    loadedTypeID === requestedTypeID &&
    resolved.loadedQuantity === maximumQuantity
  ) {
    return {
      success: true,
      data: {
        qty: resolved.loadedQuantity,
        serverTime: getReadyFileTime(resolved.session, resolved.moduleItem),
        type_id: loadedTypeID,
      },
    };
  }

  const retainedQuantity = loadedTypeID === requestedTypeID
    ? resolved.loadedQuantity
    : 0;
  const neededQuantity = maximumQuantity - retainedQuantity;
  if (neededQuantity <= 0) {
    return { success: false, errorMsg: "CREATION_CHARGE_STATE_INVALID" };
  }
  const sources = resolveReloadSources(
    resolved,
    requestedTypeID,
    ammoItemIDs,
    neededQuantity,
  );
  if (!sources.success) {
    return sources;
  }

  const requestedCharge = itemStore.findItemById(
    sources.data.moveRequests[0].itemID,
  );
  const outgoingCargoVolume = Math.max(
    0,
    itemStore.getInventoryItemUnitVolume(requestedCharge),
  ) * neededQuantity;
  const incomingCargoVolume = resolved.loadedItem && loadedTypeID !== requestedTypeID
    ? Math.max(
        0,
        itemStore.getInventoryItemUnitVolume(resolved.loadedItem),
      ) * resolved.loadedQuantity
    : 0;
  const capacity = validateCargoCapacityAfterExchange(
    resolved,
    outgoingCargoVolume,
    incomingCargoVolume,
  );
  if (!capacity.success) {
    return capacity;
  }

  const mutation = itemStore.moveItemStacksToLocation(
    sources.data.moveRequests,
    resolved.moduleItemID,
    CREATION_MODULE_CHARGE_FLAG_ID,
    {
      destinationItemID:
        loadedTypeID === requestedTypeID && resolved.loadedItem
          ? resolved.loadedItem.itemID
          : 0,
      moveOptions: { affectsFitting: true },
      preMoves:
        resolved.loadedItem && loadedTypeID !== requestedTypeID
          ? [{
              destinationFlagID: itemStore.ITEM_FLAGS.CARGO_HOLD,
              destinationLocationID: resolved.creationID,
              itemID: resolved.loadedItem.itemID,
              quantity: resolved.loadedQuantity,
            }]
          : [],
    },
  );
  if (!mutation.success) {
    return mutation;
  }

  const loadedItem = mutation.data.destinationItem;
  notifyInventoryChanges(
    resolved.session,
    mutation.data.changes,
    loadedItem,
  );
  notifyCreationChanged(resolved);
  return {
    success: true,
    data: {
      qty: maximumQuantity,
      serverTime: getReadyFileTime(resolved.session, resolved.moduleItem),
      type_id: requestedTypeID,
    },
  };
}

function unloadCreationModule(context) {
  const common = resolveCreationChargeContext(context);
  if (!common.success) {
    return common;
  }
  const resolved = common.data;
  if (!resolved.loadedItem) {
    return {
      success: true,
      data: { serverTime: getSessionFileTime(resolved.session) },
    };
  }

  const incomingCargoVolume = Math.max(
    0,
    itemStore.getInventoryItemUnitVolume(resolved.loadedItem),
  ) * resolved.loadedQuantity;
  const capacity = validateCargoCapacityAfterExchange(
    resolved,
    0,
    incomingCargoVolume,
  );
  if (!capacity.success) {
    return capacity;
  }

  const mutation = itemStore.moveItemsToLocations([{
    destinationFlagID: itemStore.ITEM_FLAGS.CARGO_HOLD,
    destinationLocationID: resolved.creationID,
    itemID: resolved.loadedItem.itemID,
    options: { affectsFitting: true },
    quantity: resolved.loadedQuantity,
  }]);
  if (!mutation.success) {
    return mutation;
  }
  notifyInventoryChanges(resolved.session, mutation.data.changes);
  notifyCreationChanged(resolved);
  return {
    success: true,
    data: { serverTime: getSessionFileTime(resolved.session) },
  };
}

module.exports = {
  CHARGE_CATEGORY_ID,
  CREATION_MODULE_CHARGE_FLAG_ID,
  DEPLOYABLE_CATEGORY_ID,
  getCreationModuleChargeState,
  reloadCreationModule,
  unloadCreationModule,
  _testing: {
    getCreationCargoCapacity,
    getReadyFileTime,
    resolveCreationChargeContext,
    validateCargoCapacityAfterExchange,
  },
};
