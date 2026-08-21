#!/usr/bin/env node
"use strict";

const path = require("node:path");
const { spawnSync } = require("node:child_process");

const { listFrontierStaticTests } = require("./frontier-test-files");

const REPO_ROOT = path.resolve(__dirname, "..", "..");

function main() {
  const testFiles = listFrontierStaticTests(REPO_ROOT);
  if (testFiles.length === 0) {
    throw new Error("No Frontier static test files were found");
  }

  console.log(`[frontier-static-tests] files=${testFiles.length}`);
  const result = spawnSync(process.execPath, ["--test", ...testFiles], {
    cwd: REPO_ROOT,
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) {
    throw result.error;
  }
  return result.status === null ? 1 : result.status;
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`[frontier-static-tests] ${error.stack || error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { main };
