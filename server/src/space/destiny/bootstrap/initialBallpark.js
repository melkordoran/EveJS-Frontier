"use strict";

const {
  getEntityMapKey,
} = require("../identity/entityID");

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function getEntityID(entity) {
  return getEntityMapKey(entity && entity.itemID);
}

function uniqueEntitiesByItemID(entities) {
  const seen = new Set();
  const result = [];
  for (const entity of normalizeArray(entities)) {
    const entityID = getEntityID(entity);
    if (entityID === null || seen.has(entityID)) {
      continue;
    }
    seen.add(entityID);
    result.push(entity);
  }
  return result;
}

function includesEntity(entities, targetEntity) {
  const targetID = getEntityID(targetEntity);
  return targetID !== null && normalizeArray(entities).some((entity) => (
    getEntityID(entity) === targetID
  ));
}

function appendEntityIfMissing(entities, targetEntity) {
  if (!targetEntity || includesEntity(entities, targetEntity)) {
    return normalizeArray(entities);
  }
  return [...normalizeArray(entities), targetEntity];
}

function isPostSetStateBootstrapStaticEntityDefault(entity, options = {}) {
  const isIncrementalStaticVisibilityEntity =
    typeof options.isIncrementalStaticVisibilityEntity === "function"
      ? options.isIncrementalStaticVisibilityEntity
      : () => false;
  return (
    entity &&
    entity.destinyBootstrapDelivery === "addBalls2" &&
    isIncrementalStaticVisibilityEntity(entity)
  );
}

// CCP Ballpark::PyWriteFullStateToStream writes every valid ball in the source
// bubble, including the source/ego ball. Elysian may split authored statics into
// post-SetState AddBalls2 waves, but the full-state lane must still retain ego.
function buildInitialBallparkEntityPlan(options = {}) {
  const egoEntity = options.egoEntity || null;
  const visibleEntities = uniqueEntitiesByItemID(options.visibleEntities);
  const dynamicEntities = uniqueEntitiesByItemID(options.dynamicEntities);
  const isStructureObserver = options.isStructureObserver === true;
  const isIncrementalStaticVisibilityEntity =
    typeof options.isIncrementalStaticVisibilityEntity === "function"
      ? options.isIncrementalStaticVisibilityEntity
      : () => false;
  const isPostSetStateBootstrapStaticEntity =
    typeof options.isPostSetStateBootstrapStaticEntity === "function"
      ? options.isPostSetStateBootstrapStaticEntity
      : (entity) => isPostSetStateBootstrapStaticEntityDefault(entity, {
          isIncrementalStaticVisibilityEntity,
        });
  const isBootstrapSiteStaticVisibilityEntity =
    typeof options.isBootstrapSiteStaticVisibilityEntity === "function"
      ? options.isBootstrapSiteStaticVisibilityEntity
      : () => false;

  let stateRefreshVisibleEntities = visibleEntities.filter(
    (entity) => !isPostSetStateBootstrapStaticEntity(entity),
  );
  stateRefreshVisibleEntities = appendEntityIfMissing(
    stateRefreshVisibleEntities,
    egoEntity,
  );

  const postSetStateBootstrapStaticEntities = visibleEntities.filter(
    (entity) => isPostSetStateBootstrapStaticEntity(entity),
  );
  const bootstrapIncludesDedicatedSiteStatics = stateRefreshVisibleEntities.some(
    (entity) => isBootstrapSiteStaticVisibilityEntity(entity),
  );
  let bootstrapEntities = isStructureObserver || bootstrapIncludesDedicatedSiteStatics
    ? stateRefreshVisibleEntities
    : dynamicEntities;
  bootstrapEntities = appendEntityIfMissing(bootstrapEntities, egoEntity);

  return {
    bootstrapEntities: uniqueEntitiesByItemID(bootstrapEntities),
    bootstrapIncludesDedicatedSiteStatics,
    postSetStateBootstrapStaticEntities,
    stateRefreshVisibleEntities: uniqueEntitiesByItemID(stateRefreshVisibleEntities),
  };
}

module.exports = {
  buildInitialBallparkEntityPlan,
  includesEntity,
  isPostSetStateBootstrapStaticEntity: isPostSetStateBootstrapStaticEntityDefault,
  uniqueEntitiesByItemID,
};
