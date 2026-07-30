"use strict";

const {
  DESTINY_STAMP_INTERVAL_MS,
} = require("../constants");
const {
  getCurrentDestinyStamp,
  getDestinyStampForwardDistance,
  normalizeDestinyStamp,
} = require("../delivery/stamps");

function toFiniteNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function getNativeBoundaryAtMs(
  nowMs,
  intervalMs = DESTINY_STAMP_INTERVAL_MS,
) {
  const interval = Math.max(1, toFiniteNumber(intervalMs, 1));
  const now = toFiniteNumber(nowMs, 0);
  return Math.floor(now / interval) * interval;
}

// Active warp advances on the canonical one-second Destiny stamp, not on each
// host pulse. The cursor is transient state on the already-authoritative warp
// state; it is deliberately absent from persistence and creates no new clock.
function acquireActiveWarpNativeSample(entity, nowMs, options = {}) {
  const warpState = entity && entity.warpState;
  if (!warpState || typeof warpState !== "object") {
    return { ready: false, reason: "NO_WARP_STATE" };
  }

  const resolveStamp = typeof options.getCurrentDestinyStamp === "function"
    ? options.getCurrentDestinyStamp
    : getCurrentDestinyStamp;
  const intervalMs = Math.max(
    1,
    toFiniteNumber(options.intervalMs, DESTINY_STAMP_INTERVAL_MS),
  );
  const activationAtMs = toFiniteNumber(
    warpState.startTimeMs,
    getNativeBoundaryAtMs(nowMs, intervalMs),
  );
  const activationStamp = normalizeDestinyStamp(resolveStamp(activationAtMs), 0);
  const currentStamp = normalizeDestinyStamp(resolveStamp(nowMs), activationStamp);
  const previousSampleStamp = Number.isInteger(warpState.nativeSampleStamp)
    ? normalizeDestinyStamp(warpState.nativeSampleStamp, activationStamp)
    : activationStamp;

  if (previousSampleStamp === currentStamp) {
    return {
      ready: false,
      reason: "SAME_NATIVE_STAMP",
      activationStamp,
      currentStamp,
      previousSampleStamp,
    };
  }

  const elapsedNativeTicks = getDestinyStampForwardDistance(
    activationStamp,
    currentStamp,
  );
  const previousElapsedNativeTicks = getDestinyStampForwardDistance(
    activationStamp,
    previousSampleStamp,
  );
  const sampleAtMs = activationAtMs + (elapsedNativeTicks * intervalMs);
  const nativeBoundaryAtMs = getNativeBoundaryAtMs(nowMs, intervalMs);
  warpState.nativeSampleStamp = currentStamp;
  warpState.nativeSampleAtMs = sampleAtMs;
  warpState.nativeBoundaryAtMs = nativeBoundaryAtMs;
  return {
    ready: true,
    activationStamp,
    currentStamp,
    previousSampleStamp,
    previousElapsedNativeTicks,
    elapsedNativeTicks,
    sampleAtMs,
    nativeBoundaryAtMs,
  };
}

module.exports = {
  acquireActiveWarpNativeSample,
  getNativeBoundaryAtMs,
};
