const destiny = require("../index.js");
const {
  isSteeringPayloadName,
} = require("../protocol/payloads.js");
const {
  resolveGotoDirectionFromUpdates,
  serializeDestinyDirectionHeading,
} = require("../protocol/direction.js");
const {
  projectPreviouslySentDestinyLane,
  resolveOwnerMovementRestampState,
} = require("../delivery/deliveryPolicy.js");
const {
  clampQueuedSubwarpUpdates,
} = require("../delivery/sync.js");
const {
  tagUpdatesRequireExistingVisibility,
} = require("./dispatchUtils.js");
const {
  resolveAtomicOwnerMovementLaneWrite,
  shouldRefreshOwnerCommandAnchor,
} = require("./ownerDispatch.js");
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
  selectFurthestDestinyStamp,
  selectLaterDestinyStamp,
} = require("../delivery/stamps");

function createMovementContractDispatch(deps = {}) {
  const {
    cloneVector,
    isReadyForDestiny,
    logMissileDebug,
    normalizeVector,
    roundNumber,
    sessionMatchesIdentity,
    summarizeRuntimeEntityForMissileDebug,
    buildMissileSessionSnapshot,
    directionsNearlyMatch,
    toInt,
    DEFAULT_RIGHT,
    MICHELLE_DIRECT_CRITICAL_ECHO_DESTINY_LEAD,
    MICHELLE_HELD_FUTURE_DESTINY_LEAD,
    PILOT_WARP_ACTIVATION_DELAY_DESTINY_TICKS,
    MICHELLE_POST_HELD_FUTURE_DESTINY_LEAD,
  } = deps;

  return {
    dispatchConfiguredSubwarpMovement(
      runtime,
      entity,
      buildUpdates,
      nowMs = runtime.getCurrentSimTimeMs(),
      options = {},
    ) {
      if (!entity || typeof buildUpdates !== "function") {
        return false;
      }

      const requireExistingVisibility =
        options.requireExistingVisibility === true ||
        options.suppressFreshAcquireReplay === true;
      const prepareUpdates = (stamp) => {
        const updates = buildUpdates(stamp);
        if (!Array.isArray(updates) || updates.length === 0) {
          return [];
        }
        return requireExistingVisibility
          ? tagUpdatesRequireExistingVisibility(updates)
          : updates;
      };

      const ownerSession =
        entity && entity.session && isReadyForDestiny(entity.session)
          ? entity.session
          : null;
      const deferForMissilePressure =
        options.queueHistorySafeContract !== true &&
        ownerSession &&
        runtime.shouldDeferPilotMovementForMissilePressure(ownerSession, nowMs);

      if (deferForMissilePressure) {
        logMissileDebug("movement.defer-for-missile-pressure", {
          rawDispatchStamp: runtime.getCurrentDestinyStamp(nowMs),
          rawSimTimeMs: roundNumber(nowMs, 3),
          entity: summarizeRuntimeEntityForMissileDebug(entity),
          session: buildMissileSessionSnapshot(runtime, ownerSession, nowMs),
        });
      }

      if (options.queueHistorySafeContract === true || deferForMissilePressure) {
        return runtime.queueSubwarpMovementContract(entity, prepareUpdates, {
          nowMs,
          scheduledStamp: options.scheduledStamp,
          excludedSession: options.excludedSession || null,
          suppressedSessions:
            options.suppressedSessions instanceof Set
              ? options.suppressedSessions
              : null,
          suppressOwnerGotoEcho: options.suppressOwnerGotoEcho === true,
        });
      }

      return runtime.broadcastPilotCommandMovementUpdates(
        entity.session || null,
        prepareUpdates(runtime.getMovementStamp(nowMs)),
        nowMs,
        {
          ...options,
          sendOptions: options.sendOptions || {},
        },
      );
    },

    dispatchSubwarpMovementUpdates(runtime, entity, updates, options = {}) {
      if (!entity || !Array.isArray(updates) || updates.length === 0) {
        return false;
      }

      const preparedUpdates =
        options.requireExistingVisibility === true
          ? tagUpdatesRequireExistingVisibility(updates)
          : updates;

      runtime.broadcastMovementUpdates(
        preparedUpdates,
        options.excludedSession || null,
        options.sendOptions || {},
      );
      return true;
    },

    queueSubwarpMovementContract(runtime, entity, buildUpdates, options = {}) {
      if (!entity || typeof buildUpdates !== "function") {
        return false;
      }

      runtime.pendingSubwarpMovementContracts.set(entity.itemID, {
        entityID: entity.itemID,
        buildUpdates,
        includeSpeedFraction: options.includeSpeedFraction === true,
        suppressOwnerGotoEcho: options.suppressOwnerGotoEcho === true,
        scheduledStamp:
          options.scheduledStamp === undefined || options.scheduledStamp === null
            ? runtime.getHistorySafeDestinyStamp(
                options.nowMs === undefined || options.nowMs === null
                  ? runtime.getCurrentSimTimeMs()
                  : options.nowMs,
                MICHELLE_HELD_FUTURE_DESTINY_LEAD,
              )
            : normalizeDestinyStamp(options.scheduledStamp),
        excludedSession: options.excludedSession || null,
        suppressedSessions:
          options.suppressedSessions instanceof Set
            ? new Set(options.suppressedSessions)
            : null,
        ownerDirectEchoLeadOverride:
          options.ownerDirectEchoLeadOverride === undefined ||
          options.ownerDirectEchoLeadOverride === null
            ? undefined
            : (toInt(options.ownerDirectEchoLeadOverride, 0) || 0),
      });
      return true;
    },

    clearPendingSubwarpMovementContract(runtime, entityOrID) {
      const entityID =
        typeof entityOrID === "object" && entityOrID !== null
          ? toInt(entityOrID.itemID, 0)
          : toInt(entityOrID, 0);
      if (entityID <= 0) {
        return false;
      }
      return runtime.pendingSubwarpMovementContracts.delete(entityID);
    },

    flushPendingSubwarpMovementContracts(runtime, now = runtime.getCurrentSimTimeMs()) {
      if (runtime.pendingSubwarpMovementContracts.size === 0) {
        return;
      }

      const deferredPendingContracts = new Map();

      const clampQueuedSubwarpUpdatesForSession = (
        session,
        queuedUpdates,
        options = {},
      ) => {
        if (
          !session ||
          !session._space ||
          !Array.isArray(queuedUpdates) ||
          queuedUpdates.length === 0
        ) {
          return queuedUpdates;
        }

        const authorityState = snapshotDestinyAuthorityState(session);
        const presentedFloorStamp = runtime.getCurrentPresentedSessionDestinyStamp(
          session,
          now,
          MICHELLE_HELD_FUTURE_DESTINY_LEAD,
        );
        const currentRawDispatchStamp = runtime.getCurrentDestinyStamp(now);
        const lastPresentedLane = resolveDestinyAuthorityLaneTuple({
          authorityState,
          legacyState: session._space,
          stampKey: "lastPresentedStamp",
          rawDispatchKey: "lastRawDispatchStamp",
          legacyStampKey: "lastSentDestinyStamp",
          legacyRawDispatchKey: "lastSentDestinyRawDispatchStamp",
        });
        const lastSentDestinyStamp = lastPresentedLane.stamp;
        const lastSentDestinyRawDispatchStamp =
          lastPresentedLane.rawDispatchStamp;
        const lastSentDestinyWasOwnerCritical =
          authorityState &&
          authorityState.lastSentWasOwnerCritical === true;
        const projectedFloorStamp =
          hasDestinyStamp(lastSentDestinyStamp) &&
          hasDestinyStamp(lastSentDestinyRawDispatchStamp) &&
          getDestinyStampForwardDistance(
            lastSentDestinyRawDispatchStamp,
            currentRawDispatchStamp,
          ) > 0 &&
          getDestinyStampForwardDistance(
            lastSentDestinyRawDispatchStamp,
            currentRawDispatchStamp,
          ) <= 1 &&
          !(
            authorityState &&
            authorityState.lastSentOnlyStaleProjectedOwnerMissileLane === true
          )
            ? projectPreviouslySentDestinyLane(
                lastSentDestinyStamp,
                lastSentDestinyRawDispatchStamp,
                currentRawDispatchStamp,
              )
            : null;
        // Keep queued observer movement inside Michelle's held-future window.
        // `client/jolty8.txt` showed that clamping queued Orbit/FollowBall to
        // visible+3 forces an immediate SynchroniseToSimulationTime + rebase.
        // The visible stamp equals the session stamp, which is ~1 tick ahead
        // of the client's _current_time. Subtract that offset so the floor
        // lands at client+2 (delta 2, held) instead of client+3 (delta 3,
        // jolt).
        const rawVisibleStamp = runtime.getCurrentVisibleSessionDestinyStamp(
          session,
          now,
        );
        const sessionStamp = runtime.getCurrentSessionDestinyStamp(
          session,
          now,
        );
        const explicitHistoryFloorStamp = resolveOptionalDestinyStamp(
          session._space && session._space.historyFloorDestinyStamp,
        );
        const hasFutureVisibleHistory =
          hasDestinyStamp(explicitHistoryFloorStamp) &&
          isDestinyStampAfter(sessionStamp, explicitHistoryFloorStamp);
        const visibleFloorStamp = hasFutureVisibleHistory
          ? advanceDestinyStamp(
              explicitHistoryFloorStamp,
              MICHELLE_HELD_FUTURE_DESTINY_LEAD,
            )
          : advanceDestinyStamp(
              rawVisibleStamp,
              MICHELLE_HELD_FUTURE_DESTINY_LEAD -
                MICHELLE_DIRECT_CRITICAL_ECHO_DESTINY_LEAD,
            );
        // If we already emitted an owner-critical future lane on this raw tick,
        // observer-visible queued movement must clear that consumed lane instead
        // of reusing an older held-future stamp. `client/fulldesync2.txt` shows
        // Michelle escalating this into UpdateStateRequest when an NPC
        // GotoDirection lands on 1775041673 after the owner's same-raw future
        // lane already reached 1775041677.
        const sameRawOwnerCriticalClearFloorStamp =
          options.isObserverVisibleContract === true &&
          lastSentDestinyWasOwnerCritical &&
          lastSentDestinyRawDispatchStamp === currentRawDispatchStamp &&
          (
            lastSentDestinyStamp === selectFurthestDestinyStamp(
              sessionStamp,
              [
                visibleFloorStamp,
                presentedFloorStamp,
                projectedFloorStamp,
                lastSentDestinyStamp,
              ],
            )
          )
            ? advanceDestinyStamp(lastSentDestinyStamp, 1)
            : null;
        return clampQueuedSubwarpUpdates({
          queuedUpdates,
          visibleFloorStamp,
          presentedFloorStamp,
          projectedFloorStamp: selectLaterDestinyStamp(
            projectedFloorStamp,
            sameRawOwnerCriticalClearFloorStamp,
          ),
          restampPayloadState: destiny.restampPayloadState,
        });
      };

      const minimumFutureStamp = runtime.getHistorySafeDestinyStamp(
        now,
        MICHELLE_HELD_FUTURE_DESTINY_LEAD,
      );
      for (const pending of runtime.pendingSubwarpMovementContracts.values()) {
        const stamp = selectLaterDestinyStamp(
          hasDestinyStamp(pending && pending.scheduledStamp)
            ? pending.scheduledStamp
            : minimumFutureStamp,
          minimumFutureStamp,
        );
        const updates = pending.buildUpdates(stamp);
        if (!Array.isArray(updates) || updates.length === 0) {
          continue;
        }
        const entity = runtime.dynamicEntities.get(toInt(pending.entityID, 0));
        let delivered = false;
        const ownerSession =
          entity &&
          entity.session &&
          entity.session !== pending.excludedSession &&
          isReadyForDestiny(entity.session)
            ? entity.session
            : null;
        const suppressedSessions =
          pending && pending.suppressedSessions instanceof Set
            ? pending.suppressedSessions
            : null;
        if (ownerSession && !(suppressedSessions && suppressedSessions.has(ownerSession))) {
          const ownerAuthorityState = snapshotDestinyAuthorityState(ownerSession);
          const liveOwnerSessionStamp = runtime.getCurrentSessionDestinyStamp(
            ownerSession,
            now,
          );
          const currentRawDispatchStamp = runtime.getCurrentDestinyStamp(now);
          let ownerUpdates = runtime.filterMovementUpdatesForSession(
            ownerSession,
            updates,
          );
          if (pending.suppressOwnerGotoEcho === true) {
            ownerUpdates = ownerUpdates.filter((update) => (
              !Array.isArray(update && update.payload) ||
              update.payload[0] !== "GotoDirection"
            ));
          }
          const ownerMovementPayloadNamesBeforeClamp = ownerUpdates
            .map((update) => (
              update &&
              Array.isArray(update.payload) &&
              typeof update.payload[0] === "string"
                ? update.payload[0]
                : null
            ))
            .filter((name) => Boolean(name));
          const ownerHasSteeringCommandBeforeClamp =
            ownerMovementPayloadNamesBeforeClamp.some(isSteeringPayloadName);
          const previousOwnerNonMissileCriticalLane =
            resolveDestinyAuthorityLaneTuple({
              authorityState: ownerAuthorityState,
              legacyState: ownerSession._space,
              stampKey: "lastOwnerNonMissileCriticalStamp",
              rawDispatchKey: "lastOwnerNonMissileCriticalRawDispatchStamp",
            });
          const previousOwnerNonMissileCriticalStamp =
            previousOwnerNonMissileCriticalLane.stamp;
          const previousOwnerNonMissileCriticalRawDispatchStamp =
            previousOwnerNonMissileCriticalLane.rawDispatchStamp;
          const previousOwnerPilotCommandLane =
            resolveDestinyAuthorityCommandTuple({
              authorityState: ownerAuthorityState,
              legacyState: ownerSession._space,
            });
          const previousOwnerPilotCommandStamp =
            previousOwnerPilotCommandLane.stamp;
          const previousOwnerPilotCommandAnchorStamp =
            previousOwnerPilotCommandLane.anchorStamp;
          const previousOwnerPilotCommandRawDispatchStamp =
            previousOwnerPilotCommandLane.rawDispatchStamp;
          const previousPresentedLane = resolveDestinyAuthorityLaneTuple({
            authorityState: ownerAuthorityState,
            legacyState: ownerSession._space,
            stampKey: "lastPresentedStamp",
            rawDispatchKey: "lastRawDispatchStamp",
            legacyStampKey: "lastSentDestinyStamp",
            legacyRawDispatchKey: "lastSentDestinyRawDispatchStamp",
          });
          const previousOwnerMissileLifecycleLane =
            resolveDestinyAuthorityLaneTuple({
              authorityState: ownerAuthorityState,
              legacyState: ownerSession._space,
              stampKey: "lastOwnerMissileLifecycleStamp",
              rawDispatchKey:
                "lastOwnerMissileLifecycleRawDispatchStamp",
            });
          const previousOwnerMissileFreshAcquireLane =
            resolveDestinyAuthorityLaneTuple({
              authorityState: ownerAuthorityState,
              legacyState: ownerSession._space,
              stampKey: "lastOwnerMissileFreshAcquireStamp",
              rawDispatchKey:
                "lastOwnerMissileFreshAcquireRawDispatchStamp",
            });
          let queuedOwnerRestampState = null;
          if (ownerHasSteeringCommandBeforeClamp) {
            const quietWindowActive =
              typeof runtime.isSessionInPilotWarpQuietWindow === "function" &&
              runtime.isSessionInPilotWarpQuietWindow(ownerSession, now);
            const currentVisibleOwnerStamp =
              runtime.getCurrentVisibleSessionDestinyStamp(
                ownerSession,
                now,
              );
            const currentPresentedOwnerStamp =
              runtime.getCurrentPresentedSessionDestinyStamp(
                ownerSession,
                now,
                quietWindowActive
                  ? PILOT_WARP_ACTIVATION_DELAY_DESTINY_TICKS
                  : MICHELLE_HELD_FUTURE_DESTINY_LEAD,
              );
            const quietWindowMinimumStamp = quietWindowActive
              ? selectLaterDestinyStamp(
                  resolveOptionalDestinyStamp(
                    ownerSession._space &&
                      ownerSession._space.pilotWarpQuietUntilStamp,
                  ),
                  typeof runtime.getHistorySafeSessionDestinyStamp === "function"
                    ? runtime.getHistorySafeSessionDestinyStamp(
                        ownerSession,
                        now,
                        PILOT_WARP_ACTIVATION_DELAY_DESTINY_TICKS,
                        PILOT_WARP_ACTIVATION_DELAY_DESTINY_TICKS,
                      )
                    : null,
                )
              : null;
            queuedOwnerRestampState = resolveOwnerMovementRestampState({
              ownerMovementUpdates: ownerUpdates,
              ownerHasSteeringCommand: true,
              ownerDirectEchoLeadOverride: pending.ownerDirectEchoLeadOverride,
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
                PILOT_WARP_ACTIVATION_DELAY_DESTINY_TICKS,
              quietWindowMinimumStamp,
              lastFreshAcquireLifecycleStamp: resolveOptionalDestinyStamp(
                ownerAuthorityState &&
                  ownerAuthorityState.lastFreshAcquireLifecycleStamp,
                ownerSession._space &&
                  ownerSession._space.lastFreshAcquireLifecycleStamp,
              ),
              lastOwnerNonMissileCriticalStamp:
                previousOwnerNonMissileCriticalStamp,
              lastOwnerNonMissileCriticalRawDispatchStamp:
                previousOwnerNonMissileCriticalRawDispatchStamp,
              lastOwnerMissileLifecycleStamp:
                previousOwnerMissileLifecycleLane.stamp,
              lastOwnerMissileLifecycleRawDispatchStamp:
                previousOwnerMissileLifecycleLane.rawDispatchStamp,
              lastOwnerMissileFreshAcquireStamp:
                previousOwnerMissileFreshAcquireLane.stamp,
              lastOwnerMissileFreshAcquireRawDispatchStamp:
                previousOwnerMissileFreshAcquireLane.rawDispatchStamp,
              previousOwnerPilotCommandStamp,
              previousOwnerPilotCommandAnchorStamp,
              previousOwnerPilotCommandRawDispatchStamp,
              previousOwnerPilotCommandDirectionRaw:
                previousOwnerPilotCommandLane.direction,
              normalizeVector,
              directionsNearlyMatch,
              getPendingHistorySafeStamp: (authoredStamp, minimumLead = 0) => (
                typeof runtime.getPendingHistorySafeSessionDestinyStamp === "function"
                  ? runtime.getPendingHistorySafeSessionDestinyStamp(
                      ownerSession,
                      authoredStamp,
                      now,
                      minimumLead,
                    )
                  : selectLaterDestinyStamp(
                      normalizeDestinyStamp(authoredStamp),
                      advanceDestinyStamp(
                        liveOwnerSessionStamp,
                        toInt(minimumLead, 0),
                      ),
                    )
              ),
              defaultRight:
                DEFAULT_RIGHT && typeof DEFAULT_RIGHT === "object"
                  ? DEFAULT_RIGHT
                  : { x: 1, y: 0, z: 0 },
            });
            if (
              queuedOwnerRestampState &&
              Array.isArray(queuedOwnerRestampState.ownerUpdates)
            ) {
              ownerUpdates = queuedOwnerRestampState.ownerUpdates;
            }
          }
          ownerUpdates = clampQueuedSubwarpUpdatesForSession(
            ownerSession,
            ownerUpdates,
            {
              isObserverVisibleContract: false,
            },
          );
          if (ownerUpdates.length > 0) {
            const ownerMovementPayloadNames = ownerUpdates
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
            const highestQueuedOwnerMovementStamp = ownerUpdates.reduce(
              (latestStamp, update) => selectLaterDestinyStamp(
                latestStamp,
                normalizeDestinyStamp(update && update.stamp),
              ),
              null,
            );
            let recordedOwnerMovementStamp = null;
            if (runtime.hasActiveTickDestinyPresentationBatch()) {
              runtime.queueTickDestinyPresentationUpdates(ownerSession, ownerUpdates, {
                sendOptions: {
                  destinyAuthorityContract: DESTINY_CONTRACTS.OWNER_PILOT_COMMAND,
                  // Queued owner steering was already clamped onto its safe
                  // presented lane before entering the generic destiny sender.
                  // Re-running owner monotonic restamp here can push or clamp
                  // that same steer onto a different lane, which recreates the
                  // Michelle backstep seen in jolty4.
                  skipOwnerMonotonicRestamp: true,
                  translateStamps: false,
                },
              });
              recordedOwnerMovementStamp = highestQueuedOwnerMovementStamp;
            } else {
              recordedOwnerMovementStamp = runtime.sendDestinyUpdates(
                ownerSession,
                ownerUpdates,
                false,
                {
                  destinyAuthorityContract: DESTINY_CONTRACTS.OWNER_PILOT_COMMAND,
                  // Match the direct owner movement path above: queued owner
                  // steering is already restamped once and must not be
                  // reprocessed by the generic owner-critical monotonic pass.
                  skipOwnerMonotonicRestamp: true,
                  translateStamps: false,
                },
              );
            }
            const emittedOwnerGotoDirection = resolveGotoDirectionFromUpdates({
              updates: ownerUpdates,
              normalizeVector,
              defaultDirection:
                DEFAULT_RIGHT && typeof DEFAULT_RIGHT === "object"
                  ? DEFAULT_RIGHT
                  : { x: 1, y: 0, z: 0 },
              expectedStamp: resolveOptionalDestinyStamp(
                recordedOwnerMovementStamp,
              ),
              normalizeStamp: resolveOptionalDestinyStamp,
            });
            if (
              ownerSession._space &&
              hasDestinyStamp(recordedOwnerMovementStamp)
            ) {
              const ownerNonMissileLaneWrite = resolveAtomicOwnerMovementLaneWrite({
                previousStamp: previousOwnerNonMissileCriticalStamp,
                previousRawDispatchStamp:
                  previousOwnerNonMissileCriticalRawDispatchStamp,
                emittedStamp: recordedOwnerMovementStamp,
                currentRawDispatchStamp,
              });
              ownerSession._space.lastOwnerNonMissileCriticalStamp =
                ownerNonMissileLaneWrite.stamp;
              ownerSession._space.lastOwnerNonMissileCriticalRawDispatchStamp =
                ownerNonMissileLaneWrite.rawDispatchStamp;
              let ownerCommandLaneWrite = null;
              if (ownerHasSteeringCommand) {
                const refreshOwnerCommandAnchor =
                  shouldRefreshOwnerCommandAnchor({
                    previousStamp: previousOwnerPilotCommandStamp,
                    previousAnchorStamp: previousOwnerPilotCommandAnchorStamp,
                    emittedStamp: recordedOwnerMovementStamp,
                    liveSessionStamp: liveOwnerSessionStamp,
                  });
                ownerCommandLaneWrite = resolveAtomicOwnerMovementLaneWrite({
                  tracksAnchor: true,
                  previousStamp: previousOwnerPilotCommandStamp,
                  previousRawDispatchStamp:
                    previousOwnerPilotCommandRawDispatchStamp,
                  previousAnchorStamp: previousOwnerPilotCommandAnchorStamp,
                  emittedStamp: recordedOwnerMovementStamp,
                  currentRawDispatchStamp,
                  nextAnchorStamp: refreshOwnerCommandAnchor
                    ? liveOwnerSessionStamp
                    : previousOwnerPilotCommandAnchorStamp,
                });
                ownerSession._space.lastPilotCommandMovementStamp =
                  ownerCommandLaneWrite.stamp;
                ownerSession._space.lastPilotCommandMovementRawDispatchStamp =
                  ownerCommandLaneWrite.rawDispatchStamp;
                ownerSession._space.lastPilotCommandMovementAnchorStamp =
                  ownerCommandLaneWrite.anchorStamp;
                if (ownerCommandLaneWrite.accepted) {
                  ownerSession._space.lastPilotCommandDirection =
                    emittedOwnerGotoDirection
                      ? cloneVector(emittedOwnerGotoDirection)
                      : null;
                }
              }
              updateDestinyAuthorityState(ownerSession, {
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
                          ? emittedOwnerGotoDirection
                            ? serializeDestinyDirectionHeading(
                                emittedOwnerGotoDirection,
                              )
                            : ""
                          : (
                            ownerAuthorityState &&
                            ownerAuthorityState.lastOwnerCommandHeadingHash
                          ) || "",
                    }
                  : {}),
              });
            }
            delivered = true;
          }
        }
        for (const session of runtime.sessions.values()) {
          if (
            sessionMatchesIdentity(session, ownerSession || pending.excludedSession) ||
            (
              suppressedSessions instanceof Set &&
              suppressedSessions.has(session)
            ) ||
            !isReadyForDestiny(session)
          ) {
            continue;
          }
          const filteredUpdates = runtime.filterMovementUpdatesForSession(
            session,
            updates,
          );
          if (filteredUpdates.length === 0) {
            continue;
          }
          const queuedUpdates = clampQueuedSubwarpUpdatesForSession(
            session,
            filteredUpdates,
            {
              isObserverVisibleContract:
                toInt(session._space && session._space.shipID, 0) !==
                toInt(pending && pending.entityID, 0),
            },
          );
          if (runtime.hasActiveTickDestinyPresentationBatch()) {
            runtime.queueTickDestinyPresentationUpdates(session, queuedUpdates, {
              sendOptions: {
                destinyAuthorityContract:
                  DESTINY_CONTRACTS.CRITICAL_MOVEMENT_OR_SHIPPRIME,
                translateStamps: false,
              },
            });
          } else {
            runtime.sendDestinyUpdates(
              session,
              queuedUpdates,
              false,
              {
                destinyAuthorityContract:
                  DESTINY_CONTRACTS.CRITICAL_MOVEMENT_OR_SHIPPRIME,
                translateStamps: false,
              },
            );
          }
          delivered = true;
        }
        if (!delivered && entity) {
          // Fresh-acquire protected movement can be filtered for a few scene
          // beats even though the server already committed the new mode. Keep
          // the queued contract alive until at least one observer can legally
          // receive it instead of dropping the first pursuit order forever.
          deferredPendingContracts.set(entity.itemID, pending);
        }
      }

      runtime.pendingSubwarpMovementContracts.clear();
      for (const [entityID, pending] of deferredPendingContracts.entries()) {
        runtime.pendingSubwarpMovementContracts.set(entityID, pending);
      }
    },
  };
}

module.exports = {
  createMovementContractDispatch,
};
