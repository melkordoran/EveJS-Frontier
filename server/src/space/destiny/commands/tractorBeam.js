"use strict";

const {
  buildFollowBallPayload,
  buildGotoPointPayload,
  buildSetBallFreePayload,
  buildSetBallMassPayload,
  buildSetBallPositionPayload,
  buildSetBallVelocityPayload,
  buildSetMaxSpeedPayload,
  buildSetSpeedFractionPayload,
  buildStopPayload,
} = require("../stream/actions");

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

function addVectors(left, right) {
  return {
    x: toFiniteNumber(left && left.x, 0) + toFiniteNumber(right && right.x, 0),
    y: toFiniteNumber(left && left.y, 0) + toFiniteNumber(right && right.y, 0),
    z: toFiniteNumber(left && left.z, 0) + toFiniteNumber(right && right.z, 0),
  };
}

function scaleVector(vector, scalar) {
  return {
    x: toFiniteNumber(vector && vector.x, 0) * scalar,
    y: toFiniteNumber(vector && vector.y, 0) * scalar,
    z: toFiniteNumber(vector && vector.z, 0) * scalar,
  };
}

function captureFittedTractorPresentation({
  scene,
  nowMs,
} = {}) {
  return scene.getMovementStamp(nowMs);
}

function applyTractorStopCommand({
  targetEntity,
  restoreMaxVelocity,
} = {}) {
  if (!targetEntity) {
    return {
      applied: false,
      buildRestoreSpeedUpdates: () => [],
      buildStopUpdates: () => [],
    };
  }

  const restoredSpeed = Math.max(0, toFiniteNumber(restoreMaxVelocity, 0));
  targetEntity.maxVelocity = restoredSpeed;
  targetEntity.speedFraction = 0;
  targetEntity.mode = "STOP";
  targetEntity.targetPoint = cloneVector(targetEntity.position);
  targetEntity.velocity = { x: 0, y: 0, z: 0 };

  return {
    applied: true,
    buildRestoreSpeedUpdates({ stamp } = {}) {
      return [
        {
          stamp,
          payload: buildSetMaxSpeedPayload(targetEntity.itemID, restoredSpeed),
        },
        {
          stamp,
          payload: buildSetSpeedFractionPayload(targetEntity.itemID, 0),
        },
      ];
    },
    buildStopUpdates({ stamp, includePosition = false } = {}) {
      const updates = [];
      if (includePosition === true) {
        updates.push({
          stamp,
          payload: buildSetBallPositionPayload(targetEntity.itemID, targetEntity.position),
        });
      }
      updates.push(
        {
          stamp,
          payload: buildSetBallVelocityPayload(targetEntity.itemID, targetEntity.velocity),
        },
        {
          stamp,
          payload: buildStopPayload(targetEntity.itemID),
        },
      );
      return updates;
    },
  };
}

function applyTractorActivationCommand({
  sourceEntity,
  targetEntity,
  tractorSpeedMetersPerSecond,
  followRangeMeters,
} = {}) {
  if (!sourceEntity || !targetEntity) {
    return { applied: false, buildPresentationUpdates: () => [] };
  }

  const tractorSpeed = Math.max(0, toFiniteNumber(tractorSpeedMetersPerSecond, 0));
  const followRange = Math.max(0, toFiniteNumber(followRangeMeters, 0));
  targetEntity.mass = 10;
  targetEntity.maxVelocity = tractorSpeed;
  targetEntity.speedFraction = 1;
  targetEntity.mode = "FOLLOW";
  targetEntity.targetEntityID = sourceEntity.itemID;
  targetEntity.followRange = followRange;

  return {
    applied: true,
    buildPresentationUpdates({ stamp } = {}) {
      return [
        {
          stamp,
          payload: buildSetMaxSpeedPayload(targetEntity.itemID, tractorSpeed),
        },
        {
          stamp,
          payload: buildSetBallFreePayload(targetEntity.itemID, true),
        },
        {
          stamp,
          payload: buildSetBallMassPayload(targetEntity.itemID, 10),
        },
        {
          stamp,
          payload: buildSetMaxSpeedPayload(targetEntity.itemID, tractorSpeed),
        },
        {
          stamp,
          payload: buildSetSpeedFractionPayload(targetEntity.itemID, 1),
        },
        {
          stamp,
          payload: buildFollowBallPayload(
            targetEntity.itemID,
            sourceEntity.itemID,
            followRange,
          ),
        },
      ];
    },
  };
}

function applyTractorSettleCommand({
  targetEntity,
  direction,
  holdPosition,
  tractorSpeedMetersPerSecond,
  stamp,
} = {}) {
  if (!targetEntity) {
    return { applied: false, buildPresentationUpdates: () => [] };
  }

  const tractorSpeed = Math.max(0, toFiniteNumber(tractorSpeedMetersPerSecond, 0));
  const targetPoint = cloneVector(holdPosition);
  targetEntity.direction = direction;
  targetEntity.targetPoint = targetPoint;
  targetEntity.maxVelocity = tractorSpeed;
  targetEntity.speedFraction = 1;
  targetEntity.mode = "GOTO";

  return {
    applied: true,
    buildPresentationUpdates({ primeSpeed = false, sendGotoPoint = false } = {}) {
      const updates = [];
      if (primeSpeed === true) {
        updates.push({
          stamp,
          payload: buildSetMaxSpeedPayload(targetEntity.itemID, tractorSpeed),
        });
        updates.push({
          stamp,
          payload: buildSetSpeedFractionPayload(targetEntity.itemID, 1),
        });
      }
      if (sendGotoPoint === true) {
        updates.push({
          stamp,
          payload: buildGotoPointPayload(targetEntity.itemID, holdPosition),
        });
      }
      return updates;
    },
  };
}

function applyTractorPullCommand({
  targetEntity,
  movementDirection,
  moveDistanceMeters,
  holdPosition,
  tractorSpeedMetersPerSecond,
  stamp,
} = {}) {
  if (!targetEntity) {
    return {
      applied: false,
      previousPosition: null,
      finishMotionState: () => {},
      buildRetargetUpdates: () => [],
      buildPositionUpdates: () => [],
      buildVelocityUpdates: () => [],
    };
  }

  const tractorSpeed = Math.max(0, toFiniteNumber(tractorSpeedMetersPerSecond, 0));
  const previousPosition = cloneVector(targetEntity.position);
  targetEntity.position = addVectors(
    targetEntity.position,
    scaleVector(movementDirection, moveDistanceMeters),
  );
  targetEntity.direction = movementDirection;
  targetEntity.velocity = scaleVector(movementDirection, tractorSpeed);
  targetEntity.targetPoint = cloneVector(holdPosition);

  return {
    applied: true,
    previousPosition,
    finishMotionState() {
      targetEntity.maxVelocity = tractorSpeed;
      targetEntity.speedFraction = 1;
      targetEntity.mode = "GOTO";
    },
    buildRetargetUpdates({ primeSpeed = false, sendGotoPoint = false } = {}) {
      const updates = [];
      if (primeSpeed === true) {
        updates.push({
          stamp,
          payload: buildSetMaxSpeedPayload(targetEntity.itemID, tractorSpeed),
        });
        updates.push({
          stamp,
          payload: buildSetSpeedFractionPayload(targetEntity.itemID, 1),
        });
      }
      if (sendGotoPoint === true) {
        updates.push({
          stamp,
          payload: buildGotoPointPayload(targetEntity.itemID, holdPosition),
        });
      }
      return updates;
    },
    buildPositionUpdates({ position = targetEntity.position } = {}) {
      return [{
        stamp,
        payload: buildSetBallPositionPayload(targetEntity.itemID, position),
      }];
    },
    buildVelocityUpdates() {
      return [{
        stamp,
        payload: buildSetBallVelocityPayload(targetEntity.itemID, targetEntity.velocity),
      }];
    },
  };
}

module.exports = {
  captureFittedTractorPresentation,
  applyTractorActivationCommand,
  applyTractorPullCommand,
  applyTractorSettleCommand,
  applyTractorStopCommand,
};
