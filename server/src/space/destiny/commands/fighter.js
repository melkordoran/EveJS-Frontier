"use strict";

const {
  buildGotoPointPayload,
  buildSetMaxSpeedPayload,
  buildSetSpeedFractionPayload,
} = require("../stream/actions");

function applyFighterPassiveMaxVelocityCommand({
  fighterEntity,
  baseMaxVelocity,
} = {}) {
  if (!fighterEntity) {
    return false;
  }
  fighterEntity.baseMaxVelocity = baseMaxVelocity;
  return true;
}

function applyFighterMobilityMaxVelocityCommand({
  fighterEntity,
  maxVelocity,
} = {}) {
  if (!fighterEntity) {
    return false;
  }
  fighterEntity.maxVelocity = maxVelocity;
  return true;
}

function createFighterOperationalMotionCommand({
  fighterEntity,
  mass,
  inertia,
  maxVelocity,
  alignTime,
  maxAccelerationTime,
  agilitySeconds,
} = {}) {
  const applied = Boolean(fighterEntity);
  return {
    applied,
    applyBaseState() {
      if (!applied) {
        return false;
      }
      fighterEntity.mass = mass;
      fighterEntity.inertia = inertia;
      fighterEntity.baseMaxVelocity = maxVelocity;
      return true;
    },
    applyLiveMaxVelocity() {
      if (!applied) {
        return false;
      }
      fighterEntity.maxVelocity = maxVelocity;
      return true;
    },
    applyAgilityState() {
      if (!applied) {
        return false;
      }
      fighterEntity.alignTime = alignTime;
      fighterEntity.maxAccelerationTime = maxAccelerationTime;
      fighterEntity.agilitySeconds = agilitySeconds;
      return true;
    },
  };
}

function applyFighterUtilityTeleportMotionCommand({
  fighterEntity,
  direction,
  targetPoint,
  cloneTargetPoint,
} = {}) {
  if (!fighterEntity) {
    return false;
  }
  fighterEntity.direction = direction;
  fighterEntity.targetPoint =
    typeof cloneTargetPoint === "function"
      ? cloneTargetPoint(targetPoint)
      : targetPoint;
  return true;
}

function applyFighterGotoPointCommand({
  fighterEntity,
  targetPoint,
  direction,
} = {}) {
  if (!fighterEntity) {
    return { applied: false, buildPresentationUpdates: () => [] };
  }

  fighterEntity.mode = "GOTO";
  fighterEntity.targetEntityID = null;
  fighterEntity.followRange = 0;
  fighterEntity.orbitDistance = 0;
  fighterEntity.pendingWarp = null;
  fighterEntity.warpState = null;
  fighterEntity.targetPoint = targetPoint;
  fighterEntity.direction = direction;
  fighterEntity.speedFraction = fighterEntity.speedFraction > 0
    ? fighterEntity.speedFraction
    : 1;

  return {
    applied: true,
    buildPresentationUpdates({ stamp } = {}) {
      return [
        {
          stamp,
          payload: buildGotoPointPayload(fighterEntity.itemID, targetPoint),
        },
        {
          stamp,
          payload: buildSetSpeedFractionPayload(
            fighterEntity.itemID,
            fighterEntity.speedFraction,
          ),
        },
      ];
    },
  };
}

function buildFighterMaxVelocityUpdates({ fighterEntity, stamp } = {}) {
  return [{
    stamp,
    payload: buildSetMaxSpeedPayload(
      fighterEntity.itemID,
      fighterEntity.maxVelocity,
    ),
  }];
}

function captureFighterMaxVelocityPresentation({
  scene,
  fighterEntity,
  nowMs,
} = {}) {
  const stamp =
    typeof scene.getMovementStamp === "function"
      ? scene.getMovementStamp(nowMs)
      : 0;

  return {
    buildUpdates() {
      return buildFighterMaxVelocityUpdates({
        fighterEntity,
        stamp,
      });
    },
  };
}

module.exports = {
  applyFighterPassiveMaxVelocityCommand,
  applyFighterMobilityMaxVelocityCommand,
  createFighterOperationalMotionCommand,
  applyFighterUtilityTeleportMotionCommand,
  applyFighterGotoPointCommand,
  buildFighterMaxVelocityUpdates,
  captureFighterMaxVelocityPresentation,
};
