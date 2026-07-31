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
