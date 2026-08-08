"use strict";

const path = require("path");

const log = require(path.join(__dirname, "../utils/logger"));
const {
  CRUDE_MATTER_GROUP_ID,
} = require(path.join(__dirname, "./frontierRiftAuthority"));

const MAX_RIFT_SCENE_PROPS = 32;

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function toFiniteNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function clonePosition(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    x: toFiniteNumber(source.x, 0),
    y: toFiniteNumber(source.y, 0),
    z: toFiniteNumber(source.z, 0),
  };
}

function resolveDependencies(options = {}) {
  return {
    authority: options.authority || require(path.join(__dirname, "./frontierRiftAuthority")),
    dungeonService: options.dungeonService || require(path.join(
      __dirname,
      "../services/dungeon/dungeonUniverseSiteService",
    )),
    siteStore: options.siteStore || require(path.join(__dirname, "./frontierRiftSites")),
  };
}

function ensureSceneState(scene) {
  if (!(scene._frontierMaterializedRiftSiteIDs instanceof Set)) {
    scene._frontierMaterializedRiftSiteIDs = new Set();
  }
  return scene._frontierMaterializedRiftSiteIDs;
}

function clearPrivateDungeonVisibilityMarkers(entity) {
  for (const fieldName of [
    "dungeonEnvironmentSource",
    "dungeonEnvironmentTemplateID",
    "dungeonMaterializedEnvironment",
    "dungeonMaterializedSiteContent",
    "dungeonSiteID",
    "dungeonSiteInstanceID",
  ]) {
    delete entity[fieldName];
  }
  return entity;
}

function buildRiftSiteEntity(site) {
  const radius = Math.max(1, toFiniteNumber(site && site.radius, 1));
  const systemID = toInt(site && site.solarSystemID, 0);
  return {
    kind: "riftDungeon",
    customFrontierRiftSite: true,
    nonPhysicalDecloakExempt: true,
    itemID: toInt(site && site.itemID, 0),
    typeID: toInt(site && site.typeID, 0),
    groupID: toInt(site && site.groupID, 0),
    categoryID: toInt(site && site.categoryID, 0),
    graphicID: toInt(site && site.graphicID, 0) || null,
    itemName: String(site && site.itemName || "Crude Rift"),
    slimName: String(site && site.itemName || "Crude Rift"),
    ownerID: 1,
    radius,
    signatureRadius: Math.max(
      1,
      toFiniteNumber(site && site.signatureRadius, radius),
    ),
    position: clonePosition(site && site.position),
    velocity: { x: 0, y: 0, z: 0 },
    direction: { x: 1, y: 0, z: 0 },
    locationID: systemID,
    systemID,
    dungeonID: toInt(site && site.dungeonID, 0),
    dungeonNameID: toInt(site && site.dungeonNameID, 0) || null,
    archetypeID: toInt(site && site.archetypeID, 0) || null,
    dungeonEntryObjectID: toInt(site && site.dungeonEntryObjectID, 0) || null,
    dungeonObjectID: toInt(site && site.dungeonEntryObjectID, 0) || null,
    dunObjectID: toInt(site && site.dungeonEntryObjectID, 0) || null,
    dunPosition: [0, 0, 0],
    resourceTypeIDs: Array.isArray(site && site.resourceTypeIDs)
      ? [...site.resourceTypeIDs]
      : [],
    riftPoints: Math.max(1, toInt(site && site.points, 1)),
    staticVisibilityScope: "system",
  };
}

function buildRiftEnvironmentPlan(template) {
  return template.sceneObjects.slice(0, MAX_RIFT_SCENE_PROPS).map((object) => ({
    dunObjectID: object.objectID,
    exact: true,
    key: `frontier-rift:${template.dungeonID}:${object.roomID}:${object.objectID}`,
    positionOffset: clonePosition(object.positionOffset),
    dunRotation: Array.isArray(object.rotation) ? [...object.rotation] : [0, 0, 0],
    suppressSlimGraphicID: true,
    suppressSlimName: true,
    typeID: object.typeID,
  }));
}

function materializeRiftSite(scene, site, options = {}) {
  if (!scene || !site) {
    return { success: false, errorMsg: "RIFT_SITE_NOT_FOUND" };
  }
  const siteID = toInt(site.itemID, 0);
  if (siteID <= 0) {
    return { success: false, errorMsg: "INVALID_RIFT_SITE_ID" };
  }
  const dependencies = resolveDependencies(options);
  const template = dependencies.authority.getTemplateByDungeonID(site.dungeonID);
  if (!template) {
    return { success: false, errorMsg: "RIFT_TEMPLATE_NOT_FOUND" };
  }

  let siteEntity = scene.staticEntitiesByID.get(siteID) || null;
  let rootAdded = false;
  if (!siteEntity) {
    siteEntity = buildRiftSiteEntity(site);
    rootAdded = scene.addStaticEntity(siteEntity);
    if (!rootAdded) {
      return { success: false, errorMsg: "RIFT_SITE_ADD_FAILED" };
    }
  }

  const materializedIDs = ensureSceneState(scene);
  if (materializedIDs.has(siteID)) {
    return {
      success: true,
      data: { alreadyMaterialized: true, propsSpawned: 0, rootAdded, siteID },
    };
  }

  const environmentPlan = buildRiftEnvironmentPlan(template);
  const rawEntities = dependencies.dungeonService.buildEnvironmentEntities(
    { instanceID: siteID },
    siteEntity,
    {},
    {
      environmentProps: environmentPlan,
      exactContentCaps: { environmentProps: MAX_RIFT_SCENE_PROPS },
    },
  );
  const addedEntities = [];
  for (const rawEntity of rawEntities) {
    const entity = clearPrivateDungeonVisibilityMarkers(rawEntity);
    entity.kind = "riftEnvironmentProp";
    entity.customFrontierRiftContent = true;
    entity.frontierRiftSiteID = siteID;
    entity.frontierRiftDungeonID = template.dungeonID;
    entity.frontierRiftResource = toInt(entity.groupID, 0) === CRUDE_MATTER_GROUP_ID;
    entity.nonPhysicalDecloakExempt = true;
    entity.staticVisibilityScope = "bubble";
    if (scene.addStaticEntity(entity)) {
      addedEntities.push(entity);
    }
  }
  materializedIDs.add(siteID);

  if (options.broadcast === true) {
    if (rootAdded) {
      scene.broadcastAddBalls([siteEntity], options.excludedSession || null);
    }
    if (addedEntities.length > 0) {
      scene.broadcastAddBalls(addedEntities, options.excludedSession || null);
    }
  }

  log.info(
    `[FrontierRift] Materialized site=${siteID} dungeon=${template.dungeonID} ` +
    `type=${template.entryTypeID} props=${addedEntities.length} resources=${template.resources.length}`,
  );
  return {
    success: true,
    data: {
      alreadyMaterialized: false,
      propsSpawned: addedEntities.length,
      resourceTypeIDs: template.resources.map((resource) => resource.typeID),
      rootAdded,
      siteID,
    },
  };
}

function dematerializeRiftSite(scene, siteID, options = {}) {
  const numericSiteID = toInt(siteID, 0);
  if (!scene || numericSiteID <= 0) {
    return { success: false, errorMsg: "INVALID_RIFT_SITE_ID" };
  }
  const content = (Array.isArray(scene.staticEntities) ? scene.staticEntities : [])
    .filter((entity) => (
      entity &&
      entity.customFrontierRiftContent === true &&
      toInt(entity.frontierRiftSiteID, 0) === numericSiteID
    ));
  const removedEntityIDs = [];
  for (const entity of content) {
    const result = scene.removeStaticEntity(entity.itemID, {
      broadcast: options.broadcast !== false,
      excludedSession: options.excludedSession || null,
    });
    if (result && result.success === true) {
      removedEntityIDs.push(entity.itemID);
    }
  }
  const root = scene.staticEntitiesByID.get(numericSiteID) || null;
  if (root && root.customFrontierRiftSite === true) {
    scene.removeStaticEntity(numericSiteID, {
      broadcast: options.broadcast !== false,
      excludedSession: options.excludedSession || null,
    });
  }
  ensureSceneState(scene).delete(numericSiteID);
  return {
    success: true,
    errorMsg: null,
    data: { removedEntityIDs, siteID: numericSiteID },
  };
}

function handleSceneCreated(scene, options = {}) {
  if (!scene) {
    return { success: false, errorMsg: "SCENE_NOT_FOUND" };
  }
  const dependencies = resolveDependencies(options);
  const results = dependencies.siteStore.listSites(scene.systemID).map((site) => (
    materializeRiftSite(scene, site, {
      ...options,
      authority: dependencies.authority,
      dungeonService: dependencies.dungeonService,
      siteStore: dependencies.siteStore,
      broadcast: false,
    })
  ));
  return {
    success: results.every((result) => result && result.success === true),
    data: { results, sites: results.length },
  };
}

module.exports = {
  MAX_RIFT_SCENE_PROPS,
  buildRiftEnvironmentPlan,
  buildRiftSiteEntity,
  clearPrivateDungeonVisibilityMarkers,
  dematerializeRiftSite,
  handleSceneCreated,
  materializeRiftSite,
};
