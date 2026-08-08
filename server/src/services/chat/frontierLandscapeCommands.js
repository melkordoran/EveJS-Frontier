"use strict";

const path = require("path");

const DEFAULT_SPAWN_DISTANCE_METERS = 150_000;
const COMMAND_USAGE = [
  "Landscape commands:",
  "/landscape list [name]",
  "/landscape inspect <ecosystemID>",
  "/landscape sites",
  "/landscape spawn <ecosystemID> [here|ahead=<meters>|offset=x,y,z|pos=x,y,z]",
  "/landscape remove <siteID|nearest|here>",
].join("\n");

function toPositiveInt(value, fallback = 0) {
  const numeric = Math.trunc(Number(value) || 0);
  return numeric > 0 ? numeric : fallback;
}

function toFiniteNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function normalizeVector(value, fallback = null) {
  if (!value || typeof value !== "object") {
    return fallback;
  }
  const vector = {
    x: Number(value.x),
    y: Number(value.y),
    z: Number(value.z),
  };
  return Object.values(vector).every(Number.isFinite) ? vector : fallback;
}

function parseCoordinateVector(value) {
  const parts = String(value || "").split(",").map((part) => Number(part.trim()));
  if (parts.length !== 3 || !parts.every(Number.isFinite)) {
    return null;
  }
  return { x: parts[0], y: parts[1], z: parts[2] };
}

function normalizeDirection(value) {
  const vector = normalizeVector(value, { x: 1, y: 0, z: 0 });
  const magnitude = Math.hypot(vector.x, vector.y, vector.z);
  if (!Number.isFinite(magnitude) || magnitude <= 0.000001) {
    return { x: 1, y: 0, z: 0 };
  }
  return {
    x: vector.x / magnitude,
    y: vector.y / magnitude,
    z: vector.z / magnitude,
  };
}

function resolveSpawnPosition(shipEntity, placementText = "") {
  const shipPosition = normalizeVector(shipEntity && shipEntity.position);
  if (!shipPosition) {
    return { success: false, errorMsg: "SHIP_POSITION_NOT_FOUND" };
  }
  const placement = String(placementText || "").trim().toLowerCase();
  if (!placement || placement.startsWith("ahead=")) {
    const rawDistance = placement
      ? placement.slice("ahead=".length)
      : DEFAULT_SPAWN_DISTANCE_METERS;
    const distance = toFiniteNumber(rawDistance, Number.NaN);
    if (!Number.isFinite(distance) || distance < 0) {
      return { success: false, errorMsg: "INVALID_AHEAD_DISTANCE" };
    }
    const direction = normalizeDirection(shipEntity && shipEntity.direction);
    return {
      success: true,
      mode: "ahead",
      position: {
        x: shipPosition.x + (direction.x * distance),
        y: shipPosition.y + (direction.y * distance),
        z: shipPosition.z + (direction.z * distance),
      },
    };
  }
  if (placement === "here") {
    return { success: true, mode: "here", position: { ...shipPosition } };
  }
  if (placement.startsWith("offset=")) {
    const offset = parseCoordinateVector(placement.slice("offset=".length));
    if (!offset) {
      return { success: false, errorMsg: "INVALID_OFFSET" };
    }
    return {
      success: true,
      mode: "offset",
      position: {
        x: shipPosition.x + offset.x,
        y: shipPosition.y + offset.y,
        z: shipPosition.z + offset.z,
      },
    };
  }
  if (placement.startsWith("pos=")) {
    const position = parseCoordinateVector(placement.slice("pos=".length));
    return position
      ? { success: true, mode: "position", position }
      : { success: false, errorMsg: "INVALID_POSITION" };
  }
  return { success: false, errorMsg: "INVALID_PLACEMENT" };
}

function distanceSquared(left, right) {
  const dx = left.x - right.x;
  const dy = left.y - right.y;
  const dz = left.z - right.z;
  return (dx * dx) + (dy * dy) + (dz * dz);
}

function formatPosition(position) {
  return [position.x, position.y, position.z]
    .map((value) => Math.round(toFiniteNumber(value, 0)).toLocaleString("en-US"))
    .join(", ");
}

function listEcosystems(referenceData) {
  if (typeof referenceData.getLandscapeEcosystems === "function") {
    return referenceData.getLandscapeEcosystems();
  }
  const cache = referenceData.ensureLoaded();
  return Array.isArray(cache && cache.landscapeEcosystems)
    ? [...cache.landscapeEcosystems]
    : [];
}

function getCharacterID(session) {
  return toPositiveInt(
    session && (session.characterID ?? session.charid ?? session.characterid),
    0,
  );
}

function getActiveSceneAndShip(session, runtime) {
  const scene = runtime.getSceneForSession(session);
  const ship = scene && typeof scene.getShipEntityForSession === "function"
    ? scene.getShipEntityForSession(session)
    : null;
  if (!scene) {
    return { success: false, errorMsg: "NOT_IN_SPACE" };
  }
  if (!ship) {
    return { success: false, errorMsg: "SHIP_NOT_FOUND" };
  }
  return { success: true, scene, ship };
}

function resolveDependencies(options = {}) {
  return {
    itemTypes: options.itemTypes || require(path.join(
      __dirname,
      "../inventory/itemTypeRegistry",
    )),
    siteStore: options.siteStore || require(path.join(
      __dirname,
      "../../space/frontierLandscapeCustomSites",
    )),
    spaceRuntime: options.spaceRuntime || require(path.join(
      __dirname,
      "../../space/runtime",
    )),
    worldData: options.worldData || require(path.join(
      __dirname,
      "../../space/worldData",
    )),
  };
}

function formatEcosystemList(referenceData, query = "") {
  const normalizedQuery = String(query || "").trim().toLowerCase();
  const ecosystems = listEcosystems(referenceData)
    .filter((ecosystem) => {
      if (!normalizedQuery) {
        return true;
      }
      return (
        String(ecosystem.ecosystemID ?? ecosystem._key) === normalizedQuery ||
        String(ecosystem.name || "").toLowerCase().includes(normalizedQuery)
      );
    })
    .sort((left, right) => (
      toPositiveInt(left.ecosystemID ?? left._key, 0) -
      toPositiveInt(right.ecosystemID ?? right._key, 0)
    ));
  if (ecosystems.length <= 0) {
    return `No landscape ecosystems matched ${JSON.stringify(query)}.`;
  }
  return [
    `Landscape ecosystems (${ecosystems.length}):`,
    ...ecosystems.map((ecosystem) => (
      `${toPositiveInt(ecosystem.ecosystemID ?? ecosystem._key, 0)}: ${ecosystem.name}`
    )),
  ].join("\n");
}

function formatEcosystemInspection(ecosystemID, dependencies) {
  const ecosystem = dependencies.worldData.getLandscapeEcosystemByID(ecosystemID);
  if (!ecosystem) {
    return { success: false, errorMsg: "LANDSCAPE_ECOSYSTEM_NOT_FOUND" };
  }
  const dungeonID = toPositiveInt(ecosystem.entryDungeonID, 0);
  const dungeon = dependencies.worldData.getLandscapeDungeonTemplateByID(dungeonID);
  const typeID = toPositiveInt(dungeon && dungeon.entryTypeID, 0);
  const typeRecord = typeID > 0
    ? dependencies.itemTypes.resolveItemByTypeID(typeID)
    : null;
  const natural = Array.isArray(ecosystem.naturalWorldPatterns)
    ? ecosystem.naturalWorldPatterns
    : [];
  const broken = Array.isArray(ecosystem.brokenWorldPatterns)
    ? ecosystem.brokenWorldPatterns
    : [];
  return {
    success: true,
    message: [
      `Ecosystem ${ecosystemID}: ${ecosystem.name}`,
      `Entry dungeon ${dungeonID}; anchor ${typeRecord && typeRecord.name || `type ${typeID}`} (${typeID}).`,
      `Natural patterns ${toPositiveInt(ecosystem.minNaturalWorldPatterns, 0)}-${toPositiveInt(ecosystem.maxNaturalWorldPatterns, 0)}: ${natural.map((entry) => entry.dungeonID).join(", ") || "none"}.`,
      `Broken patterns ${toPositiveInt(ecosystem.minBrokenWorldPatterns, 0)}-${toPositiveInt(ecosystem.maxBrokenWorldPatterns, 0)}: ${broken.map((entry) => entry.dungeonID).join(", ") || "none"}.`,
    ].join("\n"),
  };
}

function executeFrontierLandscapeCommand(session, argumentText, options = {}) {
  const dependencies = resolveDependencies(options);
  const tokens = String(argumentText || "").trim().split(/\s+/).filter(Boolean);
  const action = String(tokens.shift() || "help").toLowerCase();

  if (action === "help") {
    return { success: true, message: COMMAND_USAGE };
  }
  if (action === "list") {
    return {
      success: true,
      message: formatEcosystemList(dependencies.worldData, tokens.join(" ")),
    };
  }
  if (action === "inspect") {
    const ecosystemID = toPositiveInt(tokens[0], 0);
    if (!ecosystemID) {
      return { success: false, message: "Usage: /landscape inspect <ecosystemID>" };
    }
    const result = formatEcosystemInspection(ecosystemID, dependencies);
    return result.success
      ? result
      : { success: false, message: `Ecosystem ${ecosystemID} was not found.` };
  }

  const active = getActiveSceneAndShip(session, dependencies.spaceRuntime);
  if (!active.success) {
    return {
      success: false,
      message: active.errorMsg === "NOT_IN_SPACE"
        ? "You must be in space to manage landscape sites."
        : "Your active ship could not be found in space.",
    };
  }
  const systemID = toPositiveInt(active.scene.systemID, 0);

  if (action === "sites") {
    const sites = dependencies.siteStore.listSites(systemID);
    return {
      success: true,
      message: sites.length > 0
        ? [
          `Custom landscape sites in system ${systemID}:`,
          ...sites.map((site) => (
            `${site.itemID}: ecosystem ${site.ecosystemID} ${site.itemName} at ${formatPosition(site.position)}`
          )),
        ].join("\n")
        : `No custom landscape sites exist in system ${systemID}.`,
    };
  }

  if (action === "spawn") {
    const ecosystemID = toPositiveInt(tokens.shift(), 0);
    if (!ecosystemID) {
      return { success: false, message: "Usage: /landscape spawn <ecosystemID> [placement]" };
    }
    const placement = resolveSpawnPosition(active.ship, tokens.shift() || "");
    if (!placement.success) {
      return {
        success: false,
        message: "Placement must be here, ahead=<meters>, offset=x,y,z, or pos=x,y,z.",
      };
    }
    const createResult = dependencies.siteStore.createSite({
      ecosystemID,
      solarSystemID: systemID,
      position: placement.position,
      createdByCharacterID: getCharacterID(session),
    });
    if (!createResult || createResult.success !== true) {
      return {
        success: false,
        message: `Landscape spawn failed: ${createResult && createResult.errorMsg || "UNKNOWN_ERROR"}.`,
      };
    }
    const liveResult = dependencies.spaceRuntime.addCustomLandscapeSite(
      createResult.data,
      { broadcast: true },
    );
    if (!liveResult || liveResult.success !== true) {
      dependencies.siteStore.removeSite(createResult.data.itemID);
      return {
        success: false,
        message: `Landscape spawn failed: ${liveResult && liveResult.errorMsg || "LIVE_SCENE_ERROR"}.`,
      };
    }
    const materialized = liveResult.data && liveResult.data.materialized || {};
    return {
      success: true,
      data: { site: createResult.data, materialized },
      message: [
        `Spawned ecosystem ${ecosystemID} ${createResult.data.itemName}.`,
        `Site ${createResult.data.itemID} at ${formatPosition(createResult.data.position)}.`,
        `${toPositiveInt(materialized.propsSpawned, 0)} props, ${Array.isArray(materialized.patterns) ? materialized.patterns.length : 0} patterns, ${Array.isArray(materialized.locators) ? materialized.locators.length : 0} locators.`,
      ].join("\n"),
    };
  }

  if (action === "remove") {
    const selector = String(tokens.shift() || "nearest").toLowerCase();
    const systemSites = dependencies.siteStore.listSites(systemID);
    let site = null;
    if (selector === "nearest" || selector === "here") {
      site = systemSites
        .filter((candidate) => normalizeVector(candidate.position))
        .sort((left, right) => (
          distanceSquared(left.position, active.ship.position) -
          distanceSquared(right.position, active.ship.position)
        ))[0] || null;
    } else {
      site = dependencies.siteStore.getSite(toPositiveInt(selector, 0));
    }
    if (!site) {
      return { success: false, message: "Custom landscape site was not found." };
    }
    const liveResult = dependencies.spaceRuntime.removeCustomLandscapeSite(
      site.itemID,
      site.solarSystemID,
      { broadcast: true },
    );
    if (!liveResult || liveResult.success !== true) {
      return {
        success: false,
        message: `Landscape removal failed: ${liveResult && liveResult.errorMsg || "LIVE_SCENE_ERROR"}.`,
      };
    }
    const removeResult = dependencies.siteStore.removeSite(site.itemID);
    if (!removeResult || removeResult.success !== true) {
      dependencies.spaceRuntime.addCustomLandscapeSite(site, { broadcast: true });
      return {
        success: false,
        message: `Landscape removal failed: ${removeResult && removeResult.errorMsg || "PERSISTENCE_ERROR"}.`,
      };
    }
    return {
      success: true,
      data: { site },
      message: `Removed custom landscape site ${site.itemID} (${site.itemName}).`,
    };
  }

  return { success: false, message: COMMAND_USAGE };
}

module.exports = {
  COMMAND_USAGE,
  DEFAULT_SPAWN_DISTANCE_METERS,
  executeFrontierLandscapeCommand,
  formatEcosystemInspection,
  formatEcosystemList,
  parseCoordinateVector,
  resolveSpawnPosition,
};
