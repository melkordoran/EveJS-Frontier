"use strict";

const {
  MICHELLE_DIRECT_CRITICAL_ECHO_DESTINY_LEAD,
  MICHELLE_HELD_FUTURE_DESTINY_LEAD,
  MICHELLE_POST_HELD_FUTURE_DESTINY_LEAD,
} = require("../delivery/michelleContract");
const {
  resolveDestinyAuthorityCommandTuple,
  resolveDestinyAuthorityLaneTuple,
} = require("../authority/destinySessionState");
const {
  buildBootstrapAcquireSendOptions,
  buildObserverCombatPresentedSendOptions,
  buildOwnerMissileFreshAcquireSendOptions,
} = require("../delivery/sendOptions");
const {
  DESTINY_STAMP_MAX_FORWARD_LEAD,
  advanceDestinyStamp,
  hasDestinyStamp,
  isDestinyStampAfter,
  isDestinyStampWithinForwardWindow,
  normalizeDestinyStamp,
  resolveOptionalDestinyStamp,
  selectFurthestDestinyStamp,
  selectLaterDestinyStamp,
} = require("../delivery/stamps");

function toFiniteNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function toInt(value, fallback = 0) {
  return Math.trunc(toFiniteNumber(value, fallback));
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function callStamp(fn, args, fallback = 0) {
  return normalizeDestinyStamp(
    typeof fn === "function" ? fn(...args) : fallback,
    fallback,
  );
}

function buildAddBallsTimelinePlan(options = {}) {
  const inputOptions =
    options.inputOptions && typeof options.inputOptions === "object"
      ? options.inputOptions
      : {};
  const entities = Array.isArray(options.entities) ? options.entities : [];
  if (!Number.isFinite(Number(options.rawSimTimeMs))) {
    throw new TypeError("AddBalls timeline requires rawSimTimeMs");
  }
  const rawSimTimeMs = Number(options.rawSimTimeMs);
  for (const callbackName of [
    "getCurrentDestinyStamp",
    "getNextDestinyStamp",
    "getCurrentSessionDestinyStamp",
    "getImmediateDestinyStampForSession",
    "translateDestinyStampForSession",
    "getPendingHistorySafeSessionDestinyStamp",
    "getCurrentVisibleDestinyStampForSession",
    "getCurrentPresentedSessionDestinyStamp",
  ]) {
    if (typeof options[callbackName] !== "function") {
      throw new TypeError(`AddBalls timeline requires ${callbackName}`);
    }
  }
  const useFreshAcquireTimeline = options.useFreshAcquireTimeline === true;
  const allFreshAcquireEntitiesAreMissiles =
    entities.length > 0 &&
    entities.every((entity) => entity && entity.kind === "missile");
  const containsOwnerLaunchedMissiles =
    options.containsOwnerLaunchedMissiles === true;
  const containsDeferredFreshAcquireMissiles =
    useFreshAcquireTimeline &&
    entities.some(
      (entity) => entity && entity.deferUntilInitialVisibilitySync === true,
    );

  // Preserve the current owner/observer lane policy. Fresh missile acquires
  // stay on their authored tick; non-missile acquisition uses Michelle's
  // held-future window.
  const defaultFreshAcquireLead =
    containsOwnerLaunchedMissiles
      ? 0
      : allFreshAcquireEntitiesAreMissiles
        ? 0
        : MICHELLE_HELD_FUTURE_DESTINY_LEAD;
  const defaultMaximumFreshAcquireLead = MICHELLE_HELD_FUTURE_DESTINY_LEAD;
  const maximumFreshAcquireLead = clamp(
    Math.max(
      toInt(
        inputOptions.maximumLeadFromCurrentHistory,
        defaultMaximumFreshAcquireLead,
      ),
      0,
    ),
    0,
    DESTINY_STAMP_MAX_FORWARD_LEAD,
  );
  const freshAcquireLead = clamp(
    toInt(
      inputOptions.minimumLeadFromCurrentHistory,
      defaultFreshAcquireLead,
    ),
    0,
    maximumFreshAcquireLead,
  );

  const rawNowStamp = callStamp(
    options.getCurrentDestinyStamp,
    [rawSimTimeMs],
    Math.floor(rawSimTimeMs / 1000),
  );
  const defaultRawStamp = useFreshAcquireTimeline
    ? advanceDestinyStamp(rawNowStamp, freshAcquireLead)
    : callStamp(options.getNextDestinyStamp, [rawSimTimeMs], rawNowStamp);
  const currentSessionStamp = callStamp(
    options.getCurrentSessionDestinyStamp,
    [rawSimTimeMs],
    rawNowStamp,
  );
  const currentImmediateSessionStamp = callStamp(
    options.getImmediateDestinyStampForSession,
    [currentSessionStamp],
    currentSessionStamp,
  );
  const authorityState =
    options.authorityState && typeof options.authorityState === "object"
      ? options.authorityState
      : {};
  const sessionSpace =
    options.sessionSpace && typeof options.sessionSpace === "object"
      ? options.sessionSpace
      : {};
  const lastOwnerMissileFreshAcquireTuple =
    resolveDestinyAuthorityLaneTuple({
      authorityState,
      legacyState: sessionSpace,
      stampKey: "lastOwnerMissileFreshAcquireStamp",
      rawDispatchKey: "lastOwnerMissileFreshAcquireRawDispatchStamp",
      anchorKey: "lastOwnerMissileFreshAcquireAnchorStamp",
    });
  const lastOwnerMissileFreshAcquireStamp =
    lastOwnerMissileFreshAcquireTuple.stamp;
  const lastOwnerMissileFreshAcquireAnchorStamp =
    lastOwnerMissileFreshAcquireTuple.anchorStamp;
  const allowAdjacentRawOwnerFreshAcquireLaneReuse =
    !(
      containsOwnerLaunchedMissiles &&
      isDestinyStampAfter(
        currentSessionStamp,
        lastOwnerMissileFreshAcquireStamp,
        DESTINY_STAMP_MAX_FORWARD_LEAD,
      ) &&
      hasDestinyStamp(lastOwnerMissileFreshAcquireAnchorStamp) &&
      isDestinyStampAfter(
        lastOwnerMissileFreshAcquireAnchorStamp,
        currentSessionStamp,
        DESTINY_STAMP_MAX_FORWARD_LEAD,
      )
    );
  const currentVisibleSessionStamp = callStamp(
    options.getCurrentVisibleDestinyStampForSession,
    [currentSessionStamp],
    currentSessionStamp,
  );
  const currentPresentedSessionStamp = callStamp(
    options.getCurrentPresentedSessionDestinyStamp,
    [rawSimTimeMs, MICHELLE_HELD_FUTURE_DESTINY_LEAD],
    currentVisibleSessionStamp,
  );
  const lastPilotCommandMovementStamp =
    resolveDestinyAuthorityCommandTuple({
      authorityState,
      legacyState: sessionSpace,
    }).stamp;
  const hasRecentOwnerPilotMovementLane =
    isDestinyStampWithinForwardWindow(
      currentImmediateSessionStamp,
      lastPilotCommandMovementStamp,
      MICHELLE_POST_HELD_FUTURE_DESTINY_LEAD,
    );
  const defaultSessionStamp = useFreshAcquireTimeline
    ? containsOwnerLaunchedMissiles
      ? selectLaterDestinyStamp(
          currentSessionStamp,
          callStamp(
            options.translateDestinyStampForSession,
            [defaultRawStamp],
            defaultRawStamp,
          ),
          DESTINY_STAMP_MAX_FORWARD_LEAD,
        )
      : callStamp(
          options.getPendingHistorySafeSessionDestinyStamp,
          [defaultRawStamp, rawSimTimeMs, freshAcquireLead],
          defaultRawStamp,
        )
    : callStamp(
        options.translateDestinyStampForSession,
        [defaultRawStamp],
        defaultRawStamp,
      );
  const freshAcquireVisibleBarrierStamp = useFreshAcquireTimeline
    ? callStamp(
        options.getCurrentVisibleDestinyStampForSession,
        [rawNowStamp],
        currentVisibleSessionStamp,
      )
    : null;
  const freshAcquireClientAnchorStamp =
    hasDestinyStamp(freshAcquireVisibleBarrierStamp)
      ? advanceDestinyStamp(
          freshAcquireVisibleBarrierStamp,
          -MICHELLE_DIRECT_CRITICAL_ECHO_DESTINY_LEAD,
        )
      : null;
  const minimumFreshAcquireSessionStamp =
    useFreshAcquireTimeline &&
    !containsOwnerLaunchedMissiles &&
    !allFreshAcquireEntitiesAreMissiles
      ? advanceDestinyStamp(
          resolveOptionalDestinyStamp(
            freshAcquireClientAnchorStamp,
            defaultSessionStamp,
          ),
          freshAcquireLead,
        )
      : defaultSessionStamp;
  // Preserve the current presented-lane floor. John's later fork advances a
  // recent pilot-command lane again here; current target-client regressions
  // prove only the existing presented floor and it must not be changed by an
  // ownership extraction.
  const minimumPresentedFreshAcquireSessionStamp =
    useFreshAcquireTimeline && !allFreshAcquireEntitiesAreMissiles
      ? resolveOptionalDestinyStamp(currentPresentedSessionStamp)
      : null;
  const stamp =
    inputOptions.stampOverride === undefined ||
    inputOptions.stampOverride === null
      ? selectFurthestDestinyStamp(
          currentImmediateSessionStamp,
          [
            defaultSessionStamp,
            minimumFreshAcquireSessionStamp,
            minimumPresentedFreshAcquireSessionStamp,
          ],
          DESTINY_STAMP_MAX_FORWARD_LEAD,
        )
      : normalizeDestinyStamp(
          inputOptions.stampOverride,
          defaultSessionStamp,
        );

  const latestMissileLaunchSessionStamp =
    useFreshAcquireTimeline && allFreshAcquireEntitiesAreMissiles
      ? entities.reduce((latestStamp, entity) => {
          const launchedAtMs = toFiniteNumber(
            entity && entity.launchedAtMs,
            rawSimTimeMs,
          );
          const launchStamp = callStamp(
            options.getCurrentSessionDestinyStamp,
            [launchedAtMs],
            currentSessionStamp,
          );
          return selectLaterDestinyStamp(
            latestStamp,
            launchStamp,
            DESTINY_STAMP_MAX_FORWARD_LEAD,
          );
        }, null)
      : null;
  const useDeferredMissileLaunchSnapshots =
    useFreshAcquireTimeline &&
    allFreshAcquireEntitiesAreMissiles &&
    entities.length > 0 &&
    entities.every((entity) => (
      entity &&
      entity.kind === "missile" &&
      entity.deferUntilInitialVisibilitySync === true &&
      entity.launchPresentationSnapshot &&
      typeof entity.launchPresentationSnapshot === "object"
    ));
  const useLaunchStateForMissileFreshAcquire =
    useDeferredMissileLaunchSnapshots &&
    hasDestinyStamp(latestMissileLaunchSessionStamp);
  const defaultMissileAuthoredStateStamp =
    useFreshAcquireTimeline && allFreshAcquireEntitiesAreMissiles
      ? useLaunchStateForMissileFreshAcquire
        ? containsOwnerLaunchedMissiles
          ? latestMissileLaunchSessionStamp
          : selectLaterDestinyStamp(
              latestMissileLaunchSessionStamp,
              currentVisibleSessionStamp,
              DESTINY_STAMP_MAX_FORWARD_LEAD,
            )
        : containsOwnerLaunchedMissiles
          ? defaultSessionStamp
          : currentVisibleSessionStamp
      : stamp;
  const authoredStateStamp =
    useFreshAcquireTimeline && allFreshAcquireEntitiesAreMissiles
      ? (
        inputOptions.stampOverride === undefined ||
        inputOptions.stampOverride === null
          ? defaultMissileAuthoredStateStamp
          : normalizeDestinyStamp(
              inputOptions.stampOverride,
              defaultMissileAuthoredStateStamp,
            )
      )
      : stamp;

  const sendOptions = buildBootstrapAcquireSendOptions({
    translateStamps: false,
  });
  if (useFreshAcquireTimeline && allFreshAcquireEntitiesAreMissiles) {
    Object.assign(
      sendOptions,
      containsOwnerLaunchedMissiles
        ? buildOwnerMissileFreshAcquireSendOptions({
            allowAdjacentRawFreshAcquireLaneReuse:
              allowAdjacentRawOwnerFreshAcquireLaneReuse,
          })
        : buildObserverCombatPresentedSendOptions(),
    );
  } else if (useFreshAcquireTimeline) {
    sendOptions.avoidCurrentHistoryInsertion = true;
    sendOptions.preservePayloadStateStamp = false;
    sendOptions.minimumLeadFromCurrentHistory =
      MICHELLE_HELD_FUTURE_DESTINY_LEAD;
    sendOptions.maximumLeadFromCurrentHistory =
      MICHELLE_HELD_FUTURE_DESTINY_LEAD;
    sendOptions.historyLeadUsesImmediateSessionStamp =
      hasRecentOwnerPilotMovementLane ? undefined : true;
    sendOptions.historyLeadUsesPresentedSessionStamp =
      hasRecentOwnerPilotMovementLane || undefined;
    sendOptions.historyLeadPresentedMaximumFutureLead =
      hasRecentOwnerPilotMovementLane
        ? MICHELLE_HELD_FUTURE_DESTINY_LEAD
        : undefined;
    sendOptions.destinyAuthorityAllowPostHeldFuture = true;
  }

  return {
    allFreshAcquireEntitiesAreMissiles,
    allowAdjacentRawOwnerFreshAcquireLaneReuse,
    authoredStateStamp,
    containsDeferredFreshAcquireMissiles,
    containsOwnerLaunchedMissiles,
    currentImmediateSessionStamp,
    currentPresentedSessionStamp,
    currentSessionStamp,
    currentVisibleSessionStamp,
    defaultFreshAcquireLead,
    defaultMissileAuthoredStateStamp,
    defaultRawStamp,
    defaultSessionStamp,
    freshAcquireLead,
    freshAcquireVisibleBarrierStamp,
    hasRecentOwnerPilotMovementLane,
    latestMissileLaunchSessionStamp,
    maximumFreshAcquireLead,
    minimumFreshAcquireSessionStamp,
    minimumPresentedFreshAcquireSessionStamp,
    sendOptions,
    stamp,
    useDeferredMissileLaunchSnapshots,
    useFreshAcquireTimeline,
    useLaunchStateForMissileFreshAcquire,
  };
}

module.exports = {
  buildAddBallsTimelinePlan,
};
