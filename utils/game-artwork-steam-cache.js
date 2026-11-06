"use strict";
const fs = require("fs"), path = require("path");

function resolveSteamOfficialLibraryCacheDir(statsDir, appid) {
  const statsPath = path.resolve(String(statsDir || ""));
  const baseName = path.basename(statsPath).toLowerCase();
  const appcacheDir =
    baseName === "stats"
      ? path.dirname(statsPath)
      : baseName === "appcache"
      ? statsPath
      : path.join(statsPath, "appcache");
  return path.join(appcacheDir, "librarycache", String(appid));
}

function listFilesRecursive(rootDir, maxDepth = 6) {
  const out = [];
  const walk = (dir, depth) => {
    if (depth > maxDepth) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
      } else if (entry.isFile()) {
        out.push(full);
      }
    }
  };
  walk(rootDir, 0);
  return out;
}

function pickSteamOfficialLibraryCacheImages(statsDir, appid) {
  const libraryCacheDir = resolveSteamOfficialLibraryCacheDir(statsDir, appid);
  if (!fs.existsSync(libraryCacheDir)) {
    return {
      libraryCacheDir,
      headerPath: "",
      portraitPath: "",
    };
  }
  const files = listFilesRecursive(libraryCacheDir, 6);
  const byName = new Map();
  for (const file of files) {
    const lower = path.basename(file).toLowerCase();
    if (!byName.has(lower)) byName.set(lower, []);
    byName.get(lower).push(file);
  }
  const first = (name) => (byName.get(name) || [])[0] || "";
  const firstMatch = (matcher) => {
    for (const [name, matches] of byName.entries()) {
      if (matcher(name)) return matches[0] || "";
    }
    return "";
  };
  const headerPath = first("header.jpg");
  const portraitPath =
    first("library_600x900.jpg") ||
    first("library_capsule.jpg") ||
    firstMatch((name) => /^library_capsule(?:_[a-z0-9]+)*\.jpg$/i.test(name));
  return {
    libraryCacheDir,
    headerPath,
    portraitPath,
  };
}

module.exports = { pick: pickSteamOfficialLibraryCacheImages };
