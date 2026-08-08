import assert from "node:assert/strict";
import test from "node:test";

import {
  REQUIRED_RESOURCES,
  parseArgs,
  selectBuild,
} from "../extract-frontier-static.mjs";

test("the Frontier snapshot includes deployable component authority", () => {
  assert.equal(
    REQUIRED_RESOURCES.spaceComponentsByType,
    "res:/staticdata/spacecomponentsbytype.fsdbinary",
  );
});

test("the Frontier snapshot includes landscape site authority", () => {
  assert.equal(
    REQUIRED_RESOURCES.landscapes,
    "res:/staticdata/landscape.fsdbinary",
  );
  assert.equal(
    REQUIRED_RESOURCES.ecosystems,
    "res:/staticdata/ecosystem.fsdbinary",
  );
  assert.equal(
    REQUIRED_RESOURCES.dungeons,
    "res:/staticdata/dungeons.fsdbinary",
  );
});

test("the Frontier dungeon resource also supplies Rift authority", () => {
  assert.equal(
    REQUIRED_RESOURCES.dungeons,
    "res:/staticdata/dungeons.fsdbinary",
  );
});

test("the Frontier snapshot includes modular ship creation authority", () => {
  assert.equal(
    REQUIRED_RESOURCES.creationTemplates,
    "res:/staticdata/creation_templates.fsdbinary",
  );
  assert.equal(
    REQUIRED_RESOURCES.creationModules,
    "res:/staticdata/creation_modules.fsdbinary",
  );
  assert.equal(
    REQUIRED_RESOURCES.creationParts,
    "res:/staticdata/creation_parts.fsdbinary",
  );
  assert.equal(
    REQUIRED_RESOURCES.creationHardpointTypes,
    "res:/staticdata/creation_hardpoint_types.fsdbinary",
  );
});

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
