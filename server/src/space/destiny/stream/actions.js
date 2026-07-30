"use strict";

const {
  buildDict,
  buildKeyVal,
  buildList,
} = require("../../../services/_shared/serviceHelpers");
const {
  buildMarshalReal,
  buildMarshalRealVector,
  toFiniteNumber,
  toInt32,
} = require("./primitives");
const {
  requireEntityID,
} = require("../identity/entityID");

function normalizeActionEntityID(value, label = "entityID") {
  return requireEntityID(value, label);
}

function normalizeOptionalActionEntityID(value, label) {
  return value === undefined || value === null
    ? null
    : normalizeActionEntityID(value, label);
}

function buildGotoDirectionPayload(entityID, direction) {
  const vector = buildMarshalRealVector(direction);
  return ["GotoDirection", [normalizeActionEntityID(entityID), vector.x, vector.y, vector.z]];
}

function buildGotoPointPayload(entityID, point) {
  const vector = buildMarshalRealVector(point);
  return ["GotoPoint", [normalizeActionEntityID(entityID), vector.x, vector.y, vector.z]];
}

function buildFollowBallPayload(entityID, targetID, range) {
  return ["FollowBall", [
    normalizeActionEntityID(entityID),
    normalizeActionEntityID(targetID, "targetID"),
    toInt32(range, 0),
  ]];
}

function buildWarpToPayload(entityID, destination, distance, warpSpeed) {
  const vector = buildMarshalRealVector(destination);
  return [
    "WarpTo",
    [
      normalizeActionEntityID(entityID),
      vector.x,
      vector.y,
      vector.z,
      buildMarshalReal(distance, 0),
      toInt32(warpSpeed, 3000),
    ],
  ];
}

function buildAddBallPayload(
  entityID,
  {
    mass = 0,
    radius = 0,
    maxSpeed = 0,
    isFree = true,
    isGlobal = false,
    isMassive = false,
    isInteractive = true,
    isMoribund = false,
    position = null,
    velocity = null,
    inertia = 1,
    speedFraction = 0,
  } = {},
) {
  const positionVector = buildMarshalRealVector(position);
  const velocityVector = buildMarshalRealVector(velocity);
  return [
    "AddBall",
    [
      normalizeActionEntityID(entityID),
      buildMarshalReal(mass, 0),
      buildMarshalReal(radius, 0),
      buildMarshalReal(maxSpeed, 0),
      isFree ? 1 : 0,
      isGlobal ? 1 : 0,
      isMassive ? 1 : 0,
      isInteractive ? 1 : 0,
      isMoribund ? 1 : 0,
      positionVector.x,
      positionVector.y,
      positionVector.z,
      velocityVector.x,
      velocityVector.y,
      velocityVector.z,
      buildMarshalReal(inertia, 1),
      buildMarshalReal(speedFraction, 0),
    ],
  ];
}

function buildEntityWarpInPayload(entityID, destination, warpFactor) {
  const vector = buildMarshalRealVector(destination);
  return [
    "EntityWarpIn",
    [normalizeActionEntityID(entityID), vector.x, vector.y, vector.z, toInt32(warpFactor, 0)],
  ];
}

function buildOrbitPayload(entityID, orbitEntityID, distance) {
  return ["Orbit", [
    normalizeActionEntityID(entityID),
    normalizeActionEntityID(orbitEntityID, "orbitEntityID"),
    toInt32(distance, 0),
  ]];
}

function buildSetSpeedFractionPayload(entityID, fraction) {
  return ["SetSpeedFraction", [normalizeActionEntityID(entityID), buildMarshalReal(fraction, 0)]];
}

function buildStopPayload(entityID) {
  return ["Stop", [normalizeActionEntityID(entityID)]];
}

function buildSetBallVelocityPayload(entityID, velocity) {
  const vector = buildMarshalRealVector(velocity);
  return ["SetBallVelocity", [normalizeActionEntityID(entityID), vector.x, vector.y, vector.z]];
}

function buildSetBallPositionPayload(entityID, position) {
  const vector = buildMarshalRealVector(position);
  return ["SetBallPosition", [normalizeActionEntityID(entityID), vector.x, vector.y, vector.z]];
}

function buildSetBallAngularVelocityPayload(entityID, angularVelocity) {
  const vector = buildMarshalRealVector(angularVelocity);
  return ["SetBallAngularVelocity", [normalizeActionEntityID(entityID), vector.x, vector.y, vector.z]];
}

function buildSetMaxAngularVelocityPayload(entityID, maxAngularVelocity) {
  const vector = buildMarshalRealVector(maxAngularVelocity);
  return ["SetMaxAngularVelocity", [normalizeActionEntityID(entityID), vector.x, vector.y, vector.z]];
}

function buildSetBallRotationPayload(entityID, rotation) {
  const vector = {
    x: buildMarshalReal(rotation && rotation.x, 0),
    y: buildMarshalReal(rotation && rotation.y, 0),
    z: buildMarshalReal(rotation && rotation.z, 0),
    w: buildMarshalReal(rotation && rotation.w, 1),
  };
  return [
    "SetBallRotation",
    [normalizeActionEntityID(entityID), vector.x, vector.y, vector.z, vector.w],
  ];
}

function buildOnDockingAcceptedPayload(shipPosition, stationPosition, stationID) {
  return [normalizeActionEntityID(stationID, "stationID")];
}

function buildSetBallAgilityPayload(entityID, agility) {
  return ["SetBallAgility", [normalizeActionEntityID(entityID), buildMarshalReal(agility, 0)]];
}

function buildSetBallAngularAgilityPayload(entityID, angularAgility) {
  return ["SetBallAngularAgility", [normalizeActionEntityID(entityID), buildMarshalReal(angularAgility, 0)]];
}

function buildSetBallMassPayload(entityID, mass) {
  return ["SetBallMass", [normalizeActionEntityID(entityID), buildMarshalReal(mass, 0)]];
}

function buildSetMaxSpeedPayload(entityID, speed) {
  return ["SetMaxSpeed", [normalizeActionEntityID(entityID), buildMarshalReal(speed, 0)]];
}

function buildSetBallMassivePayload(entityID, isMassive) {
  return ["SetBallMassive", [normalizeActionEntityID(entityID), isMassive ? 1 : 0]];
}

function buildNonEnablingMassDemotionAction(entityID) {
  return buildSetBallMassivePayload(entityID, false);
}

function buildSetBallFreePayload(entityID, isFree = true) {
  return ["SetBallFree", [normalizeActionEntityID(entityID), isFree ? 1 : 0]];
}

function buildSetBallInteractivePayload(entityID, isInteractive) {
  return ["SetBallInteractive", [normalizeActionEntityID(entityID), isInteractive ? 1 : 0]];
}

function buildSetBallRadiusPayload(entityID, radius) {
  return ["SetBallRadius", [normalizeActionEntityID(entityID), buildMarshalReal(radius, 0)]];
}

function buildSetMaxAngularSpeedPayload(entityID, maxAngularSpeed) {
  return ["SetMaxAngularSpeed", [normalizeActionEntityID(entityID), buildMarshalReal(maxAngularSpeed, 0)]];
}

function buildSetBallTrollPayload(entityID, delayTicks) {
  return ["SetBallTroll", [normalizeActionEntityID(entityID), toInt32(delayTicks, 0)]];
}

function buildSetBallHarmonicPayload(
  entityID,
  harmonicValue,
  corporationID,
  allianceID,
  isForcefield,
) {
  return [
    "SetBallHarmonic",
    [
      normalizeActionEntityID(entityID),
      toInt32(harmonicValue, -1),
      toInt32(corporationID, -1),
      toInt32(allianceID, -1),
      isForcefield ? 1 : 0,
    ],
  ];
}

function buildCloakBallPayload(entityID, cloakMode, uncloakRange) {
  return [
    "CloakBall",
    [normalizeActionEntityID(entityID), toInt32(cloakMode, 1), buildMarshalReal(uncloakRange, 0)],
  ];
}

function buildUncloakBallPayload(entityID) {
  return ["UncloakBall", [normalizeActionEntityID(entityID)]];
}

// A live targeted missile is always activated as aimed and massive. The
// target-loss path does not use LaunchMissile; it materializes GOTO/FREE.
function buildLaunchMissilePayload(entityID, targetID, ownerID) {
  return [
    "LaunchMissile",
    [
      normalizeActionEntityID(entityID),
      normalizeActionEntityID(targetID, "targetID"),
      normalizeActionEntityID(ownerID, "ownerID"),
      1,
      1,
    ],
  ];
}

function buildBallNotGlobalPayload(bubbleID) {
  return ["BallNotGlobal", [toInt32(bubbleID, 0)]];
}

function buildRemoveGlobalBallPayload(entityID) {
  return ["RemoveGlobalBall", [normalizeActionEntityID(entityID)]];
}

function buildGraphicInfoDict(entries = []) {
  return buildDict(entries);
}

function normalizeGraphicInfo(graphicInfo) {
  if (graphicInfo === undefined) {
    return undefined;
  }
  if (
    graphicInfo === null ||
    (graphicInfo && typeof graphicInfo === "object" && graphicInfo.type)
  ) {
    return graphicInfo;
  }
  if (Array.isArray(graphicInfo)) {
    return buildList(graphicInfo);
  }
  if (graphicInfo && typeof graphicInfo === "object") {
    return buildKeyVal(Object.entries(graphicInfo));
  }
  return graphicInfo;
}

function buildOnSpecialFXPayload(
  entityID,
  guid,
  {
    moduleID = null,
    moduleTypeID = null,
    targetID = null,
    chargeTypeID = null,
    isOffensive = false,
    start = true,
    active = true,
    duration,
    repeat,
    startTime,
    timeFromStart,
    graphicInfo,
  } = {},
) {
  const args = [
    normalizeActionEntityID(entityID),
    normalizeOptionalActionEntityID(moduleID, "moduleID"),
    moduleTypeID,
    normalizeOptionalActionEntityID(targetID, "targetID"),
    chargeTypeID,
    String(guid || ""),
    isOffensive ? 1 : 0,
    start ? 1 : 0,
    active ? 1 : 0,
    duration === undefined ? -1 : toFiniteNumber(duration, -1),
    repeat === undefined ? null : repeat,
    startTime === undefined ? null : startTime,
    timeFromStart === undefined ? 0 : toFiniteNumber(timeFromStart, 0),
    graphicInfo === undefined ? null : normalizeGraphicInfo(graphicInfo),
  ];
  return ["OnSpecialFX", args];
}

function buildOnDamageStateChangePayload(entityID, damageState = null) {
  return ["OnDamageStateChange", [normalizeActionEntityID(entityID), damageState]];
}

function buildOnSlimItemChangePayload(entityID, slimItem = null) {
  return ["OnSlimItemChange", [normalizeActionEntityID(entityID), slimItem || null]];
}

function buildOnDbuffUpdatedPayload(entityID, dbuffState = []) {
  return [
    "OnDbuffUpdated",
    [
      normalizeActionEntityID(entityID),
      Array.isArray(dbuffState) ? buildList(dbuffState) : dbuffState,
    ],
  ];
}

function buildTerminalPlayDestructionEffectPayload(entityID, destructionEffectID) {
  return [
    "TerminalPlayDestructionEffect",
    [normalizeActionEntityID(entityID), toInt32(destructionEffectID, 0)],
  ];
}

function buildRemoveBallPayload(entityID) {
  return ["RemoveBall", [normalizeActionEntityID(entityID)]];
}

function buildRemoveBallsPayload(entityIDs) {
  return ["RemoveBalls", [buildList(
    entityIDs.map((entityID) => normalizeActionEntityID(entityID)),
  )]];
}

module.exports = {
  buildAddBallPayload,
  buildBallNotGlobalPayload,
  buildCloakBallPayload,
  buildEntityWarpInPayload,
  buildFollowBallPayload,
  buildGotoDirectionPayload,
  buildGotoPointPayload,
  buildGraphicInfoDict,
  buildLaunchMissilePayload,
  buildOnDamageStateChangePayload,
  buildOnDbuffUpdatedPayload,
  buildOnDockingAcceptedPayload,
  buildOnSlimItemChangePayload,
  buildOnSpecialFXPayload,
  buildOrbitPayload,
  buildRemoveBallPayload,
  buildRemoveBallsPayload,
  buildRemoveGlobalBallPayload,
  buildSetBallAgilityPayload,
  buildSetBallAngularAgilityPayload,
  buildSetBallAngularVelocityPayload,
  buildSetBallFreePayload,
  buildSetBallHarmonicPayload,
  buildSetBallInteractivePayload,
  buildSetBallMassPayload,
  buildSetBallMassivePayload,
  buildSetBallPositionPayload,
  buildSetBallRadiusPayload,
  buildSetBallRotationPayload,
  buildSetBallTrollPayload,
  buildSetBallVelocityPayload,
  buildSetMaxAngularSpeedPayload,
  buildSetMaxAngularVelocityPayload,
  buildSetMaxSpeedPayload,
  buildSetSpeedFractionPayload,
  buildStopPayload,
  buildTerminalPlayDestructionEffectPayload,
  buildUncloakBallPayload,
  buildWarpToPayload,
};

// Non-enumerable fixed-demotion direct leaf. This preserves the frozen public
// action/facade and payload-builder surfaces while presentation planners avoid
// a caller-controlled massive-state input.
Object.defineProperty(module.exports, "buildNonEnablingMassDemotionAction", {
  configurable: false,
  enumerable: false,
  value: buildNonEnablingMassDemotionAction,
  writable: false,
});
