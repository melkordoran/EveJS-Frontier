const BaseService = require("../baseService");
const log = require("../../utils/logger");
const { buildDict } = require("../_shared/serviceHelpers");
const { findItemById } = require("../inventory/itemStore");

// Extracted from build 3450341's industry_facilities.fsdbinary.
const FRONTIER_INDUSTRY_FACILITY_TYPE_IDS = new Set([
  87119,
  87120,
  87161,
  87162,
  88063,
  88064,
  88067,
  88068,
  88069,
  88070,
  88071,
  91978,
  95302,
  95486,
]);

function getSessionCharacterID(session) {
  return Number(session && (session.characterID || session.charid)) || 0;
}

function getSessionSolarSystemID(session) {
  return Number(
    session &&
      (session.solarsystemid2 || session.solarsystemid || session.locationid),
  ) || 0;
}

function getItemSolarSystemID(item) {
  const spaceState = item && item.spaceState;
  const explicit = Number(
    spaceState && (spaceState.solarSystemID || spaceState.solarsystemid),
  ) || 0;
  if (explicit > 0) {
    return explicit;
  }
  const locationID = Number(item && item.locationID) || 0;
  return locationID >= 30000000 && locationID < 40000000 ? locationID : 0;
}

function canReadFacility(item, session) {
  const characterID = getSessionCharacterID(session);
  if (!item || characterID <= 0) {
    return false;
  }
  if (Number(item.ownerID) === characterID) {
    return true;
  }
  const solarSystemID = getSessionSolarSystemID(session);
  return solarSystemID > 0 && getItemSolarSystemID(item) === solarSystemID;
}

function buildIdleFacilityDetails() {
  return buildDict([
    ["production", null],
    [
      "items",
      buildDict([
        ["inputs", buildDict([])],
        ["outputs", buildDict([])],
      ]),
    ],
    ["blueprint", null],
  ]);
}

class IndustryService extends BaseService {
  constructor() {
    super("industry");
  }

  Handle_get_facility_details(args, session) {
    const facilityID = Number(args && args[0]) || 0;
    const item = findItemById(facilityID);
    const typeID = Number(item && item.typeID) || 0;
    if (
      facilityID <= 0 ||
      !item ||
      !FRONTIER_INDUSTRY_FACILITY_TYPE_IDS.has(typeID) ||
      !canReadFacility(item, session)
    ) {
      log.debug(
        `[industry] Facility details unavailable char=${getSessionCharacterID(session)} ` +
          `facility=${facilityID} type=${typeID}`,
      );
      return null;
    }

    log.debug(
      `[industry] Facility details char=${getSessionCharacterID(session)} ` +
        `facility=${facilityID} type=${typeID} state=idle`,
    );
    return buildIdleFacilityDetails();
  }
}

module.exports = IndustryService;
module.exports._testing = {
  FRONTIER_INDUSTRY_FACILITY_TYPE_IDS,
  buildIdleFacilityDetails,
  canReadFacility,
  getItemSolarSystemID,
};
