"use strict";

const {
  parseEntityIDBigInt,
  requireEntityID,
} = require("../identity/entityID");
const {
  pushBigInt64,
  pushInt32,
} = require("./primitives");

const INT32_MIN = -(1n << 31n);
const INT32_MAX = (1n << 31n) - 1n;

function firstDefined(entity, keys) {
  if (!entity || typeof entity !== "object") {
    return undefined;
  }
  for (const key of keys) {
    if (entity[key] !== undefined && entity[key] !== null && entity[key] !== "") {
      return entity[key];
    }
  }
  return undefined;
}

function resolveDestinyHarmonic(entity) {
  const value = entity && (
    entity.harmonic ??
    entity.harmonicID ??
    entity.mHarmonic
  );
  return value === undefined || value === null || value === ""
    ? -1n
    : requireEntityID(value, "Destiny harmonic", { preferBigInt: true });
}

function resolveOptionalInt32(entity, key, label) {
  const value = firstDefined(entity, [key]);
  if (value === undefined) {
    return -1;
  }
  const parsed = parseEntityIDBigInt(value);
  if (parsed === null || parsed < INT32_MIN || parsed > INT32_MAX) {
    throw new TypeError(`${label} must be an exact signed int32 identity`);
  }
  return Number(parsed);
}

function resolveFreeBallCorporationID(entity) {
  return resolveOptionalInt32(entity, "corporationID", "corporationID");
}

function resolveFreeBallAllianceID(entity) {
  return resolveOptionalInt32(entity, "allianceID", "allianceID");
}

function appendFreeBallOwnershipHeader(chunks, entity, writers = {}) {
  if (!Array.isArray(chunks)) {
    throw new TypeError("Destiny chunks must be an array");
  }
  const writeBigInt64 = writers.pushBigInt64 || pushBigInt64;
  const writeInt32 = writers.pushInt32 || pushInt32;
  if (typeof writeBigInt64 !== "function" || typeof writeInt32 !== "function") {
    throw new TypeError("Destiny ownership writers must be functions");
  }

  writeBigInt64(chunks, resolveDestinyHarmonic(entity));
  writeInt32(chunks, resolveFreeBallCorporationID(entity));
  writeInt32(chunks, resolveFreeBallAllianceID(entity));
}

module.exports = {
  appendFreeBallOwnershipHeader,
  resolveDestinyHarmonic,
  resolveFreeBallAllianceID,
  resolveFreeBallCorporationID,
};
