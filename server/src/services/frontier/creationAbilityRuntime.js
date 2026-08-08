"use strict";

/**
 * Behavior-aware Creation module ability registry and dispatch.
 *
 * Client contract (build 3455996 bytecode):
 * - `creation.activate_ability(creation_id, module_item_id, str(ability_id),
 *   **params)` — ability parameters arrive as keyword arguments.
 * - AbilityId values are strings ("online", "offline", "activate_effect",
 *   "deactivate_effect", "directional_scan", "iff_reconfigure", ...). The
 *   client gates its calls on the per-module `abilities` list served in
 *   get_creation, and `ModuleActionProvider._require_ability` rejects
 *   anything not advertised.
 * - Successful abilities return a dict; the client reads `server_time` and,
 *   for directional scans, `scan_response`.
 *
 * Handlers register per (behavior, ability). Advertisement derives from this
 * registry: a behavior ability is only advertised when a handler is
 * registered for it, so the server can never advertise an ability it cannot
 * execute. online/offline remain driven by Dogma online effect 16 and use
 * the shared fallback handlers.
 */

const path = require("path");

const log = require(path.join(__dirname, "../../utils/logger"));
const { getCreationModule } = require(path.join(__dirname, "./creationStaticData"));

const ABILITY_ONLINE = "online";
const ABILITY_OFFLINE = "offline";
const ABILITY_ACTIVATE_EFFECT = "activate_effect";
const ABILITY_DEACTIVATE_EFFECT = "deactivate_effect";
const ABILITY_DIRECTIONAL_SCAN = "directional_scan";
const ABILITY_IFF_RECONFIGURE = "iff_reconfigure";
const ABILITY_DEPLOY = "deploy";

// (behaviorName -> Map(abilityId -> handler)). Fallback handlers (online/
// offline) live under the "*" behavior key and apply to every module whose
// type carries the Dogma online effect.
const handlersByBehavior = new Map();

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function getModuleBehaviorName(typeID) {
  const module = getCreationModule(typeID);
  const behavior = module && typeof module.behavior === "string"
    ? module.behavior.trim()
    : "";
  return behavior || "generic";
}

function normalizeAbilityId(value) {
  return String(value || "").trim().toLowerCase();
}

function registerCreationAbilityHandler(behaviorName, abilityId, handler) {
  const behaviorKey = String(behaviorName || "").trim() || "*";
  const normalizedAbility = normalizeAbilityId(abilityId);
  if (!normalizedAbility || !handler || typeof handler.execute !== "function") {
    throw new Error(
      `Invalid creation ability handler registration ${behaviorKey}:${normalizedAbility}`,
    );
  }
  if (!handlersByBehavior.has(behaviorKey)) {
    handlersByBehavior.set(behaviorKey, new Map());
  }
  handlersByBehavior.get(behaviorKey).set(normalizedAbility, handler);
}

function getRegisteredBehaviorAbilities(behaviorName) {
  const handlers = handlersByBehavior.get(String(behaviorName || "").trim());
  return handlers ? [...handlers.keys()] : [];
}

function resolveCreationAbilityHandler(behaviorName, abilityId) {
  const normalizedAbility = normalizeAbilityId(abilityId);
  const behaviorHandlers = handlersByBehavior.get(
    String(behaviorName || "").trim(),
  );
  if (behaviorHandlers && behaviorHandlers.has(normalizedAbility)) {
    return behaviorHandlers.get(normalizedAbility);
  }
  const fallbackHandlers = handlersByBehavior.get("*");
  return fallbackHandlers ? fallbackHandlers.get(normalizedAbility) || null : null;
}

/**
 * Dispatch a validated ability invocation. The caller (creationService) has
 * already resolved the owned Creation; this validates the module membership,
 * advertised-ability agreement, ability arguments, and executes the handler.
 *
 * Returns { success, data? , errorMsg?, params? }.
 */
function dispatchCreationAbility({
  ability,
  kwargs,
  session,
  creationContext,
  moduleItemID,
  abilityDependencies,
}) {
  const normalizedAbility = normalizeAbilityId(ability);
  if (!normalizedAbility) {
    return { success: false, errorMsg: "ABILITY_EMPTY" };
  }
  const state = creationContext && creationContext.state;
  const moduleEntry = state && Array.isArray(state.modules)
    ? state.modules.find((entry) => toInt(entry && entry.itemID, 0) === toInt(moduleItemID, 0))
    : null;
  if (!moduleEntry) {
    return { success: false, errorMsg: "MODULE_NOT_IN_CREATION" };
  }
  const advertisedAbilities = Array.isArray(moduleEntry.abilities)
    ? moduleEntry.abilities
    : [];
  if (!advertisedAbilities.includes(normalizedAbility)) {
    return {
      success: false,
      errorMsg: "ABILITY_NOT_ADVERTISED",
      params: { advertised: advertisedAbilities },
    };
  }

  const behaviorName = getModuleBehaviorName(moduleEntry.typeID);
  const handler = resolveCreationAbilityHandler(behaviorName, normalizedAbility);
  if (!handler) {
    // Advertisement derives from the registry, so this indicates a race or a
    // stale snapshot rather than a normal client request.
    return { success: false, errorMsg: "ABILITY_HANDLER_MISSING" };
  }

  const context = {
    ability: normalizedAbility,
    behaviorName,
    creationItem: creationContext.item,
    characterID: creationContext.characterID,
    moduleEntry,
    moduleItemID: toInt(moduleItemID, 0),
    kwargs: kwargs && typeof kwargs === "object" ? kwargs : {},
    session: session || null,
    dependencies: abilityDependencies || {},
  };

  if (typeof handler.validate === "function") {
    const validation = handler.validate(context);
    if (validation && validation.success === false) {
      return validation;
    }
  }

  try {
    return handler.execute(context);
  } catch (error) {
    log.warn(
      `[creationAbility] ${behaviorName}:${normalizedAbility} handler failed ` +
      `module=${context.moduleItemID}: ${error && error.message ? error.message : error}`,
    );
    if (error && error.isClientVisible === true) {
      throw error;
    }
    return { success: false, errorMsg: "ABILITY_EXECUTION_FAILED" };
  }
}

function resetCreationAbilityHandlersForTests() {
  handlersByBehavior.clear();
}

module.exports = {
  ABILITY_ACTIVATE_EFFECT,
  ABILITY_DEACTIVATE_EFFECT,
  ABILITY_DEPLOY,
  ABILITY_DIRECTIONAL_SCAN,
  ABILITY_IFF_RECONFIGURE,
  ABILITY_OFFLINE,
  ABILITY_ONLINE,
  dispatchCreationAbility,
  getModuleBehaviorName,
  getRegisteredBehaviorAbilities,
  normalizeAbilityId,
  registerCreationAbilityHandler,
  resolveCreationAbilityHandler,
  resetCreationAbilityHandlersForTests,
};
