function toPositiveInteger(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.trunc(numeric) : 0;
}

function isFrontierProfile(compatibilityProfile) {
  return String(compatibilityProfile || "").trim().toLowerCase() === "frontier";
}

function buildPositiveIDSet(rows, key) {
  return new Set(
    (Array.isArray(rows) ? rows : [])
      .map((row) => toPositiveInteger(row && row[key]))
      .filter((value) => value > 0),
  );
}

function shouldIncludeAgentRecord(
  record,
  compatibilityProfile,
  validStationIDs = new Set(),
  validSolarSystemIDs = new Set(),
) {
  if (!isFrontierProfile(compatibilityProfile)) {
    return true;
  }

  const stationID = toPositiveInteger(record && record.stationID);
  if (stationID > 0 && validStationIDs.has(stationID)) {
    return true;
  }

  const solarSystemID = toPositiveInteger(record && record.solarSystemID);
  return Boolean(
    record &&
      record.isInSpace === true &&
      solarSystemID > 0 &&
      validSolarSystemIDs.has(solarSystemID),
  );
}

module.exports = {
  buildPositiveIDSet,
  isFrontierProfile,
  shouldIncludeAgentRecord,
};
