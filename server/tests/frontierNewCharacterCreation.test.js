"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const config = require("../src/config");
const CharService = require("../src/services/character/charService");
const {
  getCharacterRecord,
} = require("../src/services/character/characterState");
const {
  CREATION_FITTING_FLAG_ID,
  ensureCreationState,
  filterCreationModuleInventoryItems,
  readCreationState,
} = require("../src/services/frontier/creationRuntime");
const CreationService = require(
  "../src/services/frontier/creationService",
);
const InvBrokerService = require(
  "../src/services/inventory/invBrokerService",
);
const {
  ITEM_FLAGS,
  findCharacterShipItem,
  getAllItems,
  getItemMetadata,
  grantItemToCharacterLocation,
  listCharacterItems,
  listContainerItems,
} = require("../src/services/inventory/itemStore");
const {
  marshalEncode,
} = require("../src/network/tcp/utils/marshal");

const STARTER_LOCATION = Object.freeze({
  corporationID: 1000442,
  factionID: null,
  stationID: 64000001,
  homeStationID: 64000001,
  cloneStationID: 64000001,
  solarSystemID: 30000004,
  constellationID: 20000004,
  regionID: 10000004,
});

function createCharacter(name, userid, creationOptions = {}) {
  const service = new CharService();
  return service.Handle_CreateCharacterWithDoll(
    [name, 1, 1, 1, null, null, 0],
    { userid },
    null,
    {
      starterLocation: STARTER_LOCATION,
      ...creationOptions,
    },
  );
}

function createFrontierCharacterInSpace(name, userid) {
  const previousProfile = config.clientCompatibilityProfile;
  config.clientCompatibilityProfile = "frontier";
  try {
    return new CharService().Handle_CreateCharacterInSpace(
      [name, 1],
      { userid },
    );
  } finally {
    config.clientCompatibilityProfile = previousProfile;
  }
}

function assertMarshallableIterable(value) {
  assert.ok(value, "inventory call must never return None");
  assert.ok(
    value.type === "list" || value.type === "objectex1",
    `unexpected inventory iterable type ${String(value.type)}`,
  );
  assert.doesNotThrow(() => marshalEncode(value, {
    compatibilityProfile: "frontier",
  }));
}

function bindShipInventory(service, session, shipID) {
  const objectID = `test:ship-inventory:${shipID}`;
  service._rememberBoundContext(objectID, {
    inventoryID: shipID,
    locationID: STARTER_LOCATION.stationID,
    flagID: ITEM_FLAGS.CARGO_HOLD,
    kind: "shipInventory",
    ownerID: session.characterID,
  });
  session.currentBoundObjectID = objectID;
}

test("Frontier character creation starts in one initialized Creation", () => {
  const characterID = createFrontierCharacterInSpace(
    "Frontier Creation Test",
    990000001,
  );
  const character = getCharacterRecord(characterID);
  const ship = findCharacterShipItem(characterID, character.shipID);

  assert.equal(character.shipTypeID, 95276);
  assert.equal(character.shipName, "Creation");
  assert.equal(ship.typeID, 95276);
  assert.equal(ship.itemName, "Creation");
  assert.equal(
    listCharacterItems(characterID).some((item) => Number(item.typeID) === 87698),
    false,
  );

  const state = readCreationState(ship);
  assert.equal(state.version, 1);
  assert.equal(state.templateTypeID, 95276);
  assert.equal(state.poweredOff, false);
  assert.equal(state.modules.length, 27);
  assert.equal(state.interiorPlacements.length, 21);
  assert.equal(state.hardpoints.length, 7);

  const moduleItems = listContainerItems(
    characterID,
    ship.itemID,
    CREATION_FITTING_FLAG_ID,
  );
  assert.equal(moduleItems.length, 27);
  assert.deepEqual(
    new Set(moduleItems.map((item) => Number(item.itemID))),
    new Set(state.modules.map((module) => Number(module.itemID))),
  );
  for (const moduleItem of moduleItems) {
    assert.equal(moduleItem.ownerID, characterID);
    assert.equal(moduleItem.locationID, ship.itemID);
    assert.equal(moduleItem.flagID, CREATION_FITTING_FLAG_ID);
    assert.equal(moduleItem.singleton, 1);
    assert.equal(moduleItem.stacksize, 1);
  }

  const staleShipSnapshot = { ...ship, customInfo: "" };
  const secondEnsure = ensureCreationState(staleShipSnapshot, characterID);
  assert.equal(secondEnsure.success, true);
  assert.equal(secondEnsure.data.seeded, false);
  assert.equal(
    listContainerItems(
      characterID,
      ship.itemID,
      CREATION_FITTING_FLAG_ID,
    ).length,
    27,
  );

  const wrongOwnerEnsure = ensureCreationState(
    staleShipSnapshot,
    characterID + 1,
  );
  assert.equal(wrongOwnerEnsure.success, false);
  assert.equal(wrongOwnerEnsure.errorMsg, "CREATION_ITEM_NOT_OWNED");

  const session = {
    charid: characterID,
    characterID,
    shipid: ship.itemID,
    shipID: ship.itemID,
    stationid: character.stationID,
    stationID: character.stationID,
    solarsystemid2: character.solarSystemID,
    compatibilityProfile: "frontier",
  };
  const creationResponse = new CreationService().Handle_get_creation(
    [ship.itemID],
    session,
  );
  assert.ok(creationResponse);
  assert.doesNotThrow(() => marshalEncode(creationResponse, {
    compatibilityProfile: "frontier",
  }));

  const inventory = new InvBrokerService();
  bindShipInventory(inventory, session, ship.itemID);
  assertMarshallableIterable(inventory.Handle_List([null], session));
  assertMarshallableIterable(inventory.Handle_List([156], session));
  assertMarshallableIterable(inventory.Handle_ListByFlags([[5]], session));
});

test("generic character creation retains the racial Wend profile", () => {
  const characterID = createCharacter("Legacy Wend Test", 990000002);
  const character = getCharacterRecord(characterID);
  const ship = findCharacterShipItem(characterID, character.shipID);

  assert.equal(character.shipTypeID, 87698);
  assert.equal(character.shipName, "Wend");
  assert.equal(ship.typeID, 87698);
  assert.equal(ship.itemName, "Wend");
});

test("non-Creation ship inventory calls remain iterable", () => {
  const characterID = createCharacter(
    "Inventory Guard Test",
    990000003,
    {
      starterShipTypeID: CharService._testing.FRONTIER_STARTER_SHIP_TYPE_ID,
      starterShipName: CharService._testing.FRONTIER_STARTER_SHIP_NAME,
      initializeCreation: true,
    },
  );
  const character = getCharacterRecord(characterID);
  const grant = grantItemToCharacterLocation(
    characterID,
    STARTER_LOCATION.stationID,
    ITEM_FLAGS.HANGAR,
    getItemMetadata(87698),
    1,
    { singleton: 1, itemName: "Inventory Test Wend" },
  );
  assert.equal(grant.success, true);
  const wend = grant.data.items[0];
  const ordinaryRows = [
    { itemID: 1, flagID: ITEM_FLAGS.CARGO_HOLD },
    { itemID: 2, flagID: 156 },
    { itemID: 3, flagID: CREATION_FITTING_FLAG_ID },
  ];

  assert.equal(readCreationState(wend), null);
  assert.equal(filterCreationModuleInventoryItems(wend, ordinaryRows), ordinaryRows);

  const session = {
    charid: characterID,
    characterID,
    shipid: character.shipID,
    shipID: character.shipID,
    stationid: STARTER_LOCATION.stationID,
    stationID: STARTER_LOCATION.stationID,
    solarsystemid2: STARTER_LOCATION.solarSystemID,
    compatibilityProfile: "frontier",
  };
  const inventory = new InvBrokerService();
  bindShipInventory(inventory, session, wend.itemID);

  assertMarshallableIterable(inventory.Handle_List([null], session));
  assertMarshallableIterable(inventory.Handle_List([156], session));
  assertMarshallableIterable(inventory.Handle_ListByFlags([[5]], session));
});

test("failed Frontier Creation initialization rolls back the new character", () => {
  const userid = 990000004;
  const service = new CharService();
  const session = { userid };
  const itemIDsBefore = new Set(
    Object.values(getAllItems()).map((item) => Number(item.itemID)),
  );
  assert.equal(service.Handle_GetNumCharacters([], session), 0);

  assert.throws(() => service.Handle_CreateCharacterWithDoll(
    ["Broken Creation Test", 1, 1, 1, null, null, 0],
    session,
    null,
    {
      starterLocation: STARTER_LOCATION,
      starterShipTypeID: 87698,
      starterShipName: "Wend",
      initializeCreation: true,
    },
  ));
  assert.equal(service.Handle_GetNumCharacters([], session), 0);
  assert.deepEqual(
    new Set(Object.values(getAllItems()).map((item) => Number(item.itemID))),
    itemIDsBefore,
  );
});
