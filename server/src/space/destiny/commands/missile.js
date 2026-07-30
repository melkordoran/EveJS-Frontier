function applyMissileCloakLossFlyoffMotionCommand(
  missileEntity,
  flyoffDirection,
  resolveTargetPoint,
  toFiniteNumber,
) {
  "use strict";

  missileEntity.mode = "GOTO";
  missileEntity.targetEntityID = null;
  missileEntity.followRange = 0;
  missileEntity.orbitDistance = 0;
  missileEntity.direction = flyoffDirection;
  missileEntity.targetPoint = resolveTargetPoint();
  if (toFiniteNumber(missileEntity.speedFraction, 0) <= 0) {
    missileEntity.speedFraction = 1;
  }
}

function demoteMissileCloakLossMassiveStateCommand(missileEntity) {
  missileEntity.isMassive = false;
  missileEntity.massive = false;
}

function clearMissileCloakLossPendingImpactCommand(missileEntity) {
  "use strict";

  missileEntity.pendingGeometryImpact = false;
  missileEntity.pendingGeometryImpactAtMs = 0;
  missileEntity.pendingGeometryImpactReason = "";
  missileEntity.pendingGeometryImpactPosition = { x: 0, y: 0, z: 0 };
}

module.exports = {
  applyMissileCloakLossFlyoffMotionCommand,
  demoteMissileCloakLossMassiveStateCommand,
  clearMissileCloakLossPendingImpactCommand,
};
