import fs from "node:fs";

export function parseStartIni(text) {
  const values = {};
  let section = "";

  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith(";") || line.startsWith("#")) {
      continue;
    }
    const sectionMatch = line.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      section = sectionMatch[1].trim().toLowerCase();
      continue;
    }
    const separator = line.indexOf("=");
    if (separator < 1) {
      continue;
    }
    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    values[section ? `${section}.${key}` : key] = value;
  }

  return values;
}

export function readStartIni(startIniPath) {
  return parseStartIni(fs.readFileSync(startIniPath, "utf8"));
}
