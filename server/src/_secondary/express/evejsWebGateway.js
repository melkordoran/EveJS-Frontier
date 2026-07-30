"use strict";

const { WebSocket, WebSocketServer } = require("ws");

const GATEWAY_PREFIX = "/_evejs-web/v1";
const GATEWAY_SOURCE = "evejs-web-gateway";
const GATEWAY_API_VERSION = 1;
const GATEWAY_TOKEN_HEADER = "x-evejs-web-token";
const RUNTIME_NOT_READY_CODE = "GATEWAY_RUNTIME_NOT_READY";
const EVENTS_PATH = `${GATEWAY_PREFIX}/events`;
// Goal R10 (roadmap G6): the bridge-session push channel. `/events` is keyed by
// characterID and carries character-control/command events; this one is keyed by
// the held bridgeSessionID and carries that session's notification captures and
// its chat. Both ride the same upgrade seam, frame guards, heartbeat, and
// shutdown machinery below.
const SESSION_EVENTS_PATH = `${GATEWAY_PREFIX}/session-events`;
const DEFAULT_EVENT_HEARTBEAT_INTERVAL_MS = 30_000;
const DEFAULT_EVENT_MAX_INBOUND_FRAME_BYTES = 16 * 1024;
const DEFAULT_EVENT_MAX_OUTBOUND_FRAME_BYTES = 2 * 1024 * 1024;
const DEFAULT_EVENT_MAX_BUFFERED_OUTPUT_BYTES = 4 * 1024 * 1024;
const DEFAULT_EVENT_SHUTDOWN_GRACE_MS = 250;

const CHARACTER_COMMAND_ERROR_DETAILS = Object.freeze({
  CHARACTER_COMMAND_INVALID: Object.freeze({
    status: 400,
    message: "Character command envelope is invalid.",
  }),
  CHARACTER_COMMAND_ID_REUSED: Object.freeze({
    status: 409,
    message: "Character command ID was reused with different command data.",
  }),
  CHARACTER_STATE_VERSION_MISMATCH: Object.freeze({
    status: 409,
    message: "Character state version does not match the authoritative state.",
  }),
  CHARACTER_COMMAND_UNAVAILABLE: Object.freeze({
    status: 503,
    message: "Authoritative character command execution is unavailable.",
  }),
});

const PUBLIC_SKILL_QUEUE_ERROR_CODES = new Set([
  "QueueTooManySkills",
  "QueueTooLong",
  "QueueSkillNotUploaded",
  "QueueCannotTrainPastMaximumLevel",
  "QueueCannotTrainOmegaRestrictedSkill",
  "QueueCannotTrainPreviouslyTrainedSkills",
  "QueueCannotPlaceSkillLevelsOutOfOrder",
  "QueueCannotPlaceSkillBeforeRequirements",
  "UserAlreadyHasSkillInTraining",
  "SkillInQueueRequiresOmegaCloneState",
  "SkillInQueueOverAlphaSpTrainingSize",
]);
const PUBLIC_PI_RESTART_ERROR_CODES = new Set([
  "CannotManagePlanetWithoutCommandCenter",
  "PinDoesNotExist",
  "PinDoesNotHaveHeads",
  "CannotPlaceHeadTooFarAway",
]);

const CAPABILITIES = Object.freeze({
  health: true,
  status: true,
  accounts: true,
  characters: true,
  snapshots: true,
  characterStatus: true,
  characterControl: true,
  skillQueue: true,
  // Goal R28: GET /skills — the skill sheet + training queue as resolved JSON.
  skillSheet: true,
  piRestartExtractors: true,
  marketStationAsks: true,
  characterEvents: true,
  serviceCall: true,
  persistentSession: true,
  boundObjectBridge: true,
  // Goal R10: the bridge-session push channel (see SESSION_EVENTS_PATH).
  sessionEvents: true,
});

// Error codes surfaced by the whitelisted callMethod bridge path
// (runtime.callServiceMethod / selectCharacter / releaseBrowserSession).
// Anything else maps to the generic CALL_FAILED.
const CALL_ERROR_STATUS_CODES = Object.freeze({
  CALL_INVALID: 400,
  CALL_NOT_ALLOWED: 403,
  CALL_SERVICE_UNAVAILABLE: 503,
  CALL_FAILED: 502,
  CALL_REFUSED: 409,
  SESSION_NOT_FOUND: 404,
  SESSION_SELECT_FAILED: 502,
  // R3 bound-object bridge.
  BOUND_HANDLE_NOT_FOUND: 404,
  BOUND_NO_OBJECT: 502,
  // R4 deferred call responses: a deferred flow that genuinely needs a client
  // round-trip the synchronous bridge cannot service is refused, not returned
  // as a broken object. 501 Not Implemented.
  CALL_DEFERRED_UNSUPPORTED: 501,
});

const DEPENDENCY_NAMES = Object.freeze([
  "serviceManager",
  "gameStore",
  "skillQueue",
  // Goal R28: the SP curve + server clock the skill SHEET needs, reported apart
  // from the queue runtime so "no training maths" is distinguishable.
  "skillSheet",
  "planetaryInteraction",
  "onlinePresence",
  "characterControl",
  "characterEvents",
  "market",
]);

function getGatewayToken() {
  return String(process.env.EVEJS_WEB_GATEWAY_TOKEN || "").trim();
}

function normalizeAddress(address) {
  const value = String(address || "").trim().toLowerCase();
  return value.startsWith("::ffff:") ? value.slice("::ffff:".length) : value;
}

function isLoopbackAddress(address) {
  const normalized = normalizeAddress(address);
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "localhost";
}

function readBearerToken(req) {
  const authorization = String(req.headers.authorization || "").trim();
  return authorization.toLowerCase().startsWith("bearer ")
    ? authorization.slice("bearer ".length).trim()
    : "";
}

function authorizeGatewayRequest(req) {
  const configuredToken = getGatewayToken();
  if (!configuredToken) {
    return isLoopbackAddress(req.socket && req.socket.remoteAddress);
  }
  const suppliedToken =
    String(req.headers[GATEWAY_TOKEN_HEADER] || "").trim() || readBearerToken(req);
  return suppliedToken === configuredToken;
}

// WebSocket upgrades use the same authorization rule as gateway requests when a
// token IS configured: present it. Without one, the token-less loopback
// allowance is deliberately narrower than the request-side rule, and is scoped
// to ONE path.
//
// R10 originally granted token-less loopback to every upgrade, because
// hard-refusing them made the push channel unreachable in the ordinary local
// setup (EVEJS_WEB_GATEWAY_TOKEN unset, BFF on 127.0.0.1) even though every
// request route on the same origin was allowed. That fixed a real problem but
// over-reached: it also opened SESSION_EVENTS_PATH's older sibling, EVENTS_PATH,
// whose only post-upgrade gate (validateOwnedCharacter) checks that the supplied
// accountID/characterID pair is internally CONSISTENT — not that the caller owns
// it. So a token-less local peer could read any character's stream by
// enumerating IDs.
//
// The legitimate token-less consumer is exactly one caller: the BFF opening the
// bridge-session push channel on 127.0.0.1 (evejs-web-poc
// src/eveGatewayClient.js — the only `new WebSocket` in that repo). EVENTS_PATH
// has no WebSocket client in either repo. Scoping the allowance to
// SESSION_EVENTS_PATH therefore costs nothing real and keeps EVENTS_PATH failing
// closed without a token, which is what webGatewayEvents.test.js has asserted
// since 85878dcf — an assertion that predates R10 and is restored here rather
// than rewritten.
function authorizeGatewayUpgrade(req) {
  const configuredToken = getGatewayToken();
  if (!configuredToken) {
    const pathname = String((req && req.url) || "").split("?", 1)[0];
    return (
      pathname === SESSION_EVENTS_PATH &&
      isLoopbackAddress(req.socket && req.socket.remoteAddress)
    );
  }
  const suppliedToken =
    String(req.headers[GATEWAY_TOKEN_HEADER] || "").trim() || readBearerToken(req);
  return suppliedToken === configuredToken;
}

function sendGatewayError(res, status, code, message) {
  res.status(status).json({
    ok: false,
    source: GATEWAY_SOURCE,
    apiVersion: GATEWAY_API_VERSION,
    error: code,
    message,
  });
}

function sendRuntimeNotReady(res) {
  sendGatewayError(
    res,
    503,
    RUNTIME_NOT_READY_CODE,
    "Authoritative EveJS gateway runtime is not ready.",
  );
}

function isGatewayNamespaceRequest(req) {
  const requestPath = String((req && (req.originalUrl || req.url)) || "")
    .split("?", 1)[0];
  return /^\/_evejs-web(?:\/|$)/.test(requestPath);
}

function getGatewayErrorDetails(error) {
  const errorStatus = Number(error && (error.status || error.statusCode));
  if (errorStatus === 413) {
    return {
      status: 413,
      code: "GATEWAY_PAYLOAD_TOO_LARGE",
      message: "Gateway request payload is too large.",
    };
  }
  if (error && error.type === "entity.parse.failed") {
    return {
      status: 400,
      code: "GATEWAY_INVALID_JSON",
      message: "Gateway request body must contain valid JSON.",
    };
  }
  if (Number.isInteger(errorStatus) && errorStatus >= 400 && errorStatus < 500) {
    return {
      status: errorStatus,
      code: "GATEWAY_INVALID_REQUEST",
      message: "Gateway request is invalid.",
    };
  }
  return {
    status: 500,
    code: "GATEWAY_INTERNAL_ERROR",
    message: "EveJS web gateway request failed.",
  };
}

function getGatewayRuntime(runtimeContext) {
  return runtimeContext && runtimeContext.gatewayRuntime
    ? runtimeContext.gatewayRuntime
    : null;
}

function runtimeDependencies(runtimeContext) {
  const runtime = getGatewayRuntime(runtimeContext);
  const reported = runtime && runtime.dependencies && typeof runtime.dependencies === "object"
    ? runtime.dependencies
    : {};
  return Object.fromEntries(
    DEPENDENCY_NAMES.map((name) => [name, reported[name] === true]),
  );
}

function hasReadyGatewayRuntime(runtimeContext) {
  const runtime = getGatewayRuntime(runtimeContext);
  if (!runtime) {
    return false;
  }
  const dependencies = runtimeDependencies(runtimeContext);
  return (
    Object.values(dependencies).every(Boolean) &&
    typeof runtime.getStatus === "function" &&
    typeof runtime.listAccounts === "function" &&
    typeof runtime.getAccountByUsername === "function" &&
    typeof runtime.getAccountByID === "function" &&
    typeof runtime.listCharacters === "function" &&
    typeof runtime.getCharacter === "function" &&
    typeof runtime.buildSnapshot === "function" &&
    typeof runtime.buildSkillSheet === "function" &&
    typeof runtime.isCharacterOnline === "function" &&
    typeof runtime.getCharacterControlStatus === "function" &&
    typeof runtime.claimBrowserControl === "function" &&
    typeof runtime.renewBrowserControl === "function" &&
    typeof runtime.releaseBrowserControl === "function" &&
    typeof runtime.submitSkillQueueSaveCommand === "function" &&
    typeof runtime.submitPiRestartExtractorsCommand === "function" &&
    typeof runtime.getStationAsks === "function" &&
    typeof runtime.subscribeCharacterEvents === "function" &&
    typeof runtime.getCharacterEventDiagnostics === "function" &&
    typeof runtime.shutdown === "function"
  );
}

function buildCharacterEventReadiness(runtimeContext) {
  const gatewayRuntime = hasReadyGatewayRuntime(runtimeContext);
  const gatewayToken = Boolean(getGatewayToken());
  return {
    ready: gatewayRuntime && gatewayToken,
    dependencies: {
      gatewayRuntime,
      gatewayToken,
    },
  };
}

function buildGatewayHealth(runtimeContext) {
  return {
    ok: true,
    source: GATEWAY_SOURCE,
    apiVersion: GATEWAY_API_VERSION,
    capabilities: { ...CAPABILITIES },
    runtime: {
      ready: hasReadyGatewayRuntime(runtimeContext),
      dependencies: runtimeDependencies(runtimeContext),
      characterEvents: buildCharacterEventReadiness(runtimeContext),
    },
  };
}

function readPositiveID(value) {
  const numericValue = Number(value);
  return Number.isSafeInteger(numericValue) && numericValue > 0
    ? numericValue
    : 0;
}

function validateOwnedCharacter(runtime, accountValue, characterValue) {
  const accountID = readPositiveID(accountValue);
  if (!accountID) {
    return {
      error: [400, "INVALID_ACCOUNT", "A positive accountID is required."],
    };
  }
  const characterID = readPositiveID(characterValue);
  if (!characterID) {
    return {
      error: [400, "INVALID_CHARACTER", "A positive characterID is required."],
    };
  }
  const character = runtime.getCharacter(characterID);
  if (!character) {
    return {
      error: [404, "CHARACTER_NOT_FOUND", "Character was not found."],
    };
  }
  if (Number(character.accountID) !== accountID) {
    return {
      error: [403, "CHARACTER_ACCOUNT_MISMATCH", "Character does not belong to the supplied account."],
    };
  }
  return { accountID, characterID, character };
}

function normalizePositiveLimit(value, fallback) {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : fallback;
}

function parseEventUpgradeRequest(req) {
  let requestUrl;
  try {
    requestUrl = new URL(String(req && req.url || ""), "http://evejs.invalid");
  } catch {
    return {
      error: [400, "INVALID_EVENT_REQUEST", "Event-stream request is invalid."],
    };
  }
  if (requestUrl.pathname !== EVENTS_PATH) {
    return {
      error: [404, "GATEWAY_ROUTE_NOT_FOUND", "EveJS web gateway route was not found."],
    };
  }
  const allowedKeys = new Set(["accountID", "characterID", "epoch", "sequence"]);
  for (const key of requestUrl.searchParams.keys()) {
    if (!allowedKeys.has(key) || requestUrl.searchParams.getAll(key).length !== 1) {
      return {
        error: [400, "INVALID_EVENT_REQUEST", "Event-stream request is invalid."],
      };
    }
  }
  const accountID = readPositiveID(requestUrl.searchParams.get("accountID"));
  const characterID = readPositiveID(requestUrl.searchParams.get("characterID"));
  if (!accountID) {
    return { error: [400, "INVALID_ACCOUNT", "A positive accountID is required."] };
  }
  if (!characterID) {
    return { error: [400, "INVALID_CHARACTER", "A positive characterID is required."] };
  }

  const cursorResult = parseEventCursorParams(requestUrl);
  if (cursorResult.error) {
    return cursorResult;
  }
  return { accountID, characterID, cursor: cursorResult.cursor };
}

// The shared `?epoch=&sequence=` resume cursor. Both are present or neither is;
// a partial cursor is a client bug, not a fresh subscribe, so it is refused
// rather than silently treated as "start from now".
function parseEventCursorParams(requestUrl) {
  const hasEpoch = requestUrl.searchParams.has("epoch");
  const hasSequence = requestUrl.searchParams.has("sequence");
  if (hasEpoch !== hasSequence) {
    return {
      error: [400, "INVALID_EVENT_CURSOR", "Event cursor is invalid."],
    };
  }
  if (!hasEpoch) {
    return { cursor: null };
  }
  const epoch = String(requestUrl.searchParams.get("epoch") || "");
  const sequenceText = String(requestUrl.searchParams.get("sequence") || "");
  const sequence = Number(sequenceText);
  if (
    !/^[A-Za-z0-9_-]{1,128}$/.test(epoch) ||
    !/^(?:0|[1-9][0-9]*)$/.test(sequenceText) ||
    !Number.isSafeInteger(sequence) ||
    sequence < 0
  ) {
    return {
      error: [400, "INVALID_EVENT_CURSOR", "Event cursor is invalid."],
    };
  }
  return { cursor: Object.freeze({ epoch, sequence }) };
}

// Goal R10: the bridge-session push upgrade. Keyed by the opaque
// bridgeSessionID plus the owning `userid` — the same pair every other bridge
// route authorizes on. Ownership itself is decided by the runtime (an unknown
// or foreign handle is opaquely SESSION_NOT_FOUND); this only validates shape.
function parseSessionEventUpgradeRequest(requestUrl) {
  const allowedKeys = new Set(["userid", "bridgeSessionID", "epoch", "sequence"]);
  for (const key of requestUrl.searchParams.keys()) {
    if (!allowedKeys.has(key) || requestUrl.searchParams.getAll(key).length !== 1) {
      return {
        error: [400, "INVALID_EVENT_REQUEST", "Event-stream request is invalid."],
      };
    }
  }
  const userid = readPositiveID(requestUrl.searchParams.get("userid"));
  if (!userid) {
    return { error: [400, "INVALID_ACCOUNT", "A positive userid is required."] };
  }
  const bridgeSessionID = String(requestUrl.searchParams.get("bridgeSessionID") || "").trim();
  if (!bridgeSessionID || bridgeSessionID.length > 256) {
    return {
      error: [400, "INVALID_SESSION", "A bridgeSessionID is required."],
    };
  }
  const cursorResult = parseEventCursorParams(requestUrl);
  if (cursorResult.error) {
    return cursorResult;
  }
  return { userid, bridgeSessionID, cursor: cursorResult.cursor };
}

function rejectUpgrade(socket, status, code, message) {
  if (!socket || socket.destroyed) {
    return;
  }
  const body = JSON.stringify({
    ok: false,
    source: GATEWAY_SOURCE,
    apiVersion: GATEWAY_API_VERSION,
    error: code,
    message,
  });
  const statusText = {
    400: "Bad Request",
    401: "Unauthorized",
    403: "Forbidden",
    404: "Not Found",
    503: "Service Unavailable",
  }[status] || "Bad Request";
  try {
    socket.end(
      `HTTP/1.1 ${status} ${statusText}\r\n` +
      "Connection: close\r\n" +
      "Content-Type: application/json; charset=utf-8\r\n" +
      `Content-Length: ${Buffer.byteLength(body)}\r\n` +
      "\r\n" +
      body,
    );
  } catch {
    socket.destroy();
  }
}

function mountEvejsWebGatewayUpgrades(server, runtimeContext = null, options = {}) {
  if (
    !server ||
    typeof server.on !== "function" ||
    typeof server.removeListener !== "function"
  ) {
    throw new TypeError("gateway event stream requires an HTTP server");
  }
  const heartbeatIntervalMs = normalizePositiveLimit(
    options.heartbeatIntervalMs,
    DEFAULT_EVENT_HEARTBEAT_INTERVAL_MS,
  );
  const maxInboundFrameBytes = normalizePositiveLimit(
    options.maxInboundFrameBytes,
    DEFAULT_EVENT_MAX_INBOUND_FRAME_BYTES,
  );
  const maxOutboundFrameBytes = normalizePositiveLimit(
    options.maxOutboundFrameBytes,
    DEFAULT_EVENT_MAX_OUTBOUND_FRAME_BYTES,
  );
  const maxBufferedOutputBytes = normalizePositiveLimit(
    options.maxBufferedOutputBytes,
    DEFAULT_EVENT_MAX_BUFFERED_OUTPUT_BYTES,
  );
  const shutdownGraceMs = normalizePositiveLimit(
    options.shutdownGraceMs,
    DEFAULT_EVENT_SHUTDOWN_GRACE_MS,
  );
  const setIntervalFn = typeof options.setInterval === "function"
    ? options.setInterval
    : setInterval;
  const clearIntervalFn = typeof options.clearInterval === "function"
    ? options.clearInterval
    : clearInterval;
  const setTimeoutFn = typeof options.setTimeout === "function"
    ? options.setTimeout
    : setTimeout;
  const clearTimeoutFn = typeof options.clearTimeout === "function"
    ? options.clearTimeout
    : clearTimeout;

  const webSocketServer = new WebSocketServer({
    noServer: true,
    clientTracking: false,
    maxPayload: maxInboundFrameBytes,
    perMessageDeflate: false,
  });
  const activeSockets = new Set();
  const subscriptions = new Map();
  const heartbeatAlive = new WeakMap();
  let heartbeatHandle = null;
  let shutdownTimerHandle = null;
  let stopped = false;
  let shutdownPromise = null;

  function stopHeartbeat() {
    if (heartbeatHandle !== null) {
      clearIntervalFn(heartbeatHandle);
      heartbeatHandle = null;
    }
  }

  function closeSocket(socket, code, reason) {
    if (!socket) {
      return;
    }
    try {
      if (socket.readyState === WebSocket.OPEN) {
        socket.close(code, reason);
      } else if (socket.readyState !== WebSocket.CLOSED) {
        socket.terminate();
      }
    } catch {
      try {
        socket.terminate();
      } catch {
        // Socket is already gone.
      }
    }
  }

  function cleanupSocket(socket) {
    const unsubscribe = subscriptions.get(socket);
    subscriptions.delete(socket);
    if (typeof unsubscribe === "function") {
      try {
        unsubscribe();
      } catch {
        // Cleanup is best effort and must continue for every socket.
      }
    }
    activeSockets.delete(socket);
    if (activeSockets.size === 0) {
      stopHeartbeat();
    }
  }

  function heartbeat() {
    for (const socket of [...activeSockets]) {
      if (socket.readyState !== WebSocket.OPEN) {
        if (socket.readyState !== WebSocket.CLOSED) {
          try {
            socket.terminate();
          } catch {
            // Cleanup below still releases the authoritative subscription.
          }
        }
        cleanupSocket(socket);
        continue;
      }
      if (heartbeatAlive.get(socket) === false) {
        try {
          socket.terminate();
        } finally {
          cleanupSocket(socket);
        }
        continue;
      }
      heartbeatAlive.set(socket, false);
      try {
        socket.ping();
      } catch {
        try {
          socket.terminate();
        } finally {
          cleanupSocket(socket);
        }
      }
    }
  }

  function startHeartbeat() {
    if (heartbeatHandle !== null || stopped || activeSockets.size === 0) {
      return;
    }
    heartbeatHandle = setIntervalFn(heartbeat, heartbeatIntervalMs);
    if (heartbeatHandle && typeof heartbeatHandle.unref === "function") {
      heartbeatHandle.unref();
    }
  }

  function sendFrame(socket, frame) {
    if (socket.readyState !== WebSocket.OPEN) {
      return false;
    }
    let payload;
    try {
      payload = JSON.stringify(frame);
    } catch {
      closeSocket(socket, 1011, "event serialization failed");
      return false;
    }
    const frameBytes = Buffer.byteLength(payload);
    if (frameBytes > maxOutboundFrameBytes) {
      closeSocket(socket, 1009, "event frame is too large");
      return false;
    }
    if (socket.bufferedAmount + frameBytes > maxBufferedOutputBytes) {
      closeSocket(socket, 1009, "event output buffer limit exceeded");
      return false;
    }
    try {
      socket.send(payload, { binary: false }, (error) => {
        if (error) {
          closeSocket(socket, 1011, "event delivery failed");
        }
      });
      return true;
    } catch {
      closeSocket(socket, 1011, "event delivery failed");
      return false;
    }
  }

  function openConnection(socket, request, eventRequest) {
    activeSockets.add(socket);
    heartbeatAlive.set(socket, true);
    socket.on("pong", () => heartbeatAlive.set(socket, true));
    socket.on("message", () => {
      closeSocket(socket, 1008, "client event messages are not supported");
    });
    socket.on("error", () => {
      // The close path owns cleanup; suppress an unhandled EventEmitter error.
    });
    socket.once("close", () => cleanupSocket(socket));
    startHeartbeat();

    try {
      const runtime = getGatewayRuntime(runtimeContext);
      const unsubscribe = runtime.subscribeCharacterEvents(
        eventRequest.characterID,
        eventRequest.cursor,
        {
          onFrame(frame) {
            return sendFrame(socket, frame);
          },
          onClose(details) {
            if (details && details.reason === "shutdown") {
              closeSocket(socket, 1012, "event stream shutting down");
            }
          },
        },
      );
      subscriptions.set(socket, unsubscribe);
    } catch {
      closeSocket(socket, 1011, "event subscription failed");
    }
  }

  // Goal R10: the bridge-session push connection. Same socket lifecycle as the
  // character-event connection above; only the subscription differs.
  function openSessionConnection(socket, sessionRequest) {
    activeSockets.add(socket);
    heartbeatAlive.set(socket, true);
    socket.on("pong", () => heartbeatAlive.set(socket, true));
    socket.on("message", () => {
      closeSocket(socket, 1008, "client event messages are not supported");
    });
    socket.on("error", () => {
      // The close path owns cleanup; suppress an unhandled EventEmitter error.
    });
    socket.once("close", () => cleanupSocket(socket));
    startHeartbeat();

    try {
      const runtime = getGatewayRuntime(runtimeContext);
      const unsubscribe = runtime.subscribeSessionEvents(
        sessionRequest.bridgeSessionID,
        sessionRequest.userid,
        sessionRequest.cursor,
        {
          onFrame(frame) {
            return sendFrame(socket, frame);
          },
          onClose(details) {
            const reason = details && details.reason;
            if (reason === "shutdown") {
              closeSocket(socket, 1012, "event stream shutting down");
              return;
            }
            if (reason && reason !== "unsubscribed" && reason !== "consumer_rejected") {
              // The bridge session itself ended (released, expired, evicted):
              // the stream can never produce another frame, so say so rather
              // than leaving the browser holding a silent socket.
              closeSocket(socket, 1000, "bridge session ended");
            }
          },
        },
      );
      subscriptions.set(socket, unsubscribe);
    } catch {
      closeSocket(socket, 1011, "event subscription failed");
    }
  }

  function onSessionUpgrade(request, socket, head, requestUrl) {
    const sessionRequest = parseSessionEventUpgradeRequest(requestUrl);
    if (sessionRequest.error) {
      rejectUpgrade(socket, ...sessionRequest.error);
      return;
    }
    if (stopped || !hasReadyGatewayRuntime(runtimeContext)) {
      rejectUpgrade(
        socket,
        503,
        RUNTIME_NOT_READY_CODE,
        "Authoritative EveJS gateway runtime is not ready.",
      );
      return;
    }
    // Resolve-and-authorize BEFORE completing the handshake, so a foreign or
    // unknown bridgeSessionID is refused with an HTTP status the BFF can read
    // instead of an opened-then-closed socket.
    const runtime = getGatewayRuntime(runtimeContext);
    try {
      runtime.authorizeSessionEvents(
        sessionRequest.bridgeSessionID,
        sessionRequest.userid,
      );
    } catch (error) {
      const code = String(error && error.code || "");
      if (code === "SESSION_NOT_FOUND" || code === "CALL_INVALID") {
        rejectUpgrade(
          socket,
          404,
          "SESSION_NOT_FOUND",
          "Unknown, expired, or released bridge session.",
        );
        return;
      }
      rejectUpgrade(
        socket,
        503,
        RUNTIME_NOT_READY_CODE,
        "Authoritative EveJS gateway runtime is not ready.",
      );
      return;
    }
    try {
      webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
        openSessionConnection(webSocket, sessionRequest);
      });
    } catch {
      rejectUpgrade(
        socket,
        400,
        "INVALID_EVENT_UPGRADE",
        "Event-stream WebSocket upgrade is invalid.",
      );
    }
  }

  function onUpgrade(request, socket, head) {
    if (!authorizeGatewayUpgrade(request)) {
      rejectUpgrade(
        socket,
        401,
        "UNAUTHORIZED",
        "Gateway event-stream request is not authorized.",
      );
      return;
    }
    let requestUrl;
    try {
      requestUrl = new URL(String(request && request.url || ""), "http://evejs.invalid");
    } catch {
      rejectUpgrade(
        socket,
        400,
        "INVALID_EVENT_REQUEST",
        "Event-stream request is invalid.",
      );
      return;
    }
    if (requestUrl.pathname === SESSION_EVENTS_PATH) {
      onSessionUpgrade(request, socket, head, requestUrl);
      return;
    }
    const eventRequest = parseEventUpgradeRequest(request);
    if (eventRequest.error) {
      rejectUpgrade(socket, ...eventRequest.error);
      return;
    }
    if (stopped || !hasReadyGatewayRuntime(runtimeContext)) {
      rejectUpgrade(
        socket,
        503,
        RUNTIME_NOT_READY_CODE,
        "Authoritative EveJS gateway runtime is not ready.",
      );
      return;
    }
    const runtime = getGatewayRuntime(runtimeContext);
    let ownership;
    try {
      ownership = validateOwnedCharacter(
        runtime,
        eventRequest.accountID,
        eventRequest.characterID,
      );
    } catch {
      rejectUpgrade(
        socket,
        503,
        RUNTIME_NOT_READY_CODE,
        "Authoritative EveJS gateway runtime is not ready.",
      );
      return;
    }
    if (ownership.error) {
      rejectUpgrade(socket, ...ownership.error);
      return;
    }
    try {
      webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
        openConnection(webSocket, request, eventRequest);
      });
    } catch {
      rejectUpgrade(
        socket,
        400,
        "INVALID_EVENT_UPGRADE",
        "Event-stream WebSocket upgrade is invalid.",
      );
    }
  }

  function getDiagnostics() {
    return Object.freeze({
      stopped,
      activeSocketCount: activeSockets.size,
      subscriptionCount: subscriptions.size,
      heartbeatActive: heartbeatHandle !== null,
      shutdownTimerActive: shutdownTimerHandle !== null,
    });
  }

  function shutdown() {
    if (shutdownPromise) {
      return shutdownPromise;
    }
    stopped = true;
    server.removeListener("upgrade", onUpgrade);
    server.removeListener("close", onServerClose);
    stopHeartbeat();
    for (const unsubscribe of subscriptions.values()) {
      try {
        unsubscribe();
      } catch {
        // Continue tearing down every subscription.
      }
    }
    subscriptions.clear();
    const closingSockets = [...activeSockets];
    if (closingSockets.length === 0) {
      shutdownPromise = Promise.resolve();
      return shutdownPromise;
    }
    shutdownPromise = new Promise((resolve) => {
      let remaining = closingSockets.length;
      let resolved = false;
      function finish() {
        if (resolved) {
          return;
        }
        resolved = true;
        if (shutdownTimerHandle !== null) {
          clearTimeoutFn(shutdownTimerHandle);
          shutdownTimerHandle = null;
        }
        for (const socket of [...activeSockets]) {
          try {
            socket.terminate();
          } catch {
            // Socket is already closed.
          }
          cleanupSocket(socket);
        }
        resolve();
      }
      shutdownTimerHandle = setTimeoutFn(finish, shutdownGraceMs);
      if (
        shutdownTimerHandle &&
        typeof shutdownTimerHandle.unref === "function"
      ) {
        shutdownTimerHandle.unref();
      }
      for (const socket of closingSockets) {
        socket.once("close", () => {
          remaining -= 1;
          if (remaining === 0) {
            finish();
          }
        });
        closeSocket(socket, 1012, "event stream shutting down");
      }
    });
    return shutdownPromise;
  }

  function onServerClose() {
    void shutdown();
  }

  server.on("upgrade", onUpgrade);
  server.once("close", onServerClose);
  return Object.freeze({ getDiagnostics, shutdown });
}

function sendCharacterControlFailure(res, error) {
  const code = String(error && error.code || "");
  const knownStatuses = {
    CHARACTER_CONTROL_RETAIL_CLIENT: 409,
    CHARACTER_CONTROL_BROWSER_PILOT: 409,
    CHARACTER_LEASE_EXPIRED: 409,
    CHARACTER_LEASE_INVALID: 403,
    CHARACTER_CONTROL_UNAVAILABLE: 503,
  };
  if (knownStatuses[code]) {
    sendGatewayError(
      res,
      knownStatuses[code],
      code,
      error && error.message
        ? error.message
        : "Character-control operation failed.",
    );
    return;
  }
  sendGatewayError(
    res,
    503,
    "CHARACTER_CONTROL_UNAVAILABLE",
    "Authoritative character control is unavailable.",
  );
}

function sendCharacterCommandFailure(res, error) {
  const code = String(error && error.code || "");
  const commandDetails = CHARACTER_COMMAND_ERROR_DETAILS[code];
  if (commandDetails) {
    sendGatewayError(
      res,
      commandDetails.status,
      code,
      commandDetails.message,
    );
    return;
  }
  if (code.startsWith("CHARACTER_CONTROL_") || code.startsWith("CHARACTER_LEASE_")) {
    sendCharacterControlFailure(res, error);
    return;
  }
  if (PUBLIC_SKILL_QUEUE_ERROR_CODES.has(code)) {
    sendGatewayError(
      res,
      400,
      code,
      `Skill queue command was rejected: ${code}.`,
    );
    return;
  }
  if (PUBLIC_PI_RESTART_ERROR_CODES.has(code)) {
    sendGatewayError(
      res,
      400,
      code,
      `PI extractor restart command was rejected: ${code}.`,
    );
    return;
  }
  const unavailable = CHARACTER_COMMAND_ERROR_DETAILS.CHARACTER_COMMAND_UNAVAILABLE;
  sendGatewayError(
    res,
    unavailable.status,
    "CHARACTER_COMMAND_UNAVAILABLE",
    unavailable.message,
  );
}

function sendCallFailure(res, error) {
  const code = String(error && error.code || "");
  if (CALL_ERROR_STATUS_CODES[code]) {
    sendGatewayError(
      res,
      CALL_ERROR_STATUS_CODES[code],
      code,
      error && error.message ? error.message : "EveJS service call failed.",
    );
    return;
  }
  sendGatewayError(res, 502, "CALL_FAILED", "EveJS service call failed.");
}

function mountEvejsWebGateway(app, runtimeContext = null) {
  function requireAuthorizedRuntime(handler) {
    return async (req, res) => {
      if (!authorizeGatewayRequest(req)) {
        sendGatewayError(res, 401, "UNAUTHORIZED", "Gateway request is not authorized.");
        return;
      }
      if (!hasReadyGatewayRuntime(runtimeContext)) {
        sendRuntimeNotReady(res);
        return;
      }
      await handler(getGatewayRuntime(runtimeContext), req, res);
    };
  }

  app.get(`${GATEWAY_PREFIX}/health`, (req, res) => {
    if (!authorizeGatewayRequest(req)) {
      sendGatewayError(res, 401, "UNAUTHORIZED", "Gateway request is not authorized.");
      return;
    }
    res.status(200).json(buildGatewayHealth(runtimeContext));
  });

  app.get(`${GATEWAY_PREFIX}/status`, requireAuthorizedRuntime((runtime, req, res) => {
    res.status(200).json({
      ok: true,
      source: GATEWAY_SOURCE,
      apiVersion: GATEWAY_API_VERSION,
      ...runtime.getStatus(),
    });
  }));

  app.get(`${GATEWAY_PREFIX}/accounts`, requireAuthorizedRuntime((runtime, req, res) => {
    res.status(200).json({
      ok: true,
      source: GATEWAY_SOURCE,
      apiVersion: GATEWAY_API_VERSION,
      accounts: runtime.listAccounts(),
    });
  }));

  app.get(`${GATEWAY_PREFIX}/account`, requireAuthorizedRuntime((runtime, req, res) => {
    const account = runtime.getAccountByUsername(req.query.username);
    if (!account) {
      sendGatewayError(res, 404, "ACCOUNT_NOT_FOUND", "Account was not found.");
      return;
    }
    res.status(200).json({
      ok: true,
      source: GATEWAY_SOURCE,
      apiVersion: GATEWAY_API_VERSION,
      account,
    });
  }));

  app.get(`${GATEWAY_PREFIX}/characters`, requireAuthorizedRuntime((runtime, req, res) => {
    const accountID = readPositiveID(req.query.accountID);
    if (!accountID) {
      sendGatewayError(res, 400, "INVALID_ACCOUNT", "A positive accountID is required.");
      return;
    }
    if (!runtime.getAccountByID(accountID)) {
      sendGatewayError(res, 404, "ACCOUNT_NOT_FOUND", "Account was not found.");
      return;
    }
    res.status(200).json({
      ok: true,
      source: GATEWAY_SOURCE,
      apiVersion: GATEWAY_API_VERSION,
      characters: runtime.listCharacters(accountID),
    });
  }));

  app.get(`${GATEWAY_PREFIX}/snapshot`, requireAuthorizedRuntime((runtime, req, res) => {
    const ownership = validateOwnedCharacter(
      runtime,
      req.query.accountID,
      req.query.characterID,
    );
    if (ownership.error) {
      sendGatewayError(res, ...ownership.error);
      return;
    }
    const snapshot = runtime.buildSnapshot(ownership.accountID, ownership.characterID);
    if (!snapshot) {
      sendGatewayError(res, 404, "CHARACTER_NOT_FOUND", "Character was not found.");
      return;
    }
    res.status(200).json({
      ok: true,
      source: GATEWAY_SOURCE,
      apiVersion: GATEWAY_API_VERSION,
      snapshot,
    });
  }));

  // R28: the skill sheet + training queue, already resolved (names, groups, the
  // SP threshold for every level, and the queue's instants as epoch ms against
  // `serverNowMs` sampled in the same read). Same ownership rule as /snapshot,
  // and — like /snapshot — NO bridge session is required: reading what a
  // character knows is not an act of piloting.
  app.get(`${GATEWAY_PREFIX}/skills`, requireAuthorizedRuntime((runtime, req, res) => {
    const ownership = validateOwnedCharacter(
      runtime,
      req.query.accountID,
      req.query.characterID,
    );
    if (ownership.error) {
      sendGatewayError(res, ...ownership.error);
      return;
    }
    const skills = runtime.buildSkillSheet(ownership.accountID, ownership.characterID);
    if (!skills) {
      sendGatewayError(res, 404, "CHARACTER_NOT_FOUND", "Character was not found.");
      return;
    }
    res.status(200).json({
      ok: true,
      source: GATEWAY_SOURCE,
      apiVersion: GATEWAY_API_VERSION,
      skills,
    });
  }));

  app.get(`${GATEWAY_PREFIX}/character-status`, requireAuthorizedRuntime((runtime, req, res) => {
    const ownership = validateOwnedCharacter(
      runtime,
      req.query.accountID,
      req.query.characterID,
    );
    if (ownership.error) {
      sendGatewayError(res, ...ownership.error);
      return;
    }
    try {
      res.status(200).json({
        ok: true,
        source: GATEWAY_SOURCE,
        apiVersion: GATEWAY_API_VERSION,
        ...runtime.getCharacterControlStatus(ownership.characterID),
      });
    } catch (error) {
      sendCharacterControlFailure(res, error);
    }
  }));

  app.post(`${GATEWAY_PREFIX}/character-control/claim`, requireAuthorizedRuntime((runtime, req, res) => {
    const body = req.body || {};
    const ownership = validateOwnedCharacter(runtime, body.accountID, body.characterID);
    if (ownership.error) {
      sendGatewayError(res, ...ownership.error);
      return;
    }
    try {
      const result = runtime.claimBrowserControl(
        ownership.characterID,
        body.controllerID,
      );
      res.status(200).json({
        ok: true,
        source: GATEWAY_SOURCE,
        apiVersion: GATEWAY_API_VERSION,
        control: result.control,
        credentials: result.credentials,
      });
    } catch (error) {
      sendCharacterControlFailure(res, error);
    }
  }));

  app.post(`${GATEWAY_PREFIX}/character-control/renew`, requireAuthorizedRuntime((runtime, req, res) => {
    const body = req.body || {};
    const ownership = validateOwnedCharacter(runtime, body.accountID, body.characterID);
    if (ownership.error) {
      sendGatewayError(res, ...ownership.error);
      return;
    }
    try {
      const result = runtime.renewBrowserControl(
        ownership.characterID,
        body.controllerID,
        body.leaseID,
        body.leaseSecret,
      );
      res.status(200).json({
        ok: true,
        source: GATEWAY_SOURCE,
        apiVersion: GATEWAY_API_VERSION,
        control: result.control,
      });
    } catch (error) {
      sendCharacterControlFailure(res, error);
    }
  }));

  app.post(`${GATEWAY_PREFIX}/character-control/release`, requireAuthorizedRuntime((runtime, req, res) => {
    const body = req.body || {};
    const ownership = validateOwnedCharacter(runtime, body.accountID, body.characterID);
    if (ownership.error) {
      sendGatewayError(res, ...ownership.error);
      return;
    }
    try {
      const result = runtime.releaseBrowserControl(
        ownership.characterID,
        body.controllerID,
        body.leaseID,
        body.leaseSecret,
      );
      res.status(200).json({
        ok: true,
        source: GATEWAY_SOURCE,
        apiVersion: GATEWAY_API_VERSION,
        control: result.control,
      });
    } catch (error) {
      sendCharacterControlFailure(res, error);
    }
  }));

  app.post(`${GATEWAY_PREFIX}/skill-queue`, requireAuthorizedRuntime(async (runtime, req, res) => {
    const body = req.body || {};
    const ownership = validateOwnedCharacter(runtime, body.accountID, body.characterID);
    if (ownership.error) {
      sendGatewayError(res, ...ownership.error);
      return;
    }
    try {
      const result = await runtime.submitSkillQueueSaveCommand(
        ownership.characterID,
        body.command,
      );
      res.status(200).json({
        ok: true,
        source: GATEWAY_SOURCE,
        apiVersion: GATEWAY_API_VERSION,
        snapshot: result.snapshot,
        stateVersion: result.stateVersion,
      });
    } catch (error) {
      sendCharacterCommandFailure(
        res,
        error,
      );
    }
  }));

  app.post(`${GATEWAY_PREFIX}/pi/restart-extractors`, requireAuthorizedRuntime(async (runtime, req, res) => {
    const body = req.body || {};
    const ownership = validateOwnedCharacter(runtime, body.accountID, body.characterID);
    if (ownership.error) {
      sendGatewayError(res, ...ownership.error);
      return;
    }
    try {
      const result = await runtime.submitPiRestartExtractorsCommand(
        ownership.characterID,
        body.command,
      );
      res.status(200).json({
        ok: true,
        source: GATEWAY_SOURCE,
        apiVersion: GATEWAY_API_VERSION,
        summary: result.summary,
        stateVersion: result.stateVersion,
      });
    } catch (error) {
      sendCharacterCommandFailure(
        res,
        error,
      );
    }
  }));

  // Whitelisted (service, method, args, kwargs) invocation path for the
  // browser-backed bridge. The runtime enforces the deny-by-default pair
  // allowlist, materializes the browser-backed session from the JSON session
  // fields, and dispatches through the retail seam
  // serviceManager.lookup(service).callMethod(method, args, session, kwargs).
  app.post(`${GATEWAY_PREFIX}/call`, requireAuthorizedRuntime(async (runtime, req, res) => {
    if (typeof runtime.callServiceMethod !== "function") {
      sendGatewayError(
        res,
        503,
        "CALL_SERVICE_UNAVAILABLE",
        "Whitelisted service-call bridge is not available.",
      );
      return;
    }
    const body = req.body || {};
    try {
      const outcome = await runtime.callServiceMethod({
        service: body.service,
        method: body.method,
        args: body.args,
        kwargs: body.kwargs,
        session: body.session,
        // Optional persistent-session handle (goal R2): when present the call
        // runs on the stored live session instead of a per-call one.
        bridgeSessionID: body.bridgeSessionID,
      });
      res.status(200).json({
        ok: true,
        source: GATEWAY_SOURCE,
        apiVersion: GATEWAY_API_VERSION,
        service: outcome.service,
        method: outcome.method,
        result: outcome.result === undefined ? null : outcome.result,
        notifications: outcome.notifications,
      });
    } catch (error) {
      sendCallFailure(res, error);
    }
  }));

  // Persistent browser-backed session lifecycle (web-client goal R2).
  // select mints a live session and dispatches the retail tuple
  // charUnboundMgr.SelectCharacterID on it through the same allowlisted
  // callMethod seam; the returned opaque bridgeSessionID is held server-side
  // by the BFF (it must never reach browser JS). release runs the same
  // disconnect path a retail socket close runs; an idle TTL reaps abandoned
  // sessions the same way.
  app.post(`${GATEWAY_PREFIX}/session/select`, requireAuthorizedRuntime(async (runtime, req, res) => {
    if (typeof runtime.selectCharacter !== "function") {
      sendGatewayError(
        res,
        503,
        "CALL_SERVICE_UNAVAILABLE",
        "Persistent-session bridge is not available.",
      );
      return;
    }
    const body = req.body || {};
    try {
      const outcome = await runtime.selectCharacter({
        args: body.args,
        kwargs: body.kwargs,
        session: body.session,
      });
      res.status(200).json({
        ok: true,
        source: GATEWAY_SOURCE,
        apiVersion: GATEWAY_API_VERSION,
        bridgeSessionID: outcome.bridgeSessionID,
        service: outcome.service,
        method: outcome.method,
        result: outcome.result === undefined ? null : outcome.result,
        notifications: outcome.notifications,
        session: outcome.session,
      });
    } catch (error) {
      sendCallFailure(res, error);
    }
  }));

  app.post(`${GATEWAY_PREFIX}/session/release`, requireAuthorizedRuntime(async (runtime, req, res) => {
    if (typeof runtime.releaseBrowserSession !== "function") {
      sendGatewayError(
        res,
        503,
        "CALL_SERVICE_UNAVAILABLE",
        "Persistent-session bridge is not available.",
      );
      return;
    }
    const body = req.body || {};
    try {
      const outcome = runtime.releaseBrowserSession({
        bridgeSessionID: body.bridgeSessionID,
        session: body.session,
      });
      res.status(200).json({
        ok: true,
        source: GATEWAY_SOURCE,
        apiVersion: GATEWAY_API_VERSION,
        released: outcome.released === true,
        characterID: outcome.characterID === undefined ? null : outcome.characterID,
      });
    } catch (error) {
      sendCallFailure(res, error);
    }
  }));

  // Bound-object bridge (web-client goal R3): the retail two-step
  // moniker/MachoBindObject call pattern on the persistent session. bind
  // dispatches an allowlisted bind method and returns an opaque boundHandle
  // (the bound OID is confined to the gateway, held on the persistent session,
  // and never reaches the BFF or browser); call dispatches an allowlisted
  // bound method on a held handle. Deny-by-default governs both the bind pair
  // and the bound-method pair. Wire contract: docs/bridge-wire-contract.md.
  app.post(`${GATEWAY_PREFIX}/bound/bind`, requireAuthorizedRuntime(async (runtime, req, res) => {
    if (typeof runtime.bindBoundObject !== "function") {
      sendGatewayError(
        res,
        503,
        "CALL_SERVICE_UNAVAILABLE",
        "Bound-object bridge is not available.",
      );
      return;
    }
    const body = req.body || {};
    try {
      const outcome = await runtime.bindBoundObject({
        service: body.service,
        method: body.method,
        args: body.args,
        kwargs: body.kwargs,
        session: body.session,
        bridgeSessionID: body.bridgeSessionID,
      });
      res.status(200).json({
        ok: true,
        source: GATEWAY_SOURCE,
        apiVersion: GATEWAY_API_VERSION,
        boundHandle: outcome.boundHandle,
        service: outcome.service,
        method: outcome.method,
        notifications: outcome.notifications,
      });
    } catch (error) {
      sendCallFailure(res, error);
    }
  }));

  app.post(`${GATEWAY_PREFIX}/bound/call`, requireAuthorizedRuntime(async (runtime, req, res) => {
    if (typeof runtime.callBoundMethod !== "function") {
      sendGatewayError(
        res,
        503,
        "CALL_SERVICE_UNAVAILABLE",
        "Bound-object bridge is not available.",
      );
      return;
    }
    const body = req.body || {};
    try {
      const outcome = await runtime.callBoundMethod({
        service: body.service,
        method: body.method,
        args: body.args,
        kwargs: body.kwargs,
        session: body.session,
        bridgeSessionID: body.bridgeSessionID,
        boundHandle: body.boundHandle,
      });
      res.status(200).json({
        ok: true,
        source: GATEWAY_SOURCE,
        apiVersion: GATEWAY_API_VERSION,
        service: outcome.service,
        method: outcome.method,
        result: outcome.result === undefined ? null : outcome.result,
        notifications: outcome.notifications,
      });
    } catch (error) {
      sendCallFailure(res, error);
    }
  }));

  // R5a flight status: a read-only snapshot of the held session's current
  // location + ship movement state, for the browser's manual "Refresh flight
  // status" between movement steps (full push streaming is G6). It reads the
  // live session scalars the gateway already holds and drains the accumulated
  // notification backlog, so a movement's OnSessionChanged is delivered here
  // too.
  app.post(`${GATEWAY_PREFIX}/session/flight-status`, requireAuthorizedRuntime((runtime, req, res) => {
    if (typeof runtime.readFlightStatus !== "function") {
      sendGatewayError(
        res,
        503,
        "CALL_SERVICE_UNAVAILABLE",
        "Flight-status read is not available.",
      );
      return;
    }
    const body = req.body || {};
    try {
      const outcome = runtime.readFlightStatus({
        session: body.session,
        bridgeSessionID: body.bridgeSessionID,
      });
      res.status(200).json({
        ok: true,
        source: GATEWAY_SOURCE,
        apiVersion: GATEWAY_API_VERSION,
        flight: outcome.flight,
        notifications: outcome.notifications,
      });
    } catch (error) {
      sendCallFailure(res, error);
    }
  }));

  // R11 space snapshot: what the held session can SEE right now — the scene's
  // visible entities (cloak-filtered by the runtime) plus the active ship's
  // shield/armor/hull/capacitor. Read-only; it calls the space runtime and never
  // mutates it. The browser polls this ~1s while in space with the overview
  // open, which matches the retail client's own 0.5-1.0s ballpark re-render;
  // distance, sorting and filtering are computed browser-side from the projected
  // positions, exactly as retail does. Wire contract:
  // docs/bridge-wire-contract.md ("Space snapshot (R11)").
  app.post(`${GATEWAY_PREFIX}/space/snapshot`, requireAuthorizedRuntime((runtime, req, res) => {
    if (typeof runtime.readSpaceSnapshot !== "function") {
      sendGatewayError(
        res,
        503,
        "CALL_SERVICE_UNAVAILABLE",
        "Space-snapshot read is not available.",
      );
      return;
    }
    const body = req.body || {};
    try {
      const outcome = runtime.readSpaceSnapshot({
        session: body.session,
        bridgeSessionID: body.bridgeSessionID,
      });
      res.status(200).json({
        ok: true,
        source: GATEWAY_SOURCE,
        apiVersion: GATEWAY_API_VERSION,
        space: outcome.space,
        notifications: outcome.notifications,
      });
    } catch (error) {
      sendCallFailure(res, error);
    }
  }));

  // R7 Local + Corp chat. read returns the channel's current member roster +
  // recent backlog for the held session (chat delivery bypasses the notify
  // drain, so READ is a backlog poll — the browser polls this on a modest
  // interval while the Chat panel is open); send broadcasts to Local
  // (chatRuntime.broadcastLocalMessage) or Corp (a session-derived corp
  // broadcast that writes the corp_<id> backlog, mirroring Local — NOT an XMPP
  // send). Presence is re-synced on each read/send + on select. Wire contract:
  // docs/bridge-wire-contract.md ("Local + Corp chat (R7)").
  app.post(`${GATEWAY_PREFIX}/chat/read`, requireAuthorizedRuntime((runtime, req, res) => {
    if (typeof runtime.readChat !== "function") {
      sendGatewayError(
        res,
        503,
        "CALL_SERVICE_UNAVAILABLE",
        "Chat read is not available.",
      );
      return;
    }
    const body = req.body || {};
    try {
      const outcome = runtime.readChat({
        session: body.session,
        bridgeSessionID: body.bridgeSessionID,
        channel: body.channel,
        limit: body.limit,
      });
      res.status(200).json({
        ok: true,
        source: GATEWAY_SOURCE,
        apiVersion: GATEWAY_API_VERSION,
        chat: outcome.chat,
        notifications: outcome.notifications,
      });
    } catch (error) {
      sendCallFailure(res, error);
    }
  }));

  app.post(`${GATEWAY_PREFIX}/chat/send`, requireAuthorizedRuntime((runtime, req, res) => {
    if (typeof runtime.sendChat !== "function") {
      sendGatewayError(
        res,
        503,
        "CALL_SERVICE_UNAVAILABLE",
        "Chat send is not available.",
      );
      return;
    }
    const body = req.body || {};
    try {
      const outcome = runtime.sendChat({
        session: body.session,
        bridgeSessionID: body.bridgeSessionID,
        channel: body.channel,
        message: body.message,
      });
      res.status(200).json({
        ok: true,
        source: GATEWAY_SOURCE,
        apiVersion: GATEWAY_API_VERSION,
        chat: outcome.chat,
        notifications: outcome.notifications,
      });
    } catch (error) {
      sendCallFailure(res, error);
    }
  }));

  app.get(`${GATEWAY_PREFIX}/market/station-asks`, requireAuthorizedRuntime(async (runtime, req, res) => {
    const stationID = readPositiveID(req.query.stationID);
    if (!stationID) {
      sendGatewayError(res, 400, "INVALID_STATION", "stationID is required.");
      return;
    }
    try {
      const rows = await runtime.getStationAsks(stationID);
      res.status(200).json({
        ok: true,
        source: GATEWAY_SOURCE,
        apiVersion: GATEWAY_API_VERSION,
        rows,
      });
    } catch (error) {
      sendGatewayError(
        res,
        503,
        "MARKET_UNAVAILABLE",
        error && error.message ? error.message : "Market daemon unavailable.",
      );
    }
  }));

  app.all(/^\/_evejs-web(?:\/|$)/, (req, res) => {
    if (!authorizeGatewayRequest(req)) {
      sendGatewayError(res, 401, "UNAUTHORIZED", "Gateway request is not authorized.");
      return;
    }
    const requestPath = String(req.originalUrl || req.url || "").split("?", 1)[0];
    if (requestPath.startsWith(`${GATEWAY_PREFIX}/`) && !hasReadyGatewayRuntime(runtimeContext)) {
      sendRuntimeNotReady(res);
      return;
    }
    sendGatewayError(
      res,
      404,
      "GATEWAY_ROUTE_NOT_FOUND",
      "EveJS web gateway route was not found.",
    );
  });

  app.use((error, req, res, next) => {
    if (!isGatewayNamespaceRequest(req)) {
      next(error);
      return;
    }
    if (!authorizeGatewayRequest(req)) {
      sendGatewayError(res, 401, "UNAUTHORIZED", "Gateway request is not authorized.");
      return;
    }
    const requestPath = String(req.originalUrl || req.url || "").split("?", 1)[0];
    if (
      requestPath !== `${GATEWAY_PREFIX}/health` &&
      requestPath.startsWith(`${GATEWAY_PREFIX}/`) &&
      !hasReadyGatewayRuntime(runtimeContext)
    ) {
      sendRuntimeNotReady(res);
      return;
    }
    const details = getGatewayErrorDetails(error);
    sendGatewayError(res, details.status, details.code, details.message);
  });
}

module.exports = {
  mountEvejsWebGateway,
  mountEvejsWebGatewayUpgrades,
};

module.exports.__testHooks = {
  authorizeGatewayUpgrade,
  buildGatewayHealth,
  getGatewayErrorDetails,
  hasReadyGatewayRuntime,
  isGatewayNamespaceRequest,
  parseEventUpgradeRequest,
  parseSessionEventUpgradeRequest,
  readPositiveID,
  rejectUpgrade,
  sendCharacterCommandFailure,
  sendCharacterControlFailure,
  validateOwnedCharacter,
};
