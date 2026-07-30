"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const { extractEntityIDsFromPayload } = require("./syncLedger");

const TRACE_SCHEMA = "evejs.spatial-flight-recorder";
const TRACE_SCHEMA_VERSION = 1;
function parseFilter(value) {
  if (value instanceof Set) {
    return new Set([...value].map((entry) => String(entry).trim()).filter(Boolean));
  }
  if (Array.isArray(value)) {
    return new Set(value.map((entry) => String(entry).trim()).filter(Boolean));
  }
  return new Set(
    String(value || "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean),
  );
}

function buildConfiguration(options = {}) {
  const requested = options.enabled === true;
  const outputPath = String(options.outputPath || "").trim();
  const scenarioId = String(options.scenarioId || "unlabeled").trim() || "unlabeled";
  const configurationError = requested && !outputPath
    ? "EVEJS_SPATIAL_TRACE_PATH is required when spatial tracing is enabled"
    : null;
  return {
    requested,
    enabled: requested && !configurationError,
    outputPath: outputPath ? path.resolve(outputPath) : null,
    scenarioId,
    scenarioFilters: parseFilter(options.scenarioFilters),
    systemFilters: parseFilter(options.systemFilters),
    sessionFilters: parseFilter(options.sessionFilters),
    entityFilters: parseFilter(options.entityFilters),
    configurationError,
  };
}

function configurationFromEnvironment() {
  return buildConfiguration({
    enabled: process.env.EVEJS_SPATIAL_TRACE === "1",
    outputPath: process.env.EVEJS_SPATIAL_TRACE_PATH,
    scenarioId: process.env.EVEJS_SPATIAL_TRACE_SCENARIO,
    scenarioFilters: process.env.EVEJS_SPATIAL_TRACE_SCENARIO_FILTER,
    systemFilters: process.env.EVEJS_SPATIAL_TRACE_SYSTEM_IDS,
    sessionFilters: process.env.EVEJS_SPATIAL_TRACE_SESSION_IDS,
    entityFilters: process.env.EVEJS_SPATIAL_TRACE_ENTITY_IDS,
  });
}

function createRuntimeState(configuration) {
  return {
    configuration,
    started: false,
    failed: false,
    failureCount: 0,
    lastError: null,
    outputFd: null,
    eventSequence: 0,
    nextGroupSequence: 1,
    nextActionSequence: 1,
    nextNotificationSequence: 1,
    nextPacketSequence: 1,
    nextDestructionSequence: 1,
    runId: typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : crypto.randomBytes(16).toString("hex"),
    relatedEntityIds: new Set(configuration.entityFilters),
    destructionBySourceEntityId: new Map(),
    destructionByReplacementEntityId: new Map(),
    lastSnapshotByEntityId: new Map(),
  };
}

let runtimeState = createRuntimeState(configurationFromEnvironment());
let notificationContextByPayload = new WeakMap();
let updateTraceContextByUpdate = new WeakMap();

function isEnabled() {
  return runtimeState.configuration.enabled === true && runtimeState.failed !== true;
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function encodeLosslessValue(value, seen = new WeakMap(), valuePath = "$") {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (Number.isNaN(value)) {
      return { $type: "Number", value: "NaN" };
    }
    if (value === Infinity) {
      return { $type: "Number", value: "Infinity" };
    }
    if (value === -Infinity) {
      return { $type: "Number", value: "-Infinity" };
    }
    if (Object.is(value, -0)) {
      return { $type: "Number", value: "-0" };
    }
    return value;
  }
  if (typeof value === "bigint") {
    return { $type: "BigInt", value: value.toString(10) };
  }
  if (value === undefined) {
    return { $type: "Undefined" };
  }
  if (typeof value === "symbol") {
    return { $type: "Symbol", value: String(value.description || "") };
  }
  if (typeof value === "function") {
    return { $type: "Function", name: String(value.name || "") };
  }
  if (Buffer.isBuffer(value)) {
    return {
      $type: "Buffer",
      encoding: "base64",
      byteLength: value.length,
      sha256: sha256(value),
      data: value.toString("base64"),
    };
  }
  if (value instanceof Date) {
    return { $type: "Date", value: value.toISOString() };
  }
  if (typeof value !== "object") {
    return { $type: "Unknown", value: String(value) };
  }
  if (seen.has(value)) {
    return { $type: "Reference", path: seen.get(value) };
  }
  seen.set(value, valuePath);
  if (Array.isArray(value)) {
    return value.map((entry, index) => (
      encodeLosslessValue(entry, seen, `${valuePath}[${index}]`)
    ));
  }
  if (value instanceof Map) {
    return {
      $type: "Map",
      entries: [...value.entries()].map(([key, entry], index) => [
        encodeLosslessValue(key, seen, `${valuePath}.entries[${index}][0]`),
        encodeLosslessValue(entry, seen, `${valuePath}.entries[${index}][1]`),
      ]),
    };
  }
  if (value instanceof Set) {
    return {
      $type: "Set",
      values: [...value].map((entry, index) => (
        encodeLosslessValue(entry, seen, `${valuePath}.values[${index}]`)
      )),
    };
  }
  if (ArrayBuffer.isView(value)) {
    const view = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    return {
      $type: value.constructor && value.constructor.name
        ? value.constructor.name
        : "ArrayBufferView",
      encoding: "base64",
      byteLength: view.length,
      sha256: sha256(view),
      data: view.toString("base64"),
    };
  }
  const normalized = {};
  for (const key of Object.keys(value)) {
    normalized[key] = encodeLosslessValue(
      value[key],
      seen,
      `${valuePath}.${key}`,
    );
  }
  return normalized;
}

function appendRecord(record) {
  if (!isEnabled()) {
    return null;
  }
  try {
    const candidateSequence = runtimeState.eventSequence + 1;
    const encoded = encodeLosslessValue({
      ...record,
      eventSequence: candidateSequence,
    });
    if (runtimeState.outputFd === null) {
      runtimeState.outputFd = fs.openSync(
        runtimeState.configuration.outputPath,
        "a",
      );
    }
    const line = Buffer.from(`${JSON.stringify(encoded)}\n`, "utf8");
    let offset = 0;
    while (offset < line.length) {
      const written = fs.writeSync(
        runtimeState.outputFd,
        line,
        offset,
        line.length - offset,
        null,
      );
      if (!Number.isSafeInteger(written) || written <= 0) {
        throw new Error("spatial trace append made no forward progress");
      }
      offset += written;
    }
    runtimeState.eventSequence = candidateSequence;
    return encoded;
  } catch (error) {
    markFailed(error);
    return null;
  }
}

function markFailed(error) {
  if (runtimeState.outputFd !== null) {
    try {
      fs.closeSync(runtimeState.outputFd);
    } catch (_closeError) {
      // The original trace failure remains authoritative and must stay fail-open.
    }
    runtimeState.outputFd = null;
  }
  runtimeState.failed = true;
  runtimeState.failureCount += 1;
  runtimeState.lastError = error && error.message
    ? String(error.message)
    : String(error);
}

function failOpen(fn, fallback) {
  return (...args) => {
    try {
      return fn(...args);
    } catch (error) {
      markFailed(error);
      return fallback;
    }
  };
}

function getSessionId(session) {
  const value = session && session.clientID;
  return Number.isFinite(Number(value)) && Number(value) > 0
    ? String(Math.trunc(Number(value)))
    : null;
}

function getShipId(session) {
  const value = session && session._space && session._space.shipID !== undefined
    ? session._space.shipID
    : session && session.shipID;
  return Number.isFinite(Number(value)) && Number(value) > 0
    ? Math.trunc(Number(value))
    : null;
}

function getSystemId(scene, session) {
  const value = scene && scene.systemID !== undefined
    ? scene.systemID
    : session && session._space && session._space.systemID !== undefined
      ? session._space.systemID
      : session && (session.solarsystemid2 || session.solarsystemid);
  return Number.isFinite(Number(value)) && Number(value) > 0
    ? Math.trunc(Number(value))
    : null;
}

function uniqueEntityIds(values) {
  return [...new Set(
    (Array.isArray(values) ? values : [values])
      .map((value) => Number(value))
      .filter((value) => Number.isSafeInteger(value) && value > 0),
  )];
}

function extractTraceEntityIds(payload) {
  const entityIds = extractEntityIDsFromPayload(payload);
  if (!Array.isArray(payload) || !Array.isArray(payload[1])) {
    return uniqueEntityIds(entityIds);
  }
  const name = payload[0];
  const args = payload[1];
  if (name === "OnSpecialFX") {
    entityIds.push(args[0], args[3]);
  } else if (name === "FollowBall" || name === "Orbit") {
    entityIds.push(args[0], args[1]);
  } else if (name === "LaunchMissile") {
    entityIds.push(args[0], args[1]);
  }
  return uniqueEntityIds(entityIds);
}

function matchesFilters({
  scene = null,
  session = null,
  entityIds = [],
  entityScoped = false,
  global = false,
} = {}) {
  if (!isEnabled()) {
    return false;
  }
  const configuration = runtimeState.configuration;
  if (
    configuration.scenarioFilters.size > 0 &&
    !configuration.scenarioFilters.has(configuration.scenarioId)
  ) {
    return false;
  }
  if (global) {
    return true;
  }
  const systemId = getSystemId(scene, session);
  if (
    configuration.systemFilters.size > 0 &&
    (systemId === null || !configuration.systemFilters.has(String(systemId)))
  ) {
    return false;
  }
  const sessionId = getSessionId(session);
  if (
    session &&
    configuration.sessionFilters.size > 0 &&
    (sessionId === null || !configuration.sessionFilters.has(sessionId))
  ) {
    return false;
  }
  if (entityScoped && configuration.entityFilters.size > 0) {
    const candidates = uniqueEntityIds(entityIds);
    if (!candidates.some((entityId) => (
      runtimeState.relatedEntityIds.has(String(entityId))
    ))) {
      return false;
    }
  }
  return true;
}

function resolveClock(scene, options = {}) {
  let simulationTimeMs = options.simulationTimeMs;
  if (simulationTimeMs === undefined && scene && typeof scene.getCurrentSimTimeMs === "function") {
    simulationTimeMs = scene.getCurrentSimTimeMs();
  }
  if (simulationTimeMs === null || !Number.isFinite(Number(simulationTimeMs))) {
    simulationTimeMs = null;
  } else {
    simulationTimeMs = Number(simulationTimeMs);
  }

  let destinyStamp = options.destinyStamp;
  if (
    destinyStamp === undefined &&
    simulationTimeMs !== null &&
    scene &&
    typeof scene.getCurrentDestinyStamp === "function"
  ) {
    destinyStamp = scene.getCurrentDestinyStamp(simulationTimeMs);
  }
  if (destinyStamp === null || !Number.isFinite(Number(destinyStamp))) {
    destinyStamp = null;
  } else {
    destinyStamp = Math.trunc(Number(destinyStamp)) >>> 0;
  }

  const tickValue = options.simulationTick !== undefined
    ? options.simulationTick
    : scene && scene._activeTickSequence;
  const simulationTick = tickValue !== null &&
    Number.isSafeInteger(Number(tickValue)) && Number(tickValue) >= 0
    ? Math.trunc(Number(tickValue))
    : null;
  return { simulationTick, simulationTimeMs, destinyStamp };
}

function observerSnapshot(session) {
  if (!session) {
    return null;
  }
  const sessionId = getSessionId(session);
  return {
    traceId: sessionId ? `session:${sessionId}` : null,
    clientId: sessionId === null ? null : Number(sessionId),
    shipId: getShipId(session),
  };
}

function emitEvent(event, {
  scene = null,
  session = null,
  entityIds = [],
  entityScoped = false,
  clock = {},
  correlation = {},
  data = {},
  global = false,
} = {}) {
  if (!matchesFilters({ scene, session, entityIds, entityScoped, global })) {
    return null;
  }
  if (!runtimeState.started && event !== "trace.started") {
    const configuration = runtimeState.configuration;
    const startedAtMs = Date.now();
    const started = appendRecord({
      schema: TRACE_SCHEMA,
      schemaVersion: TRACE_SCHEMA_VERSION,
      runId: runtimeState.runId,
      event: "trace.started",
      scenarioId: configuration.scenarioId,
      wallTimeIso: new Date(startedAtMs).toISOString(),
      wallTimeUnixMs: startedAtMs,
      monotonicNs: process.hrtime.bigint().toString(10),
      simulationTick: null,
      simulationTimeMs: null,
      destinyStamp: null,
      systemId: null,
      observer: null,
      entityIds: [],
      correlation: {},
      data: {
        outputFormat: "append-only-ndjson",
        byteDomain: "privacy-safe-destiny-notification-inner-marshal",
        filters: {
          scenarios: [...configuration.scenarioFilters],
          systems: [...configuration.systemFilters],
          sessions: [...configuration.sessionFilters],
          entities: [...configuration.entityFilters],
        },
      },
    });
    if (!started) {
      return null;
    }
    runtimeState.started = true;
  }

  const wallTimeUnixMs = Date.now();
  const resolvedClock = resolveClock(scene, clock);
  return appendRecord({
    schema: TRACE_SCHEMA,
    schemaVersion: TRACE_SCHEMA_VERSION,
    runId: runtimeState.runId,
    event: String(event),
    scenarioId: runtimeState.configuration.scenarioId,
    wallTimeIso: new Date(wallTimeUnixMs).toISOString(),
    wallTimeUnixMs,
    monotonicNs: process.hrtime.bigint().toString(10),
    simulationTick: resolvedClock.simulationTick,
    simulationTimeMs: resolvedClock.simulationTimeMs,
    destinyStamp: resolvedClock.destinyStamp,
    systemId: getSystemId(scene, session),
    observer: observerSnapshot(session),
    entityIds: uniqueEntityIds(entityIds),
    correlation,
    data,
  });
}

function copyVector(value) {
  if (!value || typeof value !== "object") {
    return value === undefined ? null : value;
  }
  const result = {};
  for (const key of ["x", "y", "z", "w"]) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      result[key] = value[key];
    }
  }
  return result;
}

function snapshotEntity(scene, entity) {
  if (!entity || typeof entity !== "object") {
    return null;
  }
  const entityId = Number(entity.itemID);
  const sceneMember = Boolean(
    scene &&
    scene.dynamicEntities instanceof Map &&
    Number.isSafeInteger(entityId) &&
    scene.dynamicEntities.get(entityId) === entity,
  );
  return {
    entityId: Number.isSafeInteger(entityId) ? entityId : entity.itemID,
    kind: entity.kind === undefined ? null : entity.kind,
    typeId: entity.typeID === undefined ? null : entity.typeID,
    position: copyVector(entity.position),
    velocity: copyVector(entity.velocity),
    direction: copyVector(entity.direction),
    heading: entity.heading && typeof entity.heading === "object"
      ? copyVector(entity.heading)
      : entity.heading === undefined ? null : entity.heading,
    targetPoint: copyVector(entity.targetPoint),
    mode: entity.mode === undefined ? null : entity.mode,
    effectStamp: entity.effectStamp === undefined ? null : entity.effectStamp,
    warpEffectStamp: entity.warpState && entity.warpState.effectStamp !== undefined
      ? entity.warpState.effectStamp
      : null,
    radius: entity.radius === undefined ? null : entity.radius,
    lifecycle: {
      alive: entity.alive === undefined ? null : entity.alive,
      moribund: entity.moribund === undefined ? null : entity.moribund,
      destroyed: entity.destroyed === undefined ? null : entity.destroyed,
      pendingRemoval: entity.pendingRemoval === undefined ? null : entity.pendingRemoval,
      destroyedAt: entity.destroyedAt === undefined ? null : entity.destroyedAt,
      sceneMember,
      derivedAlive:
        sceneMember &&
        entity.alive !== false &&
        entity.moribund !== true &&
        entity.destroyed !== true &&
        entity.pendingRemoval !== true &&
        !(Number.isFinite(Number(entity.destroyedAt)) && Number(entity.destroyedAt) > 0),
    },
    systemId: entity.systemID === undefined
      ? getSystemId(scene, null)
      : entity.systemID,
    bubbleId: entity.bubbleID === undefined ? null : entity.bubbleID,
    publicGridKey: entity.publicGridKey === undefined ? null : entity.publicGridKey,
    publicGridClusterKey: entity.publicGridClusterKey === undefined
      ? null
      : entity.publicGridClusterKey,
    launcherId: entity.launcherID === undefined ? null : entity.launcherID,
  };
}

function rememberSnapshot(entityId, snapshot) {
  const numericId = Number(entityId);
  if (Number.isSafeInteger(numericId) && numericId > 0 && snapshot) {
    runtimeState.lastSnapshotByEntityId.set(numericId, snapshot);
  }
}

function recordSimulationState(scene, simulationTimeMs) {
  if (!isEnabled() || !scene || !(scene.dynamicEntities instanceof Map)) {
    return 0;
  }
  let count = 0;
  for (const entity of scene.dynamicEntities.values()) {
    const entityId = Number(entity && entity.itemID);
    if (!matchesFilters({ scene, entityIds: [entityId], entityScoped: true })) {
      continue;
    }
    const snapshot = snapshotEntity(scene, entity);
    rememberSnapshot(entityId, snapshot);
    if (emitEvent("simulation.entity-state", {
      scene,
      entityIds: [entityId],
      entityScoped: true,
      clock: { simulationTimeMs },
      data: { snapshot },
    })) {
      count += 1;
    }
  }
  return count;
}

function getDestructionContext(entityIds) {
  for (const entityId of uniqueEntityIds(entityIds)) {
    const context = runtimeState.destructionBySourceEntityId.get(entityId) ||
      runtimeState.destructionByReplacementEntityId.get(entityId);
    if (context) {
      return context;
    }
  }
  return null;
}

function recordEntitySpawn(scene, entity, options = {}) {
  if (!isEnabled() || !scene || !entity) {
    return null;
  }
  const entityId = Number(entity.itemID);
  const parentId = Number(entity.launcherID);
  const destruction = Number.isSafeInteger(parentId)
    ? runtimeState.destructionBySourceEntityId.get(parentId) || null
    : null;
  if (destruction) {
    runtimeState.relatedEntityIds.add(String(entityId));
    runtimeState.destructionByReplacementEntityId.set(entityId, destruction);
    destruction.replacementEntityId = entityId;
  }
  const snapshot = snapshotEntity(scene, entity);
  rememberSnapshot(entityId, snapshot);
  return emitEvent(destruction ? "wreck.created" : "entity.spawned", {
    scene,
    entityIds: destruction ? [parentId, entityId] : [entityId],
    entityScoped: true,
    correlation: destruction ? { destructionId: destruction.destructionId } : {},
    data: {
      snapshot,
      broadcastRequested: options.broadcast !== false,
      replacementForEntityId: destruction ? parentId : null,
    },
  });
}

function recordWreckRecordCreated(scene, wreckRecord, details = {}) {
  if (!isEnabled() || !scene || !wreckRecord) {
    return null;
  }
  const sourceEntityId = Number(
    wreckRecord.sourceEntityID !== undefined
      ? wreckRecord.sourceEntityID
      : wreckRecord.launcherID,
  );
  const wreckEntityId = Number(
    wreckRecord.wreckID !== undefined
      ? wreckRecord.wreckID
      : wreckRecord.itemID,
  );
  if (
    !Number.isSafeInteger(sourceEntityId) || sourceEntityId <= 0 ||
    !Number.isSafeInteger(wreckEntityId) || wreckEntityId <= 0 ||
    !matchesFilters({
      scene,
      entityIds: [sourceEntityId, wreckEntityId],
      entityScoped: true,
    })
  ) {
    return null;
  }
  let destruction = runtimeState.destructionBySourceEntityId.get(sourceEntityId);
  if (!destruction) {
    destruction = {
      destructionId: `destruction:${runtimeState.nextDestructionSequence++}`,
      sourceEntityId,
      replacementEntityId: wreckEntityId,
      terminalSnapshot: null,
      wreckRecordSnapshot: null,
    };
    runtimeState.destructionBySourceEntityId.set(sourceEntityId, destruction);
  }
  destruction.replacementEntityId = wreckEntityId;
  runtimeState.relatedEntityIds.add(String(wreckEntityId));
  runtimeState.destructionByReplacementEntityId.set(wreckEntityId, destruction);
  const spatialState = wreckRecord.spaceState &&
    typeof wreckRecord.spaceState === "object"
    ? wreckRecord.spaceState
    : wreckRecord;
  const snapshot = snapshotEntity(scene, {
    itemID: wreckEntityId,
    kind: "wreck",
    typeID: wreckRecord.typeID,
    position: spatialState.position,
    velocity: spatialState.velocity,
    direction: spatialState.direction,
    heading: spatialState.heading,
    targetPoint: spatialState.targetPoint,
    mode: spatialState.mode,
    effectStamp: spatialState.effectStamp,
    radius: spatialState.radius !== undefined
      ? spatialState.radius
      : spatialState.spaceRadius,
    systemID: wreckRecord.systemID !== undefined
      ? wreckRecord.systemID
      : wreckRecord.locationID,
    launcherID: sourceEntityId,
  });
  destruction.wreckRecordSnapshot = snapshot;
  rememberSnapshot(wreckEntityId, snapshot);
  return emitEvent("wreck.record-created", {
    scene,
    entityIds: [sourceEntityId, wreckEntityId],
    entityScoped: true,
    correlation: { destructionId: destruction.destructionId },
    data: {
      sourceEntityId,
      replacementEntityId: wreckEntityId,
      persistenceKind: String(details.persistenceKind || "unspecified"),
      snapshot,
    },
  });
}

function recordTerminalState(scene, entity, options = {}) {
  if (!isEnabled() || !scene || !entity) {
    return null;
  }
  const effectId = Number(options.terminalDestructionEffectID);
  if (!Number.isSafeInteger(effectId) || effectId <= 0) {
    return null;
  }
  const entityId = Number(entity.itemID);
  if (!matchesFilters({ scene, entityIds: [entityId], entityScoped: true })) {
    return null;
  }
  const snapshot = snapshotEntity(scene, entity);
  rememberSnapshot(entityId, snapshot);
  let context = runtimeState.destructionBySourceEntityId.get(entityId);
  if (!context) {
    context = {
      destructionId: `destruction:${runtimeState.nextDestructionSequence++}`,
      sourceEntityId: entityId,
      replacementEntityId: null,
      terminalSnapshot: null,
      wreckRecordSnapshot: null,
    };
    runtimeState.destructionBySourceEntityId.set(entityId, context);
  }
  context.terminalSnapshot = snapshot;
  const destructionId = context.destructionId;
  return emitEvent("destruction.terminal-state", {
    scene,
    entityIds: [entityId],
    entityScoped: true,
    clock: {
      simulationTimeMs: options.nowMs,
      destinyStamp: options.stampOverride,
    },
    correlation: { destructionId },
    data: {
      terminalDestructionEffectId: effectId,
      snapshot,
      authoredPositionPresent: false,
    },
  });
}

function recordVisibilityEligibility(scene, session, entity, details = {}) {
  if (!isEnabled()) {
    return null;
  }
  const entityId = Number(entity && entity.itemID);
  const currentIds = session && session._space &&
    session._space.visibleDynamicEntityIDs instanceof Set
    ? session._space.visibleDynamicEntityIDs
    : null;
  return emitEvent("visibility.eligibility", {
    scene,
    session,
    entityIds: [entityId],
    entityScoped: true,
    clock: { simulationTimeMs: details.simulationTimeMs },
    data: {
      eligible: details.eligible === true
        ? true
        : details.eligible === false
          ? false
          : null,
      reason: String(details.reason || "unspecified"),
      previousMember: currentIds ? currentIds.has(entityId) : null,
      policyDetails: details.policyDetails || null,
    },
  });
}

function recordVisibilityBoundary(scene, session, entity, details = {}) {
  if (!isEnabled()) {
    return null;
  }
  const entityId = Number(entity && entity.itemID !== undefined
    ? entity.itemID
    : details.entityId);
  const previousMember = details.previousMember === true;
  const desiredMember = details.desiredMember === true;
  const transition = previousMember === desiredMember
    ? desiredMember ? "retain" : "absent"
    : desiredMember ? "acquire" : "remove";
  return emitEvent("visibility.membership", {
    scene,
    session,
    entityIds: [entityId],
    entityScoped: true,
    clock: {
      simulationTimeMs: details.simulationTimeMs,
      destinyStamp: details.destinyStamp,
    },
    data: {
      eligible: details.eligible === true
        ? true
        : details.eligible === false
          ? false
          : null,
      previousMember,
      desiredMember,
      transition,
      reason: String(details.reason || "authoritative-membership-boundary"),
      boundary: String(details.boundary || "unspecified"),
    },
  });
}

function recordVisibilityDelta(scene, session, delta, details = {}) {
  if (!isEnabled() || !delta) {
    return 0;
  }
  const currentIds = delta.currentIDs instanceof Set ? delta.currentIDs : new Set();
  const desiredIds = delta.desiredIDs instanceof Set ? delta.desiredIDs : new Set();
  const union = new Set([...currentIds, ...desiredIds]);
  let count = 0;
  for (const entityId of union) {
    const entity = scene && scene.dynamicEntities instanceof Map
      ? scene.dynamicEntities.get(entityId) || { itemID: entityId }
      : { itemID: entityId };
    if (recordVisibilityBoundary(scene, session, entity, {
      simulationTimeMs: details.simulationTimeMs,
      destinyStamp: details.destinyStamp,
      previousMember: currentIds.has(entityId),
      desiredMember: desiredIds.has(entityId),
      eligible: desiredIds.has(entityId),
      reason: desiredIds.has(entityId)
        ? "included-by-authoritative-visible-set"
        : "excluded-by-authoritative-visible-set",
      boundary: details.boundary || "dynamic-visibility-delta",
    })) {
      count += 1;
    }
  }
  return count;
}

function describeAction(payload) {
  const name = Array.isArray(payload) && typeof payload[0] === "string"
    ? payload[0]
    : "unknown";
  const args = Array.isArray(payload) && Array.isArray(payload[1])
    ? payload[1]
    : [];
  const description = {
    name,
    fields: { args },
    authoredPositionPresent: null,
  };
  if (name === "TerminalPlayDestructionEffect") {
    description.fields = {
      entityId: args[0] === undefined ? null : args[0],
      destructionEffectId: args[1] === undefined ? null : args[1],
    };
    description.authoredPositionPresent = false;
  } else if (name === "OnSpecialFX") {
    description.fields = {
      sourceEntityId: args[0] === undefined ? null : args[0],
      moduleId: args[1] === undefined ? null : args[1],
      moduleTypeId: args[2] === undefined ? null : args[2],
      targetEntityId: args[3] === undefined ? null : args[3],
      chargeTypeId: args[4] === undefined ? null : args[4],
      guid: args[5] === undefined ? null : args[5],
      offensive: args[6] === undefined ? null : args[6],
      start: args[7] === undefined ? null : args[7],
      active: args[8] === undefined ? null : args[8],
      duration: args[9] === undefined ? null : args[9],
      repeat: args[10] === undefined ? null : args[10],
      startTime: args[11] === undefined ? null : args[11],
      timeFromStart: args[12] === undefined ? null : args[12],
      graphicInfo: args[13] === undefined ? null : args[13],
    };
    description.authoredPositionPresent = false;
  } else if (name === "RemoveBalls") {
    description.fields = { entityIds: extractTraceEntityIds(payload) };
    description.authoredPositionPresent = false;
  } else if (name === "SetBallPosition") {
    description.fields = {
      entityId: args[0] === undefined ? null : args[0],
      position: { x: args[1], y: args[2], z: args[3] },
    };
    description.authoredPositionPresent = true;
  } else if (name === "AddBalls2") {
    description.fields = {
      entityIds: extractTraceEntityIds(payload),
      batches: args,
    };
    description.authoredPositionPresent = true;
  }
  return description;
}

function getAuthoritativeSnapshots(scene, entityIds) {
  return uniqueEntityIds(entityIds)
    .map((entityId) => {
      const liveEntity = scene && scene.dynamicEntities instanceof Map
        ? scene.dynamicEntities.get(entityId)
        : null;
      return liveEntity
        ? snapshotEntity(scene, liveEntity)
        : runtimeState.lastSnapshotByEntityId.get(entityId) || null;
    })
    .filter(Boolean);
}

function getUpdateTraceContext(update, session) {
  if (!update || typeof update !== "object") {
    return null;
  }
  const contexts = updateTraceContextByUpdate.get(update);
  if (!(contexts instanceof Map)) {
    return null;
  }
  return contexts.get(`${runtimeState.runId}:${getSessionId(session) || "unknown"}`) || null;
}

function recordDestinyActionAuthored(scene, session, update, details = {}) {
  if (!isEnabled() || !update || !Array.isArray(update.payload)) {
    return null;
  }
  const existingContext = getUpdateTraceContext(update, session);
  if (existingContext) {
    return existingContext;
  }
  const entityIds = extractTraceEntityIds(update.payload);
  if (!matchesFilters({
    scene,
    session,
    entityIds,
    entityScoped: runtimeState.configuration.entityFilters.size > 0,
  })) {
    return null;
  }
  const action = describeAction(update.payload);
  const destruction = getDestructionContext(entityIds);
  const context = {
    runId: runtimeState.runId,
    sessionId: getSessionId(session),
    actionId: `action:${runtimeState.nextActionSequence++}`,
    name: action.name,
    authoredStamp: Number(update.stamp) >>> 0,
    entityIds,
    destructionId: destruction ? destruction.destructionId : null,
  };
  const event = emitEvent("destiny.action.authored", {
    scene,
    session,
    entityIds,
    entityScoped: false,
    clock: {
      simulationTimeMs: details.simulationTimeMs,
      destinyStamp: context.authoredStamp,
    },
    correlation: {
      actionId: context.actionId,
      destructionId: context.destructionId,
    },
    data: {
      captureBoundary: String(
        details.captureBoundary || "sendDestinyUpdates-pre-authority",
      ),
      orderInCall: details.orderInCall,
      authoredStamp: context.authoredStamp,
      actionName: action.name,
      actionFields: action.fields,
      authoredPositionPresent: action.authoredPositionPresent,
      authoredPayload: update.payload,
      authoritativeSnapshots: getAuthoritativeSnapshots(scene, entityIds),
    },
  });
  return event ? context : null;
}

function attachDestinyUpdateContext(update, context) {
  if (!update || typeof update !== "object" || !context) {
    return update;
  }
  let contexts = updateTraceContextByUpdate.get(update);
  if (!(contexts instanceof Map)) {
    contexts = new Map();
    updateTraceContextByUpdate.set(update, contexts);
  }
  contexts.set(
    `${context.runId}:${context.sessionId || "unknown"}`,
    context,
  );
  return update;
}

function propagateDestinyUpdateContext(sourceUpdate, targetUpdate, session) {
  if (
    !sourceUpdate || typeof sourceUpdate !== "object" ||
    !targetUpdate || typeof targetUpdate !== "object"
  ) {
    return targetUpdate;
  }
  const context = getUpdateTraceContext(sourceUpdate, session);
  return context ? attachDestinyUpdateContext(targetUpdate, context) : targetUpdate;
}

function recordDestinyPresentationEnqueue(scene, session, update, details = {}) {
  if (!isEnabled() || !update) {
    return null;
  }
  const context = getUpdateTraceContext(update, session);
  if (!context) {
    return null;
  }
  if (details.supersededActionId) {
    emitEvent("destiny.presentation.superseded", {
      scene,
      session,
      entityIds: context.entityIds,
      entityScoped: false,
      clock: {
        simulationTimeMs: details.simulationTimeMs,
        destinyStamp: update.stamp,
      },
      correlation: {
        actionId: details.supersededActionId,
        replacementActionId: context.actionId,
      },
      data: {
        dedupeKey: details.dedupeKey || null,
        retainedOrder: details.order,
      },
    });
  }
  return emitEvent("destiny.presentation.enqueued", {
    scene,
    session,
    entityIds: context.entityIds,
    entityScoped: false,
    clock: {
      simulationTimeMs: details.simulationTimeMs,
      destinyStamp: update.stamp,
    },
    correlation: {
      actionId: context.actionId,
      supersededActionId: details.supersededActionId || null,
    },
    data: {
      order: details.order,
      dedupeKey: details.dedupeKey || null,
      replacedExistingEntry: Boolean(details.supersededActionId),
    },
  });
}

function recordDestinyGroupEnqueued(scene, session, details = {}) {
  if (!isEnabled() || !Array.isArray(details.updates) || details.updates.length === 0) {
    return null;
  }
  const entityIds = uniqueEntityIds(details.updates.flatMap((update) => (
    extractTraceEntityIds(update && update.payload)
  )));
  if (!matchesFilters({ scene, session, entityIds, entityScoped: false })) {
    return null;
  }
  const selected = matchesFilters({
    scene,
    session,
    entityIds,
    entityScoped: runtimeState.configuration.entityFilters.size > 0,
  });
  if (!selected) {
    return {
      selected: false,
      groupId: null,
      entityIds,
      actionContexts: details.updates.map((update, index) => {
        const payload = update && update.payload;
        return {
          actionId: null,
          groupId: null,
          orderInGroup: index,
          name: Array.isArray(payload) ? String(payload[0] || "unknown") : "unknown",
          stamp: Number(update && update.stamp) >>> 0,
          entityIds: extractTraceEntityIds(payload),
          destructionId: null,
        };
      }),
    };
  }
  const groupId = `group:${runtimeState.nextGroupSequence++}`;
  const actionContexts = details.updates.map((update, index) => {
    const payload = update && update.payload;
    const actionEntityIds = extractTraceEntityIds(payload);
    const authoredContext = getUpdateTraceContext(update, session);
    const actionId = authoredContext && authoredContext.actionId
      ? authoredContext.actionId
      : `action:${runtimeState.nextActionSequence++}`;
    const destruction = getDestructionContext(actionEntityIds);
    const action = describeAction(payload);
    const authoritativeSnapshots = getAuthoritativeSnapshots(scene, actionEntityIds);
    const actionContext = {
      actionId,
      groupId,
      orderInGroup: index,
      name: action.name,
      stamp: Number(update && update.stamp) >>> 0,
      entityIds: actionEntityIds,
      destructionId: destruction ? destruction.destructionId : null,
    };
    if (!authoredContext) {
      emitEvent("destiny.action.authored", {
        scene,
        session,
        entityIds: actionEntityIds,
        entityScoped: false,
        clock: {
          simulationTimeMs: details.simulationTimeMs,
          destinyStamp: actionContext.stamp,
        },
        correlation: {
          actionId,
          destructionId: actionContext.destructionId,
        },
        data: {
          captureBoundary: "final-direct-enqueue-fallback",
          orderInCall: null,
          authoredStamp: update && update.authoredStamp !== undefined
            ? update.authoredStamp
            : actionContext.stamp,
          actionName: action.name,
          actionFields: action.fields,
          authoredPositionPresent: action.authoredPositionPresent,
          authoredPayload: payload,
          authoritativeSnapshots,
        },
      });
    }
    emitEvent("destiny.action.enqueued", {
      scene,
      session,
      entityIds: actionEntityIds,
      entityScoped: false,
      clock: {
        simulationTimeMs: details.simulationTimeMs,
        destinyStamp: actionContext.stamp,
      },
      correlation: {
        groupId,
        actionId,
        destructionId: actionContext.destructionId,
      },
      data: {
        captureBoundary: "final-direct-enqueue",
        contract: String(details.contract || ""),
        orderInGroup: index,
        authoredStamp: update && update.authoredStamp !== undefined
          ? update.authoredStamp
          : null,
        finalStamp: actionContext.stamp,
        actionName: action.name,
        actionFields: action.fields,
        authoredPositionPresent: action.authoredPositionPresent,
        finalPayload: payload,
        authoritativeSnapshots,
      },
    });
    return actionContext;
  });
  emitEvent("destiny.group.enqueued", {
    scene,
    session,
    entityIds,
    entityScoped: false,
    clock: {
      simulationTimeMs: details.simulationTimeMs,
      destinyStamp: details.stamp,
    },
    correlation: { groupId },
    data: {
      order: details.order,
      rawDispatchStamp: details.rawDispatchStamp || null,
      waitForBubble: details.waitForBubble === true,
      contract: String(details.contract || ""),
      actionIds: actionContexts.map((context) => context.actionId),
    },
  });
  return { selected: true, groupId, actionContexts, entityIds };
}

function prepareDestinyNotification(scene, session, details = {}) {
  if (!isEnabled() || !details.payloadTuple || typeof details.payloadTuple !== "object") {
    return null;
  }
  const groupContexts = (Array.isArray(details.groupContexts)
    ? details.groupContexts
    : []).filter(Boolean);
  if (
    groupContexts.length === 0 ||
    !groupContexts.some((context) => context.selected === true)
  ) {
    return null;
  }
  const actionContexts = groupContexts.flatMap((context) => context.actionContexts || []);
  const entityIds = uniqueEntityIds(actionContexts.flatMap((context) => context.entityIds));
  const notificationId = `notification:${runtimeState.nextNotificationSequence++}`;
  const context = {
    scene,
    sessionId: getSessionId(session),
    notificationId,
    groupIds: groupContexts.map((entry) => entry.groupId).filter(Boolean),
    actionContexts,
    entityIds,
    simulationTimeMs: details.simulationTimeMs,
    simulationTick: scene && scene._activeTickSequence,
    destinyStamp: details.destinyStamp,
  };
  notificationContextByPayload.set(details.payloadTuple, context);
  emitEvent("destiny.notification.authored", {
    scene,
    session,
    entityIds,
    entityScoped: false,
    clock: {
      simulationTimeMs: details.simulationTimeMs,
      destinyStamp: details.destinyStamp,
    },
    correlation: {
      notificationId,
      groupIds: context.groupIds,
      actionIds: actionContexts.map((entry) => entry.actionId).filter(Boolean),
    },
    data: {
      waitForBubble: details.waitForBubble === true,
      actionCount: actionContexts.length,
      correlatedActionCount: actionContexts.filter((entry) => entry.actionId).length,
      actionNames: actionContexts.map((entry) => entry.name),
      actionStamps: actionContexts.map((entry) => entry.stamp),
    },
  });
  return context;
}

function extractPayloadUpdates(payloadTuple) {
  const listValue = Array.isArray(payloadTuple) ? payloadTuple[0] : null;
  const entries = listValue && listValue.type === "list" && Array.isArray(listValue.items)
    ? listValue.items
    : Array.isArray(listValue) ? listValue : [];
  return entries
    .filter((entry) => Array.isArray(entry) && Array.isArray(entry[1]))
    .map((entry, index) => ({
      index,
      stamp: Number(entry[0]) >>> 0,
      payload: entry[1],
    }));
}

function buildFallbackNotificationContext(session, payloadTuple) {
  const updates = extractPayloadUpdates(payloadTuple);
  const entityIds = uniqueEntityIds(updates.flatMap((update) => (
    extractTraceEntityIds(update.payload)
  )));
  if (!matchesFilters({
    session,
    entityIds,
    entityScoped: runtimeState.configuration.entityFilters.size > 0,
  })) {
    return null;
  }
  const notificationId = `notification:${runtimeState.nextNotificationSequence++}`;
  return {
    scene: null,
    sessionId: getSessionId(session),
    notificationId,
    groupIds: [],
    actionContexts: [],
    entityIds,
    simulationTimeMs: null,
    simulationTick: null,
    destinyStamp: null,
    fallbackActions: updates.map((update) => ({
      name: update.payload[0],
      stamp: update.stamp,
      entityIds: extractTraceEntityIds(update.payload),
      payload: update.payload,
    })),
  };
}

function recordSerializedNotification(session, payloadTuple, buffer) {
  if (!isEnabled() || !Buffer.isBuffer(buffer)) {
    return null;
  }
  const linkedContext = payloadTuple && typeof payloadTuple === "object"
    ? notificationContextByPayload.get(payloadTuple) || null
    : null;
  if (linkedContext && payloadTuple && typeof payloadTuple === "object") {
    notificationContextByPayload.delete(payloadTuple);
  }
  const context = linkedContext || buildFallbackNotificationContext(session, payloadTuple);
  if (!context) {
    return null;
  }
  const packetId = `packet:${runtimeState.nextPacketSequence++}`;
  const packetContext = { ...context, packetId };
  const event = emitEvent("destiny.notification.serialized", {
    scene: context.scene,
    session,
    entityIds: context.entityIds,
    entityScoped: false,
    clock: {
      simulationTimeMs: context.simulationTimeMs,
      simulationTick: context.simulationTick,
      destinyStamp: context.destinyStamp,
    },
    correlation: {
      notificationId: context.notificationId,
      packetId,
      groupIds: context.groupIds,
      actionIds: context.actionContexts.map((entry) => entry.actionId).filter(Boolean),
    },
    data: {
      byteDomain: "destiny-notification-inner-marshal",
      bytes: buffer,
      actions: context.actionContexts.map((entry, index) => ({
        actionId: entry.actionId,
        orderInNotification: index,
        name: entry.name,
        stamp: entry.stamp,
        entityIds: entry.entityIds,
      })),
      fallbackActions: context.fallbackActions || null,
      correlationComplete:
        context.actionContexts.length > 0 &&
        context.actionContexts.every((entry) => Boolean(entry.actionId)),
    },
  });
  return event ? packetContext : null;
}

function recordNotificationSent(session, context, details = {}) {
  if (!isEnabled() || !context) {
    return null;
  }
  return emitEvent("destiny.notification.sent", {
    scene: context.scene,
    session,
    entityIds: context.entityIds,
    entityScoped: false,
    clock: {
      simulationTimeMs: context.simulationTimeMs,
      simulationTick: context.simulationTick,
      destinyStamp: context.destinyStamp,
    },
    correlation: {
      notificationId: context.notificationId,
      packetId: context.packetId,
      groupIds: context.groupIds,
      actionIds: context.actionContexts.map((entry) => entry.actionId).filter(Boolean),
    },
    data: {
      outerMarshalByteLength: details.outerMarshalByteLength,
      bodyByteLength: details.bodyByteLength,
      framedByteLength: details.framedByteLength,
      encrypted: details.encrypted === true,
      socketWriteAccepted: details.socketWriteAccepted === true
        ? true
        : details.socketWriteAccepted === false
          ? false
          : null,
      deliveryClaimed: false,
    },
  });
}

function complete(details = {}) {
  if (!isEnabled()) {
    return null;
  }
  const completed = emitEvent("trace.completed", {
    global: true,
    data: details,
  });
  if (completed && runtimeState.outputFd !== null) {
    try {
      fs.fsyncSync(runtimeState.outputFd);
      fs.closeSync(runtimeState.outputFd);
      runtimeState.outputFd = null;
    } catch (error) {
      markFailed(error);
    }
  }
  return completed;
}

function closeCurrentOutput() {
  if (runtimeState.outputFd === null) {
    return;
  }
  try {
    fs.closeSync(runtimeState.outputFd);
  } catch (_error) {
    // Reconfiguration is test-only; the replacement recorder remains fail-open.
  }
  runtimeState.outputFd = null;
}

function configureForTesting(options = {}) {
  closeCurrentOutput();
  runtimeState = createRuntimeState(buildConfiguration(options));
  notificationContextByPayload = new WeakMap();
  updateTraceContextByUpdate = new WeakMap();
  return getStatus();
}

function resetForTesting() {
  closeCurrentOutput();
  runtimeState = createRuntimeState(configurationFromEnvironment());
  notificationContextByPayload = new WeakMap();
  updateTraceContextByUpdate = new WeakMap();
  return getStatus();
}

function getStatus() {
  const configuration = runtimeState.configuration;
  return {
    requested: configuration.requested,
    enabled: isEnabled(),
    outputPath: configuration.outputPath,
    scenarioId: configuration.scenarioId,
    configurationError: configuration.configurationError,
    started: runtimeState.started,
    failed: runtimeState.failed,
    failureCount: runtimeState.failureCount,
    lastError: runtimeState.lastError,
    eventSequence: runtimeState.eventSequence,
    runId: runtimeState.runId,
  };
}

module.exports = {
  TRACE_SCHEMA,
  TRACE_SCHEMA_VERSION,
  complete: failOpen(complete, null),
  encodeLosslessValue,
  getStatus,
  isEnabled,
  attachDestinyUpdateContext: failOpen(attachDestinyUpdateContext, null),
  propagateDestinyUpdateContext: failOpen(propagateDestinyUpdateContext, null),
  prepareDestinyNotification: failOpen(prepareDestinyNotification, null),
  recordDestinyActionAuthored: failOpen(recordDestinyActionAuthored, null),
  recordDestinyGroupEnqueued: failOpen(recordDestinyGroupEnqueued, null),
  recordEntitySpawn: failOpen(recordEntitySpawn, null),
  recordNotificationSent: failOpen(recordNotificationSent, null),
  recordDestinyPresentationEnqueue: failOpen(recordDestinyPresentationEnqueue, null),
  recordSerializedNotification: failOpen(recordSerializedNotification, null),
  recordSimulationState: failOpen(recordSimulationState, 0),
  recordTerminalState: failOpen(recordTerminalState, null),
  recordWreckRecordCreated: failOpen(recordWreckRecordCreated, null),
  recordVisibilityBoundary: failOpen(recordVisibilityBoundary, null),
  recordVisibilityDelta: failOpen(recordVisibilityDelta, 0),
  recordVisibilityEligibility: failOpen(recordVisibilityEligibility, null),
  snapshotEntity: failOpen(snapshotEntity, null),
  _testing: {
    configure: configureForTesting,
    getStatus,
    reset: resetForTesting,
  },
};
