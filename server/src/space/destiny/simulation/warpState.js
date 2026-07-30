const {
  normalizeDestinyStamp,
  resolveOptionalDestinyStamp,
} = require("../delivery/stamps");
const {
  normalizePersistentEntityID,
} = require("../identity/entityID");
const {
  getNativeWarpDropoutSpeed,
  getWarpAccelRateFromWarpSpeedAU,
  getWarpDecelRateFromWarpSpeedAU,
  isNativeWarpDistanceTooShort,
} = require("./warp");

const INVALID_RUNTIME_PERSISTENT_IDENTITY = "invalid-persistent-identity";

function hasPersistentIdentityValue(value) {
  return value !== null && value !== undefined && String(value).trim() !== "";
}

function resolveEffectDestinyStamp(value, fallback = null) {
  const numeric = Number(value);
  if (Number.isInteger(numeric) && numeric < 0) {
    return -1;
  }
  const stamp = resolveOptionalDestinyStamp(value);
  if (stamp !== null) {
    return stamp;
  }
  const fallbackNumeric = Number(fallback);
  if (Number.isInteger(fallbackNumeric) && fallbackNumeric < 0) {
    return -1;
  }
  return resolveOptionalDestinyStamp(fallback, 0);
}

function createDestinyWarpStateHelpers(deps = {}) {
  const {
    addVectors,
    clamp,
    clonePilotWarpMaxSpeedRamp,
    cloneVector,
    clearTrackingState,
    distance,
    getActualSpeedFraction,
    getCurrentAlignmentDirection,
    getTurnMetrics,
    magnitude,
    normalizeVector,
    scaleVector,
    serializeWarpState,
    subtractVectors,
    toFiniteNumber,
    toInt,
    DESTINY_STAMP_INTERVAL_MS,
    ONE_AU_IN_METERS,
    SESSIONLESS_WARP_INGRESS_DURATION_MS,
    WARP_COMPLETION_DISTANCE_MAX_METERS,
    WARP_COMPLETION_DISTANCE_MIN_METERS,
    WARP_COMPLETION_DISTANCE_RATIO,
    WARP_DECEL_RATE_MAX,
    WARP_DROPOUT_SPEED_MAX_MS,
    WARP_ENTRY_SPEED_FRACTION,
  } = deps;

  function resolveWarpSpeedAU(entity, explicitWarpSpeedAU) {
    const explicit = toFiniteNumber(explicitWarpSpeedAU, 0);
    const authored = toFiniteNumber(entity && entity.warpSpeedAU, 0);
    const requested = explicit > 0
      ? explicit
      : authored > 0
        ? authored
        : 3;
    const roundedFactor = Math.round(requested * 1000);
    return Number.isFinite(roundedFactor) && roundedFactor > 0
      ? Math.max(1, roundedFactor) / 1000
      : 3;
  }

  function resolveNativeWarpCommand(rawDistance, explicitCommand = null) {
    const command = String(explicitCommand || "").trim().toUpperCase();
    if (command === "GOTO" || command === "WARP") {
      return command;
    }
    return isNativeWarpDistanceTooShort(rawDistance) ? "GOTO" : "WARP";
  }

  function getWarpAccelRate(warpSpeedAU) {
    return getWarpAccelRateFromWarpSpeedAU(warpSpeedAU);
  }

  function getWarpDecelRate(warpSpeedAU) {
    return getWarpDecelRateFromWarpSpeedAU(
      warpSpeedAU,
      WARP_DECEL_RATE_MAX,
    );
  }

  function getWarpDropoutSpeedMs(entity) {
    return getNativeWarpDropoutSpeed(
      entity && entity.maxVelocity,
      WARP_DROPOUT_SPEED_MAX_MS,
    );
  }

  function getWarpCompletionDistance(warpState) {
    const stopDistance = Math.max(
      toFiniteNumber(warpState && warpState.stopDistance, 0),
      0,
    );
    return clamp(
      stopDistance * WARP_COMPLETION_DISTANCE_RATIO,
      WARP_COMPLETION_DISTANCE_MIN_METERS,
      WARP_COMPLETION_DISTANCE_MAX_METERS,
    );
  }

  function buildWarpProfile(entity, destination, options = {}) {
    const rawDestination = cloneVector(destination, entity.position);
    const stopDistance = Math.max(0, toFiniteNumber(options.stopDistance, 0));
    const travelVector = subtractVectors(rawDestination, entity.position);
    const direction = normalizeVector(travelVector, entity.direction);
    const applyStopDistance = options.applyStopDistance !== false;
    const targetPoint = applyStopDistance
      ? subtractVectors(rawDestination, scaleVector(direction, stopDistance))
      : cloneVector(rawDestination);
    const totalDistance = distance(entity.position, targetPoint);
    const rawDistance = distance(entity.position, rawDestination);
    const warpSpeedAU = resolveWarpSpeedAU(entity, options.warpSpeedAU);
    const cruiseWarpSpeedMs = warpSpeedAU * ONE_AU_IN_METERS;
    const accelRate = getWarpAccelRate(warpSpeedAU);
    const decelRate = getWarpDecelRate(warpSpeedAU);
    const warpDropoutSpeedMs = getWarpDropoutSpeedMs(entity);
    // Carbon caps short-warp peak speed so acceleration plus deceleration
    // consumes exactly D. The +1/-1 pair is part of the native geometry.
    const distanceLimitedWarpSpeedMs =
      ((totalDistance + 1) * accelRate * decelRate) /
      Math.max(accelRate + decelRate, 0.001);
    const maxWarpSpeedMs = Math.max(
      0,
      Math.min(cruiseWarpSpeedMs, distanceLimitedWarpSpeedMs),
    );
    const profileType = maxWarpSpeedMs < cruiseWarpSpeedMs
      ? "short"
      : "long";
    const accelDistance = Math.max(maxWarpSpeedMs / accelRate, 0);
    const decelDistance = Math.max((maxWarpSpeedMs / decelRate) - 1, 0);
    const cruiseDistance = Math.max(
      totalDistance - accelDistance - decelDistance,
      0,
    );
    const accelTimeMs =
      (Math.log(Math.max(maxWarpSpeedMs / accelRate, 1)) / accelRate) * 1000;
    const cruiseTimeMs = maxWarpSpeedMs > 0
      ? (cruiseDistance / maxWarpSpeedMs) * 1000
      : 0;
    // This is Carbon's geometric deceleration duration (speed reaches d),
    // not an ordinary completion timer. Active warp exits on the strict
    // modeled dropout-speed predicate below.
    const decelTimeMs =
      (Math.log(Math.max(maxWarpSpeedMs / decelRate, 1)) / decelRate) * 1000;
    const startupGuidanceVelocity = cloneVector(
      options.startupGuidanceVelocity,
      entity.velocity,
    );

    return {
      startTimeMs: toFiniteNumber(options.nowMs, Date.now()),
      durationMs: accelTimeMs + cruiseTimeMs + decelTimeMs,
      accelTimeMs,
      cruiseTimeMs,
      decelTimeMs,
      totalDistance,
      stopDistance,
      maxWarpSpeedMs,
      cruiseWarpSpeedMs,
      warpFloorSpeedMs: warpDropoutSpeedMs,
      warpDropoutSpeedMs,
      accelDistance,
      cruiseDistance,
      decelDistance,
      accelExponent: accelRate,
      decelExponent: decelRate,
      accelRate,
      decelRate,
      warpSpeed: Math.max(1, Math.round(warpSpeedAU * 1000)),
      commandStamp: normalizeDestinyStamp(options.commandStamp, 0),
      startupGuidanceStamp: normalizeDestinyStamp(
        options.startupGuidanceStamp,
        0,
      ),
      startupGuidanceVelocity,
      activationSpeedMs: Math.max(0, magnitude(startupGuidanceVelocity)),
      cruiseBumpStamp: resolveOptionalDestinyStamp(options.cruiseBumpStamp),
      effectStamp: resolveEffectDestinyStamp(
        options.effectStamp,
        options.defaultEffectStamp,
      ),
      targetEntityID: toInt(options.targetEntityID, 0),
      destinationStaticInstanceID: normalizePersistentEntityID(
        options.destinationStaticInstanceID,
      ),
      destinationDungeonRoomKey:
        String(options.destinationDungeonRoomKey || "").trim() || null,
      destinationDungeonSiteID: normalizePersistentEntityID(
        options.destinationDungeonSiteID,
      ),
      followID: toFiniteNumber(options.followID, 15000),
      followRangeMarker: toFiniteNumber(options.followRangeMarker, -1),
      nativeWarpCommand: resolveNativeWarpCommand(
        rawDistance,
        options.nativeWarpCommand,
      ),
      profileType,
      origin: cloneVector(entity.position),
      rawDestination,
      targetPoint,
      pilotMaxSpeedRamp: clonePilotWarpMaxSpeedRamp(options.pilotMaxSpeedRamp),
    };
  }

  function buildPendingWarp(rawPendingWarp, position = { x: 0, y: 0, z: 0 }) {
    if (!rawPendingWarp || typeof rawPendingWarp !== "object") {
      return null;
    }

    const stopDistance = Math.max(
      0,
      toFiniteNumber(rawPendingWarp.stopDistance, 0),
    );
    const totalDistance = Math.max(
      0,
      toFiniteNumber(rawPendingWarp.totalDistance, 0),
    );
    return {
      requestedAtMs: toInt(rawPendingWarp.requestedAtMs, 0),
      preWarpSyncStamp: resolveOptionalDestinyStamp(
        rawPendingWarp.preWarpSyncStamp,
      ),
      prepareStamp: resolveOptionalDestinyStamp(rawPendingWarp.prepareStamp),
      prepareVisibleStamp: resolveOptionalDestinyStamp(
        rawPendingWarp.prepareVisibleStamp,
      ),
      stopDistance,
      totalDistance,
      warpSpeedAU: resolveWarpSpeedAU(null, rawPendingWarp.warpSpeedAU),
      rawDestination: cloneVector(rawPendingWarp.rawDestination, position),
      targetPoint: cloneVector(rawPendingWarp.targetPoint, position),
      targetEntityID: toInt(rawPendingWarp.targetEntityID, 0) || null,
      destinationStaticInstanceID: normalizePersistentEntityID(
        rawPendingWarp.destinationStaticInstanceID,
      ),
      destinationDungeonRoomKey:
        String(rawPendingWarp.destinationDungeonRoomKey || "").trim() || null,
      destinationDungeonSiteID: normalizePersistentEntityID(
        rawPendingWarp.destinationDungeonSiteID,
      ),
      nativeWarpCommand: resolveNativeWarpCommand(
        totalDistance + stopDistance,
        rawPendingWarp.nativeWarpCommand,
      ),
    };
  }

  function buildWarpState(rawWarpState, position, warpSpeedAU) {
    if (!rawWarpState || typeof rawWarpState !== "object") {
      return null;
    }
    const persistedWarpFactor = toInt(rawWarpState.warpSpeed, 0);
    const resolvedWarpSpeedAU = persistedWarpFactor > 0
      ? persistedWarpFactor / 1000
      : resolveWarpSpeedAU(null, warpSpeedAU);
    const resolvedWarpFactor = Math.max(
      1,
      Math.round(resolvedWarpSpeedAU * 1000),
    );
    const startTimeMs = toFiniteNumber(rawWarpState.startTimeMs, Date.now());
    const accelTimeMs = toFiniteNumber(rawWarpState.accelTimeMs, 0);
    const startupGuidanceAtMs = toFiniteNumber(
      rawWarpState.startupGuidanceAtMs,
      0,
    );
    const cruiseBumpAtMs = toFiniteNumber(
      rawWarpState.cruiseBumpAtMs,
      startTimeMs + Math.max(accelTimeMs, 0),
    );
    const effectAtMs = toFiniteNumber(
      rawWarpState.effectAtMs,
      startTimeMs,
    );
    const startupGuidanceVelocity = cloneVector(
      rawWarpState.startupGuidanceVelocity,
      { x: 0, y: 0, z: 0 },
    );
    const hydratePersistentIdentity = (value) => (
      !hasPersistentIdentityValue(value)
        ? null
        : normalizePersistentEntityID(value) ??
          INVALID_RUNTIME_PERSISTENT_IDENTITY
    );

    return {
      startTimeMs,
      // Pilot-timeline anchors carried through persistence/rehydration.
      warpRequestedAtMs: toFiniteNumber(rawWarpState.warpRequestedAtMs, startTimeMs),
      pilotPrepareVisibleStamp: toInt(rawWarpState.pilotPrepareVisibleStamp, 0),
      durationMs: toFiniteNumber(rawWarpState.durationMs, 0),
      accelTimeMs,
      cruiseTimeMs: toFiniteNumber(rawWarpState.cruiseTimeMs, 0),
      decelTimeMs: toFiniteNumber(rawWarpState.decelTimeMs, 0),
      totalDistance: toFiniteNumber(rawWarpState.totalDistance, 0),
      stopDistance: toFiniteNumber(rawWarpState.stopDistance, 0),
      maxWarpSpeedMs: toFiniteNumber(rawWarpState.maxWarpSpeedMs, 0),
      cruiseWarpSpeedMs: toFiniteNumber(rawWarpState.cruiseWarpSpeedMs, 0),
      warpFloorSpeedMs: toFiniteNumber(rawWarpState.warpFloorSpeedMs, 0),
      warpDropoutSpeedMs: toFiniteNumber(
        rawWarpState.warpDropoutSpeedMs,
        toFiniteNumber(
          rawWarpState.warpFloorSpeedMs,
          WARP_DROPOUT_SPEED_MAX_MS,
        ),
      ),
      accelDistance: toFiniteNumber(rawWarpState.accelDistance, 0),
      cruiseDistance: toFiniteNumber(rawWarpState.cruiseDistance, 0),
      decelDistance: toFiniteNumber(rawWarpState.decelDistance, 0),
      accelExponent: toFiniteNumber(rawWarpState.accelExponent, 5),
      decelExponent: toFiniteNumber(rawWarpState.decelExponent, 5),
      accelRate: Math.max(
        toFiniteNumber(rawWarpState.accelRate, 0) ||
          toFiniteNumber(rawWarpState.accelExponent, 0) ||
          getWarpAccelRate(resolvedWarpSpeedAU),
        0.001,
      ),
      decelRate: Math.max(
        toFiniteNumber(rawWarpState.decelRate, 0) ||
          toFiniteNumber(rawWarpState.decelExponent, 0) ||
          getWarpDecelRate(resolvedWarpSpeedAU),
        0.001,
      ),
      // A persisted zero can crash Michelle during warp-time division.
      warpSpeed: resolvedWarpFactor,
      commandStamp: normalizeDestinyStamp(rawWarpState.commandStamp, 0),
      startupGuidanceAtMs,
      startupGuidanceStamp: resolveOptionalDestinyStamp(
        rawWarpState.startupGuidanceStamp,
      ),
      startupGuidanceVelocity,
      // The activation speed is transient derived state. Never admit an
      // extra persisted/injected velocity authority alongside the canonical
      // startup guidance vector.
      activationSpeedMs: Math.max(0, magnitude(startupGuidanceVelocity)),
      cruiseBumpAtMs,
      cruiseBumpStamp: resolveOptionalDestinyStamp(
        rawWarpState.cruiseBumpStamp,
      ),
      effectAtMs,
      effectStamp: resolveEffectDestinyStamp(rawWarpState.effectStamp),
      targetEntityID: toInt(rawWarpState.targetEntityID, 0),
      destinationStaticInstanceID: hydratePersistentIdentity(
        rawWarpState.destinationStaticInstanceID,
      ),
      destinationDungeonRoomKey:
        String(rawWarpState.destinationDungeonRoomKey || "").trim() || null,
      destinationDungeonSiteID: hydratePersistentIdentity(
        rawWarpState.destinationDungeonSiteID,
      ),
      followID: toInt(rawWarpState.followID, 0),
      followRangeMarker: toFiniteNumber(
        rawWarpState.followRangeMarker,
        rawWarpState.stopDistance,
      ),
      nativeWarpCommand: "WARP",
      profileType: String(rawWarpState.profileType || "legacy"),
      origin: cloneVector(rawWarpState.origin, position),
      rawDestination: cloneVector(rawWarpState.rawDestination, position),
      targetPoint: cloneVector(rawWarpState.targetPoint, position),
      pilotMaxSpeedRamp: clonePilotWarpMaxSpeedRamp(
        rawWarpState.pilotMaxSpeedRamp,
      ),
    };
  }

  function buildPendingWarpRequest(entity, destination, options = {}) {
    const rawDestination = cloneVector(destination, entity.position);
    const stopDistance = Math.max(0, toFiniteNumber(options.stopDistance, 0));
    const travelVector = subtractVectors(rawDestination, entity.position);
    const direction = normalizeVector(travelVector, entity.direction);
    const targetPoint = subtractVectors(
      rawDestination,
      scaleVector(direction, stopDistance),
    );
    const totalDistance = distance(entity.position, targetPoint);
    const rawDistance = distance(entity.position, rawDestination);
    const warpSpeedAU = resolveWarpSpeedAU(entity, options.warpSpeedAU);

    return {
      requestedAtMs: toFiniteNumber(options.nowMs, Date.now()),
      preWarpSyncStamp: null,
      prepareStamp: resolveOptionalDestinyStamp(options.prepareStamp),
      prepareVisibleStamp: resolveOptionalDestinyStamp(
        options.prepareVisibleStamp,
      ),
      stopDistance,
      totalDistance,
      warpSpeedAU,
      rawDestination,
      targetPoint,
      targetEntityID: toInt(options.targetEntityID, 0) || null,
      destinationStaticInstanceID: normalizePersistentEntityID(
        options.destinationStaticInstanceID,
      ),
      destinationDungeonRoomKey:
        String(options.destinationDungeonRoomKey || "").trim() || null,
      destinationDungeonSiteID: normalizePersistentEntityID(
        options.destinationDungeonSiteID,
      ),
      nativeWarpCommand: resolveNativeWarpCommand(rawDistance),
    };
  }

  function buildPreparingWarpState(entity, pendingWarp, options = {}) {
    const warpState = buildWarpProfile(entity, pendingWarp && pendingWarp.rawDestination, {
      applyStopDistance: false,
      stopDistance: pendingWarp && pendingWarp.stopDistance,
      targetEntityID: pendingWarp && pendingWarp.targetEntityID,
      destinationStaticInstanceID:
        pendingWarp && pendingWarp.destinationStaticInstanceID,
      destinationDungeonRoomKey:
        pendingWarp && pendingWarp.destinationDungeonRoomKey,
      destinationDungeonSiteID:
        pendingWarp && pendingWarp.destinationDungeonSiteID,
      warpSpeedAU: pendingWarp && pendingWarp.warpSpeedAU,
      nowMs:
        options.nowMs === undefined || options.nowMs === null
          ? pendingWarp && pendingWarp.requestedAtMs
          : options.nowMs,
      commandStamp: pendingWarp && pendingWarp.prepareStamp,
      startupGuidanceStamp: 0,
      startupGuidanceVelocity: entity && entity.velocity,
      cruiseBumpStamp: 0,
      effectStamp: -1,
      defaultEffectStamp: toInt(options.defaultEffectStamp, 0),
      nativeWarpCommand: pendingWarp && pendingWarp.nativeWarpCommand,
    });
    if (!warpState) {
      return null;
    }

    warpState.commandStamp = normalizeDestinyStamp(
      pendingWarp && pendingWarp.prepareStamp,
      0,
    );
    warpState.startupGuidanceAtMs = 0;
    warpState.startupGuidanceStamp = null;
    warpState.startupGuidanceVelocity = cloneVector(
      entity && entity.velocity,
      { x: 0, y: 0, z: 0 },
    );
    warpState.cruiseBumpAtMs = 0;
    warpState.cruiseBumpStamp = null;
    warpState.effectAtMs = 0;
    warpState.effectStamp = -1;
    warpState.pilotMaxSpeedRamp = [];
    // Pilot-timeline anchors (see SolarSystemScene.getPilotPerceivedWarpPosition):
    // when the align started server-side and the session stamp at which the
    // pilot's WarpTo prepare executes on the client. Used to reconstruct where
    // the pilot's locally simulated warp currently is (mid-warp bookmarks).
    warpState.warpRequestedAtMs = toFiniteNumber(
      pendingWarp && pendingWarp.requestedAtMs,
      warpState.startTimeMs,
    );
    warpState.pilotPrepareVisibleStamp = toInt(
      pendingWarp && pendingWarp.prepareVisibleStamp,
      toInt(pendingWarp && pendingWarp.prepareStamp, 0),
    );
    return warpState;
  }

  function refreshPreparingWarpState(entity) {
    if (!entity || !entity.pendingWarp) {
      return null;
    }

    const refreshed = buildPreparingWarpState(entity, entity.pendingWarp);
    if (refreshed) {
      entity.warpState = refreshed;
    }
    return refreshed;
  }

  function evaluatePendingWarpAlignment(entity, pendingWarp) {
    const desiredDirection = normalizeVector(
      subtractVectors(pendingWarp.rawDestination, entity.position),
      entity.direction,
    );
    const alignmentDirection = getCurrentAlignmentDirection(
      entity,
      desiredDirection,
    );
    const turnMetrics = getTurnMetrics(alignmentDirection, desiredDirection);
    const degrees = (turnMetrics.radians * 180) / Math.PI;
    const alignmentDot = toFiniteNumber(
      turnMetrics && turnMetrics.alignment,
      Math.cos(toFiniteNumber(turnMetrics && turnMetrics.radians, Math.PI)),
    );
    const actualSpeedFraction = getActualSpeedFraction(entity);
    const alignedByDot = Math.abs(1 - alignmentDot) < 0.01;
    const alignedBySpeed = actualSpeedFraction > WARP_ENTRY_SPEED_FRACTION;
    return {
      aligned: alignedByDot && alignedBySpeed,
      alignedByDot,
      alignedBySpeed,
      degrees,
      alignmentDot,
      actualSpeedFraction,
      desiredDirection,
      alignmentDirection,
    };
  }

  function evaluatePendingWarp(entity, pendingWarp, now = Date.now()) {
    const alignment = evaluatePendingWarpAlignment(entity, pendingWarp);
    const elapsedMs = Math.max(
      0,
      toInt(now, Date.now()) - toInt(pendingWarp.requestedAtMs, 0),
    );
    const elapsedTicks = Math.floor(
      elapsedMs / Math.max(1, DESTINY_STAMP_INTERVAL_MS),
    );
    const forced = elapsedTicks > 180;
    return {
      ready: alignment.aligned || forced,
      aligned: alignment.aligned,
      alignedByDot: alignment.alignedByDot,
      alignedBySpeed: alignment.alignedBySpeed,
      forced,
      forceTicks: elapsedTicks,
      degrees: alignment.degrees,
      alignmentDot: alignment.alignmentDot,
      actualSpeedFraction: alignment.actualSpeedFraction,
      elapsedMs,
      desiredDirection: alignment.desiredDirection,
      alignmentDirection: alignment.alignmentDirection,
    };
  }

  function getPilotWarpActivationVelocity(entity, warpState) {
    if (!warpState) {
      return { x: 0, y: 0, z: 0 };
    }

    const direction = normalizeVector(
      subtractVectors(warpState.targetPoint, entity.position),
      entity.direction,
    );
    const startupGuidanceVelocity = cloneVector(
      warpState && warpState.startupGuidanceVelocity,
      entity && entity.velocity,
    );
    const activationSpeed = magnitude(startupGuidanceVelocity);
    if (activationSpeed <= 0.5) {
      return { x: 0, y: 0, z: 0 };
    }
    return scaleVector(direction, activationSpeed);
  }

  function activatePendingWarp(entity, pendingWarp, options = {}) {
    if (
      String(pendingWarp && pendingWarp.nativeWarpCommand || "")
        .trim()
        .toUpperCase() === "GOTO"
    ) {
      const commandPoint = cloneVector(
        pendingWarp && pendingWarp.rawDestination,
        entity && entity.position,
      );
      const shouldResumeSubwarp =
        toFiniteNumber(entity && entity.speedFraction, 0) <= 0 ||
        String(entity && entity.mode || "").trim().toUpperCase() === "STOP";
      if (typeof clearTrackingState === "function") {
        clearTrackingState(entity);
      } else {
        entity.pendingWarp = null;
        entity.warpState = null;
        entity.targetEntityID = null;
      }
      entity.targetPoint = commandPoint;
      if (shouldResumeSubwarp) {
        entity.speedFraction = 1;
      }
      entity.mode = "GOTO";
      return null;
    }
    const startupGuidanceVelocity = cloneVector(entity.velocity);
    const warpState = buildWarpProfile(entity, pendingWarp.rawDestination, {
      stopDistance: pendingWarp.stopDistance,
      targetEntityID: pendingWarp.targetEntityID,
      destinationStaticInstanceID: pendingWarp.destinationStaticInstanceID,
      destinationDungeonRoomKey: pendingWarp.destinationDungeonRoomKey,
      destinationDungeonSiteID: pendingWarp.destinationDungeonSiteID,
      warpSpeedAU: pendingWarp.warpSpeedAU,
      nowMs: toFiniteNumber(options.nowMs, pendingWarp && pendingWarp.requestedAtMs),
      commandStamp: 0,
      startupGuidanceStamp: 0,
      startupGuidanceVelocity,
      cruiseBumpStamp: 0,
      effectStamp: 0,
      defaultEffectStamp: toInt(options.defaultEffectStamp, 0),
      nativeWarpCommand: pendingWarp.nativeWarpCommand,
    });
    if (!warpState) {
      return null;
    }

    entity.mode = "WARP";
    entity.speedFraction = 1;
    entity.direction = normalizeVector(
      subtractVectors(warpState.targetPoint, entity.position),
      entity.direction,
    );
    entity.targetPoint = cloneVector(warpState.targetPoint);
    entity.targetEntityID = warpState.targetEntityID || null;
    entity.warpState = warpState;
    entity.pendingWarp = null;
    const activationProgress = getWarpProgress(
      warpState,
      warpState.startTimeMs,
    );
    entity.position = addVectors(
      warpState.origin,
      scaleVector(entity.direction, activationProgress.traveled),
    );
    entity.velocity = scaleVector(
      entity.direction,
      activationProgress.speed,
    );
    entity.lastWarpCorrectionBroadcastAt = 0;
    entity.lastWarpPositionBroadcastStamp = -1;
    entity.lastPilotWarpStartupGuidanceStamp = null;
    entity.lastPilotWarpVelocityStamp = null;
    entity.lastPilotWarpEffectStamp = null;
    entity.lastPilotWarpCruiseBumpStamp = null;
    entity.lastPilotWarpMaxSpeedRampIndex = -1;
    entity.lastWarpDiagnosticStamp = null;
    return warpState;
  }

  function buildSessionlessWarpIngressState(entity, warpState, options = {}) {
    const useNativeWarpProfile = options.useNativeWarpProfile === true;
    const startTimeMs = useNativeWarpProfile
      ? toFiniteNumber(
          warpState && warpState.startTimeMs,
          toFiniteNumber(options.nowMs, Date.now()),
        )
      : toFiniteNumber(options.nowMs, Date.now());
    const durationMs = useNativeWarpProfile
      ? Math.max(250, toFiniteNumber(warpState && warpState.durationMs, 250))
      : Math.max(
          250,
          toFiniteNumber(options.durationMs, SESSIONLESS_WARP_INGRESS_DURATION_MS),
        );
    const completionHoldMs = Math.max(
      0,
      toFiniteNumber(
        options.completionHoldMs,
        useNativeWarpProfile ? 0 : DESTINY_STAMP_INTERVAL_MS,
      ),
    );
    const travelCompleteAtMs = startTimeMs + durationMs;
    return {
      startTimeMs,
      travelCompleteAtMs,
      completeAtMs: travelCompleteAtMs + completionHoldMs,
      durationMs,
      completionHoldMs,
      lastUpdateAtMs: startTimeMs,
      useNativeWarpProfile,
      origin: cloneVector(entity.position),
      targetPoint: cloneVector(warpState && warpState.targetPoint, entity.position),
      suppressCompletionStopUpdates:
        options.suppressCompletionStopUpdates === true,
    };
  }

  function advanceSessionlessWarpIngress(entity, now) {
    const ingressState = entity && entity.sessionlessWarpIngress;
    if (!entity || !ingressState) {
      return { changed: false };
    }

    const previousPosition = cloneVector(entity.position);
    const previousVelocity = cloneVector(entity.velocity);
    const origin = cloneVector(ingressState.origin, entity.position);
    const targetPoint = cloneVector(ingressState.targetPoint, entity.position);
    const travelVector = subtractVectors(targetPoint, origin);
    const totalDistance = magnitude(travelVector);
    const direction = normalizeVector(travelVector, entity.direction);
    const startTimeMs = toFiniteNumber(ingressState.startTimeMs, now);
    const travelCompleteAtMs = Math.max(
      startTimeMs + 1,
      toFiniteNumber(
        ingressState.travelCompleteAtMs,
        toFiniteNumber(ingressState.completeAtMs, now),
      ),
    );
    const completeAtMs = Math.max(
      travelCompleteAtMs,
      toFiniteNumber(ingressState.completeAtMs, travelCompleteAtMs),
    );
    const durationMs = Math.max(travelCompleteAtMs - startTimeMs, 1);
    const rawProgress = clamp((now - startTimeMs) / durationMs, 0, 1);
    const easedProgress = rawProgress <= 0
      ? 0
      : rawProgress >= 1
        ? 1
        : (rawProgress * rawProgress * (3 - (2 * rawProgress)));
    const lastUpdateAtMs = toFiniteNumber(ingressState.lastUpdateAtMs, startTimeMs);
    const deltaSeconds = Math.max((now - lastUpdateAtMs) / 1000, 0.001);

    entity.direction = direction;
    entity.position = rawProgress >= 1
      ? cloneVector(targetPoint)
      : addVectors(origin, scaleVector(direction, totalDistance * easedProgress));
    entity.velocity = rawProgress >= 1
      ? { x: 0, y: 0, z: 0 }
      : scaleVector(
          direction,
          distance(previousPosition, entity.position) / deltaSeconds,
        );
    ingressState.lastUpdateAtMs = now;

    if (rawProgress >= 1 && now < completeAtMs) {
      return {
        changed:
          distance(previousPosition, entity.position) > 1 ||
          distance(previousVelocity, entity.velocity) > 0.5,
      };
    }

    if (rawProgress >= 1) {
      const suppressCompletionStopUpdates =
        ingressState.suppressCompletionStopUpdates === true;
      const completedWarpState = serializeWarpState({
        warpState: entity.warpState,
        position: entity.position,
      });
      entity.mode = "STOP";
      entity.speedFraction = 0;
      entity.targetPoint = cloneVector(entity.position);
      entity.warpState = null;
      entity.sessionlessWarpIngress = null;
      return {
        changed:
          distance(previousPosition, entity.position) > 1 ||
          distance(previousVelocity, entity.velocity) > 0.5,
        warpCompleted: true,
        completedWarpState,
        suppressCompletionStopUpdates,
      };
    }

    return {
      changed:
        distance(previousPosition, entity.position) > 1 ||
        distance(previousVelocity, entity.velocity) > 0.5,
    };
  }

  function getWarpProgress(warpState, now) {
    const elapsedMs = Math.max(0, toFiniteNumber(now, Date.now()) - warpState.startTimeMs);
    const accelMs = warpState.accelTimeMs;
    const cruiseMs = warpState.cruiseTimeMs;
    const resolvedWarpSpeedAU = Math.max(
      toFiniteNumber(warpState.warpSpeed, 0) / 1000,
      toFiniteNumber(warpState.cruiseWarpSpeedMs, 0) / ONE_AU_IN_METERS,
      0.001,
    );
    const accelRate = Math.max(
      toFiniteNumber(warpState.accelRate, 0) ||
        toFiniteNumber(warpState.accelExponent, 0) ||
        getWarpAccelRate(resolvedWarpSpeedAU),
      0.001,
    );
    const decelRate = Math.max(
      toFiniteNumber(warpState.decelRate, 0) ||
        toFiniteNumber(warpState.decelExponent, 0) ||
        getWarpDecelRate(resolvedWarpSpeedAU),
      0.001,
    );
    const maxWarpSpeedMs = Math.max(toFiniteNumber(warpState.maxWarpSpeedMs, 0), 0);
    const warpDropoutSpeedMs = Math.max(
      toFiniteNumber(
        warpState.warpDropoutSpeedMs,
        toFiniteNumber(
          warpState.warpFloorSpeedMs,
          WARP_DROPOUT_SPEED_MAX_MS,
        ),
      ),
      0,
    );
    const accelDistance = Math.max(toFiniteNumber(warpState.accelDistance, 0), 0);
    const cruiseDistance = Math.max(toFiniteNumber(warpState.cruiseDistance, 0), 0);
    const decelStartMs = accelMs + cruiseMs;

    if (elapsedMs < accelMs) {
      const seconds = elapsedMs / 1000;
      const baseSpeed = Math.min(
        maxWarpSpeedMs,
        accelRate * Math.exp(accelRate * seconds),
      );
      const speed = Math.max(
        baseSpeed,
        toFiniteNumber(
          warpState.activationSpeedMs,
          magnitude(warpState.startupGuidanceVelocity),
        ),
      );
      return {
        complete: false,
        traveled: Math.min(
          accelDistance,
          Math.max(baseSpeed / accelRate, 0),
        ),
        speed,
      };
    }

    if (elapsedMs < accelMs + cruiseMs) {
      const seconds = (elapsedMs - accelMs) / 1000;
      return {
        complete: false,
        traveled: accelDistance + (maxWarpSpeedMs * seconds),
        speed: maxWarpSpeedMs,
      };
    }

    const seconds = Math.max((elapsedMs - decelStartMs) / 1000, 0);
    const speed = Math.max(
      0,
      maxWarpSpeedMs * Math.exp(-decelRate * seconds),
    );
    const progress = {
      complete: false,
      traveled:
        accelDistance +
        cruiseDistance +
        Math.max((maxWarpSpeedMs - speed) / decelRate, 0),
      speed,
    };
    if (warpDropoutSpeedMs > 0 && speed < warpDropoutSpeedMs) {
      return {
        complete: true,
        traveled: progress.traveled,
        speed,
        dropoutSpeedMs: warpDropoutSpeedMs,
        nativeDropout: true,
      };
    }
    if (
      warpDropoutSpeedMs <= 0 &&
      elapsedMs >= Math.max(toFiniteNumber(warpState.durationMs, 0), 0)
    ) {
      return {
        complete: true,
        traveled: progress.traveled,
        speed,
        dropoutSpeedMs: 0,
        nativeDropout: false,
      };
    }
    return progress;
  }

  function getWarpStopDistanceForTarget(shipEntity, targetEntity, minimumRange = 0) {
    const targetRadius = Math.max(0, toFiniteNumber(targetEntity && targetEntity.radius, 0));
    const desiredRange = Math.max(0, toFiniteNumber(minimumRange, 0));

    switch (targetEntity && targetEntity.kind) {
      case "planet":
      case "moon":
        return Math.max(targetRadius + 1000000, desiredRange) + (shipEntity.radius * 2);
      case "sun":
        return Math.max(targetRadius + 5000000, desiredRange) + (shipEntity.radius * 2);
      case "station":
        return targetRadius + desiredRange + (shipEntity.radius * 2);
      case "stargate":
        return Math.max(Math.max(2500, targetRadius * 0.3), desiredRange) + (shipEntity.radius * 2);
      case "asteroidBelt":
        return Math.max(2500, desiredRange) + (shipEntity.radius * 2);
      default:
        return Math.max(Math.max(1000, targetRadius), desiredRange) + (shipEntity.radius * 2);
    }
  }

  return {
    getWarpAccelRate,
    getWarpDecelRate,
    getWarpDropoutSpeedMs,
    getWarpCompletionDistance,
    buildWarpProfile,
    buildWarpState,
    buildPendingWarp,
    buildPendingWarpRequest,
    buildPreparingWarpState,
    refreshPreparingWarpState,
    evaluatePendingWarpAlignment,
    evaluatePendingWarp,
    getPilotWarpActivationVelocity,
    activatePendingWarp,
    buildSessionlessWarpIngressState,
    advanceSessionlessWarpIngress,
    getWarpProgress,
    getWarpStopDistanceForTarget,
  };
}

module.exports = {
  createDestinyWarpStateHelpers,
};

Object.defineProperty(module.exports, "createMovementWarpStateHelpers", {
  value: createDestinyWarpStateHelpers,
});
