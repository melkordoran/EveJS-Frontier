const path = require("path");

const log = require(path.join(__dirname, "../../../utils/logger"));
const config = require(path.join(__dirname, "../../../config"));
const deadspaceWarpPolicy = require(path.join(
  __dirname,
  "../../../services/dungeon/deadspaceWarpPolicy.js",
));
const {
  isFrontierProfile,
} = require("../../../services/ship/destinyCompatibility.js");
const {
  DESTINY_CONTRACTS,
} = require("../authority/destinyContracts.js");
const {
  hasDestinyStamp,
  normalizeDestinyStamp,
  selectFurthestDestinyStamp,
} = require("../delivery/stamps");
const {
  entityIDsEqual,
  normalizePersistentEntityID,
} = require("../identity/entityID");
const {
  isNativeWarpDistanceTooShort,
} = require("../simulation/warp");
const SAME_WARP_DESTINATION_TOLERANCE_METERS = 1;

function vectorsNearlyEqual(left, right, tolerance = SAME_WARP_DESTINATION_TOLERANCE_METERS) {
  if (!left || !right || typeof left !== "object" || typeof right !== "object") {
    return false;
  }
  return (
    Math.abs(Number(left.x || 0) - Number(right.x || 0)) <= tolerance &&
    Math.abs(Number(left.y || 0) - Number(right.y || 0)) <= tolerance &&
    Math.abs(Number(left.z || 0) - Number(right.z || 0)) <= tolerance
  );
}

function getActiveWarpRawDestination(entity) {
  if (!entity || typeof entity !== "object") {
    return null;
  }
  if (entity.pendingWarp && entity.pendingWarp.rawDestination) {
    return entity.pendingWarp.rawDestination;
  }
  if (
    entity.mode === "WARP" &&
    entity.warpState &&
    entity.warpState.rawDestination
  ) {
    return entity.warpState.rawDestination;
  }
  return null;
}

function getActiveWarpDestinationStaticInstanceID(entity) {
  return normalizePersistentEntityID(
    entity && entity.pendingWarp
      ? entity.pendingWarp.destinationStaticInstanceID
      : entity && entity.warpState
        ? entity.warpState.destinationStaticInstanceID
        : null,
  );
}

function getRawWarpCommandDistance(entity, point) {
  const position = entity && entity.position ? entity.position : {};
  const destination = point && typeof point === "object" ? point : {};
  const delta = ["x", "y", "z"].map((axis) => {
    const left = Number(position[axis]);
    const right = Number(destination[axis]);
    return Number.isFinite(left) && Number.isFinite(right) ? right - left : 0;
  });
  return Math.hypot(...delta);
}

function getActiveWarpDestinationDungeonRoomKey(entity) {
  return String(
    entity && entity.pendingWarp
      ? entity.pendingWarp.destinationDungeonRoomKey || ""
      : entity && entity.warpState
        ? entity.warpState.destinationDungeonRoomKey || ""
        : "",
  ).trim() || null;
}

function getActiveWarpDestinationDungeonSiteID(entity) {
  return normalizePersistentEntityID(
    entity && entity.pendingWarp
      ? entity.pendingWarp.destinationDungeonSiteID
      : entity && entity.warpState
        ? entity.warpState.destinationDungeonSiteID
        : null,
  );
}

function destinationInstanceIDsEqual(left, right) {
  return left === null
    ? right === null
    : right !== null && entityIDsEqual(left, right);
}

function isRedundantWarpToPoint(
  entity,
  point,
  destinationStaticInstanceID,
  destinationDungeonRoomKey = null,
  destinationDungeonSiteID = null,
) {
  return (
    vectorsNearlyEqual(getActiveWarpRawDestination(entity), point) &&
    destinationInstanceIDsEqual(
      getActiveWarpDestinationStaticInstanceID(entity),
      destinationStaticInstanceID,
    ) &&
    getActiveWarpDestinationDungeonRoomKey(entity) === (
      String(destinationDungeonRoomKey || "").trim() || null
    ) &&
    destinationInstanceIDsEqual(
      getActiveWarpDestinationDungeonSiteID(entity),
      normalizePersistentEntityID(destinationDungeonSiteID),
    )
  );
}

function resolveCommandDestinationStaticInstanceID(
  runtime,
  session,
  options = {},
) {
  const hasRequestedRoomKey = Object.prototype.hasOwnProperty.call(
    options,
    "destinationDungeonRoomKey",
  );
  const hasRequestedSiteID = Object.prototype.hasOwnProperty.call(
    options,
    "destinationDungeonSiteID",
  );
  if (!Object.prototype.hasOwnProperty.call(
    options,
    "destinationStaticInstanceID",
  )) {
    if (hasRequestedRoomKey || hasRequestedSiteID) {
      return {
        success: false,
        errorMsg: "DUNGEON_INSTANCE_NOT_AUTHORIZED",
      };
    }
    return {
      success: true,
      instanceID: null,
      roomKey: null,
      siteID: null,
    };
  }
  const requestedInstanceID = normalizePersistentEntityID(
    options.destinationStaticInstanceID,
  );
  const hasContextResolver = typeof runtime
    .resolveAuthorizedDestinationDungeonContext === "function";
  const hasInstanceResolver = typeof runtime
    .resolveAuthorizedDestinationStaticInstanceID === "function";
  if (
    requestedInstanceID === null ||
    (!hasContextResolver && !hasInstanceResolver)
  ) {
    return {
      success: false,
      errorMsg: "DUNGEON_INSTANCE_NOT_AUTHORIZED",
    };
  }
  let authorizedInstanceID = null;
  let roomKey = null;
  let siteID = null;
  if (hasContextResolver) {
    const context = runtime.resolveAuthorizedDestinationDungeonContext(
      session,
      requestedInstanceID,
      {
        ...(hasRequestedRoomKey
          ? { roomKey: options.destinationDungeonRoomKey }
          : {}),
        ...(hasRequestedSiteID
          ? { siteID: options.destinationDungeonSiteID }
          : {}),
      },
    );
    authorizedInstanceID = normalizePersistentEntityID(
      context && context.instanceID,
    );
    roomKey = String(context && context.roomKey || "").trim() || null;
    siteID = normalizePersistentEntityID(context && context.siteID);
  } else if (!hasRequestedRoomKey && !hasRequestedSiteID) {
    authorizedInstanceID = normalizePersistentEntityID(
      runtime.resolveAuthorizedDestinationStaticInstanceID(
        session,
        requestedInstanceID,
      ),
    );
  }
  if (
    authorizedInstanceID === null ||
    !entityIDsEqual(authorizedInstanceID, requestedInstanceID)
  ) {
    return {
      success: false,
      errorMsg: "DUNGEON_INSTANCE_NOT_AUTHORIZED",
    };
  }
  return {
    success: true,
    instanceID: authorizedInstanceID,
    roomKey,
    siteID,
  };
}

// Fails closed. A `typeof` guard here would skip the cloak rule silently when
// the scene lacks the method, letting a standard cloak carry a ship into warp
// with no error anywhere — the same silent-skip that let a stale fake scene pass
// wormholeParity while the assertion it was supposed to make never ran. A scene
// that cannot answer this is a broken build, so say so instead of guessing.
function isWarpBlockedByCloak(runtime, entity) {
  if (typeof runtime.isEntityWarpBlockedByCloak !== "function") {
    throw new Error(
      "Scene is missing isEntityWarpBlockedByCloak, so the cloak/warp rule cannot be enforced.",
    );
  }
  return runtime.isEntityWarpBlockedByCloak(entity);
}

function createMovementWarpCommands(deps = {}) {
  const {
    activatePendingWarp,
    armMovementTrace,
    buildDirectedMovementUpdates,
    buildOfficialWarpReferenceProfile,
    buildPendingWarpRequest,
    buildPreparingWarpState,
    buildSessionlessWarpIngressState,
    buildWarpPrepareDispatch,
    buildWarpStartUpdates,
    clearTrackingState,
    cloneVector,
    deactivateWarpUnsafeActiveModulesForWarpStart,
    getClientParityWarpInPoint,
    getStargateWarpLandingPoint,
    getStationWarpTargetPosition,
    getTargetMotionPosition,
    getWatcherWarpStartStamp,
    getWarpStopDistanceForTarget,
    gotoPointEntity,
    findActiveWarpDisruptorForEntity,
    hasPendingPilotWarpLanding = () => false,
    isReadyForDestiny,
    logMovementDebug,
    logWarpDebug,
    normalizeVector,
    prewarmStartupControllersForWarpDestination,
    primePilotWarpActivationState,
    persistShipEntity,
    resolveStargateWarpTarget,
    subtractVectors,
    summarizePendingWarp,
    tagUpdatesRequireExistingVisibility,
    toFiniteNumber = (value, fallback = 0) => {
      const numeric = Number(value);
      return Number.isFinite(numeric) ? numeric : fallback;
    },
    toInt,
    DESTINY_STAMP_INTERVAL_MS,
    MIN_WARP_DISTANCE_METERS,
    PILOT_WARP_ACTIVATION_DELAY_DESTINY_TICKS,
    MICHELLE_POST_HELD_FUTURE_DESTINY_LEAD,
  } = deps;
  const serviceMinimumWarpDistanceMeters = Math.max(
    0,
    toFiniteNumber(MIN_WARP_DISTANCE_METERS, 150_000),
  );

  function routeNativeGotoFallback(
    runtime,
    entity,
    pendingWarp,
    now,
    options = {},
  ) {
    if (
      !entity ||
      !pendingWarp ||
      String(pendingWarp.nativeWarpCommand || "").trim().toUpperCase() !== "GOTO" ||
      typeof gotoPointEntity !== "function"
    ) {
      return {
        success: false,
        errorMsg: "NATIVE_GOTO_FALLBACK_UNAVAILABLE",
      };
    }
    entity.sessionlessWarpIngress = null;
    if (Object.hasOwn(entity, "deferNpcWarpCompletionWakeUntilMs")) {
      entity.deferNpcWarpCompletionWakeUntilMs = 0;
    }
    entity.visibilitySuppressedUntilMs = 0;
    entity.suppressWarpAcquireUntilNextTick = false;
    if (
      entity.session &&
      typeof runtime.clearPilotWarpVisibilityHandoff === "function"
    ) {
      runtime.clearPilotWarpVisibilityHandoff(entity.session);
    }
    const routed = gotoPointEntity(
      runtime,
      entity,
      pendingWarp.rawDestination,
      {
        ...options,
        nowMs: now,
        commandSource: "nativeWarpFallback",
      },
    );
    if (routed !== true) {
      return {
        success: false,
        errorMsg: "NATIVE_GOTO_FALLBACK_FAILED",
      };
    }
    logMovementDebug("warp.native-goto", entity, {
      pendingWarp: summarizePendingWarp(pendingWarp),
    });
    if (typeof runtime.requestFinalSceneVisibilityReconciliation === "function") {
      runtime.requestFinalSceneVisibilityReconciliation();
    }
    return {
      success: true,
      data: pendingWarp,
      nativeGotoFallback: true,
    };
  }

  return {
    warpToEntity(runtime, session, targetEntityID, options = {}) {
      const entity = runtime.getShipEntityForSession(session);
      const target = runtime.getEntityByID(targetEntityID);
      const landingPending = Boolean(
        entity && hasPendingPilotWarpLanding(session, entity),
      );
      if (!entity || !target || landingPending) {
        return {
          success: false,
          errorMsg: landingPending ? "WARP_LANDING_PENDING" : "TARGET_NOT_FOUND",
        };
      }

      const targetInstanceID = normalizePersistentEntityID(
        target.dungeonSiteInstanceID ??
        target.airNpeInstanceID ??
        (target.kind === "ship" ? target.dungeonCurrentInstanceID : null),
      );
      if (targetInstanceID !== null) {
        const destinationResolution = resolveCommandDestinationStaticInstanceID(
          runtime,
          session,
          options,
        );
        if (
          destinationResolution.success !== true ||
          destinationResolution.instanceID === null ||
          !entityIDsEqual(destinationResolution.instanceID, targetInstanceID)
        ) {
          return {
            success: false,
            errorMsg: "DUNGEON_INSTANCE_NOT_AUTHORIZED",
          };
        }
      }
      if (
        typeof runtime.canSessionSeeDungeonScopedEntity === "function" &&
        !runtime.canSessionSeeDungeonScopedEntity(session, target, {
          ...(targetInstanceID !== null
            ? {
                dedicatedSiteStaticInstanceIDOverride:
                  targetInstanceID,
              }
            : {}),
        })
      ) {
        return {
          success: false,
          errorMsg: "TARGET_NOT_FOUND",
        };
      }

      if (target.kind === "stargate") {
        const stargateWarpTarget =
          typeof resolveStargateWarpTarget === "function"
            ? resolveStargateWarpTarget(
                entity,
                target,
                toFiniteNumber(options.minimumRange, 0),
              )
            : {
                rawDestination: getStargateWarpLandingPoint(
                  entity,
                  target,
                  toFiniteNumber(options.minimumRange, 0),
                ),
                stopDistance: 0,
              };
        return runtime.warpToPoint(
          session,
          stargateWarpTarget.rawDestination,
          {
            ...options,
            stopDistance: Math.max(
              0,
              toFiniteNumber(stargateWarpTarget.stopDistance, 0),
            ),
            targetEntityID: target.itemID,
          },
        );
      }

      const clientParityWarpInPoint =
        typeof getClientParityWarpInPoint === "function"
          ? getClientParityWarpInPoint(target)
          : null;
      if (clientParityWarpInPoint) {
        return runtime.warpToPoint(session, clientParityWarpInPoint, {
          ...options,
          stopDistance: Math.max(0, toFiniteNumber(options.minimumRange, 0)),
          targetEntityID: target.itemID,
        });
      }

      const stopDistance = getWarpStopDistanceForTarget(
        entity,
        target,
        toFiniteNumber(options.minimumRange, 0),
      );
      const warpTargetPoint =
        target && (target.kind === "station" || target.kind === "structure")
          ? getStationWarpTargetPosition(target, {
              shipTypeID: entity.typeID,
              selectionKey: entity.itemID,
            })
          : getTargetMotionPosition(target);
      return runtime.warpToPoint(session, warpTargetPoint, {
        ...options,
        stopDistance,
        targetEntityID: target.itemID,
      });
    },

    warpToPoint(runtime, session, point, options = {}) {
      const entity = runtime.getShipEntityForSession(session);
      const landingPending = Boolean(
        entity && hasPendingPilotWarpLanding(session, entity),
      );
      if (
        !entity ||
        entity.pendingDock ||
        landingPending
      ) {
        return {
          success: false,
          errorMsg: landingPending
            ? "WARP_LANDING_PENDING"
            : "SHIP_NOT_FOUND",
        };
      }

      // A standard cloaking device holds the ship out of warp: the pilot must
      // decloak first. Warp-safe (covert ops) cloaks carry the ship into warp
      // and so never block the command.
      if (isWarpBlockedByCloak(runtime, entity)) {
        return {
          success: false,
          errorMsg: "WARP_BLOCKED_BY_CLOAK",
        };
      }

      const destinationResolution = resolveCommandDestinationStaticInstanceID(
        runtime,
        session,
        options,
      );
      if (destinationResolution.success !== true) {
        return destinationResolution;
      }
      const destinationStaticInstanceID = destinationResolution.instanceID;

      // Native WarpTo classifies the raw command distance before its
      // same-destination no-op. Keep that ordering distinct from the later
      // post-stop-distance 150 km service policy.
      const rawCommandUsesNativeGoto = isNativeWarpDistanceTooShort(
        getRawWarpCommandDistance(entity, point),
      );

      if (!rawCommandUsesNativeGoto && isRedundantWarpToPoint(
        entity,
        point,
        destinationStaticInstanceID,
        destinationResolution.roomKey,
        destinationResolution.siteID,
      )) {
        logMovementDebug("warp.requested.redundant", entity);
        return {
          success: true,
          data: entity.pendingWarp || entity.warpState || null,
          redundant: true,
        };
      }

      // Deadspace (mission-pocket) warp restriction: gates are the only way between rooms, and
      // you cannot warp within a complex. Gate transit warps pass options.dungeonGateTransit.
      let warpPoint = point;
      if (
        config.deadspaceWarpRestrictionEnabled !== false &&
        options.dungeonGateTransit !== true &&
        options.ignoreDeadspaceWarpRestriction !== true
      ) {
        try {
          const decision = deadspaceWarpPolicy.evaluateDeadspaceWarp(entity, point, options);
          if (decision && decision.action === "block") {
            logMovementDebug("warp.requested.deadspace-blocked", entity);
            return { success: false, errorMsg: decision.errorMsg || "DunCannotWarpWithinComplex" };
          }
          if (decision && decision.action === "clamp" && decision.point) {
            logMovementDebug("warp.requested.deadspace-clamped", entity);
            warpPoint = decision.point;
          }
        } catch (error) {
          log.warn(`[SpaceRuntime] Deadspace warp check failed: ${error.message}`);
        }
      }

      if (options.ignoreCrimewatchCheck !== true) {
        try {
          const crimewatchState = require(path.join(
            __dirname,
            "../../../services/security/crimewatchState",
          ));
          const crimewatchNow =
            session &&
            session._space &&
            Number.isFinite(Number(session._space.simTimeMs))
              ? Number(session._space.simTimeMs)
              : runtime.getCurrentSimTimeMs();
          if (
            crimewatchState &&
            crimewatchState.isCriminallyFlagged(
              session && session.characterID,
              crimewatchNow,
            )
          ) {
            return {
              success: false,
              errorMsg: "CRIMINAL_TIMER_ACTIVE",
            };
          }
        } catch (error) {
          log.warn(`[SpaceRuntime] Crimewatch warp check failed: ${error.message}`);
        }
      }

      const pendingWarp = buildPendingWarpRequest(entity, warpPoint, {
        ...options,
        destinationDungeonRoomKey: destinationResolution.roomKey,
        destinationDungeonSiteID: destinationResolution.siteID,
        destinationStaticInstanceID,
        nowMs: runtime.getCurrentSimTimeMs(),
        warpSpeedAU: options.warpSpeedAU || entity.warpSpeedAU,
      });
      if (pendingWarp && rawCommandUsesNativeGoto) {
        pendingWarp.nativeWarpCommand = "GOTO";
      }
      if (
        !pendingWarp ||
        pendingWarp.totalDistance < serviceMinimumWarpDistanceMeters
      ) {
        return {
          success: false,
          errorMsg: "WARP_DISTANCE_TOO_CLOSE",
        };
      }

      if (
        options.ignoreWarpDisruptionField !== true &&
        typeof findActiveWarpDisruptorForEntity === "function"
      ) {
        const disruptor = findActiveWarpDisruptorForEntity(runtime, entity, {
          session,
          nowMs: runtime.getCurrentSimTimeMs(),
        });
        if (disruptor) {
          return {
            success: false,
            errorMsg: "WARP_DISRUPTED_BY_BUBBLE",
            data: disruptor,
          };
        }
      }

      // A standard cloaking device holds the ship out of warp: the pilot must
      // decloak first. Warp-safe (covert ops) cloaks carry the ship into warp
      // and so never block the command.
      if (isWarpBlockedByCloak(runtime, entity)) {
        return {
          success: false,
          errorMsg: "WARP_BLOCKED_BY_CLOAK",
        };
      }

      const now = runtime.getCurrentSimTimeMs();
      if (typeof runtime.cancelStargateJumpCloakBeforePilotCommand === "function") {
        runtime.cancelStargateJumpCloakBeforePilotCommand(session, "warp", {
          nowMs: now,
        });
      } else if (typeof runtime.cancelStargateJumpCloak === "function") {
        runtime.cancelStargateJumpCloak(session, "warp", {
          nowMs: now,
        });
      }
      if (pendingWarp.nativeWarpCommand === "GOTO") {
        return routeNativeGotoFallback(
          runtime,
          entity,
          pendingWarp,
          now,
          options,
        );
      }
      const movementStamp = runtime.getMovementStamp(now);
      const previousSpeedFraction = entity.speedFraction;
      const pilotPrepareStamp =
        session && isReadyForDestiny(session)
          ? runtime.getHistorySafeDestinyStamp(
              now,
              PILOT_WARP_ACTIVATION_DELAY_DESTINY_TICKS,
              PILOT_WARP_ACTIVATION_DELAY_DESTINY_TICKS,
            )
          : movementStamp;
      pendingWarp.prepareStamp = pilotPrepareStamp;
      pendingWarp.prepareVisibleStamp =
        session && isReadyForDestiny(session)
          ? runtime.getHistorySafeSessionDestinyStamp(
              session,
              now,
              PILOT_WARP_ACTIVATION_DELAY_DESTINY_TICKS,
              PILOT_WARP_ACTIVATION_DELAY_DESTINY_TICKS,
            )
          : pilotPrepareStamp;
      clearTrackingState(entity);
      entity.pendingWarp = pendingWarp;
      entity.mode = "WARP";
      entity.speedFraction = 1;
      // Deliberately leave entity.direction untouched: while the warp is
      // pending, advanceGotoMovement steers the entity toward targetPoint at
      // its real angular rate, and evaluatePendingWarp gates warp start on
      // genuine alignment. Snapping the heading here pre-satisfied the gate
      // and made warp entry look instant.
      const alignDirection = normalizeVector(
        subtractVectors(pendingWarp.rawDestination, entity.position),
        entity.direction,
      );
      entity.targetPoint = cloneVector(pendingWarp.rawDestination);
      entity.targetEntityID = pendingWarp.targetEntityID || null;
      entity.warpState = buildPreparingWarpState(entity, pendingWarp, {
        nowMs: now,
      });
      persistShipEntity(entity);
      armMovementTrace(entity, "warp", {
        pendingWarp: summarizePendingWarp(pendingWarp),
      }, now);
      logMovementDebug("warp.requested", entity);
      logWarpDebug("warp.requested", entity, {
        officialProfile: buildOfficialWarpReferenceProfile(
          pendingWarp.totalDistance,
          pendingWarp.warpSpeedAU,
          entity.maxVelocity,
        ),
      });
      if (session) {
        runtime.clearPendingSubwarpMovementContract(entity);
        const prewarmTargetEntity =
          pendingWarp.targetEntityID
            ? runtime.getEntityByID(pendingWarp.targetEntityID)
            : null;
        const prewarmResult = prewarmStartupControllersForWarpDestination(runtime, {
          excludedSession: session,
          nowMs: now,
          relevantEntities: prewarmTargetEntity ? [prewarmTargetEntity] : [],
          relevantPositions: [
            pendingWarp.targetPoint,
            pendingWarp.rawDestination,
          ].filter(Boolean),
        });
        if (!prewarmResult.success) {
          log.warn(
            `[SpaceRuntime] Warp destination prewarm failed for system=${runtime.systemID} ship=${entity.itemID}: ${prewarmResult.errorMsg || "UNKNOWN_ERROR"}`,
          );
        }
      }

      const usesFrontierNativeWarpActivation = isFrontierProfile(
        session && session.compatibilityProfile,
      );
      pendingWarp.usesFrontierNativeWarpActivation =
        usesFrontierNativeWarpActivation;
      if (session) {
        // Physical align first: the pilot receives the same GotoDirection
        // command watchers get, so the client DLL rotates and accelerates the
        // ship itself. The native WarpTo prepare bundle is deferred to the
        // align-ready gate in the scene tick (see the pendingWarp start path
        // in runtime.js), where it is re-authored on fresh history-safe
        // stamps. The DLL then enters WarpState=1 already aligned and
        // transitions to the tunnel on its own.
        pendingWarp.pilotPrepareDeferred = isReadyForDestiny(session) === true;
        const speedFractionChanged =
          Math.abs(entity.speedFraction - previousSpeedFraction) > 0.000001;
        if (pendingWarp.pilotPrepareDeferred) {
          runtime.sendDestinyUpdates(
            session,
            buildDirectedMovementUpdates(
              entity,
              alignDirection,
              speedFractionChanged,
              pilotPrepareStamp,
            ),
            false,
            {
              destinyAuthorityContract:
                DESTINY_CONTRACTS.CRITICAL_MOVEMENT_OR_SHIPPRIME,
              minimumLeadFromCurrentHistory: PILOT_WARP_ACTIVATION_DELAY_DESTINY_TICKS,
              maximumLeadFromCurrentHistory: PILOT_WARP_ACTIVATION_DELAY_DESTINY_TICKS,
            },
          );
        }
        const observerAlignStamp = selectFurthestDestinyStamp(
          movementStamp,
          [movementStamp, pilotPrepareStamp],
        );
        const alignUpdates = tagUpdatesRequireExistingVisibility(
          buildDirectedMovementUpdates(
            entity,
            alignDirection,
            speedFractionChanged,
            observerAlignStamp,
          ),
        );
        if (alignUpdates.length > 0) {
          runtime.broadcastMovementUpdates(alignUpdates, session, {
            minimumLeadFromCurrentHistory: MICHELLE_POST_HELD_FUTURE_DESTINY_LEAD,
            minimumSessionStamp: pendingWarp.prepareVisibleStamp,
          });
          runtime.scheduleWatcherMovementAnchor(entity, now, "warpAlign");
        }
      } else {
        const prepareDispatch = buildWarpPrepareDispatch(
          entity,
          pilotPrepareStamp,
          entity.warpState,
          {
            includePilotActivationVelocity: usesFrontierNativeWarpActivation,
          },
        );
        runtime.broadcastMovementUpdates(prepareDispatch.sharedUpdates);
      }
      return {
        success: true,
        data: pendingWarp,
      };
    },

    warpDynamicEntityToPoint(runtime, entityOrID, point, options = {}) {
      const entity =
        typeof entityOrID === "object" && entityOrID !== null
          ? entityOrID
          : runtime.getEntityByID(entityOrID);
      const landingPending = Boolean(
        entity && entity.session &&
        hasPendingPilotWarpLanding(entity.session, entity),
      );
      if (
        !entity ||
        (entity.kind !== "ship" && entity.kind !== "fighter") ||
        entity.pendingDock ||
        landingPending
      ) {
        return {
          success: false,
          errorMsg: landingPending
            ? "WARP_LANDING_PENDING"
            : "SHIP_NOT_FOUND",
        };
      }

      const now = runtime.getCurrentSimTimeMs();
      const destinationResolution = resolveCommandDestinationStaticInstanceID(
        runtime,
        options.session || entity.session || null,
        options,
      );
      if (destinationResolution.success !== true) {
        return destinationResolution;
      }
      const destinationStaticInstanceID = destinationResolution.instanceID;
      const rawCommandUsesNativeGoto = isNativeWarpDistanceTooShort(
        getRawWarpCommandDistance(entity, point),
      );
      if (!rawCommandUsesNativeGoto && isRedundantWarpToPoint(
        entity,
        point,
        destinationStaticInstanceID,
        destinationResolution.roomKey,
        destinationResolution.siteID,
      )) {
        logMovementDebug("warp.requested.sessionless.redundant", entity);
        return {
          success: true,
          data: entity.pendingWarp || entity.warpState || null,
          redundant: true,
        };
      }
      const pendingWarp = buildPendingWarpRequest(entity, point, {
        ...options,
        destinationDungeonRoomKey: destinationResolution.roomKey,
        destinationDungeonSiteID: destinationResolution.siteID,
        destinationStaticInstanceID,
        nowMs: now,
        warpSpeedAU: options.warpSpeedAU || entity.warpSpeedAU,
      });
      if (
        !pendingWarp ||
        pendingWarp.totalDistance < serviceMinimumWarpDistanceMeters
      ) {
        return {
          success: false,
          errorMsg: "WARP_DISTANCE_TOO_CLOSE",
        };
      }

      if (
        options.ignoreWarpDisruptionField !== true &&
        typeof findActiveWarpDisruptorForEntity === "function"
      ) {
        const disruptor = findActiveWarpDisruptorForEntity(runtime, entity, {
          nowMs: runtime.getCurrentSimTimeMs(),
        });
        if (disruptor) {
          return {
            success: false,
            errorMsg: "WARP_DISRUPTED_BY_BUBBLE",
            data: disruptor,
          };
        }
      }

      if (pendingWarp.nativeWarpCommand === "GOTO") {
        return routeNativeGotoFallback(
          runtime,
          entity,
          pendingWarp,
          now,
          options,
        );
      }

      const desiredDirection = normalizeVector(
        subtractVectors(pendingWarp.rawDestination, entity.position),
        entity.direction,
      );
      clearTrackingState(entity);
      entity.pendingWarp = pendingWarp;
      entity.mode = "WARP";
      entity.speedFraction = 1;
      entity.direction = desiredDirection;
      entity.targetPoint = cloneVector(pendingWarp.rawDestination);
      entity.targetEntityID = pendingWarp.targetEntityID || null;
      if (options.forceImmediateStart === true) {
        entity.velocity = {
          x: desiredDirection.x * entity.maxVelocity,
          y: desiredDirection.y * entity.maxVelocity,
          z: desiredDirection.z * entity.maxVelocity,
        };
        pendingWarp.requestedAtMs = now - Math.max(
          1_000,
          (toFiniteNumber(entity.alignTime, 0) * 1000) + 500,
        );
      }
      entity.warpState = buildPreparingWarpState(entity, pendingWarp, {
        nowMs: now,
      });
      persistShipEntity(entity);
      armMovementTrace(entity, "warp", {
        pendingWarp: summarizePendingWarp(pendingWarp),
        forceImmediateStart: options.forceImmediateStart === true,
      }, now);
      logMovementDebug("warp.requested.sessionless", entity, {
        forceImmediateStart: options.forceImmediateStart === true,
      });
      logWarpDebug("warp.requested.sessionless", entity, {
        forceImmediateStart: options.forceImmediateStart === true,
        officialProfile: buildOfficialWarpReferenceProfile(
          pendingWarp.totalDistance,
          pendingWarp.warpSpeedAU,
          entity.maxVelocity,
        ),
      });

      const movementStamp = runtime.getMovementStamp(now);
      runtime.clearPendingSubwarpMovementContract(entity);
      pendingWarp.prepareStamp = movementStamp;
      const prepareDispatch = buildWarpPrepareDispatch(
        entity,
        movementStamp,
        entity.warpState,
      );
      runtime.broadcastMovementUpdates(prepareDispatch.sharedUpdates);
      return {
        success: true,
        data: pendingWarp,
      };
    },

    forceStartPendingWarp(runtime, entityOrID, options = {}) {
      const entity =
        typeof entityOrID === "object" && entityOrID !== null
          ? entityOrID
          : runtime.getEntityByID(entityOrID);
      if (
        !entity ||
        (entity.kind !== "ship" && entity.kind !== "fighter")
      ) {
        return {
          success: false,
          errorMsg: "SHIP_NOT_FOUND",
        };
      }
      if (
        entity.session &&
        hasPendingPilotWarpLanding(entity.session, entity)
      ) {
        return {
          success: false,
          errorMsg: "WARP_LANDING_PENDING",
        };
      }
      if (!entity.pendingWarp) {
        return {
          success: false,
          errorMsg: "WARP_NOT_PENDING",
        };
      }

      const now = toFiniteNumber(options.nowMs, runtime.getCurrentSimTimeMs());
      const pendingWarp = entity.pendingWarp;
      if (
        String(pendingWarp.nativeWarpCommand || "").trim().toUpperCase() ===
        "GOTO"
      ) {
        return routeNativeGotoFallback(
          runtime,
          entity,
          pendingWarp,
          now,
          options,
        );
      }
      if (entity.kind !== "ship") {
        return {
          success: false,
          errorMsg: "SHIP_NOT_FOUND",
        };
      }
      const currentStamp = runtime.getCurrentDestinyStamp(now);
      if (typeof deactivateWarpUnsafeActiveModulesForWarpStart === "function") {
        const deactivationResult = deactivateWarpUnsafeActiveModulesForWarpStart(
          runtime,
          entity,
          now,
          {
            reason: "warpStart",
          },
        );
        if (deactivationResult && deactivationResult.success === false) {
          return {
            success: false,
            errorMsg:
              deactivationResult.errorMsg ||
              "WARP_START_DEACTIVATION_FAILED",
            data: deactivationResult.data || null,
          };
        }
      }
      const warpState = activatePendingWarp(entity, pendingWarp, {
        nowMs: now,
        defaultEffectStamp: currentStamp,
      });
      if (!warpState) {
        return {
          success: false,
          errorMsg: "WARP_ACTIVATION_FAILED",
        };
      }
      const warpStartStamp =
        entity.session && isReadyForDestiny(entity.session)
          ? selectFurthestDestinyStamp(
              currentStamp,
              [currentStamp, pendingWarp && pendingWarp.prepareStamp],
            )
          : currentStamp;
      primePilotWarpActivationState(entity, warpState, warpStartStamp);

      if (options.clearVisibilitySuppression !== false) {
        entity.visibilitySuppressedUntilMs = 0;
        entity.suppressWarpAcquireUntilNextTick = false;
      }
      runtime.beginWarpDepartureOwnership(entity, now);
      runtime.beginPilotWarpVisibilityHandoff(entity, warpState, now);
      if (entity.session && isReadyForDestiny(entity.session)) {
        const watcherWarpStartStamp = getWatcherWarpStartStamp(
          warpState,
          pendingWarp,
          warpStartStamp,
        );
        const warpStartUpdates = buildWarpStartUpdates(
          entity,
          warpState,
          watcherWarpStartStamp,
          {
            includeEntityWarpIn: false,
          },
        );
        if (warpStartUpdates.length > 0) {
          runtime.broadcastMovementUpdates(
            warpStartUpdates,
            entity.session,
            {
              minimumSessionStamp: hasDestinyStamp(
                pendingWarp && pendingWarp.prepareVisibleStamp,
              )
                ? normalizeDestinyStamp(pendingWarp.prepareVisibleStamp)
                : undefined,
            },
          );
        }
      }
      persistShipEntity(entity);

      return {
        success: true,
        data: {
          entity,
          warpState,
        },
      };
    },

    sendSessionlessWarpStartToVisibleSessions(runtime, entity, updates) {
      if (
        !entity ||
        !Array.isArray(updates) ||
        updates.length === 0
      ) {
        return {
          deliveredCount: 0,
        };
      }

      let deliveredCount = 0;
      for (const session of runtime.sessions.values()) {
        if (!isReadyForDestiny(session) || !session._space) {
          continue;
        }
        if (
          !(session._space.visibleDynamicEntityIDs instanceof Set) ||
          !session._space.visibleDynamicEntityIDs.has(entity.itemID)
        ) {
          continue;
        }
        runtime.sendDestinyUpdates(session, updates, false, {
          destinyAuthorityContract:
            DESTINY_CONTRACTS.CRITICAL_MOVEMENT_OR_SHIPPRIME,
        });
        deliveredCount += 1;
      }

      return {
        deliveredCount,
      };
    },

    startSessionlessWarpIngress(runtime, entityOrID, point, options = {}) {
      const entity =
        typeof entityOrID === "object" && entityOrID !== null
          ? entityOrID
          : runtime.getEntityByID(entityOrID);
      if (!entity || entity.kind !== "ship") {
        return {
          success: false,
          errorMsg: "SHIP_NOT_FOUND",
        };
      }

      const now = toFiniteNumber(options.nowMs, runtime.getCurrentSimTimeMs());
      const warpResult = runtime.warpDynamicEntityToPoint(entity, point, options);
      if (!warpResult.success) {
        return warpResult;
      }
      if (warpResult.nativeGotoFallback === true) {
        return warpResult;
      }
      if (entity.session) {
        return warpResult;
      }
      if (warpResult.redundant === true) {
        const existingIngress = entity.sessionlessWarpIngress;
        return {
          success: true,
          redundant: true,
          data: {
            entity,
            pendingWarp: entity.pendingWarp || null,
            warpState: entity.warpState || null,
            ingressCompleteAtMs:
              existingIngress &&
              Number.isFinite(Number(existingIngress.completeAtMs))
                ? Number(existingIngress.completeAtMs)
                : now,
            acquireResult: null,
          },
        };
      }

      const activationResult = runtime.forceStartPendingWarp(entity, {
        nowMs: now,
        clearVisibilitySuppression: false,
      });
      if (!activationResult.success) {
        return activationResult;
      }
      const visibilitySuppressMs = Math.max(
        1,
        toFiniteNumber(options.visibilitySuppressMs, DESTINY_STAMP_INTERVAL_MS),
      );
      entity.suppressWarpAcquireUntilNextTick = true;
      entity.visibilitySuppressedUntilMs = Math.max(
        toFiniteNumber(entity.visibilitySuppressedUntilMs, 0),
        now + visibilitySuppressMs,
      );
      entity.sessionlessWarpIngress = buildSessionlessWarpIngressState(
        entity,
        activationResult.data && activationResult.data.warpState,
        {
          nowMs: now,
          durationMs: options.ingressDurationMs,
          useNativeWarpProfile: options.useNativeWarpProfile === true,
          suppressCompletionStopUpdates:
            options.suppressCompletionStopUpdates === true,
        },
      );

      if (options.broadcastWarpStartToVisibleSessions === true) {
        const warpStartStamp = runtime.getNextDestinyStamp(now);
        const warpStartUpdates = buildWarpStartUpdates(
          entity,
          activationResult.data && activationResult.data.warpState,
          warpStartStamp,
          {
            includeEntityWarpIn: false,
          },
        );
        runtime.sendSessionlessWarpStartToVisibleSessions(
          entity,
          warpStartUpdates,
        );
      }

      const requested = runtime.requestFinalSceneVisibilityReconciliation();
      const acquireResult = options.acquireForRelevantSessions === true
        ? {
            deferredToFinalSceneTick: requested === true,
            deliveredEntityCount: 0,
            deliveredSessionCount: 0,
          }
        : null;

      return {
        success: true,
        data: {
          entity,
          pendingWarp: warpResult.data,
          warpState: activationResult.data && activationResult.data.warpState,
          ingressCompleteAtMs:
            entity.sessionlessWarpIngress &&
            Number.isFinite(Number(entity.sessionlessWarpIngress.completeAtMs))
              ? Number(entity.sessionlessWarpIngress.completeAtMs)
              : now,
          acquireResult,
        },
      };
    },
  };
}

module.exports = {
  createMovementWarpCommands,
};
