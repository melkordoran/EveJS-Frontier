import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  discoverFrontierClients,
  likelyClientRoots,
  selectBuild,
} from "../lib/frontier-client-discovery.mjs";

const DISCOVERY_CLI = path.resolve(
  "tools",
  "frontier-static",
  "discover-frontier-client.mjs",
);

function writeFile(filePath, contents = "fixture") {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
}

function populateBuild(buildRoot, {
  build,
  platform,
  sync = build,
  blueName = platform === "windows" ? "blue.pyd" : "blue.so",
} = {}) {
  writeFile(path.join(buildRoot, "start.ini"), [
    "[main]",
    "version = 20.04",
    `build = ${build}`,
    "codename = cycle-6",
    "region = ccp",
    `sync = ${sync}`,
    "branch = //frontier/cycle-6",
    "appname = FRONTIER",
    "",
  ].join("\n"));
  for (const relativePath of [
    "code.ccp",
    "manifest.dat",
    "resfileindex.txt",
    path.join("bin64", "staticdata", "mapObjects.db"),
    path.join("bin64", "cacert.pem"),
    path.join("bin64", "packages", "certifi", "cacert.pem"),
    path.join("bin64", blueName),
    platform === "windows"
      ? path.join("bin64", "exefile.exe")
      : path.join("bin64", "exefile"),
  ]) {
    writeFile(path.join(buildRoot, relativePath));
  }
}

function makeWindowsFixture(root, channel, build, options = {}) {
  fs.mkdirSync(path.join(root, "ResFiles"), { recursive: true });
  const buildRoot = path.join(root, channel);
  populateBuild(buildRoot, { build, platform: "windows", ...options });
  return buildRoot;
}

function makeMacFixture(root, channel, build) {
  const cacheRoot = path.join(root, "SharedCache");
  fs.mkdirSync(path.join(cacheRoot, "ResFiles"), { recursive: true });
  const buildRoot = path.join(
    cacheRoot,
    channel,
    "EVE.app",
    "Contents",
    "Resources",
    "build",
  );
  populateBuild(buildRoot, { build, platform: "macos" });
  return buildRoot;
}

test("discovers the Windows channel layout and records exact metadata", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "Frontier Client With Spaces "));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const buildRoot = makeWindowsFixture(root, "stillness", 3474408);

  const candidates = discoverFrontierClients({ clientRoot: root });
  assert.equal(candidates.length, 1);
  const selected = selectBuild(candidates);
  assert.equal(selected.build, 3474408);
  assert.equal(selected.metadata.sync, 3474408);
  assert.equal(selected.metadata.version, "20.04");
  assert.equal(selected.metadata.branch, "//frontier/cycle-6");
  assert.equal(selected.metadata.codename, "cycle-6");
  assert.equal(selected.metadata.region, "ccp");
  assert.equal(selected.nativeBlueName, "blue.pyd");
  assert.equal(selected.buildRoot, fs.realpathSync.native(buildRoot));
  assert.equal(selected.resFilesRoot, fs.realpathSync.native(path.join(root, "ResFiles")));
});

test("accepts an explicit Windows build directory with sibling ResFiles", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "frontier-direct-build-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const buildRoot = makeWindowsFixture(root, "stillness", 3474408, {
    blueName: "blue.dll",
  });

  const [selected] = discoverFrontierClients({ clientRoot: buildRoot });
  assert.equal(selected.channel, "stillness");
  assert.equal(selected.nativeBlueName, "blue.dll");
  assert.equal(selected.clientRoot, fs.realpathSync.native(root));
});

test("preserves discovery of the existing macOS SharedCache app layout", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "frontier-macos-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const buildRoot = makeMacFixture(root, "stillness", 3467658);

  const [selected] = discoverFrontierClients({ clientRoot: root });
  assert.equal(selected.platform, "macos");
  assert.equal(selected.layout, "macos-app");
  assert.equal(selected.nativeBlueName, "blue.so");
  assert.equal(selected.buildRoot, fs.realpathSync.native(buildRoot));
});

test("selects a unique newest build and rejects an equal-highest ambiguity", (t) => {
  const firstRoot = fs.mkdtempSync(path.join(os.tmpdir(), "frontier-first-"));
  const secondRoot = fs.mkdtempSync(path.join(os.tmpdir(), "frontier-second-"));
  t.after(() => {
    fs.rmSync(firstRoot, { recursive: true, force: true });
    fs.rmSync(secondRoot, { recursive: true, force: true });
  });
  makeWindowsFixture(firstRoot, "stillness", 3474408);
  makeWindowsFixture(firstRoot, "legacy", 3467658);
  assert.equal(
    selectBuild(discoverFrontierClients({ clientRoot: firstRoot })).build,
    3474408,
  );

  makeWindowsFixture(secondRoot, "stillness", 3474408);
  const ambiguous = discoverFrontierClients({ roots: [firstRoot, secondRoot] });
  assert.throws(() => selectBuild(ambiguous), /ambiguous across equally ranked installs/);
  assert.throws(
    () => selectBuild(ambiguous, 3474408),
    /ambiguous across equally ranked installs/,
  );
});

test("rejects incomplete clients and multiple native blue binaries", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "frontier-invalid-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const buildRoot = makeWindowsFixture(root, "stillness", 3474408);
  fs.rmSync(path.join(buildRoot, "manifest.dat"));
  assert.throws(
    () => discoverFrontierClients({ clientRoot: root }),
    /manifest not found/,
  );

  writeFile(path.join(buildRoot, "manifest.dat"));
  writeFile(path.join(buildRoot, "bin64", "blue.dll"));
  assert.throws(
    () => discoverFrontierClients({ clientRoot: root }),
    /exactly one Frontier native blue binary/,
  );
});

test("likely Windows roots include the machine-wide CCP cache location", () => {
  const roots = likelyClientRoots({
    platform: "win32",
    env: { SystemDrive: "Z:" },
    homeDirectory: path.resolve("fixture-home"),
  });
  assert.equal(
    roots.some((candidate) => candidate.toLowerCase().includes("ccp") &&
      candidate.toLowerCase().includes("eve frontier")),
    true,
  );
});

test("discovery CLI emits JSON for a path containing spaces", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "Frontier CLI With Spaces "));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  makeWindowsFixture(root, "stillness", 3474408);

  const result = spawnSync(
    process.execPath,
    [DISCOVERY_CLI, "--client-root", root, "--build", "3474408", "--json"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const record = JSON.parse(result.stdout);
  assert.equal(record.metadata.build, 3474408);
  assert.equal(record.nativeBlueName, "blue.pyd");
  assert.equal(record.buildRoot.includes(" "), true);
});
