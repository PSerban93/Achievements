const fs = require("fs");
const path = require("path");
const { createLogger } = require("./logger");
const {
  parsePs4TrophySetDir,
  buildSchemaFromPs4,
  buildSnapshotFromPs4,
  PS4_LANG_MAP,
} = require("./shadps4-trophy");

const autoConfigLogger = createLogger("autoconfig");
const schemaLogger = createLogger("achschema");

const PS4_CONFIG_FIELDS = [
  "name",
  "displayName",
  "appid",
  "platform",
  "config_path",
  "save_path",
  "trophy_path",
  "executable",
  "arguments",
  "process_name",
];

function normalizeComparableValue(key, value) {
  if (value === undefined || value === null) return "";
  if (key === "platform") return String(value).toLowerCase();
  if (
    key === "config_path" ||
    key === "save_path" ||
    key === "trophy_path" ||
    key === "executable"
  ) {
    return path.normalize(String(value));
  }
  return String(value);
}

function hasConfigChanges(prev, next) {
  for (const key of PS4_CONFIG_FIELDS) {
    const a = normalizeComparableValue(key, prev?.[key]);
    const b = normalizeComparableValue(key, next?.[key]);
    if (a !== b) return true;
  }
  return false;
}

function sanitizeConfigName(raw) {
  const s = String(raw || "")
    .replace(/[\/\\:*?"<>|]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/, "");
  const base = s || "config";
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(base)
    ? `_${base}`
    : base;
}

function ensurePs4DisplayName(title) {
  const base = String(title || "").trim();
  if (!base) return "Unknown Game (PS4)";
  return /\(ps4\)\s*$/i.test(base) ? base : `${base} (PS4)`;
}

function ensureLangObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return { ...value };
  }
  if (typeof value === "string") return { english: value };
  return {};
}

function mergeLangObject(existingValue, incomingValue) {
  const existing = ensureLangObject(existingValue);
  const incoming = ensureLangObject(incomingValue);
  const merged = { ...existing };
  for (const [key, val] of Object.entries(incoming)) {
    if (val !== undefined && val !== null && String(val).length > 0) {
      merged[key] = val;
    }
  }
  return merged;
}

function hasAllLanguages(entries, langKeys) {
  if (!Array.isArray(entries) || !entries.length) return false;
  const keys = Array.isArray(langKeys) ? langKeys : [];
  if (!keys.length) return false;
  const hasKey = (obj, key) =>
    obj &&
    typeof obj === "object" &&
    Object.prototype.hasOwnProperty.call(obj, key);
  for (const entry of entries) {
    const nameObj = entry?.displayName;
    const descObj = entry?.description;
    if (!nameObj || !descObj) return false;
    for (const lang of keys) {
      if (!hasKey(nameObj, lang) || !hasKey(descObj, lang)) return false;
    }
  }
  return true;
}

function writeSchemaAssets(schemaDir, parsed) {
  fs.mkdirSync(schemaDir, { recursive: true });
  const imgDir = path.join(schemaDir, "img");
  fs.mkdirSync(imgDir, { recursive: true });

  // Copy ICON0 and TROP*.PNG
  const iconFiles = fs.existsSync(parsed.iconsDir)
    ? fs.readdirSync(parsed.iconsDir)
    : [];
  for (const f of iconFiles) {
    const src = path.join(parsed.iconsDir, f);
    const dst = path.join(imgDir, f);
    if (!fs.existsSync(dst)) fs.copyFileSync(src, dst);
  }

  const entries = buildSchemaFromPs4(parsed);
  fs.writeFileSync(
    path.join(schemaDir, "achievements.json"),
    JSON.stringify(entries, null, 2),
    "utf8"
  );
  schemaLogger.info("ps4:schema:written", {
    appid: String(parsed.appid || ""),
    dir: schemaDir,
    achievements: entries.length,
  });
  return entries;
}

function updateSchemaFromPs4(schemaDir, parsed) {
  if (!schemaDir || !parsed) return { updated: false, added: 0, entries: [] };
  const schemaPath = path.join(schemaDir, "achievements.json");
  if (!fs.existsSync(schemaPath))
    return { updated: false, added: 0, entries: [] };

  let entries;
  try {
    entries = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
  } catch {
    return { updated: false, added: 0, entries: [] };
  }
  if (!Array.isArray(entries)) return { updated: false, added: 0, entries: [] };

  const incoming = buildSchemaFromPs4(parsed);
  const entryByName = new Map();
  for (const entry of entries) {
    entryByName.set(entry.name, entry);
  }

  let updated = false;
  let added = 0;
  let changed = 0;

  for (const inc of incoming) {
    const existing = entryByName.get(inc.name);
    if (!existing) {
      entries.push(inc);
      entryByName.set(inc.name, inc);
      added += 1;
      updated = true;
      continue;
    }
    const mergedName = mergeLangObject(existing.displayName, inc.displayName);
    const mergedDesc = mergeLangObject(existing.description, inc.description);
    if (JSON.stringify(existing.displayName) !== JSON.stringify(mergedName)) {
      existing.displayName = mergedName;
      updated = true;
      changed += 1;
    }
    if (JSON.stringify(existing.description) !== JSON.stringify(mergedDesc)) {
      existing.description = mergedDesc;
      updated = true;
      changed += 1;
    }
    if (existing.hidden !== inc.hidden) {
      existing.hidden = inc.hidden;
      updated = true;
      changed += 1;
    }
    if (existing.trophyType !== inc.trophyType) {
      existing.trophyType = inc.trophyType;
      updated = true;
      changed += 1;
    }
    if (existing.imageId !== inc.imageId) {
      existing.imageId = inc.imageId;
      updated = true;
      changed += 1;
    }
    // icon/icon_gray not overwritten (icons already local)
  }

  if (updated) {
    fs.writeFileSync(schemaPath, JSON.stringify(entries, null, 2), "utf8");
  }

  const hasSchemaChanges = updated || added > 0 || changed > 0;
  if (hasSchemaChanges) {
    schemaLogger.info("ps4:schema:updated", {
      appid: String(parsed.appid || ""),
      dir: schemaDir,
      updated,
      added,
      changed,
      total: entries.length,
      incoming: incoming.length,
    });
  }

  return { updated, added, entries };
}

function findExistingPs4Config(configsDir, appid) {
  if (!fs.existsSync(configsDir)) return null;
  const files = fs
    .readdirSync(configsDir)
    .filter((f) => f.toLowerCase().endsWith(".json"));
  for (const file of files) {
    const full = path.join(configsDir, file);
    try {
      const data = JSON.parse(fs.readFileSync(full, "utf8"));
      if (
        String(data?.appid || "").trim() === String(appid) &&
        String(data?.platform || "").toLowerCase() === "shadps4"
      ) {
        return { filePath: full, data };
      }
    } catch {}
  }
  return null;
}

async function generateConfigFromPs4Dir(trophyDir, configsDir, options = {}) {
  const appidFromDir = path.basename(
    path.dirname(path.dirname(trophyDir)) || trophyDir
  );
  let parsed;
  try {
    parsed = parsePs4TrophySetDir(trophyDir);
  } catch (err) {
    autoConfigLogger.error("ps4:trophy:parse:failed", {
      appid: appidFromDir,
      path: trophyDir,
      error: err?.message || String(err),
    });
    throw err;
  }

  const baseAppId =
    parsed?.appid || path.basename(path.dirname(path.dirname(trophyDir)));
  parsed.appid = baseAppId;
  const title = parsed.title || baseAppId;
  const trophyCount = parsed.trophies?.length || 0;
  const snapshot = buildSnapshotFromPs4(parsed);
  const schemaRoot = options.schemaRoot || path.join(configsDir, "schema");
  const schemaDir = path.join(schemaRoot, "shadps4", String(baseAppId));

  if (trophyCount === 0) {
    return {
      skipped: true,
      appid: String(baseAppId),
      title,
      reason: "no-trophies",
    };
  }

  const existing = findExistingPs4Config(configsDir, baseAppId);
  const existingName = existing
    ? path.basename(existing.filePath, ".json")
    : "";
  const configName = existingName
    ? sanitizeConfigName(existingName)
    : sanitizeConfigName(ensurePs4DisplayName(title));
  const configPath = path.join(configsDir, `${configName}.json`);

  fs.mkdirSync(schemaDir, { recursive: true });
  const schemaPath = path.join(schemaDir, "achievements.json");
  let schemaReady = false;
  let added = 0;
  let currentEntries = [];
  if (fs.existsSync(schemaPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
      schemaReady = Array.isArray(raw) && raw.length > 0;
    } catch {
      schemaReady = false;
    }
  }
  if (schemaReady) {
    const res = updateSchemaFromPs4(schemaDir, parsed);
    added = res.added || 0;
    currentEntries = res.entries || [];
  } else {
    currentEntries = writeSchemaAssets(schemaDir, parsed);
    added = currentEntries.length;
  }

  const payload = {
    name: configName,
    displayName: ensurePs4DisplayName(title),
    appid: String(baseAppId),
    platform: "shadps4",
    config_path: schemaDir,
    save_path: trophyDir,
    trophy_path: trophyDir,
    executable: "",
    arguments: "",
    process_name: "",
  };

  let created = true;
  if (existing) {
    created = false;
    const merged = { ...existing.data, ...payload };
    if (!payload.executable && existing.data?.executable) {
      merged.executable = existing.data.executable;
    }
    if (!payload.arguments && existing.data?.arguments) {
      merged.arguments = existing.data.arguments;
    }
    if (!payload.process_name && existing.data?.process_name) {
      merged.process_name = existing.data.process_name;
    }
    if (hasConfigChanges(existing.data, merged)) {
      fs.writeFileSync(existing.filePath, JSON.stringify(merged, null, 2));
      autoConfigLogger.info("ps4:config:updated", {
        appid: baseAppId,
        name: merged.name,
        filePath: existing.filePath,
        schemaDir,
      });
    }
    return {
      ...merged,
      configPath: existing.filePath,
      created,
      snapshot,
    };
  }

  fs.writeFileSync(configPath, JSON.stringify(payload, null, 2));
  autoConfigLogger.info("ps4:config:created", {
    appid: baseAppId,
    name: payload.name,
    filePath: configPath,
    schemaDir,
  });
  return { ...payload, configPath, created, snapshot };
}

module.exports = {
  generateConfigFromPs4Dir,
  updateSchemaFromPs4,
  buildSnapshotFromPs4,
};
