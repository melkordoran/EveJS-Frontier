"use strict";

const path = require("path");

const log = require(path.join(__dirname, "../../utils/logger"));

const FILETIME_TICKS_PER_MS = 10000n;
const FILETIME_EPOCH_OFFSET = 116444736000000000n;
const DEFAULT_COUNTDOWN_SECONDS = 30;
const DEFAULT_RECHECK_INTERVAL_MS = 250;
const SAFE_LOGOFF_COMPLETION_MAX_AGE_MS = 60_000;

const SAFE_LOGOFF_CONDITION_LABELS = Object.freeze({
  SHIP_IN_WARP: "UI/Inflight/SafeLogoff/ConditionShipInWarp",
  SHIP_MOVING:
    "UI/Inflight/SafeLogoff/ConditionShipOrbitingOrKeepingAtRange",
  PVP_TIMER: "UI/Inflight/SafeLogoff/ConditionPvpTimer",
  PVE_TIMER: "UI/Inflight/SafeLogoff/ConditionPveTimer",
  TARGET_LOCK: "UI/Inflight/SafeLogoff/ConditionTargetLock",
  TARGET_LOCKED: "UI/Inflight/SafeLogoff/ConditionTargetLocked",
  DRONES_CONNECTED: "UI/Inflight/SafeLogoff/ConditionDronesConnected",
  ACTIVE_MODULES: "UI/Inflight/SafeLogoff/ConditionActiveModules",
  ACTIVE_PROBES: "UI/Inflight/SafeLogoff/ConditionActiveProbes",
  CLOAKED: "UI/Inflight/SafeLogoff/ConditionCloaked",
  IN_FLEET: "UI/Inflight/SafeLogoff/ConditionInFleet",
  DOCKING: "UI/Inflight/SafeLogoff/ConditionDocking",
  WEAPONS_TIMER: "UI/Inflight/SafeLogoff/ConditionWeaponsTimer",
  SELF_DESTRUCT: "UI/Inflight/SafeLogoff/ConditionSelfDestruct",
  INVULNERABLE: "UI/Inflight/SafeLogoff/ConditionIsInvulnerable",
  FIGHTERS_IN_SPACE: "UI/Inflight/SafeLogoff/ConditionFightersInSpace",
});

const SAFE_LOGOFF_ABORT_LABELS = Object.freeze({
  SHIP_TARGETING: "UI/Inflight/SafeLogoff/AbortShipTargeting",
  SHIP_TARGETED: "UI/Inflight/SafeLogoff/AbortShipTargeted",
  MODULE_ACTIVATED: "UI/Inflight/SafeLogoff/AbortModuleActivated",
  DRONES_CONNECTED: "UI/Inflight/SafeLogoff/AbortDronesConnected",
  IN_FLEET: "UI/Inflight/SafeLogoff/AbortInFleet",
  SHIP_MOVEMENT: "UI/Inflight/SafeLogoff/AbortShipMovement",
  SHIP_WARPING: "UI/Inflight/SafeLogoff/AbortShipWarping",
  SHIP_NOT_IN_SPACE: "UI/Inflight/SafeLogoff/AbortShipNotInSpace",
  PVP_TIMER: "UI/Inflight/SafeLogoff/AbortPvpTimer",
  NPC_TIMER: "UI/Inflight/SafeLogoff/AbortNpcTimer",
  SELF_DESTRUCT: "UI/Inflight/SafeLogoff/AbortSelfDestruct",
  FIGHTERS_IN_SPACE: "UI/Inflight/SafeLogoff/AbortFightersInSpace",
});

const ABORT_LABEL_BY_CONDITION = Object.freeze({
  [SAFE_LOGOFF_CONDITION_LABELS.SHIP_IN_WARP]:
    SAFE_LOGOFF_ABORT_LABELS.SHIP_WARPING,
  [SAFE_LOGOFF_CONDITION_LABELS.SHIP_MOVING]:
    SAFE_LOGOFF_ABORT_LABELS.SHIP_MOVEMENT,
  [SAFE_LOGOFF_CONDITION_LABELS.PVP_TIMER]:
    SAFE_LOGOFF_ABORT_LABELS.PVP_TIMER,
  [SAFE_LOGOFF_CONDITION_LABELS.PVE_TIMER]:
    SAFE_LOGOFF_ABORT_LABELS.NPC_TIMER,
  [SAFE_LOGOFF_CONDITION_LABELS.WEAPONS_TIMER]:
    SAFE_LOGOFF_ABORT_LABELS.PVP_TIMER,
  [SAFE_LOGOFF_CONDITION_LABELS.TARGET_LOCK]:
    SAFE_LOGOFF_ABORT_LABELS.SHIP_TARGETING,
  [SAFE_LOGOFF_CONDITION_LABELS.TARGET_LOCKED]:
    SAFE_LOGOFF_ABORT_LABELS.SHIP_TARGETED,
  [SAFE_LOGOFF_CONDITION_LABELS.DRONES_CONNECTED]:
    SAFE_LOGOFF_ABORT_LABELS.DRONES_CONNECTED,
  [SAFE_LOGOFF_CONDITION_LABELS.ACTIVE_MODULES]:
    SAFE_LOGOFF_ABORT_LABELS.MODULE_ACTIVATED,
  [SAFE_LOGOFF_CONDITION_LABELS.IN_FLEET]:
    SAFE_LOGOFF_ABORT_LABELS.IN_FLEET,
  [SAFE_LOGOFF_CONDITION_LABELS.DOCKING]:
    SAFE_LOGOFF_ABORT_LABELS.SHIP_MOVEMENT,
  [SAFE_LOGOFF_CONDITION_LABELS.SELF_DESTRUCT]:
    SAFE_LOGOFF_ABORT_LABELS.SELF_DESTRUCT,
  [SAFE_LOGOFF_CONDITION_LABELS.FIGHTERS_IN_SPACE]:
    SAFE_LOGOFF_ABORT_LABELS.FIGHTERS_IN_SPACE,
});

let activeSafeLogoffs = new WeakMap();

function toPositiveInt(value, fallback = 0) {
  const numeric = Math.trunc(Number(value));
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
}

function toFiniteNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function collectionSize(value) {
  if (
    value instanceof Map ||
    value instanceof Set ||
    Array.isArray(value)
  ) {
    return value.size ?? value.length;
  }
  return 0;
}

function getRuntimeConfig(options = {}) {
  if (options.runtimeConfig && typeof options.runtimeConfig === "object") {
    return options.runtimeConfig;
  }
  const config = require(path.join(__dirname, "../../config"));
  if (typeof config.getConfigStateSnapshot === "function") {
    try {
      return config.getConfigStateSnapshot().resolvedConfig || config;
    } catch (_) {}
  }
  return config;
}

function isSafeLogoffEnabled(options = {}) {
  return getRuntimeConfig(options).safeLogoffEnabled !== false;
}

function resolveCharacterID(session) {
  return toPositiveInt(
    session && (session.characterID || session.charID || session.charid),
    0,
  );
}

function resolveActiveSpaceShipID(session, options = {}) {
  const { entity } = resolveSpaceContext(session, options);
  return entity && entity.kind === "ship"
    ? toPositiveInt(entity.itemID, 0)
    : 0;
}

function clearSafeLogoffCompletion(session) {
  if (!session || typeof session !== "object") {
    return false;
  }
  const hadCompletion = Boolean(
    session._safeLogoffCompletion || session._safeLogoffCompletedAtMs,
  );
  delete session._safeLogoffCompletion;
  // Remove the pre-scoped marker as well so a session upgraded in place cannot
  // accidentally suppress emergency warp for its next selected character.
  delete session._safeLogoffCompletedAtMs;
  return hadCompletion;
}

function markSafeLogoffCompletion(session, values = {}) {
  if (!session || typeof session !== "object") {
    return null;
  }
  const characterID = toPositiveInt(values.characterID, 0);
  const shipID = toPositiveInt(values.shipID, 0);
  const completedAtMs = Math.max(0, toFiniteNumber(values.completedAtMs, 0));
  clearSafeLogoffCompletion(session);
  if (!characterID || !shipID || !completedAtMs) {
    return null;
  }
  session._safeLogoffCompletion = {
    characterID,
    shipID,
    completedAtMs,
  };
  return { ...session._safeLogoffCompletion };
}

function getSafeLogoffCompletion(session) {
  const completion = session && session._safeLogoffCompletion;
  if (!completion || typeof completion !== "object") {
    return null;
  }
  const characterID = toPositiveInt(completion.characterID, 0);
  const shipID = toPositiveInt(completion.shipID, 0);
  const completedAtMs = Math.max(
    0,
    toFiniteNumber(completion.completedAtMs, 0),
  );
  if (!characterID || !shipID || !completedAtMs) {
    return null;
  }
  return { characterID, shipID, completedAtMs };
}

function consumeSafeLogoffCompletion(session, expected = {}) {
  const completion = getSafeLogoffCompletion(session);
  // Consumption is one-shot even when the token is malformed, expired, or
  // belongs to a different character. A stale token must never be reconsidered
  // by a later character using the same transport session.
  clearSafeLogoffCompletion(session);
  if (!completion) {
    return null;
  }

  const characterID = toPositiveInt(expected.characterID, 0);
  const shipID = toPositiveInt(expected.shipID, 0);
  const nowMs = Math.max(
    0,
    toFiniteNumber(
      expected.nowMs,
      typeof expected.now === "function" ? expected.now() : Date.now(),
    ),
  );
  const ageMs = nowMs - completion.completedAtMs;
  if (
    !characterID ||
    !shipID ||
    completion.characterID !== characterID ||
    completion.shipID !== shipID ||
    ageMs < 0 ||
    ageMs > SAFE_LOGOFF_COMPLETION_MAX_AGE_MS
  ) {
    return null;
  }
  return completion;
}

function resolveSpaceContext(session, options = {}) {
  const spaceRuntime = options.spaceRuntime || require(path.join(
    __dirname,
    "../../space/runtime",
  ));
  const scene =
    spaceRuntime && typeof spaceRuntime.getSceneForSession === "function"
      ? spaceRuntime.getSceneForSession(session)
      : null;
  const entity = scene && typeof scene.getShipEntityForSession === "function"
    ? scene.getShipEntityForSession(session)
    : scene && typeof scene.getEntityByID === "function"
      ? scene.getEntityByID(
          toPositiveInt(session && session._space && session._space.shipID, 0),
        )
      : null;
  return { scene, entity };
}

function getCrimewatchState(characterID, nowMs, options = {}) {
  const crimewatchState = options.crimewatchState || require(path.join(
    __dirname,
    "../security/crimewatchState",
  ));
  return crimewatchState &&
    typeof crimewatchState.getCharacterCrimewatchState === "function"
    ? crimewatchState.getCharacterCrimewatchState(characterID, nowMs)
    : null;
}

function isCharacterInFleet(session, characterID, options = {}) {
  if (toPositiveInt(session && (session.fleetid || session.fleetID), 0) > 0) {
    return true;
  }
  const fleetRuntime = options.fleetRuntime || require(path.join(
    __dirname,
    "../fleets/fleetRuntime",
  ));
  return Boolean(
    fleetRuntime &&
    typeof fleetRuntime.getFleetForCharacter === "function" &&
    fleetRuntime.getFleetForCharacter(characterID),
  );
}

function isCharacterInvulnerable(characterID, options = {}) {
  const npcControlState = options.npcControlState || require(path.join(
    __dirname,
    "../../space/npc/npcControlState",
  ));
  return Boolean(
    npcControlState &&
    typeof npcControlState.isCharacterInvulnerable === "function" &&
    npcControlState.isCharacterInvulnerable(characterID),
  );
}

function entityBelongsToPilot(entity, characterID, shipID) {
  if (!entity) {
    return false;
  }
  const controllerID = toPositiveInt(
    entity.controllerID || entity.launcherID,
    0,
  );
  const controllerOwnerID = toPositiveInt(entity.controllerOwnerID, 0);
  const ownerID = toPositiveInt(entity.ownerID || entity.characterID, 0);
  return (
    (shipID > 0 && controllerID === shipID) ||
    controllerOwnerID === characterID ||
    ownerID === characterID
  );
}

function hasControlledEntity(scene, kind, characterID, shipID) {
  if (!scene || !(scene.dynamicEntities instanceof Map)) {
    return false;
  }
  for (const candidate of scene.dynamicEntities.values()) {
    if (
      candidate &&
      candidate.kind === kind &&
      entityBelongsToPilot(candidate, characterID, shipID)
    ) {
      return true;
    }
  }
  return false;
}

function hasActiveSelfDestruct(entity, nowMs) {
  const value = entity && (
    entity.selfDestructAtMs ||
    entity.selfDestructTime ||
    entity.selfDestructTimestamp
  );
  if (value === null || value === undefined) {
    return false;
  }
  try {
    const raw = BigInt(value);
    if (raw > FILETIME_EPOCH_OFFSET) {
      const unixMs = Number((raw - FILETIME_EPOCH_OFFSET) / FILETIME_TICKS_PER_MS);
      return Number.isFinite(unixMs) && unixMs > nowMs;
    }
  } catch (_) {}
  return toFiniteNumber(value, 0) > nowMs;
}

function evaluateSafeLogoffConditions(session, options = {}) {
  const characterID = resolveCharacterID(session);
  const nowMs = Math.max(
    0,
    toFiniteNumber(
      options.nowMs,
      typeof options.now === "function" ? options.now() : Date.now(),
    ),
  );
  const { scene, entity } = resolveSpaceContext(session, options);
  if (!characterID || !scene || !entity || entity.kind !== "ship") {
    return [SAFE_LOGOFF_CONDITION_LABELS.DOCKING];
  }

  const failed = [];
  const add = (label) => {
    if (label && !failed.includes(label)) {
      failed.push(label);
    }
  };
  const mode = String(entity.mode || "STOP").toUpperCase();

  if (mode === "WARP" || entity.pendingWarp) {
    add(SAFE_LOGOFF_CONDITION_LABELS.SHIP_IN_WARP);
  } else if (
    mode === "GOTO" ||
    mode === "FOLLOW" ||
    mode === "ORBIT" ||
    entity.manualFlightActive === true
  ) {
    add(SAFE_LOGOFF_CONDITION_LABELS.SHIP_MOVING);
  }
  if (entity.pendingDock || toPositiveInt(entity.dockingTargetID, 0) > 0) {
    add(SAFE_LOGOFF_CONDITION_LABELS.DOCKING);
  }

  const crimewatch = getCrimewatchState(characterID, nowMs, options);
  if (crimewatch) {
    if (toFiniteNumber(crimewatch.pvpTimerExpiresAtMs, 0) > nowMs) {
      add(SAFE_LOGOFF_CONDITION_LABELS.PVP_TIMER);
    }
    if (toFiniteNumber(crimewatch.npcTimerExpiresAtMs, 0) > nowMs) {
      add(SAFE_LOGOFF_CONDITION_LABELS.PVE_TIMER);
    }
    if (toFiniteNumber(crimewatch.weaponTimerExpiresAtMs, 0) > nowMs) {
      add(SAFE_LOGOFF_CONDITION_LABELS.WEAPONS_TIMER);
    }
  }

  if (
    collectionSize(entity.lockedTargets) > 0 ||
    collectionSize(entity.pendingTargetLocks) > 0
  ) {
    add(SAFE_LOGOFF_CONDITION_LABELS.TARGET_LOCK);
  }
  if (collectionSize(entity.targetedBy) > 0) {
    add(SAFE_LOGOFF_CONDITION_LABELS.TARGET_LOCKED);
  }

  const shipID = toPositiveInt(entity.itemID, 0);
  if (hasControlledEntity(scene, "drone", characterID, shipID)) {
    add(SAFE_LOGOFF_CONDITION_LABELS.DRONES_CONNECTED);
  }
  if (collectionSize(entity.activeModuleEffects) > 0) {
    add(SAFE_LOGOFF_CONDITION_LABELS.ACTIVE_MODULES);
  }
  if (hasControlledEntity(scene, "probe", characterID, shipID)) {
    add(SAFE_LOGOFF_CONDITION_LABELS.ACTIVE_PROBES);
  }
  if (
    entity.cloaked === true ||
    toFiniteNumber(entity.isCloaked ?? entity.cloakMode, 0) > 0
  ) {
    add(SAFE_LOGOFF_CONDITION_LABELS.CLOAKED);
  }
  if (isCharacterInFleet(session, characterID, options)) {
    add(SAFE_LOGOFF_CONDITION_LABELS.IN_FLEET);
  }
  if (hasActiveSelfDestruct(entity, nowMs)) {
    add(SAFE_LOGOFF_CONDITION_LABELS.SELF_DESTRUCT);
  }
  if (isCharacterInvulnerable(characterID, options)) {
    add(SAFE_LOGOFF_CONDITION_LABELS.INVULNERABLE);
  }
  if (hasControlledEntity(scene, "fighter", characterID, shipID)) {
    add(SAFE_LOGOFF_CONDITION_LABELS.FIGHTERS_IN_SPACE);
  }

  return failed;
}

function toFileTime(unixTimeMs) {
  return BigInt(Math.trunc(unixTimeMs)) * FILETIME_TICKS_PER_MS +
    FILETIME_EPOCH_OFFSET;
}

function notifySession(session, eventName, args = []) {
  if (!session || typeof session.sendNotification !== "function") {
    return false;
  }
  session.sendNotification(eventName, "clientID", args);
  return true;
}

function clearScheduledState(state) {
  if (!state || state.timer === null || state.timer === undefined) {
    return;
  }
  state.clearTimer(state.timer);
  state.timer = null;
}

function cancelSafeLogoff(session, options = {}) {
  const state = session ? activeSafeLogoffs.get(session) : null;
  if (options.clearCompletion !== false) {
    clearSafeLogoffCompletion(session);
  }
  if (!state) {
    return false;
  }
  activeSafeLogoffs.delete(session);
  clearScheduledState(state);
  if (options.notify === true) {
    notifySession(
      session,
      "OnSafeLogoffAborted",
      [options.reason || SAFE_LOGOFF_ABORT_LABELS.SHIP_MOVEMENT],
    );
  }
  return true;
}

function getSafeLogoffState(session) {
  const state = session ? activeSafeLogoffs.get(session) : null;
  if (!state) {
    return null;
  }
  return {
    characterID: state.characterID,
    shipID: state.shipID,
    startedAtMs: state.startedAtMs,
    deadlineMs: state.deadlineMs,
    deadlineFiletime: state.deadlineFiletime,
  };
}

function beginSafeLogoff(session, options = {}) {
  if (!session || !resolveCharacterID(session)) {
    return { success: false, errorMsg: "SESSION_REQUIRED" };
  }
  if (!isSafeLogoffEnabled(options)) {
    return { success: false, errorMsg: "SAFE_LOGOFF_DISABLED" };
  }

  const existing = activeSafeLogoffs.get(session) || null;
  if (existing) {
    return {
      success: true,
      alreadyActive: true,
      deadlineMs: existing.deadlineMs,
      deadlineFiletime: existing.deadlineFiletime,
    };
  }
  clearSafeLogoffCompletion(session);

  const now = typeof options.now === "function" ? options.now : Date.now;
  const startedAtMs = Math.max(0, toFiniteNumber(now(), Date.now()));
  const failedConditions = evaluateSafeLogoffConditions(session, {
    ...options,
    nowMs: startedAtMs,
  });
  if (failedConditions.length > 0) {
    if (options.notifyFailure === true) {
      notifySession(session, "OnSafeLogoffFailed", [failedConditions]);
    }
    return {
      success: false,
      errorMsg: "SAFE_LOGOFF_CONDITIONS_FAILED",
      failedConditions,
    };
  }

  const shipID = resolveActiveSpaceShipID(session, options);
  if (!shipID) {
    if (options.notifyFailure === true) {
      notifySession(session, "OnSafeLogoffFailed", [
        [SAFE_LOGOFF_CONDITION_LABELS.DOCKING],
      ]);
    }
    return {
      success: false,
      errorMsg: "SAFE_LOGOFF_CONDITIONS_FAILED",
      failedConditions: [SAFE_LOGOFF_CONDITION_LABELS.DOCKING],
    };
  }

  const runtimeConfig = getRuntimeConfig(options);
  const countdownSeconds = Math.min(
    300,
    Math.max(
      1,
      Math.trunc(
        toFiniteNumber(
          options.countdownSeconds,
          runtimeConfig.safeLogoffCountdownSeconds || DEFAULT_COUNTDOWN_SECONDS,
        ),
      ),
    ),
  );
  const deadlineMs = startedAtMs + (countdownSeconds * 1000);
  const deadlineFiletime = toFileTime(deadlineMs);
  const schedule =
    typeof options.schedule === "function" ? options.schedule : setTimeout;
  const clearTimer =
    typeof options.clearTimer === "function" ? options.clearTimer : clearTimeout;
  const recheckIntervalMs = Math.max(
    50,
    Math.trunc(
      toFiniteNumber(options.recheckIntervalMs, DEFAULT_RECHECK_INTERVAL_MS),
    ),
  );
  const state = {
    characterID: resolveCharacterID(session),
    shipID,
    startedAtMs,
    deadlineMs,
    deadlineFiletime,
    timer: null,
    clearTimer,
  };
  activeSafeLogoffs.set(session, state);

  const armNextCheck = () => {
    if (activeSafeLogoffs.get(session) !== state) {
      return;
    }
    const currentMs = Math.max(0, toFiniteNumber(now(), Date.now()));
    const delayMs = Math.max(
      0,
      Math.min(recheckIntervalMs, deadlineMs - currentMs),
    );
    state.timer = schedule(runCheck, delayMs);
    if (state.timer && typeof state.timer.unref === "function") {
      state.timer.unref();
    }
  };

  const runCheck = () => {
    if (activeSafeLogoffs.get(session) !== state) {
      return;
    }
    state.timer = null;
    const currentMs = Math.max(0, toFiniteNumber(now(), Date.now()));
    let currentFailures;
    try {
      currentFailures = evaluateSafeLogoffConditions(session, {
        ...options,
        nowMs: currentMs,
      });
    } catch (error) {
      log.warn(
        `[SafeLogoff] condition recheck failed char=${state.characterID}: ${error.message}`,
      );
      currentFailures = [SAFE_LOGOFF_CONDITION_LABELS.DOCKING];
    }
    const currentCharacterID = resolveCharacterID(session);
    const currentShipID = resolveActiveSpaceShipID(session, options);
    if (
      currentCharacterID !== state.characterID ||
      currentShipID !== state.shipID
    ) {
      activeSafeLogoffs.delete(session);
      clearSafeLogoffCompletion(session);
      notifySession(session, "OnSafeLogoffAborted", [
        SAFE_LOGOFF_ABORT_LABELS.SHIP_NOT_IN_SPACE,
      ]);
      return;
    }
    if (currentFailures.length > 0) {
      activeSafeLogoffs.delete(session);
      clearSafeLogoffCompletion(session);
      const abortLabel = ABORT_LABEL_BY_CONDITION[currentFailures[0]] || null;
      if (abortLabel) {
        notifySession(session, "OnSafeLogoffAborted", [abortLabel]);
      } else {
        notifySession(session, "OnSafeLogoffFailed", [currentFailures]);
      }
      return;
    }
    if (currentMs >= deadlineMs) {
      activeSafeLogoffs.delete(session);
      const completion = markSafeLogoffCompletion(session, {
        characterID: state.characterID,
        shipID: state.shipID,
        completedAtMs: currentMs,
      });
      if (!completion) {
        notifySession(session, "OnSafeLogoffAborted", [
          SAFE_LOGOFF_ABORT_LABELS.SHIP_NOT_IN_SPACE,
        ]);
        log.warn(
          `[SafeLogoff] completion identity missing char=${state.characterID} ship=${shipID}`,
        );
        return;
      }
      notifySession(session, "OnSafeLogoffActivated", []);
      const disconnectCharacterSession =
        typeof options.disconnectCharacterSession === "function"
          ? options.disconnectCharacterSession
          : require(path.join(__dirname, "../_shared/sessionDisconnect"))
              .disconnectCharacterSession;
      let disconnectResult = null;
      try {
        disconnectResult = disconnectCharacterSession(session, {
          broadcast: true,
          clearSession: true,
          lifecycleReason: "safe_logoff",
        });
      } catch (error) {
        log.warn(
          `[SafeLogoff] canonical cleanup threw char=${state.characterID}: ${error.message}`,
        );
      }
      if (!disconnectResult || disconnectResult.success !== true) {
        log.warn(
          `[SafeLogoff] canonical cleanup failed char=${state.characterID} ` +
          `reason=${disconnectResult && disconnectResult.errorMsg || "UNKNOWN"}`,
        );
        return;
      }
      log.info(
        `[SafeLogoff] countdown completed and session cleared char=${state.characterID} ship=${shipID}`,
      );
      return;
    }
    armNextCheck();
  };

  notifySession(session, "OnSafeLogoffTimerStarted", [deadlineFiletime]);
  armNextCheck();
  log.info(
    `[SafeLogoff] countdown started char=${state.characterID} seconds=${countdownSeconds}`,
  );
  return {
    success: true,
    deadlineMs,
    deadlineFiletime,
  };
}

function resetSafeLogoffRuntimeForTests() {
  activeSafeLogoffs = new WeakMap();
}

module.exports = {
  ABORT_LABEL_BY_CONDITION,
  DEFAULT_COUNTDOWN_SECONDS,
  FILETIME_EPOCH_OFFSET,
  FILETIME_TICKS_PER_MS,
  SAFE_LOGOFF_ABORT_LABELS,
  SAFE_LOGOFF_COMPLETION_MAX_AGE_MS,
  SAFE_LOGOFF_CONDITION_LABELS,
  beginSafeLogoff,
  cancelSafeLogoff,
  clearSafeLogoffCompletion,
  consumeSafeLogoffCompletion,
  evaluateSafeLogoffConditions,
  getSafeLogoffCompletion,
  getSafeLogoffState,
  isSafeLogoffEnabled,
  markSafeLogoffCompletion,
  resetSafeLogoffRuntimeForTests,
  toFileTime,
};
