"use strict";

function applyPendingWarpPreSyncCommand(pendingWarp, stamp) {
  pendingWarp.preWarpSyncStamp = stamp;
}

function applyWarpCompletionCorrectionMarkersCommand(
  entity,
  nowMs,
  stamp,
) {
  entity.lastWarpCorrectionBroadcastAt = nowMs;
  entity.lastWarpPositionBroadcastStamp = stamp;
}

module.exports = {
  applyPendingWarpPreSyncCommand,
  applyWarpCompletionCorrectionMarkersCommand,
};
