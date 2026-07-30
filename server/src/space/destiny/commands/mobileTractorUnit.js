"use strict";

const {
  applyTractorActivationCommand,
} = require("./tractorBeam.js");
const {
  buildOnSpecialFXPayload,
} = require("../stream/actions");

function captureMobileTractorUnitPresentation({
  scene,
  nowMs,
} = {}) {
  if (scene && typeof scene.getMovementStamp === "function") {
    return scene.getMovementStamp(nowMs);
  }
  if (scene && typeof scene.getCurrentDestinyStamp === "function") {
    return scene.getCurrentDestinyStamp();
  }
  return 0;
}

function applyMobileTractorUnitTractorStartCommand({
  sourceEntity,
  targetEntity,
  tractorSpeedMetersPerSecond,
  followRangeMeters,
  effectGuid,
  effectDurationMs,
  effectRepeat,
  effectStartTime,
} = {}) {
  const activationCommand = applyTractorActivationCommand({
    sourceEntity,
    targetEntity,
    tractorSpeedMetersPerSecond,
    followRangeMeters,
  });
  if (!activationCommand.applied) {
    return { applied: false, buildPresentationUpdates: () => [] };
  }

  return {
    applied: true,
    buildPresentationUpdates({ stamp } = {}) {
      return [
        {
          stamp,
          payload: buildOnSpecialFXPayload(sourceEntity.itemID, effectGuid, {
            moduleID: sourceEntity.itemID,
            moduleTypeID: sourceEntity.typeID,
            targetID: targetEntity.itemID,
            isOffensive: false,
            start: true,
            active: true,
            duration: effectDurationMs,
            repeat: effectRepeat,
            startTime: effectStartTime,
            timeFromStart: 0,
          }),
        },
        ...activationCommand.buildPresentationUpdates({ stamp }),
      ];
    },
  };
}

module.exports = {
  captureMobileTractorUnitPresentation,
  applyMobileTractorUnitTractorStartCommand,
};
