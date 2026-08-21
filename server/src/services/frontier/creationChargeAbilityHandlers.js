"use strict";

const path = require("path");

const {
  ABILITY_RELOAD,
  ABILITY_UNLOAD,
  registerCreationAbilityHandler,
  resolveCreationAbilityHandler,
} = require(path.join(__dirname, "./creationAbilityRuntime"));
const {
  reloadCreationModule,
  unloadCreationModule,
} = require(path.join(__dirname, "./creationChargeRuntime"));

function registerCreationChargeAbilityHandlers() {
  // These are fallback handlers because charge capability is authored by
  // Dogma, not by the Creation behavior name. getCreationModuleAbilities
  // advertises them only for module types with declared charge groups.
  if (!resolveCreationAbilityHandler("__charge_registration_probe__", ABILITY_RELOAD)) {
    registerCreationAbilityHandler("*", ABILITY_RELOAD, {
      execute: reloadCreationModule,
    });
  }
  if (!resolveCreationAbilityHandler("__charge_registration_probe__", ABILITY_UNLOAD)) {
    registerCreationAbilityHandler("*", ABILITY_UNLOAD, {
      execute: unloadCreationModule,
    });
  }
}

module.exports = {
  registerCreationChargeAbilityHandlers,
};
