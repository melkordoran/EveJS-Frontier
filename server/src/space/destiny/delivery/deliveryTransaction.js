"use strict";

const AUTHORITY_SPACE_KEYS = Object.freeze([
  "historyFloorDestinyStamp",
  "lastSentDestinyStamp",
  "lastSentDestinyRawDispatchStamp",
  "lastSentDestinyOnlyStaleProjectedOwnerMissileLane",
  "lastSentDestinyWasOwnerCritical",
  "lastOwnerNonMissileCriticalStamp",
  "lastOwnerNonMissileCriticalRawDispatchStamp",
  "lastPilotCommandMovementStamp",
  "lastPilotCommandMovementAnchorStamp",
  "lastPilotCommandMovementRawDispatchStamp",
  "lastPilotCommandDirection",
  "lastFreshAcquireLifecycleStamp",
  "lastMissileLifecycleStamp",
  "lastMissileLifecycleRawDispatchStamp",
  "lastOwnerMissileLifecycleStamp",
  "lastOwnerMissileLifecycleAnchorStamp",
  "lastOwnerMissileLifecycleRawDispatchStamp",
  "lastOwnerMissileFreshAcquireStamp",
  "lastOwnerMissileFreshAcquireAnchorStamp",
  "lastOwnerMissileFreshAcquireRawDispatchStamp",
  "destinyAuthorityState",
]);

let nextDeliveryTransactionID = 1;

function cloneValue(value, seen = new Map()) {
  if (value === null || value === undefined || typeof value !== "object") {
    return value;
  }
  if (seen.has(value)) {
    return seen.get(value);
  }
  if (value instanceof Set) {
    const cloned = new Set();
    seen.set(value, cloned);
    for (const entry of value) {
      cloned.add(cloneValue(entry, seen));
    }
    return cloned;
  }
  if (value instanceof Map) {
    const cloned = new Map();
    seen.set(value, cloned);
    for (const [key, entry] of value) {
      cloned.set(cloneValue(key, seen), cloneValue(entry, seen));
    }
    return cloned;
  }
  if (Array.isArray(value)) {
    const cloned = [];
    seen.set(value, cloned);
    for (const entry of value) {
      cloned.push(cloneValue(entry, seen));
    }
    return cloned;
  }
  const cloned = {};
  seen.set(value, cloned);
  for (const [key, entry] of Object.entries(value)) {
    cloned[key] = cloneValue(entry, seen);
  }
  return cloned;
}

function snapshotAuthorityDeliveryState(session) {
  const spaceState = session && session._space && typeof session._space === "object"
    ? session._space
    : null;
  const values = {};
  const presentKeys = new Set();
  if (!spaceState) {
    return { presentKeys, values };
  }
  for (const key of AUTHORITY_SPACE_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(spaceState, key)) {
      continue;
    }
    presentKeys.add(key);
    values[key] = cloneValue(spaceState[key]);
  }
  return { presentKeys, values };
}

function restoreAuthorityDeliveryState(session, snapshot) {
  const spaceState = session && session._space && typeof session._space === "object"
    ? session._space
    : null;
  return restoreAuthorityDeliveryStateForGeneration(spaceState, snapshot);
}

function restoreAuthorityDeliveryStateForGeneration(spaceState, snapshot) {
  if (!spaceState || !snapshot) {
    return false;
  }
  for (const key of AUTHORITY_SPACE_KEYS) {
    if (snapshot.presentKeys instanceof Set && snapshot.presentKeys.has(key)) {
      spaceState[key] = cloneValue(snapshot.values && snapshot.values[key]);
    } else {
      delete spaceState[key];
    }
  }
  return true;
}

function isDestinyDeliveryTransactionGenerationCurrent(transaction) {
  return Boolean(
    transaction &&
    transaction.session &&
    transaction.spaceGeneration &&
    transaction.session._space === transaction.spaceGeneration,
  );
}

function createDestinyDeliveryTransaction(session, options = {}) {
  const creationOrder = nextDeliveryTransactionID++;
  const transaction = {
    id: `destiny-delivery:${creationOrder}`,
    creationOrder,
    session,
    // Network sessions survive same-scene ego swaps and some scene
    // transitions, but their `_space` object does not. A delivery planned for
    // one native ballpark generation must never be staged, sent, or restored
    // into its replacement merely because the JavaScript session is the same.
    spaceGeneration:
      session && session._space && typeof session._space === "object"
        ? session._space
        : null,
    state: "planning",
    beforeState: snapshotAuthorityDeliveryState(session),
    stagedState: null,
    commitCallbacks: new Set(),
    rollbackCallbacks: new Set(),
    retryCallbacks: new Set(),
    retryCount: 0,
    deliveryCount: 0,
    failure: null,
    mergedTransactions: new Set(),
  };
  registerDestinyDeliveryHooks(transaction, options);
  return transaction;
}

function mergeDestinyDeliveryTransactions(target, source) {
  if (
    !target ||
    !source ||
    target === source ||
    source.state === "committed" ||
    source.state === "rolled-back"
  ) {
    return target || source || null;
  }
  if (target.session !== source.session) {
    throw new TypeError(
      "Destiny delivery transactions cannot merge across network sessions",
    );
  }
  if (target.spaceGeneration !== source.spaceGeneration) {
    throw new TypeError(
      "Destiny delivery transactions cannot merge across space generations",
    );
  }
  if (
    source.creationOrder < target.creationOrder &&
    target.state === "planning"
  ) {
    // Queue order is not transaction order. If a later-created visibility
    // group queues first, rollback still has to restore the earliest authority
    // snapshot owned by the combined packet.
    target.beforeState = source.beforeState;
    target.creationOrder = source.creationOrder;
  }
  for (const callback of source.commitCallbacks instanceof Set
    ? source.commitCallbacks
    : []) {
    target.commitCallbacks.add(callback);
  }
  for (const callback of source.rollbackCallbacks instanceof Set
    ? source.rollbackCallbacks
    : []) {
    target.rollbackCallbacks.add(callback);
  }
  for (const callback of source.retryCallbacks instanceof Set
    ? source.retryCallbacks
    : []) {
    target.retryCallbacks.add(callback);
  }
  target.mergedTransactions.add(source);
  for (const nested of source.mergedTransactions instanceof Set
    ? source.mergedTransactions
    : []) {
    target.mergedTransactions.add(nested);
  }
  source.state = "merged";
  source.mergedInto = target;
  return target;
}

function resolveAcceptedDeliveryCount(details = {}) {
  const rawCount = details.deliveredCount ?? details.deliveryCount ?? 0;
  const count = Number(rawCount);
  return Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0;
}

function finalizeMergedTransactions(transaction, state, details = {}) {
  const deliveryCount = resolveAcceptedDeliveryCount(details);
  for (const merged of transaction && transaction.mergedTransactions instanceof Set
    ? transaction.mergedTransactions
    : []) {
    merged.state = state;
    merged.deliveryCount = deliveryCount;
    merged.failure = state === "rolled-back"
      ? details.error || details.reason || "delivery-rejected"
      : null;
    merged.callbackErrors = [];
  }
}

function registerHook(target, callback) {
  if (target instanceof Set && typeof callback === "function") {
    target.add(callback);
  }
}

function registerDestinyDeliveryHooks(transaction, options = {}) {
  if (!transaction || !options || typeof options !== "object") {
    return transaction;
  }
  registerHook(transaction.commitCallbacks, options.onDeliveryCommit);
  registerHook(transaction.rollbackCallbacks, options.onDeliveryRollback);
  registerHook(transaction.retryCallbacks, options.onDeliveryRetry);
  return transaction;
}

function stageDestinyDeliveryTransaction(transaction) {
  if (!transaction || transaction.state !== "planning") {
    return transaction;
  }
  if (!isDestinyDeliveryTransactionGenerationCurrent(transaction)) {
    return rollbackDestinyDeliveryTransaction(transaction, {
      reason: "space-generation-replaced",
      skipCallbacks: true,
    });
  }
  transaction.stagedState = snapshotAuthorityDeliveryState(transaction.session);
  restoreAuthorityDeliveryStateForGeneration(
    transaction.spaceGeneration,
    transaction.beforeState,
  );
  transaction.state = "staged";
  return transaction;
}

function invokeCallbacks(callbacks, details) {
  const errors = [];
  for (const callback of callbacks instanceof Set ? callbacks : []) {
    try {
      callback(details);
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}

function commitDestinyDeliveryTransaction(transaction, details = {}) {
  if (!transaction || transaction.state === "committed") {
    return transaction;
  }
  if (transaction.state === "rolled-back") {
    return transaction;
  }
  if (transaction.state === "planning") {
    stageDestinyDeliveryTransaction(transaction);
  }
  if (
    transaction.state === "rolled-back" ||
    !isDestinyDeliveryTransactionGenerationCurrent(transaction)
  ) {
    return rollbackDestinyDeliveryTransaction(transaction, {
      reason: "space-generation-replaced",
      skipCallbacks: true,
    });
  }
  restoreAuthorityDeliveryStateForGeneration(
    transaction.spaceGeneration,
    transaction.stagedState || transaction.beforeState,
  );
  transaction.state = "committed";
  transaction.deliveryCount = resolveAcceptedDeliveryCount(details);
  transaction.callbackErrors = invokeCallbacks(transaction.commitCallbacks, {
    ...details,
    transaction,
  });
  finalizeMergedTransactions(transaction, "committed", details);
  if (transaction.callbackErrors.length > 0) {
    transaction.failure = transaction.callbackErrors[0];
    const socket = transaction.session && transaction.session.socket;
    if (
      socket &&
      socket.destroyed !== true &&
      typeof socket.destroy === "function"
    ) {
      // The packet is already accepted, so rollback cannot undo client state.
      // Reconnect is the only safe recovery if a local visibility commit hook
      // fails after delivery.
      socket.destroy(transaction.callbackErrors[0]);
    }
  }
  return transaction;
}

function retryDestinyDeliveryTransaction(transaction, details = {}) {
  if (!transaction || transaction.state === "committed" || transaction.state === "rolled-back") {
    return transaction;
  }
  if (!isDestinyDeliveryTransactionGenerationCurrent(transaction)) {
    return rollbackDestinyDeliveryTransaction(transaction, {
      ...details,
      reason: "space-generation-replaced",
      skipCallbacks: true,
    });
  }
  transaction.retryCount += 1;
  transaction.retryCallbackErrors = invokeCallbacks(transaction.retryCallbacks, {
    ...details,
    retryCount: transaction.retryCount,
    transaction,
  });
  for (const merged of transaction.mergedTransactions instanceof Set
    ? transaction.mergedTransactions
    : []) {
    merged.retryCount = transaction.retryCount;
  }
  return transaction;
}

function rollbackDestinyDeliveryTransaction(transaction, details = {}) {
  if (!transaction || transaction.state === "rolled-back") {
    return transaction;
  }
  if (transaction.state === "committed") {
    return transaction;
  }
  // Always restore the exact object whose authority was speculatively
  // mutated. If the session already points at a replacement generation, that
  // new ballpark is intentionally untouched.
  restoreAuthorityDeliveryStateForGeneration(
    transaction.spaceGeneration,
    transaction.beforeState,
  );
  transaction.state = "rolled-back";
  transaction.failure = details.error || details.reason || "delivery-rejected";
  const generationCurrent = isDestinyDeliveryTransactionGenerationCurrent(
    transaction,
  );
  const skipCallbacks = details.skipCallbacks === true || !generationCurrent;
  transaction.callbackErrors = skipCallbacks
    ? []
    : invokeCallbacks(transaction.rollbackCallbacks, {
        ...details,
        generationCurrent,
        transaction,
      });
  transaction.rollbackCallbacksSkipped = skipCallbacks;
  finalizeMergedTransactions(transaction, "rolled-back", details);
  return transaction;
}

module.exports = {
  AUTHORITY_SPACE_KEYS,
  commitDestinyDeliveryTransaction,
  createDestinyDeliveryTransaction,
  isDestinyDeliveryTransactionGenerationCurrent,
  mergeDestinyDeliveryTransactions,
  registerDestinyDeliveryHooks,
  restoreAuthorityDeliveryState,
  restoreAuthorityDeliveryStateForGeneration,
  retryDestinyDeliveryTransaction,
  rollbackDestinyDeliveryTransaction,
  snapshotAuthorityDeliveryState,
  stageDestinyDeliveryTransaction,
};
