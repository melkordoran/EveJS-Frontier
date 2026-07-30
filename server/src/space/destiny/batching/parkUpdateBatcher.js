"use strict";

const path = require("path");

// Park batching behavior is adapted from carbonengine/destiny v3.1.1.
// Copyright (c) 2026 CCP Games; MIT terms are in batching/README.md.
const {
  buildPackagedActionUpdate,
} = require(path.join(__dirname, "./packagedAction"));
const {
  getEntityMapKey,
} = require(path.join(__dirname, "../identity/entityID"));
const {
  compareDestinyStamps,
  normalizeDestinyStamp,
} = require(path.join(__dirname, "../delivery/stamps"));
const {
  getPayloadPrimaryEntityID,
} = require(path.join(__dirname, "../protocol/payloadIdentity"));
const {
  DESTINY_NOTIFICATION_NAME,
} = require(path.join(__dirname, "../delivery/michelleContract"));

// CCP's ParkUpdateBatcher tells Michelle how many Destiny batches a client
// must wait for in the current tick. The target client does not expose that
// value on its live Michelle tuple, so these counts remain planner metadata.
const CLIENT_UPDATE_COUNT_THIS_TICK = Object.freeze({
  NONE: 0,
  ONE: 1,
  TWO: 2,
});

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function normalizeClientID(value) {
  return toInt(value, 0);
}

function normalizeClientIDs(values) {
  const seen = new Set();
  const result = [];
  for (const value of Array.isArray(values) ? values : [values]) {
    const clientID = normalizeClientID(value);
    if (clientID <= 0 || seen.has(clientID)) {
      continue;
    }
    seen.add(clientID);
    result.push(clientID);
  }
  return result;
}

function hasState(state) {
  return Array.isArray(state)
    ? state.length > 0
    : state !== undefined && state !== null && state !== false;
}

function buildDelivery(kind, clients, state, waitForBubble, updateCount, meta = {}) {
  return {
    kind,
    clients: normalizeClientIDs(clients),
    notificationName: DESTINY_NOTIFICATION_NAME,
    state,
    waitForBubble: waitForBubble === true,
    updateCount: toInt(updateCount, CLIENT_UPDATE_COUNT_THIS_TICK.ONE),
    ...meta,
  };
}

function normalizeBubbleHistories(bubbleHistories) {
  return (Array.isArray(bubbleHistories) ? bubbleHistories : [])
    .filter((entry) => entry && hasState(entry.state))
    .map((entry) => ({
      bubbleID: toInt(entry.bubbleID, 0),
      clientIDs: normalizeClientIDs(entry.clientIDs),
      state: entry.state,
    }))
    .filter((entry) => entry.clientIDs.length > 0);
}

function normalizeCharacterHistories(characterHistories) {
  return (Array.isArray(characterHistories) ? characterHistories : [])
    .filter((entry) => entry && hasState(entry.state))
    .map((entry) => ({
      characterID: toInt(entry.characterID, 0),
      clientID: normalizeClientID(entry.clientID),
      state: entry.state,
    }))
    .filter((entry) => entry.clientID > 0);
}

// Direct port of the official lane split. It returns a pure delivery plan;
// runtime dispatch remains the sole network adapter.
function buildParkUpdateDeliveryPlan(options = {}) {
  const bubbleHistories = normalizeBubbleHistories(options.bubbleHistories);
  const characterHistories = normalizeCharacterHistories(
    options.characterHistories,
  );
  const clientsWithCharacterHistory = new Set(
    characterHistories.map((entry) => entry.clientID),
  );
  const clientsWaitingForBubble = new Set();
  const singleBatchNarrowcasts = [];
  const dualBatchNarrowcasts = [];
  const singlecasts = [];

  for (const bubble of bubbleHistories) {
    const dualClients = [];
    const singleClients = [];
    for (const clientID of bubble.clientIDs) {
      if (clientsWithCharacterHistory.has(clientID)) {
        dualClients.push(clientID);
      } else {
        singleClients.push(clientID);
      }
      clientsWaitingForBubble.add(clientID);
    }

    if (singleClients.length > 0) {
      singleBatchNarrowcasts.push(buildDelivery(
        "bubble-single-batch",
        singleClients,
        bubble.state,
        false,
        CLIENT_UPDATE_COUNT_THIS_TICK.ONE,
        { bubbleID: bubble.bubbleID },
      ));
    }
    if (dualClients.length > 0) {
      dualBatchNarrowcasts.push(buildDelivery(
        "bubble-dual-batch",
        dualClients,
        bubble.state,
        false,
        CLIENT_UPDATE_COUNT_THIS_TICK.TWO,
        { bubbleID: bubble.bubbleID },
      ));
    }
  }

  for (const character of characterHistories) {
    const waitForBubble = clientsWaitingForBubble.has(character.clientID);
    singlecasts.push(buildDelivery(
      "character",
      [character.clientID],
      character.state,
      waitForBubble,
      waitForBubble
        ? CLIENT_UPDATE_COUNT_THIS_TICK.TWO
        : CLIENT_UPDATE_COUNT_THIS_TICK.ONE,
      { characterID: character.characterID },
    ));
  }

  return {
    clientsWaitingForBubble,
    clientsWithCharacterHistory,
    singlecasts,
    singleBatchNarrowcasts,
    dualBatchNarrowcasts,
    deliveryOrder: [
      ...singlecasts,
      ...singleBatchNarrowcasts,
      ...dualBatchNarrowcasts,
    ],
  };
}

function getClientStateEntryStamp(entry) {
  const value = Array.isArray(entry) ? entry[0] : entry && entry.stamp;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    throw new TypeError("Destiny client state entries require a finite stamp");
  }
  return Math.trunc(numeric);
}

// Direct translation of Carbon's client merge law. The caller owns the history
// list; this function retains no client state and only mutates that supplied
// list so the exact-stamp character/bubble pair can clear waitForBubble.
function mergeStateIntoHistory(state, historyList, waitForBubble = false) {
  if (!Array.isArray(historyList)) {
    throw new TypeError("historyList must be an array");
  }
  const entries = Array.isArray(state) ? state : [];
  if (entries.length === 0) {
    return historyList;
  }

  const entriesByTime = new Map();
  for (const entry of entries) {
    const stamp = getClientStateEntryStamp(entry);
    const stampedEntries = entriesByTime.get(stamp) || [];
    stampedEntries.push(entry);
    entriesByTime.set(stamp, stampedEntries);
  }
  const timeList = [...entriesByTime.keys()].sort((left, right) => left - right);
  let timeListIndex = 0;
  let shouldWaitForBubble = waitForBubble === true;

  for (
    let historyIndex = 0;
    historyIndex < historyList.length && timeListIndex < timeList.length;
    historyIndex += 1
  ) {
    const historyTimeEntries = historyList[historyIndex];
    const historyEntries = historyTimeEntries && historyTimeEntries[0];
    if (!Array.isArray(historyEntries) || historyEntries.length === 0) {
      throw new TypeError("historyList entries require a non-empty state array");
    }
    const historyTime = getClientStateEntryStamp(historyEntries[0]);
    const entryTime = timeList[timeListIndex];
    if (historyTime < entryTime) {
      shouldWaitForBubble = false;
      continue;
    }
    if (historyTime === entryTime) {
      historyEntries.push(...entriesByTime.get(entryTime));
      historyTimeEntries[1] = false;
    } else {
      historyList.splice(historyIndex, 0, [
        entriesByTime.get(entryTime),
        shouldWaitForBubble,
      ]);
      shouldWaitForBubble = false;
    }
    timeListIndex += 1;
  }

  for (; timeListIndex < timeList.length; timeListIndex += 1) {
    historyList.push([
      entriesByTime.get(timeList[timeListIndex]),
      shouldWaitForBubble,
    ]);
  }
  return historyList;
}

function updatePayloadName(update) {
  const payload = update && Array.isArray(update.payload) ? update.payload : null;
  return payload && typeof payload[0] === "string" ? payload[0] : "";
}

function groupContainsPayload(group, payloadName) {
  return Array.isArray(group && group.updates) &&
    group.updates.some((update) => updatePayloadName(update) === payloadName);
}

function orderFreshAcquireDependencies(values, options = {}) {
  if (!Array.isArray(values) || values.length <= 1) {
    return Array.isArray(values) ? values : [];
  }
  const getUpdate = typeof options.getUpdate === "function"
    ? options.getUpdate
    : (value) => value;

  const acquisitionIndexesByEntityID = new Map();
  for (let index = 0; index < values.length; index += 1) {
    const update = getUpdate(values[index]);
    const entityIDs = update && Array.isArray(update.freshAcquireEntityIDs)
      ? update.freshAcquireEntityIDs
      : [];
    for (const rawEntityID of entityIDs) {
      const entityID = getEntityMapKey(rawEntityID);
      if (entityID === null) {
        continue;
      }
      const indexes = acquisitionIndexesByEntityID.get(entityID) || [];
      indexes.push(index);
      acquisitionIndexesByEntityID.set(entityID, indexes);
    }
  }
  if (acquisitionIndexesByEntityID.size === 0) {
    return values;
  }

  const prerequisites = Array.from(
    { length: values.length },
    () => new Set(),
  );
  for (let index = 0; index < values.length; index += 1) {
    const update = getUpdate(values[index]);
    const entityID = getPayloadPrimaryEntityID(update && update.payload);
    const acquisitionIndexes = entityID === null
      ? null
      : acquisitionIndexesByEntityID.get(entityID);
    for (const acquisitionIndex of Array.isArray(acquisitionIndexes)
      ? acquisitionIndexes
      : []) {
      if (acquisitionIndex !== index) {
        prerequisites[index].add(acquisitionIndex);
      }
    }
  }
  if (prerequisites.every((indexes) => indexes.size === 0)) {
    return values;
  }

  // Impose only AddBalls2 -> action edges. Selecting from index zero keeps
  // unrelated same-tick actions in exact enqueue order.
  const emitted = new Set();
  const ordered = [];
  while (ordered.length < values.length) {
    let selectedIndex = null;
    for (let index = 0; index < values.length; index += 1) {
      if (emitted.has(index)) {
        continue;
      }
      let ready = true;
      for (const prerequisiteIndex of prerequisites[index]) {
        if (!emitted.has(prerequisiteIndex)) {
          ready = false;
          break;
        }
      }
      if (ready) {
        selectedIndex = index;
        break;
      }
    }
    if (selectedIndex === null) {
      return values;
    }
    emitted.add(selectedIndex);
    ordered.push(values[selectedIndex]);
  }
  return ordered;
}

function compareParkHistoryGroups(left, right, options = {}) {
  const convert = typeof options.toInt === "function" ? options.toInt : toInt;
  const leftStamp = normalizeDestinyStamp(convert(left && left.stamp, 0));
  const rightStamp = normalizeDestinyStamp(convert(right && right.stamp, 0));
  if (leftStamp !== rightStamp) {
    return compareDestinyStamps(leftStamp, rightStamp);
  }

  const leftWaits = left && left.waitForBubble === true;
  const rightWaits = right && right.waitForBubble === true;
  if (leftWaits !== rightWaits) {
    return leftWaits ? -1 : 1;
  }

  const leftSetState = groupContainsPayload(left, "SetState");
  const rightSetState = groupContainsPayload(right, "SetState");
  if (leftSetState !== rightSetState) {
    return leftSetState ? -1 : 1;
  }

  return (Number(left && left.order) || 0) - (Number(right && right.order) || 0);
}

function buildPackagedBubbleHistoryUpdate(stamp, updates) {
  return buildPackagedActionUpdate(stamp, updates);
}

function buildPackagedRemoveBallsUpdate(stamp, entityIDs) {
  const normalizedIDs = (Array.isArray(entityIDs) ? entityIDs : [entityIDs])
    .map((entry) => getEntityMapKey(entry))
    .filter((entry) => entry !== null);
  return buildPackagedBubbleHistoryUpdate(stamp, [{
    stamp,
    payload: ["RemoveBalls", [{ type: "list", items: normalizedIDs }]],
  }]);
}

function hasOwn(value, key) {
  return Boolean(value) && Object.prototype.hasOwnProperty.call(value, key);
}

function normalizeOptionalRawDispatchStamp(value, convert) {
  if (value === null || value === undefined) {
    return null;
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return null;
  }
  return normalizeDestinyStamp(convert(value, 0));
}

function normalizeDelayedTargetEvents(value) {
  return Array.isArray(value) ? value : null;
}

function mergeDelayedTargetEvents(left, right) {
  const normalizedLeft = normalizeDelayedTargetEvents(left);
  const normalizedRight = normalizeDelayedTargetEvents(right);
  if (normalizedLeft && normalizedRight) {
    return [...normalizedLeft, ...normalizedRight];
  }
  return normalizedLeft || normalizedRight;
}

// Current dispatch collects per-session history. Keeping the collection law
// here makes mixed timestamps and lane boundaries singular without adding a
// character, bubble, tick, or delivery store.
function appendParkHistoryGroup(collectedGroups, groupDetails = {}, options = {}) {
  if (!Array.isArray(collectedGroups) || !groupDetails) {
    return;
  }
  const convert = typeof options.toInt === "function" ? options.toInt : toInt;
  const rawUpdates = Array.isArray(groupDetails.updates)
    ? groupDetails.updates
    : [];
  const baseStamp = normalizeDestinyStamp(convert(groupDetails.stamp, 0));
  const baseOrder = Math.max(
    0,
    convert(groupDetails.order, collectedGroups.length),
  );
  const contract = typeof groupDetails.contract === "string"
    ? groupDetails.contract
    : "";
  const rawDispatchStamp = normalizeOptionalRawDispatchStamp(
    groupDetails.rawDispatchStamp,
    convert,
  );
  const delayedTargetEvents = normalizeDelayedTargetEvents(
    groupDetails.delayedTargetEvents,
  );
  const spatialTraceContext = groupDetails.spatialTraceContext &&
    typeof groupDetails.spatialTraceContext === "object"
    ? groupDetails.spatialTraceContext
    : null;
  const buildSpatialTraceContext =
    typeof options.buildSpatialTraceContext === "function"
      ? options.buildSpatialTraceContext
      : null;

  let splitIndex = 0;
  let currentStamp = null;
  let currentUpdates = [];
  const pushSplit = () => {
    if (!currentUpdates.length || currentStamp === null) {
      return;
    }
    const split = {
      stamp: currentStamp,
      waitForBubble:
        groupDetails.waitForBubble === true && currentStamp === baseStamp,
      order: baseOrder + (splitIndex / 1000),
      updates: currentUpdates,
      contract,
      deliveryTransaction: groupDetails.deliveryTransaction || null,
    };
    if (hasOwn(groupDetails, "rawDispatchStamp")) {
      split.rawDispatchStamp = rawDispatchStamp;
    }
    if (hasOwn(groupDetails, "delayedTargetEvents")) {
      if (splitIndex === 0) {
        split.delayedTargetEvents = delayedTargetEvents
          ? [...delayedTargetEvents]
          : null;
      }
    }
    if (buildSpatialTraceContext) {
      const splitContext = buildSpatialTraceContext({
        contract,
        order: split.order,
        rawDispatchStamp,
        sourceSpatialTraceContext: spatialTraceContext,
        splitIndex,
        stamp: split.stamp,
        updates: split.updates,
        waitForBubble: split.waitForBubble,
      });
      split.spatialTraceContext = splitContext &&
        typeof splitContext === "object"
        ? splitContext
        : null;
    } else if (hasOwn(groupDetails, "spatialTraceContext") && splitIndex === 0) {
      // A whole-group context may describe multiple stamps. Keep it once;
      // dispatch supplies the callback above when it needs exact split traces.
      split.spatialTraceContext = spatialTraceContext;
    }
    collectedGroups.push(split);
    splitIndex += 1;
    currentStamp = null;
    currentUpdates = [];
  };

  for (const update of rawUpdates) {
    const updateStamp = normalizeDestinyStamp(
      convert(update && update.stamp, baseStamp),
    );
    if (currentStamp !== null && updateStamp !== currentStamp) {
      pushSplit();
    }
    currentStamp = updateStamp;
    currentUpdates.push(update);
  }

  pushSplit();
}

function orderParkHistoryGroups(collectedGroups, options = {}) {
  return (Array.isArray(collectedGroups) ? collectedGroups : [])
    .filter((group) => (
      group && Array.isArray(group.updates) && group.updates.length > 0
    ))
    .sort((left, right) => compareParkHistoryGroups(left, right, options));
}

function sameRawDispatchLane(left, right) {
  return left === null || right === null || left === right;
}

function selectRawDispatchStamp(left, right) {
  return left === null ? right : left;
}

// Michelle cannot safely consume mixed timestamps in one notification, and
// SetState is a lane boundary. This builds final single-session delivery groups
// while retaining current transaction and diagnostic metadata.
function buildParkHistoryFlushGroups(collectedGroups, options = {}) {
  const convert = typeof options.toInt === "function" ? options.toInt : toInt;
  const orderedGroups = orderParkHistoryGroups(collectedGroups, options);
  const flushGroups = [];
  let currentStamp = null;
  let currentWaitForBubble = false;
  let currentUpdates = [];
  let currentGroupContainsSetState = false;
  let currentDeliveryTransaction = null;
  let currentDelayedTargetEvents = null;
  let currentSpatialTraceContexts = [];
  let currentRawDispatchStamp = null;
  let currentHasRawDispatchStamp = false;
  let currentHasDelayedTargetEvents = false;
  let currentHasSpatialTraceContext = false;

  const pushMerged = () => {
    if (currentUpdates.length === 0 || currentStamp === null) {
      return;
    }
    const group = {
      stamp: normalizeDestinyStamp(currentStamp),
      waitForBubble: currentWaitForBubble === true,
      updates: orderFreshAcquireDependencies(currentUpdates),
      containsSetState: currentGroupContainsSetState === true,
      deliveryTransaction: currentDeliveryTransaction,
    };
    if (currentHasDelayedTargetEvents) {
      group.delayedTargetEvents = currentDelayedTargetEvents;
    }
    if (currentHasSpatialTraceContext) {
      group.spatialTraceContexts = currentSpatialTraceContexts;
    }
    if (currentHasRawDispatchStamp) {
      group.rawDispatchStamp = currentRawDispatchStamp;
    }
    flushGroups.push(group);
    currentStamp = null;
    currentWaitForBubble = false;
    currentUpdates = [];
    currentGroupContainsSetState = false;
    currentDeliveryTransaction = null;
    currentDelayedTargetEvents = null;
    currentSpatialTraceContexts = [];
    currentRawDispatchStamp = null;
    currentHasRawDispatchStamp = false;
    currentHasDelayedTargetEvents = false;
    currentHasSpatialTraceContext = false;
  };

  for (const group of orderedGroups) {
    const groupStamp = normalizeDestinyStamp(convert(group && group.stamp, 0));
    const groupWaitForBubble = group && group.waitForBubble === true;
    const groupDeliveryTransaction = group && group.deliveryTransaction
      ? group.deliveryTransaction
      : null;
    const groupHasRawDispatchStamp = hasOwn(group, "rawDispatchStamp");
    const groupRawDispatchStamp = groupHasRawDispatchStamp
      ? normalizeOptionalRawDispatchStamp(group.rawDispatchStamp, convert)
      : null;
    const nextGroupContainsSetState = groupContainsPayload(group, "SetState");
    if (
      currentUpdates.length > 0 &&
      (
        groupStamp !== normalizeDestinyStamp(convert(currentStamp, 0)) ||
        groupWaitForBubble !== currentWaitForBubble ||
        groupDeliveryTransaction !== currentDeliveryTransaction ||
        currentGroupContainsSetState === true ||
        nextGroupContainsSetState === true ||
        (
          currentHasRawDispatchStamp &&
          groupHasRawDispatchStamp &&
          !sameRawDispatchLane(currentRawDispatchStamp, groupRawDispatchStamp)
        )
      )
    ) {
      pushMerged();
    }
    if (currentUpdates.length === 0) {
      currentStamp = groupStamp;
      currentWaitForBubble = groupWaitForBubble;
      currentGroupContainsSetState = nextGroupContainsSetState;
      currentDeliveryTransaction = groupDeliveryTransaction;
      currentRawDispatchStamp = groupRawDispatchStamp;
      currentHasRawDispatchStamp = groupHasRawDispatchStamp;
      if (hasOwn(group, "delayedTargetEvents")) {
        currentDelayedTargetEvents = normalizeDelayedTargetEvents(
          group.delayedTargetEvents,
        );
        currentHasDelayedTargetEvents = true;
      }
    } else {
      if (groupHasRawDispatchStamp) {
        currentRawDispatchStamp = selectRawDispatchStamp(
          currentRawDispatchStamp,
          groupRawDispatchStamp,
        );
        currentHasRawDispatchStamp = true;
      }
      if (hasOwn(group, "delayedTargetEvents")) {
        currentDelayedTargetEvents = mergeDelayedTargetEvents(
          currentDelayedTargetEvents,
          group.delayedTargetEvents,
        );
        currentHasDelayedTargetEvents = true;
      }
    }
    currentUpdates.push(...group.updates);
    if (group && group.spatialTraceContext) {
      currentSpatialTraceContexts.push(group.spatialTraceContext);
      currentHasSpatialTraceContext = true;
    }
  }

  pushMerged();
  const plannedGroups = flushGroups.map((group) => ({
    ...group,
    waitForBubble: false,
    orphanWaitDowngraded: group.waitForBubble === true,
    pairedGroupIndex: null,
    updateCount: CLIENT_UPDATE_COUNT_THIS_TICK.ONE,
  }));
  const consumedBubbleGroupIndexes = new Set();
  for (let index = 0; index < flushGroups.length; index += 1) {
    const group = flushGroups[index];
    if (group.waitForBubble !== true || !group.deliveryTransaction) {
      continue;
    }
    const pairedGroupIndex = flushGroups.findIndex((candidate, candidateIndex) => (
      candidateIndex > index &&
      !consumedBubbleGroupIndexes.has(candidateIndex) &&
      candidate.waitForBubble !== true &&
      normalizeDestinyStamp(convert(candidate.stamp, 0)) ===
        normalizeDestinyStamp(convert(group.stamp, 0)) &&
      candidate.deliveryTransaction === group.deliveryTransaction &&
      sameRawDispatchLane(
        hasOwn(group, "rawDispatchStamp") ? group.rawDispatchStamp : null,
        hasOwn(candidate, "rawDispatchStamp")
          ? candidate.rawDispatchStamp
          : null,
      )
    ));
    if (pairedGroupIndex < 0) {
      continue;
    }
    consumedBubbleGroupIndexes.add(pairedGroupIndex);
    plannedGroups[index] = {
      ...group,
      waitForBubble: true,
      orphanWaitDowngraded: false,
      pairedGroupIndex,
      updateCount: CLIENT_UPDATE_COUNT_THIS_TICK.TWO,
    };
    plannedGroups[pairedGroupIndex] = {
      ...flushGroups[pairedGroupIndex],
      waitForBubble: false,
      orphanWaitDowngraded: false,
      pairedGroupIndex: index,
      updateCount: CLIENT_UPDATE_COUNT_THIS_TICK.TWO,
    };
  }
  return plannedGroups;
}

module.exports = {
  CLIENT_UPDATE_COUNT_THIS_TICK,
  DESTINY_NOTIFICATION_NAME,
  appendParkHistoryGroup,
  buildParkHistoryFlushGroups,
  buildPackagedBubbleHistoryUpdate,
  buildPackagedRemoveBallsUpdate,
  buildParkUpdateDeliveryPlan,
  compareParkHistoryGroups,
  mergeStateIntoHistory,
  orderFreshAcquireDependencies,
  orderParkHistoryGroups,
};
