"use strict";

// Carbon's BaseTicker/Ticker owns the ordering between bubble reconciliation
// and the Park post-tick send. eve.js applies gameplay actions directly during
// its existing scene tick, so this adapter owns only that shared ordering seam.
// Runtime supplies the work and remains the scene orchestrator.
function runDestinyPostTick(options = {}) {
  const updateBubbles = options.updateBubbles;
  const afterBubbleUpdate = typeof options.afterBubbleUpdate === "function"
    ? options.afterBubbleUpdate
    : null;
  const flushParkHistories = options.flushParkHistories;

  if (typeof updateBubbles !== "function") {
    throw new TypeError("updateBubbles must be a function");
  }
  if (typeof flushParkHistories !== "function") {
    throw new TypeError("flushParkHistories must be a function");
  }

  const bubbleResult = updateBubbles();
  if (afterBubbleUpdate) {
    afterBubbleUpdate(bubbleResult);
  }
  return flushParkHistories();
}

module.exports = {
  runDestinyPostTick,
};
