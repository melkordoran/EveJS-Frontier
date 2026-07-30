"use strict";

const {
  normalizeDestinyStamp,
  resolveOptionalDestinyStamp,
} = require("../delivery/stamps");
const {
  toJSONSafeEntityID,
} = require("../identity/entityID");
const {
  clonePilotWarpMaxSpeedRamp,
} = require("./warpRamp");

const DEFAULT_WARP_ACCEL_EXPONENT = 5;
const DEFAULT_WARP_DECEL_EXPONENT = 5;
const INVALID_RUNTIME_PERSISTENT_IDENTITY = "invalid-persistent-identity";

function toFiniteNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    return Math.trunc(numeric);
  }
  const fallbackNumeric = Number(fallback);
  return Number.isFinite(fallbackNumeric) ? Math.trunc(fallbackNumeric) : 0;
}

function cloneVector(source = null, fallback = { x: 0, y: 0, z: 0 }) {
  return {
    x: toFiniteNumber(source && source.x, fallback.x),
    y: toFiniteNumber(source && source.y, fallback.y),
    z: toFiniteNumber(source && source.z, fallback.z),
  };
}

function hasPersistentIdentityValue(value) {
  return value !== null && value !== undefined && String(value).trim() !== "";
}

function serializeRuntimePersistentIdentity(entity, key) {
  const value = toJSONSafeEntityID(entity && entity[key]);
  if (value !== null) {
    return value;
  }
  return entity && hasPersistentIdentityValue(entity[key])
    ? INVALID_RUNTIME_PERSISTENT_IDENTITY
    : null;
}

function resolveWarpEffectDestinyStamp(value) {
  const numeric = Number(value);
  if (Number.isInteger(numeric) && numeric < 0) {
    return -1;
  }
  return normalizeDestinyStamp(value, 0);
}

function resolveSerializedWarpSpeedAU(value) {
  const requested = toFiniteNumber(value, 0);
  const roundedFactor = Math.round(requested * 1000);
  return Number.isFinite(roundedFactor) && roundedFactor > 0
    ? Math.max(1, roundedFactor) / 1000
    : 3;
}

function resolveSerializedNativeWarpCommand(value) {
  const command = String(value || "").trim().toUpperCase();
  return command === "WARP" || command === "GOTO" ? command : null;
}

function serializeWarpState(entity) {
  if (!entity.warpState) {
    return null;
  }

  return {
    startTimeMs: toFiniteNumber(entity.warpState.startTimeMs, Date.now()),
    // Pilot-timeline anchors for mid-warp pilot-perceived position reconstruction.
    warpRequestedAtMs: toFiniteNumber(entity.warpState.warpRequestedAtMs, 0),
    pilotPrepareVisibleStamp: toInt(entity.warpState.pilotPrepareVisibleStamp, 0),
    durationMs: toFiniteNumber(entity.warpState.durationMs, 0),
    accelTimeMs: toFiniteNumber(entity.warpState.accelTimeMs, 0),
    cruiseTimeMs: toFiniteNumber(entity.warpState.cruiseTimeMs, 0),
    decelTimeMs: toFiniteNumber(entity.warpState.decelTimeMs, 0),
    totalDistance: toFiniteNumber(entity.warpState.totalDistance, 0),
    stopDistance: toFiniteNumber(entity.warpState.stopDistance, 0),
    maxWarpSpeedMs: toFiniteNumber(entity.warpState.maxWarpSpeedMs, 0),
    cruiseWarpSpeedMs: toFiniteNumber(entity.warpState.cruiseWarpSpeedMs, 0),
    warpFloorSpeedMs: toFiniteNumber(entity.warpState.warpFloorSpeedMs, 0),
    warpDropoutSpeedMs: toFiniteNumber(
      entity.warpState.warpDropoutSpeedMs,
      toFiniteNumber(entity.warpState.warpFloorSpeedMs, 0),
    ),
    accelDistance: toFiniteNumber(entity.warpState.accelDistance, 0),
    cruiseDistance: toFiniteNumber(entity.warpState.cruiseDistance, 0),
    decelDistance: toFiniteNumber(entity.warpState.decelDistance, 0),
    accelExponent: toFiniteNumber(
      entity.warpState.accelExponent,
      DEFAULT_WARP_ACCEL_EXPONENT,
    ),
    decelExponent: toFiniteNumber(
      entity.warpState.decelExponent,
      DEFAULT_WARP_DECEL_EXPONENT,
    ),
    accelRate: toFiniteNumber(
      entity.warpState.accelRate,
      toFiniteNumber(
        entity.warpState.accelExponent,
        DEFAULT_WARP_ACCEL_EXPONENT,
      ),
    ),
    decelRate: toFiniteNumber(
      entity.warpState.decelRate,
      toFiniteNumber(
        entity.warpState.decelExponent,
        DEFAULT_WARP_DECEL_EXPONENT,
      ),
    ),
    // A persisted zero crashes the client mid-warp through integer division.
    warpSpeed: toInt(entity.warpState.warpSpeed, 0) > 0
      ? toInt(entity.warpState.warpSpeed, 3000)
      : 3000,
    commandStamp: normalizeDestinyStamp(entity.warpState.commandStamp, 0),
    startupGuidanceAtMs: toFiniteNumber(entity.warpState.startupGuidanceAtMs, 0),
    startupGuidanceStamp: resolveOptionalDestinyStamp(
      entity.warpState.startupGuidanceStamp,
    ),
    startupGuidanceVelocity: cloneVector(
      entity.warpState.startupGuidanceVelocity,
      { x: 0, y: 0, z: 0 },
    ),
    cruiseBumpAtMs: toFiniteNumber(entity.warpState.cruiseBumpAtMs, 0),
    cruiseBumpStamp: resolveOptionalDestinyStamp(
      entity.warpState.cruiseBumpStamp,
    ),
    effectAtMs: toFiniteNumber(entity.warpState.effectAtMs, 0),
    effectStamp: resolveWarpEffectDestinyStamp(entity.warpState.effectStamp),
    targetEntityID: toInt(entity.warpState.targetEntityID, 0),
    destinationStaticInstanceID: serializeRuntimePersistentIdentity(
      entity.warpState,
      "destinationStaticInstanceID",
    ),
    destinationDungeonRoomKey:
      String(entity.warpState.destinationDungeonRoomKey || "").trim() || null,
    destinationDungeonSiteID: serializeRuntimePersistentIdentity(
      entity.warpState,
      "destinationDungeonSiteID",
    ),
    followID: toInt(entity.warpState.followID, 0),
    followRangeMarker: toFiniteNumber(
      entity.warpState.followRangeMarker,
      entity.warpState.stopDistance,
    ),
    profileType: String(entity.warpState.profileType || "legacy"),
    origin: cloneVector(entity.warpState.origin, entity.position),
    rawDestination: cloneVector(entity.warpState.rawDestination, entity.position),
    targetPoint: cloneVector(entity.warpState.targetPoint, entity.position),
    pilotMaxSpeedRamp: clonePilotWarpMaxSpeedRamp(
      entity.warpState.pilotMaxSpeedRamp,
    ),
  };
}

function serializePendingWarp(pendingWarp) {
  if (!pendingWarp) {
    return null;
  }

  const nativeWarpCommand = resolveSerializedNativeWarpCommand(
    pendingWarp.nativeWarpCommand,
  );
  return {
    requestedAtMs: toInt(pendingWarp.requestedAtMs, 0),
    preWarpSyncStamp: resolveOptionalDestinyStamp(
      pendingWarp.preWarpSyncStamp,
    ),
    prepareStamp: resolveOptionalDestinyStamp(pendingWarp.prepareStamp),
    prepareVisibleStamp: resolveOptionalDestinyStamp(
      pendingWarp.prepareVisibleStamp,
    ),
    stopDistance: toFiniteNumber(pendingWarp.stopDistance, 0),
    totalDistance: toFiniteNumber(pendingWarp.totalDistance, 0),
    // The client divides by this value during activation; never serialize zero.
    warpSpeedAU: resolveSerializedWarpSpeedAU(pendingWarp.warpSpeedAU),
    rawDestination: cloneVector(pendingWarp.rawDestination),
    targetPoint: cloneVector(pendingWarp.targetPoint),
    ...(nativeWarpCommand ? { nativeWarpCommand } : {}),
    targetEntityID: toInt(pendingWarp.targetEntityID, 0),
    destinationStaticInstanceID: serializeRuntimePersistentIdentity(
      pendingWarp,
      "destinationStaticInstanceID",
    ),
    destinationDungeonRoomKey:
      String(pendingWarp.destinationDungeonRoomKey || "").trim() || null,
    destinationDungeonSiteID: serializeRuntimePersistentIdentity(
      pendingWarp,
      "destinationDungeonSiteID",
    ),
  };
}

const warpSerializationExports = {
  serializePendingWarp,
  serializeWarpState,
};

// Runtime hydration uses the same sentinel law without widening John's public
// enumerable serialization contract.
Object.defineProperty(
  warpSerializationExports,
  "resolveWarpEffectDestinyStamp",
  {
    value: resolveWarpEffectDestinyStamp,
    enumerable: false,
  },
);

module.exports = warpSerializationExports;
