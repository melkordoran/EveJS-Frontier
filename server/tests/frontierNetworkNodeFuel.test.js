"use strict";

/**
 * Network Node (88092) fuel service coverage: protobuf round trips, the
 * prepare/execute transaction model, persistence in the node's customInfo,
 * and the gateway service surface including FuelChangedNotice publication.
 * Run through: npm run test:frontier-server (isolated runner).
 */

const assert = require("node:assert/strict");
const test = require("node:test");

const itemStore = require("../src/services/inventory/itemStore");
const networkNodeFuelRuntime = require("../src/services/frontier/networkNodeFuelRuntime");
const {
  getNetworkNodeProtoTypes,
} = require("../src/_secondary/express/gatewayServices/assemblyNetworkNodeProto");
const {
  EXECUTE_DEPOSIT_FUEL_REQUEST,
  EXECUTE_WITHDRAW_FUEL_REQUEST,
  FUEL_CHANGED_NOTICE,
  GET_FUEL_CONFIG_REQUEST,
  GET_FUEL_REQUEST,
  PREPARE_DEPOSIT_FUEL_REQUEST,
  PREPARE_WITHDRAW_FUEL_REQUEST,
  createAssemblyNetworkNodeGatewayService,
} = require("../src/_secondary/express/gatewayServices/assemblyNetworkNodeGatewayService");
const {
  uuidBufferToString,
  uuidStringToBuffer,
} = require("../src/_secondary/express/gatewayServices/gatewayServiceHelpers");

const OWNER_ID = 140000003;
const OTHER_OWNER_ID = 140000002;
const SOLAR_SYSTEM_ID = 30000004;
const NODE_TYPE_ID = 88092;
const FUEL_UNSTABLE = 77818;
const FUEL_D1 = 88335;
const NON_FUEL_TYPE = 95324; // Creation Fuel Bay module — not a loose fuel
const CARGO_FLAG = 5;

const VALID_SIGNATURE = Buffer.alloc(66, 7).toString("base64"); // 88 chars

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

function createTestNetworkNode(ownerID = OWNER_ID, assemblyStatus = 2) {
  const node = grantOne(ownerID, SOLAR_SYSTEM_ID, 0, NODE_TYPE_ID, 1, {
    individualItems: true,
    singleton: 1,
  });
  const update = itemStore.updateInventoryItem(node.itemID, (currentItem) => ({
    ...currentItem,
    customInfo: JSON.stringify({
      evejsFrontierConstruction: {
        assemblyStatus,
        assemblyTypeID: NODE_TYPE_ID,
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

function createFuelSource(ownerID = OWNER_ID, fuelTypeID = FUEL_UNSTABLE, quantity = 1500) {
  const container = grantOne(ownerID, SOLAR_SYSTEM_ID, 0, 95276, 1, {
    individualItems: true,
    singleton: 1,
  });
  const stack = grantOne(ownerID, container.itemID, CARGO_FLAG, fuelTypeID, quantity);
  return { container, stack };
}

function stackQuantity(itemID) {
  const item = itemStore.findItemById(itemID);
  if (!item) {
    return 0;
  }
  return Number(item.stacksize ?? item.quantity) || 0;
}

function makeEnvelope(type, payload, characterID = OWNER_ID) {
  const types = getNetworkNodeProtoTypes();
  const encoded = payload === null
    ? Buffer.alloc(0)
    : Buffer.from(type.encode(type.create(payload)).finish());
  return {
    payload: { value: encoded },
    authoritative_context: {
      identity: { character: { sequential: characterID } },
    },
  };
}

function buildService(noticeSink = null) {
  return createAssemblyNetworkNodeGatewayService({
    publishGatewayNotice(noticeTypeName, payloadBuffer, targetGroup) {
      if (noticeSink) {
        noticeSink.push({ noticeTypeName, payloadBuffer, targetGroup });
      }
      return true;
    },
  });
}

test.beforeEach(() => {
  networkNodeFuelRuntime._testing.clearPendingFuelTransactions();
});

test("networknode proto: request/response round trips", () => {
  const types = getNetworkNodeProtoTypes();
  const prepare = types.PrepareDepositFuelRequest;
  const encoded = prepare.encode(prepare.create({
    network_node: { sequential: 9988400000999 },
    source: { item: { sequential: 12345 }, flag: { value: 5 } },
    items: [{ id: { sequential: 777 }, quantity: 100 }],
  })).finish();
  const decoded = prepare.decode(encoded);
  assert.equal(Number(decoded.network_node.sequential), 9988400000999);
  assert.equal(Number(decoded.source.item.sequential), 12345);
  assert.equal(Number(decoded.source.flag.value), 5);
  assert.equal(decoded.items.length, 1);
  assert.equal(Number(decoded.items[0].id.sequential), 777);
  assert.equal(decoded.items[0].quantity, 100);

  const config = types.GetFuelConfigResponse;
  const configRoundTrip = config.decode(config.encode(config.create({
    fuels: [{ fuel_type: { sequential: FUEL_UNSTABLE }, efficiency: 8 }],
  })).finish());
  assert.equal(Number(configRoundTrip.fuels[0].fuel_type.sequential), FUEL_UNSTABLE);
  assert.equal(Number(configRoundTrip.fuels[0].efficiency), 8);

  const notice = types.FuelChangedNotice;
  const noticeRoundTrip = notice.decode(notice.encode(notice.create({
    network_node: { sequential: 42 },
    fuel: { identifier: { sequential: FUEL_UNSTABLE }, quantity: 250, volume: 70 },
  })).finish());
  assert.equal(Number(noticeRoundTrip.network_node.sequential), 42);
  assert.equal(noticeRoundTrip.fuel.quantity, 250);

  const uuid = "0f8fad5b-d9cb-469f-a165-70867728950e";
  assert.equal(uuidBufferToString(uuidStringToBuffer(uuid)), uuid);
});

test("fuel config policy serves the three published fuels", () => {
  const config = networkNodeFuelRuntime.getNetworkNodeFuelConfig();
  assert.deepEqual(config, [
    { typeID: 77818, efficiency: 8 },
    { typeID: 88319, efficiency: 15 },
    { typeID: 88335, efficiency: 10 },
  ]);
  const attributes = networkNodeFuelRuntime.getNetworkNodeFuelAttributes();
  assert.equal(attributes.fuelMaxCapacityVolume, 1000);
  assert.equal(attributes.fuelBurnRateInSeconds, 3000);
});

test("get fuel: empty node reads zero, errors are typed", () => {
  const node = createTestNetworkNode();
  const empty = networkNodeFuelRuntime.getNetworkNodeFuelStatus(OWNER_ID, node.itemID);
  assert.equal(empty.success, true);
  assert.equal(empty.data.typeID, 0);
  assert.equal(empty.data.quantity, 0);

  assert.equal(
    networkNodeFuelRuntime.getNetworkNodeFuelStatus(OTHER_OWNER_ID, node.itemID).errorMsg,
    "ASSEMBLY_NOT_OWNED",
  );
  assert.equal(
    networkNodeFuelRuntime.getNetworkNodeFuelStatus(OWNER_ID, 424242).errorMsg,
    "ASSEMBLY_NOT_FOUND",
  );
});

test("deposit prepare validates without mutating", () => {
  const node = createTestNetworkNode();
  const { container, stack } = createFuelSource();
  const before = stackQuantity(stack.itemID);

  const prepared = networkNodeFuelRuntime.prepareNetworkNodeFuelDeposit({
    characterID: OWNER_ID,
    networkNodeID: node.itemID,
    sourceItemID: container.itemID,
    sourceFlagID: CARGO_FLAG,
    items: [{ itemID: stack.itemID, quantity: 1000 }],
  });
  assert.equal(prepared.success, true, prepared.errorMsg);
  assert.ok(prepared.data.transactionUUID.length >= 36);
  assert.ok(prepared.data.transactionData.includes("gasData"));

  assert.equal(stackQuantity(stack.itemID), before, "prepare must not mutate");
  assert.equal(
    networkNodeFuelRuntime.readNetworkNodeFuelState(
      itemStore.findItemById(node.itemID),
    ).quantity,
    0,
  );
});

test("deposit execute commits once, persists, and suppresses duplicates", () => {
  const node = createTestNetworkNode();
  const { container, stack } = createFuelSource();

  const prepared = networkNodeFuelRuntime.prepareNetworkNodeFuelDeposit({
    characterID: OWNER_ID,
    networkNodeID: node.itemID,
    sourceItemID: container.itemID,
    sourceFlagID: CARGO_FLAG,
    items: [{ itemID: stack.itemID, quantity: 1000 }],
  });
  assert.equal(prepared.success, true);

  const executed = networkNodeFuelRuntime.executeNetworkNodeFuelTransaction({
    action: "networknode-fuel-deposit",
    characterID: OWNER_ID,
    transactionUUID: prepared.data.transactionUUID,
    signature: VALID_SIGNATURE,
  });
  assert.equal(executed.success, true, executed.errorMsg);
  assert.equal(executed.data.quantity, 1000);
  assert.equal(executed.data.depositedQuantity, 1000);
  assert.equal(executed.data.solarSystemID, SOLAR_SYSTEM_ID);
  assert.equal(stackQuantity(stack.itemID), 500, "exactly one source deduction");

  const persistedNode = itemStore.findItemById(node.itemID);
  const fuelState = networkNodeFuelRuntime.readNetworkNodeFuelState(persistedNode);
  assert.equal(fuelState.typeID, FUEL_UNSTABLE);
  assert.equal(fuelState.quantity, 1000);
  assert.ok(fuelState.updatedAtMs > 0);
  const customInfo = JSON.parse(persistedNode.customInfo);
  assert.equal(
    customInfo.evejsFrontierConstruction.assemblyStatus,
    2,
    "construction state preserved alongside fuel state",
  );

  const duplicate = networkNodeFuelRuntime.executeNetworkNodeFuelTransaction({
    action: "networknode-fuel-deposit",
    characterID: OWNER_ID,
    transactionUUID: prepared.data.transactionUUID,
    signature: VALID_SIGNATURE,
  });
  assert.equal(duplicate.success, false);
  assert.equal(duplicate.errorMsg, "TRANSACTION_NOT_FOUND");
  assert.equal(stackQuantity(stack.itemID), 500, "duplicate must not deduct");
});

test("execute rejects bad signatures, expiry, and mismatches", () => {
  const node = createTestNetworkNode();
  const { container, stack } = createFuelSource();
  const prepare = () => networkNodeFuelRuntime.prepareNetworkNodeFuelDeposit({
    characterID: OWNER_ID,
    networkNodeID: node.itemID,
    sourceItemID: container.itemID,
    sourceFlagID: CARGO_FLAG,
    items: [{ itemID: stack.itemID, quantity: 100 }],
  });

  const badSignature = prepare();
  const rejected = networkNodeFuelRuntime.executeNetworkNodeFuelTransaction({
    action: "networknode-fuel-deposit",
    characterID: OWNER_ID,
    transactionUUID: badSignature.data.transactionUUID,
    signature: "not-base64!!",
  });
  assert.equal(rejected.errorMsg, "INVALID_SIGNATURE");

  const wrongChar = networkNodeFuelRuntime.executeNetworkNodeFuelTransaction({
    action: "networknode-fuel-deposit",
    characterID: OTHER_OWNER_ID,
    transactionUUID: badSignature.data.transactionUUID,
    signature: VALID_SIGNATURE,
  });
  assert.equal(wrongChar.errorMsg, "TRANSACTION_MISMATCH");

  const wrongAction = networkNodeFuelRuntime.executeNetworkNodeFuelTransaction({
    action: "networknode-fuel-withdraw",
    characterID: OWNER_ID,
    transactionUUID: badSignature.data.transactionUUID,
    signature: VALID_SIGNATURE,
  });
  assert.equal(wrongAction.errorMsg, "TRANSACTION_MISMATCH");

  const expired = prepare();
  const pending = networkNodeFuelRuntime._testing.getPendingFuelTransactions();
  pending.get(expired.data.transactionUUID).expiresAtMs = Date.now() - 1;
  const expiredResult = networkNodeFuelRuntime.executeNetworkNodeFuelTransaction({
    action: "networknode-fuel-deposit",
    characterID: OWNER_ID,
    transactionUUID: expired.data.transactionUUID,
    signature: VALID_SIGNATURE,
  });
  assert.equal(expiredResult.errorMsg, "TRANSACTION_NOT_FOUND");
  assert.equal(stackQuantity(stack.itemID), 1500, "no rejection may deduct fuel");
});

test("deposit validation failures are typed and non-destructive", () => {
  const node = createTestNetworkNode();
  const { container, stack } = createFuelSource();

  const wrongOwnerNode = createTestNetworkNode(OTHER_OWNER_ID);
  assert.equal(
    networkNodeFuelRuntime.prepareNetworkNodeFuelDeposit({
      characterID: OWNER_ID,
      networkNodeID: wrongOwnerNode.itemID,
      sourceItemID: container.itemID,
      sourceFlagID: CARGO_FLAG,
      items: [{ itemID: stack.itemID, quantity: 10 }],
    }).errorMsg,
    "ASSEMBLY_NOT_OWNED",
  );

  const notANode = grantOne(OWNER_ID, SOLAR_SYSTEM_ID, 0, 95276, 1, {
    individualItems: true,
    singleton: 1,
  });
  assert.equal(
    networkNodeFuelRuntime.prepareNetworkNodeFuelDeposit({
      characterID: OWNER_ID,
      networkNodeID: notANode.itemID,
      sourceItemID: container.itemID,
      sourceFlagID: CARGO_FLAG,
      items: [{ itemID: stack.itemID, quantity: 10 }],
    }).errorMsg,
    "ASSEMBLY_NOT_FOUND",
  );

  const underConstruction = createTestNetworkNode(OWNER_ID, 5);
  assert.equal(
    networkNodeFuelRuntime.prepareNetworkNodeFuelDeposit({
      characterID: OWNER_ID,
      networkNodeID: underConstruction.itemID,
      sourceItemID: container.itemID,
      sourceFlagID: CARGO_FLAG,
      items: [{ itemID: stack.itemID, quantity: 10 }],
    }).errorMsg,
    "ASSEMBLY_UNDER_CONSTRUCTION",
  );

  for (const quantity of [0, -5]) {
    assert.equal(
      networkNodeFuelRuntime.prepareNetworkNodeFuelDeposit({
        characterID: OWNER_ID,
        networkNodeID: node.itemID,
        sourceItemID: container.itemID,
        sourceFlagID: CARGO_FLAG,
        items: [{ itemID: stack.itemID, quantity }],
      }).errorMsg,
      "INVALID_QUANTITY",
      `quantity=${quantity}`,
    );
  }

  assert.equal(
    networkNodeFuelRuntime.prepareNetworkNodeFuelDeposit({
      characterID: OWNER_ID,
      networkNodeID: node.itemID,
      sourceItemID: container.itemID,
      sourceFlagID: CARGO_FLAG,
      items: [{ itemID: stack.itemID, quantity: 5000 }],
    }).errorMsg,
    "INSUFFICIENT_SOURCE_FUEL",
  );

  const nonFuel = grantOne(OWNER_ID, container.itemID, CARGO_FLAG, NON_FUEL_TYPE, 10);
  assert.equal(
    networkNodeFuelRuntime.prepareNetworkNodeFuelDeposit({
      characterID: OWNER_ID,
      networkNodeID: node.itemID,
      sourceItemID: container.itemID,
      sourceFlagID: CARGO_FLAG,
      items: [{ itemID: nonFuel.itemID, quantity: 10 }],
    }).errorMsg,
    "UNSUPPORTED_FUEL_TYPE",
  );

  const foreignStack = createFuelSource(OTHER_OWNER_ID);
  assert.equal(
    networkNodeFuelRuntime.prepareNetworkNodeFuelDeposit({
      characterID: OWNER_ID,
      networkNodeID: node.itemID,
      sourceItemID: foreignStack.container.itemID,
      sourceFlagID: CARGO_FLAG,
      items: [{ itemID: foreignStack.stack.itemID, quantity: 10 }],
    }).errorMsg,
    "SOURCE_ITEM_NOT_FOUND",
  );
});

test("deposit enforces the volume-budget capacity and single fuel type", () => {
  const node = createTestNetworkNode();
  const { container, stack } = createFuelSource(OWNER_ID, FUEL_UNSTABLE, 4000);

  // 1000 m3 / 0.28 m3 per unit = 3571 units maximum.
  const overflow = networkNodeFuelRuntime.prepareNetworkNodeFuelDeposit({
    characterID: OWNER_ID,
    networkNodeID: node.itemID,
    sourceItemID: container.itemID,
    sourceFlagID: CARGO_FLAG,
    items: [{ itemID: stack.itemID, quantity: 3600 }],
  });
  assert.equal(overflow.errorMsg, "FUEL_CAPACITY_EXCEEDED");
  assert.equal(overflow.params.remainingUnits, 3571);

  const fit = networkNodeFuelRuntime.prepareNetworkNodeFuelDeposit({
    characterID: OWNER_ID,
    networkNodeID: node.itemID,
    sourceItemID: container.itemID,
    sourceFlagID: CARGO_FLAG,
    items: [{ itemID: stack.itemID, quantity: 3571 }],
  });
  assert.equal(fit.success, true, fit.errorMsg);
  const executed = networkNodeFuelRuntime.executeNetworkNodeFuelTransaction({
    action: "networknode-fuel-deposit",
    characterID: OWNER_ID,
    transactionUUID: fit.data.transactionUUID,
    signature: VALID_SIGNATURE,
  });
  assert.equal(executed.success, true, executed.errorMsg);

  // Any further unit no longer fits...
  const oneMore = networkNodeFuelRuntime.prepareNetworkNodeFuelDeposit({
    characterID: OWNER_ID,
    networkNodeID: node.itemID,
    sourceItemID: container.itemID,
    sourceFlagID: CARGO_FLAG,
    items: [{ itemID: stack.itemID, quantity: 1 }],
  });
  assert.equal(oneMore.errorMsg, "FUEL_CAPACITY_EXCEEDED");

  // ...and a different accepted fuel type is refused while fuel is stored.
  const d1 = grantOne(OWNER_ID, container.itemID, CARGO_FLAG, FUEL_D1, 100);
  assert.equal(
    networkNodeFuelRuntime.prepareNetworkNodeFuelDeposit({
      characterID: OWNER_ID,
      networkNodeID: node.itemID,
      sourceItemID: container.itemID,
      sourceFlagID: CARGO_FLAG,
      items: [{ itemID: d1.itemID, quantity: 100 }],
    }).errorMsg,
    "MIXED_FUEL_TYPES",
  );
});

test("mid-drain failure restores already-consumed source stacks", () => {
  const node = createTestNetworkNode();
  const { container, stack } = createFuelSource(OWNER_ID, FUEL_UNSTABLE, 1000);

  const prepared = networkNodeFuelRuntime.prepareNetworkNodeFuelDeposit({
    characterID: OWNER_ID,
    networkNodeID: node.itemID,
    sourceItemID: container.itemID,
    sourceFlagID: CARGO_FLAG,
    items: [{ itemID: stack.itemID, quantity: 400 }],
  });
  assert.equal(prepared.success, true, prepared.errorMsg);

  // Let the source drain succeed, then fail the node-state write so the
  // compensation path has consumed stacks to restore.
  const realUpdate = itemStore.updateInventoryItem;
  itemStore.updateInventoryItem = (itemID, updater) => {
    if (Number(itemID) === Number(node.itemID)) {
      return { success: false, errorMsg: "WRITE_ERROR" };
    }
    return realUpdate(itemID, updater);
  };
  let executed;
  try {
    executed = networkNodeFuelRuntime.executeNetworkNodeFuelTransaction({
      action: "networknode-fuel-deposit",
      characterID: OWNER_ID,
      transactionUUID: prepared.data.transactionUUID,
      signature: VALID_SIGNATURE,
    });
  } finally {
    itemStore.updateInventoryItem = realUpdate;
  }
  assert.equal(executed.success, false);
  assert.equal(
    networkNodeFuelRuntime.readNetworkNodeFuelState(
      itemStore.findItemById(node.itemID),
    ).quantity,
    0,
    "failed commit must not store fuel",
  );
  const totalUnstableInContainer = itemStore
    .listContainerItems(OWNER_ID, container.itemID, CARGO_FLAG)
    .filter((item) => Number(item.typeID) === FUEL_UNSTABLE)
    .reduce(
      (total, item) => total + (Number(item.stacksize ?? item.quantity) || 0),
      0,
    );
  assert.equal(
    totalUnstableInContainer,
    1000,
    "all consumed units must be restored to the source container",
  );
});

test("withdraw succeeds, validates, and restores on grant failure", () => {
  const node = createTestNetworkNode();
  const { container, stack } = createFuelSource();
  const prepared = networkNodeFuelRuntime.prepareNetworkNodeFuelDeposit({
    characterID: OWNER_ID,
    networkNodeID: node.itemID,
    sourceItemID: container.itemID,
    sourceFlagID: CARGO_FLAG,
    items: [{ itemID: stack.itemID, quantity: 1000 }],
  });
  networkNodeFuelRuntime.executeNetworkNodeFuelTransaction({
    action: "networknode-fuel-deposit",
    characterID: OWNER_ID,
    transactionUUID: prepared.data.transactionUUID,
    signature: VALID_SIGNATURE,
  });

  assert.equal(
    networkNodeFuelRuntime.prepareNetworkNodeFuelWithdraw({
      characterID: OWNER_ID,
      networkNodeID: node.itemID,
      fuelTypeID: FUEL_D1,
      quantity: 100,
      destinationItemID: container.itemID,
      destinationFlagID: CARGO_FLAG,
    }).errorMsg,
    "UNSUPPORTED_FUEL_TYPE",
  );
  assert.equal(
    networkNodeFuelRuntime.prepareNetworkNodeFuelWithdraw({
      characterID: OWNER_ID,
      networkNodeID: node.itemID,
      fuelTypeID: FUEL_UNSTABLE,
      quantity: 2000,
      destinationItemID: container.itemID,
      destinationFlagID: CARGO_FLAG,
    }).errorMsg,
    "INSUFFICIENT_STORED_FUEL",
  );
  assert.equal(
    networkNodeFuelRuntime.prepareNetworkNodeFuelWithdraw({
      characterID: OWNER_ID,
      networkNodeID: node.itemID,
      fuelTypeID: FUEL_UNSTABLE,
      quantity: 100,
      destinationItemID: 909090,
      destinationFlagID: CARGO_FLAG,
    }).errorMsg,
    "INVALID_DESTINATION",
  );

  const withdrawPrepared = networkNodeFuelRuntime.prepareNetworkNodeFuelWithdraw({
    characterID: OWNER_ID,
    networkNodeID: node.itemID,
    fuelTypeID: FUEL_UNSTABLE,
    quantity: 400,
    destinationItemID: container.itemID,
    destinationFlagID: CARGO_FLAG,
  });
  assert.equal(withdrawPrepared.success, true, withdrawPrepared.errorMsg);
  const withdrawn = networkNodeFuelRuntime.executeNetworkNodeFuelTransaction({
    action: "networknode-fuel-withdraw",
    characterID: OWNER_ID,
    transactionUUID: withdrawPrepared.data.transactionUUID,
    signature: VALID_SIGNATURE,
  });
  assert.equal(withdrawn.success, true, withdrawn.errorMsg);
  assert.equal(withdrawn.data.quantity, 600);
  assert.equal(withdrawn.data.withdrawnQuantity, 400);
  assert.equal(
    networkNodeFuelRuntime.readNetworkNodeFuelState(
      itemStore.findItemById(node.itemID),
    ).quantity,
    600,
  );
  const destinationTotal = itemStore
    .listContainerItems(OWNER_ID, container.itemID, CARGO_FLAG)
    .filter((item) => Number(item.typeID) === FUEL_UNSTABLE)
    .reduce((total, item) => total + (Number(item.stacksize) || 0), 0);
  assert.equal(destinationTotal, 900, "500 leftover + 400 withdrawn");

  // Grant failure rolls the node quantity back.
  const rollbackPrepared = networkNodeFuelRuntime.prepareNetworkNodeFuelWithdraw({
    characterID: OWNER_ID,
    networkNodeID: node.itemID,
    fuelTypeID: FUEL_UNSTABLE,
    quantity: 100,
    destinationItemID: container.itemID,
    destinationFlagID: CARGO_FLAG,
  });
  const realGrant = itemStore.grantItemsToCharacterLocation;
  itemStore.grantItemsToCharacterLocation = () => ({
    success: false,
    errorMsg: "WRITE_ERROR",
  });
  let rollbackResult;
  try {
    rollbackResult = networkNodeFuelRuntime.executeNetworkNodeFuelTransaction({
      action: "networknode-fuel-withdraw",
      characterID: OWNER_ID,
      transactionUUID: rollbackPrepared.data.transactionUUID,
      signature: VALID_SIGNATURE,
    });
  } finally {
    itemStore.grantItemsToCharacterLocation = realGrant;
  }
  assert.equal(rollbackResult.success, false);
  assert.equal(
    networkNodeFuelRuntime.readNetworkNodeFuelState(
      itemStore.findItemById(node.itemID),
    ).quantity,
    600,
    "failed withdraw must restore the stored quantity",
  );
});

test("gateway service: config, get, deposit round trip with one notice", () => {
  const types = getNetworkNodeProtoTypes();
  const notices = [];
  const service = buildService(notices);
  const node = createTestNetworkNode();
  const { container, stack } = createFuelSource();

  const configResult = service.handleRequest(
    GET_FUEL_CONFIG_REQUEST,
    makeEnvelope(types.GetFuelConfigRequest, {}),
  );
  assert.equal(configResult.statusCode, 200);
  const configDecoded = types.GetFuelConfigResponse.decode(
    configResult.responsePayloadBuffer,
  );
  assert.equal(configDecoded.fuels.length, 3);
  assert.equal(Number(configDecoded.fuels[0].fuel_type.sequential), FUEL_UNSTABLE);
  assert.equal(Number(configDecoded.fuels[0].efficiency), 8);

  const emptyFuel = service.handleRequest(
    GET_FUEL_REQUEST,
    makeEnvelope(types.GetFuelRequest, {
      network_node: { sequential: node.itemID },
    }),
  );
  assert.equal(emptyFuel.statusCode, 200);
  const emptyDecoded = types.GetFuelResponse.decode(emptyFuel.responsePayloadBuffer);
  assert.equal(Number(emptyDecoded.fuel.quantity), 0);

  const prepareResult = service.handleRequest(
    PREPARE_DEPOSIT_FUEL_REQUEST,
    makeEnvelope(types.PrepareDepositFuelRequest, {
      network_node: { sequential: node.itemID },
      source: { item: { sequential: container.itemID }, flag: { value: CARGO_FLAG } },
      items: [{ id: { sequential: stack.itemID }, quantity: 1000 }],
    }),
  );
  assert.equal(prepareResult.statusCode, 200, prepareResult.statusMessage);
  const prepareDecoded = types.PrepareDepositFuelResponse.decode(
    prepareResult.responsePayloadBuffer,
  );
  const transactionUUID = uuidBufferToString(
    Buffer.from(prepareDecoded.prepared_transaction_uuid),
  );
  assert.ok(transactionUUID, "prepare must return a uuid");
  assert.ok(
    Buffer.from(prepareDecoded.prepared_transaction_bcs_data).toString("utf8")
      .includes("gasData"),
  );
  assert.equal(notices.length, 0, "prepare must not publish a notice");

  const executeResult = service.handleRequest(
    EXECUTE_DEPOSIT_FUEL_REQUEST,
    makeEnvelope(types.ExecuteDepositFuelRequest, {
      prepared_transaction_uuid: prepareDecoded.prepared_transaction_uuid,
      signature: VALID_SIGNATURE,
    }),
  );
  assert.equal(executeResult.statusCode, 200, executeResult.statusMessage);
  assert.equal(notices.length, 1, "exactly one FuelChangedNotice per commit");
  assert.equal(notices[0].noticeTypeName, FUEL_CHANGED_NOTICE);
  assert.deepEqual(notices[0].targetGroup, { solar_system: SOLAR_SYSTEM_ID });
  const noticeDecoded = types.FuelChangedNotice.decode(notices[0].payloadBuffer);
  assert.equal(Number(noticeDecoded.network_node.sequential), node.itemID);
  assert.equal(Number(noticeDecoded.fuel.identifier.sequential), FUEL_UNSTABLE);
  assert.equal(Number(noticeDecoded.fuel.quantity), 1000);

  const fuelResult = service.handleRequest(
    GET_FUEL_REQUEST,
    makeEnvelope(types.GetFuelRequest, {
      network_node: { sequential: node.itemID },
    }),
  );
  const fuelDecoded = types.GetFuelResponse.decode(fuelResult.responsePayloadBuffer);
  assert.equal(Number(fuelDecoded.fuel.identifier.sequential), FUEL_UNSTABLE);
  assert.equal(Number(fuelDecoded.fuel.quantity), 1000);

  const withdrawPrepare = service.handleRequest(
    PREPARE_WITHDRAW_FUEL_REQUEST,
    makeEnvelope(types.PrepareWithdrawFuelRequest, {
      network_node: { sequential: node.itemID },
      fuel_type: { sequential: FUEL_UNSTABLE },
      quantity: 250,
      destination: {
        item: { sequential: container.itemID },
        flag: { value: CARGO_FLAG },
      },
    }),
  );
  assert.equal(withdrawPrepare.statusCode, 200, withdrawPrepare.statusMessage);
  const withdrawDecoded = types.PrepareWithdrawFuelResponse.decode(
    withdrawPrepare.responsePayloadBuffer,
  );
  const withdrawExecute = service.handleRequest(
    EXECUTE_WITHDRAW_FUEL_REQUEST,
    makeEnvelope(types.ExecuteWithdrawFuelRequest, {
      prepared_transaction_uuid: withdrawDecoded.prepared_transaction_uuid,
      signature: VALID_SIGNATURE,
    }),
  );
  assert.equal(withdrawExecute.statusCode, 200, withdrawExecute.statusMessage);
  assert.equal(notices.length, 2);
  assert.equal(
    Number(types.FuelChangedNotice.decode(notices[1].payloadBuffer).fuel.quantity),
    750,
  );
});

test("gateway service: unauthenticated and error mappings", () => {
  const types = getNetworkNodeProtoTypes();
  const service = buildService();
  const node = createTestNetworkNode();

  const noAuth = service.handleRequest(GET_FUEL_REQUEST, {
    payload: {
      value: Buffer.from(
        types.GetFuelRequest.encode(
          types.GetFuelRequest.create({
            network_node: { sequential: node.itemID },
          }),
        ).finish(),
      ),
    },
    authoritative_context: {},
  });
  assert.equal(noAuth.statusCode, 403);

  const missingNode = service.handleRequest(
    GET_FUEL_REQUEST,
    makeEnvelope(types.GetFuelRequest, {
      network_node: { sequential: 987654 },
    }),
  );
  assert.equal(missingNode.statusCode, 404);
  assert.match(missingNode.statusMessage, /no longer exists/u);

  const staleExecute = service.handleRequest(
    EXECUTE_DEPOSIT_FUEL_REQUEST,
    makeEnvelope(types.ExecuteDepositFuelRequest, {
      prepared_transaction_uuid: uuidStringToBuffer(
        "0f8fad5b-d9cb-469f-a165-70867728950e",
      ),
      signature: VALID_SIGNATURE,
    }),
  );
  assert.equal(staleExecute.statusCode, 404);
  assert.match(staleExecute.statusMessage, /expired/u);

  assert.equal(
    service.handleRequest("eve_public.other.Request", makeEnvelope(types.GetFuelRequest, {})),
    null,
    "unrelated request types must pass through",
  );
});
