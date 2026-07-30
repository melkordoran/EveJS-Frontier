"use strict";

function createDroneOperationalMotionCommand({
  droneEntity,
  mass,
  inertia,
} = {}) {
  const applied = Boolean(droneEntity);
  return {
    applied,
    applyMassAndInertia() {
      if (!applied) {
        return false;
      }
      droneEntity.mass = mass;
      droneEntity.inertia = inertia;
      return true;
    },
    applyVelocityAndAgility({
      maxVelocity,
      resolveAlignTime,
      maxAccelerationTime,
      resolveAgilitySeconds,
    } = {}) {
      if (!applied) {
        return false;
      }
      droneEntity.maxVelocity = maxVelocity;
      droneEntity.alignTime = resolveAlignTime();
      droneEntity.maxAccelerationTime = maxAccelerationTime;
      droneEntity.agilitySeconds = resolveAgilitySeconds();
      return true;
    },
  };
}

module.exports = {
  createDroneOperationalMotionCommand,
};
