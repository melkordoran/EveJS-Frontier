"use strict";

const {
  buildPackagedRemoveBallsUpdate,
} = require("../batching/parkUpdateBatcher");
const {
  normalizeDestinyStamp,
} = require("../delivery/stamps");
const {
  normalizeEntityID,
} = require("../identity/entityID");
const {
  buildTerminalPlayDestructionEffectPayload,
} = require("../stream/actions");

function normalizeEntityIDs(entityIDs) {
  return (Array.isArray(entityIDs) ? entityIDs : [])
    .map((entityID) => normalizeEntityID(entityID))
    .filter((entityID) => entityID !== null);
}

function resolvePresentationStamp(options = {}) {
  if (options.stampOverride !== undefined && options.stampOverride !== null) {
    return normalizeDestinyStamp(options.stampOverride, 0);
  }
  return typeof options.getDefaultStamp === "function"
    ? normalizeDestinyStamp(options.getDefaultStamp(), 0)
    : 0;
}

function buildRemoveBallsPresentationUpdates(options = {}) {
  const destiny = options.destiny;
  if (!destiny || typeof destiny.buildRemoveBallsPayload !== "function") {
    throw new TypeError(
      "buildRemoveBallsPresentationUpdates requires buildRemoveBallsPayload",
    );
  }

  const entityIDs = normalizeEntityIDs(options.entityIDs);
  if (entityIDs.length === 0) {
    return [];
  }

  const stamp = resolvePresentationStamp(options);
  if (options.packagedBubbleHistory === true) {
    return [buildPackagedRemoveBallsUpdate(stamp, entityIDs)];
  }
  return [{
    stamp,
    payload: destiny.buildRemoveBallsPayload(entityIDs),
  }];
}

function buildTerminalDestructionRemoveBallsPresentationUpdates(options = {}) {
  const removeBallsUpdates = buildRemoveBallsPresentationUpdates(options);
  if (removeBallsUpdates.length === 0) {
    return [];
  }

  const terminalDestructionEffectID = Number(options.terminalDestructionEffectID);
  if (
    !Number.isFinite(terminalDestructionEffectID) ||
    Math.trunc(terminalDestructionEffectID) <= 0
  ) {
    return removeBallsUpdates;
  }

  return [
    {
      stamp: removeBallsUpdates[0].stamp,
      payload: buildTerminalPlayDestructionEffectPayload(
        normalizeEntityIDs(options.entityIDs)[0],
        terminalDestructionEffectID,
      ),
    },
    ...removeBallsUpdates,
  ];
}

module.exports = {
  buildRemoveBallsPresentationUpdates,
  buildTerminalDestructionRemoveBallsPresentationUpdates,
};
