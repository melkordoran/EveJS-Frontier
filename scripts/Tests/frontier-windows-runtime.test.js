"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const POWERSHELL = "pwsh";
const probe = process.platform === "win32"
  ? spawnSync(POWERSHELL, ["-NoLogo", "-NoProfile", "-Command", "exit 0"])
  : { status: 1 };
const canRunPowerShell = process.platform === "win32" &&
  !probe.error && probe.status === 0;

function runScript(script, args) {
  return spawnSync(
    POWERSHELL,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", script, ...args],
    { encoding: "utf8" },
  );
}

function listen(server, port = 0) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

test(
  "Windows runtime initialization and reset require an exact owned marker",
  { skip: !canRunPowerShell },
  async (t) => {
    const fixtureRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "evejs frontier runtime "),
    );
    t.after(() => fs.rmSync(fixtureRoot, { force: true, recursive: true }));

    const startScript = path.join(fixtureRoot, "StartFrontierServer.ps1");
    const stopScript = path.join(fixtureRoot, "StopFrontier.ps1");
    const portReservation = net.createServer();
    await listen(portReservation);
    const resetGuardPort = portReservation.address().port;
    await close(portReservation);
    const startSource = fs.readFileSync(
      path.join(REPO_ROOT, "StartFrontierServer.ps1"),
      "utf8",
    );
    const defaultPorts = "@(26000, 26101, 26102, 26103, 5222, 26401)";
    assert.equal(
      startSource.includes(defaultPorts),
      true,
      "runtime script required-port declaration changed unexpectedly",
    );
    fs.writeFileSync(
      startScript,
      startSource.replace(defaultPorts, `@(${resetGuardPort})`),
    );
    fs.copyFileSync(path.join(REPO_ROOT, "StopFrontier.ps1"), stopScript);
    const commonModuleRelative = path.join(
      "tools",
      "frontier-client",
      "FrontierWindows.Common.psm1",
    );
    const commonModule = path.join(fixtureRoot, commonModuleRelative);
    fs.mkdirSync(path.dirname(commonModule), { recursive: true });
    fs.copyFileSync(path.join(REPO_ROOT, commonModuleRelative), commonModule);

    const build = "9994408";
    const generatedRoot = path.join(
      fixtureRoot,
      "_local",
      "frontier-gameStore",
      build,
    );
    const generatedData = path.join(generatedRoot, "data", "exampleTable");
    const staticRoot = path.join(
      fixtureRoot,
      "_local",
      "frontier-sde",
      build,
    );
    fs.mkdirSync(generatedData, { recursive: true });
    fs.mkdirSync(staticRoot, { recursive: true });
    fs.writeFileSync(path.join(generatedData, "data.json"), "[]\n");
    fs.writeFileSync(path.join(generatedRoot, "manifest.json"), "{}\n");

    const dryRun = runScript(startScript, [
      "-Build",
      build,
      "-InitializeOnly",
      "-DryRun",
    ]);
    assert.equal(dryRun.status, 0, dryRun.stderr || dryRun.stdout);
    assert.match(dryRun.stdout, /would initialize/);

    const runtimeRoot = path.join(
      fixtureRoot,
      "_local",
      "frontier-runtime",
      build,
    );
    assert.equal(fs.existsSync(runtimeRoot), false);

    const initialize = runScript(startScript, [
      "-Build",
      build,
      "-InitializeOnly",
    ]);
    assert.equal(initialize.status, 0, initialize.stderr || initialize.stdout);

    const markerPath = path.join(runtimeRoot, ".evejs-frontier-runtime");
    const marker = JSON.parse(fs.readFileSync(markerPath, "utf8"));
    assert.equal(marker.kind, "evejs-frontier-runtime");
    assert.equal(marker.build, build);
    assert.equal(path.resolve(marker.runtimeRoot), path.resolve(runtimeRoot));
    assert.equal(
      fs.existsSync(
        path.join(runtimeRoot, "gameStore", "data", "exampleTable", "data.json"),
      ),
      true,
    );

    const status = runScript(startScript, ["-Build", build, "-Status"]);
    assert.equal(status.status, 0, status.stderr || status.stdout);
    assert.match(status.stdout, /Runtime: initialized/);
    assert.match(status.stdout, /Background process: not running/);

    const externalNested = fs.mkdtempSync(
      path.join(os.tmpdir(), "evejs frontier runtime external "),
    );
    t.after(() => fs.rmSync(externalNested, { force: true, recursive: true }));
    const nestedJunction = path.join(runtimeRoot, "gameStore", "data", "escape");
    fs.symlinkSync(externalNested, nestedJunction, "junction");
    const refusedReuse = runScript(startScript, [
      "-Build",
      build,
      "-InitializeOnly",
    ]);
    assert.notEqual(refusedReuse.status, 0);
    assert.match(
      `${refusedReuse.stderr}\n${refusedReuse.stdout}`,
      /nested reparse point/i,
    );
    fs.rmSync(nestedJunction, { force: true });

    const sentinel = path.join(runtimeRoot, "user-state.sentinel");
    fs.writeFileSync(sentinel, "preserve\n");
    const resetDryRun = runScript(startScript, [
      "-Build",
      build,
      "-ResetRuntime",
      "-InitializeOnly",
      "-DryRun",
    ]);
    assert.equal(
      resetDryRun.status,
      0,
      resetDryRun.stderr || resetDryRun.stdout,
    );
    assert.match(resetDryRun.stdout, /would reset/);
    assert.equal(fs.existsSync(sentinel), true);

    const activeListener = net.createServer();
    await listen(activeListener, resetGuardPort);
    const refusedLiveReset = runScript(startScript, [
      "-Build",
      build,
      "-ResetRuntime",
      "-InitializeOnly",
    ]);
    assert.notEqual(refusedLiveReset.status, 0);
    assert.match(
      `${refusedLiveReset.stderr}\n${refusedLiveReset.stdout}`,
      /required Frontier port\(s\) have listeners/i,
    );
    assert.equal(fs.existsSync(sentinel), true);
    await close(activeListener);

    const validMarkerText = fs.readFileSync(markerPath, "utf8");
    fs.writeFileSync(markerPath, "{}\n");
    const refusedReset = runScript(startScript, [
      "-Build",
      build,
      "-ResetRuntime",
      "-InitializeOnly",
    ]);
    assert.notEqual(refusedReset.status, 0);
    assert.equal(fs.existsSync(sentinel), true);

    fs.writeFileSync(markerPath, validMarkerText);
    const acceptedReset = runScript(startScript, [
      "-Build",
      build,
      "-ResetRuntime",
      "-InitializeOnly",
    ]);
    assert.equal(acceptedReset.status, 0, acceptedReset.stderr || acceptedReset.stdout);
    assert.equal(fs.existsSync(sentinel), false);
    assert.equal(
      fs.existsSync(
        path.join(runtimeRoot, "gameStore", "data", "exampleTable", "data.json"),
      ),
      true,
    );

    const stopStatus = runScript(stopScript, ["-Build", build, "-Status"]);
    assert.equal(stopStatus.status, 0, stopStatus.stderr || stopStatus.stdout);
    assert.match(stopStatus.stdout, /Background process: not running/);

    const pidMarkerPath = path.join(
      runtimeRoot,
      ".evejs-frontier-server.pid.json",
    );
    fs.writeFileSync(
      pidMarkerPath,
      `${JSON.stringify({
        kind: "evejs-frontier-server-process",
        schemaVersion: 1,
        build,
        runtimeRoot,
        pid: 2147483647,
        processStartTimeUtcTicks: 1,
        nodePath: path.join(fixtureRoot, "node.exe"),
        serverEntry: path.join(fixtureRoot, "server", "index.js"),
      })}\n`,
    );
    const staleStatus = runScript(stopScript, ["-Build", build, "-Status"]);
    assert.equal(staleStatus.status, 0, staleStatus.stderr || staleStatus.stdout);
    assert.match(staleStatus.stdout, /stale marker/);
    const stopDryRun = runScript(stopScript, ["-Build", build, "-DryRun"]);
    assert.equal(stopDryRun.status, 0, stopDryRun.stderr || stopDryRun.stdout);
    assert.match(stopDryRun.stdout, /would remove stale PID marker/);
    assert.equal(fs.existsSync(pidMarkerPath), true);
    const clearStale = runScript(stopScript, ["-Build", build]);
    assert.equal(clearStale.status, 0, clearStale.stderr || clearStale.stdout);
    assert.match(clearStale.stdout, /Removed stale PID marker/);
    assert.equal(fs.existsSync(pidMarkerPath), false);
  },
);

test(
  "Windows runtime initialization rejects a reparse-point ancestor",
  { skip: !canRunPowerShell },
  (t) => {
    const fixtureRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "evejs frontier runtime ancestor "),
    );
    const externalRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "evejs frontier runtime target "),
    );
    t.after(() => fs.rmSync(fixtureRoot, { force: true, recursive: true }));
    t.after(() => fs.rmSync(externalRoot, { force: true, recursive: true }));

    const startScript = path.join(fixtureRoot, "StartFrontierServer.ps1");
    fs.copyFileSync(path.join(REPO_ROOT, "StartFrontierServer.ps1"), startScript);
    const build = "9994409";
    const generatedRoot = path.join(
      fixtureRoot,
      "_local",
      "frontier-gameStore",
      build,
    );
    fs.mkdirSync(path.join(generatedRoot, "data"), { recursive: true });
    fs.writeFileSync(path.join(generatedRoot, "manifest.json"), "{}\n");
    fs.mkdirSync(
      path.join(fixtureRoot, "_local", "frontier-sde", build),
      { recursive: true },
    );
    const runtimeBase = path.join(fixtureRoot, "_local", "frontier-runtime");
    fs.symlinkSync(externalRoot, runtimeBase, "junction");

    const refused = runScript(startScript, [
      "-Build",
      build,
      "-InitializeOnly",
    ]);
    assert.notEqual(refused.status, 0);
    assert.match(
      `${refused.stderr}\n${refused.stdout}`,
      /reparse-point path component/i,
    );
    assert.equal(fs.existsSync(path.join(externalRoot, build)), false);
  },
);

test(
  "Windows background startup rolls back its exact child before PID publication",
  { skip: !canRunPowerShell },
  async (t) => {
    const fixtureRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "evejs frontier background rollback "),
    );
    t.after(() => fs.rmSync(fixtureRoot, { force: true, recursive: true }));

    const portReservation = net.createServer();
    await listen(portReservation);
    const testPort = portReservation.address().port;
    await close(portReservation);

    const startScript = path.join(fixtureRoot, "StartFrontierServer.ps1");
    const source = fs.readFileSync(
      path.join(REPO_ROOT, "StartFrontierServer.ps1"),
      "utf8",
    );
    const defaultPorts = "@(26000, 26101, 26102, 26103, 5222, 26401)";
    const markerWrite =
      "        Write-JsonAtomic -Path $PidMarker -Value $pidMarkerValue";
    assert.equal(source.includes(defaultPorts), true);
    assert.equal(source.includes(markerWrite), true);
    fs.writeFileSync(
      startScript,
      source
        .replace(defaultPorts, `@(${testPort})`)
        .replace(markerWrite, "        throw 'injected PID-marker failure'"),
    );

    const build = "9994410";
    const generatedRoot = path.join(
      fixtureRoot,
      "_local",
      "frontier-gameStore",
      build,
    );
    fs.mkdirSync(path.join(generatedRoot, "data"), { recursive: true });
    fs.writeFileSync(path.join(generatedRoot, "manifest.json"), "{}\n");
    fs.mkdirSync(
      path.join(fixtureRoot, "_local", "frontier-sde", build),
      { recursive: true },
    );
    fs.mkdirSync(
      path.join(fixtureRoot, "server", "node_modules", "better-sqlite3"),
      { recursive: true },
    );
    const childPidPath = path.join(fixtureRoot, "rollback-child.pid");
    fs.writeFileSync(
      path.join(fixtureRoot, "server", "index.js"),
      [
        '"use strict";',
        'const fs = require("node:fs");',
        `fs.writeFileSync(${JSON.stringify(childPidPath)}, String(process.pid));`,
        "setInterval(() => {}, 1000);",
        "",
      ].join("\n"),
    );

    const initialize = runScript(startScript, [
      "-Build",
      build,
      "-InitializeOnly",
    ]);
    assert.equal(initialize.status, 0, initialize.stderr || initialize.stdout);

    const failedStart = runScript(startScript, [
      "-Build",
      build,
      "-Background",
    ]);
    assert.notEqual(failedStart.status, 0);
    assert.match(
      `${failedStart.stderr}\n${failedStart.stdout}`,
      /injected PID-marker failure/i,
    );
    assert.equal(fs.existsSync(childPidPath), true);
    const childPid = Number.parseInt(fs.readFileSync(childPidPath, "utf8"), 10);
    assert.equal(Number.isInteger(childPid) && childPid > 0, true);
    const processProbe = spawnSync(
      POWERSHELL,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `if (Get-Process -Id ${childPid} -ErrorAction SilentlyContinue) { exit 1 }`,
      ],
      { encoding: "utf8" },
    );
    assert.equal(
      processProbe.status,
      0,
      `background child ${childPid} survived failed marker publication`,
    );
    assert.equal(
      fs.existsSync(path.join(
        fixtureRoot,
        "_local",
        "frontier-runtime",
        build,
        ".evejs-frontier-server.pid.json",
      )),
      false,
    );
  },
);
