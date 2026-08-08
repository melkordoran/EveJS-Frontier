"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  CUSTOM_SITE_ID_BASE,
  createCustomLandscapeSiteStore,
} = require("../src/space/frontierLandscapeCustomSites");
const {
  executeFrontierLandscapeCommand,
  resolveSpawnPosition,
} = require("../src/services/chat/frontierLandscapeCommands");

function buildReferenceData() {
  const ecosystems = [
    {
      ecosystemID: 24,
      name: "Broken World - Inner Belt - Starter Megastructure Ruins",
      entryDungeonID: 14198,
      minNaturalWorldPatterns: 2,
      maxNaturalWorldPatterns: 2,
      minBrokenWorldPatterns: 2,
      maxBrokenWorldPatterns: 4,
      naturalWorldPatterns: [{ dungeonID: 14203 }],
      brokenWorldPatterns: [{ dungeonID: 14229 }],
    },
    {
      ecosystemID: 27,
      name: "Broken World - Any Belt - Starter Supply Station",
      entryDungeonID: 14201,
      minNaturalWorldPatterns: 1,
      maxNaturalWorldPatterns: 1,
      minBrokenWorldPatterns: 1,
      maxBrokenWorldPatterns: 2,
      naturalWorldPatterns: [{ dungeonID: 14203 }],
      brokenWorldPatterns: [{ dungeonID: 13629 }],
    },
  ];
  const dungeons = new Map([
    [14198, {
      dungeonID: 14198,
      dungeonNameID: 1039001,
      entryObjectID: 1549228,
      entryTypeID: 92666,
    }],
    [14201, {
      dungeonID: 14201,
      dungeonNameID: 1039004,
      entryObjectID: 1549234,
      entryTypeID: 92669,
    }],
  ]);
  return {
    ensureLoaded: () => ({ landscapeEcosystems: ecosystems, landscapeSites: [] }),
    getLandscapeEcosystems: () => [...ecosystems],
    getLandscapeEcosystemByID: (ecosystemID) => (
      ecosystems.find((entry) => entry.ecosystemID === Number(ecosystemID)) || null
    ),
    getLandscapeDungeonTemplateByID: (dungeonID) => (
      dungeons.get(Number(dungeonID)) || null
    ),
    getLandscapeSiteByID: () => null,
  };
}

function buildMemoryDatabase() {
  let data = {};
  return {
    ensureTable() {},
    read() {
      return { success: true, data };
    },
    write(_table, _path, nextData) {
      data = structuredClone(nextData);
      return { success: true };
    },
    flushTableSync() {
      return { success: true };
    },
  };
}

function buildStore() {
  return createCustomLandscapeSiteStore({
    database: buildMemoryDatabase(),
    now: () => "2026-08-02T04:30:00.000Z",
    resolveItemByTypeID(typeID) {
      if (Number(typeID) === 92666) {
        return {
          typeID: 92666,
          name: "Inner Reliquary Husk",
          groupID: 4873,
          categoryID: 2,
          graphicID: 1211,
          radius: 1,
        };
      }
      return {
        typeID: 92669,
        name: "Outer Respite Anchorage",
        groupID: 4873,
        categoryID: 2,
        graphicID: 1211,
        radius: 1,
      };
    },
    worldData: buildReferenceData(),
  });
}

test("custom landscape sites preserve client ecosystem authority and persist", () => {
  const store = buildStore();
  const result = store.createSite({
    ecosystemID: 24,
    solarSystemID: 30021998,
    position: { x: 100, y: 200, z: 300 },
    createdByCharacterID: 140000005,
  });

  assert.equal(result.success, true);
  assert.equal(result.data.itemID, CUSTOM_SITE_ID_BASE);
  assert.equal(result.data.typeID, 92666);
  assert.equal(result.data.itemName, "Inner Reliquary Husk");
  assert.equal(result.data.dungeonID, 14198);
  assert.equal(result.data.customLandscapeSite, true);
  assert.equal(result.data.staticVisibilityScope, "system");
  assert.deepEqual(result.data.featureTags, ["belt", "inner"]);
  assert.deepEqual(store.listSites(30021998), [result.data]);

  assert.equal(store.removeSite(result.data.itemID).success, true);
  assert.deepEqual(store.listSites(30021998), []);
});

test("landscape placement supports forward, relative, and exact coordinates", () => {
  const ship = {
    position: { x: 10, y: 20, z: 30 },
    direction: { x: 0, y: 0, z: -2 },
  };

  assert.deepEqual(resolveSpawnPosition(ship, "ahead=100").position, {
    x: 10,
    y: 20,
    z: -70,
  });
  assert.deepEqual(resolveSpawnPosition(ship, "offset=1,-2,3").position, {
    x: 11,
    y: 18,
    z: 33,
  });
  assert.deepEqual(resolveSpawnPosition(ship, "pos=-5,6,7").position, {
    x: -5,
    y: 6,
    z: 7,
  });
});

test("landscape command spawns Supply Station through the live scene runtime", () => {
  const siteStore = buildStore();
  const ship = {
    itemID: 9988400001895,
    position: { x: 1000, y: 2000, z: 3000 },
    direction: { x: 1, y: 0, z: 0 },
  };
  const scene = {
    systemID: 30021998,
    getShipEntityForSession: () => ship,
  };
  let liveSite = null;
  const spaceRuntime = {
    getSceneForSession: () => scene,
    addCustomLandscapeSite(site) {
      liveSite = site;
      return {
        success: true,
        data: {
          materialized: {
            propsSpawned: 18,
            patterns: [{ dungeonID: 14203 }, { dungeonID: 13629 }],
            locators: [{ typeID: 91211 }],
          },
        },
      };
    },
  };
  const referenceData = buildReferenceData();
  const result = executeFrontierLandscapeCommand(
    { characterID: 140000005 },
    "spawn 27 ahead=5000",
    {
      itemTypes: {
        resolveItemByTypeID: () => ({ name: "Outer Respite Anchorage" }),
      },
      siteStore,
      spaceRuntime,
      worldData: referenceData,
    },
  );

  assert.equal(result.success, true);
  assert.equal(liveSite.ecosystemID, 27);
  assert.deepEqual(liveSite.position, { x: 6000, y: 2000, z: 3000 });
  assert.match(result.message, /Outer Respite Anchorage/);
  assert.match(result.message, /18 props, 2 patterns, 1 locators/);
});
