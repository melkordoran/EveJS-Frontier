#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  compileRunner,
  discoverBuilds,
  selectBuild,
} from "../frontier-static/extract-frontier-static.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "../..");
const DEFAULT_CLIENT_ROOT = path.join(
  os.homedir(),
  "Library",
  "Application Support",
  "EVE Frontier",
);
const OUTPUT_FORMAT = "evejs-frontier-contracts-v1";

const CLIENT_MODULE_PREFIXES = Object.freeze([
  "frontier/cairn/",
  "frontier/character/",
  "frontier/character_sheet/",
  "frontier/hud/scanner/",
  "frontier/industry/",
  "frontier/landscape/",
  "frontier/signatures_and_scanning/",
  "frontier/smart_assemblies/",
  "frontier/web3/",
  "experience/",
]);

function usage() {
  return [
    "Usage:",
    "  node tools/frontier-contracts/export-frontier-contracts.mjs [options]",
    "",
    "Options:",
    `  --client-root <path>  Frontier data root (default: ${DEFAULT_CLIENT_ROOT})`,
    "  --build <number>      Require a specific installed client build",
    "  --out <path>          Output directory (default: _local/frontier-contracts/<build>)",
    "  --force               Replace an exporter-owned snapshot",
    "  --dry-run             Resolve and verify code.ccp without exporting",
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

  if (
    options.build != null &&
    (!Number.isSafeInteger(options.build) || options.build <= 0)
  ) {
    throw new Error(`Invalid Frontier build: ${options.build}`);
  }
  return options;
}

function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

function commandResult(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(
      `${command} failed with status ${result.status}${detail ? `:\n${detail}` : ""}`,
    );
  }
  return result;
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

  const manifestPath = path.join(outDir, "frontier-contract-manifest.json");
  if (!fs.existsSync(manifestPath)) {
    throw new Error(
      `Refusing to replace a directory not owned by this exporter: ${outDir}`,
    );
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (manifest.format !== OUTPUT_FORMAT) {
    throw new Error(`Refusing to replace an unrecognized snapshot: ${outDir}`);
  }
  fs.rmSync(outDir, { recursive: true });
}

function outputMetadata(outDir, outputNames) {
  return Object.fromEntries(
    [...outputNames].sort().map((fileName) => {
      const filePath = path.join(outDir, fileName);
      if (!fs.existsSync(filePath)) {
        throw new Error(`Contract exporter did not produce ${fileName}`);
      }
      return [
        fileName,
        {
          bytes: fs.statSync(filePath).size,
          sha256: sha256File(filePath),
        },
      ];
    }),
  );
}

function isPublicProtoMember(memberName) {
  return memberName.startsWith("eveProto/generated/eve_public/") &&
    memberName.endsWith("_pb2.pyc");
}

function isInventoryMember(memberName) {
  return CLIENT_MODULE_PREFIXES.some((prefix) => memberName.startsWith(prefix)) &&
    memberName.endsWith(".pyc");
}

function main() {
  const options = parseArgs();
  if (options.help) {
    console.log(usage());
    return;
  }

  const selected = selectBuild(
    discoverBuilds(options.clientRoot),
    options.build,
  );
  const codePath = path.join(selected.buildRoot, "code.ccp");
  if (!fs.existsSync(codePath) || !fs.statSync(codePath).isFile()) {
    throw new Error(`Frontier code archive not found: ${codePath}`);
  }

  const outDir = options.outDir || path.join(
    REPO_ROOT,
    "_local",
    "frontier-contracts",
    String(selected.build),
  );
  console.log(
    `[frontier-contracts] build=${selected.build} channel=${selected.channel}`,
  );
  console.log(`[frontier-contracts] source=${codePath}`);
  console.log(`[frontier-contracts] output=${outDir}`);
  if (options.dryRun) {
    console.log("[frontier-contracts] Inputs verified; dry run complete.");
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
  const requestPath = path.join(toolsRoot, "contract-export-request.json");
  fs.writeFileSync(
    requestPath,
    `${JSON.stringify({
      build: selected.build,
      codePath,
      clientModulePrefixes: CLIENT_MODULE_PREFIXES,
    }, null, 2)}\n`,
    "utf8",
  );

  const pythonPath = [
    codePath,
    path.join(selected.buildRoot, "bin64"),
  ].join(path.delimiter);
  const result = commandResult(
    runner,
    [
      path.join(SCRIPT_DIR, "dump_frontier_contracts.py"),
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
  const reportLines = result.stdout.trim().split(/\r?\n/).filter(Boolean);
  const report = JSON.parse(reportLines.at(-1));
  const outputs = outputMetadata(workDir, report.outputs);
  const manifest = {
    format: OUTPUT_FORMAT,
    generatedAt: new Date().toISOString(),
    source: {
      appName: selected.startIni["main.appname"],
      branch: selected.startIni["main.branch"],
      build: selected.build,
      channel: selected.channel,
      codeArchive: {
        bytes: fs.statSync(codePath).size,
        sha256: sha256File(codePath),
      },
      version: selected.startIni["main.version"],
    },
    summary: report.summary,
    outputs,
  };
  fs.writeFileSync(
    path.join(workDir, "frontier-contract-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  fs.renameSync(workDir, outDir);
  console.log(
    `[frontier-contracts] Exported ${report.summary.descriptorFiles} protobuf files ` +
      `and indexed ${report.summary.clientModules} client modules.`,
  );
  console.log(
    `[frontier-contracts] Manifest: ${path.join(outDir, "frontier-contract-manifest.json")}`,
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    main();
  } catch (error) {
    console.error(`[frontier-contracts] ${error.message}`);
    process.exitCode = 1;
  }
}

export {
  CLIENT_MODULE_PREFIXES,
  isInventoryMember,
  isPublicProtoMember,
  parseArgs,
};
