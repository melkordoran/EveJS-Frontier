"use strict";

const {
  DESTINY_STAMP_MAX_LEAD,
} = require("../constants");
const {
  advanceNextDestinyStamp,
  getCurrentDestinyStamp,
  hasDestinyStamp,
} = require("./stamps");

function createFallbackDestinyAllocator() {
  let nextFallbackStamp = null;

function getNextStamp(now = Date.now()) {
  const currentStamp = getCurrentDestinyStamp(now);
  if (!hasDestinyStamp(nextFallbackStamp)) {
    nextFallbackStamp = currentStamp;
    return nextFallbackStamp;
  }
  nextFallbackStamp = advanceNextDestinyStamp({
    currentStamp,
    nextStamp: nextFallbackStamp,
    maximumLead: DESTINY_STAMP_MAX_LEAD,
  });
  return nextFallbackStamp;
}

  function reset() {
    nextFallbackStamp = null;
  }

  return {
    getNextStamp,
    reset,
  };
}

module.exports = {
  createFallbackDestinyAllocator,
};
