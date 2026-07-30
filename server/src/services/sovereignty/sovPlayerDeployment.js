const path = require("path");

const spaceRuntime = require(path.join(__dirname, "../../space/runtime"));
const worldData = require(path.join(__dirname, "../../space/worldData"));
const {
  throwWrappedUserError,
} = require(path.join(__dirname, "../../common/machoErrors"));
const {
  normalizeText,
} = require(path.join(__dirname, "../_shared/serviceHelpers"));
const {
  ITEM_FLAGS,
  consumeInventoryItemQuantity,
  findItemById,
} = require(path.join(__dirname, "../inventory/itemStore"));
const {
  syncInventoryItemForSession,
} = require(path.join(__dirname, "../character/characterState"));
const structureState = require(path.join(__dirname, "../structure/structureState"));
const {
  DEPLOY_DIST_MAX,
  validateDeploymentPlacement,
} = require(path.join(__dirname, "../structure/structureDeploymentPlacement"));
const {
  resolveUsableProfileIDForCorporation,
} = require(path.join(__dirname, "../structure/structureProfilesState"));
const {
  DEFAULT_REINFORCE_HOUR,
  DEFAULT_REINFORCE_WEEKDAY,
  STRUCTURE_UPKEEP_STATE,
} = require(path.join(__dirname, "../structure/structureConstants"));
const {
  anchorSovereigntyStructures,
  ensureValidSolarSystem,
  STRUCTURE_KIND,
} = require(path.join(__dirname, "./sovGmState"));
const {
  TYPE_INFRASTRUCTURE_HUB,
  TYPE_TERRITORIAL_CLAIM_UNIT,
} = require(path.join(__dirname, "./sovConstants"));
const {
  DEFAULT_SOV_FLEX_FUEL_HOURS,
  deploySovereigntyFlexStructure,
} = require(path.join(__dirname, "./sovFlexStructures"));
const {
  getSystemDefenseMultiplier,
  getSystemState,
  publishSystemStateEffects,
  replaceSystemStateSnapshot,
  upsertSystemState,
} = require(path.join(__dirname, "./sovState"));
const {
  invalidateSovereigntyModernStateCache,
} = require(path.join(__dirname, "./sovModernState"));
const {
  isSovereigntyClaimableSolarSystem,
} = require(path.join(__dirname, "./sovSystemRules"));
const {
  TYPE_ANSIBLEX_JUMP_BRIDGE,
  TYPE_PHAROLUX_CYNO_BEACON,
  TYPE_TENEBREX_CYNO_JAMMER,
} = require(path.join(__dirname, "./sovUpgradeSupport"));

const CORP_ROLE_STATION_MANAGER = 2048n;
const CORP_ROLE_DIRECTOR = 1n;
const MIN_STRUCTURE_NAME_LENGTH = 3;
const MAX_STRUCTURE_NAME_LENGTH = 256;
const TYPE_CITADEL_ASTRAHUS = 35832;
const TYPE_ENGINEERING_COMPLEX_RAITARU = 35825;
const TYPE_REFINERY_ATHANOR = 35835;
const MAX_HOSTILE_DEPLOYMENT_ADM_BY_TYPE_ID = new Map([
  [TYPE_CITADEL_ASTRAHUS, 4],
  [TYPE_ENGINEERING_COMPLEX_RAITARU, 4],
  [TYPE_REFINERY_ATHANOR, 4],
]);
const STRUCTURE_DEPLOYMENT_SOURCE_FLAGS = Object.freeze(new Set([
  ITEM_FLAGS.CARGO_HOLD,
  ITEM_FLAGS.INFRASTRUCTURE_HOLD,
]));

function normalizeInteger(value, fallback = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.trunc(numeric);
}

function normalizePositiveInteger(value, fallback = null) {
  const numeric = normalizeInteger(value, 0);
  return numeric > 0 ? numeric : fallback;
}

function normalizeDeploymentDunRotation(rotationYaw) {
  const yawRadians = Number(rotationYaw);
  if (!Number.isFinite(yawRadians)) {
    return [0, 0, 0];
  }
  const yawDegrees = ((yawRadians * 180 / Math.PI) % 360 + 360) % 360;
  return [yawDegrees, 0, 0];
}

function normalizeRoleMask(value) {
  if (typeof value === "bigint") {
    return value;
  }
  try {
    return BigInt(value || 0);
  } catch (_error) {
    return 0n;
  }
}

function cloneValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeStructureText(value, fallback = "") {
  return normalizeText(value, fallback).trim();
}

function normalizeStructureName(value) {
  return normalizeStructureText(value)
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .slice(0, MAX_STRUCTURE_NAME_LENGTH)
    .trim();
}

function normalizeExtraConfig(value) {
  if (!value || typeof value !== "object") {
    return {};
  }
  if (
    value.type === "object" &&
    value.name === "util.KeyVal" &&
    value.args &&
    value.args.type === "dict" &&
    Array.isArray(value.args.entries)
  ) {
    return Object.fromEntries(value.args.entries);
  }
  if (value.type === "dict" && Array.isArray(value.entries)) {
    return Object.fromEntries(value.entries);
  }
  return { ...value };
}

function getSessionShipID(session) {
  return normalizePositiveInteger(
    session &&
      (
        (session._space && session._space.shipID) ||
        session.shipID ||
        session.shipid ||
        session.activeShipID
      ),
    null,
  );
}

function getSessionSolarSystemID(session) {
  return normalizePositiveInteger(
    session &&
      (
        (session._space && session._space.systemID) ||
        session.solarsystemid2 ||
        session.solarsystemid
      ),
    null,
  );
}

function getSessionShipEntity(session) {
  const shipID = getSessionShipID(session);
  if (!shipID) {
    return null;
  }
  return spaceRuntime.getEntity(session, shipID);
}

function resolvePositionFromClientRequest(session, x, z) {
  const shipEntity = getSessionShipEntity(session);
  const fallback = shipEntity && shipEntity.position
    ? shipEntity.position
    : { x: 0, y: 0, z: 0 };
  const xWasProvided = x !== null && x !== undefined;
  const zWasProvided = z !== null && z !== undefined;
  const xIsValid = !xWasProvided || Number.isFinite(Number(x));
  const zIsValid = !zWasProvided || Number.isFinite(Number(z));
  const rawX = xIsValid && xWasProvided ? Number(x) : 0;
  const rawZ = zIsValid && zWasProvided ? Number(z) : 0;
  const shipX = Number(fallback.x || 0);
  const shipY = Number(fallback.y || 0);
  const shipZ = Number(fallback.z || 0);
  const relativeDistance = Math.hypot(rawX, rawZ);
  const absoluteDistance = Math.hypot(rawX - shipX, rawZ - shipZ);

  // Some client paths send ship-relative offsets while others echo absolute
  // ballpark coordinates. Select the only candidate inside the authoritative
  // deployment range; preserve the historic relative interpretation when both
  // candidates are plausible (or both are invalid and validation must reject).
  const coordinateMode =
    absoluteDistance <= DEPLOY_DIST_MAX && relativeDistance > DEPLOY_DIST_MAX
      ? "absolute"
      : "relative";
  const position = coordinateMode === "absolute"
    ? { x: rawX, y: shipY, z: rawZ }
    : { x: shipX + rawX, y: shipY, z: shipZ + rawZ };

  return {
    position,
    clientPositionOffset: {
      x: position.x - shipX,
      y: position.y - shipY,
      z: position.z - shipZ,
    },
    clientPositionMode: coordinateMode,
    clientPositionValid: xIsValid && zIsValid,
  };
}

function buildPositionFromClientRequest(session, x, z) {
  return resolvePositionFromClientRequest(session, x, z).position;
}

function validateSovereigntyCorePlacementForSession(
  session,
  typeID,
  position,
  options = {},
) {
  const numericPosition = position && typeof position === "object"
    ? {
        x: Number(position.x),
        y: Number(position.y),
        z: Number(position.z),
      }
    : null;
  if (
    options.clientPositionValid === false ||
    !numericPosition ||
    !Number.isFinite(numericPosition.x) ||
    !Number.isFinite(numericPosition.y) ||
    !Number.isFinite(numericPosition.z)
  ) {
    throwWrappedUserError("CantDeployBlocked", {
      typeID: Number(typeID || 0),
    });
  }

  const shipEntity = getSessionShipEntity(session);
  if (!shipEntity || !shipEntity.position) {
    // Unit-level/non-live callers have no authoritative ballpark position.
    // Live clients always have a ship entity and take the checked path below.
    return { success: true, data: { skipped: true } };
  }

  const distance = Math.hypot(
    numericPosition.x - Number(shipEntity.position.x || 0),
    numericPosition.y - Number(shipEntity.position.y || 0),
    numericPosition.z - Number(shipEntity.position.z || 0),
  );
  if (!Number.isFinite(distance) || distance > DEPLOY_DIST_MAX + 1e-6) {
    throwWrappedUserError("CustomNotify", {
      notify: "That sovereignty structure is too far away to deploy.",
    });
  }

  // TCU and Sov Hub placement does not use Upwell proximity categories. In
  // particular, Ship.Drop legitimately launches at the deploying ship's ball.
  // Distance remains server-authoritative even though generic conflict rules do
  // not apply to these sovereignty cores.
  return {
    success: true,
    data: {
      distance,
      maximumDistance: DEPLOY_DIST_MAX,
      sovereigntyCore: true,
    },
  };
}

function validateStructureDeploymentPlacementForSession(session, typeID, position, options = {}) {
  const solarSystemID = getSessionSolarSystemID(session);
  const scene = spaceRuntime && spaceRuntime.scenes instanceof Map
    ? spaceRuntime.scenes.get(Number(solarSystemID)) || null
    : null;
  const shipEntity = getSessionShipEntity(session);

  if (getSovereigntyKindForTypeID(typeID)) {
    return validateSovereigntyCorePlacementForSession(
      session,
      typeID,
      position,
      options,
    );
  }

  // Match the client ballpark validator only when a real live scene exists.
  if (!scene || !shipEntity) {
    return { success: true, data: { skipped: true } };
  }

  const validation = validateDeploymentPlacement({
    solarSystemID,
    typeID,
    position,
    offset: options.clientPositionOffset,
    scene,
  });
  if (validation.success) {
    return validation;
  }

  if (validation.errorMsg === "DEPLOYMENT_DISTANCE_EXCEEDED") {
    throwWrappedUserError("CustomNotify", {
      notify: "That structure is too far away to deploy.",
    });
  }

  const conflictTypeID =
    validation.data && validation.data.ballTypeID
      ? Number(validation.data.ballTypeID)
      : Number(typeID || 0);
  throwWrappedUserError("CantDeployBlocked", {
    typeID: conflictTypeID,
  });
  return validation;
}

function consumeInventoryItemForDeployment(session, itemID) {
  const removeResult = consumeInventoryItemQuantity(itemID, 1, {
    removeContents: true,
  });
  if (!removeResult.success) {
    return removeResult;
  }

  for (const change of removeResult.data && removeResult.data.changes || []) {
    if (!change || !change.item) {
      continue;
    }
    syncInventoryItemForSession(
      session,
      change.item,
      change.previousData || {},
      {
        emitCfgLocation: true,
      },
    );
  }

  return removeResult;
}

function requireValidDeploymentSession(session) {
  if (!session || !normalizePositiveInteger(session.characterID || session.charid, null)) {
    throwWrappedUserError("CustomNotify", {
      notify: "Select a character before deploying a structure.",
    });
  }

  if (!session || !session._space || !getSessionSolarSystemID(session) || !getSessionShipID(session)) {
    throwWrappedUserError("CustomNotify", {
      notify: "You must be in space to deploy a structure.",
    });
  }

  const shipEntity = getSessionShipEntity(session);
  if (
    shipEntity &&
    (
      shipEntity.mode === "WARP" ||
      shipEntity.warpState ||
      shipEntity.pendingWarp
    )
  ) {
    throwWrappedUserError("ShipInWarp");
  }

  const corporationID = normalizePositiveInteger(
    session && (session.corporationID || session.corpid),
    null,
  );
  if (corporationID && corporationID >= 1000000 && corporationID < 2000000) {
    throwWrappedUserError("DropNeedsPlayerCorp", {});
  }

  if ((normalizeRoleMask(session.corprole) & CORP_ROLE_STATION_MANAGER) === 0n) {
    throwWrappedUserError("CrpAccessDenied", {
      reason: "Insufficient roles",
    });
  }
}

function requireStructureManagementSession(session, structure) {
  if (!session || !normalizePositiveInteger(session.characterID || session.charid, null)) {
    throwWrappedUserError("CustomNotify", {
      notify: "Select a character before managing a structure.",
    });
  }

  const gmBypass = structureState.hasStructureGmBypass(session);
  const corporationID = normalizePositiveInteger(
    session && (session.corporationID || session.corpid),
    null,
  );
  const ownerCorpID = normalizePositiveInteger(
    structure && (structure.ownerCorpID || structure.ownerID),
    null,
  );
  if (!gmBypass && corporationID && ownerCorpID && corporationID !== ownerCorpID) {
    throwWrappedUserError("CrpAccessDenied", {
      reason: "Structure belongs to another corporation",
    });
  }

  const roleMask = normalizeRoleMask(session && session.corprole);
  const hasStructureRole =
    (roleMask & CORP_ROLE_STATION_MANAGER) !== 0n ||
    (roleMask & CORP_ROLE_DIRECTOR) !== 0n ||
    session.isCEO === true;
  if (!gmBypass && !hasStructureRole) {
    throwWrappedUserError("CrpAccessDenied", {
      reason: "Insufficient roles",
    });
  }
}

function requireStructureDecommissionSession(session, structure) {
  if (!session || !normalizePositiveInteger(session.characterID || session.charid, null)) {
    throwWrappedUserError("CustomNotify", {
      notify: "Select a character before decommissioning a structure.",
    });
  }

  const gmBypass = structureState.hasStructureGmBypass(session);
  const corporationID = normalizePositiveInteger(
    session && (session.corporationID || session.corpid),
    null,
  );
  const ownerCorpID = normalizePositiveInteger(
    structure && (structure.ownerCorpID || structure.ownerID),
    null,
  );
  if (!gmBypass && (!corporationID || !ownerCorpID || corporationID !== ownerCorpID)) {
    throwWrappedUserError("CrpAccessDenied", {
      reason: "Structure belongs to another corporation",
    });
  }

  const roleMask = normalizeRoleMask(session && session.corprole);
  const hasDecommissionRole =
    (roleMask & CORP_ROLE_DIRECTOR) !== 0n ||
    session.isCEO === true;
  if (!gmBypass && !hasDecommissionRole) {
    throwWrappedUserError("CrpAccessDenied", {
      reason: "Insufficient roles",
    });
  }
}

function getSovereigntyKindForTypeID(typeID) {
  const numericTypeID = normalizePositiveInteger(typeID, null);
  if (numericTypeID === TYPE_TERRITORIAL_CLAIM_UNIT) {
    return STRUCTURE_KIND.TCU;
  }
  if (numericTypeID === TYPE_INFRASTRUCTURE_HUB) {
    return STRUCTURE_KIND.IHUB;
  }
  return null;
}

function getSovereigntyFlexKindForTypeID(typeID) {
  const numericTypeID = normalizePositiveInteger(typeID, null);
  if (numericTypeID === TYPE_PHAROLUX_CYNO_BEACON) {
    return "pharolux";
  }
  if (numericTypeID === TYPE_ANSIBLEX_JUMP_BRIDGE) {
    return "ansiblex";
  }
  if (numericTypeID === TYPE_TENEBREX_CYNO_JAMMER) {
    return "tenebrex";
  }
  return null;
}

function validateClaimableNullsecSolarSystem(solarSystemID) {
  const validation = ensureValidSolarSystem(solarSystemID);
  if (!validation.success) {
    throwWrappedUserError("TargetingAttemptCancelled");
  }

  const solarSystem = worldData.getSolarSystemByID(solarSystemID);
  if (!isSovereigntyClaimableSolarSystem(solarSystem)) {
    throwWrappedUserError("CantDeployBlocked", {
      typeID: 0,
    });
  }
}

function validateHostileAdmDeployment(session, solarSystemID, typeID) {
  const normalizedTypeID = normalizePositiveInteger(typeID, null);
  const maxAdm = MAX_HOSTILE_DEPLOYMENT_ADM_BY_TYPE_ID.get(normalizedTypeID);
  if (!maxAdm) {
    return;
  }

  const systemState = getSystemState(solarSystemID);
  const ownerAllianceID = normalizePositiveInteger(
    systemState && systemState.allianceID,
    null,
  );
  if (!ownerAllianceID) {
    return;
  }

  const deployerAllianceID = normalizePositiveInteger(
    session && (session.allianceID || session.allianceid),
    null,
  );
  if (deployerAllianceID && deployerAllianceID === ownerAllianceID) {
    return;
  }

  const adm = getSystemDefenseMultiplier(systemState);
  if (adm >= maxAdm) {
    throwWrappedUserError("CantDeployBlocked", {
      typeID: normalizedTypeID,
    });
  }
}

function updateNamedSovStructure(systemID, structureID, structureName) {
  const trimmedName = normalizeStructureText(structureName);
  if (!trimmedName) {
    return;
  }
  const currentSystem = getSystemState(systemID);
  if (!currentSystem || !Array.isArray(currentSystem.structures)) {
    return;
  }
  upsertSystemState(systemID, {
    structures: currentSystem.structures.map((structure) => (
      Number(structure && structure.itemID) === Number(structureID)
        ? {
          ...cloneValue(structure),
          name: trimmedName,
        }
        : structure
    )),
  });
}

function deploySovereigntyCoreFromItem(session, item, options = {}) {
  const solarSystemID = getSessionSolarSystemID(session);
  validateClaimableNullsecSolarSystem(solarSystemID);

  const kind = getSovereigntyKindForTypeID(item && item.typeID);
  const allianceID = normalizePositiveInteger(
    session && (session.allianceID || session.allianceid),
    null,
  );
  const corporationID = normalizePositiveInteger(
    session && (session.corporationID || session.corpid),
    null,
  );
  if (!kind || !allianceID || !corporationID) {
    throwWrappedUserError("CustomNotify", {
      notify: "Join an alliance before deploying sovereignty structures.",
    });
  }

  const currentSystem = getSystemState(solarSystemID);
  const existingStructureID = kind === STRUCTURE_KIND.TCU
    ? normalizePositiveInteger(currentSystem && currentSystem.claimStructureID, null)
    : normalizePositiveInteger(currentSystem && currentSystem.infrastructureHubID, null);
  const existingStructure = currentSystem && Array.isArray(currentSystem.structures)
    ? currentSystem.structures.find((structure) => (
        Number(structure && structure.typeID) === Number(item && item.typeID)
      ))
    : null;
  if (existingStructureID || existingStructure) {
    throwWrappedUserError("CustomNotify", {
      notify: kind === STRUCTURE_KIND.TCU
        ? "This solar system already has a Territorial Claim Unit."
        : "This solar system already has a Sovereignty Hub.",
    });
  }

  const position = options.position;
  const positionsByKind = {};
  positionsByKind[String(kind)] = {
    x: Number(position.x || 0),
    y: Number(position.y || 0),
    z: Number(position.z || 0),
  };
  const namesByKind = {};
  if (options.structureName) {
    namesByKind[String(kind)] = normalizeStructureText(options.structureName);
  }
  const sourceItemID = normalizePositiveInteger(item && item.itemID, null);
  if (sourceItemID && !Number.isSafeInteger(sourceItemID)) {
    throwWrappedUserError("CustomNotify", {
      notify: "That inventory item has an invalid structure ID.",
    });
  }
  const sourceQuantity = normalizePositiveInteger(
    item && (item.stacksize ?? item.quantity),
    1,
  );
  const sourceWillBeRemoved =
    Number(item && item.singleton) === 1 || sourceQuantity <= 1;
  const structureIDCollision = sourceItemID
    ? structureState.getStructureByID(sourceItemID, { refresh: false })
    : null;
  const liveEntityCollision = sourceItemID
    ? spaceRuntime.getEntity(session, sourceItemID)
    : null;
  if (sourceItemID && (structureIDCollision || liveEntityCollision)) {
    throwWrappedUserError("CustomNotify", {
      notify: "That inventory item ID is already in use by a live structure.",
    });
  }
  const preserveSourceItemID = Boolean(
    sourceItemID &&
    sourceWillBeRemoved &&
    Number.isSafeInteger(sourceItemID)
  );
  const itemIDsByKind = preserveSourceItemID
    ? { [String(kind)]: sourceItemID }
    : null;

  const anchorResult = anchorSovereigntyStructures(
    solarSystemID,
    kind,
    allianceID,
    corporationID,
    {
      positionsByKind,
      namesByKind,
      itemIDsByKind,
      // Inventory removal must reach the client before a same-ID AddBalls2.
      // The outer deployment flow performs the runtime sync after consumption.
      suppressStructureSync: true,
      suppressNotifications: true,
      failIfKindExists: true,
    },
  );
  if (!anchorResult.success) {
    throwWrappedUserError("CustomNotify", {
      notify: `Failed to deploy sovereignty structure: ${anchorResult.errorMsg}.`,
    });
  }

  invalidateSovereigntyModernStateCache();

  return {
    success: true,
    data: {
      type: "sovereignty_core",
      solarSystemID,
      kind,
      structureID:
        kind === STRUCTURE_KIND.TCU
          ? anchorResult.data.system.claimStructureID
          : anchorResult.data.system.infrastructureHubID,
      runtimeSyncDeferred: true,
      preservedSourceItemID: preserveSourceItemID,
    },
  };
}

function deploySovereigntyFlexFromItem(session, item, options = {}) {
  const solarSystemID = getSessionSolarSystemID(session);
  validateClaimableNullsecSolarSystem(solarSystemID);

  const kind = getSovereigntyFlexKindForTypeID(item && item.typeID);
  const allianceID = normalizePositiveInteger(
    session && (session.allianceID || session.allianceid),
    null,
  );
  const corporationID = normalizePositiveInteger(
    session && (session.corporationID || session.corpid),
    null,
  );
  if (!kind || !allianceID || !corporationID) {
    throwWrappedUserError("CustomNotify", {
      notify: "Join an alliance before deploying sovereignty flex structures.",
    });
  }

  const deployResult = deploySovereigntyFlexStructure(
    session,
    kind,
    {
      solarSystemID,
      allianceID,
      corporationID,
      fuelHours: DEFAULT_SOV_FLEX_FUEL_HOURS,
      reuseExisting: false,
      position: options.position,
      name: options.structureName,
      profileID: options.profileID,
      reinforceWeekday: options.reinforceWeekday,
      reinforceHour: options.reinforceHour,
      destinationSolarsystemID: options.destinationSolarsystemID,
    },
  );
  if (!deployResult.success) {
    let notify = `Failed to deploy sovereignty flex structure: ${deployResult.errorMsg}.`;
    if (deployResult.errorMsg === "SOV_HUB_REQUIRED") {
      notify = "Deploying sovereignty flex structures requires a claimed system with a Sov Hub.";
    } else if (deployResult.errorMsg === "INSUFFICIENT_LOCAL_CAPACITY") {
      notify = "That solar system cannot support the required Sov Hub upgrade for this flex structure.";
    } else if (deployResult.errorMsg === "REQUIRED_HUB_UPGRADE_NOT_ONLINE") {
      notify = "The required Sov Hub upgrade could not be brought online for this flex structure.";
    } else if (deployResult.errorMsg === "STRUCTURE_SYSTEM_CAP_REACHED") {
      notify = "That solar system already has the maximum number of that FLEX structure role.";
    }
    throwWrappedUserError("CustomNotify", {
      notify,
    });
  }

  return {
    success: true,
    data: {
      type: "sovereignty_flex",
      solarSystemID,
      kind,
      structureID: deployResult.data.structure.structureID,
    },
  };
}

function deployGenericStructureFromItem(session, item, options = {}) {
  const solarSystemID = getSessionSolarSystemID(session);
  const typeRecord = structureState.getStructureTypeByID(item && item.typeID);
  if (!typeRecord) {
    throwWrappedUserError("CustomNotify", {
      notify: "That structure type is not supported by the current deployment service.",
    });
  }
  const fallbackStructureName =
    normalizeStructureText(item && item.itemName, typeRecord.name) ||
    normalizeStructureText(typeRecord && typeRecord.name, `Structure ${typeRecord.typeID}`);
  const resolvedStructureName =
    normalizeStructureText(options.structureName, fallbackStructureName) ||
    fallbackStructureName;
  const resolvedStructureDescription = normalizeStructureText(
    options.bio !== undefined ? options.bio : options.description,
    "",
  );
  validateHostileAdmDeployment(session, solarSystemID, typeRecord.typeID);

  const createResult = structureState.createStructure(
    {
      typeID: typeRecord.typeID,
      name: resolvedStructureName,
      itemName: resolvedStructureName,
      description: resolvedStructureDescription,
      ownerCorpID: normalizePositiveInteger(
        session && (session.corporationID || session.corpid),
        0,
      ) || 1000009,
      allianceID: normalizePositiveInteger(
        session && (session.allianceID || session.allianceid),
        null,
      ),
      upkeepState: STRUCTURE_UPKEEP_STATE.LOW_POWER,
      solarSystemID,
      position: options.position,
      rotation: normalizeDeploymentDunRotation(options.rotationYaw),
      profileID: normalizePositiveInteger(options.profileID, 1) || 1,
      reinforceWeekday: normalizeInteger(
        options.reinforceWeekday,
        DEFAULT_REINFORCE_WEEKDAY,
      ),
      reinforceHour: normalizeInteger(
        options.reinforceHour,
        DEFAULT_REINFORCE_HOUR,
      ),
      devFlags: {
        ...(options.devFlags && typeof options.devFlags === "object"
          ? options.devFlags
          : {}),
        structureDeployment: true,
        structureDeploymentSourceItemID: normalizePositiveInteger(item && item.itemID, 0) || 0,
      },
    },
    { emitLive: false },
  );
  if (!createResult.success) {
    throwWrappedUserError("CustomNotify", {
      notify: `Failed to deploy structure: ${createResult.errorMsg}.`,
    });
  }

  const startResult = structureState.startAnchoring(
    createResult.data.structureID,
    Date.now(),
    { emitLive: false },
  );
  if (!startResult.success) {
    throwWrappedUserError("CustomNotify", {
      notify: `Failed to start anchoring: ${startResult.errorMsg}.`,
    });
  }

  return {
    success: true,
    data: {
      type: "generic_structure",
      solarSystemID,
      structureID: startResult.data.structureID,
    },
  };
}

function deployStructureFromInventoryItem(session, itemID, options = {}) {
  requireValidDeploymentSession(session);

  const item = findItemById(itemID);
  if (!item) {
    throwWrappedUserError("TargetingAttemptCancelled");
  }

  const shipID = getSessionShipID(session);
  if (
    Number(item.ownerID || 0) !== Number(session.characterID || session.charid || 0) ||
    Number(item.locationID || 0) !== Number(shipID || 0) ||
    !STRUCTURE_DEPLOYMENT_SOURCE_FLAGS.has(Number(item.flagID || 0))
  ) {
    throwWrappedUserError("TargetingAttemptCancelled");
  }

  const structureName = normalizeStructureText(
    options.structureName,
    normalizeStructureText(item && item.itemName),
  );
  const position = options.position || buildPositionFromClientRequest(session);
  const typeID = normalizePositiveInteger(item.typeID, null);
  const corporationID = normalizePositiveInteger(
    session && (session.corporationID || session.corpid),
    null,
  );
  const resolvedProfileID = resolveUsableProfileIDForCorporation(
    corporationID,
    options.profileID,
  );
  let resolvedOptions = {
    ...options,
    profileID: resolvedProfileID,
  };
  const sovereigntyCoreKind = getSovereigntyKindForTypeID(typeID);
  const previousSovereigntySystem = sovereigntyCoreKind
    ? getSystemState(getSessionSolarSystemID(session))
    : null;

  let deployResult = null;
  const placementValidation = validateStructureDeploymentPlacementForSession(
    session,
    typeID,
    position,
    resolvedOptions,
  );
  const moonMiningBeaconID = normalizePositiveInteger(
    placementValidation &&
      placementValidation.data &&
      placementValidation.data.moonMiningBeaconID,
    null,
  );
  if (moonMiningBeaconID) {
    const currentDevFlags =
      resolvedOptions.devFlags && typeof resolvedOptions.devFlags === "object"
        ? resolvedOptions.devFlags
        : {};
    resolvedOptions = {
      ...resolvedOptions,
      devFlags: {
        ...currentDevFlags,
        moonMiningBeaconID,
        moonMiningLocationVerified: true,
      },
    };
  }
  if (sovereigntyCoreKind) {
    deployResult = deploySovereigntyCoreFromItem(session, item, {
      ...resolvedOptions,
      structureName,
      position,
    });
  } else if (getSovereigntyFlexKindForTypeID(typeID)) {
    deployResult = deploySovereigntyFlexFromItem(session, item, {
      ...resolvedOptions,
      structureName,
      position,
    });
  } else {
    deployResult = deployGenericStructureFromItem(session, item, {
      ...resolvedOptions,
      structureName,
      position,
    });
  }

  const consumeResult = consumeInventoryItemForDeployment(session, item.itemID);
  if (!consumeResult.success) {
    if (
      deployResult &&
      deployResult.data &&
      deployResult.data.type === "sovereignty_core" &&
      deployResult.data.runtimeSyncDeferred === true
    ) {
      replaceSystemStateSnapshot(
        deployResult.data.solarSystemID,
        previousSovereigntySystem,
        {
          suppressStructureSync: true,
          suppressNotifications: true,
        },
      );
    }
    throwWrappedUserError("CustomNotify", {
      notify: `Deployment succeeded but consuming the inventory item failed: ${consumeResult.errorMsg}.`,
    });
  }

  if (
    deployResult &&
    deployResult.data &&
    deployResult.data.type === "sovereignty_core" &&
    deployResult.data.runtimeSyncDeferred === true
  ) {
    const systemState = getSystemState(deployResult.data.solarSystemID);
    const publishResult = publishSystemStateEffects(
      previousSovereigntySystem,
      systemState,
    );
    if (publishResult.success !== true) {
      deployResult.data.runtimeSyncPending = true;
    } else {
      delete deployResult.data.runtimeSyncPending;
    }
    delete deployResult.data.runtimeSyncDeferred;
  }

  if (
    deployResult &&
    deployResult.data &&
    deployResult.data.type === "generic_structure" &&
    typeof spaceRuntime.syncStructureSceneState === "function"
  ) {
    spaceRuntime.syncStructureSceneState(deployResult.data.solarSystemID, {
      initialStructureBundle: true,
    });
  }

  return deployResult;
}

function removeSovereigntyStructureFromSystem(solarSystemID, structureID) {
  const currentSystem = getSystemState(solarSystemID);
  if (!currentSystem || !Array.isArray(currentSystem.structures)) {
    return {
      success: false,
      errorMsg: "STRUCTURE_NOT_FOUND",
    };
  }

  const remainingStructures = currentSystem.structures.filter(
    (structure) => Number(structure && structure.itemID) !== Number(structureID),
  );
  const nextPatch = {
    structures: remainingStructures,
  };

  if (Number(currentSystem.claimStructureID || 0) === Number(structureID)) {
    nextPatch.claimStructureID = null;
    nextPatch.allianceID = null;
    nextPatch.corporationID = null;
    nextPatch.claimTime = "0";
    nextPatch.devIndices = {
      ...(currentSystem.devIndices || {}),
      claimedForDays: 0,
    };
  }
  if (Number(currentSystem.infrastructureHubID || 0) === Number(structureID)) {
    nextPatch.infrastructureHubID = null;
  }

  upsertSystemState(solarSystemID, nextPatch);
  invalidateSovereigntyModernStateCache();
  return {
    success: true,
    data: getSystemState(solarSystemID),
  };
}

function unanchorStructureByID(session, structureID) {
  const structure = structureState.getStructureByID(structureID, {
    refresh: false,
  });
  if (!structure) {
    throwWrappedUserError("TargetingAttemptCancelled");
  }
  requireStructureDecommissionSession(session, structure);

  const typeID = normalizePositiveInteger(structure.typeID, null);
  if (getSovereigntyKindForTypeID(typeID)) {
    const result = removeSovereigntyStructureFromSystem(
      normalizePositiveInteger(structure.solarSystemID, 0) || getSessionSolarSystemID(session),
      structure.structureID,
    );
    if (!result.success) {
      throwWrappedUserError("CustomNotify", {
        notify: `Failed to unanchor sovereignty structure: ${result.errorMsg}.`,
      });
    }
    return {
      success: true,
      data: {
        type: "sovereignty_core",
        structureID: structure.structureID,
      },
    };
  }

  const unanchorResult = structureState.startStructureUnanchoring(structure.structureID);
  if (!unanchorResult.success) {
    throwWrappedUserError("CustomNotify", {
      notify: `Failed to unanchor structure: ${unanchorResult.errorMsg}.`,
    });
  }
  if (typeof spaceRuntime.syncStructureSceneState === "function") {
    spaceRuntime.syncStructureSceneState(structure.solarSystemID);
  }
  return {
    success: true,
    data: {
      type: "structure",
      structureID: structure.structureID,
      unanchoring: unanchorResult.data.unanchoring,
    },
  };
}

function cancelStructureUnanchorByID(session, structureID) {
  const structure = structureState.getStructureByID(structureID, {
    refresh: false,
  });
  if (!structure) {
    throwWrappedUserError("TargetingAttemptCancelled");
  }
  requireStructureDecommissionSession(session, structure);
  const cancelResult = structureState.cancelStructureUnanchoring(structure.structureID);
  if (!cancelResult.success) {
    throwWrappedUserError("CustomNotify", {
      notify: `Failed to cancel unanchor: ${cancelResult.errorMsg}.`,
    });
  }
  if (typeof spaceRuntime.syncStructureSceneState === "function") {
    spaceRuntime.syncStructureSceneState(structure.solarSystemID);
  }
  return {
    success: true,
    data: {
      structureID: normalizePositiveInteger(structureID, 0),
      cancelled: cancelResult.data.cancelled === true,
    },
  };
}

function renameStructureByID(session, structureID, newName) {
  const structure = structureState.getStructureByID(structureID, {
    refresh: false,
  });
  if (!structure || structure.destroyedAt) {
    throwWrappedUserError("TargetingAttemptCancelled");
  }
  requireStructureManagementSession(session, structure);

  const normalizedName = normalizeStructureName(newName);
  if (normalizedName.length < MIN_STRUCTURE_NAME_LENGTH) {
    throwWrappedUserError("CharNameTooShort");
  }

  const updateResult = structureState.updateStructureRecord(
    structure.structureID,
    (current) => ({
      ...current,
      name: normalizedName,
      itemName: normalizedName,
    }),
  );
  if (!updateResult.success) {
    throwWrappedUserError("CustomNotify", {
      notify: `Failed to rename structure: ${updateResult.errorMsg}.`,
    });
  }

  updateNamedSovStructure(structure.solarSystemID, structure.structureID, normalizedName);
  invalidateSovereigntyModernStateCache();
  if (typeof spaceRuntime.syncStructureSceneState === "function") {
    spaceRuntime.syncStructureSceneState(structure.solarSystemID);
  }

  return {
    success: true,
    data: {
      structureID: structure.structureID,
      name: normalizedName,
    },
  };
}

module.exports = {
  buildPositionFromClientRequest,
  cancelStructureUnanchorByID,
  deployStructureFromInventoryItem,
  getSovereigntyFlexKindForTypeID,
  getSovereigntyKindForTypeID,
  normalizeExtraConfig,
  requireStructureManagementSession,
  renameStructureByID,
  resolvePositionFromClientRequest,
  unanchorStructureByID,
};
