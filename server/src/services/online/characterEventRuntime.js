"use strict";

const crypto = require("node:crypto");

const EVENT_SOURCE = "evejs-web-gateway";
const EVENT_API_VERSION = 1;
const EVENT_STREAM_VERSION = 1;
const DEFAULT_EVENT_HISTORY_LIMIT = 256;
const DEFAULT_COMMAND_OUTCOME_LIMIT = 256;
const MAX_EVENT_HISTORY_LIMIT = 256;
const MAX_COMMAND_OUTCOME_LIMIT = 256;

const CONTROL_STATES = new Set([
  "offline",
  "retail_client",
  "browser_pilot",
]);
const ADMISSION_STATUSES = new Set(["admitted", "rejected"]);

function normalizePositiveInteger(value, fallback) {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : fallback;
}

function normalizeCharacterID(value) {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : 0;
}

function normalizeOpaqueString(value, maxLength = 512) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maxLength ||
    !value.trim() ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    return "";
  }
  return value;
}

function normalizeEpoch(value) {
  const normalized = normalizeOpaqueString(value, 128);
  return normalized && /^[A-Za-z0-9_-]+$/.test(normalized) ? normalized : "";
}

function normalizeErrorCode(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const normalized = String(value);
  return /^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(normalized)
    ? normalized
    : "CHARACTER_COMMAND_UNAVAILABLE";
}

function freezeCursor(epoch, sequence) {
  return Object.freeze({ epoch, sequence });
}

function sanitizeControlSnapshot(snapshot) {
  const controlState = String(snapshot && snapshot.controlState || "");
  if (!CONTROL_STATES.has(controlState)) {
    throw new TypeError("character event control snapshot is invalid");
  }
  const transport = controlState === "retail_client"
    ? "tcp"
    : controlState === "browser_pilot"
      ? "web"
      : null;
  let leaseExpiresAt = null;
  if (controlState === "browser_pilot" && snapshot && snapshot.leaseExpiresAt) {
    leaseExpiresAt = normalizeOpaqueString(String(snapshot.leaseExpiresAt), 128);
    if (!leaseExpiresAt) {
      throw new TypeError("character event lease expiry is invalid");
    }
  }
  return Object.freeze({
    online: controlState !== "offline",
    controlState,
    transport,
    leaseExpiresAt,
  });
}

function normalizeStateVersion(value) {
  const normalized = normalizeOpaqueString(value, 512);
  if (!normalized) {
    throw new TypeError("character event state version is invalid");
  }
  return normalized;
}

function normalizeCommandOutcome(value) {
  const commandID = normalizeOpaqueString(value && value.commandID, 512);
  const commandType = normalizeOpaqueString(value && value.commandType, 128);
  const success = value && value.success;
  const admissionStatus = String(value && value.admissionStatus || "");
  const stateVersion = normalizeStateVersion(value && value.stateVersion);
  if (
    !commandID ||
    !commandType ||
    typeof success !== "boolean" ||
    !ADMISSION_STATUSES.has(admissionStatus)
  ) {
    throw new TypeError("character event command outcome is invalid");
  }
  const errorCode = normalizeErrorCode(value && value.errorCode);
  if ((success && errorCode !== null) || (!success && errorCode === null)) {
    throw new TypeError("character event command outcome error is invalid");
  }
  return Object.freeze({
    commandID,
    commandType,
    success,
    errorCode,
    admissionStatus,
    stateVersion,
  });
}

function createCharacterEventRuntime(options = {}) {
  const controlRuntime = options.controlRuntime;
  const getStateVersion = options.getStateVersion;
  if (
    !controlRuntime ||
    typeof controlRuntime.getCharacterControlSnapshot !== "function" ||
    typeof controlRuntime.subscribe !== "function" ||
    typeof getStateVersion !== "function"
  ) {
    throw new TypeError(
      "character event runtime requires authoritative control and state versions",
    );
  }

  const randomBytes = typeof options.randomBytes === "function"
    ? options.randomBytes
    : crypto.randomBytes;
  const configuredEpoch = options.runtimeEpoch === undefined
    ? ""
    : normalizeEpoch(options.runtimeEpoch);
  if (options.runtimeEpoch !== undefined && !configuredEpoch) {
    throw new TypeError("character event runtime epoch is invalid");
  }
  const runtimeEpoch = configuredEpoch || Buffer.from(randomBytes(18)).toString("base64url");
  if (!normalizeEpoch(runtimeEpoch)) {
    throw new TypeError("character event runtime could not create an epoch");
  }

  const historyLimit = normalizePositiveInteger(
    options.historyLimit,
    DEFAULT_EVENT_HISTORY_LIMIT,
  );
  const boundedHistoryLimit = Math.min(historyLimit, MAX_EVENT_HISTORY_LIMIT);
  // Retention invariant: every settlement retained as a command-ID conflict
  // must be recoverable either by replay or, when replay is unavailable, by
  // the exact sanitized outcome in a snapshot. Since each history frame can
  // contain at most one settlement, retaining at least as many outcomes as
  // history frames makes the snapshot horizon cover the complete replay
  // horizon. Both horizons remain capped by the coordinated wire maximum.
  const commandOutcomeLimit = Math.max(
    boundedHistoryLimit,
    Math.min(
      normalizePositiveInteger(
        options.commandOutcomeLimit,
        DEFAULT_COMMAND_OUTCOME_LIMIT,
      ),
      MAX_COMMAND_OUTCOME_LIMIT,
    ),
  );
  const streams = new Map();
  let stopped = false;

  function getStream(characterID) {
    let stream = streams.get(characterID);
    if (!stream) {
      stream = {
        sequence: 0,
        history: [],
        commandOutcomes: [],
        subscribers: new Set(),
      };
      streams.set(characterID, stream);
    }
    return stream;
  }

  function makeEventFrame(characterID, stream, event) {
    return Object.freeze({
      source: EVENT_SOURCE,
      apiVersion: EVENT_API_VERSION,
      streamVersion: EVENT_STREAM_VERSION,
      type: "event",
      characterID,
      cursor: freezeCursor(runtimeEpoch, stream.sequence),
      event,
    });
  }

  function removeSubscriber(stream, subscriber, reason = "unsubscribed") {
    if (subscriber.closed) {
      return;
    }
    subscriber.closed = true;
    subscriber.pending.length = 0;
    stream.subscribers.delete(subscriber);
    if (typeof subscriber.onClose === "function") {
      try {
        subscriber.onClose(Object.freeze({ reason }));
      } catch {
        // Subscriber cleanup cannot affect authoritative event state.
      }
    }
  }

  function drainSubscriber(stream, subscriber) {
    if (subscriber.closed || subscriber.draining) {
      return;
    }
    subscriber.draining = true;
    try {
      while (!subscriber.closed && subscriber.pending.length > 0) {
        const frame = subscriber.pending.shift();
        let accepted = true;
        try {
          accepted = subscriber.onFrame(frame) !== false;
        } catch {
          accepted = false;
        }
        if (!accepted) {
          removeSubscriber(stream, subscriber, "consumer_rejected");
        }
      }
    } finally {
      subscriber.draining = false;
    }
  }

  function deliverFrame(stream, frame) {
    for (const subscriber of [...stream.subscribers]) {
      if (subscriber.closed) {
        continue;
      }
      subscriber.pending.push(frame);
      drainSubscriber(stream, subscriber);
    }
  }

  function publishEvent(characterIDValue, event) {
    const characterID = normalizeCharacterID(characterIDValue);
    if (!characterID || stopped) {
      return null;
    }
    const stream = getStream(characterID);
    const sequence = stream.sequence + 1;
    if (!Number.isSafeInteger(sequence)) {
      shutdown();
      return null;
    }
    stream.sequence = sequence;
    const frame = makeEventFrame(characterID, stream, event);
    stream.history.push(frame);
    if (stream.history.length > boundedHistoryLimit) {
      stream.history.splice(0, stream.history.length - boundedHistoryLimit);
    }
    deliverFrame(stream, frame);
    return frame;
  }

  function publishControlChange(characterIDValue, snapshotValue) {
    if (stopped) {
      return null;
    }
    const characterID = normalizeCharacterID(characterIDValue);
    if (!characterID) {
      return null;
    }
    try {
      const event = Object.freeze({
        kind: "control_changed",
        control: sanitizeControlSnapshot(snapshotValue),
        stateVersion: normalizeStateVersion(getStateVersion(characterID)),
      });
      return publishEvent(characterID, event);
    } catch {
      return null;
    }
  }

  function streamHasRetainedCommandID(stream, commandID) {
    if (
      stream.commandOutcomes.some((outcome) => outcome.commandID === commandID)
    ) {
      return true;
    }
    return stream.history.some((frame) =>
      frame &&
      frame.event &&
      frame.event.kind === "command_settled" &&
      frame.event.commandID === commandID);
  }

  function hasRetainedCommandID(characterIDValue, commandIDValue) {
    if (stopped) {
      return false;
    }
    const characterID = normalizeCharacterID(characterIDValue);
    const commandID = normalizeOpaqueString(commandIDValue, 512);
    const stream = characterID ? streams.get(characterID) : null;
    return Boolean(
      stream && commandID && streamHasRetainedCommandID(stream, commandID),
    );
  }

  function publishCommandSettlement(settlementValue) {
    if (stopped) {
      return null;
    }
    const characterID = normalizeCharacterID(
      settlementValue && settlementValue.characterID,
    );
    if (!characterID) {
      return null;
    }
    try {
      const outcome = normalizeCommandOutcome(settlementValue);
      const stream = getStream(characterID);
      // A globally bounded command-receipt cache can evict an old receipt while
      // its settlement is still retained by this character stream. Treat a
      // retry of that command ID as the same already-published settlement for
      // the entire replay/outcome retention horizon.
      if (streamHasRetainedCommandID(stream, outcome.commandID)) {
        return null;
      }
      stream.commandOutcomes.push(outcome);
      if (stream.commandOutcomes.length > commandOutcomeLimit) {
        stream.commandOutcomes.splice(
          0,
          stream.commandOutcomes.length - commandOutcomeLimit,
        );
      }
      return publishEvent(characterID, Object.freeze({
        kind: "command_settled",
        ...outcome,
      }));
    } catch {
      return null;
    }
  }

  function normalizeCursor(cursorValue) {
    if (cursorValue === null || cursorValue === undefined) {
      return null;
    }
    if (
      !cursorValue ||
      typeof cursorValue !== "object" ||
      Array.isArray(cursorValue) ||
      Object.keys(cursorValue).sort().join("\u0000") !== "epoch\u0000sequence"
    ) {
      throw new TypeError("character event cursor is invalid");
    }
    const epoch = normalizeEpoch(cursorValue.epoch);
    const sequence = Number(cursorValue.sequence);
    if (
      !epoch ||
      !Number.isSafeInteger(sequence) ||
      sequence < 0
    ) {
      throw new TypeError("character event cursor is invalid");
    }
    return Object.freeze({ epoch, sequence });
  }

  function canReplay(stream, cursor) {
    if (
      !cursor ||
      cursor.epoch !== runtimeEpoch ||
      cursor.sequence > stream.sequence
    ) {
      return false;
    }
    if (stream.history.length === 0) {
      return cursor.sequence === stream.sequence;
    }
    const earliestSequence = stream.history[0].cursor.sequence;
    return cursor.sequence >= earliestSequence - 1;
  }

  function buildSnapshotFrame(characterID, stream) {
    // Reading control can synchronously expire a lease and publish a control
    // event. Capture the high-water cursor only after those authoritative reads.
    const control = sanitizeControlSnapshot(
      controlRuntime.getCharacterControlSnapshot(characterID),
    );
    const stateVersion = normalizeStateVersion(getStateVersion(characterID));
    return Object.freeze({
      source: EVENT_SOURCE,
      apiVersion: EVENT_API_VERSION,
      streamVersion: EVENT_STREAM_VERSION,
      type: "snapshot",
      characterID,
      cursor: freezeCursor(runtimeEpoch, stream.sequence),
      control,
      stateVersion,
      commandOutcomes: Object.freeze([...stream.commandOutcomes]),
    });
  }

  function subscribe(characterIDValue, cursorValue, handlers = {}) {
    const characterID = normalizeCharacterID(characterIDValue);
    const cursor = normalizeCursor(cursorValue);
    const onFrame = typeof handlers === "function"
      ? handlers
      : handlers && handlers.onFrame;
    const onClose = handlers && typeof handlers === "object"
      ? handlers.onClose
      : null;
    if (!characterID || typeof onFrame !== "function" || stopped) {
      throw new TypeError("character event subscription is unavailable");
    }
    const stream = getStream(characterID);
    let initialFrames;
    if (canReplay(stream, cursor)) {
      initialFrames = stream.history.filter(
        (frame) => frame.cursor.sequence > cursor.sequence,
      );
    } else {
      initialFrames = [buildSnapshotFrame(characterID, stream)];
    }

    // Register before draining initial frames. Any re-entrant publication is
    // appended behind the complete replay/snapshot batch, making the handoff
    // to live delivery atomic without an asynchronous gap.
    const subscriber = {
      onFrame,
      onClose: typeof onClose === "function" ? onClose : null,
      pending: [...initialFrames],
      draining: false,
      closed: false,
    };
    stream.subscribers.add(subscriber);
    drainSubscriber(stream, subscriber);
    return () => removeSubscriber(stream, subscriber);
  }

  const unsubscribeControl = controlRuntime.subscribe((transition) => {
    if (stopped) {
      return;
    }
    const characterID = normalizeCharacterID(transition && transition.characterID);
    const previousState = String(
      transition && transition.previous && transition.previous.controlState || "",
    );
    const currentState = String(
      transition && transition.current && transition.current.controlState || "",
    );
    if (
      characterID &&
      previousState &&
      currentState &&
      previousState !== currentState
    ) {
      publishControlChange(characterID, transition.current);
    }
  });

  function getDiagnostics() {
    let subscriberCount = 0;
    let historyEventCount = 0;
    let commandOutcomeCount = 0;
    for (const stream of streams.values()) {
      subscriberCount += stream.subscribers.size;
      historyEventCount += stream.history.length;
      commandOutcomeCount += stream.commandOutcomes.length;
    }
    return Object.freeze({
      stopped,
      epoch: runtimeEpoch,
      characterCount: streams.size,
      subscriberCount,
      historyEventCount,
      commandOutcomeCount,
    });
  }

  function shutdown() {
    if (stopped) {
      return;
    }
    stopped = true;
    if (typeof unsubscribeControl === "function") {
      unsubscribeControl();
    }
    for (const stream of streams.values()) {
      for (const subscriber of [...stream.subscribers]) {
        removeSubscriber(stream, subscriber, "shutdown");
      }
      stream.history.length = 0;
      stream.commandOutcomes.length = 0;
    }
    streams.clear();
  }

  return Object.freeze({
    getDiagnostics,
    hasRetainedCommandID,
    publishCommandSettlement,
    shutdown,
    subscribe,
  });
}

module.exports = {
  DEFAULT_COMMAND_OUTCOME_LIMIT,
  DEFAULT_EVENT_HISTORY_LIMIT,
  EVENT_API_VERSION,
  EVENT_SOURCE,
  EVENT_STREAM_VERSION,
  MAX_COMMAND_OUTCOME_LIMIT,
  MAX_EVENT_HISTORY_LIMIT,
  createCharacterEventRuntime,
};
