"use strict";

// Bridge session event stream (web-client goal R10 / roadmap G6).
//
// Every server->browser signal the bridge carries used to be pull-based: the
// three ClientSession notification capture stubs on a persistent browser
// session accumulate into `entry.notifications` and are drained onto the next
// call response, and chat is a backlog poll. This module is the push side of
// that: a per-process, per-bridgeSessionID event stream with the same
// epoch/sequence replay-or-snapshot contract the character event stream uses
// (services/online/characterEventRuntime.js), so a browser that drops its
// connection can resume exactly where it left off — or be told, truthfully,
// that it cannot.
//
// It is deliberately a GATEWAY-side concern only. Nothing here touches chat or
// game mechanics: the runtime subscribes to the existing emitters and feeds
// events in. The response drain is untouched — this stream is purely additive,
// so a reconnect gap can never lose data that the next response would have
// carried anyway.

const { randomBytes } = require("node:crypto");

const EVENT_SOURCE = "evejs-web-gateway";
const EVENT_API_VERSION = 1;
const EVENT_STREAM_VERSION = 1;
// Matches characterEventRuntime's DEFAULT_EVENT_HISTORY_LIMIT: the replay
// horizon a reconnecting subscriber can be served from before it falls back to
// a snapshot.
const DEFAULT_EVENT_HISTORY_LIMIT = 256;
const MAX_EVENT_HISTORY_LIMIT = 4096;

function normalizePositiveInteger(value, fallback) {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : fallback;
}

function normalizeEpoch(value) {
  const epoch = String(value === undefined || value === null ? "" : value);
  return /^[A-Za-z0-9_-]{1,128}$/.test(epoch) ? epoch : "";
}

function normalizeStreamKey(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function freezeCursor(epoch, sequence) {
  return Object.freeze({ epoch, sequence });
}

/**
 * Create the per-process bridge-session event runtime.
 *
 * Streams are keyed by the opaque gateway-minted bridgeSessionID. Authorization
 * is NOT this module's job — the caller resolves and ownership-checks the
 * bridge session first (the gateway runtime does that through
 * getBrowserSessionEntry, which is opaque about foreign sessions).
 */
function createSessionEventRuntime(options = {}) {
  const configuredEpoch = options.runtimeEpoch === undefined
    ? ""
    : normalizeEpoch(options.runtimeEpoch);
  if (options.runtimeEpoch !== undefined && !configuredEpoch) {
    throw new TypeError("session event runtime epoch is invalid");
  }
  const runtimeEpoch =
    configuredEpoch || Buffer.from(randomBytes(18)).toString("base64url");

  const historyLimit = Math.min(
    normalizePositiveInteger(options.historyLimit, DEFAULT_EVENT_HISTORY_LIMIT),
    MAX_EVENT_HISTORY_LIMIT,
  );

  const streams = new Map();
  let stopped = false;

  function getStream(streamKey) {
    let stream = streams.get(streamKey);
    if (!stream) {
      stream = { sequence: 0, history: [], subscribers: new Set() };
      streams.set(streamKey, stream);
    }
    return stream;
  }

  function makeEventFrame(stream, event) {
    return Object.freeze({
      source: EVENT_SOURCE,
      apiVersion: EVENT_API_VERSION,
      streamVersion: EVENT_STREAM_VERSION,
      type: "event",
      cursor: freezeCursor(runtimeEpoch, stream.sequence),
      event,
    });
  }

  // The snapshot fallback. A bridge-session stream has no separately readable
  // authoritative state to snapshot (unlike character control): the truthful
  // signal is "your cursor is not replayable, resynchronize by reading". The
  // consumer refetches chat backlog / flight status and continues from this
  // cursor. Saying so explicitly beats silently dropping frames.
  function buildSnapshotFrame(stream, reason) {
    return Object.freeze({
      source: EVENT_SOURCE,
      apiVersion: EVENT_API_VERSION,
      streamVersion: EVENT_STREAM_VERSION,
      type: "snapshot",
      cursor: freezeCursor(runtimeEpoch, stream.sequence),
      // Why replay was refused, so the consumer can distinguish a fresh
      // subscribe from a genuinely missed span when it decides what to refetch.
      reason,
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
        // Subscriber cleanup cannot affect authoritative stream state.
      }
    }
  }

  // onFrame(...) === false is consumer rejection (the gateway's sendFrame
  // returns false when a socket overflows its buffer or is already closing).
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

  function canReplay(stream, cursor) {
    if (
      !cursor ||
      cursor.epoch !== runtimeEpoch ||
      cursor.sequence > stream.sequence
    ) {
      return false;
    }
    if (stream.history.length === 0) {
      // Nothing retained: the only replayable cursor is the current high-water
      // mark (the subscriber has already seen everything).
      return cursor.sequence === stream.sequence;
    }
    const earliestSequence = stream.history[0].cursor.sequence;
    return cursor.sequence >= earliestSequence - 1;
  }

  /**
   * Publish one event onto a bridge session's stream. Returns the delivered
   * frame, or null when the stream is unusable (stopped / bad key / no event).
   * Publishing to a stream with no subscribers is fine and normal — the frame
   * is retained in history so a reconnecting browser replays it.
   */
  function publish(bridgeSessionIDValue, event) {
    const streamKey = normalizeStreamKey(bridgeSessionIDValue);
    if (!streamKey || stopped || !event || typeof event !== "object") {
      return null;
    }
    const stream = getStream(streamKey);
    const sequence = stream.sequence + 1;
    if (!Number.isSafeInteger(sequence)) {
      // A sequence that can no longer be represented exactly would silently
      // break cursor comparison; refuse rather than lie about ordering.
      return null;
    }
    stream.sequence = sequence;
    const frame = makeEventFrame(stream, event);
    stream.history.push(frame);
    while (stream.history.length > historyLimit) {
      stream.history.shift();
    }
    deliverFrame(stream, frame);
    return frame;
  }

  function normalizeCursor(cursorValue) {
    if (cursorValue === undefined || cursorValue === null) {
      return null;
    }
    const epoch = normalizeEpoch(cursorValue.epoch);
    const sequence = Number(cursorValue.sequence);
    if (!epoch || !Number.isSafeInteger(sequence) || sequence < 0) {
      throw new TypeError("session event cursor is invalid");
    }
    return freezeCursor(epoch, sequence);
  }

  /**
   * Subscribe to a bridge session's stream. `cursor` resumes a prior
   * connection; omit it for a fresh subscribe. Returns an unsubscribe function.
   */
  function subscribe(bridgeSessionIDValue, cursorValue, handlers = {}) {
    const streamKey = normalizeStreamKey(bridgeSessionIDValue);
    const cursor = normalizeCursor(cursorValue);
    const onFrame = typeof handlers === "function" ? handlers : handlers && handlers.onFrame;
    const onClose = handlers && typeof handlers === "object" ? handlers.onClose : null;
    if (!streamKey || typeof onFrame !== "function" || stopped) {
      throw new TypeError("session event subscription is unavailable");
    }
    const stream = getStream(streamKey);
    let initialFrames;
    if (canReplay(stream, cursor)) {
      initialFrames = stream.history.filter(
        (frame) => frame.cursor.sequence > cursor.sequence,
      );
    } else {
      initialFrames = [
        buildSnapshotFrame(
          stream,
          cursor ? "cursor_not_replayable" : "no_cursor",
        ),
      ];
    }

    // Register BEFORE draining the initial batch, exactly as the character
    // event runtime does: any event published re-entrantly during the drain is
    // appended behind the replay/snapshot batch, so the handoff from replay to
    // live delivery is atomic with no asynchronous gap to lose frames in.
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

  /**
   * Drop a bridge session's stream entirely (the session ended). Subscribers
   * are closed with the supplied reason so the gateway can close their sockets.
   */
  function dropStream(bridgeSessionIDValue, reason = "session_ended") {
    const streamKey = normalizeStreamKey(bridgeSessionIDValue);
    const stream = streams.get(streamKey);
    if (!stream) {
      return false;
    }
    for (const subscriber of [...stream.subscribers]) {
      removeSubscriber(stream, subscriber, reason);
    }
    streams.delete(streamKey);
    return true;
  }

  function getDiagnostics() {
    let subscriberCount = 0;
    for (const stream of streams.values()) {
      subscriberCount += stream.subscribers.size;
    }
    return Object.freeze({
      ready: !stopped,
      runtimeEpoch,
      historyLimit,
      streamCount: streams.size,
      subscriberCount,
    });
  }

  function shutdown() {
    if (stopped) {
      return;
    }
    stopped = true;
    for (const streamKey of [...streams.keys()]) {
      dropStream(streamKey, "shutdown");
    }
    streams.clear();
  }

  return Object.freeze({
    runtimeEpoch,
    publish,
    subscribe,
    dropStream,
    getDiagnostics,
    shutdown,
  });
}

module.exports = {
  createSessionEventRuntime,
  DEFAULT_EVENT_HISTORY_LIMIT,
  EVENT_SOURCE,
  EVENT_API_VERSION,
  EVENT_STREAM_VERSION,
};
