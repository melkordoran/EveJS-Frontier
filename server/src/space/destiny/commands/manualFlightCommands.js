"use strict";

const destiny = require("../index.js");

function createMovementManualFlightCommands(deps = {}) {
  const {
    addVectors,
    armMovementTrace,
    clamp,
    clearTrackingState,
    cloneVector,
    normalizeVector,
    persistShipEntity,
    roundNumber,
    scaleVector,
    summarizeVector,
    toFiniteNumber,
    DEFAULT_RIGHT,
  } = deps;

  function getPitchFractionFromDirection(direction) {
    const normalized = normalizeVector(direction, DEFAULT_RIGHT);
    return clamp(Math.asin(clamp(normalized.y, -1, 1)) / (Math.PI / 2), -1, 1);
  }

  function applyManualAxis(runtime, session, axis, requestedValue) {
    const entity = runtime.getShipEntityForSession(session);
    if (!entity || entity.mode === "WARP" || entity.pendingDock) {
      return false;
    }

    const now = runtime.getCurrentSimTimeMs();
    const currentPitch = Number.isFinite(Number(entity.manualPitch))
      ? clamp(toFiniteNumber(entity.manualPitch, 0), -1, 1)
      : getPitchFractionFromDirection(entity.direction);
    const currentYawRate = clamp(
      toFiniteNumber(entity.manualYawRate, 0),
      -1,
      1,
    );
    const currentStrafingThrust = cloneVector(
      entity.manualStrafingThrust || { x: 0, y: 0, z: 0 },
    );
    const value = clamp(toFiniteNumber(requestedValue, 0), -1, 1);

    clearTrackingState(entity);
    entity.manualFlightActive = true;
    entity.manualPitch = axis === "pitch" ? value : currentPitch;
    entity.manualYawRate = axis === "yawRate" ? value : currentYawRate;
    entity.manualStrafingThrust = currentStrafingThrust;
    entity.mode = "GOTO";
    entity.targetPoint = addVectors(
      cloneVector(entity.position),
      scaleVector(normalizeVector(entity.direction, DEFAULT_RIGHT), 1.0e16),
    );
    persistShipEntity(entity);

    armMovementTrace(entity, axis === "pitch" ? "manualPitch" : "manualYawRate", {
      manualPitch: roundNumber(entity.manualPitch, 4),
      manualYawRate: roundNumber(entity.manualYawRate, 4),
      direction: summarizeVector(entity.direction),
    }, now);

    const stamp = runtime.getHistorySafeSessionDestinyStamp(session, now, 1);
    const payload = axis === "pitch"
      ? destiny.buildSetPitchPayload(entity.itemID, entity.manualPitch)
      : destiny.buildSetYawRatePayload(entity.itemID, entity.manualYawRate);
    runtime.broadcastPilotCommandMovementUpdates(
      session,
      [{ stamp, payload }],
      now,
    );
    runtime.scheduleWatcherMovementAnchor(
      entity,
      now,
      axis === "pitch" ? "setPitch" : "setYawRate",
    );
    return true;
  }

  function applyStrafingThrust(runtime, session, requestedThrust) {
    const entity = runtime.getShipEntityForSession(session);
    if (!entity || entity.mode === "WARP" || entity.pendingDock) {
      return false;
    }

    const source = Array.isArray(requestedThrust)
      ? requestedThrust
      : requestedThrust && typeof requestedThrust === "object"
        ? [requestedThrust.x, requestedThrust.y, requestedThrust.z]
        : [];
    const agilitySeconds = Math.max(
      0.05,
      toFiniteNumber(entity.agilitySeconds, 0.05),
    );
    const maximumStrafeAcceleration = Math.max(
      0,
      toFiniteNumber(entity.maxVelocity, 0) / agilitySeconds,
    ) * 0.2;
    const thrust = {
      x: clamp(
        toFiniteNumber(source[0], 0),
        -maximumStrafeAcceleration,
        maximumStrafeAcceleration,
      ),
      y: clamp(
        toFiniteNumber(source[1], 0),
        -maximumStrafeAcceleration,
        maximumStrafeAcceleration,
      ),
      z: 0,
    };
    const currentPitch = Number.isFinite(Number(entity.manualPitch))
      ? clamp(toFiniteNumber(entity.manualPitch, 0), -1, 1)
      : getPitchFractionFromDirection(entity.direction);
    const currentYawRate = clamp(
      toFiniteNumber(entity.manualYawRate, 0),
      -1,
      1,
    );

    clearTrackingState(entity);
    entity.manualFlightActive = true;
    entity.manualPitch = currentPitch;
    entity.manualYawRate = currentYawRate;
    entity.manualStrafingThrust = thrust;
    entity.mode = "GOTO";
    entity.targetPoint = addVectors(
      cloneVector(entity.position),
      scaleVector(normalizeVector(entity.direction, DEFAULT_RIGHT), 1.0e16),
    );
    persistShipEntity(entity);

    const now = runtime.getCurrentSimTimeMs();
    armMovementTrace(entity, "manualStrafingThrust", {
      thrust: summarizeVector(thrust),
      maximumStrafeAcceleration: roundNumber(maximumStrafeAcceleration, 4),
      direction: summarizeVector(entity.direction),
    }, now);

    const stamp = runtime.getHistorySafeSessionDestinyStamp(session, now, 1);
    runtime.broadcastPilotCommandMovementUpdates(
      session,
      [{
        stamp,
        payload: destiny.buildSetStrafingThrustPayload(entity.itemID, thrust),
      }],
      now,
    );
    runtime.scheduleWatcherMovementAnchor(
      entity,
      now,
      "setStrafingThrust",
    );
    return true;
  }

  return {
    setPitch(runtime, session, pitch) {
      return applyManualAxis(runtime, session, "pitch", pitch);
    },

    setStrafingThrust(runtime, session, thrust) {
      return applyStrafingThrust(runtime, session, thrust);
    },

    setYawRate(runtime, session, yawRate) {
      return applyManualAxis(runtime, session, "yawRate", yawRate);
    },
  };
}

module.exports = {
  createMovementManualFlightCommands,
};
