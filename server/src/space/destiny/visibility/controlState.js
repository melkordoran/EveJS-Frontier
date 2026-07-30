"use strict";

const {
  entityIDsEqual,
  getEntityMapKey,
  normalizePersistentEntityID,
} = require("../identity/entityID");
const {
  DESTINY_STAMP_MAX_FORWARD_LEAD,
  hasDestinyStamp,
  isDestinyStampAfter,
  normalizeDestinyStamp,
  resolveOptionalDestinyStamp,
  selectFurthestDestinyStamp,
} = require("../delivery/stamps");

function toFiniteNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function toNonNegativeInteger(value, fallback = 0) {
  return Math.max(0, Math.trunc(toFiniteNumber(value, fallback)));
}

function setHasEntityID(value, entityID) {
  if (!(value instanceof Set)) {
    return false;
  }
  for (const candidate of value) {
    if (entityIDsEqual(candidate, entityID)) {
      return true;
    }
  }
  return false;
}

function deleteEntityIDFromSet(value, entityID) {
  if (!(value instanceof Set)) {
    return false;
  }
  let changed = false;
  for (const candidate of [...value]) {
    if (entityIDsEqual(candidate, entityID)) {
      changed = value.delete(candidate) || changed;
    }
  }
  return changed;
}

function mapHasEntityID(value, entityID) {
  if (!(value instanceof Map)) {
    return false;
  }
  for (const candidate of value.keys()) {
    if (entityIDsEqual(candidate, entityID)) {
      return true;
    }
  }
  return false;
}

function resolveExpectedGeneration(session, expectedGeneration) {
  const generation = expectedGeneration === undefined
    ? session && session._space
    : expectedGeneration;
  return session && generation && session._space === generation
    ? generation
    : null;
}

function buildVisibilityControlState(options = {}) {
  const postAttachRequested = options.postAttachVisibilityReconcile === true;
  return {
    pilotWarpQuietUntilStamp: resolveOptionalDestinyStamp(
      options.pilotWarpQuietUntilStamp,
    ),
    pilotWarpVisibilityHandoff:
      options.pilotWarpVisibilityHandoff &&
      typeof options.pilotWarpVisibilityHandoff === "object"
        ? options.pilotWarpVisibilityHandoff
        : null,
    postAttachVisibilityReconcile: postAttachRequested,
    postAttachVisibilityReconcileReason:
      typeof options.postAttachVisibilityReconcileReason === "string"
        ? options.postAttachVisibilityReconcileReason
        : null,
  };
}

function buildEntityVisibilityControlState() {
  return {
    departureBubbleID: null,
    departureBubbleVisibleUntilMs: 0,
  };
}

function createDeferredInitialVisibilityQueue() {
  return new Set();
}

function installDeferredInitialVisibilityQueue(scene) {
  if (!scene || typeof scene !== "object") {
    return null;
  }
  const queue = createDeferredInitialVisibilityQueue();
  scene.deferredInitialVisibilityEntityIDs = queue;
  return queue;
}

function setLaunchPresentationSnapshot(entity, snapshot) {
  if (
    !entity ||
    typeof entity !== "object" ||
    !snapshot ||
    typeof snapshot !== "object"
  ) {
    return false;
  }
  entity.launchPresentationSnapshot = snapshot;
  return true;
}

function clearLaunchPresentationSnapshot(entity) {
  if (
    !entity ||
    typeof entity !== "object" ||
    !Object.prototype.hasOwnProperty.call(entity, "launchPresentationSnapshot")
  ) {
    return false;
  }
  delete entity.launchPresentationSnapshot;
  return true;
}

function buildPostAttachVisibilityReconciliationOptions(reason) {
  return {
    postAttachVisibilityReconcile: true,
    postAttachVisibilityReconcileReason:
      typeof reason === "string" ? reason : null,
  };
}

function resetWarpDepartureVisibilityGrace(entity) {
  if (!entity || typeof entity !== "object") {
    return false;
  }
  const changed = entity.departureBubbleID !== null ||
    toFiniteNumber(entity.departureBubbleVisibleUntilMs, 0) !== 0;
  entity.departureBubbleID = null;
  entity.departureBubbleVisibleUntilMs = 0;
  return changed;
}

function beginWarpDepartureVisibilityGrace(
  optionsOrEntity = {},
  departureBubbleID = null,
  positionalNowMs = 0,
  positionalDurationMs = 0,
) {
  const positional = arguments.length > 1;
  const options = positional
    ? {
        entity: optionsOrEntity,
        departureBubbleID,
        nowMs: positionalNowMs,
        durationMs: positionalDurationMs,
      }
    : optionsOrEntity;
  const entity = options.entity && typeof options.entity === "object"
    ? options.entity
    : null;
  if (!entity) {
    return false;
  }
  const bubbleID = Math.trunc(toFiniteNumber(options.departureBubbleID, 0));
  const nowMs = toFiniteNumber(options.nowMs, 0);
  const durationMs = toNonNegativeInteger(options.durationMs, 0);
  entity.departureBubbleID = bubbleID > 0 ? bubbleID : null;
  entity.departureBubbleVisibleUntilMs = nowMs + durationMs;
  return true;
}

function createPilotWarpVisibilityHandoffProgress(handoff) {
  return handoff && typeof handoff === "object" ? { ...handoff } : null;
}

function markPilotWarpHandoffSourceRemoved(progress) {
  if (!progress || typeof progress !== "object") {
    return false;
  }
  progress.sourceRemoved = true;
  return true;
}

function markPilotWarpHandoffDestinationPrewarmed(progress) {
  if (!progress || typeof progress !== "object") {
    return false;
  }
  progress.destinationPrewarmed = true;
  return true;
}

function updatePilotWarpHandoffLiveGrid(
  progress,
  publicGridKey,
  publicGridClusterKey,
  sourceRemoved,
  destinationJoined,
  destinationStaticJoined,
) {
  if (!progress || typeof progress !== "object") {
    return false;
  }
  progress.currentPublicGridKey = String(publicGridKey || "").trim();
  progress.currentPublicGridClusterKey = String(
    publicGridClusterKey || "",
  ).trim();
  if (sourceRemoved === true) {
    progress.sourceRemoved = true;
  }
  if (destinationJoined === true) {
    progress.destinationJoined = true;
  }
  if (destinationStaticJoined === true) {
    progress.destinationStaticJoined = true;
  }
  return true;
}

function markPilotWarpHandoffDestinationStaticJoined(progress) {
  if (!progress || typeof progress !== "object") {
    return false;
  }
  progress.destinationStaticJoined = true;
  return true;
}

function markPilotWarpHandoffDestinationJoined(progress) {
  if (!progress || typeof progress !== "object") {
    return false;
  }
  progress.destinationJoined = true;
  return true;
}

function normalizeOptionalPersistentEntityID(value) {
  if (value === null || value === undefined) {
    return null;
  }
  return normalizePersistentEntityID(value);
}

function capturePilotWarpVisibilityHandoff(handoff) {
  if (!handoff || typeof handoff !== "object") {
    return null;
  }
  return Object.freeze({
    handoff,
    shipID: getEntityMapKey(handoff.shipID),
    destinationClusterKey: String(handoff.destinationClusterKey || ""),
    destinationPublicGridKey: String(handoff.destinationPublicGridKey || ""),
    destinationStaticInstanceID: normalizeOptionalPersistentEntityID(
      handoff.destinationStaticInstanceID,
    ),
    destinationDungeonRoomKey: String(
      handoff.destinationDungeonRoomKey || "",
    ).trim(),
    destinationDungeonSiteID: normalizeOptionalPersistentEntityID(
      handoff.destinationDungeonSiteID,
    ),
    sourceRemoved: handoff.sourceRemoved === true,
    destinationStaticJoined: handoff.destinationStaticJoined === true,
    destinationJoined: handoff.destinationJoined === true,
    destinationPrewarmed: handoff.destinationPrewarmed === true,
  });
}

function sameOptionalPersistentEntityID(left, right) {
  const normalizedLeft = normalizeOptionalPersistentEntityID(left);
  const normalizedRight = normalizeOptionalPersistentEntityID(right);
  if (normalizedLeft === null || normalizedRight === null) {
    return normalizedLeft === normalizedRight;
  }
  return entityIDsEqual(normalizedLeft, normalizedRight);
}

function isPilotWarpVisibilityHandoffCaptureCurrent(handoff, capture) {
  return Boolean(
    handoff &&
    capture &&
    capture.handoff === handoff &&
    entityIDsEqual(handoff.shipID, capture.shipID) &&
    String(handoff.destinationClusterKey || "") ===
      capture.destinationClusterKey &&
    String(handoff.destinationPublicGridKey || "") ===
      capture.destinationPublicGridKey &&
    sameOptionalPersistentEntityID(
      handoff.destinationStaticInstanceID,
      capture.destinationStaticInstanceID,
    ) &&
    String(handoff.destinationDungeonRoomKey || "").trim() ===
      capture.destinationDungeonRoomKey &&
    sameOptionalPersistentEntityID(
      handoff.destinationDungeonSiteID,
      capture.destinationDungeonSiteID,
    ) &&
    (handoff.sourceRemoved === true) === capture.sourceRemoved &&
    (handoff.destinationStaticJoined === true) ===
      capture.destinationStaticJoined &&
    (handoff.destinationJoined === true) === capture.destinationJoined &&
    (handoff.destinationPrewarmed === true) === capture.destinationPrewarmed
  );
}

function resolvePilotWarpQuietWindow(options = {}) {
  const session = options.session || null;
  const generation = resolveExpectedGeneration(
    session,
    options.generation,
  );
  if (!generation || !hasDestinyStamp(options.currentSessionStamp)) {
    return {
      active: false,
      expired: false,
      quietUntilStamp: null,
    };
  }
  const quietUntilStamp = resolveOptionalDestinyStamp(
    generation.pilotWarpQuietUntilStamp,
  );
  if (quietUntilStamp === null) {
    return {
      active: false,
      expired: false,
      quietUntilStamp: null,
    };
  }
  const currentSessionStamp = normalizeDestinyStamp(
    options.currentSessionStamp,
  );
  const maximumLead = toNonNegativeInteger(
    options.maximumLead,
    DESTINY_STAMP_MAX_FORWARD_LEAD,
  );
  if (isDestinyStampAfter(currentSessionStamp, quietUntilStamp, maximumLead)) {
    return {
      active: true,
      expired: false,
      quietUntilStamp,
    };
  }
  generation.pilotWarpQuietUntilStamp = null;
  return {
    active: false,
    expired: true,
    quietUntilStamp,
  };
}

function decoratePilotWarpVisibilityHandoff(options = {}) {
  const session = options.session || null;
  const generation = resolveExpectedGeneration(session, options.generation);
  const handoff = options.handoff && typeof options.handoff === "object"
    ? options.handoff
    : null;
  if (!generation || !handoff || generation.pilotWarpVisibilityHandoff !== handoff) {
    return null;
  }
  const warpState = options.warpState && typeof options.warpState === "object"
    ? options.warpState
    : {};
  handoff.landingPending = false;
  handoff.destinationDungeonRoomKey = String(
    warpState.destinationDungeonRoomKey || "",
  ).trim() || null;
  handoff.destinationDungeonSiteID = normalizePersistentEntityID(
    warpState.destinationDungeonSiteID,
  );
  return handoff;
}

function markPilotWarpDestinationPrewarmed(options = {}) {
  const session = options.session || null;
  const generation = resolveExpectedGeneration(session, options.generation);
  const handoff = options.handoff && typeof options.handoff === "object"
    ? options.handoff
    : null;
  if (!generation || !handoff || generation.pilotWarpVisibilityHandoff !== handoff) {
    return false;
  }
  handoff.destinationPrewarmed = true;
  return true;
}

function commitPilotWarpVisibilityHandoffProgress(options = {}) {
  const session = options.session || null;
  const generation = resolveExpectedGeneration(session, options.generation);
  const handoff = options.handoff && typeof options.handoff === "object"
    ? options.handoff
    : null;
  const nextHandoff = options.nextHandoff && typeof options.nextHandoff === "object"
    ? options.nextHandoff
    : null;
  if (
    !generation ||
    !handoff ||
    !nextHandoff ||
    generation.pilotWarpVisibilityHandoff !== handoff
  ) {
    return false;
  }
  for (const [key, value] of Object.entries(nextHandoff)) {
    if (key === "__proto__" || key === "prototype" || key === "constructor") {
      continue;
    }
    handoff[key] = value;
  }
  return true;
}

function markPilotWarpLandingPending(options = {}) {
  const session = options.session || null;
  const generation = resolveExpectedGeneration(session, options.generation);
  const entity = options.entity && typeof options.entity === "object"
    ? options.entity
    : null;
  const entityID = getEntityMapKey(entity && entity.itemID);
  if (!generation || !entity || entityID === null || entity.session !== session) {
    return null;
  }
  let handoff = generation.pilotWarpVisibilityHandoff;
  if (!handoff || !entityIDsEqual(handoff.shipID, entityID)) {
    const completedWarpState =
      options.completedWarpState && typeof options.completedWarpState === "object"
        ? options.completedWarpState
        : {};
    const landingClusterKey = String(options.destinationClusterKey || "").trim();
    handoff = {
      shipID: entityID,
      sourceClusterKey: landingClusterKey,
      destinationClusterKey: landingClusterKey,
      destinationPublicGridKey: String(
        options.destinationPublicGridKey || "",
      ).trim(),
      destinationStaticInstanceID: normalizePersistentEntityID(
        completedWarpState.destinationStaticInstanceID,
      ),
      destinationDungeonRoomKey: String(
        completedWarpState.destinationDungeonRoomKey || "",
      ).trim() || null,
      destinationDungeonSiteID: normalizePersistentEntityID(
        completedWarpState.destinationDungeonSiteID,
      ),
      sourceRemoved: true,
      destinationStaticJoined: true,
      destinationJoined: true,
      destinationPrewarmed: true,
      landingPending: false,
    };
    generation.pilotWarpVisibilityHandoff = handoff;
  }
  handoff.landingPending = true;
  return handoff;
}

function commitAcceptedPilotWarpLandingControl(options = {}) {
  const session = options.session || null;
  const generation = resolveExpectedGeneration(session, options.generation);
  const handoff = options.handoff && typeof options.handoff === "object"
    ? options.handoff
    : null;
  if (
    !generation ||
    !handoff ||
    generation.pilotWarpVisibilityHandoff !== handoff ||
    handoff.landingPending !== true ||
    !hasDestinyStamp(options.acceptedStamp)
  ) {
    return false;
  }
  const acceptedStamp = normalizeDestinyStamp(options.acceptedStamp);
  const maximumLead = toNonNegativeInteger(
    options.maximumLead,
    DESTINY_STAMP_MAX_FORWARD_LEAD,
  );
  generation.pilotWarpQuietUntilStamp = selectFurthestDestinyStamp(
    acceptedStamp,
    [generation.pilotWarpQuietUntilStamp],
    maximumLead,
  );
  handoff.landingPending = false;
  generation.pilotWarpVisibilityHandoff = null;
  return true;
}

function consumeWarpAcquireUntilNextTickSuppression(options = {}) {
  const entity = options.entity && typeof options.entity === "object"
    ? options.entity
    : null;
  if (!entity || entity.suppressWarpAcquireUntilNextTick !== true) {
    return false;
  }
  const nowMs = toFiniteNumber(options.nowMs, 0);
  const durationMs = toNonNegativeInteger(options.durationMs, 0);
  entity.visibilitySuppressedUntilMs = Math.max(
    toFiniteNumber(entity.visibilitySuppressedUntilMs, 0),
    nowMs + durationMs,
  );
  entity.suppressWarpAcquireUntilNextTick = false;
  return true;
}

function authorPostAttachVisibilityReconciliation(generation, options = {}) {
  if (!generation || typeof generation !== "object") {
    return false;
  }
  const state = buildVisibilityControlState(options);
  generation.postAttachVisibilityReconcile =
    state.postAttachVisibilityReconcile;
  generation.postAttachVisibilityReconcileReason =
    state.postAttachVisibilityReconcileReason;
  return state.postAttachVisibilityReconcile;
}

function capturePostAttachVisibilityReconciliation(session) {
  const generation = session && session._space;
  if (!generation || generation.postAttachVisibilityReconcile !== true) {
    return null;
  }
  return Object.freeze({
    generation,
    reason:
      typeof generation.postAttachVisibilityReconcileReason === "string"
        ? generation.postAttachVisibilityReconcileReason
        : null,
    session,
  });
}

function commitAcceptedPostAttachVisibilityReconciliation(capture) {
  if (!capture || typeof capture !== "object") {
    return false;
  }
  const session = capture.session || null;
  const generation = resolveExpectedGeneration(session, capture.generation);
  if (
    !generation ||
    generation.postAttachVisibilityReconcile !== true ||
    (
      typeof generation.postAttachVisibilityReconcileReason === "string"
        ? generation.postAttachVisibilityReconcileReason
        : null
    ) !== capture.reason
  ) {
    return false;
  }
  generation.postAttachVisibilityReconcile = false;
  generation.postAttachVisibilityReconcileReason = null;
  return true;
}

function registerDeferredInitialVisibilityEntity(queue, entity) {
  const entityID = getEntityMapKey(entity && entity.itemID);
  if (!(queue instanceof Set) || !entity || entityID === null) {
    return false;
  }
  entity.deferUntilInitialVisibilitySync = true;
  // The scene's dynamic-entity map intentionally retains the producer's exact
  // key representation. Preserve that key here too; canonical identity is used
  // only for comparisons and duplicate-safe deletion.
  queue.add(entity.itemID);
  return true;
}

function unregisterDeferredInitialVisibilityEntity(queue, entity, options = {}) {
  const entityID = getEntityMapKey(entity && entity.itemID);
  if (!(queue instanceof Set) || !entity || entityID === null) {
    return false;
  }
  let ownsQueueEntry = true;
  if (typeof options.resolveEntityByID === "function") {
    const currentEntity = options.resolveEntityByID(entity.itemID);
    ownsQueueEntry = !currentEntity || currentEntity === entity;
  }
  let changed = false;
  if (ownsQueueEntry) {
    changed = deleteEntityIDFromSet(queue, entityID) || changed;
  }
  if (entity.deferUntilInitialVisibilitySync === true) {
    entity.deferUntilInitialVisibilitySync = false;
    changed = true;
  }
  if (
    options.clearLaunchPresentationSnapshot !== false &&
    Object.prototype.hasOwnProperty.call(entity, "launchPresentationSnapshot")
  ) {
    delete entity.launchPresentationSnapshot;
    changed = true;
  }
  return changed;
}

function collectDeferredInitialVisibilityEntities(
  queue,
  resolveEntityByID,
) {
  if (!(queue instanceof Set) || typeof resolveEntityByID !== "function") {
    return [];
  }
  const entities = [];
  const seenEntities = new Set();
  for (const queuedID of [...queue]) {
    const entityID = getEntityMapKey(queuedID);
    const entity = entityID === null ? null : resolveEntityByID(queuedID);
    if (
      !entity ||
      !entityIDsEqual(entity.itemID, entityID) ||
      entity.deferUntilInitialVisibilitySync !== true
    ) {
      deleteEntityIDFromSet(queue, queuedID);
      continue;
    }
    if (!seenEntities.has(entity)) {
      seenEntities.add(entity);
      entities.push(entity);
    }
  }
  return entities;
}

function captureDeferredInitialVisibilitySessionObservation(options = {}) {
  const session = options.session || null;
  const generation = options.generation === undefined
    ? session && session._space
    : options.generation;
  const entity = options.entity && typeof options.entity === "object"
    ? options.entity
    : null;
  const entityID = getEntityMapKey(entity && entity.itemID);
  if (!session || !generation || !entity || entityID === null) {
    return null;
  }
  return Object.freeze({
    added: options.added === true,
    assessed: options.assessed !== false,
    desired: options.desired === true,
    entity,
    entityID,
    generation,
    pending: options.pending === true,
    session,
  });
}

function generationHasPendingEntityRequirement(generation, entityID) {
  return Boolean(
    generation &&
    (
      mapHasEntityID(
        generation.pendingNativeVisibilityAcquisitionsByID,
        entityID,
      ) ||
      mapHasEntityID(
        generation.pendingNativeVisibilityRemovalsByID,
        entityID,
      )
    ),
  );
}

function settleDeferredInitialVisibilityAfterFlush(options = {}) {
  const queue = options.queue;
  const entity = options.entity && typeof options.entity === "object"
    ? options.entity
    : null;
  const entityID = getEntityMapKey(entity && entity.itemID);
  const observations = Array.isArray(options.observations)
    ? options.observations
    : [];
  const summary = {
    committedSessionCount: 0,
    observedSessionCount: observations.length,
    pendingSessionCount: 0,
    requiredSessionCount: 0,
    settled: false,
    staleGenerationCount: 0,
  };
  if (
    !(queue instanceof Set) ||
    !entity ||
    entityID === null ||
    typeof options.resolveEntityByID !== "function"
  ) {
    return { ...summary, reason: "invalid-input" };
  }
  if (options.resolveEntityByID(entity.itemID) !== entity) {
    return { ...summary, reason: "entity-replaced" };
  }
  if (entity.deferUntilInitialVisibilitySync !== true) {
    deleteEntityIDFromSet(queue, entityID);
    return { ...summary, settled: true, reason: "already-settled" };
  }

  for (const observation of observations) {
    if (
      !observation ||
      observation.entity !== entity ||
      !entityIDsEqual(observation.entityID, entityID)
    ) {
      return { ...summary, reason: "observation-entity-mismatch" };
    }
    if (observation.assessed !== true) {
      return { ...summary, reason: "visibility-not-assessed" };
    }
    const requiresAcquisition = observation.desired === true;
    const carriedRequirement = Boolean(
      requiresAcquisition ||
      observation.added === true ||
      observation.pending === true
    );
    if (carriedRequirement) {
      summary.requiredSessionCount += 1;
    }
    if (observation.session._space !== observation.generation) {
      summary.staleGenerationCount += 1;
      continue;
    }
    const currentlyPending = generationHasPendingEntityRequirement(
      observation.generation,
      entityID,
    );
    if (currentlyPending) {
      summary.pendingSessionCount += 1;
      continue;
    }
    if (
      carriedRequirement &&
      setHasEntityID(
        observation.generation.visibleDynamicEntityIDs,
        entityID,
      )
    ) {
      summary.committedSessionCount += 1;
    }
  }

  if (summary.staleGenerationCount > 0) {
    return { ...summary, reason: "generation-stale" };
  }
  if (summary.pendingSessionCount > 0) {
    return { ...summary, reason: "visibility-intent-pending" };
  }
  if (summary.committedSessionCount < summary.requiredSessionCount) {
    return { ...summary, reason: "delivery-not-committed" };
  }

  unregisterDeferredInitialVisibilityEntity(queue, entity, {
    clearLaunchPresentationSnapshot: true,
    resolveEntityByID: options.resolveEntityByID,
  });
  return { ...summary, settled: true, reason: "accepted-or-no-recipient" };
}

module.exports = {
  authorPostAttachVisibilityReconciliation,
  beginWarpDepartureVisibilityGrace,
  buildEntityVisibilityControlState,
  buildPostAttachVisibilityReconciliationOptions,
  buildVisibilityControlState,
  captureDeferredInitialVisibilitySessionObservation,
  capturePilotWarpVisibilityHandoff,
  capturePostAttachVisibilityReconciliation,
  clearLaunchPresentationSnapshot,
  collectDeferredInitialVisibilityEntities,
  commitAcceptedPilotWarpLandingControl,
  commitAcceptedPostAttachVisibilityReconciliation,
  commitPilotWarpVisibilityHandoffProgress,
  consumeWarpAcquireUntilNextTickSuppression,
  createDeferredInitialVisibilityQueue,
  createPilotWarpVisibilityHandoffProgress,
  decoratePilotWarpVisibilityHandoff,
  installDeferredInitialVisibilityQueue,
  isPilotWarpVisibilityHandoffCaptureCurrent,
  markPilotWarpHandoffDestinationJoined,
  markPilotWarpHandoffDestinationPrewarmed,
  markPilotWarpHandoffDestinationStaticJoined,
  markPilotWarpHandoffSourceRemoved,
  markPilotWarpDestinationPrewarmed,
  markPilotWarpLandingPending,
  registerDeferredInitialVisibilityEntity,
  resetWarpDepartureVisibilityGrace,
  resolvePilotWarpQuietWindow,
  setLaunchPresentationSnapshot,
  settleDeferredInitialVisibilityAfterFlush,
  unregisterDeferredInitialVisibilityEntity,
  updatePilotWarpHandoffLiveGrid,
};
