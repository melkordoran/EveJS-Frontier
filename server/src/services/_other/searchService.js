const path = require("path");
const fs = require("fs");

const BaseService = require(path.join(__dirname, "../baseService"));
const database = require(path.join(__dirname, "../../gameStore"));
const worldData = require(path.join(__dirname, "../../space/worldData"));
const {
  buildDict,
  buildList,
  extractList,
  normalizeText,
} = require(path.join(__dirname, "../_shared/serviceHelpers"));
const {
  ensureAlliancesInitialized,
  ensureCorporationsInitialized,
  getAllianceRecord,
  getCorporationRecord,
} = require(path.join(__dirname, "../corporation/corporationState"));
const {
  getAllFactionRecords,
} = require(path.join(__dirname, "../faction/factionState"));
const {
  listAgents,
} = require(path.join(__dirname, "../agent/agentAuthority"));
const {
  TABLE,
  readStaticRows,
} = require(path.join(__dirname, "../_shared/referenceData"));

const MATCH_BY = {
  PARTIAL_TERMS: 0,
  EXACT_TERMS: 1,
  EXACT_PHRASE: 2,
  EXACT_PHRASE_ONLY: 3,
};

const RESULT_TYPE = {
  AGENT: 1,
  CHARACTER: 2,
  CORPORATION: 3,
  ALLIANCE: 4,
  FACTION: 5,
  CONSTELLATION: 6,
  SOLAR_SYSTEM: 7,
  REGION: 8,
  STATION: 9,
  ITEM_TYPE: 10,
};

const MAX_RESULT_COUNT = 500;
const STATIC_QUERY_CACHE_LIMIT = 512;
const staticSearchIndexCache = new Map();
const staticQueryResultCache = new Map();
const frontierLocationRowsCache = new Map();

function readFrontierLocationRows(fileName) {
  const staticRoot = String(process.env.EVEJS_STATIC_JSONL_ROOT || "").trim();
  if (!staticRoot) {
    return [];
  }
  const filePath = path.join(path.resolve(staticRoot), fileName);
  if (frontierLocationRowsCache.has(filePath)) {
    return frontierLocationRowsCache.get(filePath);
  }
  let rows = [];
  try {
    rows = fs.readFileSync(filePath, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch (_error) {
          return null;
        }
      })
      .filter(Boolean);
  } catch (_error) {
    rows = [];
  }
  frontierLocationRowsCache.set(filePath, rows);
  return rows;
}

function getLocalizedName(value) {
  if (typeof value === "string") {
    return value;
  }
  if (value && typeof value === "object") {
    if (typeof value.en === "string") {
      return value.en;
    }
    return Object.values(value).find((candidate) => typeof candidate === "string") || "";
  }
  return "";
}

function extractKwargValue(kwargs, key, fallback = undefined) {
  if (!kwargs) {
    return fallback;
  }

  if (kwargs.type === "dict" && Array.isArray(kwargs.entries)) {
    const entry = kwargs.entries.find(([entryKey]) => entryKey === key);
    return entry ? entry[1] : fallback;
  }

  if (typeof kwargs === "object" && Object.prototype.hasOwnProperty.call(kwargs, key)) {
    return kwargs[key];
  }

  return fallback;
}

function normalizeSearchString(value) {
  return normalizeText(value, "").trim().toLowerCase();
}

function collapseSearchString(value) {
  return normalizeSearchString(value).replace(/[^a-z0-9]+/g, "");
}

function tokenizeSearchString(value) {
  return normalizeSearchString(value)
    .split(/\s+/)
    .map((token) => token.replace(/[^a-z0-9]+/g, ""))
    .filter(Boolean);
}

function appendMapListEntry(map, key, value) {
  if (!key) {
    return;
  }
  const existing = map.get(key);
  if (existing) {
    existing.push(value);
    return;
  }
  map.set(key, [value]);
}

function getStaticGroupSourceRows(groupID) {
  const normalizedGroupID = Number(groupID) || 0;
  const world = [
    RESULT_TYPE.CONSTELLATION,
    RESULT_TYPE.SOLAR_SYSTEM,
    RESULT_TYPE.REGION,
    RESULT_TYPE.STATION,
  ].includes(normalizedGroupID)
    ? worldData.ensureLoaded()
    : null;
  switch (normalizedGroupID) {
    case RESULT_TYPE.SOLAR_SYSTEM:
      return world.solarSystems;
    case RESULT_TYPE.STATION:
      return world.stations;
    case RESULT_TYPE.CONSTELLATION:
      return [
        ...readFrontierLocationRows("mapConstellations.jsonl"),
        ...world.stations,
        ...world.solarSystems,
      ];
    case RESULT_TYPE.REGION:
      // The isolated Frontier snapshot is the authority for complete authored
      // names.  Station rows preserve compatibility with older generated
      // stores, and system rows ensure every ID remains indexed if the raw
      // snapshot is unavailable.
      return [
        ...readFrontierLocationRows("mapRegions.jsonl"),
        ...world.stations,
        ...world.solarSystems,
      ];
    case RESULT_TYPE.ITEM_TYPE:
      return readStaticRows(TABLE.ITEM_TYPES);
    default:
      return null;
  }
}

function getStaticGroupEntryNames(groupID, row) {
  const id = getStaticGroupEntryID(groupID, row);
  const names = [];
  switch (Number(groupID) || 0) {
    case RESULT_TYPE.SOLAR_SYSTEM:
      names.push(row && row.solarSystemName);
      break;
    case RESULT_TYPE.STATION:
      names.push(row && (row.stationName || row.itemName));
      break;
    case RESULT_TYPE.CONSTELLATION:
      names.push(getLocalizedName(row && (row.constellationName || row.name)));
      // Frontier's authored constellation labels use this exact form.  It is
      // also the only authoritative label available for constellations that
      // contain no station in the extracted data.
      if (id > 0) {
        names.push(`C-${id}`);
      }
      break;
    case RESULT_TYPE.REGION:
      names.push(getLocalizedName(row && (row.regionName || row.name)));
      // Do not fabricate an authored region name when the current extraction
      // has none.  Numeric lookup still makes every region addressable.
      if (id > 0) {
        names.push(String(id));
      }
      break;
    case RESULT_TYPE.ITEM_TYPE:
      names.push(row && (row.name || row.typeName));
      break;
    default:
      break;
  }

  return [...new Set(
    names
      .map((name) => String(name || "").trim())
      .filter(Boolean),
  )];
}

function getStaticGroupEntryID(groupID, row) {
  switch (Number(groupID) || 0) {
    case RESULT_TYPE.SOLAR_SYSTEM:
      return Number(row && row.solarSystemID) || 0;
    case RESULT_TYPE.STATION:
      return Number(row && row.stationID) || 0;
    case RESULT_TYPE.CONSTELLATION:
      return Number(row && row.constellationID) || 0;
    case RESULT_TYPE.REGION:
      return Number(row && row.regionID) || 0;
    case RESULT_TYPE.ITEM_TYPE:
      return Number(row && row.typeID) || 0;
    default:
      return 0;
  }
}

function buildStaticSearchIndexFromRows(groupID, rows) {
  if (!rows) {
    return null;
  }

  const exactRawNameMap = new Map();
  const exactCollapsedNameMap = new Map();
  const seenAliases = new Set();
  const entries = [];
  for (const row of rows) {
    const id = getStaticGroupEntryID(groupID, row);
    if (!id) {
      continue;
    }
    for (const name of getStaticGroupEntryNames(groupID, row)) {
      const rawName = normalizeSearchString(name);
      const collapsedName = collapseSearchString(name);
      const aliasKey = `${id}\u0000${rawName}`;
      if (!collapsedName || seenAliases.has(aliasKey)) {
        continue;
      }
      seenAliases.add(aliasKey);
      const entry = {
        id,
        rawName,
        collapsedName,
      };
      appendMapListEntry(exactRawNameMap, rawName, id);
      appendMapListEntry(exactCollapsedNameMap, collapsedName, id);
      entries.push(entry);
    }
  }

  return {
    entries,
    exactRawNameMap,
    exactCollapsedNameMap,
  };
}

function buildStaticSearchIndex(groupID) {
  const rows = getStaticGroupSourceRows(groupID);
  const index = buildStaticSearchIndexFromRows(groupID, rows);
  if (!index) {
    return null;
  }
  staticSearchIndexCache.set(Number(groupID) || 0, index);
  return index;
}

function getStaticSearchIndex(groupID) {
  const normalizedGroupID = Number(groupID) || 0;
  if (staticSearchIndexCache.has(normalizedGroupID)) {
    return staticSearchIndexCache.get(normalizedGroupID);
  }
  return buildStaticSearchIndex(normalizedGroupID);
}

function getCachedStaticQueryResult(key) {
  if (!staticQueryResultCache.has(key)) {
    return null;
  }
  const cached = staticQueryResultCache.get(key);
  staticQueryResultCache.delete(key);
  staticQueryResultCache.set(key, cached);
  return [...cached];
}

function setCachedStaticQueryResult(key, resultIDs) {
  staticQueryResultCache.set(key, [...resultIDs]);
  if (staticQueryResultCache.size <= STATIC_QUERY_CACHE_LIMIT) {
    return;
  }
  const oldestKey = staticQueryResultCache.keys().next().value;
  if (oldestKey !== undefined) {
    staticQueryResultCache.delete(oldestKey);
  }
}

function searchStaticGroup(groupID, search, exactMode) {
  const index = getStaticSearchIndex(groupID);
  if (!index) {
    return null;
  }

  const rawSearch = normalizeSearchString(search);
  const collapsedSearch = collapseSearchString(search);
  const cacheKey = `${Number(groupID) || 0}|${Number(exactMode) || 0}|${rawSearch}`;
  const cached = getCachedStaticQueryResult(cacheKey);
  if (cached) {
    return cached;
  }
  if (!collapsedSearch) {
    return [];
  }

  let results = [];
  switch (Number(exactMode) || 0) {
    case MATCH_BY.EXACT_TERMS:
    case MATCH_BY.EXACT_PHRASE:
    case MATCH_BY.EXACT_PHRASE_ONLY: {
      const seen = new Set();
      const exactRaw = index.exactRawNameMap.get(rawSearch) || [];
      const exactCollapsed = index.exactCollapsedNameMap.get(collapsedSearch) || [];
      results = [...exactRaw, ...exactCollapsed].filter((id) => {
        if (!id || seen.has(id)) {
          return false;
        }
        seen.add(id);
        return true;
      });
      break;
    }
    case MATCH_BY.PARTIAL_TERMS:
    default: {
      const terms = tokenizeSearchString(search);
      const exactMatches = [];
      const prefixMatches = [];
      const substringMatches = [];
      for (const entry of index.entries) {
        const matches =
          terms.length > 0
            ? terms.every((term) => entry.collapsedName.includes(term))
            : entry.collapsedName.includes(collapsedSearch);
        if (!matches) {
          continue;
        }
        if (
          entry.rawName === rawSearch ||
          entry.collapsedName === collapsedSearch
        ) {
          exactMatches.push(entry.id);
          continue;
        }
        if (
          entry.rawName.startsWith(rawSearch) ||
          entry.collapsedName.startsWith(collapsedSearch)
        ) {
          prefixMatches.push(entry.id);
          continue;
        }
        substringMatches.push(entry.id);
      }
      const seen = new Set();
      results = [...exactMatches, ...prefixMatches, ...substringMatches].filter((id) => {
        if (!id || seen.has(id)) {
          return false;
        }
        seen.add(id);
        return true;
      });
      break;
    }
  }

  const limitedResults = results.slice(0, MAX_RESULT_COUNT);
  setCachedStaticQueryResult(cacheKey, limitedResults);
  return limitedResults;
}

function matchesSearch(name, search, exactMode = MATCH_BY.PARTIAL_TERMS) {
  const rawTarget = normalizeSearchString(name);
  const collapsedTarget = collapseSearchString(name);
  const rawSearch = normalizeSearchString(search);
  const collapsedSearch = collapseSearchString(search);
  if (!collapsedSearch) {
    return false;
  }

  switch (Number(exactMode) || 0) {
    case MATCH_BY.EXACT_TERMS:
    case MATCH_BY.EXACT_PHRASE:
    case MATCH_BY.EXACT_PHRASE_ONLY:
      return rawTarget === rawSearch || collapsedTarget === collapsedSearch;
    case MATCH_BY.PARTIAL_TERMS:
    default: {
      const terms = tokenizeSearchString(search);
      if (!terms.length) {
        return collapsedTarget.includes(collapsedSearch);
      }
      return terms.every((term) => collapsedTarget.includes(term));
    }
  }
}

function collectSearchableOwners(groupID, options = {}) {
  const hideNPC = options.hideNPC === true;
  switch (Number(groupID) || 0) {
    case RESULT_TYPE.AGENT:
      if (hideNPC) {
        return [];
      }
      return listAgents()
        .map((record) => ({
          id: Number(record && record.agentID) || 0,
          name: record && (record.ownerName || `Agent ${record.agentID}`),
        }))
        .filter((entry) => entry.id > 0 && entry.name);
    case RESULT_TYPE.CHARACTER: {
      const tableResult = database.read("characters", "/");
      const characters =
        tableResult && tableResult.success && tableResult.data && typeof tableResult.data === "object"
          ? tableResult.data
          : {};
      // Player search is a LIKE scan over every character, so it must stay
      // cheap. Read the raw stored name directly instead of getCharacterRecord,
      // which runs the full normalization pipeline and re-writes the entire
      // characters table to disk per record on a cold cache.
      return Object.entries(characters)
        .filter(([, record]) => record && typeof record === "object")
        .map(([characterID, record]) => {
          const id = Number(record.characterID || characterID) || 0;
          return {
            id,
            name: record.characterName || `Character ${id}`,
          };
        })
        .filter((entry) => entry.id > 0 && entry.name);
    }
    case RESULT_TYPE.CORPORATION: {
      const corporations = ensureCorporationsInitialized();
      return Object.keys((corporations && corporations.records) || {})
        .map((corporationID) => getCorporationRecord(corporationID))
        .filter((record) => record && (!hideNPC || record.isNPC !== true))
        .map((record) => ({
          id: Number(record.corporationID || 0) || 0,
          name: record.corporationName || `Corporation ${record.corporationID}`,
        }))
        .filter((entry) => entry.id > 0 && entry.name);
    }
    case RESULT_TYPE.ALLIANCE: {
      const alliances = ensureAlliancesInitialized();
      return Object.keys((alliances && alliances.records) || {})
        .map((allianceID) => getAllianceRecord(allianceID))
        .filter(Boolean)
        .map((record) => ({
          id: Number(record.allianceID || 0) || 0,
          name: record.allianceName || `Alliance ${record.allianceID}`,
        }))
        .filter((entry) => entry.id > 0 && entry.name);
    }
    case RESULT_TYPE.FACTION:
      return getAllFactionRecords()
        .map((record) => ({
          id: Number(record && record.factionID) || 0,
          name: record && (record.name || `Faction ${record.factionID}`),
        }))
        .filter((entry) => entry.id > 0 && entry.name);
    default:
      return [];
  }
}

function searchGroup(groupID, search, exactMode, options = {}) {
  const staticMatches = searchStaticGroup(groupID, search, exactMode);
  if (staticMatches) {
    return staticMatches;
  }

  return collectSearchableOwners(groupID, options)
    .filter((entry) => matchesSearch(entry.name, search, exactMode))
    .map((entry) => entry.id)
    .slice(0, MAX_RESULT_COUNT);
}

function clearSearchCaches() {
  staticSearchIndexCache.clear();
  staticQueryResultCache.clear();
  frontierLocationRowsCache.clear();
}

class SearchService extends BaseService {
  constructor() {
    super("search");
  }

  Handle_Query(args, session, kwargs) {
    const search = normalizeText(args && args[0], "");
    const groupIDs = extractList(args && args[1])
      .map((groupID) => Number(groupID))
      .filter((groupID) => Number.isFinite(groupID));
    const exactMode = Number(extractKwargValue(kwargs, "exact", 0)) || 0;
    const hideNPC = Boolean(Number(extractKwargValue(kwargs, "hideNPC", 0)) || 0);

    return buildDict(
      groupIDs.map((groupID) => [
        groupID,
        buildList(searchGroup(groupID, search, exactMode, { hideNPC })),
      ]),
    );
  }

  Handle_QuickQuery(args, session, kwargs) {
    const search = normalizeText(args && args[0], "");
    const groupIDs = extractList(args && args[1])
      .map((groupID) => Number(groupID))
      .filter((groupID) => Number.isFinite(groupID));
    const exactMode = Number(extractKwargValue(kwargs, "exact", 0)) || 0;
    const hideNPC = Boolean(Number(extractKwargValue(kwargs, "hideNPC", 0)) || 0);
    const matches = [];
    const seen = new Set();

    for (const groupID of groupIDs) {
      for (const ownerID of searchGroup(groupID, search, exactMode, { hideNPC })) {
        const numericOwnerID = Number(ownerID) || 0;
        if (numericOwnerID > 0 && !seen.has(numericOwnerID)) {
          seen.add(numericOwnerID);
          matches.push(numericOwnerID);
        }
      }
    }

    return buildList(matches);
  }
}

module.exports = SearchService;
module.exports._testing = {
  buildStaticSearchIndexFromRows,
  clearSearchCaches,
  getStaticGroupEntryNames,
  getStaticGroupSourceRows,
  searchStaticGroup,
};
