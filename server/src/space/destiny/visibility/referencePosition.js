function toFiniteNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function cloneVector(source = null, fallback = { x: 0, y: 0, z: 0 }) {
  return {
    x: toFiniteNumber(source && source.x, fallback.x),
    y: toFiniteNumber(source && source.y, fallback.y),
    z: toFiniteNumber(source && source.z, fallback.z),
  };
}

function resolveWarpVisibilityReferencePosition(entity, isFreshAcquire = false) {
  if (
    entity &&
    entity.sessionlessWarpIngress &&
    !entity.session &&
    isFreshAcquire === true &&
    entity.sessionlessWarpIngress.useNativeWarpProfile !== true
  ) {
    return cloneVector(
      entity.sessionlessWarpIngress.targetPoint,
      entity.targetPoint || entity.position,
    );
  }

  return cloneVector(entity && entity.position);
}

module.exports = {
  resolveWarpVisibilityReferencePosition,
};
