const {
  isSteeringPayloadName,
} = require("../protocol/payloads.js");
const {
  resolveGotoDirectionFromUpdates,
  serializeDestinyDirectionHeading,
} = require("../protocol/direction");
const {
  resolveOwnerMovementRestampState,
} = require("../delivery/deliveryPolicy.js");
const {
  rebuildOwnerKinematicUpdatesForProjectedStamp,
} = require("../projection/entityProjection.js");
const {
  DESTINY_CONTRACTS,
} = require("../authority/destinyContracts.js");
const {
  resolveDestinyAuthorityCommandTuple,
  resolveDestinyAuthorityLaneTuple,
  snapshotDestinyAuthorityState,
  updateDestinyAuthorityState,
} = require("../authority/destinySessionState.js");
const {
  advanceDestinyStamp,
  getDestinyStampForwardDistance,
  hasDestinyStamp,
  isDestinyStampAfter,
  normalizeDestinyStamp,
  resolveOptionalDestinyStamp,
  selectLaterDestinyStamp,
} = require("../delivery/stamps");

function getGuardedDestinyStampForwardDistance(fromStamp, toStamp) {
  return hasDestinyStamp(fromStamp) && hasDestinyStamp(toStamp)
    ? getDestinyStampForwardDistance(fromStamp, toStamp)
    : null;
}

function shouldRefreshOwnerCommandAnchor(options = {}) {
  const previousStamp = resolveOptionalDestinyStamp(options.previousStamp);
  const previousAnchorStamp = resolveOptionalDestinyStamp(
    options.previousAnchorStamp,
  );
  const emittedStamp = resolveOptionalDestinyStamp(options.emittedStamp);
  const liveSessionStamp = resolveOptionalDestinyStamp(options.liveSessionStamp);

  return (
    !hasDestinyStamp(previousStamp) ||
    !hasDestinyStamp(previousAnchorStamp) ||
    isDestinyStampAfter(previousStamp, emittedStamp) ||
    (
      emittedStamp === previousStamp &&
      isDestinyStampAfter(liveSessionStamp, previousStamp)
    )
  );
}

function resolveAtomicOwnerMovementLaneWrite(options = {}) {
  const tracksAnchor = options.tracksAnchor === true;
  const previousStamp = resolveOptionalDestinyStamp(options.previousStamp);
  const previousRawDispatchStamp = resolveOptionalDestinyStamp(
    options.previousRawDispatchStamp,
  );
  const previousAnchorStamp = resolveOptionalDestinyStamp(
    options.previousAnchorStamp,
  );
  const emittedStamp = resolveOptionalDestinyStamp(options.emittedStamp);
  const currentRawDispatchStamp = resolveOptionalDestinyStamp(
    options.currentRawDispatchStamp,
  );
  const nextAnchorStamp = tracksAnchor
    ? resolveOptionalDestinyStamp(options.nextAnchorStamp)
    : null;
  const candidateTupleIsComplete =
    hasDestinyStamp(emittedStamp) &&
    hasDestinyStamp(currentRawDispatchStamp) &&
    (!tracksAnchor || hasDestinyStamp(nextAnchorStamp));
  const matchingCandidateRawDoesNotRegress =
    !hasDestinyStamp(previousRawDispatchStamp) ||
    currentRawDispatchStamp === previousRawDispatchStamp ||
    isDestinyStampAfter(
      previousRawDispatchStamp,
      currentRawDispatchStamp,
    );
  const candidateEstablishesLane =
    candidateTupleIsComplete &&
    (
      !hasDestinyStamp(previousStamp) ||
      isDestinyStampAfter(previousStamp, emittedStamp) ||
      (
        emittedStamp === previousStamp &&
        matchingCandidateRawDoesNotRegress
      )
    );

  if (!candidateEstablishesLane) {
    return {
      accepted: false,
      stamp: previousStamp,
      rawDispatchStamp: previousRawDispatchStamp,
      anchorStamp: previousAnchorStamp,
    };
  }

  return {
    accepted: true,
    stamp: emittedStamp,
    rawDispatchStamp: currentRawDispatchStamp,
    anchorStamp: tracksAnchor ? nextAnchorStamp : null,
  };
}

function createMovementOwnerDispatch(deps = {}) {
  const {
    buildMissileSessionMutation,
    buildMissileSessionSnapshot,
    cloneVector,
    directionsNearlyMatch,
    isReadyForDestiny,
    logMissileDebug,
    normalizeVector,
    roundNumber,
    sessionMatchesIdentity,
    summarizeMissileUpdatesForLog,
    summarizeVector,
    toFiniteNumber,
    toInt,
    advanceMovement,
    nativeSubwarpController,
    cloneDynamicEntityForDestinyPresentation,
    destiny,
    DEFAULT_RIGHT,
    MICHELLE_HELD_FUTURE_DESTINY_LEAD,
    PILOT_WARP_ACTIVATION_DELAY_DESTINY_TICKS,
    MICHELLE_POST_HELD_FUTURE_DESTINY_LEAD = 0,
    PILOT_WARP_HISTORY_SAFE_DESTINY_LEAD =
      PILOT_WARP_ACTIVATION_DELAY_DESTINY_TICKS,
  } = deps;

  return {
    broadcastPilotCommandMovementUpdates(
      runtime,
      session,
      updates,
      nowMs = runtime.getCurrentSimTimeMs(),
      options = {},
    ) {
      if (!Array.isArray(updates) || updates.length === 0) {
        return false;
      }

      const preparedUpdates =
        options.requireExistingVisibility === true
          ? deps.tagUpdatesRequireExistingVisibility(updates)
          : updates;
      const excludedSession = options.excludedSession || null;
      const ownerShouldReceiveDirectUpdates =
        session &&
        isReadyForDestiny(session) &&
        !sessionMatchesIdentity(session, excludedSession);
      if (ownerShouldReceiveDirectUpdates) {
        const ownerAuthorityState = snapshotDestinyAuthorityState(session);
        const ownerMovementUpdates = runtime.filterMovementUpdatesForSession(
          session,
          preparedUpdates,
        );
        const ownerMovementPayloadNames = ownerMovementUpdates
          .map((update) => (
            update &&
            Array.isArray(update.payload) &&
            typeof update.payload[0] === "string"
              ? update.payload[0]
              : null
          ))
          .filter((name) => Boolean(name));
        const ownerHasSteeringCommand =
          ownerMovementPayloadNames.some(isSteeringPayloadName);
        const currentRawDispatchStamp = runtime.getCurrentDestinyStamp(nowMs);
        const liveOwnerSessionStamp = runtime.getCurrentSessionDestinyStamp(
          session,
          nowMs,
        );
        const quietWindowActive = runtime.isSessionInPilotWarpQuietWindow(
          session,
          nowMs,
        );
        const currentVisibleOwnerStamp = runtime.getCurrentVisibleSessionDestinyStamp(
          session,
          nowMs,
        );
        const presentedOwnerMaximumFutureLead = quietWindowActive
          ? PILOT_WARP_HISTORY_SAFE_DESTINY_LEAD
          : MICHELLE_HELD_FUTURE_DESTINY_LEAD;
        const currentPresentedOwnerStamp =
          runtime.getCurrentPresentedSessionDestinyStamp(
            session,
            nowMs,
            presentedOwnerMaximumFutureLead,
          );
        const quietWindowMinimumStamp = quietWindowActive
          ? selectLaterDestinyStamp(
              session._space && session._space.pilotWarpQuietUntilStamp,
              runtime.getHistorySafeSessionDestinyStamp(
                session,
                nowMs,
                PILOT_WARP_HISTORY_SAFE_DESTINY_LEAD,
                PILOT_WARP_HISTORY_SAFE_DESTINY_LEAD,
              ),
            )
          : null;
        const lastFreshAcquireLifecycleStamp = resolveOptionalDestinyStamp(
          ownerAuthorityState && ownerAuthorityState.lastFreshAcquireLifecycleStamp,
          session._space && session._space.lastFreshAcquireLifecycleStamp,
        );
        if (ownerMovementUpdates.length > 0) {
          const ownerNonMissileCriticalLane = resolveDestinyAuthorityLaneTuple({
            authorityState: ownerAuthorityState,
            legacyState: session._space,
            stampKey: "lastOwnerNonMissileCriticalStamp",
            rawDispatchKey: "lastOwnerNonMissileCriticalRawDispatchStamp",
          });
          const lastOwnerNonMissileCriticalStamp =
            ownerNonMissileCriticalLane.stamp;
          const lastOwnerNonMissileCriticalRawDispatchStamp =
            ownerNonMissileCriticalLane.rawDispatchStamp;
          const ownerMissileLifecycleLane = resolveDestinyAuthorityLaneTuple({
            authorityState: ownerAuthorityState,
            legacyState: session._space,
            stampKey: "lastOwnerMissileLifecycleStamp",
            rawDispatchKey: "lastOwnerMissileLifecycleRawDispatchStamp",
          });
          const lastOwnerMissileLifecycleStamp =
            ownerMissileLifecycleLane.stamp;
          const lastOwnerMissileLifecycleRawDispatchStamp =
            ownerMissileLifecycleLane.rawDispatchStamp;
          const ownerMissileFreshAcquireLane =
            resolveDestinyAuthorityLaneTuple({
              authorityState: ownerAuthorityState,
              legacyState: session._space,
              stampKey: "lastOwnerMissileFreshAcquireStamp",
              rawDispatchKey: "lastOwnerMissileFreshAcquireRawDispatchStamp",
            });
          const lastOwnerMissileFreshAcquireStamp =
            ownerMissileFreshAcquireLane.stamp;
          const lastOwnerMissileFreshAcquireRawDispatchStamp =
            ownerMissileFreshAcquireLane.rawDispatchStamp;
          const previousOwnerPilotCommandLane =
            resolveDestinyAuthorityCommandTuple({
              authorityState: ownerAuthorityState,
              legacyState: session._space,
            });
          const previousOwnerPilotCommandStamp =
            previousOwnerPilotCommandLane.stamp;
          const previousOwnerPilotCommandAnchorStamp =
            previousOwnerPilotCommandLane.anchorStamp;
          const previousOwnerPilotCommandRawDispatchStamp =
            previousOwnerPilotCommandLane.rawDispatchStamp;
          const previousPresentedLane = resolveDestinyAuthorityLaneTuple({
            authorityState: ownerAuthorityState,
            legacyState: session._space,
            stampKey: "lastPresentedStamp",
            rawDispatchKey: "lastRawDispatchStamp",
            legacyStampKey: "lastSentDestinyStamp",
            legacyRawDispatchKey: "lastSentDestinyRawDispatchStamp",
          });
          const ownerRestampState = resolveOwnerMovementRestampState({
            ownerMovementUpdates,
            ownerHasSteeringCommand,
            ownerDirectEchoLeadOverride: options.ownerDirectEchoLeadOverride,
            currentRawDispatchStamp,
            liveOwnerSessionStamp,
            currentVisibleOwnerStamp,
            currentPresentedOwnerStamp,
            previousLastSentDestinyWasOwnerCritical:
              ownerAuthorityState &&
              ownerAuthorityState.lastSentWasOwnerCritical === true,
            previousLastSentDestinyStamp: previousPresentedLane.stamp,
            previousLastSentDestinyRawDispatchStamp:
              previousPresentedLane.rawDispatchStamp,
            previousLastSentDestinyOnlyStaleProjectedOwnerMissileLane:
              ownerAuthorityState &&
              ownerAuthorityState.lastSentOnlyStaleProjectedOwnerMissileLane === true,
            recentEmittedOwnerCriticalMaxLead:
              MICHELLE_HELD_FUTURE_DESTINY_LEAD +
              MICHELLE_POST_HELD_FUTURE_DESTINY_LEAD +
              PILOT_WARP_HISTORY_SAFE_DESTINY_LEAD,
            ignoreRecentOwnerCriticalFloor:
              options.ignoreRecentOwnerCriticalFloor === true,
            ignoreOwnerDirectEchoHistoryFloor:
              options.ignoreOwnerDirectEchoHistoryFloor === true ||
              (
                options.sendOptions &&
                options.sendOptions.destinyAuthorityIgnorePreviousLastSentFloor === true
              ),
            quietWindowMinimumStamp,
            lastFreshAcquireLifecycleStamp,
            lastOwnerNonMissileCriticalStamp,
            lastOwnerNonMissileCriticalRawDispatchStamp,
            lastOwnerMissileLifecycleStamp,
            lastOwnerMissileLifecycleRawDispatchStamp,
            lastOwnerMissileFreshAcquireStamp,
            lastOwnerMissileFreshAcquireRawDispatchStamp,
            previousOwnerPilotCommandStamp,
            previousOwnerPilotCommandAnchorStamp,
            previousOwnerPilotCommandRawDispatchStamp,
            previousOwnerPilotCommandDirectionRaw:
              previousOwnerPilotCommandLane.direction,
            normalizeVector,
            directionsNearlyMatch,
            getPendingHistorySafeStamp: (authoredStamp, minimumLead) => (
              runtime.getPendingHistorySafeSessionDestinyStamp(
                session,
                authoredStamp,
                nowMs,
                minimumLead,
              )
            ),
            defaultRight: DEFAULT_RIGHT,
          });
          const {
            currentOwnerPilotCommandDirection,
            previousOwnerPilotCommandDirection,
            ownerDirectEchoMinimumStamp,
            repeatedOwnerPilotCommandLane,
            reusableHeldOwnerPilotCommandLane,
            nextDistinctOwnerPilotCommandLane,
            suppressSameRawDistinctFutureOwnerEcho,
            earlierTickOwnerPilotCommandMatches,
            recentPresentedFreshAcquireLane,
            recentOwnerNonMissileCriticalLane,
            recentOwnerMissileLifecycleLane,
            recentOwnerFreshAcquireLane,
            recentBufferedOwnerCriticalFloor,
            ownerVisibleStamp,
            ownerMinimumStamp,
            postFreshAcquireOwnerSteeringFloor,
            presentedNonCriticalOwnerEchoFloor,
            ownerStampFloor,
            ownerUpdates,
          } = ownerRestampState;
          logMissileDebug("movement.owner-restamp", {
            rawDispatchStamp: currentRawDispatchStamp,
            rawSimTimeMs: roundNumber(nowMs, 3),
            session: buildMissileSessionSnapshot(runtime, session, nowMs),
            ownerMovementUpdates: summarizeMissileUpdatesForLog(ownerMovementUpdates),
            ownerMovementFloor: {
              liveOwnerSessionStamp,
              currentVisibleOwnerStamp,
              currentPresentedOwnerStamp,
              ownerVisibleStamp,
              quietWindowMinimumStamp,
              lastFreshAcquireLifecycleStamp,
              recentPresentedFreshAcquireLane,
              lastOwnerNonMissileCriticalStamp,
              lastOwnerNonMissileCriticalRawDispatchStamp,
              lastOwnerMissileLifecycleStamp,
              lastOwnerMissileLifecycleRawDispatchStamp,
              lastOwnerMissileFreshAcquireStamp,
              lastOwnerMissileFreshAcquireRawDispatchStamp,
              recentOwnerNonMissileCriticalLane,
              recentOwnerMissileLifecycleLane,
              recentOwnerFreshAcquireLane,
              recentBufferedOwnerCriticalFloor,
              ownerMinimumStamp,
              ownerDirectEchoLeadOverride:
                toInt(options.ownerDirectEchoLeadOverride, 0) || null,
              ownerDirectEchoMinimumStamp,
              presentedNonCriticalOwnerEchoFloor,
              postFreshAcquireOwnerSteeringFloor,
              previousOwnerPilotCommandStamp,
              previousOwnerPilotCommandAnchorStamp,
              previousOwnerPilotCommandRawDispatchStamp,
              previousOwnerPilotCommandDirection:
                summarizeVector(previousOwnerPilotCommandDirection),
              currentOwnerPilotCommandDirection:
                summarizeVector(currentOwnerPilotCommandDirection),
              earlierTickOwnerPilotCommandMatches,
              repeatedOwnerPilotCommandLane,
              reusableHeldOwnerPilotCommandLane,
              nextDistinctOwnerPilotCommandLane,
              suppressSameRawDistinctFutureOwnerEcho,
              ownerStampFloor,
            },
          });
          const sessionBeforeOwnerMovementSend = buildMissileSessionSnapshot(
            runtime,
            session,
            nowMs,
          );
          const ownerEntity =
            typeof runtime.getShipEntityForSession === "function"
              ? runtime.getShipEntityForSession(session)
              : null;
          const ownerUpdatesForSend = suppressSameRawDistinctFutureOwnerEcho
            ? ownerUpdates
            : rebuildOwnerKinematicUpdatesForProjectedStamp({
                updates: ownerUpdates,
                entity: ownerEntity,
                rawNowMs: nowMs,
                currentSimTimeMs:
                  typeof runtime.getCurrentSessionSimTimeMs === "function"
                    ? runtime.getCurrentSessionSimTimeMs(session, nowMs)
                    : nowMs,
                currentStamp: liveOwnerSessionStamp,
                scene: runtime,
                advanceMovement,
                nativeSubwarpController,
                nativeSubwarpFrame: runtime._nativeSubwarpFrame,
                cloneDynamicEntityForDestinyPresentation,
                destiny,
              });

          const highestQueuedOwnerMovementStamp = ownerUpdatesForSend.reduce(
            (latestStamp, update) => selectLaterDestinyStamp(
              latestStamp,
              normalizeDestinyStamp(update && update.stamp),
            ),
            null,
          );
          const useTickPresentationBatch =
            !suppressSameRawDistinctFutureOwnerEcho &&
            typeof runtime.hasActiveTickDestinyPresentationBatch === "function" &&
            typeof runtime.queueTickDestinyPresentationUpdates === "function" &&
            runtime.hasActiveTickDestinyPresentationBatch();
          let emittedOwnerMovementStamp = null;
          if (suppressSameRawDistinctFutureOwnerEcho) {
            emittedOwnerMovementStamp = null;
          } else if (useTickPresentationBatch) {
            runtime.queueTickDestinyPresentationUpdates(
              session,
              ownerUpdatesForSend,
              {
                sendOptions: {
                  destinyAuthorityContract: DESTINY_CONTRACTS.OWNER_PILOT_COMMAND,
                  // Direct owner movement already resolved its held-future lane
                  // in resolveOwnerMovementRestampState. Running the generic
                  // owner-critical monotonic pass again pushes normal steering
                  // and stop packets onto later future lanes and recreates the
                  // pre-launch Michelle rewinds seen in bad.txt.
                  skipOwnerMonotonicRestamp: true,
                  translateStamps: false,
                },
              },
            );
            emittedOwnerMovementStamp = highestQueuedOwnerMovementStamp;
          } else {
            emittedOwnerMovementStamp = runtime.sendDestinyUpdates(
              session,
              ownerUpdatesForSend,
              false,
              {
                destinyAuthorityContract: DESTINY_CONTRACTS.OWNER_PILOT_COMMAND,
                // See tick-batch path above: these owner movement packets are
                // already restamped once and must not be lifted again by the
                // generic owner-critical monotonic pass.
                skipOwnerMonotonicRestamp: true,
                translateStamps: false,
              },
            );
          }
          const emittedOwnerGotoDirection = resolveGotoDirectionFromUpdates({
            updates: ownerUpdatesForSend,
            normalizeVector,
            defaultDirection: DEFAULT_RIGHT,
            expectedStamp: resolveOptionalDestinyStamp(
              emittedOwnerMovementStamp,
            ),
            normalizeStamp: resolveOptionalDestinyStamp,
          });
          const emittedOwnerCommandHeadingHash = emittedOwnerGotoDirection
            ? serializeDestinyDirectionHeading(emittedOwnerGotoDirection)
            : "";
          if (session._space && hasDestinyStamp(emittedOwnerMovementStamp)) {
            const ownerNonMissileLaneWrite = resolveAtomicOwnerMovementLaneWrite({
              previousStamp: lastOwnerNonMissileCriticalStamp,
              previousRawDispatchStamp:
                lastOwnerNonMissileCriticalRawDispatchStamp,
              emittedStamp: emittedOwnerMovementStamp,
              currentRawDispatchStamp,
            });
            session._space.lastOwnerNonMissileCriticalStamp =
              ownerNonMissileLaneWrite.stamp;
            session._space.lastOwnerNonMissileCriticalRawDispatchStamp =
              ownerNonMissileLaneWrite.rawDispatchStamp;
            let ownerCommandLaneWrite = null;
            if (ownerHasSteeringCommand) {
              const refreshOwnerCommandAnchor =
                shouldRefreshOwnerCommandAnchor({
                  previousStamp: previousOwnerPilotCommandStamp,
                  previousAnchorStamp: previousOwnerPilotCommandAnchorStamp,
                  emittedStamp: emittedOwnerMovementStamp,
                  liveSessionStamp: liveOwnerSessionStamp,
                });
              ownerCommandLaneWrite = resolveAtomicOwnerMovementLaneWrite({
                tracksAnchor: true,
                previousStamp: previousOwnerPilotCommandStamp,
                previousRawDispatchStamp:
                  previousOwnerPilotCommandRawDispatchStamp,
                previousAnchorStamp: previousOwnerPilotCommandAnchorStamp,
                emittedStamp: emittedOwnerMovementStamp,
                currentRawDispatchStamp,
                nextAnchorStamp: refreshOwnerCommandAnchor
                  ? liveOwnerSessionStamp
                  : previousOwnerPilotCommandAnchorStamp,
              });
              session._space.lastPilotCommandMovementStamp =
                ownerCommandLaneWrite.stamp;
              session._space.lastPilotCommandMovementRawDispatchStamp =
                ownerCommandLaneWrite.rawDispatchStamp;
              session._space.lastPilotCommandMovementAnchorStamp =
                ownerCommandLaneWrite.anchorStamp;
              if (ownerCommandLaneWrite.accepted) {
                session._space.lastPilotCommandDirection = emittedOwnerGotoDirection
                  ? cloneVector(emittedOwnerGotoDirection)
                  : null;
              }
            }
            updateDestinyAuthorityState(session, {
              lastOwnerNonMissileCriticalStamp:
                ownerNonMissileLaneWrite.stamp,
              lastOwnerNonMissileCriticalRawDispatchStamp:
                ownerNonMissileLaneWrite.rawDispatchStamp,
              ...(ownerHasSteeringCommand
                ? {
                    lastOwnerCommandStamp: ownerCommandLaneWrite.stamp,
                    lastOwnerCommandAnchorStamp:
                      ownerCommandLaneWrite.anchorStamp,
                    lastOwnerCommandRawDispatchStamp:
                      ownerCommandLaneWrite.rawDispatchStamp,
                    lastOwnerCommandHeadingHash:
                      ownerCommandLaneWrite.accepted
                        ? emittedOwnerCommandHeadingHash
                        : (
                            ownerAuthorityState &&
                            ownerAuthorityState.lastOwnerCommandHeadingHash
                          ) || "",
                  }
                : {}),
            });
          } else if (
            session._space &&
            ownerHasSteeringCommand &&
            suppressSameRawDistinctFutureOwnerEcho === true
          ) {
            updateDestinyAuthorityState(session, {
              lastOwnerCommandStamp: previousOwnerPilotCommandStamp,
              lastOwnerCommandHeadingHash: currentOwnerPilotCommandDirection
                ? serializeDestinyDirectionHeading(
                    currentOwnerPilotCommandDirection,
                  )
                : "",
            });
            if (
              hasDestinyStamp(previousOwnerPilotCommandStamp) &&
              currentOwnerPilotCommandDirection
            ) {
              session._space.lastPilotCommandDirection = cloneVector(
                currentOwnerPilotCommandDirection,
              );
            }
          }
          const sessionAfterOwnerMovementSend = buildMissileSessionSnapshot(
            runtime,
            session,
            nowMs,
          );
          logMissileDebug("movement.owner-send-complete", {
            rawDispatchStamp: currentRawDispatchStamp,
            rawSimTimeMs: roundNumber(nowMs, 3),
            emittedOwnerMovementStamp,
            suppressSameRawDistinctFutureOwnerEcho,
            usedTickPresentationBatch: useTickPresentationBatch,
            ownerHasSteeringCommand,
            ownerUpdates: summarizeMissileUpdatesForLog(ownerUpdatesForSend),
            sessionBefore: sessionBeforeOwnerMovementSend,
            sessionAfter: sessionAfterOwnerMovementSend,
            sessionMutation: buildMissileSessionMutation(
              sessionBeforeOwnerMovementSend,
              sessionAfterOwnerMovementSend,
            ),
          });
        }

        runtime.broadcastMovementUpdates(
          preparedUpdates,
          session,
          options.sendOptions || {},
        );
        return true;
      }

      runtime.broadcastMovementUpdates(
        preparedUpdates,
        excludedSession,
        options.sendOptions || {},
      );
      return true;
    },
  };
}

module.exports = {
  createMovementOwnerDispatch,
};
Object.defineProperties(module.exports, {
  getGuardedDestinyStampForwardDistance: {
    value: getGuardedDestinyStampForwardDistance,
  },
  resolveAtomicOwnerMovementLaneWrite: {
    value: resolveAtomicOwnerMovementLaneWrite,
  },
  shouldRefreshOwnerCommandAnchor: {
    value: shouldRefreshOwnerCommandAnchor,
  },
});
