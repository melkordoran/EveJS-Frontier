"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  MAX_ACCOUNT_ROLE,
  SESSION_BASE_ROLE_MASK,
} = require("../src/services/account/accountRoleProfiles");
const deploymentRuntime = require("../src/services/frontier/deploymentRuntime");
const networkNodeFuelRuntime = require(
  "../src/services/frontier/networkNodeFuelRuntime",
);
const sessionRegistry = require("../src/services/chat/sessionRegistry");
const {
  COMMAND_USAGE,
  executeFrontierAssemblyCommand,
  parseItemID,
  tokenizeArguments,
} = require("../src/services/frontier/assemblyChatCommands");
const {
  AVAILABLE_SLASH_COMMANDS,
  executeChatCommand,
} = require("../src/services/chat/chatCommands");
const spaceRuntime = require("../src/space/runtime");
const {
  findItemById,
  getActiveShipItem,
  getItemMetadata,
  grantItemToCharacterLocation,
  removeInventoryItem,
  updateInventoryItem,
} = require("../src/services/inventory/itemStore");

const DEFINITIONS = Object.freeze([
  {
    assemblyTypeID: 77917,
    constructionSiteTypeID: 91715,
    createOnChain: true,
    name: "Heavy Storage",
    published: true,
  },
  {
    assemblyTypeID: 92404,
    constructionSiteTypeID: 92407,
    createOnChain: true,
    name: "Heavy Turret",
    published: false,
  },
]);

function buildSession(overrides = {}) {
  return {
    accountRole: MAX_ACCOUNT_ROLE.toString(),
    characterID: 140000005,
    role: SESSION_BASE_ROLE_MASK,
    shipid: 9988400001895,
    solarsystemid: 30000004,
    solarsystemid2: 30000004,
    ...overrides,
  };
}

function buildDependencies(overrides = {}) {
  const calls = [];
  const runtime = {
    hasAssemblyAdminPrivileges: deploymentRuntime.hasAssemblyAdminPrivileges,
    listAssemblyDefinitions: () => DEFINITIONS.map((entry) => ({ ...entry })),
    listAssemblies: () => [],
    getAssemblyRecord: () => null,
    adminSpawnAssembly(session, typeID, position, options) {
      calls.push({ action: "spawn", options, position, session, typeID });
      return {
        success: true,
        data: {
          record: {
            assemblyStatus: options.assemblyStatus || 1,
            assemblyTypeID: typeID,
            destinationGateID: 0,
            itemID: 9988400004000,
            name: typeID === 92404 ? "Heavy Turret" : "Heavy Storage",
            ownerID: session.characterID,
            position,
            published: typeID !== 92404,
            solarSystemID: session.solarsystemid2,
            targetSolarSystemID: 0,
          },
        },
      };
    },
    adminSetAssemblyState() {
      calls.push({ action: "state" });
      return { success: true, data: {} };
    },
    adminLinkSmartGates() {
      calls.push({ action: "link" });
      return { success: true, data: {} };
    },
    adminUnlinkSmartGate() {
      calls.push({ action: "unlink" });
      return { success: true, data: {} };
    },
    adminCompleteConstruction() {
      calls.push({ action: "complete" });
      return { success: true, data: {} };
    },
    adminRemoveAssembly(_session, itemID) {
      calls.push({ action: "remove", itemID });
      return { success: true, data: {} };
    },
    ...overrides.deploymentRuntime,
  };
  return {
    calls,
    options: {
      deploymentRuntime: runtime,
      spaceRuntime: overrides.spaceRuntime || {
        getSceneForSession: () => ({
          systemID: 30000004,
          getShipEntityForSession: () => ({
            itemID: 9988400001895,
            direction: { x: 1, y: 0, z: 0 },
            position: { x: 100, y: 200, z: 300 },
          }),
        }),
      },
    },
  };
}

test("Frontier Smart Assembly catalog includes published and hidden end types only", () => {
  const definitions = deploymentRuntime.listAssemblyDefinitions();
  const byID = new Map(definitions.map((entry) => [entry.assemblyTypeID, entry]));

  assert.equal(definitions.length >= 39, true);
  assert.equal(byID.get(77917).name, "Heavy Storage");
  assert.equal(byID.get(77917).published, true);
  assert.equal(byID.get(92404).name, "Heavy Turret");
  assert.equal(byID.get(92404).published, false);
  assert.equal(byID.has(91715), false, "construction site is not an end assembly");
  assert.equal(byID.has(85249), false, "legacy deployable is not a Smart Assembly");
});

test("assembly help and catalog route through the shared slash dispatcher", () => {
  const dependencies = buildDependencies();
  const help = executeChatCommand(
    buildSession(),
    "/assembly help",
    null,
    { emitChatFeedback: false, assemblyCommandOptions: dependencies.options },
  );
  assert.equal(help.handled, true);
  assert.equal(help.message, COMMAND_USAGE);
  assert.ok(AVAILABLE_SLASH_COMMANDS.includes("assembly"));
  assert.ok(AVAILABLE_SLASH_COMMANDS.includes("assemblies"));

  const hidden = executeFrontierAssemblyCommand(
    buildSession(),
    "types hidden turret",
    dependencies.options,
  );
  assert.equal(hidden.success, true);
  assert.match(hidden.message, /92404: Heavy Turret \[hidden\]/u);
  assert.doesNotMatch(hidden.message, /Heavy Storage/u);
});

test("assembly mutations trust accountRole only and reject composed-role spoofing", () => {
  const dependencies = buildDependencies();
  const denied = executeFrontierAssemblyCommand(
    buildSession({
      accountRole: "0",
      role: MAX_ACCOUNT_ROLE | SESSION_BASE_ROLE_MASK,
    }),
    "spawn Heavy Storage ahead=250",
    dependencies.options,
  );

  assert.equal(denied.success, false);
  assert.match(denied.message, /elevated GM account role/u);
  assert.equal(dependencies.calls.length, 0);
  assert.equal(
    deploymentRuntime.hasAssemblyAdminPrivileges({
      accountRole: "0",
      role: MAX_ACCOUNT_ROLE,
    }),
    false,
  );
  assert.equal(
    deploymentRuntime.hasAssemblyAdminPrivileges({
      accountRole: MAX_ACCOUNT_ROLE.toString(),
    }),
    true,
  );
});

test("assembly spawn resolves end-type names inside the Smart Assembly catalog", () => {
  const dependencies = buildDependencies();
  const result = executeFrontierAssemblyCommand(
    buildSession(),
    'spawn "Heavy Storage" ahead=250 state=offline',
    dependencies.options,
  );

  assert.equal(result.success, true);
  assert.equal(dependencies.calls.length, 1);
  assert.equal(dependencies.calls[0].action, "spawn");
  assert.equal(dependencies.calls[0].typeID, 77917);
  assert.deepEqual(dependencies.calls[0].position, { x: 350, y: 200, z: 300 });
  assert.equal(dependencies.calls[0].options.assemblyStatus, 1);
  assert.match(result.message, /Spawned Heavy Storage 9988400004000/u);

  const hidden = executeFrontierAssemblyCommand(
    buildSession(),
    "spawn Heavy Turret here",
    dependencies.options,
  );
  assert.equal(hidden.success, true);
  assert.equal(dependencies.calls[1].typeID, 92404);
  assert.match(hidden.message, /hidden/u);
});

test("assembly parser rejects unsafe IDs, unterminated names, and unconfirmed removal", () => {
  const dependencies = buildDependencies();
  for (const value of ["0", "-1", "1.5", "1e3", "9007199254740993"]) {
    assert.equal(parseItemID(value), 0);
  }
  assert.equal(tokenizeArguments('spawn "Heavy Storage').success, false);

  const unsafe = executeFrontierAssemblyCommand(
    buildSession(),
    "remove 9007199254740993 confirm",
    dependencies.options,
  );
  assert.equal(unsafe.success, false);
  assert.equal(dependencies.calls.length, 0);

  const unconfirmed = executeFrontierAssemblyCommand(
    buildSession(),
    "remove 9988400004000",
    dependencies.options,
  );
  assert.equal(unconfirmed.success, false);
  assert.equal(dependencies.calls.length, 0);

  const trailing = executeFrontierAssemblyCommand(
    buildSession(),
    "state 9988400004000 online trailing",
    dependencies.options,
  );
  assert.equal(trailing.success, false);
  assert.equal(dependencies.calls.length, 0);

  const duplicateState = executeFrontierAssemblyCommand(
    buildSession(),
    "spawn Heavy Storage state=offline state=online",
    dependencies.options,
  );
  assert.equal(duplicateState.success, false);
  assert.equal(dependencies.calls.length, 0);

  const trailingList = executeFrontierAssemblyCommand(
    buildSession(),
    "list all trailing",
    dependencies.options,
  );
  assert.equal(trailingList.success, false);

  const trailingInfo = executeFrontierAssemblyCommand(
    buildSession(),
    "info 9988400004000 trailing",
    dependencies.options,
  );
  assert.equal(trailingInfo.success, false);

  const confirmed = executeFrontierAssemblyCommand(
    buildSession(),
    "remove 9988400004000 confirm",
    dependencies.options,
  );
  assert.equal(confirmed.success, true);
  assert.deepEqual(dependencies.calls, [{
    action: "remove",
    itemID: 9988400004000,
  }]);
});

test("admin runtime spawns hidden assemblies and refuses to delete their contents", () => {
  const session = buildSession({ sendNotification() {} });
  const ship = getActiveShipItem(session.characterID);
  assert.ok(ship);
  const originalShip = structuredClone(findItemById(ship.itemID));
  const moveShip = updateInventoryItem(ship.itemID, (current) => ({
    ...current,
    flagID: 0,
    locationID: session.solarsystemid2,
    spaceState: {
      ...(current.spaceState || {}),
      position: { x: 100, y: 200, z: 300 },
      systemID: session.solarsystemid2,
    },
  }));
  assert.equal(moveShip.success, true);

  const originalGetEntity = spaceRuntime.getEntity;
  const originalSpawn = spaceRuntime.spawnDynamicInventoryEntity;
  let spawnedItemID = 0;
  let childItemID = 0;
  let networkNodeItemID = 0;
  const ownerNotifications = [];
  const ownerSession = {
    ...session,
    socket: { destroyed: false },
    sendNotification(...args) {
      ownerNotifications.push(args);
    },
  };
  sessionRegistry.register(ownerSession);
  spaceRuntime.getEntity = (_session, itemID) => (
    Number(itemID) === Number(ship.itemID)
      ? {
        itemID: ship.itemID,
        direction: { x: 1, y: 0, z: 0 },
        position: { x: 100, y: 200, z: 300 },
      }
      : null
  );
  spaceRuntime.spawnDynamicInventoryEntity = () => ({
    success: true,
    data: {},
  });

  try {
    const denied = deploymentRuntime.adminSpawnAssembly(
      buildSession({ accountRole: "0", sendNotification() {} }),
      92404,
      { x: 500, y: 200, z: 300 },
    );
    assert.equal(denied.success, false);
    assert.equal(denied.errorMsg, "ASSEMBLY_ADMIN_ACCESS_DENIED");

    const spawned = deploymentRuntime.adminSpawnAssembly(
      session,
      92404,
      { x: 500, y: 200, z: 300 },
    );
    assert.equal(spawned.success, true);
    spawnedItemID = spawned.data.item.itemID;
    assert.equal(spawned.data.record.published, false);
    assert.equal(spawned.data.record.assemblyStatus, 1);
    assert.equal(findItemById(spawnedItemID).typeID, 92404);
    assert.equal(
      deploymentRuntime.adminCompleteConstruction(session, spawnedItemID).errorMsg,
      "CONSTRUCTION_ALREADY_COMPLETE",
    );

    const online = deploymentRuntime.adminSetAssemblyState(
      buildSession({ characterID: 140000006 }),
      spawnedItemID,
      2,
    );
    assert.equal(online.success, true);
    assert.equal(online.data.record.assemblyStatus, 2);
    assert.ok(ownerNotifications.some(([name]) => name === "OnItemsChanged"));
    assert.equal(
      deploymentRuntime.adminRemoveAssembly(session, spawnedItemID).errorMsg,
      "ASSEMBLY_MUST_BE_OFFLINE",
    );
    assert.equal(
      deploymentRuntime.adminSetAssemblyState(session, spawnedItemID, 1).success,
      true,
    );

    const shipBeforeBerthMarker = structuredClone(findItemById(ship.itemID));
    assert.equal(
      updateInventoryItem(ship.itemID, (current) => ({
        ...current,
        customInfo: `Berth:${spawnedItemID}`,
      })).success,
      true,
    );
    const occupied = deploymentRuntime.adminRemoveAssembly(session, spawnedItemID);
    assert.equal(occupied.success, false);
    assert.equal(occupied.errorMsg, "ASSEMBLY_OCCUPIED");
    assert.ok(findItemById(spawnedItemID));
    assert.equal(
      updateInventoryItem(ship.itemID, () => shipBeforeBerthMarker).success,
      true,
    );

    const child = grantItemToCharacterLocation(
      session.characterID,
      spawnedItemID,
      66,
      getItemMetadata(34),
      10,
    );
    assert.equal(child.success, true);
    childItemID = child.data.items[0].itemID;
    const blocked = deploymentRuntime.adminRemoveAssembly(session, spawnedItemID);
    assert.equal(blocked.success, false);
    assert.equal(blocked.errorMsg, "ASSEMBLY_NOT_EMPTY");
    assert.ok(findItemById(spawnedItemID));
    assert.ok(findItemById(childItemID));

    assert.equal(removeInventoryItem(childItemID, { removeContents: true }).success, true);
    childItemID = 0;
    assert.equal(
      deploymentRuntime.adminRemoveAssembly(session, spawnedItemID).success,
      true,
    );
    assert.equal(findItemById(spawnedItemID), null);
    spawnedItemID = 0;

    const networkNode = deploymentRuntime.adminSpawnAssembly(
      session,
      88092,
      { x: 700, y: 200, z: 300 },
      { assemblyStatus: 1 },
    );
    assert.equal(networkNode.success, true);
    networkNodeItemID = networkNode.data.item.itemID;
    assert.equal(
      networkNodeFuelRuntime.writeNetworkNodeFuelState(networkNodeItemID, {
        quantity: 25,
        typeID: 77818,
        updatedAtMs: Date.now(),
      }).success,
      true,
    );
    const fueled = deploymentRuntime.adminRemoveAssembly(
      session,
      networkNodeItemID,
    );
    assert.equal(fueled.success, false);
    assert.equal(fueled.errorMsg, "ASSEMBLY_NOT_EMPTY");
    assert.equal(fueled.data.fuelQuantity, 25);
    assert.ok(findItemById(networkNodeItemID));
    assert.equal(
      networkNodeFuelRuntime.writeNetworkNodeFuelState(networkNodeItemID, {
        quantity: 0,
        typeID: 77818,
        updatedAtMs: Date.now(),
      }).success,
      true,
    );
    assert.equal(
      deploymentRuntime.adminRemoveAssembly(session, networkNodeItemID).success,
      true,
    );
    assert.equal(findItemById(networkNodeItemID), null);
    networkNodeItemID = 0;
  } finally {
    sessionRegistry.unregister(ownerSession);
    spaceRuntime.getEntity = originalGetEntity;
    spaceRuntime.spawnDynamicInventoryEntity = originalSpawn;
    if (childItemID && findItemById(childItemID)) {
      removeInventoryItem(childItemID, { removeContents: true });
    }
    if (spawnedItemID && findItemById(spawnedItemID)) {
      removeInventoryItem(spawnedItemID, { removeContents: true });
    }
    if (networkNodeItemID && findItemById(networkNodeItemID)) {
      removeInventoryItem(networkNodeItemID, { removeContents: true });
    }
    updateInventoryItem(ship.itemID, () => originalShip);
    deploymentRuntime._testing.clearPendingAssemblyTransitions();
    deploymentRuntime._testing.clearCompletionTimers();
  }
});

test("admin Smart Gate link and unlink preserve reciprocal state", () => {
  const ownerID = 140000005;
  const nowMs = Date.now();
  const gateMetadata = getItemMetadata(84955);
  const createGate = (systemID, x) => {
    const result = require("../src/services/inventory/itemStore")
      .createSpaceItemForCharacter(ownerID, systemID, gateMetadata, {
        customInfo: deploymentRuntime._testing.writeConstructionState(null, {
          assemblyStatus: 1,
          assemblyTypeID: 84955,
          completeAtMs: 0,
          completedAtMs: nowMs,
          constructionCost: { 88783: 1050, 89089: 225, 92483: 42 },
          constructionSiteTypeID: 91712,
          createdAtMs: nowMs,
          destinationGateID: 0,
          durationSeconds: 51840,
          ownerID,
          solarSystemID: systemID,
          targetSolarSystemID: 0,
        }),
        mode: "STOP",
        position: { x, y: 0, z: 0 },
      });
    assert.equal(result.success, true);
    return result.data.itemID;
  };
  const sourceID = createGate(30000004, 1_000);
  const destinationID = createGate(30000005, 2_000);
  const session = buildSession({ sendNotification() {} });

  try {
    const linked = deploymentRuntime.adminLinkSmartGates(
      session,
      sourceID,
      destinationID,
    );
    assert.equal(linked.success, true);
    let sourceState = deploymentRuntime.readConstructionState(findItemById(sourceID));
    let destinationState = deploymentRuntime.readConstructionState(
      findItemById(destinationID),
    );
    assert.equal(sourceState.destinationGateID, destinationID);
    assert.equal(sourceState.targetSolarSystemID, 30000005);
    assert.equal(destinationState.destinationGateID, sourceID);
    assert.equal(destinationState.targetSolarSystemID, 30000004);
    assert.equal(
      deploymentRuntime.adminRemoveAssembly(session, destinationID).errorMsg,
      "SMART_GATE_MUST_BE_UNLINKED",
    );

    assert.equal(
      updateInventoryItem(destinationID, (current) => ({
        ...current,
        customInfo: deploymentRuntime._testing.writeConstructionState(
          current,
          {
            ...destinationState,
            destinationGateID: 0,
            targetSolarSystemID: 0,
          },
        ),
      })).success,
      true,
    );
    assert.equal(
      deploymentRuntime.adminRemoveAssembly(session, destinationID).errorMsg,
      "SMART_GATE_MUST_BE_UNLINKED",
      "an inbound one-sided link must still block removal",
    );
    assert.equal(
      updateInventoryItem(destinationID, (current) => ({
        ...current,
        customInfo: deploymentRuntime._testing.writeConstructionState(
          current,
          destinationState,
        ),
      })).success,
      true,
    );

    const unlinked = deploymentRuntime.adminUnlinkSmartGate(session, sourceID);
    assert.equal(unlinked.success, true);
    sourceState = deploymentRuntime.readConstructionState(findItemById(sourceID));
    destinationState = deploymentRuntime.readConstructionState(findItemById(destinationID));
    assert.equal(sourceState.destinationGateID, 0);
    assert.equal(sourceState.targetSolarSystemID, 0);
    assert.equal(destinationState.destinationGateID, 0);
    assert.equal(destinationState.targetSolarSystemID, 0);

    assert.equal(
      updateInventoryItem(sourceID, (current) => ({
        ...current,
        customInfo: deploymentRuntime._testing.writeConstructionState(
          current,
          {
            ...sourceState,
            destinationGateID: destinationID,
            targetSolarSystemID: 30000005,
          },
        ),
      })).success,
      true,
    );
    const repaired = deploymentRuntime.adminUnlinkSmartGate(session, sourceID);
    assert.equal(repaired.success, true);
    assert.equal(repaired.data.repairedSourceOnly, true);
    assert.equal(
      deploymentRuntime.readConstructionState(findItemById(sourceID))
        .destinationGateID,
      0,
    );
  } finally {
    removeInventoryItem(sourceID, { removeContents: true });
    removeInventoryItem(destinationID, { removeContents: true });
    deploymentRuntime._testing.clearPendingAssemblyTransitions();
  }
});
