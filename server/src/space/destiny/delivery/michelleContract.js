"use strict";

const DESTINY_NOTIFICATION_NAME = "DoDestinyUpdate";
const DESTINY_NOTIFICATION_ID_TYPE = "clientID";

const MICHELLE_DIRECT_CRITICAL_ECHO_DESTINY_LEAD = 1;
const MICHELLE_HELD_FUTURE_DESTINY_LEAD = 2;
const MICHELLE_POST_HELD_FUTURE_DESTINY_LEAD =
  MICHELLE_HELD_FUTURE_DESTINY_LEAD + 1;

function isSessionOpenForDestinyDelivery(session) {
  if (!session || typeof session.sendNotification !== "function") {
    return false;
  }
  if (
    session.closed === true ||
    session.disconnected === true ||
    session._closed === true
  ) {
    return false;
  }
  if (
    Object.prototype.hasOwnProperty.call(session, "socket") &&
    (!session.socket || session.socket.destroyed === true)
  ) {
    return false;
  }
  return true;
}

function attemptDestinyNotificationDelivery(session, payloadTuple) {
  if (!isSessionOpenForDestinyDelivery(session)) {
    return {
      status: "rejected",
      reason: "session-closed",
      retryable: false,
    };
  }
  try {
    const result = session.sendNotification(
      DESTINY_NOTIFICATION_NAME,
      DESTINY_NOTIFICATION_ID_TYPE,
      payloadTuple,
    );
    if (result === false) {
      return {
        status: "rejected",
        reason: "explicit-false",
        retryable: true,
      };
    }
    return {
      status: "accepted",
      reason: "accepted",
      retryable: false,
    };
  } catch (error) {
    return {
      status: "ambiguous",
      reason: "delivery-threw",
      retryable: false,
      error,
    };
  }
}

function destroySessionAfterUnsafeDestinyDelivery(session, error = null) {
  const socket = session && session.socket;
  if (
    !socket ||
    socket.destroyed === true ||
    typeof socket.destroy !== "function"
  ) {
    return false;
  }
  try {
    socket.destroy(error || undefined);
    return true;
  } catch (_destroyError) {
    return false;
  }
}

const MOVEMENT_MICHELLE_CONTRACT = Object.freeze({
  MICHELLE_DIRECT_CRITICAL_ECHO_DESTINY_LEAD,
  MICHELLE_HELD_FUTURE_DESTINY_LEAD,
  MICHELLE_POST_HELD_FUTURE_DESTINY_LEAD,
});

module.exports = {
  DESTINY_NOTIFICATION_ID_TYPE,
  DESTINY_NOTIFICATION_NAME,
  MOVEMENT_MICHELLE_CONTRACT,
  attemptDestinyNotificationDelivery,
  destroySessionAfterUnsafeDestinyDelivery,
  isSessionOpenForDestinyDelivery,
  ...MOVEMENT_MICHELLE_CONTRACT,
};
