#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  readResourceIndex,
  resolveIndexedResource,
} from "./lib/resource-index.mjs";
import { readStartIni } from "./lib/start-ini.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "../..");
const DEFAULT_CLIENT_ROOT = path.join(
  os.homedir(),
  "Library",
  "Application Support",
  "EVE Frontier",
);

const REQUIRED_RESOURCES = {
  agentTypes: "res:/staticdata/agenttypes.fsdbinary",
  bloodlines: "res:/staticdata/bloodlines.fsdbinary",
  categories: "res:/staticdata/categories.fsdbinary",
  constellations: "res:/staticdata/constellations.static",
  constellationsSchema: "res:/staticdata/constellations.schema",
  dogmaAttributes: "res:/staticdata/dogmaattributes.fsdbinary",
  dogmaEffects: "res:/staticdata/dogmaeffects.fsdbinary",
  factions: "res:/staticdata/factions.fsdbinary",
  groups: "res:/staticdata/groups.fsdbinary",
  jumps: "res:/staticdata/jumps.static",
  jumpsSchema: "res:/staticdata/jumps.schema",
  localization: "res:/localizationfsd/localization_fsd_en-us.pickle",
  locationCache: "res:/staticdata/locationcache.static",
  npcCharacters: "res:/staticdata/npccharacters.fsdbinary",
  npcCorporations: "res:/staticdata/npccorporations.fsdbinary",
  races: "res:/staticdata/races.fsdbinary",
  regions: "res:/staticdata/regions.static",
  regionsSchema: "res:/staticdata/regions.schema",
  solarSystemContent: "res:/staticdata/solarsystemcontent.static",
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
    `  --client-root <path>  Frontier data root (default: ${DEFAULT_CLIENT_ROOT})`,
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
    clientRoot: DEFAULT_CLIENT_ROOT,
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

function discoverBuilds(clientRoot) {
  const sharedCacheRoot = path.join(clientRoot, "SharedCache");
  if (!fs.existsSync(sharedCacheRoot) || !fs.statSync(sharedCacheRoot).isDirectory()) {
    throw new Error(`Frontier SharedCache not found: ${sharedCacheRoot}`);
  }

  const candidates = [];
  for (const entry of fs.readdirSync(sharedCacheRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) {
      continue;
    }
    const buildRoot = path.join(
      sharedCacheRoot,
      entry.name,
      "EVE.app",
      "Contents",
      "Resources",
      "build",
    );
    const startIniPath = path.join(buildRoot, "start.ini");
    if (!fs.existsSync(startIniPath)) {
      continue;
    }
    const startIni = readStartIni(startIniPath);
    const build = Number(startIni["main.build"]);
    if (!Number.isSafeInteger(build) || build <= 0) {
      continue;
    }
    candidates.push({
      build,
      buildRoot,
      channel: entry.name,
      sharedCacheRoot,
      startIni,
      startIniPath,
    });
  }

  if (candidates.length === 0) {
    throw new Error(`No installed Frontier client builds found under ${sharedCacheRoot}`);
  }
  return candidates.sort((left, right) => right.build - left.build);
}

function selectBuild(candidates, requestedBuild) {
  if (requestedBuild == null) {
    return candidates[0];
  }
  const selected = candidates.find((candidate) => candidate.build === requestedBuild);
  if (!selected) {
    const available = candidates.map((candidate) => candidate.build).join(", ");
    throw new Error(
      `Frontier build ${requestedBuild} is not installed. Available builds: ${available}`,
    );
  }
  return selected;
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

function locateClang() {
  const result = spawnSync("xcrun", ["--find", "clang"], { encoding: "utf8" });
  if (!result.error && result.status === 0 && result.stdout.trim()) {
    return result.stdout.trim();
  }
  return "clang";
}

function locateMacOsSdk() {
  const result = commandResult("xcrun", ["--sdk", "macosx", "--show-sdk-path"]);
  const sdkPath = result.stdout.trim();
  if (!sdkPath) {
    throw new Error("xcrun did not return a macOS SDK path");
  }
  return sdkPath;
}

function compileRunner(buildRoot, toolsRoot) {
  const libDir = path.join(buildRoot, "bin64");
  const libPython = path.join(libDir, "libpython3.12.dylib");
  if (!fs.existsSync(libPython)) {
    throw new Error(`Frontier embedded Python library not found: ${libPython}`);
  }

  fs.mkdirSync(toolsRoot, { recursive: true });
  const sourcePath = path.join(SCRIPT_DIR, "frontier-python-runner.c");
  const runnerPath = path.join(toolsRoot, "frontier-python312-runner");
  const needsBuild = !fs.existsSync(runnerPath) ||
    fs.statSync(runnerPath).mtimeMs < fs.statSync(sourcePath).mtimeMs ||
    fs.statSync(runnerPath).mtimeMs < fs.statSync(libPython).mtimeMs;
  if (!needsBuild) {
    return runnerPath;
  }

  const clang = locateClang();
  const sdkPath = locateMacOsSdk();
  commandResult(clang, [
    "-std=c11",
    "-Wall",
    "-Wextra",
    "-isysroot",
    sdkPath,
    sourcePath,
    "-L",
    libDir,
    "-lpython3.12",
    `-Wl,-rpath,${libDir}`,
    "-o",
    runnerPath,
  ]);
  fs.chmodSync(runnerPath, 0o755);
  return runnerPath;
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
  const indexPath = path.join(selected.buildRoot, "resfileindex.txt");
  const entries = readResourceIndex(indexPath);
  const resFilesRoot = path.join(selected.sharedCacheRoot, "ResFiles");
  const resources = {};

  for (const [key, logicalPath] of Object.entries(REQUIRED_RESOURCES)) {
    resources[key] = resolveIndexedResource(entries, logicalPath, resFilesRoot);
  }

  const mapObjectsPath = path.join(
    selected.buildRoot,
    "bin64",
    "staticdata",
    "mapObjects.db",
  );
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
      clientRoot,
      codename: main["main.codename"],
      machoVersion: null,
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

  const candidates = discoverBuilds(options.clientRoot);
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
  const runner = compileRunner(selected.buildRoot, toolsRoot);
  const requestPath = path.join(toolsRoot, "extraction-request.json");
  fs.writeFileSync(requestPath, `${JSON.stringify(request, null, 2)}\n`, "utf8");

  const pythonPath = [
    path.join(selected.buildRoot, "code.ccp"),
    path.join(selected.buildRoot, "bin64"),
  ].join(path.delimiter);
  const result = commandResult(
    runner,
    [
      path.join(SCRIPT_DIR, "dump_frontier_static.py"),
      "--request",
      requestPath,
      "--out",
      workDir,
    ],
    {
      env: {
        ...process.env,
        PYTHONPATH: pythonPath,
      },
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
