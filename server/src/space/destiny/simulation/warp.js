"use strict";

// Native warp factor behavior is adapted from carbonengine/destiny v3.1.1.
// Copyright (c) 2026 CCP Games; MIT terms are in simulation/README.md.
// CCP public Destiny source: Ballpark.cpp. These constants describe how
// warpFactor maps to top speed, acceleration, and deceleration in native
// Destiny's SetupWarpConstants. The 0.001 rate floors below preserve John's
// wrapper exactly; Carbon normalizes the supported factor upstream and does
// not apply the same low-factor floor to deceleration.
const WARP_FACTOR_TO_AU_PER_SECOND = 0.001;
const WARP_FACTOR_TO_ACCELERATION = 1.0 / 1000;
const WARP_FACTOR_TO_DECELERATION = 1.0 / 3000;
const NATIVE_WARP_DECEL_RATE_MAX = 2.0;

// Native WarpTo falls back to GotoPoint below 100 km. Player-command service
// validation remains a separate contract and currently requires 150 km.
const NATIVE_WARP_TO_GOTO_DISTANCE_SQUARED_METERS = 10_000_000_000;
const NATIVE_WARP_TO_GOTO_DISTANCE_METERS = 100_000;

function toFiniteNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function resolveWarpFactorFromWarpSpeedAU(warpSpeedAU) {
  return Math.max(
    toFiniteNumber(warpSpeedAU, 0) / WARP_FACTOR_TO_AU_PER_SECOND,
    0,
  );
}

function getWarpAccelRateFromWarpFactor(warpFactor) {
  return Math.max(
    toFiniteNumber(warpFactor, 0) * WARP_FACTOR_TO_ACCELERATION,
    0.001,
  );
}

function getWarpDecelRateFromWarpFactor(
  warpFactor,
  maxDecelRate = NATIVE_WARP_DECEL_RATE_MAX,
) {
  return Math.min(
    Math.max(
      toFiniteNumber(warpFactor, 0) * WARP_FACTOR_TO_DECELERATION,
      0.001,
    ),
    toFiniteNumber(maxDecelRate, NATIVE_WARP_DECEL_RATE_MAX),
  );
}

function getWarpAccelRateFromWarpSpeedAU(warpSpeedAU) {
  return getWarpAccelRateFromWarpFactor(
    resolveWarpFactorFromWarpSpeedAU(warpSpeedAU),
  );
}

function getWarpDecelRateFromWarpSpeedAU(
  warpSpeedAU,
  maxDecelRate = NATIVE_WARP_DECEL_RATE_MAX,
) {
  return getWarpDecelRateFromWarpFactor(
    resolveWarpFactorFromWarpSpeedAU(warpSpeedAU),
    maxDecelRate,
  );
}

function getWarpSpeedMetersPerSecondFromWarpFactor(warpFactor, oneAuInMeters) {
  return Math.max(
    toFiniteNumber(warpFactor, 0) *
      WARP_FACTOR_TO_AU_PER_SECOND *
      toFiniteNumber(oneAuInMeters, 0),
    0,
  );
}

function getNativeWarpDropoutSpeed(
  maxSubwarpVelocity,
  maximumDropoutSpeed = 100,
) {
  return Math.max(
    0,
    Math.min(
      toFiniteNumber(maxSubwarpVelocity, 0) / 2,
      Math.max(0, toFiniteNumber(maximumDropoutSpeed, 100)),
    ),
  );
}

function isNativeWarpDistanceTooShort(distanceMeters) {
  const distance = Math.max(toFiniteNumber(distanceMeters, 0), 0);
  return (distance * distance) < NATIVE_WARP_TO_GOTO_DISTANCE_SQUARED_METERS;
}

module.exports = {
  NATIVE_WARP_DECEL_RATE_MAX,
  NATIVE_WARP_TO_GOTO_DISTANCE_METERS,
  NATIVE_WARP_TO_GOTO_DISTANCE_SQUARED_METERS,
  WARP_FACTOR_TO_ACCELERATION,
  WARP_FACTOR_TO_AU_PER_SECOND,
  WARP_FACTOR_TO_DECELERATION,
  getWarpAccelRateFromWarpFactor,
  getWarpAccelRateFromWarpSpeedAU,
  getWarpDecelRateFromWarpFactor,
  getWarpDecelRateFromWarpSpeedAU,
  getNativeWarpDropoutSpeed,
  getWarpSpeedMetersPerSecondFromWarpFactor,
  isNativeWarpDistanceTooShort,
  resolveWarpFactorFromWarpSpeedAU,
};
