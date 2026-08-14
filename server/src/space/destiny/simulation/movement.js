"use strict";

const {
  DESTINY_ORBITAL_PRECESSION_PER_TICK:
    DEFAULT_DESTINY_ORBITAL_PRECESSION_PER_TICK,
  DESTINY_SPACE_FRICTION: DEFAULT_DESTINY_SPACE_FRICTION,
  DESTINY_STAMP_INTERVAL_MS: DEFAULT_DESTINY_STAMP_INTERVAL_MS,
} = require("../constants");
const {
  normalizeEntityID,
} = require("../identity/entityID");
const {
  advanceDestinyStamp: advanceDefaultDestinyStamp,
  getCurrentDestinyStamp: getDefaultCurrentDestinyStamp,
} = require("../delivery/stamps");
const {
  acquireActiveWarpNativeSample: acquireDefaultActiveWarpNativeSample,
} = require("./warpNativeBoundary");
const {
  integrateCarbonMotion: integrateDefaultCarbonMotion,
} = require("./carbonIntegration");

const DEFAULT_WORLD_UP = Object.freeze({ x: 0, y: 1, z: 0 });

function createDestinyMovementSimulator(deps = {}) {
  const {
    addVectors,
    acquireActiveWarpNativeSample = acquireDefaultActiveWarpNativeSample,
    advanceDestinyStamp = advanceDefaultDestinyStamp,
    advanceSessionlessWarpIngress,
    buildPerpendicular,
    clamp,
    cloneVector,
    crossProduct,
    deriveAgilitySeconds,
    distance,
    dotProduct,
    getCurrentAlignmentDirection,
    getCurrentDestinyStamp = getDefaultCurrentDestinyStamp,
    getFollowMotionProfile,
    getTurnMetrics,
    getWarpProgress,
    integrateCarbonMotion = integrateDefaultCarbonMotion,
    log,
    logMissileDebug,
    magnitude,
    normalizeTraceValue,
    normalizeVector,
    refreshPreparingWarpState,
    roundNumber,
    scaleVector,
    serializeWarpState,
    subtractVectors,
    summarizeMissileEntity,
    summarizeRuntimeEntityForMissileDebug,
    summarizeVector,
    toFiniteNumber,
    DEFAULT_RIGHT,
    DESTINY_ORBITAL_PRECESSION_PER_TICK =
      DEFAULT_DESTINY_ORBITAL_PRECESSION_PER_TICK,
    DESTINY_SPACE_FRICTION = DEFAULT_DESTINY_SPACE_FRICTION,
    DESTINY_STAMP_INTERVAL_MS = DEFAULT_DESTINY_STAMP_INTERVAL_MS,
    MAX_SUBWARP_SPEED_FRACTION,
    TURN_ALIGNMENT_RADIANS,
  } = deps;

  function getCommandDirection(entity, fallback = DEFAULT_RIGHT) {
    if (entity && entity.targetPoint && entity.position) {
      return normalizeVector(
        subtractVectors(entity.targetPoint, entity.position),
        entity.direction || fallback,
      );
    }

    return normalizeVector(entity && entity.direction, fallback);
  }

  function integrateVelocityTowardTarget(
    currentVelocity,
    desiredVelocity,
    responseSeconds,
    deltaSeconds,
  ) {
    const tau = Math.max(toFiniteNumber(responseSeconds, 0.05), 0.05);
    const delta = Math.max(toFiniteNumber(deltaSeconds, 0), 0);
    const decay = Math.exp(-(delta / tau));
    const velocityOffset = subtractVectors(currentVelocity, desiredVelocity);
    const nextVelocity = addVectors(
      desiredVelocity,
      scaleVector(velocityOffset, decay),
    );
    const positionDelta = addVectors(
      scaleVector(desiredVelocity, delta),
      scaleVector(velocityOffset, tau * (1 - decay)),
    );
    return {
      nextVelocity,
      positionDelta,
      decay,
      tau,
    };
  }

  function deriveTurnDegreesPerTick(agilitySeconds) {
    const normalizedAgility = Math.max(toFiniteNumber(agilitySeconds, 0.05), 0.05);
    // The old linear falloff effectively stalled capital-class turns once
    // agility drifted past ~60s. Use a bounded inverse curve instead so large
    // hulls still converge in a finite, client-like amount of time while small
    // hulls retain noticeably sharper turns.
    return clamp(75 / normalizedAgility, 0.75, 12);
  }

  function slerpDirection(current, target, fraction, radians) {
    const clampedFraction = clamp(fraction, 0, 1);
    if (clampedFraction <= 0) {
      return current;
    }
    if (clampedFraction >= 1) {
      return target;
    }

    const totalRadians = Math.max(toFiniteNumber(radians, 0), 0);
    const sinTotal = Math.sin(totalRadians);
    if (!Number.isFinite(sinTotal) || Math.abs(sinTotal) < 0.000001) {
      return normalizeVector(
        addVectors(
          scaleVector(current, 1 - clampedFraction),
          scaleVector(target, clampedFraction),
        ),
        target,
      );
    }

    const leftWeight =
      Math.sin((1 - clampedFraction) * totalRadians) / sinTotal;
    const rightWeight =
      Math.sin(clampedFraction * totalRadians) / sinTotal;

    return normalizeVector(
      addVectors(
        scaleVector(current, leftWeight),
        scaleVector(target, rightWeight),
      ),
      target,
    );
  }

  function rotateDirectionToward(
    currentDirection,
    targetDirection,
    deltaSeconds,
    agilitySeconds,
    currentSpeedFraction = 0,
  ) {
    const current = normalizeVector(currentDirection, targetDirection);
    const target = normalizeVector(targetDirection, current);
    const turnMetrics = getTurnMetrics(current, target);
    const degrees = (turnMetrics.radians * 180) / Math.PI;

    if (!Number.isFinite(turnMetrics.radians) || turnMetrics.radians <= TURN_ALIGNMENT_RADIANS) {
      return {
        direction: target,
        degrees,
        turnFraction: turnMetrics.turnFraction,
        turnPercent: 1,
        degPerTick: 0,
        maxStepDegrees: 0,
        turnSeconds: 0,
        snapped: true,
      };
    }

    // Destiny turns much faster than it changes speed, and from near-rest the
    // client effectively snaps to the requested heading before accelerating.
    if (currentSpeedFraction <= 0.1) {
      return {
        direction: target,
        degrees,
        turnFraction: turnMetrics.turnFraction,
        turnPercent: 1,
        degPerTick: 0,
        maxStepDegrees: 0,
        turnSeconds: 0,
        snapped: true,
      };
    }

    // Match the classic destiny turn shape more closely than a slow exponential
    // blend: heading changes in noticeable per-tick steps and large turns begin
    // by shedding speed while the nose swings through the arc.
    const degPerTick = deriveTurnDegreesPerTick(agilitySeconds);
    const tickScale = Math.max(deltaSeconds / 0.1, 0.05);
    const maxStepDegrees = degPerTick * tickScale;
    const turnPercent = clamp(maxStepDegrees / Math.max(degrees, 0.001), 0.001, 1);
    const turnSeconds = Math.max(agilitySeconds / 2.2, 0.05);
    return {
      direction: slerpDirection(current, target, turnPercent, turnMetrics.radians),
      degrees,
      turnFraction: turnMetrics.turnFraction,
      turnPercent,
      degPerTick,
      maxStepDegrees,
      turnSeconds,
      snapped: false,
    };
  }

  function applyDesiredVelocity(entity, desiredDirection, desiredSpeed, deltaSeconds) {
    const previousPosition = cloneVector(entity.position);
    const previousVelocity = cloneVector(entity.velocity);
    const headingSource = normalizeVector(entity.direction, desiredDirection);
    const targetDirection = normalizeVector(desiredDirection, headingSource);
    const agilitySeconds = Math.max(
      toFiniteNumber(entity.agilitySeconds, 0) ||
        deriveAgilitySeconds(
          entity.alignTime,
          entity.maxAccelerationTime,
          entity.mass,
          entity.inertia,
        ),
      0.05,
    );
    const currentSpeedFraction =
      entity.maxVelocity > 0
        ? Math.max(0, magnitude(entity.velocity) / entity.maxVelocity)
        : 0;
    const targetSpeedFraction =
      entity.maxVelocity > 0
        ? Math.max(0, desiredSpeed / entity.maxVelocity)
        : 0;
    const currentAlignmentDirection = getCurrentAlignmentDirection(
      entity,
      targetDirection,
    );
    const turnMetrics = getTurnMetrics(currentAlignmentDirection, targetDirection);
    const desiredVelocity = scaleVector(targetDirection, Math.max(0, desiredSpeed));
    const integration = integrateVelocityTowardTarget(
      previousVelocity,
      desiredVelocity,
      agilitySeconds,
      deltaSeconds,
    );
    const nextSpeed = magnitude(integration.nextVelocity);
    const nextSpeedFraction =
      entity.maxVelocity > 0 ? Math.max(0, nextSpeed / entity.maxVelocity) : 0;

    const turnStep = rotateDirectionToward(
      headingSource,
      targetDirection,
      deltaSeconds,
      agilitySeconds,
      currentSpeedFraction,
    );
    entity.direction =
      hasManualStrafingThrust(entity)
        ? turnStep.direction
        : nextSpeed > 0.05
        ? normalizeVector(integration.nextVelocity, turnStep.direction)
        : turnStep.direction;
    entity.velocity =
      nextSpeed <= 0.05
        ? { x: 0, y: 0, z: 0 }
        : integration.nextVelocity;
    if (desiredSpeed <= 0.001 && magnitude(entity.velocity) < 0.1) {
      entity.velocity = { x: 0, y: 0, z: 0 };
    }

    entity.position = addVectors(entity.position, integration.positionDelta);
    const positionDelta = subtractVectors(entity.position, previousPosition);
    const velocityDelta = subtractVectors(entity.velocity, previousVelocity);
    const appliedTurnMetrics = getTurnMetrics(currentAlignmentDirection, entity.direction);
    entity.lastTurnMetrics = {
      degrees: roundNumber(turnStep.degrees, 2),
      appliedDegrees: roundNumber((appliedTurnMetrics.radians * 180) / Math.PI, 2),
      turnFraction: roundNumber(turnMetrics.turnFraction, 3),
      currentSpeedFraction: roundNumber(currentSpeedFraction, 3),
      targetSpeedFraction: roundNumber(targetSpeedFraction, 3),
      effectiveTargetSpeedFraction: roundNumber(targetSpeedFraction, 3),
      turnSpeedCap: roundNumber(targetSpeedFraction, 3),
      speedDeltaFraction: roundNumber(
        Math.abs(currentSpeedFraction - targetSpeedFraction),
        3,
      ),
      speedResponseSeconds: roundNumber(agilitySeconds, 3),
      agilitySeconds: roundNumber(agilitySeconds, 3),
      exponentialDecay: roundNumber(integration.decay, 6),
      degPerTick: roundNumber(turnStep.degPerTick, 3),
      maxStepDegrees: roundNumber(turnStep.maxStepDegrees, 3),
      turnPercent: roundNumber(turnStep.turnPercent, 3),
      turnSeconds: roundNumber(turnStep.turnSeconds, 3),
      snapped: Boolean(turnStep.snapped),
    };
    entity.lastMotionDebug = {
      deltaSeconds: roundNumber(deltaSeconds, 4),
      previousPosition: summarizeVector(previousPosition),
      positionDelta: summarizeVector(positionDelta),
      previousVelocity: summarizeVector(previousVelocity),
      velocityDelta: summarizeVector(velocityDelta),
      headingSource: summarizeVector(currentAlignmentDirection),
      desiredDirection: summarizeVector(targetDirection),
      currentSpeed: roundNumber(magnitude(previousVelocity), 3),
      desiredSpeed: roundNumber(desiredSpeed, 3),
      nextSpeed: roundNumber(magnitude(entity.velocity), 3),
      turnAngleDegrees: roundNumber((turnMetrics.radians * 180) / Math.PI, 2),
      remainingTurnDegrees: roundNumber(turnStep.degrees, 2),
    };

    return {
      changed:
        distance(previousPosition, entity.position) > 1 ||
        distance(previousVelocity, entity.velocity) > 0.5,
    };
  }

  function getCarbonAgilitySeconds(entity) {
    const mass = Math.max(0, toFiniteNumber(entity && entity.mass, 0));
    const inertia = Math.max(0, toFiniteNumber(entity && entity.inertia, 0));
    const friction = Math.max(
      0.000001,
      toFiniteNumber(
        DESTINY_SPACE_FRICTION,
        DEFAULT_DESTINY_SPACE_FRICTION,
      ),
    );
    const nativeAgilitySeconds = (mass * inertia) / friction;
    if (nativeAgilitySeconds > 0) {
      return nativeAgilitySeconds;
    }
    return Math.max(
      toFiniteNumber(entity && entity.agilitySeconds, 0) ||
        deriveAgilitySeconds(
          entity && entity.alignTime,
          entity && entity.maxAccelerationTime,
          entity && entity.mass,
          entity && entity.inertia,
        ),
      0.05,
    );
  }

  function getCarbonCruiseVelocity(entity) {
    return Math.max(0, toFiniteNumber(entity && entity.maxVelocity, 0)) *
      clamp(
        toFiniteNumber(entity && entity.speedFraction, 0),
        0,
        MAX_SUBWARP_SPEED_FRACTION,
      );
  }

  function calculateCarbonGotoThrust(
    entity,
    targetPoint,
    deltaSeconds,
    options = {},
  ) {
    const target = cloneVector(targetPoint, entity && entity.position);
    const separation = subtractVectors(target, entity && entity.position);
    const separationSquared = Math.max(0, dotProduct(separation, separation));
    const separationDistance = Math.sqrt(separationSquared);
    const cruiseVelocity = getCarbonCruiseVelocity(entity);
    const agilitySeconds = getCarbonAgilitySeconds(entity);
    const maximumAcceleration = cruiseVelocity / agilitySeconds;
    const stepDistance = cruiseVelocity * Math.max(
      0,
      toFiniteNumber(deltaSeconds, 0),
    );
    let homingScale = 1;
    if (
      stepDistance > 0.000000001 &&
      separationSquared < (stepDistance * stepDistance)
    ) {
      const coefficient = separationSquared / (stepDistance * stepDistance);
      homingScale = coefficient * coefficient;
    }
    homingScale = Math.max(
      homingScale,
      clamp(toFiniteNumber(options.minHomingScale, 0), 0, 1),
    );
    const acceleration = separationDistance > 0.000000001
      ? scaleVector(
          separation,
          (maximumAcceleration * homingScale) / separationDistance,
        )
      : { x: 0, y: 0, z: 0 };
    return {
      acceleration,
      agilitySeconds,
      cruiseVelocity,
      homingScale,
      maximumAcceleration,
      separationDistance,
      stepDistance,
      targetPoint: target,
    };
  }

  function applyCarbonAcceleration(
    entity,
    acceleration,
    deltaSeconds,
    debug = null,
  ) {
    const agilitySeconds = getCarbonAgilitySeconds(entity);
    const desiredVelocity = scaleVector(acceleration, agilitySeconds);
    const desiredSpeed = magnitude(desiredVelocity);
    const desiredDirection = desiredSpeed > 0.000000001
      ? normalizeVector(desiredVelocity, entity.direction)
      : normalizeVector(entity.direction, DEFAULT_RIGHT);
    const headingSource = normalizeVector(entity.direction, desiredDirection);
    const currentSpeedFraction =
      entity.maxVelocity > 0
        ? Math.max(0, magnitude(entity.velocity) / entity.maxVelocity)
        : 0;
    const turnStep = rotateDirectionToward(
      headingSource,
      desiredDirection,
      deltaSeconds,
      agilitySeconds,
      currentSpeedFraction,
    );
    const previousPosition = cloneVector(entity.position);
    const previousVelocity = cloneVector(entity.velocity);

    // Retain the legacy diagnostics/turn calculation, but commit translation
    // through Carbon's unsnapped analytic integrator. The generic host kernel
    // intentionally settles tiny velocities for legacy callers; native
    // Ballpark integration does not.
    const motionEntity = Object.create(entity);
    motionEntity.position = cloneVector(entity.position);
    motionEntity.velocity = cloneVector(entity.velocity);
    motionEntity.direction = cloneVector(entity.direction, desiredDirection);
    motionEntity.agilitySeconds = agilitySeconds;
    const result = applyDesiredVelocity(
      motionEntity,
      desiredDirection,
      desiredSpeed,
      deltaSeconds,
    );
    const officialInertialMass =
      Math.max(0, toFiniteNumber(entity && entity.mass, 0)) *
      Math.max(0, toFiniteNumber(entity && entity.inertia, 0));
    const carbonMotion = integrateCarbonMotion(
      previousPosition,
      previousVelocity,
      acceleration,
      officialInertialMass > 0
        ? officialInertialMass
        : agilitySeconds * DESTINY_SPACE_FRICTION,
      DESTINY_SPACE_FRICTION,
      deltaSeconds,
    );
    entity.position = cloneVector(carbonMotion.position);
    entity.velocity = cloneVector(carbonMotion.velocity);
    // Carbon translation and hull orientation are separate. Keep the existing
    // compact torque authority instead of deriving heading from velocity.
    entity.direction = cloneVector(turnStep.direction, desiredDirection);
    entity.lastTurnMetrics = motionEntity.lastTurnMetrics;
    entity.lastMotionDebug = {
      ...motionEntity.lastMotionDebug,
      nextSpeed: roundNumber(magnitude(entity.velocity), 3),
      positionDelta: summarizeVector(
        subtractVectors(entity.position, previousPosition),
      ),
      velocityDelta: summarizeVector(
        subtractVectors(entity.velocity, previousVelocity),
      ),
    };
    entity.lastCarbonMotion = {
      ...(debug && typeof debug === "object" ? debug : {}),
      acceleration: summarizeVector(acceleration),
      agilitySeconds: roundNumber(agilitySeconds, 6),
      desiredSteadyVelocity: summarizeVector(desiredVelocity),
    };
    return {
      ...result,
      changed:
        distance(previousPosition, entity.position) > 1 ||
        distance(previousVelocity, entity.velocity) > 0.5,
    };
  }

  function calculateCarbonFollowPlan(entity, target, deltaSeconds) {
    const motionProfile = getFollowMotionProfile(entity, target);
    const targetPosition = cloneVector(
      motionProfile && motionProfile.targetPoint,
      target && target.position,
    );
    const targetToFollower = subtractVectors(entity.position, targetPosition);
    const centerDistance = magnitude(targetToFollower);
    const desiredDistance = Math.max(
      0,
      toFiniteNumber(entity.followRange, 0) +
        Math.max(0, toFiniteNumber(entity.radius, 0)) +
        Math.max(
          0,
          toFiniteNumber(
            motionProfile && motionProfile.rangeRadius,
            target && target.radius,
          ),
        ),
    );
    const gotoPoint = centerDistance <= 0.000000001
      ? addVectors(
          targetPosition,
          scaleVector(DEFAULT_RIGHT, desiredDistance),
        )
      : addVectors(
          targetPosition,
          scaleVector(
            targetToFollower,
            desiredDistance / centerDistance,
          ),
        );
    const fromFollowerToTarget = centerDistance > 0.000000001
      ? scaleVector(targetToFollower, -1 / centerDistance)
      : normalizeVector(target && target.velocity, entity && entity.direction);
    const gap = Math.max(0, centerDistance - desiredDistance);
    const cruiseVelocity = getCarbonCruiseVelocity(entity);
    const targetVelocity = cloneVector(target && target.velocity);
    const targetRadialSpeed = dotProduct(targetVelocity, fromFollowerToTarget);
    const closingVelocity = Math.max(0, cruiseVelocity - targetRadialSpeed);
    const desiredClosingVelocity = Math.max(
      gap * 0.5,
      cruiseVelocity * 0.25,
    );
    const minHomingScale =
      gap > 50 && cruiseVelocity > 0.000001
        ? clamp(
            (Math.max(0, targetRadialSpeed) + desiredClosingVelocity) /
              cruiseVelocity,
            0,
            1,
          )
        : 0;
    const leadSeconds =
      gap > 50 && magnitude(targetVelocity) > 0.000001
        ? clamp(
            closingVelocity > 0.000001
              ? gap / closingVelocity
              : Math.max(1, toFiniteNumber(deltaSeconds, 0)),
            Math.max(1, toFiniteNumber(deltaSeconds, 0)),
            5,
          )
        : 0;
    const pursuitPoint = leadSeconds > 0
      ? addVectors(gotoPoint, scaleVector(targetVelocity, leadSeconds))
      : gotoPoint;
    const thrust = calculateCarbonGotoThrust(
      entity,
      pursuitPoint,
      deltaSeconds,
      {
        minHomingScale,
      },
    );
    return {
      ...thrust,
      centerDistance,
      desiredDistance,
      gotoPoint,
      leadSeconds,
      pursuitPoint,
      targetPosition,
    };
  }

  function getCarbonOrbitSeed(entity) {
    const numericID = normalizeEntityID(entity && entity.itemID, {
      preferBigInt: true,
    });
    return numericID === null ? 0 : Number(numericID & 0xffffn);
  }

  function getCarbonDefaultOrbitNormal(entity, nowMs) {
    const currentTick = getCurrentDestinyStamp(toFiniteNumber(nowMs, 0));
    const phase = currentTick * DESTINY_ORBITAL_PRECESSION_PER_TICK;
    const seededPhase = getCarbonOrbitSeed(entity) + phase;
    const truncateSeven = (value) => Math.trunc(value * 10_000_000) / 10_000_000;
    return {
      x: truncateSeven(Math.cos(phase) * Math.cos(seededPhase)),
      y: truncateSeven(Math.sin(seededPhase)),
      z: truncateSeven(Math.sin(phase) * Math.cos(seededPhase)),
    };
  }

  function normalizeCarbonOrbitVector(vector) {
    const length = magnitude(vector);
    return length > 0.000000001
      ? scaleVector(vector, 1 / length)
      : { x: 0, y: 0, z: 0 };
  }

  function calculateCarbonOrbitPlan(entity, target, _deltaSeconds, nowMs = 0) {
    const cruiseVelocity = getCarbonCruiseVelocity(entity);
    const agilitySeconds = getCarbonAgilitySeconds(entity);
    const maximumAcceleration = cruiseVelocity / agilitySeconds;
    const desiredDistance = Math.max(
      0,
      toFiniteNumber(entity.orbitDistance, 0) +
        Math.max(0, toFiniteNumber(entity.radius, 0)) +
        Math.max(0, toFiniteNumber(target && target.radius, 0)),
    );
    const targetPosition = cloneVector(target && target.position);
    const rawToTarget = subtractVectors(targetPosition, entity.position);
    const rawDistance = magnitude(rawToTarget);
    let toDirection = rawDistance > 0.000000001
      ? scaleVector(rawToTarget, 1 / rawDistance)
      : { x: 0, y: 0, z: 0 };
    const orbitNormal = getCarbonDefaultOrbitNormal(entity, nowMs);
    const tangentDirection = normalizeCarbonOrbitVector(
      crossProduct(orbitNormal, toDirection),
    );

    const tangentDistanceSquared =
      (rawDistance * rawDistance) - (desiredDistance * desiredDistance);
    if (tangentDistanceSquared >= 0 && rawDistance > 0.000000001) {
      const tangentComponent =
        (desiredDistance * Math.sqrt(tangentDistanceSquared)) / rawDistance;
      toDirection = normalizeCarbonOrbitVector(
        addVectors(
          scaleVector(toDirection, tangentDistanceSquared / rawDistance),
          scaleVector(tangentDirection, tangentComponent),
        ),
      );
    }

    const truncateSeven = (value) => Math.trunc(value * 10_000_000) / 10_000_000;
    const radialFactor = truncateSeven(
      Math.exp(
        -(
          (desiredDistance - rawDistance) *
          (desiredDistance - rawDistance)
        ) / 40_000,
      ),
    );
    const oppositeCosine = -dotProduct(toDirection, tangentDirection);
    const determinant =
      1 +
      (radialFactor * radialFactor * ((oppositeCosine * oppositeCosine) - 1));
    let transverseFactor = determinant > 0
      ? (radialFactor * oppositeCosine) + Math.sqrt(determinant)
      : radialFactor * oppositeCosine;
    transverseFactor *= Math.sign(rawDistance - desiredDistance);
    const acceleration = scaleVector(
      addVectors(
        scaleVector(tangentDirection, radialFactor),
        scaleVector(toDirection, transverseFactor),
      ),
      maximumAcceleration,
    );
    const gotoPoint = addVectors(
      entity.position,
      scaleVector(acceleration, 10 * 149_597_870_700),
    );
    return {
      acceleration,
      cruiseVelocity,
      desiredDistance,
      gotoPoint,
      maximumAcceleration,
      orbitNormal,
      radialFactor,
      rawDistance,
      targetPosition,
      tangentDirection,
      toDirection,
      transverseFactor,
    };
  }

  function advanceGotoMovement(entity, deltaSeconds) {
    const desiredDirection = getCommandDirection(entity, entity.direction);
    const desiredSpeed =
      entity.maxVelocity * clamp(entity.speedFraction, 0, MAX_SUBWARP_SPEED_FRACTION);
    const result = applyDesiredVelocity(
      entity,
      desiredDirection,
      desiredSpeed,
      deltaSeconds,
    );
    const strafeChanged = applyManualStrafingThrust(entity, deltaSeconds);
    return {
      ...result,
      changed: result.changed || strafeChanged,
    };
  }

  function hasManualStrafingThrust(entity) {
    return Boolean(
      entity &&
      entity.manualFlightActive === true &&
      magnitude(entity.manualStrafingThrust || { x: 0, y: 0, z: 0 }) >
        0.000001
    );
  }

  function applyManualStrafingThrust(entity, deltaSeconds) {
    if (!hasManualStrafingThrust(entity) || entity.mode !== "GOTO") {
      return false;
    }

    const delta = Math.max(0, toFiniteNumber(deltaSeconds, 0));
    if (delta <= 0) {
      return false;
    }
    const thrust = cloneVector(entity.manualStrafingThrust);
    const forwardDirection = normalizeVector(entity.direction, DEFAULT_RIGHT);
    const horizontalDirection = normalizeVector(
      buildPerpendicular(forwardDirection),
      DEFAULT_RIGHT,
    );
    const verticalDirection = normalizeVector(
      crossProduct(horizontalDirection, forwardDirection),
      DEFAULT_WORLD_UP,
    );
    const acceleration = addVectors(
      scaleVector(verticalDirection, thrust.x),
      scaleVector(horizontalDirection, thrust.y),
    );
    const velocityDelta = scaleVector(acceleration, delta);
    const positionDelta = scaleVector(acceleration, 0.5 * delta * delta);
    entity.velocity = addVectors(entity.velocity, velocityDelta);
    entity.position = addVectors(entity.position, positionDelta);
    entity.direction = forwardDirection;
    entity.lastMotionDebug = {
      ...(entity.lastMotionDebug || {}),
      manualStrafingThrust: summarizeVector(thrust),
      manualStrafingAcceleration: summarizeVector(acceleration),
      manualStrafingVelocityDelta: summarizeVector(velocityDelta),
      manualStrafingPositionDelta: summarizeVector(positionDelta),
    };
    return magnitude(acceleration) > 0.000001;
  }

  function advanceManualFlightTarget(entity, deltaSeconds) {
    if (
      !entity ||
      entity.manualFlightActive !== true ||
      entity.mode !== "GOTO"
    ) {
      return false;
    }

    const delta = Math.max(0, toFiniteNumber(deltaSeconds, 0));
    const currentDirection = normalizeVector(entity.direction, DEFAULT_RIGHT);
    const maxAngularSpeed = Math.max(
      0,
      toFiniteNumber(entity.maxAngularSpeed, 0.25),
    );
    const pitchTarget = clamp(
      toFiniteNumber(entity.manualPitch, 0),
      -1,
      1,
    ) * (Math.PI / 2);
    const currentPitch = Math.asin(clamp(currentDirection.y, -1, 1));
    const maximumPitchStep = maxAngularSpeed * delta;
    const pitchError = pitchTarget - currentPitch;
    const pitchStep = clamp(
      pitchError,
      -maximumPitchStep,
      maximumPitchStep,
    );
    const nextPitch = clamp(
      currentPitch + pitchStep,
      -(Math.PI / 2),
      Math.PI / 2,
    );
    const currentYaw = Math.atan2(currentDirection.x, currentDirection.z);
    const yawVelocity = clamp(
      toFiniteNumber(entity.manualYawRate, 0),
      -1,
      1,
    ) * maxAngularSpeed;
    const nextYaw = currentYaw + (yawVelocity * delta);
    const pitchCosine = Math.cos(nextPitch);
    const commandDirection = normalizeVector({
      x: Math.sin(nextYaw) * pitchCosine,
      y: Math.sin(nextPitch),
      z: Math.cos(nextYaw) * pitchCosine,
    }, currentDirection);

    entity.manualPitchVelocity = delta > 0 ? pitchStep / delta : 0;
    entity.manualYawVelocity = yawVelocity;
    entity.angularVelocity = {
      x: entity.manualPitchVelocity,
      y: entity.manualYawVelocity,
      z: 0,
    };
    entity.targetPoint = addVectors(
      cloneVector(entity.position),
      scaleVector(commandDirection, 1.0e16),
    );
    return true;
  }

  function resolveMissileFollowRange(missileRadius, targetRadius) {
    const resolvedMissileRadius = Math.max(0, toFiniteNumber(missileRadius, 0));
    const resolvedTargetRadius = Math.max(0, toFiniteNumber(targetRadius, 0));
    return -(resolvedMissileRadius + resolvedTargetRadius);
  }

  function getMissileImpactDistance(entity, target) {
    // CCP's client missile ETA/collision presentation uses the target ball's
    // radius only. The missile ball radius affects visuals/torque, but tearing
    // the missile down on missileRadius + targetRadius removes it a tick early
    // and produces the visible "fizzle short of target" the client logs show.
    return Math.max(
      0,
      distance(entity && entity.position, target && target.position) - Math.max(
        1,
        toFiniteNumber(target && target.radius, 0),
      ),
    );
  }

  function resolveMissileTargetStepStartPosition(target, deltaSeconds) {
    const currentTargetPosition = cloneVector(target && target.position);
    if (!target || Math.max(0, toFiniteNumber(deltaSeconds, 0)) <= 0.000001) {
      return currentTargetPosition;
    }

    const motionDebug =
      target.lastMotionDebug &&
      typeof target.lastMotionDebug === "object"
        ? target.lastMotionDebug
        : null;
    if (motionDebug && motionDebug.previousPosition) {
      return cloneVector(motionDebug.previousPosition, currentTargetPosition);
    }

    return subtractVectors(
      currentTargetPosition,
      scaleVector(target.velocity || { x: 0, y: 0, z: 0 }, deltaSeconds),
    );
  }

  // Missile-only swept impact is the narrow collision exception required by
  // Trinity presentation. It must never be reused for ship/static contact.
  function resolveMissileSweptImpact(
    missileStartPosition,
    missileVelocity,
    targetStartPosition,
    targetEndPosition,
    targetRadius,
    deltaSeconds,
  ) {
    const stepSeconds = Math.max(0, toFiniteNumber(deltaSeconds, 0));
    const impactRadius = Math.max(1, toFiniteNumber(targetRadius, 0));
    const normalizedMissileStart = cloneVector(missileStartPosition);
    const normalizedTargetStart = cloneVector(targetStartPosition);
    const normalizedTargetEnd = cloneVector(targetEndPosition);
    const missileStepVelocity = cloneVector(missileVelocity);
    const targetStepVelocity =
      stepSeconds > 0.000001
        ? scaleVector(
            subtractVectors(normalizedTargetEnd, normalizedTargetStart),
            1 / stepSeconds,
          )
        : { x: 0, y: 0, z: 0 };
    const relativeStart = subtractVectors(
      normalizedMissileStart,
      normalizedTargetStart,
    );
    const relativeVelocity = subtractVectors(
      missileStepVelocity,
      targetStepVelocity,
    );
    const relativeVelocityMagnitudeSquared = dotProduct(
      relativeVelocity,
      relativeVelocity,
    );
    const startCenterDistance = magnitude(relativeStart);
    const startSurfaceDistance = Math.max(0, startCenterDistance - impactRadius);
    let closestTimeSeconds = 0;
    if (relativeVelocityMagnitudeSquared > 0.000001) {
      closestTimeSeconds = clamp(
        -dotProduct(relativeStart, relativeVelocity) /
          relativeVelocityMagnitudeSquared,
        0,
        stepSeconds,
      );
    }
    const relativeClosestVector = addVectors(
      relativeStart,
      scaleVector(relativeVelocity, closestTimeSeconds),
    );
    const closestCenterDistance = magnitude(relativeClosestVector);
    const closestSurfaceDistance = Math.max(
      0,
      closestCenterDistance - impactRadius,
    );
    const quadraticB = 2 * dotProduct(relativeStart, relativeVelocity);
    const quadraticC =
      dotProduct(relativeStart, relativeStart) - (impactRadius * impactRadius);
    let impactTimeSeconds = null;
    let collisionReason = null;
    if (quadraticC <= 0) {
      impactTimeSeconds = 0;
      collisionReason = "already-inside-radius";
    } else if (relativeVelocityMagnitudeSquared > 0.000001) {
      const discriminant =
        (quadraticB * quadraticB) -
        (4 * relativeVelocityMagnitudeSquared * quadraticC);
      if (discriminant >= 0) {
        const sqrtDiscriminant = Math.sqrt(discriminant);
        const candidateTimes = [
          (-quadraticB - sqrtDiscriminant) / (2 * relativeVelocityMagnitudeSquared),
          (-quadraticB + sqrtDiscriminant) / (2 * relativeVelocityMagnitudeSquared),
        ].filter((candidate) =>
          Number.isFinite(candidate) &&
          candidate >= -0.000001 &&
          candidate <= stepSeconds + 0.000001
        );
        if (candidateTimes.length > 0) {
          impactTimeSeconds = clamp(
            Math.min(...candidateTimes),
            0,
            stepSeconds,
          );
          collisionReason = "relative-sweep";
        }
      }
    }

    if (!Number.isFinite(impactTimeSeconds)) {
      impactTimeSeconds = null;
      collisionReason = null;
    }

    const resolvedImpactTimeSeconds =
      impactTimeSeconds === null
        ? closestTimeSeconds
        : impactTimeSeconds;
    const missileImpactPosition = addVectors(
      normalizedMissileStart,
      scaleVector(missileStepVelocity, resolvedImpactTimeSeconds),
    );
    const targetImpactPosition = addVectors(
      normalizedTargetStart,
      scaleVector(targetStepVelocity, resolvedImpactTimeSeconds),
    );

    return {
      impactOccurred: impactTimeSeconds !== null,
      collisionReason,
      impactTimeSeconds:
        impactTimeSeconds === null
          ? null
          : roundNumber(impactTimeSeconds, 6),
      impactTimeMs:
        impactTimeSeconds === null
          ? null
          : roundNumber(impactTimeSeconds * 1000, 3),
      closestTimeSeconds: roundNumber(closestTimeSeconds, 6),
      startSurfaceDistance: roundNumber(startSurfaceDistance, 6),
      closestSurfaceDistance: roundNumber(closestSurfaceDistance, 6),
      missileImpactPosition: summarizeVector(missileImpactPosition),
      targetImpactPosition: summarizeVector(targetImpactPosition),
      targetStepStartPosition: summarizeVector(normalizedTargetStart),
      targetStepVelocity: summarizeVector(targetStepVelocity),
    };
  }

  function advanceMissileMovement(entity, target, deltaSeconds, nowMs) {
    const previousPosition = cloneVector(entity.position);
    const previousVelocity = cloneVector(entity.velocity);
    if (entity.pendingGeometryImpact === true) {
      const frozenPosition = cloneVector(
        entity.pendingGeometryImpactPosition,
        entity.position,
      );
      entity.position = frozenPosition;
      entity.targetPoint = cloneVector(frozenPosition);
      entity.velocity = { x: 0, y: 0, z: 0 };
      entity.speedFraction = 0;
      entity.lastMissileStep = {
        previousPosition,
        targetPosition: target ? cloneVector(target.position) : null,
        deltaSeconds: roundNumber(Math.max(0, deltaSeconds), 6),
        stepDistance: 0,
        surfaceDistanceBefore: target
          ? roundNumber(getMissileImpactDistance(entity, target), 6)
          : Number.POSITIVE_INFINITY,
        surfaceDistanceAfter: target
          ? roundNumber(getMissileImpactDistance(entity, target), 6)
          : Number.POSITIVE_INFINITY,
        reachedImpactSurface: true,
        frozenAtGeometryImpact: true,
        legacyHeuristicImpactSurface: false,
        pendingGeometryImpactAtMs: roundNumber(
          toFiniteNumber(entity.pendingGeometryImpactAtMs, 0),
          3,
        ),
        impactPosition: summarizeVector(frozenPosition),
        sweptImpact: {
          impactOccurred: true,
          collisionReason: String(entity.pendingGeometryImpactReason || "pending-impact"),
          impactTimeSeconds: 0,
          impactTimeMs: 0,
          closestTimeSeconds: 0,
          startSurfaceDistance: target
            ? roundNumber(getMissileImpactDistance(entity, target), 6)
            : null,
          closestSurfaceDistance: target
            ? roundNumber(getMissileImpactDistance(entity, target), 6)
            : null,
          missileImpactPosition: summarizeVector(frozenPosition),
          targetImpactPosition: target ? summarizeVector(target.position) : null,
          targetStepStartPosition: target ? summarizeVector(target.position) : null,
          targetStepVelocity: target ? summarizeVector(target.velocity) : null,
        },
      };
      return { changed: false };
    }
    if (!target) {
      entity.lastMissileStep = {
        previousPosition,
        targetPosition: null,
        deltaSeconds: roundNumber(deltaSeconds, 6),
        stepDistance: 0,
        surfaceDistanceBefore: Number.POSITIVE_INFINITY,
        surfaceDistanceAfter: Number.POSITIVE_INFINITY,
        reachedImpactSurface: false,
        frozenAtGeometryImpact: false,
        legacyHeuristicImpactSurface: false,
        sweptImpact: null,
      };
      return { changed: false };
    }

    const targetPosition = cloneVector(target.position);
    const targetStepStartPosition = resolveMissileTargetStepStartPosition(
      target,
      deltaSeconds,
    );
    const desiredDirection = normalizeVector(
      subtractVectors(targetPosition, previousPosition),
      entity.direction,
    );
    const stepStartMs = Math.max(
      0,
      toFiniteNumber(nowMs, 0) - (Math.max(0, deltaSeconds) * 1000),
    );
    const launchAtMs = Math.max(
      0,
      toFiniteNumber(entity.launchedAtMs, stepStartMs),
    );
    // Missile cycles can resolve partway through the current scene tick. Do not
    // let a newly launched missile consume the whole tick's delta as if it had
    // already existed at step start, or short flights will overshoot and fizzle
    // before the client ever sees the proper launch arc.
    const activeStepStartMs = Math.max(stepStartMs, launchAtMs);
    const activeDeltaSeconds = Math.max(
      0,
      (Math.max(activeStepStartMs, toFiniteNumber(nowMs, 0)) - activeStepStartMs) /
        1000,
    );
    const remainingFlightSeconds =
      toFiniteNumber(entity.expiresAtMs, 0) > 0
        ? Math.max(
            0,
            (toFiniteNumber(entity.expiresAtMs, 0) - activeStepStartMs) / 1000,
          )
        : Math.max(0, deltaSeconds);
    const effectiveDeltaSeconds = Math.min(
      Math.max(0, deltaSeconds),
      activeDeltaSeconds,
      remainingFlightSeconds,
    );
    const surfaceDistanceBefore = getMissileImpactDistance(entity, target);
    const desiredSpeed = Math.max(0, toFiniteNumber(entity.maxVelocity, 0));
    const desiredVelocity = scaleVector(desiredDirection, desiredSpeed);
    entity.targetPoint = targetPosition;
    entity.followRange = resolveMissileFollowRange(
      entity.radius,
      target && target.radius,
    );
    entity.speedFraction = desiredSpeed > 0 ? 1 : 0;
    // Missile charges carry extremely small authored agility values on the live
    // Destiny ball. The client therefore flies them as near-instant homing
    // projectiles. Reusing the ship-style turn cap here left the server missile
    // path materially behind the client's local collision path, which is exactly
    // how we ended up with "damage applied but visual fizzle" outcomes.
    // CCP's missile model applies source-ship velocity in the launcher/warhead
    // animation path, but the live Destiny missile ball still flies at its own
    // max speed. Injecting the source ship's world velocity here made missile
    // balls outrun `maxVelocity` and visibly rebase the whole launch relative to
    // the ship on active volleys.
    entity.direction = desiredSpeed > 0
      ? desiredDirection
      : normalizeVector(entity.direction, desiredDirection);
    entity.velocity = desiredSpeed > 0
      ? desiredVelocity
      : { x: 0, y: 0, z: 0 };
    entity.position = addVectors(
      previousPosition,
      scaleVector(entity.velocity, effectiveDeltaSeconds),
    );
    const stepDistance = distance(previousPosition, entity.position);
    let surfaceDistanceAfter = getMissileImpactDistance(entity, target);
    const sweptImpact = resolveMissileSweptImpact(
      previousPosition,
      entity.velocity,
      targetStepStartPosition,
      targetPosition,
      Math.max(1, toFiniteNumber(target.radius, 0)),
      effectiveDeltaSeconds,
    );
    const rawSurfaceDistanceAfter = surfaceDistanceAfter;
    const legacyHeuristicImpactSurface =
      rawSurfaceDistanceAfter <= 0.001 ||
      surfaceDistanceBefore <= (stepDistance + 0.001);
    if (sweptImpact.impactOccurred) {
      const impactPosition = cloneVector(
        sweptImpact.missileImpactPosition,
        entity.position,
      );
      entity.pendingGeometryImpact = true;
      entity.pendingGeometryImpactReason = sweptImpact.collisionReason || "relative-sweep";
      entity.pendingGeometryImpactAtMs = roundNumber(
        Math.max(
          stepStartMs,
          activeStepStartMs + (toFiniteNumber(sweptImpact.impactTimeMs, 0)),
        ),
        3,
      );
      entity.pendingGeometryImpactPosition = impactPosition;
      entity.position = impactPosition;
      entity.targetPoint = cloneVector(
        sweptImpact.targetImpactPosition,
        targetPosition,
      );
      entity.velocity = { x: 0, y: 0, z: 0 };
      entity.speedFraction = 0;
      surfaceDistanceAfter = getMissileImpactDistance(entity, target);
      logMissileDebug("missile.geometry-impact-detected", {
        atMs: roundNumber(toFiniteNumber(nowMs, 0), 3),
        missile: summarizeMissileEntity(entity),
        target: summarizeRuntimeEntityForMissileDebug(target),
        previousPosition: summarizeVector(previousPosition),
        deltaSeconds: roundNumber(effectiveDeltaSeconds, 6),
        unclampedSurfaceDistanceAfter: roundNumber(rawSurfaceDistanceAfter, 6),
        clampedSurfaceDistanceAfter: roundNumber(surfaceDistanceAfter, 6),
        sweptImpact: normalizeTraceValue(sweptImpact),
      });
    }
    entity.lastMissileStep = {
      previousPosition,
      targetStepStartPosition,
      targetPosition,
      deltaSeconds: roundNumber(effectiveDeltaSeconds, 6),
      stepDistance: roundNumber(stepDistance, 6),
      surfaceDistanceBefore: roundNumber(surfaceDistanceBefore, 6),
      surfaceDistanceAfter: roundNumber(surfaceDistanceAfter, 6),
      rawSurfaceDistanceAfter: roundNumber(rawSurfaceDistanceAfter, 6),
      reachedImpactSurface:
        surfaceDistanceAfter <= 0.001 ||
        sweptImpact.impactOccurred,
      frozenAtGeometryImpact: sweptImpact.impactOccurred,
      legacyHeuristicImpactSurface,
      pendingGeometryImpactAtMs: roundNumber(
        toFiniteNumber(entity.pendingGeometryImpactAtMs, 0),
        3,
      ),
      impactPosition: sweptImpact.impactOccurred
        ? summarizeVector(entity.position)
        : null,
      sweptImpact,
    };

    return {
      changed:
        distance(previousPosition, entity.position) > 1 ||
        distance(previousVelocity, entity.velocity) > 0.5,
    };
  }

  function advanceFollowMovement(entity, target, deltaSeconds) {
    if (!target) {
      entity.mode = "STOP";
      entity.speedFraction = 0;
      entity.velocity = { x: 0, y: 0, z: 0 };
      entity.targetPoint = cloneVector(entity.position);
      entity.dockingTargetID = null;
      return { changed: true };
    }

    const motionProfile = getFollowMotionProfile(entity, target);
    const targetPoint = motionProfile.targetPoint;
    const separation = subtractVectors(targetPoint, entity.position);
    const currentDistance = magnitude(separation);
    const desiredRange = Math.max(
      0,
      toFiniteNumber(entity.followRange, 0) +
        entity.radius +
        motionProfile.rangeRadius,
    );
    const gap = currentDistance - desiredRange;
    const targetSpeed = magnitude(target.velocity || { x: 0, y: 0, z: 0 });
    const radialDirection = normalizeVector(separation, entity.direction);
    const targetRadialSpeed = dotProduct(
      target.velocity || { x: 0, y: 0, z: 0 },
      radialDirection,
    );
    const desiredDirection =
      gap > 50
        ? radialDirection
        : normalizeVector(target.velocity, normalizeVector(separation, entity.direction));
    const desiredSpeed =
      gap > 50
        ? Math.min(
            entity.maxVelocity,
            Math.max(
              0,
              targetRadialSpeed +
                Math.max(gap * 0.5, entity.maxVelocity * 0.25),
            ),
          )
        : Math.min(entity.maxVelocity, targetSpeed);

    entity.targetPoint = targetPoint;
    const movementResult = applyDesiredVelocity(
      entity,
      desiredDirection,
      desiredSpeed,
      deltaSeconds,
    );

    return movementResult;
  }

  function advanceOrbitMovement(entity, target, deltaSeconds) {
    if (!target) {
      entity.mode = "STOP";
      entity.speedFraction = 0;
      entity.velocity = { x: 0, y: 0, z: 0 };
      entity.targetPoint = cloneVector(entity.position);
      return { changed: true };
    }

    const radialVector = subtractVectors(entity.position, target.position);
    const radialDirection = normalizeVector(radialVector, buildPerpendicular(entity.direction));
    let orbitNormal = normalizeVector(entity.orbitNormal, buildPerpendicular(radialDirection));
    if (Math.abs(dotProduct(orbitNormal, radialDirection)) > 0.95) {
      orbitNormal = buildPerpendicular(radialDirection);
    }

    const tangentDirection = normalizeVector(
      scaleVector(crossProduct(orbitNormal, radialDirection), entity.orbitSign || 1),
      entity.direction,
    );
    const currentDistance = magnitude(radialVector);
    const desiredDistance = Math.max(
      toFiniteNumber(entity.orbitDistance, 0) + entity.radius + (target.radius || 0),
      entity.radius + (target.radius || 0) + 500,
    );
    const radialError = currentDistance - desiredDistance;
    const correction = scaleVector(
      radialDirection,
      clamp(-radialError / Math.max(desiredDistance, 1), -0.75, 0.75),
    );
    const desiredDirection = normalizeVector(
      addVectors(tangentDirection, correction),
      tangentDirection,
    );
    const desiredSpeed = clamp(
      Math.max(entity.maxVelocity * 0.35, Math.abs(radialError) * 0.5),
      0,
      entity.maxVelocity,
    );

    entity.orbitNormal = orbitNormal;
    entity.targetPoint = addVectors(
      target.position,
      scaleVector(radialDirection, desiredDistance),
    );
    return applyDesiredVelocity(entity, desiredDirection, desiredSpeed, deltaSeconds);
  }

  function advanceMovement(entity, scene, deltaSeconds, now) {
    advanceManualFlightTarget(entity, deltaSeconds);
    switch (entity.mode) {
      case "STOP":
        return applyDesiredVelocity(entity, entity.direction, 0, deltaSeconds);
      case "GOTO":
        return advanceGotoMovement(entity, deltaSeconds);
      case "FOLLOW":
        return advanceFollowMovement(
          entity,
          scene.getEntityByID(entity.targetEntityID),
          deltaSeconds,
        );
      case "MISSILE":
        return advanceMissileMovement(
          entity,
          scene.getEntityByID(entity.targetEntityID),
          deltaSeconds,
          now,
        );
      case "ORBIT":
        return advanceOrbitMovement(
          entity,
          scene.getEntityByID(entity.targetEntityID),
          deltaSeconds,
        );
      case "WARP": {
        if (entity.pendingWarp) {
          const result = advanceGotoMovement(entity, deltaSeconds);
          refreshPreparingWarpState(entity);
          return result;
        }
        if (
          entity.sessionlessWarpIngress &&
          entity.sessionlessWarpIngress.useNativeWarpProfile !== true
        ) {
          return advanceSessionlessWarpIngress(entity, now);
        }
        if (!entity.warpState) {
          entity.mode = "STOP";
          entity.speedFraction = 0;
          entity.velocity = { x: 0, y: 0, z: 0 };
          entity.targetPoint = cloneVector(entity.position);
          return { changed: false };
        }

        const nativeSessionlessIngress =
          entity.sessionlessWarpIngress &&
          entity.sessionlessWarpIngress.useNativeWarpProfile === true
            ? entity.sessionlessWarpIngress
            : null;
        const previousPosition = cloneVector(entity.position);
        const previousVelocity = cloneVector(entity.velocity);
        const nativeSample = acquireActiveWarpNativeSample(entity, now, {
          getCurrentDestinyStamp,
          intervalMs: DESTINY_STAMP_INTERVAL_MS,
        });
        if (!nativeSample.ready) {
          return {
            changed: false,
            nativeWarpSampleDeferred: true,
            nativeSampleStamp: nativeSample.currentStamp,
            nativeWarpModeledAtMs: Number.isFinite(
              Number(entity.warpState.nativeSampleAtMs),
            )
              ? Number(entity.warpState.nativeSampleAtMs)
              : toFiniteNumber(entity.warpState.startTimeMs, now),
          };
        }
        let sampledNativeTick = nativeSample.elapsedNativeTicks;
        let sampledAtMs = nativeSample.sampleAtMs;
        let sampledStamp = nativeSample.currentStamp;
        let progress = getWarpProgress(
          entity.warpState,
          sampledAtMs,
        );
        // A delayed host pulse can cross several canonical Destiny stamps.
        // Preserve the first discrete native dropout instead of evaluating
        // only the newest stamp and overshooting the modeled landing point.
        const firstUnsampledNativeTick = Math.max(
          1,
          toFiniteNumber(nativeSample.previousElapsedNativeTicks, 0) + 1,
        );
        if (
          progress.complete &&
          firstUnsampledNativeTick < sampledNativeTick
        ) {
          let low = firstUnsampledNativeTick;
          let high = sampledNativeTick;
          while (low < high) {
            const middle = low + Math.floor((high - low) / 2);
            const middleProgress = getWarpProgress(
              entity.warpState,
              toFiniteNumber(entity.warpState.startTimeMs, now) +
                (middle * DESTINY_STAMP_INTERVAL_MS),
            );
            if (middleProgress.complete) {
              high = middle;
            } else {
              low = middle + 1;
            }
          }
          sampledNativeTick = low;
          sampledAtMs = toFiniteNumber(entity.warpState.startTimeMs, now) +
            (sampledNativeTick * DESTINY_STAMP_INTERVAL_MS);
          sampledStamp = advanceDestinyStamp(
            nativeSample.activationStamp,
            sampledNativeTick,
          );
          progress = getWarpProgress(entity.warpState, sampledAtMs);
        }
        const direction = normalizeVector(
          subtractVectors(entity.warpState.targetPoint, entity.warpState.origin),
          entity.direction,
        );
        entity.direction = direction;
        const traveledDistance = Math.max(
          0,
          toFiniteNumber(progress.traveled, 0),
        );
        entity.position = addVectors(
          entity.warpState.origin,
          scaleVector(direction, traveledDistance),
        );
        entity.velocity = scaleVector(
          direction,
          Math.max(0, toFiniteNumber(progress.speed, 0)),
        );

        if (progress.complete) {
          const dropoutPosition = cloneVector(entity.position);
          const dropoutVelocity = cloneVector(entity.velocity);
          const completedWarpState = serializeWarpState({
            warpState: entity.warpState,
            position: entity.position,
          });
          completedWarpState.dropoutPosition = cloneVector(dropoutPosition);
          completedWarpState.dropoutVelocity = cloneVector(dropoutVelocity);
          completedWarpState.nativeDropout = progress.nativeDropout === true;
          completedWarpState.dropoutSpeedMs = Math.max(
            0,
            toFiniteNumber(progress.dropoutSpeedMs, 0),
          );
          completedWarpState.remainingDistance = Math.max(
            0,
            toFiniteNumber(entity.warpState.totalDistance, 0) -
              traveledDistance,
          );
          const _warpCompleteTargetEntity = entity.targetEntityID
            ? scene.getEntityByID(entity.targetEntityID)
            : null;
          const _warpCompleteTargetRadius = Math.max(
            0,
            toFiniteNumber(_warpCompleteTargetEntity && _warpCompleteTargetEntity.radius, 0),
          );
          const _warpCompleteDistCenter = _warpCompleteTargetEntity
            ? distance(entity.position, _warpCompleteTargetEntity.position)
            : null;
          const _warpCompleteDistEdge = _warpCompleteDistCenter !== null
            ? _warpCompleteDistCenter - _warpCompleteTargetRadius
            : null;
          log.info(
            `[WarpComplete] itemID=${entity.itemID} typeID=${entity.typeID} targetEntityID=${entity.targetEntityID || "none"}` +
            ` serverPos=(${Math.round(entity.position.x)},${Math.round(entity.position.y)},${Math.round(entity.position.z)})` +
            ` distToTargetCenter=${_warpCompleteDistCenter !== null ? Math.round(_warpCompleteDistCenter) : "n/a"}` +
            ` distToTargetEdge=${_warpCompleteDistEdge !== null ? Math.round(_warpCompleteDistEdge) : "n/a"}` +
            ` targetRadius=${_warpCompleteTargetRadius}`,
          );
          entity.mode = "STOP";
          entity.speedFraction = 0;
          entity.warpState = null;
          if (nativeSessionlessIngress) {
            entity.sessionlessWarpIngress = null;
          }
          const nativeStopEvolutionTicks = Math.max(
            1,
            Math.trunc(nativeSample.elapsedNativeTicks - sampledNativeTick) + 1,
          );
          const officialInertialMass =
            toFiniteNumber(entity.mass, 0) * toFiniteNumber(entity.inertia, 0);
          const fallbackInertialMass = Math.max(
            deriveAgilitySeconds(
              entity.alignTime,
              entity.maxAccelerationTime,
              entity.mass,
              entity.inertia,
            ),
            0.05,
          ) * 1_000_000;
          const stopEvolution = integrateCarbonMotion(
            entity.position,
            entity.velocity,
            { x: 0, y: 0, z: 0 },
            officialInertialMass > 0
              ? officialInertialMass
              : fallbackInertialMass,
            undefined,
            (nativeStopEvolutionTicks * DESTINY_STAMP_INTERVAL_MS) / 1000,
          );
          entity.position = cloneVector(stopEvolution.position);
          entity.velocity = cloneVector(stopEvolution.velocity);
          entity.targetPoint = cloneVector(entity.position);
          completedWarpState.exitPosition = cloneVector(entity.position);
          completedWarpState.exitVelocity = cloneVector(entity.velocity);
          completedWarpState.nativeCompletionStamp =
            sampledStamp;
          completedWarpState.nativeCompletionAtMs =
            nativeSample.nativeBoundaryAtMs;
          completedWarpState.nativeModeledCompletionAtMs =
            sampledAtMs;
          completedWarpState.nativeStopEvolutionTicks =
            nativeStopEvolutionTicks;
          // The same-tick STOP evolution is an interpolation endpoint, not a
          // missile target sweep spanning dropout to exit. Rebase the existing
          // diagnostic source to that endpoint.
          entity.lastMotionDebug = {
            ...(entity.lastMotionDebug || {}),
            deltaSeconds: 0,
            previousPosition: summarizeVector(entity.position),
            positionDelta: { x: 0, y: 0, z: 0 },
            previousVelocity: summarizeVector(entity.velocity),
            velocityDelta: { x: 0, y: 0, z: 0 },
          };
          return {
            changed:
              distance(previousPosition, entity.position) > 1 ||
              distance(previousVelocity, entity.velocity) > 0.5,
            warpCompleted: true,
            completedWarpState,
            suppressCompletionStopUpdates:
              nativeSessionlessIngress &&
              nativeSessionlessIngress.suppressCompletionStopUpdates === true,
            nativeWarpBoundaryAtMs: nativeSample.nativeBoundaryAtMs,
            nativeWarpModeledAtMs: sampledAtMs,
          };
        }

        return {
          changed:
            distance(previousPosition, entity.position) > 1 ||
            distance(previousVelocity, entity.velocity) > 0.5,
          nativeWarpBoundaryAtMs: nativeSample.nativeBoundaryAtMs,
          nativeWarpModeledAtMs: sampledAtMs,
        };
      }
      default:
        return { changed: false };
    }
  }

  return {
    advanceFollowMovement,
    advanceGotoMovement,
    advanceMissileMovement,
    advanceManualFlightTarget,
    advanceMovement,
    advanceOrbitMovement,
    applyManualStrafingThrust,
    applyCarbonAcceleration,
    applyDesiredVelocity,
    calculateCarbonFollowPlan,
    calculateCarbonGotoThrust,
    calculateCarbonOrbitPlan,
    deriveTurnDegreesPerTick,
    getCarbonAgilitySeconds,
    getCarbonCruiseVelocity,
    getCarbonDefaultOrbitNormal,
    getCommandDirection,
    getMissileImpactDistance,
    integrateVelocityTowardTarget,
    resolveMissileFollowRange,
    resolveMissileSweptImpact,
    resolveMissileTargetStepStartPosition,
    rotateDirectionToward,
    slerpDirection,
  };
}

module.exports = {
  createDestinyMovementSimulator,
};
