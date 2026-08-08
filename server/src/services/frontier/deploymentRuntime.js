"use strict";

const crypto = require("crypto");
const path = require("path");

const log = require(path.join(__dirname, "../../utils/logger"));
const {
  TABLE,
  readStaticRows,
} = require(path.join(__dirname, "../_shared/referenceData"));
const itemStore = require(path.join(__dirname, "../inventory/itemStore"));

const ASSEMBLY_STATUS_OFFLINE = 1;
const ASSEMBLY_STATUS_ONLINE = 2;
const ASSEMBLY_STATUS_UNDER_CONSTRUCTION = 5;
const CONSTRUCTION_INFO_KEY = "evejsFrontierConstruction";
const CONSTRUCTION_SITE_LIMIT = 25;
const PORTABLE_BUILD_RADIUS_METERS = 2_500;
const NETWORK_NODE_BUILD_RADIUS_METERS = 80_000;
const NETWORK_NODE_ASSEMBLY_TYPE_ID = 88_092;
const SLINGSHOT_GATE_TYPE_IDS = new Set([95_627, 95_677]);
const ITEM_FLAG_CARGO_HOLD = 5;
const ASSEMBLY_TRANSITION_TTL_MS = 2 * 60 * 1000;
const SUI_ZERO_DIGEST = "11111111111111111111111111111111";
const METERS_PER_LIGHT_YEAR = 9_460_730_472_580_800;
const SMART_GATE_ACTIVATION_RUINED = 0;
const SMART_GATE_ACTIVATION_UNFUELED = 1;
const SMART_GATE_ACTIVATION_TRAVERSABLE = 2;
const SMART_GATE_ARRIVAL_CLEARANCE_METERS = 10_000;

const completionTimers = new Map();
const pendingAssemblyTransitions = new Map();
let buildDefinitionsByTypeID = null;
let solarSystemsByID = null;

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function toFiniteNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function normalizeText(value) {
  if (Buffer.isBuffer(value)) {
    return value.toString("utf8");
  }
  if (value && typeof value === "object" && typeof value.value === "string") {
    return value.value;
  }
  return value === null || value === undefined ? "" : String(value);
}

function getCharacterID(session) {
  return toInt(session && (session.characterID || session.charid), 0);
}

function getSolarSystemID(session) {
  return toInt(
    session && (session.solarsystemid2 || session.solarsystemid || session.locationid),
    0,
  );
}

function sequenceItems(value) {
  if (Array.isArray(value)) {
    return value;
  }
  if (value && typeof value === "object") {
    if (Array.isArray(value.items)) {
      return value.items;
    }
    if (Array.isArray(value.value)) {
      return value.value;
    }
    if (Array.isArray(value.data)) {
      return value.data;
    }
  }
  return null;
}

function normalizeWorldVector(value) {
  const sequence = sequenceItems(value);
  const source = sequence || value;
  const x = toFiniteNumber(source && (source.x ?? source[0]), Number.NaN);
  const y = toFiniteNumber(source && (source.y ?? source[1]), Number.NaN);
  const z = toFiniteNumber(source && (source.z ?? source[2]), Number.NaN);
  if (![x, y, z].every(Number.isFinite)) {
    return null;
  }
  return { x, y, z };
}

function normalizeRotationDegrees(value) {
  const sequence = sequenceItems(value);
  const source = sequence || value;
  const yaw = toFiniteNumber(source && (source.yaw ?? source[0]), Number.NaN);
  const pitch = toFiniteNumber(source && (source.pitch ?? source[1]), Number.NaN);
  const roll = toFiniteNumber(source && (source.roll ?? source[2]), Number.NaN);
  if (![yaw, pitch, roll].every(Number.isFinite)) {
    return null;
  }
  const radiansToDegrees = 180 / Math.PI;
  return [yaw, pitch, roll].map((angle) => angle * radiansToDegrees);
}

function vectorDistance(left, right) {
  const a = normalizeWorldVector(left);
  const b = normalizeWorldVector(right);
  if (!a || !b) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function addWorldVectors(left, right) {
  const a = normalizeWorldVector(left);
  const b = normalizeWorldVector(right);
  if (!a || !b) {
    return null;
  }
  return {
    x: a.x + b.x,
    y: a.y + b.y,
    z: a.z + b.z,
  };
}

function normalizeBuildAnchors(value) {
  const anchors = [];
  for (const entry of Array.isArray(value) ? value : []) {
    const position = normalizeWorldVector(entry && (entry.position || entry));
    if (!position) {
      continue;
    }
    anchors.push({
      itemID: toInt(entry && entry.itemID, 0) || null,
      position,
    });
  }
  return anchors;
}

function assessDeploymentCandidate(frame, position, ship, networkNodeAnchors) {
  const shipDistance = vectorDistance(position, ship);
  const buildAnchors = [{
    buildAnchor: "ship",
    buildAnchorItemID: null,
    deploymentDistance: shipDistance,
    maxDeploymentDistance: PORTABLE_BUILD_RADIUS_METERS,
  }];
  for (const anchor of networkNodeAnchors) {
    buildAnchors.push({
      buildAnchor: "network-node",
      buildAnchorItemID: anchor.itemID,
      deploymentDistance: vectorDistance(position, anchor.position),
      maxDeploymentDistance: NETWORK_NODE_BUILD_RADIUS_METERS,
    });
  }

  const inRangeAnchors = buildAnchors.filter((anchor) => (
    anchor.deploymentDistance <= anchor.maxDeploymentDistance
  ));
  const rankedAnchors = inRangeAnchors.length > 0 ? inRangeAnchors : buildAnchors;
  rankedAnchors.sort((left, right) => {
    if (inRangeAnchors.length > 0 && left.buildAnchor !== right.buildAnchor) {
      return left.buildAnchor === "ship" ? -1 : 1;
    }
    const leftRatio = left.deploymentDistance / left.maxDeploymentDistance;
    const rightRatio = right.deploymentDistance / right.maxDeploymentDistance;
    return leftRatio - rightRatio;
  });

  return {
    ...rankedAnchors[0],
    frame,
    position,
    shipDistance,
    withinRange: inRangeAnchors.length > 0,
  };
}

function resolveDeploymentPosition(clientPosition, shipPosition, options = {}) {
  const submitted = normalizeWorldVector(clientPosition);
  const ship = normalizeWorldVector(shipPosition);
  if (!submitted || !ship) {
    return null;
  }

  const networkNodeAnchors = normalizeBuildAnchors(options.networkNodeAnchors);
  const candidates = [
    assessDeploymentCandidate("world", submitted, ship, networkNodeAnchors),
    assessDeploymentCandidate(
      "ship-relative",
      addWorldVectors(ship, submitted),
      ship,
      networkNodeAnchors,
    ),
  ];
  const validCandidates = candidates.filter((candidate) => candidate.withinRange);
  if (validCandidates.length > 0) {
    validCandidates.sort((left, right) => {
      if (left.buildAnchor !== right.buildAnchor) {
        return left.buildAnchor === "ship" ? -1 : 1;
      }
      return left.frame === "world" ? -1 : 1;
    });
    return validCandidates[0];
  }

  candidates.sort((left, right) => (
    left.deploymentDistance / left.maxDeploymentDistance -
    right.deploymentDistance / right.maxDeploymentDistance
  ));
  return candidates[0];
}

function normalizeQuantityMap(value) {
  const entries = value && value.type === "dict" && Array.isArray(value.entries)
    ? value.entries
    : value && typeof value === "object" && !Array.isArray(value)
      ? Object.entries(value)
      : [];
  const result = {};
  for (const [rawTypeID, rawQuantity] of entries) {
    const typeID = toInt(rawTypeID, 0);
    const quantity = toInt(rawQuantity, 0);
    if (typeID > 0 && quantity > 0) {
      result[String(typeID)] = quantity;
    }
  }
  return result;
}

function parseCustomInfo(customInfo) {
  const text = String(customInfo || "").trim();
  if (!text) {
    return {};
  }
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch (_) {
    return { legacyCustomInfo: text };
  }
}

function readConstructionState(item) {
  const state = parseCustomInfo(item && item.customInfo)[CONSTRUCTION_INFO_KEY];
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    return null;
  }
  return {
    assemblyStatus: toInt(state.assemblyStatus, ASSEMBLY_STATUS_UNDER_CONSTRUCTION),
    assemblyTypeID: toInt(state.assemblyTypeID, 0),
    completeAtMs: toInt(state.completeAtMs, 0),
    completedAtMs: toInt(state.completedAtMs, 0),
    constructionCost: normalizeQuantityMap(state.constructionCost),
    constructionSiteTypeID: toInt(state.constructionSiteTypeID, 0),
    createdAtMs: toInt(state.createdAtMs, 0),
    destinationGateID: toInt(state.destinationGateID, 0),
    durationSeconds: Math.max(0, toInt(state.durationSeconds, 0)),
    ownerID: toInt(state.ownerID, toInt(item && item.ownerID, 0)),
    solarSystemID: toInt(state.solarSystemID, toInt(item && item.locationID, 0)),
    targetSolarSystemID: toInt(state.targetSolarSystemID, 0),
  };
}

function writeConstructionState(item, state) {
  const info = parseCustomInfo(item && item.customInfo);
  info[CONSTRUCTION_INFO_KEY] = {
    ...state,
    constructionCost: normalizeQuantityMap(state && state.constructionCost),
  };
  return JSON.stringify(info);
}

function buildAssemblyTransitionTransactionData({
  action,
  characterID,
  itemID,
  transactionUUID,
}) {
  const context = [
    "evejs-frontier-assembly-transition-v1",
    normalizeText(action).trim().toLowerCase(),
    toInt(characterID, 0),
    toInt(itemID, 0),
    normalizeText(transactionUUID).trim().toLowerCase(),
  ].join(":");
  const objectID = `0x${crypto.createHash("sha256").update(context).digest("hex")}`;

  // Frontier's bundled Sui signer accepts a serialized Transaction snapshot.
  // A fully resolved no-op transaction keeps this compatibility path local
  // while ensuring the user's signature covers the transition's unique context.
  return JSON.stringify({
    version: 2,
    sender: null,
    expiration: null,
    gasData: {
      budget: "1",
      price: "1",
      owner: null,
      payment: [{
        objectId: objectID,
        version: "1",
        digest: SUI_ZERO_DIGEST,
      }],
    },
    inputs: [],
    commands: [],
  });
}

function isValidAssemblyTransitionSignature(value) {
  const signature = normalizeText(value).trim();
  if (
    signature.length < 88 ||
    signature.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(signature)
  ) {
    return false;
  }

  const decoded = Buffer.from(signature, "base64");
  if (decoded.length < 65) {
    return false;
  }
  const normalizedInput = signature.replace(/=+$/u, "");
  const normalizedDecoded = decoded.toString("base64").replace(/=+$/u, "");
  return normalizedInput === normalizedDecoded;
}

function prunePendingAssemblyTransitions(nowMs = Date.now()) {
  for (const [transactionUUID, transition] of pendingAssemblyTransitions) {
    if (!transition || transition.expiresAtMs <= nowMs) {
      pendingAssemblyTransitions.delete(transactionUUID);
    }
  }
}

function buildDefinitionsFromRows(rows) {
  const definitions = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const assemblyTypeID = toInt(row && (row.typeID ?? row._key), 0);
    const smartDeployable = row && row.smartDeployable;
    const constructionCost = normalizeQuantityMap(
      smartDeployable && smartDeployable.constructionCost,
    );
    const constructionSiteTypeID = toInt(
      smartDeployable && smartDeployable.constructionSite,
      0,
    );
    if (assemblyTypeID <= 0 || Object.keys(constructionCost).length === 0) {
      continue;
    }
    const definition = {
      assemblyTypeID,
      constructionSiteTypeID,
      constructionCost,
      createOnChain: toInt(smartDeployable.createOnChain, 0) === 1,
      durationSeconds: Math.max(0, toInt(row.activate && row.activate.durationSeconds, 0)),
    };
    const smartGate = row && row.smartGate;
    if (smartGate && typeof smartGate === "object") {
      definition.smartGate = {
        maxPerSolarSystem: Math.max(0, toInt(smartGate.maxPerSolarSystem, 0)),
        minDistanceFromSameComponent: Math.max(
          0,
          toFiniteNumber(smartGate.minDistanceFromSameComponent, 0),
        ),
        rangeLightYears: Math.max(0, toFiniteNumber(smartGate.range, 0)),
      };
    }
    definitions.set(assemblyTypeID, definition);
  }
  return definitions;
}

function getBuildDefinition(assemblyTypeID) {
  if (!buildDefinitionsByTypeID) {
    buildDefinitionsByTypeID = buildDefinitionsFromRows(
      readStaticRows(TABLE.SPACE_COMPONENTS_BY_TYPE),
    );
  }
  return buildDefinitionsByTypeID.get(toInt(assemblyTypeID, 0)) || null;
}

function getSolarSystemRecord(solarSystemID) {
  if (!solarSystemsByID) {
    solarSystemsByID = new Map(
      readStaticRows(TABLE.SOLAR_SYSTEMS).map((record) => ([
        toInt(record && record.solarSystemID, 0),
        record,
      ])),
    );
  }
  return solarSystemsByID.get(toInt(solarSystemID, 0)) || null;
}

function getSolarSystemDistanceLightYears(leftSystemID, rightSystemID) {
  const left = getSolarSystemRecord(leftSystemID);
  const right = getSolarSystemRecord(rightSystemID);
  const distanceMeters = vectorDistance(
    left && left.position,
    right && right.position,
  );
  return Number.isFinite(distanceMeters)
    ? distanceMeters / METERS_PER_LIGHT_YEAR
    : Number.POSITIVE_INFINITY;
}

function isSmartGateDefinition(definition) {
  return Boolean(
    definition &&
    definition.smartGate &&
    definition.smartGate.rangeLightYears > 0,
  );
}

function isSlingshotGateType(typeID) {
  return SLINGSHOT_GATE_TYPE_IDS.has(toInt(typeID, 0));
}

function getSmartGateActivationState(state) {
  if (!state) {
    return SMART_GATE_ACTIVATION_RUINED;
  }
  return state.assemblyStatus === ASSEMBLY_STATUS_ONLINE
    ? SMART_GATE_ACTIVATION_TRAVERSABLE
    : SMART_GATE_ACTIVATION_UNFUELED;
}

function getSpaceRuntime() {
  return require(path.join(__dirname, "../../space/runtime"));
}

function getSpaceTransitions() {
  return require(path.join(__dirname, "../../space/transitions"));
}

function getCharacterState() {
  return require(path.join(__dirname, "../character/characterState"));
}

function getSessionShipEntity(session, shipItem) {
  if (!session || !shipItem) {
    return null;
  }
  return getSpaceRuntime().getEntity(session, shipItem.itemID);
}

function isCompletedNetworkNodeBuildAnchorState(state) {
  return Boolean(
    state && state.assemblyStatus !== ASSEMBLY_STATUS_UNDER_CONSTRUCTION,
  );
}

function listCompletedNetworkNodeBuildAnchors(session, characterID, solarSystemID) {
  const anchors = [];
  for (const item of itemStore.listSystemSpaceItems(solarSystemID)) {
    if (
      toInt(item && item.typeID, 0) !== NETWORK_NODE_ASSEMBLY_TYPE_ID ||
      toInt(item && item.ownerID, 0) !== characterID
    ) {
      continue;
    }
    const constructionState = readConstructionState(item);
    if (!isCompletedNetworkNodeBuildAnchorState(constructionState)) {
      continue;
    }
    const entity = getSpaceRuntime().getEntity(session, item.itemID);
    const position = normalizeWorldVector(
      (entity && entity.position) || (item.spaceState && item.spaceState.position),
    );
    if (!position) {
      continue;
    }
    anchors.push({
      itemID: toInt(item.itemID, 0),
      position,
    });
  }
  return anchors;
}

function getItemQuantity(item) {
  return toInt(item && item.singleton, 0) === 1
    ? 1
    : Math.max(0, toInt(item && (item.stacksize ?? item.quantity), 0));
}

function aggregateContainerItems(ownerID, locationID) {
  const quantities = {};
  for (const item of itemStore.listContainerItems(ownerID, locationID, null)) {
    const typeID = toInt(item && item.typeID, 0);
    if (typeID <= 0) {
      continue;
    }
    quantities[String(typeID)] = (quantities[String(typeID)] || 0) + getItemQuantity(item);
  }
  return quantities;
}

function hasRequiredMaterials(cost, deposited) {
  return Object.entries(cost).every(([typeID, required]) => (
    toInt(deposited[typeID], 0) >= toInt(required, 0)
  ));
}

function restorePlacementMaterials(characterID, shipItemID, quantities) {
  const entries = Object.entries(normalizeQuantityMap(quantities)).map(
    ([typeID, quantity]) => ({
      itemType: itemStore.getItemMetadata(toInt(typeID, 0)),
      quantity,
    }),
  );
  return itemStore.grantItemsToCharacterLocation(
    characterID,
    shipItemID,
    ITEM_FLAG_CARGO_HOLD,
    entries,
  );
}

function consumePlacementMaterials(characterID, shipItemID, constructionCost) {
  const available = aggregateContainerItems(characterID, shipItemID);
  if (!hasRequiredMaterials(constructionCost, available)) {
    return {
      success: false,
      errorMsg: "INSUFFICIENT_PLACEMENT_MATERIALS",
      changes: [],
    };
  }

  const changes = [];
  const consumed = {};
  for (const [typeID, quantity] of Object.entries(constructionCost)) {
    const takeResult = itemStore.takeItemTypeFromCharacterLocation(
      characterID,
      shipItemID,
      null,
      toInt(typeID, 0),
      quantity,
    );
    if (!takeResult.success) {
      const restoreResult = restorePlacementMaterials(
        characterID,
        shipItemID,
        consumed,
      );
      return {
        ...takeResult,
        changes: [
          ...changes,
          ...((restoreResult.data && restoreResult.data.changes) || []),
        ],
        rollbackError: restoreResult.success ? null : restoreResult.errorMsg,
      };
    }
    consumed[typeID] = quantity;
    changes.push(...((takeResult.data && takeResult.data.changes) || []));
  }

  return { success: true, changes, consumed };
}

function syncChanges(session, changes) {
  if (!session || !Array.isArray(changes) || changes.length === 0) {
    return;
  }
  getCharacterState().emitItemsChangedBatchForSession(session, changes);
}

function notifyAssemblyAdded(session, itemID, solarSystemID) {
  if (!session || typeof session.sendNotification !== "function") {
    return;
  }
  session.sendNotification("OnAssemblyAdded", "charid", [
    toInt(itemID, 0),
    toInt(solarSystemID, 0),
  ]);
}

function clearCompletionTimer(itemID) {
  const numericItemID = toInt(itemID, 0);
  const timer = completionTimers.get(numericItemID);
  if (timer) {
    clearTimeout(timer);
    completionTimers.delete(numericItemID);
  }
}

function scheduleConstruction(itemID, session = null) {
  const numericItemID = toInt(itemID, 0);
  const item = itemStore.findItemById(numericItemID);
  const state = readConstructionState(item);
  if (
    !item ||
    !state ||
    state.assemblyStatus !== ASSEMBLY_STATUS_UNDER_CONSTRUCTION ||
    state.completeAtMs <= 0 ||
    completionTimers.has(numericItemID)
  ) {
    return false;
  }
  const delayMs = Math.max(0, state.completeAtMs - Date.now());
  const timer = setTimeout(() => {
    completionTimers.delete(numericItemID);
    completeConstruction(numericItemID, { session });
  }, Math.min(delayMs, 0x7fffffff));
  if (typeof timer.unref === "function") {
    timer.unref();
  }
  completionTimers.set(numericItemID, timer);
  return true;
}

function validateOwnedConstructionItem(session, itemID) {
  const characterID = getCharacterID(session);
  const item = itemStore.findItemById(itemID);
  const state = readConstructionState(item);
  if (!item || !state) {
    return { success: false, errorMsg: "CONSTRUCTION_SITE_NOT_FOUND" };
  }
  if (characterID <= 0 || toInt(item.ownerID, 0) !== characterID) {
    return { success: false, errorMsg: "CONSTRUCTION_SITE_ACCESS_DENIED" };
  }
  return { success: true, item, state };
}

function validateOwnedChainAssembly(session, itemID) {
  const characterID = getCharacterID(session);
  const item = itemStore.findItemById(itemID);
  const state = readConstructionState(item);
  if (!item || !state) {
    return { success: false, errorMsg: "ASSEMBLY_NOT_FOUND" };
  }
  if (characterID <= 0 || toInt(item.ownerID, 0) !== characterID) {
    return { success: false, errorMsg: "ASSEMBLY_ACCESS_DENIED" };
  }
  if (state.assemblyStatus === ASSEMBLY_STATUS_UNDER_CONSTRUCTION) {
    return { success: false, errorMsg: "ASSEMBLY_UNDER_CONSTRUCTION" };
  }
  if (getSolarSystemID(session) !== state.solarSystemID) {
    return { success: false, errorMsg: "ASSEMBLY_NOT_IN_CURRENT_SYSTEM" };
  }

  const definition = getBuildDefinition(state.assemblyTypeID);
  if (!definition || definition.createOnChain !== true) {
    return { success: false, errorMsg: "ASSEMBLY_NOT_CHAIN_ANCHORED" };
  }
  return { success: true, characterID, definition, item, state };
}

function validateOwnedSmartGateForCharacter(characterID, itemID) {
  const item = itemStore.findItemById(itemID);
  const state = readConstructionState(item);
  if (!item || !state) {
    return { success: false, errorMsg: "ASSEMBLY_NOT_FOUND" };
  }
  if (characterID <= 0 || toInt(item.ownerID, 0) !== characterID) {
    return { success: false, errorMsg: "ASSEMBLY_ACCESS_DENIED" };
  }
  if (state.assemblyStatus === ASSEMBLY_STATUS_UNDER_CONSTRUCTION) {
    return { success: false, errorMsg: "ASSEMBLY_UNDER_CONSTRUCTION" };
  }
  const definition = getBuildDefinition(state.assemblyTypeID);
  if (!isSmartGateDefinition(definition)) {
    return { success: false, errorMsg: "ASSEMBLY_NOT_SMART_GATE" };
  }
  return { success: true, characterID, definition, item, state };
}

function validateOwnedSmartGate(session, itemID) {
  const characterID = getCharacterID(session);
  const validation = validateOwnedSmartGateForCharacter(characterID, itemID);
  if (!validation.success) {
    return validation;
  }
  if (getSolarSystemID(session) !== validation.state.solarSystemID) {
    return { success: false, errorMsg: "ASSEMBLY_NOT_IN_CURRENT_SYSTEM" };
  }
  return validation;
}

function beginAssemblyStateTransition(session, itemID, targetStatus) {
  const numericTargetStatus = toInt(targetStatus, 0);
  if (
    numericTargetStatus !== ASSEMBLY_STATUS_OFFLINE &&
    numericTargetStatus !== ASSEMBLY_STATUS_ONLINE
  ) {
    return { success: false, errorMsg: "INVALID_ASSEMBLY_STATE" };
  }

  const validation = validateOwnedChainAssembly(session, itemID);
  if (!validation.success) {
    return validation;
  }
  if (
    numericTargetStatus === ASSEMBLY_STATUS_ONLINE &&
    isSmartGateDefinition(validation.definition) &&
    validation.state.targetSolarSystemID <= 0
  ) {
    return { success: false, errorMsg: "SMART_GATE_DESTINATION_REQUIRED" };
  }

  const nowMs = Date.now();
  prunePendingAssemblyTransitions(nowMs);
  for (const [existingUUID, transition] of pendingAssemblyTransitions) {
    if (
      transition.characterID === validation.characterID &&
      transition.itemID === validation.item.itemID
    ) {
      pendingAssemblyTransitions.delete(existingUUID);
    }
  }

  const action = numericTargetStatus === ASSEMBLY_STATUS_ONLINE
    ? "online"
    : "offline";
  const transactionUUID = crypto.randomUUID().toLowerCase();
  const transactionData = buildAssemblyTransitionTransactionData({
    action,
    characterID: validation.characterID,
    itemID: validation.item.itemID,
    transactionUUID,
  });
  pendingAssemblyTransitions.set(transactionUUID, {
    action,
    characterID: validation.characterID,
    createdAtMs: nowMs,
    expiresAtMs: nowMs + ASSEMBLY_TRANSITION_TTL_MS,
    itemID: validation.item.itemID,
    sourceStatus: validation.state.assemblyStatus,
    targetStatus: numericTargetStatus,
    transactionData,
  });

  log.info(
    `[FrontierDeployment] Assembly ${action} prepared char=${validation.characterID} ` +
      `item=${validation.item.itemID} tx=${transactionUUID}`,
  );
  return {
    success: true,
    data: {
      transactionData,
      transactionUUID,
    },
  };
}

function refreshAssemblyStatePresentation(session, item, state) {
  const spaceRuntime = getSpaceRuntime();
  const scene = spaceRuntime.scenes instanceof Map
    ? spaceRuntime.scenes.get(toInt(state && state.solarSystemID, 0)) || null
    : typeof spaceRuntime.getSceneForSession === "function"
      ? spaceRuntime.getSceneForSession(session)
      : null;
  const entity = scene && typeof scene.getEntityByID === "function"
    ? scene.getEntityByID(item.itemID)
    : null;

  if (!scene) {
    return { success: true, data: { broadcast: false, entity: null } };
  }
  if (entity) {
    hydrateConstructionEntityFromInventoryItem(entity, item);
    if (typeof scene.broadcastSlimItemChanges === "function") {
      scene.broadcastSlimItemChanges([entity]);
      return { success: true, data: { broadcast: true, entity } };
    }
    return { success: true, data: { broadcast: false, entity } };
  }

  if (getSolarSystemID(session) === state.solarSystemID) {
    return spaceRuntime.spawnDynamicInventoryEntity(
      state.solarSystemID,
      item.itemID,
      { broadcast: true },
    );
  }
  return { success: true, data: { broadcast: false, entity: null } };
}

function commitAssemblyStateTransition(
  session,
  itemID,
  transactionUUID,
  signature,
  targetStatus,
) {
  const numericItemID = toInt(itemID, 0);
  const numericTargetStatus = toInt(targetStatus, 0);
  const normalizedUUID = normalizeText(transactionUUID).trim().toLowerCase();
  const nowMs = Date.now();
  prunePendingAssemblyTransitions(nowMs);

  const pending = pendingAssemblyTransitions.get(normalizedUUID);
  if (!pending) {
    return { success: false, errorMsg: "ASSEMBLY_TRANSACTION_NOT_FOUND" };
  }
  if (
    pending.itemID !== numericItemID ||
    pending.targetStatus !== numericTargetStatus ||
    pending.characterID !== getCharacterID(session)
  ) {
    return { success: false, errorMsg: "ASSEMBLY_TRANSACTION_MISMATCH" };
  }
  if (!isValidAssemblyTransitionSignature(signature)) {
    return { success: false, errorMsg: "INVALID_ASSEMBLY_SIGNATURE" };
  }

  pendingAssemblyTransitions.delete(normalizedUUID);
  const validation = validateOwnedChainAssembly(session, numericItemID);
  if (!validation.success) {
    return validation;
  }
  if (validation.state.assemblyStatus === numericTargetStatus) {
    return {
      success: true,
      data: { item: validation.item, alreadyApplied: true },
    };
  }
  if (validation.state.assemblyStatus !== pending.sourceStatus) {
    return { success: false, errorMsg: "ASSEMBLY_STATE_CHANGED" };
  }

  const updateResult = itemStore.updateInventoryItem(
    validation.item.itemID,
    (currentItem) => ({
      ...currentItem,
      customInfo: writeConstructionState(currentItem, {
        ...validation.state,
        assemblyStatus: numericTargetStatus,
      }),
    }),
  );
  if (!updateResult.success || !updateResult.data) {
    return updateResult.success
      ? { success: false, errorMsg: "ASSEMBLY_STATE_UPDATE_FAILED" }
      : updateResult;
  }

  const updatedState = readConstructionState(updateResult.data);
  const presentation = refreshAssemblyStatePresentation(
    session,
    updateResult.data,
    updatedState,
  );
  syncChanges(session, [{
    item: updateResult.data,
    previousData: updateResult.previousData,
  }]);

  log.info(
    `[FrontierDeployment] Assembly ${pending.action} completed ` +
      `char=${validation.characterID} item=${numericItemID} tx=${normalizedUUID} ` +
      `presentation=${presentation && presentation.success === true ? "sent" : "pending"}`,
  );
  return {
    success: true,
    data: {
      item: updateResult.data,
      presentation,
    },
  };
}

function validateGateLink(session, gateID, destinationGateID) {
  const source = validateOwnedSmartGate(session, gateID);
  if (!source.success) {
    return source;
  }
  if (isSlingshotGateType(source.state.assemblyTypeID)) {
    return { success: false, errorMsg: "SMART_GATE_LINK_NOT_SUPPORTED" };
  }

  const destination = validateOwnedSmartGateForCharacter(
    source.characterID,
    destinationGateID,
  );
  if (!destination.success) {
    return destination;
  }
  if (source.item.itemID === destination.item.itemID) {
    return { success: false, errorMsg: "SMART_GATE_SELF_LINK" };
  }
  if (source.state.solarSystemID === destination.state.solarSystemID) {
    return { success: false, errorMsg: "SMART_GATE_SAME_SYSTEM" };
  }
  if (source.state.assemblyTypeID !== destination.state.assemblyTypeID) {
    return { success: false, errorMsg: "SMART_GATE_TYPE_MISMATCH" };
  }
  if (
    source.state.destinationGateID > 0 ||
    destination.state.destinationGateID > 0
  ) {
    return { success: false, errorMsg: "SMART_GATE_ALREADY_LINKED" };
  }
  if (
    source.state.assemblyStatus !== ASSEMBLY_STATUS_OFFLINE ||
    destination.state.assemblyStatus !== ASSEMBLY_STATUS_OFFLINE
  ) {
    return { success: false, errorMsg: "SMART_GATE_MUST_BE_OFFLINE" };
  }

  const distanceLightYears = getSolarSystemDistanceLightYears(
    source.state.solarSystemID,
    destination.state.solarSystemID,
  );
  if (!Number.isFinite(distanceLightYears)) {
    return { success: false, errorMsg: "SMART_GATE_SYSTEM_DATA_UNAVAILABLE" };
  }
  if (distanceLightYears > source.definition.smartGate.rangeLightYears) {
    return {
      success: false,
      errorMsg: "SMART_GATE_OUT_OF_RANGE",
      data: {
        distanceLightYears,
        rangeLightYears: source.definition.smartGate.rangeLightYears,
      },
    };
  }
  return { success: true, destination, distanceLightYears, source };
}

function prepareGateTransition(validation, action, destinationGateID = 0) {
  const nowMs = Date.now();
  prunePendingAssemblyTransitions(nowMs);
  for (const [existingUUID, transition] of pendingAssemblyTransitions) {
    if (
      transition.characterID === validation.source.characterID &&
      transition.itemID === validation.source.item.itemID
    ) {
      pendingAssemblyTransitions.delete(existingUUID);
    }
  }

  const transactionUUID = crypto.randomUUID().toLowerCase();
  const transactionData = buildAssemblyTransitionTransactionData({
    action: destinationGateID > 0 ? `${action}:${destinationGateID}` : action,
    characterID: validation.source.characterID,
    itemID: validation.source.item.itemID,
    transactionUUID,
  });
  pendingAssemblyTransitions.set(transactionUUID, {
    action,
    characterID: validation.source.characterID,
    createdAtMs: nowMs,
    destinationGateID: toInt(destinationGateID, 0),
    expiresAtMs: nowMs + ASSEMBLY_TRANSITION_TTL_MS,
    itemID: validation.source.item.itemID,
    transactionData,
  });
  return {
    success: true,
    data: { transactionData, transactionUUID },
  };
}

function validatePendingGateTransition(
  session,
  gateID,
  transactionUUID,
  signature,
  action,
) {
  const normalizedUUID = normalizeText(transactionUUID).trim().toLowerCase();
  prunePendingAssemblyTransitions(Date.now());
  const pending = pendingAssemblyTransitions.get(normalizedUUID);
  if (!pending) {
    return { success: false, errorMsg: "ASSEMBLY_TRANSACTION_NOT_FOUND" };
  }
  if (
    pending.action !== action ||
    pending.itemID !== toInt(gateID, 0) ||
    pending.characterID !== getCharacterID(session)
  ) {
    return { success: false, errorMsg: "ASSEMBLY_TRANSACTION_MISMATCH" };
  }
  if (!isValidAssemblyTransitionSignature(signature)) {
    return { success: false, errorMsg: "INVALID_ASSEMBLY_SIGNATURE" };
  }
  pendingAssemblyTransitions.delete(normalizedUUID);
  return { success: true, normalizedUUID, pending };
}

function updateLinkedGatePair(session, validation) {
  const sourceUpdate = itemStore.updateInventoryItem(
    validation.source.item.itemID,
    (currentItem) => ({
      ...currentItem,
      customInfo: writeConstructionState(currentItem, {
        ...validation.source.state,
        destinationGateID: validation.destination.item.itemID,
        targetSolarSystemID: validation.destination.state.solarSystemID,
      }),
    }),
  );
  if (!sourceUpdate.success || !sourceUpdate.data) {
    return sourceUpdate.success
      ? { success: false, errorMsg: "SMART_GATE_LINK_UPDATE_FAILED" }
      : sourceUpdate;
  }

  const destinationUpdate = itemStore.updateInventoryItem(
    validation.destination.item.itemID,
    (currentItem) => ({
      ...currentItem,
      customInfo: writeConstructionState(currentItem, {
        ...validation.destination.state,
        destinationGateID: validation.source.item.itemID,
        targetSolarSystemID: validation.source.state.solarSystemID,
      }),
    }),
  );
  if (!destinationUpdate.success || !destinationUpdate.data) {
    const rollback = itemStore.updateInventoryItem(
      sourceUpdate.data.itemID,
      sourceUpdate.previousData,
    );
    if (!rollback.success) {
      log.error(
        `[FrontierDeployment] Gate link rollback failed item=${sourceUpdate.data.itemID} ` +
          `reason=${rollback.errorMsg || "UNKNOWN"}`,
      );
    }
    return destinationUpdate.success
      ? { success: false, errorMsg: "SMART_GATE_LINK_UPDATE_FAILED" }
      : destinationUpdate;
  }

  const sourceState = readConstructionState(sourceUpdate.data);
  const destinationState = readConstructionState(destinationUpdate.data);
  const sourcePresentation = refreshAssemblyStatePresentation(
    session,
    sourceUpdate.data,
    sourceState,
  );
  const destinationPresentation = refreshAssemblyStatePresentation(
    session,
    destinationUpdate.data,
    destinationState,
  );
  syncChanges(session, [
    { item: sourceUpdate.data, previousData: sourceUpdate.previousData },
    { item: destinationUpdate.data, previousData: destinationUpdate.previousData },
  ]);
  return {
    success: true,
    data: {
      destination: destinationUpdate.data,
      destinationPresentation,
      source: sourceUpdate.data,
      sourcePresentation,
    },
  };
}

function beginGateLinkTransition(session, gateID, destinationGateID) {
  const validation = validateGateLink(session, gateID, destinationGateID);
  if (!validation.success) {
    return validation;
  }
  const prepared = prepareGateTransition(
    validation,
    "link",
    validation.destination.item.itemID,
  );
  log.info(
    `[FrontierDeployment] Gate link prepared char=${validation.source.characterID} ` +
      `source=${validation.source.item.itemID} destination=${validation.destination.item.itemID} ` +
      `distanceLy=${validation.distanceLightYears.toFixed(3)} ` +
      `tx=${prepared.data.transactionUUID}`,
  );
  return prepared;
}

function commitGateLinkTransition(
  session,
  gateID,
  transactionUUID,
  signature,
) {
  const pendingResult = validatePendingGateTransition(
    session,
    gateID,
    transactionUUID,
    signature,
    "link",
  );
  if (!pendingResult.success) {
    return pendingResult;
  }
  const validation = validateGateLink(
    session,
    gateID,
    pendingResult.pending.destinationGateID,
  );
  if (!validation.success) {
    return validation;
  }
  const updateResult = updateLinkedGatePair(session, validation);
  if (!updateResult.success) {
    return updateResult;
  }
  log.info(
    `[FrontierDeployment] Gates linked char=${validation.source.characterID} ` +
      `source=${validation.source.item.itemID} destination=${validation.destination.item.itemID} ` +
      `tx=${pendingResult.normalizedUUID}`,
  );
  return updateResult;
}

function validateGateJump(session, gateID) {
  const source = validateOwnedSmartGate(session, gateID);
  if (!source.success) {
    return source;
  }
  if (source.state.assemblyStatus !== ASSEMBLY_STATUS_ONLINE) {
    return { success: false, errorMsg: "SMART_GATE_OFFLINE" };
  }
  if (
    source.state.destinationGateID <= 0 ||
    source.state.targetSolarSystemID <= 0
  ) {
    return { success: false, errorMsg: "SMART_GATE_NOT_LINKED" };
  }

  const destination = validateOwnedSmartGateForCharacter(
    source.characterID,
    source.state.destinationGateID,
  );
  if (!destination.success) {
    return destination;
  }
  if (
    source.state.targetSolarSystemID !== destination.state.solarSystemID ||
    destination.state.destinationGateID !== source.item.itemID ||
    destination.state.targetSolarSystemID !== source.state.solarSystemID
  ) {
    return { success: false, errorMsg: "SMART_GATE_LINK_MISMATCH" };
  }
  if (destination.state.assemblyStatus !== ASSEMBLY_STATUS_ONLINE) {
    return { success: false, errorMsg: "SMART_GATE_DESTINATION_OFFLINE" };
  }

  const shipItem = itemStore.getActiveShipItem(source.characterID);
  if (
    !shipItem ||
    toInt(shipItem.locationID, 0) !== source.state.solarSystemID ||
    toInt(shipItem.flagID, -1) !== 0
  ) {
    return { success: false, errorMsg: "SHIP_NOT_IN_SPACE" };
  }
  return { success: true, destination, shipItem, source };
}

function buildSmartGateArrivalSpawnState(destination, shipItem) {
  const anchorPosition = normalizeWorldVector(
    destination && destination.item && destination.item.spaceState &&
      destination.item.spaceState.position,
  );
  if (!anchorPosition) {
    return null;
  }

  const anchorMagnitude = Math.hypot(
    anchorPosition.x,
    anchorPosition.y,
    anchorPosition.z,
  );
  const direction = anchorMagnitude > 0
    ? {
        x: anchorPosition.x / anchorMagnitude,
        y: anchorPosition.y / anchorMagnitude,
        z: anchorPosition.z / anchorMagnitude,
      }
    : { x: 1, y: 0, z: 0 };
  const offset =
    Math.max(0, toFiniteNumber(destination.item.radius, 0)) +
    Math.max(0, toFiniteNumber(shipItem && shipItem.radius, 0)) +
    SMART_GATE_ARRIVAL_CLEARANCE_METERS;
  return {
    anchorType: "frontierSmartGate",
    anchorID: destination.item.itemID,
    anchorName: destination.item.itemName || "Heavy Gate",
    direction,
    position: {
      x: anchorPosition.x + direction.x * offset,
      y: anchorPosition.y + direction.y * offset,
      z: anchorPosition.z + direction.z * offset,
    },
  };
}

function beginGateJumpTransition(session, gateID) {
  const validation = validateGateJump(session, gateID);
  if (!validation.success) {
    return validation;
  }
  const prepared = prepareGateTransition(
    validation,
    "jump",
    validation.destination.item.itemID,
  );
  log.info(
    `[FrontierDeployment] Gate jump prepared char=${validation.source.characterID} ` +
      `source=${validation.source.item.itemID} destination=${validation.destination.item.itemID} ` +
      `tx=${prepared.data.transactionUUID}`,
  );
  return prepared;
}

function commitGateJumpTransition(
  session,
  gateID,
  transactionUUID,
  signature,
) {
  const pendingResult = validatePendingGateTransition(
    session,
    gateID,
    transactionUUID,
    signature,
    "jump",
  );
  if (!pendingResult.success) {
    return pendingResult;
  }

  const validation = validateGateJump(session, gateID);
  if (!validation.success) {
    return validation;
  }
  if (validation.destination.item.itemID !== pendingResult.pending.destinationGateID) {
    return { success: false, errorMsg: "SMART_GATE_LINK_MISMATCH" };
  }

  const spawnState = buildSmartGateArrivalSpawnState(
    validation.destination,
    validation.shipItem,
  );
  if (!spawnState) {
    return { success: false, errorMsg: "SMART_GATE_DESTINATION_UNAVAILABLE" };
  }
  const transitionResult = getSpaceTransitions().jumpSessionToSolarSystem(
    session,
    validation.destination.state.solarSystemID,
    {
      spawnStateOverride: spawnState,
      stargateJumpCloak: true,
    },
  );
  if (!transitionResult || transitionResult.success !== true) {
    return transitionResult || {
      success: false,
      errorMsg: "SMART_GATE_JUMP_FAILED",
    };
  }

  log.info(
    `[FrontierDeployment] Gate jump completed char=${validation.source.characterID} ` +
      `source=${validation.source.item.itemID} destination=${validation.destination.item.itemID} ` +
      `system=${validation.destination.state.solarSystemID} ` +
      `tx=${pendingResult.normalizedUUID}`,
  );
  return {
    success: true,
    data: {
      destination: validation.destination.item,
      source: validation.source.item,
      transition: transitionResult.data,
    },
  };
}

function validateGateUnlink(session, gateID) {
  const source = validateOwnedSmartGate(session, gateID);
  if (!source.success) {
    return source;
  }
  if (source.state.destinationGateID <= 0) {
    return { success: false, errorMsg: "SMART_GATE_NOT_LINKED" };
  }
  if (source.state.assemblyStatus !== ASSEMBLY_STATUS_OFFLINE) {
    return { success: false, errorMsg: "SMART_GATE_MUST_BE_OFFLINE" };
  }
  const destination = validateOwnedSmartGateForCharacter(
    source.characterID,
    source.state.destinationGateID,
  );
  if (
    destination.success &&
    destination.state.assemblyStatus !== ASSEMBLY_STATUS_OFFLINE
  ) {
    return { success: false, errorMsg: "SMART_GATE_MUST_BE_OFFLINE" };
  }
  return { success: true, destination, source };
}

function beginGateUnlinkTransition(session, gateID) {
  const validation = validateGateUnlink(session, gateID);
  if (!validation.success) {
    return validation;
  }
  const prepared = prepareGateTransition(
    validation,
    "unlink",
    validation.source.state.destinationGateID,
  );
  log.info(
    `[FrontierDeployment] Gate unlink prepared char=${validation.source.characterID} ` +
      `source=${validation.source.item.itemID} destination=${validation.source.state.destinationGateID} ` +
      `tx=${prepared.data.transactionUUID}`,
  );
  return prepared;
}

function commitGateUnlinkTransition(
  session,
  gateID,
  transactionUUID,
  signature,
) {
  const pendingResult = validatePendingGateTransition(
    session,
    gateID,
    transactionUUID,
    signature,
    "unlink",
  );
  if (!pendingResult.success) {
    return pendingResult;
  }
  const validation = validateGateUnlink(session, gateID);
  if (!validation.success) {
    return validation;
  }
  if (
    validation.source.state.destinationGateID !==
      pendingResult.pending.destinationGateID
  ) {
    return { success: false, errorMsg: "ASSEMBLY_STATE_CHANGED" };
  }

  const sourceUpdate = itemStore.updateInventoryItem(
    validation.source.item.itemID,
    (currentItem) => ({
      ...currentItem,
      customInfo: writeConstructionState(currentItem, {
        ...validation.source.state,
        destinationGateID: 0,
        targetSolarSystemID: 0,
      }),
    }),
  );
  if (!sourceUpdate.success || !sourceUpdate.data) {
    return sourceUpdate;
  }

  let destinationUpdate = null;
  if (
    validation.destination.success &&
    validation.destination.state.destinationGateID === validation.source.item.itemID
  ) {
    destinationUpdate = itemStore.updateInventoryItem(
      validation.destination.item.itemID,
      (currentItem) => ({
        ...currentItem,
        customInfo: writeConstructionState(currentItem, {
          ...validation.destination.state,
          destinationGateID: 0,
          targetSolarSystemID: 0,
        }),
      }),
    );
    if (!destinationUpdate.success || !destinationUpdate.data) {
      itemStore.updateInventoryItem(sourceUpdate.data.itemID, sourceUpdate.previousData);
      return destinationUpdate;
    }
  }

  const changes = [{
    item: sourceUpdate.data,
    previousData: sourceUpdate.previousData,
  }];
  refreshAssemblyStatePresentation(
    session,
    sourceUpdate.data,
    readConstructionState(sourceUpdate.data),
  );
  if (destinationUpdate && destinationUpdate.data) {
    changes.push({
      item: destinationUpdate.data,
      previousData: destinationUpdate.previousData,
    });
    refreshAssemblyStatePresentation(
      session,
      destinationUpdate.data,
      readConstructionState(destinationUpdate.data),
    );
  }
  syncChanges(session, changes);
  log.info(
    `[FrontierDeployment] Gates unlinked char=${validation.source.characterID} ` +
      `source=${validation.source.item.itemID} destination=${pendingResult.pending.destinationGateID} ` +
      `tx=${pendingResult.normalizedUUID}`,
  );
  return { success: true, data: { source: sourceUpdate.data } };
}

function placeDirectAssembly({
  characterID,
  definition,
  deploymentDistance,
  dunRotation,
  position,
  positionFrame,
  session,
  shipItem,
  solarSystemID,
}) {
  const materialResult = consumePlacementMaterials(
    characterID,
    shipItem.itemID,
    definition.constructionCost,
  );
  if (!materialResult.success) {
    syncChanges(session, materialResult.changes);
    if (materialResult.rollbackError) {
      log.error(
        `[FrontierDeployment] Placement material rollback failed char=${characterID} ` +
          `type=${definition.assemblyTypeID} reason=${materialResult.rollbackError}`,
      );
    }
    return materialResult;
  }

  const assemblyMetadata = itemStore.getItemMetadata(definition.assemblyTypeID);
  if (!assemblyMetadata || toInt(assemblyMetadata.typeID, 0) <= 0) {
    const restoreResult = restorePlacementMaterials(
      characterID,
      shipItem.itemID,
      materialResult.consumed,
    );
    syncChanges(session, [
      ...materialResult.changes,
      ...((restoreResult.data && restoreResult.data.changes) || []),
    ]);
    return { success: false, errorMsg: "ASSEMBLY_TYPE_NOT_FOUND" };
  }

  const nowMs = Date.now();
  const state = {
    assemblyStatus: ASSEMBLY_STATUS_OFFLINE,
    assemblyTypeID: definition.assemblyTypeID,
    completeAtMs: 0,
    completedAtMs: nowMs,
    constructionCost: definition.constructionCost,
    constructionSiteTypeID: 0,
    createdAtMs: nowMs,
    durationSeconds: definition.durationSeconds,
    ownerID: characterID,
    solarSystemID,
  };
  const createResult = itemStore.createSpaceItemForCharacter(
    characterID,
    solarSystemID,
    assemblyMetadata,
    {
      customInfo: writeConstructionState(null, state),
      dunRotation,
      mode: "STOP",
      position,
    },
  );
  if (!createResult.success || !createResult.data) {
    const restoreResult = restorePlacementMaterials(
      characterID,
      shipItem.itemID,
      materialResult.consumed,
    );
    syncChanges(session, [
      ...materialResult.changes,
      ...((restoreResult.data && restoreResult.data.changes) || []),
    ]);
    return createResult.success
      ? { success: false, errorMsg: "ASSEMBLY_CREATE_FAILED" }
      : createResult;
  }

  const assemblyItem = createResult.data;
  const spawnResult = getSpaceRuntime().spawnDynamicInventoryEntity(
    solarSystemID,
    assemblyItem.itemID,
    { broadcast: true },
  );
  if (!spawnResult.success) {
    getSpaceRuntime().removeDynamicEntity(solarSystemID, assemblyItem.itemID, {
      broadcast: true,
    });
    const removeResult = itemStore.removeInventoryItem(assemblyItem.itemID, {
      removeContents: true,
    });
    const restoreResult = restorePlacementMaterials(
      characterID,
      shipItem.itemID,
      materialResult.consumed,
    );
    syncChanges(session, [
      ...materialResult.changes,
      ...((removeResult.data && removeResult.data.changes) || []),
      ...((restoreResult.data && restoreResult.data.changes) || []),
    ]);
    return spawnResult;
  }

  syncChanges(session, [
    ...materialResult.changes,
    ...(createResult.changes || []),
  ]);
  notifyAssemblyAdded(session, assemblyItem.itemID, solarSystemID);
  log.info(
    `[FrontierDeployment] Assembly placed char=${characterID} ` +
      `item=${assemblyItem.itemID} type=${definition.assemblyTypeID} ` +
      `system=${solarSystemID} distance=${deploymentDistance.toFixed(1)} ` +
      `frame=${positionFrame} status=offline`,
  );
  return {
    success: true,
    data: {
      item: assemblyItem,
      definition,
      deploymentDistance,
      directPlacement: true,
      positionFrame,
    },
  };
}

function buildDeployable(session, assemblyTypeID, rawPosition, rawRotation) {
  const characterID = getCharacterID(session);
  const solarSystemID = getSolarSystemID(session);
  if (characterID <= 0 || solarSystemID <= 0) {
    return { success: false, errorMsg: "NOT_IN_SPACE" };
  }

  const definition = getBuildDefinition(assemblyTypeID);
  if (!definition) {
    return { success: false, errorMsg: "ASSEMBLY_TYPE_NOT_SUPPORTED" };
  }

  const clientPosition = normalizeWorldVector(rawPosition);
  const dunRotation = normalizeRotationDegrees(rawRotation);
  if (!clientPosition || !dunRotation) {
    return { success: false, errorMsg: "INVALID_DEPLOYMENT_PLACEMENT" };
  }

  const shipItem = itemStore.getActiveShipItem(characterID);
  const shipEntity = getSessionShipEntity(session, shipItem);
  if (
    !shipItem ||
    !shipEntity ||
    toInt(shipItem.locationID, 0) !== solarSystemID ||
    toInt(shipItem.flagID, -1) !== 0
  ) {
    return { success: false, errorMsg: "SHIP_NOT_IN_SPACE" };
  }

  const networkNodeAnchors = definition.assemblyTypeID === NETWORK_NODE_ASSEMBLY_TYPE_ID
    ? []
    : listCompletedNetworkNodeBuildAnchors(session, characterID, solarSystemID);
  const placement = resolveDeploymentPosition(clientPosition, shipEntity.position, {
    networkNodeAnchors,
  });
  if (!placement || !placement.position) {
    return { success: false, errorMsg: "INVALID_DEPLOYMENT_PLACEMENT" };
  }
  const {
    buildAnchor,
    buildAnchorItemID,
    deploymentDistance,
    frame: positionFrame,
    maxDeploymentDistance,
    position,
    shipDistance,
    withinRange,
  } = placement;
  if (!withinRange) {
    return {
      success: false,
      errorMsg: "DEPLOYMENT_TOO_FAR",
      data: {
        buildAnchor,
        buildAnchorItemID,
        deploymentDistance,
        maxDeploymentDistance,
        positionFrame,
        shipDistance,
      },
    };
  }

  if (definition.constructionSiteTypeID <= 0) {
    return placeDirectAssembly({
      characterID,
      definition,
      deploymentDistance,
      dunRotation,
      position,
      positionFrame,
      session,
      shipItem,
      solarSystemID,
    });
  }

  const activeSites = itemStore.listOwnedItems(characterID).filter((item) => {
    const state = readConstructionState(item);
    return state && state.assemblyStatus === ASSEMBLY_STATUS_UNDER_CONSTRUCTION;
  });
  if (activeSites.length >= CONSTRUCTION_SITE_LIMIT) {
    return { success: false, errorMsg: "TOO_MANY_CONSTRUCTION_SITES" };
  }

  const siteMetadata = itemStore.getItemMetadata(definition.constructionSiteTypeID);
  if (!siteMetadata || toInt(siteMetadata.typeID, 0) <= 0) {
    return { success: false, errorMsg: "CONSTRUCTION_SITE_TYPE_NOT_FOUND" };
  }

  const nowMs = Date.now();
  const state = {
    assemblyStatus: ASSEMBLY_STATUS_UNDER_CONSTRUCTION,
    assemblyTypeID: definition.assemblyTypeID,
    completeAtMs: 0,
    completedAtMs: 0,
    constructionCost: definition.constructionCost,
    constructionSiteTypeID: definition.constructionSiteTypeID,
    createdAtMs: nowMs,
    durationSeconds: definition.durationSeconds,
    ownerID: characterID,
    solarSystemID,
  };
  const createResult = itemStore.createSpaceItemForCharacter(
    characterID,
    solarSystemID,
    siteMetadata,
    {
      customInfo: writeConstructionState(null, state),
      dunRotation,
      mode: "STOP",
      position,
    },
  );
  if (!createResult.success || !createResult.data) {
    return createResult;
  }

  const siteItem = createResult.data;
  const spawnResult = getSpaceRuntime().spawnDynamicInventoryEntity(
    solarSystemID,
    siteItem.itemID,
    { broadcast: true },
  );
  if (!spawnResult.success) {
    itemStore.removeInventoryItem(siteItem.itemID, { removeContents: true });
    return spawnResult;
  }

  syncChanges(session, createResult.changes);
  notifyAssemblyAdded(session, siteItem.itemID, solarSystemID);
  log.info(
    `[FrontierDeployment] Construction site placed char=${characterID} ` +
      `item=${siteItem.itemID} assemblyType=${definition.assemblyTypeID} ` +
      `siteType=${definition.constructionSiteTypeID} system=${solarSystemID} ` +
      `distance=${deploymentDistance.toFixed(1)} frame=${positionFrame} ` +
      `anchor=${buildAnchor}${buildAnchorItemID ? `:${buildAnchorItemID}` : ""}`,
  );
  return {
    success: true,
    data: {
      buildAnchor,
      buildAnchorItemID,
      item: siteItem,
      definition,
      deploymentDistance,
      positionFrame,
      shipDistance,
    },
  };
}

function getDepositedItemsByType(session, itemID) {
  const validation = validateOwnedConstructionItem(session, itemID);
  if (!validation.success) {
    return validation;
  }
  return {
    success: true,
    data: aggregateContainerItems(validation.item.ownerID, validation.item.itemID),
  };
}

function depositItems(session, itemID, inventoryID, rawQuantities) {
  const validation = validateOwnedConstructionItem(session, itemID);
  if (!validation.success) {
    return validation;
  }
  const { item, state } = validation;
  if (state.assemblyStatus !== ASSEMBLY_STATUS_UNDER_CONSTRUCTION) {
    return { success: false, errorMsg: "CONSTRUCTION_ALREADY_COMPLETE" };
  }

  const characterID = getCharacterID(session);
  const sourceLocationID = toInt(inventoryID, 0);
  const requested = normalizeQuantityMap(rawQuantities);
  if (sourceLocationID <= 0 || Object.keys(requested).length === 0) {
    return { success: false, errorMsg: "INVALID_CONSTRUCTION_DEPOSIT" };
  }

  const depositedBefore = aggregateContainerItems(characterID, item.itemID);
  const sourceQuantities = aggregateContainerItems(characterID, sourceLocationID);
  for (const [typeID, quantity] of Object.entries(requested)) {
    const required = toInt(state.constructionCost[typeID], 0);
    const outstanding = Math.max(0, required - toInt(depositedBefore[typeID], 0));
    if (required <= 0 || quantity > outstanding) {
      return { success: false, errorMsg: "INVALID_CONSTRUCTION_MATERIAL" };
    }
    if (toInt(sourceQuantities[typeID], 0) < quantity) {
      return { success: false, errorMsg: "INSUFFICIENT_CONSTRUCTION_MATERIAL" };
    }
  }

  const changes = [];
  for (const [typeID, quantity] of Object.entries(requested)) {
    const moveResult = itemStore.moveItemTypeFromCharacterLocation(
      characterID,
      sourceLocationID,
      null,
      item.itemID,
      0,
      toInt(typeID, 0),
      quantity,
    );
    if (!moveResult.success) {
      return moveResult;
    }
    changes.push(...((moveResult.data && moveResult.data.changes) || []));
  }
  syncChanges(session, changes);

  const depositedAfter = aggregateContainerItems(characterID, item.itemID);
  if (hasRequiredMaterials(state.constructionCost, depositedAfter) && state.completeAtMs <= 0) {
    const completeAtMs = Date.now() + state.durationSeconds * 1000;
    const updateResult = itemStore.updateInventoryItem(item.itemID, (currentItem) => ({
      ...currentItem,
      customInfo: writeConstructionState(currentItem, {
        ...state,
        completeAtMs,
      }),
    }));
    if (!updateResult.success) {
      return updateResult;
    }
    scheduleConstruction(item.itemID, session);
    log.info(
      `[FrontierDeployment] Construction started item=${item.itemID} ` +
        `assemblyType=${state.assemblyTypeID} completesIn=${state.durationSeconds}s`,
    );
  }

  return { success: true, data: depositedAfter };
}

function completeConstruction(itemID, options = {}) {
  clearCompletionTimer(itemID);
  const item = itemStore.findItemById(itemID);
  const state = readConstructionState(item);
  if (!item || !state) {
    return { success: false, errorMsg: "CONSTRUCTION_SITE_NOT_FOUND" };
  }
  if (state.assemblyStatus !== ASSEMBLY_STATUS_UNDER_CONSTRUCTION) {
    return { success: true, data: { item, alreadyComplete: true } };
  }

  const deposited = aggregateContainerItems(item.ownerID, item.itemID);
  if (!hasRequiredMaterials(state.constructionCost, deposited)) {
    return { success: false, errorMsg: "CONSTRUCTION_MATERIALS_INCOMPLETE" };
  }
  if (!options.force && state.completeAtMs > Date.now()) {
    scheduleConstruction(item.itemID, options.session || null);
    return { success: true, data: { item, pending: true } };
  }

  const materialChanges = [];
  for (const [typeID, quantity] of Object.entries(state.constructionCost)) {
    const takeResult = itemStore.takeItemTypeFromCharacterLocation(
      item.ownerID,
      item.itemID,
      null,
      toInt(typeID, 0),
      quantity,
    );
    if (!takeResult.success) {
      return takeResult;
    }
    materialChanges.push(...((takeResult.data && takeResult.data.changes) || []));
  }

  const spaceRuntime = getSpaceRuntime();
  spaceRuntime.removeDynamicEntity(state.solarSystemID, item.itemID, {
    broadcast: true,
  });

  const assemblyMetadata = itemStore.getItemMetadata(state.assemblyTypeID);
  const definition = getBuildDefinition(state.assemblyTypeID);
  const completedAssemblyStatus = definition && definition.createOnChain
    ? ASSEMBLY_STATUS_OFFLINE
    : ASSEMBLY_STATUS_ONLINE;
  const completedAtMs = Date.now();
  const updateResult = itemStore.updateInventoryItem(item.itemID, (currentItem) => ({
    ...currentItem,
    customInfo: writeConstructionState(currentItem, {
      ...state,
      assemblyStatus: completedAssemblyStatus,
      completeAtMs: 0,
      completedAtMs,
    }),
    itemName: assemblyMetadata.name || currentItem.itemName,
    typeID: state.assemblyTypeID,
  }));
  if (!updateResult.success) {
    return updateResult;
  }

  const spawnResult = spaceRuntime.spawnDynamicInventoryEntity(
    state.solarSystemID,
    item.itemID,
    { broadcast: true },
  );
  if (!spawnResult.success) {
    log.warn(
      `[FrontierDeployment] Completed item ${item.itemID} persisted but could not be presented: ${spawnResult.errorMsg}`,
    );
  }
  syncChanges(options.session, [
    ...materialChanges,
    { item: updateResult.data, previousData: updateResult.previousData },
  ]);
  log.info(
    `[FrontierDeployment] Construction completed item=${item.itemID} ` +
      `assemblyType=${state.assemblyTypeID} system=${state.solarSystemID}`,
  );
  return {
    success: true,
    data: { item: updateResult.data, presentation: spawnResult },
  };
}

function cancelConstruction(session, itemID) {
  const validation = validateOwnedConstructionItem(session, itemID);
  if (!validation.success) {
    return validation;
  }
  const { item, state } = validation;
  if (state.assemblyStatus !== ASSEMBLY_STATUS_UNDER_CONSTRUCTION) {
    return { success: false, errorMsg: "CONSTRUCTION_ALREADY_COMPLETE" };
  }

  const shipItem = itemStore.getActiveShipItem(item.ownerID);
  if (!shipItem) {
    return { success: false, errorMsg: "SHIP_NOT_FOUND" };
  }

  const changes = [];
  for (const depositedItem of itemStore.listContainerItems(item.ownerID, item.itemID, null)) {
    const transferResult = itemStore.transferItemToOwnerLocation(
      depositedItem.itemID,
      item.ownerID,
      shipItem.itemID,
      ITEM_FLAG_CARGO_HOLD,
    );
    if (!transferResult.success) {
      return transferResult;
    }
    changes.push(...((transferResult.data && transferResult.data.changes) || []));
  }

  clearCompletionTimer(item.itemID);
  getSpaceRuntime().removeDynamicEntity(state.solarSystemID, item.itemID, {
    broadcast: true,
  });
  const removeResult = itemStore.removeInventoryItem(item.itemID, {
    removeContents: false,
  });
  if (!removeResult.success) {
    return removeResult;
  }
  changes.push(...((removeResult.data && removeResult.data.changes) || []));
  syncChanges(session, changes);
  log.info(
    `[FrontierDeployment] Construction cancelled char=${item.ownerID} item=${item.itemID}`,
  );
  return { success: true, data: { changes } };
}

function hydrateConstructionEntityFromInventoryItem(entity, item) {
  const state = readConstructionState(item);
  if (!entity || !state) {
    return entity;
  }
  entity.assembly_status = state.assemblyStatus;
  if (state.assemblyStatus === ASSEMBLY_STATUS_UNDER_CONSTRUCTION) {
    delete entity.component_activate;
    delete entity.activate_comp_durationSeconds;
    delete entity.activationState;
    delete entity.targetSolarsystemID;
    if (state.completeAtMs > 0) {
      scheduleConstruction(item.itemID);
    }
    return entity;
  }

  const isActive = state.assemblyStatus !== ASSEMBLY_STATUS_UNDER_CONSTRUCTION;
  entity.component_activate = [
    isActive,
    isActive || state.completeAtMs <= 0 ? null : state.completeAtMs,
  ];
  entity.activate_comp_durationSeconds = state.durationSeconds;
  const definition = getBuildDefinition(state.assemblyTypeID);
  if (isSmartGateDefinition(definition)) {
    entity.activationState = getSmartGateActivationState(state);
    entity.targetSolarsystemID = state.targetSolarSystemID > 0
      ? state.targetSolarSystemID
      : null;
  } else {
    delete entity.activationState;
    delete entity.targetSolarsystemID;
  }
  return entity;
}

function listMyAssemblies(session) {
  const characterID = getCharacterID(session);
  if (characterID <= 0) {
    return [];
  }
  const records = [];
  for (const item of itemStore.listOwnedItems(characterID)) {
    const state = readConstructionState(item);
    if (!state) {
      continue;
    }
    if (
      state.assemblyStatus === ASSEMBLY_STATUS_UNDER_CONSTRUCTION &&
      state.completeAtMs > 0
    ) {
      scheduleConstruction(item.itemID, session);
    }
    const position = normalizeWorldVector(item.spaceState && item.spaceState.position);
    records.push({
      item_id: item.itemID,
      type_id: state.assemblyStatus === ASSEMBLY_STATUS_ONLINE
        ? item.typeID
        : state.assemblyTypeID,
      name: item.itemName || itemStore.getItemMetadata(state.assemblyTypeID).name,
      state: state.assemblyStatus,
      solar_system_id: state.solarSystemID,
      position: position ? [position.x, position.y, position.z] : null,
    });
  }
  return records.sort((left, right) => left.item_id - right.item_id);
}

function listOwnedSmartGates(characterID) {
  const numericCharacterID = toInt(characterID, 0);
  if (numericCharacterID <= 0) {
    return [];
  }
  const gates = [];
  for (const item of itemStore.listOwnedItems(numericCharacterID)) {
    const state = readConstructionState(item);
    const definition = state && getBuildDefinition(state.assemblyTypeID);
    if (
      !state ||
      state.assemblyStatus === ASSEMBLY_STATUS_UNDER_CONSTRUCTION ||
      !isSmartGateDefinition(definition)
    ) {
      continue;
    }
    gates.push({
      activationState: getSmartGateActivationState(state),
      assemblyStatus: state.assemblyStatus,
      destinationGateID: state.destinationGateID,
      itemID: toInt(item.itemID, 0),
      name: String(
        item.itemName ||
        itemStore.getItemMetadata(state.assemblyTypeID).name ||
        "Smart Gate",
      ),
      ownerID: numericCharacterID,
      position: normalizeWorldVector(item.spaceState && item.spaceState.position),
      rangeLightYears: definition.smartGate.rangeLightYears,
      solarSystemID: state.solarSystemID,
      targetSolarSystemID: state.targetSolarSystemID,
      typeID: state.assemblyTypeID,
    });
  }
  return gates.sort((left, right) => left.itemID - right.itemID);
}

function recordAssemblyInteraction(session, itemID) {
  const numericItemID = toInt(itemID, 0);
  const item = itemStore.findItemById(numericItemID);
  const state = readConstructionState(item);
  if (!item || !state) {
    return { success: false, errorMsg: "ASSEMBLY_NOT_FOUND" };
  }
  if (getSolarSystemID(session) !== state.solarSystemID) {
    return { success: false, errorMsg: "ASSEMBLY_NOT_IN_CURRENT_SYSTEM" };
  }
  log.info(
    `[FrontierDeployment] Assembly interaction char=${getCharacterID(session)} ` +
      `item=${numericItemID} type=${state.assemblyTypeID} ` +
      `state=${state.assemblyStatus} destination=${state.targetSolarSystemID || 0}`,
  );
  return { success: true, data: { item, state } };
}

module.exports = {
  ASSEMBLY_STATUS_OFFLINE,
  ASSEMBLY_STATUS_ONLINE,
  ASSEMBLY_STATUS_UNDER_CONSTRUCTION,
  CONSTRUCTION_INFO_KEY,
  beginGateJumpTransition,
  beginGateLinkTransition,
  beginGateUnlinkTransition,
  beginAssemblyStateTransition,
  buildDeployable,
  cancelConstruction,
  commitGateJumpTransition,
  commitGateLinkTransition,
  commitGateUnlinkTransition,
  commitAssemblyStateTransition,
  completeConstruction,
  depositItems,
  getDepositedItemsByType,
  hydrateConstructionEntityFromInventoryItem,
  listOwnedSmartGates,
  listMyAssemblies,
  recordAssemblyInteraction,
  // Shared with the Network Node fuel runtime, which reuses the assembly
  // transition transaction/signature conventions and construction state.
  buildAssemblyTransitionTransactionData,
  isValidAssemblyTransitionSignature,
  readConstructionState,
  _testing: {
    buildDefinitionsFromRows,
    buildAssemblyTransitionTransactionData,
    isValidAssemblyTransitionSignature,
    isCompletedNetworkNodeBuildAnchorState,
    getSmartGateActivationState,
    getSolarSystemDistanceLightYears,
    isSlingshotGateType,
    isSmartGateDefinition,
    normalizeQuantityMap,
    normalizeRotationDegrees,
    normalizeWorldVector,
    resolveDeploymentPosition,
    readConstructionState,
    writeConstructionState,
    clearBuildDefinitionCache() {
      buildDefinitionsByTypeID = null;
      solarSystemsByID = null;
    },
    clearCompletionTimers() {
      for (const timer of completionTimers.values()) {
        clearTimeout(timer);
      }
      completionTimers.clear();
    },
    clearPendingAssemblyTransitions() {
      pendingAssemblyTransitions.clear();
    },
  },
};
