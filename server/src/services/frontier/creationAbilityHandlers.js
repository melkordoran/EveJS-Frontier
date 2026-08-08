"use strict";

/**
 * Fallback Creation ability handlers shared by every module behavior:
 * online/offline map onto the existing Creation module online state flow
 * (Dogma online effect 16), preserving the pre-framework behavior exactly.
 * Behavior-specific handlers (IFF, beacon, directional scan) register from
 * their own runtime modules.
 */

const path = require("path");

const {
  ABILITY_OFFLINE,
  ABILITY_ONLINE,
  registerCreationAbilityHandler,
} = require(path.join(__dirname, "./creationAbilityRuntime"));
const {
  setCreationModuleOnlineState,
} = require(path.join(__dirname, "./creationRuntime"));

let registered = false;

function registerFallbackCreationAbilityHandlers() {
  if (registered) {
    return;
  }
  registered = true;

  const buildOnlineHandler = (online) => ({
    execute(context) {
      const result = setCreationModuleOnlineState(
        context.creationItem,
        context.characterID,
        context.moduleItemID,
        online,
        context.session,
      );
      if (!result.success) {
        return { success: false, errorMsg: result.errorMsg || "ONLINE_STATE_FAILED" };
      }
      return {
        success: true,
        data: { serverTime: result.data.serverTime },
      };
    },
  });

  registerCreationAbilityHandler("*", ABILITY_ONLINE, buildOnlineHandler(true));
  registerCreationAbilityHandler("*", ABILITY_OFFLINE, buildOnlineHandler(false));
}

module.exports = {
  registerFallbackCreationAbilityHandlers,
};
