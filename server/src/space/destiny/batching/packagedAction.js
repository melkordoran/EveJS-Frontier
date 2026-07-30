const path = require("path");

// Park packaging behavior is adapted from carbonengine/destiny v3.1.1.
// Copyright (c) 2026 CCP Games; MIT terms are in batching/README.md.

const { marshalDecodeExact, marshalEncode } = require(path.join(
  __dirname,
  "../../../network/tcp/utils/marshal",
));

const PACKAGED_ACTION_NAME = "PackagedAction";

function toStamp(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) >>> 0 : fallback >>> 0;
}

function normalizePackagedUpdate(update, fallbackStamp = 0) {
  if (Array.isArray(update) && update.length >= 2) {
    return [
      toStamp(update[0], fallbackStamp),
      update[1],
    ];
  }
  return [
    toStamp(update && update.stamp, fallbackStamp),
    update && update.payload,
  ];
}

function decodeSerializedActions(serializedActions) {
  if (!Buffer.isBuffer(serializedActions)) {
    throw new TypeError("serializedActions must be a Buffer");
  }
  if (serializedActions.length === 0) {
    throw new TypeError("serializedActions must contain a marshal stream");
  }

  let actions;
  try {
    actions = marshalDecodeExact(serializedActions);
  } catch (error) {
    throw new TypeError("serializedActions must contain a valid marshal stream", {
      cause: error,
    });
  }
  if (!Array.isArray(actions)) {
    throw new TypeError("serializedActions must decode to an action sequence");
  }
  for (const update of actions) {
    const stamp = update && update[0];
    const payload = update && update[1];
    const name = payload && payload[0];
    const validStamp = (
      typeof stamp === "number" &&
      Number.isInteger(stamp) &&
      stamp >= 0 &&
      stamp <= 0xffff_ffff
    ) || (
      typeof stamp === "bigint" &&
      stamp >= 0n &&
      stamp <= 0xffff_ffffn
    );
    const validName = (
      typeof name === "string" && name.length > 0
    ) || (
      Buffer.isBuffer(name) && name.length > 0
    );
    if (
      !Array.isArray(update) ||
      update.length !== 2 ||
      !validStamp ||
      !Array.isArray(payload) ||
      payload.length !== 2 ||
      !validName
    ) {
      throw new TypeError("serializedActions contains a malformed packaged update");
    }
  }
  return actions;
}

function buildPackagedActionPayload(serializedActionsOrUpdates, options = {}) {
  const serializedActions = Array.isArray(serializedActionsOrUpdates)
    ? marshalEncode(
      serializedActionsOrUpdates
        .filter(Boolean)
        .map((update) => normalizePackagedUpdate(
          update,
          toStamp(options && options.stamp, 0),
        )),
    )
    : serializedActionsOrUpdates;
  decodeSerializedActions(serializedActions);
  return [PACKAGED_ACTION_NAME, serializedActions];
}

function buildPackagedActionUpdate(stamp, updates) {
  return {
    stamp: toStamp(stamp, 0),
    payload: buildPackagedActionPayload(updates, { stamp }),
  };
}

function inspectPackagedActionPayload(payload) {
  if (
    !Array.isArray(payload) ||
    payload.length !== 2 ||
    payload[0] !== PACKAGED_ACTION_NAME ||
    !Buffer.isBuffer(payload[1])
  ) {
    return null;
  }

  try {
    return {
      serializedActions: payload[1],
      actions: decodeSerializedActions(payload[1]),
    };
  } catch (_error) {
    return null;
  }
}

function isPackagedActionPayload(payload) {
  return inspectPackagedActionPayload(payload) !== null;
}

module.exports = {
  PACKAGED_ACTION_NAME,
  buildPackagedActionPayload,
  buildPackagedActionUpdate,
  decodeSerializedActions,
  inspectPackagedActionPayload,
  isPackagedActionPayload,
  normalizePackagedUpdate,
};
