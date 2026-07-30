"use strict";

const crypto = require("node:crypto");
const path = require("node:path");

const sessionRegistry = require(path.join(__dirname, "../chat/sessionRegistry"));

const CONTROL_STATES = Object.freeze({
  OFFLINE: "offline",
  RETAIL_CLIENT: "retail_client",
  BROWSER_PILOT: "browser_pilot",
});

const CONTROL_TRANSPORTS = Object.freeze({
  RETAIL_CLIENT: "tcp",
  BROWSER_PILOT: "web",
});

const DEFAULT_BROWSER_LEASE_TTL_MS = 60_000;
const MAX_EXPIRED_LEASES_PER_CHARACTER = 8;

const ERROR_CODES = Object.freeze({
  RETAIL_CLIENT: "CHARACTER_CONTROL_RETAIL_CLIENT",
  BROWSER_PILOT: "CHARACTER_CONTROL_BROWSER_PILOT",
  LEASE_EXPIRED: "CHARACTER_LEASE_EXPIRED",
  LEASE_INVALID: "CHARACTER_LEASE_INVALID",
  UNAVAILABLE: "CHARACTER_CONTROL_UNAVAILABLE",
});

class CharacterControlError extends Error {
  constructor(code, message, statusCode) {
    super(message);
    this.name = "CharacterControlError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function normalizeCharacterID(value) {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : 0;
}

function normalizeControllerID(value) {
  const normalized = String(value || "").trim();
  return normalized.length >= 16 && normalized.length <= 256 ? normalized : "";
}

function normalizeTtlMs(value, fallback = DEFAULT_BROWSER_LEASE_TTL_MS) {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : fallback;
}

function asOpaqueToken(value) {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return Buffer.from(value).toString("base64url");
  }
  return String(value || "");
}

function digestLeaseSecret(secret) {
  return crypto.createHash("sha256").update(String(secret || ""), "utf8").digest();
}

function secretDigestMatches(secret, expectedDigest) {
  if (!Buffer.isBuffer(expectedDigest)) {
    return false;
  }
  const candidate = digestLeaseSecret(secret);
  return candidate.length === expectedDigest.length &&
    crypto.timingSafeEqual(candidate, expectedDigest);
}

function makeSnapshot(characterID, controlState, options = {}) {
  const browserControlled = controlState === CONTROL_STATES.BROWSER_PILOT;
  return Object.freeze({
    characterID,
    online: controlState !== CONTROL_STATES.OFFLINE,
    controlState,
    transport:
      controlState === CONTROL_STATES.RETAIL_CLIENT
        ? CONTROL_TRANSPORTS.RETAIL_CLIENT
        : browserControlled
          ? CONTROL_TRANSPORTS.BROWSER_PILOT
          : null,
    leaseExpiresAt: browserControlled && Number.isFinite(options.expiresAtMs)
      ? new Date(options.expiresAtMs).toISOString()
      : null,
  });
}

function makeControlError(code) {
  switch (code) {
    case ERROR_CODES.RETAIL_CLIENT:
      return new CharacterControlError(
        code,
        "Character is controlled by a retail client.",
        409,
      );
    case ERROR_CODES.BROWSER_PILOT:
      return new CharacterControlError(
        code,
        "Character already has an active browser-pilot lease.",
        409,
      );
    case ERROR_CODES.LEASE_EXPIRED:
      return new CharacterControlError(
        code,
        "Browser-pilot lease has expired.",
        409,
      );
    case ERROR_CODES.LEASE_INVALID:
      return new CharacterControlError(
        code,
        "Browser-pilot lease credentials are invalid.",
        403,
      );
    default:
      return new CharacterControlError(
        ERROR_CODES.UNAVAILABLE,
        "Authoritative character control is unavailable.",
        503,
      );
  }
}

function createCharacterControlRuntime(options = {}) {
  const clock = options.clock && typeof options.clock.now === "function"
    ? options.clock
    : { now: typeof options.now === "function" ? options.now : Date.now };
  const randomness = options.randomness &&
    typeof options.randomness.randomBytes === "function"
    ? options.randomness
    : {
        randomBytes: typeof options.randomBytes === "function"
          ? options.randomBytes
          : crypto.randomBytes,
      };
  const timers = options.timers || {};
  const setTimer = typeof timers.setTimeout === "function"
    ? timers.setTimeout.bind(timers)
    : typeof options.setTimeout === "function"
      ? options.setTimeout
      : setTimeout;
  const clearTimer = typeof timers.clearTimeout === "function"
    ? timers.clearTimeout.bind(timers)
    : typeof options.clearTimeout === "function"
      ? options.clearTimeout
      : clearTimeout;
  const findRetailSession = typeof options.findRetailSession === "function"
    ? options.findRetailSession
    : () => null;
  const defaultTtlMs = normalizeTtlMs(options.defaultTtlMs);

  const browserLeases = new Map();
  const expiredLeases = new Map();
  const transitionListeners = new Set();

  function nowMs() {
    const value = Number(clock.now());
    return Number.isFinite(value) ? value : Date.now();
  }

  function offlineSnapshot(characterID) {
    return makeSnapshot(characterID, CONTROL_STATES.OFFLINE);
  }

  function retailSnapshot(characterID) {
    return makeSnapshot(characterID, CONTROL_STATES.RETAIL_CLIENT);
  }

  function browserSnapshot(characterID, lease) {
    return makeSnapshot(characterID, CONTROL_STATES.BROWSER_PILOT, {
      expiresAtMs: lease.expiresAtMs,
    });
  }

  function notifyTransition(previous, current, metadata = {}) {
    if (!previous || !current || previous.controlState === current.controlState) {
      return;
    }
    const event = Object.freeze({
      characterID: current.characterID,
      previous,
      current,
      reason: String(metadata.reason || "control_transition"),
      excludeSession: metadata.excludeSession || null,
    });
    for (const listener of transitionListeners) {
      try {
        listener(event);
      } catch {
        // Control state must remain authoritative even if an observer fails.
      }
    }
  }

  function pruneExpiredHistory(characterID) {
    const history = expiredLeases.get(characterID);
    if (!history) {
      return [];
    }
    const retained = history.slice(-MAX_EXPIRED_LEASES_PER_CHARACTER);
    if (retained.length > 0) {
      expiredLeases.set(characterID, retained);
    } else {
      expiredLeases.delete(characterID);
    }
    return retained;
  }

  function rememberExpiredLease(characterID, lease, expiredAtMs) {
    const history = pruneExpiredHistory(characterID);
    history.push({
      leaseID: lease.leaseID,
      controllerID: lease.controllerID,
      secretDigest: Buffer.from(lease.secretDigest),
      expiredAtMs,
    });
    expiredLeases.set(
      characterID,
      history.slice(-MAX_EXPIRED_LEASES_PER_CHARACTER),
    );
  }

  function scheduleExpiry(characterID, lease) {
    if (lease.timerHandle !== null && lease.timerHandle !== undefined) {
      clearTimer(lease.timerHandle);
    }
    const delayMs = Math.max(0, lease.expiresAtMs - nowMs());
    lease.timerHandle = setTimer(() => {
      const active = browserLeases.get(characterID);
      if (!active || active.leaseID !== lease.leaseID) {
        return;
      }
      if (nowMs() < active.expiresAtMs) {
        scheduleExpiry(characterID, active);
        return;
      }
      expireLease(characterID, active, "browser_lease_expired");
    }, delayMs);
    if (lease.timerHandle && typeof lease.timerHandle.unref === "function") {
      lease.timerHandle.unref();
    }
  }

  function expireLease(characterID, lease, reason) {
    const active = browserLeases.get(characterID);
    if (!active || active.leaseID !== lease.leaseID) {
      return false;
    }
    if (active.timerHandle !== null && active.timerHandle !== undefined) {
      clearTimer(active.timerHandle);
    }
    const previous = browserSnapshot(characterID, active);
    browserLeases.delete(characterID);
    rememberExpiredLease(characterID, active, nowMs());
    const current = findRetailSession(characterID)
      ? retailSnapshot(characterID)
      : offlineSnapshot(characterID);
    notifyTransition(previous, current, { reason });
    return true;
  }

  function expireIfNeeded(characterID) {
    const lease = browserLeases.get(characterID);
    if (lease && nowMs() >= lease.expiresAtMs) {
      expireLease(characterID, lease, "browser_lease_expired");
    }
  }

  function getCharacterControlSnapshot(characterIDValue) {
    const characterID = normalizeCharacterID(characterIDValue);
    if (!characterID) {
      throw makeControlError(ERROR_CODES.UNAVAILABLE);
    }
    expireIfNeeded(characterID);
    const retailSession = findRetailSession(characterID);
    const lease = browserLeases.get(characterID);
    if (retailSession && lease) {
      throw makeControlError(ERROR_CODES.UNAVAILABLE);
    }
    if (retailSession) {
      return retailSnapshot(characterID);
    }
    if (lease) {
      return browserSnapshot(characterID, lease);
    }
    return offlineSnapshot(characterID);
  }

  function assertRetailControlAvailable(characterIDValue) {
    const snapshot = getCharacterControlSnapshot(characterIDValue);
    if (snapshot.controlState === CONTROL_STATES.BROWSER_PILOT) {
      throw makeControlError(ERROR_CODES.BROWSER_PILOT);
    }
    return snapshot;
  }

  function claimBrowserControl(characterIDValue, controllerIDValue, claimOptions = {}) {
    const characterID = normalizeCharacterID(characterIDValue);
    const controllerID = normalizeControllerID(controllerIDValue);
    if (!characterID || !controllerID) {
      throw makeControlError(ERROR_CODES.LEASE_INVALID);
    }
    const snapshot = getCharacterControlSnapshot(characterID);
    if (snapshot.controlState === CONTROL_STATES.RETAIL_CLIENT) {
      throw makeControlError(ERROR_CODES.RETAIL_CLIENT);
    }
    if (snapshot.controlState === CONTROL_STATES.BROWSER_PILOT) {
      throw makeControlError(ERROR_CODES.BROWSER_PILOT);
    }

    const leaseID = asOpaqueToken(randomness.randomBytes(18));
    const leaseSecret = asOpaqueToken(randomness.randomBytes(32));
    if (!leaseID || !leaseSecret) {
      throw makeControlError(ERROR_CODES.UNAVAILABLE);
    }
    const ttlMs = normalizeTtlMs(claimOptions.ttlMs, defaultTtlMs);
    const lease = {
      leaseID,
      controllerID,
      secretDigest: digestLeaseSecret(leaseSecret),
      expiresAtMs: nowMs() + ttlMs,
      timerHandle: null,
    };
    browserLeases.set(characterID, lease);
    scheduleExpiry(characterID, lease);
    const control = browserSnapshot(characterID, lease);
    notifyTransition(snapshot, control, { reason: "browser_lease_claimed" });
    return Object.freeze({
      control,
      credentials: Object.freeze({ leaseID, leaseSecret }),
    });
  }

  function credentialsMatch(entry, controllerID, leaseID, leaseSecret) {
    return Boolean(
      entry &&
      entry.controllerID === controllerID &&
      entry.leaseID === leaseID &&
      secretDigestMatches(leaseSecret, entry.secretDigest),
    );
  }

  function expiredCredentialsMatch(characterID, controllerID, leaseID, leaseSecret) {
    return pruneExpiredHistory(characterID).some((entry) =>
      credentialsMatch(entry, controllerID, leaseID, leaseSecret));
  }

  function validateLeaseCredentials(
    characterIDValue,
    controllerIDValue,
    leaseIDValue,
    leaseSecretValue,
  ) {
    const characterID = normalizeCharacterID(characterIDValue);
    const controllerID = normalizeControllerID(controllerIDValue);
    const leaseID = String(leaseIDValue || "").trim();
    const leaseSecret = String(leaseSecretValue || "");
    if (!characterID || !controllerID || !leaseID || !leaseSecret) {
      throw makeControlError(ERROR_CODES.LEASE_INVALID);
    }
    expireIfNeeded(characterID);
    const lease = browserLeases.get(characterID);
    if (credentialsMatch(lease, controllerID, leaseID, leaseSecret)) {
      return { characterID, lease };
    }
    if (expiredCredentialsMatch(characterID, controllerID, leaseID, leaseSecret)) {
      throw makeControlError(ERROR_CODES.LEASE_EXPIRED);
    }
    throw makeControlError(ERROR_CODES.LEASE_INVALID);
  }

  function renewBrowserControl(
    characterIDValue,
    controllerIDValue,
    leaseIDValue,
    leaseSecretValue,
    renewOptions = {},
  ) {
    const { characterID, lease } = validateLeaseCredentials(
      characterIDValue,
      controllerIDValue,
      leaseIDValue,
      leaseSecretValue,
    );
    lease.expiresAtMs = nowMs() + normalizeTtlMs(renewOptions.ttlMs, defaultTtlMs);
    scheduleExpiry(characterID, lease);
    return Object.freeze({ control: browserSnapshot(characterID, lease) });
  }

  function validateBrowserControl(
    characterIDValue,
    controllerIDValue,
    leaseIDValue,
    leaseSecretValue,
  ) {
    const { characterID, lease } = validateLeaseCredentials(
      characterIDValue,
      controllerIDValue,
      leaseIDValue,
      leaseSecretValue,
    );
    return Object.freeze({ control: browserSnapshot(characterID, lease) });
  }

  function releaseBrowserControl(
    characterIDValue,
    controllerIDValue,
    leaseIDValue,
    leaseSecretValue,
  ) {
    const { characterID, lease } = validateLeaseCredentials(
      characterIDValue,
      controllerIDValue,
      leaseIDValue,
      leaseSecretValue,
    );
    if (lease.timerHandle !== null && lease.timerHandle !== undefined) {
      clearTimer(lease.timerHandle);
    }
    const previous = browserSnapshot(characterID, lease);
    browserLeases.delete(characterID);
    const control = findRetailSession(characterID)
      ? retailSnapshot(characterID)
      : offlineSnapshot(characterID);
    notifyTransition(previous, control, { reason: "browser_lease_released" });
    return Object.freeze({ control });
  }

  function recordRetailSessionStarted(characterIDValue, options = {}) {
    const characterID = normalizeCharacterID(characterIDValue);
    if (!characterID) {
      return offlineSnapshot(0);
    }
    expireIfNeeded(characterID);
    if (browserLeases.has(characterID)) {
      throw makeControlError(ERROR_CODES.BROWSER_PILOT);
    }

    const previousCharacterID = normalizeCharacterID(options.previousCharacterID);
    if (previousCharacterID && previousCharacterID !== characterID) {
      recordRetailSessionEnded(previousCharacterID, {
        session: options.session,
        reason: "retail_character_changed",
      });
    }

    const current = retailSnapshot(characterID);
    const previousState = String(options.previousControlState || "");
    const anotherRetailSession = findRetailSession(characterID, {
      excludeSession: options.session || null,
    });
    const previous = previousState === CONTROL_STATES.RETAIL_CLIENT || anotherRetailSession
      ? retailSnapshot(characterID)
      : offlineSnapshot(characterID);
    notifyTransition(previous, current, {
      reason: String(options.reason || "retail_session_started"),
      excludeSession: options.session || null,
    });
    return current;
  }

  function recordRetailSessionEnded(characterIDValue, options = {}) {
    const characterID = normalizeCharacterID(characterIDValue);
    if (!characterID) {
      return offlineSnapshot(0);
    }
    expireIfNeeded(characterID);
    const current = getCharacterControlSnapshot(characterID);
    const previous = retailSnapshot(characterID);
    notifyTransition(previous, current, {
      reason: String(options.reason || "retail_session_ended"),
      excludeSession: options.session || null,
    });
    return current;
  }

  function subscribe(listener) {
    if (typeof listener !== "function") {
      throw new TypeError("character-control listener must be a function");
    }
    transitionListeners.add(listener);
    return () => transitionListeners.delete(listener);
  }

  function shutdown() {
    for (const lease of browserLeases.values()) {
      if (lease.timerHandle !== null && lease.timerHandle !== undefined) {
        clearTimer(lease.timerHandle);
      }
    }
    browserLeases.clear();
    expiredLeases.clear();
    transitionListeners.clear();
  }

  return Object.freeze({
    assertRetailControlAvailable,
    claimBrowserControl,
    getCharacterControlSnapshot,
    recordRetailSessionEnded,
    recordRetailSessionStarted,
    releaseBrowserControl,
    renewBrowserControl,
    subscribe,
    shutdown,
    validateBrowserControl,
  });
}

const defaultRuntime = createCharacterControlRuntime({
  findRetailSession(characterID, options = {}) {
    // A socket may be marked destroyed just before its close handler runs the
    // canonical character cleanup. Keep that closing session authoritative
    // during the gap so a reconnect or browser claim cannot race its persisted
    // logoff/space cleanup and create a false offline -> online edge.
    return sessionRegistry.findSessionByCharacterID(characterID, {
      ...options,
      includeClosing: true,
    });
  },
});

module.exports = {
  ...defaultRuntime,
  CharacterControlError,
  CONTROL_STATES,
  CONTROL_TRANSPORTS,
  DEFAULT_BROWSER_LEASE_TTL_MS,
  ERROR_CODES,
  createCharacterControlRuntime,
};
