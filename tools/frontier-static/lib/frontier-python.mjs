import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const LIB_DIR = path.dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = path.resolve(LIB_DIR, "..");
const REPO_ROOT = path.resolve(STATIC_DIR, "../..");

const WINDOWS_PROBE = [
  "import importlib, os, sys",
  "assert sys.version_info[:2] == (3, 12), sys.version",
  "_evejs_dll_dir = os.add_dll_directory(sys.argv[1])",
  "[importlib.import_module(name) for name in sys.argv[2:]]",
  "print('evejs-frontier-python312-ok')",
].join("; ");

const WINDOWS_RUN_SCRIPT = [
  "import os, runpy, sys",
  "_evejs_dll_dir = os.add_dll_directory(sys.argv[1])",
  "_evejs_script = sys.argv[2]",
  "sys.argv = sys.argv[2:]",
  "runpy.run_path(_evejs_script, run_name='__main__')",
].join("; ");

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

function frontierPythonPath(buildRoot) {
  return [
    path.join(buildRoot, "code.ccp"),
    path.join(buildRoot, "bin64"),
  ].join(path.delimiter);
}

function pythonEnvironment(buildRoot) {
  const bin64 = path.join(buildRoot, "bin64");
  return {
    ...process.env,
    PATH: `${bin64}${path.delimiter}${process.env.PATH || ""}`,
    PYTHONPATH: frontierPythonPath(buildRoot),
    PYTHONUTF8: "1",
  };
}

function windowsPythonCandidates() {
  const candidates = [
    process.env.EVEJS_FRONTIER_PYTHON312 && {
      command: process.env.EVEJS_FRONTIER_PYTHON312,
      prefixArgs: [],
      source: "EVEJS_FRONTIER_PYTHON312",
    },
    {
      command: path.join(
        REPO_ROOT,
        "_local",
        "frontier-python312",
        "Scripts",
        "python.exe",
      ),
      prefixArgs: [],
      source: "repository Python 3.12 environment",
    },
    { command: "py.exe", prefixArgs: ["-3.12"], source: "Python launcher" },
    { command: "python3.12.exe", prefixArgs: [], source: "python3.12.exe" },
    { command: "python.exe", prefixArgs: [], source: "python.exe" },
  ].filter(Boolean);
  const seen = new Set();
  return candidates.filter((candidate) => {
    const key = `${candidate.command}\0${candidate.prefixArgs.join("\0")}`.toLowerCase();
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function probeWindowsPython(buildRoot, requiredImports) {
  const bin64 = path.join(buildRoot, "bin64");
  const environment = pythonEnvironment(buildRoot);
  const failures = [];
  for (const candidate of windowsPythonCandidates()) {
    const result = spawnSync(
      candidate.command,
      [
        ...candidate.prefixArgs,
        "-c",
        WINDOWS_PROBE,
        bin64,
        ...requiredImports,
      ],
      {
        encoding: "utf8",
        env: environment,
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    if (
      !result.error &&
      result.status === 0 &&
      result.stdout.includes("evejs-frontier-python312-ok")
    ) {
      return {
        kind: "external-python312",
        command: candidate.command,
        argsPrefix: [
          ...candidate.prefixArgs,
          "-c",
          WINDOWS_RUN_SCRIPT,
          bin64,
        ],
        env: environment,
        description: candidate.source,
      };
    }
    const detail = result.error?.message || result.stderr?.trim() || result.stdout?.trim();
    failures.push(`${candidate.source}: ${detail || `exit ${result.status}`}`);
  }
  return { failures };
}

function locateMacClang() {
  const result = spawnSync("xcrun", ["--find", "clang"], { encoding: "utf8" });
  if (!result.error && result.status === 0 && result.stdout.trim()) {
    return result.stdout.trim();
  }
  return "clang";
}

function compileMacRunner(buildRoot, toolsRoot) {
  const libDir = path.join(buildRoot, "bin64");
  const libPython = path.join(libDir, "libpython3.12.dylib");
  if (!fs.existsSync(libPython)) {
    throw new Error(`Frontier embedded Python library not found: ${libPython}`);
  }
  const sdkResult = commandResult("xcrun", ["--sdk", "macosx", "--show-sdk-path"]);
  const sdkPath = sdkResult.stdout.trim();
  if (!sdkPath) {
    throw new Error("xcrun did not return a macOS SDK path");
  }

  fs.mkdirSync(toolsRoot, { recursive: true });
  const sourcePath = path.join(STATIC_DIR, "frontier-python-runner.c");
  const runnerPath = path.join(toolsRoot, "frontier-python312-runner");
  const needsBuild = !fs.existsSync(runnerPath) ||
    fs.statSync(runnerPath).mtimeMs < fs.statSync(sourcePath).mtimeMs ||
    fs.statSync(runnerPath).mtimeMs < fs.statSync(libPython).mtimeMs;
  if (needsBuild) {
    commandResult(locateMacClang(), [
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
  }
  return {
    kind: "embedded-python312-macos",
    command: runnerPath,
    argsPrefix: [],
    env: {
      ...process.env,
      PYTHONPATH: frontierPythonPath(buildRoot),
    },
    description: "client embedded libpython3.12.dylib",
  };
}

function findWindowsCompiler() {
  const requested = process.env.CC;
  const candidates = requested
    ? [requested]
    : ["cl.exe", "clang-cl.exe", "clang.exe"];
  for (const candidate of candidates) {
    const result = spawnSync(candidate, [], { encoding: "utf8" });
    if (!result.error) {
      return candidate;
    }
  }
  return null;
}

function compileWindowsRunner(buildRoot, toolsRoot) {
  const pythonDll = path.join(buildRoot, "bin64", "python312.dll");
  if (!fs.existsSync(pythonDll)) {
    throw new Error(`Frontier embedded Python DLL not found: ${pythonDll}`);
  }
  fs.mkdirSync(toolsRoot, { recursive: true });
  const sourcePath = path.join(STATIC_DIR, "frontier-python-runner-windows.c");
  const runnerPath = path.join(toolsRoot, "frontier-python312-runner.exe");
  const needsBuild = !fs.existsSync(runnerPath) ||
    fs.statSync(runnerPath).mtimeMs < fs.statSync(sourcePath).mtimeMs ||
    fs.statSync(runnerPath).mtimeMs < fs.statSync(pythonDll).mtimeMs;
  if (needsBuild) {
    const compiler = findWindowsCompiler();
    if (!compiler) {
      throw new Error(
        "No usable external Python 3.12 was found and the embedded-Python " +
          "fallback requires MSVC or clang on PATH.",
      );
    }
    const compilerName = path.basename(compiler).toLowerCase();
    const args = compilerName === "cl.exe" || compilerName === "clang-cl.exe"
      ? [
          "/nologo",
          "/W4",
          "/O2",
          sourcePath,
          `/Fe:${runnerPath}`,
          `/Fo:${path.join(toolsRoot, "frontier-python312-runner.obj")}`,
        ]
      : ["-std=c11", "-Wall", "-Wextra", "-O2", sourcePath, "-o", runnerPath];
    commandResult(compiler, args, { cwd: toolsRoot });
  }
  return {
    kind: "embedded-python312-windows",
    command: runnerPath,
    argsPrefix: [pythonDll],
    env: pythonEnvironment(buildRoot),
    description: "client embedded python312.dll",
  };
}

function resolveFrontierPython(
  buildRoot,
  toolsRoot,
  { platform = process.platform, requiredImports = ["typesLoader"] } = {},
) {
  if (platform === "win32") {
    const probe = probeWindowsPython(buildRoot, requiredImports);
    if (probe.command) {
      return probe;
    }
    try {
      return compileWindowsRunner(buildRoot, toolsRoot);
    } catch (error) {
      const details = probe.failures.length > 0
        ? `\nPython probes:\n${probe.failures.join("\n")}`
        : "";
      throw new Error(`${error.message}${details}`);
    }
  }
  if (platform === "darwin") {
    return compileMacRunner(buildRoot, toolsRoot);
  }
  throw new Error(`Frontier embedded-Python execution is unsupported on ${platform}`);
}

function buildPythonInvocation(runner, scriptPath, args = []) {
  return {
    command: runner.command,
    args: [...runner.argsPrefix, scriptPath, ...args],
    env: runner.env,
  };
}

export {
  buildPythonInvocation,
  compileMacRunner,
  compileWindowsRunner,
  frontierPythonPath,
  probeWindowsPython,
  resolveFrontierPython,
};
