"use strict";

const { marshalEncode } = require("./utils/marshal");

function usesNoOpHandshakeSignedFunc(profile) {
  return String(profile || "").trim().toLowerCase() === "frontier";
}

function selectHandshakeSignedFunc(profile, noOpPayload, legacyFactory) {
  if (usesNoOpHandshakeSignedFunc(profile)) {
    return {
      type: "frontier-bytes",
      value: noOpPayload,
    };
  }
  return legacyFactory();
}

function selectVersionExchangeRelease(
  profile,
  legacyProjectVersion,
  projectCodename,
  projectRegion,
) {
  if (usesNoOpHandshakeSignedFunc(profile)) {
    return {
      type: "frontier-string",
      value: `${projectCodename}@${projectRegion}`,
    };
  }
  return legacyProjectVersion;
}

function crcHqx(buffer, initial = 0) {
  let crc = Number(initial) & 0xffff;
  for (const byte of buffer) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc =
        crc & 0x8000
          ? ((crc << 1) ^ 0x1021) & 0xffff
          : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

function selectPlaceboChallengeResponseHash(profile, clientChallenge) {
  if (!usesNoOpHandshakeSignedFunc(profile)) {
    return "55087";
  }

  const marshaledArgs = marshalEncode([clientChallenge], {
    compatibilityProfile: profile,
  });
  return String(crcHqx(marshaledArgs, 0));
}

module.exports = {
  crcHqx,
  selectHandshakeSignedFunc,
  selectPlaceboChallengeResponseHash,
  selectVersionExchangeRelease,
  usesNoOpHandshakeSignedFunc,
};
