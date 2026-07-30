const DISPOSABLE_JETCAN_TYPE_ID = 23;
const SPACE_CONTAINER_FLAG_ID = 0;

function isDisposableJetcanRecord(item) {
  const expiresAtMs = Number(item && item.expiresAtMs);
  return Boolean(
    item &&
      Number(item.typeID) === DISPOSABLE_JETCAN_TYPE_ID &&
      Number(item.flagID) === SPACE_CONTAINER_FLAG_ID &&
      Number.isFinite(expiresAtMs) &&
      expiresAtMs > 0,
  );
}

function evaluateCumulativeCapacity({
  capacity,
  used,
  requiredVolume,
  epsilon = 1e-7,
}) {
  const normalizedCapacity = Math.max(0, Number(capacity) || 0);
  const normalizedUsed = Math.max(0, Number(used) || 0);
  const normalizedRequiredVolume = Math.max(
    0,
    Number(requiredVolume) || 0,
  );
  const free = Math.max(0, normalizedCapacity - normalizedUsed);

  return {
    success:
      normalizedRequiredVolume <=
      free + Math.max(0, Number(epsilon) || 0),
    free,
    requiredVolume: normalizedRequiredVolume,
  };
}

module.exports = {
  DISPOSABLE_JETCAN_TYPE_ID,
  SPACE_CONTAINER_FLAG_ID,
  evaluateCumulativeCapacity,
  isDisposableJetcanRecord,
};
