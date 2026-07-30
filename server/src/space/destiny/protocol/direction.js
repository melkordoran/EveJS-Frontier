"use strict";

const {
  getPayloadPrimaryEntityID,
} = require("./payloadIdentity");
const {
  getCanonicalPayloadName,
  isDestinyPayload,
} = require("./payloads");

const DEFAULT_DIRECTION = Object.freeze({ x: 1, y: 0, z: 0 });

function getFiniteDirectionComponent(value) {
  let candidate = value;
  if (candidate && typeof candidate === "object") {
    try {
      candidate = candidate.value;
    } catch (_error) {
      return null;
    }
  }
  if (
    candidate === null ||
    candidate === undefined ||
    typeof candidate === "bigint" ||
    typeof candidate === "boolean"
  ) {
    return null;
  }
  if (typeof candidate === "string" && candidate.trim() === "") {
    return null;
  }
  const number = Number(candidate);
  return Number.isFinite(number) ? number : null;
}

function extractFiniteDirectionVector(vector) {
  if (!vector || typeof vector !== "object") {
    return null;
  }
  try {
    const x = getFiniteDirectionComponent(vector.x);
    const y = getFiniteDirectionComponent(vector.y);
    const z = getFiniteDirectionComponent(vector.z);
    return x === null || y === null || z === null ? null : { x, y, z };
  } catch (_error) {
    return null;
  }
}

function normalizeDirection(vector) {
  const finiteVector = extractFiniteDirectionVector(vector);
  if (!finiteVector) {
    return null;
  }
  const { x, y, z } = finiteVector;
  const length = Math.sqrt((x ** 2) + (y ** 2) + (z ** 2));
  if (!Number.isFinite(length) || length <= 0) {
    return null;
  }
  return {
    x: x / length,
    y: y / length,
    z: z / length,
  };
}

function extractGotoDirectionVector(payload) {
  if (
    !isDestinyPayload(payload) ||
    getCanonicalPayloadName(payload) !== "GotoDirection" ||
    getPayloadPrimaryEntityID(payload) === null
  ) {
    return null;
  }

  try {
    const args = payload[1];
    return extractFiniteDirectionVector({
      x: args[1],
      y: args[2],
      z: args[3],
    });
  } catch (_error) {
    return null;
  }
}

function extractGotoDirection(payload, fallbackDirection = null) {
  const vector = extractGotoDirectionVector(payload);
  if (!vector) {
    return null;
  }
  const direction = normalizeDirection(vector);
  return direction || normalizeDirection(fallbackDirection);
}

function extractLatestGotoDirection(updates, fallbackDirection = null) {
  if (!Array.isArray(updates)) {
    return null;
  }

  let latestDirection = null;
  try {
    for (const update of updates) {
      const payload = Array.isArray(update)
        ? update
        : update && Array.isArray(update.payload)
          ? update.payload
          : null;
      if (getCanonicalPayloadName(payload) !== "GotoDirection") {
        continue;
      }
      const direction = extractGotoDirection(
        payload,
        latestDirection || fallbackDirection,
      );
      if (direction) {
        latestDirection = direction;
      }
    }
  } catch (_error) {
    return latestDirection;
  }
  return latestDirection;
}

function normalizeStampValue(normalizeStamp, value) {
  try {
    const normalized = typeof normalizeStamp === "function"
      ? normalizeStamp(value)
      : value;
    if (
      normalized === null ||
      normalized === undefined ||
      (typeof normalized === "number" && !Number.isFinite(normalized))
    ) {
      return { ok: false, value: null };
    }
    return {
      ok: true,
      value: normalized,
    };
  } catch (_error) {
    return { ok: false, value: null };
  }
}

function resolveGotoDirectionFromUpdates(options = {}) {
  const resolvedOptions = options && typeof options === "object" ? options : {};
  const updates = resolvedOptions.updates;
  const normalizeStamp = resolvedOptions.normalizeStamp;
  const expectedStamp = resolvedOptions.expectedStamp;
  const normalizeVector = resolvedOptions.normalizeVector;
  const defaultDirection = resolvedOptions.defaultDirection || DEFAULT_DIRECTION;
  const filterByStamp = Object.prototype.hasOwnProperty.call(
    resolvedOptions,
    "expectedStamp",
  );
  if (filterByStamp && (expectedStamp === null || expectedStamp === undefined)) {
    return null;
  }
  const normalizedExpectedStamp = filterByStamp
    ? normalizeStampValue(normalizeStamp, expectedStamp)
    : { ok: true, value: null };
  if (!normalizedExpectedStamp.ok) {
    return null;
  }
  const fallbackDirection = (
    defaultDirection && typeof defaultDirection === "object"
  )
    ? defaultDirection
    : DEFAULT_DIRECTION;
  const customVectorNormalizer = typeof normalizeVector === "function"
    ? normalizeVector
    : null;
  let latestDirection = null;

  for (const update of Array.isArray(updates) ? updates : []) {
    if (!update || typeof update !== "object" || Array.isArray(update)) {
      continue;
    }
    if (filterByStamp) {
      let stamp;
      try {
        stamp = update.stamp;
      } catch (_error) {
        continue;
      }
      const normalizedUpdateStamp = normalizeStampValue(normalizeStamp, stamp);
      if (
        !normalizedUpdateStamp.ok ||
        normalizedUpdateStamp.value !== normalizedExpectedStamp.value
      ) {
        continue;
      }
    }
    let payload;
    try {
      payload = update.payload;
    } catch (_error) {
      continue;
    }
    const vector = extractGotoDirectionVector(payload);
    if (!vector) {
      continue;
    }
    if (!customVectorNormalizer) {
      latestDirection = vector;
      continue;
    }
    try {
      latestDirection = customVectorNormalizer(
        vector,
        latestDirection || fallbackDirection,
      );
    } catch (_error) {
      // Inspection helpers cannot make delivery fail; retain the prior result.
    }
  }

  return latestDirection;
}

function serializeDestinyDirectionHeading(direction) {
  const vector = extractFiniteDirectionVector(direction);
  return vector ? JSON.stringify(vector) : "";
}

function parseDestinyDirectionHeading(serializedHeading) {
  if (typeof serializedHeading !== "string" || serializedHeading.trim() === "") {
    return null;
  }
  try {
    return extractFiniteDirectionVector(JSON.parse(serializedHeading));
  } catch (_error) {
    return null;
  }
}

module.exports = {
  extractGotoDirection,
  extractGotoDirectionVector,
  extractLatestGotoDirection,
  normalizeDirection,
  parseDestinyDirectionHeading,
  resolveGotoDirectionFromUpdates,
  serializeDestinyDirectionHeading,
};
