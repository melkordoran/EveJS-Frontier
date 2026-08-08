"use strict";

const path = require("path");

const TABLE_NAME = "frontierRiftSites";
const STATE_VERSION = 1;
const RIFT_SITE_ID_BASE = 9_200_000_000;
const RIFT_SITE_ID_LIMIT = 9_300_000_000;

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

function normalizeSite(site) {
  const itemID = toPositiveInt(site && (site.itemID ?? site.siteID), 0);
  const solarSystemID = toPositiveInt(site && site.solarSystemID, 0);
  const dungeonID = toPositiveInt(site && site.dungeonID, 0);
  const typeID = toPositiveInt(site && site.typeID, 0);
  const position = normalizePosition(site && site.position);
  if (
    itemID < RIFT_SITE_ID_BASE ||
    itemID >= RIFT_SITE_ID_LIMIT ||
    solarSystemID <= 0 ||
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
    dungeonID,
    typeID,
    groupID: toPositiveInt(site.groupID, 0),
    categoryID: toPositiveInt(site.categoryID, 0),
    graphicID: toPositiveInt(site.graphicID, 0) || null,
    radius: Math.max(1, toFiniteNumber(site.radius, 1)),
    signatureRadius: Math.max(1, toFiniteNumber(site.signatureRadius, site.radius || 1)),
    position,
    itemName: String(site.itemName || `Rift ${dungeonID}`),
    dungeonNameID: toPositiveInt(site.dungeonNameID, 0) || null,
    archetypeID: toPositiveInt(site.archetypeID, 0) || null,
    dungeonEntryObjectID: toPositiveInt(site.dungeonEntryObjectID, 0) || null,
    resourceTypeIDs: Array.isArray(site.resourceTypeIDs)
      ? [...new Set(site.resourceTypeIDs.map((entry) => toPositiveInt(entry, 0)).filter(Boolean))]
      : [],
    points: Math.max(1, toPositiveInt(site.points, 1)),
    createdAt: String(site.createdAt || ""),
    createdByCharacterID: toPositiveInt(site.createdByCharacterID, 0) || null,
    customFrontierRiftSite: true,
    kind: "riftDungeon",
    staticVisibilityScope: "system",
  };
}

function cloneSite(site) {
  const normalized = normalizeSite(site);
  return normalized ? {
    ...normalized,
    position: { ...normalized.position },
    resourceTypeIDs: [...normalized.resourceTypeIDs],
  } : null;
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
    RIFT_SITE_ID_BASE - 1,
  );
  return {
    version: STATE_VERSION,
    nextSiteID: Math.max(
      RIFT_SITE_ID_BASE,
      highestSiteID + 1,
      toPositiveInt(source.nextSiteID, RIFT_SITE_ID_BASE),
    ),
    sites,
  };
}

function createFrontierRiftSiteStore(options = {}) {
  const store = options.database || require(path.join(__dirname, "../gameStore"));
  const authority = options.authority || require(path.join(__dirname, "./frontierRiftAuthority"));
  const now = options.now || (() => new Date().toISOString());

  function readState() {
    store.ensureTable(TABLE_NAME);
    const result = store.read(TABLE_NAME, "/");
    return normalizeState(result && result.success ? result.data : null);
  }

  function writeState(state) {
    const result = store.write(TABLE_NAME, "/", normalizeState(state), { force: true });
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
    const site = readState().sites[String(toPositiveInt(siteID, 0))] || null;
    return site ? cloneSite(site) : null;
  }

  function createSite(input = {}) {
    const template = authority.resolveTemplate(input.template ?? input.dungeonID ?? input.typeID);
    const solarSystemID = toPositiveInt(input.solarSystemID, 0);
    const position = normalizePosition(input.position);
    if (!template) {
      return { success: false, errorMsg: "RIFT_TEMPLATE_NOT_FOUND" };
    }
    if (solarSystemID <= 0 || !position) {
      return { success: false, errorMsg: "INVALID_RIFT_POSITION" };
    }

    const state = readState();
    let siteID = Math.max(RIFT_SITE_ID_BASE, state.nextSiteID);
    while (siteID < RIFT_SITE_ID_LIMIT && state.sites[String(siteID)]) {
      siteID += 1;
    }
    if (siteID >= RIFT_SITE_ID_LIMIT) {
      return { success: false, errorMsg: "RIFT_SITE_ID_EXHAUSTED" };
    }

    const site = normalizeSite({
      itemID: siteID,
      solarSystemID,
      dungeonID: template.dungeonID,
      typeID: template.entryTypeID,
      groupID: template.entryType.groupID,
      categoryID: template.entryType.categoryID,
      graphicID: template.entryType.graphicID,
      radius: template.entryType.radius,
      signatureRadius: template.entryType.radius,
      position,
      itemName: String(input.itemName || template.itemName),
      dungeonNameID: template.dungeonNameID,
      archetypeID: template.archetypeID,
      dungeonEntryObjectID: template.entryObjectID,
      resourceTypeIDs: template.resources.map((resource) => resource.typeID),
      points: Math.max(1, template.resources.length),
      createdAt: now(),
      createdByCharacterID: toPositiveInt(input.createdByCharacterID, 0) || null,
    });
    const nextState = {
      ...state,
      nextSiteID: siteID + 1,
      sites: { ...state.sites, [String(siteID)]: site },
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
      return { success: false, errorMsg: "RIFT_SITE_NOT_FOUND" };
    }
    const sites = { ...state.sites };
    delete sites[String(numericSiteID)];
    const result = writeState({ ...state, sites });
    return result.success
      ? { success: true, errorMsg: null, data: cloneSite(site) }
      : result;
  }

  return { createSite, getSite, listSites, removeSite };
}

let defaultStore = null;

function getDefaultStore() {
  if (!defaultStore) {
    defaultStore = createFrontierRiftSiteStore();
  }
  return defaultStore;
}

module.exports = {
  RIFT_SITE_ID_BASE,
  RIFT_SITE_ID_LIMIT,
  STATE_VERSION,
  TABLE_NAME,
  createFrontierRiftSiteStore,
  createSite: (...args) => getDefaultStore().createSite(...args),
  getSite: (...args) => getDefaultStore().getSite(...args),
  listSites: (...args) => getDefaultStore().listSites(...args),
  normalizePosition,
  removeSite: (...args) => getDefaultStore().removeSite(...args),
};
