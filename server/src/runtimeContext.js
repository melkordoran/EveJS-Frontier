"use strict";

function createRuntimeContext(options = {}) {
  const serviceManager = options && options.serviceManager;
  if (!serviceManager || typeof serviceManager !== "object") {
    throw new TypeError("runtime context requires a serviceManager");
  }

  // Freeze the integration boundary, not the manager itself. The manager must
  // remain live as services and bound objects are registered during runtime.
  return Object.freeze({
    serviceManager,
    gatewayRuntime: options.gatewayRuntime || null,
  });
}

module.exports = {
  createRuntimeContext,
};
