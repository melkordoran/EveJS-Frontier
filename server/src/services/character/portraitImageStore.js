const fs = require("fs");
const path = require("path");

const { resolveRuntimeImagesDir } = require("../../gameStore/storeRoot");

const CHARACTER_PORTRAIT_SIZES = Object.freeze([32, 64, 128, 256, 512, 1024]);
const CHARACTER_PORTRAIT_EXTENSIONS = Object.freeze(["jpg", "png"]);
const IMAGE_ROOT = path.join(__dirname, "../../_secondary/image");
const DEFAULT_CHARACTER_PORTRAIT_PATH = path.join(IMAGE_ROOT, "images", "hi.jpg");

// Portraits are uploaded by players at runtime, so they live with the rest of
// this install's runtime data (the Docker volume, or _local\gameStore natively)
// beside gamestore.sqlite. They used to be written into the source tree, where
// a container rebuild or a move to a new install folder silently lost every
// one of them. Reads still fall back to the old location so an upgraded install
// keeps serving existing portraits until `npm run images:migrate` moves them.
const LEGACY_CHARACTER_ROOT = path.join(IMAGE_ROOT, "generated", "Character");

function toNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function ensureDirectory(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function getCharacterPortraitRoot() {
  return path.join(resolveRuntimeImagesDir(), "Character");
}

// Runtime root first: a portrait there is either a fresh upload or a migrated
// copy, and must win over anything left behind in the legacy location.
function listCharacterPortraitRoots() {
  const runtimeRoot = getCharacterPortraitRoot();
  return runtimeRoot === LEGACY_CHARACTER_ROOT
    ? [runtimeRoot]
    : [runtimeRoot, LEGACY_CHARACTER_ROOT];
}

function normalizePortraitExtension(extension = "jpg") {
  const normalized = String(extension || "").trim().toLowerCase();
  return CHARACTER_PORTRAIT_EXTENSIONS.includes(normalized) ? normalized : "jpg";
}

function buildPortraitPath(root, charId, size, extension) {
  return path.join(
    root,
    `${toNumber(charId, 0)}_${toNumber(size, 0)}.${normalizePortraitExtension(extension)}`,
  );
}

function getCharacterPortraitFilePath(charId, size, extension = "jpg") {
  return buildPortraitPath(getCharacterPortraitRoot(), charId, size, extension);
}

function getLegacyCharacterPortraitFilePath(charId, size, extension = "jpg") {
  return buildPortraitPath(LEGACY_CHARACTER_ROOT, charId, size, extension);
}

function listCharacterPortraitPathsInRoot(root, charId) {
  const numericCharId = toNumber(charId, 0);
  return CHARACTER_PORTRAIT_SIZES.flatMap((size) => (
    CHARACTER_PORTRAIT_EXTENSIONS.map((extension) => ({
      size,
      extension,
      filePath: buildPortraitPath(root, numericCharId, size, extension),
    }))
  ));
}

function listCharacterPortraitPaths(charId) {
  return listCharacterPortraitRoots().flatMap((root) => (
    listCharacterPortraitPathsInRoot(root, charId)
  ));
}

function normalizePortraitBytes(value) {
  if (Buffer.isBuffer(value)) {
    return value;
  }

  if (typeof value === "string") {
    return Buffer.from(value, "binary");
  }

  return Buffer.alloc(0);
}

function storeCharacterPortrait(charId, bytes, options = {}) {
  const numericCharId = toNumber(charId, 0);
  const portraitBytes = normalizePortraitBytes(bytes);
  const extension = normalizePortraitExtension(options.extension);
  const sizes = Array.isArray(options.sizes) && options.sizes.length > 0
    ? options.sizes.map((size) => toNumber(size, 0)).filter((size) => size > 0)
    : CHARACTER_PORTRAIT_SIZES;

  if (numericCharId <= 0 || portraitBytes.length === 0) {
    return {
      success: false,
      errorMsg: "INVALID_PORTRAIT_PAYLOAD",
    };
  }

  const portraitRoot = getCharacterPortraitRoot();
  ensureDirectory(portraitRoot);
  for (const size of sizes) {
    fs.writeFileSync(
      buildPortraitPath(portraitRoot, numericCharId, size, extension),
      portraitBytes,
    );
  }

  return {
    success: true,
    data: {
      charId: numericCharId,
      sizes: [...sizes],
      byteLength: portraitBytes.length,
    },
  };
}

function findCharacterPortraitPath(charId, size = null) {
  const numericCharId = toNumber(charId, 0);
  if (numericCharId <= 0) {
    return null;
  }

  for (const root of listCharacterPortraitRoots()) {
    if (size !== null && size !== undefined) {
      for (const extension of CHARACTER_PORTRAIT_EXTENSIONS) {
        const exactPath = buildPortraitPath(root, numericCharId, size, extension);
        if (fs.existsSync(exactPath)) {
          return exactPath;
        }
      }
    }

    for (const { filePath } of listCharacterPortraitPathsInRoot(root, numericCharId)) {
      if (fs.existsSync(filePath)) {
        return filePath;
      }
    }
  }

  return null;
}

// Deletes from both roots: a deleted character must not leave portrait bytes
// behind in the pre-migration location.
function clearCharacterPortraits(charId) {
  const numericCharId = toNumber(charId, 0);
  if (numericCharId <= 0) {
    return;
  }

  for (const { filePath } of listCharacterPortraitPaths(numericCharId)) {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }
}

module.exports = {
  CHARACTER_PORTRAIT_EXTENSIONS,
  CHARACTER_PORTRAIT_SIZES,
  DEFAULT_CHARACTER_PORTRAIT_PATH,
  LEGACY_CHARACTER_ROOT,
  findCharacterPortraitPath,
  getCharacterPortraitFilePath,
  getCharacterPortraitRoot,
  getLegacyCharacterPortraitFilePath,
  listCharacterPortraitRoots,
  storeCharacterPortrait,
  clearCharacterPortraits,
};
