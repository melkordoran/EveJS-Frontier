/**
 * GAMESTORE ROOT RESOLUTION:
 *
 * The single answer to "where does this install keep its runtime data?".
 *
 * Deliberately dependency-free (fs + path only) so anything needing a runtime
 * path — the image stores, admin tooling, migration scripts — can ask without
 * requiring server/src/gameStore, which opens SQLite and refuses to load in an
 * unisolated node:test process.
 *
 * The store root is the parent of the data dir. Everything under it is
 * per-install rather than per-checkout:
 *
 *   <storeRoot>/data/              per-table JSON (static and SDE-built tables)
 *   <storeRoot>/gamestore.sqlite   runtime tables
 *   <storeRoot>/images/            runtime-generated images (portraits, logos)
 *
 * Keeping them together is what makes "copy the store root" a complete backup,
 * and what puts uploaded portraits inside the Docker volume instead of the
 * container's ephemeral /app layer.
 */

const fs = require("fs");
const path = require("path");

const SOURCE_DATA_DIR = path.join(__dirname, "data");
const LOCAL_DATABASE_ROOT = path.resolve(__dirname, "../../..", "_local", "gameStore");
const LOCAL_DATA_DIR = path.join(LOCAL_DATABASE_ROOT, "data");
const RUNTIME_IMAGES_DIR_NAME = "images";

// Resolution is stable for a given EVEJS_GAMESTORE_DATA_DIR, and callers on the
// image-serving path ask per request, so memoise on the env value rather than
// re-running the existsSync probes every time.
let cachedEnvKey = null;
let cachedDataDir = null;

function resolveDataDir() {
  const envKey = String(process.env.EVEJS_GAMESTORE_DATA_DIR || "");
  if (cachedDataDir !== null && cachedEnvKey === envKey) {
    return cachedDataDir;
  }

  let dataDir;
  if (envKey) {
    dataDir = path.resolve(envKey);
  } else if (
    fs.existsSync(path.join(LOCAL_DATABASE_ROOT, "manifest.json")) ||
    fs.existsSync(LOCAL_DATA_DIR)
  ) {
    dataDir = LOCAL_DATA_DIR;
  } else {
    dataDir = SOURCE_DATA_DIR;
  }

  cachedEnvKey = envKey;
  cachedDataDir = dataDir;
  return dataDir;
}

function resolveStoreRoot() {
  return path.resolve(resolveDataDir(), "..");
}

function resolveRuntimeImagesDir() {
  return path.join(resolveStoreRoot(), RUNTIME_IMAGES_DIR_NAME);
}

module.exports = {
  LOCAL_DATABASE_ROOT,
  LOCAL_DATA_DIR,
  SOURCE_DATA_DIR,
  resolveDataDir,
  resolveRuntimeImagesDir,
  resolveStoreRoot,
};
