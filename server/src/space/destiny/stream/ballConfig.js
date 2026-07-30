"use strict";

const { BALL_FLAG, BALL_MODE } = require("../constants");
const { toFiniteNumber, toInt32 } = require("./primitives");

function getEntityBallRadius(entity) {
  return toFiniteNumber(entity && entity.radius, 1);
}

function resolveDestinyPhysicalMass(entity, fallbackMass = 0) {
  const mass = entity && entity.mass;
  const fallback = toFiniteNumber(fallbackMass, 0);
  return mass === undefined || mass === null
    ? fallback
    : toFiniteNumber(mass, fallback);
}

function resolveConfiguredBallMode(entity, fallbackMode = BALL_MODE.STOP) {
  const resolveMode = (value, fallback) => {
    if (typeof value === "string") {
      const modeName = value.trim().toUpperCase();
      if (Object.prototype.hasOwnProperty.call(BALL_MODE, modeName)) {
        return BALL_MODE[modeName];
      }
    }
    return toInt32(value, fallback);
  };
  const requestedFallback = resolveMode(fallbackMode, BALL_MODE.STOP);
  const fallback = (
    requestedFallback >= BALL_MODE.GOTO &&
    requestedFallback <= BALL_MODE.FORMATION
  )
    ? requestedFallback
    : BALL_MODE.STOP;
  if (
    !entity ||
    typeof entity !== "object" ||
    entity.destinyBallMode === undefined
  ) {
    return fallback;
  }
  const candidate = resolveMode(entity.destinyBallMode, fallback);
  return candidate >= BALL_MODE.GOTO && candidate <= BALL_MODE.FORMATION
    ? candidate
    : fallback;
}

function resolveConfiguredBallFlags(entity, fallbackFlags = 0) {
  const configured = (
    entity &&
    typeof entity === "object" &&
    entity.destinyBallFlags !== undefined
  )
    ? toInt32(entity.destinyBallFlags, fallbackFlags)
    : toInt32(fallbackFlags, 0);

  // These are wire-level ball properties. Callers decide which properties are
  // valid for their entity class and must pair mini-section bits with tail data.
  return configured & 0xff;
}

module.exports = {
  getEntityBallRadius,
  resolveConfiguredBallFlags,
  resolveConfiguredBallMode,
  resolveDestinyPhysicalMass,
};
