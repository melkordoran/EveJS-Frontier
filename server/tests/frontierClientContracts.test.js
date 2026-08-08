const assert = require("node:assert/strict");
const test = require("node:test");

const {
  getFrontierCoreProtoTypes,
} = require("../src/_secondary/express/gatewayServices/frontierCoreProto");
const {
  FRONTIER_TOKEN_DENOMINATION,
  createFrontierWalletGatewayService,
} = require(
  "../src/_secondary/express/gatewayServices/frontierWalletGatewayService"
);
const {
  createFrontierTokenExchangeGatewayService,
} = require(
  "../src/_secondary/express/gatewayServices/frontierTokenExchangeGatewayService"
);
const KisnService = require("../src/services/frontier/kisnService");

function requestEnvelope(characterID, payloadBuffer = Buffer.alloc(0)) {
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

test("Frontier legacy chat membership uses build 3450341 field names", () => {
  const types = getFrontierCoreProtoTypes();
  const payload = {
    solar_system: { sequential: 30021998 },
    characters: [
      { sequential: 140000005 },
      { sequential: 140000006 },
    ],
  };
  const encoded = types.chatGetMembershipResponse.encode(payload).finish();
  const decoded = types.chatGetMembershipResponse.toObject(
    types.chatGetMembershipResponse.decode(encoded),
    { longs: Number },
  );

  assert.deepEqual(
    decoded.characters.map((entry) => entry.sequential),
    [140000005, 140000006],
  );
  assert.equal(decoded.solar_system.sequential, 30021998);
});

test("Frontier wallet gateway returns an EVE token amount", () => {
  const types = getFrontierCoreProtoTypes();
  const service = createFrontierWalletGatewayService({
    getFrontierCharacterWallet(characterID) {
      return characterID === 140000005 ? { balance: 12345.5 } : null;
    },
  });
  const request = types.walletGetBalanceRequest.encode({
    wallet: { hex: "0xabc" },
  }).finish();
  const response = service.handleRequest(
    "eve_public.wallet.api.GetBalanceRequest",
    requestEnvelope(140000005, request),
  );
  const decoded = types.walletGetBalanceResponse.decode(
    response.responsePayloadBuffer,
  );

  assert.equal(response.statusCode, 200);
  assert.equal(decoded.balance.denom, FRONTIER_TOKEN_DENOMINATION);
  assert.equal(decoded.balance.value, "12345.5");
});

test("Frontier token exchange returns a deterministic local rate", () => {
  const types = getFrontierCoreProtoTypes();
  const service = createFrontierTokenExchangeGatewayService();
  const request = types.tokenGetExchangeRateRequest.encode({}).finish();
  const response = service.handleRequest(
    "eve_public.token.exchange.api.GetExchangeRateRequest",
    requestEnvelope(140000005, request),
  );
  const decoded = types.tokenGetExchangeRateResponse.toObject(
    types.tokenGetExchangeRateResponse.decode(response.responsePayloadBuffer),
    { longs: Number },
  );

  assert.equal(response.statusCode, 200);
  assert.equal(decoded.lux_per_token.units, 1);
  assert.equal(decoded.lux_per_token.nanos, 0);
  assert.equal(decoded.token_per_lux.denom, FRONTIER_TOKEN_DENOMINATION);
  assert.equal(decoded.token_per_lux.value, "1");
});

test("KISN exposes a stable nullable string to the character sheet", () => {
  const service = new KisnService();
  assert.equal(
    service.Handle_get_serial_number([], { charid: 140000005 }),
    "140000005",
  );
  assert.equal(service.Handle_get_serial_number([], {}), null);
});
