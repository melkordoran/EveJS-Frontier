"use strict";

/**
 * Frontier's module-less directional scanner Macho service.
 *
 * Client build 3467658 calls exactly:
 *   RemoteSvc("scanningService").directional_scan(
 *     scan_angle=<degrees>, scan_direction=<vec3>)
 *
 * It then reads response.added / removed / updated_scans / resolved / origin /
 * duration by attribute.  buildScanResponse supplies that util.KeyVal wire
 * object and FILETIME-delta fields, shared with the fitted Creation scanner.
 *
 * The client contains no separate strength/duration constants for this route.
 * Type 95322 is the sole type accepted by its is_scanner_module_type() helper,
 * so module-less scans deliberately use that authored static profile instead
 * of introducing an emulator-only strength or timing rule.
 */

const path = require("path");

const BaseService = require(path.join(__dirname, "../baseService"));
const log = require(path.join(__dirname, "../../utils/logger"));
const { throwWrappedUserError } = require(path.join(
  __dirname,
  "../../common/machoErrors",
));
const {
  unwrapMarshalValue,
} = require(path.join(__dirname, "../_shared/serviceHelpers"));
const scanningRuntime = require(path.join(__dirname, "./scanningRuntime"));
const {
  buildScanResponse,
} = require(path.join(__dirname, "./scanningAbilityHandlers"));

const MODULELESS_SCANNER_PROFILE_TYPE_ID = 95322;

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function resolveActiveShipID(session) {
  return toInt(
    session && (
      (session._space && session._space.shipID) ||
      session.activeShipID ||
      session.shipID ||
      session.shipid
    ),
    0,
  );
}

function getSpaceRuntime() {
  return require(path.join(__dirname, "../../space/runtime"));
}

function collectScanCandidates(spaceRuntime, session, shipID) {
  let scene = null;
  try {
    scene = spaceRuntime && typeof spaceRuntime.getSceneForSession === "function"
      ? spaceRuntime.getSceneForSession(session)
      : null;
  } catch (_) {
    scene = null;
  }
  if (!scene || typeof scene.getDynamicEntities !== "function") {
    return [];
  }

  const candidates = [];
  for (const entity of scene.getDynamicEntities()) {
    const itemID = toInt(entity && entity.itemID, 0);
    if (itemID <= 0 || itemID === toInt(shipID, 0) || !entity.position) {
      continue;
    }
    candidates.push({
      itemID,
      typeID: toInt(entity.typeID, 0),
      position: entity.position,
    });
  }
  return candidates;
}

function throwScanRequestError(reason) {
  const messages = {
    SCAN_ANGLE_INVALID: "The directional scan angle is invalid.",
    SCAN_ANGLE_OUT_OF_RANGE: "The directional scan angle is out of range.",
    SCAN_DIRECTION_INVALID: "The directional scan direction is invalid.",
    SHIP_NOT_IN_SPACE: "You must be in space to use the directional scanner.",
  };
  throwWrappedUserError("CustomNotify", {
    notify: messages[reason] || "The directional scan could not be started.",
  });
}

class ScanningService extends BaseService {
  constructor(dependencies = {}) {
    super("scanningService");
    this._spaceRuntime = dependencies.spaceRuntime || getSpaceRuntime();
    this._normalizeScanRequest =
      dependencies.normalizeScanRequest || scanningRuntime.normalizeScanRequest;
    this._performDirectionalScan =
      dependencies.performDirectionalScan || scanningRuntime.performDirectionalScan;
    this._buildScanResponse = dependencies.buildScanResponse || buildScanResponse;
  }

  Handle_directional_scan(_args, session, kwargs) {
    const request = this._normalizeScanRequest(unwrapMarshalValue(kwargs) || {});
    if (request.errorMsg) {
      throwScanRequestError(request.errorMsg);
    }

    const shipID = resolveActiveShipID(session);
    if (!session || !session._space || shipID <= 0) {
      throwScanRequestError("SHIP_NOT_IN_SPACE");
    }

    let entity = null;
    try {
      entity = this._spaceRuntime && typeof this._spaceRuntime.getEntity === "function"
        ? this._spaceRuntime.getEntity(session, shipID)
        : null;
    } catch (_) {
      entity = null;
    }
    if (!entity || entity.kind !== "ship" || !entity.position) {
      throwScanRequestError("SHIP_NOT_IN_SPACE");
    }

    const previousScanIds = Array.isArray(
      session._space.frontierDirectionalScanIds,
    )
      ? session._space.frontierDirectionalScanIds
      : [];
    const scan = this._performDirectionalScan({
      originPosition: entity.position,
      angleDegrees: request.angleDegrees,
      direction: request.direction,
      moduleTypeID: MODULELESS_SCANNER_PROFILE_TYPE_ID,
      candidates: collectScanCandidates(this._spaceRuntime, session, shipID),
      previousScanIds,
    });
    session._space.frontierDirectionalScanIds = scan.scanIds;

    log.info(
      `[scanningService] directional_scan ship=${shipID} ` +
      `angle=${request.angleDegrees} results=${scan.updatedScans.length} ` +
      `resolved=${scan.resolvedIds.length} durationMs=${scan.durationMs}`,
    );
    return this._buildScanResponse(scan);
  }
}

module.exports = ScanningService;
module.exports._testing = {
  MODULELESS_SCANNER_PROFILE_TYPE_ID,
  collectScanCandidates,
  resolveActiveShipID,
};
