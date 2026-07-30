function applySuperweaponShowFollowMotionCommand({
  entity,
  targetEntity,
  toInt,
  cloneVector,
  subtractVectors,
  normalizeVector,
  followRange,
} = {}) {
  if (!entity || !targetEntity) {
    return false;
  }

  entity.mode = "FOLLOW";
  entity.targetEntityID = toInt(targetEntity.itemID, 0) || null;
  entity.followRange = followRange;
  entity.speedFraction = 1;
  entity.targetPoint = cloneVector(
    targetEntity.position,
    entity.targetPoint || entity.position,
  );
  entity.direction = normalizeVector(
    subtractVectors(targetEntity.position, entity.position),
    entity.direction,
  );
  return true;
}

module.exports = {
  applySuperweaponShowFollowMotionCommand,
};
