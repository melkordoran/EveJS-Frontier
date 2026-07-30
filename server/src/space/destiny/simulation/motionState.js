"use strict";

const destinyConstants = require("../constants");

const DEFAULT_MAX_SUBWARP_SPEED_FRACTION = Number.isFinite(
  Number(destinyConstants.MAX_SUBWARP_SPEED_FRACTION),
)
  ? Number(destinyConstants.MAX_SUBWARP_SPEED_FRACTION)
  : 1;

function clearTrackingState(entity) {
  entity.targetEntityID = null;
  entity.followRange = 0;
  entity.orbitDistance = 0;
  entity.warpState = null;
  entity.pendingWarp = null;
  entity.dockingTargetID = null;
  entity.lastPilotWarpStartupGuidanceStamp = null;
  entity.lastPilotWarpVelocityStamp = null;
  entity.lastPilotWarpEffectStamp = null;
  entity.lastPilotWarpCruiseBumpStamp = null;
  entity.lastPilotWarpMaxSpeedRampIndex = -1;
  entity.lastWarpDiagnosticStamp = null;
}

function shouldRetireFleetWarpAssociation(entity) {
  return Boolean(
    entity &&
    (
      entity.pendingWarp ||
      entity.fleetWarpFormationQueuedWarp ||
      (entity.mode === "WARP" && entity.warpState)
    )
  );
}

function createDestinyMotionStateHelpers(deps = {}) {
  const addVectors =
    typeof deps.addVectors === "function"
      ? deps.addVectors
      : (left, right) => ({
          x: Number((left && left.x) || 0) + Number((right && right.x) || 0),
          y: Number((left && left.y) || 0) + Number((right && right.y) || 0),
          z: Number((left && left.z) || 0) + Number((right && right.z) || 0),
        });
  const clamp =
    typeof deps.clamp === "function"
      ? deps.clamp
      : (value, min, max) => Math.max(min, Math.min(max, Number(value) || 0));
  const clearFleetWarpCommandAssociation =
    typeof deps.clearFleetWarpCommandAssociation === "function"
      ? deps.clearFleetWarpCommandAssociation
      : () => {};
  const cloneVector =
    typeof deps.cloneVector === "function"
      ? deps.cloneVector
      : (source = null) => ({
          x: Number((source && source.x) || 0),
          y: Number((source && source.y) || 0),
          z: Number((source && source.z) || 0),
        });
  const normalizeVector =
    typeof deps.normalizeVector === "function"
      ? deps.normalizeVector
      : (source, fallback) => cloneVector(source || fallback);
  const scaleVector =
    typeof deps.scaleVector === "function"
      ? deps.scaleVector
      : (vector, scalar) => ({
          x: Number((vector && vector.x) || 0) * Number(scalar || 0),
          y: Number((vector && vector.y) || 0) * Number(scalar || 0),
          z: Number((vector && vector.z) || 0) * Number(scalar || 0),
        });
  const toFiniteNumber =
    typeof deps.toFiniteNumber === "function"
      ? deps.toFiniteNumber
      : (value, fallback = 0) => {
          const numeric = Number(value);
          return Number.isFinite(numeric) ? numeric : fallback;
        };
  const MAX_SUBWARP_SPEED_FRACTION = Number.isFinite(
    Number(deps.MAX_SUBWARP_SPEED_FRACTION),
  )
    ? Number(deps.MAX_SUBWARP_SPEED_FRACTION)
    : DEFAULT_MAX_SUBWARP_SPEED_FRACTION;

  function clearRuntimeTrackingState(entity) {
    if (shouldRetireFleetWarpAssociation(entity)) {
      clearFleetWarpCommandAssociation(entity);
    }
    clearTrackingState(entity);
  }

  function resetEntityMotion(entity) {
    clearRuntimeTrackingState(entity);
    entity.mode = "STOP";
    entity.speedFraction = 0;
    entity.velocity = { x: 0, y: 0, z: 0 };
    entity.targetPoint = cloneVector(entity.position);
  }

  function resetEntityMotionForHardRelocation(entity) {
    resetEntityMotion(entity);
    delete entity.lastMotionDebug;
  }

  function buildUndockMovement(entity, direction, speedFraction = 1) {
    clearRuntimeTrackingState(entity);
    entity.direction = normalizeVector(direction, entity.direction);
    entity.targetPoint = addVectors(
      cloneVector(entity.position),
      scaleVector(entity.direction, 1.0e16),
    );
    entity.speedFraction = clamp(
      speedFraction,
      0,
      MAX_SUBWARP_SPEED_FRACTION,
    );
    entity.mode = "GOTO";
    const initialSpeed =
      Math.max(0, toFiniteNumber(entity.maxVelocity, 0)) *
      entity.speedFraction;
    entity.velocity = initialSpeed > 0
      ? scaleVector(entity.direction, initialSpeed)
      : { x: 0, y: 0, z: 0 };
  }

  return {
    buildUndockMovement,
    clearTrackingState: clearRuntimeTrackingState,
    resetEntityMotion,
    resetEntityMotionForHardRelocation,
  };
}

module.exports = {
  clearTrackingState,
  createDestinyMotionStateHelpers,
};
