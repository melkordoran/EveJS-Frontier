"use strict";

const INSTANCE_ATTRIBUTE_ID_BY_FIELD = Object.freeze({
  online: 2,
  damage: 3,
  charge: 18,
  shieldCharge: 264,
  armorDamage: 266,
  skillPoints: 276,
});

function usesTimestampedInfoAttributes(compatibilityProfile) {
  return String(compatibilityProfile || "").trim().toLowerCase() === "frontier";
}

function normalizePackedInstanceRowForProfile(
  packedInstanceRow,
  compatibilityProfile,
) {
  if (
    !usesTimestampedInfoAttributes(compatibilityProfile) ||
    !packedInstanceRow ||
    packedInstanceRow.type !== "packedrow" ||
    !packedInstanceRow.fields ||
    typeof packedInstanceRow.fields !== "object"
  ) {
    return packedInstanceRow;
  }

  const entries = [];
  for (const [field, attributeID] of Object.entries(
    INSTANCE_ATTRIBUTE_ID_BY_FIELD,
  )) {
    if (Object.prototype.hasOwnProperty.call(packedInstanceRow.fields, field)) {
      entries.push([attributeID, packedInstanceRow.fields[field]]);
    }
  }

  return {
    type: "dict",
    entries,
  };
}

function normalizeInstanceCacheForProfile(
  instanceCache,
  compatibilityProfile,
) {
  if (
    !usesTimestampedInfoAttributes(compatibilityProfile) ||
    !instanceCache ||
    instanceCache.type !== "dict" ||
    !Array.isArray(instanceCache.entries)
  ) {
    return instanceCache;
  }

  return {
    ...instanceCache,
    entries: instanceCache.entries.map(([itemID, instanceAttributes]) => [
      itemID,
      normalizePackedInstanceRowForProfile(
        instanceAttributes,
        compatibilityProfile,
      ),
    ]),
  };
}

function normalizeActivationStateForProfile(
  activationState,
  compatibilityProfile,
) {
  if (
    usesTimestampedInfoAttributes(compatibilityProfile) &&
    Array.isArray(activationState)
  ) {
    const normalizedState = activationState.slice(0, 3);
    normalizedState[0] = normalizeInstanceCacheForProfile(
      normalizedState[0],
      compatibilityProfile,
    );
    return normalizedState;
  }
  return activationState;
}

function normalizeInfoAttributesForProfile(
  attributes,
  timestamp,
  compatibilityProfile,
) {
  if (
    !usesTimestampedInfoAttributes(compatibilityProfile) ||
    !attributes ||
    attributes.type !== "dict" ||
    !Array.isArray(attributes.entries)
  ) {
    return attributes;
  }

  return {
    ...attributes,
    entries: attributes.entries.map(([attributeID, value]) => [
      attributeID,
      [value, timestamp],
    ]),
  };
}

module.exports = {
  normalizeActivationStateForProfile,
  normalizeInfoAttributesForProfile,
  normalizeInstanceCacheForProfile,
  normalizePackedInstanceRowForProfile,
  usesTimestampedInfoAttributes,
};
