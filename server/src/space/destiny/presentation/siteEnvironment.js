"use strict";

const {
  DESTINY_BOOTSTRAP_DELIVERY_ADDBALLS2,
} = require("../bootstrap/staticBootstrap");
const {
  BALL_FLAG,
} = require("../constants");

const DESTINY_BALL_FLAG = Object.freeze({
  IS_FREE: BALL_FLAG.IS_FREE,
  IS_GLOBAL: BALL_FLAG.IS_GLOBAL,
  IS_MASSIVE: BALL_FLAG.IS_MASSIVE,
  IS_INTERACTIVE: BALL_FLAG.IS_INTERACTIVE,
});

function toPositiveFiniteNumber(values, fallback = 1) {
  for (const value of values) {
    let numeric;
    try {
      numeric = Number(value);
    } catch (_error) {
      continue;
    }
    if (Number.isFinite(numeric) && numeric > 0) {
      return numeric;
    }
  }
  return fallback;
}

function hasExplicitAddBalls2Delivery(source = {}) {
  const value = source.destinyBootstrapDelivery ?? source.bootstrapDelivery;
  return (
    typeof value === "string" &&
    value.trim().toLowerCase() ===
      DESTINY_BOOTSTRAP_DELIVERY_ADDBALLS2.toLowerCase()
  );
}

function hasOwn(source, fieldName) {
  return Object.prototype.hasOwnProperty.call(source || {}, fieldName);
}

function normalizeMode(value, fallback) {
  const mode = String(value || "").trim().toUpperCase();
  return mode || fallback;
}

function hasNonEmptyValue(source, fieldName) {
  if (!hasOwn(source, fieldName)) {
    return false;
  }
  const value = source[fieldName];
  if (value === null || value === undefined) {
    return false;
  }
  if (Buffer.isBuffer(value)) {
    return value.length > 0;
  }
  return String(value).trim() !== "";
}

function resolveConfiguredFlags(source) {
  if (!hasOwn(source, "destinyBallFlags")) {
    return null;
  }
  const numeric = Math.trunc(Number(source.destinyBallFlags));
  return Number.isFinite(numeric) ? numeric & 0xff : null;
}

function appendBootstrapDelivery(presentation, source) {
  if (hasExplicitAddBalls2Delivery(source)) {
    presentation.destinyBootstrapDelivery =
      DESTINY_BOOTSTRAP_DELIVERY_ADDBALLS2;
  }
  return presentation;
}

// Free/non-free, mode, and flags are client behavior contracts. Preserve
// explicit source semantics and use free STOP only for unqualified ambient
// visuals that deliberately opt into the lightweight presentation.
function resolveSiteEnvironmentPropDestinyPresentation(
  source = {},
  typePresentation = null,
) {
  const safeSource = source && typeof source === "object" ? source : {};
  const safeType =
    typePresentation && typeof typePresentation === "object"
      ? typePresentation
      : {};
  const motionFields = {
    mass: toPositiveFiniteNumber([safeSource.mass, safeType.mass]),
    maxVelocity: toPositiveFiniteNumber([
      safeSource.maxVelocity,
      safeType.maxVelocity,
    ]),
    inertia: toPositiveFiniteNumber([
      safeSource.inertia,
      safeSource.agility,
      safeType.inertia,
      safeType.agility,
    ]),
    speedFraction: toPositiveFiniteNumber([safeSource.speedFraction]),
  };

  const configuredFlags = resolveConfiguredFlags(safeSource);
  const hasExplicitTail = hasNonEmptyValue(
    safeSource,
    "destinyCollisionTail",
  );
  const hasExplicitMode =
    hasNonEmptyValue(safeSource, "destinyBallMode") ||
    hasNonEmptyValue(safeSource, "destinyMode");
  const explicitlyFree =
    safeSource.destinyForceFree === true ||
    safeSource.destinyIsFree === true;
  const explicitlyNonFree =
    safeSource.destinyForceFree === false ||
    safeSource.destinyIsFree === false;
  const hasExplicitFreeFlag =
    configuredFlags !== null &&
    (configuredFlags & BALL_FLAG.IS_FREE) !== 0;
  const useFreePresentation = !hasExplicitTail && (
    explicitlyFree ||
    hasExplicitFreeFlag ||
    (
      !explicitlyNonFree &&
      !hasExplicitMode &&
      configuredFlags === null
    )
  );

  if (!useFreePresentation) {
    const presentation = {
      destinyBallMode: normalizeMode(
        safeSource.destinyBallMode || safeSource.destinyMode,
        "RIGID",
      ),
      destinyForceFree: false,
      destinyBallFlags: (configuredFlags === null ? 0 : configuredFlags) &
        ~BALL_FLAG.IS_FREE,
      ...motionFields,
    };
    if (hasExplicitTail) {
      presentation.destinyCollisionTail = safeSource.destinyCollisionTail;
      presentation.destinyCollisionTailSource =
        safeSource.destinyCollisionTailSource || "site-environment";
    }
    return appendBootstrapDelivery(presentation, safeSource);
  }

  return appendBootstrapDelivery({
    destinyBallMode: hasExplicitFreeFlag
      ? normalizeMode(
          safeSource.destinyBallMode || safeSource.destinyMode,
          "STOP",
        )
      : "STOP",
    destinyForceFree: true,
    destinyBallFlags: hasExplicitFreeFlag
      ? configuredFlags | DESTINY_BALL_FLAG.IS_FREE
      : DESTINY_BALL_FLAG.IS_FREE,
    ...motionFields,
  }, safeSource);
}

module.exports = {
  DESTINY_BALL_FLAG,
  DESTINY_BOOTSTRAP_DELIVERY_ADDBALLS2,
  resolveSiteEnvironmentPropDestinyPresentation,
};
