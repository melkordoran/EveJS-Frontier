const {
  MICHELLE_DIRECT_CRITICAL_ECHO_DESTINY_LEAD,
  MICHELLE_HELD_FUTURE_DESTINY_LEAD,
  MICHELLE_POST_HELD_FUTURE_DESTINY_LEAD,
} = require("./michelleContract.js");
const {
  DESTINY_STAMP_MAX_FORWARD_LEAD,
  normalizeDestinyStamp,
  selectFurthestDestinyStamp,
} = require("./stamps.js");

function createExplodingDestructionStampAdapter({
  isReadyForDestiny,
  toFiniteNumber,
}) {
function resolveExplodingNonMissileDestructionSessionStamp(
  scene,
  session,
  nowMs,
  baseStamp = null,
) {
  if (!scene || !session || !isReadyForDestiny(session)) {
    return 0;
  }
  const resolvedNowMs = toFiniteNumber(
    nowMs,
    typeof scene.getCurrentSimTimeMs === "function"
      ? scene.getCurrentSimTimeMs()
      : 0,
  );
  const resolvedBaseStamp = normalizeDestinyStamp(
    baseStamp === null || baseStamp === undefined
      ? (
          typeof scene.getCurrentDestinyStamp === "function"
            ? scene.getCurrentDestinyStamp(resolvedNowMs)
            : 0
        )
      : baseStamp,
    0,
  );
  return selectFurthestDestinyStamp(
    resolvedBaseStamp,
    [
      scene.getHistorySafeSessionDestinyStamp(
        session,
        resolvedNowMs,
        MICHELLE_HELD_FUTURE_DESTINY_LEAD -
          MICHELLE_DIRECT_CRITICAL_ECHO_DESTINY_LEAD,
        MICHELLE_HELD_FUTURE_DESTINY_LEAD -
          MICHELLE_DIRECT_CRITICAL_ECHO_DESTINY_LEAD,
      ),
      scene.getCurrentPresentedSessionDestinyStamp(
        session,
        resolvedNowMs,
        MICHELLE_POST_HELD_FUTURE_DESTINY_LEAD,
      ),
    ],
    DESTINY_STAMP_MAX_FORWARD_LEAD,
  );
}

  return {
    resolveExplodingNonMissileDestructionSessionStamp,
  };
}

module.exports = {
  createExplodingDestructionStampAdapter,
};
