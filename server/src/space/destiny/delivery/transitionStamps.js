"use strict";

const {
  snapshotDestinyAuthorityState,
} = require("../authority/destinySessionState");
const {
  restoreAuthorityDeliveryState,
  snapshotAuthorityDeliveryState,
} = require("./deliveryTransaction");
const {
  advanceDestinyStamp,
  hasDestinyStamp,
  normalizeDestinyStamp,
  selectLaterDestinyStamp,
} = require("./stamps");

function toFiniteNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

/**
 * Capture the complete per-session Destiny presentation authority for an
 * in-place ego-ball replacement.  The returned handoff is deliberately bound
 * to both the exact network session and solar scene: carrying Michelle's
 * history into a different session or system would turn a legitimate fresh
 * ballpark bootstrap into stale-history corruption.
 */
function createSameSceneDestinyPresentationAuthorityHandoff(scene, session) {
  if (!scene || !session || !session._space) {
    return null;
  }

  const sourceSystemID = toInt(session._space.systemID, 0);
  const sourceSceneSystemID = toInt(scene.systemID, 0);
  if (sourceSystemID <= 0 || sourceSceneSystemID !== sourceSystemID) {
    return null;
  }

  // Materialize the canonical authority before the generic delivery snapshot
  // clones it.  This carries every authority lane as one SSOT object together
  // with its compatibility mirrors; no transition-specific field list can
  // silently fall behind when the authority model grows.
  snapshotDestinyAuthorityState(session);
  const authoritySnapshot = snapshotAuthorityDeliveryState(session);
  const visibilitySnapshot = {
    visibleDynamicEntityIDs: new Set(
      session._space.visibleDynamicEntityIDs instanceof Set
        ? session._space.visibleDynamicEntityIDs
        : [],
    ),
    visibleBubbleScopedStaticEntityIDs: new Set(
      session._space.visibleBubbleScopedStaticEntityIDs instanceof Set
        ? session._space.visibleBubbleScopedStaticEntityIDs
        : [],
    ),
    freshlyVisibleDynamicEntityIDs: new Set(
      session._space.freshlyVisibleDynamicEntityIDs instanceof Set
        ? session._space.freshlyVisibleDynamicEntityIDs
        : [],
    ),
    freshlyVisibleDynamicEntityReleaseStampByID: new Map(
      session._space.freshlyVisibleDynamicEntityReleaseStampByID instanceof Map
        ? session._space.freshlyVisibleDynamicEntityReleaseStampByID
        : [],
    ),
  };
  const sourceScene = scene;
  const sourceSession = session;
  let consumed = false;

  return Object.freeze({
    restore(targetScene, targetSession) {
      if (
        consumed ||
        targetScene !== sourceScene ||
        targetSession !== sourceSession ||
        !targetScene ||
        !targetSession ||
        !targetSession._space ||
        toInt(targetScene.systemID, 0) !== sourceSystemID ||
        toInt(targetSession._space.systemID, 0) !== sourceSystemID
      ) {
        return false;
      }

      const restored = restoreAuthorityDeliveryState(
        targetSession,
        authoritySnapshot,
      );
      if (restored) {
        // Michelle keeps the native ballpark across an in-place shipid swap.
        // Preserve only accepted membership; pending acquisitions belong to
        // the discarded generation and must be replanned. The previous ego is
        // intentionally not restored as the presented ego for the new ship.
        targetSession._space.visibleDynamicEntityIDs = new Set(
          visibilitySnapshot.visibleDynamicEntityIDs,
        );
        targetSession._space.visibleBubbleScopedStaticEntityIDs = new Set(
          visibilitySnapshot.visibleBubbleScopedStaticEntityIDs,
        );
        targetSession._space.freshlyVisibleDynamicEntityIDs = new Set(
          visibilitySnapshot.freshlyVisibleDynamicEntityIDs,
        );
        targetSession._space.freshlyVisibleDynamicEntityReleaseStampByID =
          new Map(
            visibilitySnapshot.freshlyVisibleDynamicEntityReleaseStampByID,
          );
        targetSession._space.presentedEgoEntityID = null;
        consumed = true;
      }
      return restored;
    },
  });
}

function resolveSameSceneEgoAddBallsStamp(scene, session, nowMs = null) {
  if (!scene || !session) {
    return null;
  }

  const resolvedNowMs = toFiniteNumber(
    nowMs,
    typeof scene.getCurrentSimTimeMs === "function"
      ? scene.getCurrentSimTimeMs()
      : 0,
  );
  const rawCurrentPresentedStamp =
    typeof scene.getCurrentPresentedSessionDestinyStamp === "function"
      ? scene.getCurrentPresentedSessionDestinyStamp(session, resolvedNowMs)
      : null;
  const currentPresentedStamp = hasDestinyStamp(rawCurrentPresentedStamp)
    ? normalizeDestinyStamp(rawCurrentPresentedStamp)
    : null;
  const authorityState = snapshotDestinyAuthorityState(session);
  const rawLastSentStamp = hasDestinyStamp(
    authorityState && authorityState.lastPresentedStamp,
  )
    ? authorityState.lastPresentedStamp
    : session && session._space && session._space.lastSentDestinyStamp;
  const lastSentStamp = hasDestinyStamp(rawLastSentStamp)
    ? normalizeDestinyStamp(rawLastSentStamp)
    : null;
  const floorStamp = hasDestinyStamp(lastSentStamp)
    ? advanceDestinyStamp(lastSentStamp, 1)
    : null;
  return selectLaterDestinyStamp(currentPresentedStamp, floorStamp);
}

module.exports = {
  createSameSceneDestinyPresentationAuthorityHandoff,
  resolveSameSceneEgoAddBallsStamp,
};
