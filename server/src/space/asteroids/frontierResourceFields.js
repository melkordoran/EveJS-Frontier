"use strict";

const FRONTIER_RESOURCE_FIELD_SOURCE = "frontierLandscapeEcosystem";
const FRONTIER_SYNTHETIC_RESOURCE_FIELDS_ENABLED = false;

const RESOURCE_FIELD_PROFILES = Object.freeze({
  inner: Object.freeze({
    fieldStyleID: "frontier_inner_resource_field",
    resourceTypeIDs: Object.freeze([91374, 91375, 91376]),
    asteroidCount: 30,
    maxAsteroidCount: 42,
    fieldRadiusMeters: 38_000,
    clusterRadiusMeters: 6_000,
    verticalSpreadMeters: 5_000,
  }),
  outer: Object.freeze({
    fieldStyleID: "frontier_outer_resource_field",
    resourceTypeIDs: Object.freeze([91377, 91378, 91379, 91380, 91381]),
    asteroidCount: 34,
    maxAsteroidCount: 48,
    fieldRadiusMeters: 46_000,
    clusterRadiusMeters: 7_000,
    verticalSpreadMeters: 6_000,
  }),
  transitional: Object.freeze({
    fieldStyleID: "frontier_transitional_resource_field",
    resourceTypeIDs: Object.freeze([
      91374,
      91375,
      91376,
      91377,
      91378,
      91379,
      91380,
      91381,
    ]),
    asteroidCount: 32,
    maxAsteroidCount: 46,
    fieldRadiusMeters: 42_000,
    clusterRadiusMeters: 6_500,
    verticalSpreadMeters: 5_500,
  }),
  trojan: Object.freeze({
    fieldStyleID: "frontier_trojan_resource_field",
    resourceTypeIDs: Object.freeze([91374, 91375, 91376, 91379, 91380, 91381]),
    asteroidCount: 24,
    maxAsteroidCount: 36,
    fieldRadiusMeters: 32_000,
    clusterRadiusMeters: 5_000,
    verticalSpreadMeters: 4_500,
  }),
});

const FRONTIER_RESOURCE_FIELD_STYLES = Object.freeze(
  Object.values(RESOURCE_FIELD_PROFILES).map((profile) => Object.freeze({
    fieldStyleID: profile.fieldStyleID,
    source: FRONTIER_RESOURCE_FIELD_SOURCE,
  })),
);

function toPositiveInt(value, fallback = 0) {
  const numeric = Math.trunc(Number(value) || 0);
  return numeric > 0 ? numeric : fallback;
}

function normalizeTags(site) {
  return new Set(
    (Array.isArray(site && site.featureTags) ? site.featureTags : [])
      .map((tag) => String(tag || "").trim().toLowerCase())
      .filter(Boolean),
  );
}

function resolveFrontierResourceZone(site) {
  const featureKind = String(site && site.featureKind || "").trim().toLowerCase();
  const tags = normalizeTags(site);

  if (featureKind === "trojan" && tags.has("trojan")) {
    return "trojan";
  }
  if (featureKind !== "asteroidbelt" || !tags.has("belt")) {
    return null;
  }
  if (tags.has("transitional")) {
    return "transitional";
  }
  if (tags.has("inner")) {
    return "inner";
  }
  if (tags.has("outer")) {
    return "outer";
  }
  return null;
}

function normalizePosition(position) {
  const normalized = {
    x: Number(position && position.x),
    y: Number(position && position.y),
    z: Number(position && position.z),
  };
  return Object.values(normalized).every(Number.isFinite) ? normalized : null;
}

function buildFrontierResourceFieldDefinition(site) {
  const itemID = toPositiveInt(site && site.itemID, 0);
  const solarSystemID = toPositiveInt(site && site.solarSystemID, 0);
  const position = normalizePosition(site && site.position);
  const resourceZone = resolveFrontierResourceZone(site);
  const profile = resourceZone ? RESOURCE_FIELD_PROFILES[resourceZone] : null;
  if (!profile || itemID <= 0 || solarSystemID <= 0 || !position) {
    return null;
  }

  const ecosystemID = toPositiveInt(site && site.ecosystemID, 0);
  const fieldSeed = (
    (itemID >>> 0) ^
    Math.imul(ecosystemID || 1, 0x9E3779B1)
  ) >>> 0;

  return {
    itemID,
    itemName: String(site && site.itemName || `Resource Field ${itemID}`),
    solarSystemID,
    orbitID: toPositiveInt(site && site.featureID, 0),
    position,
    fieldStyleID: profile.fieldStyleID,
    fieldSeed: fieldSeed || itemID,
    asteroidCount: profile.asteroidCount,
    maxAsteroidCount: profile.maxAsteroidCount,
    fieldRadiusMeters: profile.fieldRadiusMeters,
    clusterRadiusMeters: profile.clusterRadiusMeters,
    verticalSpreadMeters: profile.verticalSpreadMeters,
    resourceTypeIDs: [...profile.resourceTypeIDs],
    resourceZone,
    resourceFieldSource: FRONTIER_RESOURCE_FIELD_SOURCE,
    frontierLandscapeSite: true,
    sourceLandscapeSiteID: itemID,
    ecosystemID,
    ecosystemName: String(site && site.ecosystemName || ""),
  };
}

module.exports = {
  FRONTIER_RESOURCE_FIELD_SOURCE,
  FRONTIER_RESOURCE_FIELD_STYLES,
  FRONTIER_SYNTHETIC_RESOURCE_FIELDS_ENABLED,
  RESOURCE_FIELD_PROFILES,
  buildFrontierResourceFieldDefinition,
  resolveFrontierResourceZone,
};
