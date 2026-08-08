"use strict";

/**
 * Frontier Creation ability framework, IFF transponder/beacon, and
 * directional scanner coverage (client build 3455996).
 * Run through: npm run test:frontier-server (isolated runner).
 */

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  marshalEncode,
} = require("../src/network/tcp/utils/marshal");
const creationRuntime = require("../src/services/frontier/creationRuntime");
const creationAbilityRuntime = require("../src/services/frontier/creationAbilityRuntime");
const {
  getCreationTemplate,
} = require("../src/services/frontier/creationStaticData");
const iffRuntime = require("../src/services/frontier/iffRuntime");
const scanningRuntime = require("../src/services/frontier/scanningRuntime");
const itemStore = require("../src/services/inventory/itemStore");
const liveFittingState = require("../src/services/fitting/liveFittingState");
const frontierSpaceRuntime = require("../src/space/runtime");
const DogmaService = require("../src/services/dogma/dogmaService");
const {
  buildScanResponse,
  millisecondsToFiletimeDelta,
} = require("../src/services/frontier/scanningAbilityHandlers");
const {
  buildVerdictsForViewer,
} = require("../src/services/frontier/iffAbilityHandlers");
// Requiring the service registers every behavior handler.
require("../src/services/frontier/creationService");

const TYPE_SCANNER = 95322;
const TYPE_TRANSPONDER = 95988;
const TYPE_BEACON = 96039;
const TYPE_FUEL_BAY = 95324;
const TYPE_CAPACITOR = 95325;
// A real signature-bearing type from spaceComponentsByType (baseSignature 2.0).
const TYPE_SIGNATURE_TARGET = 23;

const OWNER_ID = 140000004;
const OTHER_OWNER_ID = 140000002;
const SHIP_ID = 9100000001;
const SOLAR_SYSTEM_ID = 30000004;

function frontierMarshals(value) {
  assert.doesNotThrow(() =>
    marshalEncode(value, { compatibilityProfile: "frontier" }));
}

// ── Phase 1: ability discovery and dispatch ──────────────────────────────

test("behavior-aware ability lists are exact", () => {
  assert.deepEqual(
    creationRuntime.getCreationModuleAbilities(TYPE_SCANNER),
    ["online", "offline", "directional_scan"],
  );
  assert.deepEqual(
    creationRuntime.getCreationModuleAbilities(TYPE_TRANSPONDER),
    ["online", "offline", "activate_effect", "deactivate_effect", "iff_reconfigure"],
  );
  assert.deepEqual(
    creationRuntime.getCreationModuleAbilities(TYPE_BEACON),
    ["online", "offline", "activate_effect", "deactivate_effect"],
  );
});

test("existing online/offline advertisement is unchanged for generic modules", () => {
  // Generic modules without the Dogma online effect advertise nothing; ones
  // with it keep exactly the pre-framework pair.
  assert.deepEqual(creationRuntime.getCreationModuleAbilities(TYPE_FUEL_BAY), []);
  const capacitorAbilities = creationRuntime.getCreationModuleAbilities(TYPE_CAPACITOR);
  assert.ok(
    capacitorAbilities.length === 0 ||
      capacitorAbilities.every((ability) => ["online", "offline"].includes(ability)),
    `unexpected generic abilities: ${JSON.stringify(capacitorAbilities)}`,
  );
});

test("no ability is advertised without a registered handler", () => {
  for (const typeID of [TYPE_SCANNER, TYPE_TRANSPONDER, TYPE_BEACON]) {
    const behaviorName = creationAbilityRuntime.getModuleBehaviorName(typeID);
    for (const ability of creationRuntime.getCreationModuleAbilities(typeID)) {
      assert.ok(
        creationAbilityRuntime.resolveCreationAbilityHandler(behaviorName, ability),
        `missing handler for ${behaviorName}:${ability}`,
      );
    }
  }
});

function buildDispatchContext(moduleTypeID, moduleItemID = 500001) {
  return {
    item: { itemID: SHIP_ID, ownerID: OWNER_ID, typeID: 95276 },
    characterID: OWNER_ID,
    state: {
      modules: [{
        itemID: moduleItemID,
        typeID: moduleTypeID,
        abilities: creationRuntime.getCreationModuleAbilities(moduleTypeID),
      }],
    },
  };
}

function buildIffEffectRuntime(shipID) {
  const entity = {
    kind: "ship",
    itemID: shipID,
    position: { x: 1, y: 2, z: 3 },
    activeModuleEffects: new Map(),
  };
  const calls = [];
  return {
    calls,
    entity,
    runtime: {
      getEntity(_session, requestedShipID) {
        return Number(requestedShipID) === Number(shipID) ? entity : null;
      },
      activateGenericModule(_session, moduleItem, effectName, options = {}) {
        const effectID = effectName === "iffBeacon" ? 12974 : 12972;
        const durationMs = effectName === "iffBeacon" ? 30000 : 5000;
        const effectState = {
          moduleID: moduleItem.itemID,
          effectID,
          effectName,
          durationMs,
          startedAtMs: Date.now(),
          repeat: Object.prototype.hasOwnProperty.call(options, "repeat")
            ? options.repeat
            : null,
        };
        entity.activeModuleEffects.set(moduleItem.itemID, effectState);
        calls.push({ action: "activate", effectName, options, effectState });
        return { success: true, data: { entity, effectState } };
      },
      deactivateGenericModule(_session, moduleItemID, options = {}) {
        const effectState = entity.activeModuleEffects.get(moduleItemID) || null;
        if (!effectState) {
          return { success: false, errorMsg: "MODULE_NOT_ACTIVE" };
        }
        entity.activeModuleEffects.delete(moduleItemID);
        calls.push({ action: "deactivate", options, effectState });
        return { success: true, data: { entity, effectState } };
      },
      stopShipEntity(_entity, options = {}) {
        calls.push({ action: "stopShip", options });
      },
    },
  };
}

test("dispatch rejects spoofed, unadvertised, and foreign-module abilities", () => {
  const creationContext = buildDispatchContext(TYPE_SCANNER);

  const spoofed = creationAbilityRuntime.dispatchCreationAbility({
    ability: "self_destruct_everything",
    kwargs: {},
    session: null,
    creationContext,
    moduleItemID: 500001,
  });
  assert.equal(spoofed.success, false);
  assert.equal(spoofed.errorMsg, "ABILITY_NOT_ADVERTISED");

  // A real ability that belongs to a DIFFERENT behavior must not execute.
  const wrongBehavior = creationAbilityRuntime.dispatchCreationAbility({
    ability: "iff_reconfigure",
    kwargs: { iff_channel: "tribe" },
    session: null,
    creationContext,
    moduleItemID: 500001,
  });
  assert.equal(wrongBehavior.success, false);
  assert.equal(wrongBehavior.errorMsg, "ABILITY_NOT_ADVERTISED");

  // A module that is not part of this Creation is rejected before anything else.
  const foreignModule = creationAbilityRuntime.dispatchCreationAbility({
    ability: "directional_scan",
    kwargs: { scan_angle: 15, scan_direction: [0, 0, 1] },
    session: null,
    creationContext,
    moduleItemID: 999999,
  });
  assert.equal(foreignModule.success, false);
  assert.equal(foreignModule.errorMsg, "MODULE_NOT_IN_CREATION");

  const emptyAbility = creationAbilityRuntime.dispatchCreationAbility({
    ability: "",
    kwargs: {},
    session: null,
    creationContext,
    moduleItemID: 500001,
  });
  assert.equal(emptyAbility.success, false);
  assert.equal(emptyAbility.errorMsg, "ABILITY_EMPTY");
});

test("directional scan requires an in-space session", () => {
  const result = creationAbilityRuntime.dispatchCreationAbility({
    ability: "directional_scan",
    kwargs: { scan_angle: 15, scan_direction: [0, 0, 1] },
    session: { charid: OWNER_ID },
    creationContext: buildDispatchContext(TYPE_SCANNER),
    moduleItemID: 500001,
  });
  assert.equal(result.success, false);
  assert.equal(result.errorMsg, "SHIP_NOT_IN_SPACE");
});

test("Creation fitting splits one singleton and Dogma bridges online state", () => {
  const stationID = 64000001;
  const shipGrant = itemStore.grantItemToCharacterLocation(
    OWNER_ID,
    stationID,
    itemStore.ITEM_FLAGS.HANGAR,
    95276,
    1,
    { individualItems: true, singleton: 1 },
  );
  assert.equal(shipGrant.success, true, shipGrant.errorMsg);
  const ship = shipGrant.data.items[0];
  assert.ok(ship && ship.itemID > 0);

  const stackGrant = itemStore.grantItemToCharacterLocation(
    OWNER_ID,
    ship.itemID,
    itemStore.ITEM_FLAGS.CARGO_HOLD,
    TYPE_BEACON,
    2,
    { singleton: 0 },
  );
  assert.equal(stackGrant.success, true, stackGrant.errorMsg);
  const sourceStack = stackGrant.data.items[0];
  assert.equal(sourceStack.stacksize, 2);

  const template = getCreationTemplate(ship.typeID);
  const partID = Number(Object.keys(template && template.parts || {})[0]) || 0;
  assert.ok(partID > 0);
  const commit = creationRuntime.commitCreationDraft(
    ship,
    OWNER_ID,
    [{
      op: "add",
      itemID: sourceStack.itemID,
      typeID: TYPE_BEACON,
      partID,
      sourceLocationID: ship.itemID,
      sourceFlagID: itemStore.ITEM_FLAGS.CARGO_HOLD,
      x: 0,
      y: 0,
      z: 0,
      rotationX: 0,
      rotationY: 0,
      rotationZ: 0,
    }],
    null,
  );
  assert.equal(commit.success, true, JSON.stringify(commit.diagnostics));

  let fitted = itemStore.findItemById(sourceStack.itemID);
  assert.equal(fitted.locationID, ship.itemID);
  assert.equal(fitted.flagID, creationRuntime.CREATION_FITTING_FLAG_ID);
  assert.equal(fitted.singleton, 1);
  assert.equal(fitted.stacksize, 1);
  assert.equal(fitted.quantity, -1);

  let cargoRemainders = itemStore
    .listContainerItems(OWNER_ID, ship.itemID, itemStore.ITEM_FLAGS.CARGO_HOLD)
    .filter((entry) => entry.typeID === TYPE_BEACON);
  assert.equal(cargoRemainders.length, 1);
  assert.notEqual(cargoRemainders[0].itemID, sourceStack.itemID);
  assert.equal(cargoRemainders[0].singleton, 0);
  assert.equal(cargoRemainders[0].stacksize, 1);

  const persistedShip = itemStore.findItemById(ship.itemID);
  assert.ok(
    creationRuntime.readCreationState(persistedShip).modules
      .some((module) => module.itemID === sourceStack.itemID),
  );

  // Reproduce the pre-fix persisted shape and prove hydration repairs it: the
  // selected itemID remains fitted while the extra unit returns to cargo.
  assert.equal(
    itemStore.removeInventoryItem(cargoRemainders[0].itemID, { removeContents: true }).success,
    true,
  );
  assert.equal(itemStore.updateInventoryItem(fitted.itemID, (currentItem) => ({
    ...currentItem,
    quantity: 2,
    stacksize: 2,
    singleton: 0,
  })).success, true);
  const repaired = creationRuntime.ensureCreationState(
    itemStore.findItemById(ship.itemID),
    OWNER_ID,
  );
  assert.equal(repaired.success, true, repaired.errorMsg);
  fitted = itemStore.findItemById(sourceStack.itemID);
  assert.equal(fitted.singleton, 1);
  assert.equal(fitted.stacksize, 1);
  cargoRemainders = itemStore
    .listContainerItems(OWNER_ID, ship.itemID, itemStore.ITEM_FLAGS.CARGO_HOLD)
    .filter((entry) => entry.typeID === TYPE_BEACON);
  assert.equal(cargoRemainders.length, 1);
  assert.equal(cargoRemainders[0].stacksize, 1);

  const notifications = [];
  const session = {
    charid: OWNER_ID,
    characterID: OWNER_ID,
    shipid: ship.itemID,
    shipID: ship.itemID,
    shipTypeID: ship.typeID,
    compatibilityProfile: "frontier",
    sendNotification(name, idType, payload) {
      notifications.push({ name, idType, payload });
    },
  };
  const dogma = new DogmaService();
  const online = dogma._setModuleOnlineState(
    ship.itemID,
    sourceStack.itemID,
    true,
    session,
  );
  assert.equal(online.success, true, online.errorMsg);
  assert.equal(
    creationRuntime.isCreationModuleOnline(itemStore.findItemById(sourceStack.itemID)),
    true,
  );
  const offline = dogma._setModuleOnlineState(
    ship.itemID,
    sourceStack.itemID,
    false,
    session,
  );
  assert.equal(offline.success, true, offline.errorMsg);
  assert.equal(
    creationRuntime.isCreationModuleOnline(itemStore.findItemById(sourceStack.itemID)),
    false,
  );
  assert.equal(
    notifications.filter((entry) => entry.name === "OnMultiEvent").length,
    2,
  );
});

// ── Phase 2: transponder configuration and beacon visibility ─────────────

test("transponder configuration validation matches the client contract", () => {
  const channels = iffRuntime.IFF_BEACON_CHANNELS;

  assert.deepEqual(
    iffRuntime.normalizeIffConfiguration("tribe", null, channels),
    { channel: "tribe", code: null },
  );
  assert.deepEqual(
    iffRuntime.normalizeIffConfiguration("code", "RALLY-7", channels),
    { channel: "code", code: "RALLY-7" },
  );
  // Channel off.
  assert.deepEqual(
    iffRuntime.normalizeIffConfiguration(null, "ignored", channels),
    { channel: null, code: null },
  );
  // Casing is normalized to the client's lowercase StrEnum values.
  assert.equal(
    iffRuntime.normalizeIffConfiguration("TRIBE", null, channels).channel,
    "tribe",
  );
  assert.equal(
    iffRuntime.normalizeIffConfiguration("bogus", null, channels).errorMsg,
    "IFF_CHANNEL_INVALID",
  );
  assert.equal(
    iffRuntime.normalizeIffConfiguration("code", "", channels).errorMsg,
    "IFF_CODE_REQUIRED",
  );
  assert.equal(
    iffRuntime.normalizeIffConfiguration("code", "x".repeat(33), channels).errorMsg,
    "IFF_CODE_TOO_LONG",
  );
  assert.equal(
    iffRuntime.normalizeIffConfiguration("code", "x".repeat(32), channels).code.length,
    32,
  );
  // The cairn surface only offers the mutual channels.
  assert.equal(
    iffRuntime.normalizeIffConfiguration(
      "public",
      null,
      iffRuntime.IFF_TRANSPONDER_CHANNELS,
    ).errorMsg,
    "IFF_CHANNEL_INVALID",
  );
});

test("Frontier Dogma effects retain their authored activation contract", () => {
  const broadcast = liveFittingState.getEffectTypeRecord(12972);
  const beacon = liveFittingState.getEffectTypeRecord(12974);
  assert.equal(broadcast.name, "iffBroadcast");
  assert.equal(broadcast.effectCategoryID, 1);
  assert.equal(broadcast.durationAttributeID, 73);
  assert.equal(beacon.name, "iffBeacon");
  assert.equal(beacon.effectCategoryID, 1);
  assert.equal(beacon.disallowAutoRepeat, true);
});

test("Creation live entities enforce their derived capacitor and retain active modules", (t) => {
  const stationID = 64000001;
  const previousActiveShip = itemStore.getActiveShipItem(OWNER_ID);
  t.after(() => {
    if (previousActiveShip) {
      itemStore.setActiveShipForCharacter(OWNER_ID, previousActiveShip.itemID);
    }
  });
  const shipGrant = itemStore.grantItemToCharacterLocation(
    OWNER_ID,
    stationID,
    itemStore.ITEM_FLAGS.HANGAR,
    95276,
    1,
    { individualItems: true, singleton: 1 },
  );
  assert.equal(shipGrant.success, true, shipGrant.errorMsg);
  const ship = shipGrant.data.items[0];
  const moduleGrant = itemStore.grantItemToCharacterLocation(
    OWNER_ID,
    ship.itemID,
    itemStore.ITEM_FLAGS.CARGO_HOLD,
    TYPE_TRANSPONDER,
    1,
    { individualItems: true, singleton: 1 },
  );
  assert.equal(moduleGrant.success, true, moduleGrant.errorMsg);
  const sourceModule = moduleGrant.data.items[0];
  const template = getCreationTemplate(ship.typeID);
  const partID = Number(Object.keys(template && template.parts || {})[0]) || 0;
  const commit = creationRuntime.commitCreationDraft(
    ship,
    OWNER_ID,
    [{
      op: "add",
      itemID: sourceModule.itemID,
      typeID: TYPE_TRANSPONDER,
      partID,
      sourceLocationID: ship.itemID,
      sourceFlagID: itemStore.ITEM_FLAGS.CARGO_HOLD,
      x: 0,
      y: 0,
      z: 0,
      rotationX: 0,
      rotationY: 0,
      rotationZ: 0,
    }],
    null,
  );
  assert.equal(commit.success, true, JSON.stringify(commit.diagnostics));
  assert.equal(
    itemStore.setActiveShipForCharacter(OWNER_ID, ship.itemID).success,
    true,
  );
  assert.equal(itemStore.updateInventoryItem(sourceModule.itemID, (item) => ({
    ...item,
    moduleState: { ...(item.moduleState || {}), online: true },
  })).success, true);

  const session = {
    charid: OWNER_ID,
    characterID: OWNER_ID,
    shipid: ship.itemID,
    shipID: ship.itemID,
    solarsystemid: SOLAR_SYSTEM_ID,
    solarsystemid2: SOLAR_SYSTEM_ID,
    compatibilityProfile: "frontier",
    sendNotification() {},
  };
  const entity = frontierSpaceRuntime._testing.buildShipEntityForTesting(
    session,
    itemStore.findItemById(ship.itemID),
    SOLAR_SYSTEM_ID,
  );
  assert.equal(entity.capacitorCapacity, 200);
  assert.equal(entity.capacitorChargeRatio, 1);
  assert.equal(entity.passiveDerivedState.attributes[6250], 1_800_000_000);
  assert.equal(entity.maxVelocity, 360);

  const startPosition = { ...entity.position };
  entity.mode = "GOTO";
  entity.speedFraction = 1;
  entity.targetPoint = {
    x: startPosition.x + 10_000,
    y: startPosition.y,
    z: startPosition.z,
  };
  const movement = frontierSpaceRuntime._testing.advanceMovementForTesting(
    entity,
    null,
    1,
    Date.now(),
  );
  assert.equal(movement.changed, true);
  assert.ok(entity.position.x > startPosition.x);
  assert.ok(Math.hypot(entity.velocity.x, entity.velocity.y, entity.velocity.z) > 0);

  const moduleItem = itemStore.findItemById(sourceModule.itemID);
  const moduleOwnerIDs = frontierSpaceRuntime._testing
    .getEntityRuntimeModuleOwnerItemsForTesting(entity)
    .map((item) => Number(item.itemID));
  assert.equal(moduleOwnerIDs.includes(moduleItem.itemID), true);

  const scene = new frontierSpaceRuntime._testing.SolarSystemScene(
    SOLAR_SYSTEM_ID,
  );
  entity.session = session;
  scene.dynamicEntities.set(entity.itemID, entity);
  session._space = {
    systemID: SOLAR_SYSTEM_ID,
    shipID: entity.itemID,
  };
  scene.sessions.set(OWNER_ID, session);

  const activation = scene.activateGenericModule(
    session,
    moduleItem,
    "iffBroadcast",
    { repeat: 0 },
  );
  assert.equal(activation.success, true, activation.errorMsg);
  assert.equal(entity.activeModuleEffects.has(moduleItem.itemID), true);
  assert.equal(
    Number((entity.capacitorCapacity * entity.capacitorChargeRatio).toFixed(6)),
    195,
  );

  const refresh = scene.refreshShipEntityDerivedState(entity, {
    session,
    broadcast: false,
    notifyDerivedAttributes: false,
  });
  assert.equal(refresh.success, true, refresh.errorMsg);
  assert.equal(entity.capacitorCapacity, 200);
  assert.equal(entity.activeModuleEffects.has(moduleItem.itemID), true);
});

test("transponder activation broadcasts explicitly and deactivation preserves its mode", () => {
  const shipGrant = itemStore.grantItemToCharacterLocation(
    OWNER_ID,
    64000004,
    itemStore.ITEM_FLAGS.HANGAR,
    95276,
    1,
    { individualItems: true, singleton: 1 },
  );
  assert.equal(shipGrant.success, true, shipGrant.errorMsg);
  const ship = shipGrant.data.items[0];
  const moduleGrant = itemStore.grantItemToCharacterLocation(
    OWNER_ID,
    ship.itemID,
    creationRuntime.CREATION_FITTING_FLAG_ID,
    TYPE_TRANSPONDER,
    1,
    {
      individualItems: true,
      singleton: 1,
      moduleState: { online: true },
    },
  );
  assert.equal(moduleGrant.success, true, moduleGrant.errorMsg);
  const moduleItem = moduleGrant.data.items[0];
  const creationContext = {
    item: ship,
    characterID: OWNER_ID,
    state: {
      modules: [{
        itemID: moduleItem.itemID,
        typeID: TYPE_TRANSPONDER,
        abilities: creationRuntime.getCreationModuleAbilities(TYPE_TRANSPONDER),
      }],
    },
  };
  const effectRuntime = buildIffEffectRuntime(ship.itemID);
  const session = {
    charid: OWNER_ID,
    characterID: OWNER_ID,
    shipid: ship.itemID,
    solarsystemid: SOLAR_SYSTEM_ID,
    solarsystemid2: SOLAR_SYSTEM_ID,
    _space: { systemID: SOLAR_SYSTEM_ID },
    sendNotification() {},
  };
  const invoke = (ability, kwargs = {}) =>
    creationAbilityRuntime.dispatchCreationAbility({
      ability,
      kwargs,
      session,
      creationContext,
      moduleItemID: moduleItem.itemID,
      abilityDependencies: { spaceRuntime: effectRuntime.runtime },
    });

  assert.deepEqual(
    iffRuntime.readTransponderState(itemStore.findItemById(moduleItem.itemID)),
    { channel: null, code: null, active: false },
  );

  const invalidPublic = invoke("activate_effect", { iff_channel: "public" });
  assert.equal(invalidPublic.success, false);
  assert.equal(invalidPublic.errorMsg, "IFF_CHANNEL_INVALID");

  const activated = invoke("activate_effect", {
    iff_channel: "code",
    iff_code: "RALLY-7",
  });
  assert.equal(activated.success, true, activated.errorMsg);
  assert.equal(effectRuntime.calls[0].action, "activate");
  assert.equal(effectRuntime.calls[0].effectName, "iffBroadcast");
  assert.equal(effectRuntime.calls[0].effectState.effectID, 12972);
  assert.deepEqual(
    iffRuntime.readTransponderState(itemStore.findItemById(moduleItem.itemID)),
    { channel: "code", code: "RALLY-7", active: true },
  );
  assert.deepEqual(
    iffRuntime.resolveActiveTransponder(OWNER_ID, ship.itemID, {
      readCreationState: () => ({
        modules: [{ itemID: moduleItem.itemID, typeID: TYPE_TRANSPONDER }],
      }),
      isCreationModuleOnline: () => true,
    }),
    {
      moduleItemID: moduleItem.itemID,
      channel: "code",
      code: "RALLY-7",
    },
  );

  const reconfigured = invoke("iff_reconfigure", { iff_channel: "tribe" });
  assert.equal(reconfigured.success, true, reconfigured.errorMsg);
  assert.deepEqual(
    iffRuntime.readTransponderState(itemStore.findItemById(moduleItem.itemID)),
    { channel: "tribe", code: null, active: true },
  );

  const deactivated = invoke("deactivate_effect");
  assert.equal(deactivated.success, true, deactivated.errorMsg);
  assert.equal(
    effectRuntime.calls.some((entry) => entry.action === "deactivate"),
    true,
  );
  assert.deepEqual(
    iffRuntime.readTransponderState(itemStore.findItemById(moduleItem.itemID)),
    { channel: "tribe", code: null, active: false },
  );
  assert.equal(
    iffRuntime.resolveActiveTransponder(OWNER_ID, ship.itemID, {
      readCreationState: () => ({
        modules: [{ itemID: moduleItem.itemID, typeID: TYPE_TRANSPONDER }],
      }),
      isCreationModuleOnline: () => true,
    }),
    null,
  );
});

test("beacon activation publishes a one-cycle immobilizing Dogma effect", () => {
  const shipGrant = itemStore.grantItemToCharacterLocation(
    OWNER_ID,
    SOLAR_SYSTEM_ID,
    itemStore.ITEM_FLAGS.HANGAR,
    95276,
    1,
    { individualItems: true, singleton: 1 },
  );
  assert.equal(shipGrant.success, true, shipGrant.errorMsg);
  const ship = shipGrant.data.items[0];
  assert.equal(itemStore.updateInventoryItem(ship.itemID, (currentItem) => ({
    ...currentItem,
    locationID: SOLAR_SYSTEM_ID,
    spaceState: {
      systemID: SOLAR_SYSTEM_ID,
      position: { x: 1, y: 2, z: 3 },
    },
  })).success, true);

  const moduleGrant = itemStore.grantItemToCharacterLocation(
    OWNER_ID,
    ship.itemID,
    creationRuntime.CREATION_FITTING_FLAG_ID,
    TYPE_BEACON,
    1,
    {
      individualItems: true,
      singleton: 1,
      moduleState: { online: true },
    },
  );
  assert.equal(moduleGrant.success, true, moduleGrant.errorMsg);
  const moduleItem = moduleGrant.data.items[0];
  const effectRuntime = buildIffEffectRuntime(ship.itemID);
  const session = {
    charid: OWNER_ID,
    characterID: OWNER_ID,
    shipid: ship.itemID,
    solarsystemid: SOLAR_SYSTEM_ID,
    solarsystemid2: SOLAR_SYSTEM_ID,
    corpid: 98000001,
    _space: { systemID: SOLAR_SYSTEM_ID },
    sendNotification() {},
  };
  const creationContext = {
    item: itemStore.findItemById(ship.itemID),
    characterID: OWNER_ID,
    state: {
      modules: [{
        itemID: moduleItem.itemID,
        typeID: TYPE_BEACON,
        abilities: creationRuntime.getCreationModuleAbilities(TYPE_BEACON),
      }],
    },
  };
  const invoke = (ability) => creationAbilityRuntime.dispatchCreationAbility({
    ability,
    kwargs: { iff_channel: "tribe" },
    session,
    creationContext,
    moduleItemID: moduleItem.itemID,
    abilityDependencies: { spaceRuntime: effectRuntime.runtime },
  });

  const activated = invoke("activate_effect");
  assert.equal(activated.success, true, activated.errorMsg);
  const activation = effectRuntime.calls.find((entry) => entry.action === "activate");
  assert.equal(activation.effectName, "iffBeacon");
  assert.equal(activation.options.repeat, 0);
  assert.equal(activation.effectState.effectID, 12974);
  assert.equal(activation.effectState.immobilizesShip, true);
  assert.equal(
    effectRuntime.calls.some((entry) => entry.action === "stopShip"),
    true,
  );
  assert.ok(iffRuntime.getActiveBeacon(moduleItem.itemID));

  const deactivated = invoke("deactivate_effect");
  assert.equal(deactivated.success, true, deactivated.errorMsg);
  assert.equal(iffRuntime.getActiveBeacon(moduleItem.itemID), null);
  assert.equal(effectRuntime.entity.activeModuleEffects.has(moduleItem.itemID), false);
  iffRuntime.resetIffRuntimeForTests();
});

function buildBeacon(overrides = {}) {
  return {
    beaconID: 700001,
    typeID: TYPE_BEACON,
    shipID: SHIP_ID,
    characterID: OWNER_ID,
    corporationID: 98000001,
    solarSystemID: SOLAR_SYSTEM_ID,
    position: [1, 2, 3],
    channel: "code",
    code: "RALLY-7",
    startedAtMs: 1000,
    expiresAtMs: 31000,
    ...overrides,
  };
}

function buildViewer(overrides = {}) {
  return {
    characterID: OTHER_OWNER_ID,
    solarSystemID: SOLAR_SYSTEM_ID,
    corporationID: 98000001,
    transponder: { channel: "code", code: "RALLY-7" },
    ...overrides,
  };
}

test("beacon visibility requires a matching active transponder", () => {
  const beacon = buildBeacon();

  assert.equal(iffRuntime.beaconVisibleToViewer(beacon, buildViewer()), true);

  // Mismatched code.
  assert.equal(
    iffRuntime.beaconVisibleToViewer(
      beacon,
      buildViewer({ transponder: { channel: "code", code: "OTHER" } }),
    ),
    false,
  );
  // No transponder at all.
  assert.equal(
    iffRuntime.beaconVisibleToViewer(beacon, buildViewer({ transponder: null })),
    false,
  );
  // Right code, wrong channel.
  assert.equal(
    iffRuntime.beaconVisibleToViewer(
      beacon,
      buildViewer({ transponder: { channel: "tribe", code: "RALLY-7" } }),
    ),
    false,
  );
  // Cross-system.
  assert.equal(
    iffRuntime.beaconVisibleToViewer(
      beacon,
      buildViewer({ solarSystemID: 30000005 }),
    ),
    false,
  );
  // Owner always sees their own beacon, even without a transponder.
  assert.equal(
    iffRuntime.beaconVisibleToViewer(
      beacon,
      buildViewer({ characterID: OWNER_ID, transponder: null }),
    ),
    true,
  );

  // Tribe channel: same corporation with a tribe transponder.
  const tribeBeacon = buildBeacon({ channel: "tribe", code: null });
  assert.equal(
    iffRuntime.beaconVisibleToViewer(
      tribeBeacon,
      buildViewer({ transponder: { channel: "tribe", code: null } }),
    ),
    true,
  );
  assert.equal(
    iffRuntime.beaconVisibleToViewer(
      tribeBeacon,
      buildViewer({
        corporationID: 98000999,
        transponder: { channel: "tribe", code: null },
      }),
    ),
    false,
  );

  // Public beacons are visible to everyone in the system.
  const publicBeacon = buildBeacon({ channel: "public", code: null });
  assert.equal(
    iffRuntime.beaconVisibleToViewer(publicBeacon, buildViewer({ transponder: null })),
    true,
  );
  assert.equal(
    iffRuntime.beaconVisibleToViewer(
      publicBeacon,
      buildViewer({ solarSystemID: 30000005, transponder: null }),
    ),
    false,
  );
});

test("expired beacons are never visible and are swept", () => {
  const nowMs = 100000;
  assert.equal(iffRuntime.isBeaconLive(buildBeacon({ expiresAtMs: 1 }), nowMs), false);
  assert.equal(iffRuntime.isBeaconLive(null, nowMs), false);
});

test("verdicts only pair mutually matching transponders", () => {
  const viewer = {
    shipID: 1,
    corporationID: 98000001,
    transponder: { channel: "code", code: "RALLY-7" },
  };
  const ships = [
    viewer,
    { shipID: 2, corporationID: 98000001, transponder: { channel: "code", code: "RALLY-7" } },
    { shipID: 3, corporationID: 98000001, transponder: { channel: "code", code: "NOPE" } },
    { shipID: 4, corporationID: 98000001, transponder: null },
  ];
  assert.deepEqual(buildVerdictsForViewer(viewer, ships), [[2, true]]);
});

// ── Phase 3: directional scanner ─────────────────────────────────────────

test("scan request validation follows client-authored angle bounds", () => {
  assert.equal(
    scanningRuntime.normalizeScanRequest({ scan_angle: 1, scan_direction: [0, 0, 1] }).errorMsg,
    "SCAN_ANGLE_OUT_OF_RANGE",
  );
  assert.equal(
    scanningRuntime.normalizeScanRequest({ scan_angle: 46, scan_direction: [0, 0, 1] }).errorMsg,
    "SCAN_ANGLE_OUT_OF_RANGE",
  );
  assert.equal(
    scanningRuntime.normalizeScanRequest({ scan_angle: 2.5, scan_direction: [0, 0, 1] }).angleDegrees,
    2.5,
  );
  assert.equal(
    scanningRuntime.normalizeScanRequest({ scan_angle: 45, scan_direction: [0, 0, 1] }).angleDegrees,
    45,
  );
  // Missing angle falls back to the client default.
  assert.equal(
    scanningRuntime.normalizeScanRequest({ scan_direction: [0, 0, 1] }).angleDegrees,
    15,
  );
  assert.equal(
    scanningRuntime.normalizeScanRequest({ scan_angle: 15, scan_direction: [0, 0, 0] }).errorMsg,
    "SCAN_DIRECTION_INVALID",
  );
  assert.equal(
    scanningRuntime.normalizeScanRequest({ scan_angle: 15 }).errorMsg,
    "SCAN_DIRECTION_INVALID",
  );
  // Direction is normalized to a unit vector.
  const request = scanningRuntime.normalizeScanRequest({
    scan_angle: 15,
    scan_direction: [0, 0, 5],
  });
  assert.deepEqual(request.direction, { x: 0, y: 0, z: 1 });
});

test("client-authored SNR helper is reproduced exactly", () => {
  assert.equal(scanningRuntime.calculateSnr(10, 2), 5);
  assert.equal(scanningRuntime.calculateSnr(10, 0), 100);
});

function runScan(candidates, overrides = {}) {
  return scanningRuntime.performDirectionalScan({
    originPosition: { x: 0, y: 0, z: 0 },
    angleDegrees: 15,
    direction: { x: 0, y: 0, z: 1 },
    moduleTypeID: TYPE_SCANNER,
    candidates,
    ...overrides,
  });
}

test("scanner cone includes in-cone and excludes out-of-cone targets", () => {
  const inCone = {
    itemID: 4001,
    typeID: TYPE_SIGNATURE_TARGET,
    position: { x: 0, y: 0, z: 1000000 },
  };
  // 90 degrees off the boresight.
  const outOfCone = {
    itemID: 4002,
    typeID: TYPE_SIGNATURE_TARGET,
    position: { x: 1000000, y: 0, z: 0 },
  };
  // Just outside a 15 degree half-angle (~20 degrees off axis).
  const justOutside = {
    itemID: 4003,
    typeID: TYPE_SIGNATURE_TARGET,
    position: {
      x: Math.sin((20 * Math.PI) / 180) * 1000000,
      y: 0,
      z: Math.cos((20 * Math.PI) / 180) * 1000000,
    },
  };
  // Just inside (~10 degrees off axis).
  const justInside = {
    itemID: 4004,
    typeID: TYPE_SIGNATURE_TARGET,
    position: {
      x: Math.sin((10 * Math.PI) / 180) * 1000000,
      y: 0,
      z: Math.cos((10 * Math.PI) / 180) * 1000000,
    },
  };

  const scan = runScan([inCone, outOfCone, justOutside, justInside]);
  const scannedIds = scan.updatedScans.map((result) => result.scan_id).sort();
  assert.deepEqual(scannedIds, [4001, 4004]);
});

test("scanner enforces the client-authored maximum range", () => {
  const withinRange = {
    itemID: 5001,
    typeID: TYPE_SIGNATURE_TARGET,
    position: { x: 0, y: 0, z: scanningRuntime.MAXIMUM_SCAN_DISTANCE_METERS - 1000 },
  };
  const beyondRange = {
    itemID: 5002,
    typeID: TYPE_SIGNATURE_TARGET,
    position: { x: 0, y: 0, z: scanningRuntime.MAXIMUM_SCAN_DISTANCE_METERS + 1000 },
  };
  const zeroDistance = { itemID: 5003, typeID: TYPE_SIGNATURE_TARGET, position: { x: 0, y: 0, z: 0 } };

  const scan = runScan([withinRange, beyondRange, zeroDistance]);
  assert.deepEqual(scan.updatedScans.map((result) => result.scan_id), [5001]);
});

test("scan ids are stable and deltas report added/removed", () => {
  const target = { itemID: 6001, typeID: TYPE_SIGNATURE_TARGET, position: { x: 0, y: 0, z: 500000 } };
  const other = { itemID: 6002, typeID: TYPE_SIGNATURE_TARGET, position: { x: 0, y: 0, z: 600000 } };

  const first = runScan([target]);
  assert.deepEqual(first.added, [6001]);
  assert.deepEqual(first.removed, []);
  assert.deepEqual(first.scanIds, [6001]);

  // Same target rescanned: stable id, no delta churn.
  const second = runScan([target], { previousScanIds: first.scanIds });
  assert.deepEqual(second.added, []);
  assert.deepEqual(second.removed, []);
  assert.deepEqual(second.updatedScans[0].scan_id, 6001);

  // Target swapped out.
  const third = runScan([other], { previousScanIds: second.scanIds });
  assert.deepEqual(third.added, [6002]);
  assert.deepEqual(third.removed, [6001]);
});

test("empty scans and empty beacon lists marshal under the frontier profile", () => {
  const emptyScan = runScan([]);
  assert.deepEqual(emptyScan.updatedScans, []);
  assert.deepEqual(emptyScan.resolvedIds, []);
  assert.deepEqual(emptyScan.added, []);
  frontierMarshals(buildScanResponse(emptyScan));

  const populatedScan = runScan([
    { itemID: 7001, typeID: TYPE_SIGNATURE_TARGET, position: { x: 0, y: 0, z: 200000 } },
  ]);
  assert.equal(populatedScan.updatedScans.length, 1);
  frontierMarshals(buildScanResponse(populatedScan));
});

test("scan response uses attribute-style KeyVal with filetime deltas", () => {
  const scan = runScan([
    { itemID: 8001, typeID: TYPE_SIGNATURE_TARGET, position: { x: 0, y: 0, z: 100000 } },
  ]);
  const response = buildScanResponse(scan);

  // The client accesses response.added / .origin / .duration by attribute,
  // so the payload must be util.KeyVal rather than a plain dict.
  assert.equal(response.type, "object");
  assert.equal(response.name, "util.KeyVal");
  const entries = new Map(response.args.entries);
  assert.ok(entries.has("origin"));
  assert.ok(entries.has("duration"));
  assert.ok(entries.has("added"));
  assert.ok(entries.has("removed"));
  assert.ok(entries.has("updated_scans"));
  assert.ok(entries.has("resolved"));

  // duration is a filetime delta (100ns units), not milliseconds.
  assert.equal(typeof entries.get("duration"), "bigint");
  assert.equal(entries.get("duration"), millisecondsToFiletimeDelta(scan.durationMs));
  assert.equal(millisecondsToFiletimeDelta(6000), 60000000n);

  // resolved values are filetime deltas keyed by ball id.
  const resolved = entries.get("resolved");
  assert.equal(resolved.type, "dict");
  for (const [ballID, delta] of resolved.entries) {
    assert.equal(typeof ballID, "number");
    assert.equal(typeof delta, "bigint");
  }
  frontierMarshals(response);
});

test("scan duration and signature multipliers come from authored dogma", () => {
  assert.equal(scanningRuntime.resolveScanDurationMs(TYPE_SCANNER), 6000);
  const multipliers = scanningRuntime.resolveSignatureMultipliers(TYPE_SCANNER);
  assert.deepEqual(multipliers.map(([type]) => type).sort(), [1, 2, 3]);
  for (const [, multiplier] of multipliers) {
    assert.equal(multiplier, 500);
  }
});
