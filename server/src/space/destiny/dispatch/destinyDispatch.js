const {
  createDestinyAuthority,
} = require("../authority/destinyAuthority.js");
const {
  resolveDestinyAuthorityLaneTuple,
  snapshotDestinyAuthorityState,
  updateDestinyAuthorityState,
} = require("../authority/destinySessionState.js");
const {
  DESTINY_CONTRACTS,
} = require("../authority/destinyContracts.js");
const {
  recordSyncLedgerEvent,
  summarizeDestinyUpdates,
} = require("../../../network/syncLedger");
const {
  extractPayloadEntityIDs,
} = require("../protocol/payloadIdentity");
const {
  getEntityMapKey,
} = require("../identity/entityID");
const {
  getPendingVisibilityRemovalIDs,
} = require("../visibility/acquisition");
const spatialTrace = require("../../../network/spatialTrace");
const {
  advanceDestinyStamp,
  compareDestinyStamps,
  getDestinyStampForwardDistance,
  hasDestinyStamp,
  isDestinyStampAfter,
  isDestinyStampWithinForwardWindow,
  normalizeDestinyStamp,
  resolveOptionalDestinyStamp,
  selectFurthestDestinyStamp,
  selectLaterDestinyStamp,
} = require("../delivery/stamps");
const {
  commitDestinyDeliveryTransaction,
  createDestinyDeliveryTransaction,
  isDestinyDeliveryTransactionGenerationCurrent,
  mergeDestinyDeliveryTransactions,
  registerDestinyDeliveryHooks,
  restoreAuthorityDeliveryStateForGeneration,
  retryDestinyDeliveryTransaction,
  rollbackDestinyDeliveryTransaction,
  snapshotAuthorityDeliveryState,
  stageDestinyDeliveryTransaction,
} = require("../delivery/deliveryTransaction.js");
const {
  appendParkHistoryGroup,
  buildParkHistoryFlushGroups,
  orderParkHistoryGroups,
} = require("../batching/parkUpdateBatcher.js");
const {
  appendSystemHistoryAction,
  takeSystemHistoryActions,
} = require("../batching/systemHistory.js");
const {
  attemptDestinyNotificationDelivery,
  destroySessionAfterUnsafeDestinyDelivery,
  isSessionOpenForDestinyDelivery,
} = require("../delivery/michelleContract.js");

// Delivery transactions can be created, retained, and flushed through
// different dispatch facades over the same runtime. Keep their ephemeral plan
// guards discoverable across factory instances without adding runtime truth.
const DESTINY_DELIVERY_PLAN_GUARDS = Symbol(
  "destinyDeliveryPlanGuards",
);
const entityPresentationPlanByTransaction = new WeakMap();
const drainingTickPresentationPrefixToken = Symbol(
  "drainingTickPresentationPrefix",
);

function createMovementDestinyDispatch(deps = {}) {
  const {
    buildMissileSessionMutation,
    buildMissileSessionSnapshot,
    clamp,
    destiny,
    getPayloadPrimaryEntityID,
    getNextMissileDebugTraceID,
    isVisibilityRemovalPresentationAuthorized,
    isMovementContractPayload,
    isReadyForDestiny,
    logDestinyDispatch,
    logMissileDebug,
    normalizeTraceValue,
    resolveDestinyLifecycleRestampState,
    resolveOwnerMonotonicState,
    resolvePreviousLastSentDestinyWasOwnerCritical,
    roundNumber,
    shouldLogMissilePayloadGroup,
    summarizeMissileUpdatesForLog,
    toInt,
    updatesContainMovementContractPayload,
    MICHELLE_DIRECT_CRITICAL_ECHO_DESTINY_LEAD,
    MICHELLE_HELD_FUTURE_DESTINY_LEAD,
    MICHELLE_POST_HELD_FUTURE_DESTINY_LEAD,
    PILOT_WARP_ACTIVATION_DELAY_DESTINY_TICKS,
    PILOT_WARP_HISTORY_SAFE_DESTINY_LEAD =
      PILOT_WARP_ACTIVATION_DELAY_DESTINY_TICKS,
  } = deps;
  const registerDestinyDeliveryPlanGuard = (transaction, options = {}) => {
    const guard = options && typeof options.deliveryPlanGuard === "function"
      ? options.deliveryPlanGuard
      : null;
    if (!transaction || !guard) {
      return transaction;
    }
    if (!(transaction[DESTINY_DELIVERY_PLAN_GUARDS] instanceof Set)) {
      Object.defineProperty(transaction, DESTINY_DELIVERY_PLAN_GUARDS, {
        configurable: false,
        enumerable: false,
        value: new Set(),
        writable: false,
      });
    }
    transaction[DESTINY_DELIVERY_PLAN_GUARDS].add(guard);
    return transaction;
  };
  const getDestinyDeliveryPlanGuard = (options = {}) => (
    options && typeof options.deliveryPlanGuard === "function"
      ? options.deliveryPlanGuard
      : null
  );
  const isIncomingDestinyDeliveryPlanCurrent = (
    options = {},
    transaction = null,
  ) => {
    const guard = getDestinyDeliveryPlanGuard(options);
    if (!guard) {
      return true;
    }
    try {
      return guard(transaction) === true;
    } catch (_error) {
      return false;
    }
  };
  const mergeDestinyDeliveryPlanGuards = (target, source) => {
    if (!target || !source || target === source) {
      return target || source || null;
    }
    for (const guard of source[DESTINY_DELIVERY_PLAN_GUARDS] instanceof Set
      ? source[DESTINY_DELIVERY_PLAN_GUARDS]
      : []) {
      registerDestinyDeliveryPlanGuard(target, {
        deliveryPlanGuard: guard,
      });
    }
    return target;
  };
  const isDestinyDeliveryPlanCurrent = (transaction) => {
    if (
      !transaction ||
      (transaction.state !== "planning" && transaction.state !== "staged") ||
      !isDestinyDeliveryTransactionGenerationCurrent(transaction)
    ) {
      return false;
    }
    for (const guard of transaction[DESTINY_DELIVERY_PLAN_GUARDS] instanceof Set
      ? transaction[DESTINY_DELIVERY_PLAN_GUARDS]
      : []) {
      try {
        if (guard(transaction) !== true) {
          return false;
        }
      } catch (_error) {
        return false;
      }
    }
    return true;
  };
  const getStaleDestinyDeliveryReason = (transaction) => (
    isDestinyDeliveryTransactionGenerationCurrent(transaction)
      ? "delivery-plan-replaced"
      : "space-generation-replaced"
  );
  const getStaleDestinyDeliveryReasonFromTransactions = (transactions) => {
    let hasReplacedDeliveryPlan = false;
    for (const transaction of transactions || []) {
      if (!isDestinyDeliveryTransactionGenerationCurrent(transaction)) {
        return "space-generation-replaced";
      }
      if (!isDestinyDeliveryPlanCurrent(transaction)) {
        hasReplacedDeliveryPlan = true;
      }
    }
    return hasReplacedDeliveryPlan ? "delivery-plan-replaced" : null;
  };
  const shouldSkipStaleDestinyDeliveryCallbacks = (transaction) => (
    !isDestinyDeliveryTransactionGenerationCurrent(transaction)
  );
  const rollbackDestinyDeliveryTransactionPreservingAuthority = (
    transaction,
    details = {},
  ) => {
    const generationCurrent = isDestinyDeliveryTransactionGenerationCurrent(
      transaction,
    );
    const currentAuthorityState = generationCurrent
      ? snapshotAuthorityDeliveryState(transaction.session)
      : null;
    rollbackDestinyDeliveryTransaction(transaction, details);
    if (
      currentAuthorityState &&
      transaction.session &&
      transaction.session._space === transaction.spaceGeneration
    ) {
      restoreAuthorityDeliveryStateForGeneration(
        transaction.spaceGeneration,
        currentAuthorityState,
      );
    }
    return transaction;
  };
  const OBSERVER_DIRECT_PRESENTED_MONOTONIC_PAYLOAD_NAMES = new Set([
    "AddBalls2",
    "LaunchMissile",
    "RemoveBalls",
    "GotoDirection",
    "GotoPoint",
    "Orbit",
    "FollowBall",
    "Stop",
    "WarpTo",
    "SetBallAgility",
    "SetBallMass",
    "SetMaxSpeed",
    "SetBallMassive",
    "SetSpeedFraction",
    "SetBallPosition",
    "SetBallVelocity",
    "SetBallWarpFactors",
    "CloakBall",
    "UncloakBall",
  ]);
  const destinyAuthority = createDestinyAuthority({
    buildMissileSessionSnapshot,
    clamp,
    destiny,
    getPayloadPrimaryEntityID,
    isMovementContractPayload,
    logMissileDebug,
    normalizeTraceValue,
    resolveDestinyLifecycleRestampState,
    resolveOwnerMonotonicState,
    resolvePreviousLastSentDestinyWasOwnerCritical,
    roundNumber,
    summarizeMissileUpdatesForLog,
    toInt,
    updatesContainMovementContractPayload,
    MICHELLE_DIRECT_CRITICAL_ECHO_DESTINY_LEAD,
    MICHELLE_HELD_FUTURE_DESTINY_LEAD,
    MICHELLE_POST_HELD_FUTURE_DESTINY_LEAD,
    PILOT_WARP_ACTIVATION_DELAY_DESTINY_TICKS,
    PILOT_WARP_HISTORY_SAFE_DESTINY_LEAD,
  });

  function getEntityPresentationIDs(updates) {
    const entityIDs = new Set();
    for (const update of Array.isArray(updates) ? updates : []) {
      const payload = update && Array.isArray(update.payload)
        ? update.payload
        : null;
      if (!payload) {
        continue;
      }
      for (const entityID of extractPayloadEntityIDs(payload)) {
        entityIDs.add(entityID);
      }
    }
    return [...entityIDs];
  }

  function getRemovalSuppressionEntityIDs(payload) {
    const entityIDs = extractPayloadEntityIDs(payload);
    if (
      entityIDs.length === 0 &&
      Array.isArray(payload) &&
      payload[0] === "SetBallMassive" &&
      Array.isArray(payload[1])
    ) {
      const entityID = getEntityMapKey(payload[1][0]);
      return entityID === null ? [] : [entityID];
    }
    return entityIDs;
  }

  function filterPendingRemovalDependentPayloads(
    session,
    payloads,
    options = {},
  ) {
    const pendingRemovalIDs = getPendingVisibilityRemovalIDs(session);
    if (pendingRemovalIDs.size === 0) {
      return payloads;
    }
    return payloads.filter((update) => {
      const payload = update && Array.isArray(update.payload)
        ? update.payload
        : null;
      if (!payload) {
        return true;
      }
      const payloadName = payload[0];
      if (
        payloadName === "RemoveBalls" ||
        payloadName === "RemoveBall" ||
        payloadName === "RemoveGlobalBall" ||
        payloadName === "TerminalPlayDestructionEffect"
      ) {
        return true;
      }
      const entityIDs = getRemovalSuppressionEntityIDs(payload);
      const targetsPendingRemoval = entityIDs.some(
        (entityID) => pendingRemovalIDs.has(getEntityMapKey(entityID)),
      );
      if (!targetsPendingRemoval) {
        return true;
      }
      return Boolean(
        typeof isVisibilityRemovalPresentationAuthorized === "function" &&
        isVisibilityRemovalPresentationAuthorized(
          options,
          session,
          payloadName,
          entityIDs,
        )
      );
    });
  }

  function hasDeliveryHooks(options) {
    return Boolean(
      options &&
      ["onDeliveryCommit", "onDeliveryRollback", "onDeliveryRetry"]
        .some((hookName) => typeof options[hookName] === "function"),
    );
  }

  function getExistingDeliveryTransaction(runtime, session, options = {}) {
    const suppliedTransaction = resolveRootDeliveryTransaction(
      options && options._deliveryTransaction,
    );
    if (suppliedTransaction) {
      return suppliedTransaction;
    }
    const tickEntry =
      runtime &&
      runtime._tickDestinyPresentation &&
      runtime._tickDestinyPresentation.bySession instanceof Map
        ? runtime._tickDestinyPresentation.bySession.get(session)
        : null;
    if (tickEntry && tickEntry.deliveryTransaction) {
      return resolveRootDeliveryTransaction(tickEntry.deliveryTransaction);
    }
    const directEntry =
      runtime &&
      runtime._directDestinyNotificationBatch &&
      runtime._directDestinyNotificationBatch.bySession instanceof Map
        ? runtime._directDestinyNotificationBatch.bySession.get(session)
        : null;
    return resolveRootDeliveryTransaction(
      directEntry && directEntry.deliveryTransaction,
    );
  }

  function rollbackUnplannedDeliveryCall(
    options,
    reason,
    deliveryTransaction = null,
  ) {
    if (!options || typeof options.onDeliveryRollback !== "function") {
      return;
    }
    const transaction = resolveRootDeliveryTransaction(deliveryTransaction);
    if (
      transaction &&
      transaction.rollbackCallbacks instanceof Set &&
      transaction.rollbackCallbacks.has(options.onDeliveryRollback)
    ) {
      return;
    }
    try {
      options.onDeliveryRollback({
        planningOnly: true,
        reason,
      });
    } catch (_rollbackError) {
      // No transaction or physical delivery exists for this call. The hook is
      // best-effort and must not turn local suppression into a scene failure.
    }
  }

  function isDeliveryTransactionRetainedByRuntime(
    runtime,
    session,
    deliveryTransaction,
  ) {
    const transaction = resolveRootDeliveryTransaction(deliveryTransaction);
    return Boolean(
      transaction &&
      resolveRootDeliveryTransaction(
        getExistingDeliveryTransaction(runtime, session, {}),
      ) === transaction,
    );
  }

  function rejectStaleIncomingDeliveryPlan(
    runtime,
    session,
    options,
    deliveryTransaction = null,
  ) {
    const transaction = resolveRootDeliveryTransaction(deliveryTransaction);
    if (isIncomingDestinyDeliveryPlanCurrent(options, transaction)) {
      return false;
    }
    if (
      transaction &&
      transaction.state !== "committed" &&
      transaction.state !== "rolled-back" &&
      !isDeliveryTransactionRetainedByRuntime(runtime, session, transaction)
    ) {
      rollbackDestinyDeliveryTransactionPreservingAuthority(transaction, {
        reason: "delivery-plan-replaced",
      });
    } else {
      rollbackUnplannedDeliveryCall(
        options,
        "delivery-plan-replaced",
        transaction,
      );
    }
    return true;
  }

  function getEntityPresentationPlan(deliveryTransaction) {
    const rootTransaction = resolveRootDeliveryTransaction(deliveryTransaction);
    if (!rootTransaction || typeof rootTransaction !== "object") {
      return null;
    }
    let plan = entityPresentationPlanByTransaction.get(rootTransaction);
    if (!plan) {
      plan = { floorByEntityID: new Map() };
      entityPresentationPlanByTransaction.set(rootTransaction, plan);
    }
    return plan;
  }

  function getEntityPresentationFloor(deliveryTransaction, entityIDs) {
    const plan = getEntityPresentationPlan(deliveryTransaction);
    if (!plan || !Array.isArray(entityIDs) || entityIDs.length === 0) {
      return null;
    }
    return entityIDs.reduce(
      (floor, entityID) => selectLaterDestinyStamp(
        floor,
        plan.floorByEntityID.get(entityID),
      ),
      null,
    );
  }

  function recordEntityPresentationFloor(
    deliveryTransaction,
    entityIDs,
    stamp,
  ) {
    const plan = getEntityPresentationPlan(deliveryTransaction);
    if (
      !plan ||
      !Array.isArray(entityIDs) ||
      entityIDs.length === 0 ||
      !hasDestinyStamp(stamp)
    ) {
      return;
    }
    for (const entityID of entityIDs) {
      plan.floorByEntityID.set(
        entityID,
        selectLaterDestinyStamp(
          plan.floorByEntityID.get(entityID),
          stamp,
        ),
      );
    }
  }

  function updatesContainObserverPresentedMonotonicPayload(
    updates,
    ownerShipID = 0,
  ) {
    return Array.isArray(updates) && updates.some((update) => {
      const payload = update && Array.isArray(update.payload)
        ? update.payload
        : null;
      if (!payload) {
        return false;
      }
      const payloadName = typeof payload[0] === "string"
        ? payload[0]
        : "";
      if (!OBSERVER_DIRECT_PRESENTED_MONOTONIC_PAYLOAD_NAMES.has(payloadName)) {
        return false;
      }
      const primaryEntityID = getPayloadPrimaryEntityID(payload) >>> 0;
      return ownerShipID <= 0 || primaryEntityID <= 0 || primaryEntityID !== ownerShipID;
    });
  }

  function getDestinyHistoryAnchorStampForSession(
    runtime,
    session,
    rawSimTimeMs = runtime.getCurrentSimTimeMs(),
    options = {},
  ) {
    return destinyAuthority.getDestinyHistoryAnchorStampForSession(
      runtime,
      session,
      rawSimTimeMs,
      options,
    );
  }

  function resolveDestinyDeliveryStampForSession(
    runtime,
    session,
    authoredStamp,
    rawSimTimeMs = runtime.getCurrentSimTimeMs(),
    options = {},
  ) {
    return destinyAuthority.resolveDestinyDeliveryStampForSession(
      runtime,
      session,
      authoredStamp,
      rawSimTimeMs,
      options,
    );
  }

  function prepareDestinyUpdateForSession(
    runtime,
    session,
    rawPayload,
    rawSimTimeMs = runtime.getCurrentSimTimeMs(),
    options = {},
  ) {
    return destinyAuthority.prepareDestinyUpdateForSession(
      runtime,
      session,
      rawPayload,
      rawSimTimeMs,
      options,
    );
  }

  function abortActiveTickDestinyPresentationBatch(
    runtime,
    reason = "tick-presentation-replaced",
  ) {
    if (!hasActiveTickDestinyPresentationBatch(runtime)) {
      return 0;
    }

    const tickBatch = runtime._tickDestinyPresentation;
    const abortedTransactions = new Set();
    for (const queued of tickBatch.bySession.values()) {
      const transaction = resolveRootDeliveryTransaction(
        queued && queued.deliveryTransaction,
      );
      if (transaction) {
        abortedTransactions.add(transaction);
      }
    }
    runtime._tickDestinyPresentation = null;

    for (const transaction of abortedTransactions) {
      rollbackDestinyDeliveryTransaction(transaction, { reason });
    }

    const directBatch = runtime._directDestinyNotificationBatch;
    if (directBatch && directBatch.bySession instanceof Map) {
      for (const [sessionKey, queued] of directBatch.bySession.entries()) {
        if (
          abortedTransactions.has(
            resolveRootDeliveryTransaction(
              queued && queued.deliveryTransaction,
            ),
          )
        ) {
          directBatch.bySession.delete(sessionKey);
          if (directBatch.deliveryTransactions instanceof Map) {
            directBatch.deliveryTransactions.delete(sessionKey);
          }
        }
      }
      if (
        directBatch.bySession.size === 0 &&
        runtime._directDestinyNotificationBatch === directBatch
      ) {
        runtime._directDestinyNotificationBatch = null;
      }
    }
    return abortedTransactions.size;
  }

  function beginTickDestinyPresentationBatch(runtime) {
    abortActiveTickDestinyPresentationBatch(runtime);
    flushDirectDestinyNotificationBatch(runtime);
    runtime._tickDestinyPresentation = {
      nextOrder: 0,
      bySession: new Map(),
    };
  }

  function hasActiveTickDestinyPresentationBatch(runtime) {
    return Boolean(
      runtime._tickDestinyPresentation &&
      runtime._tickDestinyPresentation.bySession instanceof Map,
    );
  }

  function shouldDeferPilotMovementForMissilePressure(
    runtime,
    session,
    nowMs = runtime.getCurrentSimTimeMs(),
  ) {
    if (!session || !session._space || !isReadyForDestiny(session)) {
      return false;
    }

    const authorityState = snapshotDestinyAuthorityState(session);
    const currentSessionStamp = runtime.getCurrentSessionDestinyStamp(
      session,
      nowMs,
    );
    const currentVisibleStamp = runtime.getCurrentVisibleSessionDestinyStamp(
      session,
      nowMs,
    );
    const currentRawDispatchStamp = runtime.getCurrentDestinyStamp(nowMs);
    const lastPresentedTuple = resolveDestinyAuthorityLaneTuple({
      authorityState,
      legacyState: session._space,
      stampKey: "lastPresentedStamp",
      rawDispatchKey: "lastRawDispatchStamp",
      legacyStampKey: "lastSentDestinyStamp",
      legacyRawDispatchKey: "lastSentDestinyRawDispatchStamp",
    });
    const lastSentDestinyStamp = lastPresentedTuple.stamp;
    const maximumTrustedMissilePressureLane = selectFurthestDestinyStamp(
      currentSessionStamp,
      [
        currentVisibleStamp,
        lastSentDestinyStamp,
        advanceDestinyStamp(
          currentSessionStamp,
          PILOT_WARP_HISTORY_SAFE_DESTINY_LEAD,
        ),
      ],
      PILOT_WARP_HISTORY_SAFE_DESTINY_LEAD,
    );
    const lastMissileLifecycleTuple = resolveDestinyAuthorityLaneTuple({
      authorityState,
      legacyState: session._space,
      stampKey: "lastMissileLifecycleStamp",
      rawDispatchKey: "lastMissileLifecycleRawDispatchStamp",
      legacyRawDispatchKey: "lastMissileLifecycleRawDispatchStamp",
    });
    const lastMissileLifecycleStamp = lastMissileLifecycleTuple.stamp;
    const lastMissileLifecycleRawDispatchStamp =
      lastMissileLifecycleTuple.rawDispatchStamp;
    const lastOwnerMissileLifecycleTuple =
      resolveDestinyAuthorityLaneTuple({
        authorityState,
        legacyState: session._space,
        stampKey: "lastOwnerMissileLifecycleStamp",
        rawDispatchKey: "lastOwnerMissileLifecycleRawDispatchStamp",
        anchorKey: "lastOwnerMissileLifecycleAnchorStamp",
      });
    const lastOwnerMissileLifecycleStamp =
      lastOwnerMissileLifecycleTuple.stamp;
    const lastOwnerMissileLifecycleRawDispatchStamp =
      lastOwnerMissileLifecycleTuple.rawDispatchStamp;

    const maximumTrustedMissilePressureLead =
      getDestinyStampForwardDistance(
        currentSessionStamp,
        maximumTrustedMissilePressureLane,
      );
    const hasRecentVisibleMissileLifecycle =
      lastMissileLifecycleStamp !== currentSessionStamp &&
      hasDestinyStamp(lastMissileLifecycleRawDispatchStamp) &&
      isDestinyStampWithinForwardWindow(
        currentSessionStamp,
        lastMissileLifecycleStamp,
        maximumTrustedMissilePressureLead,
      ) &&
      getDestinyStampForwardDistance(
        lastMissileLifecycleRawDispatchStamp,
        currentRawDispatchStamp,
      ) <= 2;
    const hasRecentOwnerMissileLifecycle =
      lastOwnerMissileLifecycleStamp !== currentSessionStamp &&
      hasDestinyStamp(lastOwnerMissileLifecycleRawDispatchStamp) &&
      isDestinyStampWithinForwardWindow(
        currentSessionStamp,
        lastOwnerMissileLifecycleStamp,
        maximumTrustedMissilePressureLead,
      ) &&
      getDestinyStampForwardDistance(
        lastOwnerMissileLifecycleRawDispatchStamp,
        currentRawDispatchStamp,
      ) <= 2;

    return hasRecentVisibleMissileLifecycle || hasRecentOwnerMissileLifecycle;
  }

  function normalizeQueuedPresentationSendOptions(sendOptions) {
    const normalized = {
      translateStamps: false,
    };
    if (!sendOptions || typeof sendOptions !== "object") {
      return normalized;
    }
    for (const key of Object.keys(sendOptions)) {
      const value = sendOptions[key];
      if (value !== undefined) {
        normalized[key] = value;
      }
    }
    for (const symbol of Object.getOwnPropertySymbols(sendOptions)) {
      const descriptor = Object.getOwnPropertyDescriptor(sendOptions, symbol);
      if (descriptor) {
        Object.defineProperty(normalized, symbol, descriptor);
      }
    }
    const deliveryTransactionDescriptor = Object.getOwnPropertyDescriptor(
      sendOptions,
      "_deliveryTransaction",
    );
    if (deliveryTransactionDescriptor) {
      Object.defineProperty(
        normalized,
        "_deliveryTransaction",
        deliveryTransactionDescriptor,
      );
    }
    normalized.translateStamps = false;
    return normalized;
  }

  function buildQueuedPresentationSendOptionsSignature(sendOptions) {
    const normalized = normalizeQueuedPresentationSendOptions(sendOptions);
    return JSON.stringify(
      Object.keys(normalized)
        .sort()
        .map((key) => [key, normalized[key]]),
      (_key, value) => (
        typeof value === "bigint"
          ? { __destinyQueuedOptionBigInt: value.toString() }
          : value
      ),
    );
  }

  function appendCollectedDestinyGroup(
    collectedGroups,
    groupDetails = {},
    options = {},
  ) {
    return appendParkHistoryGroup(collectedGroups, groupDetails, {
      ...options,
      toInt,
    });
  }

  function orderCollectedDestinyGroups(collectedGroups) {
    return orderParkHistoryGroups(collectedGroups, { toInt });
  }

  function withDeliveryTransaction(options, deliveryTransaction) {
    const nextOptions = {
      ...(options && typeof options === "object" ? options : {}),
    };
    Object.defineProperty(nextOptions, "_deliveryTransaction", {
      configurable: true,
      enumerable: false,
      value: deliveryTransaction || null,
      writable: false,
    });
    return nextOptions;
  }

  function resolveRootDeliveryTransaction(deliveryTransaction) {
    let current = deliveryTransaction || null;
    const visited = new Set();
    while (
      current &&
      current.state === "merged" &&
      current.mergedInto &&
      !visited.has(current)
    ) {
      visited.add(current);
      current = current.mergedInto;
    }
    return current;
  }

  function ensureTickDestinyDeliveryEntry(
    runtime,
    session,
    options = {},
    preferredDeliveryTransaction = null,
  ) {
    if (
      !runtime ||
      !session ||
      !hasActiveTickDestinyPresentationBatch(runtime)
    ) {
      return null;
    }

    const preferredTransaction = resolveRootDeliveryTransaction(
      preferredDeliveryTransaction,
    );
    const preferredTransactionAlreadyRetained = Boolean(
      preferredTransaction &&
      isDeliveryTransactionRetainedByRuntime(
        runtime,
        session,
        preferredTransaction,
      )
    );
    if (
      preferredTransaction &&
      (
        preferredTransaction.session !== session ||
        preferredTransaction.state !== "planning" ||
        !isDestinyDeliveryPlanCurrent(preferredTransaction)
      )
    ) {
      return null;
    }

    const batch = runtime._tickDestinyPresentation;
    let queued = batch.bySession.get(session);
    if (
      queued &&
      queued.deliveryTransaction &&
      !isDestinyDeliveryPlanCurrent(
        resolveRootDeliveryTransaction(queued.deliveryTransaction),
      )
    ) {
      const staleTransaction = resolveRootDeliveryTransaction(
        queued.deliveryTransaction,
      );
      rollbackDestinyDeliveryTransaction(
        staleTransaction,
        {
          reason: getStaleDestinyDeliveryReason(staleTransaction),
          skipCallbacks:
            shouldSkipStaleDestinyDeliveryCallbacks(staleTransaction),
        },
      );
      batch.bySession.delete(session);
      queued = null;
      if (
        preferredTransaction &&
        !preferredTransactionAlreadyRetained &&
        preferredTransaction.state === "planning" &&
        isDestinyDeliveryTransactionGenerationCurrent(preferredTransaction)
      ) {
        preferredTransaction.beforeState = snapshotAuthorityDeliveryState(
          session,
        );
      }
    }

    if (!queued) {
      queued = {
        session,
        updates: [],
        dedupeIndexes: new Map(),
        deliveryTransaction:
          preferredTransaction ||
          createDestinyDeliveryTransaction(session, options),
      };
      batch.bySession.set(session, queued);
    } else {
      const queuedTransaction = resolveRootDeliveryTransaction(
        queued.deliveryTransaction,
      );
      if (
        !queuedTransaction ||
        queuedTransaction.session !== session ||
        queuedTransaction.state !== "planning"
      ) {
        return null;
      }
      queued.deliveryTransaction = queuedTransaction;
      if (
        preferredTransaction &&
        preferredTransaction !== queuedTransaction
      ) {
        mergeDestinyDeliveryPlanGuards(
          queuedTransaction,
          preferredTransaction,
        );
        mergeDestinyDeliveryTransactions(
          queuedTransaction,
          preferredTransaction,
        );
      }
      registerDestinyDeliveryHooks(queuedTransaction, options);
    }
    registerDestinyDeliveryPlanGuard(
      resolveRootDeliveryTransaction(queued.deliveryTransaction),
      options,
    );
    return queued;
  }

  function isDeliveryTransactionOwnedByActiveTick(
    runtime,
    session,
    deliveryTransaction,
  ) {
    if (!hasActiveTickDestinyPresentationBatch(runtime)) {
      return false;
    }
    const queued = runtime._tickDestinyPresentation.bySession.get(session);
    return Boolean(
      queued &&
      resolveRootDeliveryTransaction(queued.deliveryTransaction) ===
        resolveRootDeliveryTransaction(deliveryTransaction),
    );
  }

  function hasQueuedDirectDeliveryWork(
    runtime,
    session,
    deliveryTransaction,
  ) {
    const batch = runtime && runtime._directDestinyNotificationBatch;
    const queued =
      batch && batch.bySession instanceof Map
        ? batch.bySession.get(session)
        : null;
    return Boolean(
      queued &&
      Array.isArray(queued.groups) &&
      queued.groups.length > 0 &&
      resolveRootDeliveryTransaction(queued.deliveryTransaction) ===
        resolveRootDeliveryTransaction(deliveryTransaction),
    );
  }

  function discardQueuedDirectDeliveryWork(
    runtime,
    session,
    deliveryTransaction,
  ) {
    const batch = runtime && runtime._directDestinyNotificationBatch;
    if (!batch || !(batch.bySession instanceof Map) || !session) {
      return false;
    }
    const sessionKey = getDirectDeliverySessionKey(session);
    const rootTransaction = resolveRootDeliveryTransaction(deliveryTransaction);
    const queued = batch.bySession.get(sessionKey);
    const mappedTransaction = batch.deliveryTransactions instanceof Map
      ? batch.deliveryTransactions.get(sessionKey)
      : null;
    let discarded = false;
    if (
      queued &&
      resolveRootDeliveryTransaction(queued.deliveryTransaction) ===
        rootTransaction
    ) {
      discarded = batch.bySession.delete(sessionKey) || discarded;
    }
    if (
      batch.deliveryTransactions instanceof Map &&
      resolveRootDeliveryTransaction(mappedTransaction) === rootTransaction
    ) {
      discarded = batch.deliveryTransactions.delete(sessionKey) || discarded;
    }
    if (
      batch.bySession.size === 0 &&
      (!(batch.deliveryTransactions instanceof Map) ||
        batch.deliveryTransactions.size === 0) &&
      runtime._directDestinyNotificationBatch === batch
    ) {
      runtime._directDestinyNotificationBatch = null;
    }
    return discarded;
  }

  function rollbackTickPresentationDrainFailure(
    runtime,
    batch,
    storedEntries,
    error,
  ) {
    const rolledBackTransactions = new Set();
    for (const storedQueued of Array.isArray(storedEntries) ? storedEntries : []) {
      if (!storedQueued) {
        continue;
      }
      const transaction = resolveRootDeliveryTransaction(
        storedQueued.deliveryTransaction,
      );
      if (batch && batch.bySession instanceof Map && storedQueued.session) {
        if (batch.bySession.get(storedQueued.session) === storedQueued) {
          batch.bySession.delete(storedQueued.session);
        }
      }
      discardQueuedDirectDeliveryWork(
        runtime,
        storedQueued.session,
        transaction,
      );
      if (
        transaction &&
        !rolledBackTransactions.has(transaction) &&
        transaction.state !== "committed" &&
        transaction.state !== "rolled-back"
      ) {
        rolledBackTransactions.add(transaction);
        rollbackDestinyDeliveryTransaction(transaction, {
          error,
          reason: "tick-presentation-drain-threw",
        });
      }
    }
  }

  function normalizeDelayedTargetEvents(value) {
    return Array.isArray(value) ? value : null;
  }

  function canFlushInitialBallparkBootstrapGroups(session, collectedGroups) {
    if (
      !session ||
      !session._space ||
      session._space.initialBallparkBootstrapInProgress !== true ||
      !Array.isArray(collectedGroups) ||
      collectedGroups.length === 0
    ) {
      return false;
    }
    return collectedGroups.every((group) => (
      group &&
      (
        group.contract === DESTINY_CONTRACTS.BOOTSTRAP_ACQUIRE ||
        group.contract === DESTINY_CONTRACTS.STATE_RESET
      )
    ));
  }

  function recordDestinyLedger(session, event, details = {}) {
    return recordSyncLedgerEvent(session, event, {
      kind: "destiny",
      ...details,
    });
  }

  function ensureDestinyLifecycleLedger(session) {
    if (!session || typeof session !== "object") {
      return null;
    }
    if (!session._syncLedgerDestinyLifecycle) {
      session._syncLedgerDestinyLifecycle = {
        lastNotificationStamp: null,
        addStampByEntityID: new Map(),
      };
    }
    return session._syncLedgerDestinyLifecycle;
  }

  function validateDestinyNotificationGroup(
    session,
    groupStamp,
    updates,
    context = {},
  ) {
    const lifecycle = ensureDestinyLifecycleLedger(session);
    const normalizedGroupStamp = normalizeDestinyStamp(groupStamp, 0);
    const updateStamps = [...new Set(
      (Array.isArray(updates) ? updates : [])
        .map((update) => normalizeDestinyStamp(update && update.stamp, 0)),
    )];
    const violations = [];

    if (updateStamps.length > 1) {
      violations.push({
        rule: "single-destiny-stamp-per-notification",
        stamps: updateStamps,
      });
    }
    if (updateStamps.length === 1 && updateStamps[0] !== normalizedGroupStamp) {
      violations.push({
        rule: "group-stamp-matches-update-stamp",
        groupStamp: normalizedGroupStamp,
        updateStamp: updateStamps[0],
      });
    }
    if (
      lifecycle &&
      hasDestinyStamp(lifecycle.lastNotificationStamp) &&
      isDestinyStampAfter(
        normalizedGroupStamp,
        lifecycle.lastNotificationStamp,
      )
    ) {
      violations.push({
        rule: "monotonic-destiny-notification-stamp",
        previousStamp: lifecycle.lastNotificationStamp,
        groupStamp: normalizedGroupStamp,
      });
    }

    for (const update of Array.isArray(updates) ? updates : []) {
      const payload = update && Array.isArray(update.payload)
        ? update.payload
        : null;
      if (!payload || typeof payload[0] !== "string") {
        continue;
      }
      const payloadName = payload[0];
      const entityIDs = extractPayloadEntityIDs(payload);
      if (payloadName === "SetState" && lifecycle) {
        lifecycle.addStampByEntityID.clear();
      }
      if (payloadName === "AddBalls2" && lifecycle) {
        for (const entityID of entityIDs) {
          lifecycle.addStampByEntityID.set(entityID, normalizedGroupStamp);
        }
      }
      if (payloadName === "RemoveBalls" && lifecycle) {
        for (const entityID of entityIDs) {
          const lastAddStamp = resolveOptionalDestinyStamp(
            lifecycle.addStampByEntityID.get(entityID),
          );
          if (
            hasDestinyStamp(lastAddStamp) &&
            !isDestinyStampAfter(lastAddStamp, normalizedGroupStamp)
          ) {
            violations.push({
              rule: "remove-after-addballs",
              entityID,
              addStamp: lastAddStamp,
              removeStamp: normalizedGroupStamp,
            });
          }
          lifecycle.addStampByEntityID.delete(entityID);
        }
      }
    }

    if (lifecycle) {
      lifecycle.lastNotificationStamp = selectLaterDestinyStamp(
        lifecycle.lastNotificationStamp,
        normalizedGroupStamp,
      );
    }

    if (violations.length > 0) {
      recordDestinyLedger(session, "destiny.invariant.violation", {
        ...context,
        stamp: normalizedGroupStamp,
        violations,
        updates: summarizeDestinyUpdates(updates),
      });
    }

    return violations;
  }

  function rejectReentrantDestinySend(runtime, session) {
    const activeFlush = runtime && runtime._activeDestinyDeliveryFlush;
    if (
      !activeFlush ||
      !(activeFlush.unsafeSessions instanceof Map)
    ) {
      return false;
    }
    let error = activeFlush.unsafeSessions.get(session);
    if (!error) {
      error = new Error(
        "Destiny delivery re-entered while a physical plan was active",
      );
      error.code = "DESTINY_DELIVERY_REENTRANCY";
      activeFlush.unsafeSessions.set(session, error);
    }
    destroySessionAfterUnsafeDestinyDelivery(session, error);
    return true;
  }

  function overrideReentrantDestinyDeliveryAttempt(
    runtime,
    session,
    attempt,
  ) {
    const activeFlush = runtime && runtime._activeDestinyDeliveryFlush;
    const error =
      activeFlush && activeFlush.unsafeSessions instanceof Map
        ? activeFlush.unsafeSessions.get(session)
        : null;
    return error
      ? {
          status: "ambiguous",
          reason: "reentrant-delivery",
          retryable: false,
          error,
        }
      : attempt;
  }

  function flushCollectedDestinyGroups(runtime, session, collectedGroups) {
    if (
      !session ||
      (
        !isReadyForDestiny(session) &&
        !canFlushInitialBallparkBootstrapGroups(session, collectedGroups)
      ) ||
      !Array.isArray(collectedGroups) ||
      collectedGroups.length === 0
    ) {
      return {
        accepted: false,
        ambiguous: false,
        deliveredCount: 0,
        plannedDeliveryCount: 0,
        highestStamp: null,
        reason: "session-not-ready",
      };
    }

    const deliveryTransactions = new Set(
      collectedGroups
        .map((group) => resolveRootDeliveryTransaction(
          group && group.deliveryTransaction,
        ))
        .filter(Boolean),
    );
    if (
      [...deliveryTransactions].some(
        (transaction) =>
          !isDestinyDeliveryPlanCurrent(transaction),
      )
    ) {
      return {
        accepted: false,
        ambiguous: false,
        deliveredCount: 0,
        plannedDeliveryCount: 0,
        highestStamp: null,
        reason: getStaleDestinyDeliveryReasonFromTransactions(
          deliveryTransactions,
        ),
      };
    }

    const physicalGroups = buildParkHistoryFlushGroups(
      collectedGroups,
      { toInt },
    ).map((group) => {
      const deliveryTransaction = resolveRootDeliveryTransaction(
        group && group.deliveryTransaction,
      );
      return {
        ...group,
        delayedTargetEvents: Array.isArray(group.delayedTargetEvents)
          ? group.delayedTargetEvents
          : null,
        spatialTraceContexts: Array.isArray(group.spatialTraceContexts)
          ? group.spatialTraceContexts
          : [],
        deliveryTransactions: new Set(
          deliveryTransaction ? [deliveryTransaction] : [],
        ),
      };
    });
    if (physicalGroups.length === 0) {
      return {
        accepted: false,
        ambiguous: false,
        deliveredCount: 0,
        plannedDeliveryCount: 0,
        highestStamp: null,
        reason: "empty-plan",
      };
    }

    const plannedDeliveryCount = physicalGroups.length;
    let deliveredCount = 0;
    let highestStamp = null;
    for (let groupIndex = 0; groupIndex < physicalGroups.length; groupIndex += 1) {
      const group = physicalGroups[groupIndex];
      const groupTransactions = group.deliveryTransactions instanceof Set
        ? group.deliveryTransactions
        : new Set();
      if (
        [...groupTransactions].some(
          (transaction) =>
            !isDestinyDeliveryPlanCurrent(transaction),
        )
      ) {
        if (deliveredCount > 0) {
          destroySessionAfterUnsafeDestinyDelivery(session);
        }
        return {
          accepted: false,
          ambiguous: false,
          deliveredCount,
          plannedDeliveryCount,
          highestStamp,
          reason: getStaleDestinyDeliveryReasonFromTransactions(
            groupTransactions,
          ),
        };
      }

      const updateSummary = summarizeDestinyUpdates(group.updates);
      const violations = validateDestinyNotificationGroup(
        session,
        group.stamp,
        group.updates,
        {
          waitForBubble: group.waitForBubble,
          containsSetState: group.containsSetState,
          phase: "flush-collected",
        },
      );
      recordDestinyLedger(session, "destiny.group.flushed", {
        stamp: group.stamp,
        waitForBubble: group.waitForBubble,
        containsSetState: group.containsSetState,
        violationCount: violations.length,
        delayedTargetEventCount: Array.isArray(group.delayedTargetEvents)
          ? group.delayedTargetEvents.length
          : 0,
        updates: updateSummary,
      });
      logDestinyDispatch(session, group.updates, group.waitForBubble);
      const payloadTuple = destiny.buildDestinyUpdatePayload(
        group.updates,
        group.waitForBubble,
        group.delayedTargetEvents,
      );
      if (spatialTrace.isEnabled()) {
        spatialTrace.prepareDestinyNotification(runtime, session, {
          payloadTuple,
          groupContexts: group.spatialTraceContexts,
          waitForBubble: group.waitForBubble,
          simulationTimeMs: runtime.getCurrentSimTimeMs(),
          destinyStamp: group.stamp,
        });
      }

      let attempt = overrideReentrantDestinyDeliveryAttempt(
        runtime,
        session,
        attemptDestinyNotificationDelivery(session, payloadTuple),
      );
      if (attempt.status === "rejected" && attempt.retryable === true) {
        if (
          [...groupTransactions].every(
            (transaction) =>
              isDestinyDeliveryPlanCurrent(transaction),
          )
        ) {
          for (const transaction of groupTransactions) {
            retryDestinyDeliveryTransaction(transaction, {
              groupIndex,
              reason: attempt.reason,
            });
          }
          if (
            [...groupTransactions].every((transaction) => (
              isDestinyDeliveryPlanCurrent(transaction)
            ))
          ) {
            attempt = overrideReentrantDestinyDeliveryAttempt(
              runtime,
              session,
              attemptDestinyNotificationDelivery(session, payloadTuple),
            );
          } else {
            attempt = {
              status: "rejected",
              reason: getStaleDestinyDeliveryReasonFromTransactions(
                groupTransactions,
              ),
              retryable: false,
            };
          }
        } else {
          attempt = {
            status: "rejected",
            reason: getStaleDestinyDeliveryReasonFromTransactions(
              groupTransactions,
            ),
            retryable: false,
          };
        }
      }

      if (attempt.status !== "accepted") {
        const ambiguous = attempt.status === "ambiguous";
        if (ambiguous || deliveredCount > 0) {
          destroySessionAfterUnsafeDestinyDelivery(session, attempt.error);
        }
        return {
          accepted: false,
          ambiguous,
          deliveredCount,
          plannedDeliveryCount,
          highestStamp,
          reason: ambiguous
            ? "delivery-ambiguous"
            : attempt.reason === "space-generation-replaced"
              ? "space-generation-replaced"
              : attempt.reason === "delivery-plan-replaced"
                ? "delivery-plan-replaced"
              : attempt.reason === "session-closed"
                ? "session-closed"
                : "delivery-rejected",
          error: attempt.error || null,
        };
      }

      deliveredCount += 1;
      highestStamp = selectLaterDestinyStamp(
        highestStamp,
        group.stamp,
      );
      if (
        [...groupTransactions].some(
          (transaction) =>
            !isDestinyDeliveryPlanCurrent(transaction),
        )
      ) {
        destroySessionAfterUnsafeDestinyDelivery(session);
        return {
          accepted: false,
          ambiguous: false,
          deliveredCount,
          plannedDeliveryCount,
          highestStamp,
          reason: getStaleDestinyDeliveryReasonFromTransactions(
            groupTransactions,
          ),
        };
      }
    }

    return {
      accepted: deliveredCount === plannedDeliveryCount,
      ambiguous: false,
      deliveredCount,
      plannedDeliveryCount,
      highestStamp,
      reason: "accepted",
    };
  }

  function queueCollectedDestinyGroupsForDirectFlush(
    runtime,
    session,
    collectedGroups,
  ) {
    if (
      !runtime ||
      !session ||
      !Array.isArray(collectedGroups) ||
      collectedGroups.length === 0
    ) {
      return 0;
    }

    const orderedGroups = orderCollectedDestinyGroups(collectedGroups);
    if (orderedGroups.length === 0) {
      return 0;
    }

    let queuedCount = 0;
    for (const group of orderedGroups) {
      queuedCount += queueDirectDestinyNotificationGroup(runtime, session, {
        stamp: group.stamp,
        waitForBubble: group.waitForBubble === true,
        updates: group.updates,
        contract: group.contract,
        rawDispatchStamp: group.rawDispatchStamp,
        delayedTargetEvents: group.delayedTargetEvents,
        spatialTraceContext: group.spatialTraceContext,
        deliveryTransaction: group.deliveryTransaction || null,
      });
    }

    return queuedCount;
  }

  function getDirectDestinyNotificationBatch(runtime) {
    if (
      runtime &&
      runtime._directDestinyNotificationBatch &&
      runtime._directDestinyNotificationBatch.bySession instanceof Map
    ) {
      return runtime._directDestinyNotificationBatch;
    }

    const batch = {
      bySession: new Map(),
      deliveryTransactions: new Map(),
      nextOrder: 0,
      rawDispatchStamp: null,
      scheduled: false,
    };
    runtime._directDestinyNotificationBatch = batch;
    return batch;
  }

  function getDirectDeliverySessionKey(session) {
    return session;
  }

  function retireDirectDestinyNotificationEntry(
    batch,
    sessionKey,
    expectedTransaction = null,
  ) {
    if (
      !batch ||
      !(batch.bySession instanceof Map) ||
      !(batch.deliveryTransactions instanceof Map)
    ) {
      return false;
    }
    const queued = batch.bySession.get(sessionKey);
    const transactions = new Set(
      [
        batch.deliveryTransactions.get(sessionKey),
        queued && queued.deliveryTransaction,
      ]
        .map(resolveRootDeliveryTransaction)
        .filter(Boolean),
    );
    const expectedRoot = resolveRootDeliveryTransaction(expectedTransaction);
    if (expectedRoot && !transactions.has(expectedRoot)) {
      return false;
    }
    for (const transaction of transactions) {
      if (
        transaction.state !== "committed" &&
        transaction.state !== "rolled-back"
      ) {
        rollbackDestinyDeliveryTransaction(transaction, {
          reason: getStaleDestinyDeliveryReason(transaction),
          skipCallbacks:
            shouldSkipStaleDestinyDeliveryCallbacks(transaction),
        });
      }
    }
    batch.bySession.delete(sessionKey);
    batch.deliveryTransactions.delete(sessionKey);
    return true;
  }

  function ensureDirectDestinyDeliveryTransaction(
    runtime,
    session,
    rawDispatchStamp = null,
    options = {},
  ) {
    let batch = runtime && runtime._directDestinyNotificationBatch;
    const normalizedRawDispatchStamp = hasDestinyStamp(rawDispatchStamp)
      ? normalizeDestinyStamp(rawDispatchStamp)
      : null;
    if (
      batch &&
      batch.bySession instanceof Map &&
      hasDestinyStamp(batch.rawDispatchStamp) &&
      hasDestinyStamp(normalizedRawDispatchStamp) &&
      normalizedRawDispatchStamp !== batch.rawDispatchStamp
    ) {
      flushDirectDestinyNotificationBatch(runtime);
      batch = null;
    }
    batch = batch || getDirectDestinyNotificationBatch(runtime);
    const sessionKey = getDirectDeliverySessionKey(session);
    const existingTransaction =
      batch.deliveryTransactions instanceof Map
        ? batch.deliveryTransactions.get(sessionKey)
        : null;
    if (
      existingTransaction &&
      !isDestinyDeliveryPlanCurrent(existingTransaction)
    ) {
      retireDirectDestinyNotificationEntry(
        batch,
        sessionKey,
        existingTransaction,
      );
    }
    if (!(batch.deliveryTransactions instanceof Map)) {
      batch.deliveryTransactions = new Map();
    }
    if (hasDestinyStamp(normalizedRawDispatchStamp)) {
      batch.rawDispatchStamp = normalizedRawDispatchStamp;
    }
    let transaction = batch.deliveryTransactions.get(sessionKey);
    if (
      !transaction ||
      transaction.state === "committed" ||
      transaction.state === "rolled-back"
    ) {
      transaction = createDestinyDeliveryTransaction(session, options);
      batch.deliveryTransactions.set(sessionKey, transaction);
    } else {
      registerDestinyDeliveryHooks(transaction, options);
    }
    registerDestinyDeliveryPlanGuard(transaction, options);
    return transaction;
  }

  function scheduleDirectDestinyNotificationFlush(runtime, batch) {
    if (!runtime || !batch || batch.scheduled === true) {
      return;
    }

    batch.scheduled = true;
    const scheduleFlush =
      typeof queueMicrotask === "function"
        ? queueMicrotask
        : (callback) => Promise.resolve().then(callback);
    scheduleFlush(() => {
      if (runtime._directDestinyNotificationBatch !== batch) {
        return;
      }
      if (
        [...batch.bySession.values()].some((queued) => (
          queued &&
          isDeliveryTransactionOwnedByActiveTick(
            runtime,
            queued.session,
            queued.deliveryTransaction,
          )
        ))
      ) {
        return;
      }
      flushDirectDestinyNotificationBatch(runtime);
    });
  }

  function queueDirectDestinyNotificationGroup(
    runtime,
    session,
    groupDetails = {},
  ) {
    if (
      !runtime ||
      !session ||
      !Array.isArray(groupDetails.updates) ||
      groupDetails.updates.length <= 0
    ) {
      return 0;
    }
    if (rejectReentrantDestinySend(runtime, session)) {
      return 0;
    }

    const groupRawDispatchStamp = resolveOptionalDestinyStamp(
      groupDetails.rawDispatchStamp,
    );
    const sessionKey = getDirectDeliverySessionKey(session);
    const suppliedDeliveryTransaction = resolveRootDeliveryTransaction(
      groupDetails.deliveryTransaction,
    );
    if (
      suppliedDeliveryTransaction &&
      (
        suppliedDeliveryTransaction.session !== session ||
        suppliedDeliveryTransaction.state !== "planning"
      )
    ) {
      return 0;
    }
    if (
      rejectStaleIncomingDeliveryPlan(
        runtime,
        session,
        groupDetails,
        suppliedDeliveryTransaction,
      )
    ) {
      return 0;
    }
    registerDestinyDeliveryPlanGuard(
      suppliedDeliveryTransaction,
      groupDetails,
    );
    if (
      suppliedDeliveryTransaction &&
      !isDestinyDeliveryPlanCurrent(
        suppliedDeliveryTransaction,
      )
    ) {
      rollbackDestinyDeliveryTransaction(suppliedDeliveryTransaction, {
        reason: getStaleDestinyDeliveryReason(suppliedDeliveryTransaction),
        skipCallbacks:
          shouldSkipStaleDestinyDeliveryCallbacks(
            suppliedDeliveryTransaction,
          ),
      });
      return 0;
    }
    let batch = runtime._directDestinyNotificationBatch;
    const mappedBatchTransaction =
      batch && batch.deliveryTransactions instanceof Map
        ? batch.deliveryTransactions.get(sessionKey)
        : null;
    const queuedBatchEntry =
      batch && batch.bySession instanceof Map
        ? batch.bySession.get(sessionKey)
        : null;
    const batchDeliveryTransaction = resolveRootDeliveryTransaction(
      mappedBatchTransaction ||
        (queuedBatchEntry && queuedBatchEntry.deliveryTransaction),
    );
    const sharesActiveDeliveryTransaction = Boolean(
      suppliedDeliveryTransaction &&
      batchDeliveryTransaction === suppliedDeliveryTransaction,
    );
    const suppliedTransactionAlreadyRetained = Boolean(
      suppliedDeliveryTransaction &&
      isDeliveryTransactionRetainedByRuntime(
        runtime,
        session,
        suppliedDeliveryTransaction,
      )
    );
    if (
      batchDeliveryTransaction &&
      batchDeliveryTransaction !== suppliedDeliveryTransaction &&
      !isDestinyDeliveryPlanCurrent(batchDeliveryTransaction)
    ) {
      const retiredStaleEntry = retireDirectDestinyNotificationEntry(
        batch,
        sessionKey,
        batchDeliveryTransaction,
      );
      if (!retiredStaleEntry) {
        return 0;
      }
      if (
        suppliedDeliveryTransaction &&
        !suppliedTransactionAlreadyRetained &&
        suppliedDeliveryTransaction.state === "planning" &&
        isDestinyDeliveryTransactionGenerationCurrent(
          suppliedDeliveryTransaction,
        )
      ) {
        suppliedDeliveryTransaction.beforeState =
          snapshotAuthorityDeliveryState(session);
      }
    }
    if (
      batch &&
      batch.bySession instanceof Map &&
      hasDestinyStamp(batch.rawDispatchStamp) &&
      hasDestinyStamp(groupRawDispatchStamp) &&
      groupRawDispatchStamp !== batch.rawDispatchStamp &&
      !sharesActiveDeliveryTransaction
    ) {
      flushDirectDestinyNotificationBatch(runtime);
      batch = null;
    }

    batch = batch || getDirectDestinyNotificationBatch(runtime);
    if (hasDestinyStamp(groupRawDispatchStamp)) {
      batch.rawDispatchStamp = groupRawDispatchStamp;
    }

    const deliveryTransaction =
      suppliedDeliveryTransaction ||
      ensureDirectDestinyDeliveryTransaction(
        runtime,
        session,
        groupRawDispatchStamp,
        groupDetails,
      );
    registerDestinyDeliveryPlanGuard(deliveryTransaction, groupDetails);
    if (
      runtime._directDestinyNotificationBatch &&
      runtime._directDestinyNotificationBatch !== batch
    ) {
      batch = runtime._directDestinyNotificationBatch;
    }
    if (
      deliveryTransaction.state !== "planning" ||
      !isDestinyDeliveryPlanCurrent(deliveryTransaction)
    ) {
      rollbackDestinyDeliveryTransaction(deliveryTransaction, {
        reason:
          deliveryTransaction.state === "planning"
            ? getStaleDestinyDeliveryReason(deliveryTransaction)
            : "delivery-transaction-not-planning",
        skipCallbacks:
          deliveryTransaction.state === "planning"
            ? shouldSkipStaleDestinyDeliveryCallbacks(deliveryTransaction)
            : false,
      });
      return 0;
    }
    if (!(batch.deliveryTransactions instanceof Map)) {
      batch.deliveryTransactions = new Map();
    }
    let queued = batch.bySession.get(sessionKey);
    if (
      queued &&
      queued.deliveryTransaction &&
      queued.deliveryTransaction.spaceGeneration !==
        deliveryTransaction.spaceGeneration
    ) {
      const retiredGenerationEntry = retireDirectDestinyNotificationEntry(
        batch,
        sessionKey,
        queued.deliveryTransaction,
      );
      if (!retiredGenerationEntry) {
        return 0;
      }
      if (hasDestinyStamp(groupRawDispatchStamp)) {
        batch.rawDispatchStamp = groupRawDispatchStamp;
      }
      queued = null;
    }
    if (!queued) {
      queued = {
        session,
        groups: [],
        deliveryTransaction,
      };
      batch.bySession.set(sessionKey, queued);
      batch.deliveryTransactions.set(sessionKey, deliveryTransaction);
    } else if (queued.deliveryTransaction !== deliveryTransaction) {
      mergeDestinyDeliveryPlanGuards(
        queued.deliveryTransaction,
        deliveryTransaction,
      );
      mergeDestinyDeliveryTransactions(
        queued.deliveryTransaction,
        deliveryTransaction,
      );
    }
    const order = batch.nextOrder++;
    const shouldRecordSpatialTrace = spatialTrace.isEnabled();
    const spatialTraceSimulationTimeMs = shouldRecordSpatialTrace
      ? runtime.getCurrentSimTimeMs()
      : null;
    appendCollectedDestinyGroup(queued.groups, {
      stamp: groupDetails.stamp,
      waitForBubble: groupDetails.waitForBubble === true,
      order,
      updates: groupDetails.updates,
      contract: groupDetails.contract,
      rawDispatchStamp: groupRawDispatchStamp,
      delayedTargetEvents: groupDetails.delayedTargetEvents,
      spatialTraceContext: groupDetails.spatialTraceContext,
      deliveryTransaction: queued.deliveryTransaction,
    }, {
      buildSpatialTraceContext: shouldRecordSpatialTrace
        ? (split) => spatialTrace.recordDestinyGroupEnqueued(
          runtime,
          session,
          {
            stamp: split.stamp,
            waitForBubble: split.waitForBubble,
            order: split.order,
            updates: split.updates,
            contract: split.contract,
            rawDispatchStamp: split.rawDispatchStamp,
            simulationTimeMs: spatialTraceSimulationTimeMs,
          },
        )
        : null,
    });
    recordDestinyLedger(session, "destiny.group.queued", {
      stamp: normalizeDestinyStamp(groupDetails.stamp, 0),
      waitForBubble: groupDetails.waitForBubble === true,
      contract:
        typeof groupDetails.contract === "string"
          ? groupDetails.contract
          : "",
      rawDispatchStamp: groupRawDispatchStamp,
      queueSize: queued.groups.length,
      delayedTargetEventCount: Array.isArray(groupDetails.delayedTargetEvents)
        ? groupDetails.delayedTargetEvents.length
        : 0,
      updates: summarizeDestinyUpdates(groupDetails.updates),
    });
    scheduleDirectDestinyNotificationFlush(runtime, batch);
    return queued.groups.length;
  }

  function flushDirectDestinyNotificationBatch(runtime) {
    if (
      !runtime ||
      !runtime._directDestinyNotificationBatch ||
      !(runtime._directDestinyNotificationBatch.bySession instanceof Map)
    ) {
      return 0;
    }

    const batch = runtime._directDestinyNotificationBatch;
    if (
      [...batch.bySession.values()].some((queued) => (
        queued &&
        isDeliveryTransactionOwnedByActiveTick(
          runtime,
          queued.session,
          queued.deliveryTransaction,
        )
      ))
    ) {
      return 0;
    }
    if (runtime._activeDestinyDeliveryFlush) {
      return 0;
    }
    runtime._directDestinyNotificationBatch = null;
    const flushContext = {
      batch,
      completed: false,
      error: null,
      unsafeSessions: new Map(),
    };
    runtime._activeDestinyDeliveryFlush = flushContext;

    try {
      for (const transaction of batch.deliveryTransactions instanceof Map
        ? batch.deliveryTransactions.values()
        : []) {
        if (isDestinyDeliveryPlanCurrent(transaction)) {
          stageDestinyDeliveryTransaction(transaction);
        } else {
          rollbackDestinyDeliveryTransaction(transaction, {
            reason: getStaleDestinyDeliveryReason(transaction),
            skipCallbacks:
              shouldSkipStaleDestinyDeliveryCallbacks(transaction),
          });
        }
      }

      let highestFlushedStamp = null;
      let acceptedSessionCount = 0;
      let rejectedSessionCount = 0;
      const completedTransactions = new Set();
      for (const queued of batch.bySession.values()) {
        if (
          !queued ||
          !queued.session ||
          !Array.isArray(queued.groups) ||
          queued.groups.length <= 0 ||
          !queued.deliveryTransaction ||
          queued.deliveryTransaction.state !== "staged" ||
          !isDestinyDeliveryPlanCurrent(
            queued.deliveryTransaction,
          )
        ) {
          if (queued && queued.deliveryTransaction) {
            rollbackDestinyDeliveryTransaction(queued.deliveryTransaction, {
              reason:
                Array.isArray(queued.groups) && queued.groups.length > 0
                  ? getStaleDestinyDeliveryReason(
                      queued.deliveryTransaction,
                    )
                  : "empty-delivery-plan",
              skipCallbacks:
                shouldSkipStaleDestinyDeliveryCallbacks(
                  queued.deliveryTransaction,
                ),
            });
            completedTransactions.add(queued.deliveryTransaction);
          }
          if (
            queued &&
            Array.isArray(queued.groups) &&
            queued.groups.length > 0
          ) {
            rejectedSessionCount += 1;
          }
          continue;
        }
        const result = flushCollectedDestinyGroups(
          runtime,
          queued.session,
          queued.groups,
        );
        const deliveryTransaction = queued.deliveryTransaction;
        const fullyAccepted = Boolean(
          result &&
          result.accepted === true &&
          result.deliveredCount === result.plannedDeliveryCount &&
          result.plannedDeliveryCount > 0,
        );
        if (fullyAccepted) {
          acceptedSessionCount += 1;
          highestFlushedStamp = selectLaterDestinyStamp(
            highestFlushedStamp,
            result.highestStamp,
          );
          commitDestinyDeliveryTransaction(deliveryTransaction, result);
        } else {
          rejectedSessionCount += 1;
          rollbackDestinyDeliveryTransaction(
            deliveryTransaction,
            result || { reason: "delivery-rejected" },
          );
        }
        completedTransactions.add(deliveryTransaction);
      }
      for (const transaction of batch.deliveryTransactions instanceof Map
        ? batch.deliveryTransactions.values()
        : []) {
        if (!completedTransactions.has(transaction)) {
          rollbackDestinyDeliveryTransaction(transaction, {
            reason: "empty-delivery-plan",
          });
        }
      }
      runtime._lastDestinyDeliveryBatchResult = {
        acceptedSessionCount,
        rejectedSessionCount,
        highestFlushedStamp: hasDestinyStamp(highestFlushedStamp)
          ? normalizeDestinyStamp(highestFlushedStamp)
          : 0,
      };
      flushContext.completed = true;
      return hasDestinyStamp(highestFlushedStamp)
        ? normalizeDestinyStamp(highestFlushedStamp)
        : 0;
    } catch (error) {
      flushContext.error = error;
      throw error;
    } finally {
      if (!flushContext.completed) {
        for (const transaction of batch.deliveryTransactions instanceof Map
          ? batch.deliveryTransactions.values()
          : []) {
          rollbackDestinyDeliveryTransaction(transaction, {
            error: flushContext.error,
            reason: "delivery-flush-threw",
          });
        }
        for (const queued of batch.bySession.values()) {
          if (queued && queued.session) {
            destroySessionAfterUnsafeDestinyDelivery(
              queued.session,
              flushContext.error,
            );
          }
        }
      }
      if (runtime._activeDestinyDeliveryFlush === flushContext) {
        delete runtime._activeDestinyDeliveryFlush;
      }
    }
  }

  function isFreshAcquireLifecycleUpdate(update) {
    return Boolean(update && update.freshAcquireLifecycleGroup === true);
  }

  function shouldSplitMixedFreshAcquirePayloads(payloads, options = {}) {
    return (
      options &&
      options.preservePayloadStateStamp === true &&
      Array.isArray(payloads) &&
      payloads.some((update) => isFreshAcquireLifecycleUpdate(update)) &&
      payloads.some((update) => !isFreshAcquireLifecycleUpdate(update))
    );
  }

  function buildNonFreshMixedPayloadSendOptions(baseOptions = {}) {
    const nextOptions = {
      ...(baseOptions && typeof baseOptions === "object" ? baseOptions : {}),
    };
    delete nextOptions.preservePayloadStateStamp;
    delete nextOptions.skipOwnerMonotonicRestamp;
    delete nextOptions.skipOwnerMonotonicRestampWhenPreviousNotOwnerCritical;
    delete nextOptions.avoidCurrentHistoryInsertion;
    delete nextOptions.minimumLeadFromCurrentHistory;
    delete nextOptions.maximumLeadFromCurrentHistory;
    delete nextOptions.maximumHistorySafeLeadOverride;
    delete nextOptions.historyLeadUsesCurrentSessionStamp;
    delete nextOptions.historyLeadUsesImmediateSessionStamp;
    delete nextOptions.historyLeadUsesPresentedSessionStamp;
    delete nextOptions.historyLeadPresentedMaximumFutureLead;
    return nextOptions;
  }

  function splitContiguousFreshAcquirePayloadGroups(payloads = []) {
    const groups = [];
    let currentGroup = [];
    let currentFreshAcquireState = null;

    for (const payload of Array.isArray(payloads) ? payloads : []) {
      const isFreshAcquire = isFreshAcquireLifecycleUpdate(payload);
      if (
        currentGroup.length > 0 &&
        currentFreshAcquireState !== isFreshAcquire
      ) {
        groups.push({
          isFreshAcquire: currentFreshAcquireState,
          updates: currentGroup,
        });
        currentGroup = [];
      }
      if (currentGroup.length === 0) {
        currentFreshAcquireState = isFreshAcquire;
      }
      currentGroup.push(payload);
    }

    if (currentGroup.length > 0) {
      groups.push({
        isFreshAcquire: currentFreshAcquireState,
        updates: currentGroup,
      });
    }

    return groups;
  }

  function alignQueuedEntityDependentStamps(entries) {
    const presentationFloorByEntityID = new Map();
    const insertionOrderedEntries = (Array.isArray(entries) ? entries : [])
      .slice()
      .sort(
        (left, right) =>
          toInt(left && left.order, 0) - toInt(right && right.order, 0),
      );

    return insertionOrderedEntries.map((entry) => {
      const update = entry && entry.update;
      const payload = update && Array.isArray(update.payload)
        ? update.payload
        : null;
      if (!update || !payload) {
        return entry;
      }
      const entityIDs = extractPayloadEntityIDs(payload);
      if (entityIDs.length === 0 || !hasDestinyStamp(update.stamp)) {
        return entry;
      }

      let alignedStamp = normalizeDestinyStamp(update.stamp);
      for (const entityID of entityIDs) {
        const priorFloor = presentationFloorByEntityID.get(entityID);
        if (
          hasDestinyStamp(priorFloor) &&
          compareDestinyStamps(alignedStamp, priorFloor) < 0
        ) {
          alignedStamp = priorFloor;
        }
      }
      for (const entityID of entityIDs) {
        presentationFloorByEntityID.set(entityID, alignedStamp);
      }
      if (alignedStamp === normalizeDestinyStamp(update.stamp)) {
        return entry;
      }
      const alignedUpdate = {
        ...update,
        stamp: alignedStamp,
        payload: destiny.restampPayloadState(update.payload, alignedStamp),
      };
      if (entry.spatialTraceContext) {
        spatialTrace.attachDestinyUpdateContext(
          alignedUpdate,
          entry.spatialTraceContext,
        );
      }
      return {
        ...entry,
        update: alignedUpdate,
      };
    });
  }

  function queueTickDestinyPresentationUpdates(
    runtime,
    session,
    updates,
    options = {},
  ) {
    if (
      !session ||
      !isReadyForDestiny(session) ||
      !Array.isArray(updates) ||
      updates.length === 0
    ) {
      return 0;
    }

    const queuedSendOptions =
      options &&
      options.sendOptions &&
      typeof options.sendOptions === "object"
        ? options.sendOptions
        : null;
    const normalizedQueuedSendOptions =
      normalizeQueuedPresentationSendOptions(queuedSendOptions);
    const existingDeliveryTransaction = getExistingDeliveryTransaction(
      runtime,
      session,
      normalizedQueuedSendOptions,
    );
    const suppliedDeliveryTransaction = resolveRootDeliveryTransaction(
      normalizedQueuedSendOptions &&
        normalizedQueuedSendOptions._deliveryTransaction,
    );
    if (
      suppliedDeliveryTransaction &&
      suppliedDeliveryTransaction.session !== session
    ) {
      return 0;
    }
    if (
      rejectStaleIncomingDeliveryPlan(
        runtime,
        session,
        normalizedQueuedSendOptions,
        existingDeliveryTransaction,
      )
    ) {
      return 0;
    }
    let retainedUpdates = updates.filter(
      (update) => update && Number.isFinite(Number(update.stamp)),
    );
    if (
      retainedUpdates.length !== updates.length &&
      hasDeliveryHooks(normalizedQueuedSendOptions)
    ) {
      rollbackUnplannedDeliveryCall(
        normalizedQueuedSendOptions,
        "invalid-tick-presentation-entry",
        existingDeliveryTransaction,
      );
      return 0;
    }
    if (retainedUpdates.length === 0) {
      rollbackUnplannedDeliveryCall(
        normalizedQueuedSendOptions,
        "invalid-tick-presentation-entry",
        existingDeliveryTransaction,
      );
      return 0;
    }
    const unsuppressedUpdates = filterPendingRemovalDependentPayloads(
      session,
      retainedUpdates,
      normalizedQueuedSendOptions,
    );
    if (
      unsuppressedUpdates.length !== retainedUpdates.length &&
      hasDeliveryHooks(normalizedQueuedSendOptions)
    ) {
      rollbackUnplannedDeliveryCall(
        normalizedQueuedSendOptions,
        "entity-removal-pending",
        existingDeliveryTransaction,
      );
      return 0;
    }
    retainedUpdates = unsuppressedUpdates;
    if (retainedUpdates.length === 0) {
      rollbackUnplannedDeliveryCall(
        normalizedQueuedSendOptions,
        "entity-removal-pending",
        existingDeliveryTransaction,
      );
      return 0;
    }

    if (!runtime.hasActiveTickDestinyPresentationBatch()) {
      runtime.sendDestinyUpdates(session, retainedUpdates, false, {
        ...normalizedQueuedSendOptions,
      });
      return retainedUpdates.length;
    }

    const batch = runtime._tickDestinyPresentation;
    const queued = ensureTickDestinyDeliveryEntry(
      runtime,
      session,
      normalizedQueuedSendOptions,
    );
    if (!queued) {
      return 0;
    }

    const getDedupeKey =
      typeof options.getDedupeKey === "function"
        ? options.getDedupeKey
        : null;
    const refreshStampAtFlush =
      options.refreshStampAtFlush === "currentVisible"
        ? "currentVisible"
        : options.refreshStampAtFlush === "currentVisibleIfStale"
          ? "currentVisibleIfStale"
          : null;
    const replaceDedupeOrder = options.replaceDedupeOrder === true;

    for (const update of retainedUpdates) {
      const dedupeKey = getDedupeKey ? getDedupeKey(update) : null;
      const requestedOrder = batch.nextOrder++;
      const authoredTraceContext = spatialTrace.isEnabled()
        ? spatialTrace.recordDestinyActionAuthored(runtime, session, update, {
          captureBoundary: "tick-presentation-queue",
          orderInCall: requestedOrder,
          simulationTimeMs: runtime.getCurrentSimTimeMs(),
        })
        : null;
      if (authoredTraceContext) {
        spatialTrace.attachDestinyUpdateContext(update, authoredTraceContext);
      }
      const queuedEntry = {
        dedupeKey,
        update,
        order: requestedOrder,
        replaceDedupeOrder,
        sendOptions: normalizedQueuedSendOptions,
        refreshStampAtFlush,
        spatialTraceContext: authoredTraceContext,
      };
      if (dedupeKey && queued.dedupeIndexes.has(dedupeKey)) {
        const existingIndex = queued.dedupeIndexes.get(dedupeKey);
        if (toInt(existingIndex, -1) < 0) {
          if (replaceDedupeOrder) {
            continue;
          }
          queued.dedupeIndexes.delete(dedupeKey);
        } else {
          const existingEntry = queued.updates[existingIndex];
          if (!replaceDedupeOrder) {
            queuedEntry.order = existingEntry.order;
          }
          queued.updates[existingIndex] = queuedEntry;
          if (authoredTraceContext) {
            const supersededTraceContext =
              existingEntry && existingEntry.spatialTraceContext;
            spatialTrace.recordDestinyPresentationEnqueue(
              runtime,
              session,
              update,
              {
                dedupeKey,
                order: queuedEntry.order,
                simulationTimeMs: runtime.getCurrentSimTimeMs(),
                supersededActionId:
                  supersededTraceContext && supersededTraceContext.actionId
                    ? supersededTraceContext.actionId
                    : null,
              },
            );
          }
          continue;
        }
      }
      if (!appendSystemHistoryAction(queued.updates, queuedEntry)) {
        continue;
      }
      if (dedupeKey) {
        queued.dedupeIndexes.set(dedupeKey, queued.updates.length - 1);
      }
      if (authoredTraceContext) {
        spatialTrace.recordDestinyPresentationEnqueue(runtime, session, update, {
          dedupeKey,
          order: queuedEntry.order,
          simulationTimeMs: runtime.getCurrentSimTimeMs(),
        });
      }
    }

    if (shouldLogMissilePayloadGroup(updates)) {
      logMissileDebug("destiny.presentation-queue", {
        rawSimTimeMs: roundNumber(runtime.getCurrentSimTimeMs(), 3),
        session: buildMissileSessionSnapshot(runtime, session),
        queuedCount: queued.updates.length,
        sendOptions: normalizeTraceValue(normalizedQueuedSendOptions),
        updates: summarizeMissileUpdatesForLog(updates),
      });
    }

    updateDestinyAuthorityState(session, {
      heldQueueState: {
        active: true,
        queuedCount: queued.updates.length,
        lastQueueStamp: resolveOptionalDestinyStamp(
          queued.updates.reduce(
            (latest, entry) => selectLaterDestinyStamp(
              latest,
              normalizeDestinyStamp(
                entry && entry.update && entry.update.stamp,
              ),
            ),
            null,
          ),
        ),
      },
    });

    return retainedUpdates.length;
  }

  function drainTickDestinyPresentationBatch(runtime, options = {}) {
    if (!runtime.hasActiveTickDestinyPresentationBatch()) {
      return 0;
    }

    const batch = runtime._tickDestinyPresentation;
    const finalDrain = options && options.final === true;
    const targetSession = options && options.session
      ? options.session
      : null;
    const storedEntries = targetSession
      ? [batch.bySession.get(targetSession)].filter(Boolean)
      : [...batch.bySession.values()];
    if (finalDrain) {
      runtime._tickDestinyPresentation = null;
    }
    let drainedUpdateCount = 0;

    for (const storedQueued of storedEntries) {
      try {
      const queuedUpdates = takeSystemHistoryActions(storedQueued);
      if (!finalDrain && queuedUpdates.length === 0) {
        continue;
      }
      if (storedQueued) {
        const drainedDedupeIndexes = new Map();
        if (storedQueued.dedupeIndexes instanceof Map) {
          for (const [dedupeKey, index] of storedQueued.dedupeIndexes) {
            if (toInt(index, -1) < 0) {
              drainedDedupeIndexes.set(dedupeKey, -1);
            }
          }
        }
        for (const entry of queuedUpdates) {
          if (entry && entry.dedupeKey) {
            drainedDedupeIndexes.set(entry.dedupeKey, -1);
          }
        }
        storedQueued.dedupeIndexes = drainedDedupeIndexes;
      }
      const queued = storedQueued
        ? { ...storedQueued, updates: queuedUpdates }
        : null;
      const deliveryTransaction = resolveRootDeliveryTransaction(
        queued && queued.deliveryTransaction,
      );
      if (
        deliveryTransaction &&
        !isDestinyDeliveryPlanCurrent(deliveryTransaction)
      ) {
        rollbackDestinyDeliveryTransaction(deliveryTransaction, {
          reason: getStaleDestinyDeliveryReason(deliveryTransaction),
          skipCallbacks:
            shouldSkipStaleDestinyDeliveryCallbacks(deliveryTransaction),
        });
        if (!finalDrain && queued && queued.session) {
          batch.bySession.delete(queued.session);
        }
        continue;
      }
      const hasDirectDeliveryWork = Boolean(
        queued &&
        queued.session &&
        Array.isArray(queued.updates) &&
        queued.updates.length === 0 &&
        deliveryTransaction &&
        hasQueuedDirectDeliveryWork(
          runtime,
          queued.session,
          deliveryTransaction,
        ),
      );
      if (hasDirectDeliveryWork) {
        updateDestinyAuthorityState(queued.session, {
          heldQueueState: {
            active: !finalDrain,
            queuedCount: 0,
            lastQueueStamp: null,
          },
        });
        continue;
      }
      if (
        !queued ||
        !queued.session ||
        !isReadyForDestiny(queued.session) ||
        !Array.isArray(queued.updates)
      ) {
        if (queued && queued.session) {
          updateDestinyAuthorityState(queued.session, {
            heldQueueState: {
              active: false,
              queuedCount: 0,
              lastQueueStamp: null,
            },
          });
        }
        if (deliveryTransaction) {
          rollbackDestinyDeliveryTransaction(deliveryTransaction, {
            reason: "empty-delivery-plan",
          });
        }
        if (!finalDrain && queued && queued.session) {
          batch.bySession.delete(queued.session);
        }
        continue;
      }
      if (queued.updates.length === 0) {
        updateDestinyAuthorityState(queued.session, {
          heldQueueState: {
            active: !finalDrain,
            queuedCount: 0,
            lastQueueStamp: null,
          },
        });
        if (deliveryTransaction && finalDrain) {
          rollbackDestinyDeliveryTransaction(deliveryTransaction, {
            reason: "empty-delivery-plan",
          });
        }
        continue;
      }

      // Updates authored early in a long scene tick may be stale by the
      // Park-style flush. Only explicit current-visible callers opt into this
      // refresh; scheduled movement and lifecycle lanes keep authored stamps.
      const flushNowMs = runtime.getCurrentSimTimeMs();
      const flushCurrentVisibleStamp =
        queued.updates.some((entry) => (
          entry && (
            entry.refreshStampAtFlush === "currentVisible" ||
            entry.refreshStampAtFlush === "currentVisibleIfStale"
          )
        ))
          ? runtime.getCurrentVisibleSessionDestinyStamp(
              queued.session,
              flushNowMs,
            )
          : null;
      const refreshedEntries = queued.updates
        .map((entry) => {
          if (
            !entry ||
            !(
              entry.refreshStampAtFlush === "currentVisible" ||
              entry.refreshStampAtFlush === "currentVisibleIfStale"
            ) ||
            !entry.update ||
            !hasDestinyStamp(flushCurrentVisibleStamp) ||
            (
              entry.refreshStampAtFlush === "currentVisibleIfStale" &&
              compareDestinyStamps(
                entry.update.stamp,
                flushCurrentVisibleStamp,
              ) >= 0
            )
          ) {
            return entry;
          }
          const refreshedUpdate = {
            ...entry.update,
            stamp: flushCurrentVisibleStamp,
            payload: destiny.restampPayloadState(
              entry.update.payload,
              flushCurrentVisibleStamp,
            ),
          };
          if (entry.spatialTraceContext) {
            spatialTrace.attachDestinyUpdateContext(
              refreshedUpdate,
              entry.spatialTraceContext,
            );
          }
          return {
            ...entry,
            update: refreshedUpdate,
          };
        });
      const orderedEntries = alignQueuedEntityDependentStamps(
        refreshedEntries,
      )
        .slice()
        .sort((left, right) => {
          const stampOrder = compareDestinyStamps(
            left && left.update && left.update.stamp,
            right && right.update && right.update.stamp,
          );
          if (stampOrder !== 0) {
            return stampOrder;
          }
          return toInt(left && left.order, 0) - toInt(right && right.order, 0);
        });
      if (orderedEntries.length <= 0) {
        updateDestinyAuthorityState(queued.session, {
          heldQueueState: {
            active: false,
            queuedCount: 0,
            lastQueueStamp: null,
          },
        });
        if (deliveryTransaction) {
          rollbackDestinyDeliveryTransaction(deliveryTransaction, {
            reason: "empty-delivery-plan",
          });
        }
        continue;
      }

      let currentGroupUpdates = [];
      let currentGroupSendOptions = null;
      let currentGroupSignature = "";
      const collectedGroups = [];
      let collectedGroupOrder = 0;
      const flushQueuedGroup = () => {
        if (currentGroupUpdates.length <= 0) {
          return;
        }
        if (shouldLogMissilePayloadGroup(currentGroupUpdates)) {
          logMissileDebug("destiny.presentation-flush", {
            rawSimTimeMs: roundNumber(runtime.getCurrentSimTimeMs(), 3),
            session: buildMissileSessionSnapshot(runtime, queued.session),
            sendOptions: normalizeTraceValue(currentGroupSendOptions),
            updates: summarizeMissileUpdatesForLog(currentGroupUpdates),
          });
        }
        const collectedSendOptions = withDeliveryTransaction(
          {
            ...currentGroupSendOptions,
            _collectNotificationGroups: collectedGroups,
            _collectNotificationOrder: collectedGroupOrder++,
          },
          deliveryTransaction,
        );
        Object.defineProperty(
          collectedSendOptions,
          drainingTickPresentationPrefixToken,
          {
            configurable: false,
            enumerable: false,
            value: true,
            writable: false,
          },
        );
        runtime.sendDestinyUpdates(
          queued.session,
          currentGroupUpdates,
          false,
          collectedSendOptions,
        );
      };

      for (const entry of orderedEntries) {
        const update = entry && entry.update;
        if (!update) {
          continue;
        }
        const entrySendOptions = normalizeQueuedPresentationSendOptions(
          entry && entry.sendOptions,
        );
        const entrySignature =
          buildQueuedPresentationSendOptionsSignature(entrySendOptions);
        if (
          currentGroupUpdates.length > 0 &&
          entrySignature !== currentGroupSignature
        ) {
          flushQueuedGroup();
          currentGroupUpdates = [];
          currentGroupSendOptions = null;
          currentGroupSignature = "";
        }
        if (currentGroupUpdates.length <= 0) {
          currentGroupSendOptions = entrySendOptions;
          currentGroupSignature = entrySignature;
        }
        currentGroupUpdates.push(update);
      }

      flushQueuedGroup();
      const queuedGroupCount = queueCollectedDestinyGroupsForDirectFlush(
        runtime,
        queued.session,
        collectedGroups,
      );
      updateDestinyAuthorityState(queued.session, {
        heldQueueState: {
          active: !finalDrain,
          queuedCount: 0,
          lastQueueStamp: null,
        },
      });
      if (
        finalDrain &&
        queuedGroupCount <= 0 &&
        deliveryTransaction &&
        !hasQueuedDirectDeliveryWork(
          runtime,
          queued.session,
          deliveryTransaction,
        )
      ) {
        rollbackDestinyDeliveryTransaction(deliveryTransaction, {
          reason: "empty-delivery-plan",
        });
      }
      drainedUpdateCount += queuedUpdates.length;
      } catch (error) {
        rollbackTickPresentationDrainFailure(
          runtime,
          batch,
          storedEntries,
          error,
        );
        throw error;
      }
    }

    if (finalDrain) {
      flushDirectDestinyNotificationBatch(runtime);
    }
    return drainedUpdateCount;
  }

  function flushTickDestinyPresentationBatch(runtime) {
    return drainTickDestinyPresentationBatch(runtime, { final: true });
  }

  function sendDestinyUpdates(
    runtime,
    session,
    payloads,
    waitForBubble = false,
    options = {},
  ) {
    if (!session || payloads.length === 0) {
      return null;
    }
    if (rejectReentrantDestinySend(runtime, session)) {
      return null;
    }
    const existingDeliveryTransaction = getExistingDeliveryTransaction(
      runtime,
      session,
      options,
    );
    const suppliedDeliveryTransaction = resolveRootDeliveryTransaction(
      options && options._deliveryTransaction,
    );
    if (
      suppliedDeliveryTransaction &&
      suppliedDeliveryTransaction.session !== session
    ) {
      return null;
    }
    if (
      rejectStaleIncomingDeliveryPlan(
        runtime,
        session,
        options,
        existingDeliveryTransaction,
      )
    ) {
      return null;
    }
    const retainedPayloads =
      options && options[drainingTickPresentationPrefixToken] === true
        ? payloads
        : filterPendingRemovalDependentPayloads(session, payloads, options);
    if (
      retainedPayloads.length !== payloads.length &&
      hasDeliveryHooks(options)
    ) {
      rollbackUnplannedDeliveryCall(
        options,
        "entity-removal-pending",
        existingDeliveryTransaction,
      );
      return null;
    }
    if (retainedPayloads.length === 0) {
      rollbackUnplannedDeliveryCall(
        options,
        "entity-removal-pending",
        existingDeliveryTransaction,
      );
      return null;
    }
    payloads = retainedPayloads;

    const collectNotificationGroups = Array.isArray(
      options && options._collectNotificationGroups,
    )
      ? options._collectNotificationGroups
      : null;
    if (
      suppliedDeliveryTransaction &&
      (
        suppliedDeliveryTransaction.state !== "planning" ||
        !isDestinyDeliveryPlanCurrent(
          suppliedDeliveryTransaction,
        )
      )
    ) {
      if (
        suppliedDeliveryTransaction.state !== "committed" &&
        suppliedDeliveryTransaction.state !== "rolled-back"
      ) {
        const rollbackStaleSuppliedTransaction =
          getStaleDestinyDeliveryReason(suppliedDeliveryTransaction) ===
            "delivery-plan-replaced" &&
          !isDeliveryTransactionRetainedByRuntime(
            runtime,
            session,
            suppliedDeliveryTransaction,
          )
            ? rollbackDestinyDeliveryTransactionPreservingAuthority
            : rollbackDestinyDeliveryTransaction;
        rollbackStaleSuppliedTransaction(suppliedDeliveryTransaction, {
          reason: getStaleDestinyDeliveryReason(suppliedDeliveryTransaction),
          skipCallbacks:
            shouldSkipStaleDestinyDeliveryCallbacks(
              suppliedDeliveryTransaction,
            ),
        });
      }
      return null;
    }
    const shouldUseActiveTickDelivery = Boolean(
      !collectNotificationGroups &&
      hasActiveTickDestinyPresentationBatch(runtime),
    );
    const tickDeliveryEntry = shouldUseActiveTickDelivery
      ? ensureTickDestinyDeliveryEntry(
          runtime,
          session,
          {},
          suppliedDeliveryTransaction,
        )
      : null;
    if (shouldUseActiveTickDelivery && !tickDeliveryEntry) {
      return null;
    }
    if (
      shouldUseActiveTickDelivery &&
      Array.isArray(tickDeliveryEntry.updates) &&
      tickDeliveryEntry.updates.length > 0
    ) {
      drainTickDestinyPresentationBatch(runtime, {
        final: false,
        session,
      });
    }
    runtime.refreshSessionClockSnapshot(session);
    const rawSimTimeMs = runtime.getCurrentSimTimeMs();
    const currentRawDispatchStamp = runtime.getCurrentDestinyStamp(rawSimTimeMs);
    const deliveryTransaction =
      (tickDeliveryEntry && tickDeliveryEntry.deliveryTransaction) ||
      suppliedDeliveryTransaction ||
      (collectNotificationGroups
        ? createDestinyDeliveryTransaction(session, {})
        : ensureDirectDestinyDeliveryTransaction(
            runtime,
            session,
            currentRawDispatchStamp,
            {},
          ));
    if (
      !deliveryTransaction ||
      deliveryTransaction.state !== "planning" ||
      !isDestinyDeliveryPlanCurrent(deliveryTransaction)
    ) {
      if (
        deliveryTransaction &&
        deliveryTransaction.state !== "committed" &&
        deliveryTransaction.state !== "rolled-back"
      ) {
        rollbackDestinyDeliveryTransaction(deliveryTransaction, {
          reason: getStaleDestinyDeliveryReason(deliveryTransaction),
          skipCallbacks:
            shouldSkipStaleDestinyDeliveryCallbacks(deliveryTransaction),
        });
      }
      return null;
    }
    let deliveryHooksRegisteredForCall = false;
    const registerRetainedDeliveryHooks = () => {
      if (!deliveryHooksRegisteredForCall) {
        registerDestinyDeliveryHooks(deliveryTransaction, options);
        registerDestinyDeliveryPlanGuard(deliveryTransaction, options);
        deliveryHooksRegisteredForCall = true;
      }
    };
    const rollbackAfterPlanningFailure = (
      reason,
      error = null,
    ) => {
      if (
        deliveryTransaction.state !== "rolled-back" &&
        deliveryTransaction.state !== "committed"
      ) {
        rollbackDestinyDeliveryTransaction(deliveryTransaction, {
          error,
          reason,
        });
      }
      if (
        !deliveryHooksRegisteredForCall &&
        options &&
        typeof options.onDeliveryRollback === "function" &&
        !(
          deliveryTransaction.rollbackCallbacks instanceof Set &&
          deliveryTransaction.rollbackCallbacks.has(
            options.onDeliveryRollback,
          )
        )
      ) {
        try {
          options.onDeliveryRollback({
            error,
            planningOnly: true,
            reason,
          });
        } catch (_rollbackError) {
          // Preserve the original planning failure. Rollback hooks are
          // best-effort here because no physical group exists for this call.
        }
      }
    };
    const deliveryTransactionOwnedByActiveTick =
      isDeliveryTransactionOwnedByActiveTick(
        runtime,
        session,
        deliveryTransaction,
      );
    const shouldTraceMissileDispatch =
      shouldLogMissilePayloadGroup(payloads) ||
      payloads.some((payload) => (
        payload &&
        Array.isArray(payload.payload) &&
        payload.payload[0] === "SetState"
      )) ||
      typeof options.missileDebugReason === "string";
    const destinyCallTraceID = shouldTraceMissileDispatch
      ? getNextMissileDebugTraceID()
      : 0;
    const sessionBeforeSend = shouldTraceMissileDispatch
      ? buildMissileSessionSnapshot(runtime, session, rawSimTimeMs)
      : null;

    if (shouldSplitMixedFreshAcquirePayloads(payloads, options)) {
      const payloadGroups = splitContiguousFreshAcquirePayloadGroups(payloads);
      const shouldFlushSplitTransaction =
        !collectNotificationGroups &&
        !deliveryTransactionOwnedByActiveTick &&
        !(options && options.deferDirectDestinyFlush === true);
      if (shouldTraceMissileDispatch) {
        logMissileDebug("destiny.split-mixed-fresh-acquire-batch", {
          rawDispatchStamp: currentRawDispatchStamp,
          rawSimTimeMs: roundNumber(rawSimTimeMs, 3),
          waitForBubble,
          session: sessionBeforeSend,
          sendOptions: normalizeTraceValue(options),
          groups: payloadGroups.map((group) => ({
            isFreshAcquire: group.isFreshAcquire,
            updateCount: group.updates.length,
            updates: summarizeMissileUpdatesForLog(group.updates),
          })),
        });
      }
      let highestEmittedGroupStamp = null;
      let allowWaitForBubble = waitForBubble;
      let allowDelayedTargetEvents = true;
      try {
        for (const group of payloadGroups) {
          if (!group || !Array.isArray(group.updates) || group.updates.length === 0) {
            continue;
          }
          let groupOptions = group.isFreshAcquire
            ? options
            : buildNonFreshMixedPayloadSendOptions(options);
          if (!allowDelayedTargetEvents) {
            groupOptions = {
              ...(groupOptions && typeof groupOptions === "object" ? groupOptions : {}),
            };
            delete groupOptions.delayedTargetEvents;
          }
          groupOptions = withDeliveryTransaction(
            {
              ...(groupOptions && typeof groupOptions === "object"
                ? groupOptions
                : {}),
              deferDirectDestinyFlush: true,
            },
            deliveryTransaction,
          );
          const emittedStamp = sendDestinyUpdates(
            runtime,
            session,
            group.updates,
            allowWaitForBubble,
            groupOptions,
          );
          if (!hasDestinyStamp(emittedStamp)) {
            rollbackAfterPlanningFailure("delivery-planning-rejected");
            return null;
          }
          highestEmittedGroupStamp = selectLaterDestinyStamp(
            highestEmittedGroupStamp,
            emittedStamp,
          );
          allowWaitForBubble = false;
          allowDelayedTargetEvents = false;
        }
      } catch (error) {
        rollbackAfterPlanningFailure("delivery-planning-threw", error);
        throw error;
      }
      if (shouldFlushSplitTransaction) {
        flushDirectDestinyNotificationBatch(runtime);
      }
      if (deliveryTransaction.state === "rolled-back") {
        return null;
      }
      return highestEmittedGroupStamp;
    }

    if (shouldTraceMissileDispatch) {
      logMissileDebug("destiny.send-request", {
        destinyCallTraceID,
        rawDispatchStamp: currentRawDispatchStamp,
        rawSimTimeMs: roundNumber(rawSimTimeMs, 3),
        waitForBubble,
        sendReason:
          typeof options.missileDebugReason === "string"
            ? options.missileDebugReason
            : null,
        session: sessionBeforeSend,
        payloads: summarizeMissileUpdatesForLog(payloads),
      });
    }
    let groupedUpdates = [];
    let currentStamp = null;
    let firstGroup = true;
    let highestEmittedStamp = null;
    const emittedGroupSummaries = [];
    const collectNotificationBaseOrder = Math.max(
      0,
      toInt(options && options._collectNotificationOrder, 0),
    );
    let emittedGroupOrder = 0;
    const authorityStateBeforeSend = snapshotDestinyAuthorityState(session);
    const delayedTargetEvents = normalizeDelayedTargetEvents(
      options && options.delayedTargetEvents,
    );
    let lastFreshAcquireLifecycleStamp = resolveOptionalDestinyStamp(
      authorityStateBeforeSend && authorityStateBeforeSend.lastFreshAcquireLifecycleStamp,
      session && session._space && session._space.lastFreshAcquireLifecycleStamp,
    );
    let lastMissileLifecycleStamp = resolveOptionalDestinyStamp(
      authorityStateBeforeSend && authorityStateBeforeSend.lastMissileLifecycleStamp,
      session && session._space && session._space.lastMissileLifecycleStamp,
    );
    const ownerMissileLifecycleTupleBeforeSend =
      resolveDestinyAuthorityLaneTuple({
        authorityState: authorityStateBeforeSend,
        legacyState: session && session._space,
        stampKey: "lastOwnerMissileLifecycleStamp",
        rawDispatchKey: "lastOwnerMissileLifecycleRawDispatchStamp",
        anchorKey: "lastOwnerMissileLifecycleAnchorStamp",
      });
    let lastOwnerMissileLifecycleStamp =
      ownerMissileLifecycleTupleBeforeSend.stamp;
    let lastOwnerMissileLifecycleAnchorStamp =
      ownerMissileLifecycleTupleBeforeSend.anchorStamp;
    let lastOwnerMissileLifecycleRawDispatchStamp =
      ownerMissileLifecycleTupleBeforeSend.rawDispatchStamp;
    const ownerMissileFreshAcquireTupleBeforeSend =
      resolveDestinyAuthorityLaneTuple({
        authorityState: authorityStateBeforeSend,
        legacyState: session && session._space,
        stampKey: "lastOwnerMissileFreshAcquireStamp",
        rawDispatchKey: "lastOwnerMissileFreshAcquireRawDispatchStamp",
        anchorKey: "lastOwnerMissileFreshAcquireAnchorStamp",
      });
    let lastOwnerMissileFreshAcquireStamp =
      ownerMissileFreshAcquireTupleBeforeSend.stamp;
    let lastOwnerMissileFreshAcquireAnchorStamp =
      ownerMissileFreshAcquireTupleBeforeSend.anchorStamp;
    let lastOwnerMissileFreshAcquireRawDispatchStamp =
      ownerMissileFreshAcquireTupleBeforeSend.rawDispatchStamp;
    const ownerNonMissileCriticalTupleBeforeSend =
      resolveDestinyAuthorityLaneTuple({
        authorityState: authorityStateBeforeSend,
        legacyState: session && session._space,
        stampKey: "lastOwnerNonMissileCriticalStamp",
        rawDispatchKey: "lastOwnerNonMissileCriticalRawDispatchStamp",
      });
    let lastOwnerNonMissileCriticalStamp =
      ownerNonMissileCriticalTupleBeforeSend.stamp;
    let lastOwnerNonMissileCriticalRawDispatchStamp =
      ownerNonMissileCriticalTupleBeforeSend.rawDispatchStamp;
    const flushGroup = () => {
      if (groupedUpdates.length === 0) {
        return;
      }

      const emitGroupedUpdates = (updatesGroup, emitOptions = {}) => {
        if (!Array.isArray(updatesGroup) || updatesGroup.length === 0) {
          return null;
        }
        const entityPresentationIDs = getEntityPresentationIDs(updatesGroup);
        const minimumEntityPresentationStamp = getEntityPresentationFloor(
          deliveryTransaction,
          entityPresentationIDs,
        );
        const authorityEmitOptions = hasDestinyStamp(
          minimumEntityPresentationStamp,
        )
          ? {
              ...emitOptions,
              minimumEntityPresentationStamp,
            }
          : emitOptions;
        const authorityPlan = destinyAuthority.planGroupEmission({
          deliveryTransaction,
          runtime,
          session,
          updatesGroup,
          emitOptions: authorityEmitOptions,
          sendOptions: options,
          rawSimTimeMs,
          currentRawDispatchStamp,
          shouldTraceDispatch: shouldTraceMissileDispatch,
          destinyCallTraceID,
          waitForBubble,
          firstGroup,
          sessionState: {
            lastFreshAcquireLifecycleStamp,
            lastMissileLifecycleStamp,
            lastOwnerMissileLifecycleStamp,
            lastOwnerMissileLifecycleAnchorStamp,
            lastOwnerMissileFreshAcquireStamp,
            lastOwnerMissileFreshAcquireAnchorStamp,
            lastOwnerMissileFreshAcquireRawDispatchStamp,
            lastOwnerMissileLifecycleRawDispatchStamp,
            lastOwnerNonMissileCriticalStamp,
            lastOwnerNonMissileCriticalRawDispatchStamp,
          },
          updatesContainObserverPresentedMonotonicPayload,
        });
        if (authorityPlan) {
          const {
            authorityJourney,
            updates: authorityUpdates,
            finalStamp: authorityStamp,
            originalStamp: authorityOriginalStamp,
            traceDetails: authorityTraceDetails,
            currentSessionStamp: authorityCurrentSessionStamp,
            flags: authorityFlags,
          } = authorityPlan;
          if (
            hasDestinyStamp(minimumEntityPresentationStamp) &&
            isDestinyStampAfter(
              authorityStamp,
              minimumEntityPresentationStamp,
            )
          ) {
            destinyAuthority.rejectGroupJourney(authorityJourney, {
              session,
              reason:
                `entity order floor ${minimumEntityPresentationStamp} exceeds trusted ceiling at ${authorityStamp}`,
              originalStamp: authorityOriginalStamp,
              attemptedStamp: authorityStamp >>> 0,
              restampSteps: authorityTraceDetails
                ? authorityTraceDetails.restampSteps
                : [],
            });
            recordDestinyLedger(session, "destiny.group.rejected", {
              reason: "entity-order-floor-exceeds-authority-ceiling",
              attemptedStamp: authorityStamp >>> 0,
              minimumEntityPresentationStamp,
              originalStamp: authorityOriginalStamp,
              contract: authorityJourney.contract,
              updates: summarizeDestinyUpdates(authorityUpdates),
            });
            const conflictError = new Error(
              "Destiny entity order floor exceeds its trusted authority ceiling",
            );
            conflictError.code = "DESTINY_ENTITY_ORDER_CEILING_CONFLICT";
            throw conflictError;
          }
          if (spatialTrace.isEnabled()) {
            const correlationCount = Math.min(
              updatesGroup.length,
              authorityUpdates.length,
            );
            for (let index = 0; index < correlationCount; index += 1) {
              spatialTrace.propagateDestinyUpdateContext(
                updatesGroup[index],
                authorityUpdates[index],
                session,
              );
            }
          }
          if (
            isDestinyStampAfter(
              authorityStamp,
              authorityFlags.previousLastSentDestinyStamp,
            ) &&
            authorityFlags.previousLastSentTrustedForBackstepGuard === true &&
            authorityFlags.previousLastSentDestinyOnlyStaleProjectedOwnerMissileLane !== true &&
            authorityFlags.allowSoftBackstepBehindNonCriticalPresentation !== true
          ) {
            destinyAuthority.rejectGroupJourney(authorityJourney, {
              session,
              reason: `final stamp ${authorityStamp >>> 0} behind last sent ${authorityFlags.previousLastSentDestinyStamp}`,
              originalStamp: authorityOriginalStamp,
              attemptedStamp: authorityStamp >>> 0,
              restampSteps: authorityTraceDetails
                ? authorityTraceDetails.restampSteps
                : [],
            });
            recordDestinyLedger(session, "destiny.group.rejected", {
              reason: "final-stamp-behind-last-sent",
              attemptedStamp: authorityStamp >>> 0,
              previousLastSentDestinyStamp:
                authorityFlags.previousLastSentDestinyStamp,
              originalStamp: authorityOriginalStamp,
              contract: authorityJourney.contract,
              updates: summarizeDestinyUpdates(authorityUpdates),
            });
            firstGroup = false;
            return null;
          }
          registerRetainedDeliveryHooks();
          recordEntityPresentationFloor(
            deliveryTransaction,
            entityPresentationIDs,
            authorityStamp,
          );
          if (collectNotificationGroups) {
            appendCollectedDestinyGroup(collectNotificationGroups, {
              stamp: authorityStamp >>> 0,
              waitForBubble: waitForBubble && firstGroup,
              order: ((collectNotificationBaseOrder * 100000) + emittedGroupOrder) >>> 0,
              updates: authorityUpdates,
              contract: authorityJourney.contract,
              rawDispatchStamp: currentRawDispatchStamp,
              delayedTargetEvents: firstGroup ? delayedTargetEvents : null,
              deliveryTransaction,
            });
            emittedGroupOrder += 1;
          } else {
            queueDirectDestinyNotificationGroup(runtime, session, {
              stamp: authorityStamp >>> 0,
              waitForBubble: waitForBubble && firstGroup,
              updates: authorityUpdates,
              contract: authorityJourney.contract,
              rawDispatchStamp: currentRawDispatchStamp,
              delayedTargetEvents: firstGroup ? delayedTargetEvents : null,
              deliveryTransaction,
            });
          }
          const authorityLegacyState =
            destinyAuthority.applyLegacySessionEmissionState(
              authorityJourney,
              {
                session,
                finalStamp: authorityStamp >>> 0,
                currentSessionStamp: authorityCurrentSessionStamp,
                flags: authorityFlags,
                legacyStateBefore: {
                  lastFreshAcquireLifecycleStamp,
                  lastMissileLifecycleStamp,
                  lastOwnerMissileLifecycleStamp,
                  lastOwnerMissileLifecycleAnchorStamp,
                  lastOwnerMissileFreshAcquireStamp,
                  lastOwnerMissileFreshAcquireAnchorStamp,
                  lastOwnerMissileFreshAcquireRawDispatchStamp,
                  lastOwnerMissileLifecycleRawDispatchStamp,
                  lastOwnerNonMissileCriticalStamp,
                  lastOwnerNonMissileCriticalRawDispatchStamp,
                },
              },
            );
          lastFreshAcquireLifecycleStamp =
            authorityLegacyState.lastFreshAcquireLifecycleStamp;
          lastMissileLifecycleStamp =
            authorityLegacyState.lastMissileLifecycleStamp;
          lastOwnerMissileLifecycleStamp =
            authorityLegacyState.lastOwnerMissileLifecycleStamp;
          lastOwnerMissileLifecycleAnchorStamp =
            authorityLegacyState.lastOwnerMissileLifecycleAnchorStamp;
          lastOwnerMissileFreshAcquireStamp =
            authorityLegacyState.lastOwnerMissileFreshAcquireStamp;
          lastOwnerMissileFreshAcquireAnchorStamp =
            authorityLegacyState.lastOwnerMissileFreshAcquireAnchorStamp;
          lastOwnerMissileFreshAcquireRawDispatchStamp =
            authorityLegacyState.lastOwnerMissileFreshAcquireRawDispatchStamp;
          lastOwnerMissileLifecycleRawDispatchStamp =
            authorityLegacyState.lastOwnerMissileLifecycleRawDispatchStamp;
          lastOwnerNonMissileCriticalStamp =
            authorityLegacyState.lastOwnerNonMissileCriticalStamp;
          lastOwnerNonMissileCriticalRawDispatchStamp =
            authorityLegacyState.lastOwnerNonMissileCriticalRawDispatchStamp;
          const authoritySessionAfter = destinyAuthority.completeGroupJourney(
            authorityJourney,
            {
              session,
              originalStamp: authorityOriginalStamp,
              finalStamp: authorityStamp >>> 0,
              currentSessionStamp: authorityCurrentSessionStamp,
              isCritical:
                authorityFlags.isOwnerCriticalGroup ||
                authorityFlags.isSetStateGroup ||
                authorityFlags.isMissileLifecycleGroup,
              isFreshAcquireLifecycleGroup:
                authorityFlags.isFreshAcquireLifecycleGroup,
              isMissileLifecycleGroup:
                authorityFlags.isMissileLifecycleGroup,
              flags: authorityFlags,
              restampSteps: authorityTraceDetails
                ? authorityTraceDetails.restampSteps
                : [],
              updates: authorityUpdates,
            },
          );
          if (authoritySessionAfter) {
            const legacyTrackedLaneState = {
              lastOwnerMissileLifecycleStamp,
              lastOwnerMissileLifecycleAnchorStamp,
              lastOwnerMissileLifecycleRawDispatchStamp,
              lastOwnerMissileFreshAcquireStamp,
              lastOwnerMissileFreshAcquireAnchorStamp,
              lastOwnerMissileFreshAcquireRawDispatchStamp,
              lastOwnerNonMissileCriticalStamp,
              lastOwnerNonMissileCriticalRawDispatchStamp,
            };
            lastFreshAcquireLifecycleStamp = resolveOptionalDestinyStamp(
              authoritySessionAfter.lastFreshAcquireLifecycleStamp,
              lastFreshAcquireLifecycleStamp,
            );
            lastMissileLifecycleStamp = resolveOptionalDestinyStamp(
              authoritySessionAfter.lastMissileLifecycleStamp,
              lastMissileLifecycleStamp,
            );
            const completedOwnerMissileLifecycleTuple =
              resolveDestinyAuthorityLaneTuple({
                authorityState: authoritySessionAfter,
                legacyState: legacyTrackedLaneState,
                stampKey: "lastOwnerMissileLifecycleStamp",
                rawDispatchKey: "lastOwnerMissileLifecycleRawDispatchStamp",
                anchorKey: "lastOwnerMissileLifecycleAnchorStamp",
              });
            lastOwnerMissileLifecycleStamp =
              completedOwnerMissileLifecycleTuple.stamp;
            lastOwnerMissileLifecycleAnchorStamp =
              completedOwnerMissileLifecycleTuple.anchorStamp;
            lastOwnerMissileLifecycleRawDispatchStamp =
              completedOwnerMissileLifecycleTuple.rawDispatchStamp;
            const completedOwnerMissileFreshAcquireTuple =
              resolveDestinyAuthorityLaneTuple({
                authorityState: authoritySessionAfter,
                legacyState: legacyTrackedLaneState,
                stampKey: "lastOwnerMissileFreshAcquireStamp",
                rawDispatchKey: "lastOwnerMissileFreshAcquireRawDispatchStamp",
                anchorKey: "lastOwnerMissileFreshAcquireAnchorStamp",
              });
            lastOwnerMissileFreshAcquireStamp =
              completedOwnerMissileFreshAcquireTuple.stamp;
            lastOwnerMissileFreshAcquireAnchorStamp =
              completedOwnerMissileFreshAcquireTuple.anchorStamp;
            lastOwnerMissileFreshAcquireRawDispatchStamp =
              completedOwnerMissileFreshAcquireTuple.rawDispatchStamp;
            const completedOwnerNonMissileCriticalTuple =
              resolveDestinyAuthorityLaneTuple({
                authorityState: authoritySessionAfter,
                legacyState: legacyTrackedLaneState,
                stampKey: "lastOwnerNonMissileCriticalStamp",
                rawDispatchKey: "lastOwnerNonMissileCriticalRawDispatchStamp",
              });
            lastOwnerNonMissileCriticalStamp =
              completedOwnerNonMissileCriticalTuple.stamp;
            lastOwnerNonMissileCriticalRawDispatchStamp =
              completedOwnerNonMissileCriticalTuple.rawDispatchStamp;
          }
          if (authorityTraceDetails) {
            authorityTraceDetails.finalStamp = authorityStamp >>> 0;
            authorityTraceDetails.emittedUpdates =
              summarizeMissileUpdatesForLog(authorityUpdates);
            authorityTraceDetails.sessionAfter = buildMissileSessionSnapshot(
              runtime,
              session,
              rawSimTimeMs,
            );
            authorityTraceDetails.authoritySessionAfter = authoritySessionAfter;
            authorityTraceDetails.sessionMutation = buildMissileSessionMutation(
              authorityTraceDetails.sessionBefore,
              authorityTraceDetails.sessionAfter,
            );
            emittedGroupSummaries.push({
              groupReason: authorityTraceDetails.groupReason,
              contract: authorityJourney.contract,
              originalStamp: authorityTraceDetails.originalStamp,
              finalStamp: authorityTraceDetails.finalStamp,
              groupFlags: authorityTraceDetails.groupFlags,
              sessionMutation: authorityTraceDetails.sessionMutation,
              emittedUpdates: authorityTraceDetails.emittedUpdates,
            });
            logMissileDebug("destiny.emit-group", authorityTraceDetails);
          }
          firstGroup = false;
          highestEmittedStamp = selectLaterDestinyStamp(
            highestEmittedStamp,
            normalizeDestinyStamp(authorityStamp),
          );
          return authorityStamp >>> 0;
        }
        firstGroup = false;
        return null;
      };

      const hasMixedOwnerMissileFreshAcquireAndLifecycle = (
        groupedUpdates.some(
          (payload) =>
            payload &&
            payload.freshAcquireLifecycleGroup === true &&
            payload.ownerMissileLifecycleGroup === true,
        ) &&
        groupedUpdates.some(
          (payload) =>
            payload &&
            payload.ownerMissileLifecycleGroup === true &&
            payload.freshAcquireLifecycleGroup !== true,
        )
      );
      if (hasMixedOwnerMissileFreshAcquireAndLifecycle) {
        if (shouldTraceMissileDispatch) {
          logMissileDebug("destiny.split-owner-missile-group", {
            destinyCallTraceID,
            rawDispatchStamp: currentRawDispatchStamp,
            rawSimTimeMs: roundNumber(rawSimTimeMs, 3),
            sendReason:
              typeof options.missileDebugReason === "string"
                ? options.missileDebugReason
                : null,
            session: buildMissileSessionSnapshot(runtime, session, rawSimTimeMs),
            updates: summarizeMissileUpdatesForLog(groupedUpdates),
          });
        }
        const freshAcquireUpdates = groupedUpdates.filter(
          (payload) => payload && payload.freshAcquireLifecycleGroup === true,
        );
        const lifecycleUpdates = groupedUpdates.filter(
          (payload) => !payload || payload.freshAcquireLifecycleGroup !== true,
        );
        const freshAcquireStamp = emitGroupedUpdates(freshAcquireUpdates, {
          missileDebugReason: options.missileDebugReason,
          groupReason: "owner-missile-fresh-acquire",
        });
        emitGroupedUpdates(lifecycleUpdates, {
          missileDebugReason: options.missileDebugReason,
          groupReason: "owner-missile-lifecycle",
          minimumPostFreshAcquireStamp: hasDestinyStamp(freshAcquireStamp)
            ? advanceDestinyStamp(freshAcquireStamp, 1)
            : null,
        });
        groupedUpdates = [];
        currentStamp = null;
        return;
      }

      emitGroupedUpdates(groupedUpdates, {
        missileDebugReason: options.missileDebugReason,
      });
      groupedUpdates = [];
      currentStamp = null;
    };

    try {
      for (let rawPayloadOrder = 0; rawPayloadOrder < payloads.length; rawPayloadOrder += 1) {
        const rawPayload = payloads[rawPayloadOrder];
        const authoredTraceContext = spatialTrace.isEnabled()
          ? spatialTrace.recordDestinyActionAuthored(runtime, session, rawPayload, {
            orderInCall: rawPayloadOrder,
            simulationTimeMs: rawSimTimeMs,
          })
          : null;
        const payload = runtime.prepareDestinyUpdateForSession(
          session,
          rawPayload,
          rawSimTimeMs,
          options,
        );
        if (authoredTraceContext) {
          spatialTrace.attachDestinyUpdateContext(payload, authoredTraceContext);
        }
        const stamp = Number(payload && payload.stamp);
        if (groupedUpdates.length === 0) {
          groupedUpdates.push(payload);
          currentStamp = stamp;
          continue;
        }

        if (stamp === currentStamp) {
          groupedUpdates.push(payload);
          continue;
        }

        flushGroup();
        groupedUpdates.push(payload);
        currentStamp = stamp;
      }

      flushGroup();
    } catch (error) {
      rollbackAfterPlanningFailure("delivery-planning-threw", error);
      if (error && error.code === "DESTINY_ENTITY_ORDER_CEILING_CONFLICT") {
        return null;
      }
      throw error;
    }
    if (!hasDestinyStamp(highestEmittedStamp)) {
      rollbackAfterPlanningFailure("delivery-planning-rejected");
      return null;
    }
    if (
      !collectNotificationGroups &&
      !deliveryTransactionOwnedByActiveTick &&
      !(options && options.deferDirectDestinyFlush === true)
    ) {
      flushDirectDestinyNotificationBatch(runtime);
    }
    if (deliveryTransaction.state === "rolled-back") {
      return null;
    }
    if (shouldTraceMissileDispatch) {
      const sessionAfterSend = buildMissileSessionSnapshot(
        runtime,
        session,
        rawSimTimeMs,
      );
      logMissileDebug("destiny.send-complete", {
        destinyCallTraceID,
        rawDispatchStamp: currentRawDispatchStamp,
        rawSimTimeMs: roundNumber(rawSimTimeMs, 3),
        waitForBubble,
        highestEmittedStamp,
        payloadCount: payloads.length,
        sessionBefore: sessionBeforeSend,
        sessionAfter: sessionAfterSend,
        sessionMutation: buildMissileSessionMutation(
          sessionBeforeSend,
          sessionAfterSend,
        ),
        emittedGroups: emittedGroupSummaries,
      });
    }
    return highestEmittedStamp;
  }

  function sendDestinyBatch(
    runtime,
    session,
    payloads,
    waitForBubble = false,
    options = {},
  ) {
    return sendDestinyUpdates(
      runtime,
      session,
      payloads,
      waitForBubble,
      options,
    );
  }

  function sendDestinyUpdatesIndividually(
    runtime,
    session,
    payloads,
    waitForBubble = false,
    options = {},
  ) {
    if (!session || payloads.length === 0) {
      return;
    }

    for (let index = 0; index < payloads.length; index += 1) {
      runtime.sendDestinyUpdates(
        session,
        [payloads[index]],
        waitForBubble && index === 0,
        options,
      );
    }
  }

  function sendMovementUpdatesToSession(runtime, session, updates) {
    if (!session || !isReadyForDestiny(session) || updates.length === 0) {
      return;
    }

    runtime.sendDestinyUpdates(session, updates, false, {
      destinyAuthorityContract: DESTINY_CONTRACTS.CRITICAL_MOVEMENT_OR_SHIPPRIME,
    });
  }

  return {
    getDestinyHistoryAnchorStampForSession,
    resolveDestinyDeliveryStampForSession,
    prepareDestinyUpdateForSession,
    beginTickDestinyPresentationBatch,
    hasActiveTickDestinyPresentationBatch,
    shouldDeferPilotMovementForMissilePressure,
    queueTickDestinyPresentationUpdates,
    flushTickDestinyPresentationBatch,
    queueDirectDestinyNotificationGroup,
    flushDirectDestinyNotificationBatch,
    isSessionOpenForDestinyDelivery,
    destroySessionAfterUnsafeDestinyDelivery,
    sendDestinyUpdates,
    sendDestinyBatch,
    sendDestinyUpdatesIndividually,
    sendMovementUpdatesToSession,
  };
}

module.exports = {
  createMovementDestinyDispatch,
};
