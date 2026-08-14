const BaseService = require("../baseService");
const { buildDict, buildList } = require("../_shared/serviceHelpers");
const worldData = require("../../space/worldData");

const RESOURCE_CATEGORIES = Object.freeze([
  "Carbonaceous",
  "Silicate",
  "Metallic",
]);
const RESOURCE_CATEGORY_ORDER = new Map(
  RESOURCE_CATEGORIES.map((category, index) => [category, index]),
);

function buildEmptySystemInfo() {
  return buildDict([
    ["danger_level", null],
    ["resource_composition", buildList([])],
    ["feature_resource_composition", buildDict([])],
    ["resource_potential_bucket", null],
    ["feature_resource_potential_bucket", buildDict([])],
    ["site_resource_potential_bucket", buildDict([])],
  ]);
}

function buildEmptyCrudeRiftInfo() {
  return buildDict([
    ["points", 0],
    ["counts", buildDict([])],
  ]);
}

function toPositiveInt(value, fallback = 0) {
  const numeric = Math.trunc(Number(value) || 0);
  return numeric > 0 ? numeric : fallback;
}

function toBoundedInteger(value, minimum, maximum) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric >= minimum && numeric <= maximum
    ? numeric
    : null;
}

function toRecordEntries(value) {
  if (value instanceof Map) {
    return [...value.entries()];
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return Object.entries(value);
  }
  return [];
}

function normalizeResourceComposition(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  const byCategory = new Map();
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length < 2) {
      continue;
    }
    const category = String(entry[0] || "").trim();
    const amount = Number(entry[1]);
    if (
      !RESOURCE_CATEGORY_ORDER.has(category) ||
      !Number.isFinite(amount) ||
      amount < 0
    ) {
      continue;
    }
    byCategory.set(category, amount);
  }
  return [...byCategory.entries()].sort(
    (left, right) =>
      RESOURCE_CATEGORY_ORDER.get(left[0]) - RESOURCE_CATEGORY_ORDER.get(right[0]),
  );
}

function normalizeFeatureResourceComposition(value) {
  const entries = [];
  for (const [rawFeatureID, rawComposition] of toRecordEntries(value)) {
    const featureID = toPositiveInt(rawFeatureID, 0);
    const composition = normalizeResourceComposition(rawComposition);
    if (featureID > 0 && composition.length > 0) {
      entries.push([featureID, buildList(composition)]);
    }
  }
  return entries.sort((left, right) => left[0] - right[0]);
}

function normalizePotentialBucketMap(value) {
  const entries = [];
  for (const [rawID, rawBucket] of toRecordEntries(value)) {
    const id = toPositiveInt(rawID, 0);
    const bucket = toBoundedInteger(rawBucket, 1, 5);
    if (id > 0 && bucket !== null) {
      entries.push([id, bucket]);
    }
  }
  return entries.sort((left, right) => left[0] - right[0]);
}

function buildSystemInfoFromAuthoritativeRecord(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return buildEmptySystemInfo();
  }
  return buildDict([
    ["danger_level", toBoundedInteger(record.danger_level, 1, 6)],
    ["resource_composition", buildList(
      normalizeResourceComposition(record.resource_composition),
    )],
    ["feature_resource_composition", buildDict(
      normalizeFeatureResourceComposition(record.feature_resource_composition),
    )],
    [
      "resource_potential_bucket",
      toBoundedInteger(record.resource_potential_bucket, 1, 5),
    ],
    ["feature_resource_potential_bucket", buildDict(
      normalizePotentialBucketMap(record.feature_resource_potential_bucket),
    )],
    ["site_resource_potential_bucket", buildDict(
      normalizePotentialBucketMap(record.site_resource_potential_bucket),
    )],
  ]);
}

function buildSystemInfo(solarSystemID, options = {}) {
  const numericSystemID = toPositiveInt(solarSystemID, 0);
  const getSolarSystemByID = typeof options.getSolarSystemByID === "function"
    ? options.getSolarSystemByID
    : worldData.getSolarSystemByID;
  const system = numericSystemID > 0
    ? getSolarSystemByID(numericSystemID)
    : null;
  if (!system) {
    return buildEmptySystemInfo();
  }

  // TODO(frontier-static): build 3467658 does not currently extract the
  // location-list membership used for danger tiers, remnant dust/gas masses,
  // substrate dispatch weights, or the locator inputs used for potential
  // buckets.  Never infer these from security/landscape counts.  Consume only
  // a future, explicitly authored aggregate after validating its exact client
  // shape; until then the honest response is the complete empty shape.
  const getSystemInfoRecord = typeof options.getSystemInfoRecord === "function"
    ? options.getSystemInfoRecord
    : (row) => row.frontierSystemInfo;
  return buildSystemInfoFromAuthoritativeRecord(getSystemInfoRecord(system));
}

function resolveSystemID(args = [], session = null) {
  return toPositiveInt(
    Array.isArray(args) ? args[0] : args,
    toPositiveInt(
      session && session._space && session._space.systemID,
      toPositiveInt(
        session && (session.solarsystemid2 ?? session.solarsystemid ?? session.locationid),
        0,
      ),
    ),
  );
}

function buildCrudeRiftInfo(solarSystemID, options = {}) {
  const siteStore = options.siteStore || require("../../space/frontierRiftSites");
  const numericSystemID = toPositiveInt(solarSystemID, 0);
  if (numericSystemID <= 0) {
    return buildEmptyCrudeRiftInfo();
  }
  const sites = siteStore.listSites(numericSystemID);
  const counts = new Map();
  let points = 0;
  for (const site of sites) {
    const typeID = toPositiveInt(site && site.typeID, 0);
    if (typeID > 0) {
      counts.set(typeID, (counts.get(typeID) || 0) + 1);
    }
    points += Math.max(1, toPositiveInt(site && site.points, 1));
  }
  return buildDict([
    ["points", points],
    ["counts", buildDict([...counts.entries()].sort((left, right) => left[0] - right[0]))],
  ]);
}

class SystemInfoService extends BaseService {
  constructor(options = {}) {
    super("systemInfo");
    this.options = options;
  }

  Handle_GetSystemInfo(args, session) {
    return buildSystemInfo(resolveSystemID(args, session), this.options);
  }

  Handle_GetCrudeRiftInfo(args, session) {
    return buildCrudeRiftInfo(resolveSystemID(args, session));
  }
}

module.exports = SystemInfoService;
module.exports.buildCrudeRiftInfo = buildCrudeRiftInfo;
module.exports.buildEmptyCrudeRiftInfo = buildEmptyCrudeRiftInfo;
module.exports.buildEmptySystemInfo = buildEmptySystemInfo;
module.exports.buildSystemInfo = buildSystemInfo;
module.exports.buildSystemInfoFromAuthoritativeRecord =
  buildSystemInfoFromAuthoritativeRecord;
module.exports.normalizeResourceComposition = normalizeResourceComposition;
module.exports.resolveSystemID = resolveSystemID;
