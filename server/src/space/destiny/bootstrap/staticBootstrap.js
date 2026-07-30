"use strict";

const {
  BALL_FLAG,
} = require("../constants");

const DESTINY_BOOTSTRAP_DELIVERY_ADDBALLS2 = "addBalls2";

function toFiniteNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function isAddBalls2BootstrapScope(scope) {
  return scope === "bubble" || scope === "site" || scope === "publicgrid";
}

function markAddBalls2BootstrapEntity(entity) {
  if (entity) {
    entity.destinyBootstrapDelivery = DESTINY_BOOTSTRAP_DELIVERY_ADDBALLS2;
  }
  return entity;
}

function applyAddBalls2StopPresentation(entity) {
  if (!entity) {
    return entity;
  }

  // Deliberately visual-only scenery uses one deterministic free STOP shape.
  // Authored and gameplay statics retain their own movement and menu semantics.
  entity.destinyBallMode = "STOP";
  entity.destinyForceFree = true;
  entity.destinyBallFlags = BALL_FLAG.IS_FREE;
  entity.mass = Math.max(1, toFiniteNumber(entity.mass, 1_000_000));
  entity.maxVelocity = Math.max(1, toFiniteNumber(entity.maxVelocity, 1));
  entity.inertia = Math.max(1, toFiniteNumber(entity.inertia, 1));
  entity.speedFraction = 1;
  return entity;
}

module.exports = {
  DESTINY_BOOTSTRAP_DELIVERY_ADDBALLS2,
  applyAddBalls2StopPresentation,
  isAddBalls2BootstrapScope,
  markAddBalls2BootstrapEntity,
};
