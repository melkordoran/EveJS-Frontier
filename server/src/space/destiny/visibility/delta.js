"use strict";

const {
  getEntityMapKey,
} = require("../identity/entityID");

function normalizeSet(value) {
  const normalized = new Set();
  const entries = value instanceof Set
    ? value
    : Array.isArray(value)
      ? value
      : [];
  for (const entry of entries) {
    const entityID = getEntityMapKey(entry);
    if (entityID !== null) {
      normalized.add(entityID);
    }
  }
  return normalized;
}

function normalizeArray(value) {
  return Array.isArray(value) ? [...value] : [];
}

function getEntityKey(entity) {
  return getEntityMapKey(entity && entity.itemID);
}

function isWarpingEntity(entity) {
  return Boolean(
    entity &&
      (
        entity.mode === "WARP" ||
        entity.pendingWarp ||
        entity.warpState ||
        entity.fleetWarpFormationQueuedWarp
      ),
  );
}

function buildDynamicVisibilityDeltaPlan(options = {}) {
  const egoEntity = options.egoEntity && typeof options.egoEntity === "object"
    ? options.egoEntity
    : null;
  const egoEntityKey = getEntityKey(egoEntity);
  const desiredEntities = normalizeArray(options.desiredEntities)
    .filter((entity) => {
      const entityKey = getEntityKey(entity);
      return entityKey !== null && entityKey !== egoEntityKey;
    });
  const desiredIDs = new Set(
    desiredEntities.map((entity) => getEntityKey(entity)),
  );
  const currentIDs = normalizeSet(options.currentIDs);
  const warpHandoff = options.warpHandoff && typeof options.warpHandoff === "object"
    ? options.warpHandoff
    : null;
  const destinationHandoffClusterKey = String(
    warpHandoff && warpHandoff.destinationClusterKey || "",
  ).trim();
  const preserveDestinationDynamicsThroughWarpHandoff = Boolean(
    destinationHandoffClusterKey &&
      warpHandoff &&
      warpHandoff.destinationJoined === true &&
      egoEntity &&
      isWarpingEntity(egoEntity),
  );
  const getDynamicEntityByID =
    typeof options.getDynamicEntityByID === "function"
      ? options.getDynamicEntityByID
      : () => null;
  const isFleetWarpFormationCompanionForSession =
    typeof options.isFleetWarpFormationCompanionForSession === "function"
      ? options.isFleetWarpFormationCompanionForSession
      : () => false;
  const getVisibilityPublicGridClusterKeyForEntity =
    typeof options.getVisibilityPublicGridClusterKeyForEntity === "function"
      ? options.getVisibilityPublicGridClusterKeyForEntity
      : () => "";
  const session = options.session || null;
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : 0;
  const shouldPreserveDestinationDynamic = (entity) => {
    if (!preserveDestinationDynamicsThroughWarpHandoff || !entity) {
      return false;
    }
    if (
      getEntityKey(entity) === egoEntityKey ||
      entity.mode === "WARP" ||
      entity.pendingWarp ||
      entity.warpState
    ) {
      return false;
    }
    const entityClusterKey = String(
      getVisibilityPublicGridClusterKeyForEntity(entity) || "",
    ).trim();
    return entityClusterKey === destinationHandoffClusterKey;
  };

  for (const entityID of currentIDs) {
    if (desiredIDs.has(entityID)) {
      continue;
    }
    const entity = getDynamicEntityByID(entityID);
    if (
      entity &&
      getEntityKey(entity) !== egoEntityKey &&
      isFleetWarpFormationCompanionForSession(session, entity, nowMs)
    ) {
      desiredEntities.push(entity);
      desiredIDs.add(getEntityKey(entity));
      continue;
    }
    if (shouldPreserveDestinationDynamic(entity)) {
      desiredEntities.push(entity);
      desiredIDs.add(getEntityKey(entity));
    }
  }

  const addedEntities = desiredEntities.filter(
    (entity) => !currentIDs.has(getEntityKey(entity)),
  );
  const removedIDs = [...currentIDs].filter((entityID) => (
    !desiredIDs.has(entityID)
  ));

  return {
    addedEntities,
    currentIDs,
    desiredEntities,
    desiredIDs,
    egoEntity,
    removedIDs,
  };
}

function buildStaticVisibilityDeltaPlan(options = {}) {
  const desiredEntities = normalizeArray(options.desiredEntities);
  const desiredIDs = new Set(
    desiredEntities
      .map((entity) => getEntityKey(entity))
      .filter((entityID) => entityID !== null),
  );
  const currentIDs = normalizeSet(options.currentIDs);
  const egoEntity = options.egoEntity && typeof options.egoEntity === "object"
    ? options.egoEntity
    : null;
  const warpHandoff = options.warpHandoff && typeof options.warpHandoff === "object"
    ? options.warpHandoff
    : null;
  const preserveCurrentStaticsThroughWarpHandoff = Boolean(
    egoEntity &&
      isWarpingEntity(egoEntity) &&
      (!warpHandoff || warpHandoff.sourceRemoved !== true)
  );
  const getStaticEntityByID =
    typeof options.getStaticEntityByID === "function"
      ? options.getStaticEntityByID
      : () => null;
  const isIncrementalStaticVisibilityEntity =
    typeof options.isIncrementalStaticVisibilityEntity === "function"
      ? options.isIncrementalStaticVisibilityEntity
      : () => false;
  if (preserveCurrentStaticsThroughWarpHandoff) {
    for (const entityID of currentIDs) {
      if (desiredIDs.has(entityID)) {
        continue;
      }
      const entity = getStaticEntityByID(entityID);
      if (entity && isIncrementalStaticVisibilityEntity(entity)) {
        desiredIDs.add(entityID);
        desiredEntities.push(entity);
      }
    }
  }

  const addedEntities = desiredEntities.filter(
    (entity) => !currentIDs.has(getEntityKey(entity)),
  );
  const removedIDs = [...currentIDs].filter((entityID) => (
    !desiredIDs.has(entityID)
  ));

  return {
    addedEntities,
    currentIDs,
    desiredEntities,
    desiredIDs,
    removedIDs,
  };
}

module.exports = {
  buildDynamicVisibilityDeltaPlan,
  buildStaticVisibilityDeltaPlan,
  isWarpingEntity,
};
