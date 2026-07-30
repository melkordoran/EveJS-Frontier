const destiny = require("../index.js");
const {
  projectPreviouslySentDestinyLane,
} = require("../delivery/deliveryPolicy.js");
const {
  resolveStateRefreshStamp,
} = require("../delivery/sync.js");
const {
  DESTINY_CONTRACTS,
} = require("../authority/destinyContracts.js");
const {
  resolveDestinyAuthorityLaneTuple,
  snapshotDestinyAuthorityState,
} = require("../authority/destinySessionState.js");
const {
  getDestinyStampForwardDistance,
  hasDestinyStamp,
  normalizeDestinyStamp,
  resolveOptionalDestinyStamp,
} = require("../delivery/stamps");

function createMovementSceneRefresh(deps = {}) {
  const {
    buildMissileSessionSnapshot,
    buildDbuffStateEntriesForSession,
    notifyActiveAssistanceJamStatesToSession,
    notifyActiveHostileJamStatesToSession,
    notifyActiveCommandBurstHudStatesToSession,
    isReadyForDestiny,
    logMissileDebug,
    logMovementDebug,
    refreshEntitiesForSlimPayload,
    refreshShipPresentationFields,
    roundNumber,
    summarizeRuntimeEntityForMissileDebug,
    toInt,
    MICHELLE_HELD_FUTURE_DESTINY_LEAD,
  } = deps;

  return {
    sendStateRefresh(runtime, session, egoEntity, stampOverride = null, options = {}) {
      if (!session || !egoEntity || !isReadyForDestiny(session)) {
        return;
      }

      refreshShipPresentationFields(egoEntity);
      const visibleEntities = refreshEntitiesForSlimPayload(
        runtime.getVisibleEntitiesForSession(session),
      );
      const stateRefreshVisibleEntities = visibleEntities.filter((entity) => !(
        entity &&
        entity.dungeonMaterializedSiteContent === true &&
        entity.staticVisibilityScope === "bubble"
      ));
      const rawStamp =
        stampOverride === null
          ? runtime.getNextDestinyStamp()
          : normalizeDestinyStamp(
              stampOverride,
              runtime.getNextDestinyStamp(),
            );
      const rawSimTimeMs =
        options.nowMs === undefined || options.nowMs === null
          ? runtime.getCurrentSimTimeMs()
          : Number(options.nowMs);
      const currentRawDispatchStamp = runtime.getCurrentDestinyStamp(rawSimTimeMs);
      const requestedStamp = runtime.translateDestinyStampForSession(session, rawStamp);
      const currentSessionStamp = runtime.getCurrentSessionDestinyStamp(
        session,
        rawSimTimeMs,
      );
      const authorityState = snapshotDestinyAuthorityState(session);
      const legacyState = session._space;
      const currentImmediateSessionStamp = runtime.getImmediateDestinyStampForSession(
        session,
        currentSessionStamp,
      );
      const lastPresentedLane = resolveDestinyAuthorityLaneTuple({
        authorityState,
        legacyState,
        stampKey: "lastPresentedStamp",
        rawDispatchKey: "lastRawDispatchStamp",
        legacyStampKey: "lastSentDestinyStamp",
        legacyRawDispatchKey: "lastSentDestinyRawDispatchStamp",
      });
      const rawLastSentDestinyStamp = lastPresentedLane.stamp;
      const lastSentDestinyRawDispatchStamp =
        lastPresentedLane.rawDispatchStamp;
      const ownerMissileLifecycleLane = resolveDestinyAuthorityLaneTuple({
        authorityState,
        legacyState,
        stampKey: "lastOwnerMissileLifecycleStamp",
        rawDispatchKey: "lastOwnerMissileLifecycleRawDispatchStamp",
        legacyStampKey: "lastOwnerMissileLifecycleStamp",
        legacyRawDispatchKey: "lastOwnerMissileLifecycleRawDispatchStamp",
      });
      const lastOwnerMissileLifecycleStamp = resolveOptionalDestinyStamp(
        ownerMissileLifecycleLane.stamp,
      );
      const lastOwnerMissileFreshAcquireStamp = resolveOptionalDestinyStamp(
        authorityState && authorityState.lastOwnerMissileFreshAcquireStamp,
        session._space && session._space.lastOwnerMissileFreshAcquireStamp,
      );
      const lastSentLooksOwnerMissileLifecycle =
        hasDestinyStamp(rawLastSentDestinyStamp) &&
        (
          (
            hasDestinyStamp(lastOwnerMissileLifecycleStamp) &&
            rawLastSentDestinyStamp === lastOwnerMissileLifecycleStamp
          ) ||
          (
            hasDestinyStamp(lastOwnerMissileFreshAcquireStamp) &&
            rawLastSentDestinyStamp === lastOwnerMissileFreshAcquireStamp
          )
        );
      const lastSentDestinyStamp = lastSentLooksOwnerMissileLifecycle
        ? null
        : rawLastSentDestinyStamp;
      const lastSentRawDispatchDelta =
        hasDestinyStamp(lastSentDestinyRawDispatchStamp)
          ? getDestinyStampForwardDistance(
              lastSentDestinyRawDispatchStamp,
              currentRawDispatchStamp,
            )
          : null;
      const projectedLastSentLane =
        hasDestinyStamp(lastSentDestinyStamp) &&
        lastSentRawDispatchDelta !== null &&
        lastSentRawDispatchDelta > 0 &&
        lastSentRawDispatchDelta <= 1
          ? projectPreviouslySentDestinyLane(
            lastSentDestinyStamp,
            lastSentDestinyRawDispatchStamp,
            currentRawDispatchStamp,
          )
          : null;
      const lastOwnerMissileLifecycleRawDispatchStamp =
        ownerMissileLifecycleLane.rawDispatchStamp;
      const ownerMissileLifecycleRawDispatchDelta =
        hasDestinyStamp(lastOwnerMissileLifecycleRawDispatchStamp)
          ? getDestinyStampForwardDistance(
              lastOwnerMissileLifecycleRawDispatchStamp,
              currentRawDispatchStamp,
            )
          : null;
      const projectedOwnerMissileLifecycleLane =
        hasDestinyStamp(lastOwnerMissileLifecycleStamp) &&
        ownerMissileLifecycleRawDispatchDelta !== null &&
        ownerMissileLifecycleRawDispatchDelta > 0 &&
        ownerMissileLifecycleRawDispatchDelta <= 1
          ? projectPreviouslySentDestinyLane(
            lastOwnerMissileLifecycleStamp,
            lastOwnerMissileLifecycleRawDispatchStamp,
            currentRawDispatchStamp,
          )
          : null;
      const lastPilotCommandMovementStamp = resolveOptionalDestinyStamp(
        authorityState && authorityState.lastOwnerCommandStamp,
        session._space && session._space.lastPilotCommandMovementStamp,
      );
      const refreshStampState = resolveStateRefreshStamp({
        requestedStamp,
        currentSessionStamp,
        currentImmediateSessionStamp,
        recentEmittedOwnerCriticalMaxLead: MICHELLE_HELD_FUTURE_DESTINY_LEAD,
        lastSentDestinyStamp,
        projectedLastSentLane,
        lastOwnerMissileLifecycleStamp,
        projectedOwnerMissileLifecycleLane,
        lastPilotCommandMovementStamp,
      });
      const {
        recentFutureLastSentLane,
        recentProjectedLastSentLane,
        recentOwnerMissileLifecycleLane,
        recentProjectedOwnerMissileLifecycleLane,
        recentOwnerMovementLane,
        monotonicRefreshFloorBase,
        liveStateResetFloor,
        stamp,
      } = refreshStampState;
      const simFileTime = runtime.getCurrentSessionFileTime(session, rawSimTimeMs);
      logMissileDebug("set-state.refresh", {
        reason:
          typeof options.reason === "string"
            ? options.reason
            : null,
        session: buildMissileSessionSnapshot(runtime, session, rawSimTimeMs),
        egoEntity: summarizeRuntimeEntityForMissileDebug(egoEntity),
        rawSimTimeMs: roundNumber(rawSimTimeMs, 3),
        rawDispatchStamp: currentRawDispatchStamp,
        rawRequestedStamp: normalizeDestinyStamp(rawStamp),
        requestedStamp,
        rawLastSentDestinyStamp,
        lastSentLooksOwnerMissileLifecycle,
        recentFutureLastSentLane,
        recentProjectedLastSentLane,
        recentOwnerMissileLifecycleLane,
        recentProjectedOwnerMissileLifecycleLane,
        lastOwnerMissileFreshAcquireStamp,
        recentOwnerMovementLane,
        monotonicRefreshFloorBase,
        liveStateResetFloor,
        finalStamp: stamp,
        visibleEntityCount: stateRefreshVisibleEntities.length,
      });
      // SetState must skip the owner-critical monotonic restamp pass.
      // During missile combat, lifecycle stamps compound far ahead of
      // current time. The monotonic pass would lift the SetState stamp to
      // match those compounded stamps, creating a _latest_set_state_time
      // floor that invalidates all subsequent near-current-time updates.
      // SetState at near-current time is safe: in-flight missile updates
      // at higher stamps are ABOVE the floor and won't be discarded.
      runtime.sendDestinyUpdates(session, [
        {
          stamp,
          payload: destiny.buildSetStatePayload(
            stamp,
            runtime.system,
            egoEntity.itemID,
            stateRefreshVisibleEntities,
            simFileTime,
            typeof buildDbuffStateEntriesForSession === "function"
              ? buildDbuffStateEntriesForSession(session, egoEntity, rawSimTimeMs)
              : [],
          ),
        },
      ], false, {
        destinyAuthorityContract: DESTINY_CONTRACTS.STATE_RESET,
        skipOwnerMonotonicRestamp: true,
        translateStamps: false,
        missileDebugReason:
          typeof options.reason === "string"
            ? `set-state:${options.reason}`
            : "set-state:unspecified",
      });
      if (
        options.skipHudIconReseed !== true &&
        typeof notifyActiveAssistanceJamStatesToSession === "function"
      ) {
        notifyActiveAssistanceJamStatesToSession(
          runtime,
          session,
          egoEntity,
          stateRefreshVisibleEntities,
          rawSimTimeMs,
        );
      }
      if (
        options.skipHudIconReseed !== true &&
        typeof notifyActiveHostileJamStatesToSession === "function"
      ) {
        notifyActiveHostileJamStatesToSession(
          runtime,
          session,
          egoEntity,
          stateRefreshVisibleEntities,
          rawSimTimeMs,
        );
      }
      if (
        options.skipHudIconReseed !== true &&
        typeof notifyActiveCommandBurstHudStatesToSession === "function"
      ) {
        notifyActiveCommandBurstHudStatesToSession(
          runtime,
          session,
          egoEntity,
          rawSimTimeMs,
        );
      }
    },

    scheduleWatcherMovementAnchor(
      runtime,
      entity,
      now = runtime.getCurrentSimTimeMs(),
      reason = "movement",
    ) {
      if (!entity) {
        return false;
      }

      entity.lastObserverCorrectionBroadcastAt = 0;
      logMovementDebug("observer.anchor.scheduled", entity, {
        reason,
      });
      return true;
    },
  };
}

module.exports = {
  createMovementSceneRefresh,
};
