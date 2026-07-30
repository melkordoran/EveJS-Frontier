"use strict";

const {
  isMovementContractPayload,
} = require("../protocol/payloads");
const {
  MICHELLE_POST_HELD_FUTURE_DESTINY_LEAD,
} = require("../delivery/michelleContract");
const {
  getEntityMapKey,
} = require("../identity/entityID");
const {
  getPayloadPrimaryEntityID,
} = require("../protocol/payloadIdentity");
const {
  advanceDestinyStamp,
  hasDestinyStamp,
  normalizeDestinyStamp,
  selectLaterDestinyStamp,
} = require("../delivery/stamps");

function resolveFreshVisibilityProtectionReleaseStamp(
  deliveryStamp,
  acquisitionSessionStamp = null,
) {
  if (!hasDestinyStamp(deliveryStamp)) {
    // Stamp zero is a real point in the canonical 31-bit ring. Invalid or
    // absent delivery must remain null so it cannot install a false release.
    return null;
  }
  const normalizedDeliveryStamp = normalizeDestinyStamp(deliveryStamp);
  const normalizedAcquisitionSessionStamp = hasDestinyStamp(
    acquisitionSessionStamp,
  )
    ? normalizeDestinyStamp(acquisitionSessionStamp)
    : null;
  const postHeldFutureReleaseStamp = hasDestinyStamp(
    normalizedAcquisitionSessionStamp,
  )
    ? advanceDestinyStamp(
        normalizedAcquisitionSessionStamp,
        MICHELLE_POST_HELD_FUTURE_DESTINY_LEAD,
      )
    : normalizedDeliveryStamp;
  return selectLaterDestinyStamp(
    normalizedDeliveryStamp,
    postHeldFutureReleaseStamp,
  );
}

function filterFreshAcquireBootstrapModeUpdates(updates) {
  if (!Array.isArray(updates) || updates.length === 0) {
    return [];
  }
  const freshAcquireSafeUpdates = updates.filter(
    (update) => !(update && update.requireExistingVisibility === true),
  );
  if (freshAcquireSafeUpdates.length === 0) {
    return [];
  }
  const containsWarpTo = freshAcquireSafeUpdates.some(
    (update) =>
      update &&
      Array.isArray(update.payload) &&
      update.payload[0] === "WarpTo",
  );
  if (containsWarpTo) {
    return freshAcquireSafeUpdates;
  }
  return freshAcquireSafeUpdates.filter((update) => (
    !isMovementContractPayload(update && update.payload)
  ));
}

function resolveFreshAcquireBootstrapModeUpdates(_entities, updates) {
  if (!Array.isArray(updates) || updates.length === 0) {
    return [];
  }
  return filterFreshAcquireBootstrapModeUpdates(updates);
}

function stripMissileFreshAcquireModeReplayUpdates(entities, updates) {
  if (!Array.isArray(updates) || updates.length === 0) {
    return [];
  }

  const missileIDs = new Set(
    (Array.isArray(entities) ? entities : [])
      .map((entity) => getEntityMapKey(entity && entity.itemID))
      .filter((entityID) => entityID !== null && entityID !== 0),
  );
  if (missileIDs.size === 0) {
    return updates;
  }

  return updates.filter((update) => {
    const payload =
      update && Array.isArray(update.payload) ? update.payload : null;
    const payloadName = payload && typeof payload[0] === "string"
      ? payload[0]
      : null;
    if (
      payloadName !== "FollowBall" &&
      payloadName !== "SetSpeedFraction" &&
      payloadName !== "SetBallVelocity"
    ) {
      return true;
    }
    return !missileIDs.has(getPayloadPrimaryEntityID(payload));
  });
}

module.exports = {
  filterFreshAcquireBootstrapModeUpdates,
  resolveFreshAcquireBootstrapModeUpdates,
  resolveFreshVisibilityProtectionReleaseStamp,
  stripMissileFreshAcquireModeReplayUpdates,
};
