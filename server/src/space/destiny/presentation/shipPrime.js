"use strict";

const {
  buildGotoDirectionPayload,
  buildNonEnablingMassDemotionAction,
  buildOnSpecialFXPayload,
  buildSetBallAgilityPayload,
  buildSetBallAngularAgilityPayload,
  buildSetBallMassPayload,
  buildSetBallPositionPayload,
  buildSetBallVelocityPayload,
  buildSetMaxSpeedPayload,
  buildSetMaxAngularSpeedPayload,
} = require("../stream/actions");
const {
  normalizeDestinyStamp,
} = require("../delivery/stamps");
const {
  getEntityIDText,
} = require("../identity/entityID");
const {
  normalizeVector,
} = require("../stream/primitives");

const UNDOCK_BOOTSTRAP_EFFECT_GUID = "effects.Uncloak";
const UNDOCK_BOOTSTRAP_EFFECT_DURATION_MS = 6000;

const SHIP_PRIME_PAYLOAD_NAMES = new Set([
  "SetBallAgility",
  "SetBallAngularAgility",
  "SetBallMass",
  "SetMaxAngularSpeed",
  "SetMaxSpeed",
]);

function toFiniteNumber(value, fallback = 0) {
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    return numeric;
  }
  const fallbackNumeric = Number(fallback);
  return Number.isFinite(fallbackNumeric) ? fallbackNumeric : 0;
}

function valuesDiffer(left, right, epsilon = 1e-9) {
  return Math.abs(
    toFiniteNumber(left, 0) - toFiniteNumber(right, 0),
  ) > epsilon;
}

function getVectorMagnitude(vector) {
  const x = toFiniteNumber(vector && vector.x, 0);
  const y = toFiniteNumber(vector && vector.y, 0);
  const z = toFiniteNumber(vector && vector.z, 0);
  return Math.sqrt((x ** 2) + (y ** 2) + (z ** 2));
}

function getUndockCommandDirection(entity) {
  const fallback = entity && entity.direction;
  if (entity && entity.targetPoint && entity.position) {
    return normalizeVector({
      x:
        toFiniteNumber(entity.targetPoint.x, 0) -
        toFiniteNumber(entity.position.x, 0),
      y:
        toFiniteNumber(entity.targetPoint.y, 0) -
        toFiniteNumber(entity.position.y, 0),
      z:
        toFiniteNumber(entity.targetPoint.z, 0) -
        toFiniteNumber(entity.position.z, 0),
    }, fallback);
  }
  return normalizeVector(fallback);
}

function buildUndockBootstrapMovementUpdates(
  entity,
  stampOverride = 0,
) {
  if (!entity || entity.kind !== "ship") {
    return [];
  }

  const stamp = normalizeDestinyStamp(stampOverride, 0);
  const updates = [
    {
      stamp,
      payload: buildOnSpecialFXPayload(
        entity.itemID,
        UNDOCK_BOOTSTRAP_EFFECT_GUID,
        {
          start: true,
          active: false,
          duration: UNDOCK_BOOTSTRAP_EFFECT_DURATION_MS,
        },
      ),
    },
    {
      stamp,
      payload: buildSetBallPositionPayload(entity.itemID, entity.position),
    },
    {
      stamp,
      // Exact bootstrap demotion only; no caller-controlled massive state.
      payload: buildNonEnablingMassDemotionAction(entity.itemID),
    },
    {
      stamp,
      payload: buildSetBallMassPayload(entity.itemID, entity.mass),
    },
  ];
  if (getVectorMagnitude(entity.velocity) > 0) {
    updates.push({
      stamp,
      payload: buildSetBallVelocityPayload(entity.itemID, entity.velocity),
    });
  }
  updates.push({
    stamp,
    payload: buildGotoDirectionPayload(
      entity.itemID,
      getUndockCommandDirection(entity),
    ),
  });
  return updates;
}

function buildShipPrimeUpdates(entity, stampOverride = 0) {
  if (!entity || entity.kind !== "ship") {
    return [];
  }

  const stamp = normalizeDestinyStamp(stampOverride, 0);
  const updates = [
    {
      stamp,
      payload: buildSetBallAgilityPayload(entity.itemID, entity.inertia),
    },
    {
      stamp,
      payload: buildSetBallMassPayload(entity.itemID, entity.mass),
    },
    {
      stamp,
      payload: buildSetMaxSpeedPayload(entity.itemID, entity.maxVelocity),
    },
  ];
  if (toFiniteNumber(entity.maxAngularSpeed, 0) > 0) {
    updates.push({
      stamp,
      payload: buildSetMaxAngularSpeedPayload(
        entity.itemID,
        entity.maxAngularSpeed,
      ),
    });
  }
  if (toFiniteNumber(entity.angularAgility, 0) > 0) {
    updates.push({
      stamp,
      payload: buildSetBallAngularAgilityPayload(
        entity.itemID,
        entity.angularAgility,
      ),
    });
  }
  return updates;
}

// Bootstrap and fresh acquisition need the complete physical triad. Live
// Dogma recomputation is a delta contract: repeating unchanged setters makes
// Michelle rebase the same local ship simulation without changing truth.
function buildShipPrimeDeltaUpdates(
  entity,
  previousState = {},
  stampOverride = 0,
) {
  if (!entity || entity.kind !== "ship") {
    return [];
  }

  const stamp = normalizeDestinyStamp(stampOverride, 0);
  const updates = [];
  if (valuesDiffer(entity.inertia, previousState.inertia)) {
    updates.push({
      stamp,
      payload: buildSetBallAgilityPayload(entity.itemID, entity.inertia),
    });
  }
  if (valuesDiffer(entity.mass, previousState.mass)) {
    updates.push({
      stamp,
      payload: buildSetBallMassPayload(entity.itemID, entity.mass),
    });
  }
  if (valuesDiffer(entity.maxVelocity, previousState.maxVelocity)) {
    updates.push({
      stamp,
      payload: buildSetMaxSpeedPayload(entity.itemID, entity.maxVelocity),
    });
  }
  if (valuesDiffer(entity.maxAngularSpeed, previousState.maxAngularSpeed)) {
    updates.push({
      stamp,
      payload: buildSetMaxAngularSpeedPayload(
        entity.itemID,
        entity.maxAngularSpeed,
      ),
    });
  }
  if (valuesDiffer(entity.angularAgility, previousState.angularAgility)) {
    updates.push({
      stamp,
      payload: buildSetBallAngularAgilityPayload(
        entity.itemID,
        entity.angularAgility,
      ),
    });
  }
  return updates;
}

function buildShipPrimeUpdatesForEntities(entities, stampOverride = 0) {
  const updates = [];
  for (const entity of Array.isArray(entities) ? entities : []) {
    updates.push(...buildShipPrimeUpdates(entity, stampOverride));
  }
  return updates;
}

function getShipPrimeUpdateDedupeKey(update) {
  const payload = update && Array.isArray(update.payload)
    ? update.payload
    : null;
  if (
    !payload ||
    !SHIP_PRIME_PAYLOAD_NAMES.has(payload[0]) ||
    !Array.isArray(payload[1])
  ) {
    return null;
  }
  const entityIDText = getEntityIDText(payload[1][0]);
  return entityIDText === null
    ? null
    : `ship-prime:${entityIDText}:${payload[0]}`;
}

module.exports = {
  buildShipPrimeDeltaUpdates,
  buildShipPrimeUpdates,
  buildShipPrimeUpdatesForEntities,
  buildUndockBootstrapMovementUpdates,
  getShipPrimeUpdateDedupeKey,
};
