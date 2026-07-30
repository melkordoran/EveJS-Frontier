function applyProbePositionTargetCommand({
  probeEntity,
  probe,
  buildVector,
} = {}) {
  if (!probeEntity || !probe || typeof buildVector !== "function") {
    return false;
  }

  probeEntity.position = buildVector(
    probe.pos,
    probeEntity.position || undefined,
  );
  probeEntity.targetPoint = buildVector(
    probe.destination || probe.pos,
    probeEntity.targetPoint || probeEntity.position,
  );
  return true;
}

module.exports = {
  applyProbePositionTargetCommand,
};
