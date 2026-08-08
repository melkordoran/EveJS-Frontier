"use strict";

const path = require("path");

const {
  bufferFromBytes,
  encodePayload,
  getActiveCharacterID,
} = require("./gatewayServiceHelpers");
const {
  getAssemblyGateProtoTypes,
} = require("./assemblyGateProto");
const {
  listOwnedSmartGates,
} = require(path.join(
  __dirname,
  "../../../services/frontier/deploymentRuntime",
));
const {
  findItemById,
  getItemMetadata,
} = require(path.join(
  __dirname,
  "../../../services/inventory/itemStore",
));

const GET_METADATA_REQUEST = "eve_public.assembly.api.GetMetadataRequest";
const GET_METADATA_RESPONSE = "eve_public.assembly.api.GetMetadataResponse";
const GET_ENERGY_CONFIG_REQUEST =
  "eve_public.assembly.api.GetEnergyConfigRequest";
const GET_ENERGY_CONFIG_RESPONSE =
  "eve_public.assembly.api.GetEnergyConfigResponse";
const GET_ALL_OWNED_REQUEST =
  "eve_public.assembly.gate.api.GetAllOwnedRequest";
const GET_ALL_OWNED_RESPONSE =
  "eve_public.assembly.gate.api.GetAllOwnedResponse";

function buildGateEntryPayload(gate) {
  const position = gate && gate.position;
  return {
    id: { sequential: Number(gate && gate.itemID || 0) },
    attributes: {
      type_id: Number(gate && gate.typeID || 0),
      location: {
        solar_system: {
          sequential: Number(gate && gate.solarSystemID || 0),
        },
        position: {
          x: Number(position && position.x || 0),
          y: Number(position && position.y || 0),
          z: Number(position && position.z || 0),
        },
      },
      metadata: {
        name: String(gate && gate.name || "Smart Gate"),
        description: "",
        dapp_url: "",
      },
      ...(Number(gate && gate.destinationGateID || 0) > 0
        ? {
            destination: {
              sequential: Number(gate.destinationGateID),
            },
          }
        : {}),
    },
  };
}

function buildAssemblyMetadataPayload(item) {
  if (!item) {
    return null;
  }
  const type = getItemMetadata(item.typeID, item.itemName);
  return {
    name: String(item.itemName || type && type.name || `Assembly ${item.itemID}`),
    description: "",
    dapp_url: "",
  };
}

function decodeMetadataAssemblyID(types, requestEnvelope) {
  try {
    const request = types.getMetadataRequest.decode(
      bufferFromBytes(
        requestEnvelope && requestEnvelope.payload && requestEnvelope.payload.value,
      ),
    );
    return Number(request && request.assembly && request.assembly.sequential) || 0;
  } catch (error) {
    return 0;
  }
}

function createAssemblyGateGatewayService() {
  const types = getAssemblyGateProtoTypes();
  return {
    name: "assembly-gate",
    handledRequestTypes: [
      GET_METADATA_REQUEST,
      GET_ENERGY_CONFIG_REQUEST,
      GET_ALL_OWNED_REQUEST,
    ],
    getEmptySuccessResponseType(requestTypeName) {
      if (requestTypeName === GET_METADATA_REQUEST) {
        return GET_METADATA_RESPONSE;
      }
      if (requestTypeName === GET_ENERGY_CONFIG_REQUEST) {
        return GET_ENERGY_CONFIG_RESPONSE;
      }
      return requestTypeName === GET_ALL_OWNED_REQUEST
        ? GET_ALL_OWNED_RESPONSE
        : null;
    },
    handleRequest(requestTypeName, requestEnvelope) {
      if (
        requestTypeName !== GET_METADATA_REQUEST &&
        requestTypeName !== GET_ENERGY_CONFIG_REQUEST &&
        requestTypeName !== GET_ALL_OWNED_REQUEST
      ) {
        return null;
      }
      const characterID = getActiveCharacterID(requestEnvelope);
      if (characterID <= 0) {
        return {
          statusCode: 403,
          statusMessage: "ACCESS_DENIED",
          responseTypeName:
            requestTypeName === GET_METADATA_REQUEST
              ? GET_METADATA_RESPONSE
              : requestTypeName === GET_ENERGY_CONFIG_REQUEST
                ? GET_ENERGY_CONFIG_RESPONSE
                : GET_ALL_OWNED_RESPONSE,
          responsePayloadBuffer: Buffer.alloc(0),
        };
      }
      if (requestTypeName === GET_ENERGY_CONFIG_REQUEST) {
        // The extracted build-3455996 client treats missing assembly types as
        // zero-energy entries. No authoritative energy-balance table is part
        // of the public descriptor, so return the exact successful wire shape
        // without inventing values that could incorrectly gate base building.
        return {
          statusCode: 200,
          statusMessage: "",
          responseTypeName: GET_ENERGY_CONFIG_RESPONSE,
          responsePayloadBuffer: encodePayload(
            types.getEnergyConfigResponse,
            { energy_requirements: [] },
          ),
        };
      }
      if (requestTypeName === GET_METADATA_REQUEST) {
        const assemblyID = decodeMetadataAssemblyID(types, requestEnvelope);
        if (assemblyID <= 0) {
          return {
            statusCode: 400,
            statusMessage: "INVALID_ASSEMBLY_ID",
            responseTypeName: GET_METADATA_RESPONSE,
            responsePayloadBuffer: Buffer.alloc(0),
          };
        }
        const metadata = buildAssemblyMetadataPayload(findItemById(assemblyID));
        if (!metadata) {
          return {
            statusCode: 404,
            statusMessage: "ASSEMBLY_NOT_FOUND",
            responseTypeName: GET_METADATA_RESPONSE,
            responsePayloadBuffer: Buffer.alloc(0),
          };
        }
        return {
          statusCode: 200,
          statusMessage: "",
          responseTypeName: GET_METADATA_RESPONSE,
          responsePayloadBuffer: encodePayload(
            types.getMetadataResponse,
            { metadata },
          ),
        };
      }
      return {
        statusCode: 200,
        statusMessage: "",
        responseTypeName: GET_ALL_OWNED_RESPONSE,
        responsePayloadBuffer: encodePayload(
          types.getAllOwnedResponse,
          {
            gates: listOwnedSmartGates(characterID).map(buildGateEntryPayload),
          },
        ),
      };
    },
  };
}

module.exports = {
  GET_ENERGY_CONFIG_REQUEST,
  GET_ENERGY_CONFIG_RESPONSE,
  GET_METADATA_REQUEST,
  GET_METADATA_RESPONSE,
  GET_ALL_OWNED_REQUEST,
  GET_ALL_OWNED_RESPONSE,
  buildAssemblyMetadataPayload,
  buildGateEntryPayload,
  createAssemblyGateGatewayService,
};
