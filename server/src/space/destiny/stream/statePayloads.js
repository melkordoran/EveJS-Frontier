"use strict";

const {
  buildDict,
  buildKeyVal,
  buildList,
  currentFileTime,
} = require("../../../services/_shared/serviceHelpers");
const {
  marshalEncode,
} = require("../../../network/tcp/utils/marshal");
const {
  decodeSerializedActions,
} = require("../batching/packagedAction");
const {
  requireEntityID,
} = require("../identity/entityID");
const {
  DESTINY_STAMP_INTERVAL_MS,
} = require("../constants");
const {
  encodeEntityBall: defaultEncodeEntityBall,
} = require("./ballEncoding");
const {
  toInt32,
} = require("./primitives");
const {
  normalizeCrDataDictionaryForProfile,
  usesCrDataBallMetadata,
  usesCrDataSetState,
  usesFrontierStateStreamPreamble,
} = require("./statePayloadCompatibility");

const FRONTIER_STATE_PHYSICS_DEFAULTS = [1, 0, 1];

function normalizeStateStamp(stamp) {
  return toInt32(stamp, 0) >>> 0;
}

function normalizeStateTime(value) {
  try {
    return BigInt.asIntN(64, BigInt(value ?? 0));
  } catch (_error) {
    return 0n;
  }
}

function isDestinyBallPayloadEntity(entity) {
  return Boolean(entity) && entity.omitDestinyBall !== true;
}

function encodeStateHeader(packetType, stamp, deps = {}) {
  const useFrontierPreamble = usesFrontierStateStreamPreamble(
    deps.compatibilityProfile,
  );
  const buffer = Buffer.alloc(useFrontierPreamble ? 41 : 5);
  buffer.writeUInt8(toInt32(packetType, 0) & 0xff, 0);
  buffer.writeUInt32LE(normalizeStateStamp(stamp), 1);
  if (useFrontierPreamble) {
    buffer.writeBigInt64LE(normalizeStateTime(deps.simFileTime), 5);
    buffer.writeUInt32LE(
      Math.max(
        1,
        Math.min(
          100000,
          toInt32(deps.tickIntervalMs, DESTINY_STAMP_INTERVAL_MS),
        ),
      ),
      13,
    );
    FRONTIER_STATE_PHYSICS_DEFAULTS.forEach((value, index) => {
      buffer.writeDoubleLE(value, 17 + (index * 8));
    });
  }
  return buffer;
}

function normalizeBallEntities(entities) {
  return (Array.isArray(entities) ? entities : [])
    .filter(isDestinyBallPayloadEntity);
}

function resolveEntityBallEncoder(deps) {
  if (deps && deps.encodeEntityBall !== undefined) {
    if (typeof deps.encodeEntityBall !== "function") {
      throw new TypeError("encodeEntityBall must be a function");
    }
    return deps.encodeEntityBall;
  }
  return defaultEncodeEntityBall;
}

function buildStateBuffer(packetType, stamp, entities, deps = {}) {
  const encodeEntityBall = resolveEntityBallEncoder(deps);
  const chunks = [encodeStateHeader(packetType, stamp, deps)];
  const encodeOptions = {
    ...(deps.encodeOptions || {}),
    compatibilityProfile: deps.compatibilityProfile,
  };
  for (const entity of normalizeBallEntities(entities)) {
    chunks.push(encodeEntityBall(entity, encodeOptions));
  }
  return Buffer.concat(chunks);
}

function buildAddBallsStateBuffer(stamp, entities, deps = {}) {
  return buildStateBuffer(1, stamp, entities, {
    ...deps,
    encodeOptions: {
      ...(deps.encodeOptions || {}),
      forAddBalls: true,
    },
  });
}

function buildSetStateBuffer(stamp, entities, deps = {}) {
  return buildStateBuffer(0, stamp, entities, deps);
}

function shouldBuildDamageState(entity, deps) {
  return Boolean(
    entity &&
    (
      entity.forceDamageState === true ||
      entity.kind === "station" ||
      (
        typeof deps.hasDamageableHealth === "function" &&
        deps.hasDamageableHealth(entity)
      )
    )
  );
}

function buildAddBallsExtraBallData(ballEntities, simFileTime, deps = {}) {
  if (typeof deps.buildSlimItemDict !== "function") {
    throw new TypeError("buildAddBallsExtraBallData requires buildSlimItemDict");
  }
  const buildDamageState = typeof deps.buildDamageState === "function"
    ? deps.buildDamageState
    : null;
  const useCrData = usesCrDataBallMetadata(deps.compatibilityProfile);

  return normalizeBallEntities(ballEntities)
    .filter((entity) => entity.omitSlimItem !== true)
    .map((entity) => {
      const slimItem = normalizeCrDataDictionaryForProfile(
        deps.buildSlimItemDict(entity),
        entity,
        deps.compatibilityProfile,
      );
      const damageState = buildDamageState && shouldBuildDamageState(entity, deps)
        ? buildDamageState(entity, simFileTime)
        : null;
      if (useCrData) {
        const entry = [
          requireEntityID(entity.itemID, "AddBalls2 crdata entityID"),
          slimItem,
        ];
        if (damageState !== null) {
          entry.push(damageState);
        }
        return entry;
      }
      if (damageState !== null) {
        return [slimItem, damageState];
      }
      return slimItem;
    });
}

function buildAddBalls2Payload(
  stateStamp,
  entities,
  simFileTime = currentFileTime(),
  deps = {},
) {
  const ballEntities = normalizeBallEntities(entities);
  const state = buildAddBallsStateBuffer(stateStamp, ballEntities, {
    ...deps,
    simFileTime,
  });
  const extraBallData = buildAddBallsExtraBallData(
    ballEntities,
    simFileTime,
    deps,
  );
  return [
    "AddBalls2",
    [
      [
        state,
        buildList(extraBallData),
      ],
    ],
  ];
}

function isSetStateDependencyBag(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  try {
    return [
      "buildDamageState",
      "buildDroneState",
      "buildSlimItemDict",
      "buildSlimItemObject",
      "buildSolItem",
      "compatibilityProfile",
      "encodeEntityBall",
      "hasDamageableHealth",
    ].some((name) => name in value);
  } catch (_error) {
    return false;
  }
}

function resolveSetStateArguments(effectStateEntries, deps) {
  if (isSetStateDependencyBag(effectStateEntries)) {
    return {
      deps: effectStateEntries,
      effectStateEntries: [],
    };
  }
  return {
    deps: deps && typeof deps === "object" ? deps : {},
    effectStateEntries: Array.isArray(effectStateEntries)
      ? effectStateEntries
      : [],
  };
}

function buildSetStatePayload(
  stateStamp,
  system,
  egoEntityID,
  entities,
  simFileTime = currentFileTime(),
  dbuffStateEntries = [],
  effectStateEntries = [],
  deps = {},
) {
  const resolved = resolveSetStateArguments(effectStateEntries, deps);
  const stateDeps = resolved.deps;
  const useCrData = usesCrDataSetState(stateDeps.compatibilityProfile);
  if (useCrData && typeof stateDeps.buildSlimItemDict !== "function") {
    throw new TypeError("buildSetStatePayload requires buildSlimItemDict");
  }
  if (!useCrData && typeof stateDeps.buildSlimItemObject !== "function") {
    throw new TypeError("buildSetStatePayload requires buildSlimItemObject");
  }
  if (typeof stateDeps.buildDroneState !== "function") {
    throw new TypeError("buildSetStatePayload requires buildDroneState");
  }
  if (typeof stateDeps.buildSolItem !== "function") {
    throw new TypeError("buildSetStatePayload requires buildSolItem");
  }

  const ballEntities = normalizeBallEntities(entities);
  const buildDamageState = typeof stateDeps.buildDamageState === "function"
    ? stateDeps.buildDamageState
    : null;
  const damageEntries = buildDamageState
    ? ballEntities
      .filter((entity) => shouldBuildDamageState(entity, stateDeps))
      .map((entity) => [
        requireEntityID(entity.itemID, "SetState damage entityID"),
        buildDamageState(entity, simFileTime),
      ])
    : [];
  const slimEntities = ballEntities.filter((entity) => (
    entity.omitSlimItem !== true
  ));
  const entityStateEntry = useCrData
    ? [
      "crdata",
      buildDict(slimEntities.map((entity) => [
        requireEntityID(entity.itemID, "SetState crdata entityID"),
        normalizeCrDataDictionaryForProfile(
          stateDeps.buildSlimItemDict(entity),
          entity,
          stateDeps.compatibilityProfile,
        ),
      ])),
    ]
    : [
      "slims",
      buildList(slimEntities.map((entity) => (
        stateDeps.buildSlimItemObject(entity)
      ))),
    ];
  const stateBuffer = buildSetStateBuffer(stateStamp, ballEntities, {
    ...stateDeps,
    simFileTime,
  });

  const state = buildKeyVal([
    ["stamp", stateStamp],
    [
      "state",
      stateBuffer,
    ],
    [
      "ego",
      requireEntityID(egoEntityID, "SetState ego entityID"),
    ],
    ["industryLevel", 0],
    ["researchLevel", 0],
    ["damageState", buildDict(damageEntries)],
    [
      "dbuffState",
      buildList(Array.isArray(dbuffStateEntries) ? dbuffStateEntries : []),
    ],
    ["aggressors", buildDict([])],
    ["droneState", stateDeps.buildDroneState(ballEntities)],
    entityStateEntry,
    ["solItem", stateDeps.buildSolItem(system)],
    ["effectStates", buildList(resolved.effectStateEntries)],
    ["allianceBridges", buildList([])],
  ]);

  return ["SetState", [state]];
}

function restampEncodedStateBuffer(buffer, stamp) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 5) {
    return buffer;
  }
  const nextBuffer = Buffer.from(buffer);
  nextBuffer.writeUInt32LE(normalizeStateStamp(stamp), 1);
  return nextBuffer;
}

function restampAddBalls2Payload(payload, stamp) {
  if (
    !Array.isArray(payload) ||
    payload[0] !== "AddBalls2" ||
    !Array.isArray(payload[1])
  ) {
    return payload;
  }
  const normalizedStamp = normalizeStateStamp(stamp);
  return [
    payload[0],
    payload[1].map((entry) => {
      if (!Array.isArray(entry) || !Buffer.isBuffer(entry[0])) {
        return entry;
      }
      return [
        restampEncodedStateBuffer(entry[0], normalizedStamp),
        ...entry.slice(1),
      ];
    }),
  ];
}

function restampSetStatePayload(payload, stamp) {
  if (
    !Array.isArray(payload) ||
    payload[0] !== "SetState" ||
    !Array.isArray(payload[1]) ||
    payload[1].length === 0
  ) {
    return payload;
  }

  const stateObject = payload[1][0];
  const stateArgs = stateObject && stateObject.args;
  if (
    !stateObject ||
    !stateArgs ||
    stateArgs.type !== "dict" ||
    !Array.isArray(stateArgs.entries)
  ) {
    return payload;
  }

  const normalizedStamp = normalizeStateStamp(stamp);
  return [
    payload[0],
    [
      {
        ...stateObject,
        args: {
          ...stateArgs,
          entries: stateArgs.entries.map((entry) => {
            if (!Array.isArray(entry) || entry.length < 2) {
              return entry;
            }
            const entryName = Buffer.isBuffer(entry[0])
              ? entry[0].toString("utf8")
              : entry[0];
            if (entryName === "stamp") {
              return [entry[0], normalizedStamp];
            }
            if (entryName === "state") {
              return [
                entry[0],
                restampEncodedStateBuffer(entry[1], normalizedStamp),
              ];
            }
            return entry;
          }),
        },
      },
      ...payload[1].slice(1),
    ],
  ];
}

function restampPackagedActionPayload(payload, stamp) {
  if (
    !Array.isArray(payload) ||
    payload[0] !== "PackagedAction" ||
    !Buffer.isBuffer(payload[1])
  ) {
    return payload;
  }

  const normalizedStamp = normalizeStateStamp(stamp);
  const restampedActions = decodeSerializedActions(payload[1]).map((entry) => [
    normalizedStamp,
    restampPayloadState(entry[1], normalizedStamp),
  ]);
  return [payload[0], marshalEncode(restampedActions)];
}

function restampPayloadState(payload, stamp) {
  if (!Array.isArray(payload)) {
    return payload;
  }
  const payloadName = Buffer.isBuffer(payload[0])
    ? payload[0].toString("utf8")
    : payload[0];
  if (typeof payloadName !== "string") {
    return payload;
  }
  const normalizedPayload = Buffer.isBuffer(payload[0])
    ? [payloadName, ...payload.slice(1)]
    : payload;

  switch (payloadName) {
    case "AddBalls2":
      return restampAddBalls2Payload(normalizedPayload, stamp);
    case "SetState":
      return restampSetStatePayload(normalizedPayload, stamp);
    case "PackagedAction":
      return restampPackagedActionPayload(normalizedPayload, stamp);
    default:
      return payload;
  }
}

function buildDestinyUpdatePayload(
  updates,
  waitForBubble = false,
  delayedTargetEvents = null,
) {
  const updateList = buildList(
    (Array.isArray(updates) ? updates : []).map((update) => [
      update.stamp,
      update.payload,
    ]),
  );
  if (Array.isArray(delayedTargetEvents)) {
    return [updateList, waitForBubble, delayedTargetEvents];
  }
  return [updateList, waitForBubble];
}

module.exports = {
  buildAddBalls2Payload,
  buildAddBallsExtraBallData,
  buildAddBallsStateBuffer,
  buildDestinyUpdatePayload,
  buildSetStateBuffer,
  buildSetStatePayload,
  buildStateBuffer,
  encodeStateHeader,
  isDestinyBallPayloadEntity,
  normalizeBallEntities,
  restampAddBalls2Payload,
  restampEncodedStateBuffer,
  restampPayloadState,
  restampPackagedActionPayload,
  restampSetStatePayload,
};
