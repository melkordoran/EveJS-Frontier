"use strict";

const {
  getEntityMapKey,
  normalizeEntityID,
} = require("../identity/entityID");

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeSet(value) {
  const result = new Set();
  const entries = value instanceof Set
    ? value
    : Array.isArray(value)
      ? value
      : [];
  for (const entry of entries) {
    const entityID = getEntityMapKey(entry);
    if (entityID !== null) {
      result.add(entityID);
    }
  }
  return result;
}

function buildPostWarpLandingVisibilityPresentation(options = {}) {
  const reconcile = options.reconcile && typeof options.reconcile === "object"
    ? options.reconcile
    : null;
  if (!reconcile || !reconcile.session || !reconcile.session._space) {
    return {
      dynamicDelta: null,
      staticDelta: null,
      updates: [],
    };
  }

  const session = reconcile.session;
  const deliveryGeneration = session._space;
  const nowMs = Number(reconcile.nowMs) || 0;
  const sessionStamp = toInt(reconcile.sessionStamp, 0) >>> 0;
  const completionUpdates = Array.isArray(reconcile.completionUpdates)
    ? reconcile.completionUpdates
    : (
        typeof options.buildPilotWarpCompletionUpdates === "function"
          ? options.buildPilotWarpCompletionUpdates(
              reconcile.entity,
              sessionStamp,
            )
          : []
      );
  const visibilityClusterKeyOverride = String(
    reconcile.visibilityClusterKeyOverride || "",
  ).trim() || null;
  const visibilityPositionOverride =
    reconcile.visibilityPositionOverride &&
    typeof reconcile.visibilityPositionOverride === "object"
      ? reconcile.visibilityPositionOverride
      : null;
  const removedEntityIDs = [];
  const addedEntities = [];
  let nextVisibleDynamicEntityIDs = null;
  let nextFreshlyVisibleDynamicEntityIDs = null;
  let nextVisibleStaticEntityIDs = null;

  const dynamicDelta =
    typeof options.buildDynamicVisibilityDeltaForSession === "function"
      ? options.buildDynamicVisibilityDeltaForSession(session, nowMs, {
          bypassPilotWarpQuietWindow: true,
          visibilityClusterKeyOverride,
          visibilityPositionOverride,
        })
      : null;

  if (dynamicDelta) {
    const formationRefreshEntities =
      typeof options.getFleetWarpFormationCompanionEntitiesForSession === "function"
        ? options.getFleetWarpFormationCompanionEntitiesForSession(session, nowMs)
        : [];
    const formationRefreshEntityIDs = new Set(
      normalizeArray(formationRefreshEntities)
        .map((entity) => getEntityMapKey(entity && entity.itemID))
        .filter((entityID) => entityID !== null),
    );
    const removedIDs = normalizeArray(dynamicDelta.removedIDs).filter(
      (entityID) => !formationRefreshEntityIDs.has(getEntityMapKey(entityID)),
    );
    removedEntityIDs.push(...removedIDs);
    const dynamicAddedEntities = normalizeArray(dynamicDelta.addedEntities);
    addedEntities.push(...dynamicAddedEntities);

    nextVisibleDynamicEntityIDs = new Set([
      ...normalizeSet(dynamicDelta.desiredIDs),
      ...formationRefreshEntityIDs,
    ]);
    nextFreshlyVisibleDynamicEntityIDs = new Set(
      dynamicAddedEntities
        .map((visibleEntity) => getEntityMapKey(visibleEntity.itemID))
        .filter((entityID) => entityID !== null),
    );
  }

  const staticDelta =
    typeof options.buildStaticVisibilityDeltaForSession === "function"
      ? options.buildStaticVisibilityDeltaForSession(session, nowMs, {
          dedicatedSiteStaticInstanceIDOverride: normalizeEntityID(
            reconcile.siteMaterializationInstanceID,
          ),
          visibilityClusterKeyOverride,
          visibilityPositionOverride,
        })
      : null;

  if (staticDelta) {
    removedEntityIDs.push(...normalizeArray(staticDelta.removedIDs));
    addedEntities.push(...normalizeArray(staticDelta.addedEntities));
    nextVisibleStaticEntityIDs = new Set(normalizeSet(staticDelta.desiredIDs));
  }

  const uniqueAddedEntities = [];
  const addedEntityIDs = new Set();
  for (const visibleEntity of addedEntities) {
    const entityID = getEntityMapKey(visibleEntity && visibleEntity.itemID);
    if (entityID === null || addedEntityIDs.has(entityID)) {
      continue;
    }
    addedEntityIDs.add(entityID);
    uniqueAddedEntities.push(visibleEntity);
  }
  const normalizedRemovedEntityIDs = normalizeSet(removedEntityIDs);
  const unchangedIntersectionIDs = new Set(
    [...normalizedRemovedEntityIDs].filter((entityID) => addedEntityIDs.has(entityID)),
  );
  const effectiveAddedEntities = uniqueAddedEntities.filter(
    (entity) => !unchangedIntersectionIDs.has(getEntityMapKey(entity && entity.itemID)),
  );
  for (const entityID of unchangedIntersectionIDs) {
    if (nextFreshlyVisibleDynamicEntityIDs instanceof Set) {
      nextFreshlyVisibleDynamicEntityIDs.delete(entityID);
    }
  }
  const uniqueRemovedEntityIDs = [...normalizedRemovedEntityIDs].filter(
    (entityID) => !addedEntityIDs.has(entityID),
  );
  const removeUpdates =
    uniqueRemovedEntityIDs.length > 0 &&
    typeof options.buildRemoveBallsUpdates === "function"
      ? options.buildRemoveBallsUpdates(uniqueRemovedEntityIDs, {
          nowMs,
          packagedBubbleHistory: true,
          stampOverride: sessionStamp,
        })
      : [];
  const addPresentation =
    effectiveAddedEntities.length > 0 &&
    typeof options.buildSessionStampedAddBallsUpdatesForSession === "function"
      ? options.buildSessionStampedAddBallsUpdatesForSession(
          session,
          effectiveAddedEntities,
          sessionStamp,
          {
            nowMs,
            tagFreshAcquireLifecycle: true,
          },
        )
      : null;
  // Carbon's ParkUpdateBatcher plans the complete visibility delta once:
  // every deletion first, followed by one addition snapshot on currentTime.
  const landingUpdates = [
    ...completionUpdates,
    ...removeUpdates,
    ...(addPresentation ? normalizeArray(addPresentation.updates) : []),
  ];

  const onDeliveryCommit = () => {
    if (session._space !== deliveryGeneration) {
      return;
    }
    if (nextVisibleDynamicEntityIDs instanceof Set) {
      session._space.visibleDynamicEntityIDs = new Set(
        nextVisibleDynamicEntityIDs,
      );
    }
    if (nextFreshlyVisibleDynamicEntityIDs instanceof Set) {
      session._space.freshlyVisibleDynamicEntityIDs = new Set(
        nextFreshlyVisibleDynamicEntityIDs,
      );
    }
    if (nextVisibleStaticEntityIDs instanceof Set) {
      session._space.visibleBubbleScopedStaticEntityIDs = new Set(
        nextVisibleStaticEntityIDs,
      );
    }
    // Handoff intent is delivery authority until the final visibility delta is
    // accepted. Clearing it during simulation completion loses rollback/retry
    // state and lets a rejected packet strand the client in the source bubble.
    session._space.pilotWarpVisibilityHandoff = null;
  };

  return {
    dynamicDelta,
    addedEntities: effectiveAddedEntities,
    onDeliveryCommit,
    removedEntityIDs: uniqueRemovedEntityIDs,
    staticDelta,
    updates: landingUpdates,
  };
}

function queueFleetWarpCompanionLandingPresentation(options = {}) {
  const entity = options.entity && typeof options.entity === "object"
    ? options.entity
    : null;
  const sessionOnlyUpdates = Array.isArray(options.sessionOnlyUpdates)
    ? options.sessionOnlyUpdates
    : null;
  if (!entity || !sessionOnlyUpdates) {
    return 0;
  }

  const nowMs = Number(options.nowMs) || 0;
  const getActiveFleetWarpFormationID =
    typeof options.getActiveFleetWarpFormationID === "function"
      ? options.getActiveFleetWarpFormationID
      : null;
  const entityFormationID = getActiveFleetWarpFormationID
    ? getActiveFleetWarpFormationID(entity, nowMs)
    : "";
  if (!entityFormationID) {
    return 0;
  }

  const sessions = options.sessions && typeof options.sessions[Symbol.iterator] === "function"
    ? options.sessions
    : [];
  const isReadyForDestiny =
    typeof options.isReadyForDestiny === "function"
      ? options.isReadyForDestiny
      : () => false;
  const isEntityInSessionFleetWarpFormation =
    typeof options.isEntityInSessionFleetWarpFormation === "function"
      ? options.isEntityInSessionFleetWarpFormation
      : () => false;
  const getShipEntityForSession =
    typeof options.getShipEntityForSession === "function"
      ? options.getShipEntityForSession
      : () => null;
  const getHistorySafeSessionDestinyStamp =
    typeof options.getHistorySafeSessionDestinyStamp === "function"
      ? options.getHistorySafeSessionDestinyStamp
      : null;
  const buildSessionStampedAddBallsUpdatesForSession =
    typeof options.buildSessionStampedAddBallsUpdatesForSession === "function"
      ? options.buildSessionStampedAddBallsUpdatesForSession
      : null;
  if (!getHistorySafeSessionDestinyStamp || !buildSessionStampedAddBallsUpdatesForSession) {
    return 0;
  }

  const leadTicks = toInt(options.pilotWarpActivationDelayTicks, 0);
  let queuedSessions = 0;
  for (const session of sessions) {
    if (!isReadyForDestiny(session) || !session._space) {
      continue;
    }
    if (!isEntityInSessionFleetWarpFormation(session, entity, nowMs)) {
      continue;
    }

    const egoEntity = getShipEntityForSession(session);
    if (!egoEntity || egoEntity.mode === "WARP" || egoEntity.pendingWarp) {
      continue;
    }

    const sessionStamp = getHistorySafeSessionDestinyStamp(
      session,
      nowMs,
      leadTicks,
      leadTicks,
    );
    const addPresentation = buildSessionStampedAddBallsUpdatesForSession(
      session,
      [entity],
      sessionStamp,
      {
        nowMs,
        tagFreshAcquireLifecycle: true,
      },
    );
    if (!addPresentation || normalizeArray(addPresentation.updates).length <= 0) {
      continue;
    }

    const visibleIDs = session._space.visibleDynamicEntityIDs instanceof Set
      ? session._space.visibleDynamicEntityIDs
      : new Set();
    const freshIDs = session._space.freshlyVisibleDynamicEntityIDs instanceof Set
      ? session._space.freshlyVisibleDynamicEntityIDs
      : new Set();
    const entityID = getEntityMapKey(entity.itemID);
    if (
      entityID === null ||
      normalizeSet(visibleIDs).has(entityID) ||
      normalizeSet(freshIDs).has(entityID)
    ) {
      continue;
    }

    const deliveryGeneration = session._space;
    const commitCompanionVisibility = () => {
      if (session._space !== deliveryGeneration) {
        return;
      }
      const committedVisibleIDs = normalizeSet(
        session._space.visibleDynamicEntityIDs,
      );
      const committedFreshIDs = normalizeSet(
        session._space.freshlyVisibleDynamicEntityIDs,
      );
      committedVisibleIDs.add(entityID);
      committedFreshIDs.add(entityID);
      session._space.visibleDynamicEntityIDs = committedVisibleIDs;
      session._space.freshlyVisibleDynamicEntityIDs = committedFreshIDs;
    };
    sessionOnlyUpdates.push({
      session,
      updates: addPresentation.updates,
      sendOptions: {
        ...(addPresentation.sendOptions || {}),
        onDeliveryCommit: commitCompanionVisibility,
      },
    });
    queuedSessions += 1;
  }

  return queuedSessions;
}

module.exports = {
  buildPostWarpLandingVisibilityPresentation,
  queueFleetWarpCompanionLandingPresentation,
};
