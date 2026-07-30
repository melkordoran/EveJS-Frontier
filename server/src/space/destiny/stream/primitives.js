"use strict";

const { unwrapEntityID } = require("../identity/entityID");

const SIGNED_INT64_MIN = -(1n << 63n);
const SIGNED_INT64_MAX = (1n << 63n) - 1n;

function toFiniteNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function toInt32(value, fallback = 0) {
  return Math.trunc(toFiniteNumber(value, fallback));
}

function buildVector(source = null, fallback = { x: 0, y: 0, z: 0 }) {
  return {
    x: toFiniteNumber(source && source.x, fallback.x),
    y: toFiniteNumber(source && source.y, fallback.y),
    z: toFiniteNumber(source && source.z, fallback.z),
  };
}

function normalizeVector(source = null, fallback = { x: 1, y: 0, z: 0 }) {
  const vector = buildVector(source, fallback);
  const magnitude = Math.sqrt(
    (vector.x ** 2) + (vector.y ** 2) + (vector.z ** 2),
  );
  if (!Number.isFinite(magnitude) || magnitude <= 0) {
    return buildVector(fallback);
  }
  return {
    x: vector.x / magnitude,
    y: vector.y / magnitude,
    z: vector.z / magnitude,
  };
}

function buildMarshalReal(value, fallback = 0) {
  return {
    type: "real",
    value: toFiniteNumber(value, fallback),
  };
}

function buildMarshalRealVector(source = null, fallback = { x: 0, y: 0, z: 0 }) {
  const vector = buildVector(source, fallback);
  return {
    x: buildMarshalReal(vector.x, fallback.x),
    y: buildMarshalReal(vector.y, fallback.y),
    z: buildMarshalReal(vector.z, fallback.z),
  };
}

function getMarshalRealNumber(value, fallback = 0) {
  if (
    value &&
    typeof value === "object" &&
    value.type === "real" &&
    Object.prototype.hasOwnProperty.call(value, "value")
  ) {
    return toFiniteNumber(value.value, fallback);
  }
  return toFiniteNumber(value, fallback);
}

function buildRowDescriptor(columns) {
  return {
    type: "objectex1",
    header: [
      { type: "token", value: "blue.DBRowDescriptor" },
      [columns],
    ],
    list: [],
    dict: [],
  };
}

function buildPackedRow(columns, fields) {
  return {
    type: "packedrow",
    header: buildRowDescriptor(columns),
    columns,
    fields,
  };
}

function normalizeBigInt64(value) {
  const unwrapped = unwrapEntityID(value);
  let normalized;

  if (typeof unwrapped === "bigint") {
    normalized = unwrapped;
  } else if (typeof unwrapped === "number") {
    if (!Number.isSafeInteger(unwrapped)) {
      throw new TypeError("Destiny signed-int64 Numbers must be safe integers");
    }
    normalized = BigInt(unwrapped);
  } else if (
    typeof unwrapped === "string" &&
    /^-?\d+$/.test(unwrapped.trim())
  ) {
    normalized = BigInt(unwrapped.trim());
  } else {
    throw new TypeError("Destiny signed-int64 value must be an exact integer");
  }

  if (normalized < SIGNED_INT64_MIN || normalized > SIGNED_INT64_MAX) {
    throw new RangeError("Destiny signed-int64 value is outside its wire range");
  }
  return normalized;
}

function pushBigInt64(chunks, value) {
  const buffer = Buffer.alloc(8);
  buffer.writeBigInt64LE(normalizeBigInt64(value), 0);
  chunks.push(buffer);
}

function pushInt32(chunks, value) {
  const buffer = Buffer.alloc(4);
  buffer.writeInt32LE(toInt32(value, 0), 0);
  chunks.push(buffer);
}

function pushUInt32(chunks, value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(toInt32(value, 0) >>> 0, 0);
  chunks.push(buffer);
}

function pushUInt8(chunks, value) {
  chunks.push(Buffer.from([toInt32(value, 0) & 0xff]));
}

function pushFloat(chunks, value) {
  const buffer = Buffer.alloc(4);
  buffer.writeFloatLE(toFiniteNumber(value, 0), 0);
  chunks.push(buffer);
}

function pushDouble(chunks, value) {
  const buffer = Buffer.alloc(8);
  buffer.writeDoubleLE(toFiniteNumber(value, 0), 0);
  chunks.push(buffer);
}

module.exports = {
  buildMarshalReal,
  buildMarshalRealVector,
  buildPackedRow,
  buildRowDescriptor,
  buildVector,
  getMarshalRealNumber,
  normalizeBigInt64,
  normalizeVector,
  pushBigInt64,
  pushDouble,
  pushFloat,
  pushInt32,
  pushUInt32,
  pushUInt8,
  toFiniteNumber,
  toInt32,
};
