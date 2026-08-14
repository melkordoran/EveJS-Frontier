"use strict";

/**
 * Directional scanner Creation ability handler (behavior "directional_scan").
 *
 * Wire shape notes (build 3455996):
 * - The client reads `result.get("scan_response")` from the activate_ability
 *   return value, then accesses the response BY ATTRIBUTE, so the response is
 *   marshalled as util.KeyVal rather than a plain dict.
 * - Every `resolved` value is a FILETIME DELTA (100 ns units), which the
 *   client converts with datetimeutils.filetime_delta_to_timedelta.  In
 *   contrast, `duration` is passed directly into ScanPulsePhase and must
 *   already be a datetime.timedelta instance.
 * - `added`/`removed` are dicts keyed by ball id with a tuple|None value;
 *   we send None (no per-ball payload is read for directional scans).
 * - `updated_scans` are CombinedScanResult states: (center, radius, scan_id,
 *   distance_range, estimated_number, estimated_number_uncertainty,
 *   signature_results).
 */

const path = require("path");

const log = require(path.join(__dirname, "../../utils/logger"));
const scanningRuntime = require(path.join(__dirname, "./scanningRuntime"));
const {
  ABILITY_DIRECTIONAL_SCAN,
  registerCreationAbilityHandler,
} = require(path.join(__dirname, "./creationAbilityRuntime"));
const {
  buildDict,
  buildKeyVal,
  buildList,
} = require(path.join(__dirname, "../_shared/serviceHelpers"));
const { findItemById } = require(path.join(__dirname, "../inventory/itemStore"));

const FILETIME_UNITS_PER_MS = 10000n;

let registered = false;

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function millisecondsToFiletimeDelta(milliseconds) {
  return BigInt(Math.max(0, Math.round(Number(milliseconds) || 0))) *
    FILETIME_UNITS_PER_MS;
}

function encodeProtocol2Integer(value) {
  const numeric = Math.trunc(Number(value));
  if (!Number.isSafeInteger(numeric)) {
    throw new RangeError("timedelta component exceeds the supported pickle integer range");
  }
  if (numeric >= 0 && numeric <= 0xff) {
    return Buffer.from([0x4b, numeric]); // BININT1
  }
  if (numeric >= 0 && numeric <= 0xffff) {
    const encoded = Buffer.alloc(3);
    encoded[0] = 0x4d; // BININT2
    encoded.writeUInt16LE(numeric, 1);
    return encoded;
  }
  if (numeric >= -0x80000000 && numeric <= 0x7fffffff) {
    const encoded = Buffer.alloc(5);
    encoded[0] = 0x4a; // BININT
    encoded.writeInt32LE(numeric, 1);
    return encoded;
  }
  throw new RangeError("timedelta component exceeds the supported pickle integer range");
}

/**
 * Build the exact protocol-2 reduction emitted by Python 3.12 for
 * datetime.timedelta(days, seconds, microseconds). The cPicked Macho opcode
 * invokes pickle.loads on the client, yielding a real timedelta rather than a
 * tick integer that would fail `datetime + duration` in Scanner.update().
 */
function buildPythonTimedeltaPayload(milliseconds) {
  const numericMilliseconds = Number(milliseconds);
  const totalMicroseconds = Number.isFinite(numericMilliseconds)
    ? Math.max(0, Math.round(numericMilliseconds * 1000))
    : 0;
  const microsecondsPerDay = 86_400_000_000;
  const microsecondsPerSecond = 1_000_000;
  const days = Math.floor(totalMicroseconds / microsecondsPerDay);
  const dayRemainder = totalMicroseconds - (days * microsecondsPerDay);
  const seconds = Math.floor(dayRemainder / microsecondsPerSecond);
  const microseconds = dayRemainder - (seconds * microsecondsPerSecond);

  return {
    type: "cpicked",
    data: Buffer.concat([
      Buffer.from([0x80, 0x02]), // PROTO 2
      Buffer.from("cdatetime\ntimedelta\nq\0", "latin1"),
      encodeProtocol2Integer(days),
      encodeProtocol2Integer(seconds),
      encodeProtocol2Integer(microseconds),
      Buffer.from([0x87, 0x71, 0x01, 0x52, 0x71, 0x02, 0x2e]),
      // TUPLE3, BINPUT 1, REDUCE, BINPUT 2, STOP
    ]),
  };
}

function getSpaceRuntime() {
  return require(path.join(__dirname, "../../space/runtime"));
}

/**
 * Live ballpark entities in the scanning ship's scene, excluding the ship
 * itself. Returns [] when the scene is unavailable so an empty scan
 * marshals cleanly rather than throwing.
 */
function collectScanCandidates(session, shipID) {
  const runtime = getSpaceRuntime();
  let scene = null;
  try {
    scene = typeof runtime.getSceneForSession === "function"
      ? runtime.getSceneForSession(session)
      : null;
  } catch (_) {
    scene = null;
  }
  if (!scene || typeof scene.getDynamicEntities !== "function") {
    return [];
  }
  const candidates = [];
  for (const entity of scene.getDynamicEntities()) {
    if (!entity || toInt(entity.itemID, 0) === toInt(shipID, 0)) {
      continue;
    }
    if (!entity.position) {
      continue;
    }
    candidates.push({
      itemID: toInt(entity.itemID, 0),
      typeID: toInt(entity.typeID, 0),
      position: entity.position,
    });
  }
  return candidates;
}

function buildCombinedScanState(result) {
  return [
    result.center,
    result.radius,
    result.scan_id,
    result.distance_range,
    result.estimated_number,
    result.estimated_number_uncertainty,
    buildList(result.signature_results.map((entry) => buildList(entry))),
  ];
}

function buildScanResponse(scan) {
  return buildKeyVal([
    ["origin", scan.origin],
    ["duration", buildPythonTimedeltaPayload(scan.durationMs)],
    [
      "added",
      buildDict(scan.added.map((scanId) => [scanId, null])),
    ],
    [
      "removed",
      buildDict(scan.removed.map((scanId) => [scanId, null])),
    ],
    [
      "updated_scans",
      buildList(scan.updatedScans.map((result) =>
        buildList(buildCombinedScanState(result)))),
    ],
    [
      "resolved",
      buildDict(scan.resolvedIds.map((ballID) => ([
        ballID,
        millisecondsToFiletimeDelta(scan.durationMs),
      ]))),
    ],
  ]);
}

function registerScanningAbilityHandlers() {
  if (registered) {
    return;
  }
  registered = true;

  registerCreationAbilityHandler("directional_scan", ABILITY_DIRECTIONAL_SCAN, {
    validate(context) {
      const request = scanningRuntime.normalizeScanRequest(context.kwargs);
      if (request.errorMsg) {
        return { success: false, errorMsg: request.errorMsg };
      }
      context.scanRequest = request;
      return { success: true };
    },
    execute(context) {
      const session = context.session;
      const shipID = toInt(context.creationItem && context.creationItem.itemID, 0);
      if (!session || !session._space) {
        return { success: false, errorMsg: "SHIP_NOT_IN_SPACE" };
      }
      const runtime = getSpaceRuntime();
      let entity = null;
      try {
        entity = runtime.getEntity(session, shipID);
      } catch (_) {
        entity = null;
      }
      if (!entity || entity.kind !== "ship") {
        return { success: false, errorMsg: "SHIP_NOT_IN_SPACE" };
      }
      const moduleItem = findItemById(context.moduleItemID);
      if (!moduleItem) {
        return { success: false, errorMsg: "MODULE_NOT_FOUND" };
      }

      const previousScanIds = Array.isArray(
        session._space && session._space.frontierDirectionalScanIds,
      )
        ? session._space.frontierDirectionalScanIds
        : [];
      const scan = scanningRuntime.performDirectionalScan({
        originPosition: entity.position,
        angleDegrees: context.scanRequest.angleDegrees,
        direction: context.scanRequest.direction,
        moduleTypeID: moduleItem.typeID,
        candidates: collectScanCandidates(session, shipID),
        previousScanIds,
      });
      if (session._space) {
        session._space.frontierDirectionalScanIds = scan.scanIds;
      }
      log.info(
        `[scanning] directional_scan ship=${shipID} module=${context.moduleItemID} ` +
        `angle=${context.scanRequest.angleDegrees} results=${scan.updatedScans.length} ` +
        `resolved=${scan.resolvedIds.length} durationMs=${scan.durationMs}`,
      );
      return {
        success: true,
        data: { scan_response: buildScanResponse(scan) },
      };
    },
  });
}

module.exports = {
  buildPythonTimedeltaPayload,
  buildScanResponse,
  millisecondsToFiletimeDelta,
  registerScanningAbilityHandlers,
};
