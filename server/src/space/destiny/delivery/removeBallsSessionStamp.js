"use strict";

const {
  MICHELLE_DIRECT_CRITICAL_ECHO_DESTINY_LEAD,
} = require("./michelleContract.js");

function createRemoveBallsSessionStampAdapter({
  scene,
  options,
  explodingNonMissileRemoval,
  terminalDestructionEffectID,
  resolveExplodingNonMissileDestructionSessionStamp,
}) {
  const resolveSessionStamp =
      options && typeof options.resolveSessionStamp === "function"
        ? options.resolveSessionStamp
        : explodingNonMissileRemoval
          ? (session, context = {}) =>
            resolveExplodingNonMissileDestructionSessionStamp(
              scene,
              session,
              context.nowMs,
              context.baseStamp,
            )
        : terminalDestructionEffectID > 0
          // RemoveBalls is still a critical Destiny action, so exploding removals
          // need the same history-safe +1 treatment as other owner-visible
          // critical updates to avoid Michelle rebasing back a tick.
          ? (session, context = {}) =>
            scene.getHistorySafeSessionDestinyStamp(
              session,
              context.nowMs,
              MICHELLE_DIRECT_CRITICAL_ECHO_DESTINY_LEAD,
              MICHELLE_DIRECT_CRITICAL_ECHO_DESTINY_LEAD,
            )
          : null;

  return { resolveSessionStamp };
}

module.exports = {
  createRemoveBallsSessionStampAdapter,
};
