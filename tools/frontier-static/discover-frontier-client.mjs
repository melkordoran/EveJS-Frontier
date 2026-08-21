#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  discoverFrontierClients,
  publicClientRecord,
  selectBuild,
} from "./lib/frontier-client-discovery.mjs";

function usage() {
  return [
    "Usage:",
    "  node tools/frontier-static/discover-frontier-client.mjs [options]",
    "",
    "Options:",
    "  --client-root <path>  Explicit launcher/cache root or build directory",
    "  --build <number>      Require a specific installed Frontier build",
    "  --json                Emit one machine-readable JSON object",
    "  -h, --help            Show this help",
  ].join("\n");
}

function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    build: null,
    clientRoot: null,
    json: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--client-root") {
      const value = argv[++index];
      if (!value) {
        throw new Error("--client-root requires a path");
      }
      options.clientRoot = path.resolve(value);
    } else if (argument === "--build") {
      const value = argv[++index];
      if (!/^\d+$/.test(String(value || ""))) {
        throw new Error(`Invalid Frontier build: ${value || "(missing)"}`);
      }
      options.build = Number(value);
    } else if (argument === "--json") {
      options.json = true;
    } else if (argument === "--help" || argument === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return options;
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(usage());
    return null;
  }
  const selected = selectBuild(
    discoverFrontierClients({ clientRoot: options.clientRoot }),
    options.build,
  );
  const record = publicClientRecord(selected);
  if (options.json) {
    console.log(JSON.stringify(record));
  } else {
    console.log(
      `[frontier-client] build=${record.metadata.build} sync=${record.metadata.sync ?? "unknown"} ` +
        `version=${record.metadata.version ?? "unknown"} channel=${record.channel}`,
    );
    console.log(
      `[frontier-client] branch=${record.metadata.branch ?? "unknown"} ` +
        `codename=${record.metadata.codename ?? "unknown"} ` +
        `region=${record.metadata.region ?? "unknown"}`,
    );
    console.log(`[frontier-client] root=${record.buildRoot}`);
    console.log(
      `[frontier-client] native-blue=${record.nativeBlueName} resfiles=${record.resFilesRoot}`,
    );
  }
  return record;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    main();
  } catch (error) {
    console.error(`[frontier-client] ${error.message}`);
    process.exitCode = 1;
  }
}

export { main, parseArgs, usage };
