"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  crcHqx,
  selectHandshakeSignedFunc,
  selectPlaceboChallengeResponseHash,
  selectVersionExchangeRelease,
  usesNoOpHandshakeSignedFunc,
} = require("../src/network/tcp/handshakeCompatibility");
const {
  framePayload,
  readPacketLength,
  usesBigEndianPacketLengths,
} = require("../src/network/tcp/packetFraming");
const {
  marshalDecode,
  marshalEncode,
} = require("../src/network/tcp/utils/marshal");
const { decodePacket } = require("../src/common/pyPacket");
const { encodeAddress } = require("../src/common/machoAddress");

test("Frontier handshake sends a no-op signed function", () => {
  const noOp = Buffer.from("no-op");
  const payload = selectHandshakeSignedFunc(
    "frontier",
    noOp,
    () => Buffer.from("legacy"),
  );
  assert.equal(usesNoOpHandshakeSignedFunc("frontier"), true);
  assert.deepEqual(payload, {
    type: "frontier-bytes",
    value: noOp,
  });
  const encoded = marshalEncode(payload, {
    compatibilityProfile: "frontier",
  });
  assert.equal(encoded[5], 0x13);
  assert.deepEqual(
    marshalDecode(encoded, { compatibilityProfile: "frontier" }),
    noOp,
  );
});

test("Tranquility handshake preserves the existing TiDi signed function", () => {
  const legacy = Buffer.from("legacy");
  const payload = selectHandshakeSignedFunc(
    "tranquility",
    Buffer.from("no-op"),
    () => legacy,
  );
  assert.equal(usesNoOpHandshakeSignedFunc("tranquility"), false);
  assert.deepEqual(payload, legacy);
});

test("Frontier version exchange uses the client codename and region", () => {
  assert.deepEqual(
    selectVersionExchangeRelease(
      "frontier",
      "V20.04@ccp",
      "cycle-6",
      "ccp",
    ),
    {
      type: "frontier-string",
      value: "cycle-6@ccp",
    },
  );
});

test("Frontier release text uses the Python 3 UTF-8 string dialect", () => {
  const encoded = marshalEncode({
    type: "frontier-string",
    value: "cycle-6@ccp",
  });
  const decoded = marshalDecode(encoded, {
    compatibilityProfile: "frontier",
  });

  assert.equal(encoded[5], 0x12);
  assert.equal(encoded[6], Buffer.byteLength("cycle-6@ccp", "utf8"));
  assert.deepEqual(encoded.subarray(7, 9), Buffer.from("cy"));
  assert.equal(decoded, "cycle-6@ccp");
});

test("Frontier profile encodes ordinary dictionary text as Python 3 strings", () => {
  const encoded = marshalEncode(
    {
      type: "dict",
      entries: [["challenge_responsehash", "55087"]],
    },
    { compatibilityProfile: "frontier" },
  );
  const decoded = marshalDecode(encoded, {
    compatibilityProfile: "frontier",
  });

  assert.deepEqual(decoded, {
    type: "dict",
    entries: [["challenge_responsehash", "55087"]],
  });
  assert.equal(encoded.includes(Buffer.from("challenge_responsehash")), true);
});

test("Frontier Placebo challenge hash follows its Python 3 marshal dialect", () => {
  assert.equal(
    selectPlaceboChallengeResponseHash("frontier", "\0".repeat(64)),
    "39856",
  );
  assert.equal(crcHqx(Buffer.from("123456789"), 0), 12739);
});

test("Frontier binary payloads use the Python 3 bytes opcode", () => {
  const payload = Buffer.from([0x7e, 0x00, 0xc4, 0xff]);
  const encoded = marshalEncode(payload, {
    compatibilityProfile: "frontier",
  });

  assert.equal(encoded[5], 0x13);
  assert.deepEqual(
    marshalDecode(encoded, { compatibilityProfile: "frontier" }),
    payload,
  );
});

test("Tranquility binary payloads preserve the legacy buffer opcode", () => {
  const payload = Buffer.from([0x7e, 0x00, 0xc4, 0xff]);
  const encoded = marshalEncode(payload);

  assert.equal(encoded[5], 0x0d);
  assert.deepEqual(marshalDecode(encoded), payload);
});

test("Tranquility preserves the existing Placebo challenge hash", () => {
  assert.equal(
    selectPlaceboChallengeResponseHash(
      "tranquility",
      Buffer.alloc(64),
    ),
    "55087",
  );
});

test("Tranquility version exchange preserves the legacy project version", () => {
  assert.equal(
    selectVersionExchangeRelease(
      "tranquility",
      "V24.01@ccp",
      "EvEJS",
      "ccp",
    ),
    "V24.01@ccp",
  );
});

test("Frontier packets use big-endian length prefixes", () => {
  const payload = Buffer.alloc(514, 0x7e);
  const framed = framePayload(payload, "frontier");

  assert.equal(usesBigEndianPacketLengths("frontier"), true);
  assert.deepEqual(framed.subarray(0, 4), Buffer.from([0x00, 0x00, 0x02, 0x02]));
  assert.equal(readPacketLength(framed, "frontier"), 514);
  assert.deepEqual(framed.subarray(4), payload);
});

test("Tranquility packets preserve little-endian length prefixes", () => {
  const payload = Buffer.alloc(514, 0x7e);
  const framed = framePayload(payload, "tranquility");

  assert.equal(usesBigEndianPacketLengths("tranquility"), false);
  assert.deepEqual(framed.subarray(0, 4), Buffer.from([0x02, 0x02, 0x00, 0x00]));
  assert.equal(readPacketLength(framed, "tranquility"), 514);
});

test("Frontier named objects use the observed ObjectEx2 wire shape", () => {
  const state = [
    18,
    encodeAddress({
      type: "node",
      nodeID: 1,
      service: null,
      callID: 0,
    }),
    encodeAddress({
      type: "client",
      clientID: 0,
      service: null,
      callID: 0,
    }),
    3,
    [123, 5, { type: "dict", entries: [] }],
    { type: "dict", entries: [] },
  ];
  const encoded = marshalEncode(
    {
      type: "object",
      name: "carbon.common.script.net.machoNetPacket.SessionInitialStateNotification",
      args: state,
    },
    { compatibilityProfile: "frontier" },
  );
  const decoded = marshalDecode(encoded, {
    compatibilityProfile: "frontier",
  });

  assert.equal(encoded[5], 0x23);
  assert.deepEqual(decoded.header[0], [{
    type: "token",
    value:
      "carbon.common.script.net.machoNetPacket.SessionInitialStateNotification",
  }]);
  assert.equal(decoded.header[1][0], 18);
  assert.equal(decoded.header[1][1].type, "objectex2");
  assert.equal(decoded.header[1][2].type, "objectex2");
  assert.equal(decoded.header[1][3], 3);
  assert.deepEqual(decoded.header[1].slice(4), state.slice(4));
  assert.deepEqual(decoded.list, []);
  assert.deepEqual(decoded.dict, []);

  const packet = decodePacket(decoded);
  assert.equal(packet.type, 18);
  assert.equal(packet.source.type, "node");
  assert.equal(packet.dest.type, "client");
  assert.equal(packet.userID, 3);
});

test("Tranquility named objects preserve the legacy PyObject opcode", () => {
  const encoded = marshalEncode({
    type: "object",
    name: "macho.PingRsp",
    args: [1, 2, 3, null, [], { type: "dict", entries: [] }],
  });

  assert.equal(encoded[5], 0x17);
  assert.equal(marshalDecode(encoded).type, "object");
});

test("Frontier ObjectEx2 CallReq and MachoAddress decode as PyPacket", () => {
  const objectEx2 = (name, state) => ({
    type: "objectex2",
    header: [[{ type: "token", value: name }], state],
    list: [],
    dict: [],
  });
  const decoded = objectEx2(
    "carbon.common.script.net.machoNetPacket.CallReq",
    [
      6,
      objectEx2(
        "carbon.common.script.net.machoNetAddress.MachoAddress",
        [2, 0, 1, null],
      ),
      objectEx2(
        "carbon.common.script.net.machoNetAddress.MachoAddress",
        [1, 65450, "machoNet", null],
      ),
      3,
      [],
      { type: "dict", entries: [] },
    ],
  );

  const packet = decodePacket(decoded);
  assert.equal(packet.type, 6);
  assert.equal(packet.source.type, "client");
  assert.equal(packet.source.callID, 1);
  assert.equal(packet.dest.type, "node");
  assert.equal(packet.dest.service, "machoNet");
  assert.equal(packet.userID, 3);
});
