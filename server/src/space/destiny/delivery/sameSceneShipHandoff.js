"use strict";

const { createHash } = require("node:crypto");
const { serialize } = require("node:v8");

const {
  DESTINY_CONTRACTS,
} = require("../authority/destinyContracts");
const {
  entityIDsEqual,
  normalizeEntityID,
  requireEntityID,
} = require("../identity/entityID");
const {
  createDestinyDeliveryTransaction,
  isDestinyDeliveryTransactionGenerationCurrent,
} = require("./deliveryTransaction");
const {
  buildDestructionTeardownSendOptions,
} = require("./sendOptions");
const {
  advanceDestinyStamp,
  hasDestinyStamp,
  normalizeDestinyStamp,
} = require("./stamps");

const FOLLOWING_TEARDOWN_CAPABILITY_BRAND = Symbol(
  "destiny.followingTeardownCapability",
);
const FOLLOWING_TEARDOWN_HANDOFF_CAPABILITY = Symbol(
  "destiny.followingTeardownHandoffCapability",
);
const SAME_SCENE_SHIP_HANDOFF_CAPABILITY = Symbol(
  "destiny.sameSceneShipHandoffCapability",
);
const SAME_SCENE_SHIP_HANDOFF_CAPABILITY_BRAND = Symbol(
  "destiny.sameSceneShipHandoffCapabilityBrand",
);
const SAME_SCENE_SHIP_HANDOFF_AUTHORED_ACTION_FINGERPRINT = Symbol(
  "destiny.sameSceneShipHandoffAuthoredActionFingerprint",
);
const SAME_SCENE_SHIP_HANDOFF_AUTHORED_ACTION_PAYLOADS = Symbol(
  "destiny.sameSceneShipHandoffAuthoredActionPayloads",
);
const SAME_SCENE_SHIP_HANDOFF_DELIVERY_SCOPE = Symbol(
  "destiny.sameSceneShipHandoffDeliveryScope",
);
const SAME_SCENE_SHIP_HANDOFF_SCOPE_BINDING = Symbol(
  "destiny.sameSceneShipHandoffScopeBinding",
);
const SAME_SCENE_SHIP_HANDOFF_TRANSACTION_PROOF = Symbol(
  "destiny.sameSceneShipHandoffTransactionProof",
);

const SAME_SCENE_SHIP_HANDOFF_PAYLOAD_NAMES = Object.freeze([
  "SetBallInteractive",
  "Stop",
  "OnSlimItemChange",
  "SetMaxSpeed",
  "SetBallAgility",
  "SetBallInteractive",
  "OnSlimItemChange",
  "SetMaxSpeed",
  "SetBallAgility",
  "OnSlimItemChange",
]);

function freezeSameSceneShipHandoffAuthoredValue(
  value,
  visiting = new WeakSet(),
  frozen = new WeakSet(),
) {
  if (value === null || typeof value !== "object") {
    if (typeof value === "function" || typeof value === "symbol") {
      throw new TypeError(
        "same-scene ship handoff actions must be wire-shaped values",
      );
    }
    return value;
  }
  if (frozen.has(value)) {
    return value;
  }
  if (visiting.has(value)) {
    throw new TypeError(
      "same-scene ship handoff actions must not contain cycles",
    );
  }
  const prototype = Object.getPrototypeOf(value);
  if (
    !Array.isArray(value) &&
    prototype !== Object.prototype &&
    prototype !== null
  ) {
    throw new TypeError(
      "same-scene ship handoff actions must use plain wire objects",
    );
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new TypeError(
      "same-scene ship handoff actions must not contain symbol fields",
    );
  }

  visiting.add(value);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      !descriptor ||
      descriptor.get ||
      descriptor.set ||
      (
        descriptor.enumerable !== true &&
        !(Array.isArray(value) && key === "length")
      )
    ) {
      throw new TypeError(
        "same-scene ship handoff actions must use plain data fields",
      );
    }
    if (key !== "length") {
      freezeSameSceneShipHandoffAuthoredValue(
        descriptor.value,
        visiting,
        frozen,
      );
    }
  }
  visiting.delete(value);
  Object.freeze(value);
  frozen.add(value);
  return value;
}

function buildSameSceneShipHandoffActionFingerprint(
  updates,
  authoredStamp,
) {
  if (!Array.isArray(updates) || !hasDestinyStamp(authoredStamp)) {
    return null;
  }
  const normalizedAuthoredStamp = normalizeDestinyStamp(authoredStamp);
  try {
    const actionGroup = updates.map((update) => {
      if (
        !update ||
        typeof update !== "object" ||
        !Object.prototype.hasOwnProperty.call(update, "stamp") ||
        !Object.prototype.hasOwnProperty.call(update, "payload") ||
        !hasDestinyStamp(update.stamp) ||
        normalizeDestinyStamp(update.stamp) !== normalizedAuthoredStamp
      ) {
        throw new TypeError("invalid same-scene handoff action");
      }
      const ownKeys = Object.keys(update).sort();
      const hasAuthoredStamp = Object.prototype.hasOwnProperty.call(
        update,
        "authoredStamp",
      );
      const expectedKeys = hasAuthoredStamp
        ? ["authoredStamp", "payload", "stamp"]
        : ["payload", "stamp"];
      if (
        ownKeys.length !== expectedKeys.length ||
        ownKeys.some((key, index) => key !== expectedKeys[index]) ||
        (
          hasAuthoredStamp &&
          (
            !hasDestinyStamp(update.authoredStamp) ||
            normalizeDestinyStamp(update.authoredStamp) !==
              normalizedAuthoredStamp
          )
        )
      ) {
        throw new TypeError("mutated same-scene handoff action envelope");
      }
      return [normalizedAuthoredStamp, update.payload];
    });
    return createHash("sha256")
      .update(serialize(actionGroup))
      .digest("hex");
  } catch (_error) {
    return null;
  }
}

function resolveRootDestinyDeliveryTransaction(transaction) {
  let current = transaction || null;
  const visited = new Set();
  while (
    current &&
    current.mergedInto &&
    typeof current.mergedInto === "object" &&
    !visited.has(current)
  ) {
    visited.add(current);
    current = current.mergedInto;
  }
  return current;
}

function getSameSceneShipHandoffCapability(sendOptions = {}) {
  const capability =
    sendOptions && typeof sendOptions === "object"
      ? sendOptions[SAME_SCENE_SHIP_HANDOFF_CAPABILITY]
      : null;
  return capability &&
    typeof capability === "object" &&
    capability[SAME_SCENE_SHIP_HANDOFF_CAPABILITY_BRAND] === true &&
    typeof capability[
      SAME_SCENE_SHIP_HANDOFF_AUTHORED_ACTION_FINGERPRINT
    ] === "string" &&
    Array.isArray(
      capability[SAME_SCENE_SHIP_HANDOFF_AUTHORED_ACTION_PAYLOADS],
    )
    ? capability
    : null;
}

function getFollowingTeardownCapability(sendOptions = {}) {
  const capability =
    sendOptions && typeof sendOptions === "object"
      ? sendOptions.destinyAuthorityFollowingTeardown
      : null;
  if (
    !capability ||
    typeof capability !== "object" ||
    capability[FOLLOWING_TEARDOWN_CAPABILITY_BRAND] !== true ||
    !hasDestinyStamp(capability.afterStamp)
  ) {
    return null;
  }
  let entityID;
  try {
    entityID = requireEntityID(
      capability.entityID,
      "followingTeardown.entityID",
    );
  } catch (_error) {
    return null;
  }
  const handoffCapability =
    capability[FOLLOWING_TEARDOWN_HANDOFF_CAPABILITY];
  if (
    !handoffCapability ||
    handoffCapability[SAME_SCENE_SHIP_HANDOFF_CAPABILITY_BRAND] !== true ||
    !entityIDsEqual(entityID, handoffCapability.previousEntityID)
  ) {
    return null;
  }
  return {
    afterStamp: normalizeDestinyStamp(capability.afterStamp),
    entityID,
    handoffCapability,
  };
}

function buildSameSceneShipHandoffSendOptions(
  baseOptions = {},
  details = {},
) {
  if (!hasDestinyStamp(details.stamp)) {
    throw new TypeError("same-scene ship handoff requires a Destiny stamp");
  }
  freezeSameSceneShipHandoffAuthoredValue(details.updates);
  const authoredActionFingerprint =
    buildSameSceneShipHandoffActionFingerprint(
      details.updates,
      details.stamp,
    );
  if (!authoredActionFingerprint) {
    throw new TypeError(
      "same-scene ship handoff requires exact immutable authored actions",
    );
  }
  const authoredActionPayloads = Object.freeze(
    details.updates.map((update) => update.payload),
  );
  const capability = {
    authoredStamp: normalizeDestinyStamp(details.stamp),
    previousEntityID: requireEntityID(
      details.previousEntityID,
      "sameSceneShipHandoff.previousEntityID",
    ),
    boardedEntityID: requireEntityID(
      details.boardedEntityID,
      "sameSceneShipHandoff.boardedEntityID",
    ),
  };
  Object.defineProperties(capability, {
    [SAME_SCENE_SHIP_HANDOFF_CAPABILITY_BRAND]: {
      configurable: false,
      enumerable: false,
      value: true,
      writable: false,
    },
    [SAME_SCENE_SHIP_HANDOFF_AUTHORED_ACTION_FINGERPRINT]: {
      configurable: false,
      enumerable: false,
      value: authoredActionFingerprint,
      writable: false,
    },
    [SAME_SCENE_SHIP_HANDOFF_AUTHORED_ACTION_PAYLOADS]: {
      configurable: false,
      enumerable: false,
      value: authoredActionPayloads,
      writable: false,
    },
  });
  const sendOptions = {
    ...baseOptions,
    destinyAuthorityContract:
      DESTINY_CONTRACTS.CRITICAL_MOVEMENT_OR_SHIPPRIME,
  };
  Object.defineProperty(sendOptions, SAME_SCENE_SHIP_HANDOFF_CAPABILITY, {
    configurable: false,
    enumerable: false,
    value: Object.freeze(capability),
    writable: false,
  });
  return sendOptions;
}

function buildFollowingTeardownSendOptions(options = {}) {
  if (!hasDestinyStamp(options.afterStamp)) {
    throw new TypeError("following teardown requires an accepted afterStamp");
  }
  const handoffCapability = getSameSceneShipHandoffCapability(
    options.handoffSendOptions,
  );
  if (!handoffCapability) {
    throw new TypeError(
      "following teardown requires same-scene handoff provenance",
    );
  }
  const entityID = requireEntityID(
    options.entityID,
    "followingTeardown.entityID",
  );
  if (!entityIDsEqual(entityID, handoffCapability.previousEntityID)) {
    throw new TypeError(
      "following teardown entity must match the same-scene handoff",
    );
  }
  const capability = {
    afterStamp: normalizeDestinyStamp(options.afterStamp),
    entityID,
  };
  Object.defineProperties(capability, {
    [FOLLOWING_TEARDOWN_CAPABILITY_BRAND]: {
      configurable: false,
      enumerable: false,
      value: true,
      writable: false,
    },
    [FOLLOWING_TEARDOWN_HANDOFF_CAPABILITY]: {
      configurable: false,
      enumerable: false,
      value: handoffCapability,
      writable: false,
    },
  });
  return buildDestructionTeardownSendOptions({
    translateStamps: false,
    destinyAuthorityFollowingTeardown: Object.freeze(capability),
  });
}

function readFollowingTeardownCapability(sendOptions = {}) {
  const capability = getFollowingTeardownCapability(sendOptions);
  return capability
    ? {
        afterStamp: capability.afterStamp,
        entityID: capability.entityID,
      }
    : null;
}

function isLiveSameSceneShipHandoffScopeDetails(details) {
  const rootTransaction = resolveRootDestinyDeliveryTransaction(
    details && details.transaction,
  );
  return Boolean(
    details &&
    details.handoffCapability &&
    rootTransaction &&
    rootTransaction.state === "planning" &&
    isDestinyDeliveryTransactionGenerationCurrent(rootTransaction),
  );
}

function getSameSceneShipHandoffScopeDetails(scope) {
  const details =
    scope && typeof scope === "object"
      ? scope[SAME_SCENE_SHIP_HANDOFF_DELIVERY_SCOPE]
      : null;
  return isLiveSameSceneShipHandoffScopeDetails(details)
    ? details
    : null;
}

function getSameSceneShipHandoffScopeBinding(sendOptions) {
  const details =
    sendOptions && typeof sendOptions === "object"
      ? sendOptions[SAME_SCENE_SHIP_HANDOFF_SCOPE_BINDING]
      : null;
  return isLiveSameSceneShipHandoffScopeDetails(details)
    ? details
    : null;
}

function createSameSceneShipHandoffDeliveryScope(
  session,
  handoffSendOptions,
) {
  const handoffCapability = getSameSceneShipHandoffCapability(
    handoffSendOptions,
  );
  if (!handoffCapability || !session || !session._space) {
    throw new TypeError(
      "same-scene ship handoff delivery requires one live generation",
    );
  }
  const details = Object.freeze({
    handoffCapability,
    transaction: createDestinyDeliveryTransaction(session, {}),
  });
  const scope = {};
  Object.defineProperty(scope, SAME_SCENE_SHIP_HANDOFF_DELIVERY_SCOPE, {
    configurable: false,
    enumerable: false,
    value: details,
    writable: false,
  });
  return Object.freeze(scope);
}

function resolveSendOptionsHandoffCapability(sendOptions) {
  const handoffCapability = getSameSceneShipHandoffCapability(sendOptions);
  if (handoffCapability) {
    return handoffCapability;
  }
  const followingCapability = getFollowingTeardownCapability(sendOptions);
  return followingCapability && followingCapability.handoffCapability;
}

function bindSameSceneShipHandoffDeliveryDetails(
  capabilitySource,
  enumerableOptions,
  details,
) {
  const sourceHandoffCapability = resolveSendOptionsHandoffCapability(
    capabilitySource,
  );
  if (
    !details ||
    !sourceHandoffCapability ||
    sourceHandoffCapability !== details.handoffCapability ||
    !isLiveSameSceneShipHandoffScopeDetails(details)
  ) {
    throw new TypeError(
      "same-scene ship handoff delivery scope does not match send options",
    );
  }

  const nextOptions = {
    ...(enumerableOptions && typeof enumerableOptions === "object"
      ? enumerableOptions
      : {}),
  };
  if (getSameSceneShipHandoffCapability(capabilitySource)) {
    Object.defineProperty(nextOptions, SAME_SCENE_SHIP_HANDOFF_CAPABILITY, {
      configurable: false,
      enumerable: false,
      value: sourceHandoffCapability,
      writable: false,
    });
  } else {
    const followingCapability = getFollowingTeardownCapability(nextOptions);
    if (
      !followingCapability ||
      followingCapability.handoffCapability !== sourceHandoffCapability
    ) {
      throw new TypeError(
        "same-scene ship handoff teardown provenance was replaced",
      );
    }
  }
  Object.defineProperties(nextOptions, {
    _deliveryTransaction: {
      configurable: true,
      enumerable: false,
      value: details.transaction,
      writable: false,
    },
    [SAME_SCENE_SHIP_HANDOFF_SCOPE_BINDING]: {
      configurable: false,
      enumerable: false,
      value: details,
      writable: false,
    },
  });
  return nextOptions;
}

function bindSameSceneShipHandoffDeliveryScope(
  sendOptions,
  scope,
  overrides = {},
) {
  return bindSameSceneShipHandoffDeliveryDetails(
    sendOptions,
    {
      ...(sendOptions && typeof sendOptions === "object" ? sendOptions : {}),
      ...(overrides && typeof overrides === "object" ? overrides : {}),
    },
    getSameSceneShipHandoffScopeDetails(scope),
  );
}

function inheritSameSceneShipHandoffDeliveryScope(
  sourceOptions,
  targetOptions,
) {
  const details = getSameSceneShipHandoffScopeBinding(sourceOptions);
  if (!details) {
    if (
      sourceOptions &&
      typeof sourceOptions === "object" &&
      Object.prototype.hasOwnProperty.call(
        sourceOptions,
        SAME_SCENE_SHIP_HANDOFF_SCOPE_BINDING,
      )
    ) {
      throw new TypeError(
        "same-scene ship handoff delivery scope is no longer live",
      );
    }
    return targetOptions;
  }
  return bindSameSceneShipHandoffDeliveryDetails(
    sourceOptions,
    targetOptions,
    details,
  );
}

function getPayloadArguments(update) {
  const payload = update && update.payload;
  return Array.isArray(payload) && Array.isArray(payload[1])
    ? payload[1]
    : null;
}

function isExactSameSceneShipHandoffGroup(updates, capability) {
  if (
    !Array.isArray(updates) ||
    updates.length !== SAME_SCENE_SHIP_HANDOFF_PAYLOAD_NAMES.length ||
    !capability
  ) {
    return false;
  }
  const expectedEntityIDs = [
    capability.previousEntityID,
    capability.previousEntityID,
    capability.previousEntityID,
    capability.previousEntityID,
    capability.previousEntityID,
    capability.boardedEntityID,
    capability.boardedEntityID,
    capability.boardedEntityID,
    capability.boardedEntityID,
    capability.boardedEntityID,
  ];
  const authoredActionPayloads = capability[
    SAME_SCENE_SHIP_HANDOFF_AUTHORED_ACTION_PAYLOADS
  ];
  if (
    !Array.isArray(authoredActionPayloads) ||
    authoredActionPayloads.length !== updates.length
  ) {
    return false;
  }
  for (let index = 0; index < updates.length; index += 1) {
    const update = updates[index];
    const payload = update && update.payload;
    const args = getPayloadArguments(update);
    if (
      !Array.isArray(payload) ||
      payload !== authoredActionPayloads[index] ||
      payload[0] !== SAME_SCENE_SHIP_HANDOFF_PAYLOAD_NAMES[index] ||
      !args ||
      !entityIDsEqual(args[0], expectedEntityIDs[index]) ||
      !hasDestinyStamp(update.stamp) ||
      normalizeDestinyStamp(update.stamp) !== capability.authoredStamp
    ) {
      return false;
    }
  }
  return Number(getPayloadArguments(updates[0])[1]) === 0 &&
    Number(getPayloadArguments(updates[5])[1]) === 1 &&
    buildSameSceneShipHandoffActionFingerprint(
      updates,
      capability.authoredStamp,
    ) === capability[
      SAME_SCENE_SHIP_HANDOFF_AUTHORED_ACTION_FINGERPRINT
    ];
}

function getPureSingleRemoveBallsEntityID(updates = []) {
  if (!Array.isArray(updates) || updates.length !== 1) {
    return null;
  }
  const payload = updates[0] && updates[0].payload;
  if (
    !Array.isArray(payload) ||
    payload[0] !== "RemoveBalls" ||
    !Array.isArray(payload[1]) ||
    payload[1].length !== 1
  ) {
    return null;
  }
  const list = payload[1][0];
  const entityIDs = Array.isArray(list)
    ? list
    : list && list.type === "list" && Array.isArray(list.items)
      ? list.items
      : [];
  return entityIDs.length === 1
    ? normalizeEntityID(entityIDs[0])
    : null;
}

function hasSameSceneShipHandoffCapability(sendOptions) {
  return getSameSceneShipHandoffCapability(sendOptions) !== null;
}

function getSameSceneShipHandoffTransactionProofs(transaction) {
  const rootTransaction = resolveRootDestinyDeliveryTransaction(transaction);
  if (!rootTransaction) {
    return [];
  }
  const transactions = new Set([
    rootTransaction,
    ...(rootTransaction.mergedTransactions instanceof Set
      ? rootTransaction.mergedTransactions
      : []),
  ]);
  return [...transactions]
    .map(
      (candidate) =>
        candidate &&
        candidate[SAME_SCENE_SHIP_HANDOFF_TRANSACTION_PROOF],
    )
    .filter(Boolean);
}

function recordSameSceneShipHandoffTransactionProof(options = {}) {
  const {
    deliveryTransaction,
    finalStamp,
    originalStamp,
    sendOptions,
    updates,
  } = options;
  const capability = getSameSceneShipHandoffCapability(sendOptions);
  const binding = getSameSceneShipHandoffScopeBinding(sendOptions);
  const rootDeliveryTransaction = resolveRootDestinyDeliveryTransaction(
    deliveryTransaction,
  );
  const rootBindingTransaction = resolveRootDestinyDeliveryTransaction(
    binding && binding.transaction,
  );
  if (
    !capability ||
    !binding ||
    rootBindingTransaction !== rootDeliveryTransaction ||
    binding.handoffCapability !== capability ||
    sendOptions.destinyAuthorityContract !==
      DESTINY_CONTRACTS.CRITICAL_MOVEMENT_OR_SHIPPRIME ||
    !hasDestinyStamp(originalStamp) ||
    normalizeDestinyStamp(originalStamp) !== capability.authoredStamp ||
    !hasDestinyStamp(finalStamp) ||
    !isExactSameSceneShipHandoffGroup(updates, capability) ||
    binding.transaction[SAME_SCENE_SHIP_HANDOFF_TRANSACTION_PROOF] ||
    getSameSceneShipHandoffTransactionProofs(rootDeliveryTransaction).length > 0
  ) {
    return false;
  }
  const proof = {
    afterStamp: normalizeDestinyStamp(finalStamp),
    consumed: false,
    entityID: capability.previousEntityID,
    handoffCapability: capability,
  };
  Object.defineProperty(
    binding.transaction,
    SAME_SCENE_SHIP_HANDOFF_TRANSACTION_PROOF,
    {
      configurable: false,
      enumerable: false,
      value: proof,
      writable: false,
    },
  );
  return true;
}

function authorizeFollowingTeardownTransaction(options = {}) {
  const {
    deliveryTransaction,
    originalStamp,
    previousLastSentDestinyStamp,
    sendOptions,
    updates,
  } = options;
  const capability = getFollowingTeardownCapability(sendOptions);
  const binding = getSameSceneShipHandoffScopeBinding(sendOptions);
  const rootDeliveryTransaction = resolveRootDestinyDeliveryTransaction(
    deliveryTransaction,
  );
  const rootBindingTransaction = resolveRootDestinyDeliveryTransaction(
    binding && binding.transaction,
  );
  const proof = binding &&
    binding.transaction[SAME_SCENE_SHIP_HANDOFF_TRANSACTION_PROOF];
  const transactionProofs = getSameSceneShipHandoffTransactionProofs(
    rootDeliveryTransaction,
  );
  const removeEntityID = getPureSingleRemoveBallsEntityID(updates);
  if (
    !capability ||
    !binding ||
    rootBindingTransaction !== rootDeliveryTransaction ||
    binding.handoffCapability !== capability.handoffCapability ||
    !proof ||
    transactionProofs.length !== 1 ||
    transactionProofs[0] !== proof ||
    proof.consumed === true ||
    proof.handoffCapability !== capability.handoffCapability ||
    sendOptions.destinyAuthorityContract !==
      DESTINY_CONTRACTS.DESTRUCTION_TEARDOWN ||
    removeEntityID === null ||
    !entityIDsEqual(removeEntityID, capability.entityID) ||
    !entityIDsEqual(removeEntityID, proof.entityID) ||
    capability.afterStamp !== proof.afterStamp ||
    !hasDestinyStamp(previousLastSentDestinyStamp) ||
    normalizeDestinyStamp(previousLastSentDestinyStamp) !== proof.afterStamp ||
    !hasDestinyStamp(originalStamp) ||
    normalizeDestinyStamp(originalStamp) !==
      advanceDestinyStamp(proof.afterStamp, 1)
  ) {
    return false;
  }
  proof.consumed = true;
  return true;
}

module.exports = {
  authorizeFollowingTeardownTransaction,
  bindSameSceneShipHandoffDeliveryScope,
  buildFollowingTeardownSendOptions,
  buildSameSceneShipHandoffSendOptions,
  createSameSceneShipHandoffDeliveryScope,
  hasSameSceneShipHandoffCapability,
  inheritSameSceneShipHandoffDeliveryScope,
  readFollowingTeardownCapability,
  recordSameSceneShipHandoffTransactionProof,
};
