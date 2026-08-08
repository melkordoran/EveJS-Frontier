"use strict";

/**
 * Network Node (assembly type 88092) fuel state and signed fuel transactions.
 *
 * Client contract (build 3450341 bytecode + exported protobuf evidence):
 * - The anchor UI reads GetFuelConfig (accepted fuel typeIDs + efficiency,
 *   displayed as 3600 / (fuelBurnRateInSeconds * efficiency / 100) units/h)
 *   and GetFuel (single ItemAttributes: current fuel typeID + quantity).
 * - Deposits send the source container Location plus the specific source
 *   stack itemIDs; withdrawals send a fuel typeID + destination Location.
 * - Both mutations are prepare/execute pairs: prepare returns a transaction
 *   uuid + serialized transaction payload which the Sui wallet signs; execute
 *   sends the uuid + signature. The signing convention matches the assembly
 *   online/offline transitions in deploymentRuntime.
 * - The input panel caps deposits at fuelMaxCapacity / GetVolume(typeID):
 *   the static `smartAnchor.fuelMaxCapacity` (1,000) is a VOLUME budget and
 *   per-type unit capacity derives from the fuel's volume (0.28 m3 -> 3,571
 *   units). The UI also refuses mixing fuel types, so the node stores a
 *   single fuel type at a time.
 *
 * EMULATOR POLICY (not client-derived): the accepted fuel list and efficiency
 * values are not observable locally (the retail values come from the world
 * API). We serve the three published group-4598 fuels with efficiency taken
 * from each type's authored `fuelEfficiency` dogma attribute (5607), which
 * matches the UI's percent-style formula. Adjust here if a client trace ever
 * proves different values.
 *
 * Fuel burning is intentionally NOT implemented: the static data proves the
 * 3,000s burn interval but not the per-cycle quantity semantics. The
 * persisted `updatedAtMs` anchor is stored so a future deterministic
 * catch-up burn can be added without a schema change.
 */

const crypto = require("crypto");
const path = require("path");

const itemStore = require(path.join(__dirname, "../inventory/itemStore"));
const { resolveItemByTypeID } = require(path.join(
  __dirname,
  "../inventory/itemTypeRegistry",
));
const {
  ASSEMBLY_STATUS_OFFLINE,
  ASSEMBLY_STATUS_ONLINE,
  buildAssemblyTransitionTransactionData,
  isValidAssemblyTransitionSignature,
  readConstructionState,
} = require(path.join(__dirname, "./deploymentRuntime"));
const { readStaticRows, TABLE } = require(path.join(
  __dirname,
  "../_shared/referenceData",
));

const NETWORK_NODE_TYPE_ID = 88092;
const FUEL_INFO_KEY = "evejsFrontierNetworkNodeFuel";
const FUEL_TRANSACTION_TTL_MS = 2 * 60 * 1000;
const DEFAULT_FUEL_MAX_CAPACITY_VOLUME = 1000;
const DEFAULT_FUEL_BURN_RATE_SECONDS = 3000;
const CAPACITY_VOLUME_EPSILON = 1e-6;

// Published group-4598 fuels with authored fuelEfficiency (attribute 5607).
const NETWORK_NODE_FUEL_CONFIG = Object.freeze([
  Object.freeze({ typeID: 77818, efficiency: 8 }), // Unstable Fuel
  Object.freeze({ typeID: 88319, efficiency: 15 }), // D2 Fuel
  Object.freeze({ typeID: 88335, efficiency: 10 }), // D1 Fuel
]);

const pendingFuelTransactions = new Map();

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function toFiniteNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function parseCustomInfo(customInfo) {
  const text = String(customInfo || "").trim();
  if (!text) {
    return {};
  }
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch (_) {
    return { legacyCustomInfo: text };
  }
}

function getSmartAnchorComponent() {
  const rows = readStaticRows(TABLE.SPACE_COMPONENTS_BY_TYPE);
  for (const row of Array.isArray(rows) ? rows : []) {
    if (toInt(row && (row._key ?? row.typeID), 0) === NETWORK_NODE_TYPE_ID) {
      return row.smartAnchor || null;
    }
  }
  return null;
}

let cachedAnchorAttributes = null;

function getNetworkNodeFuelAttributes() {
  if (!cachedAnchorAttributes) {
    const component = getSmartAnchorComponent();
    cachedAnchorAttributes = {
      fuelMaxCapacityVolume: Math.max(
        1,
        toFiniteNumber(
          component && component.fuelMaxCapacity,
          DEFAULT_FUEL_MAX_CAPACITY_VOLUME,
        ),
      ),
      fuelBurnRateInSeconds: Math.max(
        1,
        toFiniteNumber(
          component && component.fuelBurnRateInSeconds,
          DEFAULT_FUEL_BURN_RATE_SECONDS,
        ),
      ),
    };
  }
  return cachedAnchorAttributes;
}

function getNetworkNodeFuelConfig() {
  return NETWORK_NODE_FUEL_CONFIG.map((entry) => ({ ...entry }));
}

function isAcceptedNetworkNodeFuelType(typeID) {
  const numericTypeID = toInt(typeID, 0);
  return NETWORK_NODE_FUEL_CONFIG.some((entry) => entry.typeID === numericTypeID);
}

function resolveFuelTypeVolume(typeID) {
  const record = resolveItemByTypeID(toInt(typeID, 0));
  return toFiniteNumber(record && record.volume, 0);
}

function readNetworkNodeFuelState(item) {
  const info = parseCustomInfo(item && item.customInfo);
  const raw = info[FUEL_INFO_KEY];
  const state = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  return {
    typeID: toInt(state.typeID, 0),
    quantity: Math.max(0, toInt(state.quantity, 0)),
    updatedAtMs: toInt(state.updatedAtMs, 0),
  };
}

function writeNetworkNodeFuelState(itemID, state) {
  return itemStore.updateInventoryItem(itemID, (currentItem) => {
    const info = parseCustomInfo(currentItem.customInfo);
    if (toInt(state && state.quantity, 0) > 0) {
      info[FUEL_INFO_KEY] = {
        typeID: toInt(state.typeID, 0),
        quantity: Math.max(0, toInt(state.quantity, 0)),
        updatedAtMs: toInt(state.updatedAtMs, Date.now()),
      };
    } else {
      delete info[FUEL_INFO_KEY];
    }
    return {
      ...currentItem,
      customInfo: JSON.stringify(info),
    };
  });
}

function validateFuelNetworkNode(characterID, networkNodeID) {
  const ownerID = toInt(characterID, 0);
  const nodeID = toInt(networkNodeID, 0);
  if (ownerID <= 0) {
    return { errorMsg: "ACCESS_DENIED" };
  }
  if (nodeID <= 0) {
    return { errorMsg: "INVALID_ASSEMBLY_ID" };
  }
  const item = itemStore.findItemById(nodeID);
  if (!item || toInt(item.typeID, 0) !== NETWORK_NODE_TYPE_ID) {
    return { errorMsg: "ASSEMBLY_NOT_FOUND" };
  }
  if (toInt(item.ownerID, 0) !== ownerID) {
    return { errorMsg: "ASSEMBLY_NOT_OWNED" };
  }
  const constructionState = readConstructionState(item);
  if (
    constructionState.assemblyStatus !== ASSEMBLY_STATUS_OFFLINE &&
    constructionState.assemblyStatus !== ASSEMBLY_STATUS_ONLINE
  ) {
    return { errorMsg: "ASSEMBLY_UNDER_CONSTRUCTION" };
  }
  return { item };
}

function normalizeDepositItems(rawItems) {
  const normalized = [];
  for (const entry of Array.isArray(rawItems) ? rawItems : []) {
    const itemID = toInt(entry && (entry.itemID ?? entry.item_id), 0);
    const quantity = toInt(entry && entry.quantity, 0);
    if (itemID <= 0 || quantity <= 0) {
      return null;
    }
    const existing = normalized.find((candidate) => candidate.itemID === itemID);
    if (existing) {
      existing.quantity += quantity;
    } else {
      normalized.push({ itemID, quantity });
    }
  }
  return normalized.length > 0 ? normalized : null;
}

/**
 * Validate a deposit request without mutating. Returns the validated context
 * used both at prepare time and again at execute time.
 */
function validateFuelDeposit({
  characterID,
  networkNodeID,
  sourceItemID,
  sourceFlagID,
  items,
}) {
  const nodeResult = validateFuelNetworkNode(characterID, networkNodeID);
  if (nodeResult.errorMsg) {
    return nodeResult;
  }
  const normalizedItems = normalizeDepositItems(items);
  if (!normalizedItems) {
    return { errorMsg: "INVALID_QUANTITY" };
  }
  const sourceLocationID = toInt(sourceItemID, 0);
  const sourceFlag = toInt(sourceFlagID, -1);
  if (sourceLocationID <= 0) {
    return { errorMsg: "INVALID_SOURCE" };
  }

  const ownerID = toInt(characterID, 0);
  let fuelTypeID = 0;
  let totalQuantity = 0;
  const sourceStacks = [];
  for (const request of normalizedItems) {
    const stack = itemStore.findItemById(request.itemID);
    if (
      !stack ||
      toInt(stack.ownerID, 0) !== ownerID ||
      toInt(stack.locationID, 0) !== sourceLocationID ||
      (sourceFlag >= 0 && toInt(stack.flagID, -1) !== sourceFlag)
    ) {
      return { errorMsg: "SOURCE_ITEM_NOT_FOUND" };
    }
    const stackTypeID = toInt(stack.typeID, 0);
    if (fuelTypeID === 0) {
      fuelTypeID = stackTypeID;
    } else if (fuelTypeID !== stackTypeID) {
      return { errorMsg: "MIXED_FUEL_TYPES" };
    }
    const availableQuantity =
      toInt(stack.singleton, 0) === 1
        ? 1
        : Math.max(0, toInt(stack.stacksize ?? stack.quantity, 0));
    if (request.quantity > availableQuantity) {
      return { errorMsg: "INSUFFICIENT_SOURCE_FUEL" };
    }
    totalQuantity += request.quantity;
    sourceStacks.push({ ...request, typeID: stackTypeID });
  }

  if (!isAcceptedNetworkNodeFuelType(fuelTypeID)) {
    return { errorMsg: "UNSUPPORTED_FUEL_TYPE" };
  }

  const fuelState = readNetworkNodeFuelState(nodeResult.item);
  if (fuelState.quantity > 0 && fuelState.typeID !== fuelTypeID) {
    return { errorMsg: "MIXED_FUEL_TYPES" };
  }

  const unitVolume = resolveFuelTypeVolume(fuelTypeID);
  if (!(unitVolume > 0)) {
    return { errorMsg: "UNSUPPORTED_FUEL_TYPE" };
  }
  const capacityVolume = getNetworkNodeFuelAttributes().fuelMaxCapacityVolume;
  const nextVolume = (fuelState.quantity + totalQuantity) * unitVolume;
  if (nextVolume > capacityVolume + CAPACITY_VOLUME_EPSILON) {
    const remainingUnits = Math.max(
      0,
      Math.floor(
        (capacityVolume / unitVolume) - fuelState.quantity + CAPACITY_VOLUME_EPSILON,
      ),
    );
    return {
      errorMsg: "FUEL_CAPACITY_EXCEEDED",
      params: { remainingUnits },
    };
  }

  return {
    item: nodeResult.item,
    fuelTypeID,
    totalQuantity,
    sourceStacks,
    sourceLocationID,
    sourceFlag,
    fuelState,
  };
}

function validateFuelWithdraw({
  characterID,
  networkNodeID,
  fuelTypeID,
  quantity,
  destinationItemID,
  destinationFlagID,
}) {
  const nodeResult = validateFuelNetworkNode(characterID, networkNodeID);
  if (nodeResult.errorMsg) {
    return nodeResult;
  }
  const numericTypeID = toInt(fuelTypeID, 0);
  const numericQuantity = toInt(quantity, 0);
  if (numericQuantity <= 0) {
    return { errorMsg: "INVALID_QUANTITY" };
  }
  const fuelState = readNetworkNodeFuelState(nodeResult.item);
  if (fuelState.quantity <= 0 || fuelState.typeID !== numericTypeID) {
    return { errorMsg: "UNSUPPORTED_FUEL_TYPE" };
  }
  if (numericQuantity > fuelState.quantity) {
    return { errorMsg: "INSUFFICIENT_STORED_FUEL" };
  }
  const destinationID = toInt(destinationItemID, 0);
  const destination = destinationID > 0 ? itemStore.findItemById(destinationID) : null;
  if (!destination || toInt(destination.ownerID, 0) !== toInt(characterID, 0)) {
    return { errorMsg: "INVALID_DESTINATION" };
  }
  return {
    item: nodeResult.item,
    fuelTypeID: numericTypeID,
    quantity: numericQuantity,
    destinationID,
    destinationFlag: Math.max(0, toInt(destinationFlagID, 0)),
    fuelState,
  };
}

function prunePendingFuelTransactions(nowMs = Date.now()) {
  for (const [uuid, transaction] of pendingFuelTransactions) {
    if (!transaction || transaction.expiresAtMs <= nowMs) {
      pendingFuelTransactions.delete(uuid);
    }
  }
}

function createPendingFuelTransaction(action, characterID, networkNodeID, request) {
  prunePendingFuelTransactions();
  const transactionUUID = crypto.randomUUID().toLowerCase();
  const transactionData = buildAssemblyTransitionTransactionData({
    action,
    characterID,
    itemID: networkNodeID,
    transactionUUID,
  });
  const nowMs = Date.now();
  pendingFuelTransactions.set(transactionUUID, {
    action,
    characterID: toInt(characterID, 0),
    networkNodeID: toInt(networkNodeID, 0),
    createdAtMs: nowMs,
    expiresAtMs: nowMs + FUEL_TRANSACTION_TTL_MS,
    request,
    transactionData,
  });
  return { transactionUUID, transactionData };
}

function prepareNetworkNodeFuelDeposit(options) {
  const validation = validateFuelDeposit(options);
  if (validation.errorMsg) {
    return { success: false, errorMsg: validation.errorMsg, params: validation.params };
  }
  const prepared = createPendingFuelTransaction(
    "networknode-fuel-deposit",
    options.characterID,
    options.networkNodeID,
    {
      characterID: toInt(options.characterID, 0),
      networkNodeID: toInt(options.networkNodeID, 0),
      sourceItemID: toInt(options.sourceItemID, 0),
      sourceFlagID: toInt(options.sourceFlagID, -1),
      items: validation.sourceStacks.map((stack) => ({
        itemID: stack.itemID,
        quantity: stack.quantity,
      })),
    },
  );
  return { success: true, data: prepared };
}

function prepareNetworkNodeFuelWithdraw(options) {
  const validation = validateFuelWithdraw(options);
  if (validation.errorMsg) {
    return { success: false, errorMsg: validation.errorMsg, params: validation.params };
  }
  const prepared = createPendingFuelTransaction(
    "networknode-fuel-withdraw",
    options.characterID,
    options.networkNodeID,
    {
      characterID: toInt(options.characterID, 0),
      networkNodeID: toInt(options.networkNodeID, 0),
      fuelTypeID: validation.fuelTypeID,
      quantity: validation.quantity,
      destinationItemID: validation.destinationID,
      destinationFlagID: validation.destinationFlag,
    },
  );
  return { success: true, data: prepared };
}

function commitFuelDeposit(transaction) {
  const validation = validateFuelDeposit(transaction.request);
  if (validation.errorMsg) {
    return { success: false, errorMsg: validation.errorMsg, params: validation.params };
  }

  const changes = [];
  const consumed = [];
  for (const stack of validation.sourceStacks) {
    const result = itemStore.consumeInventoryItemQuantity(stack.itemID, stack.quantity);
    if (!result || result.success !== true) {
      for (const restore of consumed.reverse()) {
        itemStore.grantItemsToCharacterLocation(
          transaction.request.characterID,
          transaction.request.sourceItemID,
          Math.max(0, transaction.request.sourceFlagID),
          [{ itemType: validation.fuelTypeID, quantity: restore.quantity }],
        );
      }
      return {
        success: false,
        errorMsg: result && result.errorMsg ? result.errorMsg : "FUEL_CONSUME_FAILED",
      };
    }
    consumed.push(stack);
    changes.push(...((result.data && result.data.changes) || []));
  }

  const nextQuantity = validation.fuelState.quantity + validation.totalQuantity;
  const writeResult = writeNetworkNodeFuelState(transaction.request.networkNodeID, {
    typeID: validation.fuelTypeID,
    quantity: nextQuantity,
    updatedAtMs: Date.now(),
  });
  if (!writeResult || writeResult.success !== true) {
    for (const restore of consumed.reverse()) {
      itemStore.grantItemsToCharacterLocation(
        transaction.request.characterID,
        transaction.request.sourceItemID,
        Math.max(0, transaction.request.sourceFlagID),
        [{ itemType: validation.fuelTypeID, quantity: restore.quantity }],
      );
    }
    return {
      success: false,
      errorMsg: writeResult && writeResult.errorMsg
        ? writeResult.errorMsg
        : "FUEL_STATE_WRITE_FAILED",
    };
  }

  return {
    success: true,
    data: {
      networkNodeID: transaction.request.networkNodeID,
      fuelTypeID: validation.fuelTypeID,
      quantity: nextQuantity,
      depositedQuantity: validation.totalQuantity,
      solarSystemID: toInt(validation.item.locationID, 0),
      changes,
    },
  };
}

function commitFuelWithdraw(transaction) {
  const validation = validateFuelWithdraw(transaction.request);
  if (validation.errorMsg) {
    return { success: false, errorMsg: validation.errorMsg, params: validation.params };
  }

  const nextQuantity = validation.fuelState.quantity - validation.quantity;
  const writeResult = writeNetworkNodeFuelState(transaction.request.networkNodeID, {
    typeID: validation.fuelTypeID,
    quantity: nextQuantity,
    updatedAtMs: Date.now(),
  });
  if (!writeResult || writeResult.success !== true) {
    return {
      success: false,
      errorMsg: writeResult && writeResult.errorMsg
        ? writeResult.errorMsg
        : "FUEL_STATE_WRITE_FAILED",
    };
  }

  const grantResult = itemStore.grantItemsToCharacterLocation(
    transaction.request.characterID,
    validation.destinationID,
    validation.destinationFlag,
    [{ itemType: validation.fuelTypeID, quantity: validation.quantity }],
  );
  if (!grantResult || grantResult.success !== true) {
    writeNetworkNodeFuelState(transaction.request.networkNodeID, {
      typeID: validation.fuelTypeID,
      quantity: validation.fuelState.quantity,
      updatedAtMs: Date.now(),
    });
    return {
      success: false,
      errorMsg: grantResult && grantResult.errorMsg
        ? grantResult.errorMsg
        : "FUEL_WITHDRAW_GRANT_FAILED",
    };
  }

  const changes = (grantResult.data && grantResult.data.changes) || [];
  return {
    success: true,
    data: {
      networkNodeID: transaction.request.networkNodeID,
      fuelTypeID: validation.fuelTypeID,
      quantity: nextQuantity,
      withdrawnQuantity: validation.quantity,
      solarSystemID: toInt(validation.item.locationID, 0),
      changes,
    },
  };
}

/**
 * Execute a prepared fuel transaction exactly once. The pending entry is
 * consumed only when the commit succeeds, so a client retry after a
 * validation failure re-runs against unchanged state, while a duplicate
 * request after success cannot double-commit.
 */
function executeNetworkNodeFuelTransaction({
  action,
  characterID,
  transactionUUID,
  signature,
}) {
  prunePendingFuelTransactions();
  const normalizedUUID = String(transactionUUID || "").trim().toLowerCase();
  const transaction = normalizedUUID
    ? pendingFuelTransactions.get(normalizedUUID)
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

  const commit = transaction.action === "networknode-fuel-deposit"
    ? commitFuelDeposit(transaction)
    : commitFuelWithdraw(transaction);
  if (commit.success === true) {
    pendingFuelTransactions.delete(normalizedUUID);
  }
  return commit;
}

function getNetworkNodeFuelStatus(characterID, networkNodeID) {
  const nodeResult = validateFuelNetworkNode(characterID, networkNodeID);
  if (nodeResult.errorMsg) {
    return { success: false, errorMsg: nodeResult.errorMsg };
  }
  const fuelState = readNetworkNodeFuelState(nodeResult.item);
  return {
    success: true,
    data: {
      typeID: fuelState.typeID,
      quantity: fuelState.quantity,
      unitVolume: fuelState.typeID > 0 ? resolveFuelTypeVolume(fuelState.typeID) : 0,
      solarSystemID: toInt(nodeResult.item.locationID, 0),
    },
  };
}

module.exports = {
  FUEL_INFO_KEY,
  NETWORK_NODE_TYPE_ID,
  NETWORK_NODE_FUEL_CONFIG,
  executeNetworkNodeFuelTransaction,
  getNetworkNodeFuelAttributes,
  getNetworkNodeFuelConfig,
  getNetworkNodeFuelStatus,
  isAcceptedNetworkNodeFuelType,
  prepareNetworkNodeFuelDeposit,
  prepareNetworkNodeFuelWithdraw,
  readNetworkNodeFuelState,
  writeNetworkNodeFuelState,
  _testing: {
    clearPendingFuelTransactions() {
      pendingFuelTransactions.clear();
    },
    getPendingFuelTransactions() {
      return pendingFuelTransactions;
    },
    validateFuelDeposit,
    validateFuelWithdraw,
  },
};
