"use strict";

const {
  bufferFromBytes,
  encodePayload,
} = require("./gatewayServiceHelpers");
const {
  getFrontierCoreProtoTypes,
} = require("./frontierCoreProto");

const GET_EXCHANGE_RATE_REQUEST =
  "eve_public.token.exchange.api.GetExchangeRateRequest";
const GET_EXCHANGE_RATE_RESPONSE =
  "eve_public.token.exchange.api.GetExchangeRateResponse";
const FRONTIER_TOKEN_DENOMINATION = "EVE";

function createFrontierTokenExchangeGatewayService() {
  const types = getFrontierCoreProtoTypes();

  return {
    name: "frontier-token-exchange",
    handledRequestTypes: [GET_EXCHANGE_RATE_REQUEST],
    getEmptySuccessResponseType(requestTypeName) {
      return requestTypeName === GET_EXCHANGE_RATE_REQUEST
        ? GET_EXCHANGE_RATE_RESPONSE
        : null;
    },
    handleRequest(requestTypeName, requestEnvelope) {
      if (requestTypeName !== GET_EXCHANGE_RATE_REQUEST) {
        return null;
      }

      try {
        types.tokenGetExchangeRateRequest.decode(
          bufferFromBytes(
            requestEnvelope &&
              requestEnvelope.payload &&
              requestEnvelope.payload.value,
          ),
        );
      } catch (error) {
        return {
          statusCode: 400,
          statusMessage: "INVALID_EXCHANGE_RATE_REQUEST",
          responseTypeName: GET_EXCHANGE_RATE_RESPONSE,
          responsePayloadBuffer: Buffer.alloc(0),
        };
      }

      return {
        statusCode: 200,
        statusMessage: "",
        responseTypeName: GET_EXCHANGE_RATE_RESPONSE,
        responsePayloadBuffer: encodePayload(
          types.tokenGetExchangeRateResponse,
          {
            lux_per_token: { units: 1, nanos: 0 },
            token_per_lux: {
              denom: FRONTIER_TOKEN_DENOMINATION,
              value: "1",
            },
          },
        ),
      };
    },
  };
}

module.exports = {
  FRONTIER_TOKEN_DENOMINATION,
  GET_EXCHANGE_RATE_REQUEST,
  GET_EXCHANGE_RATE_RESPONSE,
  createFrontierTokenExchangeGatewayService,
};
