"use strict";

const {
  getEntityIDText,
  normalizeEntityID,
  toJSONSafeEntityID,
} = require("../identity/entityID");
const {
  getPayloadPrimaryEntityID,
} = require("./payloadIdentity");
const {
  canonicalizePayloadName,
  getCanonicalPayloadName,
  getPayloadName,
  isDestinyPayload,
  isKnownPayloadName,
} = require("./payloads");

function describePayloadArguments(value) {
  if (Buffer.isBuffer(value)) {
    return {
      kind: "buffer",
      byteLength: value.length,
    };
  }
  if (Array.isArray(value)) {
    return {
      kind: "array",
      length: value.length,
    };
  }
  if (value === null) {
    return { kind: "null" };
  }
  return { kind: typeof value };
}

function summarizePayloadForDiagnostics(payload) {
  const name = getPayloadName(payload);
  const canonicalName = getCanonicalPayloadName(payload);
  const primaryEntityID = getPayloadPrimaryEntityID(payload);
  let args;
  try {
    args = Array.isArray(payload) && payload.length > 1
      ? payload[1]
      : undefined;
  } catch (_error) {
    args = undefined;
  }

  return {
    name,
    canonicalName,
    known: name !== null && isKnownPayloadName(name),
    valid: isDestinyPayload(payload),
    primaryEntityID:
      primaryEntityID === null ? null : toJSONSafeEntityID(primaryEntityID),
    arguments: describePayloadArguments(args),
  };
}

function defaultToInt(value, fallback = 0) {
  const number = Number(value);
  if (Number.isFinite(number)) {
    return Math.trunc(number);
  }
  const fallbackNumber = Number(fallback);
  return Number.isFinite(fallbackNumber) ? Math.trunc(fallbackNumber) : 0;
}

function defaultRoundNumber(value, decimals = 1) {
  const factor = 10 ** decimals;
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number * factor) / factor : 0;
}

function defaultUnwrapMarshalNumber(value, fallback = 0) {
  let candidate = value;
  if (candidate && typeof candidate === "object" && candidate.type === "real") {
    candidate = candidate.value;
  }
  const number = Number(candidate);
  return Number.isFinite(number) ? number : fallback;
}

function defaultGetMarshalListItems(value) {
  if (Array.isArray(value)) {
    return value;
  }
  if (
    value &&
    typeof value === "object" &&
    value.type === "list" &&
    Array.isArray(value.items)
  ) {
    return value.items;
  }
  return [];
}

function defaultLimitTraceArray(values, limit = 20) {
  const items = Array.isArray(values) ? values : [];
  if (items.length <= limit) {
    return items;
  }
  return [...items.slice(0, limit), `[+${items.length - limit} more]`];
}

function createDestinyPayloadSummary(deps = {}) {
  const toInt = typeof deps.toInt === "function" ? deps.toInt : defaultToInt;
  const roundNumber = typeof deps.roundNumber === "function"
    ? deps.roundNumber
    : defaultRoundNumber;
  const unwrapMarshalNumber = typeof deps.unwrapMarshalNumber === "function"
    ? deps.unwrapMarshalNumber
    : defaultUnwrapMarshalNumber;
  const getMarshalListItems = typeof deps.getMarshalListItems === "function"
    ? deps.getMarshalListItems
    : defaultGetMarshalListItems;
  const limitTraceArray = typeof deps.limitTraceArray === "function"
    ? deps.limitTraceArray
    : defaultLimitTraceArray;
  const normalizeTraceValue = typeof deps.normalizeTraceValue === "function"
    ? deps.normalizeTraceValue
    : (value) => value;
  const dependencyNormalizer = typeof deps.normalizeEntityID === "function"
    ? deps.normalizeEntityID
    : null;

  function getPrimaryEntityID(payload, options = {}) {
    const optionNormalizer = (
      options &&
      typeof options === "object" &&
      typeof options.normalizeEntityID === "function"
    )
      ? options.normalizeEntityID
      : dependencyNormalizer;
    return getPayloadPrimaryEntityID(payload, optionNormalizer
      ? { normalizeEntityID: optionNormalizer }
      : {});
  }

  function summarizeEntityID(value) {
    try {
      const normalizedCandidate = dependencyNormalizer
        ? dependencyNormalizer(value)
        : value;
      const entityID = normalizeEntityID(normalizedCandidate);
      if (entityID === null || entityID === 0 || entityID === 0n) {
        return 0;
      }
      return toJSONSafeEntityID(entityID);
    } catch (_error) {
      return 0;
    }
  }

  function summarizePositiveEntityID(value) {
    try {
      const normalizedCandidate = dependencyNormalizer
        ? dependencyNormalizer(value)
        : value;
      const entityID = normalizeEntityID(normalizedCandidate, {
        preferBigInt: true,
      });
      return entityID !== null && entityID > 0n
        ? toJSONSafeEntityID(entityID)
        : 0;
    } catch (_error) {
      return 0;
    }
  }

  function normalizeSummaryEntityID(value) {
    try {
      const normalizedCandidate = dependencyNormalizer
        ? dependencyNormalizer(value)
        : value;
      const entityID = normalizeEntityID(normalizedCandidate);
      return entityID === null ? null : toJSONSafeEntityID(entityID);
    } catch (_error) {
      return null;
    }
  }

  function getMarshalDictEntry(value, key) {
    if (!value || typeof value !== "object") {
      return undefined;
    }
    try {
      if (
        !Array.isArray(value) &&
        value.type !== "dict" &&
        Object.prototype.hasOwnProperty.call(value, key)
      ) {
        return value[key];
      }
      if (
        value.type === "dict" &&
        Array.isArray(value.entries)
      ) {
        const entry = value.entries.find(
          (candidate) => Array.isArray(candidate) && candidate[0] === key,
        );
        return entry ? entry[1] : undefined;
      }
      if (value.args && value.args !== value) {
        return getMarshalDictEntry(value.args, key);
      }
    } catch (_error) {
      return undefined;
    }
    return undefined;
  }

  function extractSlimItemIdentity(slimEntry) {
    const slimItem = Array.isArray(slimEntry) ? slimEntry[0] : slimEntry;
    let rawItemID;
    let rawTypeID;
    try {
      rawItemID = (
        slimItem &&
        typeof slimItem === "object" &&
        Object.prototype.hasOwnProperty.call(slimItem, "itemID")
      )
        ? slimItem.itemID
        : getMarshalDictEntry(slimItem, "itemID");
      rawTypeID = (
        slimItem &&
        typeof slimItem === "object" &&
        Object.prototype.hasOwnProperty.call(slimItem, "typeID")
      )
        ? slimItem.typeID
        : getMarshalDictEntry(slimItem, "typeID");
    } catch (_error) {
      rawItemID = undefined;
      rawTypeID = undefined;
    }
    return {
      itemID: normalizeSummaryEntityID(rawItemID),
      typeID: toInt(rawTypeID, 0),
    };
  }

  function summarizeAddBalls2Args(args) {
    return getMarshalListItems(args).map((batchEntry, index) => {
      const stateBuffer = Array.isArray(batchEntry) ? batchEntry[0] : null;
      const slimEntries = getMarshalListItems(
        Array.isArray(batchEntry) ? batchEntry[1] : null,
      );
      const slimIDs = slimEntries
        .map(extractSlimItemIdentity)
        .filter((entry) => entry.itemID !== null);
      return {
        batchIndex: index,
        stateStamp:
          Buffer.isBuffer(stateBuffer) && stateBuffer.length >= 5
            ? (stateBuffer.readUInt32LE(1) >>> 0)
            : 0,
        entityCount: slimIDs.length,
        entityIDs: limitTraceArray(
          slimIDs.map((entry) => entry.itemID),
          25,
        ),
        typeIDs: limitTraceArray(
          slimIDs.map((entry) => entry.typeID).filter((value) => value > 0),
          12,
        ),
      };
    });
  }

  function summarizeSetStateArgs(args) {
    const state = Array.isArray(args) ? args[0] : null;
    const slims = getMarshalListItems(getMarshalDictEntry(state, "slims"));
    const slimIDs = slims
      .map(extractSlimItemIdentity)
      .filter((entry) => entry.itemID !== null);
    const damageState = getMarshalDictEntry(state, "damageState");
    const damageStateEntityIDs = (
      damageState &&
      damageState.type === "dict" &&
      Array.isArray(damageState.entries)
    )
      ? damageState.entries
        .map((entry) => normalizeSummaryEntityID(
          Array.isArray(entry) ? entry[0] : null,
        ))
        .filter((entityID) => entityID !== null)
      : [];
    return [{
      stamp: toInt(getMarshalDictEntry(state, "stamp"), 0) >>> 0,
      ego: summarizeEntityID(getMarshalDictEntry(state, "ego")),
      slimCount: slimIDs.length,
      slimIDs: limitTraceArray(
        slimIDs.map((entry) => entry.itemID),
        25,
      ),
      damageStateEntityIDs: limitTraceArray(damageStateEntityIDs, 25),
    }];
  }

  function summarizeDestinyArgs(name, args) {
    const canonicalName = canonicalizePayloadName(name);
    const payload = [name, args];
    if (canonicalName === null || !isDestinyPayload(payload)) {
      return null;
    }

    switch (canonicalName) {
      case "GotoDirection":
      case "GotoPoint":
      case "SetBallAngularVelocity":
      case "SetBallPosition":
      case "SetBallVelocity":
      case "SetMaxAngularVelocity":
        if (getPrimaryEntityID(payload) === null) {
          return null;
        }
        return [
          summarizeEntityID(args[0]),
          roundNumber(unwrapMarshalNumber(args[1], 0)),
          roundNumber(unwrapMarshalNumber(args[2], 0)),
          roundNumber(unwrapMarshalNumber(args[3], 0)),
        ];
      case "SetSpeedFraction":
        if (getPrimaryEntityID(payload) === null) {
          return null;
        }
        return [
          summarizeEntityID(args[0]),
          roundNumber(unwrapMarshalNumber(args[1], 0), 3),
        ];
      case "FollowBall":
      case "Orbit":
        if (getPrimaryEntityID(payload) === null) {
          return null;
        }
        return [
          summarizeEntityID(args[0]),
          summarizeEntityID(args[1]),
          roundNumber(args[2]),
        ];
      case "Stop":
        if (getPrimaryEntityID(payload) === null) {
          return null;
        }
        return [summarizeEntityID(args[0])];
      case "LaunchMissile":
        if (getPrimaryEntityID(payload) === null) {
          return null;
        }
        return [
          summarizeEntityID(args[0]),
          summarizeEntityID(args[1]),
          summarizeEntityID(args[2]),
          toInt(args[3], 0),
          toInt(args[4], 0),
        ];
      case "WarpTo":
        if (getPrimaryEntityID(payload) === null) {
          return null;
        }
        return [
          summarizeEntityID(args[0]),
          roundNumber(unwrapMarshalNumber(args[1], 0)),
          roundNumber(unwrapMarshalNumber(args[2], 0)),
          roundNumber(unwrapMarshalNumber(args[3], 0)),
          roundNumber(unwrapMarshalNumber(args[4], 0)),
          toInt(args[5], 0),
        ];
      case "AddBall":
        if (getPrimaryEntityID(payload) === null) {
          return null;
        }
        return [
          summarizeEntityID(args[0]),
          roundNumber(unwrapMarshalNumber(args[1], 0)),
          roundNumber(unwrapMarshalNumber(args[2], 0)),
          roundNumber(unwrapMarshalNumber(args[3], 0)),
          toInt(args[4], 0),
          toInt(args[5], 0),
          toInt(args[6], 0),
          toInt(args[7], 0),
          toInt(args[8], 0),
          roundNumber(unwrapMarshalNumber(args[9], 0)),
          roundNumber(unwrapMarshalNumber(args[10], 0)),
          roundNumber(unwrapMarshalNumber(args[11], 0)),
          roundNumber(unwrapMarshalNumber(args[12], 0)),
          roundNumber(unwrapMarshalNumber(args[13], 0)),
          roundNumber(unwrapMarshalNumber(args[14], 0)),
          roundNumber(unwrapMarshalNumber(args[15], 0), 3),
          roundNumber(unwrapMarshalNumber(args[16], 0), 3),
        ];
      case "AddBalls2":
        return summarizeAddBalls2Args(args);
      case "SetState":
        return summarizeSetStateArgs(args);
      case "OnDamageStateChange":
        if (getPrimaryEntityID(payload) === null) {
          return null;
        }
        return [summarizeEntityID(args[0]), normalizeTraceValue(args[1])];
      case "OnDbuffUpdated":
        if (getPrimaryEntityID(payload) === null) {
          return null;
        }
        return [{
          entityID: summarizeEntityID(args[0]),
          dbuffCollectionIDs: getMarshalListItems(args[1])
            .map((entry) => toInt(Array.isArray(entry) ? entry[0] : 0, 0))
            .filter((value) => value > 0),
        }];
      case "RemoveBalls": {
        const entityIDs = getMarshalListItems(args[0])
          .map(summarizePositiveEntityID)
          .filter((entityID) => entityID !== 0);
        return [{
          entityCount: entityIDs.length,
          entityIDs: limitTraceArray(entityIDs, 30),
        }];
      }
      default:
        return Array.isArray(args) ? args.slice() : args;
    }
  }

  return {
    getPayloadPrimaryEntityID: getPrimaryEntityID,
    summarizeDestinyArgs,
  };
}

function normalizeDiagnosticStamp(value) {
  try {
    if (typeof value === "bigint") {
      return Number(BigInt.asUintN(32, value));
    }
    if (typeof value === "string") {
      const text = value.trim();
      if (!/^-?\d+$/.test(text)) {
        return null;
      }
      return Number(BigInt.asUintN(32, BigInt(text)));
    }
    if (!Number.isSafeInteger(value)) {
      return null;
    }
    return value >>> 0;
  } catch (_error) {
    return null;
  }
}

function getUpdatePayload(update) {
  if (Array.isArray(update)) {
    return update;
  }
  try {
    return update && Array.isArray(update.payload) ? update.payload : null;
  } catch (_error) {
    return null;
  }
}

function getUpdateStamp(update) {
  if (!update || Array.isArray(update) || typeof update !== "object") {
    return null;
  }
  try {
    return Object.prototype.hasOwnProperty.call(update, "stamp")
      ? normalizeDiagnosticStamp(update.stamp)
      : null;
  } catch (_error) {
    return null;
  }
}

function summarizeUpdatesForDiagnostics(updates = []) {
  if (!Array.isArray(updates)) {
    return {
      count: 0,
      names: [],
      uniqueNames: [],
      stamps: [],
      entityIDs: [],
      updates: [],
    };
  }

  const names = [];
  const stamps = [];
  const entityIDs = [];
  const identityTexts = new Set();
  const updateSummaries = [];

  for (const update of updates) {
    const payloadSummary = summarizePayloadForDiagnostics(getUpdatePayload(update));
    const name = payloadSummary.name || "unknown";
    const stamp = getUpdateStamp(update);
    const updateEntityIDs = payloadSummary.primaryEntityID === null
      ? []
      : [payloadSummary.primaryEntityID];

    names.push(name);
    if (stamp !== null && !stamps.includes(stamp)) {
      stamps.push(stamp);
    }
    for (const entityID of updateEntityIDs) {
      const identityText = getEntityIDText(entityID);
      if (identityText !== null && !identityTexts.has(identityText)) {
        identityTexts.add(identityText);
        entityIDs.push(entityID);
      }
    }
    updateSummaries.push({
      ...payloadSummary,
      name,
      stamp,
      entityIDs: updateEntityIDs,
    });
  }

  return {
    count: updateSummaries.length,
    names,
    uniqueNames: [...new Set(names)],
    stamps,
    entityIDs,
    updates: updateSummaries,
  };
}

module.exports = {
  createDestinyPayloadSummary,
  describePayloadArguments,
  normalizeDiagnosticStamp,
  summarizePayloadForDiagnostics,
  summarizeUpdatesForDiagnostics,
};
