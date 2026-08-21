#!/usr/bin/env node
/**
 * Isolated node:test runner.
 *
 * Usage: node scripts/Tests/run-isolated-tests.js server/tests/<file>.test.js [...]
 *        npm run test:isolated -- server/tests/<file>.test.js
 *
 * Provisions a disposable attested game store (see
 * server/tests/helpers/isolatedGameStore.js), runs `node --test` against it,
 * and removes the store afterwards. Baseline selection:
 * EVEJS_TEST_STORE_BASELINE_ROOT (repo-relative or absolute), else
 * _local/gameStore, else the checked-in seed data.
 */

const path = require("path");
const { spawnSync } = require("child_process");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const HELPER_PATH = path.join(
  REPO_ROOT,
  "server",
  "tests",
  "helpers",
  "isolatedGameStore.js",
);
const { createIsolatedGameStore } = require(HELPER_PATH);

const testFiles = process.argv.slice(2).filter((arg) => !arg.startsWith("-"));
const passthroughFlags = process.argv
  .slice(2)
  .filter((arg) => arg.startsWith("-"));
if (testFiles.length === 0) {
  console.error(
    "Usage: node scripts/Tests/run-isolated-tests.js server/tests/<file>.test.js [...]",
  );
  process.exit(2);
}

async function main() {
  const store = await createIsolatedGameStore({
    seedFrontierFixtures:
      process.env.EVEJS_TEST_FRONTIER_FIXTURES === "1",
  });
  console.log(
    `[isolated-tests] store=${store.storeRoot} baseline=${store.baselineRoot}`,
  );

  let exitCode = 1;
  try {
    const result = spawnSync(
      process.execPath,
      [
        "--test",
        "--require",
        HELPER_PATH,
        ...passthroughFlags,
        ...testFiles.map((file) => path.resolve(REPO_ROOT, file)),
      ],
      {
        cwd: REPO_ROOT,
        stdio: "inherit",
        env: {
          ...process.env,
          ...store.env,
        },
      },
    );
    if (result.error) {
      throw result.error;
    }
    exitCode = result.status === null ? 1 : result.status;
  } finally {
    try {
      store.cleanup();
    } catch (error) {
      console.warn(
        `[isolated-tests] failed to remove ${store.storeRoot}: ${error.message}`,
      );
    }
  }
  return exitCode;
}

main().then(
  (exitCode) => {
    process.exitCode = exitCode;
  },
  (error) => {
    console.error(`[isolated-tests] ${error.stack || error.message}`);
    process.exitCode = 1;
  },
);
