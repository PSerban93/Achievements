const fs = require("fs");
const path = require("path");

function sanitizeConfigName(raw) {
  const value = String(raw || "")
    .replace(/[\/\\:*?"<>|]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/, "");
  const base = value || "config";
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(base)
    ? `_${base}`
    : base;
}

function sanitizeOptionalConfigName(raw) {
  const value = String(raw ?? "").trim();
  return value ? sanitizeConfigName(value) : "";
}

function normalizeRawConfigBase(raw) {
  const value = String(raw || "").trim();
  return value.toLowerCase().endsWith(".json") ? value.slice(0, -5) : value;
}

function isSafeExistingBaseName(value) {
  if (!value || value === "." || value === "..") return false;
  if (value !== path.basename(value)) return false;
  return !/[\/\\:*?"<>|\u0000-\u001f]/.test(value);
}

function resolveConfigJsonPath(configsDir, rawName) {
  if (!configsDir) return null;

  const rawBase = normalizeRawConfigBase(rawName);
  const canonicalBase = sanitizeConfigName(rawBase);
  if (!canonicalBase) return null;

  // Preserve compatibility with already-created valid filenames whose spacing
  // differs from the canonical form.
  if (isSafeExistingBaseName(rawBase)) {
    const exactPath = path.join(configsDir, `${rawBase}.json`);
    try {
      if (fs.existsSync(exactPath)) return exactPath;
    } catch {}
  }

  const canonicalPath = path.join(configsDir, `${canonicalBase}.json`);
  try {
    if (fs.existsSync(canonicalPath)) return canonicalPath;
  } catch {}

  // A legacy filename such as "Game  Name.json" canonicalizes to the same
  // value as "Game Name". Use it only when the match is unambiguous.
  try {
    const canonicalKey = canonicalBase.toLowerCase();
    const matches = fs
      .readdirSync(configsDir, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isFile() && entry.name.toLowerCase().endsWith(".json"),
      )
      .filter((entry) => {
        const base = entry.name.slice(0, -5);
        return sanitizeConfigName(base).toLowerCase() === canonicalKey;
      });
    if (matches.length === 1) {
      return path.join(configsDir, matches[0].name);
    }
  } catch {}

  // Callers that create or wait for a config still receive the canonical path.
  return canonicalPath;
}

module.exports = {
  resolveConfigJsonPath,
  sanitizeConfigName,
  sanitizeOptionalConfigName,
};
