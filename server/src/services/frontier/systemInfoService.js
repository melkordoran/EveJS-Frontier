const BaseService = require("../baseService");
const { buildDict, buildList } = require("../_shared/serviceHelpers");

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
  constructor() {
    super("systemInfo");
  }

  Handle_GetSystemInfo() {
    return buildEmptySystemInfo();
  }

  Handle_GetCrudeRiftInfo(args, session) {
    return buildCrudeRiftInfo(resolveSystemID(args, session));
  }
}

module.exports = SystemInfoService;
module.exports.buildCrudeRiftInfo = buildCrudeRiftInfo;
module.exports.buildEmptyCrudeRiftInfo = buildEmptyCrudeRiftInfo;
module.exports.buildEmptySystemInfo = buildEmptySystemInfo;
module.exports.resolveSystemID = resolveSystemID;
