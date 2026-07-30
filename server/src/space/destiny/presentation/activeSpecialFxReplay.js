"use strict";

const {
  normalizeEntityID,
} = require("../identity/entityID");
const {
  normalizeDestinyStamp,
} = require("../delivery/stamps");

function defaultToFiniteNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function resolveNowMs(options, toFiniteNumber) {
  return Object.prototype.hasOwnProperty.call(options, "nowMs")
    ? toFiniteNumber(options.nowMs, 0)
    : Date.now();
}

function shouldReplayActiveSpecialFxForFreshAcquire(effectState, options = {}) {
  const toFiniteNumber =
    typeof options.toFiniteNumber === "function"
      ? options.toFiniteNumber
      : defaultToFiniteNumber;
  const nowMs = resolveNowMs(options, toFiniteNumber);
  if (!effectState || !effectState.guid) {
    return false;
  }
  if (effectState.disableFreshAcquireSpecialFxReplay === true) {
    return false;
  }
  if (effectState.superweaponEffect === true) {
    return typeof options.isSuperweaponFxReplayWindowActive === "function" &&
      options.isSuperweaponFxReplayWindowActive(effectState, nowMs);
  }
  if (effectState.forceFreshAcquireSpecialFxReplay === true) {
    return true;
  }
  const isOffensiveWeaponFamily =
    typeof options.isOffensiveWeaponFamily === "function"
      ? options.isOffensiveWeaponFamily
      : () => false;
  const replayableStatefulSelfBuffGuids =
    options.replayableStatefulSelfBuffGuids instanceof Set
      ? options.replayableStatefulSelfBuffGuids
      : new Set();
  const replayableMiningFx = effectState.miningEffect === true;
  const replayableOffensiveFx =
    effectState.isGeneric === true &&
    isOffensiveWeaponFamily(effectState.weaponFamily);
  const replayableHostileFx =
    effectState.hostileModuleEffect === true &&
    typeof effectState.guid === "string" &&
    effectState.guid.trim() !== "";
  const replayableStatefulSelfBuffFx =
    replayableStatefulSelfBuffGuids.has(String(effectState.guid || ""));
  if (
    !replayableMiningFx &&
    !replayableOffensiveFx &&
    !replayableHostileFx &&
    !replayableStatefulSelfBuffFx
  ) {
    return false;
  }
  if (toFiniteNumber(effectState.deactivatedAtMs, 0) > 0) {
    return false;
  }

  const startedAtMs = toFiniteNumber(effectState.startedAtMs, 0);
  if (startedAtMs > 0 && startedAtMs > nowMs + 1) {
    return false;
  }

  const deactivateAtMs = toFiniteNumber(effectState.deactivateAtMs, 0);
  if (deactivateAtMs > 0 && deactivateAtMs <= nowMs) {
    return false;
  }

  return true;
}

function buildReplayPolicyOptions(options, nowMs) {
  return {
    isOffensiveWeaponFamily: options.isOffensiveWeaponFamily,
    isSuperweaponFxReplayWindowActive:
      options.isSuperweaponFxReplayWindowActive,
    nowMs,
    replayableStatefulSelfBuffGuids:
      options.replayableStatefulSelfBuffGuids,
    toFiniteNumber: options.toFiniteNumber,
  };
}

function buildFreshAcquireActiveSpecialFxReplayUpdates(options = {}) {
  const toFiniteNumber =
    typeof options.toFiniteNumber === "function"
      ? options.toFiniteNumber
      : defaultToFiniteNumber;
  const entities = Array.isArray(options.entities) ? options.entities : [];
  if (entities.length <= 0) {
    return [];
  }
  if (typeof options.buildSpecialFxPayloadsForEntity !== "function") {
    throw new TypeError(
      "active special FX replay requires buildSpecialFxPayloadsForEntity",
    );
  }

  const stamp = normalizeDestinyStamp(options.stamp, 0);
  const nowMs = resolveNowMs(options, toFiniteNumber);
  const freshAcquireEntityIDs = new Set(
    entities
      .map((entity) => normalizeEntityID(entity && entity.itemID))
      .filter((entityID) => entityID !== null),
  );
  const isOffensiveWeaponFamily =
    typeof options.isOffensiveWeaponFamily === "function"
      ? options.isOffensiveWeaponFamily
      : () => false;
  const resolveSpecialFxRepeatCount =
    typeof options.resolveSpecialFxRepeatCount === "function"
      ? options.resolveSpecialFxRepeatCount
      : () => null;
  const buildSpecialFxPayloadsForEntity =
    options.buildSpecialFxPayloadsForEntity;
  const updates = [];
  for (const entity of entities) {
    if (!entity || !(entity.activeModuleEffects instanceof Map)) {
      continue;
    }

    for (const effectState of entity.activeModuleEffects.values()) {
      if (
        !shouldReplayActiveSpecialFxForFreshAcquire(
          effectState,
          buildReplayPolicyOptions(options, nowMs),
        )
      ) {
        continue;
      }

      if (
        effectState.superweaponEffect === true &&
        String(effectState.superweaponFamily || "").toLowerCase() === "lance"
      ) {
        const replayTargetID = normalizeEntityID(
          effectState.superweaponFxTargetID ||
            effectState.superweaponBeaconID ||
            effectState.superweaponPrimaryTargetID ||
            effectState.targetID,
        );
        const targetIsFreshlyAcquired =
          replayTargetID !== null && freshAcquireEntityIDs.has(replayTargetID);
        if (!targetIsFreshlyAcquired) {
          continue;
        }
      }

      const superweaponReplayOptions =
        effectState.superweaponEffect === true &&
        typeof options.buildSuperweaponFreshAcquireFxOptions === "function"
          ? options.buildSuperweaponFreshAcquireFxOptions(
              effectState,
              nowMs,
              options.scene || null,
            )
          : null;
      const payloadResult = buildSpecialFxPayloadsForEntity(
        entity.itemID,
        effectState.guid,
        superweaponReplayOptions || {
          moduleID: effectState.moduleID,
          moduleTypeID: effectState.typeID,
          targetID: effectState.targetID || null,
          chargeTypeID: effectState.chargeTypeID || null,
          weaponFamily: String(effectState.weaponFamily || ""),
          isOffensive: isOffensiveWeaponFamily(effectState.weaponFamily),
          start: true,
          active: true,
          duration: effectState.durationMs,
          repeat: resolveSpecialFxRepeatCount(effectState),
        },
        entity,
      );
      const payloads = payloadResult && Array.isArray(payloadResult.payloads)
        ? payloadResult.payloads
        : [];
      for (const payload of payloads) {
        updates.push({
          stamp,
          payload,
        });
      }
    }
  }

  return updates;
}

function buildActiveSpecialFxEffectStateEntriesForSetState(options = {}) {
  const toFiniteNumber =
    typeof options.toFiniteNumber === "function"
      ? options.toFiniteNumber
      : defaultToFiniteNumber;
  const entities = Array.isArray(options.entities) ? options.entities : [];
  if (entities.length <= 0) {
    return [];
  }
  if (typeof options.buildSpecialFxPayloadsForEntity !== "function") {
    throw new TypeError(
      "SetState special FX replay requires buildSpecialFxPayloadsForEntity",
    );
  }

  const nowMs = resolveNowMs(options, toFiniteNumber);
  const isOffensiveWeaponFamily =
    typeof options.isOffensiveWeaponFamily === "function"
      ? options.isOffensiveWeaponFamily
      : () => false;
  const resolveSpecialFxRepeatCount =
    typeof options.resolveSpecialFxRepeatCount === "function"
      ? options.resolveSpecialFxRepeatCount
      : () => null;
  const buildSpecialFxPayloadsForEntity =
    options.buildSpecialFxPayloadsForEntity;
  const buildGenericModuleSpecialFxGraphicInfo =
    typeof options.buildGenericModuleSpecialFxGraphicInfo === "function"
      ? options.buildGenericModuleSpecialFxGraphicInfo
      : () => null;
  const buildMiningSpecialFxTimingOptions =
    typeof options.buildMiningSpecialFxTimingOptions === "function"
      ? options.buildMiningSpecialFxTimingOptions
      : () => ({});
  const entries = [];
  for (const entity of entities) {
    if (!entity || !(entity.activeModuleEffects instanceof Map)) {
      continue;
    }

    for (const effectState of entity.activeModuleEffects.values()) {
      if (
        !shouldReplayActiveSpecialFxForFreshAcquire(
          effectState,
          buildReplayPolicyOptions(options, nowMs),
        )
      ) {
        continue;
      }

      const superweaponOptions =
        effectState.superweaponEffect === true &&
        typeof options.buildSuperweaponFreshAcquireFxOptions === "function"
          ? options.buildSuperweaponFreshAcquireFxOptions(
              effectState,
              nowMs,
              options.scene || null,
            )
          : null;
      const payloadResult = buildSpecialFxPayloadsForEntity(
        entity.itemID,
        effectState.guid,
        superweaponOptions || {
          moduleID: effectState.moduleID,
          moduleTypeID: effectState.typeID,
          targetID: effectState.targetID || null,
          chargeTypeID: effectState.chargeTypeID || null,
          weaponFamily: String(effectState.weaponFamily || ""),
          isOffensive:
            effectState.hostileModuleEffect === true ||
            isOffensiveWeaponFamily(effectState.weaponFamily),
          start: true,
          active: true,
          duration: effectState.durationMs,
          repeat: resolveSpecialFxRepeatCount(effectState),
          graphicInfo: buildGenericModuleSpecialFxGraphicInfo(effectState),
          ...buildMiningSpecialFxTimingOptions(effectState, nowMs, {
            includeElapsed: true,
          }),
        },
        entity,
      );
      const payloads = payloadResult && Array.isArray(payloadResult.payloads)
        ? payloadResult.payloads
        : [];
      for (const payload of payloads) {
        if (
          Array.isArray(payload) &&
          payload[0] === "OnSpecialFX" &&
          Array.isArray(payload[1])
        ) {
          entries.push(payload[1]);
        }
      }
    }
  }

  return entries;
}

module.exports = {
  buildActiveSpecialFxEffectStateEntriesForSetState,
  buildFreshAcquireActiveSpecialFxReplayUpdates,
  shouldReplayActiveSpecialFxForFreshAcquire,
};
