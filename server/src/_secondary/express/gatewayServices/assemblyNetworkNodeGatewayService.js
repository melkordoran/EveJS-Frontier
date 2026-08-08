"use strict";

/**
 * Local gateway service for the Network Node fuel contract
 * (eve_public.assembly.networknode.api.*).
 *
 * Read paths answer GetFuelConfig/GetFuel; mutations follow the client's
 * prepare -> wallet-sign -> execute sequence with the transaction machinery
 * in services/frontier/networkNodeFuelRuntime. Exactly one FuelChangedNotice
 * is published per committed state change, targeted at the node's solar
 * system so any nearby open anchor window refreshes.
 */

const path = require("path");

const {
  bufferFromBytes,
  encodePayload,
  getActiveCharacterID,
  uuidBufferToString,
  uuidStringToBuffer,
} = require("./gatewayServiceHelpers");
const {
  getNetworkNodeProtoTypes,
} = require("./assemblyNetworkNodeProto");
const networkNodeFuelRuntime = require(path.join(
  __dirname,
  "../../../services/frontier/networkNodeFuelRuntime",
));
const sessionRegistry = require(path.join(
  __dirname,
  "../../../services/chat/sessionRegistry",
));
const {
  emitItemsChangedBatchForSession,
} = require(path.join(
  __dirname,
  "../../../services/character/characterState",
));

const API_PACKAGE = "eve_public.assembly.networknode.api";
const GET_FUEL_CONFIG_REQUEST = `${API_PACKAGE}.GetFuelConfigRequest`;
const GET_FUEL_CONFIG_RESPONSE = `${API_PACKAGE}.GetFuelConfigResponse`;
const GET_FUEL_REQUEST = `${API_PACKAGE}.GetFuelRequest`;
const GET_FUEL_RESPONSE = `${API_PACKAGE}.GetFuelResponse`;
const PREPARE_DEPOSIT_FUEL_REQUEST = `${API_PACKAGE}.PrepareDepositFuelRequest`;
const PREPARE_DEPOSIT_FUEL_RESPONSE = `${API_PACKAGE}.PrepareDepositFuelResponse`;
const EXECUTE_DEPOSIT_FUEL_REQUEST = `${API_PACKAGE}.ExecuteDepositFuelRequest`;
const EXECUTE_DEPOSIT_FUEL_RESPONSE = `${API_PACKAGE}.ExecuteDepositFuelResponse`;
const PREPARE_WITHDRAW_FUEL_REQUEST = `${API_PACKAGE}.PrepareWithdrawFuelRequest`;
const PREPARE_WITHDRAW_FUEL_RESPONSE = `${API_PACKAGE}.PrepareWithdrawFuelResponse`;
const EXECUTE_WITHDRAW_FUEL_REQUEST = `${API_PACKAGE}.ExecuteWithdrawFuelRequest`;
const EXECUTE_WITHDRAW_FUEL_RESPONSE = `${API_PACKAGE}.ExecuteWithdrawFuelResponse`;
const FUEL_CHANGED_NOTICE = `${API_PACKAGE}.FuelChangedNotice`;

const RESPONSE_TYPE_BY_REQUEST = Object.freeze({
  [GET_FUEL_CONFIG_REQUEST]: GET_FUEL_CONFIG_RESPONSE,
  [GET_FUEL_REQUEST]: GET_FUEL_RESPONSE,
  [PREPARE_DEPOSIT_FUEL_REQUEST]: PREPARE_DEPOSIT_FUEL_RESPONSE,
  [EXECUTE_DEPOSIT_FUEL_REQUEST]: EXECUTE_DEPOSIT_FUEL_RESPONSE,
  [PREPARE_WITHDRAW_FUEL_REQUEST]: PREPARE_WITHDRAW_FUEL_RESPONSE,
  [EXECUTE_WITHDRAW_FUEL_REQUEST]: EXECUTE_WITHDRAW_FUEL_RESPONSE,
});

// The client surfaces status_message verbatim through a CustomNotify user
// error (SmartAssemblySvc._raise_fuel_user_error), so keep these readable.
const ERROR_RESULTS = Object.freeze({
  ACCESS_DENIED: [403, "Access denied."],
  INVALID_ASSEMBLY_ID: [400, "Invalid Network Node identifier."],
  ASSEMBLY_NOT_FOUND: [404, "That Network Node no longer exists."],
  ASSEMBLY_NOT_OWNED: [403, "You do not own that Network Node."],
  ASSEMBLY_UNDER_CONSTRUCTION: [
    409,
    "That Network Node is still under construction.",
  ],
  INVALID_QUANTITY: [400, "The fuel amount must be a positive number of units."],
  INVALID_SOURCE: [400, "The fuel source is not available."],
  SOURCE_ITEM_NOT_FOUND: [404, "The fuel to deposit is no longer available."],
  MIXED_FUEL_TYPES: [
    409,
    "The Network Node can only store one fuel type at a time.",
  ],
  INSUFFICIENT_SOURCE_FUEL: [409, "Not enough fuel is available to deposit."],
  UNSUPPORTED_FUEL_TYPE: [400, "That item cannot be used as Network Node fuel."],
  FUEL_CAPACITY_EXCEEDED: [409, "The fuel reserve cannot hold that much fuel."],
  INSUFFICIENT_STORED_FUEL: [
    409,
    "The Network Node does not hold that much fuel.",
  ],
  INVALID_DESTINATION: [400, "The withdrawal destination is not available."],
  TRANSACTION_NOT_FOUND: [
    404,
    "The fuel transaction has expired. Please try again.",
  ],
  TRANSACTION_MISMATCH: [409, "The fuel transaction does not match."],
  INVALID_SIGNATURE: [403, "The transaction signature was rejected."],
});

function buildErrorResult(responseTypeName, errorMsg, params) {
  const mapped = ERROR_RESULTS[String(errorMsg || "")] || null;
  let statusMessage = mapped ? mapped[1] : "The fuel operation failed.";
  if (
    errorMsg === "FUEL_CAPACITY_EXCEEDED" &&
    params &&
    Number.isFinite(Number(params.remainingUnits)) &&
    Number(params.remainingUnits) > 0
  ) {
    statusMessage = `The fuel reserve can only take ${Number(params.remainingUnits)} more units.`;
  }
  return {
    statusCode: mapped ? mapped[0] : 500,
    statusMessage,
    responseTypeName,
    responsePayloadBuffer: Buffer.alloc(0),
  };
}

function decodeRequest(type, requestEnvelope) {
  try {
    return type.decode(
      bufferFromBytes(
        requestEnvelope && requestEnvelope.payload && requestEnvelope.payload.value,
      ),
    );
  } catch (error) {
    return null;
  }
}

function toNumber(value) {
  if (value === null || value === undefined) {
    return 0;
  }
  return Number(value) || 0;
}

function buildFuelItemAttributes(fuelStatus) {
  return {
    identifier: { sequential: toNumber(fuelStatus.typeID) },
    quantity: toNumber(fuelStatus.quantity),
    volume: Number(fuelStatus.unitVolume) > 0
      ? Number(fuelStatus.unitVolume) * toNumber(fuelStatus.quantity)
      : 0,
  };
}

function createAssemblyNetworkNodeGatewayService(context) {
  const types = getNetworkNodeProtoTypes();
  const publishGatewayNotice =
    context && typeof context.publishGatewayNotice === "function"
      ? context.publishGatewayNotice
      : null;

  function publishFuelChangedNotice(commitData) {
    if (!publishGatewayNotice) {
      return false;
    }
    const unitVolume = commitData.fuelTypeID > 0
      ? Number(
          networkNodeFuelRuntime.getNetworkNodeFuelStatus(
            commitData.characterID,
            commitData.networkNodeID,
          )?.data?.unitVolume,
        ) || 0
      : 0;
    const payload = encodePayload(types.FuelChangedNotice, {
      network_node: { sequential: commitData.networkNodeID },
      fuel: buildFuelItemAttributes({
        typeID: commitData.quantity > 0 ? commitData.fuelTypeID : 0,
        quantity: commitData.quantity,
        unitVolume,
      }),
    });
    return publishGatewayNotice(
      FUEL_CHANGED_NOTICE,
      payload,
      commitData.solarSystemID > 0
        ? { solar_system: commitData.solarSystemID }
        : { character: commitData.characterID },
    );
  }

  function syncInventoryChangesToCharacter(characterID, changes) {
    if (!Array.isArray(changes) || changes.length === 0) {
      return;
    }
    const session = sessionRegistry.findSessionByCharacterID(characterID);
    if (!session) {
      return;
    }
    emitItemsChangedBatchForSession(session, changes);
  }

  function handleGetFuelConfig() {
    return {
      statusCode: 200,
      statusMessage: "",
      responseTypeName: GET_FUEL_CONFIG_RESPONSE,
      responsePayloadBuffer: encodePayload(types.GetFuelConfigResponse, {
        fuels: networkNodeFuelRuntime.getNetworkNodeFuelConfig().map((entry) => ({
          fuel_type: { sequential: entry.typeID },
          efficiency: entry.efficiency,
        })),
      }),
    };
  }

  function handleGetFuel(characterID, requestEnvelope) {
    const request = decodeRequest(types.GetFuelRequest, requestEnvelope);
    const networkNodeID = toNumber(
      request && request.network_node && request.network_node.sequential,
    );
    const status = networkNodeFuelRuntime.getNetworkNodeFuelStatus(
      characterID,
      networkNodeID,
    );
    if (!status.success) {
      return buildErrorResult(GET_FUEL_RESPONSE, status.errorMsg);
    }
    return {
      statusCode: 200,
      statusMessage: "",
      responseTypeName: GET_FUEL_RESPONSE,
      responsePayloadBuffer: encodePayload(types.GetFuelResponse, {
        fuel: buildFuelItemAttributes(status.data),
      }),
    };
  }

  function buildPrepareResult(responseTypeName, responseType, prepared) {
    return {
      statusCode: 200,
      statusMessage: "",
      responseTypeName,
      responsePayloadBuffer: encodePayload(responseType, {
        prepared_transaction_uuid: uuidStringToBuffer(prepared.transactionUUID),
        prepared_transaction_bcs_data: Buffer.from(
          prepared.transactionData,
          "utf8",
        ),
      }),
    };
  }

  function handlePrepareDeposit(characterID, requestEnvelope) {
    const request = decodeRequest(
      types.PrepareDepositFuelRequest,
      requestEnvelope,
    );
    if (!request) {
      return buildErrorResult(PREPARE_DEPOSIT_FUEL_RESPONSE, "INVALID_QUANTITY");
    }
    const result = networkNodeFuelRuntime.prepareNetworkNodeFuelDeposit({
      characterID,
      networkNodeID: toNumber(
        request.network_node && request.network_node.sequential,
      ),
      sourceItemID: toNumber(
        request.source && request.source.item && request.source.item.sequential,
      ),
      sourceFlagID: request.source && request.source.flag
        ? toNumber(request.source.flag.value)
        : -1,
      items: (request.items || []).map((entry) => ({
        itemID: toNumber(entry && entry.id && entry.id.sequential),
        quantity: toNumber(entry && entry.quantity),
      })),
    });
    if (!result.success) {
      return buildErrorResult(
        PREPARE_DEPOSIT_FUEL_RESPONSE,
        result.errorMsg,
        result.params,
      );
    }
    return buildPrepareResult(
      PREPARE_DEPOSIT_FUEL_RESPONSE,
      types.PrepareDepositFuelResponse,
      result.data,
    );
  }

  function handlePrepareWithdraw(characterID, requestEnvelope) {
    const request = decodeRequest(
      types.PrepareWithdrawFuelRequest,
      requestEnvelope,
    );
    if (!request) {
      return buildErrorResult(PREPARE_WITHDRAW_FUEL_RESPONSE, "INVALID_QUANTITY");
    }
    const result = networkNodeFuelRuntime.prepareNetworkNodeFuelWithdraw({
      characterID,
      networkNodeID: toNumber(
        request.network_node && request.network_node.sequential,
      ),
      fuelTypeID: toNumber(request.fuel_type && request.fuel_type.sequential),
      quantity: toNumber(request.quantity),
      destinationItemID: toNumber(
        request.destination &&
          request.destination.item &&
          request.destination.item.sequential,
      ),
      destinationFlagID: request.destination && request.destination.flag
        ? toNumber(request.destination.flag.value)
        : 0,
    });
    if (!result.success) {
      return buildErrorResult(
        PREPARE_WITHDRAW_FUEL_RESPONSE,
        result.errorMsg,
        result.params,
      );
    }
    return buildPrepareResult(
      PREPARE_WITHDRAW_FUEL_RESPONSE,
      types.PrepareWithdrawFuelResponse,
      result.data,
    );
  }

  function handleExecute(characterID, requestEnvelope, action, requestType, responseTypeName) {
    const request = decodeRequest(requestType, requestEnvelope);
    if (!request) {
      return buildErrorResult(responseTypeName, "TRANSACTION_NOT_FOUND");
    }
    const result = networkNodeFuelRuntime.executeNetworkNodeFuelTransaction({
      action,
      characterID,
      transactionUUID: uuidBufferToString(
        bufferFromBytes(request.prepared_transaction_uuid),
      ),
      signature: String(request.signature || ""),
    });
    if (!result.success) {
      return buildErrorResult(responseTypeName, result.errorMsg, result.params);
    }
    syncInventoryChangesToCharacter(characterID, result.data.changes);
    publishFuelChangedNotice({ ...result.data, characterID });
    return {
      statusCode: 200,
      statusMessage: "",
      responseTypeName,
      responsePayloadBuffer: Buffer.alloc(0),
    };
  }

  return {
    name: "assembly-networknode",
    handledRequestTypes: Object.keys(RESPONSE_TYPE_BY_REQUEST),
    getEmptySuccessResponseType(requestTypeName) {
      // Only the read paths may degrade to an empty success on unexpected
      // handler errors; an empty prepare/execute success would fake a
      // completed transaction to the client.
      if (requestTypeName === GET_FUEL_CONFIG_REQUEST) {
        return GET_FUEL_CONFIG_RESPONSE;
      }
      return requestTypeName === GET_FUEL_REQUEST ? GET_FUEL_RESPONSE : null;
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
        case GET_FUEL_CONFIG_REQUEST:
          return handleGetFuelConfig();
        case GET_FUEL_REQUEST:
          return handleGetFuel(characterID, requestEnvelope);
        case PREPARE_DEPOSIT_FUEL_REQUEST:
          return handlePrepareDeposit(characterID, requestEnvelope);
        case PREPARE_WITHDRAW_FUEL_REQUEST:
          return handlePrepareWithdraw(characterID, requestEnvelope);
        case EXECUTE_DEPOSIT_FUEL_REQUEST:
          return handleExecute(
            characterID,
            requestEnvelope,
            "networknode-fuel-deposit",
            types.ExecuteDepositFuelRequest,
            EXECUTE_DEPOSIT_FUEL_RESPONSE,
          );
        case EXECUTE_WITHDRAW_FUEL_REQUEST:
          return handleExecute(
            characterID,
            requestEnvelope,
            "networknode-fuel-withdraw",
            types.ExecuteWithdrawFuelRequest,
            EXECUTE_WITHDRAW_FUEL_RESPONSE,
          );
        default:
          return null;
      }
    },
  };
}

module.exports = {
  EXECUTE_DEPOSIT_FUEL_REQUEST,
  EXECUTE_WITHDRAW_FUEL_REQUEST,
  FUEL_CHANGED_NOTICE,
  GET_FUEL_CONFIG_REQUEST,
  GET_FUEL_CONFIG_RESPONSE,
  GET_FUEL_REQUEST,
  GET_FUEL_RESPONSE,
  PREPARE_DEPOSIT_FUEL_REQUEST,
  PREPARE_WITHDRAW_FUEL_REQUEST,
  createAssemblyNetworkNodeGatewayService,
};
