"use strict";

// Neutral analytic integration is adapted from carbonengine/destiny v3.1.1.
// Copyright (c) 2026 CCP Games; MIT terms are in simulation/README.md.
const {
  DESTINY_SPACE_FRICTION,
} = require("../constants");

const CARBON_INTEGRATION_EPSILON = 1e-9;

function toFiniteNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function cloneVector(source = null) {
  return {
    x: toFiniteNumber(source && source.x, 0),
    y: toFiniteNumber(source && source.y, 0),
    z: toFiniteNumber(source && source.z, 0),
  };
}

function addVectors(left, right) {
  return {
    x: toFiniteNumber(left && left.x, 0) +
      toFiniteNumber(right && right.x, 0),
    y: toFiniteNumber(left && left.y, 0) +
      toFiniteNumber(right && right.y, 0),
    z: toFiniteNumber(left && left.z, 0) +
      toFiniteNumber(right && right.z, 0),
  };
}

function subtractVectors(left, right) {
  return {
    x: toFiniteNumber(left && left.x, 0) -
      toFiniteNumber(right && right.x, 0),
    y: toFiniteNumber(left && left.y, 0) -
      toFiniteNumber(right && right.y, 0),
    z: toFiniteNumber(left && left.z, 0) -
      toFiniteNumber(right && right.z, 0),
  };
}

function scaleVector(vector, scalar) {
  const resolvedScalar = toFiniteNumber(scalar, 0);
  return {
    x: toFiniteNumber(vector && vector.x, 0) * resolvedScalar,
    y: toFiniteNumber(vector && vector.y, 0) * resolvedScalar,
    z: toFiniteNumber(vector && vector.z, 0) * resolvedScalar,
  };
}

function integrateCarbonMotion(
  position,
  velocity,
  acceleration,
  inertialMass,
  friction = DESTINY_SPACE_FRICTION,
  seconds = 0,
) {
  const stepSeconds = Math.max(0, toFiniteNumber(seconds, 0));
  if (stepSeconds <= 0) {
    return {
      position: cloneVector(position),
      velocity: cloneVector(velocity),
    };
  }
  const mass = Math.max(
    CARBON_INTEGRATION_EPSILON,
    toFiniteNumber(inertialMass, 1),
  );
  const drag = Math.max(0, toFiniteNumber(friction, DESTINY_SPACE_FRICTION));
  const startPosition = cloneVector(position);
  const startVelocity = cloneVector(velocity);
  const forceAcceleration = cloneVector(acceleration);
  const lambda = drag / mass;
  if (lambda <= 1e-12) {
    return {
      position: addVectors(
        startPosition,
        addVectors(
          scaleVector(startVelocity, stepSeconds),
          scaleVector(forceAcceleration, 0.5 * stepSeconds * stepSeconds),
        ),
      ),
      velocity: addVectors(
        startVelocity,
        scaleVector(forceAcceleration, stepSeconds),
      ),
    };
  }
  const timeFactor = Math.exp(-lambda * stepSeconds);
  const equilibriumVelocity = scaleVector(forceAcceleration, 1 / lambda);
  const velocityOffset = subtractVectors(startVelocity, equilibriumVelocity);
  return {
    position: addVectors(
      startPosition,
      addVectors(
        scaleVector(equilibriumVelocity, stepSeconds),
        scaleVector(velocityOffset, (1 - timeFactor) / lambda),
      ),
    ),
    velocity: addVectors(
      equilibriumVelocity,
      scaleVector(velocityOffset, timeFactor),
    ),
  };
}

function deriveCarbonIntrinsicAcceleration(
  startVelocity,
  endVelocity,
  inertialMass,
  friction = DESTINY_SPACE_FRICTION,
  seconds = 0,
) {
  const stepSeconds = Math.max(
    CARBON_INTEGRATION_EPSILON,
    toFiniteNumber(seconds, 0),
  );
  const mass = Math.max(
    CARBON_INTEGRATION_EPSILON,
    toFiniteNumber(inertialMass, 1),
  );
  const drag = Math.max(0, toFiniteNumber(friction, DESTINY_SPACE_FRICTION));
  const lambda = drag / mass;
  if (lambda <= 1e-12) {
    return scaleVector(
      subtractVectors(cloneVector(endVelocity), cloneVector(startVelocity)),
      1 / stepSeconds,
    );
  }
  const timeFactor = Math.exp(-lambda * stepSeconds);
  const denominator = Math.max(
    CARBON_INTEGRATION_EPSILON,
    1 - timeFactor,
  );
  return scaleVector(
    subtractVectors(
      cloneVector(endVelocity),
      scaleVector(cloneVector(startVelocity), timeFactor),
    ),
    lambda / denominator,
  );
}

module.exports = {
  CARBON_INTEGRATION_EPSILON,
  deriveCarbonIntrinsicAcceleration,
  integrateCarbonMotion,
};
