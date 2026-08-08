const DEFAULT_MAX_SCENERY_PROPS = 48;
const DEFAULT_PATTERN_RING_RADIUS_METERS = 140_000;
const DEFAULT_PATTERN_RING_STEP_METERS = 140_000;
const DEFAULT_PATTERN_SLOTS_PER_RING = 6;
const DEFAULT_WARP_CLEARANCE_METERS = 25_000;

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function toFiniteNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function cloneVector(value) {
  return {
    x: toFiniteNumber(value && value.x, 0),
    y: toFiniteNumber(value && value.y, 0),
    z: toFiniteNumber(value && value.z, 0),
  };
}

function addVectors(left, right) {
  return {
    x: toFiniteNumber(left && left.x, 0) + toFiniteNumber(right && right.x, 0),
    y: toFiniteNumber(left && left.y, 0) + toFiniteNumber(right && right.y, 0),
    z: toFiniteNumber(left && left.z, 0) + toFiniteNumber(right && right.z, 0),
  };
}

function rotateVectorAroundY(vector, yawDegrees) {
  const yawRadians = toFiniteNumber(yawDegrees, 0) * (Math.PI / 180);
  const cosine = Math.cos(yawRadians);
  const sine = Math.sin(yawRadians);
  const resolved = cloneVector(vector);
  return {
    x: (resolved.x * cosine) - (resolved.z * sine),
    y: resolved.y,
    z: (resolved.x * sine) + (resolved.z * cosine),
  };
}

function distanceFromOrigin(vector) {
  const resolved = cloneVector(vector);
  return Math.hypot(resolved.x, resolved.y, resolved.z);
}

function hash32(value) {
  let hash = 0x811c9dc5;
  for (const character of String(value)) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function deterministicCount(seed, minimum, maximum) {
  const min = Math.max(0, toInt(minimum, 0));
  const max = Math.max(min, toInt(maximum, min));
  return min + (hash32(`${seed}:count`) % ((max - min) + 1));
}

function buildPatternTransform(siteID, source, patternIndex, options = {}) {
  const slotsPerRing = Math.max(
    3,
    Math.min(12, toInt(options.patternSlotsPerRing, DEFAULT_PATTERN_SLOTS_PER_RING)),
  );
  const baseRadius = Math.max(
    50_000,
    toFiniteNumber(options.patternRingRadiusMeters, DEFAULT_PATTERN_RING_RADIUS_METERS),
  );
  const ringStep = Math.max(
    50_000,
    toFiniteNumber(options.patternRingStepMeters, DEFAULT_PATTERN_RING_STEP_METERS),
  );
  const resolvedPatternIndex = Math.max(0, toInt(patternIndex, 0));
  const ringIndex = Math.floor(resolvedPatternIndex / slotsPerRing);
  const slotIndex = resolvedPatternIndex % slotsPerRing;
  const seed = [
    siteID,
    source && source.patternKind,
    source && source.dungeonID,
    source && source.occurrenceIndex,
    resolvedPatternIndex,
  ].join(":");
  const baseAngle = (hash32(`${siteID}:pattern-base-angle`) / 0x100000000) * Math.PI * 2;
  const angleJitter = (
    (hash32(`${seed}:angle-jitter`) / 0x100000000) - 0.5
  ) * (Math.PI / 9);
  const angle = baseAngle +
    (slotIndex * ((Math.PI * 2) / slotsPerRing)) +
    (ringIndex * (Math.PI / slotsPerRing)) +
    angleJitter;
  const nominalRadius = baseRadius + (ringIndex * ringStep);
  const radiusJitter = (
    (hash32(`${seed}:radius-jitter`) / 0x100000000) - 0.5
  ) * Math.min(40_000, nominalRadius * 0.2);
  const verticalOffset = (
    (hash32(`${seed}:vertical-offset`) / 0x100000000) - 0.5
  ) * 40_000;

  return {
    patternIndex: resolvedPatternIndex,
    positionOffset: {
      x: Math.cos(angle) * (nominalRadius + radiusJitter),
      y: verticalOffset,
      z: Math.sin(angle) * (nominalRadius + radiusJitter),
    },
    yawDegrees: (hash32(`${seed}:yaw`) / 0x100000000) * 360,
  };
}

function normalizePattern(pattern) {
  const dungeonID = Math.max(0, toInt(pattern && pattern.dungeonID, 0));
  const minOccurrences = Math.max(0, toInt(pattern && pattern.minOccurrences, 0));
  const maxOccurrences = Math.max(
    minOccurrences,
    toInt(pattern && pattern.maxOccurrences, minOccurrences),
  );
  return {
    dungeonID,
    minOccurrences,
    maxOccurrences,
    weight: Math.max(0, toFiniteNumber(pattern && pattern.weight, 0)),
  };
}

function selectPatternOccurrences(patterns, minimum, maximum, seed) {
  const normalized = (Array.isArray(patterns) ? patterns : [])
    .map(normalizePattern)
    .filter((pattern) => pattern.dungeonID > 0 && pattern.maxOccurrences > 0);
  const selected = [];
  const remainingByDungeonID = new Map();

  for (const pattern of normalized) {
    for (let index = 0; index < pattern.minOccurrences; index += 1) {
      selected.push({ ...pattern, occurrenceIndex: index });
    }
    remainingByDungeonID.set(
      pattern.dungeonID,
      pattern.maxOccurrences - pattern.minOccurrences,
    );
  }

  const capacity = normalized.reduce((sum, pattern) => sum + pattern.maxOccurrences, 0);
  const lowerBound = Math.min(capacity, Math.max(selected.length, toInt(minimum, 0)));
  const upperBound = Math.min(
    capacity,
    Math.max(lowerBound, toInt(maximum, lowerBound)),
  );
  const targetCount = deterministicCount(seed, lowerBound, upperBound);

  while (selected.length < targetCount) {
    const candidates = normalized.filter(
      (pattern) => (remainingByDungeonID.get(pattern.dungeonID) || 0) > 0,
    );
    if (candidates.length === 0) {
      break;
    }
    const totalWeight = candidates.reduce(
      (sum, pattern) => sum + (pattern.weight > 0 ? pattern.weight : 1),
      0,
    );
    let cursor = (
      hash32(`${seed}:pick:${selected.length}`) / 0x100000000
    ) * totalWeight;
    let selectedPattern = candidates.at(-1);
    for (const candidate of candidates) {
      cursor -= candidate.weight > 0 ? candidate.weight : 1;
      if (cursor <= 0) {
        selectedPattern = candidate;
        break;
      }
    }
    const occurrenceIndex = selectedPattern.maxOccurrences -
      (remainingByDungeonID.get(selectedPattern.dungeonID) || 0);
    selected.push({ ...selectedPattern, occurrenceIndex });
    remainingByDungeonID.set(
      selectedPattern.dungeonID,
      (remainingByDungeonID.get(selectedPattern.dungeonID) || 0) - 1,
    );
  }

  return selected;
}

function flattenDungeonObjects(dungeon, source) {
  const flattened = [];
  const sourceTransform = source && source.transform && typeof source.transform === "object"
    ? source.transform
    : { patternIndex: -1, positionOffset: { x: 0, y: 0, z: 0 }, yawDegrees: 0 };
  for (const room of Array.isArray(dungeon && dungeon.rooms) ? dungeon.rooms : []) {
    const roomPosition = cloneVector(room && room.position);
    for (const object of Array.isArray(room && room.objects) ? room.objects : []) {
      const localPosition = addVectors(roomPosition, cloneVector(object && object.position));
      flattened.push({
        ...object,
        dungeonID: toInt(dungeon && (dungeon.dungeonID ?? dungeon._key), 0),
        occurrenceIndex: toInt(source && source.occurrenceIndex, 0),
        patternKind: String(source && source.patternKind || "entry"),
        patternIndex: toInt(sourceTransform.patternIndex, -1),
        positionOffset: addVectors(
          cloneVector(sourceTransform.positionOffset),
          rotateVectorAroundY(localPosition, sourceTransform.yawDegrees),
        ),
        roomID: toInt(object && object.roomID, toInt(room && room.roomID, 0)),
        sourcePositionOffset: cloneVector(sourceTransform.positionOffset),
        sourceYawDegrees: toFiniteNumber(sourceTransform.yawDegrees, 0),
      });
    }
  }
  return flattened;
}

function scoreObject(siteID, object) {
  return hash32([
    siteID,
    object.patternKind,
    object.dungeonID,
    object.occurrenceIndex,
    object.roomID,
    object.objectID,
  ].join(":"));
}

function selectSceneryObjects(siteID, sources, maxSceneryProps, warpClearanceMeters) {
  const entrySource = sources.find((source) => source.patternKind === "entry") || null;
  const patternSources = sources.filter((source) => source.patternKind !== "entry");
  const entryObjects = entrySource
    ? flattenDungeonObjects(entrySource.dungeon, entrySource).filter((object) => (
        object.role === "scenery" &&
        toInt(object.objectID, 0) !== toInt(entrySource.dungeon && entrySource.dungeon.entryObjectID, 0)
      ))
    : [];
  const selected = entryObjects.slice(0, maxSceneryProps);
  const remainingCapacity = Math.max(0, maxSceneryProps - selected.length);
  if (remainingCapacity <= 0 || patternSources.length === 0) {
    return selected;
  }

  const sourceCandidates = patternSources.map((source) => (
    flattenDungeonObjects(source.dungeon, source)
      .filter((object) => (
        object.role === "scenery" &&
        distanceFromOrigin(object.positionOffset) >= warpClearanceMeters
      ))
      .sort((left, right) => scoreObject(siteID, left) - scoreObject(siteID, right))
  ));
  const quota = Math.max(1, Math.floor(remainingCapacity / sourceCandidates.length));
  const leftovers = [];

  for (const candidates of sourceCandidates) {
    const available = Math.max(0, maxSceneryProps - selected.length);
    const take = Math.min(available, quota, candidates.length);
    selected.push(...candidates.slice(0, take));
    leftovers.push(...candidates.slice(take));
  }

  leftovers.sort((left, right) => scoreObject(siteID, left) - scoreObject(siteID, right));
  selected.push(...leftovers.slice(0, Math.max(0, maxSceneryProps - selected.length)));
  return selected;
}

function buildLandscapeScenePlan(site, ecosystem, getDungeonByID, options = {}) {
  const siteID = Math.max(0, toInt(site && (site.itemID ?? site.siteID ?? site._key), 0));
  const maxSceneryProps = Math.max(
    1,
    Math.min(96, toInt(options.maxSceneryProps, DEFAULT_MAX_SCENERY_PROPS)),
  );
  const warpClearanceMeters = Math.max(
    5_000,
    toFiniteNumber(options.warpClearanceMeters, DEFAULT_WARP_CLEARANCE_METERS),
  );
  if (siteID <= 0 || !ecosystem || typeof getDungeonByID !== "function") {
    return {
      environmentProps: [],
      locators: [],
      selectedPatterns: [],
    };
  }

  const natural = selectPatternOccurrences(
    ecosystem.naturalWorldPatterns,
    ecosystem.minNaturalWorldPatterns,
    ecosystem.maxNaturalWorldPatterns,
    `${siteID}:natural`,
  ).map((pattern) => ({ ...pattern, patternKind: "natural" }));
  const broken = selectPatternOccurrences(
    ecosystem.brokenWorldPatterns,
    ecosystem.minBrokenWorldPatterns,
    ecosystem.maxBrokenWorldPatterns,
    `${siteID}:broken`,
  ).map((pattern) => ({ ...pattern, patternKind: "broken" }));
  const entryDungeonID = Math.max(
    0,
    toInt(ecosystem.entryDungeonID, toInt(site && site.dungeonID, 0)),
  );
  const sourceDefinitions = [
    ...(entryDungeonID > 0
      ? [{ dungeonID: entryDungeonID, occurrenceIndex: 0, patternKind: "entry" }]
      : []),
    ...natural,
    ...broken,
  ];
  let patternIndex = 0;
  const sources = sourceDefinitions
    .map((source) => ({ ...source, dungeon: getDungeonByID(source.dungeonID) }))
    .filter((source) => source.dungeon)
    .map((source) => {
      if (source.patternKind === "entry") {
        return {
          ...source,
          transform: {
            patternIndex: -1,
            positionOffset: { x: 0, y: 0, z: 0 },
            yawDegrees: 0,
          },
        };
      }
      const transform = buildPatternTransform(siteID, source, patternIndex, options);
      patternIndex += 1;
      return { ...source, transform };
    });
  const sceneryObjects = selectSceneryObjects(
    siteID,
    sources,
    maxSceneryProps,
    warpClearanceMeters,
  );
  const locators = sources.flatMap((source) => (
    flattenDungeonObjects(source.dungeon, source)
      .filter((object) => object.role !== "scenery")
  ));
  const environmentProps = sceneryObjects.map((object) => ({
    dunObjectID: Math.max(0, toInt(object.objectID, 0)),
    exact: true,
    key: [
      "landscape",
      object.patternKind,
      object.dungeonID,
      object.occurrenceIndex,
      object.roomID,
      object.objectID,
    ].join(":"),
    positionOffset: cloneVector(object.positionOffset),
    dunRotation: [toFiniteNumber(object.sourceYawDegrees, 0), 0, 0],
    suppressSlimGraphicID: true,
    suppressSlimName: true,
    typeID: Math.max(0, toInt(object.typeID, 0)),
  }));

  return {
    environmentProps,
    locators,
    selectedPatterns: sources.map((source) => ({
      dungeonID: source.dungeonID,
      occurrenceIndex: source.occurrenceIndex,
      patternKind: source.patternKind,
      patternIndex: toInt(source.transform && source.transform.patternIndex, -1),
      positionOffset: cloneVector(source.transform && source.transform.positionOffset),
      yawDegrees: toFiniteNumber(source.transform && source.transform.yawDegrees, 0),
    })),
  };
}

module.exports = {
  DEFAULT_MAX_SCENERY_PROPS,
  DEFAULT_PATTERN_RING_RADIUS_METERS,
  DEFAULT_PATTERN_RING_STEP_METERS,
  DEFAULT_PATTERN_SLOTS_PER_RING,
  DEFAULT_WARP_CLEARANCE_METERS,
  buildPatternTransform,
  buildLandscapeScenePlan,
  hash32,
  selectPatternOccurrences,
};
