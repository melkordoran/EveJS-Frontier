#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const { listFrontierServerTests } = require("./frontier-test-files");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const DEFAULT_BUILD = "3474408";

function usage() {
  return [
    "Usage:",
    "  node scripts/Tests/run-frontier-server-tests.js [--build <number>]",
    "",
    `Default build: ${DEFAULT_BUILD}`,
  ].join("\n");
}

function parseArgs(argv = process.argv.slice(2)) {
  let build = DEFAULT_BUILD;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--build") {
      build = argv[++index] || "";
    } else if (argument.startsWith("--build=")) {
      build = argument.slice("--build=".length);
    } else if (argument === "--help" || argument === "-h") {
      return { help: true, build };
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }

  if (!/^\d+$/.test(build)) {
    throw new Error(`Build must be numeric: ${build || "<empty>"}`);
  }
  return { build, help: false };
}

function resolveBuildInputs(build, repoRoot = REPO_ROOT) {
  const runtimeRoot = path.join(
    repoRoot,
    "_local",
    "frontier-runtime",
    build,
    "gameStore",
  );
  const staticRoot = path.join(repoRoot, "_local", "frontier-sde", build);
  return { runtimeRoot, staticRoot };
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(usage());
    return 0;
  }

  const { runtimeRoot, staticRoot } = resolveBuildInputs(options.build);
  if (!fs.existsSync(path.join(runtimeRoot, "data"))) {
    throw new Error(
      `Frontier runtime is missing for build ${options.build}: ${runtimeRoot}`,
    );
  }
  if (!fs.existsSync(staticRoot)) {
    throw new Error(
      `Frontier static snapshot is missing for build ${options.build}: ${staticRoot}`,
    );
  }

  const testFiles = listFrontierServerTests(REPO_ROOT);
  if (testFiles.length === 0) {
    throw new Error("No server/tests/frontier*.test.js files were found");
  }

  console.log(
    `[frontier-server-tests] build=${options.build} files=${testFiles.length}`,
  );
  const isolatedRunner = path.join(
    REPO_ROOT,
    "scripts",
    "Tests",
    "run-isolated-tests.js",
  );
  const result = spawnSync(
    process.execPath,
    [isolatedRunner, "--test-concurrency=1", ...testFiles],
    {
      cwd: REPO_ROOT,
      stdio: "inherit",
      env: {
        ...process.env,
        EVEJS_CLIENT_BUILD: options.build,
        EVEJS_CLIENT_COMPATIBILITY_PROFILE: "frontier",
        EVEJS_STATIC_JSONL_ROOT: staticRoot,
        EVEJS_TEST_FRONTIER_FIXTURES: "1",
        EVEJS_TEST_STORE_BASELINE_ROOT: runtimeRoot,
      },
    },
  );
  if (result.error) {
    throw result.error;
  }
  return result.status === null ? 1 : result.status;
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`[frontier-server-tests] ${error.stack || error.message}`);
    console.error(usage());
    process.exitCode = 1;
  }
}

module.exports = {
  DEFAULT_BUILD,
  main,
  parseArgs,
  resolveBuildInputs,
  usage,
};
