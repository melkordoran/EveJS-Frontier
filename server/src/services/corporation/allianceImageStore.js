const fs = require("fs");
const path = require("path");

const { resolveRuntimeImagesDir } = require("../../gameStore/storeRoot");

const IMAGE_ROOT = path.join(__dirname, "../../_secondary/image");
const ALLIANCE_IMAGE_SIZES = Object.freeze([32, 64, 128, 256, 512, 1024]);
const DEFAULT_ALLIANCE_LOGO_PATH = path.join(
  IMAGE_ROOT,
  "images",
  "alliance-default.png",
);

// Alliance logos are uploaded per install by the operator (ConfigEditor), so
// they belong with this install's runtime data rather than in the source tree.
// See portraitImageStore for the same rationale; reads fall back to the legacy
// location until `npm run images:migrate` moves them.
const LEGACY_ALLIANCE_ROOT = path.join(IMAGE_ROOT, "generated", "Alliance");

function toNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function ensureDirectory(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function getAllianceLogoRoot() {
  return path.join(resolveRuntimeImagesDir(), "Alliance");
}

// Runtime root first, so a freshly imported logo wins over a pre-migration one.
function listAllianceLogoRoots() {
  const runtimeRoot = getAllianceLogoRoot();
  return runtimeRoot === LEGACY_ALLIANCE_ROOT
    ? [runtimeRoot]
    : [runtimeRoot, LEGACY_ALLIANCE_ROOT];
}

function buildAllianceLogoPath(root, allianceID, size) {
  return path.join(root, `${toNumber(allianceID, 0)}_${toNumber(size, 0)}.png`);
}

function getAllianceLogoFilePath(allianceID, size) {
  return buildAllianceLogoPath(getAllianceLogoRoot(), allianceID, size);
}

function getLegacyAllianceLogoFilePath(allianceID, size) {
  return buildAllianceLogoPath(LEGACY_ALLIANCE_ROOT, allianceID, size);
}

function listAllianceLogoPaths(allianceID) {
  const numericAllianceID = toNumber(allianceID, 0);
  return listAllianceLogoRoots().flatMap((root) => (
    ALLIANCE_IMAGE_SIZES.map((size) => ({
      size,
      filePath: buildAllianceLogoPath(root, numericAllianceID, size),
    }))
  ));
}

function findAllianceLogoPath(allianceID, size = null) {
  const numericAllianceID = toNumber(allianceID, 0);
  if (numericAllianceID <= 0) {
    return null;
  }

  for (const root of listAllianceLogoRoots()) {
    if (size !== null && size !== undefined) {
      const exactPath = buildAllianceLogoPath(root, numericAllianceID, size);
      if (fs.existsSync(exactPath)) {
        return exactPath;
      }
    }

    for (const candidateSize of ALLIANCE_IMAGE_SIZES) {
      const filePath = buildAllianceLogoPath(root, numericAllianceID, candidateSize);
      if (fs.existsSync(filePath)) {
        return filePath;
      }
    }
  }

  return null;
}

module.exports = {
  DEFAULT_ALLIANCE_LOGO_PATH,
  ALLIANCE_IMAGE_SIZES,
  LEGACY_ALLIANCE_ROOT,
  ensureDirectory,
  findAllianceLogoPath,
  getAllianceLogoFilePath,
  getAllianceLogoRoot,
  getLegacyAllianceLogoFilePath,
  listAllianceLogoPaths,
  listAllianceLogoRoots,
};
