/**
 * Frontier Creation fuel tank runtime.
 *
 * Client contract (staged build 3450341 bytecode evidence):
 *   dogmaIM.LoadFuel(shipID, fuelTypeID, quantity, fuelItems=None, locationID=None)
 * - `clientDogmaLocation.LoadFuelToModules` forwards the five arguments and
 *   discards the return value, so the RPC returns None.
 * - HUD/station "Fuel Tank" widgets call it with the last two arguments None;
 *   `fittingSlotController.FitFuel`/`tryFit.TryFitFuel` pass the dragged
 *   inventory rows grouped by (typeID, locationID) with quantity = summed
 *   stack sizes.
 * - The tank level is the ship Dogma attribute `fuelCharge` (5635) against
 *   `fuelCapacity` (5633); both widgets poll the godma ship item, so a plain
 *   attribute-change notification refreshes the numerator. Loading consumes
 *   the source stacks outright — the client ships no fuel-unload RPC.
 * - `frontier.fuel.static_data` treats a type as fuel when its group is in
 *   inventorycommon.const.fuelGroups = [4738 crude fuel, 4598 corvette fuel].
 * - The client offers fuel from ship cargo (flag 5), the specialized fuel bay
 *   (flag 133), and — while docked — the hangar of the current station.
 *
 * Server model: the loaded amount persists as
 * `shipItem.conditionState.fuelCharge`, an absolute unit count (units, not
 * m3: the widget prints "<n> / <capacity> units" and capacity derives from
 * Creation FuelCapacityAdd modifiers independent of cargo volume).
 */
const path = require("path");

const itemStore = require(path.join(__dirname, "../inventory/itemStore"));
const { resolveItemByTypeID } = require(path.join(
  __dirname,
  "../inventory/itemTypeRegistry",
));

const ATTRIBUTE_FUEL_EFFICIENCY = 5607;
const ATTRIBUTE_FUEL_CAPACITY = 5633;
const ATTRIBUTE_FUEL_RATE = 5634;
const ATTRIBUTE_FUEL_CHARGE = 5635;

// inventorycommon.const.fuelGroups in the staged client.
const FUEL_GROUP_CRUDE = 4738;
const FUEL_GROUP_CORVETTE = 4598;
const FUEL_GROUP_IDS = Object.freeze([FUEL_GROUP_CRUDE, FUEL_GROUP_CORVETTE]);

// Client-side FUEL_LOCATION_FLAGS plus the docked hangar fallback.
const FLAG_CARGO = 5;
const FLAG_HANGAR = 4;
const FLAG_SPECIALIZED_FUEL_BAY = 133;

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function toFiniteNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function resolveFuelGroupID(typeID, deps = {}) {
  const resolveType = typeof deps.resolveItemByTypeID === "function"
    ? deps.resolveItemByTypeID
    : resolveItemByTypeID;
  const record = resolveType(toInt(typeID, 0));
  return toInt(record && record.groupID, 0);
}

function isSupportedFuelType(typeID, deps = {}) {
  return FUEL_GROUP_IDS.includes(resolveFuelGroupID(typeID, deps));
}

function getShipFuelCharge(shipItem) {
  const conditionState =
    shipItem && shipItem.conditionState && typeof shipItem.conditionState === "object"
      ? shipItem.conditionState
      : null;
  return Math.max(0, toFiniteNumber(conditionState && conditionState.fuelCharge, 0));
}

function normalizeRequestedFuelItemIDs(fuelItems) {
  if (!Array.isArray(fuelItems)) {
    return [];
  }
  const itemIDs = [];
  for (const entry of fuelItems) {
    let itemID = 0;
    if (typeof entry === "number" || typeof entry === "bigint") {
      itemID = toInt(entry, 0);
    } else if (entry && typeof entry === "object") {
      itemID = toInt(entry.itemID ?? entry.itemId, 0);
    }
    if (itemID > 0 && !itemIDs.includes(itemID)) {
      itemIDs.push(itemID);
    }
  }
  return itemIDs;
}

function getStackQuantity(item) {
  if (!item) {
    return 0;
  }
  if (toInt(item.singleton, 0) === 1) {
    return 1;
  }
  return Math.max(0, toInt(item.stacksize ?? item.quantity, 0));
}

/**
 * Collect candidate source stacks for a load request, mirroring the
 * containers the client's fuel pickers read. Explicit `fuelItemIDs` (fitting
 * drag) win; otherwise fall back to ship cargo, then the specialized fuel
 * bay, then — while docked — the hangar. `sourceLocationID` narrows the
 * fallback scan to that container.
 */
function collectFuelSourceStacks({
  characterID,
  shipID,
  fuelTypeID,
  fuelItemIDs = [],
  sourceLocationID = null,
  dockedLocationID = null,
  deps = {},
}) {
  const findItemById = typeof deps.findItemById === "function"
    ? deps.findItemById
    : itemStore.findItemById;
  const listContainerItems = typeof deps.listContainerItems === "function"
    ? deps.listContainerItems
    : itemStore.listContainerItems;
  const ownerID = toInt(characterID, 0);
  const numericShipID = toInt(shipID, 0);
  const numericTypeID = toInt(fuelTypeID, 0);
  const numericSourceLocationID = toInt(sourceLocationID, 0);

  const matchesRequest = (item) =>
    item &&
    toInt(item.ownerID, 0) === ownerID &&
    toInt(item.typeID, 0) === numericTypeID &&
    getStackQuantity(item) > 0 &&
    (numericSourceLocationID <= 0 ||
      toInt(item.locationID, 0) === numericSourceLocationID);

  if (fuelItemIDs.length > 0) {
    return fuelItemIDs
      .map((itemID) => findItemById(itemID))
      .filter(matchesRequest);
  }

  const stacks = [];
  const seenItemIDs = new Set();
  const appendStacks = (locationID, flagID) => {
    if (toInt(locationID, 0) <= 0) {
      return;
    }
    for (const item of listContainerItems(ownerID, locationID, flagID)) {
      const itemID = toInt(item && item.itemID, 0);
      if (itemID <= 0 || seenItemIDs.has(itemID) || !matchesRequest(item)) {
        continue;
      }
      seenItemIDs.add(itemID);
      stacks.push(item);
    }
  };

  appendStacks(numericShipID, FLAG_CARGO);
  appendStacks(numericShipID, FLAG_SPECIALIZED_FUEL_BAY);
  appendStacks(dockedLocationID, FLAG_HANGAR);

  // Oldest stacks first so repeated loads drain deterministically.
  return stacks.sort(
    (left, right) => toInt(left.itemID, 0) - toInt(right.itemID, 0),
  );
}

/**
 * Validate and execute one LoadFuel request. Consumes source stacks and
 * raises `conditionState.fuelCharge` on the ship item. Returns
 * `{ success, data: { loadedQuantity, previousFuelCharge, nextFuelCharge,
 * changes } }` or `{ success: false, errorMsg, params }`.
 */
function loadFuelIntoShipTank({
  characterID,
  shipID,
  fuelTypeID,
  quantity,
  fuelItems = null,
  sourceLocationID = null,
  fuelCapacity = 0,
  dockedLocationID = null,
  deps = {},
}) {
  const findItemById = typeof deps.findItemById === "function"
    ? deps.findItemById
    : itemStore.findItemById;
  const consumeInventoryItemQuantity =
    typeof deps.consumeInventoryItemQuantity === "function"
      ? deps.consumeInventoryItemQuantity
      : itemStore.consumeInventoryItemQuantity;
  const grantItemsToCharacterLocation =
    typeof deps.grantItemsToCharacterLocation === "function"
      ? deps.grantItemsToCharacterLocation
      : itemStore.grantItemsToCharacterLocation;
  const updateShipItem = typeof deps.updateShipItem === "function"
    ? deps.updateShipItem
    : itemStore.updateShipItem;

  const ownerID = toInt(characterID, 0);
  const numericShipID = toInt(shipID, 0);
  const numericTypeID = toInt(fuelTypeID, 0);
  const requestedQuantity = toInt(quantity, 0);

  if (ownerID <= 0 || numericShipID <= 0) {
    return { success: false, errorMsg: "FUEL_SHIP_NOT_FOUND" };
  }
  const shipItem = findItemById(numericShipID);
  if (!shipItem || toInt(shipItem.ownerID, 0) !== ownerID) {
    return { success: false, errorMsg: "FUEL_SHIP_NOT_OWNED" };
  }
  if (requestedQuantity <= 0) {
    return { success: false, errorMsg: "FUEL_QUANTITY_INVALID" };
  }
  if (!isSupportedFuelType(numericTypeID, deps)) {
    return { success: false, errorMsg: "FUEL_TYPE_UNSUPPORTED" };
  }

  const tankCapacity = Math.max(0, toFiniteNumber(fuelCapacity, 0));
  if (tankCapacity <= 0) {
    return { success: false, errorMsg: "FUEL_TANK_MISSING" };
  }
  const previousFuelCharge = Math.min(getShipFuelCharge(shipItem), tankCapacity);
  const remainingCapacity = Math.floor(tankCapacity - previousFuelCharge);
  if (requestedQuantity > remainingCapacity) {
    return {
      success: false,
      errorMsg: "FUEL_TANK_OVERFLOW",
      params: { remainingCapacity, tankCapacity },
    };
  }

  const sourceStacks = collectFuelSourceStacks({
    characterID: ownerID,
    shipID: numericShipID,
    fuelTypeID: numericTypeID,
    fuelItemIDs: normalizeRequestedFuelItemIDs(fuelItems),
    sourceLocationID,
    dockedLocationID,
    deps,
  });
  const availableQuantity = sourceStacks.reduce(
    (total, item) => total + getStackQuantity(item),
    0,
  );
  if (availableQuantity < requestedQuantity) {
    return {
      success: false,
      errorMsg: "FUEL_SOURCE_INSUFFICIENT",
      params: { availableQuantity },
    };
  }

  let remaining = requestedQuantity;
  const changes = [];
  const consumed = [];
  for (const stack of sourceStacks) {
    if (remaining <= 0) {
      break;
    }
    const take = Math.min(remaining, getStackQuantity(stack));
    const result = consumeInventoryItemQuantity(stack.itemID, take);
    if (!result || result.success !== true) {
      // Restore already-drained stacks before failing so a mid-drain write
      // error cannot destroy fuel.
      for (const restore of consumed.reverse()) {
        grantItemsToCharacterLocation(ownerID, restore.locationID, restore.flagID, [
          { itemType: numericTypeID, quantity: restore.quantity },
        ]);
      }
      return {
        success: false,
        errorMsg: result && result.errorMsg
          ? result.errorMsg
          : "FUEL_CONSUME_FAILED",
      };
    }
    consumed.push({
      quantity: take,
      locationID: toInt(stack.locationID, 0),
      flagID: toInt(stack.flagID, 0),
    });
    changes.push(...((result.data && result.data.changes) || []));
    remaining -= take;
  }

  const nextFuelCharge = Math.min(
    previousFuelCharge + requestedQuantity,
    tankCapacity,
  );
  const updateResult = updateShipItem(numericShipID, (currentItem) => ({
    ...currentItem,
    conditionState: {
      ...(currentItem.conditionState || {}),
      fuelCharge: nextFuelCharge,
    },
  }));
  if (!updateResult || updateResult.success !== true) {
    for (const restore of consumed.reverse()) {
      grantItemsToCharacterLocation(ownerID, restore.locationID, restore.flagID, [
        { itemType: numericTypeID, quantity: restore.quantity },
      ]);
    }
    return {
      success: false,
      errorMsg: updateResult && updateResult.errorMsg
        ? updateResult.errorMsg
        : "FUEL_TANK_WRITE_FAILED",
    };
  }

  return {
    success: true,
    data: {
      loadedQuantity: requestedQuantity,
      previousFuelCharge,
      nextFuelCharge,
      shipItem: updateResult.data,
      changes,
    },
  };
}

module.exports = {
  ATTRIBUTE_FUEL_CAPACITY,
  ATTRIBUTE_FUEL_CHARGE,
  ATTRIBUTE_FUEL_EFFICIENCY,
  ATTRIBUTE_FUEL_RATE,
  FUEL_GROUP_IDS,
  collectFuelSourceStacks,
  getShipFuelCharge,
  isSupportedFuelType,
  loadFuelIntoShipTank,
  normalizeRequestedFuelItemIDs,
};
