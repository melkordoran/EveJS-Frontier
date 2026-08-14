"use strict";

const KNOWN_PAYLOAD_NAMES = Object.freeze([
  "AddBall",
  "AddBalls2",
  "BallNotGlobal",
  "CloakBall",
  "EntityWarpIn",
  "FollowBall",
  "GotoDirection",
  "GotoPoint",
  "LaunchMissile",
  "OnDamageStateChange",
  "OnDbuffUpdated",
  "OnSlimItemChange",
  "OnSpecialFX",
  "Orbit",
  "PackagedAction",
  "RemoveBall",
  "RemoveBalls",
  "RemoveGlobalBall",
  "SetBallAgility",
  "SetBallAngularAgility",
  "SetBallAngularVelocity",
  "SetBallFree",
  "SetBallHarmonic",
  "SetBallInteractive",
  "SetBallMass",
  "SetBallMassive",
  "SetBallPosition",
  "SetBallRadius",
  "SetBallRotation",
  "SetBallTroll",
  "SetBallVelocity",
  "SetBallWarpFactors",
  "SetMaxAngularSpeed",
  "SetMaxAngularVelocity",
  "SetMaxSpeed",
  "SetPitch",
  "SetSpeedFraction",
  "SetState",
  "SetStrafingThrust",
  "SetYawRate",
  "Stop",
  "TerminalPlayDestructionEffect",
  "UncloakBall",
  "WarpTo",
]);

// The target ticker calls the incremental stream action AddBallsToPark while
// the live Michelle-facing implementation calls the equivalent payload
// AddBalls2. Canonicalization is inspection-only and never rewrites a tuple.
const PAYLOAD_NAME_ALIASES = Object.freeze({
  AddBallsToPark: "AddBalls2",
});

const MOVEMENT_CONTRACT_PAYLOAD_NAMES = Object.freeze([
  "GotoDirection",
  "GotoPoint",
  "LaunchMissile",
  "FollowBall",
  "Orbit",
  "SetPitch",
  "Stop",
  "SetSpeedFraction",
  "SetStrafingThrust",
  "SetYawRate",
  "SetBallVelocity",
]);

const STEERING_PAYLOAD_NAMES = Object.freeze([
  "GotoDirection",
  "GotoPoint",
  "FollowBall",
  "Orbit",
]);

const PAYLOAD_ARGUMENT_COUNTS = Object.freeze({
  AddBall: 17,
  AddBalls2: 1,
  BallNotGlobal: 1,
  CloakBall: 3,
  EntityWarpIn: 5,
  FollowBall: 3,
  GotoDirection: 4,
  GotoPoint: 4,
  LaunchMissile: 5,
  OnDamageStateChange: 2,
  OnDbuffUpdated: 2,
  OnSlimItemChange: 2,
  OnSpecialFX: 14,
  Orbit: 3,
  PackagedAction: null,
  RemoveBall: 1,
  RemoveBalls: 1,
  RemoveGlobalBall: 1,
  SetBallAgility: 2,
  SetBallAngularAgility: 2,
  SetBallAngularVelocity: 4,
  SetBallFree: 2,
  SetBallHarmonic: 5,
  SetBallInteractive: 2,
  SetBallMass: 2,
  SetBallMassive: 2,
  SetBallPosition: 4,
  SetBallRadius: 2,
  SetBallRotation: 5,
  SetBallTroll: 2,
  SetBallVelocity: 4,
  SetBallWarpFactors: 3,
  SetMaxAngularSpeed: 2,
  SetMaxAngularVelocity: 4,
  SetMaxSpeed: 2,
  SetPitch: 2,
  SetSpeedFraction: 2,
  SetState: 1,
  SetStrafingThrust: 4,
  SetYawRate: 2,
  Stop: 1,
  TerminalPlayDestructionEffect: 2,
  UncloakBall: 1,
  WarpTo: 6,
});

const knownPayloadNames = new Set(KNOWN_PAYLOAD_NAMES);
const movementContractPayloadNames = new Set(MOVEMENT_CONTRACT_PAYLOAD_NAMES);
const steeringPayloadNames = new Set(STEERING_PAYLOAD_NAMES);

function getPayloadName(payload) {
  if (!Array.isArray(payload)) {
    return null;
  }
  try {
    return typeof payload[0] === "string" ? payload[0] : null;
  } catch (_error) {
    return null;
  }
}

function canonicalizePayloadName(name) {
  if (typeof name !== "string") {
    return null;
  }
  return Object.prototype.hasOwnProperty.call(PAYLOAD_NAME_ALIASES, name)
    ? PAYLOAD_NAME_ALIASES[name]
    : name;
}

function getCanonicalPayloadName(payload) {
  const name = getPayloadName(payload);
  return name === null ? null : canonicalizePayloadName(name);
}

function isKnownPayloadName(name) {
  const canonicalName = canonicalizePayloadName(name);
  return canonicalName !== null && knownPayloadNames.has(canonicalName);
}

function isDestinyPayload(payload) {
  const canonicalName = getCanonicalPayloadName(payload);
  if (canonicalName === null || !knownPayloadNames.has(canonicalName)) {
    return false;
  }

  try {
    if (payload.length !== 2) {
      return false;
    }
    const argumentCount = PAYLOAD_ARGUMENT_COUNTS[canonicalName];
    if (argumentCount === null) {
      return Buffer.isBuffer(payload[1]);
    }
    return Array.isArray(payload[1]) && payload[1].length === argumentCount;
  } catch (_error) {
    return false;
  }
}

function isPayloadNamed(payload, name) {
  const expectedName = canonicalizePayloadName(name);
  return (
    expectedName !== null &&
    isDestinyPayload(payload) &&
    getCanonicalPayloadName(payload) === expectedName
  );
}

function isMovementContractPayloadName(name) {
  const canonicalName = canonicalizePayloadName(name);
  return (
    canonicalName !== null &&
    movementContractPayloadNames.has(canonicalName)
  );
}

function isSteeringPayloadName(name) {
  const canonicalName = canonicalizePayloadName(name);
  return canonicalName !== null && steeringPayloadNames.has(canonicalName);
}

function isMovementContractPayload(payload) {
  return (
    isDestinyPayload(payload) &&
    isMovementContractPayloadName(getCanonicalPayloadName(payload))
  );
}

function updatesContainMovementContractPayload(updates) {
  if (!Array.isArray(updates)) {
    return false;
  }
  try {
    return updates.some((update) => (
      isMovementContractPayload(update && update.payload)
    ));
  } catch (_error) {
    return false;
  }
}

module.exports = {
  KNOWN_PAYLOAD_NAMES,
  MOVEMENT_CONTRACT_PAYLOAD_NAMES,
  PAYLOAD_ARGUMENT_COUNTS,
  PAYLOAD_NAME_ALIASES,
  STEERING_PAYLOAD_NAMES,
  canonicalizePayloadName,
  getCanonicalPayloadName,
  getPayloadName,
  isDestinyPayload,
  isKnownPayloadName,
  isMovementContractPayload,
  isMovementContractPayloadName,
  isPayloadNamed,
  isSteeringPayloadName,
  updatesContainMovementContractPayload,
};
