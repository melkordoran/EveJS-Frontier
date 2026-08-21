"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  listFrontierServerTests,
  listFrontierStaticTests,
} = require("./frontier-test-files");
const {
  DEFAULT_BUILD,
  parseArgs,
  resolveBuildInputs,
} = require("./run-frontier-server-tests");

test("Frontier server runner accepts an explicit numeric build", () => {
  assert.deepEqual(parseArgs([]), { build: DEFAULT_BUILD, help: false });
  assert.deepEqual(parseArgs(["--build", "3474408"]), {
    build: "3474408",
    help: false,
  });
  assert.deepEqual(parseArgs(["--build=3474408"]), {
    build: "3474408",
    help: false,
  });
  assert.throws(() => parseArgs(["--build", "../3474408"]), /numeric/);
  assert.throws(() => parseArgs(["--unknown"]), /Unknown argument/);
});

test("Frontier test discovery is explicit, sorted, and safe with spaces", (t) => {
  const fixtureRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "evejs frontier test files "),
  );
  t.after(() => fs.rmSync(fixtureRoot, { force: true, recursive: true }));

  const serverTests = path.join(fixtureRoot, "server", "tests");
  const staticTests = path.join(
    fixtureRoot,
    "tools",
    "frontier-static",
    "test",
  );
  fs.mkdirSync(serverTests, { recursive: true });
  fs.mkdirSync(staticTests, { recursive: true });
  for (const name of [
    "frontierZulu.test.js",
    "notFrontier.test.js",
    "frontierAlpha.test.js",
    "frontierNotes.md",
  ]) {
    fs.writeFileSync(path.join(serverTests, name), "");
  }
  for (const name of ["z.test.mjs", "a.test.mjs", "notes.mjs"]) {
    fs.writeFileSync(path.join(staticTests, name), "");
  }

  assert.deepEqual(
    listFrontierServerTests(fixtureRoot).map((file) => path.basename(file)),
    ["frontierAlpha.test.js", "frontierZulu.test.js"],
  );
  assert.deepEqual(
    listFrontierStaticTests(fixtureRoot).map((file) => path.basename(file)),
    ["a.test.mjs", "z.test.mjs"],
  );
});

test("build inputs stay isolated beneath build-numbered local roots", () => {
  const repoRoot = path.resolve("repo with spaces");
  const inputs = resolveBuildInputs("3474408", repoRoot);
  assert.equal(
    inputs.runtimeRoot,
    path.join(
      repoRoot,
      "_local",
      "frontier-runtime",
      "3474408",
      "gameStore",
    ),
  );
  assert.equal(
    inputs.staticRoot,
    path.join(repoRoot, "_local", "frontier-sde", "3474408"),
  );
});
