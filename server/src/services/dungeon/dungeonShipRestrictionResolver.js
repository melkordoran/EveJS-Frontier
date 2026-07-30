"use strict";

// Dungeon ship-restriction resolver for the GetDungeonShipRestrictions RPC (TQ parity).
//
// Faithful port of the client's evedungeons/client/util.py GetDungeonShipRestrictions: given a
// dungeon (and optionally one gate), compute which ship types may / may not enter, so the mission
// UI can grey out barred ships. ENFORCEMENT already happens at the acceleration gate
// (keeperService.assertShipMayUseGate); this is the display side the client reads via
// activeMissionController._FetchDisallowedTypeIDs -> restrictions['restrictedShipTypes'] (returning
// null there would raise a client TypeError for any restricted mission's ship picker).
//
// Rules (from util.py):
//   - No dungeon / no connections -> null.
//   - For each restricted connection (allowedShipsList or allowedShipRaces set), intersect the
//     running whitelist with the types that connection allows. allowedShipsList is a client type-list
//     ID resolved via typeListAuthority (same catalog the gate enforcement uses).
//   - If NO connection carries an explicit restriction, apply the default acceleration-gate blacklist
//     (capitals/capsule/freighters) — those groups are barred everywhere.
//   - restrictedShipTypes = all ship types minus the whitelist.

const path = require("path");

const dungeonAuthority = require(path.join(__dirname, "./dungeonAuthority"));
const { getTypeList } = require(path.join(__dirname, "../inventory/typeListAuthority"));
const { listShipTypeIDs } = require(path.join(__dirname, "../inventory/itemTypeRegistry"));

// Mirrors evedungeons/common/constants.py ACCELERATION_GATE_BLACKLISTED_GROUPS (kept in sync with the
// enforcement copy in keeperService ACCELERATION_GATE_BLACKLISTED_GROUP_IDS).
const BLACKLISTED_GROUP_IDS = new Set([
  29, // Capsule
  30, // Titan
  485, // Dreadnought
  513, // Freighter
  547, // Carrier
  659, // Supercarrier
  883, // Capital Industrial Ship
  902, // Jump Freighter
  1538, // Force Auxiliary
  4594, // Lancer Dreadnought
  5120, // Command Carrier
]);

function toInt(value, fallback = 0) {
  const numeric = Math.trunc(Number(value));
  return Number.isFinite(numeric) ? numeric : fallback;
}

function normalizeRaceSet(values) {
  return new Set(
    (Array.isArray(values) ? values : [])
      .map((value) => toInt(value, 0))
      .filter((value) => value > 0),
  );
}

// Does one ship type satisfy a single connection's restriction? Matches util.py IsTypeValid.
function shipTypeAllowedByConnection(shipType, allowedRaces, allowedShipsList) {
  if (allowedShipsList > 0) {
    const typeList = getTypeList(allowedShipsList);
    if (!typeList || !typeListIncludesShip(typeList, shipType)) {
      return false;
    }
  }
  if (allowedRaces.size > 0 && !(shipType.raceID > 0 && allowedRaces.has(shipType.raceID))) {
    return false;
  }
  return true;
}

// Type-list membership by type/group (races handled separately). Mirrors typeListAuthority's
// include/exclude semantics without needing a full item lookup (we already carry group IDs).
function typeListIncludesShip(typeList, shipType) {
  const included =
    typeList.includedTypeIDs.has(shipType.typeID) ||
    typeList.includedGroupIDs.has(shipType.groupID) ||
    typeList.includedCategoryIDs.has(6);
  if (!included) {
    return false;
  }
  const excluded =
    typeList.excludedTypeIDs.has(shipType.typeID) ||
    typeList.excludedGroupIDs.has(shipType.groupID) ||
    typeList.excludedCategoryIDs.has(6);
  return !excluded;
}

// Resolve the ship restrictions for a dungeon (optionally scoped to one gate's fromObjectID).
// Returns { allowedShipTypes, restrictedShipTypes, nonDefaultShipRestrictions } or null.
function resolveDungeonShipRestrictions(dungeonID, gateID = 0) {
  const normalizedDungeonID = toInt(dungeonID, 0);
  if (!normalizedDungeonID) {
    return null;
  }
  const dungeon = dungeonAuthority.getClientDungeonByID(normalizedDungeonID);
  const connections =
    dungeon && Array.isArray(dungeon.connections) ? dungeon.connections : null;
  if (!connections || connections.length === 0) {
    return null;
  }

  const shipTypes = listShipTypeIDs();
  const normalizedGateID = toInt(gateID, 0);
  let whitelist = new Set(shipTypes.map((ship) => ship.typeID));
  let nonDefaultShipRestrictions = false;

  for (const connection of connections) {
    if (normalizedGateID && toInt(connection && connection.fromObjectID, 0) !== normalizedGateID) {
      continue;
    }
    const allowedShipsList = toInt(connection && connection.allowedShipsList, 0);
    const allowedRaces = normalizeRaceSet(connection && connection.allowedShipRaces);
    if (allowedShipsList > 0 || allowedRaces.size > 0) {
      nonDefaultShipRestrictions = true;
      const allowed = new Set(
        shipTypes
          .filter((ship) => shipTypeAllowedByConnection(ship, allowedRaces, allowedShipsList))
          .map((ship) => ship.typeID),
      );
      whitelist = new Set([...whitelist].filter((typeID) => allowed.has(typeID)));
    }
  }

  if (!nonDefaultShipRestrictions) {
    // Default: only the acceleration-gate-blacklisted groups are barred.
    whitelist = new Set(
      shipTypes
        .filter((ship) => !BLACKLISTED_GROUP_IDS.has(ship.groupID))
        .map((ship) => ship.typeID),
    );
  }

  const allowedShipTypes = [];
  const restrictedShipTypes = [];
  for (const ship of shipTypes) {
    if (whitelist.has(ship.typeID)) {
      allowedShipTypes.push(ship.typeID);
    } else {
      restrictedShipTypes.push(ship.typeID);
    }
  }

  return { allowedShipTypes, restrictedShipTypes, nonDefaultShipRestrictions };
}

module.exports = {
  resolveDungeonShipRestrictions,
  BLACKLISTED_GROUP_IDS,
};
