"use strict";

const {
  DESTINY_STAMP_INTERVAL_MS,
} = require("../constants");
const {
  getCurrentDestinyStamp,
} = require("../delivery/stamps");
const {
  getEntityMapKey,
} = require("../identity/entityID");

const NATIVE_SUBWARP_MODE_NAMES = Object.freeze([
  "STOP",
  "GOTO",
  "FOLLOW",
  "ORBIT",
]);
const NATIVE_SUBWARP_MODES = {};
Object.defineProperties(NATIVE_SUBWARP_MODES, {
  [Symbol.iterator]: {
    value() {
      return NATIVE_SUBWARP_MODE_NAMES.values();
    },
  },
  [Symbol.toStringTag]: { value: "Set" },
  entries: {
    value: function* entries() {
      for (const mode of NATIVE_SUBWARP_MODE_NAMES) {
        yield [mode, mode];
      }
    },
  },
  forEach: {
    value(callback, thisArg) {
      if (typeof callback !== "function") {
        throw new TypeError("callback must be a function");
      }
      for (const mode of NATIVE_SUBWARP_MODE_NAMES) {
        callback.call(thisArg, mode, mode, NATIVE_SUBWARP_MODES);
      }
    },
  },
  has: {
    value(mode) {
      return NATIVE_SUBWARP_MODE_NAMES.includes(mode);
    },
  },
  keys: {
    value() {
      return NATIVE_SUBWARP_MODE_NAMES.values();
    },
  },
  size: { get: () => NATIVE_SUBWARP_MODE_NAMES.length },
  values: {
    value() {
      return NATIVE_SUBWARP_MODE_NAMES.values();
    },
  },
});
Object.freeze(NATIVE_SUBWARP_MODES);

// Ballpark::EvolveStop applies this old-orientation Y damping once before the
// ordinary friction integrator when dynamical orientation is disabled.
const CARBON_OLD_STYLE_STOP_Y_DAMPING =
  (1 - 0.07) * 0.9345794392523364485981308411215;

function createNativeSubwarpController(deps = {}) {
  const {
    applyCarbonAcceleration,
    calculateCarbonFollowPlan,
    calculateCarbonGotoThrust,
    calculateCarbonOrbitPlan,
    cloneVector,
  } = deps;
  const resolveCurrentStamp =
    typeof deps.getCurrentDestinyStamp === "function"
      ? deps.getCurrentDestinyStamp
      : getCurrentDestinyStamp;
  const nativeTickIntervalMs = Math.max(
    1,
    Number(deps.DESTINY_STAMP_INTERVAL_MS) || DESTINY_STAMP_INTERVAL_MS,
  );
  const nativeTickSeconds = nativeTickIntervalMs / 1000;

  for (const [name, dependency] of Object.entries({
    applyCarbonAcceleration,
    calculateCarbonFollowPlan,
    calculateCarbonGotoThrust,
    calculateCarbonOrbitPlan,
    cloneVector,
  })) {
    if (typeof dependency !== "function") {
      throw new TypeError(`createNativeSubwarpController requires ${name}`);
    }
  }

  function getFrameIndex(simTimeMs) {
    const numeric = Number(simTimeMs);
    return Math.floor(
      Math.max(0, Number.isFinite(numeric) ? numeric : 0) /
        nativeTickIntervalMs,
    );
  }

  function getCadenceAnchorMs(previousFrame, overrideAnchorMs) {
    const explicitAnchor = Number(overrideAnchorMs);
    if (Number.isFinite(explicitAnchor)) {
      return Math.max(0, explicitAnchor);
    }
    const carriedAnchor = Number(previousFrame && previousFrame.cadenceAnchorMs);
    if (Number.isFinite(carriedAnchor)) {
      return Math.max(0, carriedAnchor);
    }
    return 0;
  }

  function getCadenceFrameStartMs(simTimeMs, cadenceAnchorMs) {
    const numericTime = Math.max(0, Number(simTimeMs) || 0);
    const anchor = Math.max(0, Number(cadenceAnchorMs) || 0);
    if (numericTime < anchor) {
      return getFrameIndex(numericTime) * nativeTickIntervalMs;
    }
    return anchor + (
      Math.floor((numericTime - anchor) / nativeTickIntervalMs) *
        nativeTickIntervalMs
    );
  }

  function isNativeSubwarpEntity(entity) {
    const mode = String(entity && entity.mode || "").toUpperCase();
    return Boolean(
      entity &&
      String(entity.kind || "").toLowerCase() !== "missile" &&
      mode !== "MISSILE" &&
      mode !== "WARP" &&
      NATIVE_SUBWARP_MODE_NAMES.includes(mode) &&
      !entity.pendingWarp &&
      !entity.warpState &&
      entity.manualFlightActive !== true &&
      !entity.sessionlessWarpIngress,
    );
  }

  function isMissileEntity(entity) {
    return Boolean(
      entity &&
      (
        String(entity.kind || "").toLowerCase() === "missile" ||
        String(entity.mode || "").toUpperCase() === "MISSILE"
      ),
    );
  }

  function cloneMotionStateValue(value, depth = 0) {
    if (depth > 12 || value === null || typeof value !== "object") {
      return value;
    }
    if (Array.isArray(value)) {
      return value.map((entry) => cloneMotionStateValue(entry, depth + 1));
    }
    const clone = {};
    for (const [key, entry] of Object.entries(value)) {
      clone[key] = cloneMotionStateValue(entry, depth + 1);
    }
    return clone;
  }

  function motionStateValuesMatch(left, right, depth = 0) {
    if (Object.is(left, right)) {
      return true;
    }
    if (
      depth > 12 ||
      left === null ||
      right === null ||
      typeof left !== "object" ||
      typeof right !== "object" ||
      Array.isArray(left) !== Array.isArray(right)
    ) {
      return false;
    }
    if (Array.isArray(left)) {
      return left.length === right.length && left.every(
        (entry, index) => motionStateValuesMatch(
          entry,
          right[index],
          depth + 1,
        ),
      );
    }
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every((key, index) => (
        key === rightKeys[index] &&
        motionStateValuesMatch(left[key], right[key], depth + 1)
      ))
    );
  }

  function cloneSnapshotEntity(entity) {
    const snapshot = {
      ...entity,
      position: cloneVector(entity && entity.position),
      velocity: cloneVector(entity && entity.velocity),
      direction: cloneVector(entity && entity.direction),
      targetPoint: cloneVector(
        entity && entity.targetPoint,
        entity && entity.position,
      ),
    };
    for (const field of ["pendingDock", "warpState", "pendingWarp"]) {
      const state = entity && entity[field];
      if (!state || typeof state !== "object") {
        continue;
      }
      snapshot[field] = cloneMotionStateValue(state);
    }
    for (const field of ["orbitNormal", "pendingGeometryImpactPosition"]) {
      const vector = entity && entity[field];
      if (vector && typeof vector === "object") {
        snapshot[field] = cloneVector(vector);
      }
    }
    if (
      entity &&
      entity.sessionlessWarpIngress &&
      typeof entity.sessionlessWarpIngress === "object"
    ) {
      snapshot.sessionlessWarpIngress = cloneMotionStateValue(
        entity.sessionlessWarpIngress,
      );
    }
    return snapshot;
  }

  function buildAccelerationControl(mode, plan, extra = {}) {
    return Object.freeze({
      kind: "ACCELERATION",
      mode,
      acceleration: Object.freeze(cloneVector(plan && plan.acceleration)),
      targetPoint: Object.freeze(cloneVector(
        plan && (plan.gotoPoint || plan.targetPoint),
      )),
      debug: Object.freeze({
        mode,
        nativeControl: true,
        ...extra,
      }),
    });
  }

  function buildControl(entity, resolveTarget, nowMs) {
    const mode = String(entity && entity.mode || "").toUpperCase();
    if (mode === "STOP") {
      return Object.freeze({
        kind: "STOP",
        mode,
        direction: Object.freeze(cloneVector(entity && entity.direction)),
      });
    }

    if (mode === "GOTO") {
      const plan = calculateCarbonGotoThrust(
        entity,
        entity.targetPoint,
        nativeTickSeconds,
      );
      return buildAccelerationControl(mode, plan, {
        homingScale: plan.homingScale,
        nativeStepSeconds: nativeTickSeconds,
      });
    }

    const target = resolveTarget(entity.targetEntityID);
    if (!target) {
      return Object.freeze({
        kind: "MISSING_TARGET",
        mode,
        direction: Object.freeze(cloneVector(entity && entity.direction)),
        targetEntityID: getEntityMapKey(entity && entity.targetEntityID),
      });
    }

    if (mode === "FOLLOW") {
      const plan = calculateCarbonFollowPlan(
        entity,
        target,
        nativeTickSeconds,
      );
      return buildAccelerationControl(mode, plan, {
        centerDistance: plan.centerDistance,
        desiredDistance: plan.desiredDistance,
        homingScale: plan.homingScale,
        nativeStepSeconds: nativeTickSeconds,
        targetPosition: Object.freeze(cloneVector(plan.targetPosition)),
      });
    }

    const plan = calculateCarbonOrbitPlan(
      entity,
      target,
      nativeTickSeconds,
      nowMs,
    );
    return Object.freeze({
      ...buildAccelerationControl(mode, plan, {
        desiredDistance: plan.desiredDistance,
        nativeStepSeconds: nativeTickSeconds,
        targetPosition: Object.freeze(cloneVector(plan.targetPosition)),
      }),
      orbitNormal: Object.freeze(cloneVector(plan.orbitNormal)),
    });
  }

  function getDynamicEntities(scene) {
    if (scene && scene.dynamicEntities instanceof Map) {
      return [...scene.dynamicEntities.values()];
    }
    if (scene && typeof scene.getDynamicEntities === "function") {
      const entities = scene.getDynamicEntities();
      return Array.isArray(entities) ? entities : [];
    }
    return [];
  }

  function getSceneEntitiesOwner(scene) {
    return scene && scene.dynamicEntities instanceof Map
      ? scene.dynamicEntities
      : scene;
  }

  function vectorsMatch(left, right) {
    return Boolean(
      left &&
      right &&
      Number(left.x) === Number(right.x) &&
      Number(left.y) === Number(right.y) &&
      Number(left.z) === Number(right.z),
    );
  }

  function planningSeedsMatch(entity, snapshot) {
    if (!entity || !snapshot) {
      return false;
    }
    for (const field of [
      "agilitySeconds",
      "alignTime",
      "expiresAtMs",
      "followRange",
      "inertia",
      "launchedAtMs",
      "mass",
      "maxVelocity",
      "maxAccelerationTime",
      "orbitDistance",
      "orbitSign",
      "pendingGeometryImpactAtMs",
      "radius",
      "speedFraction",
    ]) {
      const entityValue = Number(entity[field]);
      const snapshotValue = Number(snapshot[field]);
      if (
        entityValue !== snapshotValue &&
        !(Number.isNaN(entityValue) && Number.isNaN(snapshotValue))
      ) {
        return false;
      }
    }
    return (
      String(entity.kind || "").toLowerCase() ===
        String(snapshot.kind || "").toLowerCase() &&
      String(entity.mode || "").toUpperCase() ===
        String(snapshot.mode || "").toUpperCase() &&
      getEntityMapKey(entity.targetEntityID) ===
        getEntityMapKey(snapshot.targetEntityID) &&
      String(entity.pendingGeometryImpactReason || "") ===
        String(snapshot.pendingGeometryImpactReason || "") &&
      Boolean(entity.pendingGeometryImpact) ===
        Boolean(snapshot.pendingGeometryImpact) &&
      motionStateValuesMatch(entity.pendingDock, snapshot.pendingDock) &&
      motionStateValuesMatch(entity.warpState, snapshot.warpState) &&
      motionStateValuesMatch(entity.pendingWarp, snapshot.pendingWarp) &&
      motionStateValuesMatch(
        entity.sessionlessWarpIngress,
        snapshot.sessionlessWarpIngress,
      ) &&
      vectorsMatch(entity.position, snapshot.position) &&
      vectorsMatch(entity.velocity, snapshot.velocity) &&
      vectorsMatch(entity.direction, snapshot.direction) &&
      vectorsMatch(entity.targetPoint, snapshot.targetPoint) &&
      motionStateValuesMatch(entity.orbitNormal, snapshot.orbitNormal) &&
      motionStateValuesMatch(
        entity.pendingGeometryImpactPosition,
        snapshot.pendingGeometryImpactPosition,
      )
    );
  }

  function isSceneIntervalPlanCurrent(plan, scene, options = {}) {
    if (
      !plan ||
      !scene ||
      plan.complete !== true ||
      plan.projectionInvalidated === true ||
      plan.sceneEntitiesOwner !== getSceneEntitiesOwner(scene) ||
      !(plan.sourceEntitiesByID instanceof Map) ||
      !(plan.freshnessSnapshotsByID instanceof Map) ||
      !(plan.startSnapshotsByID instanceof Map)
    ) {
      return false;
    }
    const shouldCompare = typeof options.shouldCompare === "function"
      ? options.shouldCompare
      : () => true;
    const dynamicEntities = getDynamicEntities(scene);
    if (dynamicEntities.length !== plan.sourceEntitiesByID.size) {
      return false;
    }
    const seenEntityKeys = new Set();
    for (const entity of dynamicEntities) {
      const entityKey = getEntityMapKey(entity && entity.itemID);
      if (
        entityKey === null ||
        seenEntityKeys.has(entityKey) ||
        plan.sourceEntitiesByID.get(entityKey) !== entity
      ) {
        return false;
      }
      seenEntityKeys.add(entityKey);
      if (
        shouldCompare(entity) &&
        !planningSeedsMatch(
          entity,
          plan.freshnessSnapshotsByID.get(entityKey),
        )
      ) {
        return false;
      }
    }
    return true;
  }

  function prepareFrame(scene, nowMs, options = {}) {
    if (!scene || typeof scene !== "object") {
      return null;
    }
    // `nowMs` is the end of the host integration interval. At an exact native
    // boundary the just-finished interval belongs to the prior behavior frame,
    // so callers provide the interval start as behaviorAtMs.
    const behaviorAtMs = Number.isFinite(Number(options.behaviorAtMs))
      ? Number(options.behaviorAtMs)
      : Number(nowMs) || 0;
    const previousFrame = options.previousFrame;
    const sceneEntitiesOwner = getSceneEntitiesOwner(scene);
    const cadenceAnchorMs = getCadenceAnchorMs(
      previousFrame && previousFrame.sceneEntitiesOwner === sceneEntitiesOwner
        ? previousFrame
        : null,
      options.cadenceAnchorMs,
    );
    const frameIndex = getFrameIndex(behaviorAtMs);
    const frameStartMs = getCadenceFrameStartMs(
      behaviorAtMs,
      cadenceAnchorMs,
    );
    const frameEndMs = frameStartMs + nativeTickIntervalMs;
    const stamp = Number(resolveCurrentStamp(behaviorAtMs)) >>> 0;
    if (
      previousFrame &&
      previousFrame.frameStartMs === frameStartMs &&
      previousFrame.frameEndMs === frameEndMs &&
      previousFrame.cadenceAnchorMs === cadenceAnchorMs &&
      previousFrame.nativeTickIntervalMs === nativeTickIntervalMs &&
      previousFrame.sceneEntitiesOwner === sceneEntitiesOwner
    ) {
      return previousFrame;
    }

    const dynamicEntities = getDynamicEntities(scene);
    const snapshotByID = new Map();
    const sourceEntitiesByID = new Map();
    for (const entity of dynamicEntities) {
      const entityKey = getEntityMapKey(entity && entity.itemID);
      if (entityKey !== null) {
        sourceEntitiesByID.set(entityKey, entity);
        snapshotByID.set(entityKey, cloneSnapshotEntity(entity));
      }
    }

    const resolveTarget = (entityID) => {
      const entityKey = getEntityMapKey(entityID);
      if (entityKey === null) {
        return null;
      }
      if (snapshotByID.has(entityKey)) {
        return snapshotByID.get(entityKey);
      }
      const liveTarget = typeof scene.getEntityByID === "function"
        ? scene.getEntityByID(entityKey)
        : null;
      if (!liveTarget) {
        return null;
      }
      const targetSnapshot = cloneSnapshotEntity(liveTarget);
      snapshotByID.set(entityKey, targetSnapshot);
      return targetSnapshot;
    };

    const controlsByID = new Map();
    for (const entity of dynamicEntities) {
      if (!isNativeSubwarpEntity(entity)) {
        continue;
      }
      const entityKey = getEntityMapKey(entity.itemID);
      const snapshotEntity = snapshotByID.get(entityKey);
      if (entityKey === null || !snapshotEntity) {
        continue;
      }
      controlsByID.set(
        entityKey,
        buildControl(snapshotEntity, resolveTarget, behaviorAtMs),
      );
    }

    return {
      stamp,
      cadenceAnchorMs,
      frameIndex,
      frameStartMs,
      frameEndMs,
      preparedAtMs: Number(nowMs) || 0,
      behaviorAtMs,
      nativeTickIntervalMs,
      nativeTickSeconds,
      sceneEntitiesOwner,
      snapshotByID,
      sourceEntitiesByID,
      controlsByID,
      consumedControlIDs: new Set(),
    };
  }

  function prepareHeldFrame(scene, nowMs, options = {}) {
    const frame = prepareFrame(scene, nowMs, options);
    if (!frame) {
      return null;
    }
    // A ball transferred from a different scene has no destination-authored
    // behavior until the destination's next native boundary. Keep the common
    // destination snapshot, but deliberately carry no executable controls.
    frame.controlsByID.clear();
    frame.consumedControlIDs.clear();
    frame.foreignSourceHeld = true;
    return frame;
  }

  function rebindFrame(frame, scene, options = {}) {
    if (!frame || !scene || typeof scene !== "object") {
      return null;
    }
    const snapshotByID = new Map();
    const sourceEntitiesByID = new Map();
    const controlsByID = new Map();
    const consumedControlIDs = new Set();
    const originalEntitiesByID =
      options.originalEntitiesByID instanceof Map
        ? options.originalEntitiesByID
        : new Map();
    const allowedDestinationByID =
      options.allowedDestinationByID instanceof Map
        ? options.allowedDestinationByID
        : null;
    const preserveSnapshots = options.preserveSnapshots === true;
    const expectedSourceSceneEntitiesOwner =
      options.expectedSourceSceneEntitiesOwner;
    const sourceSceneOwnerMatches =
      expectedSourceSceneEntitiesOwner === undefined ||
      frame.sceneEntitiesOwner === expectedSourceSceneEntitiesOwner;
    for (const entity of getDynamicEntities(scene)) {
      const entityKey = getEntityMapKey(entity && entity.itemID);
      if (entityKey === null) {
        continue;
      }
      sourceEntitiesByID.set(entityKey, entity);
      snapshotByID.set(entityKey, cloneSnapshotEntity(entity));
      const originalEntity = originalEntitiesByID.get(entityKey);
      const mayCarryControl = Boolean(
        sourceSceneOwnerMatches &&
        originalEntity &&
        frame.sourceEntitiesByID instanceof Map &&
        frame.sourceEntitiesByID.get(entityKey) === originalEntity &&
        (
          !allowedDestinationByID ||
          allowedDestinationByID.get(entityKey) === entity
        ),
      );
      if (
        preserveSnapshots &&
        mayCarryControl &&
        frame.snapshotByID instanceof Map &&
        frame.snapshotByID.has(entityKey)
      ) {
        snapshotByID.set(
          entityKey,
          cloneSnapshotEntity(frame.snapshotByID.get(entityKey)),
        );
      }
      if (
        mayCarryControl &&
        frame.controlsByID instanceof Map &&
        frame.controlsByID.has(entityKey)
      ) {
        controlsByID.set(entityKey, frame.controlsByID.get(entityKey));
      }
      if (
        mayCarryControl &&
        frame.consumedControlIDs instanceof Set &&
        frame.consumedControlIDs.has(entityKey)
      ) {
        consumedControlIDs.add(entityKey);
      }
    }
    return {
      stamp: frame.stamp,
      cadenceAnchorMs: frame.cadenceAnchorMs,
      frameIndex: frame.frameIndex,
      frameStartMs: frame.frameStartMs,
      frameEndMs: frame.frameEndMs,
      preparedAtMs: frame.preparedAtMs,
      behaviorAtMs: frame.behaviorAtMs,
      nativeTickIntervalMs: frame.nativeTickIntervalMs,
      nativeTickSeconds: frame.nativeTickSeconds,
      sceneEntitiesOwner: getSceneEntitiesOwner(scene),
      sourceSceneOwnerMatched: sourceSceneOwnerMatches,
      snapshotByID,
      sourceEntitiesByID,
      controlsByID,
      consumedControlIDs,
      projectionRebound: true,
    };
  }

  function advancePrepared(entity, frame, deltaSeconds) {
    if (!isNativeSubwarpEntity(entity) || !frame) {
      return null;
    }
    const entityKey = getEntityMapKey(entity.itemID);
    const control = entityKey === null
      ? null
      : frame.controlsByID.get(entityKey);
    if (!control || frame.sourceEntitiesByID.get(entityKey) !== entity) {
      // Balls inserted after the behavior phase starts evolve at the next
      // native boundary, independent of host-map insertion order.
      return {
        changed: false,
        nativeSubwarpHeld: true,
        nativeSubwarpStamp: frame.stamp,
      };
    }
    const resolvedDeltaSeconds = Number(deltaSeconds);
    if (
      !Number.isFinite(resolvedDeltaSeconds) ||
      resolvedDeltaSeconds <= 0
    ) {
      return {
        changed: false,
        nativeSubwarpControlled: true,
        nativeSubwarpZeroDelta: true,
        nativeSubwarpStamp: frame.stamp,
      };
    }
    const logicalMode = String(entity.mode || "").toUpperCase();
    const modeTransitionPending = control.mode !== logicalMode;

    let result;
    if (control.kind === "MISSING_TARGET") {
      const commandStillCurrent =
        control.mode === logicalMode &&
        control.targetEntityID === getEntityMapKey(entity.targetEntityID);
      if (commandStillCurrent) {
        entity.mode = "STOP";
        entity.speedFraction = 0;
        entity.targetPoint = cloneVector(entity.position);
        entity.dockingTargetID = null;
      }
      result = applyCarbonAcceleration(
        entity,
        { x: 0, y: 0, z: 0 },
        resolvedDeltaSeconds,
        { mode: control.mode, missingTarget: true },
      );
      result = {
        ...result,
        nativeSubwarpMissingTarget: true,
        nativeSubwarpMissingTargetTransitionApplied: commandStillCurrent,
      };
    } else if (control.kind === "STOP") {
      if (!frame.consumedControlIDs.has(entityKey)) {
        entity.velocity = cloneVector(entity.velocity);
        entity.velocity.y *= CARBON_OLD_STYLE_STOP_Y_DAMPING;
      }
      result = applyCarbonAcceleration(
        entity,
        { x: 0, y: 0, z: 0 },
        resolvedDeltaSeconds,
        { mode: control.mode },
      );
    } else {
      // A frozen behavior frame holds acceleration, not mutable command
      // storage, so a same-mode re-aim survives until the next boundary.
      result = applyCarbonAcceleration(
        entity,
        control.acceleration,
        resolvedDeltaSeconds,
        control.debug,
      );
    }
    frame.consumedControlIDs.add(entityKey);

    return {
      ...result,
      nativeSubwarpControlled: true,
      nativeSubwarpModeTransitionPending: modeTransitionPending,
      nativeSubwarpStamp: frame.stamp,
    };
  }

  function forgetEntity(frame, entityOrID) {
    const entityObject =
      entityOrID && typeof entityOrID === "object" ? entityOrID : null;
    const entityKey = getEntityMapKey(
      entityObject ? entityObject.itemID : entityOrID,
    );
    if (!frame || entityKey === null) {
      return false;
    }
    if (
      entityObject &&
      frame.sourceEntitiesByID.get(entityKey) !== entityObject
    ) {
      return false;
    }
    const removed = frame.controlsByID.delete(entityKey);
    frame.snapshotByID.delete(entityKey);
    frame.sourceEntitiesByID.delete(entityKey);
    frame.consumedControlIDs.delete(entityKey);
    return removed;
  }

  function clearFrame(frame) {
    if (!frame) {
      return false;
    }
    for (const collection of [
      frame.controlsByID,
      frame.snapshotByID,
      frame.sourceEntitiesByID,
      frame.consumedControlIDs,
    ]) {
      if (collection && typeof collection.clear === "function") {
        collection.clear();
      }
    }
    return true;
  }

  function getNextFrameBoundaryMs(simTimeMs, previousFrame = null) {
    const cadenceAnchorMs = getCadenceAnchorMs(previousFrame);
    return getCadenceFrameStartMs(simTimeMs, cadenceAnchorMs) +
      nativeTickIntervalMs;
  }

  function buildSceneIntervalSegments(startSimTimeMs, endSimTimeMs, options = {}) {
    const start = Math.max(0, Number(startSimTimeMs) || 0);
    const end = Math.max(start, Number(endSimTimeMs) || start);
    const maximumSegments = Math.max(
      1,
      Math.min(4096, Math.trunc(Number(options.maximumSegments) || 4096)),
    );
    const segments = [];
    let segmentStartMs = start;
    while (segmentStartMs < end - 0.000001) {
      if (segments.length >= maximumSegments) {
        return {
          complete: false,
          endSimTimeMs: segmentStartMs,
          maximumSegments,
          segments: [],
          startSimTimeMs: start,
          targetSimTimeMs: end,
        };
      }
      const segmentEndMs = Math.min(
        end,
        getNextFrameBoundaryMs(segmentStartMs, options.previousFrame),
      );
      if (!(segmentEndMs > segmentStartMs + 0.000001)) {
        return {
          complete: false,
          endSimTimeMs: segmentStartMs,
          maximumSegments,
          segments: [],
          startSimTimeMs: start,
          targetSimTimeMs: end,
        };
      }
      segments.push({
        deltaSeconds: (segmentEndMs - segmentStartMs) / 1000,
        endSimTimeMs: segmentEndMs,
        startSimTimeMs: segmentStartMs,
      });
      segmentStartMs = segmentEndMs;
    }
    return {
      complete: true,
      endSimTimeMs: end,
      maximumSegments,
      segments,
      startSimTimeMs: start,
      targetSimTimeMs: end,
    };
  }

  function recomputeRawProjectedEndpoints(options = {}) {
    const {
      advanceMovement,
      cloneEntity,
      endSimTimeMs,
      projectedDynamicEntities,
      projectedEntitiesByID,
      projectionSeedsByID,
      preservedRawMovementTargetSnapshotsBySourceID,
      rawMovementTargetSnapshotsBySourceID,
      scene,
      shouldAdvance,
      sourceEntitiesByID,
      startSnapshotsByID,
      totalDeltaSeconds,
    } = options;
    if (
      typeof advanceMovement !== "function" ||
      typeof cloneEntity !== "function" ||
      !(projectedEntitiesByID instanceof Map) ||
      !(projectedDynamicEntities instanceof Map) ||
      !(projectionSeedsByID instanceof Map) ||
      !(rawMovementTargetSnapshotsBySourceID instanceof Map) ||
      !(sourceEntitiesByID instanceof Map) ||
      !(startSnapshotsByID instanceof Map)
    ) {
      return;
    }
    const rawEntries = [...projectionSeedsByID.entries()].filter(
      ([entityKey, seedEntity]) => (
        sourceEntitiesByID.has(entityKey) &&
        !isNativeSubwarpEntity(seedEntity)
      ),
    );
    if (rawEntries.length === 0) {
      rawMovementTargetSnapshotsBySourceID.clear();
      return;
    }
    rawMovementTargetSnapshotsBySourceID.clear();

    const buildEndpointView = (entityID, endpointsByID) => {
      const entityKey = getEntityMapKey(entityID);
      if (entityKey !== null && endpointsByID.has(entityKey)) {
        const endpoint = endpointsByID.get(entityKey);
        const startSnapshot = startSnapshotsByID.get(entityKey);
        const view = cloneEntity(endpoint) || cloneSnapshotEntity(endpoint);
        if (startSnapshot) {
          view.lastMotionDebug = {
            ...(view.lastMotionDebug || {}),
            previousPosition: cloneVector(startSnapshot.position),
            previousVelocity: cloneVector(startSnapshot.velocity),
          };
        }
        return view;
      }
      const liveTarget = typeof scene.getEntityByID === "function"
        ? scene.getEntityByID(entityID)
        : null;
      return liveTarget
        ? (cloneEntity(liveTarget) || cloneSnapshotEntity(liveTarget))
        : null;
    };

    const recomputePass = (entries, endpointsByID) => {
      const replacements = new Map();
      for (const [entityKey, seedEntity] of entries) {
        const sourceEntity = sourceEntitiesByID.get(entityKey);
        const projectedEntity = cloneEntity(seedEntity) ||
          cloneSnapshotEntity(seedEntity);
        const targetSnapshotsByID = new Map();
        const preservedTargetSnapshotsByID =
          preservedRawMovementTargetSnapshotsBySourceID instanceof Map
            ? preservedRawMovementTargetSnapshotsBySourceID.get(entityKey)
            : null;
        const passScene = {
          getEntityByID(entityID) {
            const targetKey = getEntityMapKey(entityID);
            const targetSource = targetKey === null
              ? null
              : sourceEntitiesByID.get(targetKey);
            const preservedTarget =
              targetKey !== null &&
              targetSource &&
              !shouldAdvance(targetSource) &&
              preservedTargetSnapshotsByID instanceof Map &&
              preservedTargetSnapshotsByID.has(targetKey)
                ? preservedTargetSnapshotsByID.get(targetKey)
                : undefined;
            const targetView = preservedTarget !== undefined
              ? (
                  preservedTarget
                    ? (cloneEntity(preservedTarget) ||
                      cloneSnapshotEntity(preservedTarget))
                    : null
                )
              : buildEndpointView(entityID, endpointsByID);
            if (targetKey !== null && !targetSnapshotsByID.has(targetKey)) {
              targetSnapshotsByID.set(
                targetKey,
                targetView
                  ? (cloneEntity(targetView) || cloneSnapshotEntity(targetView))
                  : null,
              );
            }
            return targetView;
          },
        };
        if (sourceEntity && shouldAdvance(sourceEntity)) {
          advanceMovement(
            projectedEntity,
            passScene,
            totalDeltaSeconds,
            endSimTimeMs,
          );
        }
        rawMovementTargetSnapshotsBySourceID.set(
          entityKey,
          targetSnapshotsByID,
        );
        replacements.set(entityKey, projectedEntity);
      }
      for (const [entityKey, replacement] of replacements) {
        projectedEntitiesByID.set(entityKey, replacement);
        projectedDynamicEntities.set(entityKey, replacement);
      }
    };

    // Raw non-missile endpoints are solved together from one frozen provisional
    // endpoint map. Missiles then consume those settled endpoints plus the
    // original tick-start diagnostic source. Missile-to-missile cycles retain
    // the same deterministic provisional endpoint rather than becoming map
    // insertion-order dependent.
    recomputePass(
      rawEntries.filter(([, entity]) => !isMissileEntity(entity)),
      new Map(projectedEntitiesByID),
    );
    recomputePass(
      rawEntries.filter(([, entity]) => isMissileEntity(entity)),
      new Map(projectedEntitiesByID),
    );
  }

  function buildEndpointProjectionContext(
    scene,
    retainedProjectedEntitiesByID,
    cloneEntity,
  ) {
    const liveEntitiesByID = new Map();
    let identityConflictCount = 0;
    for (const liveEntity of getDynamicEntities(scene)) {
      const entityKey = getEntityMapKey(liveEntity && liveEntity.itemID);
      if (entityKey === null) {
        continue;
      }
      if (
        liveEntitiesByID.has(entityKey) &&
        liveEntitiesByID.get(entityKey) !== liveEntity
      ) {
        identityConflictCount += 1;
        continue;
      }
      liveEntitiesByID.set(entityKey, liveEntity);
    }

    const projectedEntitiesByID = new Map();
    for (const [entityKey, liveEntity] of liveEntitiesByID) {
      const retainedProjection = retainedProjectedEntitiesByID instanceof Map
        ? retainedProjectedEntitiesByID.get(entityKey)
        : null;
      projectedEntitiesByID.set(
        entityKey,
        retainedProjection || cloneEntity(liveEntity) ||
          cloneSnapshotEntity(liveEntity),
      );
    }
    const projectedScene = {
      dynamicEntities: projectedEntitiesByID,
      getEntityByID(entityID) {
        const entityKey = getEntityMapKey(entityID);
        if (
          entityKey !== null &&
          projectedEntitiesByID.has(entityKey)
        ) {
          return projectedEntitiesByID.get(entityKey);
        }
        const liveTarget = typeof scene.getEntityByID === "function"
          ? scene.getEntityByID(entityID)
          : null;
        return liveTarget ? cloneSnapshotEntity(liveTarget) : null;
      },
    };
    return {
      identityConflictCount,
      liveEntitiesByID,
      projectedEntitiesByID,
      projectedScene,
    };
  }

  function planSceneInterval(scene, startSimTimeMs, endSimTimeMs, options = {}) {
    const requestedStartSimTimeMs = Math.max(
      0,
      Number(startSimTimeMs) || 0,
    );
    const requestedEndSimTimeMs = Math.max(
      requestedStartSimTimeMs,
      Number(endSimTimeMs) || requestedStartSimTimeMs,
    );
    // Carbon's master Ballpark resynchronizes a batch larger than five native
    // intervals and evolves exactly the last one instead of replaying an
    // unbounded backlog.
    const resynchronized =
      Math.floor(
        (requestedEndSimTimeMs - requestedStartSimTimeMs) /
          nativeTickIntervalMs,
      ) > 5;
    const effectiveStartSimTimeMs = resynchronized
      ? Math.max(0, requestedEndSimTimeMs - nativeTickIntervalMs)
      : requestedStartSimTimeMs;
    const sceneEntitiesOwner = getSceneEntitiesOwner(scene);
    const carriedFrameOwnedByScene = Boolean(
      options.previousFrame &&
      options.previousFrame.sceneEntitiesOwner === sceneEntitiesOwner,
    );
    const interval = resynchronized
      ? {
          complete: true,
          endSimTimeMs: requestedEndSimTimeMs,
          maximumSegments: 1,
          segments: [{
            deltaSeconds:
              (requestedEndSimTimeMs - effectiveStartSimTimeMs) / 1000,
            endSimTimeMs: requestedEndSimTimeMs,
            startSimTimeMs: effectiveStartSimTimeMs,
          }],
          startSimTimeMs: effectiveStartSimTimeMs,
          targetSimTimeMs: requestedEndSimTimeMs,
        }
      : buildSceneIntervalSegments(
          effectiveStartSimTimeMs,
          requestedEndSimTimeMs,
          {
            ...options,
            previousFrame: carriedFrameOwnedByScene
              ? options.previousFrame
              : null,
          },
        );
    interval.effectiveStartSimTimeMs = effectiveStartSimTimeMs;
    interval.resynchronized = resynchronized;
    interval.skippedSimTimeMs = resynchronized
      ? Math.max(
          0,
          effectiveStartSimTimeMs - requestedStartSimTimeMs,
        )
      : 0;
    interval.startSimTimeMs = requestedStartSimTimeMs;
    const dynamicEntities = getDynamicEntities(scene);
    const sourceEntitiesByID = new Map();
    for (const entity of dynamicEntities) {
      const entityKey = getEntityMapKey(entity && entity.itemID);
      if (entityKey !== null) {
        sourceEntitiesByID.set(entityKey, entity);
      }
    }
    const recoveryFrame = () => prepareFrame(
      scene,
      interval.targetSimTimeMs,
      {
        behaviorAtMs: interval.targetSimTimeMs,
        previousFrame: null,
      },
    );
    if (!interval.complete) {
      return {
        ...interval,
        activeTickSequence: options.activeTickSequence,
        endpointFrame: recoveryFrame(),
        failureReason: "segment-cap",
        freshnessSnapshotsByID: new Map(),
        projectedEntitiesByID: new Map(),
        rawMovementTargetSnapshotsBySourceID: new Map(),
        sceneEntitiesOwner,
        startSnapshotsByID: new Map(),
        sourceEntitiesByID,
      };
    }

    const cloneEntity = typeof options.cloneEntity === "function"
      ? options.cloneEntity
      : cloneSnapshotEntity;
    const advanceMovement = typeof options.advanceMovement === "function"
      ? options.advanceMovement
      : null;
    if (!advanceMovement) {
      throw new TypeError("planSceneInterval requires advanceMovement");
    }
    const shouldAdvance = typeof options.shouldAdvance === "function"
      ? options.shouldAdvance
      : () => true;
    const shouldCarryEndpoint =
      typeof options.shouldCarryEndpoint === "function"
        ? options.shouldCarryEndpoint
        : (entity) => !entity.pendingDock;
    const projectedEntitiesByID = new Map();
    const projectedDynamicEntities = new Map();
    const projectionSeedsByID = new Map();
    const rawMovementTargetSnapshotsBySourceID = new Map();
    const freshnessSnapshotsByID = new Map();
    const startSnapshotsByID = new Map();
    let identityConflictCount = 0;
    for (const sourceEntity of dynamicEntities) {
      const entityKey = getEntityMapKey(sourceEntity && sourceEntity.itemID);
      if (entityKey === null) {
        continue;
      }
      if (
        sourceEntitiesByID.get(entityKey) !== sourceEntity ||
        projectedEntitiesByID.has(entityKey)
      ) {
        identityConflictCount += 1;
        continue;
      }
      const projectedEntity = cloneEntity(sourceEntity) ||
        cloneSnapshotEntity(sourceEntity);
      projectedEntitiesByID.set(entityKey, projectedEntity);
      projectedDynamicEntities.set(entityKey, projectedEntity);
      projectionSeedsByID.set(
        entityKey,
        cloneEntity(projectedEntity) || cloneSnapshotEntity(projectedEntity),
      );
      startSnapshotsByID.set(
        entityKey,
        cloneSnapshotEntity(sourceEntity),
      );
      freshnessSnapshotsByID.set(
        entityKey,
        cloneSnapshotEntity(sourceEntity),
      );
    }
    if (identityConflictCount > 0) {
      return {
        ...interval,
        activeTickSequence: options.activeTickSequence,
        complete: false,
        endpointFrame: null,
        failureReason: "identity-conflict",
        freshnessSnapshotsByID: new Map(),
        identityConflictCount,
        projectedEntitiesByID: new Map(),
        rawMovementTargetSnapshotsBySourceID: new Map(),
        sceneEntitiesOwner,
        segments: [],
        startSnapshotsByID: new Map(),
        sourceEntitiesByID,
      };
    }

    const projectedScene = {
      dynamicEntities: projectedDynamicEntities,
      getEntityByID(entityID) {
        const entityKey = getEntityMapKey(entityID);
        if (
          entityKey !== null &&
          projectedEntitiesByID.has(entityKey)
        ) {
          return projectedEntitiesByID.get(entityKey);
        }
        const liveTarget = typeof scene.getEntityByID === "function"
          ? scene.getEntityByID(entityID)
          : null;
        return liveTarget ? cloneSnapshotEntity(liveTarget) : null;
      },
    };
    let projectedFrame = carriedFrameOwnedByScene
      ? rebindFrame(
          options.previousFrame,
          projectedScene,
          {
            allowedDestinationByID: projectedEntitiesByID,
            expectedSourceSceneEntitiesOwner: sceneEntitiesOwner,
            originalEntitiesByID: sourceEntitiesByID,
            preserveSnapshots: true,
          },
        )
      : options.previousFrame
        ? prepareHeldFrame(
            projectedScene,
            effectiveStartSimTimeMs,
            {
              behaviorAtMs: effectiveStartSimTimeMs,
              cadenceAnchorMs: resynchronized
                ? effectiveStartSimTimeMs
                : 0,
              previousFrame: null,
            },
          )
        : null;
    const plannedSegments = [];
    for (const segment of interval.segments) {
      projectedFrame = prepareFrame(
        projectedScene,
        segment.endSimTimeMs,
        {
          behaviorAtMs: segment.startSimTimeMs,
          cadenceAnchorMs: interval.resynchronized
            ? interval.effectiveStartSimTimeMs
            : undefined,
          previousFrame: projectedFrame,
        },
      );
      const liveFrame = rebindFrame(
        projectedFrame,
        scene,
        {
          allowedDestinationByID: sourceEntitiesByID,
          expectedSourceSceneEntitiesOwner: projectedDynamicEntities,
          originalEntitiesByID: projectedEntitiesByID,
          preserveSnapshots: true,
        },
      );
      for (const [entityKey, sourceEntity] of sourceEntitiesByID) {
        if (!shouldAdvance(sourceEntity)) {
          forgetEntity(liveFrame, sourceEntity);
        }
      }
      plannedSegments.push({
        ...segment,
        frame: liveFrame,
      });

      for (const [entityKey, projectedEntity] of projectedEntitiesByID) {
        const sourceEntity = sourceEntitiesByID.get(entityKey);
        if (!sourceEntity || !shouldAdvance(sourceEntity)) {
          continue;
        }
        advancePrepared(
          projectedEntity,
          projectedFrame,
          segment.deltaSeconds,
        );
      }
      recomputeRawProjectedEndpoints({
        advanceMovement,
        cloneEntity,
        endSimTimeMs: segment.endSimTimeMs,
        projectedDynamicEntities,
        projectedEntitiesByID,
        projectionSeedsByID,
        rawMovementTargetSnapshotsBySourceID,
        scene,
        shouldAdvance,
        sourceEntitiesByID,
        startSnapshotsByID,
        totalDeltaSeconds:
          (segment.endSimTimeMs - interval.effectiveStartSimTimeMs) / 1000,
      });
    }

    const lastProjectedFrame = projectedFrame;
    projectedFrame = prepareFrame(
      projectedScene,
      interval.targetSimTimeMs,
      {
        behaviorAtMs: interval.targetSimTimeMs,
        previousFrame: projectedFrame,
      },
    );
    let endpointFrame;
    if (plannedSegments.length > 0 && projectedFrame === lastProjectedFrame) {
      endpointFrame = plannedSegments[plannedSegments.length - 1].frame;
    } else if (projectedFrame === lastProjectedFrame) {
      endpointFrame = rebindFrame(
        projectedFrame,
        scene,
        {
          allowedDestinationByID: sourceEntitiesByID,
          expectedSourceSceneEntitiesOwner: projectedDynamicEntities,
          originalEntitiesByID: projectedEntitiesByID,
          preserveSnapshots: true,
        },
      );
    } else {
      const endpointContext = buildEndpointProjectionContext(
        scene,
        projectedEntitiesByID,
        cloneEntity,
      );
      identityConflictCount += endpointContext.identityConflictCount;
      if (endpointContext.identityConflictCount > 0) {
        return {
          ...interval,
          activeTickSequence: options.activeTickSequence,
          complete: false,
          endpointFrame: null,
          failureReason: "identity-conflict",
          freshnessSnapshotsByID: new Map(),
          identityConflictCount,
          projectedEntitiesByID: new Map(),
          rawMovementTargetSnapshotsBySourceID: new Map(),
          sceneEntitiesOwner,
          segments: [],
          startSnapshotsByID: new Map(),
          sourceEntitiesByID,
        };
      }
      const endpointCadenceAnchorMs = projectedFrame.cadenceAnchorMs;
      projectedFrame = prepareFrame(
        endpointContext.projectedScene,
        interval.targetSimTimeMs,
        {
          behaviorAtMs: interval.targetSimTimeMs,
          cadenceAnchorMs: endpointCadenceAnchorMs,
          previousFrame: lastProjectedFrame,
        },
      );
      endpointFrame = rebindFrame(
        projectedFrame,
        scene,
        {
          allowedDestinationByID: endpointContext.liveEntitiesByID,
          expectedSourceSceneEntitiesOwner:
            endpointContext.projectedEntitiesByID,
          originalEntitiesByID: endpointContext.projectedEntitiesByID,
          preserveSnapshots: true,
        },
      );
      for (const sourceEntity of endpointContext.liveEntitiesByID.values()) {
        if (!shouldCarryEndpoint(sourceEntity)) {
          forgetEntity(endpointFrame, sourceEntity);
        }
      }
    }
    return {
      ...interval,
      activeTickSequence: options.activeTickSequence,
      endpointFrame,
      freshnessSnapshotsByID,
      identityConflictCount,
      projectedEntitiesByID,
      rawMovementTargetSnapshotsBySourceID,
      sceneEntitiesOwner,
      segments: plannedSegments,
      startSnapshotsByID,
      sourceEntitiesByID,
    };
  }

  function refreshSceneIntervalProjections(plan, scene, options = {}) {
    if (
      !plan ||
      plan.complete !== true ||
      !scene ||
      plan.sceneEntitiesOwner !== getSceneEntitiesOwner(scene) ||
      !(plan.sourceEntitiesByID instanceof Map) ||
      !Array.isArray(plan.segments)
    ) {
      return plan;
    }
    const cloneEntity = typeof options.cloneEntity === "function"
      ? options.cloneEntity
      : cloneSnapshotEntity;
    const advanceMovement = typeof options.advanceMovement === "function"
      ? options.advanceMovement
      : null;
    if (!advanceMovement) {
      throw new TypeError(
        "refreshSceneIntervalProjections requires advanceMovement",
      );
    }
    const shouldAdvance = typeof options.shouldAdvance === "function"
      ? options.shouldAdvance
      : () => true;
    const shouldCarryEndpoint =
      typeof options.shouldCarryEndpoint === "function"
        ? options.shouldCarryEndpoint
        : (entity) => !entity.pendingDock;
    const projectedEntitiesByID = new Map();
    const projectedDynamicEntities = new Map();
    const projectionSeedsByID = new Map();
    const preservedRawMovementTargetSnapshotsBySourceID =
      plan.rawMovementTargetSnapshotsBySourceID;
    const rawMovementTargetSnapshotsBySourceID = new Map();
    const liveEntitiesByID = new Map();
    for (const [entityKey, sourceEntity] of plan.sourceEntitiesByID) {
      const currentEntity = scene.dynamicEntities instanceof Map
        ? scene.dynamicEntities.get(entityKey)
        : sourceEntity;
      if (currentEntity !== sourceEntity) {
        continue;
      }
      const projectedEntity = cloneEntity(sourceEntity) ||
        cloneSnapshotEntity(sourceEntity);
      liveEntitiesByID.set(entityKey, sourceEntity);
      projectedEntitiesByID.set(entityKey, projectedEntity);
      projectedDynamicEntities.set(entityKey, projectedEntity);
      projectionSeedsByID.set(
        entityKey,
        cloneEntity(projectedEntity) || cloneSnapshotEntity(projectedEntity),
      );
    }
    const projectedScene = {
      dynamicEntities: projectedDynamicEntities,
      getEntityByID(entityID) {
        const entityKey = getEntityMapKey(entityID);
        if (
          entityKey !== null &&
          projectedEntitiesByID.has(entityKey)
        ) {
          return projectedEntitiesByID.get(entityKey);
        }
        if (
          entityKey !== null &&
          plan.sourceEntitiesByID.has(entityKey)
        ) {
          return null;
        }
        const liveTarget = typeof scene.getEntityByID === "function"
          ? scene.getEntityByID(entityID)
          : null;
        return liveTarget ? cloneSnapshotEntity(liveTarget) : null;
      },
    };

    let projectedFrame = null;
    for (const segment of plan.segments) {
      projectedFrame = rebindFrame(
        segment && segment.frame,
        projectedScene,
        {
          allowedDestinationByID: projectedEntitiesByID,
          expectedSourceSceneEntitiesOwner: getSceneEntitiesOwner(scene),
          originalEntitiesByID: liveEntitiesByID,
          preserveSnapshots: true,
        },
      );
      for (const [entityKey, projectedEntity] of projectedEntitiesByID) {
        const sourceEntity = liveEntitiesByID.get(entityKey);
        if (!sourceEntity || !shouldAdvance(sourceEntity)) {
          continue;
        }
        advancePrepared(
          projectedEntity,
          projectedFrame,
          segment.deltaSeconds,
        );
      }
      recomputeRawProjectedEndpoints({
        advanceMovement,
        cloneEntity,
        endSimTimeMs: segment.endSimTimeMs,
        projectedDynamicEntities,
        projectedEntitiesByID,
        projectionSeedsByID,
        preservedRawMovementTargetSnapshotsBySourceID,
        rawMovementTargetSnapshotsBySourceID,
        scene,
        shouldAdvance,
        sourceEntitiesByID: liveEntitiesByID,
        startSnapshotsByID: plan.startSnapshotsByID,
        totalDeltaSeconds:
          (segment.endSimTimeMs - plan.effectiveStartSimTimeMs) / 1000,
      });
    }

    const lastProjectedFrame = projectedFrame;
    projectedFrame = prepareFrame(
      projectedScene,
      plan.targetSimTimeMs,
      {
        behaviorAtMs: plan.targetSimTimeMs,
        previousFrame: projectedFrame,
      },
    );
    if (projectedFrame !== lastProjectedFrame) {
      const endpointContext = buildEndpointProjectionContext(
        scene,
        projectedEntitiesByID,
        cloneEntity,
      );
      if (endpointContext.identityConflictCount > 0) {
        const staleEndpointFrame = plan.endpointFrame;
        const endpointIsSegmentFrame = plan.segments.some(
          (segment) => segment && segment.frame === staleEndpointFrame,
        );
        if (staleEndpointFrame && !endpointIsSegmentFrame) {
          clearFrame(staleEndpointFrame);
        }
        plan.complete = false;
        plan.endpointFrame = null;
        plan.failureReason = "identity-conflict";
        plan.identityConflictCount =
          (Number(plan.identityConflictCount) || 0) +
          endpointContext.identityConflictCount;
        plan.projectionInvalidated = true;
        return plan;
      }
      const endpointCadenceAnchorMs = projectedFrame.cadenceAnchorMs;
      projectedFrame = prepareFrame(
        endpointContext.projectedScene,
        plan.targetSimTimeMs,
        {
          behaviorAtMs: plan.targetSimTimeMs,
          cadenceAnchorMs: endpointCadenceAnchorMs,
          previousFrame: lastProjectedFrame,
        },
      );
      const refreshedEndpointFrame = rebindFrame(
        projectedFrame,
        scene,
        {
          allowedDestinationByID: endpointContext.liveEntitiesByID,
          expectedSourceSceneEntitiesOwner:
            endpointContext.projectedEntitiesByID,
          originalEntitiesByID: endpointContext.projectedEntitiesByID,
          preserveSnapshots: true,
        },
      );
      for (const sourceEntity of endpointContext.liveEntitiesByID.values()) {
        if (!shouldCarryEndpoint(sourceEntity)) {
          forgetEntity(refreshedEndpointFrame, sourceEntity);
        }
      }
      const staleEndpointFrame = plan.endpointFrame;
      const endpointIsSegmentFrame = plan.segments.some(
        (segment) => segment && segment.frame === staleEndpointFrame,
      );
      if (staleEndpointFrame && !endpointIsSegmentFrame) {
        clearFrame(staleEndpointFrame);
      }
      plan.endpointFrame = refreshedEndpointFrame;
    }
    plan.projectedEntitiesByID = projectedEntitiesByID;
    plan.rawMovementTargetSnapshotsBySourceID =
      rawMovementTargetSnapshotsBySourceID;
    plan.freshnessSnapshotsByID = new Map(
      [...liveEntitiesByID].map(([entityKey, sourceEntity]) => [
        entityKey,
        cloneSnapshotEntity(sourceEntity),
      ]),
    );
    plan.projectionInvalidated = false;
    plan.projectionRefreshApplied = true;
    return plan;
  }

  function forgetSceneIntervalEntity(plan, entityOrID) {
    if (!plan) {
      return false;
    }
    const entityObject =
      entityOrID && typeof entityOrID === "object" ? entityOrID : null;
    const entityKey = getEntityMapKey(
      entityObject ? entityObject.itemID : entityOrID,
    );
    if (entityKey === null) {
      return false;
    }
    if (
      entityObject &&
      plan.sourceEntitiesByID instanceof Map &&
      plan.sourceEntitiesByID.get(entityKey) !== entityObject
    ) {
      return false;
    }
    let removed = false;
    const lastSegmentFrame =
      Array.isArray(plan.segments) && plan.segments.length > 0
        ? plan.segments[plan.segments.length - 1].frame
        : null;
    const detachedEndpointFrame =
      plan.endpointFrame && plan.endpointFrame !== lastSegmentFrame
        ? plan.endpointFrame
        : null;
    const frames = new Set([
      ...(Array.isArray(plan.segments)
        ? plan.segments.map((segment) => segment && segment.frame)
        : []),
      plan.endpointFrame,
    ]);
    for (const frame of frames) {
      if (frame && forgetEntity(frame, entityOrID)) {
        removed = true;
      }
    }
    if (plan.sourceEntitiesByID instanceof Map) {
      removed = plan.sourceEntitiesByID.delete(entityKey) || removed;
    }
    if (plan.projectedEntitiesByID instanceof Map) {
      plan.projectedEntitiesByID.delete(entityKey);
    }
    if (plan.startSnapshotsByID instanceof Map) {
      plan.startSnapshotsByID.delete(entityKey);
    }
    if (plan.freshnessSnapshotsByID instanceof Map) {
      plan.freshnessSnapshotsByID.delete(entityKey);
    }
    if (plan.rawMovementTargetSnapshotsBySourceID instanceof Map) {
      removed = plan.rawMovementTargetSnapshotsBySourceID.delete(entityKey) ||
        removed;
      for (const targetSnapshotsByID of
        plan.rawMovementTargetSnapshotsBySourceID.values()) {
        if (targetSnapshotsByID instanceof Map) {
          removed = targetSnapshotsByID.delete(entityKey) || removed;
        }
      }
    }
    if (detachedEndpointFrame) {
      clearFrame(detachedEndpointFrame);
      plan.endpointFrame = null;
      removed = true;
    }
    if (removed) {
      plan.projectionInvalidated = true;
    }
    return removed;
  }

  function consumeSceneIntervalEntity(plan, entity) {
    if (!isNativeSubwarpEntity(entity)) {
      // Ordinary raw lanes never owned a native control and must retain their
      // plan-level start/end metadata for later consumers. Lifecycle command,
      // relocation, and removal hooks are the sole invalidation authority;
      // this also preserves a raw-to-STOP exact-boundary endpoint control.
      return null;
    }
    if (!plan || plan.complete !== true) {
      return {
        changed: false,
        nativeSubwarpHeld: true,
        nativeSubwarpPlanIncomplete: true,
      };
    }
    const entityKey = getEntityMapKey(entity && entity.itemID);
    if (
      entityKey === null ||
      !(plan.sourceEntitiesByID instanceof Map) ||
      plan.sourceEntitiesByID.get(entityKey) !== entity
    ) {
      return {
        changed: false,
        nativeSubwarpHeld: true,
      };
    }
    const previousPosition = cloneVector(entity.position);
    const previousVelocity = cloneVector(entity.velocity);
    let aggregate = null;
    for (const segment of plan.segments) {
      const result = advancePrepared(
        entity,
        segment.frame,
        segment.deltaSeconds,
      );
      if (result === null) {
        return null;
      }
      aggregate = {
        ...(aggregate || {}),
        ...result,
        changed: Boolean((aggregate && aggregate.changed) || result.changed),
        nativeSubwarpMissingTarget: Boolean(
          (aggregate && aggregate.nativeSubwarpMissingTarget) ||
          result.nativeSubwarpMissingTarget
        ),
        nativeSubwarpMissingTargetTransitionApplied: Boolean(
          (aggregate && aggregate.nativeSubwarpMissingTargetTransitionApplied) ||
          result.nativeSubwarpMissingTargetTransitionApplied
        ),
        nativeSubwarpModeTransitionPending: Boolean(
          (aggregate && aggregate.nativeSubwarpModeTransitionPending) ||
          result.nativeSubwarpModeTransitionPending
        ),
      };
    }
    if (aggregate && entity.lastMotionDebug) {
      entity.lastMotionDebug = {
        ...entity.lastMotionDebug,
        deltaSeconds: plan.segments.reduce(
          (total, segment) => total + segment.deltaSeconds,
          0,
        ),
        positionDelta: {
          x: entity.position.x - previousPosition.x,
          y: entity.position.y - previousPosition.y,
          z: entity.position.z - previousPosition.z,
        },
        previousPosition,
        previousVelocity,
        velocityDelta: {
          x: entity.velocity.x - previousVelocity.x,
          y: entity.velocity.y - previousVelocity.y,
          z: entity.velocity.z - previousVelocity.z,
        },
      };
    }
    return aggregate || {
      changed: false,
      nativeSubwarpControlled: true,
      nativeSubwarpZeroDelta: true,
    };
  }

  function advanceSceneInterval(scene, startSimTimeMs, endSimTimeMs, options = {}) {
    const start = Math.max(0, Number(startSimTimeMs) || 0);
    const end = Math.max(start, Number(endSimTimeMs) || start);
    const resynchronized =
      Math.floor((end - start) / nativeTickIntervalMs) > 5;
    const effectiveStartSimTimeMs = resynchronized
      ? Math.max(0, end - nativeTickIntervalMs)
      : start;
    const shouldAdvance = typeof options.shouldAdvance === "function"
      ? options.shouldAdvance
      : () => true;
    const resultsByEntity = new Map();
    const carriedFrameOwnedByScene = Boolean(
      options.previousFrame &&
      options.previousFrame.sceneEntitiesOwner === getSceneEntitiesOwner(scene),
    );
    let frame = carriedFrameOwnedByScene
      ? options.previousFrame
      : options.previousFrame
        ? prepareHeldFrame(
            scene,
            effectiveStartSimTimeMs,
            {
              behaviorAtMs: effectiveStartSimTimeMs,
              cadenceAnchorMs: resynchronized
                ? effectiveStartSimTimeMs
                : 0,
              previousFrame: null,
            },
          )
        : null;
    let projectedAtMs = effectiveStartSimTimeMs;
    let segmentCount = 0;
    const maximumSegments = resynchronized
      ? 1
      : Math.max(
          1,
          Math.min(4096, Math.trunc(Number(options.maximumSegments) || 4096)),
        );

    while (
      projectedAtMs < end - 0.000001 &&
      segmentCount < maximumSegments
    ) {
      const segmentEndMs = Math.min(
        end,
        resynchronized
          ? end
          : getNextFrameBoundaryMs(projectedAtMs, frame),
      );
      if (!(segmentEndMs > projectedAtMs + 0.000001)) {
        break;
      }
      frame = prepareFrame(scene, segmentEndMs, {
        behaviorAtMs: projectedAtMs,
        cadenceAnchorMs: resynchronized
          ? effectiveStartSimTimeMs
          : undefined,
        previousFrame: frame,
      });
      const segmentSeconds = (segmentEndMs - projectedAtMs) / 1000;
      for (const entity of getDynamicEntities(scene)) {
        if (!shouldAdvance(entity)) {
          continue;
        }
        const result = advancePrepared(entity, frame, segmentSeconds);
        if (result === null) {
          continue;
        }
        const previousResult = resultsByEntity.get(entity);
        resultsByEntity.set(entity, {
          ...(previousResult || {}),
          ...result,
          changed: Boolean(
            (previousResult && previousResult.changed) || result.changed,
          ),
          nativeSubwarpModeTransitionPending: Boolean(
            (previousResult &&
              previousResult.nativeSubwarpModeTransitionPending) ||
              result.nativeSubwarpModeTransitionPending,
          ),
          nativeSubwarpMissingTarget: Boolean(
            (previousResult && previousResult.nativeSubwarpMissingTarget) ||
              result.nativeSubwarpMissingTarget,
          ),
          nativeSubwarpMissingTargetTransitionApplied: Boolean(
            (previousResult &&
              previousResult.nativeSubwarpMissingTargetTransitionApplied) ||
              result.nativeSubwarpMissingTargetTransitionApplied,
          ),
        });
      }
      projectedAtMs = segmentEndMs;
      segmentCount += 1;
    }

    const complete = projectedAtMs >= end - 0.000001;
    if (complete) {
      // Retain the zero-consumption endpoint frame when the interval lands on
      // a native boundary; inside a frame this is an identity-preserving no-op.
      frame = prepareFrame(scene, end, {
        behaviorAtMs: end,
        previousFrame: frame,
      });
    }
    return {
      complete,
      endSimTimeMs: projectedAtMs,
      effectiveStartSimTimeMs,
      frame,
      resynchronized,
      resultsByEntity,
      segmentCount,
      skippedSimTimeMs: resynchronized
        ? Math.max(0, effectiveStartSimTimeMs - start)
        : 0,
      startSimTimeMs: start,
    };
  }

  return {
    advancePrepared,
    advanceSceneInterval,
    clearFrame,
    consumeSceneIntervalEntity,
    forgetEntity,
    forgetSceneIntervalEntity,
    getNextFrameBoundaryMs,
    isNativeSubwarpEntity,
    isSceneIntervalPlanCurrent,
    planSceneInterval,
    prepareFrame,
    refreshSceneIntervalProjections,
    rebindFrame,
  };
}

module.exports = {
  CARBON_OLD_STYLE_STOP_Y_DAMPING,
  NATIVE_SUBWARP_MODES,
  createNativeSubwarpController,
};
