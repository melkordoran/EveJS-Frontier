"use strict";

const {
  buildDbRowset,
} = require("../../../services/_shared/serviceHelpers");

const FRONTIER_CROWSET_NAME = "carbon.common.script.sys.crowset.CRowset";
const FRONTIER_STARGATE_JUMP_COLUMNS = [
  ["toCelestialID", 0x14],
  ["locationID", 0x14],
];
const FRONTIER_ASSEMBLY_STATUS_UNDER_CONSTRUCTION = 5;

const BASE_CR_DATA_KEYS = [
  "itemID",
  "typeID",
  "ownerID",
  "name",
  "nameID",
  "timeAddedToSpace",
  "locationID",
  "poseID",
  "dunDirection",
  "dunRotation",
  "dunPosition",
  "dunObjectID",
  "dunObjectNameID",
  "dunRadius",
];
const OWNED_CR_DATA_KEYS = [
  "securityStatus",
  "corpID",
  "allianceID",
];
const BOARDABLE_CR_DATA_KEYS = [
  "charID",
  "compression_facility_typelists",
  "docked",
  "modules",
  "skinMaterialSetID",
];
const KIND_CR_DATA_KEYS = {
  container: [
    ...OWNED_CR_DATA_KEYS,
    "isEmpty",
    "launcherID",
    "lootRights",
  ],
  drone: [
    ...OWNED_CR_DATA_KEYS,
    "signatureRadius",
  ],
  deployable: [
    ...OWNED_CR_DATA_KEYS,
    "activationState",
    "assembly_status",
    "component_activate",
    "targetSolarsystemID",
  ],
  entity: [
    "friendly_response_threshold",
    "hostile_response_threshold",
    "signatureRadius",
  ],
  fighter: [
    ...OWNED_CR_DATA_KEYS,
    "signatureRadius",
  ],
  landscapesite: [
    "archetypeID",
    "dungeonID",
    "dungeonNameID",
    "signatureRadius",
  ],
  riftdungeon: [
    "archetypeID",
    "dungeonID",
    "dungeonNameID",
    "signatureRadius",
  ],
  missile: [
    "launchModules",
    "sourceShipID",
  ],
  moon: [
    "beaconItemID",
  ],
  orbital: [],
  planet: OWNED_CR_DATA_KEYS,
  ship: [
    ...OWNED_CR_DATA_KEYS,
    ...BOARDABLE_CR_DATA_KEYS,
    "dirtTime",
    "kills",
    "selfDestructTime",
    "shipStance",
    "signatureRadius",
  ],
  stargate: [
    "activationState",
    "destinationSystemOwnerID",
    "destinationSystemStatusIcons",
    "destinationSystemWarningIcon",
    "jumps",
    "originSystemOwnerID",
  ],
  station: [
    ...OWNED_CR_DATA_KEYS,
    "activityLevel",
    "delayTime",
    "state",
    "timestamp",
  ],
  structure: [
    ...OWNED_CR_DATA_KEYS,
    ...BOARDABLE_CR_DATA_KEYS,
    "damage",
    "deedState",
    "deployTimes",
    "repairing",
    "state",
    "timer",
    "unanchoring",
    "upkeepState",
  ],
  sun: [
    "starState",
    "starState_Timestamp",
  ],
  wreck: [
    ...OWNED_CR_DATA_KEYS,
    "isEmpty",
    "launcherID",
    "lootRights",
  ],
};

function isFrontierStatePayloadProfile(compatibilityProfile) {
  return String(compatibilityProfile || "").trim().toLowerCase() === "frontier";
}

function buildFrontierStargateJumps(entity) {
  const rows = (
    entity && entity.destinationID && entity.destinationSolarSystemID
  )
    ? [[entity.destinationID, entity.destinationSolarSystemID]]
    : [];
  return buildDbRowset(
    FRONTIER_STARGATE_JUMP_COLUMNS,
    rows,
    FRONTIER_CROWSET_NAME,
  );
}

function normalizeCrDataDictionaryForProfile(
  crData,
  entity,
  compatibilityProfile,
) {
  if (
    !isFrontierStatePayloadProfile(compatibilityProfile) ||
    !crData ||
    crData.type !== "dict" ||
    !Array.isArray(crData.entries)
  ) {
    return crData;
  }

  const kind = String(entity && entity.kind || "").trim().toLowerCase();
  const allowedKeys = new Set([
    ...BASE_CR_DATA_KEYS,
    ...(KIND_CR_DATA_KEYS[kind] || []),
  ]);
  const assemblyStatusEntry = crData.entries.find((entry) => (
    Array.isArray(entry) && entry[0] === "assembly_status"
  ));
  const isConstructionSite = kind === "deployable" && (
    Number(assemblyStatusEntry && assemblyStatusEntry[1]) ===
      FRONTIER_ASSEMBLY_STATUS_UNDER_CONSTRUCTION
  );
  return {
    ...crData,
    entries: crData.entries
      .filter((entry) => (
        Array.isArray(entry) &&
        allowedKeys.has(entry[0]) &&
        !(isConstructionSite && entry[0] === "component_activate")
      ))
      .map((entry) => (
        kind === "stargate" && entry[0] === "jumps"
          ? ["jumps", buildFrontierStargateJumps(entity)]
          : entry
      )),
  };
}

/**
 * Frontier (build 3455996) never accepts a wire SlimItem object:
 * - `eve.common.script.util.slimItem.SlimItem` is absent from every whitelist
 *   blob in carbon/common/lib/whitelist.pyc (195 entries, byte-identical to
 *   build 3450341), and so is its `__guid__` "foo.SlimItem", so the client
 *   raises "HACKER WARNING! ... is not in whitelist" while unmarshalling the
 *   notification — which discards the ENTIRE DoDestinyUpdate, including the
 *   damage-state and special-FX updates bundled alongside it.
 * - The client has no `OnSlimItemChange` handler at all in this build, and
 *   builds its slim items locally from CR data (frontier/crdata/
 *   cr_base_object.pyc). SetState already reflects that: this profile sends
 *   "crdata" instead of "slims".
 * Presentation refreshes therefore omit the slim-item object entirely for
 * this profile rather than renaming it. Legacy profiles are unchanged.
 */
function usesWireSlimItemObjects(compatibilityProfile) {
  return !isFrontierStatePayloadProfile(compatibilityProfile);
}

function normalizeSlimItemObjectForProfile(
  slimItem,
  compatibilityProfile,
) {
  if (!usesWireSlimItemObjects(compatibilityProfile)) {
    return null;
  }
  if (
    !slimItem ||
    slimItem.type !== "object" ||
    slimItem.name !== "foo.SlimItem"
  ) {
    return slimItem;
  }
  return slimItem;
}

function usesCrDataSetState(compatibilityProfile) {
  return isFrontierStatePayloadProfile(compatibilityProfile);
}

function usesCrDataBallMetadata(compatibilityProfile) {
  return isFrontierStatePayloadProfile(compatibilityProfile);
}

function usesFrontierStateStreamPreamble(compatibilityProfile) {
  return isFrontierStatePayloadProfile(compatibilityProfile);
}

module.exports = {
  isFrontierStatePayloadProfile,
  usesWireSlimItemObjects,
  normalizeCrDataDictionaryForProfile,
  normalizeSlimItemObjectForProfile,
  usesCrDataBallMetadata,
  usesCrDataSetState,
  usesFrontierStateStreamPreamble,
};
