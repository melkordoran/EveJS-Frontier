"use strict";

// Shared Docker-deployment detection for the Config Editor's node helpers.
//
// The authoritative gamestore lives wherever the server keeps it. Under the
// Docker deployment that is the evejs-data volume, which has no host path. The
// host checkout is just as bare: npm dependencies are installed into the image
// (Dockerfile copies server/node_modules in), and _local/gameStore is generated
// by DatabaseCreator, which OpenServerConfig.bat deliberately skips when it
// detects Docker. So a host tool needing gamestore data cannot read a local
// copy - there is nothing to read - and has to run its query in the container.
//
// Resolution order for every caller:
//   1. An explicit EVEJS_GAMESTORE_* override always wins (this is also how a
//      delegated child resolves: compose sets EVEJS_GAMESTORE_DATA_DIR on the
//      server service, so inside the container step 1 short-circuits).
//   2. Already inside a container: use the paths we were given.
//   3. Docker deployment detected: delegate (see resolveDockerDelegation).
//   4. Otherwise: the native/local filesystem layout, unchanged.

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const DOCKER_PROXY_ENV = "EVEJS_CONFIG_CLI_DOCKER_PROXY";
const CONTAINER_REPO_ROOT = "/app";
const DOCKER_SERVICE = "server";
// A single-player export carries that character's items, skills and ships and
// runs to many megabytes, far past spawnSync's 1 MB default maxBuffer. Hitting
// that default aborts the child and surfaces as ENOBUFS.
const DELEGATED_MAX_BUFFER_BYTES = 512 * 1024 * 1024;

function hasExplicitGameStoreOverride() {
  return Boolean(
    process.env.EVEJS_GAMESTORE_DATA_DIR ||
      process.env.EVEJS_GAMESTORE_SQLITE_PATH,
  );
}

function isRunningInsideContainer() {
  if (process.env[DOCKER_PROXY_ENV] === "1") {
    return true;
  }
  try {
    return fs.existsSync("/.dockerenv");
  } catch (error) {
    return false;
  }
}

function runDockerCompose(rootDir, args) {
  return spawnSync("docker", ["compose", ...args], {
    cwd: rootDir,
    encoding: "utf8",
    windowsHide: true,
  });
}

// Docker is installed but cannot answer us — daemon stopped, compose broken.
// We cannot tell a Docker deployment from a native one in that state, and
// guessing wrong means silently serving a stale _local copy, which is the exact
// failure this detection exists to prevent. Refuse instead, and name both ways out.
function throwIndeterminateDeployment(databasePath, detail) {
  throw new Error(
    "Docker is installed but its state could not be determined" +
      (detail ? ` (${detail})` : "") +
      `. Refusing to fall back to ${databasePath}, which may be stale. ` +
      "Start Docker, or set EVEJS_GAMESTORE_SQLITE_PATH and EVEJS_GAMESTORE_DATA_DIR " +
      "to read the local copy deliberately.",
  );
}

function describeDockerFailure(result) {
  return String(result && result.stderr || "").trim().split("\n")[0].slice(0, 120);
}

// Returns the `docker compose` argument prefix to run a one-off node process
// against the live gamestore, or null when this is not a Docker deployment.
function resolveDockerDelegation({ rootDir, databasePath, service = DOCKER_SERVICE }) {
  if (!fs.existsSync(path.join(rootDir, "compose.yaml"))) {
    return null;
  }
  const running = runDockerCompose(rootDir, ["ps", "--status", "running", "-q", service]);
  // Spawn failure means the docker binary is absent, so this is a native
  // deployment and the filesystem layout is the right answer.
  if (running.error) {
    return null;
  }
  if (running.status !== 0) {
    throwIndeterminateDeployment(databasePath, describeDockerFailure(running));
  }
  const proxyEnv = ["-e", `${DOCKER_PROXY_ENV}=1`];
  if (String(running.stdout || "").trim()) {
    return ["exec", "-T", ...proxyEnv, service];
  }
  // The GUI's player tools ask you to stop the server before saving, so the
  // container being down is the NORMAL case for writes, not an edge case. Only
  // treat it as a Docker deployment if a container for the service exists.
  const created = runDockerCompose(rootDir, ["ps", "-a", "-q", service]);
  if (created.error) {
    return null;
  }
  if (created.status !== 0) {
    throwIndeterminateDeployment(databasePath, describeDockerFailure(created));
  }
  // Docker answered and has never created this service: a native deployment
  // that merely happens to have Docker installed.
  if (!String(created.stdout || "").trim()) {
    return null;
  }
  return ["run", "--rm", "--no-deps", "-T", ...proxyEnv, service];
}

// The image is built by copying the repo to /app, so any host path inside the
// repo has a container twin at the same relative position.
function containerScriptPath(rootDir, hostScriptPath) {
  const relative = path.relative(rootDir, hostScriptPath).split(path.sep).join("/");
  return `${CONTAINER_REPO_ROOT}/${relative}`;
}

// A delegated payload reports container paths. That is correct for the gamestore
// itself, which has no host equivalent and is only informational, but wrong for
// repo files a host GUI actually opens with Test-Path, which fails silently on
// Windows. Anything under /app maps back to rootDir.
function toHostRepoPath(rootDir, value) {
  const text = String(value || "");
  if (!text.startsWith(`${CONTAINER_REPO_ROOT}/`)) {
    return value;
  }
  return path.join(rootDir, text.slice(CONTAINER_REPO_ROOT.length + 1));
}

// Runs a repo script inside the container and relays its stdout verbatim.
// stdin is inherited by default because several commands take their JSON payload
// that way. Nothing is written to stderr on success: the PowerShell caller treats
// ANY stderr as a terminating error, even with exit code 0.
function delegateNodeScript({
  rootDir,
  composePrefix,
  scriptPath,
  argv = [],
  stdin = "inherit",
  failureLabel = "The containerized config CLI",
}) {
  const result = spawnSync(
    "docker",
    ["compose", ...composePrefix, "node", scriptPath, ...argv],
    {
      cwd: rootDir,
      encoding: "utf8",
      windowsHide: true,
      stdio: [stdin, "pipe", "pipe"],
      maxBuffer: DELEGATED_MAX_BUFFER_BYTES,
    },
  );
  if (result.error) {
    throw new Error(
      `Could not reach the EvEJS container to read the live game database: ${result.error.message}`,
    );
  }
  if (result.status !== 0) {
    const detail = String(result.stderr || "").trim() || `exit ${result.status}`;
    throw new Error(`${failureLabel} failed: ${detail}`);
  }
  return String(result.stdout || "");
}

module.exports = {
  CONTAINER_REPO_ROOT,
  DOCKER_PROXY_ENV,
  DOCKER_SERVICE,
  containerScriptPath,
  delegateNodeScript,
  hasExplicitGameStoreOverride,
  isRunningInsideContainer,
  resolveDockerDelegation,
  toHostRepoPath,
};
