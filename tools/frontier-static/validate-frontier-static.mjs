#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "../..");

const REQUIRED_FILES = [
  "_sde.jsonl",
  "categories.jsonl",
  "dogmaAttributes.jsonl",
  "dogmaEffects.jsonl",
  "groups.jsonl",
  "locationCache.jsonl",
  "mapConstellations.jsonl",
  "mapJumps.jsonl",
  "mapLagrangePoints.jsonl",
  "mapMoons.jsonl",
  "mapPlanets.jsonl",
  "mapRegions.jsonl",
  "mapSolarSystems.jsonl",
  "mapStargates.jsonl",
  "mapStars.jsonl",
  "npcStations.jsonl",
  "typeDogma.jsonl",
  "types.jsonl",
];

function usage() {
  return [
    "Usage:",
    "  node tools/frontier-static/validate-frontier-static.mjs [--snapshot <path>]",
  ].join("\n");
}

function parseArgs(argv = process.argv.slice(2)) {
  const options = { snapshot: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--snapshot") {
      options.snapshot = path.resolve(argv[++index] || "");
    } else if (argument === "--help" || argument === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return options;
}

function findLatestSnapshot() {
  const root = path.join(REPO_ROOT, "_local", "frontier-sde");
  if (!fs.existsSync(root)) {
    throw new Error(`No Frontier snapshots found: ${root}`);
  }
  const builds = fs.readdirSync(root)
    .filter((entry) => /^\d+$/.test(entry))
    .map(Number)
    .sort((left, right) => right - left);
  if (builds.length === 0) {
    throw new Error(`No build-numbered Frontier snapshots found: ${root}`);
  }
  return path.join(root, String(builds[0]));
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

async function readJsonl(snapshot, fileName, onRecord = () => {}) {
  const filePath = path.join(snapshot, fileName);
  const input = fs.createReadStream(filePath, { encoding: "utf8" });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  const keys = new Set();
  let count = 0;

  for await (const line of lines) {
    const text = line.trim();
    if (!text) {
      continue;
    }
    let row;
    try {
      row = JSON.parse(text);
    } catch (error) {
      throw new Error(`${fileName}:${count + 1}: ${error.message}`);
    }
    assert(Object.prototype.hasOwnProperty.call(row, "_key"), `${fileName}:${count + 1}: missing _key`);
    const key = String(row._key);
    assert(!keys.has(key), `${fileName}:${count + 1}: duplicate _key ${key}`);
    keys.add(key);
    onRecord(row);
    count += 1;
  }

  return { count, keys };
}

async function validateSnapshot(snapshot) {
  const manifestPath = path.join(snapshot, "frontier-extraction-manifest.json");
  assert(fs.existsSync(manifestPath), `Snapshot manifest not found: ${manifestPath}`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  assert(manifest.format === "evejs-frontier-static-v1", "Unrecognized snapshot format");

  for (const fileName of REQUIRED_FILES) {
    const metadata = manifest.outputs[fileName];
    assert(metadata, `Manifest is missing required output: ${fileName}`);
    const filePath = path.join(snapshot, fileName);
    assert(fs.existsSync(filePath), `Snapshot file is missing: ${fileName}`);
    assert(fs.statSync(filePath).size === metadata.bytes, `Byte size mismatch: ${fileName}`);
    assert(sha256File(filePath) === metadata.sha256, `SHA-256 mismatch: ${fileName}`);
  }

  const observedCounts = new Map();
  async function load(fileName, onRecord) {
    const result = await readJsonl(snapshot, fileName, onRecord);
    observedCounts.set(fileName, result.count);
    return result;
  }

  const categoryIDs = (await load("categories.jsonl")).keys;
  const groupCategory = new Map();
  const groups = await load("groups.jsonl", (row) => {
    groupCategory.set(Number(row._key), Number(row.categoryID));
  });
  for (const [groupID, categoryID] of groupCategory) {
    assert(categoryIDs.has(String(categoryID)), `Group ${groupID} references category ${categoryID}`);
  }

  const types = await load("types.jsonl", (row) => {
    assert(groupCategory.has(Number(row.groupID)), `Type ${row._key} references group ${row.groupID}`);
    assert(row.name && typeof row.name.en === "string", `Type ${row._key} has no English name`);
  });

  const systemIDs = new Set();
  const systemStarIDs = new Map();
  const systems = await load("mapSolarSystems.jsonl", (row) => {
    systemIDs.add(Number(row._key));
    systemStarIDs.set(Number(row._key), Number(row.starID));
  });

  const stars = await load("mapStars.jsonl", (row) => {
    assert(systemIDs.has(Number(row.solarSystemID)), `Star ${row._key} has unknown system`);
    assert(
      systemStarIDs.get(Number(row.solarSystemID)) === Number(row._key),
      `System ${row.solarSystemID} does not point back to star ${row._key}`,
    );
  });
  assert(stars.count === systems.count, "Every Frontier system must have exactly one star");

  for (const fileName of [
    "mapPlanets.jsonl",
    "mapMoons.jsonl",
    "mapLagrangePoints.jsonl",
    "npcStations.jsonl",
  ]) {
    await load(fileName, (row) => {
      assert(
        systemIDs.has(Number(row.solarSystemID)),
        `${fileName} ${row._key} has unknown system ${row.solarSystemID}`,
      );
    });
  }

  const gatesByID = new Map();
  const stargates = await load("mapStargates.jsonl", (row) => {
    assert(systemIDs.has(Number(row.solarSystemID)), `Stargate ${row._key} has unknown system`);
    assert(row.destination, `Stargate ${row._key} has no destination`);
    gatesByID.set(Number(row._key), row);
  });
  for (const [gateID, gate] of gatesByID) {
    const destinationID = Number(gate.destination.stargateID);
    const destination = gatesByID.get(destinationID);
    assert(destination, `Stargate ${gateID} references unknown gate ${destinationID}`);
    assert(
      Number(destination.destination.stargateID) === gateID,
      `Stargate ${gateID} destination ${destinationID} is not reciprocal`,
    );
    assert(
      Number(gate.destination.solarSystemID) === Number(destination.solarSystemID),
      `Stargate ${gateID} has an incorrect destination system`,
    );
  }

  for (const [fileName, metadata] of Object.entries(manifest.outputs)) {
    if (!observedCounts.has(fileName)) {
      const result = await load(fileName);
      assert(result.count === metadata.records, `Record count mismatch: ${fileName}`);
    }
    assert(observedCounts.get(fileName) === metadata.records, `Record count mismatch: ${fileName}`);
  }

  const checked = {
    build: manifest.source.client.build,
    categories: categoryIDs.size,
    groups: groups.count,
    stargates: stargates.count,
    systems: systems.count,
    types: types.count,
  };
  return checked;
}

async function main() {
  const options = parseArgs();
  if (options.help) {
    console.log(usage());
    return;
  }
  const snapshot = options.snapshot || findLatestSnapshot();
  const checked = await validateSnapshot(snapshot);
  console.log(
    `[frontier-static] Valid build ${checked.build}: ` +
    `${checked.systems.toLocaleString()} systems, ` +
    `${checked.types.toLocaleString()} types, ` +
    `${checked.stargates.toLocaleString()} stargates.`,
  );
  console.log(`[frontier-static] Snapshot: ${snapshot}`);
}

if (process.argv[1] &&
    path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[frontier-static] ${error.message}`);
    process.exitCode = 1;
  });
}

export {
  findLatestSnapshot,
  parseArgs,
  readJsonl,
  validateSnapshot,
};
