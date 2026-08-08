"use strict";

const path = require("path");

const {
  bufferFromBytes,
  encodePayload,
  getActiveCharacterID,
} = require("./gatewayServiceHelpers");
const {
  getFrontierCoreProtoTypes,
} = require("./frontierCoreProto");
const GET_BALANCE_REQUEST = "eve_public.wallet.api.GetBalanceRequest";
const GET_BALANCE_RESPONSE = "eve_public.wallet.api.GetBalanceResponse";
const FRONTIER_TOKEN_DENOMINATION = "EVE";

function formatTokenValue(value) {
  const numericValue = Number(value || 0);
  if (!Number.isFinite(numericValue)) {
    return "0";
  }
  return String(numericValue);
}

function createFrontierWalletGatewayService(context = {}) {
  const types = getFrontierCoreProtoTypes();
  const getCharacterWallet =
    context.getFrontierCharacterWallet || require(path.join(
      __dirname,
      "../../../services/account/walletState",
    )).getCharacterWallet;

  return {
    name: "frontier-wallet",
    handledRequestTypes: [GET_BALANCE_REQUEST],
    getEmptySuccessResponseType(requestTypeName) {
      return requestTypeName === GET_BALANCE_REQUEST
        ? GET_BALANCE_RESPONSE
        : null;
    },
    handleRequest(requestTypeName, requestEnvelope) {
      if (requestTypeName !== GET_BALANCE_REQUEST) {
        return null;
      }
      try {
        types.walletGetBalanceRequest.decode(
          bufferFromBytes(
            requestEnvelope &&
              requestEnvelope.payload &&
              requestEnvelope.payload.value,
          ),
        );
      } catch (error) {
        return {
          statusCode: 400,
          statusMessage: "INVALID_WALLET_REQUEST",
          responseTypeName: GET_BALANCE_RESPONSE,
          responsePayloadBuffer: Buffer.alloc(0),
        };
      }

      const characterID = getActiveCharacterID(requestEnvelope);
      const wallet = characterID > 0 ? getCharacterWallet(characterID) : null;
      if (!wallet) {
        return {
          statusCode: characterID > 0 ? 404 : 403,
          statusMessage: characterID > 0
            ? "WALLET_NOT_FOUND"
            : "ACCESS_DENIED",
          responseTypeName: GET_BALANCE_RESPONSE,
          responsePayloadBuffer: Buffer.alloc(0),
        };
      }

      return {
        statusCode: 200,
        statusMessage: "",
        responseTypeName: GET_BALANCE_RESPONSE,
        responsePayloadBuffer: encodePayload(
          types.walletGetBalanceResponse,
          {
            balance: {
              denom: FRONTIER_TOKEN_DENOMINATION,
              value: formatTokenValue(wallet.balance),
            },
          },
        ),
      };
    },
  };
}

module.exports = {
  FRONTIER_TOKEN_DENOMINATION,
  GET_BALANCE_REQUEST,
  GET_BALANCE_RESPONSE,
  createFrontierWalletGatewayService,
  formatTokenValue,
};
