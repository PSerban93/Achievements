const fs = require("fs");
const path = require("path");
const { createLogger } = require("./logger");
const {
  parsePs4TrophySetDir,
  buildSchemaFromPs4,
  buildSnapshotFromPs4,
  buildSnapshotFromPs4ProgressFile,
  PS4_LANG_MAP,
} = require("./shadps4-trophy");
const { writeAchievementPercentagesSidecar } = require("./achievement-rarity");
const {
  EXOPHASE_LANG_MAP,
  EXOPHASE_RARITY_SOURCE,
  buildExophaseSlugVariants,
  fetchExophaseAchievementsMultiLang,
} = require("./exophase-scraper");

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
  "shadps4_npcommid",
  "shadps4_schema_path",
  "shadps4_progress_path",
  "shadps4_user_id",
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

function normalizeExophaseRarityPct(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") {
    return Number.isFinite(value)
      ? Number(Math.min(100, Math.max(0, value)).toFixed(4))
      : null;
  }
  const raw = String(value || "")
    .replace(",", ".")
    .trim();
  if (!raw) return null;
  const match = raw.match(/(\d+(?:\.\d+)?)/);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed)
    ? Number(Math.min(100, Math.max(0, parsed)).toFixed(4))
    : null;
}

function hasAllRarityPct(entries) {
  if (!Array.isArray(entries) || !entries.length) return false;
  return entries.every(
    (entry) => normalizeExophaseRarityPct(entry?.rarityPct) !== null,
  );
}

function getLangValue(value, lang = "english") {
  if (typeof value === "string" || typeof value === "number") {
    return String(value).trim();
  }
  if (value && typeof value === "object") {
    return (
      String(value[lang] || "").trim() ||
      Object.values(value)
        .map((v) =>
          typeof v === "string" || typeof v === "number"
            ? String(v).trim()
            : "",
        )
        .find(Boolean) ||
      ""
    );
  }
  return "";
}

function normalizeMatchText(value) {
  if (!value) return "";
  return String(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function buildMatchKey(title, description) {
  const t = normalizeMatchText(title);
  if (!t) return "";
  const d = normalizeMatchText(description);
  return `${t}|${d}`;
}

function buildRarityEntries(entries) {
  const out = [];
  const seen = new Set();
  for (const entry of Array.isArray(entries) ? entries : []) {
    const name =
      typeof entry?.name === "string" || typeof entry?.name === "number"
        ? String(entry.name).trim()
        : "";
    if (!name || seen.has(name)) continue;
    const percent = normalizeExophaseRarityPct(entry?.rarityPct);
    if (percent === null) continue;
    seen.add(name);
    out.push({ name, percent });
  }
  out.sort((a, b) =>
    String(a.name).localeCompare(String(b.name), undefined, {
      sensitivity: "base",
      numeric: true,
    }),
  );
  return out;
}

function writeExophaseRaritySidecar(schemaDir, appid, entries) {
  const achievements = buildRarityEntries(entries);
  if (!schemaDir || !achievements.length) {
    return { written: false, matched: 0, sidecarPath: "" };
  }
  const sidecarPath = writeAchievementPercentagesSidecar(
    schemaDir,
    appid,
    achievements,
    { source: EXOPHASE_RARITY_SOURCE },
  );
  return { written: true, matched: achievements.length, sidecarPath };
}

function buildPs4ExophaseSlugCandidates(title, appid = "") {
  const cleaned = String(title || appid || "")
    .replace(/\s*\((?:PS4|shadps4)\)\s*$/i, "")
    .replace(/[™®©]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const variants = buildExophaseSlugVariants(cleaned || appid);
  return Array.from(
    new Set([
      ...variants,
      ...variants.map((slug) => `${slug}-ps4`),
    ]),
  );
}

async function enrichSchemaRarityFromExophase(schemaDir, parsed) {
  if (!schemaDir || !parsed) return { updated: false, matched: 0, fetched: 0 };
  const schemaPath = path.join(schemaDir, "achievements.json");
  if (!fs.existsSync(schemaPath)) return { updated: false, matched: 0, fetched: 0 };

  let entries;
  try {
    entries = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
  } catch {
    return { updated: false, matched: 0, fetched: 0 };
  }
  if (!Array.isArray(entries) || !entries.length) {
    return { updated: false, matched: 0, fetched: 0 };
  }
  if (hasAllRarityPct(entries)) {
    schemaLogger.info("ps4:exophase:skip", {
      appid: String(parsed?.appid || ""),
      reason: "rarity-complete",
    });
    return { updated: false, matched: entries.length, fetched: entries.length };
  }

  const slugCandidates = buildPs4ExophaseSlugCandidates(
    parsed?.title || parsed?.appid,
    parsed?.appid,
  );
  let exoData = null;
  let usedSlug = slugCandidates[0] || "";
  let lastError = null;
  schemaLogger.info("ps4:exophase:start", {
    appid: String(parsed?.appid || ""),
    slug: usedSlug,
    platform: "ps4",
    variants: slugCandidates.length,
  });
  for (const slug of slugCandidates) {
    try {
      exoData = await fetchExophaseAchievementsMultiLang({
        slug,
        platform: "shadps4",
        langKeys: ["english"],
        langMap: EXOPHASE_LANG_MAP,
        logger: schemaLogger,
      });
      usedSlug = slug;
      break;
    } catch (err) {
      lastError = err;
      schemaLogger.warn("ps4:exophase:retry", {
        appid: String(parsed?.appid || ""),
        slug,
        platform: "ps4",
        error: err?.message || String(err),
      });
    }
  }
  if (!exoData) {
    schemaLogger.warn("ps4:exophase:failed", {
      appid: String(parsed?.appid || ""),
      slug: slugCandidates[0] || "",
      platform: "ps4",
      error: lastError?.message || String(lastError || "No working Exophase URL"),
      tried: slugCandidates,
    });
    return { updated: false, matched: 0, fetched: 0 };
  }

  const keyMap = new Map();
  const keyDupes = new Set();
  const titleMap = new Map();
  const titleDupes = new Set();
  const register = (map, dupes, key, item) => {
    if (!key) return;
    const prev = map.get(key);
    if (prev && prev !== item) {
      dupes.add(key);
      return;
    }
    map.set(key, item);
  };
  for (const item of exoData.items || []) {
    const title = item?.titles?.english || "";
    const desc = item?.descriptions?.english || "";
    register(keyMap, keyDupes, buildMatchKey(title, desc), item);
    register(titleMap, titleDupes, normalizeMatchText(title), item);
  }

  let updated = false;
  let matched = 0;
  for (const entry of entries) {
    const title = getLangValue(entry.displayName, "english");
    const desc = getLangValue(entry.description, "english");
    let match = null;
    const key = buildMatchKey(title, desc);
    if (key && !keyDupes.has(key)) match = keyMap.get(key) || null;
    if (!match) {
      const titleKey = normalizeMatchText(title);
      if (titleKey && !titleDupes.has(titleKey)) {
        match = titleMap.get(titleKey) || null;
      }
    }
    const rarityPct = normalizeExophaseRarityPct(match?.rarityPct);
    if (!match || rarityPct === null) continue;
    matched += 1;
    if (entry.rarityPct !== rarityPct) {
      entry.rarityPct = rarityPct;
      updated = true;
    }
    const source = match.raritySource || EXOPHASE_RARITY_SOURCE;
    if (entry.raritySource !== source) {
      entry.raritySource = source;
      updated = true;
    }
  }

  if (updated) {
    fs.writeFileSync(schemaPath, JSON.stringify(entries, null, 2), "utf8");
  }
  const raritySidecar = writeExophaseRaritySidecar(
    schemaDir,
    String(parsed?.appid || ""),
    entries,
  );
  schemaLogger.info("ps4:exophase:merged", {
    appid: String(parsed?.appid || ""),
    slug: usedSlug,
    platform: "ps4",
    fetched: (exoData.items || []).length,
    matched,
    updated,
    raritySidecar: raritySidecar.matched,
  });
  return {
    updated,
    matched,
    fetched: (exoData.items || []).length,
    raritySidecar: raritySidecar.matched,
  };
}

function syncNativeIconAssets(schemaDir, parsed) {
  const imgDir = path.join(schemaDir, "img");
  fs.mkdirSync(imgDir, { recursive: true });
  let copied = 0;

  const iconFiles = fs.existsSync(parsed?.iconsDir)
    ? fs
        .readdirSync(parsed.iconsDir, { withFileTypes: true })
        .filter(
          (entry) =>
            entry.isFile() &&
            (entry.name.toLowerCase() === "icon0.png" ||
              /^trop\d{3}\.png$/i.test(entry.name)),
        )
        .map((entry) => entry.name)
    : [];
  for (const f of iconFiles) {
    const src = path.join(parsed.iconsDir, f);
    const dst = path.join(imgDir, f);
    if (fs.existsSync(dst)) continue;
    fs.copyFileSync(src, dst);
    copied += 1;
  }
  return copied;
}

function writeSchemaAssets(schemaDir, parsed) {
  fs.mkdirSync(schemaDir, { recursive: true });
  syncNativeIconAssets(schemaDir, parsed);

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
  const copiedAssets = syncNativeIconAssets(schemaDir, parsed);
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
    if (!String(existing.icon || "").trim() && inc.icon) {
      existing.icon = inc.icon;
      updated = true;
      changed += 1;
    }
    if (!String(existing.icon_gray || "").trim() && inc.icon_gray) {
      existing.icon_gray = inc.icon_gray;
      updated = true;
      changed += 1;
    }
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

  return {
    updated,
    added,
    entries,
    assetsUpdated: copiedAssets > 0,
    copiedAssets,
  };
}

function findExistingPs4Config(configsDir, appid, npcommid = "") {
  if (!fs.existsSync(configsDir)) return null;
  const files = fs
    .readdirSync(configsDir)
    .filter((f) => f.toLowerCase().endsWith(".json"));
  for (const file of files) {
    const full = path.join(configsDir, file);
    try {
      const data = JSON.parse(fs.readFileSync(full, "utf8"));
      const sameNpCommId =
        npcommid &&
        String(data?.shadps4_npcommid || data?.npcommid || "")
          .trim()
          .toLowerCase() === String(npcommid).trim().toLowerCase();
      if (
        String(data?.platform || "").toLowerCase() === "shadps4" &&
        (String(data?.appid || "").trim() === String(appid) || sameNpCommId)
      ) {
        return { filePath: full, data };
      }
    } catch {}
  }
  return null;
}

function getPs4CusaFromPath(inputPath) {
  const parts = String(inputPath || "").split(/[\\/]+/);
  for (let i = parts.length - 1; i >= 0; i--) {
    if (/^CUSA\d+$/i.test(parts[i] || "")) return parts[i];
  }
  return "";
}

async function generateConfigFromPs4Dir(trophyDir, configsDir, options = {}) {
  const originalTrophyDir = trophyDir;
  const cusaFromOriginalPath = getPs4CusaFromPath(originalTrophyDir);
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

  const npcommid =
    String(options.npcommid || parsed?.npcommid || path.basename(trophyDir) || "")
      .trim();
  if (npcommid) {
    try {
      const parts = String(trophyDir || "").split(/[\\/]+/);
      for (let i = parts.length - 1; i >= 0; i--) {
        if (String(parts[i] || "").toLowerCase() !== "shadps4") continue;
        const root = parts.slice(0, i + 1).join(path.sep);
        const modernTrophyDir = path.join(root, "trophy", npcommid);
        const modernXml = path.join(modernTrophyDir, "Xml", "TROP.XML");
        if (
          modernTrophyDir &&
          path.normalize(modernTrophyDir) !== path.normalize(trophyDir) &&
          fs.existsSync(modernXml)
        ) {
          trophyDir = modernTrophyDir;
          parsed = parsePs4TrophySetDir(trophyDir);
        }
        break;
      }
    } catch {}
  }
  const appidOverride = String(
    options.appid ||
      options.appidOverride ||
      options.cusa ||
      cusaFromOriginalPath ||
      "",
  ).trim();
  const parsedAppId =
    parsed?.appid && /^CUSA\d+$/i.test(String(parsed.appid))
      ? String(parsed.appid)
      : "";
  const baseAppId =
    appidOverride ||
    parsedAppId ||
    (npcommid && /^NP[A-Z0-9_]+$/i.test(npcommid) ? npcommid : "") ||
    path.basename(path.dirname(path.dirname(trophyDir)));
  parsed.appid = baseAppId;
  const title = parsed.title || baseAppId;
  const trophyCount = parsed.trophies?.length || 0;
  const progressPath = String(options.progressPath || "").trim();
  const snapshot =
    progressPath && fs.existsSync(progressPath)
      ? buildSnapshotFromPs4ProgressFile(progressPath)
      : buildSnapshotFromPs4(parsed);
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

  const existing = findExistingPs4Config(configsDir, baseAppId, npcommid);
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
  let schemaUpdated = false;
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
    schemaUpdated = !!res.updated || res.assetsUpdated === true;
    added = res.added || 0;
    currentEntries = res.entries || [];
  } else {
    currentEntries = writeSchemaAssets(schemaDir, parsed);
    schemaUpdated = true;
    added = currentEntries.length;
  }
  const shouldRefreshRarity =
    options.bootMode !== true && (added > 0 || !hasAllRarityPct(currentEntries));
  if (shouldRefreshRarity) {
    const exophaseRes = await enrichSchemaRarityFromExophase(schemaDir, parsed);
    if (exophaseRes?.updated) schemaUpdated = true;
  }

  const payload = {
    name: configName,
    displayName: ensurePs4DisplayName(title),
    appid: String(baseAppId),
    platform: "shadps4",
    config_path: schemaDir,
    save_path: progressPath || trophyDir,
    trophy_path: trophyDir,
    shadps4_npcommid: npcommid,
    shadps4_schema_path: trophyDir,
    shadps4_progress_path: progressPath,
    shadps4_user_id: String(options.userId || ""),
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
    const configUpdated = hasConfigChanges(existing.data, merged);
    if (configUpdated) {
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
      configUpdated,
      schemaUpdated,
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
  return {
    ...payload,
    configPath,
    created,
    configUpdated: true,
    schemaUpdated,
    snapshot,
  };
}

module.exports = {
  generateConfigFromPs4Dir,
  updateSchemaFromPs4,
  buildSnapshotFromPs4,
  buildSnapshotFromPs4ProgressFile,
};
