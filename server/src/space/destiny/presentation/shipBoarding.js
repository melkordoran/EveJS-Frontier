"use strict";

const { deserialize, serialize } = require("node:v8");

const {
  advanceDestinyStamp,
  hasDestinyStamp,
  normalizeDestinyStamp,
} = require("../delivery/stamps");
const {
  buildFollowingTeardownSendOptions,
  buildSameSceneShipHandoffSendOptions,
} = require("../delivery/sameSceneShipHandoff");
const {
  DESTINY_CONTRACTS,
} = require("../authority/destinyContracts");
const {
  requireEntityID,
} = require("../identity/entityID");
const {
  buildOnSlimItemChangePayload,
  buildOnSpecialFXPayload,
  buildSetBallAgilityPayload,
  buildSetBallInteractivePayload,
  buildSetBallPositionPayload,
  buildSetMaxSpeedPayload,
  buildStopPayload,
} = require("../stream/actions");

const SAME_SCENE_SHIP_HANDOFF_SEND_OPTIONS = Object.freeze({
  translateStamps: false,
  destinyAuthorityContract:
    DESTINY_CONTRACTS.CRITICAL_MOVEMENT_OR_SHIPPRIME,
});
const SHIP_BOARDING_FOLLOWING_REMOVAL_PROVENANCE = Symbol(
  "destiny.shipBoardingFollowingRemovalProvenance",
);

function toFiniteNumber(value, fallback = 0) {
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    return numeric;
  }
  const fallbackNumeric = Number(fallback);
  return Number.isFinite(fallbackNumeric) ? fallbackNumeric : 0;
}

function getEntityMaxSpeed(entity) {
  return toFiniteNumber(
    entity && (entity.maxVelocity ?? entity.maxSpeed),
    0,
  );
}

function getEntityAgility(entity) {
  return toFiniteNumber(
    entity && (entity.inertia ?? entity.agility),
    1,
  );
}

function resolveHandoffStamp(options) {
  if (
    options &&
    options.stampOverride !== undefined &&
    options.stampOverride !== null
  ) {
    return normalizeDestinyStamp(options.stampOverride);
  }
  if (!options || typeof options.getDefaultStamp !== "function") {
    return null;
  }
  const defaultStamp = options.getDefaultStamp();
  return defaultStamp === undefined || defaultStamp === null
    ? null
    : normalizeDestinyStamp(defaultStamp);
}

function prepareHandoffInputs(options = {}) {
  const previousEntity = options.previousEntity;
  const boardedEntity = options.boardedEntity;
  if (!previousEntity || !boardedEntity) {
    return null;
  }
  if (typeof options.buildSlimItemObject !== "function") {
    throw new TypeError(
      "same-scene ship handoff requires buildSlimItemObject",
    );
  }

  // Validate identities and pure slim projection before consuming a default
  // stamp. A rejected plan must not advance the caller's presentation clock.
  const previousID = requireEntityID(
    previousEntity.itemID,
    "previousEntity.itemID",
  );
  const boardedID = requireEntityID(
    boardedEntity.itemID,
    "boardedEntity.itemID",
  );
  const previousSlim = options.buildSlimItemObject(previousEntity);
  const boardedSlim = options.buildSlimItemObject(boardedEntity);
  const stamp = resolveHandoffStamp(options);
  if (!hasDestinyStamp(stamp)) {
    return null;
  }

  return {
    boardedEntity,
    boardedID,
    boardedSlim,
    previousEntity,
    previousID,
    previousSlim,
    stamp,
  };
}

// A null slim item means the active compatibility profile does not accept
// wire SlimItem objects (Frontier builds them from CR data and whitelists no
// SlimItem class). Emitting the action anyway would make the client reject
// the whole handoff bundle, so drop just this payload.
function slimItemChangePayloads(entityID, slimItem) {
  return slimItem ? [buildOnSlimItemChangePayload(entityID, slimItem)] : [];
}

function buildPlan(stamp, payloads, options = {}) {
  const includesFollowingRemoval =
    options.followingRemovalEntityID !== undefined;
  let authoredPayloads = payloads;
  if (includesFollowingRemoval) {
    try {
      // Slim projection can retain arrays owned by a live scene entity. Copy
      // the complete wire graph before the delivery capability seals it so
      // presentation immutability never freezes gameplay-owned state.
      authoredPayloads = deserialize(serialize(payloads));
    } catch (_error) {
      throw new TypeError(
        "same-scene ship handoff actions must be cloneable wire values",
      );
    }
  }
  const updates = authoredPayloads.map((payload) => ({ stamp, payload }));
  let sendOptions = { ...SAME_SCENE_SHIP_HANDOFF_SEND_OPTIONS };
  let followingRemoval = null;
  let followingRemovalProvenance = null;
  if (includesFollowingRemoval) {
    sendOptions = buildSameSceneShipHandoffSendOptions(sendOptions, {
      stamp,
      previousEntityID: options.followingRemovalEntityID,
      boardedEntityID: options.boardedEntityID,
      updates,
    });
    followingRemoval = buildFollowingShipBoardingRemovalPlan(
      stamp,
      options.followingRemovalEntityID,
      sendOptions,
    );
    followingRemovalProvenance = Object.freeze({
      entityID: followingRemoval.entityID,
      handoffSendOptions: sendOptions,
    });
  }
  const plan = {
    stamp,
    updates,
    sendOptions,
  };
  if (followingRemoval) {
    plan.followingRemoval = Object.freeze(followingRemoval);
    Object.defineProperty(
      plan,
      SHIP_BOARDING_FOLLOWING_REMOVAL_PROVENANCE,
      {
        configurable: false,
        enumerable: false,
        value: followingRemovalProvenance,
        writable: false,
      },
    );
  }
  return plan;
}

function buildFollowingShipBoardingRemovalPlan(
  handoffStamp,
  entityID,
  handoffSendOptions,
) {
  if (!hasDestinyStamp(handoffStamp)) {
    return null;
  }
  const exactEntityID = requireEntityID(
    entityID,
    "followingRemoval.entityID",
  );
  const normalizedHandoffStamp = normalizeDestinyStamp(handoffStamp);
  return {
    entityID: exactEntityID,
    stamp: advanceDestinyStamp(normalizedHandoffStamp, 1),
    sendOptions: buildFollowingTeardownSendOptions({
      afterStamp: normalizedHandoffStamp,
      entityID: exactEntityID,
      handoffSendOptions,
    }),
  };
}

function resolveSameSceneShipBoardingFollowingRemoval(
  plan,
  acceptedHandoffStamp,
) {
  const provenance =
    plan && plan[SHIP_BOARDING_FOLLOWING_REMOVAL_PROVENANCE];
  return provenance
    ? buildFollowingShipBoardingRemovalPlan(
        acceptedHandoffStamp,
        provenance.entityID,
        provenance.handoffSendOptions,
      )
    : null;
}

/**
 * Build John's in-place ego handoff. Both balls keep their existing client
 * histories: the old ego stops and becomes non-interactive, then the new ego
 * becomes interactive with its piloted slim and physical envelope. Removal is
 * deliberately left to the transition after this plan is accepted.
 */
function buildSameSceneShipBoardingHandoffPlan(options = {}) {
  const inputs = prepareHandoffInputs(options);
  if (!inputs) {
    return null;
  }

  const {
    boardedEntity,
    boardedID,
    boardedSlim,
    previousEntity,
    previousID,
    previousSlim,
    stamp,
  } = inputs;
  return buildPlan(stamp, [
    buildSetBallInteractivePayload(previousID, false),
    buildStopPayload(previousID),
    ...slimItemChangePayloads(previousID, previousSlim),
    buildSetMaxSpeedPayload(previousID, getEntityMaxSpeed(previousEntity)),
    buildSetBallAgilityPayload(previousID, getEntityAgility(previousEntity)),
    buildSetBallInteractivePayload(boardedID, true),
    ...slimItemChangePayloads(boardedID, boardedSlim),
    buildSetMaxSpeedPayload(boardedID, getEntityMaxSpeed(boardedEntity)),
    buildSetBallAgilityPayload(boardedID, getEntityAgility(boardedEntity)),
    // TQ repeats the new ego slim after its physical setters so ownership-
    // dependent menus and the HUD refresh against the final piloted envelope.
    ...slimItemChangePayloads(boardedID, boardedSlim),
  ], {
    boardedEntityID: boardedID,
    followingRemovalEntityID:
      options.includeFollowingRemoval === true
        ? previousID
        : undefined,
  });
}

/**
 * Build the current proven eject prelude and handoff. Eject retains its live
 * agility-before-max-speed ordering; it is intentionally not normalized to
 * the distinct John boarding order without packet evidence authorizing that
 * behavioral change.
 */
function buildSameSceneShipEjectHandoffPlan(options = {}) {
  const inputs = prepareHandoffInputs(options);
  if (!inputs) {
    return null;
  }

  const {
    boardedEntity: capsuleEntity,
    boardedID: capsuleID,
    boardedSlim: capsuleSlim,
    previousEntity: abandonedShipEntity,
    previousID: abandonedShipID,
    previousSlim: abandonedShipSlim,
    stamp,
  } = inputs;
  const capsulePosition =
    capsuleEntity.position ||
    capsuleEntity.targetPoint ||
    abandonedShipEntity.position ||
    { x: 0, y: 0, z: 0 };

  return buildPlan(stamp, [
    buildOnSpecialFXPayload(capsuleID, "effects.Jettison", {
      targetID: abandonedShipID,
      start: true,
      active: false,
      duration: 4000,
      graphicInfo: { poseID: 0 },
    }),
    buildSetBallPositionPayload(capsuleID, capsulePosition),
    buildSetBallInteractivePayload(abandonedShipID, false),
    buildStopPayload(abandonedShipID),
    ...slimItemChangePayloads(abandonedShipID, abandonedShipSlim),
    buildSetBallAgilityPayload(
      abandonedShipID,
      getEntityAgility(abandonedShipEntity),
    ),
    buildSetMaxSpeedPayload(
      abandonedShipID,
      getEntityMaxSpeed(abandonedShipEntity),
    ),
    buildSetBallInteractivePayload(capsuleID, true),
    ...slimItemChangePayloads(capsuleID, capsuleSlim),
    buildSetBallAgilityPayload(capsuleID, getEntityAgility(capsuleEntity)),
    buildSetMaxSpeedPayload(capsuleID, getEntityMaxSpeed(capsuleEntity)),
    ...slimItemChangePayloads(capsuleID, capsuleSlim),
  ]);
}

module.exports = {
  buildSameSceneShipBoardingHandoffPlan,
  buildSameSceneShipEjectHandoffPlan,
  resolveSameSceneShipBoardingFollowingRemoval,
};
