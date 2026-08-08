"use strict";

const path = require("path");

const TABLE_NAME = "frontierLandscapeCustomSites";
const STATE_VERSION = 1;
const CUSTOM_SITE_ID_BASE = 9_100_000_000;
const CUSTOM_SITE_ID_LIMIT = 19_000_000_000;

function toPositiveInt(value, fallback = 0) {
  const numeric = Math.trunc(Number(value) || 0);
  return numeric > 0 ? numeric : fallback;
}

function toFiniteNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function normalizePosition(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  const position = {
    x: Number(value.x),
    y: Number(value.y),
    z: Number(value.z),
  };
  return Object.values(position).every(Number.isFinite) ? position : null;
}

function cloneSite(site) {
  return {
    ...site,
    featureTags: Array.isArray(site && site.featureTags)
      ? [...site.featureTags]
      : [],
    position: normalizePosition(site && site.position),
  };
}

function normalizeSite(site) {
  const itemID = toPositiveInt(site && (site.itemID ?? site.siteID), 0);
  const solarSystemID = toPositiveInt(site && site.solarSystemID, 0);
  const ecosystemID = toPositiveInt(site && site.ecosystemID, 0);
  const dungeonID = toPositiveInt(site && site.dungeonID, 0);
  const typeID = toPositiveInt(site && site.typeID, 0);
  const position = normalizePosition(site && site.position);
  if (
    itemID < CUSTOM_SITE_ID_BASE ||
    itemID >= CUSTOM_SITE_ID_LIMIT ||
    solarSystemID <= 0 ||
    ecosystemID <= 0 ||
    dungeonID <= 0 ||
    typeID <= 0 ||
    !position
  ) {
    return null;
  }

  return {
    ...site,
    itemID,
    siteID: itemID,
    solarSystemID,
    ecosystemID,
    dungeonID,
    typeID,
    groupID: toPositiveInt(site.groupID, 0),
    categoryID: toPositiveInt(site.categoryID, 0),
    graphicID: toPositiveInt(site.graphicID, 0) || null,
    radius: Math.max(1, toFiniteNumber(site.radius, 1)),
    position,
    featureID: toPositiveInt(site.featureID, itemID),
    featureKind: String(site.featureKind || "landscape"),
    featureTags: Array.isArray(site.featureTags)
      ? site.featureTags.map((tag) => String(tag || "").trim()).filter(Boolean)
      : [],
    ecosystemName: String(site.ecosystemName || ""),
    itemName: String(site.itemName || `Ecosystem ${ecosystemID}`),
    dungeonNameID: toPositiveInt(site.dungeonNameID, 0) || null,
    archetypeID: toPositiveInt(site.archetypeID, 0) || null,
    dungeonEntryObjectID:
      toPositiveInt(site.dungeonEntryObjectID, 0) || null,
    createdAt: String(site.createdAt || ""),
    createdByCharacterID:
      toPositiveInt(site.createdByCharacterID, 0) || null,
    customLandscapeSite: true,
    kind: "landscapeSite",
    staticVisibilityScope: "system",
  };
}

function normalizeState(value) {
  const source = value && typeof value === "object" ? value : {};
  const sites = {};
  for (const rawSite of Object.values(
    source.sites && typeof source.sites === "object" ? source.sites : {},
  )) {
    const site = normalizeSite(rawSite);
    if (site) {
      sites[String(site.itemID)] = site;
    }
  }
  const highestSiteID = Object.values(sites).reduce(
    (highest, site) => Math.max(highest, site.itemID),
    CUSTOM_SITE_ID_BASE - 1,
  );
  return {
    version: STATE_VERSION,
    nextSiteID: Math.max(
      CUSTOM_SITE_ID_BASE,
      highestSiteID + 1,
      toPositiveInt(source.nextSiteID, CUSTOM_SITE_ID_BASE),
    ),
    sites,
  };
}

function inferFeatureMetadata(ecosystem) {
  const name = String(ecosystem && ecosystem.name || "").toLowerCase();
  if (name.includes("trojan")) {
    return { featureKind: "trojan", featureTags: ["trojan"] };
  }
  if (name.includes("belt") || name.includes("asteroid field")) {
    const tags = ["belt"];
    for (const zone of ["inner", "outer", "transitional"]) {
      if (name.includes(zone)) {
        tags.push(zone);
      }
    }
    return { featureKind: "asteroidBelt", featureTags: tags };
  }
  return { featureKind: "landscape", featureTags: [] };
}

function createCustomLandscapeSiteStore(options = {}) {
  const store = options.database || require(path.join(__dirname, "../gameStore"));
  const referenceData = options.worldData || require(path.join(__dirname, "./worldData"));
  const resolveType = options.resolveItemByTypeID || require(path.join(
    __dirname,
    "../services/inventory/itemTypeRegistry",
  )).resolveItemByTypeID;
  const now = options.now || (() => new Date().toISOString());

  function readState() {
    store.ensureTable(TABLE_NAME);
    const result = store.read(TABLE_NAME, "/");
    return normalizeState(result && result.success ? result.data : null);
  }

  function writeState(state) {
    const result = store.write(TABLE_NAME, "/", normalizeState(state), {
      force: true,
    });
    if (!result || result.success !== true) {
      return result || { success: false, errorMsg: "WRITE_ERROR" };
    }
    if (typeof store.flushTableSync === "function") {
      const flushResult = store.flushTableSync(TABLE_NAME);
      if (!flushResult || flushResult.success !== true) {
        return flushResult || { success: false, errorMsg: "FLUSH_ERROR" };
      }
    }
    return { success: true, errorMsg: null };
  }

  function listSites(solarSystemID = null) {
    const numericSystemID = toPositiveInt(solarSystemID, 0);
    return Object.values(readState().sites)
      .filter((site) => numericSystemID <= 0 || site.solarSystemID === numericSystemID)
      .sort((left, right) => left.itemID - right.itemID)
      .map(cloneSite);
  }

  function getSite(siteID) {
    const numericSiteID = toPositiveInt(siteID, 0);
    const site = readState().sites[String(numericSiteID)] || null;
    return site ? cloneSite(site) : null;
  }

  function allocateSiteID(state) {
    let siteID = Math.max(CUSTOM_SITE_ID_BASE, state.nextSiteID);
    while (
      siteID < CUSTOM_SITE_ID_LIMIT &&
      (
        state.sites[String(siteID)] ||
        (typeof referenceData.getLandscapeSiteByID === "function" &&
          referenceData.getLandscapeSiteByID(siteID))
      )
    ) {
      siteID += 1;
    }
    return siteID < CUSTOM_SITE_ID_LIMIT ? siteID : null;
  }

  function createSite(input = {}) {
    const ecosystemID = toPositiveInt(input.ecosystemID, 0);
    const solarSystemID = toPositiveInt(input.solarSystemID, 0);
    const position = normalizePosition(input.position);
    const ecosystem = referenceData.getLandscapeEcosystemByID(ecosystemID);
    if (!ecosystem) {
      return { success: false, errorMsg: "LANDSCAPE_ECOSYSTEM_NOT_FOUND" };
    }
    if (solarSystemID <= 0 || !position) {
      return { success: false, errorMsg: "INVALID_LANDSCAPE_POSITION" };
    }

    const dungeonID = toPositiveInt(ecosystem.entryDungeonID, 0);
    const dungeon = referenceData.getLandscapeDungeonTemplateByID(dungeonID);
    if (!dungeon) {
      return { success: false, errorMsg: "LANDSCAPE_DUNGEON_NOT_FOUND" };
    }
    const typeID = toPositiveInt(dungeon.entryTypeID, 0);
    if (typeID <= 0) {
      return { success: false, errorMsg: "LANDSCAPE_ENTRY_TYPE_NOT_FOUND" };
    }

    const sourceSite = (
      referenceData.ensureLoaded &&
      Array.isArray(referenceData.ensureLoaded().landscapeSites)
    )
      ? referenceData.ensureLoaded().landscapeSites.find(
        (site) => toPositiveInt(site && site.ecosystemID, 0) === ecosystemID,
      ) || null
      : null;
    const typeRecord = resolveType(typeID) || {};
    const state = readState();
    const siteID = allocateSiteID(state);
    if (!siteID) {
      return { success: false, errorMsg: "CUSTOM_LANDSCAPE_ID_EXHAUSTED" };
    }
    const feature = inferFeatureMetadata(ecosystem);
    const site = normalizeSite({
      itemID: siteID,
      siteID,
      typeID,
      groupID: toPositiveInt(typeRecord.groupID, toPositiveInt(sourceSite && sourceSite.groupID, 0)),
      categoryID: toPositiveInt(
        typeRecord.categoryID,
        toPositiveInt(sourceSite && sourceSite.categoryID, 0),
      ),
      graphicID: toPositiveInt(
        typeRecord.graphicID,
        toPositiveInt(sourceSite && sourceSite.graphicID, 0),
      ) || null,
      radius: Math.max(
        1,
        toFiniteNumber(typeRecord.radius, toFiniteNumber(sourceSite && sourceSite.radius, 1)),
      ),
      solarSystemID,
      position,
      featureID: siteID,
      ...feature,
      ecosystemID,
      ecosystemName: String(ecosystem.name || `Ecosystem ${ecosystemID}`),
      dungeonID,
      dungeonNameID: toPositiveInt(dungeon.dungeonNameID, 0) || null,
      archetypeID: toPositiveInt(dungeon.archetypeID, 0) || null,
      dungeonEntryObjectID: toPositiveInt(dungeon.entryObjectID, 0) || null,
      itemName: String(
        input.itemName ||
        typeRecord.name ||
        (sourceSite && sourceSite.itemName) ||
        ecosystem.name ||
        `Ecosystem ${ecosystemID}`,
      ),
      createdAt: now(),
      createdByCharacterID:
        toPositiveInt(input.createdByCharacterID, 0) || null,
    });
    if (!site) {
      return { success: false, errorMsg: "INVALID_CUSTOM_LANDSCAPE_SITE" };
    }

    const nextState = {
      ...state,
      nextSiteID: siteID + 1,
      sites: {
        ...state.sites,
        [String(siteID)]: site,
      },
    };
    const writeResult = writeState(nextState);
    return writeResult.success
      ? { success: true, errorMsg: null, data: cloneSite(site) }
      : writeResult;
  }

  function removeSite(siteID) {
    const numericSiteID = toPositiveInt(siteID, 0);
    const state = readState();
    const site = state.sites[String(numericSiteID)] || null;
    if (!site) {
      return { success: false, errorMsg: "CUSTOM_LANDSCAPE_SITE_NOT_FOUND" };
    }
    const nextSites = { ...state.sites };
    delete nextSites[String(numericSiteID)];
    const writeResult = writeState({ ...state, sites: nextSites });
    return writeResult.success
      ? { success: true, errorMsg: null, data: cloneSite(site) }
      : writeResult;
  }

  return {
    createSite,
    getSite,
    listSites,
    removeSite,
  };
}

let defaultStore = null;

function getDefaultStore() {
  if (!defaultStore) {
    defaultStore = createCustomLandscapeSiteStore();
  }
  return defaultStore;
}

module.exports = {
  CUSTOM_SITE_ID_BASE,
  CUSTOM_SITE_ID_LIMIT,
  STATE_VERSION,
  TABLE_NAME,
  createCustomLandscapeSiteStore,
  createSite: (...args) => getDefaultStore().createSite(...args),
  getSite: (...args) => getDefaultStore().getSite(...args),
  inferFeatureMetadata,
  listSites: (...args) => getDefaultStore().listSites(...args),
  normalizePosition,
  removeSite: (...args) => getDefaultStore().removeSite(...args),
};
