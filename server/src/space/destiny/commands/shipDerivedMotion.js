function applyPassiveMotionBaseCommand(
  entity,
  resolveMass,
  resolveInertia,
  resolveMaxVelocity,
) {
  entity.mass = resolveMass();
  entity.inertia = resolveInertia();
  entity.maxVelocity = resolveMaxVelocity();
}

function applyPassiveMotionTimingCommand(
  entity,
  resolveAlignTime,
  resolveAgilitySeconds,
) {
  entity.alignTime = resolveAlignTime();
  entity.agilitySeconds = resolveAgilitySeconds();
}

function applyPropulsionMotionBaseCommand(
  entity,
  resolveMass,
  resolveMaxVelocity,
) {
  entity.mass = resolveMass();
  entity.maxVelocity = resolveMaxVelocity();
}

function applyPropulsionMotionTimingCommand(
  entity,
  resolveAlignTime,
  resolveAgilitySeconds,
) {
  entity.alignTime = resolveAlignTime();
  entity.agilitySeconds = resolveAgilitySeconds();
}

function restoreCommandedSpeedFractionCommand(entity, speedFraction) {
  "use strict";

  entity.speedFraction = speedFraction;
}

module.exports = {
  applyPassiveMotionBaseCommand,
  applyPassiveMotionTimingCommand,
  applyPropulsionMotionBaseCommand,
  applyPropulsionMotionTimingCommand,
  restoreCommandedSpeedFractionCommand,
};
