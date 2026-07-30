"use strict";

const {
  entityIDsEqual,
  getEntityMapKey,
} = require("../../space/destiny/identity/entityID.js");

// Command association is movement evidence, not fleet membership or accepted
// client visibility. Keep it on the participating entity so there is no
// formation registry beside the existing scene and session truth stores. A
// Symbol also keeps the process-local token out of persistence and wire data.
const FLEET_WARP_COMMAND_ASSOCIATION = Symbol(
  "fleetWarpCommandAssociation",
);

function normalizeToken(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function isFleetWarpInProgress(entity) {
  return Boolean(
    entity &&
      (
        entity.mode === "WARP" ||
        entity.pendingWarp ||
        entity.fleetWarpFormationQueuedWarp
      )
  );
}

function hasMatchingSceneSystemID(session, sceneSystemID) {
  const sessionSystemID = getEntityMapKey(
    session &&
      session._space &&
      session._space.systemID,
  );
  const normalizedSceneSystemID = getEntityMapKey(sceneSystemID);
  return (
    sessionSystemID !== null &&
    normalizedSceneSystemID !== null &&
    entityIDsEqual(sessionSystemID, normalizedSceneSystemID)
  );
}

function buildParticipantMarker(options = {}) {
  const token = normalizeToken(options.token);
  const session = options.session || null;
  const generation = options.generation || null;
  const entity = options.entity || null;
  const sceneSystemID = getEntityMapKey(options.sceneSystemID);
  const shipID = getEntityMapKey(entity && entity.itemID);
  if (
    !token ||
    !session ||
    !generation ||
    session._space !== generation ||
    !entity ||
    entity.session !== session ||
    sceneSystemID === null ||
    shipID === null ||
    !hasMatchingSceneSystemID(session, sceneSystemID) ||
    !entityIDsEqual(generation.shipID, shipID) ||
    !isFleetWarpInProgress(entity)
  ) {
    return null;
  }

  return Object.freeze({
    generation,
    sceneSystemID,
    session,
    shipID,
    token,
  });
}

function buildFleetWarpCommandAssociationPlan(options = {}) {
  const leaderMarker = buildParticipantMarker({
    token: options.token,
    session: options.leaderSession,
    generation: options.leaderGeneration,
    entity: options.leaderEntity,
    sceneSystemID: options.sceneSystemID,
  });
  const followerMarker = buildParticipantMarker({
    token: options.token,
    session: options.followerSession,
    generation: options.followerGeneration,
    entity: options.followerEntity,
    sceneSystemID: options.sceneSystemID,
  });
  if (
    !leaderMarker ||
    !followerMarker ||
    entityIDsEqual(leaderMarker.shipID, followerMarker.shipID)
  ) {
    return null;
  }

  return Object.freeze({
    participants: Object.freeze([
      Object.freeze({
        entity: options.leaderEntity,
        marker: leaderMarker,
      }),
      Object.freeze({
        entity: options.followerEntity,
        marker: followerMarker,
      }),
    ]),
    token: leaderMarker.token,
  });
}

function commitFleetWarpCommandAssociationPlan(plan) {
  const participants = plan && Array.isArray(plan.participants)
    ? plan.participants
    : [];
  if (participants.length !== 2) {
    return false;
  }

  for (const participant of participants) {
    if (!participant || !participant.entity || !participant.marker) {
      return false;
    }
    const { entity, marker } = participant;
    if (
      entity.session !== marker.session ||
      marker.session._space !== marker.generation ||
      !entityIDsEqual(entity.itemID, marker.shipID) ||
      !hasMatchingSceneSystemID(marker.session, marker.sceneSystemID) ||
      !isFleetWarpInProgress(entity)
    ) {
      return false;
    }
  }

  const previousDescriptors = [];
  try {
    for (const { entity } of participants) {
      const descriptor = Object.getOwnPropertyDescriptor(
        entity,
        FLEET_WARP_COMMAND_ASSOCIATION,
      );
      if (!descriptor && !Object.isExtensible(entity)) {
        return false;
      }
      if (descriptor && descriptor.configurable !== true) {
        return false;
      }
      previousDescriptors.push({ descriptor, entity });
    }
    for (const { entity, marker } of participants) {
      Object.defineProperty(entity, FLEET_WARP_COMMAND_ASSOCIATION, {
        configurable: true,
        enumerable: false,
        value: marker,
        writable: true,
      });
    }
  } catch (_error) {
    for (const { descriptor, entity } of previousDescriptors.reverse()) {
      try {
        if (descriptor) {
          Object.defineProperty(
            entity,
            FLEET_WARP_COMMAND_ASSOCIATION,
            descriptor,
          );
        } else {
          delete entity[FLEET_WARP_COMMAND_ASSOCIATION];
        }
      } catch (_rollbackError) {
        // A hostile Proxy can defeat local rollback. Runtime entities are plain
        // objects, and the preflight above prevents ordinary partial writes.
      }
    }
    return false;
  }
  return true;
}

function clearFleetWarpCommandAssociation(entity) {
  if (!entity || !Object.prototype.hasOwnProperty.call(
    entity,
    FLEET_WARP_COMMAND_ASSOCIATION,
  )) {
    return false;
  }
  return delete entity[FLEET_WARP_COMMAND_ASSOCIATION];
}

function getFleetWarpCommandAssociation(entity, options = {}) {
  const marker = entity && entity[FLEET_WARP_COMMAND_ASSOCIATION];
  if (!marker || typeof marker !== "object") {
    return null;
  }
  const session = marker.session;
  if (
    !session ||
    session._space !== marker.generation ||
    entity.session !== session ||
    !entityIDsEqual(entity.itemID, marker.shipID) ||
    !hasMatchingSceneSystemID(session, marker.sceneSystemID)
  ) {
    return null;
  }

  if (
    options.sceneSystemID !== undefined &&
    options.sceneSystemID !== null &&
    !entityIDsEqual(marker.sceneSystemID, options.sceneSystemID)
  ) {
    return null;
  }
  if (
    typeof options.getEntityByID === "function" &&
    options.getEntityByID(marker.shipID) !== entity
  ) {
    return null;
  }
  return marker;
}

function haveSameFleetWarpCommandAssociation(
  leftEntity,
  rightEntity,
  options = {},
) {
  if (
    !leftEntity ||
    !rightEntity ||
    entityIDsEqual(leftEntity.itemID, rightEntity.itemID)
  ) {
    return false;
  }
  const left = getFleetWarpCommandAssociation(leftEntity, options);
  const right = getFleetWarpCommandAssociation(rightEntity, options);
  return Boolean(left && right && left.token === right.token);
}

module.exports = {
  buildFleetWarpCommandAssociationPlan,
  clearFleetWarpCommandAssociation,
  commitFleetWarpCommandAssociationPlan,
  getFleetWarpCommandAssociation,
  haveSameFleetWarpCommandAssociation,
  isFleetWarpInProgress,
};
