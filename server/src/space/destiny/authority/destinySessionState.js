const {
  MICHELLE_HELD_FUTURE_DESTINY_LEAD,
} = require("../delivery/michelleContract");
const {
  parseDestinyDirectionHeading,
  serializeDestinyDirectionHeading,
} = require("../protocol/direction");
const {
  advanceDestinyStamp,
  hasDestinyStamp,
  isDestinyStampAfter,
  normalizeDestinyStamp,
  resolveOptionalDestinyStamp,
  selectLaterDestinyStamp,
} = require("../delivery/stamps");

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    return Math.trunc(numeric);
  }
  const fallbackNumeric = Number(fallback);
  return Number.isFinite(fallbackNumeric) ? Math.trunc(fallbackNumeric) : 0;
}

function selectLatestPresentDestinyStamp(values, fallback = null) {
  const selected = (Array.isArray(values) ? values : [values])
    .filter(hasDestinyStamp)
    .reduce(
      (latest, candidate) => selectLaterDestinyStamp(latest, candidate),
      null,
    );
  return hasDestinyStamp(selected)
    ? normalizeDestinyStamp(selected)
    : resolveOptionalDestinyStamp(fallback);
}

function cloneHeldQueueState(source) {
  if (!source || typeof source !== "object") {
    return {
      active: false,
      queuedCount: 0,
      lastQueueStamp: null,
    };
  }
  return {
    active: source.active === true,
    queuedCount: Math.max(0, toInt(source.queuedCount, 0)),
    lastQueueStamp: resolveOptionalDestinyStamp(source.lastQueueStamp),
  };
}

function resolveDestinyAuthorityLaneTuple({
  authorityState,
  legacyState,
  stampKey,
  rawDispatchKey = "",
  anchorKey = "",
  legacyStampKey = stampKey,
  legacyRawDispatchKey = rawDispatchKey,
  legacyAnchorKey = anchorKey,
} = {}) {
  const hasAuthorityLane = Boolean(
    authorityState &&
    stampKey &&
    hasDestinyStamp(authorityState[stampKey]),
  );
  const sourceState = hasAuthorityLane ? authorityState : legacyState;
  const sourceStampKey = hasAuthorityLane ? stampKey : legacyStampKey;
  const sourceRawDispatchKey = hasAuthorityLane
    ? rawDispatchKey
    : legacyRawDispatchKey;
  const sourceAnchorKey = hasAuthorityLane ? anchorKey : legacyAnchorKey;
  const stamp = sourceState && sourceStampKey
    ? resolveOptionalDestinyStamp(sourceState[sourceStampKey])
    : null;

  // Companions have meaning only as members of the selected semantic
  // generation. Never fill an absent authority companion from a legacy lane.
  return {
    stamp,
    rawDispatchStamp:
      hasDestinyStamp(stamp) && sourceState && sourceRawDispatchKey
        ? resolveOptionalDestinyStamp(sourceState[sourceRawDispatchKey])
        : null,
    anchorStamp:
      hasDestinyStamp(stamp) && sourceState && sourceAnchorKey
        ? resolveOptionalDestinyStamp(sourceState[sourceAnchorKey])
        : null,
    fromAuthority: hasAuthorityLane,
  };
}

function resolveDestinyAuthorityCommandTuple({
  authorityState,
  legacyState,
} = {}) {
  const lane = resolveDestinyAuthorityLaneTuple({
    authorityState,
    legacyState,
    stampKey: "lastOwnerCommandStamp",
    rawDispatchKey: "lastOwnerCommandRawDispatchStamp",
    anchorKey: "lastOwnerCommandAnchorStamp",
    legacyStampKey: "lastPilotCommandMovementStamp",
    legacyRawDispatchKey: "lastPilotCommandMovementRawDispatchStamp",
    legacyAnchorKey: "lastPilotCommandMovementAnchorStamp",
  });
  let headingHash = lane.fromAuthority
    ? typeof authorityState.lastOwnerCommandHeadingHash === "string"
      ? authorityState.lastOwnerCommandHeadingHash
      : ""
    : serializeDestinyDirectionHeading(
        legacyState && legacyState.lastPilotCommandDirection,
      );
  if (lane.fromAuthority && !headingHash) {
    const legacyLane = resolveDestinyAuthorityLaneTuple({
      authorityState: null,
      legacyState,
      stampKey: "lastOwnerCommandStamp",
      rawDispatchKey: "lastOwnerCommandRawDispatchStamp",
      anchorKey: "lastOwnerCommandAnchorStamp",
      legacyStampKey: "lastPilotCommandMovementStamp",
      legacyRawDispatchKey: "lastPilotCommandMovementRawDispatchStamp",
      legacyAnchorKey: "lastPilotCommandMovementAnchorStamp",
    });
    const exactLegacyMirror =
      legacyLane.stamp === lane.stamp &&
      legacyLane.rawDispatchStamp === lane.rawDispatchStamp &&
      legacyLane.anchorStamp === lane.anchorStamp;
    if (exactLegacyMirror) {
      headingHash = serializeDestinyDirectionHeading(
        legacyState && legacyState.lastPilotCommandDirection,
      );
    }
  }
  const direction = parseDestinyDirectionHeading(headingHash);
  return {
    ...lane,
    headingHash,
    direction,
  };
}

function ensureDestinyAuthorityState(session) {
  if (!session || !session._space) {
    return null;
  }
  const spaceState = session._space;
  const currentState =
    spaceState.destinyAuthorityState &&
    typeof spaceState.destinyAuthorityState === "object"
      ? spaceState.destinyAuthorityState
      : {};
  const legacyLastSentStamp = resolveOptionalDestinyStamp(
    spaceState.lastSentDestinyStamp,
  );
  const hasLegacyLastSentStamp = hasDestinyStamp(legacyLastSentStamp);
  const legacyLastSentRawDispatchStamp = resolveOptionalDestinyStamp(
    spaceState.lastSentDestinyRawDispatchStamp,
  );
  const hasLegacyLastSentRawDispatchStamp = hasDestinyStamp(
    legacyLastSentRawDispatchStamp,
  );
  const legacyOwnerCommandStamp = resolveOptionalDestinyStamp(
    spaceState.lastPilotCommandMovementStamp,
  );
  const legacyOwnerCommandRawDispatchStamp = resolveOptionalDestinyStamp(
    spaceState.lastPilotCommandMovementRawDispatchStamp,
  );
  const legacyLastSentMatchesOwnerCommand =
    hasLegacyLastSentStamp &&
    hasDestinyStamp(legacyOwnerCommandStamp) &&
    legacyLastSentStamp === legacyOwnerCommandStamp;
  const legacyOwnerMissileLifecycleStamp = resolveOptionalDestinyStamp(
    spaceState.lastOwnerMissileLifecycleStamp,
  );
  const legacyOwnerMissileFreshAcquireStamp = resolveOptionalDestinyStamp(
    spaceState.lastOwnerMissileFreshAcquireStamp,
  );
  const legacyOwnerNonMissileCriticalStamp = resolveOptionalDestinyStamp(
    spaceState.lastOwnerNonMissileCriticalStamp,
  );
  const legacyLastSentMatchesOwnerMissileLifecycle =
    hasLegacyLastSentStamp &&
    hasDestinyStamp(legacyOwnerMissileLifecycleStamp) &&
    legacyLastSentStamp === legacyOwnerMissileLifecycleStamp;
  const legacyLastSentMatchesOwnerMissileFreshAcquire =
    hasLegacyLastSentStamp &&
    hasDestinyStamp(legacyOwnerMissileFreshAcquireStamp) &&
    legacyLastSentStamp === legacyOwnerMissileFreshAcquireStamp;
  const legacyLastSentMatchesOwnerNonMissileCritical =
    hasLegacyLastSentStamp &&
    hasDestinyStamp(legacyOwnerNonMissileCriticalStamp) &&
    legacyLastSentStamp === legacyOwnerNonMissileCriticalStamp;
  const currentAuthorityLastPresentedStamp = resolveOptionalDestinyStamp(
    currentState.lastPresentedStamp,
  );
  const currentAuthorityLastRawDispatchStamp = resolveOptionalDestinyStamp(
    currentState.lastRawDispatchStamp,
  );
  const legacyLastSentCriticalFlagLooksInherited =
    spaceState.lastSentDestinyWasOwnerCritical === true &&
    hasLegacyLastSentStamp &&
    hasDestinyStamp(currentState.lastPresentedStamp) &&
    hasDestinyStamp(currentState.lastRawDispatchStamp) &&
    legacyLastSentStamp !== currentAuthorityLastPresentedStamp &&
    hasLegacyLastSentRawDispatchStamp &&
    legacyLastSentRawDispatchStamp === currentAuthorityLastRawDispatchStamp;
  const legacyLastSentUntrustedFarAheadOwnerCommand =
    legacyLastSentMatchesOwnerCommand &&
    !hasDestinyStamp(legacyOwnerCommandRawDispatchStamp) &&
    hasDestinyStamp(currentState.lastPresentedStamp) &&
    isDestinyStampAfter(
      advanceDestinyStamp(
        currentAuthorityLastPresentedStamp,
        MICHELLE_HELD_FUTURE_DESTINY_LEAD,
      ),
      legacyLastSentStamp,
    );
  const legacyLastSentUntrustedMissileActivePresentationLane =
    hasLegacyLastSentStamp &&
    (
      spaceState.lastSentDestinyWasOwnerCritical !== true ||
      legacyLastSentCriticalFlagLooksInherited
    ) &&
    hasDestinyStamp(legacyOwnerMissileLifecycleStamp) &&
    isDestinyStampAfter(
      advanceDestinyStamp(
        legacyOwnerMissileLifecycleStamp,
        MICHELLE_HELD_FUTURE_DESTINY_LEAD,
      ),
      legacyLastSentStamp,
    ) &&
    legacyLastSentMatchesOwnerCommand !== true &&
    legacyLastSentMatchesOwnerMissileLifecycle !== true &&
    legacyLastSentMatchesOwnerMissileFreshAcquire !== true &&
    legacyLastSentMatchesOwnerNonMissileCritical !== true;
  const legacyLastSentUntrustedLane =
    legacyLastSentUntrustedFarAheadOwnerCommand ||
    legacyLastSentUntrustedMissileActivePresentationLane;
  const trustedLegacyLastSentStamp =
    legacyLastSentUntrustedLane ? null : legacyLastSentStamp;
  const trustedLegacyLastSentRawDispatchStamp =
    legacyLastSentUntrustedLane ? null : legacyLastSentRawDispatchStamp;
  const legacyLastSentWasOwnerCritical =
    typeof spaceState.lastSentDestinyWasOwnerCritical === "boolean"
      ? spaceState.lastSentDestinyWasOwnerCritical === true
      : (
          hasLegacyLastSentStamp &&
          legacyLastSentUntrustedLane !== true &&
          (
            (
              legacyLastSentMatchesOwnerCommand &&
              hasDestinyStamp(legacyOwnerCommandRawDispatchStamp)
            ) ||
            legacyLastSentMatchesOwnerNonMissileCritical ||
            legacyLastSentMatchesOwnerMissileLifecycle ||
            legacyLastSentMatchesOwnerMissileFreshAcquire
          )
        );
  const currentLastPresentedStamp = resolveOptionalDestinyStamp(
    currentState.lastPresentedStamp,
    trustedLegacyLastSentStamp,
  );
  const legacyLastSentSupersedesAuthority =
    legacyLastSentUntrustedLane !== true &&
    hasLegacyLastSentStamp &&
    (
      !hasDestinyStamp(currentState.lastPresentedStamp) ||
      (
        hasDestinyStamp(currentLastPresentedStamp) &&
        isDestinyStampAfter(currentLastPresentedStamp, legacyLastSentStamp)
      ) ||
      (
        legacyLastSentStamp === currentLastPresentedStamp &&
        hasLegacyLastSentRawDispatchStamp &&
        (
          !hasDestinyStamp(currentState.lastRawDispatchStamp) ||
          isDestinyStampAfter(
            currentAuthorityLastRawDispatchStamp,
            legacyLastSentRawDispatchStamp,
          )
        )
      )
    );
  const hasExplicitLegacyLastSentWasOwnerCritical =
    typeof spaceState.lastSentDestinyWasOwnerCritical === "boolean";
  const hasExplicitLegacyLastSentOnlyStaleProjectedOwnerMissileLane =
    typeof spaceState.lastSentDestinyOnlyStaleProjectedOwnerMissileLane ===
      "boolean";
  const legacyLastSentMatchesAuthorityTuple =
    legacyLastSentUntrustedLane !== true &&
    hasLegacyLastSentStamp &&
    hasDestinyStamp(currentState.lastPresentedStamp) &&
    legacyLastSentStamp === currentAuthorityLastPresentedStamp &&
    (
      (
        hasLegacyLastSentRawDispatchStamp &&
        hasDestinyStamp(currentState.lastRawDispatchStamp) &&
        legacyLastSentRawDispatchStamp === currentAuthorityLastRawDispatchStamp
      ) ||
      (
        !hasLegacyLastSentRawDispatchStamp &&
        !hasDestinyStamp(currentState.lastRawDispatchStamp)
      )
    ) &&
    (
      hasExplicitLegacyLastSentWasOwnerCritical ||
      hasExplicitLegacyLastSentOnlyStaleProjectedOwnerMissileLane
    );

  const currentOrFallbackStamp = (key, fallback = null) => (
    hasDestinyStamp(currentState[key])
      ? normalizeDestinyStamp(currentState[key])
      : resolveOptionalDestinyStamp(fallback)
  );
  const hasCurrentPresentedLane = hasDestinyStamp(
    currentState.lastPresentedStamp,
  );
  const initialPresentedStamp = hasCurrentPresentedLane
    ? normalizeDestinyStamp(currentState.lastPresentedStamp)
    : resolveOptionalDestinyStamp(trustedLegacyLastSentStamp);
  const initialPresentedRawDispatchStamp = hasCurrentPresentedLane
    ? resolveOptionalDestinyStamp(currentState.lastRawDispatchStamp)
    : hasDestinyStamp(initialPresentedStamp)
      ? resolveOptionalDestinyStamp(trustedLegacyLastSentRawDispatchStamp)
      : null;
  const initialPresentedWasOwnerCritical = hasCurrentPresentedLane
    ? currentState.lastSentWasOwnerCritical === true
    : hasDestinyStamp(initialPresentedStamp) &&
      legacyLastSentWasOwnerCritical === true;
  const initialPresentedOnlyStaleProjectedOwnerMissileLane =
    hasCurrentPresentedLane
      ? currentState.lastSentOnlyStaleProjectedOwnerMissileLane === true
      : hasDestinyStamp(initialPresentedStamp) &&
        spaceState.lastSentDestinyOnlyStaleProjectedOwnerMissileLane === true;

  const nextState = {
    lastRawDispatchStamp: initialPresentedRawDispatchStamp,
    lastPresentedStamp: initialPresentedStamp,
    lastCriticalStamp: currentOrFallbackStamp(
      "lastCriticalStamp",
      selectLatestPresentDestinyStamp([
        legacyOwnerNonMissileCriticalStamp,
        legacyOwnerMissileLifecycleStamp,
        legacyOwnerMissileFreshAcquireStamp,
        legacyOwnerCommandStamp,
      ]),
    ),
    lastNonCriticalStamp: currentOrFallbackStamp(
      "lastNonCriticalStamp",
      legacyLastSentUntrustedLane || legacyLastSentWasOwnerCritical === true
        ? null
        : trustedLegacyLastSentStamp,
    ),
    lastSentWasOwnerCritical: initialPresentedWasOwnerCritical,
    lastSentOnlyStaleProjectedOwnerMissileLane:
      initialPresentedOnlyStaleProjectedOwnerMissileLane,
    lastOwnerCommandStamp: currentOrFallbackStamp("lastOwnerCommandStamp"),
    lastOwnerCommandAnchorStamp: currentOrFallbackStamp(
      "lastOwnerCommandAnchorStamp",
    ),
    lastOwnerCommandRawDispatchStamp: currentOrFallbackStamp(
      "lastOwnerCommandRawDispatchStamp",
    ),
    lastOwnerCommandHeadingHash: typeof currentState.lastOwnerCommandHeadingHash === "string"
      ? currentState.lastOwnerCommandHeadingHash
      : "",
    lastFreshAcquireLifecycleStamp: currentOrFallbackStamp(
      "lastFreshAcquireLifecycleStamp",
      spaceState.lastFreshAcquireLifecycleStamp,
    ),
    lastBootstrapStamp: currentOrFallbackStamp(
      "lastBootstrapStamp",
      selectLatestPresentDestinyStamp([
        spaceState.lastFreshAcquireLifecycleStamp,
        legacyOwnerMissileFreshAcquireStamp,
      ]),
    ),
    lastMissileLifecycleStamp: currentOrFallbackStamp(
      "lastMissileLifecycleStamp",
    ),
    lastMissileLifecycleRawDispatchStamp: currentOrFallbackStamp(
      "lastMissileLifecycleRawDispatchStamp",
    ),
    lastOwnerMissileLifecycleStamp: currentOrFallbackStamp(
      "lastOwnerMissileLifecycleStamp",
    ),
    lastOwnerMissileLifecycleAnchorStamp: currentOrFallbackStamp(
      "lastOwnerMissileLifecycleAnchorStamp",
    ),
    lastOwnerMissileLifecycleRawDispatchStamp: currentOrFallbackStamp(
      "lastOwnerMissileLifecycleRawDispatchStamp",
    ),
    lastOwnerMissileFreshAcquireStamp: currentOrFallbackStamp(
      "lastOwnerMissileFreshAcquireStamp",
    ),
    lastOwnerMissileFreshAcquireAnchorStamp: currentOrFallbackStamp(
      "lastOwnerMissileFreshAcquireAnchorStamp",
    ),
    lastOwnerMissileFreshAcquireRawDispatchStamp: currentOrFallbackStamp(
      "lastOwnerMissileFreshAcquireRawDispatchStamp",
    ),
    lastOwnerNonMissileCriticalStamp: currentOrFallbackStamp(
      "lastOwnerNonMissileCriticalStamp",
    ),
    lastOwnerNonMissileCriticalRawDispatchStamp: currentOrFallbackStamp(
      "lastOwnerNonMissileCriticalRawDispatchStamp",
    ),
    lastResetStamp: currentOrFallbackStamp("lastResetStamp"),
    heldQueueState: cloneHeldQueueState(currentState.heldQueueState),
    lastJourneyId: typeof currentState.lastJourneyId === "string"
      ? currentState.lastJourneyId
      : "",
  };

  // A tracked lane is one generation of semantic stamp plus its provenance.
  // Never fill a missing companion on an existing authority lane from the
  // legacy mirror: that manufactures a tuple which was never emitted.
  const preserveCurrentTrackedLaneTuple = ({
    stampKey,
    rawKey = "",
    anchorKey = "",
  }) => {
    if (!hasDestinyStamp(currentState[stampKey])) {
      return;
    }
    nextState[stampKey] = normalizeDestinyStamp(currentState[stampKey]);
    if (rawKey) {
      nextState[rawKey] = resolveOptionalDestinyStamp(currentState[rawKey]);
    }
    if (anchorKey) {
      nextState[anchorKey] = resolveOptionalDestinyStamp(
        currentState[anchorKey],
      );
    }
  };
  preserveCurrentTrackedLaneTuple({
    stampKey: "lastOwnerCommandStamp",
    rawKey: "lastOwnerCommandRawDispatchStamp",
    anchorKey: "lastOwnerCommandAnchorStamp",
  });
  preserveCurrentTrackedLaneTuple({
    stampKey: "lastOwnerMissileLifecycleStamp",
    rawKey: "lastOwnerMissileLifecycleRawDispatchStamp",
    anchorKey: "lastOwnerMissileLifecycleAnchorStamp",
  });
  preserveCurrentTrackedLaneTuple({
    stampKey: "lastOwnerMissileFreshAcquireStamp",
    rawKey: "lastOwnerMissileFreshAcquireRawDispatchStamp",
    anchorKey: "lastOwnerMissileFreshAcquireAnchorStamp",
  });
  preserveCurrentTrackedLaneTuple({
    stampKey: "lastOwnerNonMissileCriticalStamp",
    rawKey: "lastOwnerNonMissileCriticalRawDispatchStamp",
  });

  const mergeLegacyTrackedLane = ({
    stampKey,
    rawKey = "",
    anchorKey = "",
    legacyStamp,
    legacyRawDispatchStamp = null,
    legacyAnchorStamp = null,
    requireRawDispatch = false,
  }) => {
    if (!hasDestinyStamp(legacyStamp)) {
      return;
    }
    const normalizedLegacyStamp = normalizeDestinyStamp(legacyStamp);
    const hasLegacyRawDispatchStamp = hasDestinyStamp(
      legacyRawDispatchStamp,
    );
    const normalizedLegacyRawDispatchStamp = hasLegacyRawDispatchStamp
      ? normalizeDestinyStamp(legacyRawDispatchStamp)
      : null;
    if (requireRawDispatch && !hasLegacyRawDispatchStamp) {
      return;
    }
    const hasCurrentStamp = hasDestinyStamp(currentState[stampKey]);
    const currentStamp = resolveOptionalDestinyStamp(nextState[stampKey]);
    const hasCurrentRawDispatchStamp = rawKey && hasDestinyStamp(
      currentState[rawKey],
    );
    const currentRawDispatchStamp = hasCurrentRawDispatchStamp
      ? normalizeDestinyStamp(nextState[rawKey])
      : null;
    if (hasCurrentStamp) {
      const legacyMatchesSupersedingPresentedTuple =
        legacyLastSentSupersedesAuthority &&
        normalizedLegacyStamp === legacyLastSentStamp &&
        (
          !rawKey ||
          (
            hasLegacyRawDispatchStamp &&
            hasLegacyLastSentRawDispatchStamp &&
            normalizedLegacyRawDispatchStamp ===
              legacyLastSentRawDispatchStamp
          )
        );
      const legacyRawIsLater =
        rawKey &&
        hasLegacyRawDispatchStamp &&
        hasCurrentRawDispatchStamp &&
        (
          normalizedLegacyStamp === currentStamp ||
          isDestinyStampAfter(currentStamp, normalizedLegacyStamp)
        ) &&
        isDestinyStampAfter(
          currentRawDispatchStamp,
          normalizedLegacyRawDispatchStamp,
        );
      const sameRawLegacyLaneIsLater =
        rawKey &&
        hasLegacyRawDispatchStamp &&
        hasCurrentRawDispatchStamp &&
        normalizedLegacyRawDispatchStamp === currentRawDispatchStamp &&
        isDestinyStampAfter(currentStamp, normalizedLegacyStamp);
      const stampOnlyLegacyLaneIsLater =
        !rawKey &&
        isDestinyStampAfter(currentStamp, normalizedLegacyStamp);
      if (
        !legacyRawIsLater &&
        !sameRawLegacyLaneIsLater &&
        !stampOnlyLegacyLaneIsLater &&
        !legacyMatchesSupersedingPresentedTuple
      ) {
        return;
      }
    }
    const legacyMatchesCurrentSemanticStamp =
      hasDestinyStamp(currentStamp) &&
      normalizedLegacyStamp === currentStamp;
    nextState[stampKey] = normalizedLegacyStamp;
    if (rawKey) {
      nextState[rawKey] = normalizedLegacyRawDispatchStamp;
    }
    if (anchorKey) {
      nextState[anchorKey] = hasDestinyStamp(legacyAnchorStamp)
        ? normalizeDestinyStamp(legacyAnchorStamp)
        : legacyMatchesCurrentSemanticStamp
          ? resolveOptionalDestinyStamp(nextState[anchorKey])
          : null;
    }
    if (
      stampKey === "lastOwnerCommandStamp" &&
      (
        !legacyMatchesCurrentSemanticStamp ||
        serializeDestinyDirectionHeading(
          spaceState.lastPilotCommandDirection,
        )
      )
    ) {
      nextState.lastOwnerCommandHeadingHash =
        serializeDestinyDirectionHeading(
          spaceState.lastPilotCommandDirection,
        );
    }
  };

  mergeLegacyTrackedLane({
    stampKey: "lastOwnerCommandStamp",
    rawKey: "lastOwnerCommandRawDispatchStamp",
    anchorKey: "lastOwnerCommandAnchorStamp",
    legacyStamp: spaceState.lastPilotCommandMovementStamp,
    legacyRawDispatchStamp: spaceState.lastPilotCommandMovementRawDispatchStamp,
    legacyAnchorStamp: spaceState.lastPilotCommandMovementAnchorStamp,
    requireRawDispatch: true,
  });
  mergeLegacyTrackedLane({
    stampKey: "lastOwnerMissileLifecycleStamp",
    rawKey: "lastOwnerMissileLifecycleRawDispatchStamp",
    anchorKey: "lastOwnerMissileLifecycleAnchorStamp",
    legacyStamp: spaceState.lastOwnerMissileLifecycleStamp,
    legacyRawDispatchStamp: spaceState.lastOwnerMissileLifecycleRawDispatchStamp,
    legacyAnchorStamp: spaceState.lastOwnerMissileLifecycleAnchorStamp,
  });
  mergeLegacyTrackedLane({
    stampKey: "lastOwnerMissileFreshAcquireStamp",
    rawKey: "lastOwnerMissileFreshAcquireRawDispatchStamp",
    anchorKey: "lastOwnerMissileFreshAcquireAnchorStamp",
    legacyStamp: spaceState.lastOwnerMissileFreshAcquireStamp,
    legacyRawDispatchStamp: spaceState.lastOwnerMissileFreshAcquireRawDispatchStamp,
    legacyAnchorStamp: spaceState.lastOwnerMissileFreshAcquireAnchorStamp,
  });
  mergeLegacyTrackedLane({
    stampKey: "lastOwnerNonMissileCriticalStamp",
    rawKey: "lastOwnerNonMissileCriticalRawDispatchStamp",
    legacyStamp: spaceState.lastOwnerNonMissileCriticalStamp,
    legacyRawDispatchStamp: spaceState.lastOwnerNonMissileCriticalRawDispatchStamp,
  });
  mergeLegacyTrackedLane({
    stampKey: "lastMissileLifecycleStamp",
    rawKey: "lastMissileLifecycleRawDispatchStamp",
    legacyStamp: spaceState.lastMissileLifecycleStamp,
    legacyRawDispatchStamp:
      spaceState.lastMissileLifecycleRawDispatchStamp,
  });

  const canonicalizeTrackedLane = ({
    stampKey,
    rawKey = "",
    anchorKey = "",
    headingKey = "",
  }) => {
    if (hasDestinyStamp(nextState[stampKey])) {
      return;
    }
    nextState[stampKey] = null;
    if (rawKey) {
      nextState[rawKey] = null;
    }
    if (anchorKey) {
      nextState[anchorKey] = null;
    }
    if (headingKey) {
      nextState[headingKey] = "";
    }
  };
  canonicalizeTrackedLane({
    stampKey: "lastMissileLifecycleStamp",
    rawKey: "lastMissileLifecycleRawDispatchStamp",
  });
  canonicalizeTrackedLane({
    stampKey: "lastOwnerCommandStamp",
    rawKey: "lastOwnerCommandRawDispatchStamp",
    anchorKey: "lastOwnerCommandAnchorStamp",
    headingKey: "lastOwnerCommandHeadingHash",
  });
  canonicalizeTrackedLane({
    stampKey: "lastOwnerMissileLifecycleStamp",
    rawKey: "lastOwnerMissileLifecycleRawDispatchStamp",
    anchorKey: "lastOwnerMissileLifecycleAnchorStamp",
  });
  canonicalizeTrackedLane({
    stampKey: "lastOwnerMissileFreshAcquireStamp",
    rawKey: "lastOwnerMissileFreshAcquireRawDispatchStamp",
    anchorKey: "lastOwnerMissileFreshAcquireAnchorStamp",
  });
  canonicalizeTrackedLane({
    stampKey: "lastOwnerNonMissileCriticalStamp",
    rawKey: "lastOwnerNonMissileCriticalRawDispatchStamp",
  });

  if (legacyLastSentUntrustedLane) {
    spaceState.lastSentDestinyStamp = resolveOptionalDestinyStamp(
      nextState.lastPresentedStamp,
    );
    spaceState.lastSentDestinyRawDispatchStamp = resolveOptionalDestinyStamp(
      nextState.lastRawDispatchStamp,
    );
    spaceState.lastSentDestinyWasOwnerCritical =
      nextState.lastSentWasOwnerCritical === true;
    spaceState.lastSentDestinyOnlyStaleProjectedOwnerMissileLane =
      nextState.lastSentOnlyStaleProjectedOwnerMissileLane === true;
  }

  if (
    legacyLastSentSupersedesAuthority ||
    legacyLastSentMatchesAuthorityTuple
  ) {
    nextState.lastPresentedStamp = legacyLastSentStamp;
    nextState.lastRawDispatchStamp = legacyLastSentRawDispatchStamp;
    nextState.lastSentWasOwnerCritical = legacyLastSentSupersedesAuthority
      ? legacyLastSentWasOwnerCritical
      : hasExplicitLegacyLastSentWasOwnerCritical
        ? spaceState.lastSentDestinyWasOwnerCritical === true
        : currentState.lastSentWasOwnerCritical === true;
    nextState.lastSentOnlyStaleProjectedOwnerMissileLane =
      legacyLastSentSupersedesAuthority ||
      hasExplicitLegacyLastSentOnlyStaleProjectedOwnerMissileLane
        ? spaceState.lastSentDestinyOnlyStaleProjectedOwnerMissileLane === true
        : currentState.lastSentOnlyStaleProjectedOwnerMissileLane === true;
    if (nextState.lastSentWasOwnerCritical) {
      nextState.lastCriticalStamp = selectLaterDestinyStamp(
        nextState.lastCriticalStamp,
        legacyLastSentStamp,
      );
    } else {
      nextState.lastNonCriticalStamp = selectLaterDestinyStamp(
        nextState.lastNonCriticalStamp,
        legacyLastSentStamp,
      );
    }
  }

  spaceState.destinyAuthorityState = nextState;
  return nextState;
}

function snapshotDestinyAuthorityState(session) {
  const state = ensureDestinyAuthorityState(session);
  if (!state) {
    return null;
  }
  return {
    ...state,
    heldQueueState: cloneHeldQueueState(state.heldQueueState),
  };
}

function updateDestinyAuthorityState(session, patch = {}) {
  const state = ensureDestinyAuthorityState(session);
  if (!state || !patch || typeof patch !== "object") {
    return state;
  }

  const optionalStampKeys = [
    "lastCriticalStamp",
    "lastNonCriticalStamp",
    "lastFreshAcquireLifecycleStamp",
    "lastBootstrapStamp",
    "lastResetStamp",
  ];
  for (const key of optionalStampKeys) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) {
      state[key] = resolveOptionalDestinyStamp(patch[key]);
    }
  }
  const groupedLaneDescriptors = [
    {
      stampKey: "lastPresentedStamp",
      rawKey: "lastRawDispatchStamp",
      booleanKeys: [
        "lastSentWasOwnerCritical",
        "lastSentOnlyStaleProjectedOwnerMissileLane",
      ],
    },
    {
      stampKey: "lastMissileLifecycleStamp",
      rawKey: "lastMissileLifecycleRawDispatchStamp",
    },
    {
      stampKey: "lastOwnerCommandStamp",
      rawKey: "lastOwnerCommandRawDispatchStamp",
      anchorKey: "lastOwnerCommandAnchorStamp",
      stringKey: "lastOwnerCommandHeadingHash",
    },
    {
      stampKey: "lastOwnerMissileLifecycleStamp",
      rawKey: "lastOwnerMissileLifecycleRawDispatchStamp",
      anchorKey: "lastOwnerMissileLifecycleAnchorStamp",
    },
    {
      stampKey: "lastOwnerMissileFreshAcquireStamp",
      rawKey: "lastOwnerMissileFreshAcquireRawDispatchStamp",
      anchorKey: "lastOwnerMissileFreshAcquireAnchorStamp",
    },
    {
      stampKey: "lastOwnerNonMissileCriticalStamp",
      rawKey: "lastOwnerNonMissileCriticalRawDispatchStamp",
    },
  ];
  const hasOwn = (key) => Object.prototype.hasOwnProperty.call(patch, key);
  for (const descriptor of groupedLaneDescriptors) {
    const {
      stampKey,
      rawKey = "",
      anchorKey = "",
      stringKey = "",
      booleanKeys = [],
    } = descriptor;
    const groupedKeys = [
      stampKey,
      rawKey,
      anchorKey,
      stringKey,
      ...booleanKeys,
    ].filter(Boolean);
    if (!groupedKeys.some(hasOwn) || !hasOwn(stampKey)) {
      continue;
    }

    const currentStamp = resolveOptionalDestinyStamp(state[stampKey]);
    const candidateStamp = resolveOptionalDestinyStamp(patch[stampKey]);
    if (!hasDestinyStamp(candidateStamp)) {
      state[stampKey] = null;
      if (rawKey) state[rawKey] = null;
      if (anchorKey) state[anchorKey] = null;
      if (stringKey) state[stringKey] = "";
      for (const booleanKey of booleanKeys) state[booleanKey] = false;
      continue;
    }
    if (candidateStamp !== currentStamp) {
      if (
        hasDestinyStamp(currentStamp) &&
        !isDestinyStampAfter(currentStamp, candidateStamp)
      ) {
        continue;
      }
      state[stampKey] = candidateStamp;
      if (rawKey) {
        state[rawKey] = hasOwn(rawKey)
          ? resolveOptionalDestinyStamp(patch[rawKey])
          : null;
      }
      if (anchorKey) {
        state[anchorKey] = hasOwn(anchorKey)
          ? resolveOptionalDestinyStamp(patch[anchorKey])
          : null;
      }
      if (stringKey) {
        state[stringKey] = hasOwn(stringKey) &&
          typeof patch[stringKey] === "string"
            ? patch[stringKey]
            : "";
      }
      for (const booleanKey of booleanKeys) {
        state[booleanKey] = hasOwn(booleanKey) && patch[booleanKey] === true;
      }
      continue;
    }

    if (!hasDestinyStamp(currentStamp)) {
      continue;
    }
    const stageCompanion = (key) => {
      const current = key
        ? resolveOptionalDestinyStamp(state[key])
        : null;
      if (!key || !hasOwn(key) || !hasDestinyStamp(patch[key])) {
        return { accepted: true, value: current };
      }
      const candidate = normalizeDestinyStamp(patch[key]);
      return {
        accepted:
          !hasDestinyStamp(current) ||
          candidate === current ||
          isDestinyStampAfter(current, candidate),
        value: candidate,
      };
    };
    const stagedRaw = stageCompanion(rawKey);
    const stagedAnchor = stageCompanion(anchorKey);
    const companionsAccepted = stagedRaw.accepted && stagedAnchor.accepted;
    if (!companionsAccepted) {
      continue;
    }
    if (rawKey && hasOwn(rawKey) && hasDestinyStamp(patch[rawKey])) {
      state[rawKey] = stagedRaw.value;
    }
    if (anchorKey && hasOwn(anchorKey) && hasDestinyStamp(patch[anchorKey])) {
      state[anchorKey] = stagedAnchor.value;
    }
    if (
      companionsAccepted &&
      stringKey &&
      hasOwn(stringKey) &&
      typeof patch[stringKey] === "string"
    ) {
      state[stringKey] = patch[stringKey];
    }
    for (const booleanKey of booleanKeys) {
      if (companionsAccepted && hasOwn(booleanKey)) {
        state[booleanKey] = patch[booleanKey] === true;
      }
    }
  }
  if (Object.prototype.hasOwnProperty.call(patch, "heldQueueState")) {
    state.heldQueueState = cloneHeldQueueState(patch.heldQueueState);
  }
  if (Object.prototype.hasOwnProperty.call(patch, "lastJourneyId")) {
    state.lastJourneyId =
      typeof patch.lastJourneyId === "string"
        ? patch.lastJourneyId
        : state.lastJourneyId;
  }

  return state;
}

module.exports = {
  ensureDestinyAuthorityState,
  resolveDestinyAuthorityCommandTuple,
  resolveDestinyAuthorityLaneTuple,
  snapshotDestinyAuthorityState,
  updateDestinyAuthorityState,
};
