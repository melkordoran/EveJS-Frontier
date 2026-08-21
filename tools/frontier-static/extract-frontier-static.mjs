#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  readResourceIndex,
  resolveIndexedResource,
} from "./lib/resource-index.mjs";
import {
  discoverFrontierClients,
  selectBuild,
} from "./lib/frontier-client-discovery.mjs";
import {
  buildPythonInvocation,
  resolveFrontierPython,
} from "./lib/frontier-python.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "../..");

const REQUIRED_RESOURCES = {
  agentTypes: "res:/staticdata/agenttypes.fsdbinary",
  bloodlines: "res:/staticdata/bloodlines.fsdbinary",
  categories: "res:/staticdata/categories.fsdbinary",
  creationHardpointTypes: "res:/staticdata/creation_hardpoint_types.fsdbinary",
  creationModules: "res:/staticdata/creation_modules.fsdbinary",
  creationParts: "res:/staticdata/creation_parts.fsdbinary",
  creationTemplates: "res:/staticdata/creation_templates.fsdbinary",
  constellations: "res:/staticdata/constellations.static",
  constellationsSchema: "res:/staticdata/constellations.schema",
  dogmaAttributes: "res:/staticdata/dogmaattributes.fsdbinary",
  dogmaEffects: "res:/staticdata/dogmaeffects.fsdbinary",
  dungeons: "res:/staticdata/dungeons.fsdbinary",
  ecosystems: "res:/staticdata/ecosystem.fsdbinary",
  factions: "res:/staticdata/factions.fsdbinary",
  groups: "res:/staticdata/groups.fsdbinary",
  jumps: "res:/staticdata/jumps.static",
  jumpsSchema: "res:/staticdata/jumps.schema",
  landscapes: "res:/staticdata/landscape.fsdbinary",
  localization: "res:/localizationfsd/localization_fsd_en-us.pickle",
  locationCache: "res:/staticdata/locationcache.static",
  npcCharacters: "res:/staticdata/npccharacters.fsdbinary",
  npcCorporations: "res:/staticdata/npccorporations.fsdbinary",
  races: "res:/staticdata/races.fsdbinary",
  regions: "res:/staticdata/regions.static",
  regionsSchema: "res:/staticdata/regions.schema",
  solarSystemContent: "res:/staticdata/solarsystemcontent.static",
  spaceComponentsByType: "res:/staticdata/spacecomponentsbytype.fsdbinary",
  stationOperations: "res:/staticdata/stationoperations.fsdbinary",
  systems: "res:/staticdata/systems.static",
  systemsSchema: "res:/staticdata/systems.schema",
  typeDogma: "res:/staticdata/typedogma.fsdbinary",
  typeMaterials: "res:/staticdata/typematerials.fsdbinary",
  types: "res:/staticdata/types.fsdbinary",
};

function usage() {
  return [
    "Usage:",
    "  node tools/frontier-static/extract-frontier-static.mjs [options]",
    "",
    "Options:",
    "  --client-root <path>  Explicit launcher/cache root or build directory",
    "  --build <number>      Require a specific installed client build",
    "  --out <path>          Output directory (default: _local/frontier-sde/<build>)",
    "  --force               Replace a previous extractor-owned snapshot",
    "  --dry-run             Resolve and verify inputs without extracting",
    "  -h, --help            Show this help",
  ].join("\n");
}

function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    build: null,
    clientRoot: null,
    dryRun: false,
    force: false,
    outDir: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--client-root") {
      options.clientRoot = path.resolve(argv[++index] || "");
    } else if (argument === "--build") {
      options.build = Number(argv[++index]);
    } else if (argument === "--out") {
      options.outDir = path.resolve(argv[++index] || "");
    } else if (argument === "--force") {
      options.force = true;
    } else if (argument === "--dry-run") {
      options.dryRun = true;
    } else if (argument === "--help" || argument === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }

  if (options.build != null &&
      (!Number.isSafeInteger(options.build) || options.build <= 0)) {
    throw new Error(`Invalid Frontier build: ${options.build}`);
  }
  return options;
}

function commandResult(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(`${command} failed with status ${result.status}${detail ? `:\n${detail}` : ""}`);
  }
  return result;
}

// Preserve the extractor's existing public helper signature for downstream tools.
function discoverBuilds(clientRoot) {
  return discoverFrontierClients({ clientRoot });
}

function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

function prepareDestination(outDir, force) {
  if (!fs.existsSync(outDir)) {
    return;
  }
  const entries = fs.readdirSync(outDir);
  if (entries.length === 0) {
    fs.rmSync(outDir, { recursive: true });
    return;
  }
  if (!force) {
    throw new Error(`Output directory is not empty. Re-run with --force: ${outDir}`);
  }

  const manifestPath = path.join(outDir, "frontier-extraction-manifest.json");
  if (!fs.existsSync(manifestPath)) {
    throw new Error(
      `Refusing to replace a directory not owned by this extractor: ${outDir}`,
    );
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (manifest.format !== "evejs-frontier-static-v1") {
    throw new Error(`Refusing to replace an unrecognized snapshot: ${outDir}`);
  }
  fs.rmSync(outDir, { recursive: true });
}

function buildRequest(selected, clientRoot) {
  const indexPath = selected.files.resourceIndex;
  const entries = readResourceIndex(indexPath);
  const resFilesRoot = selected.resFilesRoot;
  const resources = {};

  for (const [key, logicalPath] of Object.entries(REQUIRED_RESOURCES)) {
    resources[key] = resolveIndexedResource(entries, logicalPath, resFilesRoot);
  }

  const mapObjectsPath = selected.files.mapObjects;
  if (!fs.existsSync(mapObjectsPath) || !fs.statSync(mapObjectsPath).isFile()) {
    throw new Error(`Frontier mapObjects database not found: ${mapObjectsPath}`);
  }

  const main = selected.startIni;
  if (String(main["main.appname"] || "").toUpperCase() !== "FRONTIER") {
    throw new Error(`Selected client is not EVE Frontier: ${selected.startIniPath}`);
  }

  return {
    client: {
      appName: main["main.appname"],
      branch: main["main.branch"],
      build: selected.build,
      channel: selected.channel,
      clientRoot: clientRoot || selected.clientRoot,
      codename: main["main.codename"],
      machoVersion: null,
      nativeBlueName: selected.nativeBlueName,
      region: main["main.region"],
      sync: selected.metadata.sync,
      version: main["main.version"],
    },
    index: {
      entryCount: entries.size,
      path: indexPath,
      sha256: sha256File(indexPath),
    },
    mapObjectsDb: {
      physicalPath: mapObjectsPath,
      sha256: sha256File(mapObjectsPath),
      size: fs.statSync(mapObjectsPath).size,
    },
    resources,
  };
}

function publicSourceRequest(request) {
  return {
    client: {
      appName: request.client.appName,
      branch: request.client.branch,
      build: request.client.build,
      channel: request.client.channel,
      codename: request.client.codename,
      nativeBlueName: request.client.nativeBlueName,
      region: request.client.region,
      sync: request.client.sync,
      version: request.client.version,
    },
    index: {
      entryCount: request.index.entryCount,
      sha256: request.index.sha256,
    },
    mapObjectsDb: {
      sha256: request.mapObjectsDb.sha256,
      size: request.mapObjectsDb.size,
    },
    resources: Object.fromEntries(
      Object.entries(request.resources).map(([key, value]) => [
        key,
        {
          cachePath: value.cachePath,
          logicalPath: value.logicalPath,
          packedSize: value.packedSize,
          sourceHash: value.sourceHash,
          unpackedSize: value.unpackedSize,
        },
      ]),
    ),
  };
}

function outputMetadata(outDir, outputCounts) {
  const outputs = {};
  for (const [fileName, count] of Object.entries(outputCounts).sort()) {
    const filePath = path.join(outDir, fileName);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Extractor did not produce declared output: ${fileName}`);
    }
    outputs[fileName] = {
      bytes: fs.statSync(filePath).size,
      records: count,
      sha256: sha256File(filePath),
    };
  }
  return outputs;
}

function main() {
  const options = parseArgs();
  if (options.help) {
    console.log(usage());
    return;
  }

  const candidates = discoverFrontierClients({ clientRoot: options.clientRoot });
  const selected = selectBuild(candidates, options.build);
  const request = buildRequest(selected, options.clientRoot);
  const outDir = options.outDir ||
    path.join(REPO_ROOT, "_local", "frontier-sde", String(selected.build));

  console.log(
    `[frontier-static] build=${selected.build} channel=${selected.channel} ` +
    `resources=${Object.keys(request.resources).length}`,
  );
  console.log(`[frontier-static] output=${outDir}`);
  if (options.dryRun) {
    console.log("[frontier-static] Inputs verified; dry run complete.");
    return;
  }

  prepareDestination(outDir, options.force);
  fs.mkdirSync(path.dirname(outDir), { recursive: true });
  const workDir = `${outDir}.tmp-${process.pid}`;
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.mkdirSync(workDir, { recursive: true });

  const toolsRoot = path.join(
    REPO_ROOT,
    "_local",
    "frontier-tools",
    String(selected.build),
  );
  fs.mkdirSync(toolsRoot, { recursive: true });
  const runner = resolveFrontierPython(selected.buildRoot, toolsRoot, {
    requiredImports: ["typesLoader"],
  });
  const requestPath = path.join(toolsRoot, "extraction-request.json");
  fs.writeFileSync(requestPath, `${JSON.stringify(request, null, 2)}\n`, "utf8");

  const invocation = buildPythonInvocation(
    runner,
    path.join(SCRIPT_DIR, "dump_frontier_static.py"),
    ["--request", requestPath, "--out", workDir],
  );
  const result = commandResult(
    invocation.command,
    invocation.args,
    {
      env: invocation.env,
    },
  );
  const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean);
  const report = JSON.parse(lines.at(-1));
  const outputs = outputMetadata(workDir, report.outputs);
  const manifest = {
    format: "evejs-frontier-static-v1",
    generatedAt: new Date().toISOString(),
    localization: {
      language: report.localizationLanguage,
      messages: report.localizationMessages,
    },
    outputs,
    source: publicSourceRequest(request),
    totals: {
      bytes: Object.values(outputs).reduce((sum, entry) => sum + entry.bytes, 0),
      records: Object.values(outputs).reduce((sum, entry) => sum + entry.records, 0),
    },
  };
  fs.writeFileSync(
    path.join(workDir, "frontier-extraction-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  fs.renameSync(workDir, outDir);
  console.log(
    `[frontier-static] Extracted ${manifest.totals.records.toLocaleString()} records ` +
    `across ${Object.keys(outputs).length} files.`,
  );
  console.log(
    `[frontier-static] Manifest: ${path.join(outDir, "frontier-extraction-manifest.json")}`,
  );
}

if (process.argv[1] &&
    path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`[frontier-static] ${error.message}`);
    process.exitCode = 1;
  }
}

export {
  REQUIRED_RESOURCES,
  discoverBuilds,
  parseArgs,
  selectBuild,
};
