const path = require("path");

const {
  listContainerItems,
} = require(path.join(__dirname, "../inventory/itemStore"));
const {
  applyModifierGroups,
  getTypeAttributeValue,
  isEffectivelyOnlineModule,
  isShipFittingFlag,
  typeHasEffectName,
} = require(path.join(__dirname, "../fitting/liveFittingState"));
const {
  STRUCTURE_UPKEEP_STATE,
} = require(path.join(__dirname, "./structureConstants"));
const {
  isStructureServiceModuleType,
} = require(path.join(__dirname, "./structureServiceAuthority"));

const ATTRIBUTE_STRUCTURE_FULL_POWER_HP_MULTIPLIER =
  "structureFullPowerStateHitpointMultiplier";
const ATTRIBUTE_SERVICE_MODULE_FULL_POWER_HP_MULTIPLIER =
  "serviceModuleFullPowerStateHitpointMultiplier";
const ATTRIBUTE_SERVICE_MODULE_FULL_POWER_ARMOR_PLATING_MULTIPLIER =
  "serviceModuleFullPowerStateArmorPlatingMultiplier";
const ATTRIBUTE_HIDDEN_ARMOR_HP_MULTIPLIER = "hiddenArmorHPMultiplier";
const ATTRIBUTE_ARMOR_HP_BONUS = "armorHpBonus";
const EFFECT_STRUCTURE_ARMOR_HP_BONUS = "structureArmorHPBonus";
const DOGMA_OP_POST_PERCENT = 6;
const STRUCTURE_SERVICE_SLOT_FLAGS = Object.freeze([164, 165, 166, 167, 168, 169, 170, 171]);

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function toFiniteNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function toPositiveInt(value, fallback = 0) {
  const numeric = toInt(value, fallback);
  return numeric > 0 ? numeric : fallback;
}

function round6(value) {
  return Number(toFiniteNumber(value, 0).toFixed(6));
}

function getBaseStructureHitpoints(structure = {}) {
  const typeID = toPositiveInt(structure.typeID, 0);
  return {
    shieldCapacity: Math.max(0, toFiniteNumber(
      structure.shieldCapacity,
      getTypeAttributeValue(typeID, "shieldCapacity"),
    )),
    armorHP: Math.max(0, toFiniteNumber(
      structure.armorHP,
      getTypeAttributeValue(typeID, "armorHP"),
    )),
    structureHP: Math.max(0, toFiniteNumber(
      structure.hullHP ?? structure.structureHP,
      getTypeAttributeValue(typeID, "hp", "structureHP"),
    )),
  };
}

function isOnlineStructureServiceModule(item) {
  return Boolean(
    item &&
    STRUCTURE_SERVICE_SLOT_FLAGS.includes(toInt(item.flagID, 0)) &&
    isShipFittingFlag(item.flagID) &&
    isStructureServiceModuleType(item.typeID) &&
    isEffectivelyOnlineModule(item),
  );
}

function listOnlineStructureServiceModuleItems(structureID) {
  const numericStructureID = toPositiveInt(structureID, 0);
  if (!numericStructureID) {
    return [];
  }
  return listContainerItems(null, numericStructureID, null)
    .filter(isOnlineStructureServiceModule)
    .sort((left, right) => (
      toInt(left.flagID, 0) - toInt(right.flagID, 0) ||
      toInt(left.itemID, 0) - toInt(right.itemID, 0)
    ));
}

function isOnlineStructureArmorPlatingModule(item) {
  return Boolean(
    item &&
    isShipFittingFlag(item.flagID) &&
    typeHasEffectName(item.typeID, EFFECT_STRUCTURE_ARMOR_HP_BONUS) &&
    isEffectivelyOnlineModule(item),
  );
}

function listOnlineStructureArmorPlatingItems(structureID) {
  const numericStructureID = toPositiveInt(structureID, 0);
  if (!numericStructureID) {
    return [];
  }
  return listContainerItems(null, numericStructureID, null)
    .filter(isOnlineStructureArmorPlatingModule)
    .sort((left, right) => (
      toInt(left.flagID, 0) - toInt(right.flagID, 0) ||
      toInt(left.itemID, 0) - toInt(right.itemID, 0)
    ));
}

function resolveAssignedMultiplier(onlineServiceModules, attributeName, fallback = 1) {
  const values = (Array.isArray(onlineServiceModules) ? onlineServiceModules : [])
    .map((item) => toFiniteNumber(getTypeAttributeValue(item.typeID, attributeName), NaN))
    .filter((value) => Number.isFinite(value) && value > 0);
  if (values.length === 0) {
    return fallback;
  }
  // TQ's effect is a post-assignment from the online service module to the
  // structure. Current data authors all service modules with the same value,
  // but max keeps mixed future data deterministic without weakening HP.
  return Math.max(...values);
}

function resolveStructureFullPowerDogma(structure = {}, options = {}) {
  const structureID = toPositiveInt(
    structure.structureID || structure.itemID || options.structureID,
    0,
  );
  const typeID = toPositiveInt(structure.typeID, 0);
  const onlineServiceModules = Array.isArray(options.onlineServiceModules)
    ? options.onlineServiceModules.filter(isOnlineStructureServiceModule)
    : listOnlineStructureServiceModuleItems(structureID);
  const hasOnlineServiceModule = onlineServiceModules.length > 0;
  const baseHitpointMultiplier = Math.max(0, toFiniteNumber(
    getTypeAttributeValue(typeID, ATTRIBUTE_STRUCTURE_FULL_POWER_HP_MULTIPLIER),
    1,
  ));
  const hitpointMultiplier = hasOnlineServiceModule
    ? resolveAssignedMultiplier(
        onlineServiceModules,
        ATTRIBUTE_SERVICE_MODULE_FULL_POWER_HP_MULTIPLIER,
        baseHitpointMultiplier || 1,
      )
    : (baseHitpointMultiplier || 1);
  const armorPlatingMultiplier = hasOnlineServiceModule
    ? resolveAssignedMultiplier(
        onlineServiceModules,
        ATTRIBUTE_SERVICE_MODULE_FULL_POWER_ARMOR_PLATING_MULTIPLIER,
        0,
      )
    : 0;

  return {
    isFullPower: hasOnlineServiceModule,
    upkeepState: hasOnlineServiceModule
      ? STRUCTURE_UPKEEP_STATE.FULL_POWER
      : STRUCTURE_UPKEEP_STATE.LOW_POWER,
    onlineServiceModuleCount: onlineServiceModules.length,
    hitpointMultiplier: Math.max(1, hitpointMultiplier),
    armorPlatingMultiplier: Math.max(0, armorPlatingMultiplier),
    onlineServiceModuleTypeIDs: onlineServiceModules
      .map((item) => toPositiveInt(item && item.typeID, 0))
      .filter(Boolean),
  };
}

function resolveStructureEffectiveHitpoints(structure = {}, options = {}) {
  const base = getBaseStructureHitpoints(structure);
  const fullPowerDogma = resolveStructureFullPowerDogma(structure, options);
  const structureID = toPositiveInt(
    structure.structureID || structure.itemID || options.structureID,
    0,
  );
  const typeID = toPositiveInt(structure.typeID, 0);
  const onlineArmorPlatingModules = Array.isArray(options.onlineArmorPlatingModules)
    ? options.onlineArmorPlatingModules.filter(isOnlineStructureArmorPlatingModule)
    : listOnlineStructureArmorPlatingItems(structureID);
  const armorMultiplierAttributes = {
    2751: Math.max(0, toFiniteNumber(
      getTypeAttributeValue(typeID, ATTRIBUTE_HIDDEN_ARMOR_HP_MULTIPLIER),
      1,
    )),
  };
  applyModifierGroups(
    armorMultiplierAttributes,
    onlineArmorPlatingModules.map((item) => ({
      modifiedAttributeID: 2751,
      operation: DOGMA_OP_POST_PERCENT,
      value:
        toFiniteNumber(getTypeAttributeValue(item.typeID, ATTRIBUTE_ARMOR_HP_BONUS), 0) *
        fullPowerDogma.armorPlatingMultiplier,
      // hiddenArmorHPMultiplier is deliberately non-stackable in the SDE;
      // TQ uses it to apply Standup plating stacking penalties.
      stackingPenalized: true,
    })),
  );
  const hiddenArmorHPMultiplier = Math.max(
    0,
    toFiniteNumber(armorMultiplierAttributes[2751], 1),
  );
  const resolvedDogma = {
    ...fullPowerDogma,
    hiddenArmorHPMultiplier,
    onlineArmorPlatingModuleCount: onlineArmorPlatingModules.length,
    onlineArmorPlatingModuleTypeIDs: onlineArmorPlatingModules
      .map((item) => toPositiveInt(item && item.typeID, 0))
      .filter(Boolean),
  };
  return {
    ...base,
    effectiveShieldCapacity: round6(base.shieldCapacity * fullPowerDogma.hitpointMultiplier),
    effectiveArmorHP: round6(
      base.armorHP * fullPowerDogma.hitpointMultiplier * hiddenArmorHPMultiplier,
    ),
    effectiveStructureHP: round6(base.structureHP),
    fullPowerDogma: resolvedDogma,
  };
}

module.exports = {
  ATTRIBUTE_SERVICE_MODULE_FULL_POWER_ARMOR_PLATING_MULTIPLIER,
  ATTRIBUTE_SERVICE_MODULE_FULL_POWER_HP_MULTIPLIER,
  ATTRIBUTE_STRUCTURE_FULL_POWER_HP_MULTIPLIER,
  getBaseStructureHitpoints,
  isOnlineStructureArmorPlatingModule,
  isOnlineStructureServiceModule,
  listOnlineStructureArmorPlatingItems,
  listOnlineStructureServiceModuleItems,
  resolveStructureEffectiveHitpoints,
  resolveStructureFullPowerDogma,
};
