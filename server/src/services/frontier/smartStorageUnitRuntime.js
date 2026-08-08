"use strict";

/**
 * Persisted Smart Storage Unit inventory and signed prepare/execute workflow.
 *
 * Each character gets an isolated partition represented by normal inventory
 * rows (ownerID=character, locationID=assembly, flagID=66). This preserves
 * item custody and lets the existing game-store durability cover SSU contents
 * without a second side database.
 */

const crypto = require("crypto");
const path = require("path");

const itemStore = require(path.join(__dirname, "../inventory/itemStore"));
const {
  buildShipResourceState,
} = require(path.join(__dirname, "../fitting/liveFittingState"));
const creationRuntime = require(path.join(__dirname, "./creationRuntime"));
const {
  TABLE,
  readStaticRows,
} = require(path.join(__dirname, "../_shared/referenceData"));
const {
  ASSEMBLY_STATUS_OFFLINE,
  ASSEMBLY_STATUS_ONLINE,
  ASSEMBLY_STATUS_UNDER_CONSTRUCTION,
  buildAssemblyTransitionTransactionData,
  isValidAssemblyTransitionSignature,
  readConstructionState,
} = require(path.join(__dirname, "./deploymentRuntime"));

const SMART_STORAGE_FLAG = 66;
const CARGO_HOLD_FLAG = 5;
const STORAGE_TRANSACTION_TTL_MS = 2 * 60 * 1000;
const CAPACITY_EPSILON = 1e-6;
const UINT32_MAX = 0xffffffff;

const pendingTransactions = new Map();
const completedTransactions = new Map();
let storageComponentsByTypeID = null;

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) ? numeric : fallback;
}

function toFiniteNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function itemQuantity(item) {
  return toInt(item && item.singleton, 0) === 1
    ? 1
    : Math.max(0, toInt(item && (item.stacksize ?? item.quantity), 0));
}

function getStorageComponentsByTypeID() {
  if (storageComponentsByTypeID) {
    return storageComponentsByTypeID;
  }
  storageComponentsByTypeID = new Map();
  for (const row of readStaticRows(TABLE.SPACE_COMPONENTS_BY_TYPE)) {
    const typeID = toInt(row && (row._key ?? row.typeID), 0);
    const component = row && row.smartStorageUnit;
    if (typeID <= 0 || !component || typeof component !== "object") {
      continue;
    }
    storageComponentsByTypeID.set(typeID, {
      personalCapacity: Math.max(
        0,
        toFiniteNumber(component.personalCapacity, 0),
      ),
      storageCapacity: Math.max(
        0,
        toFiniteNumber(component.storageCapacity, 0),
      ),
    });
  }
  return storageComponentsByTypeID;
}

function getStorageComponent(typeID) {
  return getStorageComponentsByTypeID().get(toInt(typeID, 0)) || null;
}

function validateAccessScope(access, state) {
  if (
    !access ||
    typeof access !== "object" ||
    access.authorized !== true
  ) {
    return "ACCESS_DENIED";
  }
  const currentSystemID = toInt(access.solarSystemID, 0);
  if (currentSystemID <= 0) {
    return "ACCESS_DENIED";
  }
  if (
    currentSystemID > 0 &&
    toInt(state && state.solarSystemID, 0) !== currentSystemID
  ) {
    return "ASSEMBLY_NOT_IN_CURRENT_SYSTEM";
  }
  if (access.inRange !== true) {
    return "ASSEMBLY_OUT_OF_RANGE";
  }
  return null;
}

function validateStorageUnit(characterID, storageUnitID, options = {}) {
  const numericCharacterID = toInt(characterID, 0);
  const numericStorageUnitID = toInt(storageUnitID, 0);
  if (numericCharacterID <= 0) {
    return { errorMsg: "ACCESS_DENIED" };
  }
  if (numericStorageUnitID <= 0) {
    return { errorMsg: "INVALID_ASSEMBLY_ID" };
  }

  const item = itemStore.findItemById(numericStorageUnitID);
  const state = readConstructionState(item);
  const itemTypeID = toInt(item && item.typeID, 0);
  const stateTypeID = toInt(state && state.assemblyTypeID, 0);
  const component = getStorageComponent(itemTypeID);
  if (
    !item ||
    !state ||
    itemTypeID <= 0 ||
    stateTypeID !== itemTypeID ||
    !component
  ) {
    return { errorMsg: "ASSEMBLY_NOT_FOUND" };
  }
  if (state.assemblyStatus === ASSEMBLY_STATUS_UNDER_CONSTRUCTION) {
    return { errorMsg: "ASSEMBLY_UNDER_CONSTRUCTION" };
  }
  if (
    state.assemblyStatus !== ASSEMBLY_STATUS_OFFLINE &&
    state.assemblyStatus !== ASSEMBLY_STATUS_ONLINE
  ) {
    return { errorMsg: "ASSEMBLY_UNAVAILABLE" };
  }
  if (
    options.requireOnline === true &&
    state.assemblyStatus !== ASSEMBLY_STATUS_ONLINE
  ) {
    return { errorMsg: "ASSEMBLY_OFFLINE" };
  }

  const accessError = validateAccessScope(options.access, state);
  if (accessError) {
    return { errorMsg: accessError };
  }

  const isAssemblyOwner = toInt(item.ownerID, 0) === numericCharacterID;
  return {
    item,
    state,
    component,
    capacity: isAssemblyOwner
      ? component.storageCapacity
      : component.personalCapacity,
    isAssemblyOwner,
  };
}

function listStoredRows(characterID, storageUnitID) {
  return itemStore
    .listContainerItems(characterID, storageUnitID, SMART_STORAGE_FLAG)
    .filter((item) => item && toInt(item.typeID, 0) > 0)
    .sort((left, right) => toInt(left.itemID, 0) - toInt(right.itemID, 0));
}

function aggregateStoredRows(rows) {
  const byTypeID = new Map();
  for (const item of Array.isArray(rows) ? rows : []) {
    const typeID = toInt(item && item.typeID, 0);
    const quantity = itemQuantity(item);
    if (typeID <= 0 || quantity <= 0) {
      continue;
    }
    let entry = byTypeID.get(typeID);
    if (!entry) {
      entry = {
        itemID: toInt(item.itemID, 0),
        typeID,
        quantity: 0,
        unitVolume: Math.max(0, itemStore.getInventoryItemUnitVolume(item)),
      };
      byTypeID.set(typeID, entry);
    }
    entry.quantity += quantity;
  }
  return Array.from(byTypeID.values()).sort(
    (left, right) => left.typeID - right.typeID,
  );
}

function getUsedVolume(rows) {
  return (Array.isArray(rows) ? rows : []).reduce(
    (total, item) => total + (
      Math.max(0, itemStore.getInventoryItemUnitVolume(item)) * itemQuantity(item)
    ),
    0,
  );
}

function getShipCargoCapacity(characterID, shipItem) {
  const creationContext = creationRuntime.getCreationDogmaContext(
    shipItem,
    characterID,
  );
  const resolvedShipItem = creationContext && creationContext.success
    ? creationContext.data.item
    : shipItem;
  const additionalAttributeModifierEntries =
    creationContext &&
    creationContext.success &&
    Array.isArray(creationContext.data.shipAttributeModifierEntries)
      ? creationContext.data.shipAttributeModifierEntries
      : [];
  const resourceState = buildShipResourceState(characterID, resolvedShipItem, {
    additionalAttributeModifierEntries,
  });
  return Math.max(
    0,
    toFiniteNumber(resourceState && resourceState.cargoCapacity, 0),
  );
}

function getStorageInventory({ characterID, inventoryOwnerID, storageUnitID, access }) {
  const numericCharacterID = toInt(characterID, 0);
  if (
    numericCharacterID <= 0 ||
    toInt(inventoryOwnerID, 0) !== numericCharacterID
  ) {
    return { success: false, errorMsg: "ACCESS_DENIED" };
  }
  const validation = validateStorageUnit(numericCharacterID, storageUnitID, {
    access,
    requireOnline: false,
  });
  if (validation.errorMsg) {
    return { success: false, errorMsg: validation.errorMsg };
  }
  const rows = listStoredRows(numericCharacterID, storageUnitID);
  return {
    success: true,
    data: {
      capacity: validation.capacity,
      isAssemblyOwner: validation.isAssemblyOwner,
      items: aggregateStoredRows(rows),
      storageUnitID: toInt(storageUnitID, 0),
      usedVolume: getUsedVolume(rows),
    },
  };
}

function normalizeDepositStacks(rawStacks) {
  const byItemID = new Map();
  for (const raw of Array.isArray(rawStacks) ? rawStacks : []) {
    const itemID = toInt(raw && (raw.itemID ?? raw.item_id), 0);
    const quantity = toInt(raw && raw.quantity, 0);
    if (itemID <= 0 || quantity <= 0) {
      return null;
    }
    const nextQuantity = (byItemID.get(itemID) || 0) + quantity;
    if (!Number.isSafeInteger(nextQuantity) || nextQuantity <= 0) {
      return null;
    }
    byItemID.set(itemID, nextQuantity);
  }
  return Array.from(byItemID, ([itemID, quantity]) => ({ itemID, quantity }));
}

function normalizeWithdrawStacks(rawStacks) {
  const byTypeID = new Map();
  for (const raw of Array.isArray(rawStacks) ? rawStacks : []) {
    const typeID = toInt(raw && (raw.typeID ?? raw.type_id), 0);
    const quantity = toInt(raw && raw.quantity, 0);
    if (typeID <= 0 || quantity <= 0 || quantity > UINT32_MAX) {
      return null;
    }
    const nextQuantity = (byTypeID.get(typeID) || 0) + quantity;
    if (!Number.isSafeInteger(nextQuantity) || nextQuantity > UINT32_MAX) {
      return null;
    }
    byTypeID.set(typeID, nextQuantity);
  }
  return Array.from(byTypeID, ([typeID, quantity]) => ({ typeID, quantity }));
}

function validateGenericContainer(characterID, itemID, access, errorMsg) {
  const numericItemID = toInt(itemID, 0);
  const item = numericItemID > 0 ? itemStore.findItemById(numericItemID) : null;
  if (!item || toInt(item.ownerID, 0) !== toInt(characterID, 0)) {
    return { errorMsg };
  }
  const activeShipID = toInt(access && access.activeShipID, 0);
  if (activeShipID <= 0 || numericItemID !== activeShipID) {
    return { errorMsg };
  }
  return { item };
}

function validateDeposit(options) {
  const unit = validateStorageUnit(options.characterID, options.storageUnitID, {
    access: options.access,
    requireOnline: true,
  });
  if (unit.errorMsg) {
    return unit;
  }
  const stacks = normalizeDepositStacks(options.stacks);
  if (!stacks || stacks.length === 0) {
    return { errorMsg: "INVALID_QUANTITY" };
  }
  const sourceLocationID = toInt(options.sourceLocationID, 0);
  const sourceFlagID = toInt(options.sourceFlagID, -1);
  const source = validateGenericContainer(
    options.characterID,
    sourceLocationID,
    options.access,
    "INVALID_SOURCE",
  );
  if (source.errorMsg || sourceFlagID !== CARGO_HOLD_FLAG) {
    return { errorMsg: source.errorMsg || "INVALID_SOURCE" };
  }

  let depositVolume = 0;
  const validatedStacks = [];
  for (const requested of stacks) {
    const item = itemStore.findItemById(requested.itemID);
    if (
      !item ||
      toInt(item.ownerID, 0) !== toInt(options.characterID, 0) ||
      toInt(item.locationID, 0) !== sourceLocationID ||
      toInt(item.flagID, -1) !== sourceFlagID
    ) {
      return { errorMsg: "SOURCE_ITEM_NOT_FOUND" };
    }
    if (toInt(item.singleton, 0) !== 0) {
      return { errorMsg: "SINGLETON_NOT_ACCEPTED" };
    }
    if (requested.quantity > itemQuantity(item)) {
      return { errorMsg: "INSUFFICIENT_SOURCE_ITEMS" };
    }
    const unitVolume = Math.max(0, itemStore.getInventoryItemUnitVolume(item));
    depositVolume += unitVolume * requested.quantity;
    validatedStacks.push({
      ...requested,
      typeID: toInt(item.typeID, 0),
      unitVolume,
    });
  }

  const storedRows = listStoredRows(options.characterID, options.storageUnitID);
  const storedQuantityByTypeID = new Map(
    aggregateStoredRows(storedRows).map((entry) => [entry.typeID, entry.quantity]),
  );
  for (const stack of validatedStacks) {
    const nextQuantity =
      (storedQuantityByTypeID.get(stack.typeID) || 0) + stack.quantity;
    if (nextQuantity > UINT32_MAX) {
      return {
        errorMsg: "STORAGE_TYPE_QUANTITY_EXCEEDED",
        params: { typeID: stack.typeID },
      };
    }
    storedQuantityByTypeID.set(stack.typeID, nextQuantity);
  }
  const usedVolume = getUsedVolume(storedRows);
  if (usedVolume + depositVolume > unit.capacity + CAPACITY_EPSILON) {
    return {
      errorMsg: "STORAGE_CAPACITY_EXCEEDED",
      params: {
        capacity: unit.capacity,
        freeVolume: Math.max(0, unit.capacity - usedVolume),
      },
    };
  }

  return {
    unit,
    sourceLocationID,
    sourceFlagID,
    stacks: validatedStacks,
    depositVolume,
    usedVolume,
  };
}

function validateWithdraw(options) {
  const unit = validateStorageUnit(options.characterID, options.storageUnitID, {
    access: options.access,
    requireOnline: true,
  });
  if (unit.errorMsg) {
    return unit;
  }
  const stacks = normalizeWithdrawStacks(options.stacks);
  if (!stacks || stacks.length === 0) {
    return { errorMsg: "INVALID_QUANTITY" };
  }
  if (toInt(options.destinationStorageUnitID, 0) > 0) {
    return { errorMsg: "UNSUPPORTED_DESTINATION" };
  }
  const destinationLocationID = toInt(options.destinationLocationID, 0);
  const destinationFlagID = toInt(options.destinationFlagID, -1);
  const destination = validateGenericContainer(
    options.characterID,
    destinationLocationID,
    options.access,
    "INVALID_DESTINATION",
  );
  if (destination.errorMsg || destinationFlagID !== CARGO_HOLD_FLAG) {
    return { errorMsg: destination.errorMsg || "INVALID_DESTINATION" };
  }

  const storedRows = listStoredRows(options.characterID, options.storageUnitID);
  const rowsByTypeID = new Map();
  for (const item of storedRows) {
    const typeID = toInt(item.typeID, 0);
    if (!rowsByTypeID.has(typeID)) {
      rowsByTypeID.set(typeID, []);
    }
    rowsByTypeID.get(typeID).push(item);
  }

  const moves = [];
  for (const requested of stacks) {
    let remaining = requested.quantity;
    for (const item of rowsByTypeID.get(requested.typeID) || []) {
      if (remaining <= 0) {
        break;
      }
      const quantity = Math.min(remaining, itemQuantity(item));
      if (quantity > 0) {
        moves.push({
          itemID: toInt(item.itemID, 0),
          typeID: requested.typeID,
          quantity,
          unitVolume: Math.max(
            0,
            itemStore.getInventoryItemUnitVolume(item),
          ),
        });
        remaining -= quantity;
      }
    }
    if (remaining > 0) {
      return {
        errorMsg: "INSUFFICIENT_STORED_ITEMS",
        params: { typeID: requested.typeID },
      };
    }
  }

  const destinationCapacity = getShipCargoCapacity(
    options.characterID,
    destination.item,
  );
  const destinationUsedVolume = itemStore
    .listContainerItems(
      options.characterID,
      destinationLocationID,
      CARGO_HOLD_FLAG,
    )
    .reduce(
      (total, item) => total + (
        Math.max(0, itemStore.getInventoryItemUnitVolume(item)) * itemQuantity(item)
      ),
      0,
    );
  const withdrawalVolume = moves.reduce(
    (total, move) => total + (move.unitVolume * move.quantity),
    0,
  );
  if (
    destinationCapacity <= 0 ||
    destinationUsedVolume + withdrawalVolume >
      destinationCapacity + CAPACITY_EPSILON
  ) {
    return {
      errorMsg: "SHIP_CARGO_CAPACITY_EXCEEDED",
      params: {
        freeVolume: Math.max(0, destinationCapacity - destinationUsedVolume),
      },
    };
  }

  return {
    unit,
    destinationLocationID,
    destinationFlagID,
    stacks,
    moves,
  };
}

function pruneTransactions(nowMs = Date.now()) {
  for (const [uuid, transaction] of pendingTransactions) {
    if (!transaction || transaction.expiresAtMs <= nowMs) {
      pendingTransactions.delete(uuid);
    }
  }
  for (const [uuid, transaction] of completedTransactions) {
    if (!transaction || transaction.expiresAtMs <= nowMs) {
      completedTransactions.delete(uuid);
    }
  }
}

function createPendingTransaction(action, characterID, storageUnitID, request) {
  pruneTransactions();
  const transactionUUID = crypto.randomUUID().toLowerCase();
  const transactionData = buildAssemblyTransitionTransactionData({
    action,
    characterID,
    itemID: storageUnitID,
    transactionUUID,
  });
  const nowMs = Date.now();
  pendingTransactions.set(transactionUUID, {
    action,
    characterID: toInt(characterID, 0),
    storageUnitID: toInt(storageUnitID, 0),
    createdAtMs: nowMs,
    expiresAtMs: nowMs + STORAGE_TRANSACTION_TTL_MS,
    request: JSON.parse(JSON.stringify(request)),
    transactionData,
  });
  return { transactionUUID, transactionData };
}

function prepareStorageDeposit(options) {
  const validation = validateDeposit(options);
  if (validation.errorMsg) {
    return {
      success: false,
      errorMsg: validation.errorMsg,
      params: validation.params,
    };
  }
  const prepared = createPendingTransaction(
    "storageunit-deposit",
    options.characterID,
    options.storageUnitID,
    {
      characterID: toInt(options.characterID, 0),
      storageUnitID: toInt(options.storageUnitID, 0),
      sourceLocationID: validation.sourceLocationID,
      sourceFlagID: validation.sourceFlagID,
      stacks: validation.stacks.map(({ itemID, quantity }) => ({
        itemID,
        quantity,
      })),
    },
  );
  return { success: true, data: prepared };
}

function prepareStorageWithdraw(options) {
  const validation = validateWithdraw(options);
  if (validation.errorMsg) {
    return {
      success: false,
      errorMsg: validation.errorMsg,
      params: validation.params,
    };
  }
  const prepared = createPendingTransaction(
    "storageunit-withdraw",
    options.characterID,
    options.storageUnitID,
    {
      characterID: toInt(options.characterID, 0),
      storageUnitID: toInt(options.storageUnitID, 0),
      destinationLocationID: validation.destinationLocationID,
      destinationFlagID: validation.destinationFlagID,
      destinationStorageUnitID: 0,
      stacks: validation.stacks,
    },
  );
  return { success: true, data: prepared };
}

function aggregateNoticeItems(entries) {
  const byTypeID = new Map();
  for (const entry of entries) {
    let aggregate = byTypeID.get(entry.typeID);
    if (!aggregate) {
      aggregate = {
        itemID: entry.itemID,
        typeID: entry.typeID,
        quantity: 0,
        unitVolume: entry.unitVolume,
      };
      byTypeID.set(entry.typeID, aggregate);
    }
    aggregate.quantity += entry.quantity;
  }
  return Array.from(byTypeID.values()).sort(
    (left, right) => left.typeID - right.typeID,
  );
}

function commitDeposit(transaction, access) {
  const validation = validateDeposit({ ...transaction.request, access });
  if (validation.errorMsg) {
    return {
      success: false,
      errorMsg: validation.errorMsg,
      params: validation.params,
    };
  }
  const moved = itemStore.moveItemsToLocations(
    validation.stacks.map((stack) => ({
      itemID: stack.itemID,
      destinationLocationID: transaction.storageUnitID,
      destinationFlagID: SMART_STORAGE_FLAG,
      quantity: stack.quantity,
    })),
  );
  if (!moved || moved.success !== true) {
    return {
      success: false,
      errorMsg: moved && moved.errorMsg ? moved.errorMsg : "STORAGE_MOVE_FAILED",
    };
  }
  const noticeItems = aggregateNoticeItems(validation.stacks.map((stack, index) => ({
    itemID: toInt(moved.data.moves[index] && moved.data.moves[index].movedItemID, 0),
    typeID: stack.typeID,
    quantity: stack.quantity,
    unitVolume: stack.unitVolume,
  })));
  return {
    success: true,
    data: {
      action: transaction.action,
      changes: moved.data.changes,
      characterID: transaction.characterID,
      noticeItems,
      storageUnitID: transaction.storageUnitID,
    },
  };
}

function commitWithdraw(transaction, access) {
  const validation = validateWithdraw({ ...transaction.request, access });
  if (validation.errorMsg) {
    return {
      success: false,
      errorMsg: validation.errorMsg,
      params: validation.params,
    };
  }
  const moved = itemStore.moveItemsToLocations(
    validation.moves.map((move) => ({
      itemID: move.itemID,
      destinationLocationID: validation.destinationLocationID,
      destinationFlagID: validation.destinationFlagID,
      quantity: move.quantity,
    })),
  );
  if (!moved || moved.success !== true) {
    return {
      success: false,
      errorMsg: moved && moved.errorMsg ? moved.errorMsg : "STORAGE_MOVE_FAILED",
    };
  }
  const noticeItems = aggregateNoticeItems(validation.moves.map((move, index) => {
    const resultingItemID = toInt(
      moved.data.moves[index] && moved.data.moves[index].movedItemID,
      move.itemID,
    );
    const resultingItem = itemStore.findItemById(resultingItemID);
    return {
      itemID: resultingItemID,
      typeID: move.typeID,
      quantity: move.quantity,
      unitVolume: Math.max(
        0,
        itemStore.getInventoryItemUnitVolume(resultingItem),
      ),
    };
  }));
  return {
    success: true,
    data: {
      action: transaction.action,
      changes: moved.data.changes,
      characterID: transaction.characterID,
      noticeItems,
      storageUnitID: transaction.storageUnitID,
    },
  };
}

function executeStorageTransaction({
  action,
  characterID,
  transactionUUID,
  signature,
  access,
  resolveAccess,
}) {
  // Compatibility-only envelope check: the current local Frontier profile has
  // no trusted character-to-Sui-wallet binding or canonical BCS transaction
  // verifier. Session identity, proximity, ownership, UUID/TTL binding, and
  // execute-time state revalidation remain authoritative until that exists.
  pruneTransactions();
  const normalizedUUID = String(transactionUUID || "").trim().toLowerCase();
  const completed = normalizedUUID
    ? completedTransactions.get(normalizedUUID)
    : null;
  if (completed) {
    if (
      completed.action !== action ||
      completed.characterID !== toInt(characterID, 0)
    ) {
      return { success: false, errorMsg: "TRANSACTION_MISMATCH" };
    }
    if (!isValidAssemblyTransitionSignature(signature)) {
      return { success: false, errorMsg: "INVALID_SIGNATURE" };
    }
    return {
      success: true,
      data: { ...completed.data, replayed: true },
    };
  }

  const transaction = normalizedUUID
    ? pendingTransactions.get(normalizedUUID)
    : null;
  if (!transaction || transaction.expiresAtMs <= Date.now()) {
    return { success: false, errorMsg: "TRANSACTION_NOT_FOUND" };
  }
  if (
    transaction.action !== action ||
    transaction.characterID !== toInt(characterID, 0)
  ) {
    return { success: false, errorMsg: "TRANSACTION_MISMATCH" };
  }
  if (!isValidAssemblyTransitionSignature(signature)) {
    return { success: false, errorMsg: "INVALID_SIGNATURE" };
  }

  const executionAccess = typeof resolveAccess === "function"
    ? resolveAccess(transaction.storageUnitID)
    : access;

  const commit = transaction.action === "storageunit-deposit"
    ? commitDeposit(transaction, executionAccess)
    : commitWithdraw(transaction, executionAccess);
  if (commit.success === true) {
    const expiresAtMs = Date.now() + STORAGE_TRANSACTION_TTL_MS;
    pendingTransactions.delete(normalizedUUID);
    completedTransactions.set(normalizedUUID, {
      action: transaction.action,
      characterID: transaction.characterID,
      data: commit.data,
      expiresAtMs,
    });
  }
  return commit;
}

module.exports = {
  SMART_STORAGE_FLAG,
  executeStorageTransaction,
  getStorageInventory,
  prepareStorageDeposit,
  prepareStorageWithdraw,
  _testing: {
    aggregateStoredRows,
    clearStorageComponentCache() {
      storageComponentsByTypeID = null;
    },
    clearTransactions() {
      pendingTransactions.clear();
      completedTransactions.clear();
    },
    getCompletedTransactions() {
      return completedTransactions;
    },
    getPendingTransactions() {
      return pendingTransactions;
    },
    getShipCargoCapacity,
    validateDeposit,
    validateStorageUnit,
    validateWithdraw,
  },
};
