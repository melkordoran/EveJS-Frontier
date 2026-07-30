"use strict";

const {
  isDeepStrictEqual,
} = require("node:util");

function sameConsecutiveSystemAction(left, right) {
  return Boolean(
    left &&
    right &&
    left.dedupeKey === right.dedupeKey &&
    left.replaceDedupeOrder === right.replaceDedupeOrder &&
    left.refreshStampAtFlush === right.refreshStampAtFlush &&
    isDeepStrictEqual(left.sendOptions, right.sendOptions) &&
    isDeepStrictEqual(left.update, right.update),
  );
}

// Carbon Actions suppresses only the same complete action twice in a row.
// The caller supplies the existing per-session queue, so this helper adds no
// system-history owner or retained state of its own.
function appendSystemHistoryAction(history, entry) {
  if (!Array.isArray(history) || !entry) {
    return false;
  }
  if (
    history.length > 0 &&
    sameConsecutiveSystemAction(history[history.length - 1], entry)
  ) {
    return false;
  }
  history.push(entry);
  return true;
}

// Transfer, rather than copy, the existing queue at the tick/flush boundary.
function takeSystemHistoryActions(owner, property = "updates") {
  if (!owner || !Array.isArray(owner[property])) {
    return [];
  }
  const history = owner[property];
  owner[property] = [];
  return history;
}

module.exports = {
  appendSystemHistoryAction,
  sameConsecutiveSystemAction,
  takeSystemHistoryActions,
};
