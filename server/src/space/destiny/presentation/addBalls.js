"use strict";

const {
  tagUpdatesFreshAcquireLifecycleGroup,
  tagUpdatesMissileLifecycleGroup,
  tagUpdatesOwnerMissileLifecycleGroup,
} = require("../dispatch/dispatchUtils");
const {
  normalizePersistentEntityID,
} = require("../identity/entityID");
const {
  normalizeDestinyStamp,
} = require("../delivery/stamps");
const {
  isTargetedLiveMissile,
} = require("../stream/ballEncoding");
const {
  resolveFreshAcquireBootstrapModeUpdates,
  stripMissileFreshAcquireModeReplayUpdates,
} = require("./freshAcquire");

function requireUpdates(result, label) {
  if (!Array.isArray(result)) {
    throw new TypeError(`${label} must return an array`);
  }
  return result;
}

function buildInitialBootstrapAddBallsPresentationUpdate(options = {}) {
  const stamp = normalizeDestinyStamp(options.stamp, 0);
  const entities = Array.isArray(options.entities) ? options.entities : [];
  if (typeof options.buildAddBalls2Payload !== "function") {
    throw new TypeError(
      "initial bootstrap AddBalls presentation requires buildAddBalls2Payload",
    );
  }
  return {
    stamp,
    payload: options.buildAddBalls2Payload(
      stamp,
      entities,
      options.simFileTime ?? 0,
    ),
  };
}

function buildInitialBootstrapSetStatePresentationUpdate(options = {}) {
  const stamp = normalizeDestinyStamp(options.stamp, 0);
  const entities = Array.isArray(options.entities) ? options.entities : [];
  if (typeof options.buildSetStatePayload !== "function") {
    throw new TypeError(
      "initial bootstrap SetState presentation requires buildSetStatePayload",
    );
  }
  return {
    stamp,
    payload: options.buildSetStatePayload(
      stamp,
      options.system,
      options.egoEntityID,
      entities,
      options.simFileTime ?? 0,
      Array.isArray(options.dbuffStateEntries)
        ? options.dbuffStateEntries
        : [],
      Array.isArray(options.effectStateEntries)
        ? options.effectStateEntries
        : [],
    ),
  };
}

function buildMissileLaunchActionUpdates(options = {}) {
  const entities = Array.isArray(options.entities) ? options.entities : [];
  const missileEntities = entities.filter(
    (entity) => entity && entity.kind === "missile",
  );
  if (missileEntities.length === 0) {
    return [];
  }
  if (typeof options.buildLaunchMissilePayload !== "function") {
    throw new TypeError(
      "missile AddBalls presentation requires buildLaunchMissilePayload",
    );
  }

  const stamp = normalizeDestinyStamp(options.stamp, 0);
  const updates = [];
  for (const entity of missileEntities) {
    if (!isTargetedLiveMissile(entity)) {
      continue;
    }
    const entityID = normalizePersistentEntityID(entity.itemID);
    const targetID = normalizePersistentEntityID(entity.targetEntityID);
    const ownerID = normalizePersistentEntityID(entity.sourceShipID);
    // An invalidated deferred snapshot is intentionally targetless GOTO/FREE.
    // It materializes without a stale LaunchMissile action.
    if (entityID === null || targetID === null || ownerID === null) {
      continue;
    }
    updates.push({
      stamp,
      payload: options.buildLaunchMissilePayload(entityID, targetID, ownerID),
    });
  }
  return updates;
}

function buildAddBallsPresentationUpdates(options = {}) {
  const stamp = normalizeDestinyStamp(options.stamp, 0);
  const entities = Array.isArray(options.entities) ? options.entities : [];
  if (typeof options.buildAddBalls2Payload !== "function") {
    throw new TypeError(
      "buildAddBallsPresentationUpdates requires buildAddBalls2Payload",
    );
  }
  if (typeof options.buildPrimeUpdatesForEntities !== "function") {
    throw new TypeError(
      "buildAddBallsPresentationUpdates requires buildPrimeUpdatesForEntities",
    );
  }
  if (typeof options.buildModeUpdates !== "function") {
    throw new TypeError(
      "buildAddBallsPresentationUpdates requires buildModeUpdates",
    );
  }
  if (
    options.replayActiveSpecialFx === true &&
    typeof options.buildActiveSpecialFxReplayUpdates !== "function"
  ) {
    throw new TypeError(
      "active FX AddBalls presentation requires buildActiveSpecialFxReplayUpdates",
    );
  }
  const buildPrimeUpdatesForEntities = options.buildPrimeUpdatesForEntities;
  const buildModeUpdates = options.buildModeUpdates;
  const buildActiveSpecialFxReplayUpdates =
    options.buildActiveSpecialFxReplayUpdates;

  const addBallsUpdate = {
    stamp,
    payload: options.buildAddBalls2Payload(
      stamp,
      entities,
      options.simFileTime || 0,
    ),
  };
  if (options.tagFreshAcquireLifecycle === true) {
    // This metadata is dependency-only. Dispatch strips it and serializes the
    // same AddBalls2 payload as before.
    addBallsUpdate.freshAcquireEntityIDs = entities
      .map((entity) => normalizePersistentEntityID(entity && entity.itemID))
      .filter((entityID) => entityID !== null);
  }

  let updates = [addBallsUpdate];
  updates.push(...requireUpdates(
    buildPrimeUpdatesForEntities(entities, stamp),
    "buildPrimeUpdatesForEntities",
  ));

  const modeUpdates = [];
  for (const entity of entities) {
    modeUpdates.push(...requireUpdates(
      buildModeUpdates(entity, stamp),
      "buildModeUpdates",
    ));
  }
  const bootstrapModeUpdates = resolveFreshAcquireBootstrapModeUpdates(
    entities,
    modeUpdates,
  );
  if (bootstrapModeUpdates.length > 0) {
    updates.push(...bootstrapModeUpdates);
  }

  if (options.replayActiveSpecialFx === true) {
    const activeSpecialFxReplayUpdates = requireUpdates(
      buildActiveSpecialFxReplayUpdates(
        entities,
        stamp,
        options.presentationRawSimTimeMs,
        {
          scene: options.scene || null,
          session: options.session || null,
        },
      ),
      "buildActiveSpecialFxReplayUpdates",
    );
    updates.push(...activeSpecialFxReplayUpdates);
  }

  // AddBalls2 only creates a missile ball. Michelle begins native missile
  // flight after LaunchMissile is applied to the existing ball, so activation
  // remains the final dependent action on the same authored stamp.
  updates.push(...buildMissileLaunchActionUpdates({
    buildLaunchMissilePayload: options.buildLaunchMissilePayload,
    entities,
    stamp,
  }));

  const containsFreshAcquireMissiles = entities.some(
    (entity) => entity && entity.kind === "missile",
  );
  if (options.tagFreshAcquireLifecycle === true) {
    updates = tagUpdatesFreshAcquireLifecycleGroup(updates);
  }
  if (containsFreshAcquireMissiles) {
    updates = tagUpdatesMissileLifecycleGroup(updates);
    updates = stripMissileFreshAcquireModeReplayUpdates(entities, updates);
    if (options.containsOwnerLaunchedMissiles === true) {
      updates = tagUpdatesOwnerMissileLifecycleGroup(updates);
    }
  }

  return {
    containsFreshAcquireMissiles,
    updates,
  };
}

function buildSessionStampedAddBallsPresentationForSession(options = {}) {
  const session = options.session || null;
  const inputEntities = Array.isArray(options.entities) ? options.entities : [];
  const isReadyForDestiny =
    typeof options.isReadyForDestiny === "function"
      ? options.isReadyForDestiny
      : () => true;
  const emptyResult = {
    updates: [],
    sendOptions: {
      translateStamps: false,
    },
  };
  if (!session || !isReadyForDestiny(session) || inputEntities.length === 0) {
    return emptyResult;
  }

  const filterBallparkEntitiesForSession =
    typeof options.filterBallparkEntitiesForSession === "function"
      ? options.filterBallparkEntitiesForSession
      : (_targetSession, entities) => entities;
  const filteredEntities = filterBallparkEntitiesForSession(
    session,
    inputEntities,
  );
  if (!Array.isArray(filteredEntities) || filteredEntities.length === 0) {
    return emptyResult;
  }

  const refreshEntitiesForSlimPayload =
    typeof options.refreshEntitiesForSlimPayload === "function"
      ? options.refreshEntitiesForSlimPayload
      : (entities) => entities;
  const refreshedEntities = refreshEntitiesForSlimPayload(filteredEntities);
  if (!Array.isArray(refreshedEntities) || refreshedEntities.length === 0) {
    return emptyResult;
  }
  const stamp = normalizeDestinyStamp(options.sessionStamp, 0);
  const nowMs = Number.isFinite(Number(options.nowMs))
    ? Number(options.nowMs)
    : 0;
  if (typeof options.buildDestinyPresentationForSession !== "function") {
    throw new TypeError(
      "buildSessionStampedAddBallsPresentationForSession requires buildDestinyPresentationForSession",
    );
  }
  const getCurrentSessionFileTime =
    typeof options.getCurrentSessionFileTime === "function"
      ? options.getCurrentSessionFileTime
      : () => 0;

  const presentation = options.buildDestinyPresentationForSession(
    session,
    refreshedEntities,
    stamp,
    { nowMs },
  );
  const presentationEntities =
    presentation && Array.isArray(presentation.entities)
      ? presentation.entities
      : [];
  const presentationRawSimTimeMs =
    presentation && presentation.rawSimTimeMs;
  const simFileTime = getCurrentSessionFileTime(
    session,
    presentationRawSimTimeMs,
  );
  const containsOwnerLaunchedMissiles =
    typeof options.containsOwnerLaunchedMissiles === "function"
      ? options.containsOwnerLaunchedMissiles(session, presentationEntities)
      : options.containsOwnerLaunchedMissiles === true;
  const { updates } = buildAddBallsPresentationUpdates({
    stamp,
    entities: presentationEntities,
    simFileTime,
    presentationRawSimTimeMs,
    scene: options.scene || null,
    session,
    replayActiveSpecialFx: options.replayActiveSpecialFx === true,
    tagFreshAcquireLifecycle: options.tagFreshAcquireLifecycle === true,
    containsOwnerLaunchedMissiles,
    buildAddBalls2Payload: options.buildAddBalls2Payload,
    buildLaunchMissilePayload: options.buildLaunchMissilePayload,
    buildPrimeUpdatesForEntities: options.buildPrimeUpdatesForEntities,
    buildModeUpdates: options.buildModeUpdates,
    buildActiveSpecialFxReplayUpdates:
      options.buildActiveSpecialFxReplayUpdates,
  });

  return {
    updates,
    sendOptions: {
      translateStamps: false,
    },
  };
}

module.exports = {
  buildAddBallsPresentationUpdates,
  buildInitialBootstrapAddBallsPresentationUpdate,
  buildInitialBootstrapSetStatePresentationUpdate,
  buildSessionStampedAddBallsPresentationForSession,
};
