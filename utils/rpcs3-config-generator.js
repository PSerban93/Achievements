const fs = require("fs");
const path = require("path");
const { createLogger } = require("./logger");
const {
  parseTrophySetDir,
  buildSnapshotFromTrophy,
  buildSchemaFromTrophy,
} = require("./rpcs3-trophy");
const {
  fetchExophaseAchievementsMultiLang,
  EXOPHASE_LANG_KEYS,
  EXOPHASE_LANG_MAP,
  buildExophaseSlugVariants,
  downloadExophaseIcon,
} = require("./exophase-scraper");

const autoConfigLogger = createLogger("autoconfig");
const schemaLogger = createLogger("achschema");

const RPCS3_CONFIG_FIELDS = [
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
  for (const key of RPCS3_CONFIG_FIELDS) {
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

function findExistingRpcs3Config(configsDir, appid) {
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
        String(data?.platform || "").toLowerCase() === "rpcs3"
      ) {
        return { filePath: full, data };
      }
    } catch {}
  }
  return null;
}

function ensureUniqueConfigName(baseName) {
  let name = sanitizeConfigName(baseName);
  if (!name) name = "config";
  let base = name.replace(/\s*\(rpcs3(?:\s+\d+)?\)\s*$/i, "");
  if (!base) base = name || "config";
  return `${base} (RPCS3)`;
}

function ensureRpcs3DisplayName(title) {
  const base = String(title || "").trim();
  if (!base) return "Unknown Game (RPCS3)";
  return /\(rpcs3\)\s*$/i.test(base) ? base : `${base} (RPCS3)`;
}

function resolveFallbackIconPath(parsed) {
  const fallback = parsed?.fallbackIconName || "";
  return fallback ? `img/${fallback}` : "";
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
  const hasExtraLangs = Object.keys(existing).some((key) => key !== "english");
  for (const [key, val] of Object.entries(incoming)) {
    if (key === "english" && hasExtraLangs && existing.english) continue;
    if (val !== undefined && val !== null && String(val).length > 0) {
      merged[key] = val;
    }
  }
  return merged;
}

function getLangValue(value, lang = "english") {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    if (value[lang]) return value[lang];
    const first = Object.values(value).find(
      (v) => typeof v === "string" && v
    );
    return first || "";
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

function hasMultiLang(entries) {
  if (!Array.isArray(entries) || !entries.length) return false;
  return entries.every((entry) => {
    const obj = entry?.displayName;
    if (!obj || typeof obj !== "object") return false;
    const keys = Object.keys(obj);
    return keys.some((k) => k !== "english");
  });
}

function copyIfMissing(src, dst) {
  if (!fs.existsSync(dst)) fs.copyFileSync(src, dst);
}

function writeSchemaAssets(schemaDir, parsed) {
  const imgDir = path.join(schemaDir, "img");
  fs.mkdirSync(imgDir, { recursive: true });

  const entries = buildSchemaFromTrophy(parsed);
  const fallbackIconPath = resolveFallbackIconPath(parsed);

  if (parsed?.fallbackIconName) {
    const src = path.join(parsed.trophyDir, parsed.fallbackIconName);
    const dst = path.join(imgDir, parsed.fallbackIconName);
    if (fs.existsSync(src)) copyIfMissing(src, dst);
  }

  for (const entry of entries) {
    const trophyId = entry?.imageId;
    if (trophyId === undefined || trophyId === null) {
      entry.icon = "";
      entry.icon_gray = fallbackIconPath;
      continue;
    }
    const pad = String(trophyId).padStart(3, "0");
    const iconName =
      parsed?.iconFiles?.get(Number(trophyId)) || `TROP${pad}.PNG`;
    const iconSrc = path.join(parsed.trophyDir, iconName);
    const iconDst = path.join(imgDir, iconName);
    if (fs.existsSync(iconSrc)) copyIfMissing(iconSrc, iconDst);
    entry.icon = `img/${iconName}`;
    entry.icon_gray = fallbackIconPath;
  }

  fs.writeFileSync(
    path.join(schemaDir, "achievements.json"),
    JSON.stringify(entries, null, 2),
    "utf8"
  );

  schemaLogger.info("rpcs3:schema:written", {
    appid: String(parsed?.appid || ""),
    dir: schemaDir,
    achievements: entries.length,
  });

  return entries;
}

async function enrichSchemaFromExophase(schemaDir, parsed, exoData) {
  if (!schemaDir || !parsed || !exoData) {
    return { updated: false, matched: 0, icons: 0 };
  }
  const schemaPath = path.join(schemaDir, "achievements.json");
  if (!fs.existsSync(schemaPath)) return { updated: false, matched: 0, icons: 0 };

  let entries;
  try {
    entries = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
  } catch {
    return { updated: false, matched: 0, icons: 0 };
  }
  if (!Array.isArray(entries) || !entries.length) {
    return { updated: false, matched: 0, icons: 0 };
  }

  const items = exoData.items || [];
  if (!items.length) return { updated: false, matched: 0, icons: 0 };

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

  for (const item of items) {
    const titles = item?.titles || {};
    const descriptions = item?.descriptions || {};
    for (const langKey of Object.keys(titles)) {
      const title = titles[langKey] || "";
      const desc = descriptions[langKey] || "";
      const key = buildMatchKey(title, desc);
      register(keyMap, keyDupes, key, item);
      const titleKey = normalizeMatchText(title);
      register(titleMap, titleDupes, titleKey, item);
    }
  }

  if (keyDupes.size || titleDupes.size) {
    schemaLogger.warn("rpcs3:exophase:duplicates", {
      appid: String(parsed?.appid || ""),
      keyDuplicates: keyDupes.size,
      titleDuplicates: titleDupes.size,
    });
  }

  let updated = false;
  let matched = 0;
  let iconsSaved = 0;

  for (const entry of entries) {
    const title = getLangValue(entry.displayName, "english");
    const desc = getLangValue(entry.description, "english");
    let match = null;
    const key = buildMatchKey(title, desc);
    if (key && !keyDupes.has(key)) {
      match = keyMap.get(key) || null;
    }
    if (!match) {
      const titleKey = normalizeMatchText(title);
      if (titleKey && !titleDupes.has(titleKey)) {
        match = titleMap.get(titleKey) || null;
      }
    }
    if (!match) continue;

    matched += 1;
    const beforeName = JSON.stringify(entry.displayName);
    const beforeDesc = JSON.stringify(entry.description);
    const display = mergeLangObject(entry.displayName, match.titles);
    const descMerged = mergeLangObject(entry.description, match.descriptions);

    if (beforeName !== JSON.stringify(display)) {
      entry.displayName = display;
      updated = true;
    }
    if (beforeDesc !== JSON.stringify(descMerged)) {
      entry.description = descMerged;
      updated = true;
    }

    // Icon handling pentru RPCS3 rămâne nativ (TROP*.PNG); nu suprascriem cu Exophase.
  }

  if (updated) {
    fs.writeFileSync(schemaPath, JSON.stringify(entries, null, 2), "utf8");
  }

  return { updated, matched, icons: iconsSaved };
}

function updateSchemaFromTrophy(schemaDir, parsed) {
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

  const imgDir = path.join(schemaDir, "img");
  fs.mkdirSync(imgDir, { recursive: true });

  const fallbackIconPath = resolveFallbackIconPath(parsed);
  if (parsed?.fallbackIconName) {
    const src = path.join(parsed.trophyDir, parsed.fallbackIconName);
    const dst = path.join(imgDir, parsed.fallbackIconName);
    if (fs.existsSync(src)) copyIfMissing(src, dst);
  }

  let updated = false;
  let added = 0;
  let changed = 0;

  const incoming = buildSchemaFromTrophy(parsed);
  const entryByName = new Map();
  for (const entry of entries) {
    const key = entry?.name != null ? String(entry.name) : "";
    if (key) entryByName.set(key, entry);
  }

  for (const inc of incoming) {
    const key = inc?.name != null ? String(inc.name) : "";
    if (!key) continue;
    const existing = entryByName.get(key);
    if (!existing) {
      entries.push(inc);
      entryByName.set(key, inc);
      updated = true;
      added += 1;
      continue;
    }
    const mergedName = mergeLangObject(existing.displayName, inc.displayName);
    if (JSON.stringify(existing.displayName) !== JSON.stringify(mergedName)) {
      existing.displayName = mergedName;
      updated = true;
      changed += 1;
    }
    const mergedDesc = mergeLangObject(
      existing.description,
      inc.description
    );
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
  }

  for (const entry of entries) {
    const trophyId = entry?.imageId;
    if (trophyId === undefined || trophyId === null) {
      continue;
    }
    // nu atingem icon/icon_gray; ele rămân cele din schema existentă (sau exophase)
  }

  if (updated) {
    fs.writeFileSync(schemaPath, JSON.stringify(entries, null, 2), "utf8");
  }

  const hasSchemaChanges = updated || added > 0 || changed > 0;
  if (hasSchemaChanges) {
    schemaLogger.info("rpcs3:schema:updated", {
      appid: String(parsed?.appid || ""),
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

async function generateConfigFromTrophyDir(trophyDir, configsDir, options = {}) {
  const appid = path.basename(trophyDir);
  const bootMode = options.bootMode === true;
  let parsed;
  try {
    parsed = parseTrophySetDir(trophyDir);
  } catch (err) {
    autoConfigLogger.error("rpcs3:trophy:parse:failed", {
      appid,
      path: trophyDir,
      error: err?.message || String(err),
    });
    throw err;
  }

  parsed.appid = appid;
  const title = parsed.title || appid;
  const trophyCount = parsed.trophies?.length || 0;
  const snapshot = buildSnapshotFromTrophy(parsed);
  const schemaRoot = options.schemaRoot || path.join(configsDir, "schema");
  const schemaDir = path.join(schemaRoot, "rpcs3", String(appid));

  if (trophyCount === 0) {
    return { skipped: true, appid, title, reason: "no-trophies" };
  }

  const existing = findExistingRpcs3Config(configsDir, appid);
  const existingName = existing
    ? path.basename(existing.filePath, ".json")
    : "";
  const configName = existingName
    ? sanitizeConfigName(existingName)
    : ensureUniqueConfigName(title || appid);
  const configPath = path.join(configsDir, `${configName}.json`);

  fs.mkdirSync(schemaDir, { recursive: true });
  const schemaPath = path.join(schemaDir, "achievements.json");
  let schemaReady = false;
  let schemaChanged = false;
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
    const res = updateSchemaFromTrophy(schemaDir, parsed);
    schemaChanged = !!res.updated;
    added = res.added || 0;
    currentEntries = res.entries || [];
  } else {
    currentEntries = writeSchemaAssets(schemaDir, parsed);
    schemaChanged = true;
    added = currentEntries.length;
  }

  // Enrich with Exophase (multilang trophies) – keep RPCS3 isolated from other platforms
  if (trophyCount > 0) {
    let skipExo = false;
    if (bootMode && !schemaChanged) {
      schemaLogger.info("rpcs3:exophase:skip", {
        appid: String(appid),
        reason: "schema-unchanged-boot",
      });
      skipExo = true;
    }
    try {
      if (
        added === 0 &&
        currentEntries.length > 0 &&
        hasAllLanguages(currentEntries, EXOPHASE_LANG_KEYS)
      ) {
        schemaLogger.info("rpcs3:exophase:skip", {
          appid: String(appid),
          reason: "languages-complete",
        });
        skipExo = true;
      }
    } catch {}
    // dacă nu am adăugat entry-uri noi și deja avem cel puțin o limbă non-english pe fiecare, sărim
    if (!skipExo && (added > 0 || !hasMultiLang(currentEntries))) {
    const variants = buildExophaseSlugVariants(title || appid);
    const slugCandidates = Array.from(
      new Set([
        ...variants,
        ...variants.map((s) => `${s}-ps3`),
        ...variants.map((s) => `${s}-psn`),
      ]),
    );
    if (slugCandidates.length) {
      schemaLogger.info("rpcs3:exophase:start", {
        appid: String(appid),
        slug: slugCandidates[0],
        platform: "rpcs3",
        variants: slugCandidates.length,
      });
      let merged = false;
      let usedSlug = slugCandidates[0];
      let lastError = null;
      let exoData = null;
      for (const candidate of slugCandidates) {
        try {
          exoData = await fetchExophaseAchievementsMultiLang({
            slug: candidate,
            platform: "rpcs3",
            langKeys: EXOPHASE_LANG_KEYS,
            langMap: EXOPHASE_LANG_MAP,
            logger: schemaLogger,
          });
      const mergeRes = await enrichSchemaFromExophase(
        schemaDir,
        parsed,
        exoData
      );
      merged = mergeRes?.updated || mergeRes?.matched > 0;
      if (merged) schemaChanged = true;
      usedSlug = candidate;
      break;
        } catch (err) {
          lastError = err;
          schemaLogger.warn("rpcs3:exophase:retry", {
            appid: String(appid),
            slug: candidate,
            platform: "rpcs3",
            error: err?.message || String(err),
          });
        }
      }
      if (merged) {
        if (usedSlug !== slugCandidates[0]) {
          schemaLogger.info("rpcs3:exophase:alt-slug", {
            appid: String(appid),
            slug: usedSlug,
            platform: "rpcs3",
          });
        }
        schemaLogger.info("rpcs3:exophase:merged", {
          appid: String(appid),
          slug: usedSlug,
          expected: trophyCount,
        });
      } else if (lastError) {
        schemaLogger.warn("rpcs3:exophase:failed", {
          appid: String(appid),
          slug: slugCandidates[0],
          platform: "rpcs3",
          error: lastError?.message || String(lastError),
          tried: slugCandidates,
        });
      }
    }
    }
  }

  const payload = {
    name: configName,
    displayName: ensureRpcs3DisplayName(title),
    appid: String(appid),
    platform: "rpcs3",
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
    const configUpdated = hasConfigChanges(existing.data, merged);
    if (configUpdated) {
      fs.writeFileSync(existing.filePath, JSON.stringify(merged, null, 2));
      autoConfigLogger.info("rpcs3:config:updated", {
        appid,
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
      schemaUpdated: schemaChanged,
      snapshot,
    };
  }

  fs.writeFileSync(configPath, JSON.stringify(payload, null, 2));
  autoConfigLogger.info("rpcs3:config:created", {
    appid,
    name: payload.name,
    filePath: configPath,
    schemaDir,
  });
  return {
    ...payload,
    configPath,
    created,
    configUpdated: true,
    schemaUpdated: schemaChanged,
    snapshot,
  };
}

module.exports = { generateConfigFromTrophyDir, updateSchemaFromTrophy };
