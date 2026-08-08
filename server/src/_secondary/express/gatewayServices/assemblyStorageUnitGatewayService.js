"use strict";

/** Local build-3455996 Smart Storage Unit gateway contract. */

const path = require("path");

const {
  bufferFromBytes,
  encodePayload,
  getActiveCharacterID,
  uuidBufferToString,
  uuidStringToBuffer,
} = require("./gatewayServiceHelpers");
const {
  getStorageUnitProtoTypes,
} = require("./assemblyStorageUnitProto");
const smartStorageUnitRuntime = require(path.join(
  __dirname,
  "../../../services/frontier/smartStorageUnitRuntime",
));
const sessionRegistry = require(path.join(
  __dirname,
  "../../../services/chat/sessionRegistry",
));
const spaceRuntime = require(path.join(__dirname, "../../../space/runtime"));
const {
  emitItemsChangedBatchForSession,
} = require(path.join(
  __dirname,
  "../../../services/character/characterState",
));

const API_PACKAGE = "eve_public.assembly.storageunit.api";
const GET_INVENTORY_REQUEST = `${API_PACKAGE}.GetInventoryRequest`;
const GET_INVENTORY_RESPONSE = `${API_PACKAGE}.GetInventoryResponse`;
const PREPARE_DEPOSIT_ITEMS_REQUEST = `${API_PACKAGE}.PrepareDepositItemsRequest`;
const PREPARE_DEPOSIT_ITEMS_RESPONSE = `${API_PACKAGE}.PrepareDepositItemsResponse`;
const EXECUTE_DEPOSIT_ITEMS_REQUEST = `${API_PACKAGE}.ExecuteDepositItemsRequest`;
const EXECUTE_DEPOSIT_ITEMS_RESPONSE = `${API_PACKAGE}.ExecuteDepositItemsResponse`;
const PREPARE_WITHDRAW_ITEMS_REQUEST = `${API_PACKAGE}.PrepareWithdrawItemsRequest`;
const PREPARE_WITHDRAW_ITEMS_RESPONSE = `${API_PACKAGE}.PrepareWithdrawItemsResponse`;
const EXECUTE_WITHDRAW_ITEMS_REQUEST = `${API_PACKAGE}.ExecuteWithdrawItemsRequest`;
const EXECUTE_WITHDRAW_ITEMS_RESPONSE = `${API_PACKAGE}.ExecuteWithdrawItemsResponse`;
const INVENTORY_ITEM_DEPOSITED_NOTICE = `${API_PACKAGE}.InventoryItemDepositedNotice`;
const INVENTORY_ITEM_WITHDRAWN_NOTICE = `${API_PACKAGE}.InventoryItemWithdrawnNotice`;
const MAX_ASSEMBLY_INTERACTION_DISTANCE_METERS = 5000;
const UINT32_MAX = 0xffffffff;

const RESPONSE_TYPE_BY_REQUEST = Object.freeze({
  [GET_INVENTORY_REQUEST]: GET_INVENTORY_RESPONSE,
  [PREPARE_DEPOSIT_ITEMS_REQUEST]: PREPARE_DEPOSIT_ITEMS_RESPONSE,
  [EXECUTE_DEPOSIT_ITEMS_REQUEST]: EXECUTE_DEPOSIT_ITEMS_RESPONSE,
  [PREPARE_WITHDRAW_ITEMS_REQUEST]: PREPARE_WITHDRAW_ITEMS_RESPONSE,
  [EXECUTE_WITHDRAW_ITEMS_REQUEST]: EXECUTE_WITHDRAW_ITEMS_RESPONSE,
});

const ERROR_RESULTS = Object.freeze({
  ACCESS_DENIED: [403, "Access denied."],
  INVALID_ASSEMBLY_ID: [400, "Invalid Smart Storage Unit identifier."],
  ASSEMBLY_NOT_FOUND: [404, "That Smart Storage Unit no longer exists."],
  ASSEMBLY_UNDER_CONSTRUCTION: [409, "That Smart Storage Unit is still under construction."],
  ASSEMBLY_UNAVAILABLE: [409, "That Smart Storage Unit is unavailable."],
  ASSEMBLY_OFFLINE: [409, "That Smart Storage Unit is offline."],
  ASSEMBLY_NOT_IN_CURRENT_SYSTEM: [403, "That Smart Storage Unit is not in your current system."],
  ASSEMBLY_OUT_OF_RANGE: [403, "Move within 5 km of the Smart Storage Unit."],
  INVALID_QUANTITY: [400, "Select a positive quantity."],
  INVALID_SOURCE: [400, "The deposit source is not available."],
  SOURCE_ITEM_NOT_FOUND: [404, "An item selected for deposit is no longer available."],
  SINGLETON_NOT_ACCEPTED: [400, "Smart Storage Units do not accept singleton items."],
  INSUFFICIENT_SOURCE_ITEMS: [409, "Not enough items remain in the source stack."],
  STORAGE_CAPACITY_EXCEEDED: [409, "The Smart Storage Unit does not have enough free capacity."],
  STORAGE_TYPE_QUANTITY_EXCEEDED: [409, "That item stack has reached the Smart Storage Unit's client-visible limit."],
  INVALID_DESTINATION: [400, "The withdrawal destination is not available."],
  SHIP_CARGO_CAPACITY_EXCEEDED: [409, "Your ship cargo hold does not have enough free capacity."],
  UNSUPPORTED_DESTINATION: [400, "Direct storage-to-storage withdrawal is not supported yet."],
  INSUFFICIENT_STORED_ITEMS: [409, "The Smart Storage Unit no longer holds that quantity."],
  TRANSACTION_NOT_FOUND: [404, "The storage transaction has expired. Please try again."],
  TRANSACTION_MISMATCH: [409, "The storage transaction does not match."],
  INVALID_SIGNATURE: [403, "The transaction signature was rejected."],
  INVALID_MOVE_REQUEST: [400, "The storage move was invalid."],
  ITEM_NOT_FOUND: [404, "An item in the storage transaction no longer exists."],
  INSUFFICIENT_ITEMS: [409, "An item stack changed before the transaction completed."],
  WRITE_ERROR: [500, "The storage inventory could not be saved."],
  STORAGE_MOVE_FAILED: [500, "The storage move could not be completed."],
});

function decodeRequest(type, requestEnvelope) {
  try {
    return type.decode(bufferFromBytes(
      requestEnvelope && requestEnvelope.payload && requestEnvelope.payload.value,
    ));
  } catch (_) {
    return null;
  }
}

function toNumber(value) {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) ? numeric : 0;
}

function buildErrorResult(responseTypeName, errorMsg, params) {
  const mapped = ERROR_RESULTS[String(errorMsg || "")] || null;
  let statusMessage = mapped ? mapped[1] : "The Smart Storage Unit operation failed.";
  if (
    errorMsg === "STORAGE_CAPACITY_EXCEEDED" &&
    params &&
    Number.isFinite(Number(params.freeVolume))
  ) {
    statusMessage = `The Smart Storage Unit has ${Math.max(
      0,
      Math.floor(Number(params.freeVolume)),
    ).toLocaleString("en-US")} m³ free.`;
  }
  return {
    statusCode: mapped ? mapped[0] : 500,
    statusMessage,
    responseTypeName,
    responsePayloadBuffer: Buffer.alloc(0),
  };
}

function buildInventoryItem(item) {
  const quantity = Math.max(0, Math.min(UINT32_MAX, toNumber(item.quantity)));
  const unitVolume = Math.max(0, Number(item.unitVolume) || 0);
  return {
    identifier: { sequential: toNumber(item.itemID) },
    attributes: {
      identifier: { sequential: toNumber(item.typeID) },
      quantity,
      volume: unitVolume * quantity,
    },
  };
}

function createAssemblyStorageUnitGatewayService(context) {
  const types = getStorageUnitProtoTypes();
  const publishGatewayNotice =
    context && typeof context.publishGatewayNotice === "function"
      ? context.publishGatewayNotice
      : null;
  const customAccessResolver =
    context && typeof context.resolveStorageUnitAccess === "function"
      ? context.resolveStorageUnitAccess
      : null;

  function resolveLiveAccess(characterID, storageUnitID) {
    if (customAccessResolver) {
      return customAccessResolver(characterID, storageUnitID);
    }
    const session = sessionRegistry.findSessionByCharacterID(characterID);
    if (!session) {
      return { authorized: false };
    }
    const activeShipID = toNumber(
      (session._space && session._space.shipID) || session.shipid || session.shipID,
    );
    const solarSystemID = toNumber(
      session.solarsystemid2 ||
      (session._space && session._space.systemID) ||
      session.solarsystemid ||
      session.locationid,
    );
    const shipEntity = activeShipID > 0
      ? spaceRuntime.getEntity(session, activeShipID)
      : null;
    const storageEntity = spaceRuntime.getEntity(session, storageUnitID);
    const scene = spaceRuntime.getSceneForSession(session);
    const surfaceDistance = (
      scene &&
      typeof scene.getCommandTimeEntitySurfaceDistance === "function"
    )
      ? scene.getCommandTimeEntitySurfaceDistance(shipEntity, storageEntity)
      : Infinity;
    return {
      activeShipID,
      authorized: true,
      inRange: Number.isFinite(surfaceDistance) &&
        surfaceDistance <= MAX_ASSEMBLY_INTERACTION_DISTANCE_METERS,
      solarSystemID,
      surfaceDistance,
    };
  }

  function getLiveSession(characterID) {
    return sessionRegistry.findSessionByCharacterID(characterID);
  }

  function syncInventoryChanges(characterID, changes) {
    const session = getLiveSession(characterID);
    if (!session || !Array.isArray(changes) || changes.length === 0) {
      return false;
    }
    return emitItemsChangedBatchForSession(session, changes);
  }

  function publishInventoryNotices(typeName, messageType, commitData) {
    if (!publishGatewayNotice || commitData.replayed === true) {
      return;
    }
    for (const item of commitData.noticeItems || []) {
      publishGatewayNotice(
        typeName,
        encodePayload(messageType, {
          storage_unit: { sequential: commitData.storageUnitID },
          character: { sequential: commitData.characterID },
          item: buildInventoryItem(item),
        }),
        { character: commitData.characterID },
      );
    }
  }

  function buildPrepareResult(responseTypeName, responseType, prepared) {
    return {
      statusCode: 200,
      statusMessage: "",
      responseTypeName,
      responsePayloadBuffer: encodePayload(responseType, {
        prepared_transaction: {
          uuid: uuidStringToBuffer(prepared.transactionUUID),
        },
        prepared_transaction_attributes: {
          // Despite the legacy field name, build 3455996's Transaction.from
          // restores strings beginning with "{" as JSON transaction snapshots.
          // Base64(JSON) is instead interpreted as binary BCS and rejected.
          bcs_data_b64_bytes: prepared.transactionData,
        },
      }),
    };
  }

  function handleGetInventory(characterID, requestEnvelope) {
    const request = decodeRequest(types.GetInventoryRequest, requestEnvelope);
    if (!request) {
      return buildErrorResult(GET_INVENTORY_RESPONSE, "INVALID_ASSEMBLY_ID");
    }
    const storageUnitID = toNumber(
      request.storage_unit && request.storage_unit.sequential,
    );
    const result = smartStorageUnitRuntime.getStorageInventory({
      access: resolveLiveAccess(characterID, storageUnitID),
      characterID,
      inventoryOwnerID: toNumber(
        request.inventory_owner && request.inventory_owner.sequential,
      ),
      storageUnitID,
    });
    if (!result.success) {
      return buildErrorResult(GET_INVENTORY_RESPONSE, result.errorMsg, result.params);
    }
    return {
      statusCode: 200,
      statusMessage: "",
      responseTypeName: GET_INVENTORY_RESPONSE,
      responsePayloadBuffer: encodePayload(types.GetInventoryResponse, {
        items: result.data.items.map(buildInventoryItem),
      }),
    };
  }

  function handlePrepareDeposit(characterID, requestEnvelope) {
    const request = decodeRequest(types.PrepareDepositItemsRequest, requestEnvelope);
    if (!request) {
      return buildErrorResult(PREPARE_DEPOSIT_ITEMS_RESPONSE, "INVALID_QUANTITY");
    }
    const storageUnitID = toNumber(
      request.destination_container && request.destination_container.sequential,
    );
    const result = smartStorageUnitRuntime.prepareStorageDeposit({
      access: resolveLiveAccess(characterID, storageUnitID),
      characterID,
      sourceLocationID: toNumber(
        request.source_container &&
        request.source_container.item &&
        request.source_container.item.sequential,
      ),
      sourceFlagID: request.source_container && request.source_container.flag
        ? toNumber(request.source_container.flag.value)
        : -1,
      stacks: (request.stacks || []).map((stack) => ({
        itemID: toNumber(stack && stack.item && stack.item.sequential),
        quantity: toNumber(stack && stack.quantity),
      })),
      storageUnitID,
    });
    if (!result.success) {
      return buildErrorResult(
        PREPARE_DEPOSIT_ITEMS_RESPONSE,
        result.errorMsg,
        result.params,
      );
    }
    return buildPrepareResult(
      PREPARE_DEPOSIT_ITEMS_RESPONSE,
      types.PrepareDepositItemsResponse,
      result.data,
    );
  }

  function handlePrepareWithdraw(characterID, requestEnvelope) {
    const request = decodeRequest(types.PrepareWithdrawItemsRequest, requestEnvelope);
    if (!request) {
      return buildErrorResult(PREPARE_WITHDRAW_ITEMS_RESPONSE, "INVALID_QUANTITY");
    }
    const storageUnitID = toNumber(
      request.source_container && request.source_container.sequential,
    );
    const result = smartStorageUnitRuntime.prepareStorageWithdraw({
      access: resolveLiveAccess(characterID, storageUnitID),
      characterID,
      destinationFlagID: request.generic_location && request.generic_location.flag
        ? toNumber(request.generic_location.flag.value)
        : -1,
      destinationLocationID: toNumber(
        request.generic_location &&
        request.generic_location.item &&
        request.generic_location.item.sequential,
      ),
      destinationStorageUnitID: toNumber(
        request.another_assembly && request.another_assembly.sequential,
      ),
      stacks: (request.stacks || []).map((stack) => ({
        typeID: toNumber(
          stack && stack.item_type && stack.item_type.sequential,
        ),
        quantity: toNumber(stack && stack.quantity),
      })),
      storageUnitID,
    });
    if (!result.success) {
      return buildErrorResult(
        PREPARE_WITHDRAW_ITEMS_RESPONSE,
        result.errorMsg,
        result.params,
      );
    }
    return buildPrepareResult(
      PREPARE_WITHDRAW_ITEMS_RESPONSE,
      types.PrepareWithdrawItemsResponse,
      result.data,
    );
  }

  function handleExecute(
    characterID,
    requestEnvelope,
    action,
    requestType,
    responseTypeName,
    noticeTypeName,
    noticeMessageType,
  ) {
    const request = decodeRequest(requestType, requestEnvelope);
    const transactionUUID = uuidBufferToString(bufferFromBytes(
      request &&
      request.prepared_transaction &&
      request.prepared_transaction.uuid,
    ));
    if (!request || !transactionUUID) {
      return buildErrorResult(responseTypeName, "TRANSACTION_NOT_FOUND");
    }
    const result = smartStorageUnitRuntime.executeStorageTransaction({
      action,
      characterID,
      resolveAccess: (storageUnitID) => resolveLiveAccess(
        characterID,
        storageUnitID,
      ),
      signature: String(request.signature || ""),
      transactionUUID,
    });
    if (!result.success) {
      return buildErrorResult(responseTypeName, result.errorMsg, result.params);
    }
    if (result.data.replayed !== true) {
      syncInventoryChanges(characterID, result.data.changes);
      publishInventoryNotices(noticeTypeName, noticeMessageType, result.data);
    }
    return {
      statusCode: 200,
      statusMessage: "",
      responseTypeName,
      responsePayloadBuffer: Buffer.alloc(0),
    };
  }

  return {
    name: "assembly-storageunit",
    handledRequestTypes: Object.keys(RESPONSE_TYPE_BY_REQUEST),
    getEmptySuccessResponseType(requestTypeName) {
      // Mutation failures must never be converted into a fake 2xx commit.
      return requestTypeName === GET_INVENTORY_REQUEST
        ? GET_INVENTORY_RESPONSE
        : null;
    },
    handleRequest(requestTypeName, requestEnvelope) {
      const responseTypeName = RESPONSE_TYPE_BY_REQUEST[requestTypeName];
      if (!responseTypeName) {
        return null;
      }
      const characterID = getActiveCharacterID(requestEnvelope);
      if (characterID <= 0) {
        return buildErrorResult(responseTypeName, "ACCESS_DENIED");
      }
      switch (requestTypeName) {
        case GET_INVENTORY_REQUEST:
          return handleGetInventory(characterID, requestEnvelope);
        case PREPARE_DEPOSIT_ITEMS_REQUEST:
          return handlePrepareDeposit(characterID, requestEnvelope);
        case PREPARE_WITHDRAW_ITEMS_REQUEST:
          return handlePrepareWithdraw(characterID, requestEnvelope);
        case EXECUTE_DEPOSIT_ITEMS_REQUEST:
          return handleExecute(
            characterID,
            requestEnvelope,
            "storageunit-deposit",
            types.ExecuteDepositItemsRequest,
            EXECUTE_DEPOSIT_ITEMS_RESPONSE,
            INVENTORY_ITEM_DEPOSITED_NOTICE,
            types.InventoryItemDepositedNotice,
          );
        case EXECUTE_WITHDRAW_ITEMS_REQUEST:
          return handleExecute(
            characterID,
            requestEnvelope,
            "storageunit-withdraw",
            types.ExecuteWithdrawItemsRequest,
            EXECUTE_WITHDRAW_ITEMS_RESPONSE,
            INVENTORY_ITEM_WITHDRAWN_NOTICE,
            types.InventoryItemWithdrawnNotice,
          );
        default:
          return null;
      }
    },
  };
}

module.exports = {
  EXECUTE_DEPOSIT_ITEMS_REQUEST,
  EXECUTE_WITHDRAW_ITEMS_REQUEST,
  GET_INVENTORY_REQUEST,
  GET_INVENTORY_RESPONSE,
  INVENTORY_ITEM_DEPOSITED_NOTICE,
  INVENTORY_ITEM_WITHDRAWN_NOTICE,
  PREPARE_DEPOSIT_ITEMS_REQUEST,
  PREPARE_WITHDRAW_ITEMS_REQUEST,
  createAssemblyStorageUnitGatewayService,
};
