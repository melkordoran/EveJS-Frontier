"use strict";

const {
  DESTINY_CONTRACTS,
} = require("../authority/destinyContracts");
const {
  MICHELLE_DIRECT_CRITICAL_ECHO_DESTINY_LEAD,
  MICHELLE_HELD_FUTURE_DESTINY_LEAD,
} = require("./michelleContract");

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    return Math.trunc(numeric);
  }
  const fallbackNumeric = Number(fallback);
  return Number.isFinite(fallbackNumeric) ? Math.trunc(fallbackNumeric) : 0;
}

function buildMichelleSafeDestinySendOptions(baseOptions = {}) {
  const minimumHistoryLeadFloor = Math.max(
    0,
    toInt(
      baseOptions.minimumHistoryLeadFloor,
      MICHELLE_HELD_FUTURE_DESTINY_LEAD,
    ),
  );
  const minimumLeadFromCurrentHistory = Math.max(
    toInt(baseOptions.minimumLeadFromCurrentHistory, 0),
    minimumHistoryLeadFloor,
  );
  const maximumLeadFromCurrentHistory = Math.max(
    toInt(
      baseOptions.maximumLeadFromCurrentHistory,
      minimumLeadFromCurrentHistory,
    ),
    minimumLeadFromCurrentHistory,
  );
  const historyLeadUsesImmediateSessionStamp =
    baseOptions.historyLeadUsesImmediateSessionStamp === true;
  const historyLeadUsesPresentedSessionStamp =
    baseOptions.historyLeadUsesPresentedSessionStamp === true;
  const historyLeadUsesCurrentSessionStamp =
    !historyLeadUsesImmediateSessionStamp &&
    !historyLeadUsesPresentedSessionStamp &&
    baseOptions.historyLeadUsesCurrentSessionStamp === true;
  return {
    ...baseOptions,
    avoidCurrentHistoryInsertion: true,
    minimumLeadFromCurrentHistory,
    maximumLeadFromCurrentHistory,
    maximumHistorySafeLeadOverride: Math.max(
      toInt(baseOptions.maximumHistorySafeLeadOverride, 0),
      maximumLeadFromCurrentHistory,
    ),
    historyLeadUsesCurrentSessionStamp:
      historyLeadUsesCurrentSessionStamp || undefined,
    historyLeadUsesImmediateSessionStamp:
      historyLeadUsesImmediateSessionStamp || undefined,
    historyLeadUsesPresentedSessionStamp:
      historyLeadUsesPresentedSessionStamp || undefined,
  };
}

function buildPresentedSessionAlignedDestinySendOptions(baseOptions = {}) {
  const minimumLeadFromCurrentHistory = Math.max(
    0,
    toInt(baseOptions.minimumLeadFromCurrentHistory, 0),
  );
  const maximumLeadFromCurrentHistory = Math.max(
    toInt(
      baseOptions.maximumLeadFromCurrentHistory,
      minimumLeadFromCurrentHistory,
    ),
    minimumLeadFromCurrentHistory,
  );
  return {
    ...baseOptions,
    avoidCurrentHistoryInsertion: false,
    minimumLeadFromCurrentHistory,
    maximumLeadFromCurrentHistory,
    historyLeadUsesCurrentSessionStamp: false,
    historyLeadUsesImmediateSessionStamp: false,
    historyLeadUsesPresentedSessionStamp: true,
  };
}

function buildOwnerMissileLifecycleSendOptions(baseOptions = {}) {
  return buildMichelleSafeDestinySendOptions({
    ...baseOptions,
    destinyAuthorityContract: DESTINY_CONTRACTS.OWNER_MISSILE_LIFECYCLE,
    minimumHistoryLeadFloor: MICHELLE_HELD_FUTURE_DESTINY_LEAD,
    minimumLeadFromCurrentHistory: Math.max(
      toInt(baseOptions.minimumLeadFromCurrentHistory, 0),
      MICHELLE_HELD_FUTURE_DESTINY_LEAD,
    ),
    maximumLeadFromCurrentHistory: Math.max(
      toInt(baseOptions.maximumLeadFromCurrentHistory, 0),
      MICHELLE_HELD_FUTURE_DESTINY_LEAD,
    ),
    maximumHistorySafeLeadOverride: Math.max(
      toInt(baseOptions.maximumHistorySafeLeadOverride, 0),
      MICHELLE_HELD_FUTURE_DESTINY_LEAD,
    ),
    historyLeadUsesCurrentSessionStamp: false,
    historyLeadUsesImmediateSessionStamp: true,
  });
}

function buildObserverMissileLifecycleSendOptions(baseOptions = {}) {
  return buildMichelleSafeDestinySendOptions({
    ...baseOptions,
    destinyAuthorityContract: DESTINY_CONTRACTS.OBSERVER_MISSILE_LIFECYCLE,
    minimumHistoryLeadFloor: MICHELLE_HELD_FUTURE_DESTINY_LEAD,
    minimumLeadFromCurrentHistory: Math.max(
      toInt(baseOptions.minimumLeadFromCurrentHistory, 0),
      MICHELLE_HELD_FUTURE_DESTINY_LEAD,
    ),
    maximumLeadFromCurrentHistory: Math.max(
      toInt(
        baseOptions.maximumLeadFromCurrentHistory,
        MICHELLE_HELD_FUTURE_DESTINY_LEAD,
      ),
      MICHELLE_HELD_FUTURE_DESTINY_LEAD,
    ),
    maximumHistorySafeLeadOverride: Math.max(
      toInt(baseOptions.maximumHistorySafeLeadOverride, 0),
      MICHELLE_HELD_FUTURE_DESTINY_LEAD,
    ),
    historyLeadUsesCurrentSessionStamp: false,
    historyLeadUsesImmediateSessionStamp: false,
    historyLeadUsesPresentedSessionStamp: true,
    historyLeadPresentedMaximumFutureLead: 0,
  });
}

function buildOwnerShipPrimeSendOptions(broadcastOptions = {}) {
  const baseOptions = {
    translateStamps:
      broadcastOptions &&
      Object.prototype.hasOwnProperty.call(broadcastOptions, "translateStamps")
        ? broadcastOptions.translateStamps
        : undefined,
    minimumLeadFromCurrentHistory:
      broadcastOptions && broadcastOptions.minimumLeadFromCurrentHistory,
    maximumLeadFromCurrentHistory:
      broadcastOptions && broadcastOptions.maximumLeadFromCurrentHistory,
    destinyAuthorityContract: DESTINY_CONTRACTS.CRITICAL_MOVEMENT_OR_SHIPPRIME,
  };
  if (
    broadcastOptions &&
    broadcastOptions.historyLeadUsesPresentedSessionStamp === true
  ) {
    return buildPresentedSessionAlignedDestinySendOptions(baseOptions);
  }
  return buildMichelleSafeDestinySendOptions({
    ...baseOptions,
    minimumHistoryLeadFloor:
      broadcastOptions && broadcastOptions.minimumHistoryLeadFloor,
    maximumHistorySafeLeadOverride:
      broadcastOptions && broadcastOptions.maximumHistorySafeLeadOverride,
    historyLeadUsesCurrentSessionStamp:
      broadcastOptions && broadcastOptions.historyLeadUsesCurrentSessionStamp,
    historyLeadUsesImmediateSessionStamp:
      broadcastOptions && broadcastOptions.historyLeadUsesImmediateSessionStamp,
  });
}

function buildOwnerCloakShipStateSendOptions(baseOptions = {}) {
  return buildObserverCombatPresentedSendOptions({
    ...baseOptions,
    translateStamps: false,
  });
}

function buildOwnerMissileFreshAcquireSendOptions(baseOptions = {}) {
  return buildMichelleSafeDestinySendOptions({
    ...baseOptions,
    destinyAuthorityContract: DESTINY_CONTRACTS.OWNER_MISSILE_LIFECYCLE,
    preservePayloadStateStamp: false,
    skipOwnerMonotonicRestampWhenPreviousNotOwnerCritical: true,
    minimumHistoryLeadFloor: MICHELLE_DIRECT_CRITICAL_ECHO_DESTINY_LEAD,
    minimumLeadFromCurrentHistory: Math.max(
      toInt(baseOptions.minimumLeadFromCurrentHistory, 0),
      MICHELLE_DIRECT_CRITICAL_ECHO_DESTINY_LEAD,
    ),
    maximumLeadFromCurrentHistory: Math.max(
      toInt(baseOptions.maximumLeadFromCurrentHistory, 0),
      MICHELLE_DIRECT_CRITICAL_ECHO_DESTINY_LEAD,
    ),
    maximumHistorySafeLeadOverride: Math.max(
      toInt(baseOptions.maximumHistorySafeLeadOverride, 0),
      MICHELLE_HELD_FUTURE_DESTINY_LEAD,
    ),
    historyLeadUsesCurrentSessionStamp: false,
    historyLeadUsesImmediateSessionStamp: false,
    historyLeadUsesPresentedSessionStamp: true,
    historyLeadPresentedMaximumFutureLead:
      MICHELLE_DIRECT_CRITICAL_ECHO_DESTINY_LEAD,
  });
}

function buildOwnerDamageStateSendOptions(baseOptions = {}) {
  return buildObserverCombatPresentedSendOptions({
    ...baseOptions,
  });
}

function buildObserverPropulsionShipPrimeBroadcastOptions(baseOptions = {}) {
  return {
    ...baseOptions,
    minimumHistoryLeadFloor: Math.max(
      toInt(baseOptions.minimumHistoryLeadFloor, 0),
      MICHELLE_DIRECT_CRITICAL_ECHO_DESTINY_LEAD,
    ),
    minimumLeadFromCurrentHistory: Math.max(
      toInt(baseOptions.minimumLeadFromCurrentHistory, 0),
      MICHELLE_DIRECT_CRITICAL_ECHO_DESTINY_LEAD,
    ),
    maximumLeadFromCurrentHistory: Math.max(
      toInt(baseOptions.maximumLeadFromCurrentHistory, 0),
      MICHELLE_DIRECT_CRITICAL_ECHO_DESTINY_LEAD,
    ),
    maximumHistorySafeLeadOverride: Math.max(
      toInt(baseOptions.maximumHistorySafeLeadOverride, 0),
      MICHELLE_HELD_FUTURE_DESTINY_LEAD,
    ),
    historyLeadUsesPresentedSessionStamp: true,
    historyLeadPresentedMaximumFutureLead:
      MICHELLE_DIRECT_CRITICAL_ECHO_DESTINY_LEAD,
    avoidCurrentHistoryInsertion: true,
  };
}

function buildObserverPropulsionSpecialFxOptions(baseOptions = {}) {
  return buildMichelleSafeDestinySendOptions({
    ...baseOptions,
    destinyAuthorityContract: DESTINY_CONTRACTS.COMBAT_NONCRITICAL,
    useCurrentStamp: true,
    minimumHistoryLeadFloor: Math.max(
      toInt(baseOptions.minimumHistoryLeadFloor, 0),
      MICHELLE_DIRECT_CRITICAL_ECHO_DESTINY_LEAD,
    ),
    minimumLeadFromCurrentHistory: Math.max(
      toInt(baseOptions.minimumLeadFromCurrentHistory, 0),
      MICHELLE_DIRECT_CRITICAL_ECHO_DESTINY_LEAD,
    ),
    maximumLeadFromCurrentHistory: Math.max(
      toInt(baseOptions.maximumLeadFromCurrentHistory, 0),
      MICHELLE_DIRECT_CRITICAL_ECHO_DESTINY_LEAD,
    ),
    maximumHistorySafeLeadOverride: Math.max(
      toInt(baseOptions.maximumHistorySafeLeadOverride, 0),
      MICHELLE_HELD_FUTURE_DESTINY_LEAD,
    ),
    historyLeadUsesCurrentSessionStamp: false,
    historyLeadUsesImmediateSessionStamp: false,
    historyLeadUsesPresentedSessionStamp: true,
    historyLeadPresentedMaximumFutureLead:
      MICHELLE_DIRECT_CRITICAL_ECHO_DESTINY_LEAD,
  });
}

function buildMissileDeploymentSpecialFxOptions(baseOptions = {}) {
  return buildMichelleSafeDestinySendOptions({
    ...baseOptions,
    destinyAuthorityContract: DESTINY_CONTRACTS.COMBAT_NONCRITICAL,
    useCurrentStamp: true,
    minimumHistoryLeadFloor: MICHELLE_DIRECT_CRITICAL_ECHO_DESTINY_LEAD,
    minimumLeadFromCurrentHistory: Math.max(
      toInt(baseOptions.minimumLeadFromCurrentHistory, 0),
      MICHELLE_DIRECT_CRITICAL_ECHO_DESTINY_LEAD,
    ),
    maximumLeadFromCurrentHistory: Math.max(
      toInt(baseOptions.maximumLeadFromCurrentHistory, 0),
      MICHELLE_DIRECT_CRITICAL_ECHO_DESTINY_LEAD,
    ),
    maximumHistorySafeLeadOverride: Math.max(
      toInt(baseOptions.maximumHistorySafeLeadOverride, 0),
      MICHELLE_HELD_FUTURE_DESTINY_LEAD,
    ),
    historyLeadUsesCurrentSessionStamp: false,
    historyLeadUsesImmediateSessionStamp: false,
    historyLeadUsesPresentedSessionStamp: true,
    historyLeadPresentedMaximumFutureLead:
      MICHELLE_DIRECT_CRITICAL_ECHO_DESTINY_LEAD,
  });
}

function buildObserverCombatPresentedSendOptions(baseOptions = {}) {
  return buildMichelleSafeDestinySendOptions({
    ...baseOptions,
    destinyAuthorityContract: DESTINY_CONTRACTS.COMBAT_NONCRITICAL,
    minimumHistoryLeadFloor: MICHELLE_HELD_FUTURE_DESTINY_LEAD,
    minimumLeadFromCurrentHistory: Math.max(
      toInt(baseOptions.minimumLeadFromCurrentHistory, 0),
      MICHELLE_HELD_FUTURE_DESTINY_LEAD,
    ),
    maximumLeadFromCurrentHistory: Math.max(
      toInt(
        baseOptions.maximumLeadFromCurrentHistory,
        MICHELLE_HELD_FUTURE_DESTINY_LEAD,
      ),
      MICHELLE_HELD_FUTURE_DESTINY_LEAD,
    ),
    maximumHistorySafeLeadOverride: Math.max(
      toInt(baseOptions.maximumHistorySafeLeadOverride, 0),
      MICHELLE_HELD_FUTURE_DESTINY_LEAD,
    ),
    historyLeadUsesCurrentSessionStamp: false,
    historyLeadUsesImmediateSessionStamp: false,
    historyLeadUsesPresentedSessionStamp: true,
    historyLeadPresentedMaximumFutureLead: 0,
  });
}

function buildNpcOffensiveSpecialFxOptions(baseOptions = {}) {
  return buildObserverCombatPresentedSendOptions({
    ...baseOptions,
    useCurrentStamp: true,
  });
}

function buildObserverDamageStateSendOptions(baseOptions = {}) {
  return buildObserverCombatPresentedSendOptions(baseOptions);
}

function buildBootstrapAcquireSendOptions(baseOptions = {}) {
  return {
    ...baseOptions,
    destinyAuthorityContract: DESTINY_CONTRACTS.BOOTSTRAP_ACQUIRE,
  };
}

function buildStateResetSendOptions(baseOptions = {}) {
  return {
    ...baseOptions,
    destinyAuthorityContract: DESTINY_CONTRACTS.STATE_RESET,
  };
}

function buildDestructionTeardownSendOptions(baseOptions = {}) {
  return {
    ...baseOptions,
    destinyAuthorityContract: DESTINY_CONTRACTS.DESTRUCTION_TEARDOWN,
  };
}

module.exports = {
  buildBootstrapAcquireSendOptions,
  buildDestructionTeardownSendOptions,
  buildMichelleSafeDestinySendOptions,
  buildMissileDeploymentSpecialFxOptions,
  buildNpcOffensiveSpecialFxOptions,
  buildObserverCombatPresentedSendOptions,
  buildObserverDamageStateSendOptions,
  buildObserverMissileLifecycleSendOptions,
  buildObserverPropulsionShipPrimeBroadcastOptions,
  buildObserverPropulsionSpecialFxOptions,
  buildOwnerCloakShipStateSendOptions,
  buildOwnerDamageStateSendOptions,
  buildOwnerMissileFreshAcquireSendOptions,
  buildOwnerMissileLifecycleSendOptions,
  buildOwnerShipPrimeSendOptions,
  buildPresentedSessionAlignedDestinySendOptions,
  buildStateResetSendOptions,
};
