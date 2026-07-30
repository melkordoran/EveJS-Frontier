"use strict";

const {
  getPendingVisibilityAcquisitionIDs,
  getPendingVisibilityRemovalIDs,
  isVisibilityAcquisitionCommitted,
  reserveVisibilityAcquisitions,
  reserveVisibilityRemovals,
} = require("./acquisition");
const {
  deleteEntityIDFromMap,
  entityIDsEqual,
  getEntityMapKey,
} = require("../identity/entityID");

// These brands are capabilities, not retained visibility state.  Each
// capability is also bound to the exact object that carries it so copying a
// non-enumerable symbol cannot forge a reservation or presentation grant.
const REMOVAL_RESERVATION_BRAND = Symbol(
  "destiny.sceneVisibilityRemovalReservation",
);
const REMOVAL_PRESENTATION_BRAND = Symbol(
  "destiny.sceneVisibilityRemovalPresentation",
);

const DEFAULT_BOOTSTRAP_STALE_CODE =
  "DESTINY_BOOTSTRAP_VISIBILITY_GENERATION_REPLACED";
const DEFAULT_JOURNAL_MAX_ENTRIES = 200;
const DEFAULT_JOURNAL_MAX_IDS = 64;

function toInteger(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function getCollectionEntries(value) {
  return value instanceof Set || Array.isArray(value) ? value : [];
}

function normalizeVisibilityEntityIDSet(value) {
  const normalized = new Set();
  for (const rawEntityID of getCollectionEntries(value)) {
    const entityID = getEntityMapKey(rawEntityID);
    if (entityID !== null) {
      normalized.add(entityID);
    }
  }
  return normalized;
}

function visibilitySetHasEntityID(value, rawEntityID) {
  if (!(value instanceof Set)) {
    return false;
  }
  const entityID = getEntityMapKey(rawEntityID);
  if (entityID === null) {
    return false;
  }
  if (value.has(entityID)) {
    return true;
  }
  for (const candidate of value) {
    if (entityIDsEqual(candidate, entityID)) {
      return true;
    }
  }
  return false;
}

function deleteEntityIDFromSet(value, rawEntityID) {
  if (!(value instanceof Set)) {
    return false;
  }
  let deleted = false;
  for (const candidate of [...value]) {
    if (entityIDsEqual(candidate, rawEntityID)) {
      deleted = value.delete(candidate) || deleted;
    }
  }
  return deleted;
}

function getPlannedVisibleDynamicEntityIDs(session, committedIDs) {
  const visibleIDs = normalizeVisibilityEntityIDSet(committedIDs);
  for (const entityID of getPendingVisibilityRemovalIDs(session, "dynamic")) {
    deleteEntityIDFromSet(visibleIDs, entityID);
  }
  for (const entityID of getPendingVisibilityAcquisitionIDs(session, "dynamic")) {
    visibleIDs.add(entityID);
  }
  return visibleIDs;
}

function getStaticEntity(scene, entityID, options = {}) {
  if (typeof options.getStaticEntityByID === "function") {
    return options.getStaticEntityByID(scene, entityID);
  }
  return scene && scene.staticEntitiesByID instanceof Map
    ? scene.staticEntitiesByID.get(entityID)
    : null;
}

function isIncrementalStaticEntity(entity, options = {}) {
  return (
    typeof options.isIncrementalStaticVisibilityEntity === "function" &&
    options.isIncrementalStaticVisibilityEntity(entity) === true
  );
}

function getPlannedVisibleStaticEntityIDs(
  scene,
  session,
  committedIDs,
  options = {},
) {
  const visibleIDs = normalizeVisibilityEntityIDSet(committedIDs);
  for (const entityID of getPendingVisibilityRemovalIDs(session, "static")) {
    deleteEntityIDFromSet(visibleIDs, entityID);
  }
  for (const entityID of getPendingVisibilityAcquisitionIDs(session, "static")) {
    const entity = getStaticEntity(scene, entityID, options);
    if (isIncrementalStaticEntity(entity, options)) {
      visibleIDs.add(entityID);
    }
  }
  return visibleIDs;
}

function isSceneVisibilityAcquisitionCommitted(
  session,
  rawEntityID,
  kind = null,
) {
  if (isVisibilityAcquisitionCommitted(session, rawEntityID, kind)) {
    return true;
  }
  const generation = session && session._space;
  const entityID = getEntityMapKey(rawEntityID);
  if (!generation || entityID === null) {
    return false;
  }
  const normalizedKind = String(kind || "").trim().toLowerCase();
  const egoCommitted = entityIDsEqual(
    generation.presentedEgoEntityID,
    entityID,
  );
  const dynamicCommitted = visibilitySetHasEntityID(
    generation.visibleDynamicEntityIDs,
    entityID,
  );
  const staticCommitted = visibilitySetHasEntityID(
    generation.visibleBubbleScopedStaticEntityIDs,
    entityID,
  );
  if (normalizedKind === "ego") {
    return egoCommitted;
  }
  if (normalizedKind === "dynamic") {
    return dynamicCommitted;
  }
  if (normalizedKind === "static") {
    return staticCommitted;
  }
  return egoCommitted || dynamicCommitted || staticCommitted;
}

function resolveVisibilityAcquisitionKind(
  scene,
  session,
  entity,
  rawEntityID,
  options = {},
) {
  const entityID = getEntityMapKey(rawEntityID);
  if (
    entityID !== null &&
    session &&
    session._space &&
    entityIDsEqual(session._space.shipID, entityID)
  ) {
    return "ego";
  }
  if (
    entityID !== null &&
    scene &&
    scene.dynamicEntities instanceof Map &&
    scene.dynamicEntities.has(entityID)
  ) {
    return "dynamic";
  }
  if (
    entityID !== null &&
    scene &&
    scene.staticEntitiesByID instanceof Map &&
    scene.staticEntitiesByID.has(entityID)
  ) {
    return "static";
  }
  return isIncrementalStaticEntity(entity, options) ? "static" : "dynamic";
}

function applyStaleGenerationBehavior(
  intent,
  behavior,
  errorCode = "DESTINY_VISIBILITY_GENERATION_REPLACED",
) {
  if (behavior === "commit") {
    return Boolean(intent && typeof intent.commit === "function" && intent.commit());
  }
  if (behavior === "rollback") {
    return Boolean(
      intent && typeof intent.rollback === "function" && intent.rollback(),
    );
  }
  if (behavior === "throw") {
    const error = new Error(errorCode);
    error.code = errorCode;
    throw error;
  }
  return false;
}

function reserveSceneVisibilityAcquisitions(
  scene,
  session,
  entities,
  options = {},
) {
  const pendingRemovalIDs = getPendingVisibilityRemovalIDs(session);
  return reserveVisibilityAcquisitions(session, entities, {
    resolveKind: (entity, entityID) => resolveVisibilityAcquisitionKind(
      scene,
      session,
      entity,
      entityID,
      options,
    ),
    isCommitted: (_entity, entityID, kind) => (
      !visibilitySetHasEntityID(pendingRemovalIDs, entityID) &&
      isSceneVisibilityAcquisitionCommitted(session, entityID, kind)
    ),
  });
}

function reserveSceneVisibilityRemovals(session, entityIDs, options = {}) {
  const generation = session && session._space;
  const pendingAcquisitionIDs = getPendingVisibilityAcquisitionIDs(session);
  const staticIDs = generation &&
    generation.visibleBubbleScopedStaticEntityIDs instanceof Set
    ? generation.visibleBubbleScopedStaticEntityIDs
    : new Set();
  const requestedKind = String(options.kind || "").trim().toLowerCase();
  const nativeReservation = reserveVisibilityRemovals(session, entityIDs, {
    resolveKind: (entityID) => (
      generation && entityIDsEqual(generation.presentedEgoEntityID, entityID)
        ? "ego"
        : requestedKind === "static" || requestedKind === "dynamic"
          ? requestedKind
          : visibilitySetHasEntityID(staticIDs, entityID)
            ? "static"
            : "dynamic"
    ),
    isCommitted: (entityID) => (
      options.allowUncommitted === true ||
      (
        options.allowPendingAcquisition === true &&
        visibilitySetHasEntityID(pendingAcquisitionIDs, entityID)
      ) ||
      isSceneVisibilityAcquisitionCommitted(session, entityID)
    ),
  });
  let active = true;
  let reservation = null;
  const reservedEntityIDs = normalizeVisibilityEntityIDSet(
    nativeReservation.entityIDs,
  );
  const capability = (candidateSession, candidateReservation, rawEntityID) => (
    active === true &&
    candidateSession === session &&
    candidateReservation === reservation &&
    candidateSession &&
    candidateSession._space === generation &&
    candidateReservation.generation === generation &&
    visibilitySetHasEntityID(reservedEntityIDs, rawEntityID)
  );
  reservation = {
    ...nativeReservation,
    commit(...args) {
      active = false;
      return nativeReservation.commit(...args);
    },
    rollback(...args) {
      active = false;
      return nativeReservation.rollback(...args);
    },
  };
  Object.defineProperty(reservation, REMOVAL_RESERVATION_BRAND, {
    configurable: false,
    enumerable: false,
    value: capability,
    writable: false,
  });
  return reservation;
}

function isOwnedSceneVisibilityRemovalReservation(
  session,
  reservation,
  entityIDs,
) {
  const capability = reservation && typeof reservation === "object"
    ? reservation[REMOVAL_RESERVATION_BRAND]
    : null;
  const generation = session && session._space;
  if (
    !generation ||
    typeof capability !== "function" ||
    reservation.generation !== generation ||
    !(reservation.entityIDs instanceof Set)
  ) {
    return false;
  }
  const pendingRemovalIDs = getPendingVisibilityRemovalIDs(session);
  return (
    Array.isArray(entityIDs) &&
    entityIDs.length > 0 &&
    entityIDs.every((rawEntityID) => {
      const entityID = getEntityMapKey(rawEntityID);
      return (
        entityID !== null &&
        capability(session, reservation, entityID) === true &&
        visibilitySetHasEntityID(reservation.entityIDs, entityID) &&
        visibilitySetHasEntityID(pendingRemovalIDs, entityID)
      );
    })
  );
}

function authorizeSceneVisibilityRemovalPresentation(
  sendOptions,
  session,
  reservation,
  entityIDs,
  kind,
) {
  const normalizedEntityIDs = [...normalizeVisibilityEntityIDSet(entityIDs)];
  if (
    !sendOptions ||
    typeof sendOptions !== "object" ||
    kind !== "cloak" ||
    !isOwnedSceneVisibilityRemovalReservation(
      session,
      reservation,
      normalizedEntityIDs,
    )
  ) {
    return false;
  }
  const generation = session._space;
  const authorizedEntityIDs = normalizeVisibilityEntityIDSet(
    normalizedEntityIDs,
  );
  const authorization = (
    _candidateSendOptions,
    candidateSession,
    payloadName,
    rawEntityIDs,
  ) => (
    candidateSession === session &&
    candidateSession &&
    candidateSession._space === generation &&
    payloadName === "CloakBall" &&
    Array.isArray(rawEntityIDs) &&
    rawEntityIDs.length > 0 &&
    rawEntityIDs.every((entityID) =>
      visibilitySetHasEntityID(authorizedEntityIDs, entityID)) &&
    isOwnedSceneVisibilityRemovalReservation(
      candidateSession,
      reservation,
      rawEntityIDs,
    )
  );
  Object.defineProperty(sendOptions, REMOVAL_PRESENTATION_BRAND, {
    configurable: false,
    enumerable: false,
    value: authorization,
    writable: false,
  });
  return true;
}

function isSceneVisibilityRemovalPresentationAuthorized(
  sendOptions,
  session,
  payloadName,
  entityIDs,
) {
  const authorization = sendOptions && typeof sendOptions === "object"
    ? sendOptions[REMOVAL_PRESENTATION_BRAND]
    : null;
  const normalizedEntityIDs = [...normalizeVisibilityEntityIDSet(entityIDs)];
  return Boolean(
    typeof authorization === "function" &&
    normalizedEntityIDs.length > 0 &&
    authorization(
      sendOptions,
      session,
      payloadName,
      normalizedEntityIDs,
    ) === true
  );
}

function commitVisibilityAcquisitionMembership(
  scene,
  session,
  reservation,
  options = {},
) {
  const generation = session && session._space;
  if (!generation || !reservation || reservation.generation !== generation) {
    applyStaleGenerationBehavior(
      reservation,
      options.staleGenerationBehavior || "ignore",
      options.staleGenerationCode,
    );
    return false;
  }

  const dynamicIDs = normalizeVisibilityEntityIDSet(
    generation.visibleDynamicEntityIDs,
  );
  const freshIDs = normalizeVisibilityEntityIDSet(
    generation.freshlyVisibleDynamicEntityIDs,
  );
  const staticIDs = normalizeVisibilityEntityIDSet(
    generation.visibleBubbleScopedStaticEntityIDs,
  );
  let presentedEgoEntityID = generation.presentedEgoEntityID;

  for (const entry of Array.isArray(reservation.entries)
    ? reservation.entries
    : []) {
    const entityID = getEntityMapKey(entry && entry.entityID);
    if (entityID === null) {
      continue;
    }
    if (entry.kind === "ego") {
      presentedEgoEntityID = entityID;
    } else if (entry.kind === "static") {
      const entity = getStaticEntity(scene, entityID, options);
      if (isIncrementalStaticEntity(entity, options)) {
        staticIDs.add(entityID);
      }
    } else {
      dynamicIDs.add(entityID);
      freshIDs.add(entityID);
    }
  }

  const finalized = typeof reservation.commit === "function"
    ? reservation.commit()
    : false;
  if (finalized !== true && options.requireIntentFinalization === true) {
    return false;
  }
  generation.presentedEgoEntityID = presentedEgoEntityID;
  generation.visibleDynamicEntityIDs = dynamicIDs;
  generation.freshlyVisibleDynamicEntityIDs = freshIDs;
  generation.visibleBubbleScopedStaticEntityIDs = staticIDs;
  return finalized === true;
}

function clearCommittedVisibilityMembership(
  generation,
  rawEntityID,
  options = {},
) {
  if (!generation || typeof generation !== "object") {
    return false;
  }
  const entityID = getEntityMapKey(rawEntityID);
  if (entityID === null) {
    return false;
  }
  let changed = false;
  if (options.dynamic !== false) {
    changed = deleteEntityIDFromSet(
      generation.visibleDynamicEntityIDs,
      entityID,
    ) || changed;
  }
  if (options.fresh !== false) {
    changed = deleteEntityIDFromSet(
      generation.freshlyVisibleDynamicEntityIDs,
      entityID,
    ) || changed;
  }
  if (options.release !== false) {
    changed = deleteEntityIDFromMap(
      generation.freshlyVisibleDynamicEntityReleaseStampByID,
      entityID,
    ) || changed;
  }
  if (options.static === true) {
    changed = deleteEntityIDFromSet(
      generation.visibleBubbleScopedStaticEntityIDs,
      entityID,
    ) || changed;
  }
  if (
    options.ego === true &&
    entityIDsEqual(generation.presentedEgoEntityID, entityID)
  ) {
    generation.presentedEgoEntityID = null;
    changed = true;
  }
  return changed;
}

function clearSameSceneDynamicClassification(generation, entityID) {
  const wasDynamic = visibilitySetHasEntityID(
    generation && generation.visibleDynamicEntityIDs,
    entityID,
  );
  clearCommittedVisibilityMembership(generation, entityID, {
    dynamic: true,
    ego: false,
    fresh: true,
    release: true,
    static: false,
  });
  return wasDynamic;
}

function commitSceneVisibilityRemovals(
  session,
  reservation,
  options = {},
) {
  const generation = session && session._space;
  if (!reservation || !reservation.generation || generation !== reservation.generation) {
    applyStaleGenerationBehavior(
      reservation,
      options.staleGenerationBehavior || "commit",
      options.staleGenerationCode,
    );
    return false;
  }
  if (typeof reservation.commit !== "function" || reservation.commit() !== true) {
    return false;
  }
  for (const entry of Array.isArray(reservation.entries)
    ? reservation.entries
    : []) {
    clearCommittedVisibilityMembership(
      reservation.generation,
      entry && entry.entityID,
      options,
    );
  }
  return true;
}

function reserveSceneVisibilityDelta(
  scene,
  session,
  addedEntities,
  removedEntityIDs,
  options = {},
) {
  const removalReservation = reserveSceneVisibilityRemovals(
    session,
    removedEntityIDs,
    options.removal,
  );
  let acquisitionReservation;
  try {
    acquisitionReservation = reserveSceneVisibilityAcquisitions(
      scene,
      session,
      addedEntities,
      options.acquisition,
    );
  } catch (error) {
    removalReservation.rollback();
    throw error;
  }
  const generation = session && session._space;
  return {
    generation,
    acquisitionReservation,
    removalReservation,
    addedEntities: acquisitionReservation.entities,
    removedIDs: [...removalReservation.entityIDs],
    commit() {
      if (
        !session ||
        session._space !== generation ||
        acquisitionReservation.generation !== generation ||
        removalReservation.generation !== generation
      ) {
        return false;
      }
      const acquisitionCommitted = acquisitionReservation.commit();
      const removalCommitted = removalReservation.commit();
      return acquisitionCommitted || removalCommitted;
    },
    rollback() {
      const acquisitionRolledBack = acquisitionReservation.rollback();
      const removalRolledBack = removalReservation.rollback();
      return acquisitionRolledBack || removalRolledBack;
    },
  };
}

function collectEntityIDsFromEntities(entities) {
  return normalizeVisibilityEntityIDSet(
    (Array.isArray(entities) ? entities : []).map((entity) =>
      entity && entity.itemID),
  );
}

function collectDeltaFreshEntityIDs(delta = {}) {
  if (delta.freshEntityIDs instanceof Set || Array.isArray(delta.freshEntityIDs)) {
    return normalizeVisibilityEntityIDSet(delta.freshEntityIDs);
  }
  if (delta.addedEntityIDs instanceof Set || Array.isArray(delta.addedEntityIDs)) {
    return normalizeVisibilityEntityIDSet(delta.addedEntityIDs);
  }
  return collectEntityIDsFromEntities(delta.addedEntities);
}

function getReleaseIDsToDelete(
  generation,
  desiredIDs,
  explicitEntityIDs,
  options = {},
) {
  const releaseStampByID =
    generation.freshlyVisibleDynamicEntityReleaseStampByID;
  const deleteIDs = normalizeVisibilityEntityIDSet(explicitEntityIDs);
  if (!(releaseStampByID instanceof Map)) {
    return deleteIDs;
  }
  const isProtectionBoundaryActive =
    typeof options.isProtectionBoundaryActive === "function"
      ? options.isProtectionBoundaryActive
      : () => true;
  for (const [rawEntityID, releaseStamp] of releaseStampByID.entries()) {
    const entityID = getEntityMapKey(rawEntityID);
    if (
      entityID === null ||
      !visibilitySetHasEntityID(desiredIDs, entityID) ||
      isProtectionBoundaryActive(options.currentStamp, releaseStamp) !== true
    ) {
      if (entityID !== null) {
        deleteIDs.add(entityID);
      }
    }
  }
  return deleteIDs;
}

function finalizeAcceptedIntent(intent, options = {}) {
  if (options.finalizeIntent === false) {
    return true;
  }
  const method = options.intentFinalizationMethod === "rollback"
    ? "rollback"
    : "commit";
  return Boolean(intent && typeof intent[method] === "function" && intent[method]());
}

function commitDynamicVisibilityDelta(
  session,
  visibilityIntent,
  delta = {},
  options = {},
) {
  const generation = session && session._space;
  if (!generation || !visibilityIntent || visibilityIntent.generation !== generation) {
    applyStaleGenerationBehavior(
      visibilityIntent,
      options.staleGenerationBehavior || "ignore",
      options.staleGenerationCode,
    );
    return false;
  }
  const desiredIDs = normalizeVisibilityEntityIDSet(delta.desiredIDs);
  const freshIDs = collectDeltaFreshEntityIDs(delta);
  const releaseIDsToDelete = getReleaseIDsToDelete(
    generation,
    desiredIDs,
    options.freshReleaseEntityIDsToDelete,
    options,
  );
  const finalized = finalizeAcceptedIntent(visibilityIntent, options);
  if (!finalized && options.requireIntentFinalization === true) {
    return false;
  }
  generation.visibleDynamicEntityIDs = desiredIDs;
  generation.freshlyVisibleDynamicEntityIDs = freshIDs;
  for (const entityID of releaseIDsToDelete) {
    deleteEntityIDFromMap(
      generation.freshlyVisibleDynamicEntityReleaseStampByID,
      entityID,
    );
  }
  return true;
}

function commitStaticVisibilityDelta(
  session,
  visibilityIntent,
  delta = {},
  options = {},
) {
  const generation = session && session._space;
  if (!generation || !visibilityIntent || visibilityIntent.generation !== generation) {
    applyStaleGenerationBehavior(
      visibilityIntent,
      options.staleGenerationBehavior || "ignore",
      options.staleGenerationCode,
    );
    return false;
  }
  const desiredIDs = normalizeVisibilityEntityIDSet(delta.desiredIDs);
  const finalized = finalizeAcceptedIntent(visibilityIntent, options);
  if (!finalized && options.requireIntentFinalization === true) {
    return false;
  }
  generation.visibleBubbleScopedStaticEntityIDs = desiredIDs;
  return true;
}

function commitCombinedVisibilityDelta(
  session,
  visibilityIntent,
  dynamicDelta,
  staticDelta,
  options = {},
) {
  const generation = session && session._space;
  if (!generation || !visibilityIntent || visibilityIntent.generation !== generation) {
    applyStaleGenerationBehavior(
      visibilityIntent,
      options.staleGenerationBehavior || "commit",
      options.staleGenerationCode,
    );
    return false;
  }

  let desiredDynamicIDs = null;
  let freshDynamicIDs = null;
  let releaseIDsToDelete = null;
  if (dynamicDelta && typeof dynamicDelta === "object") {
    desiredDynamicIDs = normalizeVisibilityEntityIDSet(dynamicDelta.desiredIDs);
    const hasPlannedFreshIDs =
      options.plannedFreshDynamicEntityIDs instanceof Set ||
      Array.isArray(options.plannedFreshDynamicEntityIDs);
    if (hasPlannedFreshIDs) {
      freshDynamicIDs = normalizeVisibilityEntityIDSet(
        options.plannedFreshDynamicEntityIDs,
      );
    } else {
      const candidateFreshIDs = collectDeltaFreshEntityIDs(dynamicDelta);
      const reservedAddedIDs = options.reservedAddedEntityIDs
        ? normalizeVisibilityEntityIDSet(options.reservedAddedEntityIDs)
        : collectEntityIDsFromEntities(visibilityIntent.addedEntities);
      const unchangedIDs = normalizeVisibilityEntityIDSet(
        options.unchangedIntersectionEntityIDs,
      );
      freshDynamicIDs = new Set(
        [...candidateFreshIDs].filter((entityID) => (
          visibilitySetHasEntityID(reservedAddedIDs, entityID) &&
          !visibilitySetHasEntityID(unchangedIDs, entityID)
        )),
      );
    }
    releaseIDsToDelete = getReleaseIDsToDelete(
      generation,
      desiredDynamicIDs,
      options.freshReleaseEntityIDsToDelete,
      options,
    );
  }
  const desiredStaticIDs = staticDelta && typeof staticDelta === "object"
    ? normalizeVisibilityEntityIDSet(staticDelta.desiredIDs)
    : null;

  const finalized = finalizeAcceptedIntent(visibilityIntent, options);
  if (!finalized && options.requireIntentFinalization === true) {
    return false;
  }
  if (desiredDynamicIDs) {
    generation.visibleDynamicEntityIDs = desiredDynamicIDs;
    generation.freshlyVisibleDynamicEntityIDs = freshDynamicIDs;
    for (const entityID of releaseIDsToDelete) {
      deleteEntityIDFromMap(
        generation.freshlyVisibleDynamicEntityReleaseStampByID,
        entityID,
      );
    }
  }
  if (desiredStaticIDs) {
    generation.visibleBubbleScopedStaticEntityIDs = desiredStaticIDs;
  }
  return true;
}

function commitInitialBallparkVisibility(
  session,
  generation,
  visibilitySnapshot,
  egoEntityID,
  options = {},
) {
  if (!session || session._space !== generation) {
    applyStaleGenerationBehavior(
      null,
      options.staleGenerationBehavior || "throw",
      options.staleGenerationCode || DEFAULT_BOOTSTRAP_STALE_CODE,
    );
    return false;
  }
  const dynamicIDs = normalizeVisibilityEntityIDSet(
    visibilitySnapshot && visibilitySnapshot.dynamicEntityIDs,
  );
  const staticIDs = normalizeVisibilityEntityIDSet(
    visibilitySnapshot && visibilitySnapshot.staticEntityIDs,
  );
  const normalizedEgoEntityID = getEntityMapKey(egoEntityID);
  generation.visibleDynamicEntityIDs = dynamicIDs;
  generation.visibleBubbleScopedStaticEntityIDs = staticIDs;
  generation.freshlyVisibleDynamicEntityIDs = new Set();
  generation.presentedEgoEntityID = normalizedEgoEntityID;
  return true;
}

function installFreshVisibilityReleaseEntries(
  session,
  generation,
  entries,
  options = {},
) {
  if (!session || session._space !== generation) {
    applyStaleGenerationBehavior(
      null,
      options.staleGenerationBehavior || "ignore",
      options.staleGenerationCode,
    );
    return false;
  }
  const inputEntries = entries instanceof Map
    ? [...entries.entries()]
    : Array.isArray(entries)
      ? entries
      : [];
  const normalizeReleaseStamp = typeof options.normalizeReleaseStamp === "function"
    ? options.normalizeReleaseStamp
    : (stamp) => stamp;
  const normalizedEntries = [];
  for (const entry of inputEntries) {
    if (!Array.isArray(entry) || entry.length < 2) {
      continue;
    }
    const entityID = getEntityMapKey(entry[0]);
    if (entityID === null) {
      continue;
    }
    const releaseStamp = normalizeReleaseStamp(entry[1], entityID);
    if (releaseStamp !== null && releaseStamp !== undefined) {
      normalizedEntries.push([entityID, releaseStamp]);
    }
  }
  const releaseStampByID =
    generation.freshlyVisibleDynamicEntityReleaseStampByID instanceof Map
      ? generation.freshlyVisibleDynamicEntityReleaseStampByID
      : new Map();
  for (const [entityID, releaseStamp] of normalizedEntries) {
    deleteEntityIDFromMap(releaseStampByID, entityID);
    releaseStampByID.set(entityID, releaseStamp);
  }
  generation.freshlyVisibleDynamicEntityReleaseStampByID = releaseStampByID;
  return true;
}

function createVisibilityGenerationState(options = {}) {
  const releaseStampByID = new Map();
  if (options.freshlyVisibleDynamicEntityReleaseStampByID instanceof Map) {
    for (const [rawEntityID, releaseStamp] of
      options.freshlyVisibleDynamicEntityReleaseStampByID.entries()) {
      const entityID = getEntityMapKey(rawEntityID);
      if (entityID !== null) {
        releaseStampByID.set(entityID, releaseStamp);
      }
    }
  }
  const maxJournalEntries = Math.min(
    DEFAULT_JOURNAL_MAX_ENTRIES,
    Math.max(
      1,
      toInteger(
        options.maxJournalEntries,
        DEFAULT_JOURNAL_MAX_ENTRIES,
      ),
    ),
  );
  const sourceJournal = Array.isArray(options.visibilityJournal)
    ? options.visibilityJournal
    : [];
  const visibilityJournal = sourceJournal
    .slice(-maxJournalEntries)
    .map((entry) => (
      entry && typeof entry === "object" ? { ...entry } : entry
    ));
  return {
    freshlyVisibleDynamicEntityIDs: normalizeVisibilityEntityIDSet(
      options.freshlyVisibleDynamicEntityIDs,
    ),
    freshlyVisibleDynamicEntityReleaseStampByID: releaseStampByID,
    presentedEgoEntityID: getEntityMapKey(options.presentedEgoEntityID),
    visibilityJournal,
    visibilityJournalSeq: toInteger(options.visibilityJournalSeq, 0),
    visibleBubbleScopedStaticEntityIDs: normalizeVisibilityEntityIDSet(
      options.visibleBubbleScopedStaticEntityIDs,
    ),
    visibleDynamicEntityIDs: normalizeVisibilityEntityIDSet(
      options.visibleDynamicEntityIDs,
    ),
  };
}

function summarizeVisibilityIDs(values, maxIDs) {
  const ids = [...normalizeVisibilityEntityIDSet(values)];
  return {
    count: ids.length,
    ids: ids.slice(0, maxIDs),
    omitted: Math.max(0, ids.length - maxIDs),
  };
}

function normalizeVisibilityJournalDetails(details, maxIDs) {
  const normalized = details && typeof details === "object" ? { ...details } : {};
  for (const key of [
    "addedEntityIDs",
    "entityIDs",
    "removedEntityIDs",
    "desiredVisibleEntityIDs",
    "dynamicEntityIDs",
    "staticEntityIDs",
    "removedStaticEntityIDs",
    "addedStaticEntityIDs",
  ]) {
    if (Array.isArray(normalized[key]) || normalized[key] instanceof Set) {
      normalized[key] = summarizeVisibilityIDs(normalized[key], maxIDs);
    }
  }
  if (Array.isArray(normalized.entities)) {
    normalized.entities = summarizeVisibilityIDs(
      normalized.entities.map((entity) => entity && entity.itemID),
      maxIDs,
    );
  }
  return normalized;
}

function recordVisibilityJournal(session, event, details = {}, options = {}) {
  const generation = options.generation || (session && session._space);
  if (!session || !generation || session._space !== generation) {
    return null;
  }
  const maxEntries = Math.max(
    1,
    toInteger(options.maxEntries, DEFAULT_JOURNAL_MAX_ENTRIES),
  );
  const maxIDs = Math.max(0, toInteger(options.maxIDs, DEFAULT_JOURNAL_MAX_IDS));
  const normalizedDetails = normalizeVisibilityJournalDetails(details, maxIDs);
  const atMs = typeof options.now === "function" ? options.now() : Date.now();
  const nowMs = Number.isFinite(Number(normalizedDetails.nowMs))
    ? Number(normalizedDetails.nowMs)
    : atMs;
  const record = {
    seq: toInteger(generation.visibilityJournalSeq, 0) + 1,
    event,
    atMs,
    nowMs,
    destinyStamp: typeof options.getDestinyStamp === "function"
      ? options.getDestinyStamp(nowMs, session)
      : null,
    systemID: toInteger(generation.systemID, 0),
    shipID: getEntityMapKey(generation.shipID),
    characterID: getEntityMapKey(session.characterID || session.charID),
    ...normalizedDetails,
  };
  generation.visibilityJournalSeq = record.seq;
  if (!Array.isArray(generation.visibilityJournal)) {
    generation.visibilityJournal = [];
  }
  generation.visibilityJournal.push(record);
  if (generation.visibilityJournal.length > maxEntries) {
    generation.visibilityJournal.splice(
      0,
      generation.visibilityJournal.length - maxEntries,
    );
  }
  if (typeof options.recordSyncLedgerEvent === "function") {
    options.recordSyncLedgerEvent(session, `visibility.${event}`, {
      kind: "visibility",
      ...record,
    });
  }
  return record;
}

function createVisibilityJournalRecorder(options = {}) {
  const boundOptions = { ...options };
  return (session, event, details = {}) => recordVisibilityJournal(
    session,
    event,
    details,
    boundOptions,
  );
}

module.exports = {
  authorizeSceneVisibilityRemovalPresentation,
  clearCommittedVisibilityMembership,
  clearSameSceneDynamicClassification,
  commitCombinedVisibilityDelta,
  commitDynamicVisibilityDelta,
  commitInitialBallparkVisibility,
  commitSceneVisibilityRemovals,
  commitStaticVisibilityDelta,
  commitVisibilityAcquisitionMembership,
  createVisibilityGenerationState,
  createVisibilityJournalRecorder,
  getPlannedVisibleDynamicEntityIDs,
  getPlannedVisibleStaticEntityIDs,
  installFreshVisibilityReleaseEntries,
  isOwnedSceneVisibilityRemovalReservation,
  isSceneVisibilityAcquisitionCommitted,
  isSceneVisibilityRemovalPresentationAuthorized,
  normalizeVisibilityEntityIDSet,
  recordVisibilityJournal,
  reserveSceneVisibilityAcquisitions,
  reserveSceneVisibilityDelta,
  reserveSceneVisibilityRemovals,
  resolveVisibilityAcquisitionKind,
  visibilitySetHasEntityID,
};
