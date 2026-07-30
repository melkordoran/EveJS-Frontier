"use strict";

const crypto = require("node:crypto");

const AUTHORIZATION_POLICIES = Object.freeze({
  OFFLINE_COMPANION: "offline_companion",
  BROWSER_PILOT: "browser_pilot",
});

const ERROR_CODES = Object.freeze({
  INVALID: "CHARACTER_COMMAND_INVALID",
  ID_REUSED: "CHARACTER_COMMAND_ID_REUSED",
  STATE_VERSION_MISMATCH: "CHARACTER_STATE_VERSION_MISMATCH",
  UNAVAILABLE: "CHARACTER_COMMAND_UNAVAILABLE",
});

const DEFAULT_COMPLETED_RECEIPT_LIMIT = 1024;
const MAX_OPAQUE_VALUE_LENGTH = 512;
const MAX_COMMAND_TYPE_LENGTH = 128;
const MAX_JSON_DEPTH = 32;

const CONTROL_ERROR_DETAILS = Object.freeze({
  retail_client: Object.freeze({
    code: "CHARACTER_CONTROL_RETAIL_CLIENT",
    message: "Character is controlled by a retail client.",
    statusCode: 409,
  }),
  browser_pilot: Object.freeze({
    code: "CHARACTER_CONTROL_BROWSER_PILOT",
    message: "Character has an active browser-pilot lease.",
    statusCode: 409,
  }),
});

const PUBLIC_PRECONDITION_ERROR_DETAILS = Object.freeze({
  [ERROR_CODES.INVALID]: Object.freeze({
    name: "CharacterCommandError",
    message: "Character command envelope is invalid.",
    statusCode: 400,
  }),
  [ERROR_CODES.ID_REUSED]: Object.freeze({
    name: "CharacterCommandError",
    message: "Character command ID was reused with different command data.",
    statusCode: 409,
  }),
  [ERROR_CODES.STATE_VERSION_MISMATCH]: Object.freeze({
    name: "CharacterCommandError",
    message: "Character state version does not match the authoritative state.",
    statusCode: 409,
  }),
  [ERROR_CODES.UNAVAILABLE]: Object.freeze({
    name: "CharacterCommandError",
    message: "Authoritative character command execution is unavailable.",
    statusCode: 503,
  }),
  CHARACTER_CONTROL_RETAIL_CLIENT: Object.freeze({
    name: "CharacterControlError",
    message: "Character is controlled by a retail client.",
    statusCode: 409,
  }),
  CHARACTER_CONTROL_BROWSER_PILOT: Object.freeze({
    name: "CharacterControlError",
    message: "Character has an active browser-pilot lease.",
    statusCode: 409,
  }),
  CHARACTER_LEASE_EXPIRED: Object.freeze({
    name: "CharacterControlError",
    message: "Browser-pilot lease has expired.",
    statusCode: 409,
  }),
  CHARACTER_LEASE_INVALID: Object.freeze({
    name: "CharacterControlError",
    message: "Browser-pilot lease credentials are invalid.",
    statusCode: 403,
  }),
  CHARACTER_CONTROL_UNAVAILABLE: Object.freeze({
    name: "CharacterControlError",
    message: "Authoritative character control is unavailable.",
    statusCode: 503,
  }),
});

class CharacterCommandError extends Error {
  constructor(code, message, statusCode) {
    super(message);
    this.name = "CharacterCommandError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function makeCommandError(code) {
  switch (code) {
    case ERROR_CODES.INVALID:
      return new CharacterCommandError(
        code,
        "Character command envelope is invalid.",
        400,
      );
    case ERROR_CODES.ID_REUSED:
      return new CharacterCommandError(
        code,
        "Character command ID was reused with different command data.",
        409,
      );
    case ERROR_CODES.STATE_VERSION_MISMATCH:
      return new CharacterCommandError(
        code,
        "Character state version does not match the authoritative state.",
        409,
      );
    default:
      return new CharacterCommandError(
        ERROR_CODES.UNAVAILABLE,
        "Authoritative character command execution is unavailable.",
        503,
      );
  }
}

function makeControlError(controlState) {
  const details = CONTROL_ERROR_DETAILS[controlState];
  if (!details) {
    const error = new Error("Authoritative character control is unavailable.");
    error.name = "CharacterControlError";
    error.code = "CHARACTER_CONTROL_UNAVAILABLE";
    error.statusCode = 503;
    return error;
  }
  const error = new Error(details.message);
  error.name = "CharacterControlError";
  error.code = details.code;
  error.statusCode = details.statusCode;
  return error;
}

function normalizeCharacterID(value) {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : 0;
}

function normalizePositiveInteger(value, fallback) {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : fallback;
}

function normalizeOpaqueString(
  value,
  maxLength = MAX_OPAQUE_VALUE_LENGTH,
  minLength = 1,
) {
  if (
    typeof value !== "string" ||
    value.length < minLength ||
    value.length > maxLength
  ) {
    return "";
  }
  if (!value.trim() || /[\u0000-\u001f\u007f]/.test(value)) {
    return "";
  }
  return value;
}

function normalizeRuntimeEpoch(value) {
  const normalized = normalizeOpaqueString(value, 128);
  return normalized && /^[A-Za-z0-9_-]+$/.test(normalized) ? normalized : "";
}

function normalizeControllerID(value) {
  if (typeof value !== "string") {
    return "";
  }
  const normalized = value.trim();
  return normalized.length >= 16 && normalized.length <= 256
    ? normalized
    : "";
}

function normalizeJsonValue(value, depth = 0) {
  if (depth > MAX_JSON_DEPTH) {
    throw makeCommandError(ERROR_CODES.INVALID);
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw makeCommandError(ERROR_CODES.INVALID);
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeJsonValue(entry, depth + 1));
  }
  if (value && typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw makeCommandError(ERROR_CODES.INVALID);
    }
    const normalized = {};
    for (const key of Object.keys(value).sort()) {
      if (!key || /[\u0000-\u001f\u007f]/.test(key)) {
        throw makeCommandError(ERROR_CODES.INVALID);
      }
      normalized[key] = normalizeJsonValue(value[key], depth + 1);
    }
    return normalized;
  }
  throw makeCommandError(ERROR_CODES.INVALID);
}

function cloneJsonValue(value) {
  return value === undefined
    ? null
    : JSON.parse(JSON.stringify(normalizeJsonValue(value)));
}

function sanitizeJsonValue(value, secrets) {
  const normalized = normalizeJsonValue(value);
  function visit(entry) {
    if (typeof entry === "string") {
      return redactText(entry, secrets);
    }
    if (Array.isArray(entry)) {
      return entry.map(visit);
    }
    if (entry && typeof entry === "object") {
      return Object.fromEntries(
        Object.entries(entry).map(([key, child]) => [
          redactText(key, secrets),
          visit(child),
        ]),
      );
    }
    return entry;
  }
  return visit(normalized);
}

function fingerprintCommand(command) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(command), "utf8")
    .digest("base64url");
}

function fingerprintsMatch(left, right) {
  const leftBuffer = Buffer.from(String(left || ""), "utf8");
  const rightBuffer = Buffer.from(String(right || ""), "utf8");
  return leftBuffer.length === rightBuffer.length &&
    crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function redactText(value, secrets) {
  let text = String(value || "");
  for (const secret of secrets) {
    if (typeof secret === "string" && secret.length > 0) {
      text = text.split(secret).join("[redacted]");
    }
  }
  return text.slice(0, 1024);
}

function serializeCanonicalError(codeValue) {
  const code = String(codeValue || "");
  const details = PUBLIC_PRECONDITION_ERROR_DETAILS[code] ||
    PUBLIC_PRECONDITION_ERROR_DETAILS[ERROR_CODES.UNAVAILABLE];
  return Object.freeze({
    name: details.name,
    code: PUBLIC_PRECONDITION_ERROR_DETAILS[code]
      ? code
      : ERROR_CODES.UNAVAILABLE,
    message: details.message,
    statusCode: details.statusCode,
  });
}

function serializeMappedDomainError(mapped, secrets = []) {
  if (!mapped || typeof mapped !== "object") {
    return null;
  }
  const code = String(mapped.code || "");
  const statusCode = Number(mapped.statusCode);
  if (
    !/^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(code) ||
    !Number.isInteger(statusCode) ||
    statusCode < 400 ||
    statusCode > 499
  ) {
    return null;
  }
  const message = redactText(mapped.message || code, secrets);
  if (!message) {
    return null;
  }
  return Object.freeze({
    name: "CharacterCommandDomainError",
    code,
    message,
    statusCode,
  });
}

function deserializeError(serialized) {
  const error = new Error(serialized.message);
  error.name = serialized.name;
  error.code = serialized.code;
  error.statusCode = serialized.statusCode;
  return error;
}

function serializeHandlerError(error, definition, secrets) {
  if (definition && typeof definition.mapPublicError === "function") {
    try {
      const mapped = serializeMappedDomainError(
        definition.mapPublicError(error),
        secrets,
      );
      if (mapped) {
        return mapped;
      }
    } catch {
      // A broken error mapper is itself an internal command failure.
    }
  }
  return serializeCanonicalError(ERROR_CODES.UNAVAILABLE);
}

function createCharacterCommandRuntime(options = {}) {
  const controlRuntime = options.controlRuntime;
  if (
    !controlRuntime ||
    typeof controlRuntime.getCharacterControlSnapshot !== "function" ||
    typeof controlRuntime.subscribe !== "function"
  ) {
    throw new TypeError("character command runtime requires authoritative control");
  }

  const rawDefinitions = options.commandDefinitions;
  if (!rawDefinitions || typeof rawDefinitions !== "object") {
    throw new TypeError("character command runtime requires command definitions");
  }
  const definitions = new Map();
  for (const [type, definition] of Object.entries(rawDefinitions)) {
    if (
      !normalizeOpaqueString(type, MAX_COMMAND_TYPE_LENGTH) ||
      !definition ||
      !Object.values(AUTHORIZATION_POLICIES).includes(definition.authorizationPolicy) ||
      typeof definition.normalizePayload !== "function" ||
      typeof definition.handler !== "function" ||
      (
        definition.mapPublicError !== undefined &&
        typeof definition.mapPublicError !== "function"
      )
    ) {
      throw new TypeError(`invalid character command definition: ${type}`);
    }
    if (
      definition.authorizationPolicy === AUTHORIZATION_POLICIES.BROWSER_PILOT &&
      typeof controlRuntime.validateBrowserControl !== "function"
    ) {
      throw new TypeError("browser-pilot commands require lease validation");
    }
    definitions.set(type, Object.freeze({ ...definition }));
  }
  if (definitions.size === 0) {
    throw new TypeError("character command runtime requires command definitions");
  }

  const randomBytes = typeof options.randomBytes === "function"
    ? options.randomBytes
    : crypto.randomBytes;
  const configuredEpoch = options.runtimeEpoch === undefined
    ? ""
    : normalizeRuntimeEpoch(options.runtimeEpoch);
  if (options.runtimeEpoch !== undefined && !configuredEpoch) {
    throw new TypeError("character command runtime epoch is invalid");
  }
  const runtimeEpoch = configuredEpoch || Buffer.from(randomBytes(18)).toString("base64url");
  if (!normalizeRuntimeEpoch(runtimeEpoch)) {
    throw new TypeError("character command runtime could not create an epoch");
  }
  const completedReceiptLimit = normalizePositiveInteger(
    options.completedReceiptLimit,
    DEFAULT_COMPLETED_RECEIPT_LIMIT,
  );
  const onReceiptCached = typeof options.onReceiptCached === "function"
    ? options.onReceiptCached
    : null;
  const isCommandIDRetained = typeof options.isCommandIDRetained === "function"
    ? options.isCommandIDRetained
    : null;

  const revisions = new Map();
  const lanes = new Map();
  const inFlightByCharacter = new Map();
  const completedReceipts = new Map();
  let stopped = false;

  function getRevision(characterID) {
    return revisions.get(characterID) || 0;
  }

  function getStateVersion(characterIDValue) {
    const characterID = normalizeCharacterID(characterIDValue);
    if (!characterID || stopped) {
      throw makeCommandError(ERROR_CODES.UNAVAILABLE);
    }
    return `${runtimeEpoch}.${getRevision(characterID).toString(36)}`;
  }

  function advanceStateVersion(characterID) {
    const nextRevision = getRevision(characterID) + 1;
    if (!Number.isSafeInteger(nextRevision)) {
      throw makeCommandError(ERROR_CODES.UNAVAILABLE);
    }
    revisions.set(characterID, nextRevision);
    return `${runtimeEpoch}.${nextRevision.toString(36)}`;
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
    if (characterID && previousState && currentState && previousState !== currentState) {
      advanceStateVersion(characterID);
    }
  });

  function normalizeEnvelope(envelopeValue, requiredType) {
    if (!envelopeValue || typeof envelopeValue !== "object" || Array.isArray(envelopeValue)) {
      throw makeCommandError(ERROR_CODES.INVALID);
    }
    const prototype = Object.getPrototypeOf(envelopeValue);
    if (prototype !== Object.prototype && prototype !== null) {
      throw makeCommandError(ERROR_CODES.INVALID);
    }
    const requiredKeys = [
      "commandID",
      "controllerID",
      "expectedStateVersion",
      "payload",
      "type",
    ];
    const keys = Object.keys(envelopeValue).sort();
    if (
      keys.length !== requiredKeys.length ||
      keys.some((key, index) => key !== requiredKeys[index])
    ) {
      throw makeCommandError(ERROR_CODES.INVALID);
    }

    const commandID = normalizeOpaqueString(envelopeValue.commandID);
    const controllerID = normalizeControllerID(envelopeValue.controllerID);
    const expectedStateVersion = normalizeOpaqueString(envelopeValue.expectedStateVersion);
    const type = normalizeOpaqueString(envelopeValue.type, MAX_COMMAND_TYPE_LENGTH);
    const definition = definitions.get(type);
    if (
      !commandID ||
      !controllerID ||
      !expectedStateVersion ||
      !definition ||
      (requiredType && type !== requiredType)
    ) {
      throw makeCommandError(ERROR_CODES.INVALID);
    }

    let payload;
    try {
      payload = normalizeJsonValue(definition.normalizePayload(envelopeValue.payload));
    } catch (error) {
      if (error instanceof CharacterCommandError) {
        throw error;
      }
      throw makeCommandError(ERROR_CODES.INVALID);
    }
    return Object.freeze({
      commandID,
      controllerID,
      expectedStateVersion,
      type,
      payload,
      definition,
      fingerprint: fingerprintCommand({
        controllerID,
        expectedStateVersion,
        payload,
        type,
      }),
    });
  }

  function getInFlight(characterID, commandID) {
    const commands = inFlightByCharacter.get(characterID);
    return commands ? commands.get(commandID) || null : null;
  }

  function setInFlight(characterID, commandID, entry) {
    let commands = inFlightByCharacter.get(characterID);
    if (!commands) {
      commands = new Map();
      inFlightByCharacter.set(characterID, commands);
    }
    commands.set(commandID, entry);
  }

  function deleteInFlight(characterID, commandID, entry) {
    const commands = inFlightByCharacter.get(characterID);
    if (!commands || commands.get(commandID) !== entry) {
      return;
    }
    commands.delete(commandID);
    if (commands.size === 0) {
      inFlightByCharacter.delete(characterID);
    }
  }

  function receiptKey(characterID, commandID) {
    return `${characterID}:${commandID}`;
  }

  function cacheReceipt(characterID, commandID, fingerprint, outcome) {
    if (stopped) {
      return false;
    }
    const key = receiptKey(characterID, commandID);
    completedReceipts.set(key, Object.freeze({ fingerprint, outcome }));
    while (completedReceipts.size > completedReceiptLimit) {
      completedReceipts.delete(completedReceipts.keys().next().value);
    }
    return true;
  }

  function publishCachedReceipt(characterID, envelope, outcome, admissionStatus) {
    if (!onReceiptCached || stopped) {
      return;
    }
    try {
      onReceiptCached(Object.freeze({
        characterID,
        commandID: envelope.commandID,
        commandType: envelope.type,
        success: outcome.ok,
        errorCode: outcome.ok ? null : outcome.error.code,
        admissionStatus,
        stateVersion: getStateVersion(characterID),
      }));
    } catch {
      // Receipt settlement observers cannot alter a cached command outcome.
    }
  }

  function replayOutcome(outcome) {
    if (outcome.ok) {
      return Promise.resolve(cloneJsonValue(outcome.value));
    }
    return Promise.reject(deserializeError(outcome.error));
  }

  function authorizeInsideLane(characterID, envelope, authorization) {
    if (envelope.definition.authorizationPolicy === AUTHORIZATION_POLICIES.OFFLINE_COMPANION) {
      const control = controlRuntime.getCharacterControlSnapshot(characterID);
      if (control && control.controlState === "offline" && control.online === false) {
        return;
      }
      throw makeControlError(control && control.controlState);
    }

    const credentials = authorization && typeof authorization === "object"
      ? authorization
      : {};
    controlRuntime.validateBrowserControl(
      characterID,
      envelope.controllerID,
      credentials.leaseID,
      credentials.leaseSecret,
    );
  }

  function executeInsideLane(characterID, envelope, authorization) {
    const secrets = [
      envelope.controllerID,
      authorization && authorization.leaseID,
      authorization && authorization.leaseSecret,
    ];
    return Promise.resolve().then(async () => {
      let handlerStarted = false;
      try {
        if (getStateVersion(characterID) !== envelope.expectedStateVersion) {
          throw makeCommandError(ERROR_CODES.STATE_VERSION_MISMATCH);
        }
        authorizeInsideLane(characterID, envelope, authorization);
        advanceStateVersion(characterID);
        handlerStarted = true;
        const result = await envelope.definition.handler({
          characterID,
          payload: cloneJsonValue(envelope.payload),
        });
        let sanitizedResult;
        try {
          sanitizedResult = sanitizeJsonValue(result, secrets);
        } catch {
          throw makeCommandError(ERROR_CODES.UNAVAILABLE);
        }
        const outcome = Object.freeze({
          ok: true,
          value: Object.freeze({
            result: cloneJsonValue(sanitizedResult),
            stateVersion: getStateVersion(characterID),
          }),
        });
        const cached = cacheReceipt(
          characterID,
          envelope.commandID,
          envelope.fingerprint,
          outcome,
        );
        if (cached) {
          publishCachedReceipt(characterID, envelope, outcome, "admitted");
        }
        return cloneJsonValue(outcome.value);
      } catch (error) {
        const serializedError = handlerStarted
          ? serializeHandlerError(error, envelope.definition, secrets)
          : serializeCanonicalError(error && error.code);
        const outcome = Object.freeze({
          ok: false,
          error: serializedError,
        });
        const cached = cacheReceipt(
          characterID,
          envelope.commandID,
          envelope.fingerprint,
          outcome,
        );
        if (cached) {
          publishCachedReceipt(
            characterID,
            envelope,
            outcome,
            handlerStarted ? "admitted" : "rejected",
          );
        }
        throw deserializeError(outcome.error);
      }
    });
  }

  function enqueue(characterID, operation) {
    const previousTail = lanes.get(characterID) || Promise.resolve();
    const task = previousTail.then(operation);
    const tail = task.then(
      () => undefined,
      () => undefined,
    );
    lanes.set(characterID, tail);
    tail.then(() => {
      if (lanes.get(characterID) === tail) {
        lanes.delete(characterID);
      }
    });
    return task;
  }

  function submitCommand(characterIDValue, envelopeValue, submissionOptions = {}) {
    if (stopped) {
      return Promise.reject(makeCommandError(ERROR_CODES.UNAVAILABLE));
    }
    const characterID = normalizeCharacterID(characterIDValue);
    if (!characterID) {
      return Promise.reject(makeCommandError(ERROR_CODES.INVALID));
    }

    let envelope;
    try {
      envelope = normalizeEnvelope(envelopeValue, submissionOptions.requiredType);
    } catch (error) {
      return Promise.reject(error);
    }

    const receipt = completedReceipts.get(receiptKey(characterID, envelope.commandID));
    if (receipt) {
      if (!fingerprintsMatch(receipt.fingerprint, envelope.fingerprint)) {
        return Promise.reject(makeCommandError(ERROR_CODES.ID_REUSED));
      }
      return replayOutcome(receipt.outcome);
    }

    const existing = getInFlight(characterID, envelope.commandID);
    if (existing) {
      if (!fingerprintsMatch(existing.fingerprint, envelope.fingerprint)) {
        return Promise.reject(makeCommandError(ERROR_CODES.ID_REUSED));
      }
      return existing.promise;
    }

    if (isCommandIDRetained) {
      try {
        if (isCommandIDRetained(characterID, envelope.commandID) === true) {
          return Promise.reject(makeCommandError(ERROR_CODES.ID_REUSED));
        }
      } catch {
        return Promise.reject(makeCommandError(ERROR_CODES.UNAVAILABLE));
      }
    }

    const promise = enqueue(
      characterID,
      () => executeInsideLane(
        characterID,
        envelope,
        submissionOptions.authorization,
      ),
    );
    const entry = Object.freeze({
      fingerprint: envelope.fingerprint,
      promise,
    });
    setInFlight(characterID, envelope.commandID, entry);
    promise.then(
      () => deleteInFlight(characterID, envelope.commandID, entry),
      () => deleteInFlight(characterID, envelope.commandID, entry),
    );
    return promise;
  }

  function shutdown() {
    if (stopped) {
      return;
    }
    stopped = true;
    if (typeof unsubscribeControl === "function") {
      unsubscribeControl();
    }
    lanes.clear();
    inFlightByCharacter.clear();
    completedReceipts.clear();
  }

  return Object.freeze({
    getStateVersion,
    shutdown,
    submitCommand,
  });
}

module.exports = {
  AUTHORIZATION_POLICIES,
  CharacterCommandError,
  DEFAULT_COMPLETED_RECEIPT_LIMIT,
  ERROR_CODES,
  createCharacterCommandRuntime,
};
