"use strict";

const path = require("path");

const log = require(path.join(__dirname, "../../../utils/logger"));

const {
  DESTINY_CONTRACTS,
  inferDestinyContract,
} = require("./destinyContracts");
const {
  createDestinyJourneyLog,
} = require("./destinyJourneyLog");
const {
  resolveDestinyAuthorityLaneTuple,
  snapshotDestinyAuthorityState,
  updateDestinyAuthorityState,
} = require("./destinySessionState");
const {
  advanceDestinyStamp,
  clampDestinyStampToCeiling,
  getDestinyStampForwardDistance,
  hasDestinyStamp,
  isDestinyStampAfter,
  isDestinyStampWithinForwardWindow,
  normalizeDestinyStamp,
  resolveOptionalDestinyStamp,
  selectFurthestDestinyStamp,
  selectFurthestPresentDestinyStamp,
  selectLaterDestinyStamp,
} = require("../delivery/stamps");
const {
  authorizeFollowingTeardownTransaction,
  hasSameSceneShipHandoffCapability,
  readFollowingTeardownCapability,
  recordSameSceneShipHandoffTransactionProof,
} = require("../delivery/sameSceneShipHandoff");

function createDestinyAuthority(deps = {}) {
  const {
    buildMissileSessionSnapshot,
    clamp,
    destiny,
    getPayloadPrimaryEntityID,
    isMovementContractPayload,
    logMissileDebug,
    normalizeTraceValue,
    resolveDestinyLifecycleRestampState,
    resolveOwnerMonotonicState,
    resolvePreviousLastSentDestinyWasOwnerCritical,
    roundNumber,
    summarizeMissileUpdatesForLog,
    toInt,
    updatesContainMovementContractPayload,
    MICHELLE_DIRECT_CRITICAL_ECHO_DESTINY_LEAD,
    MICHELLE_HELD_FUTURE_DESTINY_LEAD,
    MICHELLE_POST_HELD_FUTURE_DESTINY_LEAD,
    PILOT_WARP_ACTIVATION_DELAY_DESTINY_TICKS,
    PILOT_WARP_HISTORY_SAFE_DESTINY_LEAD =
      PILOT_WARP_ACTIVATION_DELAY_DESTINY_TICKS,
  } = deps;

  const journeyLog = createDestinyJourneyLog({
    normalizeTraceValue,
  });
  const OWNER_SHIP_PRIME_PAYLOAD_NAMES = new Set([
    "CloakBall",
    "UncloakBall",
  ]);

  function buildSessionSnapshotSafe(runtime, session, rawSimTimeMs) {
    return typeof buildMissileSessionSnapshot === "function"
      ? buildMissileSessionSnapshot(runtime, session, rawSimTimeMs)
      : null;
  }

  function buildDecisionTree(restampSteps = []) {
    if (!Array.isArray(restampSteps) || restampSteps.length === 0) {
      return [];
    }
    return restampSteps.map((step, index) => ({
      order: index + 1,
      reason: step && typeof step.reason === "string"
        ? step.reason
        : "unknown",
      kind: step && typeof step.kind === "string"
        ? step.kind
        : "unknown",
      beforeStamp: toInt(step && step.beforeStamp, 0) >>> 0,
      candidateStamp: toInt(step && step.candidateStamp, 0) >>> 0,
      applied: step && step.applied === true,
      afterStamp: toInt(step && step.afterStamp, 0) >>> 0,
      metadata: normalizeTraceValue(step || {}),
    }));
  }

  function classifyEnvelope(payloads = [], options = {}) {
    const contract = inferDestinyContract(payloads, options);
    journeyLog.logMichelle("destiny.contract.classify", {
      contract,
      options,
      updates: summarizeMissileUpdatesForLog(payloads),
    });
    return contract;
  }

  function getDestinyHistoryAnchorStampForSession(
    runtime,
    session,
    rawSimTimeMs = runtime.getCurrentSimTimeMs(),
    options = {},
  ) {
    if (options && options.historyLeadUsesImmediateSessionStamp === true) {
      const currentSessionStamp = runtime.getCurrentSessionDestinyStamp(
        session,
        rawSimTimeMs,
      );
      return runtime.getImmediateDestinyStampForSession(
        session,
        currentSessionStamp,
      );
    }
    if (options && options.historyLeadUsesPresentedSessionStamp === true) {
      const presentedMaximumFutureLead = Math.max(
        0,
        toInt(
          options.historyLeadPresentedMaximumFutureLead,
          MICHELLE_HELD_FUTURE_DESTINY_LEAD,
        ),
      );
      return runtime.getCurrentPresentedSessionDestinyStamp(
        session,
        rawSimTimeMs,
        presentedMaximumFutureLead,
      );
    }
    if (options && options.historyLeadUsesCurrentSessionStamp === true) {
      return runtime.getCurrentSessionDestinyStamp(session, rawSimTimeMs);
    }
    const visibleStamp = runtime.getCurrentVisibleSessionDestinyStamp(
      session,
      rawSimTimeMs,
    );
    return advanceDestinyStamp(
      visibleStamp,
      -MICHELLE_DIRECT_CRITICAL_ECHO_DESTINY_LEAD,
    );
  }

  function resolveDestinyDeliveryStampForSession(
    runtime,
    session,
    authoredStamp,
    rawSimTimeMs = runtime.getCurrentSimTimeMs(),
    options = {},
  ) {
    const maximumHistorySafeLead = Math.max(
      MICHELLE_HELD_FUTURE_DESTINY_LEAD,
      MICHELLE_POST_HELD_FUTURE_DESTINY_LEAD,
      PILOT_WARP_HISTORY_SAFE_DESTINY_LEAD,
      clamp(
        toInt(options && options.maximumHistorySafeLeadOverride, 0),
        0,
        16,
      ),
    );
    const normalizedAuthoredStamp = normalizeDestinyStamp(authoredStamp, 0);
    const hasMinimumLead =
      options &&
      Object.prototype.hasOwnProperty.call(
        options,
        "minimumLeadFromCurrentHistory",
      );
    const hasMaximumLead =
      options &&
      Object.prototype.hasOwnProperty.call(
        options,
        "maximumLeadFromCurrentHistory",
      );
    const avoidCurrentHistoryInsertion =
      options && options.avoidCurrentHistoryInsertion === true;
    if (
      !session ||
      !session._space ||
      (!avoidCurrentHistoryInsertion && !hasMinimumLead && !hasMaximumLead)
    ) {
      return normalizedAuthoredStamp;
    }

    const minimumLeadFloor = avoidCurrentHistoryInsertion ? 1 : 0;
    const minimumLead = clamp(
      toInt(
        hasMinimumLead
          ? options.minimumLeadFromCurrentHistory
          : minimumLeadFloor,
        minimumLeadFloor,
      ),
      minimumLeadFloor,
      maximumHistorySafeLead,
    );
    const maximumLead = hasMaximumLead
      ? clamp(
        toInt(options.maximumLeadFromCurrentHistory, minimumLead),
        minimumLead,
        maximumHistorySafeLead,
      )
      : null;
    const historyAnchorStamp = getDestinyHistoryAnchorStampForSession(
      runtime,
      session,
      rawSimTimeMs,
      options,
    );
    const currentRawDispatchStamp = normalizeDestinyStamp(
      runtime.getCurrentDestinyStamp(rawSimTimeMs),
      0,
    );
    const authorityState = snapshotDestinyAuthorityState(session);
    const previousPresentedLane = resolveDestinyAuthorityLaneTuple({
      authorityState,
      legacyState: session && session._space,
      stampKey: "lastPresentedStamp",
      rawDispatchKey: "lastRawDispatchStamp",
      legacyStampKey: "lastSentDestinyStamp",
      legacyRawDispatchKey: "lastSentDestinyRawDispatchStamp",
    });
    const previousLastSentDestinyStamp = previousPresentedLane.stamp;
    const previousLastSentDestinyRawDispatchStamp =
      previousPresentedLane.rawDispatchStamp;
    const previousLastSentDestinyOnlyStaleProjectedOwnerMissileLane =
      previousPresentedLane.fromAuthority
        ? authorityState &&
          authorityState.lastSentOnlyStaleProjectedOwnerMissileLane === true
        : session &&
          session._space &&
          session._space.lastSentDestinyOnlyStaleProjectedOwnerMissileLane === true;
    const useRecentLastSentAsHistoryFloor =
      options && options.useRecentLastSentAsHistoryFloor === true;
    const hasMinimumSessionStamp = Boolean(
      options &&
      Object.prototype.hasOwnProperty.call(options, "minimumSessionStamp") &&
      hasDestinyStamp(options.minimumSessionStamp),
    );
    const minimumSessionStamp = hasMinimumSessionStamp
      ? normalizeDestinyStamp(options.minimumSessionStamp)
      : null;
    const hasPreviousLastSentDestinyStamp = hasDestinyStamp(
      previousLastSentDestinyStamp,
    );
    const hasPreviousLastSentDestinyRawDispatchStamp = hasDestinyStamp(
      previousLastSentDestinyRawDispatchStamp,
    );
    const previousRawDispatchDistance =
      hasPreviousLastSentDestinyRawDispatchStamp
        ? getDestinyStampForwardDistance(
            previousLastSentDestinyRawDispatchStamp,
            currentRawDispatchStamp,
          )
        : Number.POSITIVE_INFINITY;
    const recentLastSentHistoryFloor =
      useRecentLastSentAsHistoryFloor &&
      hasPreviousLastSentDestinyStamp &&
      hasPreviousLastSentDestinyRawDispatchStamp &&
      previousLastSentDestinyOnlyStaleProjectedOwnerMissileLane !== true &&
      previousRawDispatchDistance <= 1
        ? previousLastSentDestinyStamp
        : null;
    const minimumStamp = advanceDestinyStamp(historyAnchorStamp, minimumLead);
    const maximumStamp =
      maximumLead === null
        ? null
        : advanceDestinyStamp(historyAnchorStamp, maximumLead);

    let deliveryStamp = selectFurthestDestinyStamp(
      historyAnchorStamp,
      [normalizedAuthoredStamp, minimumStamp],
    );
    const authoredLead = getDestinyStampForwardDistance(
      historyAnchorStamp,
      normalizedAuthoredStamp,
    );
    const deliveryLead = getDestinyStampForwardDistance(
      historyAnchorStamp,
      deliveryStamp,
    );
    if (
      maximumStamp !== null &&
      authoredLead <= (
        maximumLead + MICHELLE_DIRECT_CRITICAL_ECHO_DESTINY_LEAD
      ) &&
      deliveryLead > maximumLead
    ) {
      deliveryStamp = maximumStamp;
    }
    if (recentLastSentHistoryFloor !== null) {
      deliveryStamp = selectLaterDestinyStamp(
        deliveryStamp,
        recentLastSentHistoryFloor,
      );
    }
    if (minimumSessionStamp !== null) {
      deliveryStamp = selectLaterDestinyStamp(
        deliveryStamp,
        minimumSessionStamp,
      );
    }
    journeyLog.logMichelle("destiny.delivery.resolve", {
      charID: session && session.characterID ? session.characterID : 0,
      shipID: session && session._space ? toInt(session._space.shipID, 0) : 0,
      authoredStamp: normalizedAuthoredStamp,
      rawSimTimeMs: roundNumber(rawSimTimeMs, 3),
      currentRawDispatchStamp,
      historyAnchorStamp,
      avoidCurrentHistoryInsertion,
      minimumLead,
      maximumLead,
      minimumStamp,
      maximumStamp,
      minimumSessionStamp,
      recentLastSentHistoryFloor,
      deliveryStamp,
      options,
    });
    return deliveryStamp >>> 0;
  }

  function prepareDestinyUpdateForSession(
    runtime,
    session,
    rawPayload,
    rawSimTimeMs = runtime.getCurrentSimTimeMs(),
    options = {},
  ) {
    if (!rawPayload || !Number.isFinite(Number(rawPayload.stamp))) {
      return rawPayload;
    }

    const translateStamps = options && options.translateStamps === true;
    const authoredStamp = normalizeDestinyStamp(
      translateStamps
        ? runtime.translateDestinyStampForSession(session, rawPayload.stamp)
        : rawPayload.stamp,
      0,
    );
    const deliveryStamp = resolveDestinyDeliveryStampForSession(
      runtime,
      session,
      authoredStamp,
      rawSimTimeMs,
      options,
    );
    const preservePayloadStateStamp =
      options && options.preservePayloadStateStamp === true;
    const payload =
      deliveryStamp !== authoredStamp && !preservePayloadStateStamp
        ? destiny.restampPayloadState(rawPayload.payload, deliveryStamp)
        : rawPayload.payload;
    return {
      ...rawPayload,
      authoredStamp,
      stamp: deliveryStamp,
      payload,
    };
  }

  function beginGroupJourney({
    session,
    updates,
    options = {},
    rawSimTimeMs = 0,
    currentRawDispatchStamp = 0,
  }) {
    const journeyId = journeyLog.allocateJourneyID("destiny");
    const contract = classifyEnvelope(updates, options);
    const authoritySessionBefore = snapshotDestinyAuthorityState(session);
    updateDestinyAuthorityState(session, {
      lastJourneyId: journeyId,
    });
    journeyLog.logJourney("destiny.authority.begin-group", {
      journeyId,
      contract,
      charID: session && session.characterID ? session.characterID : 0,
      shipID: session && session._space ? toInt(session._space.shipID, 0) : 0,
      rawDispatchStamp: toInt(currentRawDispatchStamp, 0) >>> 0,
      rawSimTimeMs: roundNumber(rawSimTimeMs, 3),
      authoritySessionBefore,
      originalUpdates: summarizeMissileUpdatesForLog(updates),
      options,
    });
    return {
      journeyId,
      contract,
      authoritySessionBefore,
      rawSimTimeMs: roundNumber(rawSimTimeMs, 3),
      currentRawDispatchStamp: toInt(currentRawDispatchStamp, 0) >>> 0,
      originalUpdates: summarizeMissileUpdatesForLog(updates),
    };
  }

  function planGroupEmission({
    deliveryTransaction = null,
    runtime,
    session,
    updatesGroup,
    emitOptions = {},
    sendOptions = {},
    rawSimTimeMs = runtime.getCurrentSimTimeMs(),
    currentRawDispatchStamp = 0,
    shouldTraceDispatch = false,
    destinyCallTraceID = 0,
    waitForBubble = false,
    firstGroup = false,
    sessionState = {},
    updatesContainObserverPresentedMonotonicPayload,
  }) {
    if (!Array.isArray(updatesGroup) || updatesGroup.length === 0) {
      return null;
    }

    currentRawDispatchStamp = normalizeDestinyStamp(
      currentRawDispatchStamp,
      0,
    );

    const authoritySessionState = snapshotDestinyAuthorityState(session);
    let localUpdates = updatesGroup;
    let localStamp = normalizeDestinyStamp(
      localUpdates[0] && localUpdates[0].stamp,
      0,
    );
    const minimumPostFreshAcquireStamp =
      emitOptions &&
      Object.prototype.hasOwnProperty.call(
        emitOptions,
        "minimumPostFreshAcquireStamp",
      ) &&
      hasDestinyStamp(emitOptions.minimumPostFreshAcquireStamp)
        ? normalizeDestinyStamp(emitOptions.minimumPostFreshAcquireStamp)
        : null;
    const minimumEntityPresentationStamp =
      emitOptions &&
      Object.prototype.hasOwnProperty.call(
        emitOptions,
        "minimumEntityPresentationStamp",
      ) &&
      hasDestinyStamp(emitOptions.minimumEntityPresentationStamp)
        ? normalizeDestinyStamp(emitOptions.minimumEntityPresentationStamp)
        : null;
    const isFreshAcquireLifecycleGroup = localUpdates.some(
      (payload) => payload && payload.freshAcquireLifecycleGroup === true,
    );
    const isMissileLifecycleGroup = localUpdates.some(
      (payload) => (
        payload &&
        (
          payload.missileLifecycleGroup === true ||
          payload.ownerMissileLifecycleGroup === true
        )
      ),
    );
    const isOwnerMissileLifecycleGroup = localUpdates.some(
      (payload) => payload && payload.ownerMissileLifecycleGroup === true,
    );
    const isSetStateGroup = localUpdates.some((payload) => (
      payload &&
      Array.isArray(payload.payload) &&
      payload.payload[0] === "SetState"
    ));
    const containsWarpPayload = localUpdates.some((update) => {
      const payload = update && Array.isArray(update.payload)
        ? update.payload
        : null;
      return payload && payload[0] === "WarpTo";
    });
    const containsRemoveBallsPayload = localUpdates.some((update) => {
      const payload = update && Array.isArray(update.payload)
        ? update.payload
        : null;
      return payload && payload[0] === "RemoveBalls";
    });
    const originalStamp = normalizeDestinyStamp(localStamp, 0);
    const authorityClassificationOptions = {
      ...(sendOptions && typeof sendOptions === "object" ? sendOptions : {}),
      ...(emitOptions && typeof emitOptions === "object" ? emitOptions : {}),
    };
    const authorityJourney = beginGroupJourney({
      session,
      updates: localUpdates,
      options: authorityClassificationOptions,
      rawSimTimeMs,
      currentRawDispatchStamp,
    });
    const isBootstrapAcquireGroup =
      authorityJourney.contract === DESTINY_CONTRACTS.BOOTSTRAP_ACQUIRE;
    const isDestructionTeardownGroup =
      authorityJourney.contract === DESTINY_CONTRACTS.DESTRUCTION_TEARDOWN;
    const traceDetails =
      shouldTraceDispatch || isSetStateGroup
        ? {
            journeyId: authorityJourney.journeyId,
            contract: authorityJourney.contract,
            destinyCallTraceID,
            rawDispatchStamp: currentRawDispatchStamp,
            rawSimTimeMs: roundNumber(rawSimTimeMs, 3),
            waitForBubble: waitForBubble && firstGroup,
            sendReason:
              typeof emitOptions.missileDebugReason === "string"
                ? emitOptions.missileDebugReason
                : null,
            groupReason:
              typeof emitOptions.groupReason === "string"
                ? emitOptions.groupReason
                : null,
            requestedMinimumPostFreshAcquireStamp: minimumPostFreshAcquireStamp,
            sessionBefore: buildSessionSnapshotSafe(runtime, session, rawSimTimeMs),
            authoritySessionBefore: authorityJourney.authoritySessionBefore,
            originalStamp,
            originalUpdates: summarizeMissileUpdatesForLog(localUpdates),
            groupFlags: {
              freshAcquireLifecycle: isFreshAcquireLifecycleGroup,
              missileLifecycle: isMissileLifecycleGroup,
              ownerMissileLifecycle: isOwnerMissileLifecycleGroup,
              setState: isSetStateGroup,
            },
            restampSteps: [],
          }
        : null;

    const restampLocalUpdates = (nextStamp) => {
      const normalizedNextStamp = normalizeDestinyStamp(nextStamp, localStamp);
      if (normalizedNextStamp === localStamp) {
        return false;
      }
      localUpdates = localUpdates.map((payload) => ({
        ...payload,
        stamp: normalizedNextStamp,
        payload:
          sendOptions &&
          sendOptions.preservePayloadStateStamp === true &&
          payload &&
          payload.freshAcquireLifecycleGroup === true
            ? payload.payload
            : destiny.restampPayloadState(payload.payload, normalizedNextStamp),
      }));
      localStamp = normalizedNextStamp;
      return true;
    };
    const recordFloorStage = (reason, candidateStamp, metadata = {}) => {
      const candidateIsPresent = hasDestinyStamp(candidateStamp);
      const normalizedCandidateStamp = candidateIsPresent
        ? normalizeDestinyStamp(candidateStamp)
        : null;
      if (!traceDetails) {
        if (
          normalizedCandidateStamp !== null &&
          isDestinyStampAfter(localStamp, normalizedCandidateStamp)
        ) {
          restampLocalUpdates(normalizedCandidateStamp);
        }
        return;
      }
      const beforeStamp = normalizeDestinyStamp(localStamp, 0);
      const applied =
        normalizedCandidateStamp !== null &&
        isDestinyStampAfter(beforeStamp, normalizedCandidateStamp);
      if (applied) {
        restampLocalUpdates(normalizedCandidateStamp);
      }
      traceDetails.restampSteps.push({
        reason,
        kind: "floor",
        beforeStamp,
        candidateStamp: normalizedCandidateStamp === null
          ? 0
          : normalizedCandidateStamp,
        candidatePresent: normalizedCandidateStamp !== null,
        applied,
        afterStamp: normalizeDestinyStamp(localStamp, 0),
        ...metadata,
      });
    };
    const recordCeilingStage = (reason, candidateStamp, metadata = {}) => {
      const beforeUpdates =
        metadata && metadata.captureBeforeUpdates === true
          ? summarizeMissileUpdatesForLog(localUpdates)
          : null;
      const candidateIsPresent = hasDestinyStamp(candidateStamp);
      const normalizedCandidateStamp = candidateIsPresent
        ? normalizeDestinyStamp(candidateStamp)
        : null;
      if (!traceDetails) {
        if (
          normalizedCandidateStamp !== null &&
          isDestinyStampAfter(normalizedCandidateStamp, localStamp)
        ) {
          restampLocalUpdates(normalizedCandidateStamp);
        }
        return;
      }
      const beforeStamp = normalizeDestinyStamp(localStamp, 0);
      const applied =
        normalizedCandidateStamp !== null &&
        isDestinyStampAfter(normalizedCandidateStamp, beforeStamp);
      if (applied) {
        restampLocalUpdates(normalizedCandidateStamp);
      }
      traceDetails.restampSteps.push({
        reason,
        kind: "ceiling",
        beforeStamp,
        candidateStamp: normalizedCandidateStamp === null
          ? 0
          : normalizedCandidateStamp,
        candidatePresent: normalizedCandidateStamp !== null,
        applied,
        afterStamp: normalizeDestinyStamp(localStamp, 0),
        beforeUpdates,
        ...metadata,
      });
    };

    const currentSessionStamp = normalizeDestinyStamp(
      runtime.getCurrentSessionDestinyStamp(session, rawSimTimeMs),
      0,
    );
    const currentImmediateSessionStamp =
      normalizeDestinyStamp(
        runtime.getImmediateDestinyStampForSession(
          session,
          currentSessionStamp,
        ),
        currentSessionStamp,
      );
    const ownerCommandLane = resolveDestinyAuthorityLaneTuple({
      authorityState: authoritySessionState,
      legacyState: session && session._space,
      stampKey: "lastOwnerCommandStamp",
      rawDispatchKey: "lastOwnerCommandRawDispatchStamp",
      anchorKey: "lastOwnerCommandAnchorStamp",
      legacyStampKey: "lastPilotCommandMovementStamp",
      legacyRawDispatchKey: "lastPilotCommandMovementRawDispatchStamp",
      legacyAnchorKey: "lastPilotCommandMovementAnchorStamp",
    });
    const lastOwnerPilotCommandMovementStamp = ownerCommandLane.stamp;
    const lastOwnerPilotCommandMovementAnchorStamp = ownerCommandLane.anchorStamp;
    const lastOwnerPilotCommandMovementRawDispatchStamp =
      ownerCommandLane.rawDispatchStamp;
    const lifecyclePreviousPresentedLane = resolveDestinyAuthorityLaneTuple({
      authorityState: authoritySessionState,
      legacyState: session && session._space,
      stampKey: "lastPresentedStamp",
      rawDispatchKey: "lastRawDispatchStamp",
      legacyStampKey: "lastSentDestinyStamp",
      legacyRawDispatchKey: "lastSentDestinyRawDispatchStamp",
    });
    const lifecyclePreviousLastSentDestinyStamp =
      lifecyclePreviousPresentedLane.stamp;
    const lifecyclePreviousLastSentDestinyRawDispatchStamp =
      lifecyclePreviousPresentedLane.rawDispatchStamp;
    const lifecyclePreviousLastSentDestinyWasOwnerCritical =
      lifecyclePreviousPresentedLane.fromAuthority
        ? authoritySessionState &&
          authoritySessionState.lastSentWasOwnerCritical === true
        : session &&
          session._space &&
          session._space.lastSentDestinyWasOwnerCritical === true;
    const lifecycleRestampState =
      typeof resolveDestinyLifecycleRestampState === "function"
        ? resolveDestinyLifecycleRestampState({
            localStamp,
            minimumPostFreshAcquireStamp,
            isFreshAcquireLifecycleGroup,
            isMissileLifecycleGroup,
            isOwnerMissileLifecycleGroup,
            currentSessionStamp,
            currentImmediateSessionStamp,
            currentRawDispatchStamp,
            lastFreshAcquireLifecycleStamp:
              resolveOptionalDestinyStamp(sessionState.lastFreshAcquireLifecycleStamp),
            lastMissileLifecycleStamp:
              resolveOptionalDestinyStamp(sessionState.lastMissileLifecycleStamp),
            lastOwnerMissileLifecycleStamp:
              resolveOptionalDestinyStamp(sessionState.lastOwnerMissileLifecycleStamp),
            lastOwnerMissileFreshAcquireStamp:
              resolveOptionalDestinyStamp(sessionState.lastOwnerMissileFreshAcquireStamp),
            lastOwnerMissileFreshAcquireRawDispatchStamp:
              resolveOptionalDestinyStamp(
                sessionState.lastOwnerMissileFreshAcquireRawDispatchStamp,
              ),
            lastOwnerMissileLifecycleRawDispatchStamp:
              resolveOptionalDestinyStamp(
                sessionState.lastOwnerMissileLifecycleRawDispatchStamp,
              ),
            previousLastSentDestinyStamp: lifecyclePreviousLastSentDestinyStamp,
            previousLastSentDestinyRawDispatchStamp:
              lifecyclePreviousLastSentDestinyRawDispatchStamp,
            previousLastSentDestinyWasOwnerCritical:
              lifecyclePreviousLastSentDestinyWasOwnerCritical,
            lastOwnerPilotCommandMovementStamp,
            lastOwnerPilotCommandMovementAnchorStamp,
            lastOwnerPilotCommandMovementRawDispatchStamp,
          })
        : {
            finalStamp: localStamp,
            freshAcquireFloor: null,
            missileLifecycleFloor: null,
            ownerMissileLifecycleFloor: null,
          };
    if (traceDetails && lifecycleRestampState.freshAcquireFloor) {
      traceDetails.freshAcquireFloor = lifecycleRestampState.freshAcquireFloor;
    }
    if (traceDetails && lifecycleRestampState.missileLifecycleFloor) {
      traceDetails.missileLifecycleFloor = lifecycleRestampState.missileLifecycleFloor;
    }
    if (traceDetails && lifecycleRestampState.ownerMissileLifecycleFloor) {
      traceDetails.ownerMissileLifecycleFloor =
        lifecycleRestampState.ownerMissileLifecycleFloor;
    }
    recordFloorStage(
      "lifecycle.finalStamp",
      lifecycleRestampState.finalStamp,
      {
        freshAcquireFloor: lifecycleRestampState.freshAcquireFloor,
        missileLifecycleFloor: lifecycleRestampState.missileLifecycleFloor,
        ownerMissileLifecycleFloor:
          lifecycleRestampState.ownerMissileLifecycleFloor,
      },
    );
    // Transaction-local entity causality is an input to authority planning,
    // not permission to widen Michelle's trusted future windows. Every
    // applicable owner, missile, observer, and subwarp ceiling below remains
    // authoritative over this general floor.
    recordFloorStage(
      "presentation.entityOrderFloor",
      minimumEntityPresentationStamp,
      {
        currentRawDispatchStamp,
      },
    );

    const maximumPlanningLead = Math.max(
      16,
      MICHELLE_HELD_FUTURE_DESTINY_LEAD +
        MICHELLE_POST_HELD_FUTURE_DESTINY_LEAD +
        PILOT_WARP_HISTORY_SAFE_DESTINY_LEAD +
        MICHELLE_DIRECT_CRITICAL_ECHO_DESTINY_LEAD,
    );
    const sessionStampFloorCap = advanceDestinyStamp(
      currentSessionStamp,
      MICHELLE_DIRECT_CRITICAL_ECHO_DESTINY_LEAD,
    );
    const allowsPostHeldFutureDelivery =
      (isBootstrapAcquireGroup && isFreshAcquireLifecycleGroup) ||
      isDestructionTeardownGroup ||
      isSetStateGroup ||
      containsWarpPayload ||
      (
        sendOptions &&
        (
          sendOptions.destinyAuthorityAllowPostHeldFuture === true ||
          toInt(sendOptions.minimumLeadFromCurrentHistory, 0) >
            MICHELLE_HELD_FUTURE_DESTINY_LEAD ||
          toInt(sendOptions.maximumLeadFromCurrentHistory, 0) >
            MICHELLE_HELD_FUTURE_DESTINY_LEAD ||
          toInt(sendOptions.maximumHistorySafeLeadOverride, 0) >
            MICHELLE_HELD_FUTURE_DESTINY_LEAD
        )
      );
    const followingTeardownCapability =
      readFollowingTeardownCapability(sendOptions);
    const allowsFollowingTeardownStamp = followingTeardownCapability
      ? authorizeFollowingTeardownTransaction({
          deliveryTransaction,
          originalStamp,
          previousLastSentDestinyStamp:
            lifecyclePreviousLastSentDestinyStamp,
          sendOptions,
          updates: localUpdates,
        })
      : false;
    if (followingTeardownCapability && !allowsFollowingTeardownStamp) {
      return null;
    }
    const subwarpHeldFutureCeilingStamp =
      allowsPostHeldFutureDelivery
        ? null
        : advanceDestinyStamp(
            currentSessionStamp,
            MICHELLE_HELD_FUTURE_DESTINY_LEAD,
          );
    const capSubwarpSafeFloor = (stamp) => {
      if (!hasDestinyStamp(stamp)) {
        return null;
      }
      const normalizedStamp = normalizeDestinyStamp(stamp);
      if (subwarpHeldFutureCeilingStamp === null) {
        return normalizedStamp;
      }
      return clampDestinyStampToCeiling(
        currentSessionStamp,
        normalizedStamp,
        subwarpHeldFutureCeilingStamp,
      );
    };
    const rawSameRawPublishedLastSentFloor =
      hasDestinyStamp(lifecyclePreviousLastSentDestinyStamp) &&
      hasDestinyStamp(lifecyclePreviousLastSentDestinyRawDispatchStamp) &&
      lifecyclePreviousLastSentDestinyRawDispatchStamp === currentRawDispatchStamp
        ? lifecyclePreviousLastSentDestinyStamp
        : null;
    const sameRawPublishedLastSentFloor =
      hasDestinyStamp(rawSameRawPublishedLastSentFloor)
        ? clampDestinyStampToCeiling(
            currentSessionStamp,
            rawSameRawPublishedLastSentFloor,
            sessionStampFloorCap,
          )
        : null;
    recordFloorStage(
      "published.sameRawLastSentFloor",
      sameRawPublishedLastSentFloor,
    );
    if (
      hasDestinyStamp(lifecyclePreviousLastSentDestinyStamp) &&
      hasDestinyStamp(lifecyclePreviousLastSentDestinyRawDispatchStamp) &&
      lifecyclePreviousLastSentDestinyRawDispatchStamp !== currentRawDispatchStamp
    ) {
      const cappedCrossRawLastSentFloor = clampDestinyStampToCeiling(
        currentSessionStamp,
        lifecyclePreviousLastSentDestinyStamp,
        sessionStampFloorCap,
      );
      recordFloorStage(
        "published.crossRawLastSentFloor",
        cappedCrossRawLastSentFloor,
      );
    }

    const ownerShipID =
      session && session._space
        ? (toInt(session._space.shipID, 0) >>> 0)
        : 0;
    const skipOwnerMonotonicRestamp =
      sendOptions && sendOptions.skipOwnerMonotonicRestamp === true;
    const containsMovementContractPayload =
      typeof updatesContainMovementContractPayload === "function"
        ? updatesContainMovementContractPayload(localUpdates)
        : false;
    const isOwnerPilotMovementGroup =
      ownerShipID > 0 &&
      localUpdates.some((update) => {
        const payload = update && Array.isArray(update.payload)
          ? update.payload
          : null;
        if (!payload || typeof isMovementContractPayload !== "function") {
          return false;
        }
        if (!isMovementContractPayload(payload)) {
          return false;
        }
        return typeof getPayloadPrimaryEntityID === "function" &&
          getPayloadPrimaryEntityID(payload) === ownerShipID;
      });
    const isOwnerShipPrimeGroup =
      ownerShipID > 0 &&
      localUpdates.some((update) => {
        const payload = update && Array.isArray(update.payload)
          ? update.payload
          : null;
        if (!payload || !OWNER_SHIP_PRIME_PAYLOAD_NAMES.has(payload[0])) {
          return false;
        }
        return typeof getPayloadPrimaryEntityID === "function" &&
          getPayloadPrimaryEntityID(payload) === ownerShipID;
      });
    const isOwnerDamageStateGroup =
      ownerShipID > 0 &&
      localUpdates.some((update) => {
        const payload = update && Array.isArray(update.payload)
          ? update.payload
          : null;
        if (!payload || payload[0] !== "OnDamageStateChange") {
          return false;
        }
        return (toInt(payload[1] && payload[1][0], 0) >>> 0) === ownerShipID;
      });
    const isOwnerCriticalGroup =
      ownerShipID > 0 &&
      (
        isOwnerMissileLifecycleGroup ||
        isSetStateGroup ||
        isOwnerPilotMovementGroup ||
        isOwnerShipPrimeGroup
      );
    const previousLastSentDestinyStamp =
      lifecyclePreviousPresentedLane.stamp;
    const previousLastSentDestinyRawDispatchStamp =
      lifecyclePreviousPresentedLane.rawDispatchStamp;
    const previousLastSentDestinyOnlyStaleProjectedOwnerMissileLane =
      lifecyclePreviousPresentedLane.fromAuthority
        ? authoritySessionState &&
          authoritySessionState.lastSentOnlyStaleProjectedOwnerMissileLane === true
        : session &&
          session._space &&
          session._space.lastSentDestinyOnlyStaleProjectedOwnerMissileLane === true;
    const previousLastSentDestinyWasOwnerCritical =
      typeof resolvePreviousLastSentDestinyWasOwnerCritical === "function"
        ? resolvePreviousLastSentDestinyWasOwnerCritical({
            explicitWasOwnerCritical:
              authoritySessionState &&
              typeof authoritySessionState.lastSentWasOwnerCritical === "boolean"
                ? authoritySessionState.lastSentWasOwnerCritical === true
                : (
                    session &&
                    session._space &&
                    typeof session._space.lastSentDestinyWasOwnerCritical === "boolean"
                      ? session._space.lastSentDestinyWasOwnerCritical === true
                      : undefined
                  ),
            previousLastSentDestinyStamp,
            lastOwnerMissileLifecycleStamp:
              resolveOptionalDestinyStamp(sessionState.lastOwnerMissileLifecycleStamp),
            lastOwnerMissileFreshAcquireStamp:
              resolveOptionalDestinyStamp(sessionState.lastOwnerMissileFreshAcquireStamp),
            lastOwnerNonMissileCriticalStamp:
              resolveOptionalDestinyStamp(sessionState.lastOwnerNonMissileCriticalStamp),
            lastOwnerPilotCommandMovementStamp,
          })
        : lifecyclePreviousLastSentDestinyWasOwnerCritical;
    const containsObserverPresentedMonotonicPayload =
      typeof updatesContainObserverPresentedMonotonicPayload === "function"
        ? updatesContainObserverPresentedMonotonicPayload(localUpdates, ownerShipID)
        : false;
    const currentPresentedObserverStamp =
      containsObserverPresentedMonotonicPayload &&
      previousLastSentDestinyOnlyStaleProjectedOwnerMissileLane !== true
        ? normalizeDestinyStamp(
            runtime.getCurrentPresentedSessionDestinyStamp(
              session,
              rawSimTimeMs,
              MICHELLE_HELD_FUTURE_DESTINY_LEAD +
                MICHELLE_POST_HELD_FUTURE_DESTINY_LEAD,
            ),
            currentSessionStamp,
          )
        : null;
    const rawPresentedOwnerCriticalStamp =
      ownerShipID > 0
        ? normalizeDestinyStamp(
            runtime.getCurrentPresentedSessionDestinyStamp(
              session,
              rawSimTimeMs,
              PILOT_WARP_HISTORY_SAFE_DESTINY_LEAD,
            ),
            currentSessionStamp,
          )
        : null;
    const currentPresentedOwnerCriticalStamp =
      isMissileLifecycleGroup &&
      isOwnerMissileLifecycleGroup !== true
        ? clampDestinyStampToCeiling(
            currentSessionStamp,
            rawPresentedOwnerCriticalStamp,
            advanceDestinyStamp(
              currentSessionStamp,
              MICHELLE_HELD_FUTURE_DESTINY_LEAD,
            ),
          )
        : rawPresentedOwnerCriticalStamp;
    const currentPresentedObserverSubwarpSafeStamp =
      capSubwarpSafeFloor(currentPresentedObserverStamp);
    const bootstrapAcquireNeedsOwnerMovementClearance =
      isBootstrapAcquireGroup &&
      isFreshAcquireLifecycleGroup &&
      isDestinyStampWithinForwardWindow(
        currentImmediateSessionStamp,
        lastOwnerPilotCommandMovementStamp,
        maximumPlanningLead,
      ) &&
      (
        currentPresentedOwnerCriticalStamp === null ||
        isDestinyStampWithinForwardWindow(
          currentImmediateSessionStamp,
          lastOwnerPilotCommandMovementStamp,
          getDestinyStampForwardDistance(
            currentImmediateSessionStamp,
            currentPresentedOwnerCriticalStamp,
          ),
        )
      );
    const observerDirectPresentedMonotonicFloor =
      !isOwnerCriticalGroup &&
      !isOwnerDamageStateGroup &&
      containsObserverPresentedMonotonicPayload
        ? currentPresentedObserverSubwarpSafeStamp
        : null;
    const bootstrapAcquireClearCeilingStamp =
      isBootstrapAcquireGroup &&
      isFreshAcquireLifecycleGroup &&
      !isMissileLifecycleGroup &&
      !isOwnerCriticalGroup &&
      !isOwnerDamageStateGroup
        ? advanceDestinyStamp(
            bootstrapAcquireNeedsOwnerMovementClearance
              ? selectFurthestDestinyStamp(
                  currentImmediateSessionStamp,
                  [
                    currentPresentedObserverSubwarpSafeStamp,
                    lastOwnerPilotCommandMovementStamp,
                  ],
                  maximumPlanningLead,
                )
              : currentImmediateSessionStamp,
            MICHELLE_HELD_FUTURE_DESTINY_LEAD,
          )
        : null;
    const latestFreshAcquireLane = selectFurthestPresentDestinyStamp(
      currentSessionStamp,
      [
        resolveOptionalDestinyStamp(
          sessionState.lastOwnerMissileFreshAcquireStamp,
        ),
        resolveOptionalDestinyStamp(
          sessionState.lastFreshAcquireLifecycleStamp,
        ),
      ],
      maximumPlanningLead,
    );
    const sameRawNonCriticalPresentedLaneHasClearedOwnerFreshAcquireLane =
      hasDestinyStamp(previousLastSentDestinyStamp) &&
      hasDestinyStamp(previousLastSentDestinyRawDispatchStamp) &&
      previousLastSentDestinyRawDispatchStamp === currentRawDispatchStamp &&
      hasDestinyStamp(currentPresentedOwnerCriticalStamp) &&
      previousLastSentDestinyStamp === currentPresentedOwnerCriticalStamp &&
      hasDestinyStamp(latestFreshAcquireLane) &&
      isDestinyStampAfter(
        latestFreshAcquireLane,
        previousLastSentDestinyStamp,
        maximumPlanningLead,
      );
    const skipOwnerMonotonicRestampForNonCriticalPresentedLane =
      skipOwnerMonotonicRestamp !== true &&
      sendOptions &&
      sendOptions.skipOwnerMonotonicRestampWhenPreviousNotOwnerCritical === true &&
      isOwnerMissileLifecycleGroup === true &&
      isFreshAcquireLifecycleGroup === true &&
      !sameRawNonCriticalPresentedLaneHasClearedOwnerFreshAcquireLane &&
      previousLastSentDestinyWasOwnerCritical !== true &&
      !(
        hasDestinyStamp(previousLastSentDestinyStamp) &&
        previousLastSentDestinyStamp === (
          resolveOptionalDestinyStamp(
            sessionState.lastOwnerMissileLifecycleStamp,
          )
        ) &&
        previousLastSentDestinyStamp !== (
          resolveOptionalDestinyStamp(
            sessionState.lastOwnerMissileFreshAcquireStamp,
          )
        )
      ) &&
      hasDestinyStamp(previousLastSentDestinyStamp) &&
      previousLastSentDestinyStamp === currentPresentedOwnerCriticalStamp &&
      hasDestinyStamp(previousLastSentDestinyRawDispatchStamp) &&
      previousLastSentDestinyRawDispatchStamp === currentRawDispatchStamp;
    const ownerMonotonicState = (
      skipOwnerMonotonicRestamp ||
      skipOwnerMonotonicRestampForNonCriticalPresentedLane
    )
      ? {
          maximumTrustedRecentEmittedOwnerCriticalStamp: null,
          projectedRecentLastSentLane: null,
          presentedLastSentMonotonicFloor: null,
          genericMonotonicFloor: null,
          recentOwnerCriticalMonotonicFloor: null,
          ownerCriticalCeilingStamp: null,
        }
      : (
        typeof resolveOwnerMonotonicState === "function"
          ? resolveOwnerMonotonicState({
              hasOwnerShip: ownerShipID > 0,
              containsMovementContractPayload,
              isSetStateGroup,
              isOwnerPilotMovementGroup,
              isOwnerShipPrimeGroup,
              isMissileLifecycleGroup,
              isOwnerMissileLifecycleGroup,
              isOwnerCriticalGroup,
              isFreshAcquireLifecycleGroup,
              isOwnerDamageStateGroup,
              currentLocalStamp: localStamp,
              currentSessionStamp,
              currentImmediateSessionStamp,
              currentPresentedOwnerCriticalStamp,
              currentRawDispatchStamp,
              recentEmittedOwnerCriticalMaxLead:
                MICHELLE_HELD_FUTURE_DESTINY_LEAD +
                MICHELLE_POST_HELD_FUTURE_DESTINY_LEAD +
                PILOT_WARP_HISTORY_SAFE_DESTINY_LEAD,
              ownerCriticalCeilingLead: MICHELLE_DIRECT_CRITICAL_ECHO_DESTINY_LEAD,
              previousLastSentDestinyStamp,
              previousLastSentDestinyRawDispatchStamp,
              previousLastSentDestinyExplicitWasOwnerCritical:
                authoritySessionState &&
                typeof authoritySessionState.lastSentWasOwnerCritical === "boolean"
                  ? authoritySessionState.lastSentWasOwnerCritical === true
                  : (
                      session &&
                      session._space &&
                      typeof session._space.lastSentDestinyWasOwnerCritical === "boolean"
                        ? session._space.lastSentDestinyWasOwnerCritical === true
                        : false
                    ),
              previousLastSentDestinyWasOwnerCritical,
              previousLastSentDestinyOnlyStaleProjectedOwnerMissileLane:
                authoritySessionState &&
                authoritySessionState.lastSentOnlyStaleProjectedOwnerMissileLane === true
                  ? true
                  : (
                      session &&
                      session._space &&
                      session._space.lastSentDestinyOnlyStaleProjectedOwnerMissileLane === true
                    ),
              lastOwnerPilotCommandMovementStamp,
              lastOwnerPilotCommandMovementAnchorStamp,
              lastOwnerPilotCommandMovementRawDispatchStamp,
              lastOwnerNonMissileCriticalStamp:
                resolveOptionalDestinyStamp(
                  sessionState.lastOwnerNonMissileCriticalStamp,
                ),
              lastOwnerMissileLifecycleStamp:
                resolveOptionalDestinyStamp(
                  sessionState.lastOwnerMissileLifecycleStamp,
                ),
              lastOwnerMissileLifecycleAnchorStamp:
                resolveOptionalDestinyStamp(
                  sessionState.lastOwnerMissileLifecycleAnchorStamp,
                ),
              lastOwnerMissileLifecycleRawDispatchStamp:
                resolveOptionalDestinyStamp(
                  sessionState.lastOwnerMissileLifecycleRawDispatchStamp,
                ),
              lastOwnerMissileFreshAcquireStamp:
                resolveOptionalDestinyStamp(
                  sessionState.lastOwnerMissileFreshAcquireStamp,
                ),
              lastOwnerMissileFreshAcquireAnchorStamp:
                resolveOptionalDestinyStamp(
                  sessionState.lastOwnerMissileFreshAcquireAnchorStamp,
                ),
              lastOwnerMissileFreshAcquireRawDispatchStamp:
                resolveOptionalDestinyStamp(
                  sessionState.lastOwnerMissileFreshAcquireRawDispatchStamp,
                ),
              allowAdjacentRawFreshAcquireLaneReuse:
                sendOptions &&
                sendOptions.allowAdjacentRawFreshAcquireLaneReuse === true,
            })
          : {
              maximumTrustedRecentEmittedOwnerCriticalStamp: null,
              projectedRecentLastSentLane: null,
              presentedLastSentMonotonicFloor: null,
              genericMonotonicFloor: null,
              recentOwnerCriticalMonotonicFloor: null,
              ownerCriticalCeilingStamp: null,
            }
      );
    const {
      maximumTrustedRecentEmittedOwnerCriticalStamp,
      projectedRecentLastSentLane,
      presentedLastSentMonotonicFloor,
      genericMonotonicFloor,
      recentOwnerCriticalMonotonicFloor,
      ownerCriticalCeilingStamp,
      decisionSummary: ownerMonotonicDecisionSummary,
    } = ownerMonotonicState;
    const destructionTeardownLastSentMonotonicFloor =
      isDestructionTeardownGroup &&
      hasDestinyStamp(presentedLastSentMonotonicFloor)
        ? presentedLastSentMonotonicFloor
        : null;
    const sameRawPublishedLastSentSubwarpSafeFloor =
      capSubwarpSafeFloor(sameRawPublishedLastSentFloor);
    const presentedLastSentSubwarpSafeFloor =
      capSubwarpSafeFloor(presentedLastSentMonotonicFloor);
    const recentOwnerCriticalSubwarpSafeFloor =
      capSubwarpSafeFloor(recentOwnerCriticalMonotonicFloor);
    if (traceDetails) {
      traceDetails.genericMonotonicFloor = {
        ownerShipID,
        containsMovementContractPayload,
        isOwnerCriticalGroup,
        isOwnerDamageStateGroup,
        isOwnerPilotMovementGroup,
        isOwnerShipPrimeGroup,
        previousLastSentDestinyStamp,
        previousLastSentDestinyRawDispatchStamp,
        previousLastSentDestinyWasOwnerCritical,
        currentPresentedOwnerCriticalStamp,
        skipOwnerMonotonicRestamp,
        skipOwnerMonotonicRestampForNonCriticalPresentedLane,
        allowAdjacentRawFreshAcquireLaneReuse:
          sendOptions &&
          sendOptions.allowAdjacentRawFreshAcquireLaneReuse === true,
        maximumTrustedRecentEmittedOwnerCriticalStamp,
        projectedRecentLastSentLane,
        presentedLastSentMonotonicFloor,
        presentedLastSentSubwarpSafeFloor,
        genericMonotonicFloor,
        recentOwnerCriticalMonotonicFloor,
        recentOwnerCriticalSubwarpSafeFloor,
        ownerCriticalCeilingStamp,
      };
      traceDetails.ownerMonotonicDecisionTrace =
        ownerMonotonicDecisionSummary || null;
    }
    recordFloorStage(
      "owner.presentedLastSentMonotonicFloor",
      presentedLastSentMonotonicFloor,
    );
    recordFloorStage(
      "owner.genericMonotonicFloor",
      genericMonotonicFloor,
    );
    recordFloorStage(
      "owner.recentOwnerCriticalMonotonicFloor",
      recentOwnerCriticalMonotonicFloor,
    );
    recordFloorStage(
      "destructionTeardown.lastSentMonotonicFloor",
      destructionTeardownLastSentMonotonicFloor,
    );
    if (traceDetails) {
      traceDetails.observerDirectPresentedMonotonicFloor = {
        ownerShipID,
        containsObserverPresentedMonotonicPayload,
        currentPresentedObserverStamp,
        currentPresentedObserverSubwarpSafeStamp,
        previousLastSentDestinyOnlyStaleProjectedOwnerMissileLane,
        observerDirectPresentedMonotonicFloor,
      };
    }
    const observerMovementContractProjectedClearFloor =
      containsMovementContractPayload &&
      !isMissileLifecycleGroup &&
      !isOwnerCriticalGroup &&
      !isOwnerDamageStateGroup &&
      previousLastSentDestinyWasOwnerCritical === true &&
      hasDestinyStamp(currentPresentedObserverSubwarpSafeStamp) &&
      hasDestinyStamp(projectedRecentLastSentLane) &&
      isDestinyStampAfter(
        currentPresentedObserverSubwarpSafeStamp,
        projectedRecentLastSentLane,
        maximumPlanningLead,
      )
        ? advanceDestinyStamp(currentPresentedObserverSubwarpSafeStamp, 1)
        : null;
    if (traceDetails) {
      traceDetails.observerMovementContractProjectedClearFloor = {
        ownerShipID,
        containsMovementContractPayload,
        previousLastSentDestinyWasOwnerCritical,
        currentPresentedObserverStamp,
        currentPresentedObserverSubwarpSafeStamp,
        projectedRecentLastSentLane,
        observerMovementContractProjectedClearFloor,
      };
    }
    const observerMissileLifecyclePostHeldClearFloor =
      isMissileLifecycleGroup &&
      !isOwnerCriticalGroup &&
      !isOwnerDamageStateGroup &&
      isFreshAcquireLifecycleGroup !== true &&
      hasDestinyStamp(currentPresentedObserverSubwarpSafeStamp) &&
      getDestinyStampForwardDistance(
        currentSessionStamp,
        currentPresentedObserverSubwarpSafeStamp,
      ) >= MICHELLE_POST_HELD_FUTURE_DESTINY_LEAD &&
      hasDestinyStamp(recentOwnerCriticalSubwarpSafeFloor) &&
      (
        recentOwnerCriticalSubwarpSafeFloor ===
          currentPresentedObserverSubwarpSafeStamp ||
        isDestinyStampAfter(
          currentPresentedObserverSubwarpSafeStamp,
          recentOwnerCriticalSubwarpSafeFloor,
          maximumPlanningLead,
        )
      )
        ? advanceDestinyStamp(currentPresentedObserverSubwarpSafeStamp, 1)
        : null;
    if (traceDetails) {
      traceDetails.observerMissileLifecyclePostHeldClearFloor = {
        ownerShipID,
        isMissileLifecycleGroup,
        isFreshAcquireLifecycleGroup,
        currentSessionStamp,
        currentPresentedObserverStamp,
        currentPresentedObserverSubwarpSafeStamp,
        recentOwnerCriticalMonotonicFloor,
        recentOwnerCriticalSubwarpSafeFloor,
        observerMissileLifecyclePostHeldClearFloor,
      };
    }
    const lastFreshAcquirePublishedStamp = selectFurthestPresentDestinyStamp(
      currentSessionStamp,
      [
        resolveOptionalDestinyStamp(
          sessionState.lastFreshAcquireLifecycleStamp,
        ),
        resolveOptionalDestinyStamp(
          authoritySessionState &&
            authoritySessionState.lastFreshAcquireLifecycleStamp,
        ),
        resolveOptionalDestinyStamp(
          session && session._space &&
            session._space.lastFreshAcquireLifecycleStamp,
        ),
        resolveOptionalDestinyStamp(
          authoritySessionState && authoritySessionState.lastBootstrapStamp,
        ),
      ],
      maximumPlanningLead,
    );
    const movementAfterSameRawFreshAcquireCatchUpFloor =
      containsMovementContractPayload &&
      !isMissileLifecycleGroup &&
      !isOwnerCriticalGroup &&
      !isOwnerDamageStateGroup &&
      hasDestinyStamp(previousLastSentDestinyStamp) &&
      hasDestinyStamp(previousLastSentDestinyRawDispatchStamp) &&
      previousLastSentDestinyRawDispatchStamp === currentRawDispatchStamp &&
      previousLastSentDestinyStamp === lastFreshAcquirePublishedStamp
        ? previousLastSentDestinyStamp
        : null;
    recordFloorStage(
      "observer.directPresentedMonotonicFloor",
      observerDirectPresentedMonotonicFloor,
    );
    recordCeilingStage(
      "bootstrapAcquire.clearCeiling",
      bootstrapAcquireClearCeilingStamp,
    );
    recordFloorStage(
      "observer.movementContractProjectedClearFloor",
      observerMovementContractProjectedClearFloor,
    );
    recordFloorStage(
      "observer.missileLifecyclePostHeldClearFloor",
      observerMissileLifecyclePostHeldClearFloor,
    );
    recordCeilingStage(
      "owner.ownerCriticalCeilingStamp",
      ownerCriticalCeilingStamp,
      {
        ownerCriticalCeilingStamp,
        captureBeforeUpdates: true,
      },
    );
    if (
      hasDestinyStamp(ownerCriticalCeilingStamp) &&
      traceDetails &&
      traceDetails.restampSteps.length > 0
    ) {
      const latestRestampStep =
        traceDetails.restampSteps[traceDetails.restampSteps.length - 1];
      if (
        latestRestampStep &&
        latestRestampStep.reason === "owner.ownerCriticalCeilingStamp" &&
        latestRestampStep.applied === true &&
        typeof logMissileDebug === "function"
      ) {
        const unclampedStamp = latestRestampStep.beforeStamp >>> 0;
        const unclampedUpdates = Array.isArray(latestRestampStep.beforeUpdates)
          ? latestRestampStep.beforeUpdates
          : [];
        traceDetails.ownerCriticalCeilingClamp = {
          unclampedStamp,
          clampedStamp: localStamp >>> 0,
          ownerCriticalCeilingStamp,
        };
        logMissileDebug("destiny.owner-critical-ceiling-clamp", {
          destinyCallTraceID,
          rawDispatchStamp: currentRawDispatchStamp,
          rawSimTimeMs: roundNumber(rawSimTimeMs, 3),
          ownerCriticalCeilingStamp,
          unclampedStamp,
          clampedStamp: localStamp >>> 0,
          session: buildSessionSnapshotSafe(runtime, session, rawSimTimeMs),
          unclampedUpdates,
          clampedUpdates: summarizeMissileUpdatesForLog(localUpdates),
          traceDetails: normalizeTraceValue(traceDetails),
        });
      }
    }
    if (
      isMissileLifecycleGroup &&
      !isOwnerCriticalGroup &&
      !isOwnerDamageStateGroup &&
      !hasDestinyStamp(ownerCriticalCeilingStamp)
    ) {
      const missileLifecycleBaseCeilingStamp = selectFurthestDestinyStamp(
        currentSessionStamp,
        [
          advanceDestinyStamp(
            currentSessionStamp,
            MICHELLE_HELD_FUTURE_DESTINY_LEAD,
          ),
          currentPresentedOwnerCriticalStamp,
        ],
        maximumPlanningLead,
      );
      const missileLifecycleMonotonicFloor =
        selectFurthestPresentDestinyStamp(
          currentSessionStamp,
          [
            sameRawPublishedLastSentSubwarpSafeFloor,
            presentedLastSentSubwarpSafeFloor,
            recentOwnerCriticalSubwarpSafeFloor,
            observerDirectPresentedMonotonicFloor,
            observerMissileLifecyclePostHeldClearFloor,
          ],
          maximumPlanningLead,
        );
      const missileLifecycleCeilingStamp = selectFurthestDestinyStamp(
        currentSessionStamp,
        [missileLifecycleBaseCeilingStamp, missileLifecycleMonotonicFloor],
        maximumPlanningLead,
      );
      recordCeilingStage(
        "missile.nonOwnerLifecycleCeiling",
        missileLifecycleCeilingStamp,
      );
    }
    if (
      !isMissileLifecycleGroup &&
      !isOwnerCriticalGroup &&
      !isOwnerDamageStateGroup &&
      !hasDestinyStamp(ownerCriticalCeilingStamp)
    ) {
      const observerBroadcastMonotonicFloor =
        selectFurthestPresentDestinyStamp(
          currentSessionStamp,
          [
            sameRawPublishedLastSentSubwarpSafeFloor,
            presentedLastSentSubwarpSafeFloor,
            recentOwnerCriticalSubwarpSafeFloor,
            observerDirectPresentedMonotonicFloor,
            observerMovementContractProjectedClearFloor,
            observerMissileLifecyclePostHeldClearFloor,
          ],
          maximumPlanningLead,
        );
      const observerBroadcastCeilingStamp = selectFurthestDestinyStamp(
        currentSessionStamp,
        [
          sessionStampFloorCap,
          advanceDestinyStamp(
            currentSessionStamp,
            MICHELLE_HELD_FUTURE_DESTINY_LEAD,
          ),
          bootstrapAcquireClearCeilingStamp,
          observerBroadcastMonotonicFloor,
          destructionTeardownLastSentMonotonicFloor,
          allowsFollowingTeardownStamp ? originalStamp : null,
        ],
        maximumPlanningLead,
      );
      recordCeilingStage(
        "observer.heldFutureCeiling",
        observerBroadcastCeilingStamp,
        {
          allowsFollowingTeardownStamp,
          followingTeardownCapability,
          originalStamp,
          followingTeardownEntityID:
            followingTeardownCapability &&
            followingTeardownCapability.entityID,
        },
      );
    }
    recordCeilingStage(
      "authority.subwarpHeldFutureCeiling",
      subwarpHeldFutureCeilingStamp,
      {
        allowsPostHeldFutureDelivery,
        containsWarpPayload,
        minimumLeadFromCurrentHistory:
          toInt(sendOptions && sendOptions.minimumLeadFromCurrentHistory, 0),
        maximumLeadFromCurrentHistory:
          toInt(sendOptions && sendOptions.maximumLeadFromCurrentHistory, 0),
        maximumHistorySafeLeadOverride:
          toInt(sendOptions && sendOptions.maximumHistorySafeLeadOverride, 0),
      },
    );
    const ownerSkippedMonotonicLastSentCatchUpIsSafe =
      allowsPostHeldFutureDelivery ||
      subwarpHeldFutureCeilingStamp === null ||
      (
        hasDestinyStamp(previousLastSentDestinyStamp) &&
        isDestinyStampWithinForwardWindow(
          currentSessionStamp,
          previousLastSentDestinyStamp,
          getDestinyStampForwardDistance(
            currentSessionStamp,
            subwarpHeldFutureCeilingStamp,
          ),
        )
      );
    const ownerSkippedMonotonicLastSentCatchUpFloor =
      authorityJourney.contract === DESTINY_CONTRACTS.OWNER_PILOT_COMMAND &&
      isOwnerPilotMovementGroup &&
      skipOwnerMonotonicRestamp === true &&
      previousLastSentDestinyOnlyStaleProjectedOwnerMissileLane !== true &&
      hasDestinyStamp(previousLastSentDestinyStamp) &&
      isDestinyStampAfter(
        localStamp,
        previousLastSentDestinyStamp,
        maximumPlanningLead,
      ) &&
      ownerSkippedMonotonicLastSentCatchUpIsSafe
        ? previousLastSentDestinyStamp
        : null;
    recordFloorStage(
      "owner.skippedMonotonicLastSentCatchUpFloor",
      ownerSkippedMonotonicLastSentCatchUpFloor,
      {
        previousLastSentDestinyStamp,
        previousLastSentDestinyRawDispatchStamp,
        currentRawDispatchStamp,
        currentSessionStamp,
        subwarpHeldFutureCeilingStamp,
        allowsPostHeldFutureDelivery,
        skipOwnerMonotonicRestamp,
        previousLastSentDestinyOnlyStaleProjectedOwnerMissileLane,
        isSafe: ownerSkippedMonotonicLastSentCatchUpIsSafe,
      },
    );
    const bootstrapAcquireLastSentCatchUpFloor =
      isBootstrapAcquireGroup &&
      isFreshAcquireLifecycleGroup &&
      hasDestinyStamp(previousLastSentDestinyStamp) &&
      isDestinyStampAfter(
        localStamp,
        previousLastSentDestinyStamp,
        maximumPlanningLead,
      ) &&
      allowsPostHeldFutureDelivery
        ? previousLastSentDestinyStamp
        : null;
    recordFloorStage(
      "bootstrapAcquire.lastSentCatchUpFloor",
      bootstrapAcquireLastSentCatchUpFloor,
      {
        previousLastSentDestinyStamp,
        previousLastSentDestinyRawDispatchStamp,
        currentRawDispatchStamp,
        currentSessionStamp,
        bootstrapAcquireClearCeilingStamp,
        allowsPostHeldFutureDelivery,
      },
    );
    recordFloorStage(
      "movement.sameRawFreshAcquireCatchUpFloor",
      movementAfterSameRawFreshAcquireCatchUpFloor,
      {
        previousLastSentDestinyStamp,
        previousLastSentDestinyRawDispatchStamp,
        currentRawDispatchStamp,
        currentSessionStamp,
        lastFreshAcquirePublishedStamp,
        containsMovementContractPayload,
        isOwnerCriticalGroup,
      },
    );
    const ordinaryTeardownEntityOrderFloor =
      isDestructionTeardownGroup &&
      containsRemoveBallsPayload &&
      !isMissileLifecycleGroup &&
      !isOwnerMissileLifecycleGroup &&
      !isOwnerCriticalGroup &&
      !isOwnerDamageStateGroup &&
      allowsPostHeldFutureDelivery &&
      subwarpHeldFutureCeilingStamp === null
        ? minimumEntityPresentationStamp
        : null;
    recordFloorStage(
      "presentation.ordinaryTeardownEntityOrderFloor",
      ordinaryTeardownEntityOrderFloor,
      {
        currentRawDispatchStamp,
        currentSessionStamp,
        containsRemoveBallsPayload,
      },
    );
    if (
      traceDetails &&
      hasDestinyStamp(previousLastSentDestinyStamp) &&
      isDestinyStampAfter(
        localStamp,
        previousLastSentDestinyStamp,
        maximumPlanningLead,
      ) &&
      typeof logMissileDebug === "function"
    ) {
      logMissileDebug("destiny.backstep-risk", {
        destinyCallTraceID,
        rawDispatchStamp: currentRawDispatchStamp,
        rawSimTimeMs: roundNumber(rawSimTimeMs, 3),
        previousLastSentDestinyStamp,
        emittedStamp: normalizeDestinyStamp(localStamp, 0),
        session: buildSessionSnapshotSafe(runtime, session, rawSimTimeMs),
        updates: summarizeMissileUpdatesForLog(localUpdates),
        traceDetails: normalizeTraceValue(traceDetails),
      });
    }
    if (
      hasSameSceneShipHandoffCapability(sendOptions) &&
      !recordSameSceneShipHandoffTransactionProof({
        deliveryTransaction,
        finalStamp: localStamp,
        originalStamp,
        sendOptions,
        updates: updatesGroup,
      })
    ) {
      return null;
    }
    journeyLog.logEngine("destiny.authority.plan-group", {
      journeyId: authorityJourney.journeyId,
      contract: authorityJourney.contract,
      charID: session && session.characterID ? session.characterID : 0,
      shipID: ownerShipID,
      rawDispatchStamp: currentRawDispatchStamp,
      rawSimTimeMs: roundNumber(rawSimTimeMs, 3),
      originalStamp,
      finalStamp: normalizeDestinyStamp(localStamp, 0),
      currentSessionStamp,
      currentImmediateSessionStamp,
      currentPresentedOwnerCriticalStamp,
      currentPresentedObserverStamp,
      flags: {
        isFreshAcquireLifecycleGroup,
        isMissileLifecycleGroup,
        isOwnerMissileLifecycleGroup,
        isSetStateGroup,
        isOwnerPilotMovementGroup,
        isOwnerShipPrimeGroup,
        isOwnerDamageStateGroup,
        isOwnerCriticalGroup,
      },
      floors: {
        sameRawPublishedLastSentFloor,
        sameRawPublishedLastSentSubwarpSafeFloor,
        presentedLastSentMonotonicFloor,
        presentedLastSentSubwarpSafeFloor,
        genericMonotonicFloor,
        recentOwnerCriticalMonotonicFloor,
        recentOwnerCriticalSubwarpSafeFloor,
        observerDirectPresentedMonotonicFloor,
        observerMovementContractProjectedClearFloor,
        observerMissileLifecyclePostHeldClearFloor,
        ownerSkippedMonotonicLastSentCatchUpFloor,
        bootstrapAcquireLastSentCatchUpFloor,
        movementAfterSameRawFreshAcquireCatchUpFloor,
      },
      ceilings: {
        ownerCriticalCeilingStamp,
        subwarpHeldFutureCeilingStamp,
      },
      restampSteps: traceDetails ? traceDetails.restampSteps : [],
      updates: summarizeMissileUpdatesForLog(localUpdates),
    });
    return {
      authorityJourney,
      updates: localUpdates,
      finalStamp: normalizeDestinyStamp(localStamp, 0),
      originalStamp,
      traceDetails,
      currentSessionStamp: normalizeDestinyStamp(currentSessionStamp, 0),
      flags: {
        isFreshAcquireLifecycleGroup,
        isMissileLifecycleGroup,
        isOwnerMissileLifecycleGroup,
        isSetStateGroup,
        isOwnerPilotMovementGroup,
        isOwnerShipPrimeGroup,
        isOwnerDamageStateGroup,
        isOwnerCriticalGroup,
        previousLastSentDestinyStamp: resolveOptionalDestinyStamp(
          previousLastSentDestinyStamp,
        ),
      },
    };
  }

  function applyLegacySessionEmissionState(context = {}, details = {}) {
    const {
      journeyId,
      contract,
      currentRawDispatchStamp,
    } = context;
    const {
      session,
      finalStamp,
      currentSessionStamp,
      flags = {},
      legacyStateBefore = {},
    } = details;
    if (!session || !session._space) {
      return {
        ...legacyStateBefore,
      };
    }
    const localStamp = normalizeDestinyStamp(finalStamp, 0);
    const currentSessionAnchorStamp = normalizeDestinyStamp(
      currentSessionStamp,
      0,
    );
    const nextLegacyState = {
      lastFreshAcquireLifecycleStamp:
        resolveOptionalDestinyStamp(legacyStateBefore.lastFreshAcquireLifecycleStamp),
      lastMissileLifecycleStamp:
        resolveOptionalDestinyStamp(legacyStateBefore.lastMissileLifecycleStamp),
      lastMissileLifecycleRawDispatchStamp:
        resolveOptionalDestinyStamp(
          legacyStateBefore.lastMissileLifecycleRawDispatchStamp,
        ),
      lastOwnerMissileLifecycleStamp:
        resolveOptionalDestinyStamp(legacyStateBefore.lastOwnerMissileLifecycleStamp),
      lastOwnerMissileLifecycleAnchorStamp:
        resolveOptionalDestinyStamp(
          legacyStateBefore.lastOwnerMissileLifecycleAnchorStamp,
        ),
      lastOwnerMissileFreshAcquireStamp:
        resolveOptionalDestinyStamp(legacyStateBefore.lastOwnerMissileFreshAcquireStamp),
      lastOwnerMissileFreshAcquireAnchorStamp:
        resolveOptionalDestinyStamp(
          legacyStateBefore.lastOwnerMissileFreshAcquireAnchorStamp,
        ),
      lastOwnerMissileFreshAcquireRawDispatchStamp:
        resolveOptionalDestinyStamp(
          legacyStateBefore.lastOwnerMissileFreshAcquireRawDispatchStamp,
        ),
      lastOwnerMissileLifecycleRawDispatchStamp:
        resolveOptionalDestinyStamp(
          legacyStateBefore.lastOwnerMissileLifecycleRawDispatchStamp,
        ),
      lastOwnerNonMissileCriticalStamp:
        resolveOptionalDestinyStamp(legacyStateBefore.lastOwnerNonMissileCriticalStamp),
      lastOwnerNonMissileCriticalRawDispatchStamp:
        resolveOptionalDestinyStamp(
          legacyStateBefore.lastOwnerNonMissileCriticalRawDispatchStamp,
        ),
    };
    const previousSessionLastSentDestinyStamp = hasDestinyStamp(
      session._space.lastSentDestinyStamp,
    )
      ? normalizeDestinyStamp(session._space.lastSentDestinyStamp)
      : null;
    const localStampEstablishedLastSentLane =
      previousSessionLastSentDestinyStamp === null ||
      isDestinyStampAfter(previousSessionLastSentDestinyStamp, localStamp);
    const localStampMatchedLastSentLane =
      localStamp === previousSessionLastSentDestinyStamp;
    session._space.lastSentDestinyStamp = selectLaterDestinyStamp(
      previousSessionLastSentDestinyStamp,
      localStamp,
    );
    if (localStampEstablishedLastSentLane) {
      session._space.lastSentDestinyRawDispatchStamp =
        currentRawDispatchStamp;
      session._space.lastSentDestinyOnlyStaleProjectedOwnerMissileLane =
        false;
      session._space.lastSentDestinyWasOwnerCritical =
        flags.isOwnerCriticalGroup === true;
    } else if (localStampMatchedLastSentLane) {
      session._space.lastSentDestinyRawDispatchStamp = selectLaterDestinyStamp(
        hasDestinyStamp(session._space.lastSentDestinyRawDispatchStamp)
          ? session._space.lastSentDestinyRawDispatchStamp
          : null,
        currentRawDispatchStamp,
      );
      session._space.lastSentDestinyOnlyStaleProjectedOwnerMissileLane =
        false;
      session._space.lastSentDestinyWasOwnerCritical =
        flags.isOwnerCriticalGroup === true;
    }
    if (flags.isSetStateGroup === true) {
      const previousOwnerNonMissileCriticalSessionStamp = hasDestinyStamp(
        session._space.lastOwnerNonMissileCriticalStamp,
      )
        ? session._space.lastOwnerNonMissileCriticalStamp
        : null;
      if (
        previousOwnerNonMissileCriticalSessionStamp === null ||
        localStamp === previousOwnerNonMissileCriticalSessionStamp ||
        isDestinyStampAfter(
          previousOwnerNonMissileCriticalSessionStamp,
          localStamp,
        )
      ) {
        session._space.lastOwnerNonMissileCriticalStamp = localStamp;
        nextLegacyState.lastOwnerNonMissileCriticalStamp = localStamp;
        session._space.lastOwnerNonMissileCriticalRawDispatchStamp =
          currentRawDispatchStamp;
        nextLegacyState.lastOwnerNonMissileCriticalRawDispatchStamp =
          currentRawDispatchStamp;
      }
    }
    const previousFreshAcquireLifecycleStamp =
      Object.prototype.hasOwnProperty.call(
        session._space,
        "lastFreshAcquireLifecycleStamp",
      )
        ? session._space.lastFreshAcquireLifecycleStamp
        : legacyStateBefore.lastFreshAcquireLifecycleStamp;
    if (
      flags.isFreshAcquireLifecycleGroup === true &&
      (
        !hasDestinyStamp(previousFreshAcquireLifecycleStamp) ||
        localStamp === normalizeDestinyStamp(previousFreshAcquireLifecycleStamp) ||
        isDestinyStampAfter(previousFreshAcquireLifecycleStamp, localStamp)
      )
    ) {
      session._space.lastFreshAcquireLifecycleStamp = localStamp;
      nextLegacyState.lastFreshAcquireLifecycleStamp = localStamp;
    }
    const previousMissileLifecycleStamp =
      Object.prototype.hasOwnProperty.call(
        session._space,
        "lastMissileLifecycleStamp",
      )
        ? session._space.lastMissileLifecycleStamp
        : legacyStateBefore.lastMissileLifecycleStamp;
    if (
      flags.isMissileLifecycleGroup === true &&
      (
        !hasDestinyStamp(previousMissileLifecycleStamp) ||
        localStamp === normalizeDestinyStamp(previousMissileLifecycleStamp) ||
        isDestinyStampAfter(previousMissileLifecycleStamp, localStamp)
      )
    ) {
      session._space.lastMissileLifecycleStamp = localStamp;
      nextLegacyState.lastMissileLifecycleStamp = localStamp;
      const previousMissileLifecycleRawDispatchStamp =
        resolveOptionalDestinyStamp(
          session._space.lastMissileLifecycleRawDispatchStamp,
          legacyStateBefore.lastMissileLifecycleRawDispatchStamp,
        );
      const nextMissileLifecycleRawDispatchStamp =
        hasDestinyStamp(previousMissileLifecycleStamp) &&
        localStamp === normalizeDestinyStamp(previousMissileLifecycleStamp)
          ? selectLaterDestinyStamp(
              previousMissileLifecycleRawDispatchStamp,
              currentRawDispatchStamp,
            )
          : currentRawDispatchStamp;
      session._space.lastMissileLifecycleRawDispatchStamp =
        nextMissileLifecycleRawDispatchStamp;
      nextLegacyState.lastMissileLifecycleRawDispatchStamp =
        nextMissileLifecycleRawDispatchStamp;
    }
    if (flags.isOwnerMissileLifecycleGroup === true) {
      const previousOwnerMissileLifecycleStamp =
        Object.prototype.hasOwnProperty.call(
          session._space,
          "lastOwnerMissileLifecycleStamp",
        )
          ? session._space.lastOwnerMissileLifecycleStamp
          : legacyStateBefore.lastOwnerMissileLifecycleStamp;
      if (
        !hasDestinyStamp(previousOwnerMissileLifecycleStamp) ||
        localStamp === normalizeDestinyStamp(previousOwnerMissileLifecycleStamp) ||
        isDestinyStampAfter(previousOwnerMissileLifecycleStamp, localStamp)
      ) {
        session._space.lastOwnerMissileLifecycleStamp = localStamp;
        nextLegacyState.lastOwnerMissileLifecycleStamp = localStamp;
        session._space.lastOwnerMissileLifecycleAnchorStamp =
          currentSessionAnchorStamp;
        nextLegacyState.lastOwnerMissileLifecycleAnchorStamp =
          currentSessionAnchorStamp;
        session._space.lastOwnerMissileLifecycleRawDispatchStamp =
          currentRawDispatchStamp;
        nextLegacyState.lastOwnerMissileLifecycleRawDispatchStamp =
          currentRawDispatchStamp;
      }
      const previousOwnerMissileFreshAcquireStamp =
        Object.prototype.hasOwnProperty.call(
          session._space,
          "lastOwnerMissileFreshAcquireStamp",
        )
          ? session._space.lastOwnerMissileFreshAcquireStamp
          : legacyStateBefore.lastOwnerMissileFreshAcquireStamp;
      if (
        flags.isFreshAcquireLifecycleGroup === true &&
        (
          !hasDestinyStamp(previousOwnerMissileFreshAcquireStamp) ||
          localStamp === normalizeDestinyStamp(previousOwnerMissileFreshAcquireStamp) ||
          isDestinyStampAfter(previousOwnerMissileFreshAcquireStamp, localStamp)
        )
      ) {
        session._space.lastOwnerMissileFreshAcquireStamp = localStamp;
        nextLegacyState.lastOwnerMissileFreshAcquireStamp = localStamp;
        session._space.lastOwnerMissileFreshAcquireAnchorStamp =
          currentSessionAnchorStamp;
        nextLegacyState.lastOwnerMissileFreshAcquireAnchorStamp =
          currentSessionAnchorStamp;
        session._space.lastOwnerMissileFreshAcquireRawDispatchStamp =
          currentRawDispatchStamp;
        nextLegacyState.lastOwnerMissileFreshAcquireRawDispatchStamp =
          currentRawDispatchStamp;
      }
    }
    journeyLog.logEngine("destiny.authority.apply-legacy-session-state", {
      journeyId,
      contract,
      charID: session && session.characterID ? session.characterID : 0,
      shipID: session && session._space ? toInt(session._space.shipID, 0) : 0,
      rawDispatchStamp: currentRawDispatchStamp,
      currentSessionStamp: currentSessionAnchorStamp,
      finalStamp: localStamp,
      flags,
      legacyStateBefore,
      legacyStateAfter: nextLegacyState,
      lastSentDestinyStamp: resolveOptionalDestinyStamp(
        session._space.lastSentDestinyStamp,
      ),
      lastSentDestinyRawDispatchStamp:
        resolveOptionalDestinyStamp(session._space.lastSentDestinyRawDispatchStamp),
    });
    updateDestinyAuthorityState(session, {
      lastPresentedStamp: resolveOptionalDestinyStamp(
        session._space.lastSentDestinyStamp,
      ),
      lastRawDispatchStamp:
        resolveOptionalDestinyStamp(session._space.lastSentDestinyRawDispatchStamp),
      lastSentWasOwnerCritical:
        session._space.lastSentDestinyWasOwnerCritical === true,
      lastSentOnlyStaleProjectedOwnerMissileLane:
        session._space.lastSentDestinyOnlyStaleProjectedOwnerMissileLane === true,
      lastFreshAcquireLifecycleStamp:
        nextLegacyState.lastFreshAcquireLifecycleStamp,
      lastMissileLifecycleStamp:
        nextLegacyState.lastMissileLifecycleStamp,
      lastMissileLifecycleRawDispatchStamp:
        nextLegacyState.lastMissileLifecycleRawDispatchStamp,
      lastOwnerMissileLifecycleStamp:
        nextLegacyState.lastOwnerMissileLifecycleStamp,
      lastOwnerMissileLifecycleAnchorStamp:
        nextLegacyState.lastOwnerMissileLifecycleAnchorStamp,
      lastOwnerMissileLifecycleRawDispatchStamp:
        nextLegacyState.lastOwnerMissileLifecycleRawDispatchStamp,
      lastOwnerMissileFreshAcquireStamp:
        nextLegacyState.lastOwnerMissileFreshAcquireStamp,
      lastOwnerMissileFreshAcquireAnchorStamp:
        nextLegacyState.lastOwnerMissileFreshAcquireAnchorStamp,
      lastOwnerMissileFreshAcquireRawDispatchStamp:
        nextLegacyState.lastOwnerMissileFreshAcquireRawDispatchStamp,
      lastOwnerNonMissileCriticalStamp:
        nextLegacyState.lastOwnerNonMissileCriticalStamp,
      lastOwnerNonMissileCriticalRawDispatchStamp:
        nextLegacyState.lastOwnerNonMissileCriticalRawDispatchStamp,
    });
    return nextLegacyState;
  }

  function completeGroupJourney(context = {}, details = {}) {
    const {
      journeyId,
      contract,
      authoritySessionBefore,
      rawSimTimeMs,
      currentRawDispatchStamp,
      originalUpdates,
    } = context;
    const completedFinalStamp = normalizeDestinyStamp(details.finalStamp, 0);
    const preserveLaterAuthorityStamp = (previousStamp, candidateStamp) =>
      selectLaterDestinyStamp(
        hasDestinyStamp(previousStamp) ? previousStamp : null,
        candidateStamp,
      );
    const resolveAtomicAuthorityLane = ({
      applies,
      stampKey,
      anchorKey = null,
      rawDispatchKey = null,
      candidateStamp = completedFinalStamp,
      candidateAnchorStamp = details.currentSessionStamp,
      candidateRawDispatchStamp = currentRawDispatchStamp,
    }) => {
      const previousStamp = resolveOptionalDestinyStamp(
        authoritySessionBefore && authoritySessionBefore[stampKey],
      );
      const previousAnchorStamp = anchorKey
        ? resolveOptionalDestinyStamp(
            authoritySessionBefore && authoritySessionBefore[anchorKey],
          )
        : null;
      const previousRawDispatchStamp = rawDispatchKey
        ? resolveOptionalDestinyStamp(
            authoritySessionBefore && authoritySessionBefore[rawDispatchKey],
          )
        : null;
      const normalizedCandidateStamp = resolveOptionalDestinyStamp(candidateStamp);
      const normalizedCandidateAnchorStamp = anchorKey
        ? resolveOptionalDestinyStamp(candidateAnchorStamp)
        : null;
      const normalizedCandidateRawDispatchStamp = rawDispatchKey
        ? resolveOptionalDestinyStamp(candidateRawDispatchStamp)
        : null;
      const candidateTupleIsComplete =
        normalizedCandidateStamp !== null &&
        (!anchorKey || normalizedCandidateAnchorStamp !== null) &&
        (!rawDispatchKey || normalizedCandidateRawDispatchStamp !== null);
      const matchingCandidateRawDoesNotRegress =
        !rawDispatchKey ||
        previousRawDispatchStamp === null ||
        normalizedCandidateRawDispatchStamp === previousRawDispatchStamp ||
        isDestinyStampAfter(
          previousRawDispatchStamp,
          normalizedCandidateRawDispatchStamp,
        );
      const candidateEstablishesOrMatchesLane =
        applies === true &&
        candidateTupleIsComplete &&
        (
          previousStamp === null ||
          isDestinyStampAfter(previousStamp, normalizedCandidateStamp) ||
          (
            normalizedCandidateStamp === previousStamp &&
            matchingCandidateRawDoesNotRegress
          )
        );
      return {
        candidateEstablishesOrMatchesLane,
        stamp: candidateEstablishesOrMatchesLane
          ? normalizedCandidateStamp
          : previousStamp,
        anchorStamp: anchorKey
          ? (
              candidateEstablishesOrMatchesLane
                ? normalizedCandidateAnchorStamp
                : previousAnchorStamp
            )
          : null,
        rawDispatchStamp: rawDispatchKey
          ? (
              candidateEstablishesOrMatchesLane
                ? normalizedCandidateRawDispatchStamp
                : previousRawDispatchStamp
            )
          : null,
      };
    };
    const presentedLane = resolveAtomicAuthorityLane({
      applies: true,
      stampKey: "lastPresentedStamp",
      rawDispatchKey: "lastRawDispatchStamp",
    });
    const missileLifecycleLane = resolveAtomicAuthorityLane({
      applies:
        contract === DESTINY_CONTRACTS.OWNER_MISSILE_LIFECYCLE ||
        contract === DESTINY_CONTRACTS.OBSERVER_MISSILE_LIFECYCLE ||
        Boolean(
          details.isMissileLifecycleGroup === true ||
          (details.flags && details.flags.isMissileLifecycleGroup === true),
        ),
      stampKey: "lastMissileLifecycleStamp",
      rawDispatchKey: "lastMissileLifecycleRawDispatchStamp",
    });
    const ownerCommandLane = resolveAtomicAuthorityLane({
      applies: contract === DESTINY_CONTRACTS.OWNER_PILOT_COMMAND,
      stampKey: "lastOwnerCommandStamp",
      anchorKey: "lastOwnerCommandAnchorStamp",
      rawDispatchKey: "lastOwnerCommandRawDispatchStamp",
    });
    const ownerMissileLifecycleLane = resolveAtomicAuthorityLane({
      applies:
        contract === DESTINY_CONTRACTS.OWNER_MISSILE_LIFECYCLE ||
        Boolean(details.flags && details.flags.isOwnerMissileLifecycleGroup === true),
      stampKey: "lastOwnerMissileLifecycleStamp",
      anchorKey: "lastOwnerMissileLifecycleAnchorStamp",
      rawDispatchKey: "lastOwnerMissileLifecycleRawDispatchStamp",
    });
    const ownerMissileFreshAcquireLane = resolveAtomicAuthorityLane({
      applies:
        contract === DESTINY_CONTRACTS.OWNER_MISSILE_LIFECYCLE &&
        details.isFreshAcquireLifecycleGroup === true,
      stampKey: "lastOwnerMissileFreshAcquireStamp",
      anchorKey: "lastOwnerMissileFreshAcquireAnchorStamp",
      rawDispatchKey: "lastOwnerMissileFreshAcquireRawDispatchStamp",
    });
    const ownerNonMissileCriticalLane = resolveAtomicAuthorityLane({
      applies: Boolean(details.flags && details.flags.isSetStateGroup === true),
      stampKey: "lastOwnerNonMissileCriticalStamp",
      rawDispatchKey: "lastOwnerNonMissileCriticalRawDispatchStamp",
    });
    const completedStampEstablishedPresentedLane =
      presentedLane.candidateEstablishesOrMatchesLane;
    const authoritySessionAfter = updateDestinyAuthorityState(
      details.session,
      {
        lastJourneyId: journeyId,
        lastRawDispatchStamp: presentedLane.rawDispatchStamp,
        lastPresentedStamp: presentedLane.stamp,
        lastCriticalStamp:
          details.isCritical === true
            ? preserveLaterAuthorityStamp(
                authoritySessionBefore && authoritySessionBefore.lastCriticalStamp,
                completedFinalStamp,
              )
            : resolveOptionalDestinyStamp(
                authoritySessionBefore && authoritySessionBefore.lastCriticalStamp,
              ),
        lastNonCriticalStamp:
          details.isCritical === true
            ? resolveOptionalDestinyStamp(
                authoritySessionBefore && authoritySessionBefore.lastNonCriticalStamp,
              )
            : preserveLaterAuthorityStamp(
                authoritySessionBefore && authoritySessionBefore.lastNonCriticalStamp,
                completedFinalStamp,
              ),
        lastOwnerCommandStamp: ownerCommandLane.stamp,
        lastOwnerCommandAnchorStamp: ownerCommandLane.anchorStamp,
        lastOwnerCommandRawDispatchStamp: ownerCommandLane.rawDispatchStamp,
        lastBootstrapStamp:
          contract === DESTINY_CONTRACTS.BOOTSTRAP_ACQUIRE ||
          details.isFreshAcquireLifecycleGroup === true
            ? preserveLaterAuthorityStamp(
                authoritySessionBefore && authoritySessionBefore.lastBootstrapStamp,
                completedFinalStamp,
              )
            : resolveOptionalDestinyStamp(
                authoritySessionBefore && authoritySessionBefore.lastBootstrapStamp,
              ),
        lastFreshAcquireLifecycleStamp:
          details.isFreshAcquireLifecycleGroup === true
            ? preserveLaterAuthorityStamp(
                authoritySessionBefore &&
                  authoritySessionBefore.lastFreshAcquireLifecycleStamp,
                completedFinalStamp,
              )
            : resolveOptionalDestinyStamp(
                authoritySessionBefore &&
                  authoritySessionBefore.lastFreshAcquireLifecycleStamp,
              ),
        lastMissileLifecycleStamp: missileLifecycleLane.stamp,
        lastMissileLifecycleRawDispatchStamp:
          missileLifecycleLane.rawDispatchStamp,
        lastOwnerMissileLifecycleStamp: ownerMissileLifecycleLane.stamp,
        lastOwnerMissileLifecycleAnchorStamp:
          ownerMissileLifecycleLane.anchorStamp,
        lastOwnerMissileLifecycleRawDispatchStamp:
          ownerMissileLifecycleLane.rawDispatchStamp,
        lastOwnerMissileFreshAcquireStamp:
          ownerMissileFreshAcquireLane.stamp,
        lastOwnerMissileFreshAcquireAnchorStamp:
          ownerMissileFreshAcquireLane.anchorStamp,
        lastOwnerMissileFreshAcquireRawDispatchStamp:
          ownerMissileFreshAcquireLane.rawDispatchStamp,
        lastOwnerNonMissileCriticalStamp:
          ownerNonMissileCriticalLane.stamp,
        lastOwnerNonMissileCriticalRawDispatchStamp:
          ownerNonMissileCriticalLane.rawDispatchStamp,
        lastSentWasOwnerCritical:
          details.flags &&
          details.flags.isOwnerCriticalGroup === true &&
          completedStampEstablishedPresentedLane
            ? true
            : (
                authoritySessionBefore &&
                authoritySessionBefore.lastSentWasOwnerCritical === true &&
                !completedStampEstablishedPresentedLane
              ),
        lastSentOnlyStaleProjectedOwnerMissileLane:
          completedStampEstablishedPresentedLane
            ? false
            : Boolean(
                authoritySessionBefore &&
                authoritySessionBefore.lastSentOnlyStaleProjectedOwnerMissileLane === true
              ),
        lastResetStamp:
          contract === DESTINY_CONTRACTS.STATE_RESET
            ? preserveLaterAuthorityStamp(
                authoritySessionBefore && authoritySessionBefore.lastResetStamp,
                completedFinalStamp,
              )
            : resolveOptionalDestinyStamp(
                authoritySessionBefore && authoritySessionBefore.lastResetStamp,
              ),
      },
    );

    journeyLog.logJourney("destiny.authority.emit-group", {
      journeyId,
      contract,
      charID: details.session && details.session.characterID
        ? details.session.characterID
        : 0,
      shipID: details.session && details.session._space
        ? toInt(details.session._space.shipID, 0)
        : 0,
      rawDispatchStamp: currentRawDispatchStamp,
      rawSimTimeMs,
      originalStamp: toInt(details.originalStamp, 0) >>> 0,
      finalStamp: toInt(details.finalStamp, 0) >>> 0,
      isCritical: details.isCritical === true,
      restampSteps: Array.isArray(details.restampSteps)
        ? details.restampSteps
        : [],
      originalUpdates,
      emittedUpdates: summarizeMissileUpdatesForLog(details.updates),
      authoritySessionBefore,
      authoritySessionAfter,
      flags: details.flags || null,
    });

    const appliedRestampSteps = Array.isArray(details.restampSteps)
      ? details.restampSteps.filter((step) => step && step.applied === true)
      : [];
    if (appliedRestampSteps.length > 0) {
      journeyLog.logRestamp("destiny.authority.repaired-group", {
        journeyId,
        contract,
        charID: details.session && details.session.characterID
          ? details.session.characterID
          : 0,
        shipID: details.session && details.session._space
          ? toInt(details.session._space.shipID, 0)
          : 0,
        originalStamp: toInt(details.originalStamp, 0) >>> 0,
        finalStamp: toInt(details.finalStamp, 0) >>> 0,
        appliedRestampSteps,
      });
      const repairSummary = appliedRestampSteps
        .map((step) => `${step.reason}:${step.beforeStamp}->${step.afterStamp}`)
        .join(", ");
      log.info(
        `[DestinyAuthority] Repaired ${contract} for char ${details.session && details.session.characterID ? details.session.characterID : 0}: ${repairSummary}`,
      );
    }

    return authoritySessionAfter;
  }

  function rejectGroupJourney(context = {}, details = {}) {
    const {
      journeyId,
      contract,
      authoritySessionBefore,
      rawSimTimeMs,
      currentRawDispatchStamp,
      originalUpdates,
    } = context;
    const normalizedRestampSteps = Array.isArray(details.restampSteps)
      ? details.restampSteps
      : [];
    const decisionTree = buildDecisionTree(normalizedRestampSteps);
    const authoritySessionCurrent = snapshotDestinyAuthorityState(details.session);
    const rejection = {
      policy:
        typeof details.dropPolicy === "string" && details.dropPolicy
          ? details.dropPolicy
          : "backstep-behind-last-sent",
      reason: details.reason || "unsafe delivery",
      originalStamp: toInt(details.originalStamp, 0) >>> 0,
      attemptedStamp: toInt(details.attemptedStamp, 0) >>> 0,
      rawDispatchStamp: currentRawDispatchStamp,
      rawSimTimeMs,
    };
    journeyLog.logJourney("destiny.authority.reject-group", {
      journeyId,
      contract,
      charID: details.session && details.session.characterID
        ? details.session.characterID
        : 0,
      shipID: details.session && details.session._space
        ? toInt(details.session._space.shipID, 0)
        : 0,
      rawDispatchStamp: currentRawDispatchStamp,
      rawSimTimeMs,
      rejection,
      originalUpdates,
      authoritySessionBefore,
      authoritySessionCurrent,
      restampSteps: normalizedRestampSteps,
      decisionTree,
    });
    journeyLog.logRestamp("destiny.authority.reject-group", {
      journeyId,
      contract,
      charID: details.session && details.session.characterID
        ? details.session.characterID
        : 0,
      shipID: details.session && details.session._space
        ? toInt(details.session._space.shipID, 0)
        : 0,
      rejection,
      restampSteps: normalizedRestampSteps,
      decisionTree,
    });
    journeyLog.logDrop("destiny.authority.reject-group", {
      journeyId,
      contract,
      charID: details.session && details.session.characterID
        ? details.session.characterID
        : 0,
      shipID: details.session && details.session._space
        ? toInt(details.session._space.shipID, 0)
        : 0,
      rejection,
      authoritySessionBefore,
      authoritySessionCurrent,
      restampSteps: normalizedRestampSteps,
      decisionTree,
      originalUpdates,
      journeyTree: {
        contract,
        source: "destiny.authority.reject-group",
        authored: {
          originalStamp: rejection.originalStamp,
          updates: originalUpdates,
        },
        dispatch: {
          rawDispatchStamp: rejection.rawDispatchStamp,
          rawSimTimeMs: rejection.rawSimTimeMs,
        },
        evaluation: {
          attemptedStamp: rejection.attemptedStamp,
          decisionTree,
        },
        rejection,
      },
    });
    journeyLog.logEngine("destiny.authority.reject-group", {
      journeyId,
      contract,
      charID: details.session && details.session.characterID
        ? details.session.characterID
        : 0,
      shipID: details.session && details.session._space
        ? toInt(details.session._space.shipID, 0)
        : 0,
      rejection,
      decisionTree,
    });
    log.criticalAlert("DESTINY DROP", [
      { label: "Journey", value: journeyId },
      { label: "Contract", value: contract },
      {
        label: "Character",
        value: details.session && details.session.characterID
          ? details.session.characterID
          : 0,
      },
      {
        label: "Ship",
        value: details.session && details.session._space
          ? toInt(details.session._space.shipID, 0)
          : 0,
      },
      { label: "Raw", value: currentRawDispatchStamp },
      { label: "From", value: toInt(details.originalStamp, 0) >>> 0 },
      { label: "To", value: toInt(details.attemptedStamp, 0) >>> 0 },
      { label: "Reason", value: details.reason || "unsafe delivery" },
      { label: "Policy", value: rejection.policy || "unknown" },
      {
        label: "Drop Log",
        value: journeyLog.DESTINY_DROP_LOG_PATH,
      },
    ], {
      subtitle: "Unsafe Destiny send rejected before it could jolt Michelle",
    });
    log.warn(
      `[DestinyAuthority] Rejected ${contract} for char ${details.session && details.session.characterID ? details.session.characterID : 0}: ${details.reason || "unsafe delivery"}`,
    );
  }

  return {
    DESTINY_CONTRACTS,
    classifyEnvelope,
    getDestinyHistoryAnchorStampForSession,
    resolveDestinyDeliveryStampForSession,
    prepareDestinyUpdateForSession,
    beginGroupJourney,
    planGroupEmission,
    applyLegacySessionEmissionState,
    completeGroupJourney,
    rejectGroupJourney,
  };
}

module.exports = {
  createDestinyAuthority,
};
