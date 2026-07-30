"use strict";

function createSessionAlignmentAdapter(options) {
  const resolveSessionAlignedStamp =
    options && typeof options.resolveSessionAlignedStamp === "function"
      ? options.resolveSessionAlignedStamp
      : null;

  return {
    resolveSessionAlignedStamp,
  };
}

module.exports = {
  createSessionAlignmentAdapter,
};
