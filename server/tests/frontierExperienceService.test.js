"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  marshalEncode,
} = require("../src/network/tcp/utils/marshal");
const ExperienceService = require(
  "../src/services/frontier/experienceService",
);

const CHARACTER_ID = 140000005;
const FRONTIER_MARSHAL_OPTIONS = Object.freeze({
  compatibilityProfile: "frontier",
});

test("Frontier experience returns the complete zero-valued character contract", () => {
  const service = new ExperienceService();
  const response = service.Handle_get_character([], {
    characterID: CHARACTER_ID,
  });

  assert.deepEqual(response, {
    type: "dict",
    entries: [
      ["total_xp", 0],
      ["cap", 0],
      [
        "category_xp",
        {
          type: "dict",
          entries: [
            ["1", 0],
            ["2", 0],
            ["3", 0],
            ["4", 0],
          ],
        },
      ],
    ],
  });
  assert.doesNotThrow(() => marshalEncode(response, FRONTIER_MARSHAL_OPTIONS));

  assert.deepEqual(
    service.Handle_get_character([], { charid: CHARACTER_ID }),
    response,
  );
  assert.deepEqual(service.Handle_get_character([], {}), response);
});

test("Frontier experience progression exposes four attribute-bearing pathway rows", () => {
  const service = new ExperienceService();
  const response = service.Handle_get_character_progression([], {
    charid: CHARACTER_ID,
  });

  assert.equal(response.type, "list");
  assert.equal(response.items.length, 4);
  assert.deepEqual(
    response.items.map((row) => {
      assert.equal(row.type, "object");
      assert.equal(row.name, "util.KeyVal");
      return Object.fromEntries(row.args.entries);
    }),
    [
      { categoryID: 1, points: 0 },
      { categoryID: 2, points: 0 },
      { categoryID: 3, points: 0 },
      { categoryID: 4, points: 0 },
    ],
  );
  assert.doesNotThrow(() => marshalEncode(response, FRONTIER_MARSHAL_OPTIONS));

  assert.deepEqual(
    service.Handle_get_character_progression([], {}),
    response,
  );
});

test("Frontier experience keeps the existing empty-memory startup contract", () => {
  const service = new ExperienceService();
  const expected = {
    type: "dict",
    entries: [
      ["shell_memories", { type: "dict", entries: [] }],
      ["crown_memories", { type: "dict", entries: [] }],
    ],
  };

  assert.deepEqual(service.Handle_get_memories_from_character(), expected);
  assert.deepEqual(service.Handle_get_memories_from_shell(), expected);
});
