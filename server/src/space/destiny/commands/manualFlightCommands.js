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
    const value = clamp(toFiniteNumber(requestedValue, 0), -1, 1);

    clearTrackingState(entity);
    entity.manualFlightActive = true;
    entity.manualPitch = axis === "pitch" ? value : currentPitch;
    entity.manualYawRate = axis === "yawRate" ? value : currentYawRate;
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

  return {
    setPitch(runtime, session, pitch) {
      return applyManualAxis(runtime, session, "pitch", pitch);
    },

    setYawRate(runtime, session, yawRate) {
      return applyManualAxis(runtime, session, "yawRate", yawRate);
    },
  };
}

module.exports = {
  createMovementManualFlightCommands,
};
