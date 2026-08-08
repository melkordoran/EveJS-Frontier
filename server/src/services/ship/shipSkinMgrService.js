"use strict";

const ShipCosmeticsMgrService = require("./shipCosmeticsMgrService");
const log = require("../../utils/logger");

const SHIP_SKIN_MGR_ALLOWED_METHODS = new Set([
  "ActivateSkinLicense",
  "ActivateSkinLicenseCorp",
  "GetAppliedSkinMaterialSetID",
  "GetLicencedSkins",
  "GetLicencedSkinsCorp",
  "GetLicencedSkinsForShipType",
  "GetLicencedSkinsForStructureType",
  "GetAppliedSkin",
  "ApplySkinToStructureByPlayer",
  "ApplySkinToShip",
]);

function normalizeMethodName(method) {
  if (Buffer.isBuffer(method)) {
    return method.toString("utf8");
  }
  if (method && typeof method === "object" && typeof method.value === "string") {
    return method.value;
  }
  return method === null || method === undefined ? "" : String(method);
}

/**
 * Build 3455996 still addresses the classic `shipSkinMgr` Macho service.
 * Keep it as a compatibility name over the same persisted cosmetics state
 * while retaining `shipCosmeticsMgr` for newer callers.
 */
class ShipSkinMgrService extends ShipCosmeticsMgrService {
  constructor() {
    super("shipSkinMgr");
  }

  callMethod(method, args, session, kwargs) {
    const normalizedMethod = normalizeMethodName(method);
    if (!SHIP_SKIN_MGR_ALLOWED_METHODS.has(normalizedMethod)) {
      log.warn(`[shipSkinMgr] Blocked non-client method: ${normalizedMethod || "<empty>"}`);
      return null;
    }
    return super.callMethod(normalizedMethod, args, session, kwargs);
  }
}

module.exports = ShipSkinMgrService;
module.exports.SHIP_SKIN_MGR_ALLOWED_METHODS = SHIP_SKIN_MGR_ALLOWED_METHODS;
