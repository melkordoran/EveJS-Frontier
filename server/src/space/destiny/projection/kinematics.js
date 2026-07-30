"use strict";

const {
  getEntityMapKey: getCanonicalEntityMapKey,
} = require("../identity/entityID");

const DEFAULT_MAX_PROJECTION_STEP_MS = 250;
const DEFAULT_MAX_PROJECTION_STEPS = 240;
// Projection is a synchronous read path. Keep even adversarial caller
// configuration finite while allowing focused tests to request finer steps.
const ABSOLUTE_MAX_PROJECTION_STEPS = 4_096;

function toFiniteNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function resolveMaxProjectionSteps(options = {}) {
  const authored = options.maxProjectionSteps;
  const numeric = authored === null || authored === undefined
    ? DEFAULT_MAX_PROJECTION_STEPS
    : toFiniteNumber(authored, DEFAULT_MAX_PROJECTION_STEPS);
  return Math.min(
    ABSOLUTE_MAX_PROJECTION_STEPS,
    Math.max(1, Math.trunc(numeric)),
  );
}

function resolveProjectionStepMs(deltaMs, options = {}) {
  const authoredStepMs = options.maxProjectionStepMs;
  const configuredStepMs = Math.max(
    0,
    authoredStepMs === null || authoredStepMs === undefined
      ? DEFAULT_MAX_PROJECTION_STEP_MS
      : toFiniteNumber(authoredStepMs, DEFAULT_MAX_PROJECTION_STEP_MS),
  );
  const maxSteps = resolveMaxProjectionSteps(options);
  const projectionDeltaMs = Math.max(0, toFiniteNumber(deltaMs, 0));
  return Math.max(configuredStepMs, projectionDeltaMs / maxSteps);
}

function getDefaultMovementTargetEntityIDs(entity) {
  if (
    !entity ||
    typeof entity !== "object" ||
    entity.targetEntityID === undefined ||
    entity.targetEntityID === null
  ) {
    return [];
  }
  return [entity.targetEntityID];
}

function normalizeMovementTargetEntityIDs(entity, options = {}) {
  const resolver =
    typeof options.getMovementTargetEntityIDs === "function"
      ? options.getMovementTargetEntityIDs
      : getDefaultMovementTargetEntityIDs;
  const resolved = resolver(entity);
  if (resolved === undefined || resolved === null) {
    return [];
  }
  return Array.isArray(resolved) ? resolved : [resolved];
}

function buildNativeProjectionStepEndpoints(
  baseSimTimeMs,
  targetSimTimeMs,
  stepMs,
  maxSteps,
  nativeSubwarpController,
  nativeSubwarpFrame,
) {
  const boundaries = [];
  let boundaryCursor = baseSimTimeMs;
  for (let index = 0; index < maxSteps; index += 1) {
    const boundary = Number(
      nativeSubwarpController.getNextFrameBoundaryMs(
        boundaryCursor,
        nativeSubwarpFrame,
      ),
    );
    if (
      !Number.isFinite(boundary) ||
      !(boundary > boundaryCursor + 0.000001) ||
      !(boundary < targetSimTimeMs - 0.000001)
    ) {
      break;
    }
    boundaries.push(boundary);
    boundaryCursor = boundary;
  }

  const segmentEnds = [...boundaries, targetSimTimeMs];
  const countStepsAt = (candidateStepMs) => {
    let count = 0;
    let segmentStart = baseSimTimeMs;
    for (const segmentEnd of segmentEnds) {
      count += Math.max(
        1,
        Math.ceil((segmentEnd - segmentStart) / candidateStepMs),
      );
      segmentStart = segmentEnd;
    }
    return count;
  };

  let resolvedStepMs = Math.max(stepMs, 0.000001);
  if (countStepsAt(resolvedStepMs) > maxSteps) {
    let low = resolvedStepMs;
    let high = Math.max(targetSimTimeMs - baseSimTimeMs, low);
    for (let index = 0; index < 64; index += 1) {
      const middle = low + ((high - low) / 2);
      if (countStepsAt(middle) > maxSteps) {
        low = middle;
      } else {
        high = middle;
      }
    }
    resolvedStepMs = high;
  }

  const endpoints = [];
  let segmentStart = baseSimTimeMs;
  for (const segmentEnd of segmentEnds) {
    const segmentLength = segmentEnd - segmentStart;
    const segmentSteps = Math.max(
      1,
      Math.ceil(segmentLength / resolvedStepMs),
    );
    for (let index = 1; index <= segmentSteps; index += 1) {
      endpoints.push(
        index === segmentSteps
          ? segmentEnd
          : Math.min(
              segmentEnd,
              segmentStart + (resolvedStepMs * index),
            ),
      );
    }
    segmentStart = segmentEnd;
  }

  return {
    complete: endpoints.length <= maxSteps,
    endpoints: endpoints.slice(0, maxSteps),
  };
}

function projectEntityGraphToTime(options = {}) {
  const entities = Array.isArray(options.entities)
    ? options.entities
    : options.entity
      ? [options.entity]
      : [];
  const baseSimTimeMs = Math.max(
    0,
    toFiniteNumber(options.baseSimTimeMs, 0),
  );
  const targetSimTimeMs = Math.max(
    baseSimTimeMs,
    toFiniteNumber(options.targetSimTimeMs, baseSimTimeMs),
  );
  const advanceMovement = options.advanceMovement;
  const cloneEntity = options.cloneEntity;
  const getEntityByID =
    typeof options.getEntityByID === "function"
      ? options.getEntityByID
      : options.scene && typeof options.scene.getEntityByID === "function"
        ? (entityID) => options.scene.getEntityByID(entityID)
        : () => null;
  const getEntityMapKey =
    typeof options.getEntityMapKey === "function"
      ? options.getEntityMapKey
      : getCanonicalEntityMapKey;
  const shouldAdvance =
    typeof options.shouldAdvance === "function"
      ? options.shouldAdvance
      : () => true;
  const nativeSubwarpControllerRequested = Boolean(
    options.nativeSubwarpController,
  );
  const nativeSubwarpController =
    options.nativeSubwarpController &&
    typeof options.nativeSubwarpController.prepareFrame === "function" &&
    typeof options.nativeSubwarpController.advancePrepared === "function" &&
    typeof options.nativeSubwarpController.rebindFrame === "function" &&
    typeof options.nativeSubwarpController.planSceneInterval === "function" &&
    typeof options.nativeSubwarpController.getNextFrameBoundaryMs === "function" &&
    typeof options.nativeSubwarpController.isNativeSubwarpEntity === "function"
      ? options.nativeSubwarpController
      : null;
  const authoredMaxDepth = options.maxProjectionDepth;
  const maxDepth = Math.max(0, Math.trunc(
    authoredMaxDepth === null || authoredMaxDepth === undefined
      ? 3
      : toFiniteNumber(authoredMaxDepth, 3),
  ));

  if (
    entities.length === 0 ||
    typeof advanceMovement !== "function" ||
    typeof cloneEntity !== "function"
  ) {
    return {
      entities,
      projectedByID: new Map(),
      targetSimTimeMs,
      unaddressablePlanRecordCount: 0,
    };
  }

  const projectedByID = new Map();
  const recordsByID = new Map();
  const recordsByObject = new WeakMap();
  const records = [];
  const hasEntityKey = (key) => key !== null && key !== undefined;
  let identityConflictCount = 0;

  // Discover and clone the complete bounded movement graph before advancing
  // any participant. Registering each clone first keeps FOLLOW/ORBIT cycles
  // finite, and every solver then observes one start-of-step snapshot.
  let registerEntity;
  const expandRecord = (record, depth) => {
    if (!record || depth >= record.expandedDepth) {
      return;
    }
    record.expandedDepth = depth;
    if (depth >= maxDepth) {
      return;
    }

    for (const targetEntityID of normalizeMovementTargetEntityIDs(
      record.originalEntity,
      options,
    )) {
      registerEntity(getEntityByID(targetEntityID), depth + 1);
    }
  };

  registerEntity = (entity, depth = 0) => {
    if (!entity || typeof entity !== "object" || depth > maxDepth) {
      return null;
    }

    const entityKey = getEntityMapKey(entity.itemID);
    if (hasEntityKey(entityKey) && recordsByID.has(entityKey)) {
      const record = recordsByID.get(entityKey);
      if (record.originalEntity !== entity) {
        identityConflictCount += 1;
      }
      expandRecord(record, depth);
      return record;
    }
    if (!hasEntityKey(entityKey) && recordsByObject.has(entity)) {
      const record = recordsByObject.get(entity);
      expandRecord(record, depth);
      return record;
    }

    const projectedEntity = cloneEntity(entity);
    const record = {
      expandedDepth: Number.POSITIVE_INFINITY,
      entityKey,
      originalEntity: entity,
      projectedEntity,
      shouldAdvance: shouldAdvance(projectedEntity, entity),
    };
    records.push(record);
    recordsByObject.set(entity, record);
    if (hasEntityKey(entityKey)) {
      recordsByID.set(entityKey, record);
      projectedByID.set(entityKey, projectedEntity);
    }

    expandRecord(record, depth);
    return record;
  };

  const rootRecords = entities.map((entity) => registerEntity(entity, 0));
  // Presentation may deliberately use a bounded approximation, but
  // authoritative range consumes this completeness signal and fails closed
  // whenever an existing dependency fell outside that bounded graph.
  let unresolvedDependencyCount = 0;
  for (const record of records) {
    for (const targetEntityID of normalizeMovementTargetEntityIDs(
      record.originalEntity,
      options,
    )) {
      const targetKey = getEntityMapKey(targetEntityID);
      if (hasEntityKey(targetKey) && recordsByID.has(targetKey)) {
        continue;
      }
      if (getEntityByID(targetEntityID)) {
        unresolvedDependencyCount += 1;
      }
    }
  }
  const graphComplete =
    identityConflictCount === 0 && unresolvedDependencyCount === 0;
  let nativeFrameComplete =
    !nativeSubwarpControllerRequested || Boolean(nativeSubwarpController);
  const skippedEntityCount = records.reduce(
    (count, record) => count + (record.shouldAdvance ? 0 : 1),
    0,
  );
  const activeNativeSubwarpController =
    nativeSubwarpController &&
    records.some((record) => (
      record.shouldAdvance &&
      nativeSubwarpController.isNativeSubwarpEntity(record.projectedEntity)
    ))
      ? nativeSubwarpController
      : null;
  const unaddressablePlanRecordCount = activeNativeSubwarpController
    ? records.reduce((count, record) => (
        count + (
          record.shouldAdvance &&
          !hasEntityKey(record.entityKey)
            ? 1
            : 0
        )
      ), 0)
    : 0;
  if (unaddressablePlanRecordCount > 0) {
    nativeFrameComplete = false;
  }
  const expectedNativeSubwarpSceneEntitiesOwner =
    options.nativeSubwarpSceneEntitiesOwner !== undefined
      ? options.nativeSubwarpSceneEntitiesOwner
      : (
          options.scene && options.scene.dynamicEntities instanceof Map
            ? options.scene.dynamicEntities
            : undefined
        );
  const carriedNativeSubwarpFrameOwnerMatched = Boolean(
    options.nativeSubwarpFrame &&
    (
      expectedNativeSubwarpSceneEntitiesOwner === undefined ||
      options.nativeSubwarpFrame.sceneEntitiesOwner ===
        expectedNativeSubwarpSceneEntitiesOwner
    ),
  );
  let projectedAtMs = targetSimTimeMs;
  if (
    records.some((record) => record.shouldAdvance) &&
    baseSimTimeMs < targetSimTimeMs - 0.000001
  ) {
    const totalProjectionMs = targetSimTimeMs - baseSimTimeMs;
    const maxSteps = resolveMaxProjectionSteps(options);
    projectedAtMs = baseSimTimeMs;
    const stepMs = resolveProjectionStepMs(
      totalProjectionMs,
      options,
    );
    const nativeStepPlan = activeNativeSubwarpController
      ? buildNativeProjectionStepEndpoints(
          baseSimTimeMs,
          targetSimTimeMs,
          stepMs,
          maxSteps,
          activeNativeSubwarpController,
          carriedNativeSubwarpFrameOwnerMatched
            ? options.nativeSubwarpFrame
            : null,
        )
      : null;
    const legacyStepCount = Math.min(
      maxSteps,
      Math.max(1, Math.ceil(totalProjectionMs / stepMs)),
    );
    const stepEndpoints = nativeStepPlan
      ? nativeStepPlan.endpoints
      : Array.from(
          { length: legacyStepCount },
          (_unused, index) => (
            index === legacyStepCount - 1
              ? targetSimTimeMs
              : Math.min(
                  targetSimTimeMs,
                  baseSimTimeMs + (stepMs * (index + 1)),
                )
          ),
        );
    if (nativeStepPlan && nativeStepPlan.complete !== true) {
      nativeFrameComplete = false;
    }

    const projectedDynamicEntities = new Map();
    const originalEntitiesByID = new Map();
    for (const record of records) {
      if (hasEntityKey(record.entityKey)) {
        projectedDynamicEntities.set(record.entityKey, record.projectedEntity);
        originalEntitiesByID.set(record.entityKey, record.originalEntity);
      }
    }
    const projectionFrameScene = {
      dynamicEntities: projectedDynamicEntities,
      getEntityByID(targetEntityID) {
        const targetKey = getEntityMapKey(targetEntityID);
        if (
          hasEntityKey(targetKey) &&
          projectedDynamicEntities.has(targetKey)
        ) {
          return projectedDynamicEntities.get(targetKey);
        }
        return getEntityByID(targetEntityID);
      },
    };
    let nativeSubwarpFrame = activeNativeSubwarpController
      ? carriedNativeSubwarpFrameOwnerMatched
        ? activeNativeSubwarpController.rebindFrame(
            options.nativeSubwarpFrame,
            projectionFrameScene,
            {
              expectedSourceSceneEntitiesOwner:
                expectedNativeSubwarpSceneEntitiesOwner,
              originalEntitiesByID,
            },
          )
        : options.nativeSubwarpFrame
          ? activeNativeSubwarpController.prepareFrame(
              projectionFrameScene,
              baseSimTimeMs,
              {
                behaviorAtMs: baseSimTimeMs,
                cadenceAnchorMs: 0,
                previousFrame: null,
              },
            )
          : null
      : null;
    if (
      nativeSubwarpFrame &&
      options.nativeSubwarpFrame &&
      !carriedNativeSubwarpFrameOwnerMatched
    ) {
      nativeSubwarpFrame.controlsByID.clear();
      nativeSubwarpFrame.consumedControlIDs.clear();
      nativeSubwarpFrame.foreignSourceHeld = true;
    }
    const carriedFrameSourceOwnerMatched = Boolean(
      nativeSubwarpFrame &&
      carriedNativeSubwarpFrameOwnerMatched &&
      nativeSubwarpFrame.sourceSceneOwnerMatched !== false,
    );
    const carriedFrameCoversBase = Boolean(
      carriedFrameSourceOwnerMatched &&
      Number(nativeSubwarpFrame.frameStartMs) <= baseSimTimeMs + 0.000001 &&
      Number(nativeSubwarpFrame.frameEndMs) > baseSimTimeMs + 0.000001,
    );
    const requiresCarriedFrame = Boolean(
      options.requireCarriedNativeSubwarpFrame === true &&
      records.some((record) => (
        record.shouldAdvance &&
        activeNativeSubwarpController &&
        activeNativeSubwarpController.isNativeSubwarpEntity(
          record.projectedEntity,
        )
      )),
    );
    if (requiresCarriedFrame && !carriedFrameCoversBase) {
      nativeFrameComplete = false;
    }

    if (activeNativeSubwarpController) {
      const nativeProjectionTargetMs = nativeStepPlan.complete === true
        ? targetSimTimeMs
        : nativeStepPlan.endpoints.length > 0
          ? nativeStepPlan.endpoints[nativeStepPlan.endpoints.length - 1]
          : baseSimTimeMs;
      if (nativeProjectionTargetMs > baseSimTimeMs + 0.000001) {
        const nativeIntervalPlan =
          activeNativeSubwarpController.planSceneInterval(
            projectionFrameScene,
            baseSimTimeMs,
            nativeProjectionTargetMs,
            {
              advanceMovement,
              cloneEntity,
              maximumSegments: maxSteps,
              previousFrame: nativeSubwarpFrame,
              shouldAdvance(entity) {
                const entityKey = getEntityMapKey(entity && entity.itemID);
                const record = hasEntityKey(entityKey)
                  ? recordsByID.get(entityKey)
                  : recordsByObject.get(entity);
                return Boolean(
                  record &&
                  record.projectedEntity === entity &&
                  record.shouldAdvance,
                );
              },
            },
          );
        if (
          nativeIntervalPlan.complete === true &&
          nativeIntervalPlan.projectedEntitiesByID instanceof Map
        ) {
          for (const record of records) {
            if (!hasEntityKey(record.entityKey)) {
              continue;
            }
            const plannedEntity = nativeIntervalPlan.projectedEntitiesByID.get(
              record.entityKey,
            );
            if (!plannedEntity) {
              continue;
            }
            record.projectedEntity = plannedEntity;
            projectedByID.set(record.entityKey, plannedEntity);
          }
          projectedAtMs = nativeProjectionTargetMs;
        } else {
          nativeFrameComplete = false;
        }
      }
    } else {
      for (const nextProjectedAtMs of stepEndpoints) {
        if (!(nextProjectedAtMs > projectedAtMs)) {
          continue;
        }
        const currentStepMs = nextProjectedAtMs - projectedAtMs;
        const stepSnapshotsByID = new Map();
        for (const record of records) {
          if (hasEntityKey(record.entityKey)) {
            stepSnapshotsByID.set(
              record.entityKey,
              cloneEntity(record.projectedEntity),
            );
          }
        }

        for (const record of records) {
          if (!record.shouldAdvance) {
            continue;
          }
          const stepScene = {
            getEntityByID(targetEntityID) {
              const targetKey = getEntityMapKey(targetEntityID);
              if (
                hasEntityKey(targetKey) &&
                stepSnapshotsByID.has(targetKey)
              ) {
                return stepSnapshotsByID.get(targetKey);
              }
              return getEntityByID(targetEntityID);
            },
          };
          advanceMovement(
            record.projectedEntity,
            stepScene,
            currentStepMs / 1000,
            nextProjectedAtMs,
          );
        }
        projectedAtMs = nextProjectedAtMs;
      }
    }
  }

  const timeComplete = projectedAtMs >= targetSimTimeMs - 0.000001;
  return {
    complete: graphComplete && nativeFrameComplete && timeComplete,
    entities: rootRecords.map((record, index) => (
      record ? record.projectedEntity : entities[index]
    )),
    identityConflictCount,
    nativeFrameComplete,
    projectedAtMs,
    projectedByID,
    skippedEntityCount,
    targetSimTimeMs,
    timeComplete,
    unaddressablePlanRecordCount,
    unresolvedDependencyCount,
  };
}

function projectEntityToTime(options = {}) {
  const result = projectEntityGraphToTime(options);
  return result.complete === true && result.entities.length > 0
    ? result.entities[0]
    : options.entity;
}

module.exports = {
  DEFAULT_MAX_PROJECTION_STEP_MS,
  DEFAULT_MAX_PROJECTION_STEPS,
  getDefaultMovementTargetEntityIDs,
  normalizeMovementTargetEntityIDs,
  projectEntityGraphToTime,
  projectEntityToTime,
  resolveProjectionStepMs,
};
