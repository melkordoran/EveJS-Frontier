"use strict";

const path = require("path");

const {
  resolveSpawnPosition,
} = require(path.join(__dirname, "./frontierLandscapeCommands"));

const METERS_PER_AU = 149_597_870_700;
const DEFAULT_RIFT_SPAWN_DISTANCE_METERS = Math.round(METERS_PER_AU / 10);

const COMMAND_USAGE = [
  "Rift commands:",
  "/rift list [name]",
  "/rift inspect <dungeonID|typeID|name>",
  "/rift sites",
  "/rift spawn [dungeonID|typeID|name] [here|ahead=<meters>|offset=x,y,z|pos=x,y,z]",
  "/rift remove <siteID|nearest|here>",
].join("\n");

function toPositiveInt(value, fallback = 0) {
  const numeric = Math.trunc(Number(value) || 0);
  return numeric > 0 ? numeric : fallback;
}

function normalizePosition(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  const position = { x: Number(value.x), y: Number(value.y), z: Number(value.z) };
  return Object.values(position).every(Number.isFinite) ? position : null;
}

function distanceSquared(left, right) {
  const dx = left.x - right.x;
  const dy = left.y - right.y;
  const dz = left.z - right.z;
  return (dx * dx) + (dy * dy) + (dz * dz);
}

function formatPosition(position) {
  return [position.x, position.y, position.z]
    .map((value) => Math.round(Number(value) || 0).toLocaleString("en-US"))
    .join(", ");
}

function getCharacterID(session) {
  return toPositiveInt(
    session && (session.characterID ?? session.charid ?? session.characterid),
    0,
  );
}

function isPlacementToken(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized === "here" ||
    normalized.startsWith("ahead=") ||
    normalized.startsWith("offset=") ||
    normalized.startsWith("pos=");
}

function resolveDependencies(options = {}) {
  return {
    authority: options.authority || require(path.join(
      __dirname,
      "../../space/frontierRiftAuthority",
    )),
    siteStore: options.siteStore || require(path.join(
      __dirname,
      "../../space/frontierRiftSites",
    )),
    spaceRuntime: options.spaceRuntime || require(path.join(
      __dirname,
      "../../space/runtime",
    )),
  };
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

function formatTemplateList(authority, query = "") {
  const normalizedQuery = String(query || "").trim().toLowerCase();
  const templates = authority.listTemplates().filter((template) => (
    !normalizedQuery ||
    String(template.dungeonID) === normalizedQuery ||
    String(template.entryTypeID) === normalizedQuery ||
    template.itemName.toLowerCase().includes(normalizedQuery)
  ));
  if (templates.length <= 0) {
    return `No Rift templates matched ${JSON.stringify(query)}.`;
  }
  return [
    `Frontier Rift templates (${templates.length}):`,
    ...templates.map((template) => (
      `${template.dungeonID}: ${template.itemName} (type ${template.entryTypeID}, ` +
      `${template.resources.length} resource${template.resources.length === 1 ? "" : "s"})` +
      `${template.preferred ? " [preferred]" : ""}`
    )),
  ].join("\n");
}

function formatTemplateInspection(authority, query) {
  const template = authority.resolveTemplate(query);
  if (!template) {
    return null;
  }
  return [
    `${template.itemName}: dungeon ${template.dungeonID}, type ${template.entryTypeID}.`,
    `Archetype ${toPositiveInt(template.archetypeID, 0) || "none"}; ` +
      `${template.sceneObjects.length} initially active room objects.`,
    `Resources: ${template.resources.map((resource) => (
      `${resource.itemName} (${resource.typeID})`
    )).join(", ") || "none"}.`,
    template.spawnGuardObjectIDs.length > 0
      ? `${template.spawnGuardObjectIDs.length} trigger-spawned object(s) are held back initially.`
      : "No trigger-spawned objects are declared.",
  ].join("\n");
}

function executeFrontierRiftCommand(session, argumentText, options = {}) {
  const dependencies = resolveDependencies(options);
  const tokens = String(argumentText || "").trim().split(/\s+/).filter(Boolean);
  const action = String(tokens.shift() || "help").toLowerCase();

  if (action === "help") {
    return { success: true, message: COMMAND_USAGE };
  }
  if (action === "list") {
    return {
      success: true,
      message: formatTemplateList(dependencies.authority, tokens.join(" ")),
    };
  }
  if (action === "inspect") {
    const query = tokens.join(" ");
    const message = query && formatTemplateInspection(dependencies.authority, query);
    return message
      ? { success: true, message }
      : { success: false, message: "Usage: /rift inspect <dungeonID|typeID|name>" };
  }

  const active = getActiveSceneAndShip(session, dependencies.spaceRuntime);
  if (!active.success) {
    return {
      success: false,
      message: active.errorMsg === "NOT_IN_SPACE"
        ? "You must be in space to manage Rifts."
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
          `Custom Rifts in system ${systemID}:`,
          ...sites.map((site) => (
            `${site.itemID}: ${site.itemName} (dungeon ${site.dungeonID}) at ${formatPosition(site.position)}`
          )),
        ].join("\n")
        : `No custom Rifts exist in system ${systemID}.`,
    };
  }

  if (action === "spawn") {
    let templateQuery = String(tokens.shift() || "");
    let placementText = String(tokens.shift() || "");
    if (isPlacementToken(templateQuery)) {
      placementText = templateQuery;
      templateQuery = "";
    }
    const template = dependencies.authority.resolveTemplate(templateQuery);
    if (!template) {
      return { success: false, message: `Rift template ${JSON.stringify(templateQuery)} was not found.` };
    }
    const effectivePlacementText = placementText ||
      `ahead=${DEFAULT_RIFT_SPAWN_DISTANCE_METERS}`;
    const placement = resolveSpawnPosition(active.ship, effectivePlacementText);
    if (!placement.success) {
      return {
        success: false,
        message: "Placement must be here, ahead=<meters>, offset=x,y,z, or pos=x,y,z.",
      };
    }
    const createResult = dependencies.siteStore.createSite({
      template: template.dungeonID,
      solarSystemID: systemID,
      position: placement.position,
      createdByCharacterID: getCharacterID(session),
    });
    if (!createResult || createResult.success !== true) {
      return {
        success: false,
        message: `Rift spawn failed: ${createResult && createResult.errorMsg || "UNKNOWN_ERROR"}.`,
      };
    }
    const liveResult = dependencies.spaceRuntime.addCustomRiftSite(
      createResult.data,
      { broadcast: true },
    );
    if (!liveResult || liveResult.success !== true) {
      dependencies.siteStore.removeSite(createResult.data.itemID);
      return {
        success: false,
        message: `Rift spawn failed: ${liveResult && liveResult.errorMsg || "LIVE_SCENE_ERROR"}.`,
      };
    }
    return {
      success: true,
      data: { site: createResult.data, materialized: liveResult.data },
      message: [
        `Spawned ${createResult.data.itemName} from dungeon ${template.dungeonID}.`,
        `Rift ${createResult.data.itemID} at ${formatPosition(createResult.data.position)}.`,
        `${toPositiveInt(liveResult.data && liveResult.data.propsSpawned, 0)} authored room objects; ` +
          `resource types ${createResult.data.resourceTypeIDs.join(", ") || "none"}.`,
      ].join("\n"),
    };
  }

  if (action === "remove") {
    const selector = String(tokens.shift() || "nearest").toLowerCase();
    const sites = dependencies.siteStore.listSites(systemID);
    let site = null;
    if (selector === "nearest" || selector === "here") {
      site = sites
        .filter((candidate) => normalizePosition(candidate.position))
        .sort((left, right) => (
          distanceSquared(left.position, active.ship.position) -
          distanceSquared(right.position, active.ship.position)
        ))[0] || null;
    } else {
      site = dependencies.siteStore.getSite(toPositiveInt(selector, 0));
    }
    if (!site || site.solarSystemID !== systemID) {
      return { success: false, message: "Custom Rift was not found in this system." };
    }
    const liveResult = dependencies.spaceRuntime.removeCustomRiftSite(
      site.itemID,
      site.solarSystemID,
      { broadcast: true },
    );
    if (!liveResult || liveResult.success !== true) {
      return {
        success: false,
        message: `Rift removal failed: ${liveResult && liveResult.errorMsg || "LIVE_SCENE_ERROR"}.`,
      };
    }
    const removeResult = dependencies.siteStore.removeSite(site.itemID);
    if (!removeResult || removeResult.success !== true) {
      dependencies.spaceRuntime.addCustomRiftSite(site, { broadcast: true });
      return {
        success: false,
        message: `Rift removal failed: ${removeResult && removeResult.errorMsg || "PERSISTENCE_ERROR"}.`,
      };
    }
    return {
      success: true,
      data: { site },
      message: `Removed custom Rift ${site.itemID} (${site.itemName}).`,
    };
  }

  return { success: false, message: COMMAND_USAGE };
}

module.exports = {
  COMMAND_USAGE,
  DEFAULT_RIFT_SPAWN_DISTANCE_METERS,
  executeFrontierRiftCommand,
  formatTemplateInspection,
  formatTemplateList,
  isPlacementToken,
};
