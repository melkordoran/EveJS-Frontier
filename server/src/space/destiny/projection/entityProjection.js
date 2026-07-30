"use strict";

const {
  entityIDsEqual,
  getEntityMapKey,
} = require("../identity/entityID");
const {
  projectEntityGraphToTime,
  projectEntityToTime,
} = require("./kinematics");
const {
  getCurrentDestinyStamp,
  getDestinyStampForwardBoundaryDeltaMs,
  normalizeDestinyStamp,
} = require("../delivery/stamps");

function magnitude(vector) {
  const x = Number(vector && vector.x) || 0;
  const y = Number(vector && vector.y) || 0;
  const z = Number(vector && vector.z) || 0;
  return Math.sqrt((x ** 2) + (y ** 2) + (z ** 2));
}

function toFiniteNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function cloneVector(source = null, fallback = { x: 0, y: 0, z: 0 }) {
  return {
    x: toFiniteNumber(source && source.x, fallback.x),
    y: toFiniteNumber(source && source.y, fallback.y),
    z: toFiniteNumber(source && source.z, fallback.z),
  };
}

function cloneDynamicEntityForDestinyPresentation(entity) {
  if (!entity || typeof entity !== "object") {
    return entity;
  }

  const clone = {
    ...entity,
    position: cloneVector(entity.position),
    velocity: cloneVector(entity.velocity),
    direction: cloneVector(entity.direction, { x: 1, y: 0, z: 0 }),
    targetPoint: cloneVector(entity.targetPoint, entity.position),
  };

  if (entity.warpState && typeof entity.warpState === "object") {
    clone.warpState = {
      ...entity.warpState,
      origin: cloneVector(entity.warpState.origin, entity.position),
      targetPoint: cloneVector(
        entity.warpState.targetPoint,
        entity.targetPoint || entity.position,
      ),
      direction: cloneVector(
        entity.warpState.direction,
        entity.direction || { x: 1, y: 0, z: 0 },
      ),
      entryPosition: cloneVector(
        entity.warpState.entryPosition,
        entity.position,
      ),
    };
  }

  if (entity.pendingWarp && typeof entity.pendingWarp === "object") {
    clone.pendingWarp = {
      ...entity.pendingWarp,
      origin: cloneVector(entity.pendingWarp.origin, entity.position),
      targetPoint: cloneVector(
        entity.pendingWarp.targetPoint,
        entity.targetPoint || entity.position,
      ),
      direction: cloneVector(
        entity.pendingWarp.direction,
        entity.direction || { x: 1, y: 0, z: 0 },
      ),
    };
  }

  if (
    entity.sessionlessWarpIngress &&
    typeof entity.sessionlessWarpIngress === "object"
  ) {
    clone.sessionlessWarpIngress = {
      ...entity.sessionlessWarpIngress,
      origin: cloneVector(
        entity.sessionlessWarpIngress.origin,
        entity.position,
      ),
      targetPoint: cloneVector(
        entity.sessionlessWarpIngress.targetPoint,
        entity.targetPoint || entity.position,
      ),
    };
  }

  return clone;
}

function buildDestinyPresentationForSession(options = {}) {
  const session = options.session || null;
  const entities = Array.isArray(options.entities) ? options.entities : [];
  const rawSimTimeMs = Math.max(0, Number(options.rawSimTimeMs) || 0);
  const getCurrentSessionSimTimeMs = options.getCurrentSessionSimTimeMs;
  const getStampForSimTime = options.getCurrentDestinyStamp;
  const getEntityByID = options.getEntityByID;
  const resolveEntityMapKey =
    typeof options.getEntityMapKey === "function"
      ? options.getEntityMapKey
      : getEntityMapKey;
  const cloneDynamicEntityForDestinyPresentation =
    options.cloneDynamicEntityForDestinyPresentation;
  const advanceMovement = options.advanceMovement;
  const isReadyForDestiny =
    typeof options.isReadyForDestiny === "function"
      ? options.isReadyForDestiny
      : () => true;
  const currentSessionSimTimeMs =
    typeof getCurrentSessionSimTimeMs === "function"
      ? getCurrentSessionSimTimeMs(session, rawSimTimeMs)
      : rawSimTimeMs;

  if (
    !session ||
    !isReadyForDestiny(session) ||
    entities.length === 0 ||
    typeof getStampForSimTime !== "function" ||
    typeof getEntityByID !== "function" ||
    typeof cloneDynamicEntityForDestinyPresentation !== "function" ||
    typeof advanceMovement !== "function"
  ) {
    return {
      entities,
      rawSimTimeMs,
      sessionSimTimeMs: currentSessionSimTimeMs,
    };
  }

  const currentSessionStamp = normalizeDestinyStamp(
    getStampForSimTime(currentSessionSimTimeMs),
    0,
  );
  const normalizedSessionStamp = normalizeDestinyStamp(
    options.sessionStamp,
    currentSessionStamp,
  );
  const presentationDeltaMs = getDestinyStampForwardBoundaryDeltaMs(
    currentSessionSimTimeMs,
    currentSessionStamp,
    normalizedSessionStamp,
    options.maximumForwardLead,
  );
  const presentationSessionSimTimeMs =
    currentSessionSimTimeMs + presentationDeltaMs;
  if (presentationDeltaMs <= 0.000001) {
    return {
      entities,
      rawSimTimeMs,
      sessionSimTimeMs: presentationSessionSimTimeMs,
    };
  }

  const presentationRawSimTimeMs = rawSimTimeMs + presentationDeltaMs;
  const projection = projectEntityGraphToTime({
    entities,
    baseSimTimeMs: rawSimTimeMs,
    targetSimTimeMs: presentationRawSimTimeMs,
    getEntityByID,
    getEntityMapKey: resolveEntityMapKey,
    cloneEntity: cloneDynamicEntityForDestinyPresentation,
    advanceMovement,
    nativeSubwarpController: options.nativeSubwarpController,
    nativeSubwarpFrame: options.nativeSubwarpFrame,
    nativeSubwarpSceneEntitiesOwner:
      options.nativeSubwarpSceneEntitiesOwner,
    maxProjectionDepth: 2,
    maxProjectionStepMs: options.maxProjectionStepMs,
    maxProjectionSteps: options.maxProjectionSteps,
    shouldAdvance: (projectedEntity) => (
      !projectedEntity.sessionlessWarpIngress &&
      !projectedEntity.pendingDock
    ),
  });

  if (projection.complete !== true) {
    return {
      entities,
      rawSimTimeMs,
      sessionSimTimeMs: currentSessionSimTimeMs,
    };
  }

  return {
    entities: projection.entities,
    rawSimTimeMs: presentationRawSimTimeMs,
    sessionSimTimeMs: presentationSessionSimTimeMs,
  };
}

function projectEntityForDestinyStamp(options = {}) {
  const entity = options.entity;
  const advanceMovement = options.advanceMovement;
  const cloneDynamicEntityForDestinyPresentation =
    options.cloneDynamicEntityForDestinyPresentation;
  if (
    !entity ||
    typeof advanceMovement !== "function" ||
    typeof cloneDynamicEntityForDestinyPresentation !== "function"
  ) {
    return entity;
  }

  const rawNowMs = Math.max(0, Number(options.rawNowMs) || 0);
  const hasAuthoredCurrentSimTime =
    options.currentSimTimeMs !== null &&
    options.currentSimTimeMs !== undefined &&
    Number.isFinite(Number(options.currentSimTimeMs));
  const currentSimTimeMs = hasAuthoredCurrentSimTime
    ? Number(options.currentSimTimeMs)
    : rawNowMs;
  const currentStamp = normalizeDestinyStamp(
    options.currentStamp,
    getCurrentDestinyStamp(currentSimTimeMs),
  );
  const targetStamp = normalizeDestinyStamp(options.stamp, currentStamp);
  const projectionDeltaMs = getDestinyStampForwardBoundaryDeltaMs(
    currentSimTimeMs,
    currentStamp,
    targetStamp,
    options.maximumForwardLead,
  );
  const targetRawSimTimeMs = rawNowMs + projectionDeltaMs;
  if (
    targetRawSimTimeMs <= rawNowMs + 0.000001 ||
    entity.sessionlessWarpIngress ||
    entity.pendingDock
  ) {
    return cloneDynamicEntityForDestinyPresentation(entity);
  }

  const scene =
    options.scene && typeof options.scene === "object"
      ? options.scene
      : {
          getEntityByID() {
            return null;
          },
        };
  return projectEntityToTime({
    entity,
    baseSimTimeMs: rawNowMs,
    targetSimTimeMs: targetRawSimTimeMs,
    scene,
    getEntityByID: (entityID) => (
      typeof scene.getEntityByID === "function"
        ? scene.getEntityByID(entityID)
        : null
    ),
    getEntityMapKey: options.getEntityMapKey || getEntityMapKey,
    cloneEntity: cloneDynamicEntityForDestinyPresentation,
    advanceMovement,
    nativeSubwarpController: options.nativeSubwarpController,
    nativeSubwarpFrame: options.nativeSubwarpFrame,
    nativeSubwarpSceneEntitiesOwner:
      options.nativeSubwarpSceneEntitiesOwner !== undefined
        ? options.nativeSubwarpSceneEntitiesOwner
        : (
            scene && scene.dynamicEntities instanceof Map
              ? scene.dynamicEntities
              : undefined
          ),
    maxProjectionDepth: options.maxProjectionDepth,
    maxProjectionStepMs: options.maxProjectionStepMs,
    maxProjectionSteps: options.maxProjectionSteps,
    shouldAdvance: (projected) => (
      !projected.sessionlessWarpIngress &&
      !projected.pendingDock
    ),
  });
}

function rebuildKinematicUpdatesForProjectedStamp(options = {}) {
  const updates = Array.isArray(options.updates) ? options.updates : [];
  const entity = options.entity;
  const destiny = options.destiny;
  if (
    !entity ||
    updates.length === 0 ||
    !destiny ||
    typeof destiny.buildSetBallVelocityPayload !== "function"
  ) {
    return updates;
  }
  const hasProjectionClock = [
    options.rawNowMs,
    options.currentSimTimeMs,
    options.currentStamp,
  ].some((value) => (
    value !== null &&
    value !== undefined &&
    Number.isFinite(Number(value))
  ));
  if (!hasProjectionClock) {
    return updates;
  }

  const entityID = getEntityMapKey(entity.itemID);
  if (entityID === null) {
    return updates;
  }

  const stopVelocitySeedStamps = new Set();
  for (const update of updates) {
    const payload = update && Array.isArray(update.payload) ? update.payload : null;
    const args = payload && Array.isArray(payload[1]) ? payload[1] : null;
    if (
      !payload ||
      payload[0] !== "Stop" ||
      !entityIDsEqual(args && args[0], entityID)
    ) {
      continue;
    }
    stopVelocitySeedStamps.add(normalizeDestinyStamp(update && update.stamp, 0));
  }

  const projectedByStamp = new Map();
  let changed = false;
  const rewrittenUpdates = updates.map((update) => {
    const payload = update && Array.isArray(update.payload) ? update.payload : null;
    const args = payload && Array.isArray(payload[1]) ? payload[1] : null;
    const payloadEntityID =
      payload && payload[0] === "SetBallVelocity"
        ? getEntityMapKey(args && args[0])
        : null;
    if (!entityIDsEqual(payloadEntityID, entityID)) {
      return update;
    }

    const stamp = normalizeDestinyStamp(update && update.stamp, 0);
    let projectedEntity = projectedByStamp.get(stamp);
    if (!projectedEntity) {
      projectedEntity = projectEntityForDestinyStamp({
        entity,
        scene: options.scene,
        advanceMovement: options.advanceMovement,
        nativeSubwarpController: options.nativeSubwarpController,
        nativeSubwarpFrame: options.nativeSubwarpFrame,
        cloneDynamicEntityForDestinyPresentation:
          options.cloneDynamicEntityForDestinyPresentation,
        rawNowMs: options.rawNowMs,
        currentSimTimeMs: options.currentSimTimeMs,
        currentStamp: options.currentStamp,
        stamp,
      });
      projectedByStamp.set(stamp, projectedEntity);
    }
    const projectedVelocity = projectedEntity && projectedEntity.velocity;
    // A Stop packet seeds the client's deceleration with the ball's actual
    // command-time velocity. Pre-decelerating or substituting direction here
    // creates the visible jolt captured by the client stop golden.
    const stopSeedVelocity = stopVelocitySeedStamps.has(stamp)
      ? (
        magnitude(entity.velocity) <= 0.000001
          ? { x: 0, y: 0, z: 0 }
          : { x: entity.velocity.x, y: entity.velocity.y, z: entity.velocity.z }
      )
      : projectedVelocity;
    changed = true;
    return {
      ...update,
      payload: destiny.buildSetBallVelocityPayload(
        entityID,
        stopSeedVelocity,
      ),
    };
  });

  return changed ? rewrittenUpdates : updates;
}

const rebuildOwnerKinematicUpdatesForProjectedStamp =
  rebuildKinematicUpdatesForProjectedStamp;

module.exports = {
  buildDestinyPresentationForSession,
  projectEntityForDestinyStamp,
  rebuildKinematicUpdatesForProjectedStamp,
  rebuildOwnerKinematicUpdatesForProjectedStamp,
};

Object.defineProperty(
  module.exports,
  "cloneDynamicEntityForDestinyPresentation",
  {
    value: cloneDynamicEntityForDestinyPresentation,
    enumerable: false,
  },
);
