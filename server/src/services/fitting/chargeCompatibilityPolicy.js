"use strict";

const DEFAULT_UNKNOWN_CAPACITY_QUANTITY = 1;

function positiveNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function positiveInteger(value) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
}

function normalizeDeclaredGroupIDs(values) {
  return [...new Set(Array.from(values || [])
    .map(positiveInteger)
    .filter((value) => value !== null))]
    .sort((left, right) => left - right);
}

/**
 * Resolve the number of charges that can fit in a module.
 *
 * Positive capacity and volume are authoritative and may legitimately produce
 * zero. When either fact is absent/nonpositive, the SDE does not provide a
 * usable volume bound. Eve.js deliberately falls back to one unit so callers
 * receive a finite, nonnegative quantity without inventing an unbounded clip.
 */
function calculateChargeCapacity({ moduleCapacity, chargeVolume } = {}) {
  const capacity = positiveNumber(moduleCapacity);
  const volume = positiveNumber(chargeVolume);

  if (capacity !== null && volume !== null) {
    const maximumQuantity = Math.floor(capacity / volume);
    return {
      status: maximumQuantity > 0 ? "authoritative" : "rejected-oversized",
      maximumQuantity,
      moduleCapacity: capacity,
      chargeVolume: volume,
      fallbackReason: null,
    };
  }

  const missingFacts = [];
  if (capacity === null) missingFacts.push("module-capacity-missing-or-nonpositive");
  if (volume === null) missingFacts.push("charge-volume-missing-or-nonpositive");
  return {
    status: "single-unit-fallback",
    maximumQuantity: DEFAULT_UNKNOWN_CAPACITY_QUANTITY,
    moduleCapacity: capacity,
    chargeVolume: volume,
    fallbackReason: missingFacts.join("+"),
  };
}

/**
 * Pure module/charge policy shared by runtime adapters and parity tooling.
 * Module-declared charge groups are the primary relationship. Reciprocal
 * launcherGroup facts are intentionally not a veto: the pinned SDE uses them
 * as corroborating family metadata and does not populate them consistently.
 */
function evaluateChargeCompatibility({
  declaredChargeGroupIDs,
  chargeGroupID,
  moduleChargeSize,
  chargeSize,
  moduleCapacity,
  chargeVolume,
} = {}) {
  const groups = normalizeDeclaredGroupIDs(declaredChargeGroupIDs);
  const normalizedChargeGroupID = positiveInteger(chargeGroupID);
  const normalizedModuleSize = positiveNumber(moduleChargeSize);
  const normalizedChargeSize = positiveNumber(chargeSize);
  const capacity = calculateChargeCapacity({ moduleCapacity, chargeVolume });

  if (
    normalizedChargeGroupID === null ||
    !groups.includes(normalizedChargeGroupID)
  ) {
    return {
      accepted: false,
      rejectionReason: "charge-group-not-declared-by-module",
      groupConstraint: "rejected",
      sizeConstraint: "not-evaluated",
      capacityConstraint: "not-evaluated",
      maximumQuantity: 0,
      capacity,
    };
  }

  if (
    normalizedModuleSize !== null &&
    normalizedChargeSize !== null &&
    normalizedModuleSize !== normalizedChargeSize
  ) {
    return {
      accepted: false,
      rejectionReason: "charge-size-mismatch",
      groupConstraint: "matched",
      sizeConstraint: "rejected-mismatch",
      capacityConstraint: "not-evaluated",
      maximumQuantity: 0,
      capacity,
    };
  }

  if (capacity.maximumQuantity <= 0) {
    return {
      accepted: false,
      rejectionReason: "charge-volume-exceeds-module-capacity",
      groupConstraint: "matched",
      sizeConstraint:
        normalizedModuleSize !== null && normalizedChargeSize !== null
          ? "matched"
          : "not-declared-on-both-sides",
      capacityConstraint: "rejected-oversized",
      maximumQuantity: 0,
      capacity,
    };
  }

  return {
    accepted: true,
    rejectionReason: null,
    groupConstraint: "matched",
    sizeConstraint:
      normalizedModuleSize !== null && normalizedChargeSize !== null
        ? "matched"
        : "not-declared-on-both-sides",
    capacityConstraint:
      capacity.status === "authoritative"
        ? "fits"
        : "single-unit-fallback",
    maximumQuantity: capacity.maximumQuantity,
    capacity,
  };
}

module.exports = {
  DEFAULT_UNKNOWN_CAPACITY_QUANTITY,
  calculateChargeCapacity,
  evaluateChargeCompatibility,
  normalizeDeclaredGroupIDs,
  positiveNumber,
};
