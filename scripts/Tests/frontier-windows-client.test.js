"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const { once } = require("node:events");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const test = require("node:test");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const POWERSHELL = "pwsh";
const probe = process.platform === "win32"
  ? spawnSync(POWERSHELL, ["-NoLogo", "-NoProfile", "-Command", "exit 0"])
  : { status: 1 };
const canRunPowerShell = process.platform === "win32" &&
  !probe.error && probe.status === 0;

function psLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function runPowerShell(command) {
  return spawnSync(
    POWERSHELL,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
    { encoding: "utf8" },
  );
}

function createFrontierDiscoveryFixture(fixtureBase, build) {
  const retailRoot = path.join(fixtureBase, "retail");
  const sourceRoot = path.join(retailRoot, "stillness");
  const officialResFiles = path.join(retailRoot, "ResFiles");
  for (const directory of [
    officialResFiles,
    path.join(sourceRoot, "bin64", "staticdata"),
    path.join(sourceRoot, "bin64", "packages", "certifi"),
  ]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  fs.writeFileSync(
    path.join(sourceRoot, "start.ini"),
    `[main]\nappname=FRONTIER\nbuild=${build}\nsync=${build}\nversion=20.04\n`,
  );
  for (const relative of [
    "code.ccp",
    "manifest.dat",
    "resfileindex.txt",
    path.join("bin64", "staticdata", "mapObjects.db"),
    path.join("bin64", "cacert.pem"),
    path.join("bin64", "packages", "certifi", "cacert.pem"),
    path.join("bin64", "exefile.exe"),
    path.join("bin64", "blue.pyd"),
  ]) {
    fs.writeFileSync(path.join(sourceRoot, relative), `fixture-${relative}`);
  }
  return { officialResFiles, sourceRoot };
}

function writeCopyStageMarker({
  build,
  officialResFiles,
  sourceRoot,
  stageRoot,
  stagingBase,
}) {
  const resFiles = path.join(stageRoot, "ResFiles");
  fs.mkdirSync(resFiles, { recursive: true });
  fs.writeFileSync(
    path.join(stageRoot, ".evejs-frontier-stage.json"),
    `${JSON.stringify({
      format: "evejs-frontier-stage-v2",
      platform: "windows",
      build,
      stagePath: stageRoot,
      stagingBase,
      sourceRoot,
      patchState: "unpatched",
      retailHashesBefore: {},
      resFiles: {
        mode: "copy",
        path: resFiles,
        sourceTarget: officialResFiles,
      },
    })}\n`,
  );
}

test("all Windows Frontier PowerShell entry points parse", {
  skip: !canRunPowerShell,
}, () => {
  const files = [
    "SetupFrontierWindows.ps1",
    "StageFrontierClient.ps1",
    "PatchFrontierClientTrust.ps1",
    "StartFrontierServer.ps1",
    "StopFrontier.ps1",
    "PlayFrontier.ps1",
    "CaptureFrontierSession.ps1",
  ];
  for (const file of files) {
    const script = path.join(REPO_ROOT, file);
    const command = [
      "$tokens=$null;$errors=$null;",
      `[void][Management.Automation.Language.Parser]::ParseFile(${psLiteral(script)},[ref]$tokens,[ref]$errors);`,
      "if($errors.Count){$errors|ForEach-Object{$_.Message}|Write-Error;exit 1}",
    ].join("");
    const result = runPowerShell(command);
    assert.equal(result.status, 0, `${file}: ${result.stderr || result.stdout}`);
  }
});

test("launcher argument redaction never emits session credentials", {
  skip: !canRunPowerShell,
}, () => {
  const modulePath = path.join(
    REPO_ROOT,
    "tools",
    "frontier-client",
    "FrontierWindows.Common.psm1",
  );
  const secrets = [
    "/ssoToken=secret-sso",
    "/refreshToken=secret-refresh",
    "/LauncherData=secret-launcher",
    "/deviceID=secret-device",
    "/machineHash=secret-machine",
    "/journeyID=secret-journey",
    "exp=secret-expiry",
  ];
  const values = secrets.map(psLiteral).join(",");
  const command = [
    `Import-Module ${psLiteral(modulePath)} -Force;`,
    `@(${values})|ForEach-Object{Protect-FrontierLaunchArgument $_}`,
  ].join("");
  const result = runPowerShell(command);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  for (const secret of secrets) {
    assert.doesNotMatch(result.stdout, new RegExp(secret.split("=")[1]));
  }
  assert.equal((result.stdout.match(/\*\*\*/g) || []).length, secrets.length);
});

test("stage ownership accepts only its exact build-numbered contained path", {
  skip: !canRunPowerShell,
}, (t) => {
  const fixtureBase = fs.mkdtempSync(
    path.join(os.tmpdir(), "evejs frontier stage guards "),
  );
  t.after(() => fs.rmSync(fixtureBase, { force: true, recursive: true }));
  const build = 9994408;
  const stageRoot = path.join(fixtureBase, String(build));
  fs.mkdirSync(stageRoot);
  const markerPath = path.join(stageRoot, ".evejs-frontier-stage.json");
  const marker = {
    format: "evejs-frontier-stage-v2",
    platform: "windows",
    build,
    stagePath: stageRoot,
    stagingBase: fixtureBase,
  };
  fs.writeFileSync(markerPath, `${JSON.stringify(marker)}\n`);
  const modulePath = path.join(
    REPO_ROOT,
    "tools",
    "frontier-client",
    "FrontierWindows.Common.psm1",
  );
  const command = [
    `Import-Module ${psLiteral(modulePath)} -Force;`,
    `Read-FrontierStageMarker -StageRoot ${psLiteral(stageRoot)} `,
    `-ExpectedBase ${psLiteral(fixtureBase)} -ExpectedBuild ${build}|Out-Null`,
  ].join("");
  const valid = runPowerShell(command);
  assert.equal(valid.status, 0, valid.stderr || valid.stdout);

  marker.stagePath = path.join(fixtureBase, "somewhere-else");
  fs.writeFileSync(markerPath, `${JSON.stringify(marker)}\n`);
  const invalid = runPowerShell(command);
  assert.notEqual(invalid.status, 0);
});

test("patch dry run validates a marker without mutating it", {
  skip: !canRunPowerShell,
}, (t) => {
  const fixtureBase = fs.mkdtempSync(
    path.join(os.tmpdir(), "evejs frontier patch dry run "),
  );
  t.after(() => fs.rmSync(fixtureBase, { force: true, recursive: true }));
  const build = 9994409;
  const stageRoot = path.join(fixtureBase, String(build));
  fs.mkdirSync(stageRoot);
  const markerPath = path.join(stageRoot, ".evejs-frontier-stage.json");
  const content = `${JSON.stringify({
    format: "evejs-frontier-stage-v2",
    platform: "windows",
    build,
    stagePath: stageRoot,
    stagingBase: fixtureBase,
  })}\n`;
  fs.writeFileSync(markerPath, content);
  const result = spawnSync(
    POWERSHELL,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-File",
      path.join(REPO_ROOT, "PatchFrontierClientTrust.ps1"),
      "-StagedRoot",
      stageRoot,
      "-DryRun",
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Dry run/);
  assert.equal(fs.readFileSync(markerPath, "utf8"), content);
});

test("patch check rejects unsigned exefile before the Python transaction", {
  skip: !canRunPowerShell,
}, (t) => {
  const fixtureBase = fs.mkdtempSync(
    path.join(os.tmpdir(), "evejs frontier trust preflight "),
  );
  t.after(() => fs.rmSync(fixtureBase, { force: true, recursive: true }));
  const build = 9994411;
  const stageRoot = path.join(fixtureBase, String(build));
  const exefile = path.join(stageRoot, "bin64", "exefile.exe");
  fs.mkdirSync(path.dirname(exefile), { recursive: true });
  fs.writeFileSync(exefile, "not-an-authenticode-signed-executable");
  const markerPath = path.join(stageRoot, ".evejs-frontier-stage.json");
  const content = `${JSON.stringify({
    format: "evejs-frontier-stage-v2",
    platform: "windows",
    build,
    stagePath: stageRoot,
    stagingBase: fixtureBase,
  })}\n`;
  fs.writeFileSync(markerPath, content);

  const result = spawnSync(
    POWERSHELL,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-File",
      path.join(REPO_ROOT, "PatchFrontierClientTrust.ps1"),
      "-StagedRoot",
      stageRoot,
      "-Check",
    ],
    { encoding: "utf8" },
  );
  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}\n${result.stdout}`, /Authenticode signature is not valid/);
  assert.equal(fs.readFileSync(markerPath, "utf8"), content);
  assert.equal(fs.existsSync(path.join(stageRoot, ".evejs-backups")), false);
});

test("stage cleanup refuses a retargeted ResFiles junction", {
  skip: !canRunPowerShell,
}, (t) => {
  const fixtureBase = fs.mkdtempSync(
    path.join(os.tmpdir(), "evejs frontier cleanup guard "),
  );
  t.after(() => fs.rmSync(fixtureBase, { force: true, recursive: true }));
  const build = 9994412;
  const retailRoot = path.join(fixtureBase, "retail");
  const sourceRoot = path.join(retailRoot, "stillness");
  const officialResFiles = path.join(retailRoot, "ResFiles");
  const wrongResFiles = path.join(fixtureBase, "wrong ResFiles");
  const stagingBase = path.join(fixtureBase, "staged-client");
  const stageRoot = path.join(stagingBase, String(build));
  for (const directory of [
    officialResFiles,
    wrongResFiles,
    path.join(sourceRoot, "bin64", "staticdata"),
    path.join(sourceRoot, "bin64", "packages", "certifi"),
    stageRoot,
  ]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  fs.writeFileSync(
    path.join(sourceRoot, "start.ini"),
    `[main]\nappname=FRONTIER\nbuild=${build}\nsync=${build}\nversion=20.04\n`,
  );
  for (const relative of [
    "code.ccp",
    "manifest.dat",
    "resfileindex.txt",
    path.join("bin64", "staticdata", "mapObjects.db"),
    path.join("bin64", "cacert.pem"),
    path.join("bin64", "packages", "certifi", "cacert.pem"),
    path.join("bin64", "exefile.exe"),
    path.join("bin64", "blue.pyd"),
  ]) {
    fs.writeFileSync(path.join(sourceRoot, relative), `fixture-${relative}`);
  }
  const sentinel = path.join(wrongResFiles, "must-survive.txt");
  fs.writeFileSync(sentinel, "owned by the wrong target");
  const stagedResFiles = path.join(stageRoot, "ResFiles");
  fs.symlinkSync(wrongResFiles, stagedResFiles, "junction");
  fs.writeFileSync(
    path.join(stageRoot, ".evejs-frontier-stage.json"),
    `${JSON.stringify({
      format: "evejs-frontier-stage-v2",
      platform: "windows",
      build,
      stagePath: stageRoot,
      stagingBase,
      sourceRoot,
      resFiles: {
        mode: "junction",
        path: stagedResFiles,
        target: officialResFiles,
      },
    })}\n`,
  );

  const result = spawnSync(
    POWERSHELL,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-File",
      path.join(REPO_ROOT, "StageFrontierClient.ps1"),
      "-SourceRoot",
      sourceRoot,
      "-Build",
      String(build),
      "-StagingBase",
      stagingBase,
      "-Clean",
      "-NoPatch",
    ],
    { encoding: "utf8" },
  );
  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}\n${result.stdout}`, /Junction target changed/);
  assert.equal(fs.existsSync(stageRoot), true);
  assert.equal(fs.readFileSync(sentinel, "utf8"), "owned by the wrong target");
});

test("stage preflight rejects a staging-base ancestor junction before writing", {
  skip: !canRunPowerShell,
}, (t) => {
  const fixtureBase = fs.mkdtempSync(
    path.join(os.tmpdir(), "evejs frontier base chain guard "),
  );
  t.after(() => fs.rmSync(fixtureBase, { force: true, recursive: true }));
  const build = 9994413;
  const { sourceRoot } = createFrontierDiscoveryFixture(fixtureBase, build);
  const actualBase = path.join(fixtureBase, "actual staging parent");
  const stagingAlias = path.join(fixtureBase, "staging parent alias");
  const stagingBase = path.join(stagingAlias, "must-not-be-created");
  fs.mkdirSync(actualBase);
  fs.symlinkSync(actualBase, stagingAlias, "junction");

  const result = spawnSync(
    POWERSHELL,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-File",
      path.join(REPO_ROOT, "StageFrontierClient.ps1"),
      "-SourceRoot",
      sourceRoot,
      "-Build",
      String(build),
      "-StagingBase",
      stagingBase,
      "-NoPatch",
    ],
    { encoding: "utf8" },
  );
  assert.notEqual(result.status, 0);
  assert.match(
    `${result.stderr}\n${result.stdout}`,
    /Refusing a reparse-point staging path component/,
  );
  assert.equal(fs.existsSync(path.join(actualBase, "must-not-be-created")), false);
});

test("existing stage preflight rejects every nested reparse except ResFiles", {
  skip: !canRunPowerShell,
}, (t) => {
  const fixtureBase = fs.mkdtempSync(
    path.join(os.tmpdir(), "evejs frontier nested reparse guard "),
  );
  t.after(() => fs.rmSync(fixtureBase, { force: true, recursive: true }));
  const build = 9994414;
  const { officialResFiles, sourceRoot } = createFrontierDiscoveryFixture(
    fixtureBase,
    build,
  );
  const stagingBase = path.join(fixtureBase, "staged-client");
  const stageRoot = path.join(stagingBase, String(build));
  const outside = path.join(fixtureBase, "outside stage");
  fs.mkdirSync(path.join(stageRoot, "bin64"), { recursive: true });
  fs.mkdirSync(outside);
  const sentinel = path.join(outside, "must-survive.txt");
  fs.writeFileSync(sentinel, "outside data");
  fs.symlinkSync(outside, path.join(stageRoot, "bin64", "escape"), "junction");
  writeCopyStageMarker({
    build,
    officialResFiles,
    sourceRoot,
    stageRoot,
    stagingBase,
  });

  const result = spawnSync(
    POWERSHELL,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-File",
      path.join(REPO_ROOT, "StageFrontierClient.ps1"),
      "-SourceRoot",
      sourceRoot,
      "-Build",
      String(build),
      "-StagingBase",
      stagingBase,
      "-Status",
    ],
    { encoding: "utf8" },
  );
  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}\n${result.stdout}`, /Unexpected reparse point/);
  assert.equal(fs.readFileSync(sentinel, "utf8"), "outside data");
  assert.equal(fs.existsSync(stageRoot), true);
});

test("stage cleanup refuses a live exact exefile by PID marker and path scan", {
  skip: !canRunPowerShell,
}, async (t) => {
  const fixtureBase = fs.mkdtempSync(
    path.join(os.tmpdir(), "evejs frontier live cleanup guard "),
  );
  let clientProcess = null;
  t.after(async () => {
    if (clientProcess && clientProcess.exitCode === null) {
      clientProcess.kill();
      await Promise.race([
        once(clientProcess, "exit"),
        new Promise((resolve) => setTimeout(resolve, 5000)),
      ]);
    }
    fs.rmSync(fixtureBase, { force: true, recursive: true });
  });

  const build = 9994415;
  const { officialResFiles, sourceRoot } = createFrontierDiscoveryFixture(
    fixtureBase,
    build,
  );
  const stagingBase = path.join(fixtureBase, "staged-client");
  const stageRoot = path.join(stagingBase, String(build));
  const stagedExefile = path.join(stageRoot, "bin64", "exefile.exe");
  const localAppData = path.join(fixtureBase, "local app data");
  const pidMarker = path.join(
    localAppData,
    "EveJS-Frontier",
    "windows",
    "logs",
    String(build),
    "client.pid.json",
  );
  fs.mkdirSync(path.dirname(stagedExefile), { recursive: true });
  fs.copyFileSync(path.join(process.env.SystemRoot, "System32", "ping.exe"), stagedExefile);
  writeCopyStageMarker({
    build,
    officialResFiles,
    sourceRoot,
    stageRoot,
    stagingBase,
  });
  const sentinel = path.join(stageRoot, "must-survive.txt");
  fs.writeFileSync(sentinel, "live stage");

  clientProcess = spawn(stagedExefile, ["127.0.0.1", "-n", "60"], {
    stdio: "ignore",
    windowsHide: true,
  });
  await once(clientProcess, "spawn");
  const ticks = runPowerShell(
    `(Get-Process -Id ${clientProcess.pid}).StartTime.ToUniversalTime().Ticks`,
  );
  assert.equal(ticks.status, 0, ticks.stderr || ticks.stdout);
  fs.mkdirSync(path.dirname(pidMarker), { recursive: true });
  fs.writeFileSync(pidMarker, `${JSON.stringify({
    format: "evejs-frontier-client-process-v1",
    build,
    stageRoot,
    exefile: stagedExefile,
    pid: clientProcess.pid,
    processStartTimeUtcTicks: ticks.stdout.trim(),
  })}\n`);

  const args = [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-File",
    path.join(REPO_ROOT, "StageFrontierClient.ps1"),
    "-SourceRoot",
    sourceRoot,
    "-Build",
    String(build),
    "-StagingBase",
    stagingBase,
    "-Clean",
    "-NoPatch",
  ];
  const withMarker = spawnSync(POWERSHELL, args, {
    encoding: "utf8",
    env: { ...process.env, LOCALAPPDATA: localAppData },
  });
  assert.notEqual(withMarker.status, 0);
  assert.match(
    `${withMarker.stderr}\n${withMarker.stdout}`,
    /PID marker reports the staged Frontier client is running/,
  );
  assert.equal(fs.readFileSync(sentinel, "utf8"), "live stage");

  fs.rmSync(pidMarker);
  const withoutMarker = spawnSync(POWERSHELL, args, {
    encoding: "utf8",
    env: { ...process.env, LOCALAPPDATA: localAppData },
  });
  assert.notEqual(withoutMarker.status, 0);
  assert.match(
    `${withoutMarker.stderr}\n${withoutMarker.stdout}`,
    /exact staged Frontier executable is running/,
  );
  assert.equal(fs.readFileSync(sentinel, "utf8"), "live stage");
});

test("private launcher-session writer applies the SID-only ACL before publishing", {
  skip: !canRunPowerShell,
}, (t) => {
  const fixtureBase = fs.mkdtempSync(
    path.join(os.tmpdir(), "evejs frontier private session "),
  );
  t.after(() => fs.rmSync(fixtureBase, { force: true, recursive: true }));
  const outputPath = path.join(fixtureBase, "launcher session.args");
  const modulePath = path.join(
    REPO_ROOT,
    "tools",
    "frontier-client",
    "FrontierWindows.Common.psm1",
  );
  const command = [
    `Import-Module ${psLiteral(modulePath)} -Force;`,
    `Write-FrontierPrivateLinesAtomic -Path ${psLiteral(outputPath)} `,
    `-Lines @('/ssoToken=test-secret','exp=test-expiry');`,
    `$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;`,
    `$allow=@((Get-Acl -LiteralPath ${psLiteral(outputPath)}).Access|`,
    `Where-Object{$_.AccessControlType -eq 'Allow'});`,
    `if($allow.Count -ne 1 -or $allow[0].IdentityReference.Translate(`,
    `[Security.Principal.SecurityIdentifier]).Value -ne $sid){exit 9}`,
  ].join("");
  const result = runPowerShell(command);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(
    fs.readFileSync(outputPath, "utf8").trim().split(/\r?\n/),
    ["/ssoToken=test-secret", "exp=test-expiry"],
  );
  assert.deepEqual(
    fs.readdirSync(fixtureBase).filter((name) => name.includes(".tmp-")),
    [],
  );
});

test("StopFrontier accepts the explicit custom stage recorded by a client PID marker", {
  skip: !canRunPowerShell,
}, (t) => {
  const fixtureBase = fs.mkdtempSync(
    path.join(os.tmpdir(), "evejs frontier custom stop "),
  );
  t.after(() => fs.rmSync(fixtureBase, { force: true, recursive: true }));
  const localAppData = path.join(fixtureBase, "local app data");
  const build = 9994410;
  const stageRoot = path.join(fixtureBase, "custom stages", String(build));
  const exefile = path.join(stageRoot, "bin64", "exefile.exe");
  const logRoot = path.join(
    localAppData,
    "EveJS-Frontier",
    "windows",
    "logs",
    String(build),
  );
  fs.mkdirSync(path.dirname(exefile), { recursive: true });
  fs.writeFileSync(exefile, "fixture");
  fs.mkdirSync(logRoot, { recursive: true });
  fs.writeFileSync(path.join(logRoot, "client.pid.json"), `${JSON.stringify({
    format: "evejs-frontier-client-process-v1",
    build,
    stageRoot,
    exefile,
    pid: 2147483000,
    processStartTimeUtcTicks: 1,
  })}\n`);

  const result = spawnSync(
    POWERSHELL,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-File",
      path.join(REPO_ROOT, "StopFrontier.ps1"),
      "-Build",
      String(build),
      "-ClientOnly",
      "-Status",
      "-StagedRoot",
      stageRoot,
    ],
    {
      encoding: "utf8",
      env: { ...process.env, LOCALAPPDATA: localAppData },
    },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Background client: stale marker/);
});
