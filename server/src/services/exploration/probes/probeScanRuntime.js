const path = require("path");

const {
  buildDict,
  buildFiletimeLong,
  buildKeyVal,
  buildMarshalRealVectorList,
  buildMarshalReal,
  currentFileTime,
  normalizeBigInt,
  unwrapMarshalValue,
} = require(path.join(__dirname, "../../_shared/serviceHelpers"));
const explorationAuthority = require(path.join(
  __dirname,
  "../explorationAuthority",
));
const signatureRuntime = require(path.join(
  __dirname,
  "../signatures/signatureRuntime",
));
const probeRuntimeState = require(path.join(__dirname, "./probeRuntimeState"));
const {
  getTypeDogmaAttributes,
} = require(path.join(__dirname, "../../fitting/liveFittingState"));
const {
  resolveItemByTypeID,
} = require(path.join(__dirname, "../../inventory/itemTypeRegistry"));

const PROBE_SCAN_GROUP_SIGNATURES =
  Number(
    explorationAuthority.getScanContracts().probeScanGroups &&
    explorationAuthority.getScanContracts().probeScanGroups.signatures,
  ) || 3;
const PROBE_SCAN_GROUP_STRUCTURES =
  Number(explorationAuthority.getScanContracts().probeScanGroups &&
    explorationAuthority.getScanContracts().probeScanGroups.structures) || 5;
const PROBE_SCAN_GROUP_SHIPS =
  Number(explorationAuthority.getScanContracts().probeScanGroups &&
    explorationAuthority.getScanContracts().probeScanGroups.ships) || 4;
const PROBE_SCAN_GROUP_DRONES =
  Number(explorationAuthority.getScanContracts().probeScanGroups &&
    explorationAuthority.getScanContracts().probeScanGroups.drones) || 6;
const PROBE_SCAN_GROUP_NPCS =
  Number(explorationAuthority.getScanContracts().probeScanGroups &&
    explorationAuthority.getScanContracts().probeScanGroups.npcs) || 10;
const PROBE_SCAN_GROUP_ORBITALS =
  Number(explorationAuthority.getScanContracts().probeScanGroups &&
    explorationAuthority.getScanContracts().probeScanGroups.orbitals) || 11;
const PROBE_SCAN_GROUP_DEPLOYABLES =
  Number(explorationAuthority.getScanContracts().probeScanGroups &&
    explorationAuthority.getScanContracts().probeScanGroups.deployables) || 12;
const PROBE_SCAN_GROUP_SOVEREIGNTY =
  Number(explorationAuthority.getScanContracts().probeScanGroups &&
    explorationAuthority.getScanContracts().probeScanGroups.sovereignty) || 13;
const PROBE_SCAN_GROUP_ABYSSAL_TRACES =
  Number(explorationAuthority.getScanContracts().probeScanGroups &&
    explorationAuthority.getScanContracts().probeScanGroups.abyssalTraces) || 14;
const GROUP_COSMIC_SIGNATURE =
  Number(
    explorationAuthority.getSignatureTypeDefinition("wormhole") &&
    explorationAuthority.getSignatureTypeDefinition("wormhole").inventoryGroupID,
  ) || 502;
const ATTRIBUTE_SCAN_WORMHOLE_STRENGTH =
  explorationAuthority.getScanStrengthAttribute("wormhole") || 1908;
const ATTRIBUTE_BASE_SENSOR_STRENGTH = 1371;
const ATTRIBUTE_BASE_MAX_SCAN_DEVIATION = 1372;
const ATTRIBUTE_RANGE_FACTOR = 1373;
const ATTRIBUTE_PROBE_CAN_SCAN_SHIPS = 1413;
const ATTRIBUTE_SIGNATURE_RADIUS = 552;
const SENSOR_STRENGTH_ATTRIBUTE_IDS = Object.freeze([208, 209, 210, 211]);
const CATEGORY_SHIP = 6;
const CATEGORY_DRONE = 18;
const CATEGORY_DEPLOYABLE = 22;
const CATEGORY_SOVEREIGNTY_STRUCTURE = 40;
const CATEGORY_ORBITAL = 46;
const CATEGORY_STRUCTURE = 65;
const DEFAULT_PROBE_SCAN_DURATION_MS = 8_000;
const DEFAULT_PROBE_EXPIRY_SECONDS = 60 * 60;
const PROBE_RESULT_PERFECT = 1;
const PROBE_RESULT_UNUSABLE = 0.001;
const PROBE_SCAN_BONUS_ORIGINS = Object.freeze([
  "modules",
  "ship",
  "skills",
  "implants",
  "boosters",
]);
const PROBE_SCAN_BONUS_IDS = Object.freeze([
  "strength",
  "deviation",
  "duration",
]);

function toFiniteNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function clonePosition(value, fallback = [0, 0, 0]) {
  const unwrappedValue =
    value &&
    typeof value === "object" &&
    (value.type || value.name || value.header)
      ? unwrapMarshalValue(value)
      : value;

  if (Array.isArray(unwrappedValue)) {
    return probeRuntimeState.clampVectorToProbeBounds([
      toFiniteNumber(unwrappedValue[0], fallback[0]),
      toFiniteNumber(unwrappedValue[1], fallback[1]),
      toFiniteNumber(unwrappedValue[2], fallback[2]),
    ]);
  }

  if (unwrappedValue && typeof unwrappedValue === "object") {
    return probeRuntimeState.clampVectorToProbeBounds([
      toFiniteNumber(unwrappedValue.x, fallback[0]),
      toFiniteNumber(unwrappedValue.y, fallback[1]),
      toFiniteNumber(unwrappedValue.z, fallback[2]),
    ]);
  }

  if (Array.isArray(value)) {
    return probeRuntimeState.clampVectorToProbeBounds([
      toFiniteNumber(value[0], fallback[0]),
      toFiniteNumber(value[1], fallback[1]),
      toFiniteNumber(value[2], fallback[2]),
    ]);
  }

  if (value && typeof value === "object") {
    return probeRuntimeState.clampVectorToProbeBounds([
      toFiniteNumber(value.x, fallback[0]),
      toFiniteNumber(value.y, fallback[1]),
      toFiniteNumber(value.z, fallback[2]),
    ]);
  }

  return [...fallback];
}

function normalizeScanBonuses(value) {
  const rawBonuses =
    value && typeof value === "object" && (value.type || value.name || value.header)
      ? unwrapMarshalValue(value)
      : value;
  const scanBonuses = {};

  for (const bonusID of PROBE_SCAN_BONUS_IDS) {
    const rawOrigins =
      rawBonuses &&
      typeof rawBonuses === "object" &&
      rawBonuses[bonusID] &&
      typeof rawBonuses[bonusID] === "object"
        ? rawBonuses[bonusID]
        : {};
    scanBonuses[bonusID] = Object.fromEntries(
      PROBE_SCAN_BONUS_ORIGINS.map((originID) => [
        originID,
        toFiniteNumber(rawOrigins[originID], 0),
      ]),
    );
  }

  return scanBonuses;
}

function mergeScanBonuses(...values) {
  const output = normalizeScanBonuses(null);
  for (const value of values) {
    const scanBonuses = normalizeScanBonuses(value);
    for (const bonusID of PROBE_SCAN_BONUS_IDS) {
      for (const originID of PROBE_SCAN_BONUS_ORIGINS) {
        output[bonusID][originID] += toFiniteNumber(
          scanBonuses &&
            scanBonuses[bonusID] &&
            scanBonuses[bonusID][originID],
          0,
        );
      }
    }
  }
  return output;
}

function hasAnyScanBonus(scanBonuses = {}) {
  const normalized = normalizeScanBonuses(scanBonuses);
  return PROBE_SCAN_BONUS_IDS.some((bonusID) =>
    PROBE_SCAN_BONUS_ORIGINS.some((originID) =>
      Math.abs(toFiniteNumber(normalized[bonusID][originID], 0)) > 1e-9,
    ),
  );
}

function sumScanBonus(scanBonuses = {}, bonusID) {
  const normalized = normalizeScanBonuses(scanBonuses);
  const bonuses = normalized[String(bonusID || "")] || {};
  return PROBE_SCAN_BONUS_ORIGINS.reduce(
    (sum, originID) => sum + toFiniteNumber(bonuses[originID], 0),
    0,
  );
}

function resolveScanBonusMultiplier(scanBonuses = {}, bonusID) {
  return Math.max(0, 1 + (sumScanBonus(scanBonuses, bonusID) / 100));
}

function buildScanBonusesDict(scanBonuses = {}) {
  return buildDict(
    PROBE_SCAN_BONUS_IDS.map((bonusID) => [
      bonusID,
      buildDict(
        PROBE_SCAN_BONUS_ORIGINS.map((originID) => [
          originID,
          buildMarshalReal(
            toFiniteNumber(
              scanBonuses &&
                scanBonuses[bonusID] &&
                scanBonuses[bonusID][originID],
              0,
            ),
            0,
          ),
        ]),
      ),
    ]),
  );
}

function extractProbeEntries(rawProbes) {
  if (!rawProbes) {
    return [];
  }

  if (
    rawProbes &&
    typeof rawProbes === "object" &&
    rawProbes.type === "dict" &&
    Array.isArray(rawProbes.entries)
  ) {
    return rawProbes.entries;
  }

  if (rawProbes instanceof Map) {
    return [...rawProbes.entries()];
  }

  if (typeof rawProbes === "object") {
    return Object.entries(rawProbes);
  }

  return [];
}

function normalizeProbeRecord(rawProbeID, rawProbe = {}) {
  const normalizedProbe =
    rawProbe && typeof rawProbe === "object" && (rawProbe.type || rawProbe.name || rawProbe.header)
      ? unwrapMarshalValue(rawProbe)
      : rawProbe;
  const probeID = toInt(
    rawProbeID,
    toInt(normalizedProbe && normalizedProbe.probeID, 0),
  );
  if (probeID <= 0) {
    return null;
  }

  const initialPosition = clonePosition(
    normalizedProbe && (normalizedProbe.pos || normalizedProbe.position),
  );
  const destination = clonePosition(
    normalizedProbe && normalizedProbe.destination,
    initialPosition,
  );
  // CCP's probe scan start payload reflects the probe positions that are about
  // to be used for the scan, not the stale pre-drag launch coordinates. When
  // we echo the stale launch coordinates back here, the client snaps the probe
  // formation back toward the origin and computes coverage from the wrong
  // place. Use the effective destination as the scan-time position.
  const pos = clonePosition(destination, initialPosition);
  const typeID = toInt(normalizedProbe && normalizedProbe.typeID, 0);
  const resolvedRange = probeRuntimeState.resolveProbeRangeContract(
    typeID,
    normalizedProbe && normalizedProbe.rangeStep,
    normalizedProbe && normalizedProbe.scanRange,
  );
  const state = toInt(normalizedProbe && normalizedProbe.state, 1);
  const expiry =
    normalizedProbe && Object.prototype.hasOwnProperty.call(normalizedProbe, "expiry")
      ? normalizeBigInt(normalizedProbe.expiry, 0n).toString()
      : (
        currentFileTime() +
        (BigInt(DEFAULT_PROBE_EXPIRY_SECONDS) * 10_000_000n)
      ).toString();
  const scanBonuses = normalizeScanBonuses(
    normalizedProbe && normalizedProbe.scanBonuses,
  );

  return {
    probeID,
    typeID,
    pos,
    destination,
    scanRange: resolvedRange.scanRange,
    rangeStep: resolvedRange.rangeStep,
    state,
    expiry,
    scanBonuses,
  };
}

function normalizeProbeMap(rawProbes) {
  return new Map(
    extractProbeEntries(rawProbes)
      .map(([probeID, probe]) => normalizeProbeRecord(probeID, probe))
      .filter(Boolean)
      .filter((probe) => probe.state > 0)
      .sort((left, right) => left.probeID - right.probeID)
      .slice(0, 8)
      .map((probe) => [probe.probeID, probe]),
  );
}

function normalizeProbePatchMap(rawProbes) {
  return new Map(
    extractProbeEntries(rawProbes)
      .map(([rawProbeID, rawProbe]) => {
        const normalizedProbe =
          rawProbe &&
          typeof rawProbe === "object" &&
          (rawProbe.type || rawProbe.name || rawProbe.header)
            ? unwrapMarshalValue(rawProbe)
            : rawProbe;
        const probeID = toInt(
          rawProbeID,
          toInt(normalizedProbe && normalizedProbe.probeID, 0),
        );
        if (probeID <= 0) {
          return null;
        }
        return [
          probeID,
          {
            typeID: toInt(normalizedProbe && normalizedProbe.typeID, 0),
            ...(() => {
              const resolvedRange = probeRuntimeState.resolveProbeRangeContract(
                toInt(normalizedProbe && normalizedProbe.typeID, 0),
                normalizedProbe && normalizedProbe.rangeStep,
                normalizedProbe && normalizedProbe.scanRange,
              );
              return {
                destination: clonePosition(
                  normalizedProbe && normalizedProbe.destination,
                  clonePosition(normalizedProbe && (normalizedProbe.pos || normalizedProbe.position)),
                ),
                scanRange: resolvedRange.scanRange,
                rangeStep: resolvedRange.rangeStep,
                state: toInt(normalizedProbe && normalizedProbe.state, 1),
              };
            })(),
          },
        ];
      })
      .filter(Boolean),
  );
}

function buildProbeDict(probeMap) {
  return buildDict(
    [...probeMap.values()].map((probe) => [
      probe.probeID,
      buildProbeKeyVal(probe),
    ]),
  );
}

function buildProbeKeyVal(probe = {}) {
  return buildKeyVal([
    ["probeID", toInt(probe.probeID, 0)],
    ["typeID", toInt(probe.typeID, 0) > 0 ? toInt(probe.typeID, 0) : null],
    ["pos", buildMarshalRealVectorList(clonePosition(probe.pos))],
    ["destination", buildMarshalRealVectorList(clonePosition(probe.destination, probe.pos))],
    ["scanRange", Math.max(0, toFiniteNumber(probe.scanRange, 0))],
    ["rangeStep", Math.max(1, toInt(probe.rangeStep, 1))],
    ["state", toInt(probe.state, 1)],
    ["scanBonuses", buildScanBonusesDict(normalizeScanBonuses(probe.scanBonuses))],
    ["expiry", buildFiletimeLong(probe.expiry)],
  ]);
}

function distanceBetween(left, right) {
  const dx = toFiniteNumber(left && left[0], 0) - toFiniteNumber(right && right[0], 0);
  const dy = toFiniteNumber(left && left[1], 0) - toFiniteNumber(right && right[1], 0);
  const dz = toFiniteNumber(left && left[2], 0) - toFiniteNumber(right && right[2], 0);
  return Math.sqrt((dx ** 2) + (dy ** 2) + (dz ** 2));
}

function getProbeTypeAttributes(typeID) {
  return getTypeDogmaAttributes(toInt(typeID, 0)) || {};
}

function isCombatScannerProbe(probeOrTypeID) {
  const typeID = toInt(
    probeOrTypeID && typeof probeOrTypeID === "object"
      ? probeOrTypeID.typeID
      : probeOrTypeID,
    0,
  );
  return toFiniteNumber(
    getProbeTypeAttributes(typeID)[String(ATTRIBUTE_PROBE_CAN_SCAN_SHIPS)],
    0,
  ) > 0;
}

function resolveProbeStrengthAtRange(probe) {
  const attributes = getProbeTypeAttributes(probe && probe.typeID);
  const baseStrength = Math.max(
    0,
    toFiniteNumber(attributes[String(ATTRIBUTE_BASE_SENSOR_STRENGTH)], 0),
  );
  const rangeFactor = Math.max(
    1,
    toFiniteNumber(attributes[String(ATTRIBUTE_RANGE_FACTOR)], 2),
  );
  const rangeStep = Math.max(1, toInt(probe && probe.rangeStep, 1));
  const strengthAtRange = baseStrength / (rangeFactor ** (rangeStep - 1));
  return Math.max(
    0,
    strengthAtRange * resolveScanBonusMultiplier(probe && probe.scanBonuses, "strength"),
  );
}

function resolveTargetRequiredStrength(site) {
  const explicitStrength = toFiniteNumber(
    site && (site.probeTargetRequiredStrength ?? site.requiredScanStrength),
    0,
  );
  if (explicitStrength > 0) {
    return explicitStrength;
  }
  if (toInt(site && site.scanGroupID, PROBE_SCAN_GROUP_SIGNATURES) === PROBE_SCAN_GROUP_SIGNATURES) {
    return Math.max(1, toFiniteNumber(site && site.difficulty, 1));
  }
  return 1;
}

function isProbeEligibleForSite(site, probe) {
  const scanGroupID = toInt(site && site.scanGroupID, PROBE_SCAN_GROUP_SIGNATURES);
  return scanGroupID === PROBE_SCAN_GROUP_SIGNATURES || isCombatScannerProbe(probe);
}

function collectSceneEntities(scene) {
  const byID = new Map();
  const candidates = [
    ...(Array.isArray(scene && scene.staticEntities) ? scene.staticEntities : []),
    ...(scene && scene.dynamicEntities instanceof Map
      ? [...scene.dynamicEntities.values()]
      : Array.isArray(scene && scene.dynamicEntities)
        ? scene.dynamicEntities
        : []),
  ];
  for (const entity of candidates) {
    const itemID = toInt(entity && entity.itemID, 0);
    if (itemID > 0 && !byID.has(itemID)) {
      byID.set(itemID, entity);
    }
  }
  return [...byID.values()];
}

function resolveEntityScanGroup(entity, metadata = null) {
  const kind = String(entity && entity.kind || "").trim().toLowerCase();
  const categoryID = toInt(
    entity && entity.categoryID,
    toInt(metadata && metadata.categoryID, 0),
  );

  if (kind.includes("npc")) {
    return PROBE_SCAN_GROUP_NPCS;
  }
  if (kind.includes("drone") || kind.includes("fighter")) {
    return PROBE_SCAN_GROUP_DRONES;
  }
  if (kind === "ship" || categoryID === CATEGORY_SHIP) {
    return PROBE_SCAN_GROUP_SHIPS;
  }
  if (kind.includes("abyssal") && kind.includes("trace")) {
    return PROBE_SCAN_GROUP_ABYSSAL_TRACES;
  }
  if (kind.includes("sovereignty") || categoryID === CATEGORY_SOVEREIGNTY_STRUCTURE) {
    return PROBE_SCAN_GROUP_SOVEREIGNTY;
  }
  if (kind.includes("orbital") || categoryID === CATEGORY_ORBITAL) {
    return PROBE_SCAN_GROUP_ORBITALS;
  }
  if (
    kind.includes("deployable") ||
    kind.startsWith("mobile") ||
    categoryID === CATEGORY_DEPLOYABLE
  ) {
    return PROBE_SCAN_GROUP_DEPLOYABLES;
  }
  if (kind.includes("structure") || categoryID === CATEGORY_STRUCTURE) {
    return PROBE_SCAN_GROUP_STRUCTURES;
  }
  if (categoryID === CATEGORY_DRONE) {
    return PROBE_SCAN_GROUP_DRONES;
  }
  return 0;
}

function isEntityHiddenFromCombatProbes(entity) {
  if (!entity || entity.probeScanVisible === false || entity.cloaked === true) {
    return true;
  }
  if (toInt(entity.isCloaked, 0) > 0 || toInt(entity.cloakMode, 0) > 0) {
    return true;
  }
  if (typeof entity.cloakState === "number") {
    return toInt(entity.cloakState, 0) > 0;
  }
  if (entity.cloakState && typeof entity.cloakState === "object") {
    return (
      entity.cloakState.active === true ||
      String(entity.cloakState.state || "").trim().toLowerCase() === "active" ||
      toInt(entity.cloakState.mode, 0) > 0
    );
  }
  return false;
}

function resolveEntitySensorStrength(entity, attributes = {}) {
  const explicitStrength = toFiniteNumber(entity && entity.sensorStrength, 0);
  return Math.max(
    explicitStrength,
    ...SENSOR_STRENGTH_ATTRIBUTE_IDS.map((attributeID) =>
      toFiniteNumber(attributes[String(attributeID)], 0)),
  );
}

function buildDeterministicTargetHint(actualPosition, itemID, deviationMeters) {
  const seed = Math.abs(toInt(itemID, 1));
  const angle = ((seed % 3600) / 3600) * Math.PI * 2;
  const vertical = (((Math.floor(seed / 3600) % 2001) - 1000) / 1000) * 0.35;
  const horizontal = Math.sqrt(Math.max(0, 1 - (vertical ** 2)));
  return [
    actualPosition[0] + (Math.cos(angle) * horizontal * deviationMeters),
    actualPosition[1] + (vertical * deviationMeters),
    actualPosition[2] + (Math.sin(angle) * horizontal * deviationMeters),
  ];
}

function buildCombatTargetSite(entity) {
  const itemID = toInt(entity && entity.itemID, 0);
  const typeID = toInt(entity && entity.typeID, 0);
  const metadata = resolveItemByTypeID(typeID) || null;
  const scanGroupID = resolveEntityScanGroup(entity, metadata);
  if (itemID <= 0 || typeID <= 0 || scanGroupID <= 0) {
    return null;
  }

  const attributes = getProbeTypeAttributes(typeID);
  const signatureRadius = Math.max(
    1,
    toFiniteNumber(
      entity && entity.signatureRadius,
      toFiniteNumber(attributes[String(ATTRIBUTE_SIGNATURE_RADIUS)],
        toFiniteNumber(metadata && metadata.radius, 1)),
    ),
  );
  const sensorStrength = Math.max(1, resolveEntitySensorStrength(entity, attributes));
  const requiredScanStrength = Math.max(0.25, (sensorStrength / signatureRadius) * 20);
  const actualPosition = [
    toFiniteNumber(entity && entity.position && entity.position.x, 0),
    toFiniteNumber(entity && entity.position && entity.position.y, 0),
    toFiniteNumber(entity && entity.position && entity.position.z, 0),
  ];
  const deviationMeters = Math.max(
    10_000,
    Math.min(149_597_870_700, requiredScanStrength * 5_000_000),
  );

  return {
    siteID: itemID,
    targetID: itemID,
    itemID,
    typeID,
    groupID: toInt(entity && entity.groupID, toInt(metadata && metadata.groupID, 0)),
    scanGroupID,
    strengthAttributeID: 0,
    difficulty: 1,
    probeTargetRequiredStrength: requiredScanStrength,
    signatureRadius,
    sensorStrength,
    deviation: deviationMeters,
    actualPosition: {
      x: actualPosition[0],
      y: actualPosition[1],
      z: actualPosition[2],
    },
    position: buildDeterministicTargetHint(actualPosition, itemID, deviationMeters),
  };
}

function listCombatTargetSites(options = {}) {
  const scene = options && options.scene;
  const ownShipID = toInt(options && options.shipID, 0);
  if (!scene) {
    return [];
  }
  return collectSceneEntities(scene)
    .filter((entity) => toInt(entity && entity.itemID, 0) !== ownShipID)
    .filter((entity) => !isEntityHiddenFromCombatProbes(entity))
    .map((entity) => buildCombatTargetSite(entity))
    .filter(Boolean)
    .sort((left, right) => toInt(left.itemID, 0) - toInt(right.itemID, 0));
}

function lerpPosition(fromPosition, toPosition, ratio) {
  const clampedRatio = Math.max(0, Math.min(1, toFiniteNumber(ratio, 0)));
  const fromVector = clonePosition(fromPosition);
  const toVector = clonePosition(toPosition, fromVector);
  return [
    fromVector[0] + ((toVector[0] - fromVector[0]) * clampedRatio),
    fromVector[1] + ((toVector[1] - fromVector[1]) * clampedRatio),
    fromVector[2] + ((toVector[2] - fromVector[2]) * clampedRatio),
  ];
}

function scoreProbeCoverage(site, probe) {
  if (!isProbeEligibleForSite(site, probe)) {
    return 0;
  }
  const actualPosition = [
    toFiniteNumber(site && site.actualPosition && site.actualPosition.x, 0),
    toFiniteNumber(site && site.actualPosition && site.actualPosition.y, 0),
    toFiniteNumber(site && site.actualPosition && site.actualPosition.z, 0),
  ];
  const probeRange = Math.max(0, toFiniteNumber(probe && probe.scanRange, 0));
  if (probeRange <= 0) {
    return 0;
  }
  const effectiveProbePosition = clonePosition(
    probe && (probe.destination || probe.pos),
    clonePosition(probe && probe.pos),
  );
  const distance = distanceBetween(actualPosition, effectiveProbePosition);
  if (distance > probeRange) {
    return 0;
  }
  const normalizedDistance = Math.max(0, Math.min(1, distance / probeRange));
  const geometryQuality = Math.max(0, 1 - (normalizedDistance ** 2));
  const strengthRatio = resolveProbeStrengthAtRange(probe) /
    resolveTargetRequiredStrength(site);
  return Math.max(0, Math.min(1, geometryQuality * Math.max(0, strengthRatio)));
}

function resolveCertainty(coverageScores = []) {
  const scores = [...coverageScores]
    .filter((score) => Number.isFinite(score) && score > 0)
    .sort((left, right) => right - left);
  if (scores.length <= 0) {
    return 0;
  }
  if (scores.length === 1) {
    return Math.min(0.249, scores[0] * 0.249);
  }
  if (scores.length === 2) {
    return Math.min(0.499, ((scores[0] + scores[1]) / 2) * 0.5);
  }
  if (scores.length === 3) {
    return Math.min(0.999, ((scores[0] + scores[1] + scores[2]) / 3) * 0.9);
  }
  const strongestFour = scores.slice(0, 4);
  const average = strongestFour.reduce((sum, score) => sum + score, 0) /
    strongestFour.length;
  return Math.max(0, Math.min(1, average * 1.2));
}

function resolveFormationGeometryQuality(coverageEntries = []) {
  const strongestFour = [...coverageEntries]
    .filter((entry) => entry && toFiniteNumber(entry.score, 0) > 0 && entry.probe)
    .sort((left, right) => toFiniteNumber(right.score, 0) - toFiniteNumber(left.score, 0))
    .slice(0, 4);
  if (strongestFour.length < 4) {
    return 1;
  }

  const normalizedSeparations = [];
  for (let leftIndex = 0; leftIndex < strongestFour.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < strongestFour.length; rightIndex += 1) {
      const leftProbe = strongestFour[leftIndex].probe;
      const rightProbe = strongestFour[rightIndex].probe;
      const averageRange = Math.max(
        1,
        (toFiniteNumber(leftProbe && leftProbe.scanRange, 0) +
          toFiniteNumber(rightProbe && rightProbe.scanRange, 0)) / 2,
      );
      normalizedSeparations.push(
        distanceBetween(
          clonePosition(leftProbe && (leftProbe.destination || leftProbe.pos)),
          clonePosition(rightProbe && (rightProbe.destination || rightProbe.pos)),
        ) / averageRange,
      );
    }
  }
  if (normalizedSeparations.length <= 0) {
    return 0;
  }
  const averageSeparation = normalizedSeparations.reduce(
    (sum, separation) => sum + separation,
    0,
  ) / normalizedSeparations.length;
  // Normal pinpoint/spread formations place probe centres comfortably more
  // than 0.2 scan radii apart.  Coincident probes therefore cannot manufacture
  // a 100% result merely by being counted four times.
  return Math.max(0, Math.min(1, averageSeparation / 0.2));
}

function buildResultPosition(site, certainty) {
  const actualPosition = [
    toFiniteNumber(site && site.actualPosition && site.actualPosition.x, 0),
    toFiniteNumber(site && site.actualPosition && site.actualPosition.y, 0),
    toFiniteNumber(site && site.actualPosition && site.actualPosition.z, 0),
  ];
  if (toFiniteNumber(certainty, 0) >= PROBE_RESULT_PERFECT) {
    return actualPosition;
  }

  const hintedPosition = clonePosition(site && site.position, actualPosition);
  const blendRatio = Math.max(
    0,
    Math.min(1, (toFiniteNumber(certainty, 0) - PROBE_RESULT_UNUSABLE) / (PROBE_RESULT_PERFECT - PROBE_RESULT_UNUSABLE)),
  );
  return lerpPosition(hintedPosition, actualPosition, blendRatio);
}

function buildResultDeviation(site, certainty, resolvedPosition, scanBonuses = null) {
  const actualPosition = [
    toFiniteNumber(site && site.actualPosition && site.actualPosition.x, 0),
    toFiniteNumber(site && site.actualPosition && site.actualPosition.y, 0),
    toFiniteNumber(site && site.actualPosition && site.actualPosition.z, 0),
  ];
  if (toFiniteNumber(certainty, 0) >= PROBE_RESULT_PERFECT) {
    return 0;
  }

  const siteDeviation = Math.max(
    1,
    toFiniteNumber(site && site.deviation, 1) *
      resolveScanBonusMultiplier(scanBonuses, "deviation"),
  );
  const positionalError = distanceBetween(actualPosition, resolvedPosition);
  return Math.max(
    1,
    Math.min(
      siteDeviation,
      positionalError > 0
        ? positionalError
        : siteDeviation * (1 - Math.max(0, Math.min(1, toFiniteNumber(certainty, 0)))),
    ),
  );
}

function resolveResultID(site) {
  const rawTargetID = site && site.targetID;
  if (typeof rawTargetID === "number" || typeof rawTargetID === "bigint") {
    const numericTargetID = toInt(rawTargetID, 0);
    if (numericTargetID > 0) {
      return numericTargetID;
    }
  }
  const targetID = String(rawTargetID || "").trim().toUpperCase();
  if (targetID) {
    return targetID;
  }
  return toInt(site && site.siteID, 0);
}

function buildScanResultEntry(site, certainty, options = {}) {
  const actualPosition = [
    toFiniteNumber(site && site.actualPosition && site.actualPosition.x, 0),
    toFiniteNumber(site && site.actualPosition && site.actualPosition.y, 0),
    toFiniteNumber(site && site.actualPosition && site.actualPosition.z, 0),
  ];
  const resolvedPosition = buildResultPosition(site, certainty);
  const deviationMeters = buildResultDeviation(
    site,
    certainty,
    resolvedPosition,
    options.scanBonuses,
  );
  const isPerfect = toFiniteNumber(certainty, 0) >= PROBE_RESULT_PERFECT;
  return buildKeyVal([
    ["id", resolveResultID(site)],
    ["scanGroupID", toInt(site && site.scanGroupID, PROBE_SCAN_GROUP_SIGNATURES)],
    ["groupID", toInt(site && site.groupID, GROUP_COSMIC_SIGNATURE)],
    ["typeID", site && site.typeID == null ? null : toInt(site && site.typeID, 0)],
    ["strengthAttributeID", toInt(site && site.strengthAttributeID, ATTRIBUTE_SCAN_WORMHOLE_STRENGTH)],
    ["dungeonID", site && site.dungeonID == null ? null : site.dungeonID],
    ["dungeonNameID", site && site.dungeonNameID == null ? null : site.dungeonNameID],
    ["archetypeID", site && site.archetypeID == null ? null : site.archetypeID],
    ["factionID", site && site.factionID == null ? null : site.factionID],
    ["itemID", site && site.itemID == null ? null : site.itemID],
    ["difficulty", Math.max(1, toInt(site && site.difficulty, 1))],
    ["certainty", Math.max(0, Math.min(1, toFiniteNumber(certainty, 0)))],
    [
      "data",
      isPerfect
        ? buildMarshalRealVectorList(actualPosition)
        : buildMarshalReal(deviationMeters, deviationMeters),
    ],
    [
      "pos",
      buildMarshalRealVectorList(isPerfect ? actualPosition : resolvedPosition),
    ],
  ]);
}

function buildResolvedSignatureScanResults(systemID, options = {}) {
  const sites = signatureRuntime.listSystemSignatureSites(systemID, options);
  return {
    durationMs: Math.max(
      1,
      toInt(options.durationMs, DEFAULT_PROBE_SCAN_DURATION_MS),
    ),
    probes: new Map(),
    probeIDs: [],
    results: sites.map((site) => buildScanResultEntry(site, 1, {
      scanBonuses: options.scanBonuses,
    })),
    absentTargets: [],
  };
}

function applyScanBonusesToProbeMap(probeMap, scanBonuses = null) {
  const normalizedScanBonuses = normalizeScanBonuses(scanBonuses);
  if (!hasAnyScanBonus(normalizedScanBonuses)) {
    return probeMap;
  }
  return new Map(
    [...probeMap.entries()].map(([probeID, probe]) => [
      probeID,
      {
        ...probe,
        scanBonuses: mergeScanBonuses(probe && probe.scanBonuses, normalizedScanBonuses),
      },
    ]),
  );
}

function resolveResultScanBonuses(probeMap, scanBonuses = null) {
  const normalizedScanBonuses = normalizeScanBonuses(scanBonuses);
  if (hasAnyScanBonus(normalizedScanBonuses)) {
    return normalizedScanBonuses;
  }
  for (const probe of probeMap.values()) {
    if (hasAnyScanBonus(probe && probe.scanBonuses)) {
      return normalizeScanBonuses(probe.scanBonuses);
    }
  }
  return normalizedScanBonuses;
}

function buildSignatureScanResults(systemID, rawProbes, options = {}) {
  const probeMap = applyScanBonusesToProbeMap(
    normalizeProbeMap(rawProbes),
    options.scanBonuses,
  );
  const resultScanBonuses = resolveResultScanBonuses(probeMap, options.scanBonuses);
  const signatureSites = signatureRuntime.listSystemSignatureSites(systemID, options);
  const hasCombatScannerProbe = [...probeMap.values()].some((probe) =>
    isCombatScannerProbe(probe));
  const sites = hasCombatScannerProbe
    ? [...signatureSites, ...listCombatTargetSites(options)]
    : signatureSites;
  const results = [];
  const absentTargets = [];
  const perfectSignatureIDs = [];

  for (const site of sites) {
    const coverageEntries = [...probeMap.values()]
      .map((probe) => ({ probe, score: scoreProbeCoverage(site, probe) }))
      .filter((entry) => entry.score > 0);
    const coverageScores = coverageEntries.map((entry) => entry.score);
    const certainty = resolveCertainty(coverageScores) *
      resolveFormationGeometryQuality(coverageEntries);
    if (certainty <= 0) {
      absentTargets.push(resolveResultID(site));
      continue;
    }
    if (toFiniteNumber(certainty, 0) >= PROBE_RESULT_PERFECT) {
      perfectSignatureIDs.push(resolveResultID(site));
    }
    results.push(buildScanResultEntry(site, certainty, {
      scanBonuses: resultScanBonuses,
    }));
  }

  return {
    durationMs: Math.max(
      1,
      toInt(options.durationMs, DEFAULT_PROBE_SCAN_DURATION_MS),
    ),
    probes: probeMap,
    probeIDs: [...probeMap.keys()],
    results,
    absentTargets,
    perfectSignatureIDs,
  };
}

module.exports = {
  ATTRIBUTE_SCAN_WORMHOLE_STRENGTH,
  DEFAULT_PROBE_SCAN_DURATION_MS,
  DEFAULT_PROBE_EXPIRY_SECONDS,
  GROUP_COSMIC_SIGNATURE,
  PROBE_SCAN_GROUP_SIGNATURES,
  buildProbeDict,
  buildProbeKeyVal,
  buildResolvedSignatureScanResults,
  buildScanResultEntry,
  buildSignatureScanResults,
  normalizeProbeMap,
  normalizeProbePatchMap,
  resolveResultID,
  _testing: {
    buildCombatTargetSite,
    isCombatScannerProbe,
    isProbeEligibleForSite,
    listCombatTargetSites,
    mergeScanBonuses,
    normalizeScanBonuses,
    resolveCertainty,
    resolveFormationGeometryQuality,
    resolveProbeStrengthAtRange,
    resolveScanBonusMultiplier,
    resolveTargetRequiredStrength,
    scoreProbeCoverage,
  },
};
