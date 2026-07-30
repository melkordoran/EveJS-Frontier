"use strict";

const {
  DESTINY_STAMP_MAX_FORWARD_LEAD,
  advanceDestinyStamp,
  hasDestinyStamp,
  normalizeDestinyStamp,
  selectFurthestDestinyStamp,
} = require("./stamps");

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

function resolvePresentedSessionDestinyStamp(options = {}) {
  const currentVisibleStamp = normalizeDestinyStamp(
    options.currentVisibleStamp,
    0,
  );
  if (options.hasSessionSpace !== true) {
    return currentVisibleStamp;
  }

  const defaultMaximumFutureLead = Math.max(
    0,
    toInt(options.defaultMaximumFutureLead, 0),
  );
  const maximumTrustedLead = Math.max(
    defaultMaximumFutureLead,
    toInt(options.maximumTrustedLead, defaultMaximumFutureLead),
  );
  const trustedFutureLead = clamp(
    toInt(options.maximumFutureLead, defaultMaximumFutureLead),
    0,
    maximumTrustedLead,
  );
  const lastSentStamp = hasDestinyStamp(options.lastSentStamp)
    ? normalizeDestinyStamp(options.lastSentStamp)
    : null;
  return selectFurthestDestinyStamp(
    currentVisibleStamp,
    [lastSentStamp],
    trustedFutureLead,
  );
}

function resolvePendingHistorySafeSessionDestinyStamp(options = {}) {
  const rawStamp = normalizeDestinyStamp(options.rawStamp, 0);
  if (options.hasSessionSpace !== true) {
    return rawStamp;
  }

  const currentSessionStamp = normalizeDestinyStamp(
    options.currentSessionStamp,
    0,
  );
  const lastVisibleSessionStamp = hasDestinyStamp(
    options.lastVisibleSessionStamp,
  )
    ? normalizeDestinyStamp(options.lastVisibleSessionStamp)
    : null;
  const minimumLead = clamp(
    toInt(options.minimumLead, 1),
    0,
    DESTINY_STAMP_MAX_FORWARD_LEAD,
  );
  const minimumStamp = advanceDestinyStamp(currentSessionStamp, minimumLead);
  const translatedStamp = hasDestinyStamp(options.translatedStamp)
    ? normalizeDestinyStamp(options.translatedStamp)
    : rawStamp;

  return selectFurthestDestinyStamp(
    currentSessionStamp,
    [translatedStamp, lastVisibleSessionStamp, minimumStamp],
    DESTINY_STAMP_MAX_FORWARD_LEAD,
  );
}

module.exports = {
  resolvePresentedSessionDestinyStamp,
  resolvePendingHistorySafeSessionDestinyStamp,
};
