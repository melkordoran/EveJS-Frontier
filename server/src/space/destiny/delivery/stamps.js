const {
  DESTINY_STAMP_INTERVAL_MS,
} = require("../constants");

// Destiny serializes timestamps as signed 32-bit values, while Elysian's
// wall-clock-derived source intentionally stays in the non-negative half of
// that domain. Keep every short history-window comparison in this 31-bit
// ring: ordinary `<` / `>` comparisons fail when the source rolls through
// 0x7fffffff (or when a captured fixture exercises the same boundary).
const DESTINY_STAMP_MODULUS = 0x80000000;
const DESTINY_STAMP_MASK = DESTINY_STAMP_MODULUS - 1;
const DESTINY_STAMP_MAX_FORWARD_LEAD = 16;
const DESTINY_STAMP_MAX_ORDERING_DISTANCE =
  (DESTINY_STAMP_MODULUS / 2) - 1;

function getCurrentDestinyStamp(now = Date.now()) {
  const numericNow = Number(now);
  const stampSource = Number.isFinite(numericNow)
    ? Math.floor(numericNow / DESTINY_STAMP_INTERVAL_MS)
    : Math.floor(Date.now() / DESTINY_STAMP_INTERVAL_MS);
  return (stampSource & DESTINY_STAMP_MASK) >>> 0;
}

function getCeilDestinyStamp(now = Date.now()) {
  const numericNow = Number(now);
  const stampSource = Number.isFinite(numericNow)
    ? Math.ceil(numericNow / DESTINY_STAMP_INTERVAL_MS)
    : Math.ceil(Date.now() / DESTINY_STAMP_INTERVAL_MS);
  return (stampSource & DESTINY_STAMP_MASK) >>> 0;
}

function getMovementStamp(now = Date.now()) {
  return getCurrentDestinyStamp(now);
}

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    return Math.trunc(numeric);
  }
  const fallbackNumeric = Number(fallback);
  return Number.isFinite(fallbackNumeric) ? Math.trunc(fallbackNumeric) : 0;
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, value));
}

function normalizeDestinyStamp(value, fallback = 0) {
  // `Number(null)` is zero, but null/undefined are the canonical absence
  // values for optional Destiny lanes. Honour the caller's fallback before
  // coercion so an absent lane cannot silently become a real stamp zero.
  const sourceValue = value === null || value === undefined
    ? fallback
    : value;
  const normalized = toInt(sourceValue, 0) % DESTINY_STAMP_MODULUS;
  return (
    normalized < 0
      ? normalized + DESTINY_STAMP_MODULUS
      : normalized
  ) >>> 0;
}

function hasDestinyStamp(value) {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= DESTINY_STAMP_MASK;
}

function resolveOptionalDestinyStamp(value, fallback = null) {
  if (hasDestinyStamp(value)) {
    return normalizeDestinyStamp(value);
  }
  return hasDestinyStamp(fallback)
    ? normalizeDestinyStamp(fallback)
    : null;
}

function advanceDestinyStamp(stamp, lead = 1) {
  return normalizeDestinyStamp(
    normalizeDestinyStamp(stamp) + toInt(lead, 0),
  );
}

function getDestinyStampForwardDistance(fromStamp, toStamp) {
  const from = normalizeDestinyStamp(fromStamp);
  const to = normalizeDestinyStamp(toStamp);
  return ((to - from) + DESTINY_STAMP_MODULUS) % DESTINY_STAMP_MODULUS;
}

function compareDestinyStamps(leftStamp, rightStamp) {
  const leftPresent = hasDestinyStamp(leftStamp);
  const rightPresent = hasDestinyStamp(rightStamp);
  if (!leftPresent || !rightPresent) {
    return leftPresent === rightPresent ? 0 : leftPresent ? -1 : 1;
  }
  const left = normalizeDestinyStamp(leftStamp);
  const right = normalizeDestinyStamp(rightStamp);
  if (left === right) {
    return 0;
  }
  const leftToRight = getDestinyStampForwardDistance(left, right);
  const rightToLeft = getDestinyStampForwardDistance(right, left);
  return leftToRight <= rightToLeft ? -1 : 1;
}

function getDestinyStampForwardBoundaryDeltaMs(
  currentSimTimeMs,
  currentStamp,
  targetStamp,
  maximumLead = DESTINY_STAMP_MAX_FORWARD_LEAD,
) {
  if (!hasDestinyStamp(currentStamp) || !hasDestinyStamp(targetStamp)) {
    return 0;
  }
  const forwardDistance = getDestinyStampForwardDistance(
    currentStamp,
    targetStamp,
  );
  const normalizedMaximumLead = clamp(
    toInt(maximumLead, DESTINY_STAMP_MAX_FORWARD_LEAD),
    0,
    DESTINY_STAMP_MAX_FORWARD_LEAD,
  );
  if (forwardDistance <= 0 || forwardDistance > normalizedMaximumLead) {
    return 0;
  }
  const normalizedCurrentSimTimeMs = Number(currentSimTimeMs);
  const currentTimeMs = Number.isFinite(normalizedCurrentSimTimeMs)
    ? normalizedCurrentSimTimeMs
    : 0;
  const intervalRemainder = (
    (currentTimeMs % DESTINY_STAMP_INTERVAL_MS) +
    DESTINY_STAMP_INTERVAL_MS
  ) % DESTINY_STAMP_INTERVAL_MS;
  return (forwardDistance * DESTINY_STAMP_INTERVAL_MS) - intervalRemainder;
}

function isDestinyStampWithinForwardWindow(
  currentStamp,
  candidateStamp,
  maximumLead,
) {
  if (!hasDestinyStamp(currentStamp) || !hasDestinyStamp(candidateStamp)) {
    return false;
  }
  const normalizedMaximumLead = Math.max(0, toInt(maximumLead, 0));
  return getDestinyStampForwardDistance(currentStamp, candidateStamp) <=
    normalizedMaximumLead;
}

function isDestinyStampAfter(
  referenceStamp,
  candidateStamp,
  maximumLead = DESTINY_STAMP_MAX_ORDERING_DISTANCE,
) {
  if (!hasDestinyStamp(referenceStamp) || !hasDestinyStamp(candidateStamp)) {
    return false;
  }
  const distance = getDestinyStampForwardDistance(
    referenceStamp,
    candidateStamp,
  );
  return distance > 0 && distance <= Math.max(0, toInt(maximumLead, 0));
}

function selectLaterDestinyStamp(
  previousStamp,
  candidateStamp,
  maximumLead = DESTINY_STAMP_MAX_ORDERING_DISTANCE,
) {
  if (!hasDestinyStamp(previousStamp)) {
    return hasDestinyStamp(candidateStamp)
      ? normalizeDestinyStamp(candidateStamp)
      : null;
  }
  const normalizedPreviousStamp = normalizeDestinyStamp(previousStamp);
  if (!hasDestinyStamp(candidateStamp)) {
    return normalizedPreviousStamp;
  }
  return isDestinyStampAfter(
    normalizedPreviousStamp,
    candidateStamp,
    maximumLead,
  )
    ? normalizeDestinyStamp(candidateStamp)
    : normalizedPreviousStamp;
}

function selectFurthestDestinyStamp(
  anchorStamp,
  candidateStamps,
  maximumLead = DESTINY_STAMP_MAX_ORDERING_DISTANCE,
) {
  const normalizedAnchorStamp = normalizeDestinyStamp(anchorStamp);
  const normalizedMaximumLead = Math.max(0, toInt(maximumLead, 0));
  let selectedStamp = normalizedAnchorStamp;
  let selectedDistance = 0;
  for (const candidateStamp of Array.isArray(candidateStamps)
    ? candidateStamps
    : [candidateStamps]) {
    if (!hasDestinyStamp(candidateStamp)) {
      continue;
    }
    const candidateDistance = getDestinyStampForwardDistance(
      normalizedAnchorStamp,
      candidateStamp,
    );
    if (
      candidateDistance <= normalizedMaximumLead &&
      candidateDistance >= selectedDistance
    ) {
      selectedStamp = normalizeDestinyStamp(candidateStamp);
      selectedDistance = candidateDistance;
    }
  }
  return selectedStamp;
}

// Unlike `selectFurthestDestinyStamp`, this nullable selector does not inject
// the anchor as an implicit candidate. It is the canonical helper for optional
// policy floors/ceilings where stamp zero is valid and absence is null.
function selectFurthestPresentDestinyStamp(
  anchorStamp,
  candidateStamps,
  maximumLead = DESTINY_STAMP_MAX_ORDERING_DISTANCE,
) {
  const normalizedAnchorStamp = normalizeDestinyStamp(anchorStamp, 0);
  const normalizedMaximumLead = Math.max(0, toInt(maximumLead, 0));
  const presentCandidates = (
    Array.isArray(candidateStamps) ? candidateStamps : [candidateStamps]
  ).filter((candidateStamp) => (
    hasDestinyStamp(candidateStamp) &&
    getDestinyStampForwardDistance(
      normalizedAnchorStamp,
      candidateStamp,
    ) <= normalizedMaximumLead
  ));
  return presentCandidates.length > 0
    ? selectFurthestDestinyStamp(
        normalizedAnchorStamp,
        presentCandidates,
        normalizedMaximumLead,
      )
    : null;
}

function clampDestinyStampToCeiling(anchorStamp, candidateStamp, ceilingStamp) {
  if (!hasDestinyStamp(candidateStamp)) {
    return resolveOptionalDestinyStamp(ceilingStamp);
  }
  if (!hasDestinyStamp(ceilingStamp)) {
    return normalizeDestinyStamp(candidateStamp);
  }
  return getDestinyStampForwardDistance(anchorStamp, candidateStamp) >
    getDestinyStampForwardDistance(anchorStamp, ceilingStamp)
    ? normalizeDestinyStamp(ceilingStamp)
    : normalizeDestinyStamp(candidateStamp);
}

function advanceNextDestinyStamp(options = {}) {
  const currentStamp = normalizeDestinyStamp(options.currentStamp, 0);
  const maximumLead = Math.max(0, toInt(options.maximumLead, 0));
  const previousNextStamp = normalizeDestinyStamp(
    options.nextStamp,
    currentStamp,
  );
  const previousLead = getDestinyStampForwardDistance(
    currentStamp,
    previousNextStamp,
  );
  // A specialized lane (the acceleration gate currently authors +5) may
  // legitimately sit beyond this caller's ordinary horizon. It is not a
  // candidate for this bounded lane: allocate at the lane ceiling and let the
  // scene retain the higher watermark separately. A huge forward distance is
  // the modular representation of a stale/behind stamp.
  if (previousLead > maximumLead) {
    return previousLead <= DESTINY_STAMP_MAX_FORWARD_LEAD
      ? advanceDestinyStamp(currentStamp, maximumLead)
      : currentStamp;
  }
  if (previousLead >= maximumLead) {
    return advanceDestinyStamp(currentStamp, maximumLead);
  }
  return advanceDestinyStamp(previousNextStamp, 1);
}

function advanceHistorySafeDestinyStamp(options = {}) {
  const currentStamp = normalizeDestinyStamp(options.currentStamp, 0);
  const maximumLead = clamp(
    toInt(options.maximumLead, 0),
    0,
    DESTINY_STAMP_MAX_FORWARD_LEAD,
  );
  const normalizedLead = clamp(
    toInt(options.minimumLead, 1),
    0,
    maximumLead,
  );
  const previousNextStamp = normalizeDestinyStamp(
    options.nextStamp,
    currentStamp,
  );
  const previousLead = getDestinyStampForwardDistance(
    currentStamp,
    previousNextStamp,
  );
  const baseLead = previousLead <= maximumLead ? previousLead : 0;
  return advanceDestinyStamp(
    currentStamp,
    clamp(Math.max(baseLead, normalizedLead), 0, maximumLead),
  );
}

module.exports = {
  DESTINY_STAMP_MODULUS,
  DESTINY_STAMP_MAX_FORWARD_LEAD,
  DESTINY_STAMP_MAX_ORDERING_DISTANCE,
  advanceDestinyStamp,
  advanceHistorySafeDestinyStamp,
  advanceNextDestinyStamp,
  compareDestinyStamps,
  clampDestinyStampToCeiling,
  getDestinyStampForwardBoundaryDeltaMs,
  getDestinyStampForwardDistance,
  getCeilDestinyStamp,
  getCurrentDestinyStamp,
  getMovementStamp,
  hasDestinyStamp,
  isDestinyStampAfter,
  isDestinyStampWithinForwardWindow,
  normalizeDestinyStamp,
  resolveOptionalDestinyStamp,
  selectFurthestDestinyStamp,
  selectFurthestPresentDestinyStamp,
  selectLaterDestinyStamp,
};
