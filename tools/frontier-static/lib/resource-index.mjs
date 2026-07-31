import fs from "node:fs";
import path from "node:path";

export function parseResourceIndex(text) {
  const entries = new Map();
  const lines = String(text).split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) {
      continue;
    }

    const fields = line.split(",");
    if (fields.length !== 5) {
      throw new Error(`Malformed resource index line ${index + 1}: expected 5 fields`);
    }

    const [logicalPath, cachePath, sourceHash, unpackedSizeText, packedSizeText] = fields;
    if (!logicalPath.startsWith("res:/")) {
      throw new Error(`Malformed resource index line ${index + 1}: invalid logical path`);
    }
    if (!/^[0-9a-f]{2}\/[0-9a-f_]+$/i.test(cachePath)) {
      throw new Error(`Malformed resource index line ${index + 1}: invalid cache path`);
    }
    if (entries.has(logicalPath)) {
      throw new Error(`Duplicate resource index entry: ${logicalPath}`);
    }

    const unpackedSize = Number(unpackedSizeText);
    const packedSize = Number(packedSizeText);
    if (!Number.isSafeInteger(unpackedSize) || unpackedSize < 0 ||
        !Number.isSafeInteger(packedSize) || packedSize < 0) {
      throw new Error(`Malformed resource index line ${index + 1}: invalid size`);
    }

    entries.set(logicalPath, {
      logicalPath,
      cachePath,
      sourceHash,
      unpackedSize,
      packedSize,
    });
  }

  return entries;
}

export function readResourceIndex(indexPath) {
  return parseResourceIndex(fs.readFileSync(indexPath, "utf8"));
}

export function resolveIndexedResource(entries, logicalPath, resFilesRoot) {
  const entry = entries.get(logicalPath);
  if (!entry) {
    throw new Error(`Required Frontier resource is not indexed: ${logicalPath}`);
  }

  const root = path.resolve(resFilesRoot);
  const physicalPath = path.resolve(root, entry.cachePath);
  if (!physicalPath.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Indexed resource escapes ResFiles: ${logicalPath}`);
  }
  if (!fs.existsSync(physicalPath) || !fs.statSync(physicalPath).isFile()) {
    throw new Error(`Indexed Frontier resource is missing: ${logicalPath} -> ${physicalPath}`);
  }
  const actualSize = fs.statSync(physicalPath).size;
  if (actualSize !== entry.unpackedSize) {
    throw new Error(
      `Indexed Frontier resource size mismatch: ${logicalPath} ` +
      `(expected ${entry.unpackedSize}, found ${actualSize})`,
    );
  }

  return { ...entry, physicalPath };
}
