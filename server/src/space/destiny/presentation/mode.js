"use strict";

const {
  normalizeEntityID,
} = require("../identity/entityID");
const {
  normalizeDestinyStamp,
} = require("../delivery/stamps");
const {
  buildNonEnablingMassDemotionAction,
  buildOnDockingAcceptedPayload,
  buildOnSpecialFXPayload,
  buildSetBallFreePayload,
  buildSetBallPositionPayload,
  buildSetBallVelocityPayload,
  buildSetSpeedFractionPayload,
  buildStopPayload,
} = require("../stream/actions");

const DEFAULT_STRUCTURE_DOCKING_CLOAK_EFFECT_GUID = "effects.Cloak";
const DEFAULT_STRUCTURE_DOCKING_TETHER_EFFECT_GUID = "effects.Tethering";

function resolveModeStamp(options = {}) {
  if (options.stampOverride !== null && options.stampOverride !== undefined) {
    return normalizeDestinyStamp(options.stampOverride, 0);
  }
  return normalizeDestinyStamp(
    typeof options.getNextDestinyStamp === "function"
      ? options.getNextDestinyStamp()
      : 0,
    0,
  );
}

function hasUsableModeTarget(value) {
  const normalizedTargetID = normalizeEntityID(value);
  return normalizedTargetID !== null && normalizedTargetID !== 0;
}

function defaultMagnitude(vector) {
  const x = Number(vector && vector.x) || 0;
  const y = Number(vector && vector.y) || 0;
  const z = Number(vector && vector.z) || 0;
  return Math.sqrt((x ** 2) + (y ** 2) + (z ** 2));
}

function buildTeleportStopPresentationUpdates(entity, stampOverride = 0) {
  if (!entity) {
    return [];
  }

  const stamp = normalizeDestinyStamp(stampOverride, 0);
  return [
    {
      stamp,
      payload: buildSetSpeedFractionPayload(entity.itemID, 0),
    },
    {
      stamp,
      payload: buildSetBallPositionPayload(entity.itemID, entity.position),
    },
    {
      stamp,
      payload: buildStopPayload(entity.itemID),
    },
    {
      stamp,
      payload: buildSetBallVelocityPayload(entity.itemID, entity.velocity),
    },
  ];
}

function buildOrdinaryDockingStopPresentationUpdates(
  entity,
  stampOverride = 0,
) {
  if (!entity) {
    return [];
  }

  const stamp = normalizeDestinyStamp(stampOverride, 0);
  return [
    {
      stamp,
      payload: buildSetSpeedFractionPayload(entity.itemID, 0),
    },
    {
      stamp,
      payload: buildStopPayload(entity.itemID),
    },
    {
      stamp,
      payload: buildSetBallVelocityPayload(entity.itemID, entity.velocity),
    },
  ];
}

function buildStructureDockingTransitionUpdates(
  entity,
  stampOverride = 0,
  options = {},
) {
  if (!entity) {
    return [];
  }

  const stamp = normalizeDestinyStamp(stampOverride, 0);
  const cloakEffectGuid =
    options.cloakEffectGuid || DEFAULT_STRUCTURE_DOCKING_CLOAK_EFFECT_GUID;
  const tetherEffectGuid =
    options.tetherEffectGuid || DEFAULT_STRUCTURE_DOCKING_TETHER_EFFECT_GUID;
  const tetherEffectOptions = options.tetherEffectOptions || {};
  return [
    {
      stamp,
      payload: buildOnSpecialFXPayload(entity.itemID, cloakEffectGuid, {
        start: true,
        active: false,
      }),
    },
    {
      stamp,
      payload: buildOnSpecialFXPayload(
        entity.itemID,
        tetherEffectGuid,
        tetherEffectOptions,
      ),
    },
    {
      stamp,
      // This is the frozen non-enabling demotion. Callers cannot promote a
      // ball or supply general massive-state policy through this planner.
      payload: buildNonEnablingMassDemotionAction(entity.itemID),
    },
    {
      stamp,
      payload: buildStopPayload(entity.itemID),
    },
  ];
}

function buildDockingAcceptedNotificationPayload(
  shipPosition,
  stationPosition,
  stationID,
) {
  return buildOnDockingAcceptedPayload(
    shipPosition,
    stationPosition,
    stationID,
  );
}

function buildSetBallFreePresentationUpdates(
  entityID,
  isFree,
  stampOverride = 0,
) {
  const stamp = normalizeDestinyStamp(stampOverride, 0);
  return [{
    stamp,
    payload: buildSetBallFreePayload(entityID, isFree),
  }];
}

function buildModePresentationUpdates(options = {}) {
  const entity = options.entity;
  if (!entity) {
    return [];
  }

  const destiny = options.destiny;
  if (!destiny || typeof destiny !== "object") {
    throw new TypeError("mode presentation requires Destiny payload builders");
  }

  const toInt =
    typeof options.toInt === "function"
      ? options.toInt
      : (value, fallback = 0) => {
          const numeric = Number(value);
          return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
        };
  const magnitude =
    typeof options.magnitude === "function"
      ? options.magnitude
      : defaultMagnitude;
  const getCommandDirection =
    typeof options.getCommandDirection === "function"
      ? options.getCommandDirection
      : () => entity.direction;
  const modeStamp = resolveModeStamp(options);
  const updates = [];

  switch (entity.mode) {
    case "GOTO":
      updates.push({
        stamp: modeStamp,
        payload: destiny.buildGotoDirectionPayload(
          entity.itemID,
          getCommandDirection(entity, entity.direction),
        ),
      });
      break;
    case "FOLLOW":
      // A persisted/transitional entity can briefly retain FOLLOW after its
      // target disappears. Never manufacture a FollowBall against ball zero.
      if (hasUsableModeTarget(entity.targetEntityID)) {
        updates.push({
          stamp: modeStamp,
          payload: destiny.buildFollowBallPayload(
            entity.itemID,
            entity.targetEntityID,
            entity.followRange,
          ),
        });
      }
      break;
    case "ORBIT":
      if (hasUsableModeTarget(entity.targetEntityID)) {
        updates.push({
          stamp: modeStamp,
          payload: destiny.buildOrbitPayload(
            entity.itemID,
            entity.targetEntityID,
            entity.orbitDistance,
          ),
        });
      }
      break;
    case "WARP":
      if (entity.warpState) {
        if (
          entity.pendingWarp &&
          toInt(entity.warpState.effectStamp, 0) < 0 &&
          typeof options.buildWarpPrepareCommandUpdate === "function"
        ) {
          const prepareUpdate = options.buildWarpPrepareCommandUpdate(
            entity,
            modeStamp,
            entity.warpState,
          );
          if (prepareUpdate) {
            updates.push(prepareUpdate);
          }
        } else {
          const buildWarpAcquireUpdates = entity.session
            ? options.buildPlayerWarpInFlightAcquireUpdates
            : options.buildSessionlessWarpInFlightAcquireUpdates;
          if (typeof buildWarpAcquireUpdates === "function") {
            const warpUpdates = buildWarpAcquireUpdates(
              entity,
              entity.warpState,
              modeStamp,
            );
            if (Array.isArray(warpUpdates)) {
              updates.push(...warpUpdates);
            }
          }
        }
      }
      break;
    default:
      break;
  }

  if (entity.mode !== "WARP" && entity.speedFraction > 0) {
    updates.push({
      stamp: modeStamp,
      payload: destiny.buildSetSpeedFractionPayload(
        entity.itemID,
        entity.speedFraction,
      ),
    });
  }
  if (entity.mode !== "WARP" && magnitude(entity.velocity) > 0) {
    updates.push({
      stamp: modeStamp,
      payload: destiny.buildSetBallVelocityPayload(
        entity.itemID,
        entity.velocity,
      ),
    });
  }

  return updates;
}

module.exports = {
  buildDockingAcceptedNotificationPayload,
  buildModePresentationUpdates,
  buildOrdinaryDockingStopPresentationUpdates,
  buildSetBallFreePresentationUpdates,
  buildStructureDockingTransitionUpdates,
  buildTeleportStopPresentationUpdates,
};
