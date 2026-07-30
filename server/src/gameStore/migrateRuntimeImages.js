#!/usr/bin/env node
"use strict";

/**
 * One-time migration: runtime-generated images used to be written into the
 * source tree at server/src/_secondary/image/generated/<kind>, which meant
 * character portraits and alliance logos were left behind whenever an install
 * was moved to a new folder, and destroyed outright whenever a Docker container
 * was rebuilt (the app tree is an image layer; only /var/lib/evejs is a volume).
 *
 * They now live beside gamestore.sqlite under <storeRoot>/images, so copying the
 * store root carries them along with the rest of the runtime data.
 *
 * This moves any pre-migration files into the new location. It is idempotent
 * and safe to re-run: a file that already exists at the destination is left
 * alone (the destination is the newer upload) and reported as skipped.
 *
 * Run automatically by StartServer.bat, or manually: npm run images:migrate
 *   --dry-run   report what would move without touching anything
 *   --quiet     print nothing unless something moved or failed
 */

const fs = require("fs");
const path = require("path");

const portraitStore = require("../services/character/portraitImageStore");
const allianceStore = require("../services/corporation/allianceImageStore");

const DRY_RUN = process.argv.includes("--dry-run");
const QUIET = process.argv.includes("--quiet");

// Only files this server actually generates are moved; anything else in the
// legacy directory is left untouched rather than guessed at.
const MIGRATIONS = [
  {
    label: "character portraits",
    legacyDir: portraitStore.LEGACY_CHARACTER_ROOT,
    targetDir: portraitStore.getCharacterPortraitRoot(),
    filePattern: /^\d+_\d+\.(?:jpg|png)$/i,
  },
  {
    label: "alliance logos",
    legacyDir: allianceStore.LEGACY_ALLIANCE_ROOT,
    targetDir: allianceStore.getAllianceLogoRoot(),
    filePattern: /^\d+_\d+\.png$/i,
  },
];

function moveFile(sourcePath, targetPath) {
  try {
    fs.renameSync(sourcePath, targetPath);
  } catch (error) {
    // The store root can sit on a different volume than the checkout.
    if (error.code !== "EXDEV") {
      throw error;
    }
    fs.copyFileSync(sourcePath, targetPath);
    fs.unlinkSync(sourcePath);
  }
}

function migrate({ label, legacyDir, targetDir, filePattern }) {
  const result = { label, legacyDir, targetDir, moved: 0, skipped: 0, failed: 0 };

  if (path.resolve(legacyDir) === path.resolve(targetDir) || !fs.existsSync(legacyDir)) {
    return result;
  }

  const entries = fs.readdirSync(legacyDir).filter((entry) => filePattern.test(entry));
  if (entries.length === 0) {
    return result;
  }

  if (!DRY_RUN) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  for (const entry of entries) {
    const sourcePath = path.join(legacyDir, entry);
    const targetPath = path.join(targetDir, entry);

    if (fs.existsSync(targetPath)) {
      result.skipped += 1;
      continue;
    }

    if (DRY_RUN) {
      result.moved += 1;
      continue;
    }

    try {
      moveFile(sourcePath, targetPath);
      result.moved += 1;
    } catch (error) {
      result.failed += 1;
      console.error(`  failed to move ${entry}: ${error.message}`);
    }
  }

  return result;
}

function main() {
  const results = MIGRATIONS.map(migrate);
  const moved = results.reduce((total, result) => total + result.moved, 0);
  const skipped = results.reduce((total, result) => total + result.skipped, 0);
  const failed = results.reduce((total, result) => total + result.failed, 0);

  if (moved === 0 && failed === 0 && QUIET) {
    return;
  }

  if (moved === 0 && skipped === 0 && failed === 0) {
    console.log("No legacy runtime image files found; nothing to migrate.");
    return;
  }

  for (const result of results) {
    if (result.moved === 0 && result.skipped === 0 && result.failed === 0) {
      continue;
    }
    console.log(
      `  ${result.label}: ${result.moved} ${DRY_RUN ? "to move" : "moved"}` +
        `${result.skipped > 0 ? `, ${result.skipped} skipped (already present)` : ""}` +
        `${result.failed > 0 ? `, ${result.failed} failed` : ""}`,
    );
    console.log(`    from ${result.legacyDir}`);
    console.log(`    to   ${result.targetDir}`);
  }

  if (DRY_RUN) {
    console.log("Dry run: nothing was changed.");
    return;
  }

  console.log(
    failed > 0
      ? "Runtime image migration finished with errors; see the messages above."
      : "Runtime image migration complete.",
  );

  if (failed > 0) {
    process.exitCode = 1;
  }
}

main();
