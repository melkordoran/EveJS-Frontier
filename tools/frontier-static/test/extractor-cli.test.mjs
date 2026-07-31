import assert from "node:assert/strict";
import test from "node:test";

import { parseArgs, selectBuild } from "../extract-frontier-static.mjs";

test("parseArgs accepts an explicit Frontier client and build", () => {
  const options = parseArgs([
    "--client-root",
    "/tmp/frontier",
    "--build",
    "3450341",
    "--out",
    "/tmp/output",
    "--force",
    "--dry-run",
  ]);
  assert.equal(options.clientRoot, "/tmp/frontier");
  assert.equal(options.build, 3450341);
  assert.equal(options.outDir, "/tmp/output");
  assert.equal(options.force, true);
  assert.equal(options.dryRun, true);
});

test("selectBuild chooses the requested build or newest available build", () => {
  const candidates = [{ build: 3450341 }, { build: 3440000 }];
  assert.equal(selectBuild(candidates, null).build, 3450341);
  assert.equal(selectBuild(candidates, 3440000).build, 3440000);
  assert.throws(() => selectBuild(candidates, 1), /is not installed/);
});
