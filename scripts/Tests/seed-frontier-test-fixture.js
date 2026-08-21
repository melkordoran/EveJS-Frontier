#!/usr/bin/env node
"use strict";

const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const HELPER_PATH = path.join(
  REPO_ROOT,
  "server",
  "tests",
  "helpers",
  "isolatedGameStore.js",
);

if (
  process.env.EVEJS_TEST_STORE_ISOLATED !== "1" ||
  process.env.EVEJS_TEST_FRONTIER_FIXTURES !== "1"
) {
  throw new Error(
    "Refusing to seed Frontier test fixtures outside an attested disposable store",
  );
}

require(HELPER_PATH).markTestProcessForIsolatedStore();

const database = require(path.join(REPO_ROOT, "server", "src", "gameStore"));
const CharService = require(path.join(
  REPO_ROOT,
  "server",
  "src",
  "services",
  "character",
  "charService",
));
const {
  getCharacterRecord,
} = require(path.join(
  REPO_ROOT,
  "server",
  "src",
  "services",
  "character",
  "characterState",
));
const {
  getActiveShipItem,
} = require(path.join(
  REPO_ROOT,
  "server",
  "src",
  "services",
  "inventory",
  "itemStore",
));

const FRONTIER_TEST_CHARACTERS = Object.freeze([
  { characterID: 140000005, name: "Frontier Test Fixture" },
  { characterID: 140000006, name: "Frontier Owner Fixture" },
]);

async function main() {
  database.preloadAll();

  for (const fixture of FRONTIER_TEST_CHARACTERS) {
    const existingCharacter = getCharacterRecord(fixture.characterID);
    if (existingCharacter) {
      if (!getActiveShipItem(fixture.characterID)) {
        throw new Error(
          `Frontier test character ${fixture.characterID} exists without an active ship`,
        );
      }
      console.log(
        `[frontier-test-fixture] reused character=${fixture.characterID}`,
      );
      continue;
    }

    const createdCharacterID = new CharService().Handle_CreateCharacterInSpace(
      [fixture.name, 1],
      { userid: 900000 + (fixture.characterID - 140000000) },
    );
    if (Number(createdCharacterID) !== fixture.characterID) {
      throw new Error(
        `Expected Frontier test character ${fixture.characterID}, ` +
          `created ${createdCharacterID}`,
      );
    }
    const activeShip = getActiveShipItem(fixture.characterID);
    if (!activeShip || Number(activeShip.itemID) <= 0) {
      throw new Error(
        `Frontier test character ${fixture.characterID} has no active ship`,
      );
    }
    console.log(
      `[frontier-test-fixture] created character=${fixture.characterID} ` +
        `ship=${activeShip.itemID}`,
    );
  }
  database.flushAllSync();

  await database._shutdownPersistenceWorkerForTests();
  database._closeSqliteForTests();
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(`[frontier-test-fixture] ${error.stack || error.message}`);
    process.exit(1);
  },
);
