"use strict";

/**
 * Build-3455996 assembly energy configuration contract coverage.
 * Run through:
 *   npm run test:isolated -- server/tests/frontierAssemblyEnergyConfig.test.js
 */

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  getAssemblyGateProtoTypes,
} = require("../src/_secondary/express/gatewayServices/assemblyGateProto");
const {
  GET_ENERGY_CONFIG_REQUEST,
  GET_ENERGY_CONFIG_RESPONSE,
  createAssemblyGateGatewayService,
} = require("../src/_secondary/express/gatewayServices/assemblyGateGatewayService");
const CHARACTER_ID = 140000005;

function requestEnvelope(payloadBuffer = Buffer.alloc(0), characterID = CHARACTER_ID) {
  return {
    authoritative_context: {
      active_character: {
        sequential: characterID,
      },
    },
    payload: {
      value: payloadBuffer,
    },
  };
}

test("assembly energy protobuf matches the build-3455996 descriptor", () => {
  const types = getAssemblyGateProtoTypes();
  const encodedRequest = types.getEnergyConfigRequest.encode({}).finish();
  assert.equal(encodedRequest.length, 0);

  const encodedResponse = types.getEnergyConfigResponse.encode({
    energy_requirements: [
      { assembly_type: 88067, energy_required: 100 },
      { assembly_type: 88064, energy_required: 200 },
    ],
  }).finish();
  const decoded = types.getEnergyConfigResponse.toObject(
    types.getEnergyConfigResponse.decode(encodedResponse),
    { longs: Number },
  );

  assert.deepEqual(decoded.energy_requirements, [
    { assembly_type: 88067, energy_required: 100 },
    { assembly_type: 88064, energy_required: 200 },
  ]);
});

test("assembly gateway returns a successful energy configuration", () => {
  const types = getAssemblyGateProtoTypes();
  const service = createAssemblyGateGatewayService();

  assert.ok(service.handledRequestTypes.includes(GET_ENERGY_CONFIG_REQUEST));
  assert.equal(
    service.getEmptySuccessResponseType(GET_ENERGY_CONFIG_REQUEST),
    GET_ENERGY_CONFIG_RESPONSE,
  );

  const response = service.handleRequest(
    GET_ENERGY_CONFIG_REQUEST,
    requestEnvelope(types.getEnergyConfigRequest.encode({}).finish()),
  );
  const decoded = types.getEnergyConfigResponse.toObject(
    types.getEnergyConfigResponse.decode(response.responsePayloadBuffer),
    { longs: Number, arrays: true },
  );

  assert.equal(response.statusCode, 200);
  assert.equal(response.statusMessage, "");
  assert.equal(response.responseTypeName, GET_ENERGY_CONFIG_RESPONSE);
  assert.deepEqual(decoded.energy_requirements, []);
});

test("assembly energy configuration requires an active character", () => {
  const service = createAssemblyGateGatewayService();
  const denied = service.handleRequest(
    GET_ENERGY_CONFIG_REQUEST,
    requestEnvelope(Buffer.alloc(0), 0),
  );
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.statusMessage, "ACCESS_DENIED");
  assert.equal(denied.responseTypeName, GET_ENERGY_CONFIG_RESPONSE);
});
