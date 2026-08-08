import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const {
  DEFAULT_PROFILE,
  REQUIRED_TABLES,
  parseArgs,
} = require("../../DatabaseCreator/database-creator.js");

test("DatabaseCreator emits Frontier deployable component authority", () => {
  assert.equal(REQUIRED_TABLES.includes("spaceComponentsByType"), true);
});

test("DatabaseCreator emits Frontier landscape site authority", () => {
  assert.equal(REQUIRED_TABLES.includes("landscapeSites"), true);
});

test("DatabaseCreator emits complete Frontier dungeon authority", () => {
  assert.equal(REQUIRED_TABLES.includes("frontierDungeonTemplates"), true);
});

test("DatabaseCreator emits Frontier modular ship creation authority", () => {
  for (const table of [
    "creationHardpointTypes",
    "creationModules",
    "creationParts",
    "creationTemplates",
  ]) {
    assert.equal(REQUIRED_TABLES.includes(table), true);
  }
});

test("DatabaseCreator keeps Tranquility as its default profile", () => {
  assert.equal(DEFAULT_PROFILE, "tranquility");
  assert.equal(parseArgs([]).profile, "tranquility");
});

test("DatabaseCreator accepts only the explicit Frontier profile", () => {
  assert.equal(parseArgs(["--profile", "frontier"]).profile, "frontier");
  assert.throws(
    () => parseArgs(["--profile", "unknown"]),
    /Invalid database profile/,
  );
});
