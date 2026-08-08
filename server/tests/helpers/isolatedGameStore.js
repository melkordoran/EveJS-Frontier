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
 * sqlite3 online-backup API produces a consistent snapshot including
 * un-checkpointed WAL frames; a raw file clone would silently drop them.
 */
function cloneSqliteDatabase(sourcePath, destinationPath) {
  const backup = spawnSync(
    "sqlite3",
    [sourcePath, `.backup '${destinationPath.replace(/'/g, "''")}'`],
    { stdio: "ignore" },
  );
  if (backup.status === 0 && fs.existsSync(destinationPath)) {
    return true;
  }
  return cloneTree(sourcePath, destinationPath);
}

/**
 * Create a disposable attested store. Returns { storeRoot, dataDir,
 * attestationPath, baselineRoot, env, cleanup } where `env` holds the exact
 * variables the isolation guard checks and `cleanup()` removes the store.
 */
function createIsolatedGameStore(options = {}) {
  const baselineRoot = path.resolve(
    options.baselineRoot || resolveDefaultBaselineRoot(),
  );
  const storeRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "evejs-test-store-"),
  );
  const dataDir = path.join(storeRoot, "data");

  const baselineDataDir = path.join(baselineRoot, "data");
  if (!cloneTree(baselineDataDir, dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  const baselineSqlite = path.join(baselineRoot, "gamestore.sqlite");
  if (fs.existsSync(baselineSqlite)) {
    cloneSqliteDatabase(baselineSqlite, path.join(storeRoot, "gamestore.sqlite"));
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

  return {
    storeRoot,
    dataDir,
    attestationPath,
    baselineRoot,
    env: {
      EVEJS_TEST_STORE_ISOLATED: "1",
      EVEJS_TEST_STORE_ROOT: storeRoot,
      EVEJS_TEST_STORE_ATTESTATION: attestationPath,
      EVEJS_TEST_STORE_BASELINE_ROOT: baselineRoot,
      EVEJS_GAMESTORE_DATA_DIR: dataDir,
    },
    cleanup() {
      fs.rmSync(storeRoot, { recursive: true, force: true });
    },
  };
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
  createIsolatedGameStore,
  markTestProcessForIsolatedStore,
  resolveDefaultBaselineRoot,
};
