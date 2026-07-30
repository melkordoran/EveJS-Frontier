"use strict";

const {
  entityIDsEqual,
  normalizePersistentEntityID,
} = require("../../space/destiny/identity/entityID.js");

function normalizeDungeonInstanceID(value) {
  const normalized = normalizePersistentEntityID(value);
  return (
    typeof normalized === "number" &&
    Number.isSafeInteger(normalized) &&
    normalized > 0
  )
    ? normalized
    : null;
}

function normalizeScope(value) {
  return String(value == null ? "" : value).trim().toLowerCase();
}

function getOwnership(instance) {
  return instance &&
    instance.ownership &&
    typeof instance.ownership === "object" &&
    !Array.isArray(instance.ownership)
    ? instance.ownership
    : null;
}

function isPrivateDungeonInstance(instance) {
  if (!instance || typeof instance !== "object" || Array.isArray(instance)) {
    return false;
  }
  const ownership = getOwnership(instance);
  return (
    normalizeScope(instance.instanceScope) === "private" ||
    normalizeScope(ownership && ownership.visibilityScope) === "private"
  );
}

function isPublicDungeonInstance(instance) {
  if (!instance || typeof instance !== "object" || Array.isArray(instance)) {
    return false;
  }
  const ownership = getOwnership(instance);
  const instanceScope = normalizeScope(instance.instanceScope);
  const visibilityScope = normalizeScope(ownership && ownership.visibilityScope);
  return (
    ["public", "shared", "system"].includes(instanceScope) &&
    ["public", "shared", "system"].includes(visibilityScope)
  );
}

function exactPositiveIDsEqual(left, right) {
  const normalizedLeft = normalizePersistentEntityID(left);
  const normalizedRight = normalizePersistentEntityID(right);
  return (
    normalizedLeft !== null &&
    normalizedRight !== null &&
    entityIDsEqual(normalizedLeft, normalizedRight)
  );
}

function getSessionIdentity(session, fieldNames) {
  if (!session || typeof session !== "object" || Array.isArray(session)) {
    return null;
  }
  let resolvedIdentity = null;
  for (const fieldName of fieldNames) {
    if (!Object.hasOwn(session, fieldName)) {
      continue;
    }
    const rawCandidate = session[fieldName];
    if (
      rawCandidate === null ||
      rawCandidate === undefined ||
      String(rawCandidate).trim() === ""
    ) {
      continue;
    }
    const candidate = normalizePersistentEntityID(rawCandidate);
    if (candidate === null) {
      return null;
    }
    if (
      resolvedIdentity !== null &&
      !entityIDsEqual(resolvedIdentity, candidate)
    ) {
      return null;
    }
    resolvedIdentity = candidate;
  }
  return resolvedIdentity;
}

function identityMatches(candidate, expected) {
  const normalizedExpected = normalizePersistentEntityID(expected);
  return (
    candidate !== null &&
    normalizedExpected !== null &&
    entityIDsEqual(candidate, normalizedExpected)
  );
}

function canSessionAccessDungeonInstance(session, instance) {
  if (!instance || typeof instance !== "object" || Array.isArray(instance)) {
    return false;
  }
  if (!isPrivateDungeonInstance(instance)) {
    return isPublicDungeonInstance(instance);
  }

  const ownership = getOwnership(instance);
  if (!ownership) {
    return false;
  }

  const characterID = getSessionIdentity(session, [
    "characterID",
    "charID",
    "charid",
  ]);
  if (
    identityMatches(characterID, ownership.characterID) ||
    identityMatches(characterID, ownership.missionOwnerCharacterID)
  ) {
    return true;
  }

  const sharedWithCharacterIDs = ownership.sharedWithCharacterIDs instanceof Set
    ? [...ownership.sharedWithCharacterIDs]
    : Array.isArray(ownership.sharedWithCharacterIDs)
      ? ownership.sharedWithCharacterIDs
      : [];
  if (
    sharedWithCharacterIDs.some((sharedCharacterID) => (
      exactPositiveIDsEqual(characterID, sharedCharacterID)
    ))
  ) {
    return true;
  }

  // The persisted shape reserves corporation/fleet ownership fields, but no
  // current producer defines either as private Destiny visibility authority.
  // In particular, fleet roster membership must never manufacture access.
  return false;
}

function resolveGetInstance(options) {
  if (
    options &&
    typeof options === "object" &&
    Object.hasOwn(options, "getInstance")
  ) {
    return typeof options.getInstance === "function"
      ? options.getInstance
      : null;
  }
  try {
    const dungeonRuntime = require("./dungeonRuntime.js");
    return dungeonRuntime && typeof dungeonRuntime.getInstance === "function"
      ? dungeonRuntime.getInstance
      : null;
  } catch (_error) {
    return null;
  }
}

const VISIBLE_DUNGEON_LIFECYCLE_STATES = ["seeded", "active", "paused"];
// A cleared site whose teardown is parked on the occupancy grace is terminal in the runtime but still
// standing on grid, so its pocket has to keep resolving for the pilots who are in it (and for anyone
// warping to them). Only the occupancy-grace caller opts in; every other terminal instance stays dark.
const GRACE_DUNGEON_LIFECYCLE_STATES = [
  ...VISIBLE_DUNGEON_LIFECYCLE_STATES,
  "completed",
];

function resolveDungeonInstanceVisibilityForSession(
  session,
  requestedInstanceID,
  options = {},
) {
  const resolverOptions = options && typeof options === "object"
    ? options
    : {};
  const allowedLifecycleStates = resolverOptions.allowTeardownGraceLifecycle === true
    ? GRACE_DUNGEON_LIFECYCLE_STATES
    : VISIBLE_DUNGEON_LIFECYCLE_STATES;
  const instanceID = normalizeDungeonInstanceID(requestedInstanceID);
  if (instanceID === null) {
    return null;
  }

  const getInstance = resolveGetInstance(resolverOptions);
  if (!getInstance) {
    return null;
  }

  let instance;
  try {
    instance = getInstance(instanceID);
  } catch (_error) {
    return null;
  }
  if (!instance || typeof instance !== "object" || Array.isArray(instance)) {
    return null;
  }

  const returnedInstanceID = normalizeDungeonInstanceID(instance.instanceID);
  const solarSystemID = normalizePersistentEntityID(instance.solarSystemID);
  const lifecycleState = normalizeScope(instance.lifecycleState);
  if (
    returnedInstanceID === null ||
    solarSystemID === null ||
    !allowedLifecycleStates.includes(lifecycleState) ||
    !entityIDsEqual(instanceID, returnedInstanceID)
  ) {
    return null;
  }

  if (Object.hasOwn(resolverOptions, "systemID")) {
    const requestedSystemID = normalizePersistentEntityID(
      resolverOptions.systemID,
    );
    if (
      requestedSystemID === null ||
      !entityIDsEqual(requestedSystemID, solarSystemID)
    ) {
      return null;
    }
  }

  if (!canSessionAccessDungeonInstance(session, instance)) {
    return null;
  }

  return {
    instance,
    instanceID,
    isPrivate: isPrivateDungeonInstance(instance),
    solarSystemID,
  };
}

function resolveAuthorizedDungeonInstanceIDForSession(
  session,
  requestedInstanceID,
  options = {},
) {
  const resolution = resolveDungeonInstanceVisibilityForSession(
    session,
    requestedInstanceID,
    options,
  );
  return resolution ? resolution.instanceID : null;
}

module.exports = {
  canSessionAccessDungeonInstance,
  isPrivateDungeonInstance,
  normalizeDungeonInstanceID,
  resolveAuthorizedDungeonInstanceIDForSession,
  resolveDungeonInstanceVisibilityForSession,
};
