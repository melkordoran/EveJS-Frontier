import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { readStartIni } from "./start-ini.mjs";

const DISCOVERY_FORMAT = "evejs-frontier-client-discovery-v1";

const REQUIRED_BUILD_FILES = Object.freeze({
  codeArchive: "code.ccp",
  manifest: "manifest.dat",
  resourceIndex: "resfileindex.txt",
  mapObjects: path.join("bin64", "staticdata", "mapObjects.db"),
  caBundle: path.join("bin64", "cacert.pem"),
  certifiCaBundle: path.join("bin64", "packages", "certifi", "cacert.pem"),
});

function isDirectory(candidate) {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

function isFile(candidate) {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function canonicalPath(candidate) {
  const absolute = path.resolve(candidate);
  try {
    return fs.realpathSync.native(absolute);
  } catch {
    return absolute;
  }
}

function pathIdentity(candidate) {
  const canonical = canonicalPath(candidate);
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

function uniquePaths(candidates) {
  const seen = new Set();
  const output = [];
  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    const absolute = path.resolve(candidate);
    const identity = process.platform === "win32"
      ? absolute.toLowerCase()
      : absolute;
    if (!seen.has(identity)) {
      seen.add(identity);
      output.push(absolute);
    }
  }
  return output;
}

function parseNumericIniValue(value, label, { required = false } = {}) {
  const text = String(value ?? "").trim();
  if (!text) {
    if (required) {
      throw new Error(`Frontier ${label} is missing`);
    }
    return null;
  }
  if (!/^\d+$/.test(text)) {
    throw new Error(`Frontier ${label} is not numeric: ${text}`);
  }
  const numeric = Number(text);
  if (!Number.isSafeInteger(numeric) || numeric <= 0) {
    throw new Error(`Frontier ${label} is invalid: ${text}`);
  }
  return numeric;
}

function findCacheRoot(buildRoot, preferredCacheRoot = null) {
  const candidates = [];
  if (preferredCacheRoot) {
    candidates.push(preferredCacheRoot);
  }
  let current = path.resolve(buildRoot);
  for (let depth = 0; depth < 9; depth += 1) {
    candidates.push(current);
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  for (const candidate of uniquePaths(candidates)) {
    if (isDirectory(path.join(candidate, "ResFiles"))) {
      return canonicalPath(candidate);
    }
  }
  return null;
}

function describeLayoutRoot(cacheRoot) {
  return path.basename(cacheRoot).toLowerCase() === "sharedcache"
    ? path.dirname(cacheRoot)
    : cacheRoot;
}

function validateClientLayout(layout) {
  const buildRoot = canonicalPath(layout.buildRoot);
  const startIniPath = path.join(buildRoot, "start.ini");
  if (!isFile(startIniPath)) {
    throw new Error(`Frontier start.ini not found: ${startIniPath}`);
  }

  const startIni = readStartIni(startIniPath);
  const appName = String(startIni["main.appname"] || "").trim();
  if (appName.toUpperCase() !== "FRONTIER") {
    throw new Error(`Client is not EVE Frontier: ${startIniPath}`);
  }
  const build = parseNumericIniValue(startIni["main.build"], "build", {
    required: true,
  });
  const sync = parseNumericIniValue(startIni["main.sync"], "sync");

  const files = { startIni: startIniPath };
  for (const [name, relativePath] of Object.entries(REQUIRED_BUILD_FILES)) {
    const filePath = path.join(buildRoot, relativePath);
    if (!isFile(filePath)) {
      throw new Error(`Frontier ${name} not found: ${filePath}`);
    }
    files[name] = canonicalPath(filePath);
  }

  const windowsExecutable = path.join(buildRoot, "bin64", "exefile.exe");
  const macExecutable = path.join(buildRoot, "bin64", "exefile");
  const executableCandidates = [windowsExecutable, macExecutable].filter(isFile);
  if (executableCandidates.length !== 1) {
    throw new Error(
      `Expected exactly one Frontier executable under ${path.join(buildRoot, "bin64")}`,
    );
  }
  files.executable = canonicalPath(executableCandidates[0]);

  const executableName = path.basename(files.executable).toLowerCase();
  const platform = executableName.endsWith(".exe") ? "windows" : "macos";
  const blueNames = platform === "windows"
    ? ["blue.dll", "blue.pyd"]
    : ["blue.so"];
  const blueCandidates = blueNames
    .map((name) => path.join(buildRoot, "bin64", name))
    .filter(isFile);
  if (blueCandidates.length !== 1) {
    throw new Error(
      `Expected exactly one Frontier native blue binary (${blueNames.join(" or ")}) ` +
        `under ${path.join(buildRoot, "bin64")}`,
    );
  }
  files.nativeBlue = canonicalPath(blueCandidates[0]);

  const cacheRoot = findCacheRoot(buildRoot, layout.cacheRoot);
  if (!cacheRoot) {
    throw new Error(`Could not resolve a sibling/shared ResFiles tree for ${buildRoot}`);
  }
  const resFilesRoot = canonicalPath(path.join(cacheRoot, "ResFiles"));
  if (!isDirectory(resFilesRoot)) {
    throw new Error(`Frontier ResFiles tree not found: ${resFilesRoot}`);
  }

  return {
    format: DISCOVERY_FORMAT,
    platform,
    layout: platform === "windows" ? "windows-channel" : "macos-app",
    clientRoot: canonicalPath(layout.clientRoot || describeLayoutRoot(cacheRoot)),
    cacheRoot,
    channel: String(layout.channel || path.basename(buildRoot)),
    build,
    buildRoot,
    resFilesRoot,
    nativeBlueName: path.basename(files.nativeBlue),
    metadata: {
      appName,
      build,
      sync,
      version: String(startIni["main.version"] || "").trim() || null,
      branch: String(startIni["main.branch"] || "").trim() || null,
      codename: String(startIni["main.codename"] || "").trim() || null,
      region: String(startIni["main.region"] || "").trim() || null,
    },
    files,
    startIni,
    startIniPath,
  };
}

function enumerateLayoutCandidates(clientRoot) {
  const root = canonicalPath(clientRoot);
  if (!isDirectory(root)) {
    return [];
  }

  const layouts = [];
  const seen = new Set();
  const add = (buildRoot, cacheRoot, channel, logicalRoot = root) => {
    const startIni = path.join(buildRoot, "start.ini");
    if (!isFile(startIni)) {
      return;
    }
    const identity = pathIdentity(buildRoot);
    if (seen.has(identity)) {
      return;
    }
    seen.add(identity);
    layouts.push({
      buildRoot,
      cacheRoot,
      channel,
      clientRoot: logicalRoot,
    });
  };

  // An explicit root may be the build/channel directory itself.
  add(root, null, path.basename(root), path.dirname(root));

  // An explicit root may be the macOS EVE.app bundle.
  add(
    path.join(root, "Contents", "Resources", "build"),
    null,
    path.basename(path.dirname(root)),
    root,
  );

  // Existing macOS launcher layout:
  //   <root>/SharedCache/<channel>/EVE.app/Contents/Resources/build
  const sharedCacheRoot = path.basename(root).toLowerCase() === "sharedcache"
    ? root
    : path.join(root, "SharedCache");
  if (isDirectory(sharedCacheRoot)) {
    for (const entry of fs.readdirSync(sharedCacheRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) {
        continue;
      }
      add(
        path.join(
          sharedCacheRoot,
          entry.name,
          "EVE.app",
          "Contents",
          "Resources",
          "build",
        ),
        sharedCacheRoot,
        entry.name,
        path.basename(root).toLowerCase() === "sharedcache" ? path.dirname(root) : root,
      );
      // Some launcher caches contain a direct Windows channel beside ResFiles.
      add(
        path.join(sharedCacheRoot, entry.name),
        sharedCacheRoot,
        entry.name,
        path.basename(root).toLowerCase() === "sharedcache" ? path.dirname(root) : root,
      );
    }
  }

  // Current Windows launcher layout:
  //   <root>/<channel> (for example stillness), with <root>/ResFiles.
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) {
      continue;
    }
    add(path.join(root, entry.name), root, entry.name, root);
  }

  return layouts;
}

function likelyClientRoots({
  platform = process.platform,
  env = process.env,
  homeDirectory = os.homedir(),
} = {}) {
  const explicitEnvironmentRoots = [
    env.EVEJS_FRONTIER_CLIENT_ROOT,
    env.EVE_FRONTIER_CLIENT_ROOT,
  ];
  if (platform === "darwin") {
    return uniquePaths([
      ...explicitEnvironmentRoots,
      path.join(homeDirectory, "Library", "Application Support", "EVE Frontier"),
    ]);
  }
  if (platform === "win32") {
    const systemDrive = env.SystemDrive || path.parse(process.cwd()).root || "C:\\";
    return uniquePaths([
      ...explicitEnvironmentRoots,
      path.join(systemDrive, "CCP", "EVE Frontier"),
      env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "CCP", "EVE Frontier"),
      env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "EVE Frontier"),
      env.PROGRAMDATA && path.join(env.PROGRAMDATA, "CCP", "EVE Frontier"),
      env.ProgramFiles && path.join(env.ProgramFiles, "EVE Frontier"),
      env["ProgramFiles(x86)"] && path.join(env["ProgramFiles(x86)"], "EVE Frontier"),
      path.join(homeDirectory, "AppData", "Local", "CCP", "EVE Frontier"),
    ]);
  }
  return uniquePaths(explicitEnvironmentRoots);
}

function discoverFrontierClients({ clientRoot = null, roots = null } = {}) {
  const searchRoots = clientRoot
    ? [path.resolve(clientRoot)]
    : (roots ? uniquePaths(roots) : likelyClientRoots());
  const candidates = [];
  const errors = [];
  const seenBuildRoots = new Set();

  for (const root of searchRoots) {
    for (const layout of enumerateLayoutCandidates(root)) {
      try {
        const candidate = validateClientLayout(layout);
        const identity = pathIdentity(candidate.buildRoot);
        if (!seenBuildRoots.has(identity)) {
          seenBuildRoots.add(identity);
          candidates.push(candidate);
        }
      } catch (error) {
        errors.push(`${layout.buildRoot}: ${error.message}`);
      }
    }
  }

  if (candidates.length === 0) {
    const searched = searchRoots.length > 0 ? searchRoots.join(", ") : "(none)";
    const detail = errors.length > 0 ? `\n${errors.join("\n")}` : "";
    throw new Error(`No complete installed Frontier client found. Searched: ${searched}${detail}`);
  }

  return candidates.sort((left, right) => {
    const buildOrder = right.build - left.build;
    return buildOrder || left.buildRoot.localeCompare(right.buildRoot);
  });
}

function selectBuild(candidates, requestedBuild = null) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new Error("No installed Frontier client builds are available");
  }
  let selectedBuild = requestedBuild;
  if (selectedBuild == null) {
    selectedBuild = Math.max(...candidates.map((candidate) => Number(candidate.build)));
  }
  const matches = candidates.filter(
    (candidate) => Number(candidate.build) === Number(selectedBuild),
  );
  if (matches.length === 0) {
    const available = [...new Set(candidates.map((candidate) => candidate.build))]
      .sort((left, right) => right - left)
      .join(", ");
    throw new Error(
      `Frontier build ${selectedBuild} is not installed. Available builds: ${available}`,
    );
  }
  if (matches.length > 1) {
    throw new Error(
      `Frontier build ${selectedBuild} is ambiguous across equally ranked installs: ` +
        matches.map((candidate) => candidate.buildRoot).join(", "),
    );
  }
  return matches[0];
}

function publicClientRecord(candidate) {
  return {
    format: DISCOVERY_FORMAT,
    platform: candidate.platform,
    layout: candidate.layout,
    clientRoot: candidate.clientRoot,
    cacheRoot: candidate.cacheRoot,
    channel: candidate.channel,
    buildRoot: candidate.buildRoot,
    resFilesRoot: candidate.resFilesRoot,
    nativeBlueName: candidate.nativeBlueName,
    metadata: candidate.metadata,
    files: candidate.files,
  };
}

export {
  DISCOVERY_FORMAT,
  REQUIRED_BUILD_FILES,
  discoverFrontierClients,
  enumerateLayoutCandidates,
  likelyClientRoots,
  publicClientRecord,
  selectBuild,
  validateClientLayout,
};
