"use strict";

const path = require("path");

const {
  resolveSpawnPosition,
} = require(path.join(__dirname, "../chat/frontierLandscapeCommands"));

const DEFAULT_SPAWN_DISTANCE_METERS = 1_000;
const COMMAND_USAGE = [
  "Smart Assembly commands:",
  "/assembly types [all|published|hidden] [name|typeID]",
  "/assembly list [mine|system|all]",
  "/assembly info <itemID|nearest>",
  "/assembly spawn <name|typeID> [here|ahead=<meters>|offset=x,y,z|pos=x,y,z] [state=default|offline|online]",
  "/assembly state <itemID> <offline|online>",
  "/assembly link <sourceGateID> <destinationGateID>",
  "/assembly unlink <gateID>",
  "/assembly complete <constructionSiteID>",
  "/assembly remove <itemID> confirm",
  "Types/list/info are read-only. Mutations require an elevated account role.",
].join("\n");

const STATUS_LABELS = Object.freeze({
  1: "offline",
  2: "online",
  5: "construction",
});

const ERROR_MESSAGES = Object.freeze({
  ASSEMBLY_ADMIN_ACCESS_DENIED:
    "Assembly mutations require an elevated GM account role.",
  ASSEMBLY_ACCESS_DENIED: "You do not own this assembly.",
  ASSEMBLY_MUST_BE_OFFLINE: "Set the assembly offline before removing it.",
  ASSEMBLY_NOT_EMPTY:
    "The assembly contains inventory. Empty it before removal.",
  ASSEMBLY_NOT_FOUND: "Smart Assembly was not found.",
  ASSEMBLY_OCCUPIED:
    "The assembly has an active or persisted berth. Undock first.",
  ASSEMBLY_OWNER_MISMATCH:
    "Both gates must have the same owner before they can be linked.",
  ASSEMBLY_TYPE_NOT_FOUND: "Smart Assembly type metadata was not found.",
  ASSEMBLY_TYPE_NOT_SUPPORTED: "That type is not a Smart Assembly.",
  ASSEMBLY_UNDER_CONSTRUCTION:
    "The assembly is still under construction.",
  CONSTRUCTION_MATERIALS_INCOMPLETE:
    "The construction site does not contain all required materials.",
  CONSTRUCTION_ALREADY_COMPLETE: "That Smart Assembly is already complete.",
  CONSTRUCTION_SITE_NOT_FOUND: "Construction site was not found.",
  INVALID_ASSEMBLY_STATE: "Assembly state must be offline or online.",
  INVALID_DEPLOYMENT_PLACEMENT: "The assembly placement is invalid.",
  NOT_IN_SPACE: "You must be in space to manage Smart Assemblies.",
  SHIP_NOT_IN_SPACE: "Your active ship could not be found in space.",
  SMART_GATE_ALREADY_LINKED: "One of those gates is already linked.",
  SMART_GATE_DESTINATION_REQUIRED:
    "Link the Smart Gate before setting it online.",
  SMART_GATE_LINK_MISMATCH: "The reciprocal Smart Gate link is inconsistent.",
  SMART_GATE_LINK_NOT_SUPPORTED:
    "Catapults do not use reciprocal Smart Gate links.",
  SMART_GATE_MUST_BE_OFFLINE: "Both Smart Gates must be offline.",
  SMART_GATE_MUST_BE_UNLINKED: "Unlink the Smart Gate before removing it.",
  SMART_GATE_NOT_LINKED: "That Smart Gate is not linked.",
  SMART_GATE_OUT_OF_RANGE: "The destination Smart Gate is out of range.",
  SMART_GATE_SAME_SYSTEM: "Smart Gates must be in different systems.",
  SMART_GATE_SELF_LINK: "A Smart Gate cannot link to itself.",
  SMART_GATE_TYPE_MISMATCH: "Smart Gates must have the same type.",
});

function toPositiveInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : fallback;
}

function getCharacterID(session) {
  return toPositiveInt(
    session && (session.characterID ?? session.charid ?? session.characterid),
    0,
  );
}

function getSolarSystemID(session) {
  return toPositiveInt(
    session && (session.solarsystemid2 ?? session.solarsystemid),
    0,
  );
}

function normalizeName(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, " ")
    .trim();
}

function tokenizeArguments(value) {
  const source = String(value || "");
  const tokens = [];
  let current = "";
  let quote = null;
  let escaping = false;

  for (const character of source) {
    if (escaping) {
      current += character;
      escaping = false;
      continue;
    }
    if (character === "\\") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (character === quote) {
        quote = null;
      } else {
        current += character;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (/\s/u.test(character)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += character;
  }
  if (escaping) {
    current += "\\";
  }
  if (quote) {
    return { success: false, errorMsg: "UNTERMINATED_QUOTE", tokens: [] };
  }
  if (current) {
    tokens.push(current);
  }
  return { success: true, tokens };
}

function parseItemID(value) {
  const text = String(value || "").trim();
  if (!/^[1-9][0-9]*$/u.test(text)) {
    return 0;
  }
  return toPositiveInt(text, 0);
}

function isPlacementToken(value) {
  const normalized = String(value || "").toLowerCase();
  return normalized === "here" ||
    normalized.startsWith("ahead=") ||
    normalized.startsWith("offset=") ||
    normalized.startsWith("pos=");
}

function resolveDependencies(options = {}) {
  return {
    deploymentRuntime: options.deploymentRuntime || require(path.join(
      __dirname,
      "./deploymentRuntime",
    )),
    spaceRuntime: options.spaceRuntime || require(path.join(
      __dirname,
      "../../space/runtime",
    )),
  };
}

function formatPosition(position) {
  if (!position) {
    return "unknown";
  }
  return [position.x, position.y, position.z]
    .map((value) => Math.round(Number(value) || 0).toLocaleString("en-US"))
    .join(", ");
}

function formatStatus(value) {
  return STATUS_LABELS[Number(value)] || `state-${Number(value) || 0}`;
}

function formatRuntimeError(result, prefix = "Assembly command failed") {
  const errorMsg = String(result && result.errorMsg || "UNKNOWN_ERROR");
  const detail = String(ERROR_MESSAGES[errorMsg] || errorMsg).replace(/[.]+$/u, "");
  return `${prefix}: ${detail}.`;
}

function resolveDefinition(definitions, query) {
  const source = String(query || "").trim();
  const numericTypeID = parseItemID(source);
  if (numericTypeID > 0) {
    const match = definitions.find(
      (entry) => Number(entry.assemblyTypeID) === numericTypeID,
    );
    return match
      ? { success: true, match }
      : { success: false, errorMsg: "ASSEMBLY_TYPE_NOT_SUPPORTED", suggestions: [] };
  }
  const normalizedQuery = normalizeName(source);
  if (!normalizedQuery) {
    return { success: false, errorMsg: "ASSEMBLY_TYPE_REQUIRED", suggestions: [] };
  }
  const exactMatches = definitions.filter(
    (entry) => normalizeName(entry.name) === normalizedQuery,
  );
  if (exactMatches.length === 1) {
    return { success: true, match: exactMatches[0] };
  }
  const partialMatches = definitions.filter(
    (entry) => normalizeName(entry.name).includes(normalizedQuery),
  );
  if (partialMatches.length === 1) {
    return { success: true, match: partialMatches[0] };
  }
  const suggestions = (exactMatches.length > 0 ? exactMatches : partialMatches)
    .slice(0, 6)
    .map((entry) => `${entry.name} (${entry.assemblyTypeID})`);
  return {
    success: false,
    errorMsg: suggestions.length > 1 ? "ASSEMBLY_TYPE_AMBIGUOUS" : "ASSEMBLY_TYPE_NOT_SUPPORTED",
    suggestions,
  };
}

function formatDefinitionList(definitions, scope, query) {
  const normalizedQuery = normalizeName(query);
  const rows = definitions.filter((definition) => {
    if (scope === "published" && definition.published === false) {
      return false;
    }
    if (scope === "hidden" && definition.published !== false) {
      return false;
    }
    return !normalizedQuery ||
      String(definition.assemblyTypeID) === normalizedQuery ||
      normalizeName(definition.name).includes(normalizedQuery);
  });
  if (rows.length <= 0) {
    return `No Smart Assembly types matched ${JSON.stringify(query || scope)}.`;
  }
  return [
    `Smart Assembly types (${rows.length}, ${scope}):`,
    ...rows.map((definition) => (
      `${definition.assemblyTypeID}: ${definition.name}` +
      `${definition.published === false ? " [hidden]" : ""}` +
      `${definition.createOnChain ? " [on-chain]" : " [portable]"}`
    )),
  ].join("\n");
}

function formatAssemblyRecord(record) {
  const destination = Number(record.destinationGateID) > 0
    ? `; destination=${record.destinationGateID} system=${record.targetSolarSystemID}`
    : "";
  return `${record.itemID}: ${record.name} (type ${record.assemblyTypeID}` +
    `${record.published === false ? ", hidden" : ""}) ` +
    `owner=${record.ownerID} system=${record.solarSystemID} ` +
    `state=${formatStatus(record.assemblyStatus)} ` +
    `position=${formatPosition(record.position)}${destination}`;
}

function findNearestAssembly(session, dependencies) {
  const systemID = getSolarSystemID(session);
  const scene = dependencies.spaceRuntime.getSceneForSession(session);
  const ship = scene && typeof scene.getShipEntityForSession === "function"
    ? scene.getShipEntityForSession(session)
    : null;
  if (!systemID || !ship || !ship.position) {
    return null;
  }
  return dependencies.deploymentRuntime.listAssemblies({ solarSystemID: systemID })
    .map((record) => ({
      record,
      distance: record.position
        ? Math.hypot(
          record.position.x - ship.position.x,
          record.position.y - ship.position.y,
          record.position.z - ship.position.z,
        )
        : Number.POSITIVE_INFINITY,
    }))
    .sort((left, right) => (
      left.distance - right.distance || left.record.itemID - right.record.itemID
    ))[0]?.record || null;
}

function requireAdmin(session, deploymentRuntime) {
  return deploymentRuntime.hasAssemblyAdminPrivileges(session)
    ? null
    : {
      success: false,
      message: ERROR_MESSAGES.ASSEMBLY_ADMIN_ACCESS_DENIED,
    };
}

function executeFrontierAssemblyCommand(session, argumentText, options = {}) {
  const dependencies = resolveDependencies(options);
  const parsed = tokenizeArguments(argumentText);
  if (!parsed.success) {
    return { success: false, message: "Assembly command has an unterminated quote." };
  }
  const tokens = parsed.tokens;
  const action = String(tokens.shift() || "help").toLowerCase();

  if (action === "help") {
    return { success: true, message: COMMAND_USAGE };
  }

  if (action === "types" || action === "catalog") {
    let scope = String(tokens[0] || "all").toLowerCase();
    if (["all", "published", "hidden"].includes(scope)) {
      tokens.shift();
    } else {
      scope = "all";
    }
    return {
      success: true,
      message: formatDefinitionList(
        dependencies.deploymentRuntime.listAssemblyDefinitions(),
        scope,
        tokens.join(" "),
      ),
    };
  }

  if (action === "list") {
    const scope = String(tokens.shift() || "mine").toLowerCase();
    if (tokens.length > 0) {
      return { success: false, message: "Usage: /assembly list [mine|system|all]" };
    }
    let filters = {};
    if (scope === "mine") {
      const characterID = getCharacterID(session);
      if (!characterID) {
        return { success: false, message: "Select a character first." };
      }
      filters = { ownerID: characterID };
    } else if (scope === "system") {
      const solarSystemID = getSolarSystemID(session);
      if (!solarSystemID) {
        return { success: false, message: "You must be in space to list this system." };
      }
      filters = { solarSystemID };
    } else if (scope === "all") {
      const denied = requireAdmin(session, dependencies.deploymentRuntime);
      if (denied) {
        return denied;
      }
    } else {
      return { success: false, message: "Usage: /assembly list [mine|system|all]" };
    }
    const records = dependencies.deploymentRuntime.listAssemblies(filters);
    return {
      success: true,
      data: { records },
      message: records.length > 0
        ? [`Smart Assemblies (${records.length}, ${scope}):`, ...records.map(formatAssemblyRecord)].join("\n")
        : `No Smart Assemblies matched scope ${scope}.`,
    };
  }

  if (action === "info" || action === "inspect") {
    const selector = String(tokens.shift() || "");
    if (tokens.length > 0) {
      return { success: false, message: "Usage: /assembly info <itemID|nearest>" };
    }
    let record = null;
    if (selector.toLowerCase() === "nearest") {
      record = findNearestAssembly(session, dependencies);
    } else {
      const itemID = parseItemID(selector);
      record = itemID > 0
        ? dependencies.deploymentRuntime.getAssemblyRecord(itemID)
        : null;
    }
    if (!record) {
      return { success: false, message: "Smart Assembly was not found." };
    }
    const isAdmin = dependencies.deploymentRuntime.hasAssemblyAdminPrivileges(session);
    if (
      !isAdmin &&
      record.ownerID !== getCharacterID(session) &&
      record.solarSystemID !== getSolarSystemID(session)
    ) {
      return { success: false, message: "Smart Assembly is not visible from this session." };
    }
    return {
      success: true,
      data: { record },
      message: formatAssemblyRecord(record),
    };
  }

  const mutationActions = new Set([
    "complete",
    "link",
    "offline",
    "online",
    "remove",
    "spawn",
    "state",
    "unlink",
  ]);
  if (mutationActions.has(action)) {
    const denied = requireAdmin(session, dependencies.deploymentRuntime);
    if (denied) {
      return denied;
    }
  }

  if (action === "spawn") {
    let placementText = "";
    let stateText = "default";
    let stateSpecified = false;
    const queryTokens = [];
    for (const token of tokens) {
      const normalized = token.toLowerCase();
      if (isPlacementToken(normalized)) {
        if (placementText) {
          return { success: false, message: "Specify only one assembly placement." };
        }
        placementText = token;
      } else if (normalized.startsWith("state=")) {
        if (stateSpecified) {
          return { success: false, message: "Specify only one assembly state." };
        }
        stateSpecified = true;
        stateText = normalized.slice("state=".length);
      } else {
        queryTokens.push(token);
      }
    }
    if (!["default", "offline", "online"].includes(stateText)) {
      return { success: false, message: "Assembly state must be default, offline, or online." };
    }
    const definitions = dependencies.deploymentRuntime.listAssemblyDefinitions();
    const resolved = resolveDefinition(definitions, queryTokens.join(" "));
    if (!resolved.success) {
      const suggestions = resolved.suggestions && resolved.suggestions.length > 0
        ? ` Try: ${resolved.suggestions.join(", ")}.`
        : "";
      return {
        success: false,
        message: `${ERROR_MESSAGES[resolved.errorMsg] || "Smart Assembly type was not found."}${suggestions}`,
      };
    }
    const scene = dependencies.spaceRuntime.getSceneForSession(session);
    const ship = scene && typeof scene.getShipEntityForSession === "function"
      ? scene.getShipEntityForSession(session)
      : null;
    if (!scene || !ship) {
      return { success: false, message: "You must be in space with an active ship." };
    }
    const placement = resolveSpawnPosition(
      ship,
      placementText || `ahead=${DEFAULT_SPAWN_DISTANCE_METERS}`,
    );
    if (!placement.success) {
      return {
        success: false,
        message: "Placement must be here, ahead=<meters>, offset=x,y,z, or pos=x,y,z.",
      };
    }
    const stateByName = { offline: 1, online: 2 };
    const spawnResult = dependencies.deploymentRuntime.adminSpawnAssembly(
      session,
      resolved.match.assemblyTypeID,
      placement.position,
      {
        assemblyStatus: stateText === "default" ? null : stateByName[stateText],
      },
    );
    if (!spawnResult.success) {
      return { success: false, message: formatRuntimeError(spawnResult, "Assembly spawn failed") };
    }
    const record = spawnResult.data.record;
    return {
      success: true,
      data: spawnResult.data,
      message: `Spawned ${record.name} ${record.itemID} in system ${record.solarSystemID} ` +
        `at ${formatPosition(record.position)} (${formatStatus(record.assemblyStatus)}` +
        `${record.published === false ? ", hidden" : ""}).`,
    };
  }

  if (action === "state" || action === "online" || action === "offline") {
    const itemID = parseItemID(tokens.shift());
    const stateText = action === "state"
      ? String(tokens.shift() || "").toLowerCase()
      : action;
    if (
      !itemID ||
      !["offline", "online"].includes(stateText) ||
      tokens.length > 0
    ) {
      return { success: false, message: "Usage: /assembly state <itemID> <offline|online>" };
    }
    const result = dependencies.deploymentRuntime.adminSetAssemblyState(
      session,
      itemID,
      stateText === "online" ? 2 : 1,
    );
    return result.success
      ? {
        success: true,
        data: result.data,
        message: `Assembly ${itemID} is ${stateText}.`,
      }
      : { success: false, message: formatRuntimeError(result, "Assembly state change failed") };
  }

  if (action === "link") {
    const sourceID = parseItemID(tokens.shift());
    const destinationID = parseItemID(tokens.shift());
    if (!sourceID || !destinationID || tokens.length > 0) {
      return { success: false, message: "Usage: /assembly link <sourceGateID> <destinationGateID>" };
    }
    const result = dependencies.deploymentRuntime.adminLinkSmartGates(
      session,
      sourceID,
      destinationID,
    );
    return result.success
      ? { success: true, data: result.data, message: `Linked Smart Gates ${sourceID} and ${destinationID}.` }
      : { success: false, message: formatRuntimeError(result, "Smart Gate link failed") };
  }

  if (action === "unlink") {
    const gateID = parseItemID(tokens.shift());
    if (!gateID || tokens.length > 0) {
      return { success: false, message: "Usage: /assembly unlink <gateID>" };
    }
    const result = dependencies.deploymentRuntime.adminUnlinkSmartGate(session, gateID);
    return result.success
      ? {
        success: true,
        data: result.data,
        message: result.data && result.data.repairedSourceOnly
          ? `Cleared the stale outgoing link on Smart Gate ${gateID}; the referenced peer was left unchanged.`
          : `Unlinked Smart Gate ${gateID}.`,
      }
      : { success: false, message: formatRuntimeError(result, "Smart Gate unlink failed") };
  }

  if (action === "complete") {
    const itemID = parseItemID(tokens.shift());
    if (!itemID || tokens.length > 0) {
      return { success: false, message: "Usage: /assembly complete <constructionSiteID>" };
    }
    const result = dependencies.deploymentRuntime.adminCompleteConstruction(session, itemID);
    return result.success
      ? { success: true, data: result.data, message: `Completed Smart Assembly construction ${itemID}.` }
      : { success: false, message: formatRuntimeError(result, "Construction completion failed") };
  }

  if (action === "remove") {
    const itemID = parseItemID(tokens.shift());
    const confirmation = String(tokens.shift() || "").toLowerCase();
    if (!itemID || confirmation !== "confirm" || tokens.length > 0) {
      return { success: false, message: "Usage: /assembly remove <itemID> confirm" };
    }
    const result = dependencies.deploymentRuntime.adminRemoveAssembly(session, itemID);
    return result.success
      ? { success: true, data: result.data, message: `Removed Smart Assembly ${itemID}.` }
      : { success: false, message: formatRuntimeError(result, "Assembly removal failed") };
  }

  return { success: false, message: COMMAND_USAGE };
}

module.exports = {
  COMMAND_USAGE,
  DEFAULT_SPAWN_DISTANCE_METERS,
  executeFrontierAssemblyCommand,
  formatAssemblyRecord,
  formatDefinitionList,
  parseItemID,
  resolveDefinition,
  tokenizeArguments,
};
