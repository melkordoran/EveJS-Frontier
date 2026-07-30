const destiny = require("../index.js");
const {
  DESTINY_STAMP_MAX_FORWARD_LEAD,
  hasDestinyStamp,
  normalizeDestinyStamp,
  selectFurthestDestinyStamp,
} = require("../delivery/stamps");

function resolveBoundedStopStamp(anchorStamp, candidateStamps, maximumLead) {
  const candidates = (
    Array.isArray(candidateStamps) ? candidateStamps : [candidateStamps]
  ).filter(hasDestinyStamp);
  const anchor = hasDestinyStamp(anchorStamp)
    ? normalizeDestinyStamp(anchorStamp)
    : candidates.length > 0
      ? normalizeDestinyStamp(candidates[0])
      : 0;
  const normalizedMaximumLead = Math.min(
    DESTINY_STAMP_MAX_FORWARD_LEAD,
    Math.max(0, Math.trunc(Number(maximumLead) || 0)),
  );
  return selectFurthestDestinyStamp(
    anchor,
    candidates,
    normalizedMaximumLead,
  );
}

function createMovementStopSpeedCommands(deps = {}) {
  const {
    addVectors,
    armMovementTrace,
    buildWarpCompletionUpdates,
    clamp,
    clearTrackingState,
    cloneVector,
    forgetNativeSubwarpEntity,
    logMovementDebug,
    magnitude,
    normalizeVector,
    persistShipEntity,
    roundNumber,
    scaleVector,
    subtractVectors,
    MICHELLE_HELD_FUTURE_DESTINY_LEAD,
    MAX_SUBWARP_SPEED_FRACTION,
  } = deps;

  return {
    setSpeedFraction(runtime, session, fraction) {
      const entity = runtime.getShipEntityForSession(session);
      if (!entity || entity.mode === "WARP" || entity.pendingDock) {
        return false;
      }

      const now = runtime.getCurrentSimTimeMs();
      const normalizedFraction = clamp(fraction, 0, MAX_SUBWARP_SPEED_FRACTION);
      if (normalizedFraction <= 0) {
        return runtime.stop(session);
      }

      entity.speedFraction = normalizedFraction;
      if (entity.speedFraction > 0 && entity.mode === "STOP") {
        entity.mode = "GOTO";
        entity.targetPoint = addVectors(
          cloneVector(entity.position),
          scaleVector(entity.direction, 1.0e16),
        );
      }
      persistShipEntity(entity);
      armMovementTrace(entity, "speed", {
        requestedSpeedFraction: roundNumber(normalizedFraction, 3),
      }, now);
      logMovementDebug("cmd.speed", entity);

      const stamp = runtime.getHistorySafeSessionDestinyStamp(
        session,
        now,
        1,
      );
      runtime.broadcastPilotCommandMovementUpdates(
        session,
        [
          {
            stamp,
            payload: destiny.buildSetSpeedFractionPayload(
              entity.itemID,
              entity.speedFraction,
            ),
          },
        ],
        now,
      );
      runtime.scheduleWatcherMovementAnchor(entity, now, "setSpeedFraction");

      return true;
    },

    stopShipEntity(runtime, entityOrID, options = {}) {
      const entity =
        typeof entityOrID === "object" && entityOrID !== null
          ? entityOrID
          : runtime.getEntityByID(entityOrID);
      if (!entity || entity.pendingDock) {
        return false;
      }

      if (entity.mode === "WARP" && entity.warpState && !entity.pendingWarp) {
        if (
          options.allowSessionlessWarpAbort === true &&
          entity.sessionlessWarpIngress
        ) {
          const now = runtime.getCurrentSimTimeMs();
          const arrivalPoint = cloneVector(
            entity.sessionlessWarpIngress.targetPoint,
            entity.warpState && entity.warpState.targetPoint,
          );
          entity.direction = normalizeVector(
            subtractVectors(arrivalPoint, entity.position),
            entity.direction,
          );
          entity.position = cloneVector(arrivalPoint, entity.position);
          entity.velocity = { x: 0, y: 0, z: 0 };
          entity.mode = "STOP";
          entity.speedFraction = 0;
          entity.targetPoint = cloneVector(entity.position);
          entity.warpState = null;
          entity.pendingWarp = null;
          entity.sessionlessWarpIngress = null;
          entity.visibilitySuppressedUntilMs = 0;
          entity.suppressWarpAcquireUntilNextTick = false;
          clearTrackingState(entity);
          if (typeof forgetNativeSubwarpEntity === "function") {
            forgetNativeSubwarpEntity(runtime, entity);
          }
          persistShipEntity(entity);
          armMovementTrace(entity, "warp_abort", {
            reason: String(options.reason || "sessionless_abort"),
          }, now);
          logMovementDebug("cmd.stop.sessionlessWarpAbort", entity, {
            reason: String(options.reason || "sessionless_abort"),
          });
          runtime.requestFinalSceneVisibilityReconciliation();
          const stamp = runtime.getMovementStamp(now);
          runtime.broadcastPilotCommandMovementUpdates(
            entity.session || null,
            buildWarpCompletionUpdates(entity, stamp),
            now,
          );
          runtime.scheduleWatcherMovementAnchor(
            entity,
            now,
            "stopSessionlessWarpAbort",
          );
          return true;
        }
        logMovementDebug("cmd.stop.ignored.activeWarp", entity);
        return false;
      }

      const now = runtime.getCurrentSimTimeMs();
      runtime.clearPendingSubwarpMovementContract(entity);
      const wasAlreadyStopped =
        entity.mode === "STOP" &&
        entity.speedFraction <= 0 &&
        magnitude(entity.velocity) < 0.1;
      entity.mode = "STOP";
      entity.speedFraction = 0;
      entity.targetPoint = cloneVector(entity.position);
      clearTrackingState(entity);
      persistShipEntity(entity);
      armMovementTrace(entity, "stop", {}, now);
      logMovementDebug("cmd.stop", entity);

      if (wasAlreadyStopped) {
        return true;
      }

      const superweaponStop = String(options.reason || "") === "superweapon";
      const historySafeStopStamp = superweaponStop
        ? runtime.getHistorySafeSessionDestinyStamp(
            entity.session || null,
            now,
            MICHELLE_HELD_FUTURE_DESTINY_LEAD,
            MICHELLE_HELD_FUTURE_DESTINY_LEAD,
          )
        : null;
      const currentStopStamp =
        entity.session &&
        typeof runtime.getCurrentSessionDestinyStamp === "function"
          ? runtime.getCurrentSessionDestinyStamp(entity.session, now)
          : typeof runtime.getCurrentDestinyStamp === "function"
            ? runtime.getCurrentDestinyStamp(now)
            : historySafeStopStamp;
      const presentedStopStamp =
        entity.session &&
        typeof runtime.getCurrentPresentedSessionDestinyStamp === "function"
          ? runtime.getCurrentPresentedSessionDestinyStamp(
              entity.session,
              now,
              MICHELLE_HELD_FUTURE_DESTINY_LEAD,
            )
          : null;
      const stamp = superweaponStop
        ? resolveBoundedStopStamp(
            currentStopStamp,
            [historySafeStopStamp, presentedStopStamp],
            MICHELLE_HELD_FUTURE_DESTINY_LEAD,
          )
        : runtime.getHistorySafeSessionDestinyStamp(
            entity.session || null,
            now,
            1,
          );
      // TQ's CmdStop packet for the citadel-undock golden path contains only
      // Stop(shipID); SetSpeedFraction(0) is a separate command family.
      const updates = [
        {
          stamp,
          payload: destiny.buildStopPayload(entity.itemID),
        },
      ];
      runtime.broadcastPilotCommandMovementUpdates(
        entity.session || null,
        updates,
        now,
        superweaponStop
          ? {
              ownerDirectEchoLeadOverride:
                MICHELLE_HELD_FUTURE_DESTINY_LEAD,
            }
          : {},
      );
      runtime.scheduleWatcherMovementAnchor(entity, now, "stop");

      return true;
    },

    stop(runtime, session) {
      const entity = runtime.getShipEntityForSession(session);
      return runtime.stopShipEntity(entity);
    },
  };
}

module.exports = {
  createMovementStopSpeedCommands,
};
