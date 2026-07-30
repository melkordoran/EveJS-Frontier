const {
  DESTINY_STAMP_INTERVAL_MS,
  DESTINY_STAMP_MAX_LEAD,
} = require("../constants");
const {
  MICHELLE_DIRECT_CRITICAL_ECHO_DESTINY_LEAD,
  MICHELLE_HELD_FUTURE_DESTINY_LEAD,
  MICHELLE_POST_HELD_FUTURE_DESTINY_LEAD,
} = require("./michelleContract.js");
const {
  DESTINY_STAMP_MAX_FORWARD_LEAD,
  DESTINY_STAMP_MAX_ORDERING_DISTANCE,
  advanceDestinyStamp,
  clampDestinyStampToCeiling,
  getDestinyStampForwardDistance,
  hasDestinyStamp,
  isDestinyStampAfter,
  isDestinyStampWithinForwardWindow,
  normalizeDestinyStamp,
  resolveOptionalDestinyStamp,
  selectFurthestPresentDestinyStamp,
} = require("./stamps");

// This module owns the server-side delivery policy built on top of Michelle's
// smaller client timing contract. The Michelle primitives themselves live in
// `michelleContract.js`; the constants below are derived send/restamp
// rules that attempt to land our packets inside that contract safely.

// Adjacent owner steering echoes are often the same intended heading with tiny
// float jitter from repeated client `CmdGotoDirection` input. Keeping this too
// close to `1.0` lets effectively identical steers through, which then shows up
// as current-1 rewinds just before stop / combat transitions.
const OWNER_PENDING_GOTO_DUPLICATE_ALIGNMENT = 0.9998;

// Warp prepare is different from Michelle's ordinary held-future window: we
// intentionally schedule an authoritative future activation tick so the pilot
// keeps aligning locally until warp actually starts. The `warp.pre_start.ego`
// traces show `prepareStamp` landing about 4 seconds after `requestedAtMs`,
// which makes this a staged activation contract, not an extra Michelle lane.
function toInt(value, fallback = 0) {
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    return Math.trunc(numeric);
  }
  const fallbackNumeric = Number(fallback);
  return Number.isFinite(fallbackNumeric) ? Math.trunc(fallbackNumeric) : 0;
}

function toDestinyStamp(value, fallback = 0) {
  return normalizeDestinyStamp(value, fallback);
}

function formatDiagnosticDestinyStamp(value) {
  return hasDestinyStamp(value) ? toDestinyStamp(value) : 0;
}

function hasRequiredDestinyStamps(...values) {
  return values.every((value) => hasDestinyStamp(value));
}

function isDestinyStampWithinRelativeWindow(
  anchorStamp,
  candidateStamp,
  minimumLead,
  maximumLead,
) {
  if (!hasDestinyStamp(anchorStamp) || !hasDestinyStamp(candidateStamp)) {
    return false;
  }
  const normalizedMinimumLead = Math.trunc(Number(minimumLead) || 0);
  const normalizedMaximumLead = Math.trunc(Number(maximumLead) || 0);
  if (normalizedMaximumLead < normalizedMinimumLead) {
    return false;
  }
  const windowStart = advanceDestinyStamp(anchorStamp, normalizedMinimumLead);
  return isDestinyStampWithinForwardWindow(
    windowStart,
    candidateStamp,
    normalizedMaximumLead - normalizedMinimumLead,
  );
}

function getRecentDestinyStampDelta(
  previousStamp,
  currentStamp,
  maximumDelta,
) {
  if (!hasDestinyStamp(previousStamp) || !hasDestinyStamp(currentStamp)) {
    return null;
  }
  const delta = getDestinyStampForwardDistance(previousStamp, currentStamp);
  return delta <= Math.max(0, toInt(maximumDelta, 0)) ? delta : null;
}

function resolveDelayedDestinyStampState(options = {}) {
  const currentStamp = hasDestinyStamp(options.currentStamp)
    ? toDestinyStamp(options.currentStamp)
    : null;
  let pendingStamp = resolveOptionalDestinyStamp(options.pendingStamp);
  let scheduledNow = false;

  if (
    pendingStamp === null &&
    currentStamp !== null &&
    options.scheduleWhenAbsent === true
  ) {
    const delay = Math.min(
      DESTINY_STAMP_MAX_FORWARD_LEAD,
      Math.max(0, toInt(options.delay, 1)),
    );
    pendingStamp = advanceDestinyStamp(currentStamp, delay);
    scheduledNow = true;
  }

  return {
    pendingStamp,
    scheduledNow,
    ready:
      scheduledNow === false &&
      currentStamp !== null &&
      pendingStamp !== null &&
      (
        currentStamp === pendingStamp ||
        isDestinyStampAfter(pendingStamp, currentStamp)
      ),
  };
}

function toFiniteNumber(value, fallback = 0) {
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    return numeric;
  }
  const fallbackNumeric = Number(fallback);
  return Number.isFinite(fallbackNumeric) ? fallbackNumeric : 0;
}

function projectPreviouslySentDestinyLane(
  sentLaneStamp,
  sentRawDispatchStamp,
  currentRawDispatchStamp,
) {
  if (
    !hasDestinyStamp(sentLaneStamp) ||
    !hasDestinyStamp(sentRawDispatchStamp) ||
    !hasDestinyStamp(currentRawDispatchStamp)
  ) {
    return null;
  }
  const normalizedSentLaneStamp = toDestinyStamp(sentLaneStamp);
  const normalizedSentRawDispatchStamp = toDestinyStamp(sentRawDispatchStamp);
  const normalizedCurrentRawDispatchStamp = toDestinyStamp(currentRawDispatchStamp);
  const rawDispatchDelta = getDestinyStampForwardDistance(
    normalizedSentRawDispatchStamp,
    normalizedCurrentRawDispatchStamp,
  );
  if (
    rawDispatchDelta <= 0 ||
    rawDispatchDelta > DESTINY_STAMP_MAX_ORDERING_DISTANCE
  ) {
    return null;
  }
  return advanceDestinyStamp(normalizedSentLaneStamp, rawDispatchDelta);
}

function resolvePreviousLastSentDestinyWasOwnerCritical(options = {}) {
  if (!hasDestinyStamp(options.previousLastSentDestinyStamp)) {
    return false;
  }
  const previousLastSentDestinyStamp = toDestinyStamp(
    options.previousLastSentDestinyStamp,
  );

  const inferredTrackedOwnerCriticalLane = (
    (
      hasDestinyStamp(options.lastOwnerMissileFreshAcquireStamp) &&
      previousLastSentDestinyStamp ===
        toDestinyStamp(options.lastOwnerMissileFreshAcquireStamp)
    ) ||
    (
      hasDestinyStamp(options.lastOwnerNonMissileCriticalStamp) &&
      previousLastSentDestinyStamp ===
        toDestinyStamp(options.lastOwnerNonMissileCriticalStamp)
    ) ||
    (
      hasDestinyStamp(options.lastOwnerPilotCommandMovementStamp) &&
      previousLastSentDestinyStamp ===
        toDestinyStamp(options.lastOwnerPilotCommandMovementStamp)
    )
  );
  const inferredOwnerDamageLifecycleLane =
    hasDestinyStamp(options.lastOwnerMissileLifecycleStamp) &&
    previousLastSentDestinyStamp ===
      toDestinyStamp(options.lastOwnerMissileLifecycleStamp) &&
    (
      !hasDestinyStamp(options.lastOwnerMissileFreshAcquireStamp) ||
      previousLastSentDestinyStamp !==
        toDestinyStamp(options.lastOwnerMissileFreshAcquireStamp)
    );

  if (options.explicitWasOwnerCritical === true) {
    return true;
  }
  if (options.explicitWasOwnerCritical === false) {
    return inferredTrackedOwnerCriticalLane;
  }

  return inferredTrackedOwnerCriticalLane || inferredOwnerDamageLifecycleLane;
}

function resolveProjectedRecentLastSentLane(options = {}) {
  if (
    !hasDestinyStamp(options.previousLastSentDestinyStamp) ||
    !hasDestinyStamp(options.previousLastSentDestinyRawDispatchStamp) ||
    !hasDestinyStamp(options.currentRawDispatchStamp)
  ) {
    return null;
  }
  const previousLastSentDestinyStamp = toDestinyStamp(
    options.previousLastSentDestinyStamp,
  );
  const previousLastSentDestinyRawDispatchStamp = toDestinyStamp(
    options.previousLastSentDestinyRawDispatchStamp,
  );
  const currentRawDispatchStamp = toDestinyStamp(options.currentRawDispatchStamp);
  const maximumDispatchDelta = Math.max(
    0,
    toInt(options.maximumDispatchDelta, 2),
  );

  const rawDispatchDelta = getRecentDestinyStampDelta(
    previousLastSentDestinyRawDispatchStamp,
    currentRawDispatchStamp,
    maximumDispatchDelta,
  );
  if (rawDispatchDelta === null || rawDispatchDelta <= 0) {
    return null;
  }

  return projectPreviouslySentDestinyLane(
    previousLastSentDestinyStamp,
    previousLastSentDestinyRawDispatchStamp,
    currentRawDispatchStamp,
  );
}

function getRecentTrustedLane(options = {}) {
  if (
    !hasDestinyStamp(options.laneStamp) ||
    !hasDestinyStamp(options.currentStamp)
  ) {
    return null;
  }
  const laneStamp = toDestinyStamp(options.laneStamp);
  const currentStamp = toDestinyStamp(options.currentStamp);
  const maximumLead = Math.max(
    0,
    toInt(options.maximumLead, MICHELLE_HELD_FUTURE_DESTINY_LEAD),
  );
  if (!isDestinyStampWithinRelativeWindow(currentStamp, laneStamp, 1, maximumLead)) {
    return null;
  }

  const laneRawDispatchStamp = options.laneRawDispatchStamp;
  const currentRawDispatchStamp = options.currentRawDispatchStamp;
  const maximumRawDispatchDelta = Math.max(
    0,
    toInt(options.maximumRawDispatchDelta, 2),
  );
  if (
    hasDestinyStamp(laneRawDispatchStamp) &&
    hasDestinyStamp(currentRawDispatchStamp)
  ) {
    const rawDispatchDelta = getRecentDestinyStampDelta(
      laneRawDispatchStamp,
      currentRawDispatchStamp,
      maximumRawDispatchDelta,
    );
    if (rawDispatchDelta === null) {
      return null;
    }
  }

  return laneStamp;
}

function getRecentProjectedLane(options = {}) {
  if (
    !hasDestinyStamp(options.laneStamp) ||
    !hasDestinyStamp(options.laneRawDispatchStamp) ||
    !hasDestinyStamp(options.currentRawDispatchStamp)
  ) {
    return null;
  }
  const laneStamp = toDestinyStamp(options.laneStamp);
  const laneRawDispatchStamp = toDestinyStamp(options.laneRawDispatchStamp);
  const currentRawDispatchStamp = toDestinyStamp(options.currentRawDispatchStamp);
  const rawDispatchDelta = getDestinyStampForwardDistance(
    laneRawDispatchStamp,
    currentRawDispatchStamp,
  );
  if (
    rawDispatchDelta <= 0 ||
    rawDispatchDelta > Math.max(0, toInt(options.maximumRawDispatchDelta, 2))
  ) {
    return null;
  }

  return getRecentTrustedLane({
    laneStamp: projectPreviouslySentDestinyLane(
      laneStamp,
      laneRawDispatchStamp,
      currentRawDispatchStamp,
    ),
    currentStamp: options.currentStamp,
    currentRawDispatchStamp,
    maximumLead: options.maximumLead,
    maximumRawDispatchDelta: options.maximumRawDispatchDelta,
  });
}

function attachRecentOwnerLanePresence(
  state,
  rawDispatchStampPresent,
  anchorStampPresent,
) {
  Object.defineProperties(state, {
    rawDispatchStampPresent: {
      enumerable: false,
      value: rawDispatchStampPresent,
    },
    anchorStampPresent: {
      enumerable: false,
      value: anchorStampPresent,
    },
  });
  return state;
}

function resolveRecentOwnerLaneState(options = {}) {
  const laneStamp = hasDestinyStamp(options.laneStamp)
    ? toDestinyStamp(options.laneStamp)
    : null;
  const laneAnchorStamp = hasDestinyStamp(options.laneAnchorStamp)
    ? toDestinyStamp(options.laneAnchorStamp)
    : null;
  const laneRawDispatchStamp = hasDestinyStamp(options.laneRawDispatchStamp)
    ? toDestinyStamp(options.laneRawDispatchStamp)
    : null;
  const requiredClocksPresent = hasRequiredDestinyStamps(
    options.currentSessionStamp,
    options.currentImmediateSessionStamp,
    options.currentRawDispatchStamp,
  );
  const maximumRawDispatchDelta = Math.max(
    0,
    toInt(options.maximumRawDispatchDelta, 2),
  );
  const maximumProjectedLead = Math.max(
    0,
    toInt(
      options.maximumProjectedLead,
      MICHELLE_HELD_FUTURE_DESTINY_LEAD +
        MICHELLE_POST_HELD_FUTURE_DESTINY_LEAD,
    ),
  );
  const allowFarAheadReuseAfterRawAdvance =
    options.allowFarAheadReuseAfterRawAdvance !== false;
  if (laneStamp === null || !requiredClocksPresent) {
    return attachRecentOwnerLanePresence({
      laneStamp: null,
      recentLane: null,
      projectedConsumedLane: null,
      rawDispatchDelta: 0,
      anchorDelta: 0,
      progressDelta: 0,
    }, false, false);
  }
  const currentSessionStamp = toDestinyStamp(options.currentSessionStamp);
  const currentImmediateSessionStamp = toDestinyStamp(
    options.currentImmediateSessionStamp,
  );
  const currentRawDispatchStamp = toDestinyStamp(options.currentRawDispatchStamp);

  const rawDispatchDistance = laneRawDispatchStamp !== null
    ? getDestinyStampForwardDistance(
        laneRawDispatchStamp,
        currentRawDispatchStamp,
      )
    : null;
  const rawDispatchDelta =
    rawDispatchDistance !== null &&
    rawDispatchDistance <= DESTINY_STAMP_MAX_ORDERING_DISTANCE
      ? rawDispatchDistance
      : 0;
  const hasRecentRawWindow =
    laneRawDispatchStamp !== null &&
    rawDispatchDistance <= DESTINY_STAMP_MAX_ORDERING_DISTANCE &&
    rawDispatchDelta <= maximumRawDispatchDelta;
  const anchorDistance = laneAnchorStamp !== null
    ? getDestinyStampForwardDistance(laneAnchorStamp, currentSessionStamp)
    : null;
  const anchorDelta =
    anchorDistance !== null &&
    anchorDistance <= DESTINY_STAMP_MAX_ORDERING_DISTANCE
      ? anchorDistance
      : 0;
  const progressDelta = Math.max(rawDispatchDelta, anchorDelta);
  const allowRecentLaneReuse =
    isDestinyStampAfter(currentImmediateSessionStamp, laneStamp) &&
    (
      allowFarAheadReuseAfterRawAdvance === true ||
      rawDispatchDelta <= 0 ||
      isDestinyStampWithinForwardWindow(
        currentImmediateSessionStamp,
        laneStamp,
        maximumProjectedLead,
      )
    );
  const recentLane =
    allowRecentLaneReuse &&
    (
      hasRecentRawWindow ||
      (
        laneRawDispatchStamp === null &&
        laneAnchorStamp !== null &&
        anchorDistance <= DESTINY_STAMP_MAX_ORDERING_DISTANCE &&
        anchorDelta <= maximumProjectedLead
      )
    )
      ? laneStamp
      : null;
  const projectedLane =
    progressDelta > 0
      ? advanceDestinyStamp(laneStamp, progressDelta)
      : null;
  // Only raw-dispatch-recent lanes may keep projecting consumed history once a
  // concrete raw stamp exists. `npc4.txt` exposed the failure mode: an old
  // owner steer from raw 3812 was still being projected from its anchor stamp
  // at raw 3836, which let ancient movement masquerade as fresh owner-critical
  // history and shoved owner missile add/remove groups out to +4/+5.
  const canProjectConsumedLane =
    projectedLane !== null &&
    (
      laneRawDispatchStamp === null ||
      hasRecentRawWindow
    );
  const projectedConsumedLane =
    canProjectConsumedLane &&
    isDestinyStampWithinForwardWindow(
      currentImmediateSessionStamp,
      projectedLane,
      maximumProjectedLead,
    )
      ? projectedLane
      : null;

  return attachRecentOwnerLanePresence({
    laneStamp,
    recentLane,
    projectedConsumedLane,
    rawDispatchDelta,
    anchorDelta,
    progressDelta,
  }, laneRawDispatchStamp !== null, laneAnchorStamp !== null);
}

const DECISION_CANDIDATE_PRESENT = Symbol("decisionCandidatePresent");

function buildDecisionCandidate(label, value, extra = {}) {
  const present = hasDestinyStamp(value);
  const candidate = {
    label,
    value: present ? toDestinyStamp(value) : 0,
    ...extra,
  };
  Object.defineProperty(candidate, DECISION_CANDIDATE_PRESENT, {
    enumerable: false,
    value: present,
  });
  return candidate;
}

function summarizeDecisionCandidates(candidates = [], selectedValue = null) {
  const selectedValueIsPresent = hasDestinyStamp(selectedValue);
  const normalizedSelectedValue = selectedValueIsPresent
    ? toDestinyStamp(selectedValue)
    : 0;
  const normalizedCandidates = Array.isArray(candidates)
    ? candidates.map((candidate) => {
        const present = candidate &&
          candidate[DECISION_CANDIDATE_PRESENT] === true;
        const normalizedCandidate = {
          ...candidate,
          value: present ? toDestinyStamp(candidate.value) : 0,
        };
        Object.defineProperty(
          normalizedCandidate,
          DECISION_CANDIDATE_PRESENT,
          { enumerable: false, value: present },
        );
        return normalizedCandidate;
      })
    : [];
  return {
    all: normalizedCandidates,
    active: normalizedCandidates.filter((candidate) => (
      candidate[DECISION_CANDIDATE_PRESENT] === true
    )),
    winners:
      selectedValueIsPresent
        ? normalizedCandidates.filter(
            (candidate) => (
              candidate[DECISION_CANDIDATE_PRESENT] === true &&
              candidate.value === normalizedSelectedValue
            ),
          )
        : [],
  };
}

function formatRecentOwnerLaneStateSummary(label, state) {
  const resolvedState =
    state && typeof state === "object"
      ? state
      : {};
  return `${label}: lane=${formatDiagnosticDestinyStamp(resolvedState.laneStamp)} recent=${formatDiagnosticDestinyStamp(
    resolvedState.recentLane,
  )} projected=${formatDiagnosticDestinyStamp(resolvedState.projectedConsumedLane)} rawDelta=${toInt(
    resolvedState.rawDispatchDelta,
    0,
  )} anchorDelta=${toInt(resolvedState.anchorDelta, 0)} progress=${toInt(
    resolvedState.progressDelta,
    0,
  )}`;
}

function formatDecisionCandidateSummary(summary) {
  const active = summary && Array.isArray(summary.active) ? summary.active : [];
  const winners = summary && Array.isArray(summary.winners) ? summary.winners : [];
  const winnerLabels = new Set(winners.map((entry) => entry.label));
  return active.map((entry) =>
    `${winnerLabels.has(entry.label) ? "*" : ""}${entry.label}=${formatDiagnosticDestinyStamp(entry.value)}`);
}

function resolveOwnerMonotonicState(options = {}) {
  const hasOwnerShip = options.hasOwnerShip === true;
  const containsMovementContractPayload =
    options.containsMovementContractPayload === true;
  const isSetStateGroup = options.isSetStateGroup === true;
  const isOwnerPilotMovementGroup =
    options.isOwnerPilotMovementGroup === true;
  const isMissileLifecycleGroup =
    options.isMissileLifecycleGroup === true;
  const isOwnerMissileLifecycleGroup =
    options.isOwnerMissileLifecycleGroup === true;
  const isOwnerCriticalGroup = options.isOwnerCriticalGroup === true;
  const isFreshAcquireLifecycleGroup =
    options.isFreshAcquireLifecycleGroup === true;
  const isOwnerDamageStateGroup =
    options.isOwnerDamageStateGroup === true;
  const allowAdjacentRawFreshAcquireLaneReuse =
    options.allowAdjacentRawFreshAcquireLaneReuse === true;
  const currentSessionStamp = toDestinyStamp(options.currentSessionStamp);
  const currentImmediateSessionStamp = toDestinyStamp(
    options.currentImmediateSessionStamp,
  );
  const currentLocalStamp = toDestinyStamp(options.currentLocalStamp);
  const readOptionalStamp = (key) => resolveOptionalDestinyStamp(options[key]);
  const currentPresentedOwnerCriticalStamp = readOptionalStamp(
    "currentPresentedOwnerCriticalStamp",
  );
  const currentRawDispatchStamp = toDestinyStamp(options.currentRawDispatchStamp);
  const recentEmittedOwnerCriticalMaxLead = Math.max(
    0,
    toInt(options.recentEmittedOwnerCriticalMaxLead, 0),
  );
  const ownerCriticalCeilingLead = Math.max(
    0,
    toInt(
      options.ownerCriticalCeilingLead,
      MICHELLE_HELD_FUTURE_DESTINY_LEAD,
    ),
  );
  const previousLastSentDestinyStamp = readOptionalStamp(
    "previousLastSentDestinyStamp",
  );
  const previousLastSentDestinyRawDispatchStamp = readOptionalStamp(
    "previousLastSentDestinyRawDispatchStamp",
  );
  const previousLastSentDestinyExplicitWasOwnerCritical =
    options.previousLastSentDestinyExplicitWasOwnerCritical === true;
  const previousLastSentDestinyWasOwnerCritical =
    options.previousLastSentDestinyWasOwnerCritical === true;
  const previousLastSentDestinyOnlyStaleProjectedOwnerMissileLane =
    options.previousLastSentDestinyOnlyStaleProjectedOwnerMissileLane === true;
  const lastOwnerPilotCommandMovementStamp = readOptionalStamp(
    "lastOwnerPilotCommandMovementStamp",
  );
  const lastOwnerPilotCommandMovementAnchorStamp = readOptionalStamp(
    "lastOwnerPilotCommandMovementAnchorStamp",
  );
  const lastOwnerPilotCommandMovementRawDispatchStamp = readOptionalStamp(
    "lastOwnerPilotCommandMovementRawDispatchStamp",
  );
  const lastOwnerNonMissileCriticalStamp = readOptionalStamp(
    "lastOwnerNonMissileCriticalStamp",
  );
  const lastOwnerMissileLifecycleStamp = readOptionalStamp(
    "lastOwnerMissileLifecycleStamp",
  );
  const lastOwnerMissileLifecycleAnchorStamp = readOptionalStamp(
    "lastOwnerMissileLifecycleAnchorStamp",
  );
  const lastOwnerMissileLifecycleRawDispatchStamp = readOptionalStamp(
    "lastOwnerMissileLifecycleRawDispatchStamp",
  );
  const lastOwnerMissileFreshAcquireStamp = readOptionalStamp(
    "lastOwnerMissileFreshAcquireStamp",
  );
  const lastOwnerMissileFreshAcquireAnchorStamp = readOptionalStamp(
    "lastOwnerMissileFreshAcquireAnchorStamp",
  );
  const lastOwnerMissileFreshAcquireRawDispatchStamp = readOptionalStamp(
    "lastOwnerMissileFreshAcquireRawDispatchStamp",
  );

  const maximumTrustedRecentEmittedOwnerCriticalStamp =
    hasOwnerShip
      ? advanceDestinyStamp(
          currentSessionStamp,
          recentEmittedOwnerCriticalMaxLead,
        )
      : null;
  const maximumProjectedOwnerCriticalLead = Math.max(
    MICHELLE_HELD_FUTURE_DESTINY_LEAD +
      MICHELLE_POST_HELD_FUTURE_DESTINY_LEAD,
    recentEmittedOwnerCriticalMaxLead +
      MICHELLE_DIRECT_CRITICAL_ECHO_DESTINY_LEAD,
  );
  const projectedRecentLastSentLane = resolveProjectedRecentLastSentLane({
    previousLastSentDestinyStamp,
    previousLastSentDestinyRawDispatchStamp,
    currentRawDispatchStamp,
    maximumDispatchDelta: 2,
  });
  const previousLastSentRawDispatchDelta = getRecentDestinyStampDelta(
    previousLastSentDestinyRawDispatchStamp,
    currentRawDispatchStamp,
    2,
  );
  const previousLastSentLaneIsRelevant =
    isDestinyStampWithinRelativeWindow(
      currentImmediateSessionStamp,
      previousLastSentDestinyStamp,
      -1,
      DESTINY_STAMP_MAX_FORWARD_LEAD,
    ) && (
      previousLastSentRawDispatchDelta !== null ||
      previousLastSentDestinyRawDispatchStamp === null
    );
  const hasProjectedRecentLastSentLane =
    previousLastSentRawDispatchDelta !== null &&
    previousLastSentRawDispatchDelta > 0 &&
    isDestinyStampWithinRelativeWindow(
      currentImmediateSessionStamp,
      projectedRecentLastSentLane,
      0,
      DESTINY_STAMP_MAX_FORWARD_LEAD,
    );
  const previousLastSentDestinyAnchorStamp =
    previousLastSentLaneIsRelevant &&
    previousLastSentDestinyStamp === lastOwnerPilotCommandMovementStamp
      ? lastOwnerPilotCommandMovementAnchorStamp
      : previousLastSentLaneIsRelevant &&
        previousLastSentDestinyStamp === lastOwnerMissileLifecycleStamp
        ? lastOwnerMissileLifecycleAnchorStamp
        : previousLastSentLaneIsRelevant &&
          previousLastSentDestinyStamp === lastOwnerMissileFreshAcquireStamp
          ? lastOwnerMissileFreshAcquireAnchorStamp
          : null;
  const previousLastSentDestinyMatchesOwnerMissileLane =
    previousLastSentLaneIsRelevant &&
    (
      previousLastSentDestinyStamp === lastOwnerMissileLifecycleStamp ||
      previousLastSentDestinyStamp === lastOwnerMissileFreshAcquireStamp
    );
  const previousLastSentDestinyWasOwnerDamageLifecycleLane =
    previousLastSentDestinyExplicitWasOwnerCritical !== true &&
    previousLastSentDestinyWasOwnerCritical !== true &&
    previousLastSentLaneIsRelevant &&
    previousLastSentDestinyStamp === lastOwnerMissileLifecycleStamp &&
    previousLastSentDestinyStamp !== lastOwnerMissileFreshAcquireStamp;
  const recentOverallLastSentState = resolveRecentOwnerLaneState({
    laneStamp: previousLastSentDestinyStamp,
    laneAnchorStamp: previousLastSentDestinyAnchorStamp,
    laneRawDispatchStamp: previousLastSentDestinyRawDispatchStamp,
    currentSessionStamp,
    currentImmediateSessionStamp,
    currentRawDispatchStamp,
    maximumProjectedLead: maximumProjectedOwnerCriticalLead,
    allowFarAheadReuseAfterRawAdvance: !(
      previousLastSentDestinyOnlyStaleProjectedOwnerMissileLane === true &&
      previousLastSentDestinyMatchesOwnerMissileLane
    ),
  });
  const recentPresentedLastSentLane =
    hasOwnerShip &&
    previousLastSentLaneIsRelevant &&
    previousLastSentDestinyStamp === currentPresentedOwnerCriticalStamp &&
    previousLastSentRawDispatchDelta !== null &&
    (
      isDestinyStampWithinForwardWindow(
        currentSessionStamp,
        previousLastSentDestinyStamp,
        recentEmittedOwnerCriticalMaxLead,
      ) ||
      previousLastSentDestinyRawDispatchStamp === currentRawDispatchStamp
    )
      ? previousLastSentDestinyStamp
      : null;
  const recentNonCriticalLastSentLane =
    containsMovementContractPayload &&
    !isSetStateGroup &&
    previousLastSentDestinyWasOwnerCritical !== true
      ? getRecentTrustedLane({
          laneStamp: previousLastSentDestinyStamp,
          currentStamp: currentSessionStamp,
          currentRawDispatchStamp,
          laneRawDispatchStamp: previousLastSentDestinyRawDispatchStamp,
          maximumLead: recentEmittedOwnerCriticalMaxLead,
          maximumRawDispatchDelta: 2,
        })
      : null;
  // Once Michelle is still legitimately presenting a previously sent future
  // lane, any newer group for the same session must stay on or above that lane
  // instead of rewinding under it. This applies even to non-movement groups
  // such as damage-state, add/remove, or slim/bootstrap bundles.
  //
  // CRITICAL: Cap the floor to currentSessionStamp + ownerCriticalCeilingLead.
  // Without this cap, isOwnerDamageStateGroup events (OnDamageStateChange)
  // compound +1 per event with no ceiling, advancing stamps far ahead of wall
  // clock (e.g., +9 ticks). The client processes entries 3+ ticks ahead
  // IMMEDIATELY, jumping _current_time forward and re-extrapolating all ball
  // positions — causing massive jolting. Subsequent near-current-time missile
  // updates then arrive BELOW the jumped _current_time, applying stale state.
  const presentedLastSentCeilingCap =
    hasOwnerShip
      // A lane the session is already presenting is safe to reuse as a hard
      // ceiling. Clamping below it creates owner-only backsteps.
      ? selectFurthestPresentDestinyStamp(
          currentSessionStamp,
          [
            advanceDestinyStamp(
              currentSessionStamp,
              ownerCriticalCeilingLead,
            ),
            currentPresentedOwnerCriticalStamp,
          ],
          DESTINY_STAMP_MAX_FORWARD_LEAD,
        )
      : null;
  const uncappedPresentedLastSentMonotonicFloor =
    recentPresentedLastSentLane !== null
      ? (
          (
            isOwnerCriticalGroup ||
            isOwnerDamageStateGroup
          ) &&
          previousLastSentDestinyMatchesOwnerMissileLane !== true
            ? advanceDestinyStamp(recentPresentedLastSentLane, 1)
            : recentPresentedLastSentLane
        )
      : null;
  const presentedLastSentMonotonicFloor =
    uncappedPresentedLastSentMonotonicFloor !== null &&
    presentedLastSentCeilingCap !== null
      ? clampDestinyStampToCeiling(
          currentSessionStamp,
          uncappedPresentedLastSentMonotonicFloor,
          presentedLastSentCeilingCap,
        )
      : uncappedPresentedLastSentMonotonicFloor;
  const recentOwnerMovementState = resolveRecentOwnerLaneState({
    laneStamp: lastOwnerPilotCommandMovementStamp,
    laneAnchorStamp: lastOwnerPilotCommandMovementAnchorStamp,
    laneRawDispatchStamp: lastOwnerPilotCommandMovementRawDispatchStamp,
    currentSessionStamp,
    currentImmediateSessionStamp,
    currentRawDispatchStamp,
    maximumProjectedLead: maximumProjectedOwnerCriticalLead,
  });
  const recentOwnerMissileLifecycleState = resolveRecentOwnerLaneState({
    laneStamp: lastOwnerMissileLifecycleStamp,
    laneAnchorStamp: lastOwnerMissileLifecycleAnchorStamp,
    laneRawDispatchStamp: lastOwnerMissileLifecycleRawDispatchStamp,
    currentSessionStamp,
    currentImmediateSessionStamp,
    currentRawDispatchStamp,
    maximumProjectedLead: maximumProjectedOwnerCriticalLead,
    allowFarAheadReuseAfterRawAdvance: true,
  });
  const recentOwnerFreshAcquireState = resolveRecentOwnerLaneState({
    laneStamp: lastOwnerMissileFreshAcquireStamp,
    laneAnchorStamp: lastOwnerMissileFreshAcquireAnchorStamp,
    laneRawDispatchStamp: lastOwnerMissileFreshAcquireRawDispatchStamp,
    currentSessionStamp,
    currentImmediateSessionStamp,
    currentRawDispatchStamp,
    maximumProjectedLead: maximumProjectedOwnerCriticalLead,
    allowFarAheadReuseAfterRawAdvance: true,
  });
  const recentOverallOwnerCriticalState =
    previousLastSentDestinyWasOwnerCritical === true &&
    !(
      previousLastSentDestinyOnlyStaleProjectedOwnerMissileLane === true &&
      previousLastSentDestinyMatchesOwnerMissileLane
    )
      ? resolveRecentOwnerLaneState({
          laneStamp: previousLastSentDestinyStamp,
          laneAnchorStamp: previousLastSentDestinyAnchorStamp,
          laneRawDispatchStamp: previousLastSentDestinyRawDispatchStamp,
          currentSessionStamp,
          currentImmediateSessionStamp,
          currentRawDispatchStamp,
          maximumProjectedLead: maximumProjectedOwnerCriticalLead,
          allowFarAheadReuseAfterRawAdvance:
            !previousLastSentDestinyMatchesOwnerMissileLane,
        })
      : attachRecentOwnerLanePresence({
          recentLane: null,
          projectedConsumedLane: null,
          rawDispatchDelta: 0,
          anchorDelta: 0,
          progressDelta: 0,
        }, false, false);
  const uncappedGenericMonotonicFloor =
    containsMovementContractPayload &&
    !isSetStateGroup &&
    !isOwnerMissileLifecycleGroup &&
    !isOwnerCriticalGroup &&
    isDestinyStampWithinRelativeWindow(
      currentSessionStamp,
      recentNonCriticalLastSentLane,
      1,
      maximumProjectedOwnerCriticalLead,
    )
      ? selectFurthestPresentDestinyStamp(
          currentSessionStamp,
          [
            recentNonCriticalLastSentLane,
            hasProjectedRecentLastSentLane
              ? projectedRecentLastSentLane
              : null,
          ],
          DESTINY_STAMP_MAX_FORWARD_LEAD,
        )
      : null;
  const genericMonotonicFloor =
    uncappedGenericMonotonicFloor !== null &&
    presentedLastSentCeilingCap !== null
      ? clampDestinyStampToCeiling(
          currentSessionStamp,
          uncappedGenericMonotonicFloor,
          presentedLastSentCeilingCap,
        )
      : uncappedGenericMonotonicFloor;
  const recentOwnerCriticalLane =
    isOwnerCriticalGroup &&
    previousLastSentDestinyWasOwnerCritical === true
      ? (
          recentPresentedLastSentLane !== null
            ? recentPresentedLastSentLane
            : (
                (
                  !hasOwnerShip ||
                  isDestinyStampWithinForwardWindow(
                    currentSessionStamp,
                    previousLastSentDestinyStamp,
                    recentEmittedOwnerCriticalMaxLead,
                  )
                )
                  ? getRecentTrustedLane({
                      laneStamp: previousLastSentDestinyStamp,
                      currentStamp: currentSessionStamp,
                      currentRawDispatchStamp,
                      laneRawDispatchStamp: previousLastSentDestinyRawDispatchStamp,
                      maximumLead:
                        recentEmittedOwnerCriticalMaxLead +
                        MICHELLE_DIRECT_CRITICAL_ECHO_DESTINY_LEAD,
                      maximumRawDispatchDelta: 2,
                    })
                  : null
              )
        )
      : null;
  const recentOwnerCriticalRawDispatchDelta =
    previousLastSentRawDispatchDelta === null
      ? 0
      : previousLastSentRawDispatchDelta;
  const isTrustedRecentOwnerCriticalLane = (
    lane,
    rawDispatchDelta = 0,
    allowBeyondBufferedCeiling = false,
  ) => (
    hasDestinyStamp(lane) &&
    (
      rawDispatchDelta === 0 ||
      allowBeyondBufferedCeiling === true ||
      !hasOwnerShip ||
      isDestinyStampWithinForwardWindow(
        currentSessionStamp,
        lane,
        recentEmittedOwnerCriticalMaxLead,
      )
    )
  );
  const allowFarAheadRecentOwnerMissileLifecycleLane =
    recentOwnerMissileLifecycleState.rawDispatchDelta === 1 &&
    previousLastSentDestinyOnlyStaleProjectedOwnerMissileLane !== true &&
    lastOwnerMissileLifecycleStamp !== null &&
    lastOwnerMissileFreshAcquireStamp !== null &&
    lastOwnerMissileLifecycleStamp ===
      advanceDestinyStamp(lastOwnerMissileFreshAcquireStamp, 1) &&
    lastOwnerMissileFreshAcquireRawDispatchStamp !== null &&
    lastOwnerMissileLifecycleRawDispatchStamp !== null &&
    lastOwnerMissileFreshAcquireRawDispatchStamp ===
      lastOwnerMissileLifecycleRawDispatchStamp;
  const allowFarAheadRecentOverallOwnerCriticalLane =
    recentOverallLastSentState.rawDispatchDelta === 1 ||
    recentOverallOwnerCriticalState.rawDispatchDelta === 1;
  const previousLastSentDestinyMatchesTrackedOwnerCriticalLane =
    previousLastSentLaneIsRelevant &&
    (
      previousLastSentDestinyStamp === lastOwnerPilotCommandMovementStamp ||
      previousLastSentDestinyStamp === lastOwnerNonMissileCriticalStamp ||
      previousLastSentDestinyStamp === lastOwnerMissileLifecycleStamp ||
      previousLastSentDestinyStamp === lastOwnerMissileFreshAcquireStamp
    );
  const allowUntrackedRecentOverallOwnerLaneTrust =
    recentOverallLastSentState.rawDispatchDelta > 0 &&
    // Observer missile lifecycle is already handled by its own lifecycle
    // floor/ceiling contract. Treating an untracked prior observer missile
    // lane like owner-critical history lets RemoveBalls project themselves
    // forward again, which is exactly the glitch.txt 4816 -> 4820 -> 4824
    // runaway we are trying to avoid.
    isMissileLifecycleGroup !== true;
  const recentOverallLastSentTrustedLane =
    (
      previousLastSentDestinyMatchesTrackedOwnerCriticalLane === true ||
      allowUntrackedRecentOverallOwnerLaneTrust === true
    ) &&
    isTrustedRecentOwnerCriticalLane(
      recentOverallLastSentState.recentLane,
      recentOverallLastSentState.rawDispatchDelta,
      allowFarAheadRecentOverallOwnerCriticalLane,
    )
      ? recentOverallLastSentState.recentLane
      : null;
  const recentOwnerMovementTrustedLane =
    isTrustedRecentOwnerCriticalLane(
      recentOwnerMovementState.recentLane,
      recentOwnerMovementState.rawDispatchDelta,
    )
      ? recentOwnerMovementState.recentLane
      : null;
  const recentOwnerMissileLifecycleTrustedLane =
    isTrustedRecentOwnerCriticalLane(
      recentOwnerMissileLifecycleState.recentLane,
      recentOwnerMissileLifecycleState.rawDispatchDelta,
      allowFarAheadRecentOwnerMissileLifecycleLane,
    )
      ? recentOwnerMissileLifecycleState.recentLane
      : null;
  const recentOwnerFreshAcquireTrustedLane =
    isTrustedRecentOwnerCriticalLane(
      recentOwnerFreshAcquireState.recentLane,
      recentOwnerFreshAcquireState.rawDispatchDelta,
    )
      ? recentOwnerFreshAcquireState.recentLane
      : null;
  const recentOverallOwnerCriticalTrustedLane =
    (
      previousLastSentDestinyMatchesTrackedOwnerCriticalLane === true ||
      allowUntrackedRecentOverallOwnerLaneTrust === true
    ) &&
    isTrustedRecentOwnerCriticalLane(
      recentOverallOwnerCriticalState.recentLane,
      recentOverallOwnerCriticalState.rawDispatchDelta,
    )
      ? recentOverallOwnerCriticalState.recentLane
      : null;
  const projectedOwnerMissileLifecycleLane =
    recentOwnerMissileLifecycleState.projectedConsumedLane !== null &&
    (
      recentOwnerMissileLifecycleState.rawDispatchDelta > 0 ||
      (
        recentOwnerMissileLifecycleState.anchorDelta > 0 &&
        recentOwnerMissileLifecycleTrustedLane !== null &&
        isDestinyStampAfter(recentOwnerMissileLifecycleTrustedLane, currentLocalStamp)
      )
    ) &&
    recentOwnerMissileLifecycleState.laneStamp !== null &&
    (
      !hasOwnerShip ||
      isDestinyStampWithinForwardWindow(
        currentSessionStamp,
        recentOwnerMissileLifecycleState.laneStamp,
        recentEmittedOwnerCriticalMaxLead,
      ) ||
      allowFarAheadRecentOwnerMissileLifecycleLane
    ) &&
    !(
      (
        isFreshAcquireLifecycleGroup ||
        isOwnerMissileLifecycleGroup
      ) &&
      recentOwnerMissileLifecycleState.rawDispatchDelta > 2 &&
      !isDestinyStampWithinForwardWindow(
        currentSessionStamp,
        recentOwnerMissileLifecycleState.laneStamp,
        recentEmittedOwnerCriticalMaxLead,
      )
    )
      ? recentOwnerMissileLifecycleState.projectedConsumedLane
      : null;
  const projectedOwnerFreshAcquireLane =
    recentOwnerFreshAcquireState.projectedConsumedLane !== null &&
    recentOwnerFreshAcquireState.rawDispatchDelta > 0 &&
    recentOwnerFreshAcquireState.laneStamp !== null &&
    (
      !hasOwnerShip ||
      isDestinyStampWithinForwardWindow(
        currentSessionStamp,
        recentOwnerFreshAcquireState.laneStamp,
        recentEmittedOwnerCriticalMaxLead,
      )
    )
      ? recentOwnerFreshAcquireState.projectedConsumedLane
      : null;
  const projectedRecentOverallOwnerCriticalLane =
    recentOverallLastSentTrustedLane !== null &&
    hasProjectedRecentLastSentLane &&
    isDestinyStampAfter(
      recentOverallLastSentTrustedLane,
      projectedRecentLastSentLane,
    ) &&
    !(
      isFreshAcquireLifecycleGroup &&
      previousLastSentDestinyMatchesOwnerMissileLane === true &&
      !isDestinyStampWithinForwardWindow(
        currentSessionStamp,
        projectedRecentLastSentLane,
        recentEmittedOwnerCriticalMaxLead +
          MICHELLE_DIRECT_CRITICAL_ECHO_DESTINY_LEAD +
          1,
      )
    )
      ? projectedRecentLastSentLane
      : null;
  const reusableRecentOwnerCriticalLane = selectFurthestPresentDestinyStamp(
    currentSessionStamp,
    [
      recentPresentedLastSentLane,
      recentOverallLastSentTrustedLane,
      recentOwnerMovementTrustedLane,
      recentOwnerMissileLifecycleTrustedLane,
      recentOwnerFreshAcquireTrustedLane,
      recentOverallOwnerCriticalTrustedLane,
    ],
    DESTINY_STAMP_MAX_FORWARD_LEAD,
  );
  const projectedConsumedOwnerCriticalLane = selectFurthestPresentDestinyStamp(
    currentSessionStamp,
    [
      projectedRecentOverallOwnerCriticalLane,
      projectedOwnerMissileLifecycleLane,
      projectedOwnerFreshAcquireLane,
    ],
    DESTINY_STAMP_MAX_FORWARD_LEAD,
  );
  // Non-owner missile *fresh-acquire* already has its own Michelle-safe
  // restamp contract in resolveDestinyLifecycleRestampState(). Running those
  // same observer AddBalls2 waves through the owner-critical monotonic floor
  // again is what produced fulldesync9's bad 2960 -> 2957 inversion and later
  // 2965 inflation.
  //
  // But ordinary non-owner missile lifecycle (especially RemoveBalls) still
  // needs the monotonic floor. `badjolt.txt` proved dropping it entirely lets
  // later non-owner missile teardown packets fall back under already-sent
  // session history. So the safe boundary is narrow:
  // - observer missile fresh-acquire: skip owner-critical monotonic floor
  // - other missile lifecycle: keep it
  const requiresOwnerCriticalMonotonicFloor =
    isOwnerCriticalGroup ||
    isOwnerDamageStateGroup ||
    isOwnerMissileLifecycleGroup ||
    (
      isMissileLifecycleGroup &&
      isFreshAcquireLifecycleGroup !== true
    );
  const sameRawReusableOwnerMissileLifecycleLane =
    recentOwnerMissileLifecycleTrustedLane !== null &&
    recentOwnerMissileLifecycleState.rawDispatchStampPresent === true &&
    recentOwnerMissileLifecycleState.rawDispatchDelta === 0
      ? recentOwnerMissileLifecycleTrustedLane
      : null;
  const ownerMovementRawDispatchDelta = getRecentDestinyStampDelta(
    lastOwnerPilotCommandMovementRawDispatchStamp,
    currentRawDispatchStamp,
    2,
  );
  const nearbyOwnerMovementClearFloor =
    isFreshAcquireLifecycleGroup &&
    previousLastSentLaneIsRelevant &&
    previousLastSentDestinyStamp === lastOwnerPilotCommandMovementStamp &&
    isDestinyStampWithinRelativeWindow(
      currentSessionStamp,
      lastOwnerPilotCommandMovementStamp,
      -1,
      MICHELLE_HELD_FUTURE_DESTINY_LEAD,
    ) &&
    (
      ownerMovementRawDispatchDelta !== null ||
      lastOwnerPilotCommandMovementRawDispatchStamp === null
    )
      ? advanceDestinyStamp(lastOwnerPilotCommandMovementStamp, 1)
      : null;
  const nearbyOwnerNonMissileCriticalClearFloor =
    previousLastSentLaneIsRelevant &&
    previousLastSentDestinyStamp === lastOwnerNonMissileCriticalStamp &&
    previousLastSentDestinyMatchesOwnerMissileLane !== true &&
    isDestinyStampWithinRelativeWindow(
      currentSessionStamp,
      lastOwnerNonMissileCriticalStamp,
      -1,
      MICHELLE_HELD_FUTURE_DESTINY_LEAD,
    )
      ? advanceDestinyStamp(lastOwnerNonMissileCriticalStamp, 1)
      : null;
  const sameRawFreshAcquireReusableLane = selectFurthestPresentDestinyStamp(
    currentSessionStamp,
    [
      recentOwnerFreshAcquireTrustedLane !== null &&
      recentOwnerFreshAcquireState.rawDispatchStampPresent === true &&
      recentOwnerFreshAcquireState.rawDispatchDelta === 0
        ? recentOwnerFreshAcquireTrustedLane
        : null,
      recentOverallLastSentTrustedLane !== null &&
      previousLastSentDestinyStamp === lastOwnerMissileFreshAcquireStamp &&
      recentOverallLastSentState.rawDispatchStampPresent === true &&
      recentOverallLastSentState.rawDispatchDelta === 0
        ? recentOverallLastSentTrustedLane
        : null,
      recentOverallOwnerCriticalTrustedLane !== null &&
      previousLastSentDestinyStamp === lastOwnerMissileFreshAcquireStamp &&
      recentOverallOwnerCriticalState.rawDispatchStampPresent === true &&
      recentOverallOwnerCriticalState.rawDispatchDelta === 0
        ? recentOverallOwnerCriticalTrustedLane
        : null,
    ],
    DESTINY_STAMP_MAX_FORWARD_LEAD,
  );
  const projectedFreshAcquireReusableLane =
    isFreshAcquireLifecycleGroup &&
    allowAdjacentRawFreshAcquireLaneReuse === true &&
    projectedOwnerFreshAcquireLane !== null
      ? projectedOwnerFreshAcquireLane
      : null;
  const preserveOwnerDamageLifecycleFreshAcquireFloor =
    isFreshAcquireLifecycleGroup &&
    previousLastSentDestinyWasOwnerDamageLifecycleLane === true;
  const freshAcquireBufferedCeilingStamp =
    isFreshAcquireLifecycleGroup
      ? advanceDestinyStamp(
          currentImmediateSessionStamp,
          MICHELLE_HELD_FUTURE_DESTINY_LEAD,
        )
      : null;
  const freshAcquireSameRawFarAheadTrustCeilingStamp =
    isFreshAcquireLifecycleGroup
      ? advanceDestinyStamp(freshAcquireBufferedCeilingStamp, 1)
      : null;
  const freshAcquireSameRawLifecycleClearCeilingStamp =
    isFreshAcquireLifecycleGroup
      ? advanceDestinyStamp(freshAcquireSameRawFarAheadTrustCeilingStamp, 1)
      : null;
  const filterFarAheadOwnerLaneForFreshAcquire = (
    lane,
    rawDispatchDelta = 0,
    reusableLane = null,
    sourceMatchesMissileLane = true,
  ) => (
    isFreshAcquireLifecycleGroup &&
    sourceMatchesMissileLane === true &&
    hasDestinyStamp(lane) &&
    isDestinyStampAfter(freshAcquireSameRawFarAheadTrustCeilingStamp, lane) &&
    !(
      reusableLane !== null &&
      lane === reusableLane
    ) &&
    !(
      projectedFreshAcquireReusableLane !== null &&
      lane === projectedFreshAcquireReusableLane
    )
      ? null
      : lane
  );
  const recentOwnerFreshAcquireFreshAcquireLane =
    filterFarAheadOwnerLaneForFreshAcquire(
      recentOwnerFreshAcquireTrustedLane,
      recentOwnerFreshAcquireState.rawDispatchDelta,
      sameRawFreshAcquireReusableLane,
    );
  const recentOwnerCriticalFreshAcquireLane =
    filterFarAheadOwnerLaneForFreshAcquire(
      recentOwnerCriticalLane,
      recentOwnerCriticalRawDispatchDelta,
      sameRawFreshAcquireReusableLane,
      previousLastSentDestinyMatchesOwnerMissileLane,
    );
  const recentOwnerMissileLifecycleFreshAcquireLane =
    preserveOwnerDamageLifecycleFreshAcquireFloor &&
    previousLastSentDestinyStamp === lastOwnerMissileLifecycleStamp
      ? recentOwnerMissileLifecycleTrustedLane
      : filterFarAheadOwnerLaneForFreshAcquire(
          recentOwnerMissileLifecycleTrustedLane,
          recentOwnerMissileLifecycleState.rawDispatchDelta,
          sameRawFreshAcquireReusableLane,
        );
  const recentOverallLastSentFreshAcquireLane =
    filterFarAheadOwnerLaneForFreshAcquire(
      recentOverallLastSentTrustedLane,
      recentOverallLastSentState.rawDispatchDelta,
      sameRawFreshAcquireReusableLane,
      previousLastSentDestinyMatchesOwnerMissileLane &&
        previousLastSentDestinyWasOwnerDamageLifecycleLane !== true,
    );
  const recentOverallOwnerCriticalFreshAcquireLane =
    filterFarAheadOwnerLaneForFreshAcquire(
      recentOverallOwnerCriticalTrustedLane,
      recentOverallOwnerCriticalState.rawDispatchDelta,
      sameRawFreshAcquireReusableLane,
      previousLastSentDestinyMatchesOwnerMissileLane &&
        previousLastSentDestinyWasOwnerDamageLifecycleLane !== true,
    );
  const farAheadTrackedOwnerMissileLaneBlocksFreshAcquireClear =
    isFreshAcquireLifecycleGroup &&
    previousLastSentDestinyWasOwnerDamageLifecycleLane !== true &&
    previousLastSentDestinyMatchesOwnerMissileLane === true &&
    recentOverallLastSentTrustedLane !== null &&
    isDestinyStampAfter(
      freshAcquireSameRawLifecycleClearCeilingStamp,
      recentOverallLastSentTrustedLane,
    );
  const presentedOwnerCriticalLead = currentPresentedOwnerCriticalStamp !== null
    ? getDestinyStampForwardDistance(
        currentImmediateSessionStamp,
        currentPresentedOwnerCriticalStamp,
      )
    : null;
  const nearbyPresentedNonMissileOwnerCriticalLaneClearFloor =
    previousLastSentLaneIsRelevant &&
    previousLastSentDestinyWasOwnerCritical === true &&
    previousLastSentDestinyMatchesOwnerMissileLane !== true &&
    presentedOwnerCriticalLead !== null &&
    presentedOwnerCriticalLead <= maximumProjectedOwnerCriticalLead &&
    isDestinyStampWithinForwardWindow(
      currentImmediateSessionStamp,
      previousLastSentDestinyStamp,
      presentedOwnerCriticalLead,
    )
      ? advanceDestinyStamp(previousLastSentDestinyStamp, 1)
      : null;
  const sameRawNearOwnerLaneClearFloor =
    recentOverallLastSentTrustedLane !== null &&
    recentOverallLastSentState.rawDispatchStampPresent === true &&
    recentOverallLastSentState.rawDispatchDelta === 0 &&
    previousLastSentDestinyWasOwnerCritical === true &&
    isOwnerDamageStateGroup !== true &&
    !farAheadTrackedOwnerMissileLaneBlocksFreshAcquireClear &&
    (
      sameRawReusableOwnerMissileLifecycleLane === null ||
      previousLastSentDestinyStamp === lastOwnerMissileFreshAcquireStamp ||
      (
        isFreshAcquireLifecycleGroup &&
        isDestinyStampWithinForwardWindow(
          currentImmediateSessionStamp,
          recentOverallLastSentTrustedLane,
          getDestinyStampForwardDistance(
            currentImmediateSessionStamp,
            freshAcquireSameRawLifecycleClearCeilingStamp,
          ),
        )
      )
    ) &&
    !(
      isFreshAcquireLifecycleGroup &&
      previousLastSentDestinyStamp === lastOwnerMissileFreshAcquireStamp
    )
      ? advanceDestinyStamp(recentOverallLastSentTrustedLane, 1)
      : null;
  const sameRawOwnerDamageLifecycleClearFloor =
    isFreshAcquireLifecycleGroup &&
    previousLastSentDestinyWasOwnerDamageLifecycleLane === true &&
    previousLastSentDestinyRawDispatchStamp === currentRawDispatchStamp
      ? advanceDestinyStamp(previousLastSentDestinyStamp, 1)
      : null;
  const ownerDamageStateRecentOwnerCriticalClearFloor =
    isOwnerDamageStateGroup === true &&
    reusableRecentOwnerCriticalLane !== null
      ? advanceDestinyStamp(reusableRecentOwnerCriticalLane, 2)
      : null;
  const canReuseProjectedFreshAcquireLane =
    projectedFreshAcquireReusableLane !== null &&
    isDestinyStampAfter(
      currentPresentedOwnerCriticalStamp,
      projectedFreshAcquireReusableLane,
    ) &&
    isDestinyStampAfter(currentLocalStamp, projectedFreshAcquireReusableLane);
  const recentOwnerCriticalContribution =
    recentOwnerCriticalLane !== null
      ? (
          isFreshAcquireLifecycleGroup
            ? sameRawFreshAcquireReusableLane !== null &&
              recentOwnerCriticalFreshAcquireLane ===
                sameRawFreshAcquireReusableLane
              ? sameRawFreshAcquireReusableLane
              : recentOwnerCriticalFreshAcquireLane !== null
                ? advanceDestinyStamp(recentOwnerCriticalFreshAcquireLane, 1)
                : null
            : recentOwnerCriticalLane
        )
      : null;
  const freshAcquireRecentOwnerMovementClearContribution =
    isFreshAcquireLifecycleGroup && recentOwnerMovementTrustedLane !== null
      ? advanceDestinyStamp(recentOwnerMovementTrustedLane, 1)
      : null;
  const freshAcquireRecentOwnerMissileLifecycleClearContribution =
    isFreshAcquireLifecycleGroup &&
    recentOwnerMissileLifecycleFreshAcquireLane !== null &&
    !(
      sameRawFreshAcquireReusableLane !== null &&
      recentOwnerMissileLifecycleState.rawDispatchStampPresent === true &&
      recentOwnerMissileLifecycleState.rawDispatchDelta === 0 &&
      recentOwnerMissileLifecycleFreshAcquireLane ===
        sameRawFreshAcquireReusableLane
    )
      ? advanceDestinyStamp(recentOwnerMissileLifecycleFreshAcquireLane, 1)
      : null;
  const freshAcquireRecentOwnerFreshAcquireClearContribution =
    isFreshAcquireLifecycleGroup &&
    recentOwnerFreshAcquireFreshAcquireLane !== null &&
    recentOwnerFreshAcquireState.rawDispatchDelta > 0
      ? advanceDestinyStamp(recentOwnerFreshAcquireFreshAcquireLane, 1)
      : null;
  const freshAcquireRecentOverallLastSentClearContribution =
    isFreshAcquireLifecycleGroup &&
    recentOverallLastSentFreshAcquireLane !== null &&
    !(
      previousLastSentDestinyStamp === lastOwnerMissileFreshAcquireStamp &&
      recentOverallLastSentState.rawDispatchStampPresent === true &&
      recentOverallLastSentState.rawDispatchDelta === 0
    ) &&
    !(
      sameRawFreshAcquireReusableLane !== null &&
      recentOverallLastSentState.rawDispatchStampPresent === true &&
      recentOverallLastSentState.rawDispatchDelta === 0 &&
      recentOverallLastSentFreshAcquireLane ===
        sameRawFreshAcquireReusableLane
    )
      ? advanceDestinyStamp(recentOverallLastSentFreshAcquireLane, 1)
      : null;
  const freshAcquireRecentOverallOwnerCriticalClearContribution =
    isFreshAcquireLifecycleGroup &&
    recentOverallOwnerCriticalFreshAcquireLane !== null &&
    !(
      previousLastSentDestinyStamp === lastOwnerMissileFreshAcquireStamp &&
      recentOverallOwnerCriticalState.rawDispatchStampPresent === true &&
      recentOverallOwnerCriticalState.rawDispatchDelta === 0
    ) &&
    !(
      sameRawFreshAcquireReusableLane !== null &&
      recentOverallOwnerCriticalState.rawDispatchStampPresent === true &&
      recentOverallOwnerCriticalState.rawDispatchDelta === 0 &&
      recentOverallOwnerCriticalFreshAcquireLane ===
        sameRawFreshAcquireReusableLane
    )
      ? advanceDestinyStamp(recentOverallOwnerCriticalFreshAcquireLane, 1)
      : null;
  const freshAcquireMaxClearContribution =
    isFreshAcquireLifecycleGroup
      ? selectFurthestPresentDestinyStamp(
          currentSessionStamp,
          [
            freshAcquireRecentOwnerMovementClearContribution,
            freshAcquireRecentOwnerMissileLifecycleClearContribution,
            freshAcquireRecentOwnerFreshAcquireClearContribution,
            freshAcquireRecentOverallLastSentClearContribution,
            freshAcquireRecentOverallOwnerCriticalClearContribution,
          ],
          DESTINY_STAMP_MAX_FORWARD_LEAD,
        )
      : reusableRecentOwnerCriticalLane;
  const projectedConsumedOwnerCriticalContribution =
    projectedConsumedOwnerCriticalLane !== null
      ? (
          isFreshAcquireLifecycleGroup &&
          projectedFreshAcquireReusableLane !== null &&
          projectedConsumedOwnerCriticalLane ===
            projectedFreshAcquireReusableLane &&
          canReuseProjectedFreshAcquireLane
            ? projectedFreshAcquireReusableLane
            : (
              isMissileLifecycleGroup &&
              isOwnerMissileLifecycleGroup !== true &&
              isOwnerCriticalGroup !== true &&
              isOwnerDamageStateGroup !== true
            )
              // Observer missile lifecycle already has its own held-future
              // floor. Lifting it an extra +1 off projected owner-critical
              // history is what created the `npc4.txt` 3848 -> 3849 runaway
              // that then poisoned the next owner steer.
              ? projectedConsumedOwnerCriticalLane
            : advanceDestinyStamp(projectedConsumedOwnerCriticalLane, 1)
        )
      : null;
  const recentOwnerCriticalFloorCandidates = [
    buildDecisionCandidate(
      "ownerDamageStateRecentOwnerCriticalClearFloor",
      ownerDamageStateRecentOwnerCriticalClearFloor,
    ),
    buildDecisionCandidate(
      "sameRawOwnerDamageLifecycleClearFloor",
      sameRawOwnerDamageLifecycleClearFloor,
    ),
    buildDecisionCandidate(
      "sameRawFreshAcquireReusableLane",
      isFreshAcquireLifecycleGroup ? sameRawFreshAcquireReusableLane : null,
    ),
    buildDecisionCandidate(
      "nearbyOwnerMovementClearFloor",
      nearbyOwnerMovementClearFloor,
    ),
    buildDecisionCandidate(
      "nearbyOwnerNonMissileCriticalClearFloor",
      nearbyOwnerNonMissileCriticalClearFloor,
    ),
    buildDecisionCandidate(
      "nearbyPresentedNonMissileOwnerCriticalLaneClearFloor",
      nearbyPresentedNonMissileOwnerCriticalLaneClearFloor,
    ),
    buildDecisionCandidate(
      "sameRawNearOwnerLaneClearFloor",
      sameRawNearOwnerLaneClearFloor,
    ),
    buildDecisionCandidate(
      "recentOwnerCriticalContribution",
      recentOwnerCriticalContribution,
    ),
    buildDecisionCandidate(
      "freshAcquireRecentOwnerMovementClearContribution",
      freshAcquireRecentOwnerMovementClearContribution,
    ),
    buildDecisionCandidate(
      "freshAcquireRecentOwnerMissileLifecycleClearContribution",
      freshAcquireRecentOwnerMissileLifecycleClearContribution,
    ),
    buildDecisionCandidate(
      "freshAcquireRecentOwnerFreshAcquireClearContribution",
      freshAcquireRecentOwnerFreshAcquireClearContribution,
    ),
    buildDecisionCandidate(
      "freshAcquireRecentOverallLastSentClearContribution",
      freshAcquireRecentOverallLastSentClearContribution,
    ),
    buildDecisionCandidate(
      "freshAcquireRecentOverallOwnerCriticalClearContribution",
      freshAcquireRecentOverallOwnerCriticalClearContribution,
    ),
    buildDecisionCandidate(
      isFreshAcquireLifecycleGroup
        ? "freshAcquireMaxClearContribution"
        : "reusableRecentOwnerCriticalLane",
      freshAcquireMaxClearContribution,
    ),
    buildDecisionCandidate(
      "projectedConsumedOwnerCriticalContribution",
      projectedConsumedOwnerCriticalContribution,
    ),
  ];
  const recentOwnerCriticalMonotonicFloor =
    requiresOwnerCriticalMonotonicFloor
      ? selectFurthestPresentDestinyStamp(
          currentSessionStamp,
          [
            ownerDamageStateRecentOwnerCriticalClearFloor,
            sameRawOwnerDamageLifecycleClearFloor,
            isFreshAcquireLifecycleGroup
              ? sameRawFreshAcquireReusableLane
              : null,
            nearbyOwnerMovementClearFloor,
            nearbyOwnerNonMissileCriticalClearFloor,
            nearbyPresentedNonMissileOwnerCriticalLaneClearFloor,
            sameRawNearOwnerLaneClearFloor,
            recentOwnerCriticalContribution,
            freshAcquireMaxClearContribution,
            projectedConsumedOwnerCriticalContribution,
          ],
          DESTINY_STAMP_MAX_FORWARD_LEAD,
        )
      : null;
  const ownerMissileLifecycleCeilingStamp =
    isOwnerMissileLifecycleGroup
      ? selectFurthestPresentDestinyStamp(
          currentSessionStamp,
          [
            presentedLastSentCeilingCap,
            advanceDestinyStamp(
              currentSessionStamp,
              MICHELLE_HELD_FUTURE_DESTINY_LEAD,
            ),
          ],
          DESTINY_STAMP_MAX_FORWARD_LEAD,
        )
      : null;
  const ownerCriticalBaseCeilingStamp =
    isOwnerDamageStateGroup
      ? presentedLastSentCeilingCap
      : isOwnerMissileLifecycleGroup
        ? ownerMissileLifecycleCeilingStamp
        : isOwnerCriticalGroup
          ? presentedLastSentCeilingCap
          : null;
  // Hard-cap the ceiling at currentSession + lead. Previously this was
  // max(baseCeiling, recentOwnerCriticalMonotonicFloor) which let the
  // ceiling rise with compounded missile lifecycle stamps. With 6
  // launchers, stamps compound ~12 per tick, pushing the client's
  // _current_time far ahead of wall clock. The hard cap forces all
  // events in a tick to share the near-current ceiling stamp, matching
  // the CCP server's behavior where simultaneous events share stamps.
  const ownerCriticalCeilingStamp =
    (
      isOwnerCriticalGroup ||
      isOwnerDamageStateGroup
    )
      ? ownerCriticalBaseCeilingStamp
      : null;
  const reusableRecentOwnerCriticalLaneCandidates = summarizeDecisionCandidates(
    [
      buildDecisionCandidate(
        "recentPresentedLastSentLane",
        recentPresentedLastSentLane,
      ),
      buildDecisionCandidate(
        "recentOverallLastSentTrustedLane",
        recentOverallLastSentTrustedLane,
      ),
      buildDecisionCandidate(
        "recentOwnerMovementTrustedLane",
        recentOwnerMovementTrustedLane,
      ),
      buildDecisionCandidate(
        "recentOwnerMissileLifecycleTrustedLane",
        recentOwnerMissileLifecycleTrustedLane,
      ),
      buildDecisionCandidate(
        "recentOwnerFreshAcquireTrustedLane",
        recentOwnerFreshAcquireTrustedLane,
      ),
      buildDecisionCandidate(
        "recentOverallOwnerCriticalTrustedLane",
        recentOverallOwnerCriticalTrustedLane,
      ),
    ],
    reusableRecentOwnerCriticalLane,
  );
  const projectedConsumedOwnerCriticalLaneCandidates =
    summarizeDecisionCandidates(
      [
        buildDecisionCandidate(
          "projectedRecentOverallOwnerCriticalLane",
          projectedRecentOverallOwnerCriticalLane,
        ),
        buildDecisionCandidate(
          "projectedOwnerMissileLifecycleLane",
          projectedOwnerMissileLifecycleLane,
        ),
        buildDecisionCandidate(
          "projectedOwnerFreshAcquireLane",
          projectedOwnerFreshAcquireLane,
        ),
      ],
      projectedConsumedOwnerCriticalLane,
    );
  const recentOwnerCriticalMonotonicFloorCandidatesSummary =
    summarizeDecisionCandidates(
      recentOwnerCriticalFloorCandidates,
      recentOwnerCriticalMonotonicFloor,
    );
  const ownerCriticalCeilingCandidates = summarizeDecisionCandidates(
    [
      buildDecisionCandidate(
        "ownerCriticalBaseCeilingStamp",
        ownerCriticalBaseCeilingStamp,
      ),
      buildDecisionCandidate(
        "recentOwnerCriticalMonotonicFloor",
        recentOwnerCriticalMonotonicFloor,
      ),
    ],
    ownerCriticalCeilingStamp,
  );
  const decisionTrace = {
    inputs: {
      hasOwnerShip,
      containsMovementContractPayload,
      isSetStateGroup,
      isOwnerPilotMovementGroup,
      isMissileLifecycleGroup,
      isOwnerMissileLifecycleGroup,
      isOwnerCriticalGroup,
      isFreshAcquireLifecycleGroup,
      isOwnerDamageStateGroup,
      allowAdjacentRawFreshAcquireLaneReuse,
      currentSessionStamp,
      currentImmediateSessionStamp,
      currentLocalStamp,
      currentPresentedOwnerCriticalStamp,
      currentRawDispatchStamp,
      recentEmittedOwnerCriticalMaxLead,
      ownerCriticalCeilingLead,
      previousLastSentDestinyStamp,
      previousLastSentDestinyRawDispatchStamp,
      previousLastSentDestinyExplicitWasOwnerCritical,
      previousLastSentDestinyWasOwnerCritical,
      previousLastSentDestinyOnlyStaleProjectedOwnerMissileLane,
      lastOwnerPilotCommandMovementStamp,
      lastOwnerPilotCommandMovementAnchorStamp,
      lastOwnerPilotCommandMovementRawDispatchStamp,
      lastOwnerNonMissileCriticalStamp,
      lastOwnerMissileLifecycleStamp,
      lastOwnerMissileLifecycleAnchorStamp,
      lastOwnerMissileLifecycleRawDispatchStamp,
      lastOwnerMissileFreshAcquireStamp,
      lastOwnerMissileFreshAcquireAnchorStamp,
      lastOwnerMissileFreshAcquireRawDispatchStamp,
    },
    recentStates: {
      recentOverallLastSentState,
      recentOwnerMovementState,
      recentOwnerMissileLifecycleState,
      recentOwnerFreshAcquireState,
      recentOverallOwnerCriticalState,
    },
    trustedLanes: {
      recentPresentedLastSentLane,
      recentNonCriticalLastSentLane,
      recentOwnerCriticalLane,
      recentOverallLastSentTrustedLane,
      recentOwnerMovementTrustedLane,
      recentOwnerMissileLifecycleTrustedLane,
      recentOwnerFreshAcquireTrustedLane,
      recentOverallOwnerCriticalTrustedLane,
      sameRawReusableOwnerMissileLifecycleLane,
      sameRawFreshAcquireReusableLane,
      projectedFreshAcquireReusableLane,
      canReuseProjectedFreshAcquireLane,
      recentOwnerFreshAcquireFreshAcquireLane,
      recentOwnerMissileLifecycleFreshAcquireLane,
      recentOverallLastSentFreshAcquireLane,
      recentOverallOwnerCriticalFreshAcquireLane,
      recentOwnerCriticalFreshAcquireLane,
      reusableRecentOwnerCriticalLane,
      projectedConsumedOwnerCriticalLane,
    },
    ceilings: {
      maximumTrustedRecentEmittedOwnerCriticalStamp,
      maximumProjectedOwnerCriticalLead,
      ownerCriticalBaseCeilingStamp,
      ownerCriticalCeilingStamp,
      freshAcquireBufferedCeilingStamp,
      freshAcquireSameRawFarAheadTrustCeilingStamp,
      freshAcquireSameRawLifecycleClearCeilingStamp,
    },
    filters: {
      allowFarAheadRecentOwnerMissileLifecycleLane,
      allowFarAheadRecentOverallOwnerCriticalLane,
      previousLastSentDestinyMatchesOwnerMissileLane,
      previousLastSentDestinyWasOwnerDamageLifecycleLane,
      previousLastSentDestinyMatchesTrackedOwnerCriticalLane,
      allowUntrackedRecentOverallOwnerLaneTrust,
      preserveOwnerDamageLifecycleFreshAcquireFloor,
      farAheadTrackedOwnerMissileLaneBlocksFreshAcquireClear,
    },
    candidateGroups: {
      reusableRecentOwnerCriticalLane: reusableRecentOwnerCriticalLaneCandidates,
      projectedConsumedOwnerCriticalLane:
        projectedConsumedOwnerCriticalLaneCandidates,
      recentOwnerCriticalMonotonicFloor:
        recentOwnerCriticalMonotonicFloorCandidatesSummary,
      ownerCriticalCeilingStamp: ownerCriticalCeilingCandidates,
    },
  };
  const decisionSummary = {
    inputs: {
      currentSessionStamp,
      currentImmediateSessionStamp,
      currentLocalStamp,
      currentPresentedOwnerCriticalStamp,
      currentRawDispatchStamp,
      previousLastSentDestinyStamp,
      previousLastSentDestinyRawDispatchStamp,
      lastOwnerMissileLifecycleStamp,
      lastOwnerMissileFreshAcquireStamp,
      allowAdjacentRawFreshAcquireLaneReuse,
      isFreshAcquireLifecycleGroup,
      isMissileLifecycleGroup,
      isOwnerCriticalGroup,
      isOwnerDamageStateGroup,
    },
    recentStates: [
      formatRecentOwnerLaneStateSummary(
        "recentOverallLastSentState",
        recentOverallLastSentState,
      ),
      formatRecentOwnerLaneStateSummary(
        "recentOwnerMovementState",
        recentOwnerMovementState,
      ),
      formatRecentOwnerLaneStateSummary(
        "recentOwnerMissileLifecycleState",
        recentOwnerMissileLifecycleState,
      ),
      formatRecentOwnerLaneStateSummary(
        "recentOwnerFreshAcquireState",
        recentOwnerFreshAcquireState,
      ),
      formatRecentOwnerLaneStateSummary(
        "recentOverallOwnerCriticalState",
        recentOverallOwnerCriticalState,
      ),
    ],
    resolvedLanes: {
      reusableRecentOwnerCriticalLane,
      projectedConsumedOwnerCriticalLane,
      sameRawFreshAcquireReusableLane,
      projectedFreshAcquireReusableLane,
      recentOwnerCriticalMonotonicFloor,
      ownerCriticalCeilingStamp,
    },
    candidateGroups: {
      reusableRecentOwnerCriticalLane: formatDecisionCandidateSummary(
        reusableRecentOwnerCriticalLaneCandidates,
      ),
      projectedConsumedOwnerCriticalLane: formatDecisionCandidateSummary(
        projectedConsumedOwnerCriticalLaneCandidates,
      ),
      recentOwnerCriticalMonotonicFloor: formatDecisionCandidateSummary(
        recentOwnerCriticalMonotonicFloorCandidatesSummary,
      ),
      ownerCriticalCeilingStamp: formatDecisionCandidateSummary(
        ownerCriticalCeilingCandidates,
      ),
    },
  };

  return {
    maximumTrustedRecentEmittedOwnerCriticalStamp,
    projectedRecentLastSentLane: hasProjectedRecentLastSentLane
      ? projectedRecentLastSentLane
      : null,
    presentedLastSentMonotonicFloor,
    genericMonotonicFloor,
    recentOwnerMovementState,
    recentOverallLastSentState,
    recentOwnerMissileLifecycleState,
    recentOwnerFreshAcquireState,
    recentOverallOwnerCriticalState,
    reusableRecentOwnerCriticalLane,
    projectedConsumedOwnerCriticalLane,
    sameRawFreshAcquireReusableLane,
    projectedFreshAcquireReusableLane,
    sameRawNearOwnerLaneClearFloor,
    recentOwnerCriticalMonotonicFloor,
    ownerCriticalCeilingStamp,
    decisionTrace,
    decisionSummary,
  };
}

function resolveGotoCommandSyncState(options = {}) {
  const speedFractionChanged = options.speedFractionChanged === true;
  const ownerLocallyPredictsHeading =
    options.ownerLocallyPredictsHeading === true;
  if (!hasRequiredDestinyStamps(
    options.liveOwnerSessionStamp,
    options.currentRawDispatchStamp,
  )) {
    return {
      isCurrentGotoDuplicate: false,
      isPendingGotoDuplicate: false,
      suppressOwnerGotoEchoRecentDuplicate: false,
      suppressOwnerGotoEchoSameRawPendingFutureSteer: false,
    };
  }
  const pendingOwnerMovementStamp = resolveOptionalDestinyStamp(
    options.pendingOwnerMovementStamp,
  );
  const liveOwnerSessionStamp = toDestinyStamp(options.liveOwnerSessionStamp);
  const pendingOwnerMovementRawDispatchStamp = resolveOptionalDestinyStamp(
    options.pendingOwnerMovementRawDispatchStamp,
  );
  const currentRawDispatchStamp = toDestinyStamp(options.currentRawDispatchStamp);
  const hasPendingFutureOwnerSteer =
    pendingOwnerMovementStamp !== null &&
    isDestinyStampAfter(
      liveOwnerSessionStamp,
      pendingOwnerMovementStamp,
      DESTINY_STAMP_MAX_FORWARD_LEAD,
    );
  const sameRawPendingFutureOwnerSteer =
    hasPendingFutureOwnerSteer &&
    pendingOwnerMovementRawDispatchStamp !== null &&
    currentRawDispatchStamp === pendingOwnerMovementRawDispatchStamp;
  const pendingOwnerMovementRawDispatchDelta = getRecentDestinyStampDelta(
    pendingOwnerMovementRawDispatchStamp,
    currentRawDispatchStamp,
    1,
  );
  return {
    isCurrentGotoDuplicate:
      !speedFractionChanged && options.currentGotoDirectionMatches === true,
    isPendingGotoDuplicate:
      !speedFractionChanged && options.pendingOwnerCommandDirectionMatches === true,
    // Only the locally predicted steering path should suppress duplicate owner
    // echoes. Plain CmdGotoDirection callers like double-click-in-space do not
    // move the client ship ball locally before the server echo arrives.
    suppressOwnerGotoEchoRecentDuplicate:
      ownerLocallyPredictsHeading &&
      !speedFractionChanged &&
      options.pendingOwnerCommandDirectionMatches === true &&
      pendingOwnerMovementRawDispatchDelta !== null,
    // The same distinction applies to same-raw owner steering. Only the
    // predicted-steer path should keep the first future echo and suppress the
    // newer same-raw owner echo.
    suppressOwnerGotoEchoSameRawPendingFutureSteer:
      ownerLocallyPredictsHeading &&
      !speedFractionChanged &&
      sameRawPendingFutureOwnerSteer,
  };
}

function resolveOwnerMovementRestampState(options = {}) {
  const ownerMovementUpdates = Array.isArray(options.ownerMovementUpdates)
    ? options.ownerMovementUpdates
    : [];
  const ownerHasSteeringCommand = options.ownerHasSteeringCommand === true;
  if (!hasRequiredDestinyStamps(
    options.currentRawDispatchStamp,
    options.liveOwnerSessionStamp,
    options.currentVisibleOwnerStamp,
    options.currentPresentedOwnerStamp,
  )) {
    return {
      currentOwnerPilotCommandDirection: null,
      previousOwnerPilotCommandDirection: null,
      ownerDirectEchoMinimumStamp: null,
      repeatedOwnerPilotCommandLane: null,
      reusableHeldOwnerPilotCommandLane: null,
      nextDistinctOwnerPilotCommandLane: null,
      suppressSameRawDistinctFutureOwnerEcho: false,
      earlierTickOwnerPilotCommandMatches: false,
      recentPresentedFreshAcquireLane: null,
      recentOwnerNonMissileCriticalLane: null,
      recentOwnerMissileLifecycleLane: null,
      recentOwnerFreshAcquireLane: null,
      recentBufferedOwnerCriticalFloor: null,
      ownerVisibleStamp: null,
      ownerMinimumStamp: null,
      postFreshAcquireOwnerSteeringFloor: null,
      presentedNonCriticalOwnerEchoFloor: null,
      ownerStampFloor: null,
      ownerUpdates: ownerMovementUpdates,
    };
  }
  const currentRawDispatchStamp = toDestinyStamp(options.currentRawDispatchStamp);
  const liveOwnerSessionStamp = toDestinyStamp(options.liveOwnerSessionStamp);
  const currentVisibleOwnerStamp = toDestinyStamp(options.currentVisibleOwnerStamp);
  const currentPresentedOwnerStamp = toDestinyStamp(
    options.currentPresentedOwnerStamp,
  );
  const readOptionalStamp = (key) => resolveOptionalDestinyStamp(options[key]);
  const previousLastSentDestinyWasOwnerCritical =
    options.previousLastSentDestinyWasOwnerCritical === true;
  const quietWindowMinimumStamp = readOptionalStamp("quietWindowMinimumStamp");
  const lastFreshAcquireLifecycleStamp = readOptionalStamp(
    "lastFreshAcquireLifecycleStamp",
  );
  const lastOwnerNonMissileCriticalStamp = readOptionalStamp(
    "lastOwnerNonMissileCriticalStamp",
  );
  const lastOwnerNonMissileCriticalRawDispatchStamp = readOptionalStamp(
    "lastOwnerNonMissileCriticalRawDispatchStamp",
  );
  const lastOwnerMissileLifecycleStamp = readOptionalStamp(
    "lastOwnerMissileLifecycleStamp",
  );
  const lastOwnerMissileLifecycleRawDispatchStamp = readOptionalStamp(
    "lastOwnerMissileLifecycleRawDispatchStamp",
  );
  const lastOwnerMissileFreshAcquireStamp = readOptionalStamp(
    "lastOwnerMissileFreshAcquireStamp",
  );
  const lastOwnerMissileFreshAcquireRawDispatchStamp = readOptionalStamp(
    "lastOwnerMissileFreshAcquireRawDispatchStamp",
  );
  const previousOwnerPilotCommandStamp = readOptionalStamp(
    "previousOwnerPilotCommandStamp",
  );
  const previousOwnerPilotCommandAnchorStamp = readOptionalStamp(
    "previousOwnerPilotCommandAnchorStamp",
  );
  const previousOwnerPilotCommandRawDispatchStamp = readOptionalStamp(
    "previousOwnerPilotCommandRawDispatchStamp",
  );
  const previousOwnerPilotCommandDirectionRaw =
    options.previousOwnerPilotCommandDirectionRaw;
  const normalizeVector =
    typeof options.normalizeVector === "function"
      ? options.normalizeVector
      : (vector, fallback) => {
        const base =
          vector && typeof vector === "object" ? vector : fallback || { x: 1, y: 0, z: 0 };
        const x = toFiniteNumber(base.x, 0);
        const y = toFiniteNumber(base.y, 0);
        const z = toFiniteNumber(base.z, 0);
        const magnitude = Math.sqrt((x * x) + (y * y) + (z * z));
        if (magnitude <= 0) {
          return {
            x: toFiniteNumber(fallback && fallback.x, 1),
            y: toFiniteNumber(fallback && fallback.y, 0),
            z: toFiniteNumber(fallback && fallback.z, 0),
          };
        }
        return {
          x: x / magnitude,
          y: y / magnitude,
          z: z / magnitude,
        };
      };
  const directionsNearlyMatch =
    typeof options.directionsNearlyMatch === "function"
      ? options.directionsNearlyMatch
      : (left, right, minimumDot = OWNER_PENDING_GOTO_DUPLICATE_ALIGNMENT) => {
        const normalizedLeft = normalizeVector(left, { x: 1, y: 0, z: 0 });
        const normalizedRight = normalizeVector(right, { x: 1, y: 0, z: 0 });
        const dot =
          (normalizedLeft.x * normalizedRight.x) +
          (normalizedLeft.y * normalizedRight.y) +
          (normalizedLeft.z * normalizedRight.z);
        return dot >= minimumDot;
      };
  const getPendingHistorySafeStamp =
    typeof options.getPendingHistorySafeStamp === "function"
      ? options.getPendingHistorySafeStamp
      : (authoredStamp) => toDestinyStamp(authoredStamp);
  const defaultRight =
    options.defaultRight && typeof options.defaultRight === "object"
      ? options.defaultRight
      : { x: 1, y: 0, z: 0 };

  // Michelle's direct-critical held-future window is still the base owner echo
  // contract. Plain moving CmdGotoDirection is the one remaining exception:
  // that path is not locally predicted by the client ship ball, so a +1 echo
  // can still arrive as current-1 under combat churn. Let callers explicitly
  // lift that path to Michelle's held-future +2 lane without changing the
  // locally-predicted steering contract.
  const ownerDirectEchoLead = Math.max(
    0,
    toInt(
      options.ownerDirectEchoLeadOverride,
      MICHELLE_DIRECT_CRITICAL_ECHO_DESTINY_LEAD,
    ),
  );
  const ownerDirectEchoBaseFloor = advanceDestinyStamp(
    liveOwnerSessionStamp,
    ownerDirectEchoLead,
  );
  const ownerDirectEchoMinimumStamp = ownerMovementUpdates.length > 0
    ? selectFurthestPresentDestinyStamp(
        liveOwnerSessionStamp,
        [
          ownerDirectEchoBaseFloor,
          ...ownerMovementUpdates.flatMap((update) => {
            const authoredStamp = toDestinyStamp(update && update.stamp);
            const pendingHistorySafeStamp = getPendingHistorySafeStamp(
              authoredStamp,
              ownerDirectEchoLead,
            );
            return [
              authoredStamp,
              hasDestinyStamp(pendingHistorySafeStamp)
                ? toDestinyStamp(pendingHistorySafeStamp)
                : null,
            ];
          }),
        ],
        DESTINY_STAMP_MAX_FORWARD_LEAD,
      )
    : null;
  const currentOwnerPilotCommandDirection = ownerMovementUpdates.reduce(
    (latestDirection, update) => {
      const payload =
        update && Array.isArray(update.payload) ? update.payload : null;
      if (!payload || payload[0] !== "GotoDirection") {
        return latestDirection;
      }
      const args = Array.isArray(payload[1]) ? payload[1] : null;
      if (!args || args.length < 4) {
        return latestDirection;
      }
      return normalizeVector(
        {
          x: toFiniteNumber(
            args[1] && typeof args[1] === "object" ? args[1].value : args[1],
            0,
          ),
          y: toFiniteNumber(
            args[2] && typeof args[2] === "object" ? args[2].value : args[2],
            0,
          ),
          z: toFiniteNumber(
            args[3] && typeof args[3] === "object" ? args[3].value : args[3],
            0,
          ),
        },
        latestDirection || defaultRight,
      );
    },
    null,
  );
  const previousOwnerPilotCommandDirection =
    ownerHasSteeringCommand &&
    isDestinyStampWithinRelativeWindow(
      liveOwnerSessionStamp,
      previousOwnerPilotCommandStamp,
      0,
      DESTINY_STAMP_MAX_FORWARD_LEAD,
    ) &&
    previousOwnerPilotCommandAnchorStamp !== null &&
    previousOwnerPilotCommandDirectionRaw
      ? normalizeVector(
          previousOwnerPilotCommandDirectionRaw,
          currentOwnerPilotCommandDirection || defaultRight,
        )
      : null;
  const repeatedOwnerPilotCommandLane =
    ownerHasSteeringCommand &&
    isDestinyStampAfter(
      liveOwnerSessionStamp,
      previousOwnerPilotCommandStamp,
      DESTINY_STAMP_MAX_FORWARD_LEAD,
    ) &&
    previousOwnerPilotCommandAnchorStamp === liveOwnerSessionStamp &&
    previousOwnerPilotCommandDirection &&
    currentOwnerPilotCommandDirection &&
    directionsNearlyMatch(
      previousOwnerPilotCommandDirection,
      currentOwnerPilotCommandDirection,
      OWNER_PENDING_GOTO_DUPLICATE_ALIGNMENT,
    )
      ? previousOwnerPilotCommandStamp
      : null;
  // `client/jolty16.txt` showed one more owner-lane edge case: the last held
  // plain `CmdGotoDirection` could still be reused after some newer owner tick
  // had already been presented to Michelle. The visible clock can still sit on
  // the older session stamp while the presented lane has moved on, so guard
  // reuse/suppression against the newer presented owner tick as well.
  const ownerMovementPlanningAnchorStamp = advanceDestinyStamp(
    liveOwnerSessionStamp,
    -1,
  );
  const ownerPilotCommandReuseFloor = selectFurthestPresentDestinyStamp(
    ownerMovementPlanningAnchorStamp,
    [currentVisibleOwnerStamp, currentPresentedOwnerStamp],
    DESTINY_STAMP_MAX_FORWARD_LEAD + 1,
  );
  const isStampAtOrAfterFloor = (
    candidateStamp,
    floorStamp,
    maximumLead = DESTINY_STAMP_MAX_FORWARD_LEAD,
    anchorStamp = liveOwnerSessionStamp,
  ) => {
    if (!hasDestinyStamp(candidateStamp) || !hasDestinyStamp(floorStamp)) {
      return false;
    }
    const candidateDistance = getDestinyStampForwardDistance(
      anchorStamp,
      candidateStamp,
    );
    const floorDistance = getDestinyStampForwardDistance(anchorStamp, floorStamp);
    return candidateDistance <= maximumLead &&
      floorDistance <= maximumLead &&
      candidateDistance >= floorDistance;
  };
  const previousOwnerPilotCommandRawDispatchDelta = getRecentDestinyStampDelta(
    previousOwnerPilotCommandRawDispatchStamp,
    currentRawDispatchStamp,
    1,
  );
  // Adjacent-raw plain CmdGotoDirection input can still safely reuse the
  // immediately pending held-future owner lane while that lane has not yet
  // been presented to Michelle, or when the new heading is effectively the
  // same steer. Once that same future lane is already on the presented
  // surface, reusing it for a genuinely distinct re-aim creates the
  // `jolty99` live shape where Michelle consumes the first future steer and
  // then rewinds when later raw ticks replay older copies of that same
  // visible lane.
  const reusableHeldOwnerPilotCommandLane =
    ownerHasSteeringCommand &&
    ownerDirectEchoLead > MICHELLE_DIRECT_CRITICAL_ECHO_DESTINY_LEAD &&
    isStampAtOrAfterFloor(
      previousOwnerPilotCommandStamp,
      ownerPilotCommandReuseFloor,
      DESTINY_STAMP_MAX_FORWARD_LEAD + 1,
      ownerMovementPlanningAnchorStamp,
    ) &&
    previousOwnerPilotCommandRawDispatchDelta === 1 &&
    previousOwnerPilotCommandAnchorStamp !== null &&
    advanceDestinyStamp(previousOwnerPilotCommandAnchorStamp, 1) ===
      liveOwnerSessionStamp &&
    previousOwnerPilotCommandDirection &&
    currentOwnerPilotCommandDirection &&
    (
      isDestinyStampAfter(
        currentPresentedOwnerStamp,
        previousOwnerPilotCommandStamp,
        DESTINY_STAMP_MAX_FORWARD_LEAD,
      ) ||
      directionsNearlyMatch(
        previousOwnerPilotCommandDirection,
        currentOwnerPilotCommandDirection,
        OWNER_PENDING_GOTO_DUPLICATE_ALIGNMENT,
      )
    ) &&
    (
      previousOwnerPilotCommandStamp === liveOwnerSessionStamp ||
      advanceDestinyStamp(previousOwnerPilotCommandStamp, 1) ===
        ownerDirectEchoMinimumStamp
    ) &&
    repeatedOwnerPilotCommandLane === null
      ? previousOwnerPilotCommandStamp
      : null;
  // Preserve owner steering order across raw dispatches. `client/jolt13.txt`
  // showed that once a distinct owner `GotoDirection` is already pending on a
  // future tick, reusing that same future tick for a later distinct heading
  // lets Michelle process one steer on time and then rewind when another
  // packet for that already-consumed tick arrives later. The parity-safe
  // contract is:
  // - same raw dispatch: keep the first owner echo and only update direction
  // - later raw dispatch, true duplicate / near-duplicate heading: reuse the
  //   pending future tick
  // - later raw dispatch, distinct heading: advance beyond the pending future
  //   owner steer
  const nextDistinctOwnerPilotCommandLane =
    ownerHasSteeringCommand &&
    isDestinyStampAfter(
      liveOwnerSessionStamp,
      previousOwnerPilotCommandStamp,
      DESTINY_STAMP_MAX_FORWARD_LEAD,
    ) &&
    previousOwnerPilotCommandRawDispatchDelta === 1 &&
    previousOwnerPilotCommandDirection &&
    currentOwnerPilotCommandDirection &&
    reusableHeldOwnerPilotCommandLane === null &&
    repeatedOwnerPilotCommandLane === null
      ? advanceDestinyStamp(previousOwnerPilotCommandStamp, 1)
      : null;
  const suppressSameRawDistinctFutureOwnerEcho =
    ownerHasSteeringCommand &&
    isStampAtOrAfterFloor(
      previousOwnerPilotCommandStamp,
      ownerPilotCommandReuseFloor,
      DESTINY_STAMP_MAX_FORWARD_LEAD + 1,
      ownerMovementPlanningAnchorStamp,
    ) &&
    previousOwnerPilotCommandRawDispatchStamp !== null &&
    previousOwnerPilotCommandRawDispatchStamp === currentRawDispatchStamp &&
    previousOwnerPilotCommandDirection &&
    currentOwnerPilotCommandDirection &&
    repeatedOwnerPilotCommandLane === null;
  const earlierTickOwnerPilotCommandMatches =
    previousOwnerPilotCommandDirection &&
    currentOwnerPilotCommandDirection &&
    directionsNearlyMatch(
      previousOwnerPilotCommandDirection,
      currentOwnerPilotCommandDirection,
      OWNER_PENDING_GOTO_DUPLICATE_ALIGNMENT,
    );
  const ownerVisibleStamp = currentVisibleOwnerStamp;
  // Fresh-acquire `AddBalls2` presentation already consumes Michelle's held
  // future tick. If owner steering reuses that same presented stamp, the pilot
  // can advance locally through the wreck-add tick and then rebase backward
  // when the older `GotoDirection` finally executes. Keep immediate
  // post-fresh-acquire steering on the first tick after the acquire lane.
  const recentPresentedFreshAcquireLane =
    ownerHasSteeringCommand &&
    isDestinyStampWithinRelativeWindow(
      currentVisibleOwnerStamp,
      lastFreshAcquireLifecycleStamp,
      1,
      MICHELLE_HELD_FUTURE_DESTINY_LEAD,
    )
      ? lastFreshAcquireLifecycleStamp
      : null;
  const postFreshAcquireOwnerSteeringFloor =
    recentPresentedFreshAcquireLane !== null
      ? selectFurthestPresentDestinyStamp(
          liveOwnerSessionStamp,
          [
            ownerDirectEchoMinimumStamp,
            advanceDestinyStamp(recentPresentedFreshAcquireLane, 1),
          ],
          DESTINY_STAMP_MAX_FORWARD_LEAD,
        )
      : null;
  const recentOwnerNonMissileCriticalLane = getRecentTrustedLane({
    laneStamp: lastOwnerNonMissileCriticalStamp,
    currentStamp: liveOwnerSessionStamp,
    currentRawDispatchStamp,
    laneRawDispatchStamp: lastOwnerNonMissileCriticalRawDispatchStamp,
    maximumLead: MICHELLE_HELD_FUTURE_DESTINY_LEAD,
    maximumRawDispatchDelta: 2,
  });
  const recentOwnerMissileLifecycleLane = getRecentTrustedLane({
    laneStamp: lastOwnerMissileLifecycleStamp,
    currentStamp: liveOwnerSessionStamp,
    currentRawDispatchStamp,
    laneRawDispatchStamp: lastOwnerMissileLifecycleRawDispatchStamp,
    maximumLead: MICHELLE_HELD_FUTURE_DESTINY_LEAD,
    maximumRawDispatchDelta: 2,
  });
  const recentOwnerFreshAcquireLane = getRecentTrustedLane({
    laneStamp: lastOwnerMissileFreshAcquireStamp,
    currentStamp: liveOwnerSessionStamp,
    currentRawDispatchStamp,
    laneRawDispatchStamp: lastOwnerMissileFreshAcquireRawDispatchStamp,
    maximumLead: MICHELLE_HELD_FUTURE_DESTINY_LEAD,
    maximumRawDispatchDelta: 2,
  });
  // Owner steering must never backstep under an already-buffered owner-
  // critical tick that Michelle can still legally hold in the shared +1/+2
  // window. This keeps owner steering, owner missile lifecycle, and owner
  // fresh-acquire traffic on one monotonic client-visible timeline without
  // reintroducing custom far-ahead lanes.
  const recentBufferedOwnerCriticalFloor =
    selectFurthestPresentDestinyStamp(
      liveOwnerSessionStamp,
      [
        recentOwnerNonMissileCriticalLane,
        recentOwnerMissileLifecycleLane,
        recentOwnerFreshAcquireLane,
      ],
      MICHELLE_HELD_FUTURE_DESTINY_LEAD,
    );
  // `client/awful.txt` and `client/jolty11.txt` exposed the remaining plain
  // CmdGotoDirection parity gap. The non-predicted owner steer still needs the
  // held-future +2 base lead, but once a same-session noncritical / owner-
  // critical lane has already advanced Michelle we only need to clear the next
  // owner-visible tick beyond the highest already-consumed owner lane. The
  // regression was re-adding the full lead on top of the presented lane, which
  // created stale 1888/5301 owner echoes and later recovery SetState windows.
  const presentedNonCriticalOwnerEchoFloor =
    ownerHasSteeringCommand &&
    ownerDirectEchoLead > MICHELLE_DIRECT_CRITICAL_ECHO_DESTINY_LEAD &&
    previousLastSentDestinyWasOwnerCritical !== true &&
    isDestinyStampAfter(
      liveOwnerSessionStamp,
      currentPresentedOwnerStamp,
      DESTINY_STAMP_MAX_FORWARD_LEAD,
    )
      ? advanceDestinyStamp(
          selectFurthestPresentDestinyStamp(
            liveOwnerSessionStamp,
            [
              ownerDirectEchoMinimumStamp,
              clampDestinyStampToCeiling(
                liveOwnerSessionStamp,
                currentPresentedOwnerStamp,
                advanceDestinyStamp(liveOwnerSessionStamp, ownerDirectEchoLead),
              ),
              recentBufferedOwnerCriticalFloor,
            ],
            DESTINY_STAMP_MAX_FORWARD_LEAD,
          ),
          1,
        )
      : null;
  const ownerMinimumStamp = ownerMovementUpdates.reduce((highestMinimumStamp, update) => {
    const authoredStamp = toDestinyStamp(update && update.stamp);
    if (quietWindowMinimumStamp !== null) {
      return selectFurthestPresentDestinyStamp(
        ownerMovementPlanningAnchorStamp,
        [highestMinimumStamp, quietWindowMinimumStamp],
        DESTINY_STAMP_MAX_FORWARD_LEAD + 1,
      );
    }
    if (!ownerHasSteeringCommand) {
      return highestMinimumStamp;
    }
    if (
      isStampAtOrAfterFloor(
        authoredStamp,
        ownerVisibleStamp,
        DESTINY_STAMP_MAX_FORWARD_LEAD + 1,
        ownerMovementPlanningAnchorStamp,
      )
    ) {
      return highestMinimumStamp;
    }
    const pendingHistorySafeStamp = getPendingHistorySafeStamp(authoredStamp, 0);
    return selectFurthestPresentDestinyStamp(
      ownerMovementPlanningAnchorStamp,
      [
        highestMinimumStamp,
        ownerVisibleStamp,
        hasDestinyStamp(pendingHistorySafeStamp)
          ? toDestinyStamp(pendingHistorySafeStamp)
          : null,
      ],
      DESTINY_STAMP_MAX_FORWARD_LEAD + 1,
    );
  }, null);
  // Owner-issued movement control packets are still Michelle-critical even
  // when they are not steering payloads. `client/jolt4.txt` showed Stop /
  // SetSpeedFraction / SetBallVelocity landing on the raw current tick while
  // Michelle had already advanced to the next presented tick, which forced a
  // rewind before the stop contract could apply. Keep those owner control
  // packets on the same direct-critical echo floor used by steering updates so
  // the stop/speed contract lands inside Michelle's held-future window instead
  // of behind it.
  const ownerStampFloor =
    reusableHeldOwnerPilotCommandLane !== null
      ? selectFurthestPresentDestinyStamp(
          ownerMovementPlanningAnchorStamp,
          [
            ownerMinimumStamp,
            presentedNonCriticalOwnerEchoFloor,
            postFreshAcquireOwnerSteeringFloor,
            recentBufferedOwnerCriticalFloor,
            repeatedOwnerPilotCommandLane,
            reusableHeldOwnerPilotCommandLane,
          ],
          DESTINY_STAMP_MAX_FORWARD_LEAD + 1,
        )
      : selectFurthestPresentDestinyStamp(
          ownerMovementPlanningAnchorStamp,
          [
            ownerMinimumStamp,
            ownerDirectEchoMinimumStamp,
            presentedNonCriticalOwnerEchoFloor,
            postFreshAcquireOwnerSteeringFloor,
            recentBufferedOwnerCriticalFloor,
            repeatedOwnerPilotCommandLane,
            nextDistinctOwnerPilotCommandLane,
          ],
          DESTINY_STAMP_MAX_FORWARD_LEAD + 1,
        );
  const ownerUpdates = ownerMovementUpdates.map((update) => ({
    ...update,
    stamp: selectFurthestPresentDestinyStamp(
      ownerMovementPlanningAnchorStamp,
      [toDestinyStamp(update && update.stamp), ownerStampFloor],
      DESTINY_STAMP_MAX_FORWARD_LEAD + 1,
    ),
  }));

  return {
    currentOwnerPilotCommandDirection,
    previousOwnerPilotCommandDirection,
    ownerDirectEchoMinimumStamp,
    repeatedOwnerPilotCommandLane,
    reusableHeldOwnerPilotCommandLane,
    nextDistinctOwnerPilotCommandLane,
    suppressSameRawDistinctFutureOwnerEcho,
    earlierTickOwnerPilotCommandMatches,
    recentPresentedFreshAcquireLane,
    recentOwnerNonMissileCriticalLane,
    recentOwnerMissileLifecycleLane,
    recentOwnerFreshAcquireLane,
    recentBufferedOwnerCriticalFloor,
    ownerVisibleStamp,
    ownerMinimumStamp,
    postFreshAcquireOwnerSteeringFloor,
    presentedNonCriticalOwnerEchoFloor,
    ownerStampFloor,
    ownerUpdates,
  };
}

function resolveDestinyLifecycleRestampState(options = {}) {
  const isFreshAcquireLifecycleGroup =
    options.isFreshAcquireLifecycleGroup === true;
  const isMissileLifecycleGroup =
    options.isMissileLifecycleGroup === true;
  const isOwnerMissileLifecycleGroup =
    options.isOwnerMissileLifecycleGroup === true;
  const minimumPostFreshAcquireStamp = hasDestinyStamp(
    options.minimumPostFreshAcquireStamp,
  )
    ? toDestinyStamp(options.minimumPostFreshAcquireStamp)
    : null;
  const localStamp = hasDestinyStamp(options.localStamp)
    ? toDestinyStamp(options.localStamp)
    : null;
  if (
    localStamp === null ||
    !hasRequiredDestinyStamps(
      options.currentSessionStamp,
      options.currentImmediateSessionStamp,
      options.currentRawDispatchStamp,
    )
  ) {
    return {
      finalStamp: localStamp,
      recentOwnerMovementLane: null,
      freshAcquireFloor: null,
      missileLifecycleFloor: null,
      ownerMissileLifecycleFloor: null,
    };
  }
  const currentSessionStamp = toDestinyStamp(options.currentSessionStamp);
  const currentImmediateSessionStamp = toDestinyStamp(
    options.currentImmediateSessionStamp,
  );
  const currentRawDispatchStamp = toDestinyStamp(options.currentRawDispatchStamp);
  const readOptionalStamp = (key) => resolveOptionalDestinyStamp(options[key]);
  const lastFreshAcquireLifecycleStamp = readOptionalStamp(
    "lastFreshAcquireLifecycleStamp",
  );
  const lastMissileLifecycleStamp = readOptionalStamp(
    "lastMissileLifecycleStamp",
  );
  const lastOwnerMissileLifecycleStamp = readOptionalStamp(
    "lastOwnerMissileLifecycleStamp",
  );
  const lastOwnerMissileFreshAcquireStamp = readOptionalStamp(
    "lastOwnerMissileFreshAcquireStamp",
  );
  const lastOwnerMissileFreshAcquireRawDispatchStamp = readOptionalStamp(
    "lastOwnerMissileFreshAcquireRawDispatchStamp",
  );
  const lastOwnerMissileLifecycleRawDispatchStamp = readOptionalStamp(
    "lastOwnerMissileLifecycleRawDispatchStamp",
  );
  const previousLastSentDestinyStamp = readOptionalStamp(
    "previousLastSentDestinyStamp",
  );
  const previousLastSentDestinyRawDispatchStamp = readOptionalStamp(
    "previousLastSentDestinyRawDispatchStamp",
  );
  const previousLastSentDestinyWasOwnerCritical =
    options.previousLastSentDestinyWasOwnerCritical === true;
  const lastOwnerPilotCommandMovementStamp = readOptionalStamp(
    "lastOwnerPilotCommandMovementStamp",
  );
  const lastOwnerPilotCommandMovementRawDispatchStamp = readOptionalStamp(
    "lastOwnerPilotCommandMovementRawDispatchStamp",
  );

  let workingLocalStamp = localStamp;
  let freshAcquireFloor = null;
  let missileLifecycleFloor = null;
  let ownerMissileLifecycleFloor = null;

  const maximumTrustedOwnerMovementLane = advanceDestinyStamp(
    currentSessionStamp,
    MICHELLE_HELD_FUTURE_DESTINY_LEAD,
  );
  const minimumTrustedOwnerMovementLane = advanceDestinyStamp(
    currentSessionStamp,
    -1,
  );
  const ownerMovementRawDelta = getRecentDestinyStampDelta(
    lastOwnerPilotCommandMovementRawDispatchStamp,
    currentRawDispatchStamp,
    2,
  );
  const recentOwnerMovementLane =
    isDestinyStampWithinRelativeWindow(
      currentSessionStamp,
      lastOwnerPilotCommandMovementStamp,
      -1,
      MICHELLE_HELD_FUTURE_DESTINY_LEAD,
    ) && (
      ownerMovementRawDelta !== null ||
      lastOwnerPilotCommandMovementRawDispatchStamp === null
    )
      ? lastOwnerPilotCommandMovementStamp
      : null;
  const recentOwnerMissileLifecycleLane = getRecentTrustedLane({
    laneStamp: lastOwnerMissileLifecycleStamp,
    currentStamp: currentImmediateSessionStamp,
    currentRawDispatchStamp,
    laneRawDispatchStamp: lastOwnerMissileLifecycleRawDispatchStamp,
    maximumLead: MICHELLE_HELD_FUTURE_DESTINY_LEAD,
    maximumRawDispatchDelta: 2,
  });
  const recentOwnerFreshAcquireLane = getRecentTrustedLane({
    laneStamp: lastOwnerMissileFreshAcquireStamp,
    currentStamp: currentImmediateSessionStamp,
    currentRawDispatchStamp,
    laneRawDispatchStamp: lastOwnerMissileFreshAcquireRawDispatchStamp,
    maximumLead: MICHELLE_HELD_FUTURE_DESTINY_LEAD,
    maximumRawDispatchDelta: 2,
  });
  const previousLastSentDestinyMatchesKnownOwnerCriticalLane =
    previousLastSentDestinyStamp !== null &&
    (
      previousLastSentDestinyWasOwnerCritical === true ||
      previousLastSentDestinyStamp === lastOwnerPilotCommandMovementStamp ||
      previousLastSentDestinyStamp === lastOwnerMissileLifecycleStamp ||
      previousLastSentDestinyStamp === lastOwnerMissileFreshAcquireStamp
    );
  const recentOverallOwnerCriticalLane =
    previousLastSentDestinyMatchesKnownOwnerCriticalLane
      ? getRecentTrustedLane({
          laneStamp: previousLastSentDestinyStamp,
          currentStamp: currentImmediateSessionStamp,
          currentRawDispatchStamp,
          laneRawDispatchStamp: previousLastSentDestinyRawDispatchStamp,
          maximumLead: MICHELLE_HELD_FUTURE_DESTINY_LEAD,
          maximumRawDispatchDelta: 2,
        })
      : null;
  const recentOwnerCriticalFloor = selectFurthestPresentDestinyStamp(
    currentImmediateSessionStamp,
    [
      recentOwnerMovementLane,
      recentOwnerMissileLifecycleLane,
      recentOwnerFreshAcquireLane,
      recentOverallOwnerCriticalLane,
    ],
    DESTINY_STAMP_MAX_FORWARD_LEAD,
  );

  if (isFreshAcquireLifecycleGroup) {
    const reusableFreshAcquireLane =
      isDestinyStampWithinRelativeWindow(
        currentSessionStamp,
        lastFreshAcquireLifecycleStamp,
        1,
        MICHELLE_HELD_FUTURE_DESTINY_LEAD,
      )
        ? lastFreshAcquireLifecycleStamp
        : null;
    const ownerFreshAcquireHeldCeiling =
      isOwnerMissileLifecycleGroup
        ? advanceDestinyStamp(
            currentSessionStamp,
            MICHELLE_HELD_FUTURE_DESTINY_LEAD,
          )
        : null;
    // `jolt222.txt`: launcher-owner missile acquires can still arrive as
    // separate notifications inside the same raw dispatch. Reusing the exact
    // same held-future fresh-acquire lane after we've already emitted it once
    // in that raw tick leaves the later AddBalls2 vulnerable to arriving after
    // Michelle has already consumed and rebased that lane. Clear the shared
    // lane once, but clamp to the held-future ceiling so dense volleys do not
    // run off into +3/+4 lanes.
    const ownerSameRawFreshAcquireClearFloor =
      isOwnerMissileLifecycleGroup &&
      reusableFreshAcquireLane !== null &&
      previousLastSentDestinyStamp === reusableFreshAcquireLane &&
      previousLastSentDestinyRawDispatchStamp === currentRawDispatchStamp
        ? clampDestinyStampToCeiling(
            currentSessionStamp,
            advanceDestinyStamp(reusableFreshAcquireLane, 1),
            ownerFreshAcquireHeldCeiling,
          )
        : null;
    const freshAcquireHistorySafeFloor = advanceDestinyStamp(
      isOwnerMissileLifecycleGroup
        ? currentImmediateSessionStamp
        : currentSessionStamp,
      MICHELLE_HELD_FUTURE_DESTINY_LEAD,
    );
    const resolvedFreshAcquireFloor =
      reusableFreshAcquireLane !== null &&
      ownerSameRawFreshAcquireClearFloor === null
        ? reusableFreshAcquireLane
        : selectFurthestPresentDestinyStamp(
            currentSessionStamp,
            [
              workingLocalStamp,
              freshAcquireHistorySafeFloor,
              recentOwnerCriticalFloor !== null
                ? advanceDestinyStamp(recentOwnerCriticalFloor, 1)
                : null,
              ownerSameRawFreshAcquireClearFloor,
              minimumPostFreshAcquireStamp,
            ],
            DESTINY_STAMP_MAX_FORWARD_LEAD,
          );
    freshAcquireFloor = {
      reusableFreshAcquireLane,
      ownerFreshAcquireHeldCeiling,
      ownerSameRawFreshAcquireClearFloor,
      freshAcquireHistorySafeFloor,
      recentOwnerCriticalFloor,
      freshAcquireFloor: resolvedFreshAcquireFloor,
    };
    workingLocalStamp = resolvedFreshAcquireFloor;
  }

  if (isMissileLifecycleGroup && !isOwnerMissileLifecycleGroup) {
    // Observer-visible missile lifecycle must stay inside Michelle's held
    // future window. Delta 3 is the visible jolt threshold, so both the
    // reuse window and the default floor must stay at session+2, not +3.
    const reusableMissileLifecycleLane =
      isDestinyStampWithinRelativeWindow(
        currentSessionStamp,
        lastMissileLifecycleStamp,
        1,
        MICHELLE_HELD_FUTURE_DESTINY_LEAD,
      )
        ? lastMissileLifecycleStamp
        : null;
    const resolvedMissileLifecycleFloor =
      reusableMissileLifecycleLane !== null
        ? reusableMissileLifecycleLane
        : selectFurthestPresentDestinyStamp(
            currentSessionStamp,
            [
              workingLocalStamp,
              advanceDestinyStamp(
                currentSessionStamp,
                MICHELLE_HELD_FUTURE_DESTINY_LEAD,
              ),
              recentOwnerMovementLane !== null
                ? advanceDestinyStamp(recentOwnerMovementLane, 1)
                : null,
            ],
            DESTINY_STAMP_MAX_FORWARD_LEAD,
          );
    missileLifecycleFloor = {
      reusableMissileLifecycleLane,
      recentOwnerMovementLane,
      missileLifecycleFloor: resolvedMissileLifecycleFloor,
    };
    workingLocalStamp = resolvedMissileLifecycleFloor;
  }

  if (isOwnerMissileLifecycleGroup) {
    const requiredOwnerFloor = selectFurthestPresentDestinyStamp(
      currentImmediateSessionStamp,
      [
        minimumPostFreshAcquireStamp,
        advanceDestinyStamp(
          currentImmediateSessionStamp,
          MICHELLE_HELD_FUTURE_DESTINY_LEAD,
        ),
        recentOwnerCriticalFloor,
      ],
      DESTINY_STAMP_MAX_FORWARD_LEAD,
    );
    const resolvedOwnerMissileLifecycleFloor = requiredOwnerFloor;
    const normalizedOwnerMissileStamp = selectFurthestPresentDestinyStamp(
      currentImmediateSessionStamp,
      [workingLocalStamp, resolvedOwnerMissileLifecycleFloor],
      DESTINY_STAMP_MAX_FORWARD_LEAD,
    );
    ownerMissileLifecycleFloor = {
      currentSessionStamp,
      currentImmediateSessionStamp,
      recentOwnerMovementLane,
      recentOwnerMissileLifecycleLane,
      recentOwnerFreshAcquireLane,
      recentOverallOwnerCriticalLane,
      recentOwnerCriticalFloor,
      requiredOwnerFloor,
      ownerCombatFloor: resolvedOwnerMissileLifecycleFloor,
      normalizedOwnerMissileStamp,
    };
    workingLocalStamp = normalizedOwnerMissileStamp;
  }

  return {
    finalStamp: toDestinyStamp(workingLocalStamp),
    recentOwnerMovementLane,
    freshAcquireFloor,
    missileLifecycleFloor,
    ownerMissileLifecycleFloor,
  };
}

function resolveDamageStateDispatchStamp(options = {}) {
  const visibleStamp = hasDestinyStamp(options.visibleStamp)
    ? toDestinyStamp(options.visibleStamp)
    : null;
  if (
    visibleStamp === null ||
    !hasDestinyStamp(options.currentRawDispatchStamp)
  ) {
    return {
      directCriticalEchoStamp: null,
      maximumHeldFutureDamageStamp: null,
      presentedDamageClearFloor: null,
      sameRawPresentedDamageReuseClearFloor: null,
      projectedPresentedDamageClearFloor: null,
      finalStamp: visibleStamp,
    };
  }
  const currentPresentedStamp = hasDestinyStamp(options.currentPresentedStamp)
    ? toDestinyStamp(options.currentPresentedStamp)
    : null;
  const previousLastSentDestinyStamp = hasDestinyStamp(
    options.previousLastSentDestinyStamp,
  ) ? toDestinyStamp(options.previousLastSentDestinyStamp) : null;
  const previousLastSentDestinyRawDispatchStamp = hasDestinyStamp(
    options.previousLastSentDestinyRawDispatchStamp,
  ) ? toDestinyStamp(options.previousLastSentDestinyRawDispatchStamp) : null;
  const currentRawDispatchStamp = toDestinyStamp(options.currentRawDispatchStamp);
  const directCriticalEchoStamp = advanceDestinyStamp(
    visibleStamp,
    MICHELLE_DIRECT_CRITICAL_ECHO_DESTINY_LEAD,
  );
  const maximumHeldFutureDamageStamp = advanceDestinyStamp(
    visibleStamp,
    MICHELLE_HELD_FUTURE_DESTINY_LEAD,
  );
  // Damage-state is a non-critical lane for both owners and observers.
  // `client/more.txt` showed the owner shape, and `client/here.txt` showed the
  // observer equivalent: once Michelle has already presented a later lane,
  // blindly reusing `visible + 1` lands `OnDamageStateChange` behind current
  // history. Keep damage inside Michelle's held-future window, but clear
  // already-presented / already-consumed same-raw lanes instead of blindly
  // reusing `visible + 1`.
  const presentedDamageClearFloor =
    currentPresentedStamp !== null &&
    isDestinyStampAfter(directCriticalEchoStamp, currentPresentedStamp)
      ? clampDestinyStampToCeiling(
          visibleStamp,
          currentPresentedStamp,
          maximumHeldFutureDamageStamp,
        )
      : null;
  const sameRawPresentedDamageReuseClearFloor =
    previousLastSentDestinyStamp !== null &&
    currentPresentedStamp !== null &&
    previousLastSentDestinyStamp === currentPresentedStamp &&
    previousLastSentDestinyRawDispatchStamp !== null &&
    previousLastSentDestinyRawDispatchStamp === currentRawDispatchStamp
      ? clampDestinyStampToCeiling(
          visibleStamp,
          advanceDestinyStamp(currentPresentedStamp, 1),
          maximumHeldFutureDamageStamp,
        )
      : null;
  // `client/funky.txt` still had owner damage-state arriving one lane behind a
  // freshly projected owner movement lane:
  //   damage 1775153614 - current 1775153615
  //   damage 1775153685 - current 1775153686
  // In both windows we had already emitted the previous presented lane on the
  // prior raw dispatch, so Michelle had effectively consumed `presented + 1`
  // before the next OnDamageStateChange arrived. Clear that exact projected
  // lane, but only for the adjacent-raw case; this keeps damage monotonic with
  // recent owner steering without reopening the older far-future drift.
  const projectedPresentedDamageClearFloor =
    previousLastSentDestinyStamp !== null &&
    currentPresentedStamp !== null &&
    previousLastSentDestinyStamp === currentPresentedStamp &&
    previousLastSentDestinyRawDispatchStamp !== null &&
    getRecentDestinyStampDelta(
      previousLastSentDestinyRawDispatchStamp,
      currentRawDispatchStamp,
      1,
    ) === 1
      ? projectPreviouslySentDestinyLane(
          previousLastSentDestinyStamp,
          previousLastSentDestinyRawDispatchStamp,
          currentRawDispatchStamp,
        )
      : null;
  const finalStamp = selectFurthestPresentDestinyStamp(
    visibleStamp,
    [
      maximumHeldFutureDamageStamp,
      presentedDamageClearFloor,
      sameRawPresentedDamageReuseClearFloor,
      projectedPresentedDamageClearFloor,
    ],
    16,
  );
  return {
    directCriticalEchoStamp,
    maximumHeldFutureDamageStamp,
    presentedDamageClearFloor,
    sameRawPresentedDamageReuseClearFloor,
    projectedPresentedDamageClearFloor,
    finalStamp,
  };
}

const MOVEMENT_DELIVERY_POLICY = Object.freeze({
  DESTINY_STAMP_INTERVAL_MS,
  DESTINY_STAMP_MAX_LEAD,
  OWNER_PENDING_GOTO_DUPLICATE_ALIGNMENT,
});

module.exports = {
  MOVEMENT_DELIVERY_POLICY,
  ...MOVEMENT_DELIVERY_POLICY,
  projectPreviouslySentDestinyLane,
  resolvePreviousLastSentDestinyWasOwnerCritical,
  resolveProjectedRecentLastSentLane,
  getRecentTrustedLane,
  getRecentProjectedLane,
  resolveRecentOwnerLaneState,
  resolveOwnerMonotonicState,
  resolveGotoCommandSyncState,
  resolveOwnerMovementRestampState,
  resolveDestinyLifecycleRestampState,
  resolveDamageStateDispatchStamp,
};

// Keep the established enumerable policy surface stable for callers that use
// Object.keys while exposing the cross-package semantic scheduling boundary.
Object.defineProperty(module.exports, "resolveDelayedDestinyStampState", {
  configurable: false,
  enumerable: false,
  value: resolveDelayedDestinyStampState,
  writable: false,
});
