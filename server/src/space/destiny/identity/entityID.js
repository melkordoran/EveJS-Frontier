"use strict";

// Carbon's Ball::ID is int64_t and its Python boundary uses the signed
// PyLong long-long conversion. Negative IDs are therefore valid wire/local
// identities even though persistent database entities use positive IDs.
const MIN_SIGNED_ENTITY_ID = -(1n << 63n);
const MAX_SIGNED_ENTITY_ID = (1n << 63n) - 1n;
const MIN_SAFE_ENTITY_ID = BigInt(Number.MIN_SAFE_INTEGER);
const MAX_SAFE_ENTITY_ID = BigInt(Number.MAX_SAFE_INTEGER);

function unwrapEntityID(value) {
  if (!value || typeof value !== "object") {
    return value;
  }

  let wrapperType;
  try {
    wrapperType = value.type;
  } catch (_error) {
    return value;
  }

  if (wrapperType !== "long" && wrapperType !== "PyLong") {
    return value;
  }

  try {
    return value.value;
  } catch (_error) {
    return value;
  }
}

function parseEntityIDBigInt(value) {
  const unwrapped = unwrapEntityID(value);
  let parsed;

  if (typeof unwrapped === "bigint") {
    parsed = unwrapped;
  } else if (typeof unwrapped === "number") {
    // An unsafe Number has already lost identity bits and cannot be repaired
    // by converting it to BigInt after the fact.
    if (!Number.isSafeInteger(unwrapped)) {
      return null;
    }
    parsed = BigInt(unwrapped);
  } else if (typeof unwrapped === "string") {
    const text = unwrapped.trim();
    if (!/^-?\d+$/.test(text)) {
      return null;
    }
    try {
      parsed = BigInt(text);
    } catch (_error) {
      return null;
    }
  } else {
    return null;
  }

  return parsed >= MIN_SIGNED_ENTITY_ID && parsed <= MAX_SIGNED_ENTITY_ID
    ? parsed
    : null;
}

function normalizeEntityID(value, options = {}) {
  const parsed = parseEntityIDBigInt(value);
  if (parsed === null) {
    return null;
  }
  if (options.preferBigInt === true) {
    return parsed;
  }
  return parsed >= MIN_SAFE_ENTITY_ID && parsed <= MAX_SAFE_ENTITY_ID
    ? Number(parsed)
    : parsed;
}

function normalizePersistentEntityID(value, options = {}) {
  const parsed = parseEntityIDBigInt(value);
  if (parsed === null || parsed <= 0n) {
    return null;
  }
  if (options.preferBigInt === true) {
    return parsed;
  }
  return parsed <= MAX_SAFE_ENTITY_ID ? Number(parsed) : parsed;
}

function normalizeNonNegativeInt64(value, options = {}) {
  const parsed = parseEntityIDBigInt(value);
  if (parsed === null || parsed < 0n) {
    return null;
  }
  if (options.preferBigInt === true) {
    return parsed;
  }
  return parsed <= MAX_SAFE_ENTITY_ID ? Number(parsed) : parsed;
}

function getEntityMapKey(value, options = {}) {
  return normalizeEntityID(value, options);
}

function normalizeEntityIDSet(value, options = {}) {
  const normalized = new Set();
  const entries = value instanceof Set
    ? value
    : Array.isArray(value)
      ? value
      : [];
  for (const entry of entries) {
    const entityID = getEntityMapKey(entry, options);
    if (entityID !== null) {
      normalized.add(entityID);
    }
  }
  return normalized;
}

function getEntityIDText(value) {
  const parsed = parseEntityIDBigInt(value);
  return parsed === null ? null : parsed.toString(10);
}

function entityIDsEqual(left, right) {
  const leftText = getEntityIDText(left);
  return leftText !== null && leftText === getEntityIDText(right);
}

function deleteEntityIDFromMap(map, entityID) {
  if (!(map instanceof Map) || parseEntityIDBigInt(entityID) === null) {
    return false;
  }
  let deleted = false;
  for (const key of [...map.keys()]) {
    if (entityIDsEqual(key, entityID)) {
      deleted = map.delete(key) || deleted;
    }
  }
  return deleted;
}

function compareEntityIDs(left, right) {
  const leftID = parseEntityIDBigInt(left);
  const rightID = parseEntityIDBigInt(right);
  if (leftID === null || rightID === null) {
    if (leftID === rightID) {
      return 0;
    }
    return leftID === null ? 1 : -1;
  }
  return leftID < rightID ? -1 : leftID > rightID ? 1 : 0;
}

function requireEntityID(value, label = "entityID", options = {}) {
  const normalized = normalizeEntityID(value, options);
  if (normalized === null) {
    throw new TypeError(`${label} must be an exact signed int64 identity`);
  }
  return normalized;
}

function requirePersistentEntityID(value, label = "entityID", options = {}) {
  const normalized = normalizePersistentEntityID(value, options);
  if (normalized === null) {
    throw new TypeError(`${label} must be an exact positive int64 persistent identity`);
  }
  return normalized;
}

function deriveEntityID(baseID, multiplier, offset = 0, options = {}) {
  const label = options.label || "entityID";
  const base = requirePersistentEntityID(baseID, `${label} base`, {
    preferBigInt: true,
  });
  const parsedMultiplier = parseEntityIDBigInt(multiplier);
  const parsedOffset = parseEntityIDBigInt(offset);
  if (parsedMultiplier === null || parsedMultiplier < 1n) {
    throw new TypeError(`${label} multiplier must be an exact positive integer`);
  }
  if (parsedOffset === null || parsedOffset < 0n) {
    throw new TypeError(`${label} offset must be an exact non-negative integer`);
  }
  return requirePersistentEntityID(
    (base * parsedMultiplier) + parsedOffset,
    label,
    options,
  );
}

function toWireEntityID(value, options = {}) {
  return requireEntityID(value, options.label || "entityID", {
    preferBigInt: true,
  });
}

function toJSONSafeEntityID(value) {
  const normalized = normalizeEntityID(value);
  if (normalized === null) {
    return null;
  }
  return typeof normalized === "bigint" ? normalized.toString(10) : normalized;
}

module.exports = {
  MAX_SAFE_ENTITY_ID,
  MAX_SIGNED_ENTITY_ID,
  MIN_SAFE_ENTITY_ID,
  MIN_SIGNED_ENTITY_ID,
  compareEntityIDs,
  deriveEntityID,
  deleteEntityIDFromMap,
  entityIDsEqual,
  getEntityIDText,
  getEntityMapKey,
  normalizeEntityID,
  normalizeEntityIDSet,
  normalizeNonNegativeInt64,
  normalizePersistentEntityID,
  parseEntityIDBigInt,
  requireEntityID,
  requirePersistentEntityID,
  toJSONSafeEntityID,
  toWireEntityID,
  unwrapEntityID,
};
