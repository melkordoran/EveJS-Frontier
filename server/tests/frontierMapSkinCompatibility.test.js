"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const MapService = require("../src/services/map/mapService");
const ServiceManager = require("../src/services/serviceManager");
const {
  WEB_CALL_ALLOWLIST,
} = require("../src/_secondary/express/evejsWebGatewayRuntime");
const ShipCosmeticsMgrService = require(
  "../src/services/ship/shipCosmeticsMgrService",
);
const ShipSkinMgrService = require(
  "../src/services/ship/shipSkinMgrService",
);
const {
  SHIP_SKIN_MGR_ALLOWED_METHODS,
} = ShipSkinMgrService;

const {
  buildCorporationMemberMapRows,
} = MapService._testing;
const {
  buildLicensedSkinKeyVal,
  resolveAppliedSkinLicenseRecord,
  resolveOwnedShipItem,
} = ShipCosmeticsMgrService._testing;

function getObjectEntry(object, key) {
  const entries = object && object.args && object.args.entries;
  const match = Array.isArray(entries)
    ? entries.find(([entryKey]) => entryKey === key)
    : null;
  return match ? match[1] : undefined;
}

test("Frontier corporation map rows include unique online same-corporation pilots", () => {
  const requester = {
    characterID: 140000005,
    corporationID: 1000009,
    solarsystemid2: 30000010,
    lastActivity: 10,
  };
  const sessions = [
    requester,
    {
      characterID: 140000006,
      corporationID: 1000009,
      solarsystemid2: 30000004,
      lastActivity: 10,
    },
    {
      characterID: 140000006,
      corpid: 1000009,
      solarsystemid2: 30000005,
      lastActivity: 20,
    },
    {
      characterID: 140000007,
      corporationID: 1000010,
      solarsystemid2: 30000006,
    },
    {
      characterID: 140000008,
      corporationID: 1000009,
      locationid: 60000001,
    },
    {
      characterID: 140000009,
      corporationID: 1000009,
      locationid: 30000007,
    },
  ];

  assert.deepEqual(buildCorporationMemberMapRows(requester, sessions), [
    [140000005, 30000010],
    [140000006, 30000005],
    [140000009, 30000007],
  ]);
});

test("Frontier map service returns the expected corporation-member rowset shape", () => {
  const response = new MapService().Handle_GetMyExtraMapInfo([], null);

  assert.equal(response.name, "eve.common.script.sys.rowset.Rowset");
  assert.deepEqual(getObjectEntry(response, "header"), {
    type: "list",
    items: ["characterID", "locationID"],
  });
  assert.deepEqual(getObjectEntry(response, "lines"), {
    type: "list",
    items: [],
  });
});

test("private corporation-member locations are not exposed by the web-call bridge", () => {
  assert.equal(
    WEB_CALL_ALLOWLIST.some(
      ({ service, method }) =>
        service === "map" && method === "GetMyExtraMapInfo",
    ),
    false,
  );
});

test("build 3455996 shipSkinMgr compatibility service is registered independently", () => {
  const serviceManager = new ServiceManager();
  const cosmeticsService = new ShipCosmeticsMgrService();
  const skinService = new ShipSkinMgrService();

  serviceManager.register(cosmeticsService);
  serviceManager.register(skinService);

  assert.equal(serviceManager.lookup("shipCosmeticsMgr"), cosmeticsService);
  assert.equal(serviceManager.lookup("shipSkinMgr"), skinService);
  assert.equal(typeof skinService.Handle_GetAppliedSkin, "function");
  assert.equal(typeof skinService.Handle_GetAppliedSkinMaterialSetID, "function");

  let inheritedDeveloperMethodCalled = false;
  skinService.Handle_GiveSkin = () => {
    inheritedDeveloperMethodCalled = true;
  };
  assert.equal(skinService.callMethod("GiveSkin", [], {}), null);
  assert.equal(inheritedDeveloperMethodCalled, false);
  assert.equal(SHIP_SKIN_MGR_ALLOWED_METHODS.has("ApplySkinToShip"), true);
  assert.equal(SHIP_SKIN_MGR_ALLOWED_METHODS.has("RemoveSkin"), false);
});

test("shipSkinMgr resolves an applied skin only for its licensee and hull", () => {
  const appliedRecord = {
    shipID: 9988400001895,
    characterID: 140000005,
    ownerID: 140000005,
    typeID: 95276,
    skinID: 1234,
  };
  const licenseRecord = {
    skinID: 1234,
    expiresAtFileTime: null,
    isSingleUse: false,
    licenseTypeID: 5678,
    skinMaterialID: 9012,
  };
  const options = {
    getAppliedSkinRecord: () => appliedRecord,
    findItemById: () => ({
      itemID: 9988400001895,
      ownerID: 140000005,
      typeID: 95276,
    }),
    getEffectiveLicenseRecord: (licenseeID, skinID) =>
      licenseeID === 140000005 && skinID === 1234 ? licenseRecord : null,
  };

  assert.equal(
    resolveAppliedSkinLicenseRecord(
      140000005,
      9988400001895,
      95276,
      options,
    ),
    licenseRecord,
  );
  assert.equal(
    resolveAppliedSkinLicenseRecord(
      140000006,
      9988400001895,
      95276,
      options,
    ),
    null,
  );
  assert.equal(
    resolveAppliedSkinLicenseRecord(
      140000005,
      9988400001895,
      95277,
      options,
    ),
    null,
  );

  assert.deepEqual(buildLicensedSkinKeyVal(licenseRecord), {
    type: "object",
    name: "util.KeyVal",
    args: {
      type: "dict",
      entries: [
        ["skinID", 1234],
        ["expires", null],
        ["isSingleUse", false],
        ["licenseTypeID", 5678],
        ["skinMaterialID", 9012],
        ["materialID", 9012],
      ],
    },
  });
});

test("ship SKIN mutation accepts only a ship owned by the active character", () => {
  const ownedShip = {
    itemID: 9988400001895,
    ownerID: 140000005,
    typeID: 95276,
  };
  const options = { findItemById: () => ownedShip };

  assert.equal(
    resolveOwnedShipItem(9988400001895, 140000005, options),
    ownedShip,
  );
  assert.equal(
    resolveOwnedShipItem(9988400001895, 140000006, options),
    null,
  );
  assert.equal(resolveOwnedShipItem(9988400001895, 0, options), null);
});
