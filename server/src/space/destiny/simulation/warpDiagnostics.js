"use strict";

function defaultToFiniteNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function defaultRoundNumber(value, digits = 3) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 0;
  }
  const factor = 10 ** Math.max(0, Math.min(12, Math.trunc(Number(digits) || 3)));
  return Math.round(numeric * factor) / factor;
}

function createDestinyWarpDiagnostics(deps = {}) {
  const toFiniteNumber =
    typeof deps.toFiniteNumber === "function"
      ? deps.toFiniteNumber
      : defaultToFiniteNumber;
  const roundNumber =
    typeof deps.roundNumber === "function"
      ? deps.roundNumber
      : defaultRoundNumber;
  const distance =
    typeof deps.distance === "function"
      ? deps.distance
      : () => 0;
  const magnitude =
    typeof deps.magnitude === "function"
      ? deps.magnitude
      : () => 0;
  const getCurrentDestinyStamp =
    typeof deps.getCurrentDestinyStamp === "function"
      ? deps.getCurrentDestinyStamp
      : () => 0;
  const getWarpProgress =
    typeof deps.getWarpProgress === "function"
      ? deps.getWarpProgress
      : () => ({ complete: false, speed: 0, traveled: 0 });
  const ONE_AU_IN_METERS = Math.max(
    toFiniteNumber(deps.ONE_AU_IN_METERS, 149597870700),
    1,
  );
  const WARP_DROPOUT_SPEED_MAX_MS = Math.max(
    toFiniteNumber(deps.WARP_DROPOUT_SPEED_MAX_MS, 100),
    1,
  );

  function buildOfficialWarpReferenceProfile(
    warpDistanceMeters,
    warpSpeedAU,
    maxSubwarpSpeedMs,
  ) {
    const totalDistance = Math.max(toFiniteNumber(warpDistanceMeters, 0), 0);
    const resolvedWarpSpeedAU = Math.max(toFiniteNumber(warpSpeedAU, 0), 0.001);
    const resolvedSubwarpSpeedMs = Math.max(
      Math.min(
        toFiniteNumber(maxSubwarpSpeedMs, 0) / 2,
        WARP_DROPOUT_SPEED_MAX_MS,
      ),
      1,
    );
    const kAccel = resolvedWarpSpeedAU;
    const kDecel = Math.min(resolvedWarpSpeedAU / 3, 2);

    let maxWarpSpeedMs = resolvedWarpSpeedAU * ONE_AU_IN_METERS;
    let accelDistance = maxWarpSpeedMs / kAccel;
    let decelDistance = maxWarpSpeedMs / kDecel;
    const minimumDistance = accelDistance + decelDistance;
    const cruiseDistance = Math.max(totalDistance - minimumDistance, 0);
    let cruiseTimeSeconds = 0;
    let profileType = "long";

    if (minimumDistance > totalDistance) {
      profileType = "short";
      maxWarpSpeedMs =
        (totalDistance * kAccel * kDecel) /
        Math.max(kAccel + kDecel, 0.001);
      accelDistance = maxWarpSpeedMs / kAccel;
      decelDistance = maxWarpSpeedMs / kDecel;
    } else {
      cruiseTimeSeconds = cruiseDistance / maxWarpSpeedMs;
    }

    const accelTimeSeconds =
      Math.log(Math.max(maxWarpSpeedMs / kAccel, 1)) / kAccel;
    const decelTimeSeconds =
      Math.log(Math.max(maxWarpSpeedMs / resolvedSubwarpSpeedMs, 1)) / kDecel;
    const totalTimeSeconds =
      accelTimeSeconds + cruiseTimeSeconds + decelTimeSeconds;

    return {
      profileType,
      warpDistanceMeters: roundNumber(totalDistance, 3),
      warpDistanceAU: roundNumber(totalDistance / ONE_AU_IN_METERS, 6),
      warpSpeedAU: roundNumber(resolvedWarpSpeedAU, 3),
      kAccel: roundNumber(kAccel, 6),
      kDecel: roundNumber(kDecel, 6),
      warpDropoutSpeedMs: roundNumber(resolvedSubwarpSpeedMs, 3),
      maxWarpSpeedMs: roundNumber(maxWarpSpeedMs, 3),
      maxWarpSpeedAU: roundNumber(maxWarpSpeedMs / ONE_AU_IN_METERS, 6),
      accelDistance: roundNumber(accelDistance, 3),
      accelDistanceAU: roundNumber(accelDistance / ONE_AU_IN_METERS, 6),
      cruiseDistance: roundNumber(
        Math.max(totalDistance - accelDistance - decelDistance, 0),
        3,
      ),
      cruiseDistanceAU: roundNumber(
        Math.max(totalDistance - accelDistance - decelDistance, 0) /
          ONE_AU_IN_METERS,
        6,
      ),
      decelDistance: roundNumber(decelDistance, 3),
      decelDistanceAU: roundNumber(decelDistance / ONE_AU_IN_METERS, 6),
      minimumDistance: roundNumber(
        Math.min(minimumDistance, totalDistance),
        3,
      ),
      minimumDistanceAU: roundNumber(
        Math.min(minimumDistance, totalDistance) / ONE_AU_IN_METERS,
        6,
      ),
      accelTimeMs: roundNumber(accelTimeSeconds * 1000, 3),
      cruiseTimeMs: roundNumber(cruiseTimeSeconds * 1000, 3),
      decelTimeMs: roundNumber(decelTimeSeconds * 1000, 3),
      totalTimeMs: roundNumber(totalTimeSeconds * 1000, 3),
      ceilTotalSeconds: Math.ceil(totalTimeSeconds),
    };
  }

  function buildWarpProfileDelta(warpState, officialProfile) {
    if (!warpState || !officialProfile) {
      return null;
    }

    return {
      durationMs: roundNumber(
        toFiniteNumber(warpState.durationMs, 0) -
          toFiniteNumber(officialProfile.totalTimeMs, 0),
        3,
      ),
      accelTimeMs: roundNumber(
        toFiniteNumber(warpState.accelTimeMs, 0) -
          toFiniteNumber(officialProfile.accelTimeMs, 0),
        3,
      ),
      cruiseTimeMs: roundNumber(
        toFiniteNumber(warpState.cruiseTimeMs, 0) -
          toFiniteNumber(officialProfile.cruiseTimeMs, 0),
        3,
      ),
      decelTimeMs: roundNumber(
        toFiniteNumber(warpState.decelTimeMs, 0) -
          toFiniteNumber(officialProfile.decelTimeMs, 0),
        3,
      ),
      maxWarpSpeedMs: roundNumber(
        toFiniteNumber(warpState.maxWarpSpeedMs, 0) -
          toFiniteNumber(officialProfile.maxWarpSpeedMs, 0),
        3,
      ),
      accelDistance: roundNumber(
        toFiniteNumber(warpState.accelDistance, 0) -
          toFiniteNumber(officialProfile.accelDistance, 0),
        3,
      ),
      cruiseDistance: roundNumber(
        toFiniteNumber(warpState.cruiseDistance, 0) -
          toFiniteNumber(officialProfile.cruiseDistance, 0),
        3,
      ),
      decelDistance: roundNumber(
        toFiniteNumber(warpState.decelDistance, 0) -
          toFiniteNumber(officialProfile.decelDistance, 0),
        3,
      ),
    };
  }

  function getWarpPhaseName(warpState, elapsedMs) {
    const elapsed = Math.max(toFiniteNumber(elapsedMs, 0), 0);
    const accelTimeMs = Math.max(
      toFiniteNumber(warpState && warpState.accelTimeMs, 0),
      0,
    );
    const cruiseTimeMs = Math.max(
      toFiniteNumber(warpState && warpState.cruiseTimeMs, 0),
      0,
    );
    const durationMs = Math.max(
      toFiniteNumber(warpState && warpState.durationMs, 0),
      0,
    );

    if (elapsed < accelTimeMs) {
      return "accel";
    }
    if (elapsed < accelTimeMs + cruiseTimeMs) {
      return "cruise";
    }
    if (elapsed < durationMs) {
      return "decel";
    }
    return "complete";
  }

  function buildWarpRuntimeDiagnostics(entity, now = Date.now()) {
    if (!entity || !entity.warpState) {
      return null;
    }

    const warpState = entity.warpState;
    const elapsedMs = Math.max(
      0,
      toFiniteNumber(now, Date.now()) -
        toFiniteNumber(warpState.startTimeMs, now),
    );
    const progress = getWarpProgress(warpState, now);
    const positionRemainingDistance = Math.max(
      distance(entity.position, warpState.targetPoint),
      0,
    );
    const profileRemainingDistance = Math.max(
      toFiniteNumber(warpState.totalDistance, 0) -
        toFiniteNumber(progress.traveled, 0),
      0,
    );
    const velocityMagnitude = magnitude(entity.velocity);

    return {
      stamp: getCurrentDestinyStamp(now),
      phase: getWarpPhaseName(warpState, elapsedMs),
      elapsedMs: roundNumber(elapsedMs, 3),
      remainingMs: roundNumber(
        Math.max(toFiniteNumber(warpState.durationMs, 0) - elapsedMs, 0),
        3,
      ),
      progressComplete: Boolean(progress.complete),
      progressDistance: roundNumber(toFiniteNumber(progress.traveled, 0), 3),
      progressDistanceAU: roundNumber(
        toFiniteNumber(progress.traveled, 0) / ONE_AU_IN_METERS,
        6,
      ),
      progressRemainingDistance: roundNumber(profileRemainingDistance, 3),
      progressRemainingDistanceAU: roundNumber(
        profileRemainingDistance / ONE_AU_IN_METERS,
        6,
      ),
      progressSpeedMs: roundNumber(toFiniteNumber(progress.speed, 0), 3),
      progressSpeedAU: roundNumber(
        toFiniteNumber(progress.speed, 0) / ONE_AU_IN_METERS,
        6,
      ),
      entitySpeedMs: roundNumber(velocityMagnitude, 3),
      entitySpeedAU: roundNumber(velocityMagnitude / ONE_AU_IN_METERS, 6),
      positionRemainingDistance: roundNumber(positionRemainingDistance, 3),
      positionRemainingDistanceAU: roundNumber(
        positionRemainingDistance / ONE_AU_IN_METERS,
        6,
      ),
      remainingDistanceDelta: roundNumber(
        positionRemainingDistance - profileRemainingDistance,
        3,
      ),
    };
  }

  return {
    buildOfficialWarpReferenceProfile,
    buildWarpProfileDelta,
    buildWarpRuntimeDiagnostics,
    getWarpPhaseName,
  };
}

module.exports = {
  createDestinyWarpDiagnostics,
};
