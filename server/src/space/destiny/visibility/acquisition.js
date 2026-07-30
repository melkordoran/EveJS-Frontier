"use strict";

const {
  getEntityMapKey,
} = require("../identity/entityID");

const PENDING_ACQUISITIONS_KEY = "pendingNativeVisibilityAcquisitionsByID";
const PENDING_REMOVALS_KEY = "pendingNativeVisibilityRemovalsByID";

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function normalizeStampOverride(value) {
  return value === undefined || value === null
    ? null
    : (toInt(value, 0) >>> 0);
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function cloneOptions(value) {
  return value && typeof value === "object" ? { ...value } : {};
}

function normalizeAcquisitionKind(value) {
  const normalized = String(value || "dynamic").trim().toLowerCase();
  return normalized === "static" || normalized === "ego"
    ? normalized
    : "dynamic";
}

function getPendingVisibilityMap(session, stateKey, create = false) {
  const spaceState = session && session._space;
  if (!spaceState || typeof spaceState !== "object") {
    return null;
  }
  if (spaceState[stateKey] instanceof Map) {
    return spaceState[stateKey];
  }
  if (!create) {
    return null;
  }
  const pending = new Map();
  spaceState[stateKey] = pending;
  return pending;
}

function getPendingVisibilityAcquisitionMap(session, create = false) {
  return getPendingVisibilityMap(session, PENDING_ACQUISITIONS_KEY, create);
}

function getPendingVisibilityRemovalMap(session, create = false) {
  return getPendingVisibilityMap(session, PENDING_REMOVALS_KEY, create);
}

function getPendingVisibilityAcquisitionIDs(session, kind = null) {
  const pending = getPendingVisibilityAcquisitionMap(session, false);
  if (!(pending instanceof Map)) {
    return new Set();
  }
  const normalizedKind = kind === null
    ? null
    : normalizeAcquisitionKind(kind);
  const entityIDs = new Set();
  for (const [entityID, entry] of pending.entries()) {
    if (
      normalizedKind === null ||
      normalizeAcquisitionKind(entry && entry.kind) === normalizedKind
    ) {
      entityIDs.add(entityID);
    }
  }
  return entityIDs;
}

function getPendingVisibilityRemovalIDs(session, kind = null) {
  const pending = getPendingVisibilityRemovalMap(session, false);
  if (!(pending instanceof Map)) {
    return new Set();
  }
  const normalizedKind = kind === null
    ? null
    : normalizeAcquisitionKind(kind);
  const entityIDs = new Set();
  for (const [entityID, entry] of pending.entries()) {
    if (
      normalizedKind === null ||
      normalizeAcquisitionKind(entry && entry.kind) === normalizedKind
    ) {
      entityIDs.add(entityID);
    }
  }
  return entityIDs;
}

function isVisibilityAcquisitionCommitted(session, rawEntityID, kind = null) {
  const spaceState = session && session._space;
  const entityID = getEntityMapKey(rawEntityID);
  if (!spaceState || entityID === null) {
    return false;
  }

  const normalizedKind = kind === null
    ? null
    : normalizeAcquisitionKind(kind);
  const egoCommitted = getEntityMapKey(spaceState.presentedEgoEntityID) === entityID;
  const dynamicCommitted =
    spaceState.visibleDynamicEntityIDs instanceof Set &&
    spaceState.visibleDynamicEntityIDs.has(entityID);
  const staticCommitted =
    spaceState.visibleBubbleScopedStaticEntityIDs instanceof Set &&
    spaceState.visibleBubbleScopedStaticEntityIDs.has(entityID);

  if (normalizedKind === "ego") {
    return egoCommitted;
  }
  if (normalizedKind === "static") {
    return staticCommitted;
  }
  if (normalizedKind === "dynamic") {
    return dynamicCommitted;
  }
  return egoCommitted || dynamicCommitted || staticCommitted;
}

// A reservation is deliberately attached to the exact `_space` object which
// authored it. Same-scene ego swaps replace that object; an old delivery can
// therefore neither commit visibility into the new generation nor erase a
// newer generation's reservation for a reused entity ID.
function reserveVisibilityAcquisitions(session, entities, options = {}) {
  const generation = session && session._space;
  const inputEntities = Array.isArray(entities) ? entities : [];
  const pending = getPendingVisibilityAcquisitionMap(session, true);
  const resolveKind = typeof options.resolveKind === "function"
    ? options.resolveKind
    : () => "dynamic";
  const isCommitted = typeof options.isCommitted === "function"
    ? options.isCommitted
    : () => false;
  const reservedEntities = [];
  const reservedEntries = [];
  const seenEntityIDs = new Set();

  if (!generation || !(pending instanceof Map)) {
    return {
      entities: [],
      entries: [],
      entityIDs: new Set(),
      commit: () => false,
      rollback: () => false,
    };
  }

  for (const entity of inputEntities) {
    const entityID = getEntityMapKey(entity && entity.itemID);
    if (entityID === null || seenEntityIDs.has(entityID)) {
      continue;
    }
    seenEntityIDs.add(entityID);
    const kind = normalizeAcquisitionKind(resolveKind(entity, entityID));
    if (
      pending.has(entityID) ||
      isCommitted(entity, entityID, kind) === true
    ) {
      continue;
    }
    const token = Object.freeze({ kind });
    pending.set(entityID, token);
    reservedEntries.push({ entityID, token });
    reservedEntities.push(entity);
  }

  let finalized = false;
  const clearOwnedReservations = () => {
    if (finalized) {
      return false;
    }
    finalized = true;
    if (session._space !== generation) {
      return false;
    }
    const livePending = getPendingVisibilityAcquisitionMap(session, false);
    if (!(livePending instanceof Map)) {
      return false;
    }
    for (const { entityID, token } of reservedEntries) {
      if (livePending.get(entityID) === token) {
        livePending.delete(entityID);
      }
    }
    if (livePending.size === 0) {
      delete generation[PENDING_ACQUISITIONS_KEY];
    }
    return true;
  };

  return {
    entities: reservedEntities,
    entries: reservedEntries.map(({ entityID, token }) => ({
      entityID,
      kind: token.kind,
    })),
    entityIDs: new Set(reservedEntries.map((entry) => entry.entityID)),
    generation,
    commit: clearOwnedReservations,
    rollback: clearOwnedReservations,
  };
}

function reserveVisibilityRemovals(session, entityIDs, options = {}) {
  const generation = session && session._space;
  const pending = getPendingVisibilityRemovalMap(session, true);
  const resolveKind = typeof options.resolveKind === "function"
    ? options.resolveKind
    : () => "dynamic";
  const isCommitted = typeof options.isCommitted === "function"
    ? options.isCommitted
    : () => true;
  const reservedEntries = [];
  const seenEntityIDs = new Set();

  if (!generation || !(pending instanceof Map)) {
    return {
      entries: [],
      entityIDs: new Set(),
      commit: () => false,
      rollback: () => false,
    };
  }

  for (const rawEntityID of Array.isArray(entityIDs) ? entityIDs : []) {
    const entityID = getEntityMapKey(rawEntityID);
    if (
      entityID === null ||
      seenEntityIDs.has(entityID) ||
      pending.has(entityID) ||
      isCommitted(entityID) !== true
    ) {
      continue;
    }
    seenEntityIDs.add(entityID);
    const kind = normalizeAcquisitionKind(resolveKind(entityID));
    const token = Object.freeze({ kind });
    pending.set(entityID, token);
    reservedEntries.push({ entityID, token });
  }

  let finalized = false;
  const clearOwnedReservations = () => {
    if (finalized) {
      return false;
    }
    finalized = true;
    if (session._space !== generation) {
      return false;
    }
    const livePending = getPendingVisibilityRemovalMap(session, false);
    if (!(livePending instanceof Map)) {
      return false;
    }
    for (const { entityID, token } of reservedEntries) {
      if (livePending.get(entityID) === token) {
        livePending.delete(entityID);
      }
    }
    if (livePending.size === 0) {
      delete generation[PENDING_REMOVALS_KEY];
    }
    return true;
  };

  return {
    entries: reservedEntries.map(({ entityID, token }) => ({
      entityID,
      kind: token.kind,
    })),
    entityIDs: new Set(reservedEntries.map((entry) => entry.entityID)),
    generation,
    commit: clearOwnedReservations,
    rollback: clearOwnedReservations,
  };
}

function visibilityDeltaRequiresDelivery(presentation) {
  if (!presentation || typeof presentation !== "object") {
    return false;
  }
  return (
    normalizeArray(presentation.removedIDs).length > 0 ||
    normalizeArray(presentation.addedEntities).length > 0 ||
    normalizeArray(presentation.additionalUpdates).length > 0
  );
}

function withDeliveryHooks(sendOptions, options = {}) {
  const next = cloneOptions(sendOptions);
  for (const hookName of [
    "onDeliveryCommit",
    "onDeliveryRollback",
    "onDeliveryRetry",
  ]) {
    if (typeof options[hookName] === "function") {
      next[hookName] = options[hookName];
    }
  }
  return next;
}

// CCP Destiny treats bubble acquisition as one history problem: remove what
// left visibility, then add what entered visibility, on one ordered lane. This
// planner centralizes that contract for Elysian while runtime still supplies
// the scene-specific AddBalls2 and RemoveBalls builders during migration.
function buildVisibilityDeltaPresentation(options = {}) {
  const delta = options.delta && typeof options.delta === "object"
    ? options.delta
    : null;
  if (!delta) {
    return {
      addPresentation: null,
      addSendOptions: null,
      addedEntities: [],
      hasUpdates: false,
      additionalUpdates: [],
      removeUpdates: [],
      removedIDs: [],
      updates: [],
    };
  }

  const removedIDs = normalizeArray(delta.removedIDs);
  const addedEntities = normalizeArray(delta.addedEntities);
  const stampOverride = normalizeStampOverride(options.stampOverride);
  const removeUpdates =
    removedIDs.length > 0 && typeof options.buildRemoveBallsUpdates === "function"
      ? options.buildRemoveBallsUpdates(removedIDs, {
          nowMs: options.nowMs,
          packagedBubbleHistory: true,
          stampOverride,
        })
      : [];
  const addPresentation =
    addedEntities.length > 0 && typeof options.buildAddBallsUpdatesForSession === "function"
      ? options.buildAddBallsUpdatesForSession(
          options.session,
          addedEntities,
          {
            freshAcquire: true,
            nowMs: options.nowMs,
            stampOverride,
          },
        )
      : null;
  const addSendOptions = addPresentation && addPresentation.sendOptions
    ? cloneOptions(addPresentation.sendOptions)
    : null;

  if (
    addSendOptions &&
    stampOverride !== null &&
    options.preserveAuthoredStamp === true
  ) {
    // Post-warp landing visibility is already authored onto the landing stamp.
    // Letting generic fresh-acquire lead rules bump it a tick later creates the
    // exact split-wave landing jolt this rewrite is removing.
    delete addSendOptions.avoidCurrentHistoryInsertion;
  }

  const addUpdates = addPresentation && Array.isArray(addPresentation.updates)
    ? addPresentation.updates
    : [];
  const additionalUpdates = normalizeArray(options.additionalUpdates);
  const updates = [
    ...removeUpdates,
    ...addUpdates,
    ...additionalUpdates,
  ];

  return {
    addPresentation,
    addSendOptions,
    additionalUpdates,
    addedEntities,
    hasUpdates: updates.length > 0,
    removeUpdates,
    removedIDs,
    updates,
  };
}

// Runtime delivery still needs scene/session methods, but all branches should
// consume the same presentation so Add/Remove waves are not independently
// invented by every caller.
function deliverVisibilityDeltaPresentation(options = {}) {
  const presentation = options.presentation && typeof options.presentation === "object"
    ? options.presentation
    : null;
  if (!presentation || presentation.hasUpdates !== true) {
    return {
      delivered: false,
      mode: "none",
    };
  }

  // Delivery is also exercised by recovery and test callers which may hold a
  // presentation authored before optional lanes were added. Normalize every
  // lane at this boundary: an absent optional lane means "no updates", never
  // an exception after the visibility reservations have already been taken.
  const removeUpdates = normalizeArray(presentation.removeUpdates);
  const addUpdates = normalizeArray(
    presentation.addPresentation && presentation.addPresentation.updates,
  );
  const additionalUpdates = normalizeArray(presentation.additionalUpdates);
  const combinedUpdates = normalizeArray(presentation.updates);

  const removeSendOptions = withDeliveryHooks(options.removeSendOptions, options);
  const addSendOptions = withDeliveryHooks(presentation.addSendOptions ||
    (
      presentation.addPresentation && presentation.addPresentation.sendOptions
        ? presentation.addPresentation.sendOptions
        : null
    ), options);
  if (options.hasActiveTickDestinyPresentationBatch === true) {
    if (
      removeUpdates.length > 0 &&
      typeof options.queueTickDestinyPresentationUpdates === "function"
    ) {
      options.queueTickDestinyPresentationUpdates(
        options.session,
        removeUpdates,
        {
          sendOptions: removeSendOptions,
          refreshStampAtFlush: "currentVisibleIfStale",
        },
      );
    }
    if (
      addUpdates.length > 0 &&
      typeof options.queueTickDestinyPresentationUpdates === "function"
    ) {
      options.queueTickDestinyPresentationUpdates(
        options.session,
        addUpdates,
        {
          sendOptions: addSendOptions,
          refreshStampAtFlush: "currentVisibleIfStale",
        },
      );
    }
    if (
      additionalUpdates.length > 0 &&
      typeof options.queueTickDestinyPresentationUpdates === "function"
    ) {
      options.queueTickDestinyPresentationUpdates(
        options.session,
        additionalUpdates,
        {
          sendOptions: addSendOptions || removeSendOptions,
          refreshStampAtFlush: "currentVisibleIfStale",
        },
      );
    }
    return {
      delivered: true,
      mode: "queued",
    };
  }

  if (
    combinedUpdates.length > 0 &&
    typeof options.sendDestinyUpdates === "function"
  ) {
    const emittedStamp = options.sendDestinyUpdates(
      options.session,
      combinedUpdates,
      options.waitForBubble === true,
      addSendOptions,
    );
    return {
      delivered: emittedStamp !== null && emittedStamp !== undefined,
      mode: emittedStamp !== null && emittedStamp !== undefined
        ? "combined"
        : "delivery-failed",
      emittedStamp: emittedStamp ?? null,
    };
  }

  if (
    removeUpdates.length > 0 &&
    typeof options.sendDestinyUpdates === "function"
  ) {
    const emittedStamp = options.sendDestinyUpdates(
      options.session,
      removeUpdates,
      options.waitForBubble === true,
      removeSendOptions,
    );
    return {
      delivered: emittedStamp !== null && emittedStamp !== undefined,
      mode: emittedStamp !== null && emittedStamp !== undefined
        ? "remove-only"
        : "delivery-failed",
      emittedStamp: emittedStamp ?? null,
    };
  }

  return {
    delivered: false,
    mode: "none",
  };
}

module.exports = {
  buildVisibilityDeltaPresentation,
  deliverVisibilityDeltaPresentation,
  getPendingVisibilityAcquisitionIDs,
  getPendingVisibilityRemovalIDs,
  isVisibilityAcquisitionCommitted,
  normalizeStampOverride,
  reserveVisibilityAcquisitions,
  reserveVisibilityRemovals,
  visibilityDeltaRequiresDelivery,
};
