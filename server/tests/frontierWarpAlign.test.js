"use strict";

/**
 * Physical warp-align coverage: while a warp is pending the ship must turn
 * and accelerate through the real movement simulation (no instant heading
 * snap), and evaluatePendingWarp must gate warp start on genuine alignment.
 * Run through: npm run test:frontier-server (isolated runner).
 */

const assert = require("node:assert/strict");
const test = require("node:test");

const runtime = require("../src/space/runtime");

const advanceMovement = runtime._testing.advanceMovementForTesting;
const evaluatePendingWarp = runtime._testing.evaluatePendingWarpForTesting;

function vec(x, y, z) {
  return { x, y, z };
}

function dot(left, right) {
  return (left.x * right.x) + (left.y * right.y) + (left.z * right.z);
}

function magnitude(value) {
  return Math.hypot(value.x, value.y, value.z);
}

const WARP_DESTINATION = vec(0, 0, 5_000_000);

function buildAlignTestEntity(overrides = {}) {
  const requestedAtMs = 1_000_000;
  return {
    itemID: 970001,
    kind: "ship",
    mode: "WARP",
    position: vec(0, 0, 0),
    direction: vec(1, 0, 0), // facing +X, warping toward +Z: a 90° turn
    velocity: vec(0, 0, 0),
    speedFraction: 1,
    maxVelocity: 200,
    agilitySeconds: 6,
    alignTime: 8,
    mass: 1_000_000,
    inertia: 1,
    warpSpeedAU: 3,
    targetPoint: { ...WARP_DESTINATION },
    pendingWarp: {
      requestedAtMs,
      rawDestination: { ...WARP_DESTINATION },
      targetPoint: { ...WARP_DESTINATION },
      stopDistance: 0,
      totalDistance: magnitude(WARP_DESTINATION),
      warpSpeedAU: 3,
      targetEntityID: null,
      nativeWarpCommand: "WARP",
      prepareStamp: null,
      prepareVisibleStamp: null,
    },
    ...overrides,
  };
}

function runPendingWarpUntilReady(entity, maxTicks = 90) {
  const requestedAtMs = entity.pendingWarp.requestedAtMs;
  const gates = [];
  for (let tick = 1; tick <= maxTicks; tick += 1) {
    advanceMovement(entity, null, 1, requestedAtMs + (tick * 1000));
    const gate = evaluatePendingWarp(
      entity,
      entity.pendingWarp,
      requestedAtMs + (tick * 1000),
    );
    gates.push(gate);
    if (gate.aligned) {
      return { readyAtTick: tick, gates };
    }
  }
  return { readyAtTick: null, gates };
}

test("pending warp from rest accelerates through the speed gate over real time", () => {
  const entity = buildAlignTestEntity();
  const { readyAtTick, gates } = runPendingWarpUntilReady(entity);

  // From rest the velocity-lag model accelerates straight at the target, so
  // alignment is speed-gated: warp must not start on the first tick and must
  // take roughly ln(4)*agilitySeconds (~8s for a 6s-agility hull).
  assert.equal(gates[0].ready, false, "gate passed on the first tick");
  assert.equal(gates[0].alignedBySpeed, false);
  assert.notEqual(readyAtTick, null, "align gate never became ready");
  assert.ok(
    readyAtTick >= 3 && readyAtTick <= 30,
    `align completed at tick ${readyAtTick}, expected a physical duration`,
  );
  assert.ok(
    magnitude(entity.velocity) > 0.75 * entity.maxVelocity,
    "gate requires genuine speed, not the commanded fraction",
  );
});

test("pending warp from cruise turns the velocity vector gradually", () => {
  const entity = buildAlignTestEntity({
    velocity: vec(200, 0, 0), // full speed +X, warping toward +Z
  });
  const desired = vec(0, 0, 1);
  const { readyAtTick, gates } = runPendingWarpUntilReady(entity);

  // The first simulated second must not complete the 90° vector turn — that
  // is the insta-align regression this suite guards against.
  const tickOneVelocity = gates[0].alignmentDot;
  assert.ok(
    tickOneVelocity < 0.995,
    `tick 1 already aligned (${tickOneVelocity})`,
  );
  assert.equal(gates[0].ready, false, "gate passed on the first tick");
  assert.notEqual(readyAtTick, null, "align gate never became ready");
  assert.ok(
    readyAtTick >= 2 && readyAtTick <= 60,
    `turn completed at tick ${readyAtTick}, expected a physical duration`,
  );
  // Alignment progressed monotonically toward the warp vector.
  for (let index = 1; index < gates.length; index += 1) {
    assert.ok(
      gates[index].alignmentDot >= gates[index - 1].alignmentDot - 0.0001,
      `alignment regressed at tick ${index + 1}`,
    );
  }
  const finalDirection = normalizeSafe(entity.velocity);
  assert.ok(dot(finalDirection, desired) > 0.99, "ends aligned with the warp vector");
});

function normalizeSafe(value) {
  const length = magnitude(value);
  return length > 0
    ? { x: value.x / length, y: value.y / length, z: value.z / length }
    : { x: 0, y: 0, z: 0 };
}

test("align gate rejects aligned-but-slow and fast-but-misaligned ships", () => {
  const alignedSlow = buildAlignTestEntity({
    direction: vec(0, 0, 1),
    velocity: vec(0, 0, 10),
  });
  const slowGate = evaluatePendingWarp(
    alignedSlow,
    alignedSlow.pendingWarp,
    alignedSlow.pendingWarp.requestedAtMs + 1000,
  );
  assert.equal(slowGate.alignedByDot, true);
  assert.equal(slowGate.alignedBySpeed, false);
  assert.equal(slowGate.ready, false);

  const fastMisaligned = buildAlignTestEntity({
    direction: vec(1, 0, 0),
    velocity: vec(200, 0, 0),
  });
  const misalignedGate = evaluatePendingWarp(
    fastMisaligned,
    fastMisaligned.pendingWarp,
    fastMisaligned.pendingWarp.requestedAtMs + 1000,
  );
  assert.equal(misalignedGate.alignedByDot, false);
  assert.equal(misalignedGate.alignedBySpeed, true);
  assert.equal(misalignedGate.ready, false);

  const alignedFast = buildAlignTestEntity({
    direction: vec(0, 0, 1),
    velocity: vec(0, 0, 190),
  });
  const readyGate = evaluatePendingWarp(
    alignedFast,
    alignedFast.pendingWarp,
    alignedFast.pendingWarp.requestedAtMs + 1000,
  );
  assert.equal(readyGate.ready, true);
  assert.equal(readyGate.forced, false);
});

test("align gate force-starts a stuck warp after the tick valve", () => {
  const stuck = buildAlignTestEntity({
    direction: vec(1, 0, 0),
    velocity: vec(0, 0, 0),
  });
  const forcedGate = evaluatePendingWarp(
    stuck,
    stuck.pendingWarp,
    stuck.pendingWarp.requestedAtMs + (181 * 1000),
  );
  assert.equal(forcedGate.aligned, false);
  assert.equal(forcedGate.forced, true);
  assert.equal(forcedGate.ready, true);
});
