"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const itemStore = require("../src/services/inventory/itemStore");
const smartStorageUnitRuntime = require(
  "../src/services/frontier/smartStorageUnitRuntime",
);
const {
  getStorageUnitProtoTypes,
} = require(
  "../src/_secondary/express/gatewayServices/assemblyStorageUnitProto",
);
const {
  EXECUTE_DEPOSIT_ITEMS_REQUEST,
  EXECUTE_WITHDRAW_ITEMS_REQUEST,
  GET_INVENTORY_REQUEST,
  INVENTORY_ITEM_DEPOSITED_NOTICE,
  INVENTORY_ITEM_WITHDRAWN_NOTICE,
  PREPARE_DEPOSIT_ITEMS_REQUEST,
  PREPARE_WITHDRAW_ITEMS_REQUEST,
  createAssemblyStorageUnitGatewayService,
} = require(
  "../src/_secondary/express/gatewayServices/assemblyStorageUnitGatewayService",
);
const {
  uuidBufferToString,
} = require(
  "../src/_secondary/express/gatewayServices/gatewayServiceHelpers",
);

const OWNER_ID = 140000003;
const VISITOR_ID = 140000002;
const SOLAR_SYSTEM_ID = 30000004;
const STORAGE_TYPE_ID = 77917;
const SHIP_TYPE_ID = 95276;
const MATERIAL_TYPE_ID = 78423; // Water Ice, 0.1 m³ per unit
const CARGO_FLAG = 5;
const STORAGE_FLAG = 66;
const VALID_SIGNATURE = Buffer.alloc(66, 7).toString("base64");

function grantOne(ownerID, locationID, flagID, itemType, quantity, options) {
  const result = itemStore.grantItemsToCharacterLocation(
    ownerID,
    locationID,
    flagID,
    [{ itemType, quantity, options }],
  );
  assert.equal(result.success, true, result.errorMsg);
  return result.data.items[0];
}

function createShip(ownerID = OWNER_ID) {
  return grantOne(ownerID, SOLAR_SYSTEM_ID, 0, SHIP_TYPE_ID, 1, {
    individualItems: true,
    singleton: 1,
  });
}

function createStorageUnit(ownerID = OWNER_ID, assemblyStatus = 2) {
  const unit = grantOne(ownerID, SOLAR_SYSTEM_ID, 0, STORAGE_TYPE_ID, 1, {
    individualItems: true,
    singleton: 1,
  });
  const update = itemStore.updateInventoryItem(unit.itemID, (current) => ({
    ...current,
    customInfo: JSON.stringify({
      evejsFrontierConstruction: {
        assemblyStatus,
        assemblyTypeID: STORAGE_TYPE_ID,
        completedAtMs: 1,
        createdAtMs: 1,
        ownerID,
        solarSystemID: SOLAR_SYSTEM_ID,
      },
    }),
  }));
  assert.equal(update.success, true, update.errorMsg);
  return update.data;
}

function createAccess(ship, overrides = {}) {
  return {
    activeShipID: ship.itemID,
    authorized: true,
    inRange: true,
    solarSystemID: SOLAR_SYSTEM_ID,
    ...overrides,
  };
}

function makeEnvelope(type, payload, characterID = OWNER_ID) {
  return {
    payload: {
      value: Buffer.from(type.encode(type.create(payload)).finish()),
    },
    authoritative_context: {
      identity: { character: { sequential: characterID } },
    },
  };
}

function buildService(access, notices = []) {
  return createAssemblyStorageUnitGatewayService({
    publishGatewayNotice(noticeTypeName, payloadBuffer, targetGroup) {
      notices.push({ noticeTypeName, payloadBuffer, targetGroup });
      return true;
    },
    resolveStorageUnitAccess() {
      return access;
    },
  });
}

function totalAt(ownerID, locationID, flagID, typeID) {
  return itemStore
    .listContainerItems(ownerID, locationID, flagID)
    .filter((item) => Number(item.typeID) === Number(typeID))
    .reduce(
      (total, item) => total + Number(item.stacksize ?? item.quantity ?? 0),
      0,
    );
}

test.beforeEach(() => {
  smartStorageUnitRuntime._testing.clearTransactions();
  smartStorageUnitRuntime._testing.clearStorageComponentCache();
});

test("storageunit proto mirrors nested prepared transaction and destination oneof", () => {
  const types = getStorageUnitProtoTypes();
  const deposit = types.PrepareDepositItemsRequest.decode(
    types.PrepareDepositItemsRequest.encode(
      types.PrepareDepositItemsRequest.create({
        source_container: {
          item: { sequential: 9988400001001 },
          flag: { value: CARGO_FLAG },
        },
        destination_container: { sequential: 9988400002002 },
        stacks: [{ item: { sequential: 9988400003003 }, quantity: 25 }],
      }),
    ).finish(),
  );
  assert.equal(Number(deposit.source_container.item.sequential), 9988400001001);
  assert.equal(Number(deposit.destination_container.sequential), 9988400002002);
  assert.equal(Number(deposit.stacks[0].item.sequential), 9988400003003);
  assert.equal(Number(deposit.stacks[0].quantity), 25);

  const withdraw = types.PrepareWithdrawItemsRequest.decode(
    types.PrepareWithdrawItemsRequest.encode(
      types.PrepareWithdrawItemsRequest.create({
        source_container: { sequential: 9988400002002 },
        generic_location: {
          item: { sequential: 9988400001001 },
          flag: { value: CARGO_FLAG },
        },
        stacks: [{ item_type: { sequential: MATERIAL_TYPE_ID }, quantity: 7 }],
      }),
    ).finish(),
  );
  assert.equal(withdraw.destination_container, "generic_location");
  assert.equal(Number(withdraw.stacks[0].item_type.sequential), MATERIAL_TYPE_ID);

  const response = types.PrepareDepositItemsResponse.decode(
    types.PrepareDepositItemsResponse.encode(
      types.PrepareDepositItemsResponse.create({
        prepared_transaction: { uuid: Buffer.alloc(16, 9) },
        prepared_transaction_attributes: {
          bcs_data_b64_bytes: "{\"version\":2}",
        },
      }),
    ).finish(),
  );
  assert.equal(Buffer.from(response.prepared_transaction.uuid).length, 16);
  assert.equal(
    response.prepared_transaction_attributes.bcs_data_b64_bytes,
    "{\"version\":2}",
  );
});

test("inventory is isolated per character and aggregate rows expose correct capacities", () => {
  const unit = createStorageUnit();
  const ownerShip = createShip();
  const visitorShip = createShip(VISITOR_ID);
  grantOne(OWNER_ID, unit.itemID, STORAGE_FLAG, MATERIAL_TYPE_ID, 10);
  grantOne(OWNER_ID, unit.itemID, STORAGE_FLAG, MATERIAL_TYPE_ID, 15);
  grantOne(VISITOR_ID, unit.itemID, STORAGE_FLAG, MATERIAL_TYPE_ID, 4);

  const owner = smartStorageUnitRuntime.getStorageInventory({
    access: createAccess(ownerShip),
    characterID: OWNER_ID,
    inventoryOwnerID: OWNER_ID,
    storageUnitID: unit.itemID,
  });
  assert.equal(owner.success, true, owner.errorMsg);
  assert.equal(owner.data.capacity, 25000000);
  assert.equal(owner.data.items.length, 1);
  assert.equal(owner.data.items[0].quantity, 25);

  const visitor = smartStorageUnitRuntime.getStorageInventory({
    access: createAccess(visitorShip),
    characterID: VISITOR_ID,
    inventoryOwnerID: VISITOR_ID,
    storageUnitID: unit.itemID,
  });
  assert.equal(visitor.success, true, visitor.errorMsg);
  assert.equal(visitor.data.capacity, 1000000);
  assert.equal(visitor.data.items[0].quantity, 4);

  const spoofed = smartStorageUnitRuntime.getStorageInventory({
    access: createAccess(visitorShip),
    characterID: VISITOR_ID,
    inventoryOwnerID: OWNER_ID,
    storageUnitID: unit.itemID,
  });
  assert.equal(spoofed.errorMsg, "ACCESS_DENIED");
});

test("deposit prepare is non-mutating; execute commits once and survives duplicate retry", () => {
  const unit = createStorageUnit();
  const ship = createShip();
  const stack = grantOne(OWNER_ID, ship.itemID, CARGO_FLAG, MATERIAL_TYPE_ID, 50);
  const access = createAccess(ship);

  const prepared = smartStorageUnitRuntime.prepareStorageDeposit({
    access,
    characterID: OWNER_ID,
    sourceFlagID: CARGO_FLAG,
    sourceLocationID: ship.itemID,
    stacks: [{ itemID: stack.itemID, quantity: 20 }],
    storageUnitID: unit.itemID,
  });
  assert.equal(prepared.success, true, prepared.errorMsg);
  assert.equal(totalAt(OWNER_ID, ship.itemID, CARGO_FLAG, MATERIAL_TYPE_ID), 50);
  assert.equal(totalAt(OWNER_ID, unit.itemID, STORAGE_FLAG, MATERIAL_TYPE_ID), 0);

  const executed = smartStorageUnitRuntime.executeStorageTransaction({
    access,
    action: "storageunit-deposit",
    characterID: OWNER_ID,
    signature: VALID_SIGNATURE,
    transactionUUID: prepared.data.transactionUUID,
  });
  assert.equal(executed.success, true, executed.errorMsg);
  assert.equal(executed.data.noticeItems[0].quantity, 20);
  assert.equal(totalAt(OWNER_ID, ship.itemID, CARGO_FLAG, MATERIAL_TYPE_ID), 30);
  assert.equal(totalAt(OWNER_ID, unit.itemID, STORAGE_FLAG, MATERIAL_TYPE_ID), 20);
  const storedMaterial = itemStore
    .listContainerItems(OWNER_ID, unit.itemID, STORAGE_FLAG)
    .find((item) => Number(item.typeID) === MATERIAL_TYPE_ID);
  assert.ok(storedMaterial);
  assert.equal(
    Object.prototype.hasOwnProperty.call(storedMaterial, "moduleState"),
    false,
    "ordinary stored material must never be treated as an online module",
  );

  const duplicate = smartStorageUnitRuntime.executeStorageTransaction({
    access,
    action: "storageunit-deposit",
    characterID: OWNER_ID,
    signature: VALID_SIGNATURE,
    transactionUUID: prepared.data.transactionUUID,
  });
  assert.equal(duplicate.success, true);
  assert.equal(duplicate.data.replayed, true);
  assert.equal(totalAt(OWNER_ID, ship.itemID, CARGO_FLAG, MATERIAL_TYPE_ID), 30);
  assert.equal(totalAt(OWNER_ID, unit.itemID, STORAGE_FLAG, MATERIAL_TYPE_ID), 20);
});

test("mutations reject offline, out-of-range, singleton, and changed source state", () => {
  const offline = createStorageUnit(OWNER_ID, 1);
  const online = createStorageUnit();
  const ship = createShip();
  const stack = grantOne(OWNER_ID, ship.itemID, CARGO_FLAG, MATERIAL_TYPE_ID, 10);
  const singleton = grantOne(
    OWNER_ID,
    ship.itemID,
    CARGO_FLAG,
    MATERIAL_TYPE_ID,
    1,
    { individualItems: true, singleton: 1 },
  );
  const specialSingleton = grantOne(
    OWNER_ID,
    ship.itemID,
    CARGO_FLAG,
    MATERIAL_TYPE_ID,
    1,
    { individualItems: true, singleton: 2 },
  );

  const base = {
    characterID: OWNER_ID,
    sourceFlagID: CARGO_FLAG,
    sourceLocationID: ship.itemID,
    stacks: [{ itemID: stack.itemID, quantity: 1 }],
  };
  assert.equal(
    smartStorageUnitRuntime.prepareStorageDeposit({
      ...base,
      storageUnitID: online.itemID,
    }).errorMsg,
    "ACCESS_DENIED",
  );
  assert.equal(
    smartStorageUnitRuntime.prepareStorageDeposit({
      ...base,
      access: createAccess(ship),
      storageUnitID: offline.itemID,
    }).errorMsg,
    "ASSEMBLY_OFFLINE",
  );
  assert.equal(
    smartStorageUnitRuntime.prepareStorageDeposit({
      ...base,
      access: createAccess(ship, { inRange: false }),
      storageUnitID: online.itemID,
    }).errorMsg,
    "ASSEMBLY_OUT_OF_RANGE",
  );
  assert.equal(
    smartStorageUnitRuntime.prepareStorageDeposit({
      ...base,
      access: createAccess(ship),
      stacks: [{ itemID: singleton.itemID, quantity: 1 }],
      storageUnitID: online.itemID,
    }).errorMsg,
    "SINGLETON_NOT_ACCEPTED",
  );
  assert.equal(
    smartStorageUnitRuntime.prepareStorageDeposit({
      ...base,
      access: createAccess(ship),
      stacks: [{ itemID: specialSingleton.itemID, quantity: 1 }],
      storageUnitID: online.itemID,
    }).errorMsg,
    "SINGLETON_NOT_ACCEPTED",
  );

  const prepared = smartStorageUnitRuntime.prepareStorageDeposit({
    ...base,
    access: createAccess(ship),
    stacks: [{ itemID: stack.itemID, quantity: 10 }],
    storageUnitID: online.itemID,
  });
  itemStore.moveItemToLocation(stack.itemID, ship.itemID, 4, 10);
  const stale = smartStorageUnitRuntime.executeStorageTransaction({
    access: createAccess(ship),
    action: "storageunit-deposit",
    characterID: OWNER_ID,
    signature: VALID_SIGNATURE,
    transactionUUID: prepared.data.transactionUUID,
  });
  assert.equal(stale.errorMsg, "SOURCE_ITEM_NOT_FOUND");
  assert.equal(totalAt(OWNER_ID, online.itemID, STORAGE_FLAG, MATERIAL_TYPE_ID), 0);
});

test("withdraw rejects fitting flags without losing stored quantities", () => {
  const unit = createStorageUnit();
  const creation = createShip();
  grantOne(OWNER_ID, unit.itemID, STORAGE_FLAG, MATERIAL_TYPE_ID, 1000000);

  const fittingDestination = smartStorageUnitRuntime.prepareStorageWithdraw({
    access: createAccess(creation),
    characterID: OWNER_ID,
    destinationFlagID: 11,
    destinationLocationID: creation.itemID,
    stacks: [{ typeID: MATERIAL_TYPE_ID, quantity: 10 }],
    storageUnitID: unit.itemID,
  });
  assert.equal(fittingDestination.errorMsg, "INVALID_DESTINATION");
  assert.equal(
    totalAt(OWNER_ID, unit.itemID, STORAGE_FLAG, MATERIAL_TYPE_ID),
    1000000,
  );

  assert.equal(
    smartStorageUnitRuntime._testing.getShipCargoCapacity(OWNER_ID, creation),
    288,
    "the default Creation's eight cargo modules each contribute 36 m³",
  );
  const overCapacity = smartStorageUnitRuntime.prepareStorageWithdraw({
    access: createAccess(creation),
    characterID: OWNER_ID,
    destinationFlagID: CARGO_FLAG,
    destinationLocationID: creation.itemID,
    stacks: [{ typeID: MATERIAL_TYPE_ID, quantity: 1000000 }],
    storageUnitID: unit.itemID,
  });
  assert.equal(overCapacity.errorMsg, "SHIP_CARGO_CAPACITY_EXCEEDED");
  assert.equal(
    totalAt(OWNER_ID, unit.itemID, STORAGE_FLAG, MATERIAL_TYPE_ID),
    1000000,
  );

});

test("atomic batch move leaves every source untouched when any staged move fails", () => {
  const ship = createShip();
  const destination = createStorageUnit();
  const first = grantOne(OWNER_ID, ship.itemID, CARGO_FLAG, MATERIAL_TYPE_ID, 5);
  const before = totalAt(OWNER_ID, ship.itemID, CARGO_FLAG, MATERIAL_TYPE_ID);
  const result = itemStore.moveItemsToLocations([
    {
      destinationFlagID: STORAGE_FLAG,
      destinationLocationID: destination.itemID,
      itemID: first.itemID,
      quantity: 2,
    },
    {
      destinationFlagID: STORAGE_FLAG,
      destinationLocationID: destination.itemID,
      itemID: 999999999999,
      quantity: 1,
    },
  ]);
  assert.equal(result.success, false);
  assert.equal(result.errorMsg, "ITEM_NOT_FOUND");
  assert.equal(totalAt(OWNER_ID, ship.itemID, CARGO_FLAG, MATERIAL_TYPE_ID), before);
  assert.equal(totalAt(OWNER_ID, destination.itemID, STORAGE_FLAG, MATERIAL_TYPE_ID), 0);

  for (const quantity of [0, -1, 1.5, Number.NaN]) {
    const malformed = itemStore.moveItemsToLocations([{
      destinationFlagID: STORAGE_FLAG,
      destinationLocationID: destination.itemID,
      itemID: first.itemID,
      quantity,
    }]);
    assert.equal(malformed.errorMsg, "INVALID_MOVE_REQUEST");
  }
  const missingFlag = itemStore.moveItemsToLocations([{
    destinationLocationID: destination.itemID,
    itemID: first.itemID,
    quantity: 1,
  }]);
  assert.equal(missingFlag.errorMsg, "INVALID_MOVE_REQUEST");
  assert.equal(totalAt(OWNER_ID, ship.itemID, CARGO_FLAG, MATERIAL_TYPE_ID), before);
  assert.equal(totalAt(OWNER_ID, destination.itemID, STORAGE_FLAG, MATERIAL_TYPE_ID), 0);
});

test("gateway deposit/withdraw round trip publishes exactly-once character notices", () => {
  const types = getStorageUnitProtoTypes();
  const unit = createStorageUnit();
  const ship = createShip();
  const stack = grantOne(OWNER_ID, ship.itemID, CARGO_FLAG, MATERIAL_TYPE_ID, 40);
  const access = createAccess(ship);
  const notices = [];
  const service = buildService(access, notices);

  const emptyResult = service.handleRequest(
    GET_INVENTORY_REQUEST,
    makeEnvelope(types.GetInventoryRequest, {
      inventory_owner: { sequential: OWNER_ID },
      storage_unit: { sequential: unit.itemID },
    }),
  );
  assert.equal(emptyResult.statusCode, 200, emptyResult.statusMessage);
  assert.equal(
    types.GetInventoryResponse.decode(emptyResult.responsePayloadBuffer).items.length,
    0,
  );

  const prepareResult = service.handleRequest(
    PREPARE_DEPOSIT_ITEMS_REQUEST,
    makeEnvelope(types.PrepareDepositItemsRequest, {
      destination_container: { sequential: unit.itemID },
      source_container: {
        flag: { value: CARGO_FLAG },
        item: { sequential: ship.itemID },
      },
      stacks: [{ item: { sequential: stack.itemID }, quantity: 25 }],
    }),
  );
  assert.equal(prepareResult.statusCode, 200, prepareResult.statusMessage);
  const prepared = types.PrepareDepositItemsResponse.decode(
    prepareResult.responsePayloadBuffer,
  );
  const transactionUUID = uuidBufferToString(
    Buffer.from(prepared.prepared_transaction.uuid),
  );
  assert.ok(transactionUUID);
  assert.match(
    prepared.prepared_transaction_attributes.bcs_data_b64_bytes,
    /"gasData"/u,
  );
  assert.equal(notices.length, 0);

  const executePayload = {
    prepared_transaction: prepared.prepared_transaction,
    signature: VALID_SIGNATURE,
  };
  const execute = service.handleRequest(
    EXECUTE_DEPOSIT_ITEMS_REQUEST,
    makeEnvelope(types.ExecuteDepositItemsRequest, executePayload),
  );
  assert.equal(execute.statusCode, 200, execute.statusMessage);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].noticeTypeName, INVENTORY_ITEM_DEPOSITED_NOTICE);
  assert.deepEqual(notices[0].targetGroup, { character: OWNER_ID });
  const depositNotice = types.InventoryItemDepositedNotice.decode(
    notices[0].payloadBuffer,
  );
  assert.equal(Number(depositNotice.item.attributes.quantity), 25);
  assert.equal(
    Number(depositNotice.item.attributes.identifier.sequential),
    MATERIAL_TYPE_ID,
  );

  const replay = service.handleRequest(
    EXECUTE_DEPOSIT_ITEMS_REQUEST,
    makeEnvelope(types.ExecuteDepositItemsRequest, executePayload),
  );
  assert.equal(replay.statusCode, 200);
  assert.equal(notices.length, 1, "retry must not publish a second notice");

  const inventoryResult = service.handleRequest(
    GET_INVENTORY_REQUEST,
    makeEnvelope(types.GetInventoryRequest, {
      inventory_owner: { sequential: OWNER_ID },
      storage_unit: { sequential: unit.itemID },
    }),
  );
  const inventory = types.GetInventoryResponse.decode(
    inventoryResult.responsePayloadBuffer,
  );
  assert.equal(inventory.items.length, 1);
  assert.equal(Number(inventory.items[0].attributes.quantity), 25);

  const withdrawPrepareResult = service.handleRequest(
    PREPARE_WITHDRAW_ITEMS_REQUEST,
    makeEnvelope(types.PrepareWithdrawItemsRequest, {
      generic_location: {
        flag: { value: CARGO_FLAG },
        item: { sequential: ship.itemID },
      },
      source_container: { sequential: unit.itemID },
      stacks: [{ item_type: { sequential: MATERIAL_TYPE_ID }, quantity: 10 }],
    }),
  );
  assert.equal(
    withdrawPrepareResult.statusCode,
    200,
    withdrawPrepareResult.statusMessage,
  );
  const withdrawPrepared = types.PrepareWithdrawItemsResponse.decode(
    withdrawPrepareResult.responsePayloadBuffer,
  );
  const withdrawExecute = service.handleRequest(
    EXECUTE_WITHDRAW_ITEMS_REQUEST,
    makeEnvelope(types.ExecuteWithdrawItemsRequest, {
      prepared_transaction: withdrawPrepared.prepared_transaction,
      signature: VALID_SIGNATURE,
    }),
  );
  assert.equal(withdrawExecute.statusCode, 200, withdrawExecute.statusMessage);
  assert.equal(notices.length, 2);
  assert.equal(notices[1].noticeTypeName, INVENTORY_ITEM_WITHDRAWN_NOTICE);
  const withdrawNotice = types.InventoryItemWithdrawnNotice.decode(
    notices[1].payloadBuffer,
  );
  assert.equal(Number(withdrawNotice.item.attributes.quantity), 10);
  assert.equal(totalAt(OWNER_ID, unit.itemID, STORAGE_FLAG, MATERIAL_TYPE_ID), 15);
  assert.equal(totalAt(OWNER_ID, ship.itemID, CARGO_FLAG, MATERIAL_TYPE_ID), 25);
  for (const material of [
    ...itemStore.listContainerItems(OWNER_ID, unit.itemID, STORAGE_FLAG),
    ...itemStore.listContainerItems(OWNER_ID, ship.itemID, CARGO_FLAG),
  ].filter((item) => Number(item.typeID) === MATERIAL_TYPE_ID)) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(material, "moduleState"),
      false,
      "ordinary material must remain free of module state after a round trip",
    );
  }
});

test("gateway rejects unauthenticated, spoofed owner, invalid signature, and stale UUID", () => {
  const types = getStorageUnitProtoTypes();
  const unit = createStorageUnit();
  const ship = createShip();
  const stack = grantOne(OWNER_ID, ship.itemID, CARGO_FLAG, MATERIAL_TYPE_ID, 5);
  const service = buildService(createAccess(ship));

  const unauthenticated = service.handleRequest(GET_INVENTORY_REQUEST, {
    authoritative_context: {},
    payload: {
      value: Buffer.from(types.GetInventoryRequest.encode(
        types.GetInventoryRequest.create({
          inventory_owner: { sequential: OWNER_ID },
          storage_unit: { sequential: unit.itemID },
        }),
      ).finish()),
    },
  });
  assert.equal(unauthenticated.statusCode, 403);

  const spoofed = service.handleRequest(
    GET_INVENTORY_REQUEST,
    makeEnvelope(types.GetInventoryRequest, {
      inventory_owner: { sequential: VISITOR_ID },
      storage_unit: { sequential: unit.itemID },
    }),
  );
  assert.equal(spoofed.statusCode, 403);

  const prepare = service.handleRequest(
    PREPARE_DEPOSIT_ITEMS_REQUEST,
    makeEnvelope(types.PrepareDepositItemsRequest, {
      destination_container: { sequential: unit.itemID },
      source_container: {
        flag: { value: CARGO_FLAG },
        item: { sequential: ship.itemID },
      },
      stacks: [{ item: { sequential: stack.itemID }, quantity: 1 }],
    }),
  );
  const prepared = types.PrepareDepositItemsResponse.decode(
    prepare.responsePayloadBuffer,
  );
  const badSignature = service.handleRequest(
    EXECUTE_DEPOSIT_ITEMS_REQUEST,
    makeEnvelope(types.ExecuteDepositItemsRequest, {
      prepared_transaction: prepared.prepared_transaction,
      signature: "not-a-signature",
    }),
  );
  assert.equal(badSignature.statusCode, 403);
  assert.equal(totalAt(OWNER_ID, unit.itemID, STORAGE_FLAG, MATERIAL_TYPE_ID), 0);

  const stale = service.handleRequest(
    EXECUTE_DEPOSIT_ITEMS_REQUEST,
    makeEnvelope(types.ExecuteDepositItemsRequest, {
      prepared_transaction: { uuid: Buffer.alloc(16, 2) },
      signature: VALID_SIGNATURE,
    }),
  );
  assert.equal(stale.statusCode, 404);
});
