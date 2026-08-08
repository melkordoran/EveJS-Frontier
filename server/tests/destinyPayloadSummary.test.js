"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createDestinyPayloadSummary,
} = require("../src/space/destiny/protocol/payloadSummary");

test("AddBalls2 diagnostics recognize Frontier CRData entries", () => {
  const state = Buffer.alloc(5);
  state.writeUInt32LE(1234, 1);
  const args = [[
    state,
    {
      type: "list",
      items: [[
        9_200_000_000,
        {
          type: "dict",
          entries: [
            ["itemID", 9_200_000_000],
            ["typeID", 92395],
          ],
        },
      ]],
    },
  ]];

  const summary = createDestinyPayloadSummary()
    .summarizeDestinyArgs("AddBalls2", args);

  assert.deepEqual(summary, [{
    batchIndex: 0,
    stateStamp: 1234,
    entityCount: 1,
    entityIDs: [9_200_000_000],
    typeIDs: [92395],
  }]);
});

test("AddBalls2 diagnostics retain classic slim-item tuple support", () => {
  const state = Buffer.alloc(5);
  const args = [[
    state,
    {
      type: "list",
      items: [[
        {
          type: "dict",
          entries: [
            ["itemID", 40000004],
            ["typeID", 45031],
          ],
        },
        null,
      ]],
    },
  ]];

  const summary = createDestinyPayloadSummary()
    .summarizeDestinyArgs("AddBalls2", args);

  assert.equal(summary[0].entityCount, 1);
  assert.deepEqual(summary[0].entityIDs, [40000004]);
  assert.deepEqual(summary[0].typeIDs, [45031]);
});
