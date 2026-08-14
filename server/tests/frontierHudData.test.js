"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const SearchService = require("../src/services/_other/searchService");
const MapService = require("../src/services/map/mapService");
const CairnService = require("../src/services/frontier/cairnService");
const IffMapService = require("../src/services/frontier/iffMapService");
const { marshalEncode } = require("../src/network/tcp/utils/marshal");
const {
  buildSystemInfo,
  buildSystemInfoFromAuthoritativeRecord,
} = require("../src/services/frontier/systemInfoService");

const {
  buildStaticSearchIndexFromRows,
} = SearchService._testing;

function dictEntry(dict, key) {
  const entry = dict && Array.isArray(dict.entries)
    ? dict.entries.find(([entryKey]) => entryKey === key)
    : null;
  return entry ? entry[1] : undefined;
}

test("Frontier static search indexes every constellation/region ID without invented names", () => {
  const constellationIndex = buildStaticSearchIndexFromRows(6, [
    { constellationID: 20000004, constellationName: "C-20000004" },
    { constellationID: 20000004 },
    { constellationID: 20000005 },
  ]);
  assert.deepEqual(
    constellationIndex.exactRawNameMap.get("c-20000005"),
    [20000005],
  );
  assert.equal(
    constellationIndex.entries.filter((entry) => entry.id === 20000004).length,
    1,
  );

  const regionIndex = buildStaticSearchIndexFromRows(8, [
    { regionID: 10000004, name: { en: "653-Y-21" } },
    { regionID: 10000004 },
    { regionID: 10000005 },
  ]);
  assert.deepEqual(regionIndex.exactRawNameMap.get("653-y-21"), [10000004]);
  assert.deepEqual(regionIndex.exactRawNameMap.get("10000005"), [10000005]);
  assert.equal(
    regionIndex.entries.some((entry) => entry.rawName === "region 10000005"),
    false,
  );
});

test("Frontier map exposes both pathfinder route prerequisites", () => {
  const service = new MapService();
  const avoidance = service.Handle_GetEdencomAvoidanceSystems();
  assert.equal(avoidance.type, "list");
  assert.equal(new Set(avoidance.items).size, avoidance.items.length);
  assert.deepEqual([...avoidance.items].sort((left, right) => left - right), avoidance.items);
  assert.ok(avoidance.items.includes(30004992));
  assert.ok(avoidance.items.includes(30002048));

  const jumpBridges = service.Handle_GetJumpBridgesWithMyAccess([], null);
  assert.equal(Array.isArray(jumpBridges), true);
  assert.equal(jumpBridges.length, 3);
  for (const list of jumpBridges) {
    assert.equal(list.type, "list");
    assert.equal(Array.isArray(list.items), true);
  }
});

test("Frontier SystemInfo stays exact-shaped when 3467658 lacks authored inputs", () => {
  const response = buildSystemInfo(30000004, {
    getSolarSystemByID: (systemID) => (
      systemID === 30000004
        ? { solarSystemID: systemID, security: 0, landscapeSiteCount: 42 }
        : null
    ),
  });
  assert.deepEqual(response, {
    type: "dict",
    entries: [
      ["danger_level", null],
      ["resource_composition", { type: "list", items: [] }],
      ["feature_resource_composition", { type: "dict", entries: [] }],
      ["resource_potential_bucket", null],
      ["feature_resource_potential_bucket", { type: "dict", entries: [] }],
      ["site_resource_potential_bucket", { type: "dict", entries: [] }],
    ],
  });
});

test("Frontier SystemInfo validates an authoritative aggregate before marshalling", () => {
  const response = buildSystemInfoFromAuthoritativeRecord({
    danger_level: 4,
    resource_composition: [
      ["Metallic", 0.2],
      ["Carbonaceous", 0.5],
      ["Unknown", 0.3],
    ],
    feature_resource_composition: {
      42: [["Silicate", 0.75]],
      invalid: [["Metallic", 1]],
    },
    resource_potential_bucket: 3,
    feature_resource_potential_bucket: { 42: 5, 43: 8 },
    site_resource_potential_bucket: { 9001: 1, 9002: 0 },
  });
  assert.equal(dictEntry(response, "danger_level"), 4);
  assert.deepEqual(dictEntry(response, "resource_composition"), {
    type: "list",
    items: [["Carbonaceous", 0.5], ["Metallic", 0.2]],
  });
  assert.deepEqual(dictEntry(response, "feature_resource_composition"), {
    type: "dict",
    entries: [[42, { type: "list", items: [["Silicate", 0.75]] }]],
  });
  assert.equal(dictEntry(response, "resource_potential_bucket"), 3);
  assert.deepEqual(dictEntry(response, "feature_resource_potential_bucket"), {
    type: "dict",
    entries: [[42, 5]],
  });
  assert.deepEqual(dictEntry(response, "site_resource_potential_bucket"), {
    type: "dict",
    entries: [[9001, 1]],
  });
});

function buildCairnOptions(channel, code = null) {
  const entities = [
    {
      itemID: 1001,
      typeID: CairnService.TYPE_FIELD_CAIRN,
      itemName: "My Cairn",
      ownerID: 42,
      position: { x: 1, y: 2, z: 3 },
    },
    {
      itemID: 1002,
      typeID: CairnService.TYPE_FIELD_CAIRN,
      itemName: "Tribe Cairn",
      ownerID: 43,
      position: [4, 5, 6],
    },
    {
      itemID: 1003,
      typeID: CairnService.TYPE_FIELD_CAIRN,
      itemName: "Foreign Tribe Cairn",
      ownerID: 44,
      position: [7, 8, 9],
    },
    {
      itemID: 1004,
      typeID: CairnService.TYPE_FIELD_CAIRN,
      itemName: "Matching Code Cairn",
      ownerID: 44,
      position: [10, 11, 12],
    },
    { itemID: 1005, typeID: 12345, ownerID: 42, position: [0, 0, 0] },
  ];
  const itemByID = new Map(entities.map((entity) => [entity.itemID, {
    ...entity,
    state: entity.itemID === 1002 || entity.itemID === 1003
      ? { channel: "tribe", code: null }
      : entity.itemID === 1004
        ? { channel: "code", code: "shared-code" }
        : { channel: null, code: null },
  }]));
  return {
    getSceneForSession: () => ({
      dynamicEntities: new Map(entities.map((entity) => [entity.itemID, entity])),
    }),
    findItemById: (itemID) => itemByID.get(itemID) || null,
    readTransponderState: (item) => item.state,
    getCharacterCorporationID: (characterID) => (
      characterID === 42 || characterID === 43 ? 7 : 8
    ),
    resolveActiveTransponder: () => ({ channel, code }),
  };
}

test("Frontier Cairn markers honor owner and mutual tribe visibility", () => {
  const service = new CairnService("cairnService", buildCairnOptions("tribe"));
  const response = service.Handle_get_visible_cairns([], {
    characterID: 42,
    corporationID: 7,
    shipID: 500,
    _space: { systemID: 30000004, shipID: 500 },
  });
  assert.deepEqual(response.items.map((row) => dictEntry(row, "item_id")), [1001, 1002]);
  assert.deepEqual(dictEntry(response.items[0], "position"), [1, 2, 3]);
  assert.equal(dictEntry(response.items[0], "is_mine"), true);
  assert.equal(dictEntry(response.items[1], "transponder_channel"), "tribe");
  assert.doesNotThrow(() => marshalEncode(response, { compatibilityProfile: "frontier" }));
});

test("Frontier Cairn markers honor matching code visibility", () => {
  const service = new CairnService(
    "cairnService",
    buildCairnOptions("code", "shared-code"),
  );
  const response = service.Handle_get_visible_cairns([], {
    characterID: 42,
    corporationID: 7,
    shipID: 500,
    _space: { systemID: 30000004, shipID: 500 },
  });
  assert.deepEqual(response.items.map((row) => dictEntry(row, "item_id")), [1001, 1004]);
  assert.equal(dictEntry(response.items[1], "transponder_code"), "shared-code");
});

test("Frontier Cairn transponder mutation rejects owned non-Cairn items unchanged", () => {
  const originalCustomInfo = "Berth:9988400001127";
  const ownedShip = {
    itemID: 9988400001895,
    typeID: 95276,
    ownerID: 42,
    customInfo: originalCustomInfo,
  };
  let writeCalls = 0;
  const service = new IffMapService({
    findItemById: (itemID) => (
      itemID === ownedShip.itemID ? ownedShip : null
    ),
    writeTransponderState: () => {
      writeCalls += 1;
      ownedShip.customInfo = "mutated";
      return { success: true };
    },
  });

  assert.equal(
    service.Handle_set_transponder(
      [ownedShip.itemID, "tribe", null],
      { characterID: 42, solarsystemid2: 30000004 },
    ),
    false,
  );
  assert.equal(writeCalls, 0);
  assert.equal(ownedShip.customInfo, originalCustomInfo);
});
