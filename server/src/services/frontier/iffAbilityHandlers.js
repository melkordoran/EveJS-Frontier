"use strict";

/**
 * IFF Creation ability handlers.
 *
 * - behavior "iff" + "activate_effect"/"deactivate_effect": starts or stops
 *   the Transponder broadcast. Activation carries the locally saved
 *   iff_channel/iff_code settings; deactivation preserves those settings.
 * - behavior "iff" + ability "iff_reconfigure": validates iff_channel /
 *   iff_code kwargs and updates the selected mode without changing whether
 *   the Transponder is broadcasting.
 * - behavior "iff_beacon" + "activate_effect"/"deactivate_effect": starts or
 *   stops the Transponder Beacon. Activation requires an undocked, in-space
 *   ship; the ship is held stationary through the established
 *   activeModuleEffects immobilizer authority for the authored Dogma
 *   duration (30 s for type 96039) and released on expiry, deactivation, or
 *   any scene teardown.
 *
 * After every accepted state change the same-system sessions receive
 * OnIffMapChanged (clients then refetch beacons/cairns) and refreshed
 * OnIffVerdicts.
 */

const path = require("path");

const log = require(path.join(__dirname, "../../utils/logger"));
const iffRuntime = require(path.join(__dirname, "./iffRuntime"));
const {
  ABILITY_ACTIVATE_EFFECT,
  ABILITY_DEACTIVATE_EFFECT,
  ABILITY_IFF_RECONFIGURE,
  registerCreationAbilityHandler,
} = require(path.join(__dirname, "./creationAbilityRuntime"));
const {
  isCreationModuleOnline,
} = require(path.join(__dirname, "./creationRuntime"));
const { findItemById } = require(path.join(__dirname, "../inventory/itemStore"));

let registered = false;

const IFF_BROADCAST_EFFECT_NAME = "iffBroadcast";
const IFF_BEACON_EFFECT_NAME = "iffBeacon";

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function getSpaceRuntime() {
  return require(path.join(__dirname, "../../space/runtime"));
}

function getSessionRegistry() {
  return require(path.join(__dirname, "../chat/sessionRegistry"));
}

function resolveSessionSolarSystemID(session) {
  return toInt(
    session && (session.solarsystemid2 || session.solarsystemid || session.locationid),
    0,
  );
}

/**
 * Push OnIffMapChanged (and refreshed verdicts) to every live session in the
 * solar system. The client reacts by invalidating its cairn/beacon caches
 * and refetching, so this notification—not the RPC return value—is what
 * makes changes appear without a UI reopen.
 */
function notifyIffMapChanged(solarSystemID, reason = "changed") {
  const numericSystemID = toInt(solarSystemID, 0);
  if (numericSystemID <= 0) {
    return 0;
  }
  let notified = 0;
  const sessionRegistry = getSessionRegistry();
  const sessions = typeof sessionRegistry.getSessions === "function"
    ? sessionRegistry.getSessions()
    : [];
  for (const session of sessions) {
    if (
      !session ||
      typeof session.sendNotification !== "function" ||
      resolveSessionSolarSystemID(session) !== numericSystemID
    ) {
      continue;
    }
    try {
      session.sendNotification("OnIffMapChanged", "clientID", []);
      notified += 1;
    } catch (error) {
      log.warn(
        `[iff] OnIffMapChanged notify failed char=${session.charid || "?"}: ` +
        `${error && error.message ? error.message : error}`,
      );
    }
  }
  log.debug(`[iff] OnIffMapChanged system=${numericSystemID} sessions=${notified} reason=${reason}`);
  return notified;
}

/**
 * Minimal verdict model (documented emulator scope): for each recipient in
 * the system, every other ship with an active transponder on a mutual
 * channel gets a friendly=true verdict when it matches the recipient's own
 * active transponder (same tribe/corporation, or exact code match).
 */
function buildVerdictsForViewer(viewer, shipsInSystem) {
  const verdicts = [];
  for (const other of shipsInSystem) {
    if (toInt(other.shipID, 0) === toInt(viewer.shipID, 0)) {
      continue;
    }
    if (!other.transponder || !viewer.transponder) {
      continue;
    }
    let friendly = false;
    if (
      other.transponder.channel === iffRuntime.IFF_CHANNEL_TRIBE &&
      viewer.transponder.channel === iffRuntime.IFF_CHANNEL_TRIBE
    ) {
      friendly =
        toInt(viewer.corporationID, 0) > 0 &&
        toInt(viewer.corporationID, 0) === toInt(other.corporationID, 0);
    } else if (
      other.transponder.channel === iffRuntime.IFF_CHANNEL_CODE &&
      viewer.transponder.channel === iffRuntime.IFF_CHANNEL_CODE
    ) {
      friendly =
        Boolean(viewer.transponder.code) &&
        viewer.transponder.code === other.transponder.code;
    }
    if (friendly) {
      verdicts.push([toInt(other.shipID, 0), true]);
    }
  }
  return verdicts;
}

function notifyIffVerdicts(solarSystemID) {
  const numericSystemID = toInt(solarSystemID, 0);
  if (numericSystemID <= 0) {
    return 0;
  }
  const sessionRegistry = getSessionRegistry();
  const sessions = (typeof sessionRegistry.getSessions === "function"
    ? sessionRegistry.getSessions()
    : []
  ).filter((session) =>
    session &&
    typeof session.sendNotification === "function" &&
    resolveSessionSolarSystemID(session) === numericSystemID);

  const ships = sessions.map((session) => {
    const shipID = toInt(session.activeShipID || session.shipid || session.shipID, 0);
    const characterID = toInt(session.charid || session.characterID, 0);
    return {
      shipID,
      characterID,
      corporationID: toInt(session.corpid, 0),
      transponder: shipID > 0
        ? iffRuntime.resolveActiveTransponder(characterID, shipID)
        : null,
    };
  });

  let notified = 0;
  for (let index = 0; index < sessions.length; index += 1) {
    const session = sessions[index];
    const verdicts = buildVerdictsForViewer(ships[index], ships);
    try {
      session.sendNotification("OnIffVerdicts", "clientID", [{
        type: "dict",
        entries: verdicts,
      }]);
      notified += 1;
    } catch (error) {
      log.warn(
        `[iff] OnIffVerdicts notify failed char=${session.charid || "?"}: ` +
        `${error && error.message ? error.message : error}`,
      );
    }
  }
  return notified;
}

function notifyIffStateChanged(solarSystemID, reason) {
  notifyIffMapChanged(solarSystemID, reason);
  notifyIffVerdicts(solarSystemID);
}

function scheduleIffStateChanged(solarSystemID, reason) {
  const numericSystemID = toInt(solarSystemID, 0);
  if (numericSystemID <= 0) {
    return false;
  }
  setImmediate(() => notifyIffStateChanged(numericSystemID, reason));
  return true;
}

function resolveInSpaceContext(context) {
  const session = context.session;
  const solarSystemID = resolveSessionSolarSystemID(session);
  const shipID = toInt(context.creationItem && context.creationItem.itemID, 0);
  if (solarSystemID <= 0 || !session || !session._space) {
    return { errorMsg: "SHIP_NOT_IN_SPACE" };
  }
  const runtime = context.dependencies && context.dependencies.spaceRuntime
    ? context.dependencies.spaceRuntime
    : getSpaceRuntime();
  let entity = null;
  try {
    entity = runtime.getEntity(session, shipID);
  } catch (_) {
    entity = null;
  }
  if (!entity || entity.kind !== "ship") {
    return { errorMsg: "SHIP_NOT_IN_SPACE" };
  }
  return { solarSystemID, shipID, entity, runtime };
}

function startIffDogmaEffect(context, moduleItem, effectName, options = {}) {
  const spaceContext = resolveInSpaceContext(context);
  if (spaceContext.errorMsg) {
    return { success: false, errorMsg: spaceContext.errorMsg };
  }
  if (typeof spaceContext.runtime.activateGenericModule !== "function") {
    return { success: false, errorMsg: "DOGMA_EFFECT_RUNTIME_UNAVAILABLE" };
  }

  const activationOptions = {};
  if (Object.prototype.hasOwnProperty.call(options, "repeat")) {
    activationOptions.repeat = options.repeat;
  }
  const activation = spaceContext.runtime.activateGenericModule(
    context.session,
    moduleItem,
    effectName,
    activationOptions,
  );
  if (!activation || activation.success !== true) {
    return activation || { success: false, errorMsg: "DOGMA_EFFECT_START_FAILED" };
  }

  const effectState = activation.data && activation.data.effectState
    ? activation.data.effectState
    : null;
  if (!effectState || toInt(effectState.effectID, 0) <= 0) {
    if (typeof spaceContext.runtime.deactivateGenericModule === "function") {
      spaceContext.runtime.deactivateGenericModule(
        context.session,
        context.moduleItemID,
        { reason: "iff-invalid-effect", deferUntilCycle: false },
      );
    }
    return { success: false, errorMsg: "DOGMA_EFFECT_STATE_MISSING" };
  }

  effectState.iffCreationEffect = true;
  if (options.immobilizesShip === true) {
    effectState.immobilizesShip = true;
    effectState.iffBeaconEffect = true;
    if (typeof spaceContext.runtime.stopShipEntity === "function") {
      spaceContext.runtime.stopShipEntity(spaceContext.entity, {
        reason: IFF_BEACON_EFFECT_NAME,
      });
    }
  }

  return {
    success: true,
    data: {
      activation,
      effectState,
      spaceContext,
    },
  };
}

function stopIffDogmaEffect(context, reason = "iff-deactivated") {
  const runtime = context.dependencies && context.dependencies.spaceRuntime
    ? context.dependencies.spaceRuntime
    : getSpaceRuntime();
  if (!runtime || typeof runtime.deactivateGenericModule !== "function") {
    return { success: false, errorMsg: "DOGMA_EFFECT_RUNTIME_UNAVAILABLE" };
  }
  const result = runtime.deactivateGenericModule(
    context.session,
    context.moduleItemID,
    { reason, deferUntilCycle: false },
  );
  if (
    result &&
    result.success !== true &&
    ["MODULE_NOT_ACTIVE", "NOT_IN_SPACE"].includes(result.errorMsg)
  ) {
    return { success: true, data: { alreadyStopped: true } };
  }
  return result || { success: false, errorMsg: "DOGMA_EFFECT_STOP_FAILED" };
}

function registerIffAbilityHandlers() {
  if (registered) {
    return;
  }
  registered = true;

  registerCreationAbilityHandler(
    iffRuntime.IFF_BEHAVIOR_NAME,
    ABILITY_ACTIVATE_EFFECT,
    {
      validate(context) {
        const configuration = iffRuntime.normalizeIffConfiguration(
          context.kwargs.iff_channel,
          context.kwargs.iff_code,
          iffRuntime.IFF_TRANSPONDER_CHANNELS,
        );
        if (configuration.errorMsg) {
          return { success: false, errorMsg: configuration.errorMsg };
        }
        if (!configuration.channel) {
          return { success: false, errorMsg: "IFF_CHANNEL_REQUIRED" };
        }
        context.transponderConfiguration = configuration;
        return { success: true };
      },
      execute(context) {
        const moduleItem = findItemById(context.moduleItemID);
        if (!moduleItem) {
          return { success: false, errorMsg: "MODULE_NOT_FOUND" };
        }
        if (!isCreationModuleOnline(moduleItem)) {
          return { success: false, errorMsg: "MODULE_OFFLINE" };
        }
        const effectResult = startIffDogmaEffect(
          context,
          moduleItem,
          IFF_BROADCAST_EFFECT_NAME,
        );
        if (!effectResult.success) {
          return effectResult;
        }
        const result = iffRuntime.setTransponderBroadcastState(
          context.moduleItemID,
          true,
          context.transponderConfiguration,
        );
        if (!result || result.success !== true) {
          stopIffDogmaEffect(context, "iff-state-write-failed");
          return result || { success: false, errorMsg: "IFF_WRITE_FAILED" };
        }
        const solarSystemID = effectResult.data.spaceContext.solarSystemID;
        scheduleIffStateChanged(solarSystemID, "transponder-activated");
        log.info(
          `[iff] transponder activated module=${context.moduleItemID} ` +
          `channel=${context.transponderConfiguration.channel} ` +
          `hasCode=${Boolean(context.transponderConfiguration.code)}`,
        );
        return {
          success: true,
          data: { durationMs: effectResult.data.effectState.durationMs },
        };
      },
    },
  );

  registerCreationAbilityHandler(
    iffRuntime.IFF_BEHAVIOR_NAME,
    ABILITY_DEACTIVATE_EFFECT,
    {
      execute(context) {
        const effectResult = stopIffDogmaEffect(
          context,
          "iff-transponder-deactivated",
        );
        if (!effectResult.success) {
          return effectResult;
        }
        const result = iffRuntime.setTransponderBroadcastState(
          context.moduleItemID,
          false,
        );
        if (!result || result.success !== true) {
          return result || { success: false, errorMsg: "IFF_WRITE_FAILED" };
        }
        const solarSystemID = resolveSessionSolarSystemID(context.session);
        if (solarSystemID > 0) {
          scheduleIffStateChanged(solarSystemID, "transponder-deactivated");
        }
        log.info(`[iff] transponder deactivated module=${context.moduleItemID}`);
        return { success: true, data: {} };
      },
    },
  );

  registerCreationAbilityHandler(
    iffRuntime.IFF_BEHAVIOR_NAME,
    ABILITY_IFF_RECONFIGURE,
    {
      execute(context) {
        const configuration = iffRuntime.normalizeIffConfiguration(
          context.kwargs.iff_channel,
          context.kwargs.iff_code,
          iffRuntime.IFF_TRANSPONDER_CHANNELS,
        );
        if (configuration.errorMsg) {
          return { success: false, errorMsg: configuration.errorMsg };
        }
        const writeResult = iffRuntime.writeTransponderState(
          context.moduleItemID,
          configuration,
        );
        if (!writeResult || writeResult.success !== true) {
          return {
            success: false,
            errorMsg: (writeResult && writeResult.errorMsg) || "IFF_WRITE_FAILED",
          };
        }
        const solarSystemID = resolveSessionSolarSystemID(context.session);
        if (solarSystemID > 0) {
          scheduleIffStateChanged(solarSystemID, "transponder-reconfigured");
        }
        log.info(
          `[iff] transponder reconfigured module=${context.moduleItemID} ` +
          `channel=${configuration.channel || "off"} hasCode=${Boolean(configuration.code)}`,
        );
        return { success: true, data: {} };
      },
    },
  );

  registerCreationAbilityHandler(
    iffRuntime.IFF_BEACON_BEHAVIOR_NAME,
    ABILITY_ACTIVATE_EFFECT,
    {
      validate(context) {
        const configuration = iffRuntime.normalizeIffConfiguration(
          context.kwargs.iff_channel,
          context.kwargs.iff_code,
          iffRuntime.IFF_BEACON_CHANNELS,
        );
        if (configuration.errorMsg) {
          return { success: false, errorMsg: configuration.errorMsg };
        }
        if (!configuration.channel) {
          return { success: false, errorMsg: "IFF_CHANNEL_REQUIRED" };
        }
        context.beaconConfiguration = configuration;
        return { success: true };
      },
      execute(context) {
        const moduleItem = findItemById(context.moduleItemID);
        if (!moduleItem) {
          return { success: false, errorMsg: "MODULE_NOT_FOUND" };
        }
        if (!isCreationModuleOnline(moduleItem)) {
          return { success: false, errorMsg: "MODULE_OFFLINE" };
        }
        const effectResult = startIffDogmaEffect(
          context,
          moduleItem,
          IFF_BEACON_EFFECT_NAME,
          { repeat: 0, immobilizesShip: true },
        );
        if (!effectResult.success) {
          return effectResult;
        }
        const { effectState, spaceContext } = effectResult.data;
        const nowMs = Number.isFinite(Number(effectState.startedAtMs))
          ? Number(effectState.startedAtMs)
          : Date.now();
        const durationMs = iffRuntime.resolveBeaconDurationMs(moduleItem.typeID);
        const entityPosition = spaceContext.entity.position || null;
        const startResult = iffRuntime.startBeacon({
          beaconID: context.moduleItemID,
          moduleTypeID: moduleItem.typeID,
          shipID: spaceContext.shipID,
          characterID: context.characterID,
          corporationID: toInt(context.session && context.session.corpid, 0),
          solarSystemID: spaceContext.solarSystemID,
          position: entityPosition
            ? [entityPosition.x, entityPosition.y, entityPosition.z]
            : null,
          channel: context.beaconConfiguration.channel,
          code: context.beaconConfiguration.code,
          durationMs,
          releaseImmobilizer: (reason) => stopIffDogmaEffect(
            context,
            `iff-beacon-${reason || "released"}`,
          ),
          notifyMapChanged: (reason) =>
            scheduleIffStateChanged(spaceContext.solarSystemID, `beacon-${reason}`),
          nowMs,
        });
        if (!startResult.success) {
          stopIffDogmaEffect(context, "iff-beacon-start-failed");
          return startResult;
        }
        scheduleIffStateChanged(spaceContext.solarSystemID, "beacon-activated");
        return { success: true, data: { durationMs } };
      },
    },
  );

  registerCreationAbilityHandler(
    iffRuntime.IFF_BEACON_BEHAVIOR_NAME,
    ABILITY_DEACTIVATE_EFFECT,
    {
      execute(context) {
        const stopResult = iffRuntime.stopBeacon(
          context.moduleItemID,
          "deactivated",
        );
        if (!stopResult.success) {
          return stopResult;
        }
        return { success: true, data: {} };
      },
    },
  );
}

module.exports = {
  buildVerdictsForViewer,
  notifyIffMapChanged,
  notifyIffStateChanged,
  notifyIffVerdicts,
  registerIffAbilityHandlers,
};
