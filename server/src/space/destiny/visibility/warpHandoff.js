"use strict";

const {
  entityIDsEqual,
  getEntityMapKey,
  normalizeEntityID,
} = require("../identity/entityID");

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function toFiniteNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function normalizeSet(value) {
  const result = new Set();
  const entries = value instanceof Set
    ? value
    : Array.isArray(value)
      ? value
      : [];
  for (const entry of entries) {
    const entityID = getEntityMapKey(entry);
    if (entityID !== null) {
      result.add(entityID);
    }
  }
  return result;
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function getEntityID(entity) {
  return getEntityMapKey(entity && entity.itemID);
}

function clearPilotWarpVisibilityHandoff(session) {
  if (session && session._space) {
    session._space.pilotWarpVisibilityHandoff = null;
  }
}

function beginPilotWarpVisibilityHandoff(options = {}) {
  const entity = options.entity && typeof options.entity === "object"
    ? options.entity
    : null;
  const warpState = options.warpState && typeof options.warpState === "object"
    ? options.warpState
    : null;
  const session = entity && entity.session;
  if (!session || !session._space || !entity || !warpState) {
    return null;
  }

  const getVisibilityPublicGridKeyForEntity =
    typeof options.getVisibilityPublicGridKeyForEntity === "function"
      ? options.getVisibilityPublicGridKeyForEntity
      : () => "";
  const getVisibilityPublicGridClusterKeyForEntity =
    typeof options.getVisibilityPublicGridClusterKeyForEntity === "function"
      ? options.getVisibilityPublicGridClusterKeyForEntity
      : () => "";
  const getPublicGridClusterKeyForPosition =
    typeof options.getPublicGridClusterKeyForPosition === "function"
      ? options.getPublicGridClusterKeyForPosition
      : () => "";
  const buildPublicGridKey =
    typeof options.buildPublicGridKey === "function"
      ? options.buildPublicGridKey
      : () => "";

  const sourcePublicGridKey = getVisibilityPublicGridKeyForEntity(entity);
  const sourceClusterKey = getVisibilityPublicGridClusterKeyForEntity(entity);
  const destinationPoint =
    warpState.targetPoint || warpState.rawDestination || entity.position;
  const destinationClusterKey =
    getPublicGridClusterKeyForPosition(destinationPoint);
  const handoff = {
    shipID: getEntityMapKey(entity.itemID),
    sourcePublicGridKey,
    sourceClusterKey,
    destinationPublicGridKey: buildPublicGridKey(destinationPoint || null),
    destinationClusterKey,
    currentPublicGridKey: sourcePublicGridKey,
    currentPublicGridClusterKey: sourceClusterKey,
    destinationStaticInstanceID:
      normalizeEntityID(warpState && warpState.destinationStaticInstanceID),
    sourceRemoved: false,
    destinationStaticJoined: false,
    destinationJoined: false,
    destinationPrewarmed: false,
  };
  session._space.pilotWarpVisibilityHandoff = handoff;
  return handoff;
}

function buildPilotWarpVisibilityHandoffReadiness(options = {}) {
  const entity = options.entity && typeof options.entity === "object"
    ? options.entity
    : null;
  const handoff = options.handoff && typeof options.handoff === "object"
    ? options.handoff
    : null;
  if (!entity || !entity.warpState || !handoff) {
    return {
      active: false,
    };
  }

  const nowMs = toFiniteNumber(options.nowMs, 0);
  const hasWarpPhaseNowMs =
    options.warpPhaseNowMs !== null &&
    options.warpPhaseNowMs !== undefined &&
    Number.isFinite(Number(options.warpPhaseNowMs));
  const warpPhaseNowMs = hasWarpPhaseNowMs
    ? Number(options.warpPhaseNowMs)
    : nowMs;
  const warpStartTimeMs = toFiniteNumber(
    entity.warpState && entity.warpState.startTimeMs,
    nowMs,
  );
  const warpEffectAtMs = toFiniteNumber(
    entity.warpState && entity.warpState.effectAtMs,
    0,
  );
  const warpEffectStamp = toInt(
    entity.warpState && entity.warpState.effectStamp,
    0,
  );
  const warpEffectActive =
    warpEffectStamp >= 0 &&
    (
      warpEffectAtMs <= 0 ||
      nowMs >= warpEffectAtMs
    );
  if (!warpEffectActive) {
    return {
      active: false,
      nowMs,
      warpEffectAtMs,
      warpEffectStamp,
    };
  }

  const getPilotClientWarpVisualActivationAtMs =
    typeof options.getPilotClientWarpVisualActivationAtMs === "function"
      ? options.getPilotClientWarpVisualActivationAtMs
      : () => 0;
  const getWarpPhaseName =
    typeof options.getWarpPhaseName === "function"
      ? options.getWarpPhaseName
      : () => "complete";
  const getLivePublicGridKeyForEntity =
    typeof options.getLivePublicGridKeyForEntity === "function"
      ? options.getLivePublicGridKeyForEntity
      : () => "";
  const getLivePublicGridClusterKeyForEntity =
    typeof options.getLivePublicGridClusterKeyForEntity === "function"
      ? options.getLivePublicGridClusterKeyForEntity
      : () => "";
  const getPublicGridClusterKeyForPosition =
    typeof options.getPublicGridClusterKeyForPosition === "function"
      ? options.getPublicGridClusterKeyForPosition
      : () => "";
  const buildPublicGridKey =
    typeof options.buildPublicGridKey === "function"
      ? options.buildPublicGridKey
      : () => "";
  const distance =
    typeof options.distance === "function"
      ? options.distance
      : () => 0;

  // A modeled phase timestamp represents Carbon's native RealWarp clock and
  // is anchored to its activation epoch. `effectAtMs` remains an outbound
  // presentation gate only. Calls without the modeled refinement retain the
  // exact John handoff behavior.
  const effectiveWarpStartMs = hasWarpPhaseNowMs
    ? warpStartTimeMs
    : warpEffectAtMs > warpStartTimeMs ? warpEffectAtMs : warpStartTimeMs;
  const clientVisualActivationAtMs = Math.max(
    0,
    toFiniteNumber(getPilotClientWarpVisualActivationAtMs(entity), 0),
  );
  const clientWarpVisualActive =
    clientVisualActivationAtMs <= 0 ||
    nowMs + 0.001 >= clientVisualActivationAtMs;
  const sourceRemovalSettleMs = Math.max(
    0,
    toFiniteNumber(options.sourceRemovalSettleMs, 0),
  );
  const clientWarpSourceRemovalSettled =
    clientVisualActivationAtMs <= 0 ||
    nowMs + 0.001 >=
      (clientVisualActivationAtMs + sourceRemovalSettleMs);
  const elapsedMs = Math.max(
    0,
    warpPhaseNowMs - effectiveWarpStartMs,
  );
  const warpPhase = getWarpPhaseName(entity.warpState, elapsedMs);
  const livePublicGridKey = getLivePublicGridKeyForEntity(entity);
  const liveClusterKey = getLivePublicGridClusterKeyForEntity(entity);
  const sourcePublicGridKey = String(
    handoff.sourcePublicGridKey || "",
  ).trim();
  const sourceClusterKey = String(handoff.sourceClusterKey || "").trim();
  const sourcePublicGridLeft = Boolean(
    sourcePublicGridKey &&
      String(livePublicGridKey || "").trim() !== sourcePublicGridKey,
  );
  const sourceClusterLeft = Boolean(
    sourceClusterKey &&
      String(liveClusterKey || "").trim() !== sourceClusterKey,
  );
  const sourceHandoffReady = Boolean(
    clientWarpSourceRemovalSettled &&
      (
        sourcePublicGridLeft ||
        sourceClusterLeft
      ),
  );
  const destinationPoint =
    (entity.warpState && (
      entity.warpState.targetPoint ||
      entity.warpState.rawDestination
    )) ||
    entity.position;
  const destinationPublicGridKey = String(
    handoff.destinationPublicGridKey ||
    buildPublicGridKey(destinationPoint || null) ||
    "",
  ).trim();
  const destinationClusterKey = String(
    getPublicGridClusterKeyForPosition(destinationPoint) ||
    handoff.destinationClusterKey ||
    "",
  ).trim();
  const destinationStaticInstanceID = normalizeEntityID(
    handoff.destinationStaticInstanceID,
  );
  const destinationPublicGridEntered = Boolean(
    destinationPublicGridKey &&
      String(livePublicGridKey || "").trim() === destinationPublicGridKey,
  );
  const destinationClusterEntered = Boolean(
    destinationClusterKey &&
      String(liveClusterKey || "").trim() === destinationClusterKey,
  );
  const destinationDistanceMeters = distance(
    entity.position,
    destinationPoint,
  );
  const staticPreloadDistanceMeters = Math.max(
    0,
    toFiniteNumber(options.destinationStaticPreloadDistanceMeters, 0),
  );
  const destinationDedicatedStaticCompleteReady = Boolean(
    destinationStaticInstanceID !== null &&
      warpPhase === "complete" &&
      destinationClusterKey &&
      (
        destinationPublicGridEntered ||
        destinationClusterEntered ||
        destinationDistanceMeters <= staticPreloadDistanceMeters
      ),
  );
  const destinationStaticPreloadReady = Boolean(
    warpPhase === "decel" &&
      destinationDistanceMeters <= staticPreloadDistanceMeters,
  );
  // Warm the destination controllers throughout deceleration without exposing
  // their balls. TQ uses this window to assemble one complete destination
  // snapshot, then acquires statics and dynamics together near landing.
  const destinationControllerPrewarmReady = Boolean(
    destinationClusterKey && warpPhase === "decel",
  );
  const destinationPublicGridPreloadReady = Boolean(
    destinationStaticInstanceID === null &&
      destinationClusterKey &&
      warpPhase === "decel" &&
      destinationDistanceMeters <= staticPreloadDistanceMeters,
  );
  const destinationHandoffReady = Boolean(
    warpPhase === "decel" &&
      (
        destinationPublicGridEntered ||
        destinationClusterEntered
      ),
  );
  const destinationStaticHandoffReady = Boolean(
    destinationHandoffReady ||
      destinationStaticPreloadReady ||
      destinationPublicGridPreloadReady ||
      (
        destinationStaticInstanceID !== null &&
        destinationClusterKey &&
        (
          warpPhase === "decel" ||
          destinationDedicatedStaticCompleteReady
        )
      ),
  );
  const destinationDynamicHandoffReady = Boolean(
    (
      destinationHandoffReady ||
        destinationPublicGridPreloadReady
    ) &&
    (
      handoff.sourceRemoved === true ||
      sourceHandoffReady ||
      destinationHandoffReady
    ),
  );
  const liveGridClusterKey = String(liveClusterKey || "").trim();
  const lastJoinedGridClusterKey = String(
    handoff.currentPublicGridClusterKey ||
    handoff.sourceClusterKey ||
    "",
  ).trim();
  const liveGridChanged = Boolean(
    liveGridClusterKey &&
      liveGridClusterKey !== lastJoinedGridClusterKey,
  );
  const liveGridIsDestinationCluster = Boolean(
    destinationClusterKey &&
      liveGridClusterKey &&
      liveGridClusterKey === destinationClusterKey,
  );
  const liveGridVisibilityReady = Boolean(
    clientWarpVisualActive &&
      liveGridChanged &&
      !liveGridIsDestinationCluster &&
      !destinationStaticHandoffReady &&
      !destinationDynamicHandoffReady &&
      (
        handoff.sourceRemoved === true ||
        sourceHandoffReady ||
        destinationHandoffReady
      ),
  );

  return {
    active: true,
    nowMs,
    warpPhaseNowMs,
    warpStartTimeMs,
    warpEffectAtMs,
    warpEffectStamp,
    effectiveWarpStartMs,
    clientVisualActivationAtMs,
    clientWarpVisualActive,
    clientWarpSourceRemovalSettled,
    elapsedMs,
    warpPhase,
    livePublicGridKey,
    liveClusterKey,
    sourcePublicGridKey,
    sourceClusterKey,
    sourcePublicGridLeft,
    sourceClusterLeft,
    sourceHandoffReady,
    destinationPoint,
    destinationPublicGridKey,
    destinationClusterKey,
    destinationStaticInstanceID,
    destinationPublicGridEntered,
    destinationClusterEntered,
    destinationDistanceMeters,
    destinationControllerPrewarmReady,
    destinationDedicatedStaticCompleteReady,
    destinationStaticPreloadReady,
    destinationPublicGridPreloadReady,
    destinationHandoffReady,
    destinationStaticHandoffReady,
    destinationDynamicHandoffReady,
    bubbleGateDestinationAcquire: destinationStaticInstanceID !== null,
    liveGridClusterKey,
    lastJoinedGridClusterKey,
    liveGridChanged,
    liveGridIsDestinationCluster,
    liveGridVisibilityReady,
  };
}

function buildWarpSourceRemovalPlan(options = {}) {
  const currentDynamicIDs = normalizeSet(options.currentDynamicIDs);
  const currentStaticIDs = normalizeSet(options.currentStaticIDs);
  const getDynamicEntityByID =
    typeof options.getDynamicEntityByID === "function"
      ? options.getDynamicEntityByID
      : () => null;
  const isFleetWarpFormationCompanionForSession =
    typeof options.isFleetWarpFormationCompanionForSession === "function"
      ? options.isFleetWarpFormationCompanionForSession
      : () => false;
  const hasStaticEntityID =
    typeof options.hasStaticEntityID === "function"
      ? options.hasStaticEntityID
      : () => true;
  const shouldPreserveStaticID =
    typeof options.shouldPreserveStaticID === "function"
      ? options.shouldPreserveStaticID
      : () => false;
  const shouldPreserveDynamicID =
    typeof options.shouldPreserveDynamicID === "function"
      ? options.shouldPreserveDynamicID
      : () => false;
  const session = options.session || null;
  const nowMs = toFiniteNumber(options.nowMs, 0);

  const removedDynamicIDs = [];
  const nextVisibleDynamicIDs = new Set(currentDynamicIDs);
  const freshDynamicIDsToDelete = new Set();
  for (const entityID of currentDynamicIDs) {
    const candidate = getDynamicEntityByID(entityID);
    if (
      !isFleetWarpFormationCompanionForSession(
        session,
        candidate,
        nowMs,
      ) &&
      !shouldPreserveDynamicID(entityID, candidate)
    ) {
      removedDynamicIDs.push(entityID);
      nextVisibleDynamicIDs.delete(entityID);
      freshDynamicIDsToDelete.add(entityID);
    }
  }

  for (const entityID of nextVisibleDynamicIDs) {
    const candidate = getDynamicEntityByID(entityID);
    if (
      isFleetWarpFormationCompanionForSession(
        session,
        candidate,
        nowMs,
      )
    ) {
      freshDynamicIDsToDelete.add(entityID);
    }
  }

  const removedStaticIDs = [];
  const nextVisibleStaticIDs = new Set(currentStaticIDs);
  for (const entityID of currentStaticIDs) {
    if (!hasStaticEntityID(entityID)) {
      continue;
    }
    if (shouldPreserveStaticID(entityID)) {
      continue;
    }
    removedStaticIDs.push(entityID);
    nextVisibleStaticIDs.delete(entityID);
  }

  return {
    freshDynamicIDsToDelete,
    nextVisibleDynamicIDs,
    nextVisibleStaticIDs,
    removedDynamicIDs,
    removedStaticIDs,
  };
}

function buildWarpLiveGridDynamicRefreshPlan(options = {}) {
  const liveDynamicDelta = options.liveDynamicDelta &&
    typeof options.liveDynamicDelta === "object"
      ? options.liveDynamicDelta
      : null;
  if (!liveDynamicDelta) {
    return {
      addedDynamicEntities: [],
      freshDynamicIDs: new Set(),
      nextVisibleDynamicIDs: new Set(),
      removedDynamicIDs: [],
    };
  }

  const formationRefreshEntityIDs = new Set(
    normalizeArray(options.formationRefreshEntities)
      .map((candidate) => getEntityID(candidate))
      .filter((entityID) => entityID !== null),
  );
  const removedDynamicIDs = normalizeArray(liveDynamicDelta.removedIDs)
    .map((entityID) => getEntityMapKey(entityID))
    .filter((entityID) => (
      entityID !== null && !formationRefreshEntityIDs.has(entityID)
    ));
  const addedDynamicEntities = normalizeArray(liveDynamicDelta.addedEntities)
    .filter((candidate) => !formationRefreshEntityIDs.has(getEntityID(candidate)));
  const currentIDs = normalizeSet(liveDynamicDelta.currentIDs);
  const nextVisibleDynamicIDs = new Set();
  for (const entityID of normalizeSet(liveDynamicDelta.desiredIDs)) {
    if (
      formationRefreshEntityIDs.has(entityID) &&
      !currentIDs.has(entityID)
    ) {
      continue;
    }
    nextVisibleDynamicIDs.add(entityID);
  }

  return {
    addedDynamicEntities,
    freshDynamicIDs: new Set(
      addedDynamicEntities
        .map((visibleEntity) => getEntityID(visibleEntity))
        .filter((entityID) => entityID !== null),
    ),
    nextVisibleDynamicIDs,
    removedDynamicIDs,
  };
}

function buildWarpLiveGridStaticRefreshPlan(options = {}) {
  const currentStaticIDs = normalizeSet(options.currentStaticIDs);
  const liveStaticEntities = normalizeArray(options.liveStaticEntities);
  const hasStaticEntityID =
    typeof options.hasStaticEntityID === "function"
      ? options.hasStaticEntityID
      : () => true;
  const shouldPreserveStaticID =
    typeof options.shouldPreserveStaticID === "function"
      ? options.shouldPreserveStaticID
      : () => false;

  const desiredStaticIDs = new Set();
  for (const visibleEntity of liveStaticEntities) {
    const entityID = getEntityID(visibleEntity);
    if (entityID !== null && hasStaticEntityID(entityID)) {
      desiredStaticIDs.add(entityID);
    }
  }

  const removedStaticIDs = [...currentStaticIDs].filter((entityID) => (
    !desiredStaticIDs.has(entityID) &&
    !shouldPreserveStaticID(entityID)
  ));
  const addedStaticEntities = liveStaticEntities.filter((visibleEntity) => (
    !currentStaticIDs.has(getEntityID(visibleEntity))
  ));
  const nextVisibleStaticIDs = new Set(desiredStaticIDs);
  for (const entityID of currentStaticIDs) {
    if (shouldPreserveStaticID(entityID)) {
      nextVisibleStaticIDs.add(entityID);
    }
  }

  return {
    addedStaticEntities,
    nextVisibleStaticIDs,
    removedStaticIDs,
  };
}

function buildWarpDestinationStaticAcquisitionPlan(options = {}) {
  const currentIDs = normalizeSet(options.currentStaticIDs);
  if (options.enabled !== true) {
    return {
      addedStaticEntities: [],
      desiredStaticIDs: new Set(),
      nextVisibleStaticIDs: currentIDs,
      removedStaticIDs: [],
    };
  }

  const destinationStaticEntities = normalizeArray(options.destinationStaticEntities);
  const shouldPreserveStaticID =
    typeof options.shouldPreserveStaticID === "function"
      ? options.shouldPreserveStaticID
      : () => false;
  const desiredStaticIDs = new Set(
    destinationStaticEntities
      .map((visibleEntity) => getEntityID(visibleEntity))
      .filter((entityID) => entityID !== null),
  );
  const addedStaticEntities = destinationStaticEntities.filter((visibleEntity) => {
    const entityID = getEntityID(visibleEntity);
    return entityID !== null && !currentIDs.has(entityID);
  });
  const removedStaticIDs = [...currentIDs].filter((entityID) => (
    !desiredStaticIDs.has(entityID) &&
    !shouldPreserveStaticID(entityID)
  ));
  const nextVisibleStaticIDs = new Set(
    [...currentIDs].filter((entityID) => shouldPreserveStaticID(entityID)),
  );
  for (const entityID of desiredStaticIDs) {
    nextVisibleStaticIDs.add(entityID);
  }

  return {
    addedStaticEntities,
    desiredStaticIDs,
    nextVisibleStaticIDs,
    removedStaticIDs,
  };
}

function isWarpDestinationStaticPreserved(options = {}) {
  const staticEntity = options.staticEntity && typeof options.staticEntity === "object"
    ? options.staticEntity
    : null;
  if (!staticEntity) {
    return false;
  }

  const destinationStaticInstanceID = normalizeEntityID(
    options.destinationStaticInstanceID,
  );
  if (
    destinationStaticInstanceID !== null &&
    entityIDsEqual(
      staticEntity.dungeonSiteInstanceID,
      destinationStaticInstanceID,
    )
  ) {
    return true;
  }

  const handoff = options.handoff && typeof options.handoff === "object"
    ? options.handoff
    : null;
  if (!handoff || handoff.destinationStaticJoined !== true) {
    return false;
  }

  const destinationClusterKey = String(
    options.destinationClusterKey || "",
  ).trim();
  const getPublicGridClusterKeyForEntity =
    typeof options.getPublicGridClusterKeyForEntity === "function"
      ? options.getPublicGridClusterKeyForEntity
      : () => "";
  const getPublicGridClusterKeyForPosition =
    typeof options.getPublicGridClusterKeyForPosition === "function"
      ? options.getPublicGridClusterKeyForPosition
      : () => "";
  const staticClusterKey = String(
    getPublicGridClusterKeyForEntity(staticEntity) ||
      getPublicGridClusterKeyForPosition(staticEntity.position) ||
      "",
  ).trim();
  if (
    destinationClusterKey &&
    staticClusterKey &&
    staticClusterKey === destinationClusterKey
  ) {
    return true;
  }

  if (!staticEntity.position || typeof staticEntity.position !== "object") {
    return false;
  }

  const distance =
    typeof options.distance === "function"
      ? options.distance
      : () => Infinity;
  const bubbleRadiusMeters = Math.max(
    0,
    toFiniteNumber(options.bubbleRadiusMeters, 0),
  );
  return distance(staticEntity.position, options.destinationPoint) <=
    bubbleRadiusMeters;
}

function buildWarpDestinationAcquireIntent(options = {}) {
  const handoff = options.handoff && typeof options.handoff === "object"
    ? options.handoff
    : {};
  const destinationClusterKey = String(
    options.destinationClusterKey || "",
  ).trim();
  const shouldAcquireDestinationStatic = Boolean(
    !handoff.destinationStaticJoined &&
      destinationClusterKey &&
      options.destinationStaticHandoffReady === true,
  );
  const shouldAcquireDestinationDynamic = Boolean(
    !handoff.destinationJoined &&
      destinationClusterKey &&
      options.destinationDynamicHandoffReady === true,
  );

  return {
    shouldAcquireDestinationDynamic,
    shouldAcquireDestinationStatic,
  };
}

function buildWarpDestinationAcquirePlan(options = {}) {
  const intent = buildWarpDestinationAcquireIntent(options);
  const destinationStaticPlan = buildWarpDestinationStaticAcquisitionPlan({
    enabled: intent.shouldAcquireDestinationStatic,
    destinationStaticEntities: options.destinationStaticEntities,
    currentStaticIDs: options.currentStaticIDs,
    shouldPreserveStaticID: options.shouldPreserveStaticID,
  });
  const destinationDynamicPlan = buildWarpDestinationDynamicRefreshPlan({
    destinationDelta: intent.shouldAcquireDestinationDynamic
      ? options.destinationDelta
      : null,
    formationRefreshEntities: options.formationRefreshEntities,
    currentDynamicIDs: options.currentDynamicIDs,
  });
  const destinationSnapshotEntities = [
    ...destinationStaticPlan.addedStaticEntities,
    ...destinationDynamicPlan.destinationRefreshEntities,
  ];

  return {
    destinationDynamicPlan,
    destinationSnapshotEntities,
    destinationStaticPlan,
    shouldAcquireDestinationDynamic: intent.shouldAcquireDestinationDynamic,
    shouldAcquireDestinationStatic: intent.shouldAcquireDestinationStatic,
  };
}

function isDeferredFleetWarpCompanion(entity, deferredFormationCompanionIDs) {
  const entityID = getEntityID(entity);
  if (deferredFormationCompanionIDs.has(entityID)) {
    return true;
  }
  // Fleet-warp companions must stay on their native warp/landing presentation
  // lane. Re-adding them through the pilot handoff AddBalls path while the
  // player is still in tunnel creates split-wave despawns and broken warp-ins.
  return Boolean(
    entity &&
      (
        entity.mode === "WARP" ||
        entity.pendingWarp ||
        entity.warpState
      ),
  );
}

function buildWarpDestinationDynamicRefreshPlan(options = {}) {
  const destinationDelta = options.destinationDelta &&
    typeof options.destinationDelta === "object"
      ? options.destinationDelta
      : null;
  const currentIDs = normalizeSet(options.currentDynamicIDs);
  if (!destinationDelta) {
    return {
      destinationRefreshEntities: [],
      freshDynamicIDs: new Set(),
      nextVisibleDynamicIDs: currentIDs,
    };
  }

  const deferredFormationCompanionIDs = new Set(
    normalizeArray(options.formationRefreshEntities)
      .map((candidate) => getEntityID(candidate))
      .filter((entityID) => entityID !== null),
  );
  const destinationRefreshEntities = normalizeArray(destinationDelta.addedEntities)
    .filter((candidate) => !isDeferredFleetWarpCompanion(
      candidate,
      deferredFormationCompanionIDs,
    ));
  const nextVisibleDynamicIDs = new Set(currentIDs);
  const freshDynamicIDs = new Set();
  for (const visibleEntity of destinationRefreshEntities) {
    const entityID = getEntityID(visibleEntity);
    if (entityID !== null) {
      nextVisibleDynamicIDs.add(entityID);
      freshDynamicIDs.add(entityID);
    }
  }

  return {
    destinationRefreshEntities,
    freshDynamicIDs,
    nextVisibleDynamicIDs,
  };
}

module.exports = {
  beginPilotWarpVisibilityHandoff,
  buildPilotWarpVisibilityHandoffReadiness,
  buildWarpDestinationAcquireIntent,
  buildWarpDestinationAcquirePlan,
  buildWarpDestinationDynamicRefreshPlan,
  buildWarpDestinationStaticAcquisitionPlan,
  buildWarpLiveGridDynamicRefreshPlan,
  buildWarpLiveGridStaticRefreshPlan,
  buildWarpSourceRemovalPlan,
  clearPilotWarpVisibilityHandoff,
  isDeferredFleetWarpCompanion,
  isWarpDestinationStaticPreserved,
};
