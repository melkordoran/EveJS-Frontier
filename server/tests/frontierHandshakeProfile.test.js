"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const zlib = require("node:zlib");

const {
  crcHqx,
  selectHandshakeSignedFunc,
  selectPlaceboChallengeResponseHash,
  selectVersionExchangeRelease,
  usesNoOpHandshakeSignedFunc,
} = require("../src/network/tcp/handshakeCompatibility");
const {
  framePayload,
  readPacketLength,
  usesBigEndianPacketLengths,
} = require("../src/network/tcp/packetFraming");
const {
  marshalDecode,
  marshalDecodeExact,
  marshalEncode,
} = require("../src/network/tcp/utils/marshal");
const { decodePacket } = require("../src/common/pyPacket");
const { encodeAddress } = require("../src/common/machoAddress");
const {
  buildCachedMethodCallResult,
  getCachableObjectResponse,
} = require("../src/services/cache/objectCacheRuntime");
const {
  normalizeActivationStateForProfile,
  normalizeInfoAttributesForProfile,
  normalizePackedInstanceRowForProfile,
} = require("../src/services/dogma/dogmaInfoCompatibility");
const {
  normalizeCombatTimersForProfile,
} = require("../src/services/security/crimewatchCompatibility");
const {
  buildDestinyConfigurationSettings,
  defersUndockBallparkStateUntilBeyonceBind,
} = require("../src/services/ship/destinyCompatibility");
const {
  createDestinyWarpUpdateBuilders,
} = require("../src/space/destiny/simulation/warpBuilders");
const {
  createDestinyMovementSimulator,
} = require("../src/space/destiny/simulation/movement");
const {
  clearTrackingState,
} = require("../src/space/destiny/simulation/motionState");
const {
  createMovementManualFlightCommands,
} = require("../src/space/destiny/commands/manualFlightCommands");
const {
  getPayloadPrimaryEntityID,
} = require("../src/space/destiny/protocol/payloadIdentity");
const {
  isDestinyPayload,
} = require("../src/space/destiny/protocol/payloads");
const {
  normalizeCrDataDictionaryForProfile,
  normalizeSlimItemObjectForProfile,
  usesCrDataBallMetadata,
  usesCrDataSetState,
  usesFrontierStateStreamPreamble,
  usesWireSlimItemObjects,
} = require("../src/space/destiny/stream/statePayloadCompatibility");
const {
  buildSlimItemPresentationUpdates,
  buildStructureLifecyclePresentationUpdates,
} = require("../src/space/destiny/presentation/specialFxPayloads");
const {
  encodeEntityBall,
} = require("../src/space/destiny/stream/ballEncoding");
const {
  buildAddBalls2Payload,
  buildSetStatePayload,
} = require("../src/space/destiny/stream/statePayloads");
const {
  buildSlimItemDict,
} = require("../src/space/destiny");
const SmartAssemblyService = require(
  "../src/services/frontier/smartAssemblyService",
);
const BeyonceService = require("../src/services/ship/beyonceService");
const DogmaService = require("../src/services/dogma/dogmaService");
const frontierSpaceRuntime = require("../src/space/runtime");
const CairnService = require("../src/services/frontier/cairnService");
const IffMapService = require("../src/services/frontier/iffMapService");
const {
  buildEmptyCrudeRiftInfo,
  buildEmptySystemInfo,
} = require("../src/services/frontier/systemInfoService");
const {
  buildItemsInSystemsRowset,
} = require("../src/services/character/charMgrGlobalAssetsRowsets");
const {
  buildSettingsInfoCode,
} = require("../src/services/character/settingsInfoCompatibility");
const {
  buildCreationDiagnostic,
  buildCreationSnapshot,
} = require("../src/services/frontier/creationCompatibility");
const {
  buildCreationShipAttributeModifierEntries,
  CREATION_FITTING_FLAG_ID,
  buildCreationSeedPlan,
  buildSeededCreationState,
  filterCreationModuleInventoryItems,
  getCreationModuleAbilities,
  normalizeCreationState,
} = require("../src/services/frontier/creationRuntime");
const {
  applyModifierGroups,
} = require("../src/services/fitting/liveFittingState");
const DeploymentMgrService = require(
  "../src/services/frontier/deploymentMgrService",
);
const {
  ASSEMBLY_STATUS_OFFLINE,
  ASSEMBLY_STATUS_ONLINE,
  ASSEMBLY_STATUS_UNDER_CONSTRUCTION,
  hydrateConstructionEntityFromInventoryItem,
  _testing: deploymentContractTesting,
} = require("../src/services/frontier/deploymentRuntime");
const {
  BERTHING_PHASE_APPROACHING,
  BERTHING_PHASE_BERTHED,
  BERTHING_PHASE_DEPARTING,
  berth,
  getContractForSession,
  undockBerth,
  _testing: berthingContractTesting,
} = require("../src/services/frontier/berthingRuntime");
const StargateService = require("../src/services/frontier/stargateService");
const ExperienceService = require("../src/services/frontier/experienceService");
const {
  buildEmptyMemories,
} = ExperienceService;
const StatusEffectMgrService = require(
  "../src/services/frontier/statusEffectMgrService",
);
const ShellManagerService = require(
  "../src/services/frontier/shellManagerService",
);
const IndustryService = require(
  "../src/services/frontier/industryService",
);
const InvBrokerService = require(
  "../src/services/inventory/invBrokerService",
);
const BerthingSvcService = require(
  "../src/services/frontier/berthingSvcService",
);
const {
  GET_METADATA_REQUEST,
  GET_ALL_OWNED_REQUEST,
  createAssemblyGateGatewayService,
} = require(
  "../src/_secondary/express/gatewayServices/assemblyGateGatewayService",
);
const {
  getAssemblyGateProtoTypes,
} = require(
  "../src/_secondary/express/gatewayServices/assemblyGateProto",
);
const {
  MarketDaemonClient,
} = require("../src/services/market/marketDaemonClient");
const {
  shouldIncludeAgentRecord,
} = require("../src/services/agent/agentCompatibility");
const {
  resolveDefaultStartupSystemIDs,
} = require("../src/space/startupPreloadCompatibility");
const {
  skillLevelRecords,
} = require("../../tools/DatabaseCreator/database-creator");
const {
  encodeCharacterBrainEffectLists,
} = require(
  "../src/services/dogma/brain/characterBrainCompatibility",
);
const {
  buildCharacterSkillEntry,
} = require("../src/services/skills/skillTransport");
const {
  executeChatCommand,
} = require("../src/services/chat/chatCommands");
const {
  getActiveShipRecord,
} = require("../src/services/character/characterState");
const {
  ITEM_FLAGS,
  createSpaceItemForCharacter,
  findItemById,
  getItemMetadata,
  listCharacterItems,
  listContainerItems,
  removeInventoryItem,
  updateInventoryItem,
} = require("../src/services/inventory/itemStore");

test("Frontier smart assembly startup returns an iterable empty collection", () => {
  const service = new SmartAssemblyService();

  assert.deepEqual(service.Handle_get_my_assemblies(), {
    type: "list",
    items: [],
  });
});

test("Frontier system view returns an iterable empty cairn collection", () => {
  for (const service of [new CairnService(), new IffMapService()]) {
    const cairns = service.Handle_get_visible_cairns();

    assert.deepEqual(cairns, {
      type: "list",
      items: [],
    });
    assert.doesNotThrow(() =>
      marshalEncode(cairns, { compatibilityProfile: "frontier" }),
    );
  }
  assert.equal(new IffMapService().name, "iffMapService");
});

test("Frontier system view returns an iterable empty IFF beacon collection", () => {
  const service = new IffMapService();
  // No session context and no active beacons: the collection must still be a
  // marshallable empty list rather than null/undefined (system-view fix).
  const beacons = service.Handle_get_visible_beacons([], null);

  assert.deepEqual(beacons, {
    type: "list",
    items: [],
  });
  assert.doesNotThrow(() =>
    marshalEncode(beacons, { compatibilityProfile: "frontier" }),
  );
  // set_transponder rejects an unresolvable/unowned item instead of throwing.
  assert.equal(service.Handle_set_transponder([], null), false);
  assert.equal(
    service.Handle_set_transponder([0, "tribe", null], { charid: 140000005 }),
    false,
  );
});

test("Frontier system resource startup returns complete empty dictionaries", () => {
  assert.deepEqual(buildEmptySystemInfo(), {
    type: "dict",
    entries: [
      ["danger_level", null],
      ["resource_composition", { type: "list", items: [] }],
      ["feature_resource_composition", { type: "dict", entries: [] }],
      ["resource_potential_bucket", null],
      ["feature_resource_potential_bucket", { type: "dict", entries: [] }],
      ["site_resource_potential_bucket", { type: "dict", entries: [] }],
    ],
  });
  assert.deepEqual(buildEmptyCrudeRiftInfo(), {
    type: "dict",
    entries: [
      ["points", 0],
      ["counts", { type: "dict", entries: [] }],
    ],
  });
  assert.doesNotThrow(() =>
    marshalEncode(buildEmptySystemInfo(), {
      compatibilityProfile: "frontier",
    }),
  );
});

test("Frontier creation snapshots satisfy the required client model", () => {
  const snapshot = buildCreationSnapshot({
    itemID: 9988400000487,
    typeID: 87698,
    ownerID: 140000005,
  }, 140000005);

  assert.deepEqual(snapshot, {
    type: "dict",
    entries: [
      ["item_id", 9988400000487],
      ["type_id", 87698],
      ["owner_id", 140000005],
      ["access_control", {
        type: "dict",
        entries: [["default", "owner"]],
      }],
      ["layout", { type: "dict", entries: [] }],
      ["modules", { type: "dict", entries: [] }],
      ["interior_placements", { type: "dict", entries: [] }],
      ["hardpoints", { type: "list", items: [] }],
    ],
  });
  assert.doesNotThrow(() => marshalEncode(snapshot, {
    compatibilityProfile: "frontier",
  }));
});

test("Frontier creation templates become populated client fitting models", () => {
  const template = {
    typeID: 95276,
    parts: {
      1: {
        graphic_id: 34625,
        position: [1, 2, 3],
        rotation: [0, 0, 0, 1],
      },
    },
    interior_modules: [{
      type_id: 95320,
      part_id: 1,
      position: [4, 5, 6],
      rotation: [0, 0, 90],
      hardpoints: [{
        exterior_type_id: 95326,
        part_id: 1,
        position: [7, 8, 9],
        rotation: [0, 0, 0, 1],
      }],
    }],
  };
  const plan = buildCreationSeedPlan(template);
  const state = buildSeededCreationState(
    template,
    9988400001895,
    plan,
    [
      { itemID: 9988400002100, typeID: 95320 },
      { itemID: 9988400002101, typeID: 95326 },
    ],
  );
  const snapshot = buildCreationSnapshot({
    itemID: 9988400001895,
    typeID: 95276,
    ownerID: 140000005,
  }, 140000005, state, template);
  const fields = Object.fromEntries(snapshot.entries);

  assert.deepEqual(plan.map(({ kind, typeID }) => ({ kind, typeID })), [
    { kind: "interior", typeID: 95320 },
    { kind: "exterior", typeID: 95326 },
  ]);
  assert.equal(fields.layout.entries[0][0], "parts");
  assert.equal(fields.modules.entries.length, 2);
  assert.equal(fields.interior_placements.entries.length, 1);
  assert.equal(fields.hardpoints.items.length, 1);
  assert.deepEqual(
    Object.fromEntries(fields.hardpoints.items[0].entries).attached_item_id,
    9988400002101,
  );
  assert.doesNotThrow(() => marshalEncode(snapshot, {
    compatibilityProfile: "frontier",
  }));
});

test("Frontier creation module abilities follow static online effects", () => {
  assert.equal(CREATION_FITTING_FLAG_ID, 183);
  const effectsByType = new Map([
    [95320, new Set([16, 12920])],
    [95324, new Set([12094])],
  ]);
  const options = {
    getTypeDogmaEffects: (typeID) => effectsByType.get(typeID) || new Set(),
  };
  assert.deepEqual(
    getCreationModuleAbilities(95320, options),
    ["online", "offline"],
  );
  assert.deepEqual(getCreationModuleAbilities(95324, options), []);

  const normalized = normalizeCreationState({
    templateTypeID: 95276,
    modules: [
      { itemID: 9988400002100, typeID: 95320, abilities: [] },
      { itemID: 9988400002101, typeID: 95324, abilities: ["online"] },
    ],
    interiorPlacements: [],
    hardpoints: [],
  }, options);
  assert.deepEqual(normalized.modules.map((module) => module.abilities), [
    ["online", "offline"],
    [],
  ]);
});

test("Frontier creation inventory hides orphaned fitting generations", () => {
  const ship = {
    customInfo: JSON.stringify({
      evejsFrontierCreation: {
        templateTypeID: 95276,
        modules: [
          { itemID: 101, typeID: 95325 },
          { itemID: 102, typeID: 95324 },
        ],
      },
    }),
  };
  const visibleItems = filterCreationModuleInventoryItems(ship, [
    { itemID: 91, typeID: 95325, flagID: 183 },
    { itemID: 101, typeID: 95325, flagID: 183 },
    { itemID: 102, typeID: 95324, flagID: 183 },
    { itemID: 201, typeID: 78423, flagID: 5 },
  ]);

  assert.deepEqual(visibleItems.map((item) => item.itemID), [101, 102, 201]);
});

test("Frontier creation passive modules derive ship fuel and capacitor capacity", () => {
  const capacitorEffect = [{
    modifierInfo: [{
      func: "ItemModifier",
      domain: "shipID",
      modifiedAttributeID: 482,
      modifyingAttributeID: 482,
      operation: 2,
    }],
  }];
  const fuelCapacityEffect = [{
    modifierInfo: [{
      func: "ItemModifier",
      domain: "shipID",
      modifiedAttributeID: 5633,
      modifyingAttributeID: 5679,
      operation: 2,
    }],
  }];
  const modules = [
    { itemID: 1, typeID: 95325 },
    { itemID: 2, typeID: 95325 },
    { itemID: 3, typeID: 95324 },
    { itemID: 4, typeID: 95324 },
    { itemID: 5, typeID: 95324 },
    { itemID: 6, typeID: 95324 },
    { itemID: 7, typeID: 96013 },
  ];
  const attributesByType = new Map([
    [95325, { 482: 100 }],
    [95324, { 5679: 500 }],
    [96013, { 5679: 250 }],
  ]);
  const effectsByType = new Map([
    [95325, capacitorEffect],
    [95324, fuelCapacityEffect],
    [96013, fuelCapacityEffect],
  ]);
  const modifierEntries = buildCreationShipAttributeModifierEntries(modules, {
    buildEffectiveItemAttributeMap: (item) => attributesByType.get(item.typeID),
    getPassiveModifierEffectRecords: (typeID) => effectsByType.get(typeID),
  });
  const shipAttributes = { 482: 0, 5633: 0 };

  applyModifierGroups(shipAttributes, modifierEntries);

  assert.equal(shipAttributes[482], 200);
  assert.equal(shipAttributes[5633], 2250);
});

test("Frontier Creation ship info exposes derived capacitor and fuel capacity", () => {
  const service = new DogmaService();
  service._getShipRuntimeAttributeOverrides = () => ({
    attributes: { 482: 0, 5633: 0 },
    mass: 1,
    maxVelocity: 0,
    maxTargetRange: 0,
    maxLockedTargets: 0,
    signatureRadius: 0,
    cloakingTargetingDelay: 0,
    scanResolution: 0,
  });
  const attributes = service._buildShipAttributes(
    { characterID: 140000005 },
    {
      itemID: 9988400001895,
      typeID: 95276,
      ownerID: 140000005,
      conditionState: {
        armorDamage: 0,
        charge: 1,
        damage: 0,
        shieldCharge: 1,
      },
    },
    { compatibilityProfile: "frontier" },
    {
      creationDogmaContext: {
        shipAttributeModifierEntries: [
          {
            modifiedAttributeID: 482,
            operation: 2,
            stackingPenalized: false,
            value: 200,
          },
          {
            modifiedAttributeID: 5633,
            operation: 2,
            stackingPenalized: false,
            value: 2250,
          },
        ],
      },
    },
  );

  assert.equal(attributes[18], 200);
  assert.equal(attributes[482], 200);
  assert.equal(attributes[5633], 2250);
});

test("Frontier Creation refreshes derived attributes after Godma hydration", () => {
  const service = new DogmaService();
  const notifications = [];
  const session = {
    _space: {},
    sendNotification(name, idType, payload) {
      notifications.push({ name, idType, payload });
    },
  };

  assert.equal(service._queuePostGetAllInfoCreationAttributeRefresh(
    session,
    140000005,
    9988400001895,
    { 18: 200, 482: 200, 5633: 2250 },
    {
      shipAttributeModifierEntries: [
        { modifiedAttributeID: 482 },
        { modifiedAttributeID: 5633 },
      ],
    },
  ), 3);
  assert.equal(service._flushPostGetAllInfoCreationAttributeRefresh(session), 3);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].name, "OnModuleAttributeChanges");
  assert.equal(notifications[0].idType, "clientID");
  const changes = notifications[0].payload[0].items;
  assert.deepEqual(changes.map((change) => change[3]), [18, 482, 5633]);
  assert.equal(changes[0][5], 200);
  assert.deepEqual(changes[1][5], { type: "real", value: 200 });
  assert.equal(changes[2][5], 2250);
});

test("Frontier creation diagnostics preserve the client field contract", () => {
  const diagnostic = buildCreationDiagnostic({
    code: "item_unavailable",
    severity: "blocker",
    moduleItemID: 9988400002100,
    changeOp: "add",
    params: { reason: "ITEM_NOT_FOUND" },
  });
  assert.deepEqual(Object.fromEntries(diagnostic.entries), {
    code: "item_unavailable",
    severity: "blocker",
    moduleItemID: 9988400002100,
    changeOp: "add",
    retryAt: null,
    params: {
      type: "dict",
      entries: [["reason", "ITEM_NOT_FOUND"]],
    },
  });
  assert.doesNotThrow(() => marshalEncode(diagnostic, {
    compatibilityProfile: "frontier",
  }));
});

test("Frontier startup services return indexable empty/default contracts", () => {
  assert.deepEqual(new DeploymentMgrService().Handle_get_claimed_packs(), {
    type: "list",
    items: [],
  });
  assert.equal(new StargateService().Handle_get_fuel_energy(), 0);
  assert.deepEqual(buildEmptyMemories(), {
    type: "dict",
    entries: [
      ["shell_memories", { type: "dict", entries: [] }],
      ["crown_memories", { type: "dict", entries: [] }],
    ],
  });
  const experience = new ExperienceService();
  assert.deepEqual(
    experience.Handle_get_memories_from_shell(),
    buildEmptyMemories(),
  );
  assert.doesNotThrow(() => marshalEncode(
    experience.Handle_get_memories_from_shell(),
    { compatibilityProfile: "frontier" },
  ));
  assert.deepEqual(new StatusEffectMgrService().Handle_get_grace_state(), [
    0.0,
    false,
  ]);

  const shellManager = new ShellManagerService();
  assert.equal(shellManager.Handle_get_active_shell_db_data(), null);
  assert.deepEqual(shellManager.Handle_get_medical_trait_shell_points(), [0, 0]);
  assert.deepEqual(shellManager.Handle_get_medical_trait_breakdown(), {
    type: "list",
    items: [],
  });
  assert.equal(shellManager.Handle_get_last_crown_created_time(), null);
  assert.equal(new BerthingSvcService().Handle_get_my_contract(), null);
});

test("Frontier shell manager provisions one client-visible active shell", () => {
  const characterID = 140000005;
  const beforeShellIDs = new Set(
    listCharacterItems(characterID)
      .filter(
        (item) =>
          Number(item.categoryID) ===
          ShellManagerService._testing.SHELL_CATEGORY_ID,
      )
      .map((item) => Number(item.itemID)),
  );
  const notifications = [];
  const session = {
    charid: characterID,
    characterID,
    sendNotification(...args) {
      notifications.push(args);
    },
  };
  let shellID = 0;

  try {
    const service = new ShellManagerService();
    const firstResponse = service.Handle_get_active_shell_db_data([], session);
    const first = Object.fromEntries(firstResponse.entries);
    shellID = Number(first.shellID);

    assert.equal(shellID > 0, true);
    assert.equal(first.shellUniqueID, String(shellID));
    assert.equal(first.shellName, "Blank Shell");
    assert.equal(first.shellCrownID, null);
    assert.deepEqual(first.implants, { type: "list", items: [] });
    assert.equal(findItemById(shellID).typeID, 91969);
    assert.equal(findItemById(shellID).locationID, characterID);

    const second = Object.fromEntries(
      service.Handle_get_active_shell_db_data([], session).entries,
    );
    assert.equal(second.shellID, shellID);
    assert.equal(
      listCharacterItems(characterID).filter(
        (item) =>
          Number(item.categoryID) ===
          ShellManagerService._testing.SHELL_CATEGORY_ID,
      ).length,
      Math.max(1, beforeShellIDs.size),
    );

    const characterInventory = new InvBrokerService()
      ._getCharacterContainerItems(session, null);
    assert.equal(
      characterInventory.some((item) => Number(item.itemID) === shellID),
      true,
    );
    if (!beforeShellIDs.has(shellID)) {
      assert.equal(
        notifications.some(([eventName]) => eventName === "OnItemChange"),
        true,
      );
    }
    assert.doesNotThrow(() => marshalEncode(firstResponse, {
      compatibilityProfile: "frontier",
    }));
  } finally {
    if (shellID > 0 && !beforeShellIDs.has(shellID)) {
      removeInventoryItem(shellID, { removeContents: true });
    }
  }
});

test("Frontier industry details and assembly metadata resolve persisted facilities", () => {
  const characterID = 140000005;
  const solarSystemID = 30000004;
  const createResult = createSpaceItemForCharacter(
    characterID,
    solarSystemID,
    getItemMetadata(87120),
    {
      itemName: "Compatibility Heavy Printer",
      mode: "STOP",
      position: { x: 1_000, y: 2_000, z: 3_000 },
    },
  );
  assert.equal(createResult.success, true);
  const facilityID = createResult.data.itemID;
  const session = {
    characterID,
    locationid: solarSystemID,
    solarsystemid: solarSystemID,
    solarsystemid2: solarSystemID,
  };

  try {
    const details = new IndustryService().Handle_get_facility_details(
      [facilityID],
      session,
    );
    const detailsByName = Object.fromEntries(details.entries);
    assert.equal(detailsByName.production, null);
    assert.equal(detailsByName.blueprint, null);
    assert.deepEqual(Object.fromEntries(detailsByName.items.entries), {
      inputs: { type: "dict", entries: [] },
      outputs: { type: "dict", entries: [] },
    });
    assert.doesNotThrow(() => marshalEncode(details, {
      compatibilityProfile: "frontier",
    }));

    const types = getAssemblyGateProtoTypes();
    const requestPayload = Buffer.from(
      types.getMetadataRequest.encode(
        types.getMetadataRequest.create({
          assembly: { sequential: facilityID },
        }),
      ).finish(),
    );
    const gatewayResult = createAssemblyGateGatewayService().handleRequest(
      GET_METADATA_REQUEST,
      {
        authoritative_context: {
          active_character: { sequential: characterID },
        },
        payload: { value: requestPayload },
      },
    );
    const metadataResponse = types.getMetadataResponse.decode(
      gatewayResult.responsePayloadBuffer,
    );
    assert.equal(gatewayResult.statusCode, 200);
    assert.equal(metadataResponse.metadata.name, "Compatibility Heavy Printer");
    assert.equal(metadataResponse.metadata.description, "");
    assert.equal(metadataResponse.metadata.dapp_url, "");
  } finally {
    removeInventoryItem(facilityID, { removeContents: true });
  }
});

test("Frontier deployment contract maps depot and direct-placement assemblies", () => {
  const definitions = deploymentContractTesting.buildDefinitionsFromRows([
    {
      _key: 90184,
      activate: { durationSeconds: 48 },
      smartDeployable: {
        constructionCost: { 84180: 6, 84210: 6, 88561: 6 },
        constructionSite: 91717,
        createOnChain: 1,
      },
    },
    {
      _key: 88092,
      activate: { durationSeconds: 30 },
      smartDeployable: {
        constructionCost: { 84180: 10, 84210: 10, 88561: 10 },
        createOnChain: 1,
      },
    },
    {
      _key: 84955,
      activate: { durationSeconds: 51840 },
      smartDeployable: {
        constructionCost: { 88783: 1050, 89089: 225, 92483: 42 },
        constructionSite: 91712,
        createOnChain: 1,
      },
      smartGate: {
        maxPerSolarSystem: 4,
        minDistanceFromSameComponent: 200000,
        range: 365,
      },
    },
  ]);

  assert.deepEqual(definitions.get(90184), {
    assemblyTypeID: 90184,
    constructionSiteTypeID: 91717,
    constructionCost: { 84180: 6, 84210: 6, 88561: 6 },
    createOnChain: true,
    durationSeconds: 48,
  });
  assert.deepEqual(definitions.get(88092), {
    assemblyTypeID: 88092,
    constructionSiteTypeID: 0,
    constructionCost: { 84180: 10, 84210: 10, 88561: 10 },
    createOnChain: true,
    durationSeconds: 30,
  });
  assert.deepEqual(definitions.get(84955), {
    assemblyTypeID: 84955,
    constructionSiteTypeID: 91712,
    constructionCost: { 88783: 1050, 89089: 225, 92483: 42 },
    createOnChain: true,
    durationSeconds: 51840,
    smartGate: {
      maxPerSolarSystem: 4,
      minDistanceFromSameComponent: 200000,
      rangeLightYears: 365,
    },
  });
  assert.deepEqual(
    deploymentContractTesting.normalizeWorldVector([-411, 0, -1957]),
    { x: -411, y: 0, z: -1957 },
  );
  assert.deepEqual(
    deploymentContractTesting.normalizeRotationDegrees([Math.PI, 0, -Math.PI / 2]),
    [180, 0, -90],
  );
  assert.deepEqual(
    deploymentContractTesting.resolveDeploymentPosition(
      [0, 0, 765.4717407226562],
      { x: 988976934.328545, y: 201556508.345823, z: -194298032.529605 },
    ),
    {
      buildAnchor: "ship",
      buildAnchorItemID: null,
      deploymentDistance: 765.4717407226562,
      frame: "ship-relative",
      maxDeploymentDistance: 2500,
      position: {
        x: 988976934.328545,
        y: 201556508.345823,
        z: -194297267.05786428,
      },
      shipDistance: 765.4717407226562,
      withinRange: true,
    },
  );

  const heavyGatePlacement = deploymentContractTesting.resolveDeploymentPosition(
    [-14253, -74, -20121],
    { x: 988990784.3285517, y: 201556508.34582326, z: -194297267.0578641 },
    {
      networkNodeAnchors: [{
        itemID: 9988400000999,
        position: {
          x: 988976934.3285447,
          y: 201556508.34582326,
          z: -194297267.0578641,
        },
      }],
    },
  );
  assert.equal(heavyGatePlacement.withinRange, true);
  assert.equal(heavyGatePlacement.frame, "ship-relative");
  assert.equal(heavyGatePlacement.buildAnchor, "network-node");
  assert.equal(heavyGatePlacement.buildAnchorItemID, 9988400000999);
  assert.equal(heavyGatePlacement.maxDeploymentDistance, 80000);
  assert.ok(Math.abs(heavyGatePlacement.deploymentDistance - 20125.171452685812) < 0.001);
  assert.ok(Math.abs(heavyGatePlacement.shipDistance - 24657.820787733857) < 0.001);
  assert.deepEqual(heavyGatePlacement.position, {
    x: 988976531.3285517,
    y: 201556434.34582326,
    z: -194317388.0578641,
  });

  const heavyGateWithoutNetworkNode =
    deploymentContractTesting.resolveDeploymentPosition(
      [-14253, -74, -20121],
      { x: 988990784.3285517, y: 201556508.34582326, z: -194297267.0578641 },
    );
  assert.equal(heavyGateWithoutNetworkNode.withinRange, false);
  assert.equal(heavyGateWithoutNetworkNode.frame, "ship-relative");
  assert.equal(heavyGateWithoutNetworkNode.buildAnchor, "ship");
  assert.equal(heavyGateWithoutNetworkNode.maxDeploymentDistance, 2500);

  assert.equal(
    deploymentContractTesting.isCompletedNetworkNodeBuildAnchorState({
      assemblyStatus: ASSEMBLY_STATUS_OFFLINE,
    }),
    true,
  );
  assert.equal(
    deploymentContractTesting.isCompletedNetworkNodeBuildAnchorState({
      assemblyStatus: ASSEMBLY_STATUS_ONLINE,
    }),
    true,
  );
  assert.equal(
    deploymentContractTesting.isCompletedNetworkNodeBuildAnchorState({
      assemblyStatus: ASSEMBLY_STATUS_UNDER_CONSTRUCTION,
    }),
    false,
  );

  const item = {
    customInfo: deploymentContractTesting.writeConstructionState(null, {
      assemblyStatus: ASSEMBLY_STATUS_UNDER_CONSTRUCTION,
      assemblyTypeID: 90184,
      constructionCost: { 84180: 6 },
      constructionSiteTypeID: 91717,
      ownerID: 140000005,
      solarSystemID: 30000004,
    }),
    locationID: 30000004,
    ownerID: 140000005,
  };
  assert.equal(
    deploymentContractTesting.readConstructionState(item).assemblyTypeID,
    90184,
  );
  assert.equal(ASSEMBLY_STATUS_OFFLINE, 1);
});

test("Frontier construction hydration publishes assembly activation state", () => {
  const offlineEntity = {};
  hydrateConstructionEntityFromInventoryItem(offlineEntity, {
    customInfo: deploymentContractTesting.writeConstructionState(null, {
      assemblyStatus: ASSEMBLY_STATUS_OFFLINE,
      assemblyTypeID: 87160,
      completeAtMs: 0,
      durationSeconds: 60,
    }),
  });
  assert.equal(offlineEntity.assembly_status, ASSEMBLY_STATUS_OFFLINE);
  assert.deepEqual(offlineEntity.component_activate, [true, null]);
  assert.equal(offlineEntity.activate_comp_durationSeconds, 60);

  const constructionEntity = {
    component_activate: [true, null],
    activate_comp_durationSeconds: 60,
  };
  hydrateConstructionEntityFromInventoryItem(constructionEntity, {
    itemID: 9988400001389,
    typeID: 91701,
    customInfo: deploymentContractTesting.writeConstructionState(null, {
      assemblyStatus: ASSEMBLY_STATUS_UNDER_CONSTRUCTION,
      assemblyTypeID: 87160,
      completeAtMs: 0,
      constructionSiteTypeID: 91701,
      durationSeconds: 60,
    }),
  });
  assert.equal(constructionEntity.assembly_status, ASSEMBLY_STATUS_UNDER_CONSTRUCTION);
  assert.equal(Object.hasOwn(constructionEntity, "component_activate"), false);
  assert.equal(
    Object.hasOwn(constructionEntity, "activate_comp_durationSeconds"),
    false,
  );

  const smartGateEntity = { kind: "deployable" };
  hydrateConstructionEntityFromInventoryItem(smartGateEntity, {
    itemID: 9988400000999,
    customInfo: deploymentContractTesting.writeConstructionState(null, {
      assemblyStatus: ASSEMBLY_STATUS_OFFLINE,
      assemblyTypeID: 84955,
      completeAtMs: 0,
      destinationGateID: 9988400001000,
      durationSeconds: 51840,
      targetSolarSystemID: 30000005,
    }),
  });
  assert.equal(smartGateEntity.activationState, 1);
  assert.equal(smartGateEntity.targetSolarsystemID, 30000005);
});

test("Frontier Refuge accepts Creation without widening its ship-group rules", () => {
  const definitions = berthingContractTesting.buildSmartHangarDefinitions([{
    _key: 87160,
    smartHangar: {
      acceptedGroupIDs: { 31: 1, 237: 1 },
      accessRange: 5000,
      allowFreeForAll: 0,
      allowUserAdd: 1,
      allowUserTake: 1,
    },
  }]);
  const refuge = definitions.get(87160);

  assert.equal(refuge.accessRange, 5000);
  assert.equal(refuge.allowUserAdd, true);
  assert.equal(berthingContractTesting.smartHangarAcceptsShipGroup(refuge, 31), true);
  assert.equal(berthingContractTesting.smartHangarAcceptsShipGroup(refuge, 237), true);
  assert.equal(berthingContractTesting.smartHangarAcceptsShipGroup(refuge, 5128), false);
  assert.equal(
    berthingContractTesting.smartHangarAcceptsShip(
      refuge,
      { typeID: 95276, groupID: 5128 },
    ),
    true,
  );
  assert.equal(
    berthingContractTesting.smartHangarAcceptsShip(
      refuge,
      { typeID: 95735, groupID: 5128 },
    ),
    false,
  );
});

test("Frontier Creation berths at Refuge center and departs outside its hull", () => {
  const characterID = 140000005;
  const solarSystemID = 30000004;
  const shipID = 9988400001895;
  const refugeID = 9988400001127;
  const creationState = {
    templateTypeID: 95276,
    modules: [{ itemID: 9988400002100, typeID: 95320 }],
  };
  const session = {
    charid: characterID,
    characterID,
    shipid: shipID,
    shipID,
    solarsystemid2: solarSystemID,
    _space: { shipID, systemID: solarSystemID },
  };
  const activeShip = {
    itemID: shipID,
    typeID: 95276,
    groupID: 5128,
    categoryID: 6,
    ownerID: characterID,
    locationID: solarSystemID,
    customInfo: JSON.stringify({ evejsFrontierCreation: creationState }),
    spaceState: {
      systemID: solarSystemID,
      position: { x: 1_500, y: 2_000, z: 3_000 },
      direction: { x: 1, y: 0, z: 0 },
    },
  };
  const refugeItem = {
    itemID: refugeID,
    typeID: 87160,
    ownerID: characterID,
    locationID: solarSystemID,
    dunRotation: [90, 0, 0],
    spaceState: {
      systemID: solarSystemID,
      position: { x: 1_000, y: 2_000, z: 3_000 },
    },
  };
  const shipEntity = {
    itemID: shipID,
    kind: "ship",
    radius: 1,
    position: { ...activeShip.spaceState.position },
    direction: { ...activeShip.spaceState.direction },
  };
  const refugeEntity = {
    itemID: refugeID,
    kind: "deployable",
    radius: 1,
    position: { ...refugeItem.spaceState.position },
    direction: { x: 0, y: 0, z: 1 },
    dunRotation: [...refugeItem.dunRotation],
  };
  const teleports = [];
  const assertForwardDirection = (direction) => {
    assert.ok(Math.abs(direction.x - 1) < 1e-12);
    assert.ok(Math.abs(direction.y) < 1e-12);
    assert.ok(Math.abs(direction.z) < 1e-12);
  };
  const spaceRuntime = {
    getEntity(_session, itemID) {
      return Number(itemID) === shipID ? shipEntity : refugeEntity;
    },
    stop() {
      return true;
    },
    teleportSessionShipToPoint(_session, point, options) {
      const position = { ...point };
      const direction = { ...options.direction };
      teleports.push({ direction, position });
      shipEntity.position = position;
      shipEntity.direction = direction;
      activeShip.spaceState = {
        ...activeShip.spaceState,
        position,
        direction,
      };
      return { success: true, data: { entity: shipEntity } };
    },
  };
  const updateShipItem = (_itemID, updater) => {
    Object.assign(activeShip, updater({ ...activeShip }));
    return { success: true, data: { ...activeShip } };
  };
  const dependencies = {
    findItemById: (itemID) => Number(itemID) === refugeID ? refugeItem : null,
    getActiveShipItem: () => activeShip,
    getSmartHangarDefinition: () => ({
      acceptedGroupIDs: new Set([31, 237]),
      acceptedTypeIDs: new Set([95276]),
      accessRange: 5_000,
      allowUserAdd: true,
      allowUserTake: true,
    }),
    readConstructionState: () => ({ assemblyStatus: ASSEMBLY_STATUS_ONLINE }),
    spaceRuntime,
    updateShipItem,
  };

  berthingContractTesting.clearContracts();
  try {
    const berthResult = berth(session, refugeID, dependencies);
    assert.equal(berthResult.success, true);
    assert.deepEqual(teleports[0].position, refugeEntity.position);
    assertForwardDirection(teleports[0].direction);

    const berthedInfo = JSON.parse(activeShip.customInfo);
    assert.deepEqual(berthedInfo.evejsFrontierCreation, creationState);
    assert.equal(
      berthedInfo.evejsFrontierBerthing.hostAssemblyID,
      refugeID,
    );
    assert.equal(getContractForSession(session, dependencies).phase, BERTHING_PHASE_BERTHED);

    berthingContractTesting.clearContracts();
    const recovered = getContractForSession(session, dependencies);
    assert.equal(recovered.hostAssemblyID, refugeID);
    assert.equal(recovered.occupiedShipID, shipID);
    assert.equal(recovered.phase, BERTHING_PHASE_BERTHED);

    const undockResult = undockBerth(session, refugeID, dependencies);
    assert.equal(undockResult.success, true);
    assertForwardDirection(teleports[1].direction);
    assert.deepEqual(teleports[1].position, { x: 1_420, y: 2_000, z: 3_000 });

    const departedInfo = JSON.parse(activeShip.customInfo);
    assert.deepEqual(departedInfo.evejsFrontierCreation, creationState);
    assert.equal(Object.hasOwn(departedInfo, "evejsFrontierBerthing"), false);
    assert.equal(getContractForSession(session, dependencies), null);
  } finally {
    berthingContractTesting.clearContracts();
  }
});

test("Frontier berthing service exposes the complete client contract", () => {
  const contract = {
    hostAssemblyID: 9988400001127,
    occupiedShipID: 9988400000487,
    characterID: 140000005,
    solarSystemID: 30000004,
    phase: BERTHING_PHASE_BERTHED,
    signedAt: 134141234567890000n,
  };
  const calls = [];
  const success = (phase) => ({
    success: true,
    data: { contract: { ...contract, phase } },
  });
  const runtime = {
    getContractForSession() {
      return contract;
    },
    beginBerth(_session, hostAssemblyID) {
      calls.push(["begin", hostAssemblyID]);
      return success(BERTHING_PHASE_APPROACHING);
    },
    berth(_session, hostAssemblyID) {
      calls.push(["berth", hostAssemblyID]);
      return success(BERTHING_PHASE_BERTHED);
    },
    completeBerth(_session, hostAssemblyID) {
      calls.push(["complete", hostAssemblyID]);
      return success(BERTHING_PHASE_BERTHED);
    },
    undockBerth(_session, hostAssemblyID) {
      calls.push(["undock", hostAssemblyID]);
      return success(BERTHING_PHASE_DEPARTING);
    },
    ejectOccupiedShip(_session, hostAssemblyID) {
      calls.push(["eject", hostAssemblyID]);
      return success(BERTHING_PHASE_DEPARTING);
    },
  };
  const service = new BerthingSvcService({ runtime });
  const session = { characterID: contract.characterID };
  const response = service.Handle_get_my_contract([], session);

  assert.deepEqual(Object.fromEntries(response.entries), {
    host_assembly_id: contract.hostAssemblyID,
    occupied_ship_id: contract.occupiedShipID,
    char_id: contract.characterID,
    solar_system_id: contract.solarSystemID,
    phase: BERTHING_PHASE_BERTHED,
    signed_at: contract.signedAt,
  });
  assert.equal(
    Object.fromEntries(service.Handle_begin_berth([contract.hostAssemblyID], session).entries).phase,
    BERTHING_PHASE_APPROACHING,
  );
  assert.equal(
    Object.fromEntries(service.Handle_berth([contract.hostAssemblyID], session).entries).phase,
    BERTHING_PHASE_BERTHED,
  );
  assert.equal(
    Object.fromEntries(service.Handle_complete_berth([contract.hostAssemblyID], session).entries).phase,
    BERTHING_PHASE_BERTHED,
  );
  assert.equal(service.Handle_undock_berth([contract.hostAssemblyID], session), null);
  assert.equal(service.Handle_eject_occupied_ship([contract.hostAssemblyID], session), null);
  assert.deepEqual(calls, [
    ["begin", contract.hostAssemblyID],
    ["berth", contract.hostAssemblyID],
    ["complete", contract.hostAssemblyID],
    ["undock", contract.hostAssemblyID],
    ["eject", contract.hostAssemblyID],
  ]);
  assert.doesNotThrow(() => marshalEncode(response, {
    compatibilityProfile: "frontier",
  }));
});

test("Frontier chain assemblies commit a one-use signed state transition", () => {
  const characterID = 140000005;
  const solarSystemID = 30000004;
  const nowMs = Date.now();
  const nodeMetadata = getItemMetadata(88092);
  const createResult = createSpaceItemForCharacter(
    characterID,
    solarSystemID,
    nodeMetadata,
    {
      customInfo: deploymentContractTesting.writeConstructionState(null, {
        assemblyStatus: ASSEMBLY_STATUS_OFFLINE,
        assemblyTypeID: 88092,
        completeAtMs: 0,
        completedAtMs: nowMs,
        constructionCost: { 84180: 10, 84210: 10, 88561: 10 },
        constructionSiteTypeID: 0,
        createdAtMs: nowMs,
        durationSeconds: 30,
        ownerID: characterID,
        solarSystemID,
      }),
      mode: "STOP",
      position: { x: 1_000, y: 2_000, z: 3_000 },
    },
  );
  assert.equal(createResult.success, true);
  const itemID = createResult.data.itemID;
  const session = {
    characterID,
    locationid: solarSystemID,
    solarsystemid: solarSystemID,
    solarsystemid2: solarSystemID,
    sendNotification() {},
  };

  try {
    const service = new SmartAssemblyService();
    const prepared = service.Handle_set_online([itemID], session);
    const transaction = Object.fromEntries(prepared.entries);
    const transactionData = JSON.parse(transaction.transaction_data);

    assert.equal(prepared.type, "dict");
    assert.match(transaction.transaction_uuid, /^[0-9a-f-]{36}$/u);
    assert.equal(transactionData.version, 2);
    assert.deepEqual(transactionData.inputs, []);
    assert.deepEqual(transactionData.commands, []);
    assert.match(
      transactionData.gasData.payment[0].objectId,
      /^0x[0-9a-f]{64}$/u,
    );
    assert.equal(
      service.Handle_set_online_signature(
        [itemID, transaction.transaction_uuid, "not-a-signature"],
        session,
      ),
      false,
    );
    assert.equal(
      deploymentContractTesting.readConstructionState(findItemById(itemID))
        .assemblyStatus,
      ASSEMBLY_STATUS_OFFLINE,
    );

    const signatureEnvelope = Buffer.alloc(97, 1).toString("base64");
    assert.equal(
      service.Handle_set_online_signature(
        [itemID, transaction.transaction_uuid, signatureEnvelope],
        session,
      ),
      true,
    );
    assert.equal(
      deploymentContractTesting.readConstructionState(findItemById(itemID))
        .assemblyStatus,
      ASSEMBLY_STATUS_ONLINE,
    );
    assert.equal(
      service.Handle_set_online_signature(
        [itemID, transaction.transaction_uuid, signatureEnvelope],
        session,
      ),
      false,
    );
  } finally {
    deploymentContractTesting.clearPendingAssemblyTransitions();
    removeInventoryItem(itemID, { removeContents: true });
  }
});

test("Frontier Heavy Gates link reciprocally before signed online", () => {
  const characterID = 140000005;
  const sourceSystemID = 30000004;
  const destinationSystemID = 30000005;
  const activeShip = getActiveShipRecord(characterID);
  assert.ok(activeShip && activeShip.itemID > 0);
  const originalShip = structuredClone(findItemById(activeShip.itemID));
  const repositionResult = updateInventoryItem(activeShip.itemID, (ship) => ({
    ...ship,
    flagID: 0,
    locationID: sourceSystemID,
    spaceState: {
      ...(ship.spaceState || {}),
      systemID: sourceSystemID,
    },
  }));
  assert.equal(repositionResult.success, true);
  const nowMs = Date.now();
  const gateMetadata = getItemMetadata(84955);
  const createGate = (solarSystemID, x) => createSpaceItemForCharacter(
    characterID,
    solarSystemID,
    gateMetadata,
    {
      customInfo: deploymentContractTesting.writeConstructionState(null, {
        assemblyStatus: ASSEMBLY_STATUS_OFFLINE,
        assemblyTypeID: 84955,
        completeAtMs: 0,
        completedAtMs: nowMs,
        constructionCost: { 88783: 1050, 89089: 225, 92483: 42 },
        constructionSiteTypeID: 91712,
        createdAtMs: nowMs,
        destinationGateID: 0,
        durationSeconds: 51840,
        ownerID: characterID,
        solarSystemID,
        targetSolarSystemID: 0,
      }),
      mode: "STOP",
      position: { x, y: 2_000, z: 3_000 },
    },
  );
  const sourceResult = createGate(sourceSystemID, 1_000);
  const destinationResult = createGate(destinationSystemID, 4_000);
  assert.equal(sourceResult.success, true);
  assert.equal(destinationResult.success, true);
  const sourceGateID = sourceResult.data.itemID;
  const destinationGateID = destinationResult.data.itemID;
  const session = {
    characterID,
    locationid: sourceSystemID,
    solarsystemid: sourceSystemID,
    solarsystemid2: sourceSystemID,
    sendNotification() {},
  };
  const signatureEnvelope = Buffer.alloc(97, 1).toString("base64");

  try {
    const service = new SmartAssemblyService();
    assert.equal(service.Handle_on_interaction([sourceGateID], session), null);

    const preparedLink = Object.fromEntries(
      service.Handle_link_gates(
        [sourceGateID, destinationGateID],
        session,
      ).entries,
    );
    assert.equal(
      service.Handle_link_gates_signature(
        [sourceGateID, preparedLink.transaction_uuid, signatureEnvelope],
        session,
      ),
      true,
    );

    const sourceState = deploymentContractTesting.readConstructionState(
      findItemById(sourceGateID),
    );
    const destinationState = deploymentContractTesting.readConstructionState(
      findItemById(destinationGateID),
    );
    assert.equal(sourceState.destinationGateID, destinationGateID);
    assert.equal(sourceState.targetSolarSystemID, destinationSystemID);
    assert.equal(destinationState.destinationGateID, sourceGateID);
    assert.equal(destinationState.targetSolarSystemID, sourceSystemID);

    const gatewayResult = createAssemblyGateGatewayService().handleRequest(
      GET_ALL_OWNED_REQUEST,
      {
        authoritative_context: {
          active_character: { sequential: characterID },
        },
      },
    );
    const gatewayResponse = getAssemblyGateProtoTypes().getAllOwnedResponse.decode(
      gatewayResult.responsePayloadBuffer,
    );
    const sourceEntry = gatewayResponse.gates.find(
      (entry) => Number(entry.id.sequential) === sourceGateID,
    );
    assert.equal(gatewayResult.statusCode, 200);
    assert.equal(
      Number(sourceEntry.attributes.location.solar_system.sequential),
      sourceSystemID,
    );
    assert.equal(
      Number(sourceEntry.attributes.destination.sequential),
      destinationGateID,
    );

    const preparedOnline = Object.fromEntries(
      service.Handle_set_online([sourceGateID], session).entries,
    );
    assert.equal(
      service.Handle_set_online_signature(
        [sourceGateID, preparedOnline.transaction_uuid, signatureEnvelope],
        session,
      ),
      true,
    );
    assert.equal(
      deploymentContractTesting.readConstructionState(findItemById(sourceGateID))
        .assemblyStatus,
      ASSEMBLY_STATUS_ONLINE,
    );

    assert.throws(
      () => service.Handle_gate_jump([sourceGateID], session),
      (error) => {
        assert.equal(error && error.name, "MachoWrappedException");
        assert.match(
          JSON.stringify(error && error.machoErrorResponse),
          /destination Heavy Gate must be online/u,
        );
        return true;
      },
    );

    const destinationSession = {
      ...session,
      locationid: destinationSystemID,
      solarsystemid: destinationSystemID,
      solarsystemid2: destinationSystemID,
    };
    const preparedDestinationOnline = Object.fromEntries(
      service.Handle_set_online([destinationGateID], destinationSession).entries,
    );
    assert.equal(
      service.Handle_set_online_signature(
        [
          destinationGateID,
          preparedDestinationOnline.transaction_uuid,
          signatureEnvelope,
        ],
        destinationSession,
      ),
      true,
    );

    const preparedJump = Object.fromEntries(
      service.Handle_gate_jump([sourceGateID], session).entries,
    );
    const transitions = require("../src/space/transitions");
    const originalJumpSessionToSolarSystem = transitions.jumpSessionToSolarSystem;
    let capturedJump = null;
    transitions.jumpSessionToSolarSystem = (
      jumpSession,
      solarSystemID,
      options,
    ) => {
      capturedJump = { jumpSession, options, solarSystemID };
      return { success: true, data: { solarSystemID } };
    };
    try {
      assert.equal(
        service.Handle_gate_jump_signature(
          [sourceGateID, preparedJump.transaction_uuid, signatureEnvelope],
          session,
        ),
        true,
      );
    } finally {
      transitions.jumpSessionToSolarSystem = originalJumpSessionToSolarSystem;
    }
    assert.equal(capturedJump.jumpSession, session);
    assert.equal(capturedJump.solarSystemID, destinationSystemID);
    assert.equal(capturedJump.options.stargateJumpCloak, true);
    assert.equal(
      capturedJump.options.spawnStateOverride.anchorID,
      destinationGateID,
    );
    assert.equal(
      capturedJump.options.spawnStateOverride.anchorType,
      "frontierSmartGate",
    );
  } finally {
    deploymentContractTesting.clearPendingAssemblyTransitions();
    removeInventoryItem(sourceGateID, { removeContents: true });
    removeInventoryItem(destinationGateID, { removeContents: true });
    updateInventoryItem(activeShip.itemID, () => originalShip);
  }
});

test("Frontier /create grants items to the active ship cargo while in space", () => {
  const characterID = 140000005;
  const ship = getActiveShipRecord(characterID);
  assert.ok(ship && ship.itemID > 0);

  const quantityInCargo = () => listContainerItems(
    characterID,
    ship.itemID,
    ITEM_FLAGS.CARGO_HOLD,
  )
    .filter((item) => Number(item.typeID) === 34)
    .reduce(
      (total, item) => total + Math.max(
        0,
        Number(item.stacksize ?? item.quantity) || 0,
      ),
      0,
    );
  const beforeQuantity = quantityInCargo();
  const notifications = [];
  const session = {
    characterID,
    locationid: ship.locationID,
    shipid: ship.itemID,
    solarsystemid: ship.locationID,
    solarsystemid2: ship.locationID,
    stationid: null,
    structureid: null,
    sendNotification(...args) {
      notifications.push(args);
    },
  };

  const result = executeChatCommand(
    session,
    "/create 34 7",
    null,
    { emitChatFeedback: false },
  );

  assert.equal(result.handled, true);
  assert.equal(Number.isInteger(result.message), true);
  assert.equal(quantityInCargo(), beforeQuantity + 7);
  assert.equal(findItemById(result.message).locationID, ship.itemID);
  assert.equal(findItemById(result.message).flagID, ITEM_FLAGS.CARGO_HOLD);
  assert.equal(
    notifications.some(([eventName]) => eventName === "OnItemChange"),
    true,
  );
});

test("Frontier construction-site crdata omits completed-assembly activation fields", () => {
  const normalized = normalizeCrDataDictionaryForProfile(
    {
      type: "dict",
      entries: [
        ["itemID", 9988400000900],
        ["typeID", 91717],
        ["groupID", 4885],
        ["categoryID", 22],
        ["ownerID", 140000005],
        ["assembly_status", ASSEMBLY_STATUS_UNDER_CONSTRUCTION],
        ["component_activate", { type: "tuple", items: [false, null] }],
        ["activate_comp_durationSeconds", 60],
        ["unsupported", true],
      ],
    },
    { itemID: 9988400000900, kind: "deployable" },
    "frontier",
  );

  assert.deepEqual(normalized.entries, [
    ["itemID", 9988400000900],
    ["typeID", 91717],
    ["ownerID", 140000005],
    ["assembly_status", ASSEMBLY_STATUS_UNDER_CONSTRUCTION],
  ]);
});

test("Frontier completed deployable crdata preserves activation state", () => {
  const normalized = normalizeCrDataDictionaryForProfile(
    {
      type: "dict",
      entries: [
        ["itemID", 9988400000999],
        ["typeID", 88092],
        ["ownerID", 140000005],
        ["assembly_status", ASSEMBLY_STATUS_ONLINE],
        ["activationState", 2],
        ["component_activate", { type: "tuple", items: [true, null] }],
        ["targetSolarsystemID", 30000005],
      ],
    },
    { itemID: 9988400000999, kind: "deployable" },
    "frontier",
  );

  assert.deepEqual(normalized.entries, [
    ["itemID", 9988400000999],
    ["typeID", 88092],
    ["ownerID", 140000005],
    ["assembly_status", ASSEMBLY_STATUS_ONLINE],
    ["activationState", 2],
    ["component_activate", { type: "tuple", items: [true, null] }],
    ["targetSolarsystemID", 30000005],
  ]);
});

test("Frontier landscape sites materialize as warpable CRDungeon anchors", () => {
  const entity = frontierSpaceRuntime._testing
    .buildStaticLandscapeSiteEntityForTesting({
      itemID: 900202923,
      typeID: 92480,
      groupID: 4873,
      categoryID: 2,
      graphicID: 1211,
      itemName: "Fringe Tallyport",
      radius: 1,
      solarSystemID: 30010146,
      featureID: 500202921,
      featureKind: "asteroidBelt",
      ecosystemID: 20,
      dungeonID: 14026,
      dungeonNameID: 1036889,
      archetypeID: null,
      dungeonEntryObjectID: 1467747,
      position: {
        x: -204498589797.842,
        y: 72888241492.775,
        z: -434793239501.402,
      },
    });

  assert.equal(entity.kind, "landscapeSite");
  assert.equal(entity.itemID, 900202923);
  assert.equal(entity.systemID, 30010146);
  assert.equal(entity.dungeonEntryObjectID, 1467747);

  const normalized = normalizeCrDataDictionaryForProfile(
    buildSlimItemDict(entity),
    entity,
    "frontier",
  );
  const fields = Object.fromEntries(normalized.entries);

  assert.equal(fields.itemID, 900202923);
  assert.equal(fields.typeID, 92480);
  assert.equal(fields.locationID, 30010146);
  assert.equal(fields.dungeonID, 14026);
  assert.equal(fields.dungeonNameID, 1036889);
  assert.equal(fields.archetypeID, null);
  assert.equal(fields.signatureRadius, 1);
});

test("Frontier market daemon can be disabled without reconnect activity", async () => {
  const client = new MarketDaemonClient({ enabled: false });

  client.startBackgroundConnect();
  assert.deepEqual(client.getStatus(), {
    enabled: false,
    host: "127.0.0.1",
    port: 40111,
    connected: false,
    connecting: false,
    pendingRequests: 0,
  });
  await assert.rejects(client.call("StartupCheck"), /is disabled/);
});

test("Frontier agent authority excludes locations absent from its static data", () => {
  const stations = new Set([64000001]);
  const systems = new Set([30000004]);

  assert.equal(shouldIncludeAgentRecord(
    { stationID: 60000001 },
    "frontier",
    stations,
    systems,
  ), false);
  assert.equal(shouldIncludeAgentRecord(
    { stationID: 64000001 },
    "frontier",
    stations,
    systems,
  ), true);
  assert.equal(shouldIncludeAgentRecord(
    { stationID: null, solarSystemID: 30000004, isInSpace: true },
    "frontier",
    stations,
    systems,
  ), true);
  assert.equal(shouldIncludeAgentRecord(
    { stationID: 60000001 },
    "tranquility",
    stations,
    systems,
  ), true);
});

test("Frontier race skill maps retain zero levels and explicit trained levels", () => {
  assert.deepEqual(skillLevelRecords({
    3300: 0,
    3363: 2,
    3387: 5,
  }), [
    { typeID: 3300, level: 0 },
    { typeID: 3363, level: 2 },
    { typeID: 3387, level: 5 },
  ]);
  assert.deepEqual(skillLevelRecords([
    { _key: 3300, _value: 0 },
  ]), [{ typeID: 3300, level: 0 }]);
});

test("Frontier skill entries match the four-argument client constructor", () => {
  const skillRecord = {
    typeID: 3300,
    trainedSkillLevel: 4,
    trainedSkillPoints: 45255,
    skillRank: 1,
    virtualSkillLevel: 5,
  };

  const frontierEntry = buildCharacterSkillEntry(skillRecord, {
    compatibilityProfile: "frontier",
  });
  const tranquilityEntry = buildCharacterSkillEntry(skillRecord, {
    compatibilityProfile: "tranquility",
  });

  assert.deepEqual(frontierEntry.header[1], [3300, 4, 45255, 1]);
  assert.deepEqual(tranquilityEntry.header[1], [3300, 4, 45255, 1, 5]);
  assert.doesNotThrow(() =>
    marshalEncode(frontierEntry, { compatibilityProfile: "frontier" }),
  );
});

test("Frontier lazy startup preloads its bootstrap system only", () => {
  assert.deepEqual(resolveDefaultStartupSystemIDs("frontier"), [30000004]);
  assert.deepEqual(resolveDefaultStartupSystemIDs("tranquility"), [
    30000142,
    30000145,
    30100032,
  ]);
});

test("Frontier global inventory returns an indexable typed rowset", () => {
  const rowset = buildItemsInSystemsRowset();

  assert.equal(rowset.type, "objectex2");
  assert.equal(
    rowset.header[0][0].value,
    "carbon.common.script.sys.crowset.CRowset",
  );
  assert.equal(rowset.header[1].entries[0][0], "header");
  assert.equal(rowset.header[1].entries[0][1].header[1][0][0][0], "itemID");
  assert.deepEqual(rowset.list, []);
  assert.doesNotThrow(() =>
    marshalEncode(rowset, { compatibilityProfile: "frontier" }),
  );
});

test("Frontier handshake sends a no-op signed function", () => {
  const noOp = Buffer.from("no-op");
  const payload = selectHandshakeSignedFunc(
    "frontier",
    noOp,
    () => Buffer.from("legacy"),
  );
  assert.equal(usesNoOpHandshakeSignedFunc("frontier"), true);
  assert.deepEqual(payload, {
    type: "frontier-bytes",
    value: noOp,
  });
  const encoded = marshalEncode(payload, {
    compatibilityProfile: "frontier",
  });
  assert.equal(encoded[5], 0x13);
  assert.deepEqual(
    marshalDecode(encoded, { compatibilityProfile: "frontier" }),
    noOp,
  );
});

test("Tranquility handshake preserves the existing TiDi signed function", () => {
  const legacy = Buffer.from("legacy");
  const payload = selectHandshakeSignedFunc(
    "tranquility",
    Buffer.from("no-op"),
    () => legacy,
  );
  assert.equal(usesNoOpHandshakeSignedFunc("tranquility"), false);
  assert.deepEqual(payload, legacy);
});

test("Frontier version exchange uses the client codename and region", () => {
  assert.deepEqual(
    selectVersionExchangeRelease(
      "frontier",
      "V20.04@ccp",
      "cycle-6",
      "ccp",
    ),
    {
      type: "frontier-string",
      value: "cycle-6@ccp",
    },
  );
});

test("Frontier release text uses the Python 3 UTF-8 string dialect", () => {
  const encoded = marshalEncode({
    type: "frontier-string",
    value: "cycle-6@ccp",
  });
  const decoded = marshalDecode(encoded, {
    compatibilityProfile: "frontier",
  });

  assert.equal(encoded[5], 0x12);
  assert.equal(encoded[6], Buffer.byteLength("cycle-6@ccp", "utf8"));
  assert.deepEqual(encoded.subarray(7, 9), Buffer.from("cy"));
  assert.equal(decoded, "cycle-6@ccp");
});

test("Frontier compact Unicode characters consume one UTF-8 byte", () => {
  const encoded = Buffer.from([
    0x7e, 0x00, 0x00, 0x00, 0x00,
    0x2c,
    0x29, 0x2f,
    0x09,
  ]);

  assert.deepEqual(
    marshalDecodeExact(encoded, { compatibilityProfile: "frontier" }),
    ["/", 1],
  );
});

test("Tranquility compact Unicode characters preserve UCS-2 decoding", () => {
  const encoded = Buffer.from([
    0x7e, 0x00, 0x00, 0x00, 0x00,
    0x2c,
    0x29, 0x2f, 0x00,
    0x09,
  ]);

  assert.deepEqual(marshalDecodeExact(encoded), [
    { type: "wstring", value: "/" },
    1,
  ]);
});

test("Frontier settings use Python 3.12 bytecode without changing legacy settings", () => {
  const frontierCode = buildSettingsInfoCode("frontier");
  const legacyCode = buildSettingsInfoCode("tranquility");

  assert.equal(frontierCode.length, 86);
  assert.equal(frontierCode.readUInt8(0), 0xe3);
  assert.equal(legacyCode.readUInt8(0), 0x63);
  assert.notDeepEqual(frontierCode, legacyCode);
  assert.doesNotThrow(() => marshalEncode([frontierCode, 0], {
    compatibilityProfile: "frontier",
  }));
});

test("Frontier nested dogma brain streams avoid the legacy PyObject tag", () => {
  const keyVal = {
    type: "object",
    name: "util.KeyVal",
    args: { type: "dict", entries: [] },
  };
  const frontierBrain = encodeCharacterBrainEffectLists(
    [keyVal],
    [],
    [],
    "frontier",
  );
  const legacyBrain = encodeCharacterBrainEffectLists(
    [keyVal],
    [],
    [],
    "tranquility",
  );

  assert.equal(frontierBrain[8], 0x23);
  assert.equal(legacyBrain[8], 0x17);
});

test("Frontier profile encodes ordinary dictionary text as Python 3 strings", () => {
  const encoded = marshalEncode(
    {
      type: "dict",
      entries: [["challenge_responsehash", "55087"]],
    },
    { compatibilityProfile: "frontier" },
  );
  const decoded = marshalDecode(encoded, {
    compatibilityProfile: "frontier",
  });

  assert.deepEqual(decoded, {
    type: "dict",
    entries: [["challenge_responsehash", "55087"]],
  });
  assert.equal(encoded.includes(Buffer.from("challenge_responsehash")), true);
});

test("Frontier Placebo challenge hash follows its Python 3 marshal dialect", () => {
  assert.equal(
    selectPlaceboChallengeResponseHash("frontier", "\0".repeat(64)),
    "39856",
  );
  assert.equal(crcHqx(Buffer.from("123456789"), 0), 12739);
});

test("Frontier binary payloads use the Python 3 bytes opcode", () => {
  const payload = Buffer.from([0x7e, 0x00, 0xc4, 0xff]);
  const encoded = marshalEncode(payload, {
    compatibilityProfile: "frontier",
  });

  assert.equal(encoded[5], 0x13);
  assert.deepEqual(
    marshalDecode(encoded, { compatibilityProfile: "frontier" }),
    payload,
  );
});

test("Tranquility binary payloads preserve the legacy buffer opcode", () => {
  const payload = Buffer.from([0x7e, 0x00, 0xc4, 0xff]);
  const encoded = marshalEncode(payload);

  assert.equal(encoded[5], 0x0d);
  assert.deepEqual(marshalDecode(encoded), payload);
});

test("Tranquility preserves the existing Placebo challenge hash", () => {
  assert.equal(
    selectPlaceboChallengeResponseHash(
      "tranquility",
      Buffer.alloc(64),
    ),
    "55087",
  );
});

test("Tranquility version exchange preserves the legacy project version", () => {
  assert.equal(
    selectVersionExchangeRelease(
      "tranquility",
      "V24.01@ccp",
      "EvEJS",
      "ccp",
    ),
    "V24.01@ccp",
  );
});

test("Frontier packets use big-endian length prefixes", () => {
  const payload = Buffer.alloc(514, 0x7e);
  const framed = framePayload(payload, "frontier");

  assert.equal(usesBigEndianPacketLengths("frontier"), true);
  assert.deepEqual(framed.subarray(0, 4), Buffer.from([0x00, 0x00, 0x02, 0x02]));
  assert.equal(readPacketLength(framed, "frontier"), 514);
  assert.deepEqual(framed.subarray(4), payload);
});

test("Tranquility packets preserve little-endian length prefixes", () => {
  const payload = Buffer.alloc(514, 0x7e);
  const framed = framePayload(payload, "tranquility");

  assert.equal(usesBigEndianPacketLengths("tranquility"), false);
  assert.deepEqual(framed.subarray(0, 4), Buffer.from([0x02, 0x02, 0x00, 0x00]));
  assert.equal(readPacketLength(framed, "tranquility"), 514);
});

test("Frontier named objects use the observed ObjectEx2 wire shape", () => {
  const state = [
    18,
    encodeAddress({
      type: "node",
      nodeID: 1,
      service: null,
      callID: 0,
    }),
    encodeAddress({
      type: "client",
      clientID: 0,
      service: null,
      callID: 0,
    }),
    3,
    [123, 5, { type: "dict", entries: [] }],
    { type: "dict", entries: [] },
  ];
  const encoded = marshalEncode(
    {
      type: "object",
      name: "carbon.common.script.net.machoNetPacket.SessionInitialStateNotification",
      args: state,
    },
    { compatibilityProfile: "frontier" },
  );
  const decoded = marshalDecode(encoded, {
    compatibilityProfile: "frontier",
  });

  assert.equal(encoded[5], 0x23);
  assert.deepEqual(decoded.header[0], [{
    type: "token",
    value:
      "carbon.common.script.net.machoNetPacket.SessionInitialStateNotification",
  }]);
  assert.equal(decoded.header[1][0], 18);
  assert.equal(decoded.header[1][1].type, "objectex2");
  assert.equal(decoded.header[1][2].type, "objectex2");
  assert.equal(decoded.header[1][3], 3);
  assert.deepEqual(decoded.header[1].slice(4), state.slice(4));
  assert.deepEqual(decoded.list, []);
  assert.deepEqual(decoded.dict, []);

  const packet = decodePacket(decoded);
  assert.equal(packet.type, 18);
  assert.equal(packet.source.type, "node");
  assert.equal(packet.dest.type, "client");
  assert.equal(packet.userID, 3);
});

test("Frontier named objects normalize cached-call raw string descriptors", () => {
  const name =
    "carbon.common.script.net.objectCaching.CachedMethodCallResult";
  const encoded = marshalEncode(
    {
      type: "object",
      name: { type: "rawstr", value: name },
      args: [["station-info"], null, null],
    },
    { compatibilityProfile: "frontier" },
  );
  const decoded = marshalDecode(encoded, {
    compatibilityProfile: "frontier",
  });

  assert.deepEqual(decoded.header[0], [{ type: "token", value: name }]);
  assert.deepEqual(decoded.header[1], [["station-info"], null, null]);
});

test("Frontier proxy cache stores its inner object with ObjectEx2 encoding", () => {
  const rowset = {
    type: "object",
    name: "eve.common.script.sys.rowset.Rowset",
    args: {
      type: "dict",
      entries: [
        ["header", { type: "list", items: ["stationID"] }],
        ["RowClass", { type: "token", value: "util.Row" }],
        ["lines", { type: "list", items: [[64000001]] }],
      ],
    },
  };
  const cachedResult = buildCachedMethodCallResult(rowset, {
    serviceName: "map",
    method: "GetStationInfo",
    proxyCache: true,
    compatibilityProfile: "frontier",
  });
  const cachedReference = cachedResult.args[1];
  const cachedObject = getCachableObjectResponse(
    true,
    cachedReference.args[0],
    cachedReference.args[2],
    cachedReference.args[1],
    "frontier",
  );
  assert.equal(cachedObject.args[4].type, "frontier-bytes");

  const tqCachedObject = getCachableObjectResponse(
    true,
    cachedReference.args[0],
    cachedReference.args[2],
    cachedReference.args[1],
    "tq",
  );
  assert.equal(tqCachedObject.args[4].type, "bytes");

  const storedPickle = cachedObject.args[5]
    ? zlib.inflateSync(cachedObject.args[4].value)
    : cachedObject.args[4].value;
  const decoded = marshalDecode(storedPickle, {
    compatibilityProfile: "frontier",
  });

  assert.equal(storedPickle[5], 0x23);
  assert.deepEqual(decoded.header[0], [{
    type: "token",
    value: "eve.common.script.sys.rowset.Rowset",
  }]);
});

test("Frontier translates the Python 2 set class to its Python 3 module", () => {
  const encoded = marshalEncode(
    {
      type: "objectex1",
      header: [
        { type: "token", value: "__builtin__.set" },
        [{ type: "list", items: [] }],
      ],
      list: [],
      dict: [],
    },
    { compatibilityProfile: "frontier" },
  );
  const decoded = marshalDecode(encoded, {
    compatibilityProfile: "frontier",
  });

  assert.equal(decoded.header[0].value, "builtins.set");
});

test("Tranquility preserves the Python 2 set class token", () => {
  const encoded = marshalEncode({
    type: "objectex1",
    header: [
      { type: "token", value: "__builtin__.set" },
      [{ type: "list", items: [] }],
    ],
    list: [],
    dict: [],
  });

  assert.equal(marshalDecode(encoded).header[0].value, "__builtin__.set");
});

test("Frontier dogma info attributes carry value and timestamp pairs", () => {
  const timestamp = 134299357435130000n;
  const attributes = {
    type: "dict",
    entries: [
      [3, 0],
      [4, 6800000],
    ],
  };

  assert.deepEqual(
    normalizeInfoAttributesForProfile(attributes, timestamp, "frontier"),
    {
      type: "dict",
      entries: [
        [3, [0, timestamp]],
        [4, [6800000, timestamp]],
      ],
    },
  );
});

test("Tranquility dogma info attributes preserve scalar values", () => {
  const attributes = {
    type: "dict",
    entries: [[3, 0]],
  };

  assert.equal(
    normalizeInfoAttributesForProfile(
      attributes,
      134299357435130000n,
      "tranquility",
    ),
    attributes,
  );
});

test("Frontier ship activation state omits the newer heat-state element", () => {
  const activationState = [
    { instanceCache: true },
    { flagQuantityCache: true },
    { weaponBanks: true },
    { heatState: true },
  ];

  assert.deepEqual(
    normalizeActivationStateForProfile(activationState, "frontier"),
    activationState.slice(0, 3),
  );
  assert.equal(
    normalizeActivationStateForProfile(activationState, "tranquility"),
    activationState,
  );
});

test("Frontier instance cache uses dogma attribute dictionaries", () => {
  const packedRow = {
    type: "packedrow",
    fields: {
      instanceID: 9988400000487,
      online: true,
      damage: 3,
      charge: 18,
      skillPoints: 276,
      armorDamage: 266,
      shieldCharge: 264,
      incapacitated: false,
    },
  };

  assert.deepEqual(
    normalizePackedInstanceRowForProfile(packedRow, "frontier"),
    {
      type: "dict",
      entries: [
        [2, true],
        [3, 3],
        [18, 18],
        [264, 264],
        [266, 266],
        [276, 276],
      ],
    },
  );
  assert.equal(
    normalizePackedInstanceRowForProfile(packedRow, "tranquility"),
    packedRow,
  );
});

test("Frontier combat timers omit the newer disapproval-timer element", () => {
  const combatTimers = [
    ["weapon", null],
    ["pvp", null],
    ["npc", null],
    ["criminal", null],
    ["disapproval", null],
  ];

  assert.deepEqual(
    normalizeCombatTimersForProfile(combatTimers, "frontier"),
    combatTimers.slice(0, 4),
  );
  assert.equal(
    normalizeCombatTimersForProfile(combatTimers, "tranquility"),
    combatTimers,
  );
});

test("Frontier space bootstrap receives its three destiny feature flags", () => {
  assert.deepEqual(
    buildDestinyConfigurationSettings("frontier"),
    [false, false, false],
  );
  assert.equal(
    buildDestinyConfigurationSettings("tranquility"),
    null,
  );
});

test("Frontier sends an atomic native warp and FX packet", () => {
  const toFiniteNumber = (value, fallback = 0) => {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : fallback;
  };
  const toInt = (value, fallback = 0) => {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
  };
  const cloneVector = (value, fallback = { x: 0, y: 0, z: 0 }) => ({
    x: toFiniteNumber(value && value.x, fallback.x),
    y: toFiniteNumber(value && value.y, fallback.y),
    z: toFiniteNumber(value && value.z, fallback.z),
  });
  const magnitude = (value) => Math.hypot(value.x, value.y, value.z);
  const normalizeVector = (value, fallback) => {
    const length = magnitude(value);
    return length > 0
      ? { x: value.x / length, y: value.y / length, z: value.z / length }
      : cloneVector(fallback);
  };
  const scaleVector = (value, scale) => ({
    x: value.x * scale,
    y: value.y * scale,
    z: value.z * scale,
  });
  const subtractVectors = (left, right) => ({
    x: left.x - right.x,
    y: left.y - right.y,
    z: left.z - right.z,
  });
  const builderDeps = {
    cloneVector,
    DESTINY_STAMP_INTERVAL_MS: 1_000,
    DEFAULT_RIGHT: { x: 1, y: 0, z: 0 },
    ENABLE_PILOT_WARP_FACTOR_OPTION_A: false,
    ENABLE_PILOT_WARP_MAX_SPEED_RAMP: false,
    ENABLE_PILOT_WARP_SOLVER_ASSIST_OPTION_B: false,
    INDIVIDUAL_WARP_FACTORS: {
      acceleration: 0.001,
      deceleration: 1 / 3000,
    },
    magnitude,
    normalizeVector,
    scaleVector,
    subtractVectors,
    WARP_NATIVE_ACTIVATION_SPEED_FRACTION: 0.75,
    WARP_NATIVE_ACTIVATION_SPEED_MARGIN_MS: 1,
    WARP_START_ACTIVATION_SEED_SCALE: 1.1,
    toFiniteNumber,
    toInt,
  };
  const builders = createDestinyWarpUpdateBuilders(builderDeps);
  const entity = {
    itemID: 9002,
    maxVelocity: 200,
    position: { x: 0, y: 0, z: 0 },
  };
  const warpState = {
    rawDestination: { x: 1_000_000, y: 0, z: 0 },
    stopDistance: 0,
    warpSpeed: 6_000,
    startTimeMs: 10_000,
  };

  const frontierPrepare = builders.buildWarpPrepareDispatch(
    entity,
    100,
    warpState,
    {
      includePilotActivationVelocity: true,
    },
  );
  assert.deepEqual(
    frontierPrepare.pilotUpdates.map((update) => update.payload[0]),
    [
      "SetBallWarpFactors",
      "SetMaxSpeed",
      "WarpTo",
      "SetBallVelocity",
      "OnSpecialFX",
      "SetSpeedFraction",
    ],
  );
  assert.equal(frontierPrepare.pilotUpdates[0].payload[1][1].value, 0.001);
  assert.equal(
    frontierPrepare.pilotUpdates[0].payload[1][2].value,
    1 / 3000,
  );
  assert.equal(frontierPrepare.pilotUpdates[2].payload[1][5], 6_000);
  const activationVelocity = frontierPrepare.pilotUpdates[3].payload[1];
  assert.ok(Math.abs(activationVelocity[1].value - 166) < 1e-9);
  assert.equal(activationVelocity[2].value, 0);
  assert.equal(activationVelocity[3].value, 0);

  const movingEntity = {
    ...entity,
    velocity: { x: 0, y: 200, z: 0 },
  };
  const alignedVelocity = builders.buildWarpPrepareDispatch(
    movingEntity,
    100,
    warpState,
    { includePilotActivationVelocity: true },
  ).pilotUpdates[3].payload[1];
  assert.ok(Math.abs(alignedVelocity[1].value - 200) < 1e-9);
  assert.equal(alignedVelocity[2].value, 0);
  assert.equal(alignedVelocity[3].value, 0);

  const legacyBuilders = createDestinyWarpUpdateBuilders({
    ...builderDeps,
    INDIVIDUAL_WARP_FACTORS: null,
  });
  const tqPrepare = legacyBuilders.buildWarpPrepareDispatch(
    entity,
    100,
    warpState,
  );
  assert.deepEqual(
    tqPrepare.pilotUpdates.map((update) => update.payload[0]),
    ["SetMaxSpeed", "WarpTo", "OnSpecialFX", "SetSpeedFraction"],
  );
  assert.equal(tqPrepare.pilotUpdates[1].payload[1][5], 6_000);

  builders.primePilotWarpActivationState(entity, warpState, 100);
  assert.equal(warpState.effectStamp, 100);
  assert.equal(warpState.effectAtMs, 10_000);
});

test("Frontier deployable warp subjects use the entity warp path", () => {
  const service = new BeyonceService();
  const session = { characterID: 140000005 };
  const targetID = 9988400001770;
  const originalWarpToEntity = frontierSpaceRuntime.warpToEntity;
  let capturedWarp = null;
  frontierSpaceRuntime.warpToEntity = (warpSession, warpTargetID, options) => {
    capturedWarp = { options, warpSession, warpTargetID };
    return { success: true, data: {} };
  };

  try {
    assert.equal(
      service.Handle_CmdWarpToStuff(
        ["deployable", targetID],
        session,
        { minRange: 25_000 },
      ),
      null,
    );
  } finally {
    frontierSpaceRuntime.warpToEntity = originalWarpToEntity;
  }

  assert.equal(capturedWarp.warpSession, session);
  assert.equal(capturedWarp.warpTargetID, targetID);
  assert.equal(capturedWarp.options.minimumRange, 25_000);
});

test("Frontier undock defers authoritative ballpark state until beyonce bind", () => {
  assert.equal(
    defersUndockBallparkStateUntilBeyonceBind("frontier"),
    true,
  );
  assert.equal(
    defersUndockBallparkStateUntilBeyonceBind("tranquility"),
    false,
  );
  assert.equal(defersUndockBallparkStateUntilBeyonceBind(), false);
});

test("Frontier manual flight uses native scalar pitch and yaw actions", () => {
  const addVectors = (left, right) => ({
    x: left.x + right.x,
    y: left.y + right.y,
    z: left.z + right.z,
  });
  const cloneVector = (value) => ({
    x: Number(value && value.x) || 0,
    y: Number(value && value.y) || 0,
    z: Number(value && value.z) || 0,
  });
  const scaleVector = (value, scalar) => ({
    x: value.x * scalar,
    y: value.y * scalar,
    z: value.z * scalar,
  });
  const normalizeVector = (value, fallback = { x: 1, y: 0, z: 0 }) => {
    const length = Math.hypot(value.x, value.y, value.z);
    return length > 0
      ? scaleVector(value, 1 / length)
      : cloneVector(fallback);
  };
  const clamp = (value, minimum, maximum) =>
    Math.max(minimum, Math.min(maximum, Number(value) || 0));
  const entity = {
    itemID: 9002,
    mode: "GOTO",
    position: { x: 0, y: 0, z: 0 },
    direction: { x: 0, y: 0, z: 1 },
    targetPoint: { x: 0, y: 0, z: 1.0e16 },
    speedFraction: 1,
  };
  const sent = [];
  const runtime = {
    getShipEntityForSession: () => entity,
    getCurrentSimTimeMs: () => 10_000,
    getHistorySafeSessionDestinyStamp: () => 77,
    broadcastPilotCommandMovementUpdates: (_session, updates) => sent.push(...updates),
    scheduleWatcherMovementAnchor: () => true,
  };
  const commands = createMovementManualFlightCommands({
    addVectors,
    armMovementTrace: () => {},
    clamp,
    clearTrackingState,
    cloneVector,
    normalizeVector,
    persistShipEntity: () => true,
    roundNumber: (value) => Number(value),
    scaleVector,
    summarizeVector: cloneVector,
    toFiniteNumber: (value, fallback = 0) =>
      Number.isFinite(Number(value)) ? Number(value) : fallback,
    DEFAULT_RIGHT: { x: 1, y: 0, z: 0 },
  });

  assert.equal(commands.setPitch(runtime, {}, 2), true);
  assert.equal(commands.setYawRate(runtime, {}, -0.5), true);
  assert.equal(entity.manualFlightActive, true);
  assert.equal(entity.manualPitch, 1);
  assert.equal(entity.manualYawRate, -0.5);
  assert.deepEqual(sent.map((update) => update.payload[0]), [
    "SetPitch",
    "SetYawRate",
  ]);
  for (const update of sent) {
    assert.equal(update.stamp, 77);
    assert.equal(isDestinyPayload(update.payload), true);
    assert.equal(getPayloadPrimaryEntityID(update.payload), 9002);
  }
  assert.equal(sent[0].payload[1][1].value, 1);
  assert.equal(sent[1].payload[1][1].value, -0.5);
});

test("Frontier manual flight advances pitch target and sustained yaw rate", () => {
  const addVectors = (left, right) => ({
    x: left.x + right.x,
    y: left.y + right.y,
    z: left.z + right.z,
  });
  const cloneVector = (value) => ({
    x: Number(value && value.x) || 0,
    y: Number(value && value.y) || 0,
    z: Number(value && value.z) || 0,
  });
  const scaleVector = (value, scalar) => ({
    x: value.x * scalar,
    y: value.y * scalar,
    z: value.z * scalar,
  });
  const normalizeVector = (value, fallback = { x: 1, y: 0, z: 0 }) => {
    const length = Math.hypot(value.x, value.y, value.z);
    return length > 0
      ? scaleVector(value, 1 / length)
      : cloneVector(fallback);
  };
  const simulator = createDestinyMovementSimulator({
    addVectors,
    clamp: (value, minimum, maximum) =>
      Math.max(minimum, Math.min(maximum, Number(value) || 0)),
    cloneVector,
    normalizeVector,
    scaleVector,
    toFiniteNumber: (value, fallback = 0) =>
      Number.isFinite(Number(value)) ? Number(value) : fallback,
    DEFAULT_RIGHT: { x: 1, y: 0, z: 0 },
  });
  const entity = {
    mode: "GOTO",
    manualFlightActive: true,
    manualPitch: 1,
    manualYawRate: 1,
    maxAngularSpeed: 0.5,
    position: { x: 10, y: 20, z: 30 },
    direction: { x: 0, y: 0, z: 1 },
  };

  assert.equal(simulator.advanceManualFlightTarget(entity, 1), true);
  assert.ok(Math.abs(entity.manualPitchVelocity - 0.5) < 1e-9);
  assert.ok(Math.abs(entity.manualYawVelocity - 0.5) < 1e-9);
  const direction = normalizeVector({
    x: entity.targetPoint.x - entity.position.x,
    y: entity.targetPoint.y - entity.position.y,
    z: entity.targetPoint.z - entity.position.z,
  });
  assert.ok(Math.abs(direction.x - (Math.sin(0.5) * Math.cos(0.5))) < 1e-9);
  assert.ok(Math.abs(direction.y - Math.sin(0.5)) < 1e-9);
  assert.ok(Math.abs(direction.z - (Math.cos(0.5) ** 2)) < 1e-9);
});

test("Frontier rigid balls include the native orientation fields", () => {
  const entity = {
    itemID: 64000001,
    kind: "station",
    radius: 33800,
    position: { x: 1, y: 2, z: 3 },
  };
  const frontier = encodeEntityBall(entity, {
    compatibilityProfile: "frontier",
  });
  const tranquility = encodeEntityBall(entity, {
    compatibilityProfile: "tranquility",
  });

  assert.equal(frontier.length, 87);
  assert.equal(frontier.readBigInt64LE(0), 64000001n);
  assert.equal(frontier.readUInt8(8), 11);
  assert.equal(frontier.readUInt8(37), 0x06);
  assert.equal(frontier.readInt32LE(38), -0x80000000);
  assert.equal(frontier.readDoubleLE(42), 1);
  assert.equal(frontier.readDoubleLE(50), 0);
  assert.equal(frontier.readDoubleLE(58), 0);
  assert.equal(frontier.readDoubleLE(66), 0);
  assert.equal(frontier.readInt32LE(74), -1);
  assert.equal(frontier.readFloatLE(78), 1);
  assert.equal(frontier.readInt32LE(82), 0);
  assert.equal(frontier.readUInt8(86), 0xff);
  assert.equal(tranquility.length, 39);
  assert.equal(tranquility.readUInt8(38), 0xff);
});

test("Frontier free GOTO balls match the native mode trailer", () => {
  const entity = {
    itemID: 9002,
    kind: "ship",
    mode: "GOTO",
    radius: 13.5,
    mass: 6800000,
    ownerID: 1000442,
    corporationID: 1000442,
    pilotCharacterID: 140000005,
    position: { x: 1, y: 2, z: 3 },
    velocity: { x: 4, y: 5, z: 6 },
    maxVelocity: 260,
    maxAngularSpeed: 0.235,
    angularAgility: 0.6,
    inertia: 0.5,
    speedFraction: 1,
    targetPoint: { x: 7, y: 8, z: 9 },
  };
  const encoded = encodeEntityBall(entity, {
    compatibilityProfile: "frontier",
  });

  assert.equal(encoded.length, 244);
  assert.equal(encoded.readBigInt64LE(0), 9002n);
  assert.equal(encoded.readUInt8(8), 0);
  assert.equal(encoded.readUInt8(37), 0x09);
  assert.equal(encoded.readInt32LE(38), -0x80000000);
  assert.equal(encoded.readDoubleLE(42), 1);
  assert.equal(encoded.readInt32LE(74), -1);
  assert.equal(encoded.readFloatLE(78), 1);
  assert.equal(encoded.readDoubleLE(82), 6800000);
  assert.equal(encoded.readFloatLE(107), 260);
  assert.equal(encoded.readDoubleLE(111), 4);
  assert.equal(encoded.readFloatLE(135), 0.5);
  assert.equal(encoded.readFloatLE(139), 1);
  assert.ok(Math.abs(encoded.readFloatLE(167) - 0.235) < 1e-6);
  assert.ok(Math.abs(encoded.readFloatLE(195) - 0.6) < 1e-6);
  assert.equal(encoded.readDoubleLE(199), -1);
  assert.equal(encoded.readDoubleLE(207), -1);
  assert.equal(encoded.readUInt8(215), 0xff);
  assert.equal(encoded.readFloatLE(216), 0);
  assert.equal(encoded.readDoubleLE(220), 7);
  assert.equal(encoded.readDoubleLE(228), 8);
  assert.equal(encoded.readDoubleLE(236), 9);
});

test("Frontier free WARP balls match the native 64-bit effect trailer", () => {
  const entity = {
    itemID: 9002,
    kind: "ship",
    mode: "WARP",
    radius: 13.5,
    mass: 6800000,
    ownerID: 1000442,
    corporationID: 1000442,
    pilotCharacterID: 140000005,
    position: { x: 1, y: 2, z: 3 },
    velocity: { x: 4, y: 5, z: 6 },
    maxVelocity: 260,
    inertia: 0.5,
    speedFraction: 1,
    warpState: {
      nativeWarpCommand: "WARP",
      targetPoint: { x: 70, y: 80, z: 90 },
      effectStamp: 101,
      totalDistance: 123456789,
      stopDistance: 848.5,
      warpSpeed: 6000,
    },
  };
  const encoded = encodeEntityBall(entity, {
    compatibilityProfile: "frontier",
  });

  assert.equal(encoded.length, 272);
  assert.equal(encoded.readUInt8(8), 3);
  assert.equal(encoded.readUInt8(215), 0xff);
  assert.equal(encoded.readDoubleLE(216), 70);
  assert.equal(encoded.readDoubleLE(224), 80);
  assert.equal(encoded.readDoubleLE(232), 90);
  assert.equal(encoded.readBigInt64LE(240), 101n);
  assert.equal(encoded.readDoubleLE(248), 123456789);
  assert.equal(encoded.readDoubleLE(256), 848.5);
  assert.equal(encoded.readBigInt64LE(264), 6000n);
});

test("Frontier SetState uses the Python 3 crdata contract", () => {
  assert.equal(usesCrDataSetState("frontier"), true);
  assert.equal(usesCrDataSetState("tranquility"), false);
  assert.equal(usesFrontierStateStreamPreamble("frontier"), true);
  assert.equal(usesFrontierStateStreamPreamble("tranquility"), false);

  const simFileTime = 134141234567890000n;
  const buildPayload = (compatibilityProfile) => buildSetStatePayload(
    7,
    {},
    9001,
    [{ itemID: 9001, kind: "station" }],
    simFileTime,
    [],
    [],
    {
      compatibilityProfile,
      encodeEntityBall: () => Buffer.alloc(0),
      buildSlimItemDict: (entity) => ({
        type: "dict",
        entries: [
          ["itemID", entity.itemID],
          ["typeID", 85226],
          ["groupID", 15],
          ["categoryID", 3],
          ["graphicID", 29045],
          ["activityLevel", null],
          ["online", 1],
        ],
      }),
      buildSlimItemObject: (entity) => ({
        type: "object",
        name: "foo.SlimItem",
        args: {
          type: "dict",
          entries: [["itemID", entity.itemID]],
        },
      }),
      buildDroneState: () => ({ type: "list", items: [] }),
      buildSolItem: () => null,
    },
  );
  const getStateEntry = (payload, name) => (
    payload[1][0].args.entries.find(([key]) => key === name)?.[1]
  );

  const frontierPayload = buildPayload("frontier");
  assert.deepEqual(
    getStateEntry(frontierPayload, "crdata").entries[0][0],
    9001,
  );
  assert.deepEqual(
    getStateEntry(frontierPayload, "crdata").entries[0][1].entries
      .map(([key]) => key),
    ["itemID", "typeID", "activityLevel"],
  );
  assert.equal(getStateEntry(frontierPayload, "slims"), undefined);
  const frontierState = getStateEntry(frontierPayload, "state");
  assert.equal(frontierState.length, 41);
  assert.equal(frontierState.readUInt8(0), 0);
  assert.equal(frontierState.readUInt32LE(1), 7);
  assert.equal(frontierState.readBigInt64LE(5), simFileTime);
  assert.equal(frontierState.readUInt32LE(13), 1000);
  assert.equal(frontierState.readDoubleLE(17), 1);
  assert.equal(frontierState.readDoubleLE(25), 0);
  assert.equal(frontierState.readDoubleLE(33), 1);

  const tqPayload = buildPayload("tranquility");
  assert.equal(getStateEntry(tqPayload, "crdata"), undefined);
  assert.equal(getStateEntry(tqPayload, "slims").items[0].name, "foo.SlimItem");
  assert.equal(getStateEntry(tqPayload, "state").length, 5);
});

test("Frontier omits wire slim items; legacy profiles keep them", () => {
  const legacySlim = {
    type: "object",
    name: "foo.SlimItem",
    args: { type: "dict", entries: [["itemID", 9988400001771]] },
  };

  // Build 3455996 whitelists neither "foo.SlimItem" (the class __guid__) nor
  // "eve.common.script.util.slimItem.SlimItem", and ships no
  // OnSlimItemChange handler: any wire SlimItem makes the client discard the
  // entire DoDestinyUpdate. Frontier therefore sends none.
  assert.equal(normalizeSlimItemObjectForProfile(legacySlim, "frontier"), null);
  assert.equal(usesWireSlimItemObjects("frontier"), false);

  assert.equal(
    normalizeSlimItemObjectForProfile(legacySlim, "tranquility"),
    legacySlim,
  );
  assert.equal(usesWireSlimItemObjects("tranquility"), true);
});

test("Frontier presentation bundles drop the slim update but keep damage state", () => {
  const damageState = { type: "list", items: [] };
  const slimUpdates = buildSlimItemPresentationUpdates({
    stamp: 100,
    entityID: 9988400001771,
    slimItem: null,
  });
  assert.deepEqual(slimUpdates, []);

  const lifecycleUpdates = buildStructureLifecyclePresentationUpdates({
    stamp: 100,
    entityID: 9988400001771,
    damageState,
    slimItem: null,
  });
  const actions = lifecycleUpdates.map((update) => update.payload[0]);
  assert.ok(actions.includes("OnDamageStateChange"));
  assert.ok(!actions.includes("OnSlimItemChange"));

  // Legacy profiles still receive the slim refresh.
  const legacySlim = {
    type: "object",
    name: "foo.SlimItem",
    args: { type: "dict", entries: [] },
  };
  assert.deepEqual(
    buildSlimItemPresentationUpdates({
      stamp: 100,
      entityID: 9988400001771,
      slimItem: legacySlim,
    }).map((update) => update.payload[0]),
    ["OnSlimItemChange"],
  );
});

test("Frontier stargate crdata uses a typed CRowset for jumps", () => {
  const jumps = {
    type: "object",
    name: "eve.common.script.sys.rowset.Rowset",
    args: {
      type: "dict",
      entries: [],
    },
  };
  const crData = {
    type: "dict",
    entries: [
      ["itemID", 60000001],
      ["typeID", 79787],
      ["jumps", jumps],
    ],
  };
  const entity = {
    itemID: 60000001,
    kind: "stargate",
    destinationID: 60000002,
    destinationSolarSystemID: 30000005,
  };

  const normalized = normalizeCrDataDictionaryForProfile(
    crData,
    entity,
    "frontier",
  );
  const frontierJumps = normalized.entries.find(([key]) => key === "jumps")[1];

  assert.equal(frontierJumps.type, "objectex2");
  assert.equal(
    frontierJumps.header[0][0].value,
    "carbon.common.script.sys.crowset.CRowset",
  );
  assert.deepEqual(frontierJumps.list[0].columns, [
    ["toCelestialID", 0x14],
    ["locationID", 0x14],
  ]);
  assert.deepEqual(frontierJumps.list[0].values, [60000002, 30000005]);
  assert.equal(
    normalizeCrDataDictionaryForProfile(crData, entity, "tranquility"),
    crData,
  );
});

test("Frontier legacy orbitals use only generic CR object fields", () => {
  const crData = {
    type: "dict",
    entries: [
      ["itemID", 1200042000001],
      ["typeID", 2233],
      ["ownerID", 1],
      ["locationID", 30000004],
      ["corpID", 1],
      ["allianceID", 0],
      ["orbitalState", null],
    ],
  };

  const normalized = normalizeCrDataDictionaryForProfile(
    crData,
    { itemID: 1200042000001, kind: "orbital" },
    "frontier",
  );

  assert.deepEqual(
    normalized.entries.map(([key]) => key),
    ["itemID", "typeID", "ownerID", "locationID"],
  );
});

test("Frontier AddBalls2 uses ball ID keyed crdata tuples", () => {
  assert.equal(usesCrDataBallMetadata("frontier"), true);
  assert.equal(usesCrDataBallMetadata("tranquility"), false);

  const slimItem = {
    type: "dict",
    entries: [
      ["itemID", 9002],
      ["typeID", 87698],
      ["groupID", 25],
      ["categoryID", 6],
      ["graphicID", 31488],
      ["modules", { type: "list", items: [] }],
    ],
  };
  const damageState = { marker: "damage" };
  const buildPayload = (compatibilityProfile) => buildAddBalls2Payload(
    9,
    [{ itemID: 9002, kind: "ship", forceDamageState: true }],
    134141234567890001n,
    {
      compatibilityProfile,
      encodeEntityBall: () => Buffer.alloc(0),
      buildSlimItemDict: () => slimItem,
      buildDamageState: () => damageState,
    },
  );

  const frontierPayload = buildPayload("frontier");
  assert.equal(frontierPayload[1][0][0].length, 41);
  assert.equal(frontierPayload[1][0][1].items[0][0], 9002);
  assert.deepEqual(
    frontierPayload[1][0][1].items[0][1].entries.map(([key]) => key),
    ["itemID", "typeID", "modules"],
  );
  assert.equal(frontierPayload[1][0][1].items[0][2], damageState);

  const tqPayload = buildPayload("tranquility");
  assert.equal(tqPayload[1][0][0].length, 5);
  assert.deepEqual(
    tqPayload[1][0][1].items[0],
    [slimItem, damageState],
  );
});

test("Tranquility named objects preserve the legacy PyObject opcode", () => {
  const encoded = marshalEncode({
    type: "object",
    name: "macho.PingRsp",
    args: [1, 2, 3, null, [], { type: "dict", entries: [] }],
  });

  assert.equal(encoded[5], 0x17);
  assert.equal(marshalDecode(encoded).type, "object");
});

test("Frontier ObjectEx2 CallReq and MachoAddress decode as PyPacket", () => {
  const objectEx2 = (name, state) => ({
    type: "objectex2",
    header: [[{ type: "token", value: name }], state],
    list: [],
    dict: [],
  });
  const decoded = objectEx2(
    "carbon.common.script.net.machoNetPacket.CallReq",
    [
      6,
      objectEx2(
        "carbon.common.script.net.machoNetAddress.MachoAddress",
        [2, 0, 1, null],
      ),
      objectEx2(
        "carbon.common.script.net.machoNetAddress.MachoAddress",
        [1, 65450, "machoNet", null],
      ),
      3,
      [],
      { type: "dict", entries: [] },
    ],
  );

  const packet = decodePacket(decoded);
  assert.equal(packet.type, 6);
  assert.equal(packet.source.type, "client");
  assert.equal(packet.source.callID, 1);
  assert.equal(packet.dest.type, "node");
  assert.equal(packet.dest.service, "machoNet");
  assert.equal(packet.userID, 3);
});
