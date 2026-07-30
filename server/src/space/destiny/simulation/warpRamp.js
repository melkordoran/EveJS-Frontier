"use strict";

const {
  normalizeDestinyStamp,
} = require("../delivery/stamps");

function toFiniteNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function clonePilotWarpMaxSpeedRamp(rawRamp, fallback = []) {
  const source = Array.isArray(rawRamp) ? rawRamp : fallback;
  return source
    .map((entry) => ({
      atMs: toFiniteNumber(entry && entry.atMs, 0),
      stamp: normalizeDestinyStamp(entry && entry.stamp, 0),
      speed: Math.max(toFiniteNumber(entry && entry.speed, 0), 0),
      label: String((entry && entry.label) || ""),
    }))
    .filter((entry) => entry.atMs > 0 && entry.speed > 0);
}

module.exports = {
  clonePilotWarpMaxSpeedRamp,
};
