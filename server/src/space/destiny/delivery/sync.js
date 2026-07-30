"use strict";

const {
  DESTINY_STAMP_MAX_FORWARD_LEAD,
  DESTINY_STAMP_MAX_ORDERING_DISTANCE,
  advanceDestinyStamp,
  hasDestinyStamp,
  isDestinyStampWithinForwardWindow,
  normalizeDestinyStamp,
  selectFurthestDestinyStamp,
} = require("./stamps");

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    return Math.trunc(numeric);
  }
  const fallbackNumeric = Number(fallback);
  return Number.isFinite(fallbackNumeric) ? Math.trunc(fallbackNumeric) : 0;
}

function normalizeRequiredStamp(value, fallback = 0) {
  return normalizeDestinyStamp(
    hasDestinyStamp(value) ? value : fallback,
  );
}

function normalizeOptionalStamp(value) {
  return hasDestinyStamp(value) ? normalizeDestinyStamp(value) : null;
}

function getRecentLaneWithinLead(
  laneStamp,
  currentImmediateSessionStamp,
  maximumLead,
) {
  if (!hasDestinyStamp(laneStamp)) {
    return null;
  }
  const normalizedLaneStamp = normalizeDestinyStamp(laneStamp);
  const normalizedCurrentImmediateSessionStamp = normalizeRequiredStamp(
    currentImmediateSessionStamp,
    0,
  );
  const normalizedMaximumLead = Math.max(0, toInt(maximumLead, 0));
  return (
    normalizedLaneStamp !== normalizedCurrentImmediateSessionStamp &&
    isDestinyStampWithinForwardWindow(
      normalizedCurrentImmediateSessionStamp,
      normalizedLaneStamp,
      normalizedMaximumLead,
    )
  )
    ? normalizedLaneStamp
    : null;
}

function resolveStateRefreshStamp(options = {}) {
  const requestedStamp = normalizeRequiredStamp(options.requestedStamp, 0);
  const currentImmediateSessionStamp = normalizeRequiredStamp(
    options.currentImmediateSessionStamp,
    0,
  );
  const currentSessionStamp = normalizeRequiredStamp(
    options.currentSessionStamp,
    currentImmediateSessionStamp,
  );
  const recentEmittedOwnerCriticalMaxLead = Math.max(
    0,
    toInt(options.recentEmittedOwnerCriticalMaxLead, 0),
  );
  const recentFutureLastSentLane = getRecentLaneWithinLead(
    options.lastSentDestinyStamp,
    currentImmediateSessionStamp,
    recentEmittedOwnerCriticalMaxLead,
  );
  const recentProjectedLastSentLane = getRecentLaneWithinLead(
    options.projectedLastSentLane,
    currentImmediateSessionStamp,
    recentEmittedOwnerCriticalMaxLead,
  );
  const recentOwnerMissileLifecycleLane = getRecentLaneWithinLead(
    options.lastOwnerMissileLifecycleStamp,
    currentImmediateSessionStamp,
    recentEmittedOwnerCriticalMaxLead,
  );
  const recentProjectedOwnerMissileLifecycleLane = getRecentLaneWithinLead(
    options.projectedOwnerMissileLifecycleLane,
    currentImmediateSessionStamp,
    recentEmittedOwnerCriticalMaxLead,
  );
  const recentOwnerMovementLane = getRecentLaneWithinLead(
    options.lastPilotCommandMovementStamp,
    currentImmediateSessionStamp,
    recentEmittedOwnerCriticalMaxLead,
  );
  // Preserve all five current monotonic contributors. Missile lifecycle
  // lanes remain diagnostics as well as real floors when they are recent.
  const monotonicCandidates = [
    recentFutureLastSentLane,
    recentProjectedLastSentLane,
    recentOwnerMovementLane,
    recentOwnerMissileLifecycleLane,
    recentProjectedOwnerMissileLifecycleLane,
  ].filter(hasDestinyStamp);
  const monotonicRefreshFloorBase = monotonicCandidates.length > 0
    ? selectFurthestDestinyStamp(
        currentImmediateSessionStamp,
        monotonicCandidates,
        recentEmittedOwnerCriticalMaxLead,
      )
    : null;
  const liveStateResetFloor = selectFurthestDestinyStamp(
    currentImmediateSessionStamp,
    [currentImmediateSessionStamp, currentSessionStamp],
    DESTINY_STAMP_MAX_ORDERING_DISTANCE,
  );
  const stamp = selectFurthestDestinyStamp(
    currentImmediateSessionStamp,
    [
      requestedStamp,
      liveStateResetFloor,
      hasDestinyStamp(monotonicRefreshFloorBase)
        ? advanceDestinyStamp(monotonicRefreshFloorBase, 1)
        : null,
    ],
    DESTINY_STAMP_MAX_ORDERING_DISTANCE,
  );

  return {
    recentFutureLastSentLane,
    recentProjectedLastSentLane,
    recentOwnerMissileLifecycleLane,
    recentProjectedOwnerMissileLifecycleLane,
    recentOwnerMovementLane,
    monotonicRefreshFloorBase,
    liveStateResetFloor,
    stamp,
  };
}

function clampQueuedSubwarpUpdates(options = {}) {
  const queuedUpdates = Array.isArray(options.queuedUpdates)
    ? options.queuedUpdates
    : [];
  if (queuedUpdates.length === 0) {
    return queuedUpdates;
  }

  const visibleFloorStamp = normalizeOptionalStamp(options.visibleFloorStamp);
  const presentedFloorStamp = normalizeOptionalStamp(options.presentedFloorStamp);
  const projectedFloorStamp = normalizeOptionalStamp(options.projectedFloorStamp);
  const restampPayloadState =
    typeof options.restampPayloadState === "function"
      ? options.restampPayloadState
      : null;

  return queuedUpdates.map((update) => {
    const authoredStamp = normalizeRequiredStamp(update && update.stamp, 0);
    const deliveryStamp = selectFurthestDestinyStamp(
      authoredStamp,
      [
        authoredStamp,
        visibleFloorStamp,
        presentedFloorStamp,
        projectedFloorStamp,
      ],
      DESTINY_STAMP_MAX_FORWARD_LEAD,
    );
    if (deliveryStamp === authoredStamp) {
      return update;
    }
    return {
      ...update,
      stamp: deliveryStamp,
      payload: restampPayloadState
        ? restampPayloadState(update && update.payload, deliveryStamp)
        : (update && update.payload),
    };
  });
}

module.exports = {
  resolveStateRefreshStamp,
  clampQueuedSubwarpUpdates,
};
