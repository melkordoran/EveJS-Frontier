"use strict";

const {
  resolvePilotWarpPhasePresentation,
} = require("./pilotWarpPhase");
const {
  DESTINY_STAMP_MAX_FORWARD_LEAD,
  normalizeDestinyStamp,
  selectFurthestDestinyStamp,
} = require("../delivery/stamps");

function handleActiveWarpTickPresentation(options = {}) {
  const entity = options.entity || null;
  const result = options.result || {};
  const nowMs = Number.isFinite(Number(options.nowMs))
    ? Number(options.nowMs)
    : 0;
  const warpState = entity && entity.warpState ? entity.warpState : null;
  const getMovementStamp = typeof options.getMovementStamp === "function"
    ? options.getMovementStamp
    : () => 0;
  const warpCommandStamp = normalizeDestinyStamp(
    warpState && warpState.commandStamp,
    0,
  );
  const requestedMaximumForwardLead = Number(options.maximumForwardLead);
  const maximumForwardLead = Number.isFinite(requestedMaximumForwardLead)
    ? Math.max(0, Math.trunc(requestedMaximumForwardLead))
    : DESTINY_STAMP_MAX_FORWARD_LEAD;
  const warpCorrectionStamp = selectFurthestDestinyStamp(
    warpCommandStamp,
    [normalizeDestinyStamp(getMovementStamp(nowMs), warpCommandStamp)],
    maximumForwardLead,
  );

  let correctionDebug = null;
  const session = entity && entity.session ? entity.session : null;
  const isReadyForDestiny = typeof options.isReadyForDestiny === "function"
    ? options.isReadyForDestiny
    : () => false;
  if (!result.warpCompleted && session && isReadyForDestiny(session)) {
    const pilotWarpPhase = resolvePilotWarpPhasePresentation({
      entity,
      warpState,
      nowMs,
      stamp: warpCorrectionStamp,
      maximumForwardLead,
      shouldSchedulePilotWarpCruiseBump:
        options.shouldSchedulePilotWarpCruiseBump,
      getPilotWarpCruiseBumpAtMs: options.getPilotWarpCruiseBumpAtMs,
      getPilotWarpEffectAtMs: options.getPilotWarpEffectAtMs,
      buildWarpCruiseMaxSpeedUpdate: options.buildWarpCruiseMaxSpeedUpdate,
      buildWarpStartEffectUpdate: options.buildWarpStartEffectUpdate,
      oneAuInMeters: options.oneAuInMeters,
    });
    if (
      pilotWarpPhase.updates.length > 0 &&
      Array.isArray(options.sessionOnlyUpdates)
    ) {
      options.sessionOnlyUpdates.push({
        session,
        updates: pilotWarpPhase.updates,
        sendOptions: pilotWarpPhase.sendOptions,
      });
      if (typeof options.logWarpDebug === "function") {
        options.logWarpDebug("warp.pilot.phase", entity, pilotWarpPhase.debug);
      }
    }
    if (typeof options.resolveWatcherCorrectionDispatch === "function") {
      correctionDebug = options.resolveWatcherCorrectionDispatch({
        entity,
        result,
        now: nowMs,
        sessionOnlyUpdates: options.sessionOnlyUpdates,
        watcherOnlyUpdates: options.watcherOnlyUpdates,
      });
    }
  }

  if (entity && entity.lastWarpDiagnosticStamp !== warpCorrectionStamp) {
    if (typeof options.logWarpDebug === "function") {
      options.logWarpDebug("warp.progress", entity, {
        stamp: warpCorrectionStamp,
      });
    }
    entity.lastWarpDiagnosticStamp = warpCorrectionStamp;
  }

  return {
    correctionDebug,
    warpCorrectionStamp,
  };
}

module.exports = {
  handleActiveWarpTickPresentation,
};
