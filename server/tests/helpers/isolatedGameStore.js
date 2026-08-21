/**
 * Disposable, attested game-store provisioning for node:test runs.
 *
 * server/src/gameStore refuses to load inside a node:test process unless the
 * environment carries a valid isolation attestation (see
 * assertNodeTestIsolationBeforeOpen). This helper is the only writer of that
 * attestation: it clones a baseline store into a temporary root outside every
 * protected game-store path and emits the environment the guard verifies.
 *
 * Two roles:
 *  - Imported by scripts/Tests/run-isolated-tests.js to create/destroy the
 *    disposable store around a `node --test` child.
 *  - Preloaded (`node --require`) inside the test process itself, where it
 *    marks the process so gameStore skips its shutdown flush hooks for the
 *    throwaway store.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const ATTESTATION_FILE = ".evejs-test-store-attestation.json";
const CLEANUP_SYMBOL = Symbol.for("evejs.testStore.cleanupHooksInstalled");

function resolveDefaultBaselineRoot() {
  const fromEnv = String(process.env.EVEJS_TEST_STORE_BASELINE_ROOT || "");
  if (fromEnv) {
    return path.resolve(REPO_ROOT, fromEnv);
  }
  const localStoreRoot = path.resolve(REPO_ROOT, "_local", "gameStore");
  if (fs.existsSync(path.join(localStoreRoot, "data"))) {
    return localStoreRoot;
  }
  // Fall back to the checked-in seed data (no sqlite; tables start empty).
  return path.resolve(REPO_ROOT, "server", "src", "gameStore");
}

function cloneTree(sourcePath, destinationPath) {
  if (!fs.existsSync(sourcePath)) {
    return false;
  }
  // APFS clone first: the frontier baseline data dir is ~630 MB and copy-on-
  // write makes provisioning effectively free. Fall back to a real copy.
  if (process.platform === "darwin") {
    const result = spawnSync("cp", ["-cR", sourcePath, destinationPath], {
      stdio: "ignore",
    });
    if (result.status === 0) {
      return true;
    }
  }
  fs.cpSync(sourcePath, destinationPath, { recursive: true });
  return true;
}

/**
 * Copy a SQLite database that may be open in WAL mode by a live server. The
 * better-sqlite3's online-backup API produces a consistent snapshot including
 * un-checkpointed WAL frames. There is deliberately no raw-copy fallback:
 * copying only the main file of a live WAL database can silently lose data.
 */
async function cloneSqliteDatabase(sourcePath, destinationPath) {
  if (fs.existsSync(destinationPath)) {
    throw new Error(
      `Refusing to replace an existing SQLite backup: ${destinationPath}`,
    );
  }

  let Database;
  try {
    Database = require("better-sqlite3");
  } catch (error) {
    throw new Error(
      "Cannot create a consistent SQLite test snapshot because " +
        "server/node_modules/better-sqlite3 is unavailable. Run " +
        "`npm --prefix server ci` under the active Node version.",
      { cause: error },
    );
  }

  let sourceDatabase;
  try {
    sourceDatabase = new Database(sourcePath, {
      fileMustExist: true,
      readonly: true,
    });
    await sourceDatabase.backup(destinationPath);
  } catch (error) {
    throw new Error(
      `Failed to back up SQLite baseline ${sourcePath}: ${error.message}`,
      { cause: error },
    );
  } finally {
    if (sourceDatabase && sourceDatabase.open) {
      sourceDatabase.close();
    }
  }

  if (!fs.existsSync(destinationPath)) {
    throw new Error(
      `SQLite backup reported success without creating ${destinationPath}`,
    );
  }
  return true;
}

function seedFrontierTestFixtures(storeEnvironment) {
  const seederPath = path.join(
    REPO_ROOT,
    "scripts",
    "Tests",
    "seed-frontier-test-fixture.js",
  );
  const result = spawnSync(process.execPath, [seederPath], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ...storeEnvironment,
      EVEJS_TEST_FRONTIER_FIXTURES: "1",
    },
    stdio: "inherit",
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `Frontier test fixture seeder failed with exit code ${result.status}`,
    );
  }
}

/**
 * Create a disposable attested store. Resolves to { storeRoot, dataDir,
 * attestationPath, baselineRoot, env, cleanup } where `env` holds the exact
 * variables the isolation guard checks and `cleanup()` removes the store.
 * Set options.seedFrontierFixtures only for the Frontier suite; the seed is
 * written to this disposable store, never its baseline.
 */
async function createIsolatedGameStore(options = {}) {
  const baselineRoot = path.resolve(
    options.baselineRoot || resolveDefaultBaselineRoot(),
  );
  const storeRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "evejs-test-store-"),
  );
  const dataDir = path.join(storeRoot, "data");

  try {
    const baselineDataDir = path.join(baselineRoot, "data");
    if (!cloneTree(baselineDataDir, dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    const baselineSqlite = path.join(baselineRoot, "gamestore.sqlite");
    if (fs.existsSync(baselineSqlite)) {
      await cloneSqliteDatabase(
        baselineSqlite,
        path.join(storeRoot, "gamestore.sqlite"),
      );
    }
    const baselineManifest = path.join(baselineRoot, "manifest.json");
    if (fs.existsSync(baselineManifest)) {
      cloneTree(baselineManifest, path.join(storeRoot, "manifest.json"));
    }

    const attestationPath = path.join(storeRoot, ATTESTATION_FILE);
    fs.writeFileSync(
      attestationPath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          kind: "evejs-test-store",
          createdBy: "server/tests/helpers/isolatedGameStore.js",
          createdAtMs: Date.now(),
          storeRoot,
          dataDir,
          baselineRoot,
        },
        null,
        2,
      )}\n`,
    );

    const environment = {
      EVEJS_TEST_STORE_ISOLATED: "1",
      EVEJS_TEST_STORE_ROOT: storeRoot,
      EVEJS_TEST_STORE_ATTESTATION: attestationPath,
      EVEJS_TEST_STORE_BASELINE_ROOT: baselineRoot,
      EVEJS_GAMESTORE_DATA_DIR: dataDir,
    };
    if (options.seedFrontierFixtures === true) {
      seedFrontierTestFixtures(environment);
    }

    return {
      storeRoot,
      dataDir,
      attestationPath,
      baselineRoot,
      env: environment,
      cleanup() {
        fs.rmSync(storeRoot, { recursive: true, force: true });
      },
    };
  } catch (error) {
    fs.rmSync(storeRoot, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Inside an attested test process: mark it so gameStore's shutdown handlers
 * skip flush work for the disposable store. No-op outside isolation.
 */
function markTestProcessForIsolatedStore() {
  if (process.env.EVEJS_TEST_STORE_ISOLATED !== "1") {
    return false;
  }
  process[CLEANUP_SYMBOL] = true;
  return true;
}

if (
  process.env.EVEJS_TEST_STORE_ISOLATED === "1" &&
  process.env.EVEJS_TEST_STORE_ROOT
) {
  markTestProcessForIsolatedStore();
}

module.exports = {
  ATTESTATION_FILE,
  cloneSqliteDatabase,
  createIsolatedGameStore,
  markTestProcessForIsolatedStore,
  resolveDefaultBaselineRoot,
  seedFrontierTestFixtures,
};
