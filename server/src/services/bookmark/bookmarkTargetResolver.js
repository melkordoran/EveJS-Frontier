const path = require("path");

const {
  normalizeNumber,
} = require(path.join(__dirname, "../_shared/serviceHelpers"));
const runtime = require(path.join(__dirname, "./bookmarkRuntimeState"));
const {
  TYPE_SOLAR_SYSTEM,
} = require(path.join(__dirname, "./bookmarkConstants"));

function getSessionSolarSystemID(session) {
  return normalizeNumber(
    session &&
      (
        (session._space && session._space.systemID) ||
        session.solarsystemid2 ||
        session.solarsystemid
      ),
    0,
  );
}

function buildCoordinateBookmarkTarget(entity, systemID, positionOverride = null) {
  if (!entity || systemID <= 0) {
    return null;
  }
  const position = positionOverride || entity.position;
  const x = normalizeNumber(position && position.x, null);
  const y = normalizeNumber(position && position.y, null);
  const z = normalizeNumber(position && position.z, null);
  if (x === null || y === null || z === null) {
    return null;
  }
  return {
    itemID: null,
    typeID: TYPE_SOLAR_SYSTEM,
    locationID: systemID,
    x,
    y,
    z,
  };
}

function resolveLocationBookmarkTarget(itemID, session, scene = null) {
  const numericItemID = normalizeNumber(itemID, 0);
  if (numericItemID <= 0) {
    return null;
  }

  const staticTarget = runtime.resolveStaticBookmarkTarget(numericItemID, session);
  if (staticTarget) {
    return staticTarget;
  }

  const systemID = getSessionSolarSystemID(session);
  const shipEntity = scene ? scene.getShipEntityForSession(session) : null;
  if (shipEntity && numericItemID === normalizeNumber(shipEntity.itemID, 0)) {
    // Mid-warp the server's ball leads the pilot's locally simulated one, so
    // capture the position the pilot's client is actually rendering.
    const perceivedWarpPosition =
      scene && typeof scene.getPilotPerceivedWarpPosition === "function"
        ? scene.getPilotPerceivedWarpPosition(shipEntity)
        : null;
    return buildCoordinateBookmarkTarget(
      shipEntity,
      systemID,
      perceivedWarpPosition,
    );
  }

  const targetEntity = scene ? scene.getEntityByID(numericItemID) : null;
  if (targetEntity) {
    return buildCoordinateBookmarkTarget(targetEntity, systemID);
  }

  return null;
}

module.exports = {
  buildCoordinateBookmarkTarget,
  getSessionSolarSystemID,
  resolveLocationBookmarkTarget,
};
