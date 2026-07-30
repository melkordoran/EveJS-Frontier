"use strict";

const {
  entityIDsEqual,
  normalizeNonNegativeInt64,
  normalizePersistentEntityID,
  toJSONSafeEntityID,
} = require("./entityID.js");

const INVALID_ENTITY_SCOPE_IDENTITY = "invalid-entity-interaction-scope";

const AIR_SCOPE_ID_FIELDS = Object.freeze([
  "airNpeOwnerCharacterID",
  "airNpeOperationID",
  "airNpeInstanceID",
]);

const DUNGEON_BOOLEAN_MARKERS = Object.freeze([
  "dungeonMaterializedContainer",
  "dungeonMaterializedSiteContent",
  "dungeonSiteContentBonus",
  "dungeonSiteContentFailureExplodes",
  "dungeonSiteContentPersistsAfterResponse",
]);

const DUNGEON_TEXT_MARKERS = Object.freeze([
  "dungeonEncounterKey",
  "dungeonSiteContentKey",
  "dungeonSiteContentRole",
  "dungeonSiteContentAnalyzer",
  "dungeonSiteContentTrigger",
  "dungeonSiteContentLootProfile",
  "dungeonSiteContentHackingDifficulty",
]);

const AIR_BOOLEAN_MARKERS = Object.freeze([
  "airNpeBoardingShipPresentation",
  "airNpeTutorialDebris",
  "airNpeHostile",
]);

function getScopeMetadataContainers(entity) {
  if (!entity || typeof entity !== "object" || Array.isArray(entity)) {
    return [];
  }
  const containers = [entity];
  if (
    entity.spaceState &&
    typeof entity.spaceState === "object" &&
    !Array.isArray(entity.spaceState) &&
    entity.spaceState !== entity
  ) {
    containers.push(entity.spaceState);
  }
  return containers;
}

function containerHasIdentityValue(container, fieldName) {
  return Boolean(
    container &&
    Object.hasOwn(container, fieldName) &&
    container[fieldName] !== null &&
    container[fieldName] !== undefined
  );
}

function hasIdentityValue(entity, fieldName) {
  return getScopeMetadataContainers(entity)
    .some((container) => containerHasIdentityValue(container, fieldName));
}

function resolveExactIdentityAliases(entity, fieldNames, options = {}) {
  let present = false;
  let value = null;
  const normalizeIdentity = options.allowZero === true
    ? normalizeNonNegativeInt64
    : normalizePersistentEntityID;
  for (const container of getScopeMetadataContainers(entity)) {
    for (const fieldName of fieldNames) {
      if (!containerHasIdentityValue(container, fieldName)) {
        continue;
      }
      present = true;
      const candidate = normalizeIdentity(container[fieldName]);
      if (
        candidate === null ||
        (value !== null && !entityIDsEqual(value, candidate))
      ) {
        return { present, valid: false, value: null };
      }
      value = candidate;
    }
  }
  return { present, valid: true, value };
}

function hasDungeonContentMarker(entity) {
  return getScopeMetadataContainers(entity).some((container) => (
    DUNGEON_BOOLEAN_MARKERS.some((fieldName) => container[fieldName] === true) ||
    DUNGEON_TEXT_MARKERS.some(
      (fieldName) => String(container[fieldName] || "").trim(),
    ) ||
    Array.isArray(container.dungeonSiteContentExplicitLoot) ||
    Array.isArray(container.dungeonSiteContentLootTags)
  ));
}

function hasAirContentMarker(entity) {
  return getScopeMetadataContainers(entity).some((container) => (
    AIR_BOOLEAN_MARKERS.some((fieldName) => container[fieldName] === true) ||
    String(container.airNpeHostileWave || "").trim()
  ));
}

function hasScopeTextValue(entity, fieldName) {
  return getScopeMetadataContainers(entity)
    .some((container) => String(container[fieldName] || "").trim());
}

function hasScopeArrayValue(entity, fieldName) {
  return getScopeMetadataContainers(entity)
    .some((container) => Array.isArray(container[fieldName]));
}

function resolveEntityInteractionScope(entity) {
  if (!entity || typeof entity !== "object" || Array.isArray(entity)) {
    return { scoped: false, valid: false };
  }

  const dungeonInstance = resolveExactIdentityAliases(entity, [
    "dungeonCurrentInstanceID",
    "dungeonSiteInstanceID",
  ]);
  const dungeonSite = resolveExactIdentityAliases(entity, [
    "dungeonCurrentSiteID",
    "dungeonSiteID",
  ]);
  const airInstance = resolveExactIdentityAliases(entity, [
    "airNpeInstanceID",
  ]);
  const airOwner = resolveExactIdentityAliases(entity, [
    "airNpeOwnerCharacterID",
  ]);
  const airOperation = resolveExactIdentityAliases(entity, [
    "airNpeOperationID",
  ]);
  const playerTrackerIdentities = [
    resolveExactIdentityAliases(entity, ["dungeonCurrentDungeonID"]),
    resolveExactIdentityAliases(
      entity,
      ["dungeonCurrentRoomID"],
      { allowZero: true },
    ),
  ];
  const hasPlayerTrackerContext = Boolean(
    entity.kind === "ship" &&
    (
      playerTrackerIdentities.some((identity) => identity.present) ||
      hasIdentityValue(entity, "dungeonCurrentSiteID") ||
      hasScopeTextValue(entity, "dungeonCurrentRoomKey") ||
      hasScopeArrayValue(entity, "dungeonCurrentRoomPosition")
    )
  );
  const dungeonMarker = hasDungeonContentMarker(entity);
  const airMarker = hasAirContentMarker(entity);
  const hasDungeonScope = Boolean(
    dungeonMarker ||
    dungeonInstance.present ||
    dungeonSite.present ||
    hasPlayerTrackerContext
  );
  const hasAirScope = Boolean(
    airMarker ||
    airInstance.present ||
    airOwner.present ||
    airOperation.present
  );
  const scoped = hasDungeonScope || hasAirScope;
  const hasDungeonAuthority = dungeonInstance.value !== null;
  const hasAirAuthority = Boolean(
    airInstance.value !== null || airOwner.value !== null
  );
  const valid = Boolean(
    entity.entityInteractionScopeInvalid !== true &&
    entity.playerCompanionScopeInvalid !== true &&
    dungeonInstance.valid &&
    dungeonSite.valid &&
    airInstance.valid &&
    airOwner.valid &&
    airOperation.valid &&
    playerTrackerIdentities.every((identity) => identity.valid) &&
    (!hasPlayerTrackerContext || hasDungeonAuthority) &&
    (!dungeonMarker || hasDungeonAuthority) &&
    (!dungeonSite.present || hasDungeonAuthority) &&
    (!airMarker || hasAirAuthority) &&
    (!airOperation.present || hasAirAuthority) &&
    (!scoped || hasDungeonAuthority || hasAirAuthority)
  );

  return {
    airInstanceID: airInstance.value,
    airOperationID: airOperation.value,
    airOwnerCharacterID: airOwner.value,
    dungeonInstanceID: dungeonInstance.value,
    dungeonSiteID: dungeonSite.value,
    hasAirScope,
    hasDungeonScope,
    scoped,
    valid,
  };
}

function resolveEntityActorCharacterID(entity, session = null) {
  const character = resolveExactIdentityAliases(entity, [
    "characterID",
    "pilotCharacterID",
  ]);
  const owner = resolveExactIdentityAliases(entity, ["ownerID"]);
  const sessionCharacter = resolveExactIdentityAliases(session, [
    "characterID",
    "charID",
    "charid",
  ]);
  if (!character.valid || !owner.valid || !sessionCharacter.valid) {
    return null;
  }

  let resolved = character.value;
  for (const candidate of [sessionCharacter.value, owner.value]) {
    if (candidate === null) {
      continue;
    }
    if (resolved !== null && !entityIDsEqual(resolved, candidate)) {
      return null;
    }
    resolved = candidate;
  }
  return resolved;
}

function entityMatchesOwnerScope(entity, scope, ownerCharacterID) {
  if (ownerCharacterID === null) {
    return true;
  }
  if (
    scope.airOwnerCharacterID !== null &&
    entityIDsEqual(scope.airOwnerCharacterID, ownerCharacterID)
  ) {
    return true;
  }
  const actorCharacterID = resolveEntityActorCharacterID(
    entity,
    entity && entity.session,
  );
  return Boolean(
    actorCharacterID !== null &&
    entityIDsEqual(actorCharacterID, ownerCharacterID)
  );
}

function canEntitiesInteractLocally(sourceEntity, targetEntity) {
  if (!sourceEntity || !targetEntity) {
    return false;
  }
  const sourceScope = resolveEntityInteractionScope(sourceEntity);
  const targetScope = resolveEntityInteractionScope(targetEntity);
  if (!sourceScope.valid || !targetScope.valid) {
    return false;
  }
  if (sourceScope.scoped !== targetScope.scoped) {
    return false;
  }
  if (!sourceScope.scoped) {
    return true;
  }

  if (
    sourceScope.dungeonInstanceID !== null ||
    targetScope.dungeonInstanceID !== null
  ) {
    if (
      sourceScope.dungeonInstanceID === null ||
      targetScope.dungeonInstanceID === null ||
      !entityIDsEqual(
        sourceScope.dungeonInstanceID,
        targetScope.dungeonInstanceID,
      )
    ) {
      return false;
    }
  }

  if (
    sourceScope.airInstanceID !== null &&
    targetScope.airInstanceID !== null &&
    !entityIDsEqual(sourceScope.airInstanceID, targetScope.airInstanceID)
  ) {
    return false;
  }
  if (
    sourceScope.airInstanceID !== null &&
    targetScope.airInstanceID === null &&
    !entityMatchesOwnerScope(
      targetEntity,
      targetScope,
      sourceScope.airOwnerCharacterID,
    )
  ) {
    return false;
  }
  if (
    sourceScope.airInstanceID === null &&
    targetScope.airInstanceID !== null &&
    !entityMatchesOwnerScope(
      sourceEntity,
      sourceScope,
      targetScope.airOwnerCharacterID,
    )
  ) {
    return false;
  }
  if (
    sourceScope.airOperationID !== null &&
    targetScope.airOperationID !== null &&
    !entityIDsEqual(sourceScope.airOperationID, targetScope.airOperationID)
  ) {
    return false;
  }
  if (
    sourceScope.dungeonSiteID !== null &&
    targetScope.dungeonSiteID !== null &&
    !entityIDsEqual(sourceScope.dungeonSiteID, targetScope.dungeonSiteID)
  ) {
    return false;
  }
  if (
    !entityMatchesOwnerScope(
      targetEntity,
      targetScope,
      sourceScope.airOwnerCharacterID,
    ) ||
    !entityMatchesOwnerScope(
      sourceEntity,
      sourceScope,
      targetScope.airOwnerCharacterID,
    )
  ) {
    return false;
  }

  return true;
}

function canEntityDiscoverTarget(observerEntity, targetEntity) {
  if (!observerEntity || !targetEntity) {
    return false;
  }
  const observerScope = resolveEntityInteractionScope(observerEntity);
  const targetScope = resolveEntityInteractionScope(targetEntity);
  if (!observerScope.valid || !targetScope.valid) {
    return false;
  }
  if (!targetScope.scoped) {
    return true;
  }
  return canEntitiesInteractLocally(observerEntity, targetEntity);
}

function buildChildEntityScopeMetadata(sourceEntity) {
  const scope = resolveEntityInteractionScope(sourceEntity);
  if (!scope.valid) {
    return {
      dungeonSiteInstanceID: INVALID_ENTITY_SCOPE_IDENTITY,
    };
  }
  if (!scope.scoped) {
    return {};
  }

  const metadata = {};
  for (const [fieldName, value] of [
    ["airNpeOwnerCharacterID", scope.airOwnerCharacterID],
    ["airNpeOperationID", scope.airOperationID],
    ["airNpeInstanceID", scope.airInstanceID],
    ["dungeonSiteID", scope.dungeonSiteID],
    ["dungeonSiteInstanceID", scope.dungeonInstanceID],
  ]) {
    if (value !== null) {
      metadata[fieldName] = toJSONSafeEntityID(value);
    }
  }
  return metadata;
}

function buildPlayerEgoScopeMetadata(sourceEntity) {
  const scope = resolveEntityInteractionScope(sourceEntity);
  if (!scope.valid) {
    return {
      dungeonCurrentInstanceID: INVALID_ENTITY_SCOPE_IDENTITY,
    };
  }

  const metadata = {};
  for (const [fieldName, value] of [
    ["airNpeOwnerCharacterID", scope.airOwnerCharacterID],
    ["airNpeOperationID", scope.airOperationID],
    ["airNpeInstanceID", scope.airInstanceID],
  ]) {
    if (value !== null) {
      metadata[fieldName] = toJSONSafeEntityID(value);
    }
  }

  if (!hasIdentityValue(sourceEntity, "dungeonCurrentInstanceID")) {
    return metadata;
  }
  metadata.dungeonCurrentInstanceID = toJSONSafeEntityID(
    scope.dungeonInstanceID,
  );

  for (const fieldName of [
    "dungeonCurrentDungeonID",
    "dungeonCurrentSiteID",
    "dungeonCompletedNotifiedInstanceID",
  ]) {
    if (!hasIdentityValue(sourceEntity, fieldName)) {
      continue;
    }
    const value = normalizePersistentEntityID(sourceEntity[fieldName]);
    metadata[fieldName] = value === null
      ? INVALID_ENTITY_SCOPE_IDENTITY
      : toJSONSafeEntityID(value);
  }

  if (hasIdentityValue(sourceEntity, "dungeonCurrentRoomID")) {
    const roomID = normalizeNonNegativeInt64(
      sourceEntity.dungeonCurrentRoomID,
    );
    metadata.dungeonCurrentRoomID = roomID === null
      ? INVALID_ENTITY_SCOPE_IDENTITY
      : toJSONSafeEntityID(roomID);
  }
  const roomKey = String(sourceEntity.dungeonCurrentRoomKey || "").trim();
  if (roomKey) {
    metadata.dungeonCurrentRoomKey = roomKey;
  }
  if (
    Array.isArray(sourceEntity.dungeonCurrentRoomPosition) &&
    sourceEntity.dungeonCurrentRoomPosition.length >= 3
  ) {
    metadata.dungeonCurrentRoomPosition = sourceEntity
      .dungeonCurrentRoomPosition
      .slice(0, 3)
      .map((value) => {
        const numeric = Number(value);
        return Number.isFinite(numeric) ? numeric : 0;
      });
  }
  const updatedAtMs = Number(sourceEntity.dungeonCurrentUpdatedAtMs);
  if (Number.isFinite(updatedAtMs) && updatedAtMs > 0) {
    metadata.dungeonCurrentUpdatedAtMs = updatedAtMs;
  }
  return metadata;
}

module.exports = {
  AIR_SCOPE_ID_FIELDS,
  INVALID_ENTITY_SCOPE_IDENTITY,
  buildChildEntityScopeMetadata,
  buildPlayerEgoScopeMetadata,
  canEntitiesInteractLocally,
  canEntityDiscoverTarget,
  hasAirContentMarker,
  hasDungeonContentMarker,
  resolveEntityActorCharacterID,
  resolveEntityInteractionScope,
};
