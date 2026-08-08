const LEGACY_SETTINGS_CODE_HEX =
  "630000000000000000010000004300000073040000006900005328010000004e280000000028000000002800000000280000000073080000003c737472696e673e740100000066010000007300000000";

// Python 3.12 marshal payload for: def f(): return {}
const FRONTIER_SETTINGS_CODE_HEX =
  "e30000000000000000000000000100000003000000f30600000097006900530029014ea9007202000000f300000000fa083c737472696e673eda016672050000000100000073070000008000d80b0d80497203000000";

function isFrontierProfile(compatibilityProfile) {
  return String(compatibilityProfile || "").trim().toLowerCase() === "frontier";
}

function buildSettingsInfoCode(compatibilityProfile) {
  return Buffer.from(
    isFrontierProfile(compatibilityProfile)
      ? FRONTIER_SETTINGS_CODE_HEX
      : LEGACY_SETTINGS_CODE_HEX,
    "hex",
  );
}

module.exports = {
  FRONTIER_SETTINGS_CODE_HEX,
  LEGACY_SETTINGS_CODE_HEX,
  buildSettingsInfoCode,
  isFrontierProfile,
};
