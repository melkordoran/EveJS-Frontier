const {
  resolveDestinyAuthorityLaneTuple,
  snapshotDestinyAuthorityState,
} = require("../authority/destinySessionState");
const {
  MICHELLE_HELD_FUTURE_DESTINY_LEAD,
} = require("./michelleContract");
const {
  resolvePresentedSessionDestinyStamp,
} = require("./sessionWindows");
const {
  DESTINY_STAMP_MAX_FORWARD_LEAD,
  advanceDestinyStamp,
  getCurrentDestinyStamp,
  getDestinyStampForwardBoundaryDeltaMs,
  hasDestinyStamp,
  normalizeDestinyStamp,
  selectFurthestDestinyStamp,
} = require("./stamps");
const {
  PILOT_WARP_HISTORY_SAFE_DESTINY_LEAD,
} = require("../simulation/warpContract");

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    return Math.trunc(numeric);
  }
  const fallbackNumeric = Number(fallback);
  return Number.isFinite(fallbackNumeric) ? Math.trunc(fallbackNumeric) : 0;
}

function toFiniteNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function roundNumber(value, digits = 3) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 0;
  }
  const factor = 10 ** Math.max(0, Math.min(12, toInt(digits, 3)));
  return Math.round(numeric * factor) / factor;
}

function getSessionClockOffsetMs(session) {
  if (!session || !session._space) {
    return 0;
  }
  return toFiniteNumber(session._space.clockOffsetMs, 0);
}

function resolvePresentedDestinyLaneForSession(session) {
  if (!session || !session._space) {
    return {
      stamp: null,
      rawDispatchStamp: null,
      wasOwnerCritical: false,
      onlyStaleProjectedOwnerMissileLane: false,
    };
  }

  const spaceState = session._space;
  const authorityState = snapshotDestinyAuthorityState(session);
  const lane = resolveDestinyAuthorityLaneTuple({
    authorityState,
    legacyState: spaceState,
    stampKey: "lastPresentedStamp",
    rawDispatchKey: "lastRawDispatchStamp",
    legacyStampKey: "lastSentDestinyStamp",
    legacyRawDispatchKey: "lastSentDestinyRawDispatchStamp",
  });
  const classificationState = lane.fromAuthority
    ? authorityState
    : spaceState;
  const ownerCriticalKey = lane.fromAuthority
    ? "lastSentWasOwnerCritical"
    : "lastSentDestinyWasOwnerCritical";
  const staleProjectionKey = lane.fromAuthority
    ? "lastSentOnlyStaleProjectedOwnerMissileLane"
    : "lastSentDestinyOnlyStaleProjectedOwnerMissileLane";

  return {
    stamp: lane.stamp,
    rawDispatchStamp: lane.rawDispatchStamp,
    wasOwnerCritical: classificationState[ownerCriticalKey] === true,
    onlyStaleProjectedOwnerMissileLane:
      classificationState[staleProjectionKey] === true,
  };
}

function getLastSentDestinyStampForSession(session, fallbackStamp = 0) {
  const fallback = normalizeDestinyStamp(fallbackStamp, 0);
  const presentedLane = resolvePresentedDestinyLaneForSession(session);
  return hasDestinyStamp(presentedLane.stamp)
    ? presentedLane.stamp
    : fallback;
}

function getHistoryFloorDestinyStampForSession(session, fallbackStamp = 0) {
  if (!session || !session._space) {
    return normalizeDestinyStamp(fallbackStamp, 0);
  }
  return hasDestinyStamp(session._space.historyFloorDestinyStamp)
    ? normalizeDestinyStamp(session._space.historyFloorDestinyStamp)
    : normalizeDestinyStamp(fallbackStamp, 0);
}

function getImmediateDestinyStampForSession(session, fallbackStamp = 0) {
  const currentStamp = normalizeDestinyStamp(fallbackStamp, 0);
  const previousStamp = advanceDestinyStamp(currentStamp, -1);
  if (!session || !session._space) {
    return previousStamp;
  }
  const lastVisibleStamp = hasDestinyStamp(
    session._space.historyFloorDestinyStamp,
  )
    ? normalizeDestinyStamp(session._space.historyFloorDestinyStamp)
    : null;
  return selectFurthestDestinyStamp(
    previousStamp,
    [lastVisibleStamp],
    MICHELLE_HELD_FUTURE_DESTINY_LEAD,
  );
}

function getStargateDepartureDestinyStampForSession(session, fallbackStamp = 0) {
  const immediateStamp =
    getImmediateDestinyStampForSession(session, fallbackStamp) >>> 0;
  if (!session || !session._space) {
    return immediateStamp;
  }

  const presentedLane = resolvePresentedDestinyLaneForSession(session);

  if (presentedLane.onlyStaleProjectedOwnerMissileLane) {
    return immediateStamp;
  }
  return selectFurthestDestinyStamp(
    immediateStamp,
    [presentedLane.stamp],
  );
}

function translateSimTimeForSession(session, rawSimTimeMs, fallbackRawSimTimeMs = 0) {
  const normalizedRawSimTimeMs = toFiniteNumber(rawSimTimeMs, fallbackRawSimTimeMs);
  return roundNumber(
    normalizedRawSimTimeMs + getSessionClockOffsetMs(session),
    3,
  );
}

function getCurrentSessionSimTimeMs(session, rawSimTimeMs, fallbackRawSimTimeMs = 0) {
  return translateSimTimeForSession(session, rawSimTimeMs, fallbackRawSimTimeMs);
}

function getCurrentSessionDestinyStamp(session, rawSimTimeMs, fallbackRawSimTimeMs = 0) {
  return getCurrentDestinyStamp(
    getCurrentSessionSimTimeMs(session, rawSimTimeMs, fallbackRawSimTimeMs),
  );
}

function getCurrentVisibleDestinyStampForSession(session, fallbackStamp = 0) {
  const currentStamp = normalizeDestinyStamp(fallbackStamp, 0);
  const lastVisibleStamp =
    session && session._space &&
    hasDestinyStamp(session._space.historyFloorDestinyStamp)
      ? normalizeDestinyStamp(session._space.historyFloorDestinyStamp)
      : null;
  return selectFurthestDestinyStamp(
    currentStamp,
    [lastVisibleStamp],
    DESTINY_STAMP_MAX_FORWARD_LEAD,
  );
}

function getCurrentVisibleSessionDestinyStamp(
  session,
  rawSimTimeMs,
  fallbackRawSimTimeMs = 0,
) {
  return getCurrentVisibleDestinyStampForSession(
    session,
    getCurrentSessionDestinyStamp(session, rawSimTimeMs, fallbackRawSimTimeMs),
  );
}

function getCurrentPresentedSessionDestinyStamp(
  session,
  rawSimTimeMs,
  maximumFutureLead = MICHELLE_HELD_FUTURE_DESTINY_LEAD,
  fallbackRawSimTimeMs = 0,
) {
  const currentVisibleStamp = getCurrentVisibleSessionDestinyStamp(
    session,
    rawSimTimeMs,
    fallbackRawSimTimeMs,
  );
  const presentedLane = resolvePresentedDestinyLaneForSession(session);
  return resolvePresentedSessionDestinyStamp({
    currentVisibleStamp,
    hasSessionSpace: Boolean(session && session._space),
    lastSentStamp: hasDestinyStamp(presentedLane.stamp)
      ? presentedLane.stamp
      : currentVisibleStamp,
    maximumFutureLead,
    defaultMaximumFutureLead: MICHELLE_HELD_FUTURE_DESTINY_LEAD,
    maximumTrustedLead: Math.max(
      MICHELLE_HELD_FUTURE_DESTINY_LEAD,
      PILOT_WARP_HISTORY_SAFE_DESTINY_LEAD,
    ),
  });
}

function getOwnerPropulsionTogglePresentationStamp(
  session,
  rawSimTimeMs,
  fallbackRawSimTimeMs = 0,
) {
  const currentSessionStamp = getCurrentSessionDestinyStamp(
    session,
    rawSimTimeMs,
    fallbackRawSimTimeMs,
  ) >>> 0;
  const currentPresentedStamp = getCurrentPresentedSessionDestinyStamp(
    session,
    rawSimTimeMs,
    PILOT_WARP_HISTORY_SAFE_DESTINY_LEAD,
    fallbackRawSimTimeMs,
  ) >>> 0;
  return selectFurthestDestinyStamp(
    currentSessionStamp,
    [
      advanceDestinyStamp(currentSessionStamp, 1),
      advanceDestinyStamp(currentPresentedStamp, 1),
    ],
    MICHELLE_HELD_FUTURE_DESTINY_LEAD,
  );
}

function getCurrentClampedDestinyStampForSession(session, fallbackStamp = 0) {
  return getCurrentVisibleDestinyStampForSession(
    session,
    toInt(fallbackStamp, 0) >>> 0,
  );
}

function getCurrentVisibleSessionSimTimeMs(
  session,
  rawSimTimeMs,
  fallbackRawSimTimeMs = 0,
) {
  const currentSessionSimTimeMs = getCurrentSessionSimTimeMs(
    session,
    rawSimTimeMs,
    fallbackRawSimTimeMs,
  );
  const currentVisibleStamp = getCurrentVisibleSessionDestinyStamp(
    session,
    rawSimTimeMs,
    fallbackRawSimTimeMs,
  );
  const currentSessionStamp = getCurrentSessionDestinyStamp(
    session,
    rawSimTimeMs,
    fallbackRawSimTimeMs,
  );
  return currentSessionSimTimeMs + getDestinyStampForwardBoundaryDeltaMs(
    currentSessionSimTimeMs,
    currentSessionStamp,
    currentVisibleStamp,
    DESTINY_STAMP_MAX_FORWARD_LEAD,
  );
}

function getCurrentClampedSessionSimTimeMs(
  session,
  rawSimTimeMs,
  fallbackRawSimTimeMs = 0,
) {
  return getCurrentVisibleSessionSimTimeMs(
    session,
    rawSimTimeMs,
    fallbackRawSimTimeMs,
  );
}

function translateDestinyStampForSession(
  session,
  rawStamp,
  getStamp = getCurrentDestinyStamp,
) {
  const normalizedRawStamp = normalizeDestinyStamp(rawStamp, 0);
  const clockOffsetMs = getSessionClockOffsetMs(session);
  if (Math.abs(clockOffsetMs) < 0.000001) {
    return normalizedRawStamp;
  }
  return getStamp((normalizedRawStamp * 1000) + clockOffsetMs);
}

module.exports = {
  getCurrentClampedDestinyStampForSession,
  getCurrentClampedSessionSimTimeMs,
  getCurrentPresentedSessionDestinyStamp,
  getCurrentSessionDestinyStamp,
  getCurrentSessionSimTimeMs,
  getCurrentVisibleDestinyStampForSession,
  getCurrentVisibleSessionDestinyStamp,
  getCurrentVisibleSessionSimTimeMs,
  getHistoryFloorDestinyStampForSession,
  getImmediateDestinyStampForSession,
  getLastSentDestinyStampForSession,
  getOwnerPropulsionTogglePresentationStamp,
  getSessionClockOffsetMs,
  getStargateDepartureDestinyStampForSession,
  translateDestinyStampForSession,
  translateSimTimeForSession,
};
