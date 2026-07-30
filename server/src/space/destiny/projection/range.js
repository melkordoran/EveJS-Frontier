"use strict";

const {
  projectEntityGraphToTime,
} = require("./kinematics");
const {
  getEntityMapKey: getCanonicalEntityMapKey,
} = require("../identity/entityID");

const DEFAULT_MAX_COMMAND_PROJECTION_STEP_MS = 250;
const DEFAULT_MAX_COMMAND_PROJECTION_STEPS = 240;

function toFiniteNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function magnitude(vector) {
  const x = toFiniteNumber(vector && vector.x, 0);
  const y = toFiniteNumber(vector && vector.y, 0);
  const z = toFiniteNumber(vector && vector.z, 0);
  return Math.sqrt((x * x) + (y * y) + (z * z));
}

function subtractVectors(left, right) {
  return {
    x: toFiniteNumber(left && left.x, 0) - toFiniteNumber(right && right.x, 0),
    y: toFiniteNumber(left && left.y, 0) - toFiniteNumber(right && right.y, 0),
    z: toFiniteNumber(left && left.z, 0) - toFiniteNumber(right && right.z, 0),
  };
}

function getEntityTargetingRadius(entity) {
  return Math.max(0, toFiniteNumber(entity && entity.radius, 0));
}

function getEntitySurfaceDistance(sourceEntity, targetEntity) {
  if (!sourceEntity || !targetEntity) {
    return Infinity;
  }

  return Math.max(
    0,
    magnitude(subtractVectors(
      targetEntity && targetEntity.position,
      sourceEntity && sourceEntity.position,
    )) -
      getEntityTargetingRadius(sourceEntity) -
      getEntityTargetingRadius(targetEntity),
  );
}

function normalizeScene(options = {}) {
  return options.scene && typeof options.scene === "object"
    ? options.scene
    : {};
}

function resolveSceneBaseSimTimeMs(scene, options = {}) {
  const authoredBaseSimTimeMs = options.sceneBaseSimTimeMs;
  const fallbackBaseSimTimeMs = toFiniteNumber(scene && scene.simTimeMs, 0);
  return Math.max(
    0,
    authoredBaseSimTimeMs === null || authoredBaseSimTimeMs === undefined
      ? fallbackBaseSimTimeMs
      : toFiniteNumber(authoredBaseSimTimeMs, fallbackBaseSimTimeMs),
  );
}

function resolveCommandSimTimeMs(scene, sceneBaseSimTimeMs, options = {}) {
  const currentSimTimeMs =
    typeof options.getCurrentSimTimeMs === "function"
      ? options.getCurrentSimTimeMs()
      : (
        scene && typeof scene.getCurrentSimTimeMs === "function"
          ? scene.getCurrentSimTimeMs()
          : sceneBaseSimTimeMs
      );
  // null means "use the scene clock" at runtime. Number(null) is zero, so
  // only a finite explicitly authored value may override that live clock.
  const explicitNowMs =
    options.nowMs === null || options.nowMs === undefined
      ? Number.NaN
      : Number(options.nowMs);
  return Math.max(
    sceneBaseSimTimeMs,
    Number.isFinite(explicitNowMs)
      ? explicitNowMs
      : toFiniteNumber(currentSimTimeMs, sceneBaseSimTimeMs),
  );
}

function resolveMaxCommandProjectionStepMs(options = {}) {
  if (
    options.maxCommandProjectionStepMs === null ||
    options.maxCommandProjectionStepMs === undefined
  ) {
    return DEFAULT_MAX_COMMAND_PROJECTION_STEP_MS;
  }
  const explicit = toFiniteNumber(
    options.maxCommandProjectionStepMs,
    Number.NaN,
  );
  return Number.isFinite(explicit)
    ? Math.max(0, explicit)
    : DEFAULT_MAX_COMMAND_PROJECTION_STEP_MS;
}

function resolveMaxCommandProjectionSteps(options = {}) {
  if (
    options.maxCommandProjectionSteps === null ||
    options.maxCommandProjectionSteps === undefined
  ) {
    return DEFAULT_MAX_COMMAND_PROJECTION_STEPS;
  }
  const explicit = toFiniteNumber(options.maxCommandProjectionSteps, Number.NaN);
  return Number.isFinite(explicit)
    ? Math.max(1, Math.trunc(explicit))
    : DEFAULT_MAX_COMMAND_PROJECTION_STEPS;
}

function getSceneEntityByID(scene, entityID, options = {}) {
  if (typeof options.getEntityByID === "function") {
    return options.getEntityByID(entityID);
  }
  return scene && typeof scene.getEntityByID === "function"
    ? scene.getEntityByID(entityID)
    : null;
}

function buildCommandTimeSurfaceState(options = {}) {
  const scene = normalizeScene(options);
  const sourceEntity = options.sourceEntity || null;
  const targetEntity = options.targetEntity || null;
  if (!sourceEntity || !targetEntity) {
    return {
      available: false,
      projected: false,
      sourceEntity,
      targetEntity,
      centerDistance: Infinity,
      surfaceDistance: getEntitySurfaceDistance(sourceEntity, targetEntity),
    };
  }

  const sceneBaseSimTimeMs = resolveSceneBaseSimTimeMs(scene, options);
  const commandSimTimeMs = resolveCommandSimTimeMs(
    scene,
    sceneBaseSimTimeMs,
    options,
  );
  const projectionDeltaMs = Math.max(
    0,
    commandSimTimeMs - sceneBaseSimTimeMs,
  );
  if (projectionDeltaMs <= 0.000001) {
    const centerDistance = magnitude(subtractVectors(
      targetEntity && targetEntity.position,
      sourceEntity && sourceEntity.position,
    ));
    return {
      available: true,
      projected: false,
      sourceEntity,
      targetEntity,
      centerDistance,
      surfaceDistance: getEntitySurfaceDistance(sourceEntity, targetEntity),
    };
  }

  const advanceMovement = options.advanceMovement;
  const cloneDynamicEntityForDestinyPresentation =
    options.cloneDynamicEntityForDestinyPresentation;
  if (
    typeof advanceMovement !== "function" ||
    typeof cloneDynamicEntityForDestinyPresentation !== "function"
  ) {
    // A future command cannot be authorized from a stale live position.
    return {
      available: false,
      projected: false,
      sourceEntity,
      targetEntity,
      centerDistance: Infinity,
      surfaceDistance: Infinity,
    };
  }

  const projection = projectEntityGraphToTime({
    entities: [sourceEntity, targetEntity],
    baseSimTimeMs: sceneBaseSimTimeMs,
    targetSimTimeMs: commandSimTimeMs,
    getEntityByID: (entityID) => getSceneEntityByID(
      scene,
      entityID,
      options,
    ),
    getEntityMapKey:
      typeof options.getEntityMapKey === "function"
        ? options.getEntityMapKey
        : getCanonicalEntityMapKey,
    cloneEntity: cloneDynamicEntityForDestinyPresentation,
    advanceMovement,
    nativeSubwarpController: options.nativeSubwarpController,
    nativeSubwarpFrame: options.nativeSubwarpFrame,
    nativeSubwarpSceneEntitiesOwner:
      scene && scene.dynamicEntities instanceof Map
        ? scene.dynamicEntities
        : undefined,
    requireCarriedNativeSubwarpFrame: Boolean(
      options.nativeSubwarpController,
    ),
    maxProjectionDepth: options.maxProjectionDepth,
    maxProjectionStepMs: resolveMaxCommandProjectionStepMs(options),
    maxProjectionSteps: resolveMaxCommandProjectionSteps(options),
    shouldAdvance: (projectedEntity) => (
      !projectedEntity.sessionlessWarpIngress &&
      !projectedEntity.pendingDock
    ),
  });

  const [projectedSourceEntity, projectedTargetEntity] = projection.entities;
  if (
    projection.complete !== true ||
    projection.skippedEntityCount > 0
  ) {
    // A truncated dependency graph or a sessionless ingress would make the
    // projected distance approximate. Keep those states non-authoritative.
    return {
      available: false,
      projected: false,
      sourceEntity: projectedSourceEntity,
      targetEntity: projectedTargetEntity,
      centerDistance: Infinity,
      surfaceDistance: Infinity,
    };
  }
  const centerDistance = magnitude(subtractVectors(
    projectedTargetEntity && projectedTargetEntity.position,
    projectedSourceEntity && projectedSourceEntity.position,
  ));

  return {
    available: true,
    projected: true,
    sourceEntity: projectedSourceEntity,
    targetEntity: projectedTargetEntity,
    centerDistance,
    surfaceDistance: getEntitySurfaceDistance(
      projectedSourceEntity,
      projectedTargetEntity,
    ),
  };
}

function getCommandTimeEntitySurfaceDistance(options = {}) {
  return buildCommandTimeSurfaceState(options).surfaceDistance;
}

function isWithinSurfaceRange(surfaceDistance, rangeMeters, graceMeters = 0) {
  return (
    Math.max(0, toFiniteNumber(surfaceDistance, Infinity)) <=
    Math.max(0, toFiniteNumber(rangeMeters, 0)) +
      Math.max(0, toFiniteNumber(graceMeters, 0))
  );
}

function isWithinCommandTimeSurfaceRange(options = {}) {
  return isWithinSurfaceRange(
    getCommandTimeEntitySurfaceDistance(options),
    options.rangeMeters,
    options.graceMeters,
  );
}

module.exports = {
  buildCommandTimeSurfaceState,
  getCommandTimeEntitySurfaceDistance,
  getEntitySurfaceDistance,
  getEntityTargetingRadius,
  isWithinCommandTimeSurfaceRange,
  isWithinSurfaceRange,
};
