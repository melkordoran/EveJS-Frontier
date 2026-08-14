"use strict";

/**
 * Frontier directional scanner runtime (module 95322, behavior
 * "directional_scan", capability "scanning").
 *
 * Client contract (build 3467658 bytecode; the Creation path is unchanged
 * from 3455996):
 * - `creation.activate_ability(ship, module, "directional_scan",
 *   scan_angle=<degrees>, scan_direction=<vec3>)`; the adapter converts its
 *   internal radians with math.degrees() before sending. The result dict is
 *   read as `result.get("scan_response")` and the response is then accessed
 *   by ATTRIBUTE (response.added / .removed / .updated_scans / .resolved /
 *   .origin / .duration), so the payload must be an attribute-style object
 *   (util.KeyVal), not a plain dict.
 * - `resolved` maps ball_id -> filetime DELTA (the client applies
 *   datetimeutils.filetime_delta_to_timedelta). `duration` is returned as an
 *   actual datetime.timedelta because the client passes it directly into
 *   ScanPulsePhase and performs datetime arithmetic with it.
 * - `added`/`removed` are dict[int, tuple|None] keyed by ball id.
 * - `updated_scans` entries are CombinedScanResult states:
 *   (center, radius, scan_id, distance_range, estimated_number,
 *    estimated_number_uncertainty, signature_results), where each
 *   signature_result state is (signature_type, signature, noise_level).
 *
 * Client-authored constants and math reused verbatim (no invented formulas):
 * - SCAN_ANGLE_MIN 2.5°, SCAN_ANGLE_MAX 45°, SCAN_ANGLE_DEFAULT 15°.
 * - ScanTimeCalculator.MAXIMUM_SCAN_DISTANCE = 1e8 m (100,000 km).
 * - calculate_snr(signature, noise) = signature / noise, or 100 when noise
 *   is zero.
 * - Scan duration comes from the module's authored activeScanDuration
 *   attribute (6179 = 6000 ms for type 95322).
 * - Per-signature-type strength multipliers come from the module's authored
 *   ActiveScanGravStrengthMulti / ActiveScanEMStrengthMulti /
 *   ActiveScanThermalStrengthMulti attributes (6265/6266/6267).
 *
 * Documented emulator approximation (NOT client-recoverable): the client
 * ships the reveal/where-it-lands math but the server-side signature model
 * (how a ball's baseSignature becomes per-type signature strength and noise)
 * is not in the client package. We therefore use a deterministic model:
 *   signature = baseSignature * (typeMultiplier / 1000)
 *   noise     = distance / MAXIMUM_SCAN_DISTANCE
 * and resolve a contact (a 1-signature CombinedScanResult reported through
 * `resolved`) when snr >= RESOLVE_SNR_THRESHOLD. This is isolated in
 * buildSignatureResultsForTarget/isResolved so it can be replaced wholesale
 * when better evidence appears, and it is covered by deterministic tests.
 */

const path = require("path");

const {
  getTypeAttributeValue,
} = require(path.join(__dirname, "../fitting/liveFittingState"));
const { readStaticRows, TABLE } = require(path.join(
  __dirname,
  "../_shared/referenceData",
));

const SCAN_ANGLE_MIN_DEGREES = 2.5;
const SCAN_ANGLE_MAX_DEGREES = 45.0;
const SCAN_ANGLE_DEFAULT_DEGREES = 15.0;
const MAXIMUM_SCAN_DISTANCE_METERS = 100000000.0;
const DEFAULT_ACTIVE_SCAN_DURATION_MS = 6000;
const RESOLVE_SNR_THRESHOLD = 1.0;
const SIGNATURE_TYPE_GRAVIMETRIC = 1;
const SIGNATURE_TYPE_ELECTROMAGNETIC = 2;
const SIGNATURE_TYPE_THERMAL = 3;
const SIGNATURE_TYPE_MULTIPLIER_ATTRIBUTES = Object.freeze([
  [SIGNATURE_TYPE_GRAVIMETRIC, "ActiveScanGravStrengthMulti"],
  [SIGNATURE_TYPE_ELECTROMAGNETIC, "ActiveScanEMStrengthMulti"],
  [SIGNATURE_TYPE_THERMAL, "ActiveScanThermalStrengthMulti"],
]);

function toFiniteNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function normalizeVector(value) {
  if (Array.isArray(value) && value.length >= 3) {
    return {
      x: toFiniteNumber(value[0], 0),
      y: toFiniteNumber(value[1], 0),
      z: toFiniteNumber(value[2], 0),
    };
  }
  if (value && typeof value === "object") {
    return {
      x: toFiniteNumber(value.x, 0),
      y: toFiniteNumber(value.y, 0),
      z: toFiniteNumber(value.z, 0),
    };
  }
  return null;
}

function magnitude(vector) {
  return Math.hypot(vector.x, vector.y, vector.z);
}

function unitVector(vector) {
  const length = magnitude(vector);
  if (!(length > 0)) {
    return null;
  }
  return { x: vector.x / length, y: vector.y / length, z: vector.z / length };
}

function dotProduct(left, right) {
  return (left.x * right.x) + (left.y * right.y) + (left.z * right.z);
}

/**
 * Validate scan_angle (degrees, clamped to the client's authored bounds) and
 * scan_direction (any non-zero vector; normalized here).
 */
function normalizeScanRequest(kwargs) {
  const rawAngle = kwargs && kwargs.scan_angle;
  const angleDegrees = rawAngle === undefined || rawAngle === null
    ? SCAN_ANGLE_DEFAULT_DEGREES
    : toFiniteNumber(rawAngle, NaN);
  if (!Number.isFinite(angleDegrees)) {
    return { errorMsg: "SCAN_ANGLE_INVALID" };
  }
  if (
    angleDegrees < SCAN_ANGLE_MIN_DEGREES - 1e-6 ||
    angleDegrees > SCAN_ANGLE_MAX_DEGREES + 1e-6
  ) {
    return { errorMsg: "SCAN_ANGLE_OUT_OF_RANGE" };
  }
  const direction = normalizeVector(kwargs && kwargs.scan_direction);
  const unitDirection = direction ? unitVector(direction) : null;
  if (!unitDirection) {
    return { errorMsg: "SCAN_DIRECTION_INVALID" };
  }
  return { angleDegrees, direction: unitDirection };
}

function resolveScanDurationMs(moduleTypeID) {
  const duration = toFiniteNumber(
    getTypeAttributeValue(toInt(moduleTypeID, 0), "activeScanDuration"),
    0,
  );
  return duration > 0 ? duration : DEFAULT_ACTIVE_SCAN_DURATION_MS;
}

function resolveSignatureMultipliers(moduleTypeID) {
  const multipliers = [];
  for (const [signatureType, attributeName] of SIGNATURE_TYPE_MULTIPLIER_ATTRIBUTES) {
    const value = toFiniteNumber(
      getTypeAttributeValue(toInt(moduleTypeID, 0), attributeName),
      0,
    );
    if (value > 0) {
      multipliers.push([signatureType, value]);
    }
  }
  return multipliers;
}

// baseSignature is authored per type in spaceComponentsByType
// ({"baseSignature": {"baseSignature": <float>}}), covering ~7,275 types.
let baseSignaturesByTypeID = null;

function getBaseSignatureIndex() {
  if (!baseSignaturesByTypeID) {
    baseSignaturesByTypeID = new Map();
    for (const row of readStaticRows(TABLE.SPACE_COMPONENTS_BY_TYPE)) {
      const typeID = toInt(row && (row._key ?? row.typeID), 0);
      const component = row && row.baseSignature;
      const value = toFiniteNumber(component && component.baseSignature, 0);
      if (typeID > 0 && value > 0) {
        baseSignaturesByTypeID.set(typeID, value);
      }
    }
  }
  return baseSignaturesByTypeID;
}

function resolveBaseSignature(typeID) {
  return getBaseSignatureIndex().get(toInt(typeID, 0)) || 0;
}

function resetScanningStaticDataForTests() {
  baseSignaturesByTypeID = null;
}

// Client-authored: calculate_snr(signature, noise).
function calculateSnr(signature, noise) {
  return noise > 0 ? signature / noise : 100;
}

/**
 * Emulator signature model — see the module header. Returns the
 * per-signature-type [signatureType, signature, noiseLevel] triples the
 * client's SignatureResult.__set_state__ consumes.
 */
function buildSignatureResultsForTarget({
  baseSignature,
  distanceMeters,
  multipliers,
}) {
  const noise = Math.max(
    0,
    distanceMeters / MAXIMUM_SCAN_DISTANCE_METERS,
  );
  return multipliers.map(([signatureType, multiplier]) => ([
    signatureType,
    baseSignature * (multiplier / 1000),
    noise,
  ]));
}

function isResolved(signatureResults) {
  return signatureResults.some(([, signature, noise]) =>
    calculateSnr(signature, noise) >= RESOLVE_SNR_THRESHOLD);
}

/**
 * Deterministic, stable scan id for a contact: the ball id. The client keys
 * its signature repository and delta bookkeeping on scan_id, so reusing the
 * ball id keeps ids stable across repeated scans of the same target.
 */
function buildScanId(ballID) {
  return toInt(ballID, 0);
}

/**
 * Run a directional scan over candidate entities.
 *
 * `candidates` are {itemID, typeID, position:{x,y,z}} in the scanning ship's
 * solar system (the caller supplies live ballpark entities). Returns the
 * data the service layer marshals into the client's response shape.
 */
function performDirectionalScan({
  originPosition,
  angleDegrees,
  direction,
  moduleTypeID,
  candidates,
  previousScanIds = [],
}) {
  const origin = normalizeVector(originPosition) || { x: 0, y: 0, z: 0 };
  const halfAngleRadians = (angleDegrees * Math.PI) / 180;
  const cosineThreshold = Math.cos(halfAngleRadians);
  const multipliers = resolveSignatureMultipliers(moduleTypeID);
  const durationMs = resolveScanDurationMs(moduleTypeID);

  const combinedResults = [];
  const resolvedIds = [];
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    const position = normalizeVector(candidate && candidate.position);
    if (!position) {
      continue;
    }
    const offset = {
      x: position.x - origin.x,
      y: position.y - origin.y,
      z: position.z - origin.z,
    };
    const distanceMeters = magnitude(offset);
    if (distanceMeters <= 0 || distanceMeters > MAXIMUM_SCAN_DISTANCE_METERS) {
      continue;
    }
    const offsetDirection = unitVector(offset);
    if (!offsetDirection) {
      continue;
    }
    // Cone test: the scan angle is the half-angle from the boresight.
    if (dotProduct(offsetDirection, direction) < cosineThreshold) {
      continue;
    }
    const baseSignature = resolveBaseSignature(candidate.typeID);
    if (!(baseSignature > 0)) {
      continue;
    }
    const signatureResults = buildSignatureResultsForTarget({
      baseSignature,
      distanceMeters,
      multipliers,
    });
    const scanId = buildScanId(candidate.itemID);
    combinedResults.push({
      center: [position.x, position.y, position.z],
      radius: distanceMeters * Math.sin(halfAngleRadians),
      scan_id: scanId,
      distance_range: [distanceMeters, distanceMeters],
      estimated_number: 1,
      estimated_number_uncertainty: 0,
      signature_results: signatureResults,
    });
    if (isResolved(signatureResults)) {
      resolvedIds.push(toInt(candidate.itemID, 0));
    }
  }

  const currentIds = combinedResults.map((result) => result.scan_id);
  const previous = new Set(
    (Array.isArray(previousScanIds) ? previousScanIds : []).map((value) =>
      toInt(value, 0)),
  );
  const added = currentIds.filter((scanId) => !previous.has(scanId));
  const removed = [...previous].filter((scanId) => !currentIds.includes(scanId));

  return {
    origin: [origin.x, origin.y, origin.z],
    durationMs,
    added,
    removed,
    updatedScans: combinedResults,
    resolvedIds,
    scanIds: currentIds,
  };
}

module.exports = {
  DEFAULT_ACTIVE_SCAN_DURATION_MS,
  MAXIMUM_SCAN_DISTANCE_METERS,
  RESOLVE_SNR_THRESHOLD,
  SCAN_ANGLE_DEFAULT_DEGREES,
  SCAN_ANGLE_MAX_DEGREES,
  SCAN_ANGLE_MIN_DEGREES,
  SIGNATURE_TYPE_ELECTROMAGNETIC,
  SIGNATURE_TYPE_GRAVIMETRIC,
  SIGNATURE_TYPE_THERMAL,
  buildScanId,
  buildSignatureResultsForTarget,
  calculateSnr,
  isResolved,
  normalizeScanRequest,
  performDirectionalScan,
  resolveBaseSignature,
  resolveScanDurationMs,
  resolveSignatureMultipliers,
  resetScanningStaticDataForTests,
};
