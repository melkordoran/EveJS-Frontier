"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  FRONTIER_SYNTHETIC_RESOURCE_FIELDS_ENABLED,
  buildFrontierResourceFieldDefinition,
  resolveFrontierResourceZone,
} = require("../src/space/asteroids/frontierResourceFields");

test("Frontier landscape resource-field prototypes remain deterministic but disabled", () => {
  const site = {
    itemID: 900439961,
    itemName: "Outer Vestiges",
    solarSystemID: 30021998,
    featureID: 500439960,
    featureKind: "asteroidBelt",
    featureTags: ["belt", "outer", "belt_cold"],
    ecosystemID: 7,
    ecosystemName: "Broken World - Outer Belt - Vestiges",
    position: {
      x: 85203619766.684,
      y: -2716284710.642,
      z: 12181661045.76,
    },
  };

  const first = buildFrontierResourceFieldDefinition(site);
  const second = buildFrontierResourceFieldDefinition(site);

  assert.equal(FRONTIER_SYNTHETIC_RESOURCE_FIELDS_ENABLED, false);
  assert.equal(resolveFrontierResourceZone(site), "outer");
  assert.deepEqual(first, second);
  assert.equal(first.itemID, 900439961);
  assert.equal(first.fieldStyleID, "frontier_outer_resource_field");
  assert.deepEqual(first.resourceTypeIDs, [91377, 91378, 91379, 91380, 91381]);
  assert.equal(first.sourceLandscapeSiteID, site.itemID);
});

test("Trojan Drifting Annex is covered by the same disabled synthetic-field policy", () => {
  const trojan = buildFrontierResourceFieldDefinition({
    itemID: 900439962,
    itemName: "Trojan Drifting Annex",
    solarSystemID: 30021998,
    featureID: 500439961,
    featureKind: "trojan",
    featureTags: ["trojan", "inner", "super_host"],
    ecosystemID: 13,
    position: { x: 1, y: 2, z: 3 },
  });

  assert.equal(FRONTIER_SYNTHETIC_RESOURCE_FIELDS_ENABLED, false);
  assert.equal(trojan.resourceZone, "trojan");
  assert.deepEqual(trojan.resourceTypeIDs, [91374, 91375, 91376, 91379, 91380, 91381]);
  assert.equal(buildFrontierResourceFieldDefinition({
    itemID: 42,
    solarSystemID: 30021998,
    featureKind: "landmark",
    featureTags: ["inner"],
    position: { x: 1, y: 2, z: 3 },
  }), null);
});
