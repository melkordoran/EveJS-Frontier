"use strict";

const {
  PILOT_WARP_ACTIVATION_DELAY_DESTINY_TICKS,
} = require("./warpContract");
const {
  clonePilotWarpMaxSpeedRamp,
} = require("./warpRamp");
const {
  buildSetMaxSpeedPayload,
} = require("../stream/actions");
const {
  DESTINY_STAMP_MAX_FORWARD_LEAD,
  hasDestinyStamp,
  isDestinyStampAfter,
  normalizeDestinyStamp,
} = require("../delivery/stamps");

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function toFiniteNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function roundNumber(value, digits = 3) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 0;
  }
  const factor = 10 ** Math.max(0, Math.min(12, toInt(digits, 3)));
  return Math.round(numeric * factor) / factor;
}

function resolvePilotWarpPhasePresentation(options = {}) {
  const entity = options.entity;
  const warpState = options.warpState || null;
  if (!entity || !warpState) {
    return { debug: null, sendOptions: null, updates: [] };
  }

  const nowMs = toFiniteNumber(options.nowMs, 0);
  const stamp = normalizeDestinyStamp(options.stamp, 0);
  const maximumForwardLead = Math.max(
    0,
    toInt(options.maximumForwardLead, DESTINY_STAMP_MAX_FORWARD_LEAD),
  );
  const warpCommandStamp = normalizeDestinyStamp(warpState.commandStamp, 0);
  const warpCruiseBumpStamp = hasDestinyStamp(warpState.cruiseBumpStamp)
    ? normalizeDestinyStamp(warpState.cruiseBumpStamp)
    : null;
  const warpEffectStamp = hasDestinyStamp(warpState.effectStamp)
    ? normalizeDestinyStamp(warpState.effectStamp)
    : null;
  const shouldSchedulePilotWarpCruiseBump =
    typeof options.shouldSchedulePilotWarpCruiseBump === "function"
      ? options.shouldSchedulePilotWarpCruiseBump
      : () => false;
  const getPilotWarpCruiseBumpAtMs =
    typeof options.getPilotWarpCruiseBumpAtMs === "function"
      ? options.getPilotWarpCruiseBumpAtMs
      : () => 0;
  const getPilotWarpEffectAtMs =
    typeof options.getPilotWarpEffectAtMs === "function"
      ? options.getPilotWarpEffectAtMs
      : () => 0;
  const warpCruiseBumpAtMs = toFiniteNumber(
    warpState.cruiseBumpAtMs,
    shouldSchedulePilotWarpCruiseBump(warpState)
      ? getPilotWarpCruiseBumpAtMs(warpState)
      : 0,
  );
  const warpEffectAtMs = toFiniteNumber(
    warpState.effectAtMs,
    getPilotWarpEffectAtMs(warpState),
  );
  const pilotMaxSpeedRamp = clonePilotWarpMaxSpeedRamp(
    warpState.pilotMaxSpeedRamp,
  );
  let dueRampIndex = toInt(entity.lastPilotWarpMaxSpeedRampIndex, -1);
  for (
    let index = dueRampIndex + 1;
    index < pilotMaxSpeedRamp.length;
    index += 1
  ) {
    if (nowMs >= toFiniteNumber(pilotMaxSpeedRamp[index].atMs, 0)) {
      dueRampIndex = index;
    } else {
      break;
    }
  }

  const shouldSendCruiseBump =
    hasDestinyStamp(warpCruiseBumpStamp) &&
    isDestinyStampAfter(
      warpCommandStamp,
      warpCruiseBumpStamp,
      maximumForwardLead,
    ) &&
    nowMs >= warpCruiseBumpAtMs &&
    entity.lastPilotWarpCruiseBumpStamp !== warpCruiseBumpStamp;
  const shouldSendEffect =
    hasDestinyStamp(warpEffectStamp) &&
    isDestinyStampAfter(
      warpCommandStamp,
      warpEffectStamp,
      maximumForwardLead,
    ) &&
    nowMs >= warpEffectAtMs &&
    entity.lastPilotWarpEffectStamp !== warpEffectStamp;
  const updates = [];
  let rampDebug = null;
  const previousRampIndex = toInt(entity.lastPilotWarpMaxSpeedRampIndex, -1);
  const foldRampIntoCruise = shouldSendCruiseBump && dueRampIndex > previousRampIndex;

  if (foldRampIntoCruise) {
    entity.lastPilotWarpMaxSpeedRampIndex = dueRampIndex;
  } else if (dueRampIndex > previousRampIndex) {
    const rampEntry = pilotMaxSpeedRamp[dueRampIndex];
    updates.push({
      stamp,
      payload: buildSetMaxSpeedPayload(entity.itemID, rampEntry.speed),
    });
    entity.lastPilotWarpMaxSpeedRampIndex = dueRampIndex;
    rampDebug = {
      index: dueRampIndex,
      label: rampEntry.label,
      speedMs: roundNumber(rampEntry.speed, 3),
      speedAU: roundNumber(
        rampEntry.speed /
          Math.max(1, toFiniteNumber(options.oneAuInMeters, 1)),
        6,
      ),
    };
  }

  if (
    shouldSendCruiseBump &&
    typeof options.buildWarpCruiseMaxSpeedUpdate === "function"
  ) {
    updates.push(options.buildWarpCruiseMaxSpeedUpdate(entity, stamp, warpState));
    entity.lastPilotWarpCruiseBumpStamp = warpCruiseBumpStamp;
  }
  if (
    shouldSendEffect &&
    typeof options.buildWarpStartEffectUpdate === "function"
  ) {
    updates.push(options.buildWarpStartEffectUpdate(entity, stamp));
    entity.lastPilotWarpEffectStamp = warpEffectStamp;
  }

  return {
    debug: updates.length > 0
      ? {
          stamp,
          ramp: rampDebug,
          cruiseBump: shouldSendCruiseBump,
          effect: shouldSendEffect,
        }
      : null,
    sendOptions: updates.length > 0
      ? {
          minimumLeadFromCurrentHistory:
            PILOT_WARP_ACTIVATION_DELAY_DESTINY_TICKS,
          maximumLeadFromCurrentHistory:
            PILOT_WARP_ACTIVATION_DELAY_DESTINY_TICKS,
        }
      : null,
    updates,
  };
}

module.exports = {
  resolvePilotWarpPhasePresentation,
};
