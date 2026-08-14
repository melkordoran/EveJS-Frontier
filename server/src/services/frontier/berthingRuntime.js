"use strict";

const path = require("path");

const {
  currentFileTime,
} = require(path.join(__dirname, "../_shared/serviceHelpers"));
const {
  TABLE,
  readStaticRows,
} = require(path.join(__dirname, "../_shared/referenceData"));
const itemStore = require(path.join(__dirname, "../inventory/itemStore"));
const deploymentRuntime = require(path.join(__dirname, "./deploymentRuntime"));

const BERTHING_PHASE_APPROACHING = "approaching";
const BERTHING_PHASE_BERTHED = "berthed";
const BERTHING_PHASE_DEPARTING = "departing";
const DEFAULT_SMART_HANGAR_ACCESS_RANGE = 5_000;
const BERTH_SHIP_CUSTOM_INFO_PREFIX = "Berth:";
const BERTHING_STATE_KEY = "evejsFrontierBerthing";
const CREATION_SHIP_TYPE_ID = 95276;
const REFUGE_TYPE_ID = 87160;
const REFUGE_INTERIOR_RADIUS = 169;
const BERTH_DEPARTURE_PADDING = 250;

const ACCEPTED_SHIP_TYPE_OVERRIDES = new Map([
  [REFUGE_TYPE_ID, new Set([CREATION_SHIP_TYPE_ID])],
]);

const contractsByCharacterID = new Map();
let smartHangarsByTypeID = null;

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function toFiniteNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function cloneVector(value, fallback = { x: 0, y: 0, z: 0 }) {
  return {
    x: toFiniteNumber(value && value.x, fallback.x),
    y: toFiniteNumber(value && value.y, fallback.y),
    z: toFiniteNumber(value && value.z, fallback.z),
  };
}

function addVectors(left, right) {
  return {
    x: toFiniteNumber(left && left.x, 0) + toFiniteNumber(right && right.x, 0),
    y: toFiniteNumber(left && left.y, 0) + toFiniteNumber(right && right.y, 0),
    z: toFiniteNumber(left && left.z, 0) + toFiniteNumber(right && right.z, 0),
  };
}

function subtractVectors(left, right) {
  return {
    x: toFiniteNumber(left && left.x, 0) - toFiniteNumber(right && right.x, 0),
    y: toFiniteNumber(left && left.y, 0) - toFiniteNumber(right && right.y, 0),
    z: toFiniteNumber(left && left.z, 0) - toFiniteNumber(right && right.z, 0),
  };
}

function scaleVector(value, scalar) {
  return {
    x: toFiniteNumber(value && value.x, 0) * scalar,
    y: toFiniteNumber(value && value.y, 0) * scalar,
    z: toFiniteNumber(value && value.z, 0) * scalar,
  };
}

function vectorMagnitude(value) {
  const vector = cloneVector(value);
  return Math.hypot(vector.x, vector.y, vector.z);
}

function normalizeVector(value, fallback = { x: 1, y: 0, z: 0 }) {
  const vector = cloneVector(value, fallback);
  const length = vectorMagnitude(vector);
  return length > 0 && Number.isFinite(length)
    ? scaleVector(vector, 1 / length)
    : cloneVector(fallback);
}

function directionFromDunRotation(value) {
  if (!Array.isArray(value) || value.length < 2) {
    return null;
  }
  const yaw = toFiniteNumber(value[0], Number.NaN) * (Math.PI / 180);
  const pitch = toFiniteNumber(value[1], Number.NaN) * (Math.PI / 180);
  if (!Number.isFinite(yaw) || !Number.isFinite(pitch)) {
    return null;
  }
  return normalizeVector({
    x: Math.sin(yaw) * Math.cos(pitch),
    y: -Math.sin(pitch),
    z: Math.cos(yaw) * Math.cos(pitch),
  });
}

function parseCustomInfoObject(value) {
  const text = String(value || "").trim();
  if (!text || text.startsWith(BERTH_SHIP_CUSTOM_INFO_PREFIX)) {
    return null;
  }
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : null;
  } catch (_) {
    return null;
  }
}

function readBerthHostIDFromCustomInfo(value) {
  const text = String(value || "").trim();
  if (text.startsWith(BERTH_SHIP_CUSTOM_INFO_PREFIX)) {
    return toInt(text.slice(BERTH_SHIP_CUSTOM_INFO_PREFIX.length), 0);
  }
  const parsed = parseCustomInfoObject(text);
  return toInt(
    parsed && parsed[BERTHING_STATE_KEY] &&
      parsed[BERTHING_STATE_KEY].hostAssemblyID,
    0,
  );
}

function writeBerthHostIDToCustomInfo(value, hostAssemblyID) {
  const hostID = toInt(hostAssemblyID, 0);
  const text = String(value || "").trim();
  const parsed = parseCustomInfoObject(text);
  if (!parsed && !text) {
    return `${BERTH_SHIP_CUSTOM_INFO_PREFIX}${hostID}`;
  }
  const info = parsed || { legacyCustomInfo: text };
  info[BERTHING_STATE_KEY] = { hostAssemblyID: hostID };
  return JSON.stringify(info);
}

function clearBerthHostIDFromCustomInfo(value) {
  const text = String(value || "").trim();
  if (!text || text.startsWith(BERTH_SHIP_CUSTOM_INFO_PREFIX)) {
    return "";
  }
  const parsed = parseCustomInfoObject(text);
  if (!parsed) {
    return text;
  }
  delete parsed[BERTHING_STATE_KEY];
  return Object.keys(parsed).length > 0 ? JSON.stringify(parsed) : "";
}

function getCharacterID(session) {
  return toInt(session && (session.characterID || session.charid), 0);
}

function getSolarSystemID(session) {
  return toInt(
    session && (
      session.solarsystemid2 ||
      session.solarsystemid ||
      (session._space && session._space.systemID) ||
      session.locationid
    ),
    0,
  );
}

function getShipID(session) {
  return toInt(
    session && (
      session.shipID ||
      session.shipid ||
      session.activeShipID ||
      (session._space && session._space.shipID)
    ),
    0,
  );
}

function getSpaceRuntime() {
  return require(path.join(__dirname, "../../space/runtime"));
}

function normalizeAcceptedGroupIDs(value) {
  if (value === null || value === undefined) {
    return null;
  }
  const entries = Array.isArray(value)
    ? value.map((groupID) => [groupID, true])
    : typeof value === "object"
      ? Object.entries(value)
      : [];
  return new Set(
    entries
      .filter(([, enabled]) => Boolean(enabled))
      .map(([groupID]) => toInt(groupID, 0))
      .filter((groupID) => groupID > 0),
  );
}

function buildSmartHangarDefinitions(rows) {
  const definitions = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const typeID = toInt(row && (row.typeID ?? row._key), 0);
    const smartHangar = row && row.smartHangar;
    if (typeID <= 0 || !smartHangar || typeof smartHangar !== "object") {
      continue;
    }
    definitions.set(typeID, {
      typeID,
      acceptedGroupIDs: normalizeAcceptedGroupIDs(smartHangar.acceptedGroupIDs),
      acceptedTypeIDs: new Set(ACCEPTED_SHIP_TYPE_OVERRIDES.get(typeID) || []),
      accessRange: Math.max(
        0,
        toFiniteNumber(
          smartHangar.accessRange,
          DEFAULT_SMART_HANGAR_ACCESS_RANGE,
        ),
      ),
      allowFreeForAll: toInt(smartHangar.allowFreeForAll, 0) === 1,
      allowUserAdd: toInt(smartHangar.allowUserAdd, 0) === 1,
      allowUserTake: toInt(smartHangar.allowUserTake, 0) === 1,
    });
  }
  return definitions;
}

function getSmartHangarDefinition(typeID) {
  if (!smartHangarsByTypeID) {
    smartHangarsByTypeID = buildSmartHangarDefinitions(
      readStaticRows(TABLE.SPACE_COMPONENTS_BY_TYPE),
    );
  }
  return smartHangarsByTypeID.get(toInt(typeID, 0)) || null;
}

function vectorDistance(left, right) {
  const leftPosition = left && left.position;
  const rightPosition = right && right.position;
  if (!leftPosition || !rightPosition) {
    return Number.POSITIVE_INFINITY;
  }
  const dx = toFiniteNumber(leftPosition.x, Number.NaN) -
    toFiniteNumber(rightPosition.x, Number.NaN);
  const dy = toFiniteNumber(leftPosition.y, Number.NaN) -
    toFiniteNumber(rightPosition.y, Number.NaN);
  const dz = toFiniteNumber(leftPosition.z, Number.NaN) -
    toFiniteNumber(rightPosition.z, Number.NaN);
  return [dx, dy, dz].every(Number.isFinite)
    ? Math.hypot(dx, dy, dz)
    : Number.POSITIVE_INFINITY;
}

function smartHangarAcceptsShipGroup(definition, groupID) {
  return Boolean(
    definition &&
      (
        definition.acceptedGroupIDs === null ||
        definition.acceptedGroupIDs.has(toInt(groupID, 0))
      ),
  );
}

function smartHangarAcceptsShip(definition, ship) {
  return Boolean(
    definition &&
      ship &&
      (
        (
          definition.acceptedTypeIDs instanceof Set &&
          definition.acceptedTypeIDs.has(toInt(ship.typeID, 0))
        ) ||
        smartHangarAcceptsShipGroup(definition, ship.groupID)
      ),
  );
}

function validateBerthingRequest(session, hostAssemblyID, dependencies = {}) {
  const characterID = getCharacterID(session);
  const solarSystemID = getSolarSystemID(session);
  const shipID = getShipID(session);
  if (
    characterID <= 0 ||
    solarSystemID <= 0 ||
    shipID <= 0 ||
    toInt(session && (session.stationID || session.stationid), 0) > 0 ||
    toInt(session && (session.structureID || session.structureid), 0) > 0
  ) {
    return { success: false, errorMsg: "BERTHING_NOT_IN_SPACE" };
  }

  const findItemById = dependencies.findItemById || itemStore.findItemById;
  const getActiveShipItem = dependencies.getActiveShipItem || itemStore.getActiveShipItem;
  const getDefinition = dependencies.getSmartHangarDefinition || getSmartHangarDefinition;
  const readConstructionState = dependencies.readConstructionState ||
    deploymentRuntime._testing.readConstructionState;
  const spaceRuntime = dependencies.spaceRuntime || getSpaceRuntime();
  const hostID = toInt(hostAssemblyID, 0);
  const hostItem = findItemById(hostID);
  if (!hostItem) {
    return { success: false, errorMsg: "BERTHING_HOST_NOT_FOUND" };
  }

  const definition = getDefinition(hostItem.typeID);
  if (!definition) {
    return { success: false, errorMsg: "BERTHING_HOST_NOT_SMART_HANGAR" };
  }
  if (toInt(hostItem.ownerID, 0) !== characterID) {
    return { success: false, errorMsg: "BERTHING_HOST_NOT_OWNED" };
  }
  if (!definition.allowUserAdd) {
    return { success: false, errorMsg: "BERTHING_HOST_NOT_OPERATIONAL" };
  }

  const constructionState = readConstructionState(hostItem);
  if (
    constructionState &&
    constructionState.assemblyStatus === deploymentRuntime.ASSEMBLY_STATUS_UNDER_CONSTRUCTION
  ) {
    return { success: false, errorMsg: "BERTHING_HOST_NOT_OPERATIONAL" };
  }
  if (
    toInt(hostItem.locationID, 0) !== solarSystemID ||
    toInt(hostItem.spaceState && hostItem.spaceState.systemID, solarSystemID) !== solarSystemID
  ) {
    return { success: false, errorMsg: "BERTHING_HOST_NOT_FOUND" };
  }

  const activeShip = getActiveShipItem(characterID);
  if (!activeShip || toInt(activeShip.itemID, 0) !== shipID) {
    return { success: false, errorMsg: "BERTHING_SHIP_NOT_FOUND" };
  }
  if (!smartHangarAcceptsShip(definition, activeShip)) {
    return { success: false, errorMsg: "BERTHING_SHIP_GROUP_NOT_ACCEPTED" };
  }

  const shipEntity = spaceRuntime.getEntity(session, shipID);
  const hostEntity = spaceRuntime.getEntity(session, hostID);
  if (!shipEntity) {
    return { success: false, errorMsg: "BERTHING_SHIP_NOT_FOUND" };
  }
  if (!hostEntity) {
    return { success: false, errorMsg: "BERTHING_HOST_NOT_FOUND" };
  }
  const distance = vectorDistance(shipEntity, hostEntity);
  if (distance > definition.accessRange) {
    return {
      success: false,
      errorMsg: "BERTHING_OUT_OF_RANGE",
      data: { accessRange: definition.accessRange, distance },
    };
  }

  return {
    success: true,
    data: {
      activeShip,
      characterID,
      definition,
      distance,
      hostEntity,
      hostItem,
      shipEntity,
      solarSystemID,
      spaceRuntime,
      session,
    },
  };
}

function buildContract(validationData, phase, previousContract = null) {
  return {
    hostAssemblyID: validationData.hostItem.itemID,
    occupiedShipID: validationData.activeShip.itemID,
    characterID: validationData.characterID,
    solarSystemID: validationData.solarSystemID,
    phase,
    signedAt: currentFileTime(),
    preBerthPosition: previousContract && previousContract.preBerthPosition
      ? cloneVector(previousContract.preBerthPosition)
      : cloneVector(validationData.shipEntity.position),
    preBerthDirection: previousContract && previousContract.preBerthDirection
      ? normalizeVector(previousContract.preBerthDirection)
      : normalizeVector(validationData.shipEntity.direction),
  };
}

function getBerthDirection(validationData) {
  return directionFromDunRotation(
    validationData.hostEntity.dunRotation || validationData.hostItem.dunRotation,
  ) || normalizeVector(
    validationData.hostEntity.direction,
    validationData.shipEntity.direction,
  );
}

function writeShipBerthMarker(activeShip, hostAssemblyID, dependencies = {}) {
  const updateShipItem = dependencies.updateShipItem || itemStore.updateShipItem;
  return updateShipItem(activeShip.itemID, (currentItem) => ({
    ...currentItem,
    customInfo: writeBerthHostIDToCustomInfo(
      currentItem.customInfo,
      hostAssemblyID,
    ),
  }));
}

function clearShipBerthMarker(activeShip, dependencies = {}) {
  const updateShipItem = dependencies.updateShipItem || itemStore.updateShipItem;
  return updateShipItem(activeShip.itemID, (currentItem) => ({
    ...currentItem,
    customInfo: clearBerthHostIDFromCustomInfo(currentItem.customInfo),
  }));
}

function relocateShipIntoBerth(validationData, dependencies = {}) {
  const berthPosition = cloneVector(validationData.hostEntity.position);
  const berthDirection = getBerthDirection(validationData);
  const hadMarker = readBerthHostIDFromCustomInfo(
    validationData.activeShip.customInfo,
  ) === toInt(validationData.hostItem.itemID, 0);
  const markerResult = writeShipBerthMarker(
    validationData.activeShip,
    validationData.hostItem.itemID,
    dependencies,
  );
  if (!markerResult || markerResult.success !== true) {
    return { success: false, errorMsg: "BERTHING_STATE_WRITE_FAILED" };
  }

  if (typeof validationData.spaceRuntime.stop === "function") {
    validationData.spaceRuntime.stop(validationData.session);
  }
  const relocation = validationData.spaceRuntime.teleportSessionShipToPoint(
    validationData.session,
    berthPosition,
    { direction: berthDirection, refreshOwnerSession: true },
  );
  if (!relocation || relocation.success !== true) {
    if (!hadMarker) {
      clearShipBerthMarker(validationData.activeShip, dependencies);
    }
    return {
      success: false,
      errorMsg: "BERTHING_RELOCATION_FAILED",
      data: { relocationError: relocation && relocation.errorMsg },
    };
  }

  return {
    success: true,
    data: { berthDirection, berthPosition },
  };
}

function buildBerthDepartureState(contract, hostItem, hostEntity, shipEntity) {
  const hostPosition = cloneVector(hostEntity.position);
  const approachOffset = contract && contract.preBerthPosition
    ? subtractVectors(contract.preBerthPosition, hostPosition)
    : null;
  const fallbackDirection = directionFromDunRotation(
    hostEntity.dunRotation || hostItem.dunRotation,
  ) || normalizeVector(hostEntity.direction);
  const direction = normalizeVector(approachOffset, fallbackDirection);
  const hostRadius = Math.max(
    toFiniteNumber(hostEntity.radius, 0),
    toInt(hostItem.typeID, 0) === REFUGE_TYPE_ID ? REFUGE_INTERIOR_RADIUS : 0,
  );
  const distance = hostRadius +
    Math.max(1, toFiniteNumber(shipEntity.radius, 0)) +
    BERTH_DEPARTURE_PADDING;
  return {
    direction,
    position: addVectors(hostPosition, scaleVector(direction, distance)),
  };
}

function setBerthingPhase(session, hostAssemblyID, phase, dependencies = {}) {
  const validation = validateBerthingRequest(session, hostAssemblyID, dependencies);
  if (!validation.success) {
    return validation;
  }
  const previousContract = contractsByCharacterID.get(validation.data.characterID) || null;
  const contract = buildContract(validation.data, phase, previousContract);
  if (phase === BERTHING_PHASE_BERTHED) {
    const relocation = relocateShipIntoBerth(validation.data, dependencies);
    if (!relocation.success) {
      return relocation;
    }
    contract.berthPosition = relocation.data.berthPosition;
    contract.berthDirection = relocation.data.berthDirection;
  }
  contractsByCharacterID.set(contract.characterID, contract);
  return { success: true, data: { contract } };
}

function recoverPersistedContract(session, dependencies = {}) {
  const characterID = getCharacterID(session);
  const shipID = getShipID(session);
  const solarSystemID = getSolarSystemID(session);
  const getActiveShipItem = dependencies.getActiveShipItem || itemStore.getActiveShipItem;
  const findItemById = dependencies.findItemById || itemStore.findItemById;
  const getDefinition = dependencies.getSmartHangarDefinition || getSmartHangarDefinition;
  const activeShip = getActiveShipItem(characterID);
  if (!activeShip || toInt(activeShip.itemID, 0) !== shipID) {
    return null;
  }
  const hostAssemblyID = readBerthHostIDFromCustomInfo(activeShip.customInfo);
  const hostItem = hostAssemblyID > 0 ? findItemById(hostAssemblyID) : null;
  if (
    !hostItem ||
    !getDefinition(hostItem.typeID) ||
    toInt(hostItem.ownerID, 0) !== characterID ||
    toInt(hostItem.locationID, 0) !== solarSystemID
  ) {
    return null;
  }
  return {
    hostAssemblyID,
    occupiedShipID: shipID,
    characterID,
    solarSystemID,
    phase: BERTHING_PHASE_BERTHED,
    signedAt: currentFileTime(),
    preBerthPosition: null,
    preBerthDirection: null,
    berthPosition: cloneVector(
      activeShip.spaceState && activeShip.spaceState.position,
      hostItem.spaceState && hostItem.spaceState.position,
    ),
    berthDirection: normalizeVector(activeShip.spaceState && activeShip.spaceState.direction),
  };
}

function getContractForSession(session, dependencies = {}) {
  const characterID = getCharacterID(session);
  if (characterID <= 0) {
    return null;
  }
  let contract = contractsByCharacterID.get(characterID) || null;
  if (
    contract &&
    (
      contract.solarSystemID !== getSolarSystemID(session) ||
      contract.occupiedShipID !== getShipID(session)
    )
  ) {
    contractsByCharacterID.delete(characterID);
    contract = null;
  }
  if (!contract) {
    contract = recoverPersistedContract(session, dependencies);
    if (contract) {
      contractsByCharacterID.set(characterID, contract);
    }
  }
  return contract ? { ...contract } : null;
}

function beginBerth(session, hostAssemblyID, dependencies = {}) {
  return setBerthingPhase(
    session,
    hostAssemblyID,
    BERTHING_PHASE_APPROACHING,
    dependencies,
  );
}

function berth(session, hostAssemblyID, dependencies = {}) {
  return setBerthingPhase(
    session,
    hostAssemblyID,
    BERTHING_PHASE_BERTHED,
    dependencies,
  );
}

function completeBerth(session, hostAssemblyID, dependencies = {}) {
  return setBerthingPhase(
    session,
    hostAssemblyID,
    BERTHING_PHASE_BERTHED,
    dependencies,
  );
}

function clearContract(session, hostAssemblyID, phase, dependencies = {}) {
  const characterID = getCharacterID(session);
  const contract = getContractForSession(session, dependencies);
  if (
    !contract ||
    contract.hostAssemblyID !== toInt(hostAssemblyID, 0)
  ) {
    return { success: false, errorMsg: "BERTHING_CONTRACT_NOT_FOUND" };
  }

  const findItemById = dependencies.findItemById || itemStore.findItemById;
  const getActiveShipItem = dependencies.getActiveShipItem || itemStore.getActiveShipItem;
  const spaceRuntime = dependencies.spaceRuntime || getSpaceRuntime();
  const activeShip = getActiveShipItem(characterID);
  const hostItem = findItemById(contract.hostAssemblyID);
  const shipEntity = spaceRuntime.getEntity(session, contract.occupiedShipID);
  const hostEntity = spaceRuntime.getEntity(session, contract.hostAssemblyID);
  if (!activeShip || !shipEntity) {
    return { success: false, errorMsg: "BERTHING_SHIP_NOT_FOUND" };
  }
  if (!hostItem || !hostEntity) {
    return { success: false, errorMsg: "BERTHING_HOST_NOT_FOUND" };
  }

  const markerResult = clearShipBerthMarker(activeShip, dependencies);
  if (!markerResult || markerResult.success !== true) {
    return { success: false, errorMsg: "BERTHING_STATE_WRITE_FAILED" };
  }
  const departure = buildBerthDepartureState(
    contract,
    hostItem,
    hostEntity,
    shipEntity,
  );
  const relocation = spaceRuntime.teleportSessionShipToPoint(
    session,
    departure.position,
    { direction: departure.direction, refreshOwnerSession: true },
  );
  if (!relocation || relocation.success !== true) {
    writeShipBerthMarker(activeShip, contract.hostAssemblyID, dependencies);
    return {
      success: false,
      errorMsg: "BERTHING_RELOCATION_FAILED",
      data: { relocationError: relocation && relocation.errorMsg },
    };
  }

  contractsByCharacterID.delete(characterID);
  return {
    success: true,
    data: {
      contract: {
        ...contract,
        phase,
        signedAt: currentFileTime(),
        departurePosition: departure.position,
        departureDirection: departure.direction,
      },
    },
  };
}

function undockBerth(session, hostAssemblyID, dependencies = {}) {
  return clearContract(
    session,
    hostAssemblyID,
    BERTHING_PHASE_DEPARTING,
    dependencies,
  );
}

function ejectOccupiedShip(session, hostAssemblyID, dependencies = {}) {
  return clearContract(
    session,
    hostAssemblyID,
    BERTHING_PHASE_DEPARTING,
    dependencies,
  );
}

function hasActiveContractForHostAssembly(hostAssemblyID) {
  const numericHostID = toInt(hostAssemblyID, 0);
  if (numericHostID <= 0) {
    return false;
  }
  return [...contractsByCharacterID.values()].some(
    (contract) => toInt(contract && contract.hostAssemblyID, 0) === numericHostID,
  );
}

module.exports = {
  BERTHING_PHASE_APPROACHING,
  BERTHING_PHASE_BERTHED,
  BERTHING_PHASE_DEPARTING,
  beginBerth,
  berth,
  completeBerth,
  ejectOccupiedShip,
  getContractForSession,
  hasActiveContractForHostAssembly,
  readBerthHostIDFromCustomInfo,
  undockBerth,
  _testing: {
    buildSmartHangarDefinitions,
    clearContracts() {
      contractsByCharacterID.clear();
    },
    clearSmartHangarDefinitionCache() {
      smartHangarsByTypeID = null;
    },
    normalizeAcceptedGroupIDs,
    readBerthHostIDFromCustomInfo,
    writeBerthHostIDToCustomInfo,
    clearBerthHostIDFromCustomInfo,
    smartHangarAcceptsShip,
    smartHangarAcceptsShipGroup,
    buildBerthDepartureState,
    recoverPersistedContract,
    validateBerthingRequest,
    vectorDistance,
  },
};
