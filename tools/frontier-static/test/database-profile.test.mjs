import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const {
  DEFAULT_PROFILE,
  parseArgs,
} = require("../../DatabaseCreator/database-creator.js");

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
