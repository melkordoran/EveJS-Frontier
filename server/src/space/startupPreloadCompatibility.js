const TRANQUILITY_STARTUP_SYSTEM_IDS = Object.freeze([
  30000142,
  30000145,
  30100032,
]);
const FRONTIER_STARTUP_SYSTEM_IDS = Object.freeze([30000004]);

function isFrontierProfile(compatibilityProfile) {
  return String(compatibilityProfile || "").trim().toLowerCase() === "frontier";
}

function resolveDefaultStartupSystemIDs(compatibilityProfile) {
  return [
    ...(isFrontierProfile(compatibilityProfile)
      ? FRONTIER_STARTUP_SYSTEM_IDS
      : TRANQUILITY_STARTUP_SYSTEM_IDS),
  ];
}

module.exports = {
  FRONTIER_STARTUP_SYSTEM_IDS,
  TRANQUILITY_STARTUP_SYSTEM_IDS,
  isFrontierProfile,
  resolveDefaultStartupSystemIDs,
};
