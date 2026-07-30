"use strict";

function snapshotArray(value) {
  return Array.isArray(value) ? [...value] : [];
}

function runFinalSceneTickVisibilityCoordinator(options = {}) {
  const topologyEntities = snapshotArray(options.topologyEntities);
  const bubbleEntities = snapshotArray(options.bubbleEntities);
  const sessions = snapshotArray(options.sessions);
  const landingReconciles = snapshotArray(options.landingReconciles);
  const reconcilePublicGrid = typeof options.reconcilePublicGrid === "function"
    ? options.reconcilePublicGrid
    : null;
  const reconcileBubble = typeof options.reconcileBubble === "function"
    ? options.reconcileBubble
    : null;
  const composePublicGrids = typeof options.composePublicGrids === "function"
    ? options.composePublicGrids
    : null;
  const reconcileLanding = typeof options.reconcileLanding === "function"
    ? options.reconcileLanding
    : null;
  const resolveWarpHandoffEntity =
    typeof options.resolveWarpHandoffEntity === "function"
      ? options.resolveWarpHandoffEntity
      : null;
  const reconcileWarpHandoff =
    typeof options.reconcileWarpHandoff === "function"
      ? options.reconcileWarpHandoff
      : null;
  const reconcileGenericSession =
    typeof options.reconcileGenericSession === "function"
      ? options.reconcileGenericSession
      : null;

  const topologyEntitySet = new Set();
  let topologyEntityCount = 0;
  for (const entity of topologyEntities) {
    if (!entity || topologyEntitySet.has(entity)) {
      continue;
    }
    topologyEntitySet.add(entity);
    topologyEntityCount += 1;
    if (reconcilePublicGrid) {
      reconcilePublicGrid(entity);
    }
  }
  const bubbleEntitySet = new Set();
  let bubbleEntityCount = 0;
  for (const entity of bubbleEntities) {
    if (
      !entity ||
      entity.mode === "WARP" ||
      bubbleEntitySet.has(entity)
    ) {
      continue;
    }
    bubbleEntitySet.add(entity);
    bubbleEntityCount += 1;
    if (reconcileBubble) {
      reconcileBubble(entity);
    }
  }
  if (composePublicGrids) {
    composePublicGrids();
  }

  // These Sets are an ephemeral plan over the current scene tick. They neither
  // retain membership nor duplicate the generation-owned visibility ledgers.
  const landingSessions = new Set();
  let landingSessionCount = 0;
  for (const reconcile of landingReconciles) {
    const session = reconcile && reconcile.session;
    if (!session || landingSessions.has(session)) {
      continue;
    }
    // A stale or rejected landing must not fall through to the generic path and
    // disturb its quiet/retry boundary.
    landingSessions.add(session);
    landingSessionCount += 1;
    if (reconcileLanding) {
      reconcileLanding(reconcile);
    }
  }

  let warpHandoffSessionCount = 0;
  let genericSessionCount = 0;
  const processedSessions = new Set(landingSessions);
  for (const session of sessions) {
    if (!session || processedSessions.has(session)) {
      continue;
    }
    processedSessions.add(session);
    const warpEntity = resolveWarpHandoffEntity
      ? resolveWarpHandoffEntity(session)
      : null;
    if (warpEntity) {
      warpHandoffSessionCount += 1;
      if (reconcileWarpHandoff) {
        reconcileWarpHandoff(session, warpEntity);
      }
      continue;
    }
    genericSessionCount += 1;
    if (reconcileGenericSession) {
      reconcileGenericSession(session);
    }
  }

  return {
    bubbleEntityCount,
    genericSessionCount,
    landingSessionCount,
    topologyEntityCount,
    warpHandoffSessionCount,
  };
}

module.exports = {
  runFinalSceneTickVisibilityCoordinator,
};
