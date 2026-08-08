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
  "creationHardpointTypes.jsonl",
  "creationModules.jsonl",
  "creationParts.jsonl",
  "creationTemplates.jsonl",
  "dogmaAttributes.jsonl",
  "dogmaEffects.jsonl",
  "frontierDungeonTemplates.jsonl",
  "groups.jsonl",
  "landscapeDungeonTemplates.jsonl",
  "landscapeEcosystems.jsonl",
  "landscapeSites.jsonl",
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
  "spaceComponentsByType.jsonl",
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
  const typeIDs = types.keys;

  const creationHardpointTypeIDs = (
    await load("creationHardpointTypes.jsonl")
  ).keys;
  const creationModuleIDs = (await load("creationModules.jsonl", (row) => {
    const typeID = Number(row._key);
    const placement = row.placement && typeof row.placement === "object"
      ? row.placement
      : {};
    for (const hardpointType of placement.hardpoints || []) {
      assert(
        creationHardpointTypeIDs.has(String(hardpointType)),
        `Creation module ${typeID} references unknown hardpoint ${hardpointType}`,
      );
    }
    for (const hardpointType of placement.compatible_hardpoints || []) {
      assert(
        creationHardpointTypeIDs.has(String(hardpointType)),
        `Creation module ${typeID} references unknown compatible hardpoint ${hardpointType}`,
      );
    }
  })).keys;
  const creationParts = await load("creationParts.jsonl");
  const creationTemplates = await load("creationTemplates.jsonl", (row) => {
    const typeID = Number(row._key);
    assert(typeIDs.has(String(typeID)), `Creation template ${typeID} has unknown hull type`);
    assert(row.parts && typeof row.parts === "object", `Creation template ${typeID} has no parts`);
    const templatePartIDs = new Set(Object.keys(row.parts).map(String));
    for (const [partID, part] of Object.entries(row.parts)) {
      assert(
        creationParts.keys.has(String(part && part.graphic_id)),
        `Creation template ${typeID} part ${partID} has unknown graphic ${part && part.graphic_id}`,
      );
      assert(Array.isArray(part.position), `Creation template ${typeID} part ${partID} has no position`);
      assert(Array.isArray(part.rotation), `Creation template ${typeID} part ${partID} has no rotation`);
    }
    const interiorModules = row.interior_modules || [];
    assert(Array.isArray(interiorModules), `Creation template ${typeID} has invalid interior modules`);
    for (const module of interiorModules) {
      assert(
        creationModuleIDs.has(String(module.type_id)),
        `Creation template ${typeID} references unknown module ${module.type_id}`,
      );
      assert(
        templatePartIDs.has(String(module.part_id)),
        `Creation template ${typeID} module ${module.type_id} references unknown part ${module.part_id}`,
      );
      assert(Array.isArray(module.position), `Creation template ${typeID} module ${module.type_id} has no position`);
      assert(Array.isArray(module.rotation), `Creation template ${typeID} module ${module.type_id} has no rotation`);
      for (const [hardpointIndex, hardpoint] of (module.hardpoints || []).entries()) {
        assert(
          templatePartIDs.has(String(hardpoint.part_id)),
          `Creation template ${typeID} module ${module.type_id} hardpoint ${hardpointIndex} references unknown part ${hardpoint.part_id}`,
        );
        assert(
          !hardpoint.exterior_type_id || creationModuleIDs.has(String(hardpoint.exterior_type_id)),
          `Creation template ${typeID} module ${module.type_id} hardpoint ${hardpointIndex} references unknown exterior module ${hardpoint.exterior_type_id}`,
        );
        assert(Array.isArray(hardpoint.position), `Creation template ${typeID} module ${module.type_id} hardpoint ${hardpointIndex} has no position`);
        assert(Array.isArray(hardpoint.rotation), `Creation template ${typeID} module ${module.type_id} hardpoint ${hardpointIndex} has no rotation`);
      }
    }
  });
  assert(creationParts.count > 0, "Frontier creation data contains no hull parts");
  assert(creationTemplates.count > 0, "Frontier creation data contains no ship templates");

  const frontierDungeonIDs = new Set();
  await load("frontierDungeonTemplates.jsonl", (row) => {
    const dungeonID = Number(row._key);
    frontierDungeonIDs.add(dungeonID);
    assert(Number(row.dungeonID) === dungeonID, `Frontier dungeon ${dungeonID} has mismatched dungeonID`);
    assert(Array.isArray(row.rooms), `Frontier dungeon ${dungeonID} has no rooms`);
    assert(Array.isArray(row.triggers), `Frontier dungeon ${dungeonID} has no triggers`);
    for (const room of row.rooms) {
      assert(Number(room.roomID) > 0, `Frontier dungeon ${dungeonID} has an invalid room`);
      assert(Array.isArray(room.objects), `Frontier dungeon ${dungeonID} room ${room.roomID} has no objects`);
      for (const object of room.objects) {
        assert(Number(object.objectID) > 0, `Frontier dungeon ${dungeonID} has an invalid object`);
        assert(
          typeIDs.has(String(object.typeID)),
          `Frontier dungeon ${dungeonID} object ${object.objectID} has unknown type ${object.typeID}`,
        );
      }
    }
  });
  assert(frontierDungeonIDs.size > 0, "Frontier dungeon authority is empty");

  const landscapeDungeonIDs = new Set();
  await load("landscapeDungeonTemplates.jsonl", (row) => {
    const dungeonID = Number(row._key);
    landscapeDungeonIDs.add(dungeonID);
    assert(Number(row.dungeonID) === dungeonID, `Landscape dungeon ${dungeonID} has mismatched dungeonID`);
    assert(Array.isArray(row.rooms), `Landscape dungeon ${dungeonID} has no rooms`);
    for (const room of row.rooms) {
      assert(Number(room.roomID) > 0, `Landscape dungeon ${dungeonID} has an invalid room`);
      assert(Array.isArray(room.objects), `Landscape dungeon ${dungeonID} room ${room.roomID} has no objects`);
      for (const object of room.objects) {
        assert(Number(object.objectID) > 0, `Landscape dungeon ${dungeonID} has an invalid object`);
        assert(
          typeIDs.has(String(object.typeID)),
          `Landscape dungeon ${dungeonID} object ${object.objectID} has unknown type ${object.typeID}`,
        );
        assert(
          ["entryLocator", "eventLocator", "poiLocator", "resourceLocator", "scenery"].includes(object.role),
          `Landscape dungeon ${dungeonID} object ${object.objectID} has invalid role ${object.role}`,
        );
      }
    }
  });

  const landscapeEcosystemIDs = new Set();
  await load("landscapeEcosystems.jsonl", (row) => {
    const ecosystemID = Number(row._key);
    landscapeEcosystemIDs.add(ecosystemID);
    assert(Number(row.ecosystemID) === ecosystemID, `Landscape ecosystem ${ecosystemID} has mismatched ecosystemID`);
    assert(
      landscapeDungeonIDs.has(Number(row.entryDungeonID)),
      `Landscape ecosystem ${ecosystemID} has unknown entry dungeon ${row.entryDungeonID}`,
    );
    for (const fieldName of ["naturalWorldPatterns", "brokenWorldPatterns"]) {
      assert(Array.isArray(row[fieldName]), `Landscape ecosystem ${ecosystemID} has no ${fieldName}`);
      for (const pattern of row[fieldName]) {
        assert(
          landscapeDungeonIDs.has(Number(pattern.dungeonID)),
          `Landscape ecosystem ${ecosystemID} has unknown pattern dungeon ${pattern.dungeonID}`,
        );
      }
    }
  });

  const componentsByTypeID = new Map();
  await load("spaceComponentsByType.jsonl", (row) => {
    componentsByTypeID.set(Number(row._key), row);
  });
  const relayComponents = componentsByTypeID.get(90184);
  const relaySiteComponents = componentsByTypeID.get(91717);
  assert(relayComponents, "Relay type 90184 has no space-component definition");
  assert(
    Number(relayComponents.smartDeployable?.constructionSite) === 91717,
    "Relay type 90184 does not map to construction site 91717",
  );
  assert(
    relaySiteComponents?.assemblyConstruction,
    "Relay construction site 91717 has no assemblyConstruction component",
  );

  const systemIDs = new Set();
  const systemStarIDs = new Map();
  const systems = await load("mapSolarSystems.jsonl", (row) => {
    systemIDs.add(Number(row._key));
    systemStarIDs.set(Number(row._key), Number(row.starID));
  });

  const landscapeSiteIDs = new Set();
  const landscapeSites = await load("landscapeSites.jsonl", (row) => {
    const siteID = Number(row._key);
    landscapeSiteIDs.add(siteID);
    assert(Number(row.siteID) === siteID, `Landscape site ${siteID} has mismatched siteID`);
    assert(
      systemIDs.has(Number(row.solarSystemID)),
      `Landscape site ${siteID} has unknown system ${row.solarSystemID}`,
    );
    assert(
      typeIDs.has(String(row.typeID)),
      `Landscape site ${siteID} has unknown type ${row.typeID}`,
    );
    assert(
      landscapeEcosystemIDs.has(Number(row.ecosystemID)),
      `Landscape site ${siteID} has unknown ecosystem ${row.ecosystemID}`,
    );
    assert(
      landscapeDungeonIDs.has(Number(row.dungeonID)),
      `Landscape site ${siteID} has unknown dungeon ${row.dungeonID}`,
    );
    assert(
      row.featureKind === "asteroidBelt" || row.featureKind === "trojan",
      `Landscape site ${siteID} has invalid feature kind ${row.featureKind}`,
    );
    assert(Number(row.dungeonID) > 0, `Landscape site ${siteID} has no dungeon`);
    assert(
      row.position && ["x", "y", "z"].every((axis) => Number.isFinite(Number(row.position[axis]))),
      `Landscape site ${siteID} has an invalid position`,
    );
  });
  assert(landscapeSites.count > 0, "Frontier landscape contains no sites");

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
    frontierDungeons: frontierDungeonIDs.size,
    groups: groups.count,
    landscapeDungeons: landscapeDungeonIDs.size,
    landscapeEcosystems: landscapeEcosystemIDs.size,
    stargates: stargates.count,
    landscapeSites: landscapeSiteIDs.size,
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
    `${checked.landscapeSites.toLocaleString()} landscape sites, ` +
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
