"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildGlobalConfigEntries,
} = require("../src/services/machoNet/globalConfig");
const {
  clearCharacterFromSession,
  getActiveShipRecord,
} = require("../src/services/character/characterState");
const {
  persistCharacterLogoffState,
} = require("../src/services/_shared/sessionDisconnect");
const {
  getEmergencyWarpReturnState,
} = require("../src/services/_shared/emergencyWarpRuntime");
const {
  SAFE_LOGOFF_ABORT_LABELS,
  SAFE_LOGOFF_CONDITION_LABELS,
  beginSafeLogoff,
  cancelSafeLogoff,
  consumeSafeLogoffCompletion,
  evaluateSafeLogoffConditions,
  getSafeLogoffCompletion,
  getSafeLogoffState,
  markSafeLogoffCompletion,
  resetSafeLogoffRuntimeForTests,
  toFileTime,
} = require("../src/services/ship/safeLogoffRuntime");
const {
  clearTrackingState,
} = require("../src/space/destiny/simulation/motionState");
const {
  createMovementManualFlightCommands,
} = require("../src/space/destiny/commands/manualFlightCommands");
const {
  createDestinyMovementSimulator,
} = require("../src/space/destiny/simulation/movement");
const {
  getPayloadPrimaryEntityID,
} = require("../src/space/destiny/protocol/payloadIdentity");
const {
  isDestinyPayload,
} = require("../src/space/destiny/protocol/payloads");
const spaceRuntime = require("../src/space/runtime");

function createVectorHelpers() {
  const toFiniteNumber = (value, fallback = 0) =>
    Number.isFinite(Number(value)) ? Number(value) : fallback;
  const cloneVector = (value, fallback = { x: 0, y: 0, z: 0 }) => ({
    x: toFiniteNumber(value && value.x, fallback.x),
    y: toFiniteNumber(value && value.y, fallback.y),
    z: toFiniteNumber(value && value.z, fallback.z),
  });
  const addVectors = (left, right) => ({
    x: left.x + right.x,
    y: left.y + right.y,
    z: left.z + right.z,
  });
  const scaleVector = (value, scalar) => ({
    x: value.x * scalar,
    y: value.y * scalar,
    z: value.z * scalar,
  });
  const magnitude = (value) => Math.hypot(value.x, value.y, value.z);
  const normalizeVector = (value, fallback = { x: 1, y: 0, z: 0 }) => {
    const resolved = cloneVector(value, fallback);
    const length = magnitude(resolved);
    return length > 0
      ? scaleVector(resolved, 1 / length)
      : cloneVector(fallback);
  };
  const crossProduct = (left, right) => ({
    x: (left.y * right.z) - (left.z * right.y),
    y: (left.z * right.x) - (left.x * right.z),
    z: (left.x * right.y) - (left.y * right.x),
  });
  const buildPerpendicular = (direction) => normalizeVector(
    crossProduct(normalizeVector(direction), { x: 0, y: 1, z: 0 }),
    { x: 0, y: 0, z: 1 },
  );
  return {
    addVectors,
    buildPerpendicular,
    clamp: (value, minimum, maximum) =>
      Math.max(minimum, Math.min(maximum, toFiniteNumber(value, 0))),
    cloneVector,
    crossProduct,
    magnitude,
    normalizeVector,
    scaleVector,
    summarizeVector: cloneVector,
    toFiniteNumber,
  };
}

function createSafeLogoffFixture() {
  const characterID = 140000005;
  const entity = {
    kind: "ship",
    itemID: 9988400001000,
    mode: "STOP",
    pendingWarp: null,
    pendingDock: null,
    dockingTargetID: null,
    manualFlightActive: false,
    lockedTargets: new Map(),
    pendingTargetLocks: new Map(),
    targetedBy: new Set(),
    activeModuleEffects: new Map(),
    cloaked: false,
  };
  const scene = {
    dynamicEntities: new Map([[entity.itemID, entity]]),
    getShipEntityForSession: () => entity,
  };
  const session = {
    characterID,
    _space: { systemID: 30000004, shipID: entity.itemID },
    notifications: [],
    sendNotification(name, destination, args) {
      this.notifications.push({ name, destination, args });
    },
  };
  const options = {
    runtimeConfig: {
      safeLogoffEnabled: true,
      safeLogoffCountdownSeconds: 30,
    },
    spaceRuntime: { getSceneForSession: () => scene },
    crimewatchState: { getCharacterCrimewatchState: () => null },
    fleetRuntime: { getFleetForCharacter: () => null },
    npcControlState: { isCharacterInvulnerable: () => false },
  };
  return { characterID, entity, options, scene, session };
}

test("Frontier global config explicitly advertises Safe Logoff and strafe", () => {
  const enabled = new Map(buildGlobalConfigEntries({
    safeLogoffEnabled: true,
    strafeEnabled: true,
  }));
  assert.equal(enabled.get("enable_logoff_to_character_selection"), 1);
  assert.equal(enabled.get("strafe_enabled"), "1");

  const disabled = new Map(buildGlobalConfigEntries({
    safeLogoffEnabled: false,
    strafeEnabled: false,
  }));
  assert.equal(disabled.get("enable_logoff_to_character_selection"), 0);
  assert.equal(disabled.get("strafe_enabled"), "0");
});

test("Safe Logoff returns the live-client localization labels for unsafe state", () => {
  const { characterID, entity, options, scene, session } =
    createSafeLogoffFixture();
  const nowMs = 10_000;
  entity.mode = "WARP";
  entity.pendingWarp = {};
  entity.lockedTargets.set(7, {});
  entity.targetedBy.add(8);
  entity.activeModuleEffects.set(9, {});
  entity.cloaked = true;
  entity.selfDestructAtMs = nowMs + 5_000;
  scene.dynamicEntities.set(11, {
    kind: "drone",
    itemID: 11,
    controllerID: entity.itemID,
  });
  scene.dynamicEntities.set(12, {
    kind: "probe",
    itemID: 12,
    ownerID: characterID,
  });
  scene.dynamicEntities.set(13, {
    kind: "fighter",
    itemID: 13,
    controllerOwnerID: characterID,
  });
  options.crimewatchState.getCharacterCrimewatchState = () => ({
    pvpTimerExpiresAtMs: nowMs + 1_000,
    npcTimerExpiresAtMs: nowMs + 1_000,
    weaponTimerExpiresAtMs: nowMs + 1_000,
  });
  options.fleetRuntime.getFleetForCharacter = () => ({ fleetID: 22 });
  options.npcControlState.isCharacterInvulnerable = () => true;

  const conditions = evaluateSafeLogoffConditions(session, {
    ...options,
    nowMs,
  });

  for (const expected of [
    SAFE_LOGOFF_CONDITION_LABELS.SHIP_IN_WARP,
    SAFE_LOGOFF_CONDITION_LABELS.PVP_TIMER,
    SAFE_LOGOFF_CONDITION_LABELS.PVE_TIMER,
    SAFE_LOGOFF_CONDITION_LABELS.WEAPONS_TIMER,
    SAFE_LOGOFF_CONDITION_LABELS.TARGET_LOCK,
    SAFE_LOGOFF_CONDITION_LABELS.TARGET_LOCKED,
    SAFE_LOGOFF_CONDITION_LABELS.DRONES_CONNECTED,
    SAFE_LOGOFF_CONDITION_LABELS.ACTIVE_MODULES,
    SAFE_LOGOFF_CONDITION_LABELS.ACTIVE_PROBES,
    SAFE_LOGOFF_CONDITION_LABELS.CLOAKED,
    SAFE_LOGOFF_CONDITION_LABELS.IN_FLEET,
    SAFE_LOGOFF_CONDITION_LABELS.SELF_DESTRUCT,
    SAFE_LOGOFF_CONDITION_LABELS.INVULNERABLE,
    SAFE_LOGOFF_CONDITION_LABELS.FIGHTERS_IN_SPACE,
  ]) {
    assert.equal(conditions.includes(expected), true, expected);
  }
});

test("Safe Logoff activates then invokes canonical cleanup with scoped persistence identity", () => {
  resetSafeLogoffRuntimeForTests();
  const { characterID, entity, options, session } = createSafeLogoffFixture();
  let nowMs = 1_000;
  let scheduledCheck = null;
  const cleanupCalls = [];
  const result = beginSafeLogoff(session, {
    ...options,
    countdownSeconds: 1,
    now: () => nowMs,
    schedule: (callback) => {
      scheduledCheck = callback;
      return { unref() {} };
    },
    clearTimer: () => {},
    disconnectCharacterSession(targetSession, cleanupOptions) {
      cleanupCalls.push({ targetSession, cleanupOptions });
      assert.equal(
        targetSession.notifications.at(-1).name,
        "OnSafeLogoffActivated",
      );
      assert.deepEqual(getSafeLogoffCompletion(targetSession), {
        characterID,
        shipID: entity.itemID,
        completedAtMs: nowMs,
      });
      assert.deepEqual(
        consumeSafeLogoffCompletion(targetSession, {
          characterID,
          shipID: entity.itemID,
          nowMs,
        }),
        { characterID, shipID: entity.itemID, completedAtMs: nowMs },
      );
      // Model the canonical cleanup's detach and character-session clear so
      // this regression proves completion does not stop at a client event.
      targetSession._space = null;
      targetSession.characterID = 0;
      targetSession.charid = null;
      return { success: true, cleanupErrors: [] };
    },
  });

  assert.equal(result.success, true);
  assert.equal(result.deadlineFiletime, toFileTime(2_000));
  assert.equal(session.notifications[0].name, "OnSafeLogoffTimerStarted");
  assert.deepEqual(session.notifications[0].args, [toFileTime(2_000)]);
  assert.equal(typeof scheduledCheck, "function");

  nowMs = 2_000;
  scheduledCheck();
  assert.equal(session.notifications.at(-1).name, "OnSafeLogoffActivated");
  assert.equal(cleanupCalls.length, 1);
  assert.equal(cleanupCalls[0].targetSession, session);
  assert.deepEqual(cleanupCalls[0].cleanupOptions, {
    broadcast: true,
    clearSession: true,
    lifecycleReason: "safe_logoff",
  });
  assert.equal(session.characterID, 0);
  assert.equal(session._space, null);
  assert.equal(getSafeLogoffCompletion(session), null);
  assert.equal(getSafeLogoffState(session), null);
});

test("Safe Logoff persistence consumes the scoped token and keeps exact space state", () => {
  const characterID = 140000005;
  const activeShip = getActiveShipRecord(characterID);
  assert.ok(activeShip && Number(activeShip.itemID) > 0);

  const shipID = Number(activeShip.itemID);
  const completedAtMs = Date.now();
  const liveSpaceState = {
    systemID: 30000004,
    position: { x: 12_345, y: -6_789, z: 42 },
    velocity: { x: 0, y: 0, z: 0 },
    direction: { x: 1, y: 0, z: 0 },
    targetPoint: { x: 12_345, y: -6_789, z: 42 },
    mode: "STOP",
    speedFraction: 0,
  };
  const session = {
    characterID,
    charid: characterID,
    stationID: null,
    stationid: null,
    structureID: null,
    structureid: null,
    solarsystemid: 30000004,
    solarsystemid2: 30000004,
    _space: { systemID: 30000004, shipID },
  };
  markSafeLogoffCompletion(session, {
    characterID,
    shipID,
    completedAtMs,
  });

  const originalSnapshot = spaceRuntime.getEntitySpaceStateSnapshot;
  spaceRuntime.getEntitySpaceStateSnapshot = () => liveSpaceState;
  try {
    const result = persistCharacterLogoffState(session);
    assert.equal(result.success, true);
  } finally {
    spaceRuntime.getEntitySpaceStateSnapshot = originalSnapshot;
  }

  assert.equal(getSafeLogoffCompletion(session), null);
  const persistedShip = getActiveShipRecord(characterID);
  assert.deepEqual(persistedShip.spaceState.position, liveSpaceState.position);
  assert.equal(
    getEmergencyWarpReturnState(persistedShip.spaceState),
    null,
  );
});

test("Safe Logoff revalidation aborts when the pilot starts moving", () => {
  resetSafeLogoffRuntimeForTests();
  const { entity, options, session } = createSafeLogoffFixture();
  let nowMs = 5_000;
  let scheduledCheck = null;
  const result = beginSafeLogoff(session, {
    ...options,
    countdownSeconds: 30,
    now: () => nowMs,
    schedule: (callback) => {
      scheduledCheck = callback;
      return { unref() {} };
    },
    clearTimer: () => {},
  });
  assert.equal(result.success, true);

  entity.mode = "GOTO";
  nowMs += 250;
  scheduledCheck();
  assert.deepEqual(session.notifications.at(-1), {
    name: "OnSafeLogoffAborted",
    destination: "clientID",
    args: [SAFE_LOGOFF_ABORT_LABELS.SHIP_MOVEMENT],
  });
  assert.equal(getSafeLogoffState(session), null);
  assert.equal(cancelSafeLogoff(session), false);
});

test("Safe Logoff reports the dedicated abort when the ship leaves space", () => {
  resetSafeLogoffRuntimeForTests();
  const { options, session } = createSafeLogoffFixture();
  let nowMs = 7_000;
  let scheduledCheck = null;
  const result = beginSafeLogoff(session, {
    ...options,
    countdownSeconds: 30,
    now: () => nowMs,
    schedule: (callback) => {
      scheduledCheck = callback;
      return { unref() {} };
    },
    clearTimer: () => {},
  });
  assert.equal(result.success, true);

  session._space = null;
  options.spaceRuntime.getSceneForSession = () => null;
  nowMs += 250;
  scheduledCheck();
  assert.deepEqual(session.notifications.at(-1), {
    name: "OnSafeLogoffAborted",
    destination: "clientID",
    args: [SAFE_LOGOFF_ABORT_LABELS.SHIP_NOT_IN_SPACE],
  });
  assert.equal(getSafeLogoffState(session), null);
});

test("Safe Logoff countdown cannot complete across an A-to-B session switch", () => {
  resetSafeLogoffRuntimeForTests();
  const { entity, options, session } = createSafeLogoffFixture();
  let nowMs = 20_000;
  let scheduledCheck = null;
  const result = beginSafeLogoff(session, {
    ...options,
    countdownSeconds: 1,
    now: () => nowMs,
    schedule: (callback) => {
      scheduledCheck = callback;
      return { unref() {} };
    },
    clearTimer: () => {},
    disconnectCharacterSession() {
      assert.fail("cleanup must not run for a different character or ship");
    },
  });
  assert.equal(result.success, true);

  session.characterID = 140000006;
  session.charid = 140000006;
  entity.itemID = 9988400001001;
  session._space.shipID = entity.itemID;
  nowMs = 21_000;
  scheduledCheck();

  assert.deepEqual(session.notifications.at(-1), {
    name: "OnSafeLogoffAborted",
    destination: "clientID",
    args: [SAFE_LOGOFF_ABORT_LABELS.SHIP_NOT_IN_SPACE],
  });
  assert.equal(getSafeLogoffState(session), null);
  assert.equal(getSafeLogoffCompletion(session), null);
});

test("Safe Logoff completion is exact-match and consumed by an A-to-B session reuse", () => {
  const characterA = 140000005;
  const characterB = 140000006;
  const shipA = 9988400001000;
  const shipB = 9988400001001;
  const completedAtMs = 50_000;
  const session = {
    characterID: characterA,
    charid: characterA,
    _space: { systemID: 30000004, shipID: shipA },
  };
  assert.deepEqual(markSafeLogoffCompletion(session, {
    characterID: characterA,
    shipID: shipA,
    completedAtMs,
  }), {
    characterID: characterA,
    shipID: shipA,
    completedAtMs,
  });

  const result = clearCharacterFromSession(session, {
    emitNotifications: false,
    controlTransition: false,
  });
  assert.equal(result.success, true);
  assert.equal(getSafeLogoffCompletion(session), null);
  assert.equal("_safeLogoffCompletedAtMs" in session, false);
  assert.equal(session.characterID, 0);

  session.characterID = characterB;
  session.charid = characterB;
  session._space = { systemID: 30000004, shipID: shipB };
  assert.equal(consumeSafeLogoffCompletion(session, {
    characterID: characterB,
    shipID: shipB,
    nowMs: completedAtMs + 1,
  }), null);
});

test("a mismatched Safe Logoff completion cannot be retried by another character", () => {
  const session = {};
  const completedAtMs = 80_000;
  markSafeLogoffCompletion(session, {
    characterID: 140000005,
    shipID: 9988400001000,
    completedAtMs,
  });

  assert.equal(consumeSafeLogoffCompletion(session, {
    characterID: 140000006,
    shipID: 9988400001001,
    nowMs: completedAtMs + 1,
  }), null);
  assert.equal(consumeSafeLogoffCompletion(session, {
    characterID: 140000005,
    shipID: 9988400001000,
    nowMs: completedAtMs + 2,
  }), null);
});

test("Safe Logoff abort consumes any completed identity even after its timer ended", () => {
  const session = {};
  markSafeLogoffCompletion(session, {
    characterID: 140000005,
    shipID: 9988400001000,
    completedAtMs: 100_000,
  });

  assert.equal(cancelSafeLogoff(session), false);
  assert.equal(getSafeLogoffCompletion(session), null);
});

test("Frontier strafe command clamps acceleration and emits native Destiny action", () => {
  const vectors = createVectorHelpers();
  const entity = {
    itemID: 9002,
    mode: "STOP",
    position: { x: 0, y: 0, z: 0 },
    velocity: { x: 0, y: 0, z: 0 },
    direction: { x: 1, y: 0, z: 0 },
    targetPoint: { x: 1.0e16, y: 0, z: 0 },
    speedFraction: 0,
    maxVelocity: 100,
    agilitySeconds: 2,
  };
  const sent = [];
  const runtime = {
    getShipEntityForSession: () => entity,
    getCurrentSimTimeMs: () => 10_000,
    getHistorySafeSessionDestinyStamp: () => 77,
    broadcastPilotCommandMovementUpdates: (_session, updates) =>
      sent.push(...updates),
    scheduleWatcherMovementAnchor: () => true,
  };
  const commands = createMovementManualFlightCommands({
    ...vectors,
    armMovementTrace: () => {},
    clearTrackingState,
    persistShipEntity: () => true,
    roundNumber: (value) => Number(value),
    DEFAULT_RIGHT: { x: 1, y: 0, z: 0 },
  });

  assert.equal(commands.setStrafingThrust(runtime, {}, [999, -999, 44]), true);
  assert.deepEqual(entity.manualStrafingThrust, { x: 10, y: -10, z: 0 });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].stamp, 77);
  assert.equal(sent[0].payload[0], "SetStrafingThrust");
  assert.equal(isDestinyPayload(sent[0].payload), true);
  assert.equal(getPayloadPrimaryEntityID(sent[0].payload), 9002);
  assert.deepEqual(
    sent[0].payload[1].slice(1).map((value) => value.value),
    [10, -10, 0],
  );

  assert.equal(commands.setPitch(runtime, {}, 0.5), true);
  assert.deepEqual(entity.manualStrafingThrust, { x: 10, y: -10, z: 0 });
});

test("Frontier strafe acceleration is integrated in ship-local vertical and horizontal axes", () => {
  const vectors = createVectorHelpers();
  const simulator = createDestinyMovementSimulator({
    ...vectors,
    roundNumber: (value) => Number(value),
    DEFAULT_RIGHT: { x: 1, y: 0, z: 0 },
  });
  const entity = {
    mode: "GOTO",
    manualFlightActive: true,
    manualStrafingThrust: { x: 2, y: 3, z: 0 },
    position: { x: 0, y: 0, z: 0 },
    velocity: { x: 0, y: 0, z: 0 },
    direction: { x: 1, y: 0, z: 0 },
  };

  assert.equal(simulator.applyManualStrafingThrust(entity, 1), true);
  assert.deepEqual(entity.velocity, { x: 0, y: 2, z: 3 });
  assert.deepEqual(entity.position, { x: 0, y: 1, z: 1.5 });
  assert.deepEqual(entity.direction, { x: 1, y: 0, z: 0 });
});
