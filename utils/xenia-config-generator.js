const fs = require("fs");
const path = require("path");
const { createLogger } = require("./logger");
const {
  parseGpdFile,
  buildSchemaFromGpd,
  buildSnapshotFromGpd,
  getValidAchievements,
} = require("./xenia-gpd");
const { writeAchievementPercentagesSidecar } = require("./achievement-rarity");
const {
  EXOPHASE_LANG_KEYS,
  EXOPHASE_LANG_MAP,
  EXOPHASE_RARITY_SOURCE,
  mapExophasePlatform,
  buildExophaseSlug,
  buildExophaseSlugVariants,
  fetchExophaseAchievementsMultiLang,
  downloadExophaseIcon,
} = require("./exophase-scraper");

const autoConfigLogger = createLogger("autoconfig");
const schemaLogger = createLogger("achschema");
const TITLE_IMAGE_ID = 0x8000;
const exophaseInFlight = new Set();
const XENIA_CONFIG_FIELDS = [
  "name",
  "displayName",
  "appid",
  "platform",
  "config_path",
  "save_path",
  "gpd_path",
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
    key === "gpd_path" ||
    key === "executable"
  ) {
    return path.normalize(String(value));
  }
  return String(value);
}

function hasConfigChanges(prev, next) {
  for (const key of XENIA_CONFIG_FIELDS) {
    const a = normalizeComparableValue(key, prev?.[key]);
    const b = normalizeComparableValue(key, next?.[key]);
    if (a !== b) return true;
  }
  return false;
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

function findExistingXeniaConfig(configsDir, appid) {
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
        String(data?.platform || "").toLowerCase() === "xenia"
      ) {
        return { filePath: full, data };
      }
    } catch {}
  }
  return null;
}

function ensureUniqueConfigName(baseName, configsDir) {
  let name = sanitizeConfigName(baseName);
  if (!name) name = "config";
  let base = name.replace(/\s*\(xenia(?:\s+\d+)?\)\s*$/i, "");
  if (!base) base = name || "config";
  return `${base} (Xenia)`;
}

function ensureXeniaDisplayName(title) {
  const base = String(title || "").trim();
  if (!base) return "Unknown Game (Xenia)";
  return /\(xenia\)\s*$/i.test(base) ? base : `${base} (Xenia)`;
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
  const hasExtraLangs = Object.keys(existing).some(
    (key) => key !== "english"
  );
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
    const first = Object.values(value).find((v) => typeof v === "string" && v);
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

function hasAllRarityPct(entries) {
  if (!Array.isArray(entries) || !entries.length) return false;
  return entries.every(
    (entry) => normalizeExophaseRarityPct(entry?.rarityPct) !== null,
  );
}

function buildExophaseRarityEntries(entries) {
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
  const achievements = buildExophaseRarityEntries(entries);
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

function resolveFallbackIconPath(imagesById) {
  if (!imagesById || !(imagesById instanceof Map)) return "";
  const key = String(TITLE_IMAGE_ID);
  if (imagesById.has(key)) return `img/${key}.png`;
  return "";
}

async function enrichSchemaFromExophase(schemaDir, parsed, options = {}) {
  if (!schemaDir || !parsed) return { updated: false, matched: 0, icons: 0 };
  const schemaPath = path.join(schemaDir, "achievements.json");
  if (!fs.existsSync(schemaPath))
    return { updated: false, matched: 0, icons: 0 };

  let entries;
  try {
    entries = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
  } catch {
    return { updated: false, matched: 0, icons: 0 };
  }
  if (!Array.isArray(entries) || entries.length === 0) {
    return { updated: false, matched: 0, icons: 0 };
  }
  const langKeys = options.langKeys || EXOPHASE_LANG_KEYS;
  if (hasAllLanguages(entries, langKeys) && hasAllRarityPct(entries)) {
    schemaLogger.info("xenia:exophase:skip", {
      appid: String(parsed?.appid || ""),
      reason: "metadata-complete",
    });
    return { updated: false, matched: 0, icons: 0 };
  }

  const platform = mapExophasePlatform(options.platform || "xenia");
  const rawTitle = String(parsed.title || "").trim();
  if (!rawTitle || rawTitle === String(parsed?.appid || "").trim()) {
    schemaLogger.warn("xenia:exophase:skip", {
      appid: String(parsed?.appid || ""),
      reason: "missing-title",
    });
    return { updated: false, matched: 0, icons: 0 };
  }
  const variants = buildExophaseSlugVariants(rawTitle);
  if (!platform || variants.length === 0) {
    schemaLogger.warn("xenia:exophase:skip", {
      appid: String(parsed?.appid || ""),
      reason: "missing-slug-or-platform",
    });
    return { updated: false, matched: 0, icons: 0 };
  }
  const primarySlug = variants[0];
  schemaLogger.info("xenia:exophase:start", {
    appid: String(parsed?.appid || ""),
    slug: primarySlug,
    platform,
    variants: variants.length,
  });

  let exoData;
  let usedSlug = primarySlug;
  let lastError = null;
  for (const candidate of variants) {
    try {
      const storageState = process.env.EXOPHASE_STORAGE_STATE || "";
      exoData = await fetchExophaseAchievementsMultiLang({
        slug: candidate,
        platform,
        langKeys,
        langMap: EXOPHASE_LANG_MAP,
        storageState:
          storageState && fs.existsSync(storageState) ? storageState : "",
        logger: schemaLogger,
      });
      usedSlug = candidate;
      break;
    } catch (err) {
      lastError = err;
      schemaLogger.warn("xenia:exophase:retry", {
        appid: String(parsed?.appid || ""),
        slug: candidate,
        platform,
        error: err?.message || String(err),
      });
    }
  }
  if (!exoData) {
    schemaLogger.warn("xenia:exophase:failed", {
      appid: String(parsed?.appid || ""),
      slug: primarySlug,
      platform,
      error: lastError?.message || String(lastError),
      tried: variants,
    });
    return { updated: false, matched: 0, icons: 0 };
  }
  if (usedSlug !== primarySlug) {
    schemaLogger.info("xenia:exophase:alt-slug", {
      appid: String(parsed?.appid || ""),
      slug: usedSlug,
      platform,
    });
  }

  const items = exoData?.items || [];
  if (!items.length) {
    schemaLogger.warn("xenia:exophase:empty", {
      appid: String(parsed?.appid || ""),
      slug: usedSlug,
      platform,
    });
    return { updated: false, matched: 0, icons: 0 };
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
    schemaLogger.warn("xenia:exophase:duplicates", {
      appid: String(parsed?.appid || ""),
      keyDuplicates: keyDupes.size,
      titleDuplicates: titleDupes.size,
    });
  }

  let updated = false;
  let matched = 0;
  let iconsSaved = 0;
  let rarityMatched = 0;

  for (const entry of entries) {
    const gpdTitle = getLangValue(entry.displayName, "english");
    const gpdDesc = getLangValue(entry.description, "english");
    let match = null;
    const key = buildMatchKey(gpdTitle, gpdDesc);
    if (key && !keyDupes.has(key)) {
      match = keyMap.get(key) || null;
    }
    if (!match) {
      const titleKey = normalizeMatchText(gpdTitle);
      if (titleKey && !titleDupes.has(titleKey)) {
        match = titleMap.get(titleKey) || null;
      }
    }
    if (!match) continue;

    matched += 1;
    const beforeName = JSON.stringify(entry.displayName);
    const beforeDesc = JSON.stringify(entry.description);
    const display = ensureLangObject(entry.displayName);
    const desc = ensureLangObject(entry.description);

    for (const [langKey, value] of Object.entries(match.titles || {})) {
      if (value) display[langKey] = value;
    }
    for (const [langKey, value] of Object.entries(match.descriptions || {})) {
      if (value) desc[langKey] = value;
    }

    if (beforeName !== JSON.stringify(display)) {
      entry.displayName = display;
      updated = true;
    }
    if (beforeDesc !== JSON.stringify(desc)) {
      entry.description = desc;
      updated = true;
    }

    const rarityPct = normalizeExophaseRarityPct(match.rarityPct);
    if (rarityPct !== null) {
      rarityMatched += 1;
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

    const imageId = entry?.imageId;
    if (imageId === undefined || imageId === null) continue;
    if (!match.icon_url) continue;
    const iconRel = `img/${String(imageId)}.png`;
    if (entry.icon !== iconRel) {
      entry.icon = iconRel;
      updated = true;
    }
    const iconPath = path.join(schemaDir, iconRel);
    if (!fs.existsSync(iconPath)) {
      const ok = await downloadExophaseIcon(match.icon_url, iconPath);
      if (ok) iconsSaved += 1;
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

  schemaLogger.info("xenia:exophase:merged", {
    appid: String(parsed?.appid || ""),
    slug: usedSlug,
    platform,
    matched,
    updated,
    icons: iconsSaved,
    rarity: rarityMatched,
    raritySidecar: raritySidecar.matched,
  });

  return {
    updated,
    matched,
    icons: iconsSaved,
    rarity: rarityMatched,
    raritySidecar: raritySidecar.matched,
  };
}

function queueExophaseEnrich(schemaDir, parsed, options = {}) {
  const appid = String(parsed?.appid || "");
  if (!appid || exophaseInFlight.has(appid)) return;
  exophaseInFlight.add(appid);
  enrichSchemaFromExophase(schemaDir, parsed, options)
    .catch((err) => {
      schemaLogger.warn("xenia:exophase:error", {
        appid,
        error: err?.message || String(err),
      });
    })
    .finally(() => {
      exophaseInFlight.delete(appid);
    });
}

function writeSchemaAssets(schemaDir, parsed) {
  const imgDir = path.join(schemaDir, "img");
  fs.mkdirSync(imgDir, { recursive: true });

  const entries = buildSchemaFromGpd(parsed, { preferLocked: true });
  const imagesById = parsed?.imagesById || new Map();
  const fallbackIconPath = resolveFallbackIconPath(imagesById);
  let imagesSaved = 0;
  for (const [imageKey, payload] of imagesById.entries()) {
    if (!payload) continue;
    const fileName = `${imageKey}.png`;
    const outPath = path.join(imgDir, fileName);
    if (!fs.existsSync(outPath)) {
      fs.writeFileSync(outPath, payload);
      imagesSaved += 1;
    }
  }

  for (const entry of entries) {
    const imageId = entry.imageId;
    if (imageId === undefined || imageId === null) {
      entry.icon = "";
      entry.icon_gray = fallbackIconPath;
      continue;
    }
    const imageKey = String(imageId);
    const fileName = `${imageKey}.png`;
    entry.icon = `img/${fileName}`;
    entry.icon_gray = fallbackIconPath;
  }

  const sanitized = entries;

  fs.writeFileSync(
    path.join(schemaDir, "achievements.json"),
    JSON.stringify(sanitized, null, 2),
    "utf8"
  );

  schemaLogger.info("xenia:schema:written", {
    appid: String(parsed?.appid || ""),
    dir: schemaDir,
    achievements: sanitized.length,
    images: imagesSaved,
  });

  return sanitized;
}

function updateSchemaFromGpd(schemaDir, parsed, options = {}) {
  if (!schemaDir || !parsed) return { updated: false, images: 0 };
  const schemaPath = path.join(schemaDir, "achievements.json");
  if (!fs.existsSync(schemaPath)) return { updated: false, images: 0 };

  let entries;
  try {
    entries = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
  } catch {
    return { updated: false, images: 0 };
  }
  if (!Array.isArray(entries)) return { updated: false, images: 0 };

  const imgDir = path.join(schemaDir, "img");
  fs.mkdirSync(imgDir, { recursive: true });

  const imagesById = parsed?.imagesById || new Map();
  const fallbackIconPath = resolveFallbackIconPath(imagesById);
  let imagesSaved = 0;
  for (const [imageKey, payload] of imagesById.entries()) {
    if (!payload) continue;
    const outPath = path.join(imgDir, `${imageKey}.png`);
    if (!fs.existsSync(outPath)) {
      fs.writeFileSync(outPath, payload);
      imagesSaved += 1;
    }
  }

  let updated = false;
  let added = 0;
  let changed = 0;
  let pruned = 0;
  const incoming = buildSchemaFromGpd(parsed, { preferLocked: true });
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
    const mergedDisplay = mergeLangObject(
      existing.displayName,
      inc.displayName
    );
    if (
      JSON.stringify(existing.displayName) !== JSON.stringify(mergedDisplay)
    ) {
      existing.displayName = mergedDisplay;
      updated = true;
      changed += 1;
    }
    const mergedDescription = mergeLangObject(
      existing.description,
      inc.description
    );
    if (
      JSON.stringify(existing.description) !== JSON.stringify(mergedDescription)
    ) {
      existing.description = mergedDescription;
      updated = true;
      changed += 1;
    }
    if (existing.hidden !== inc.hidden) {
      existing.hidden = inc.hidden;
      updated = true;
      changed += 1;
    }
    if (existing.gamerscore !== inc.gamerscore) {
      existing.gamerscore = inc.gamerscore;
      updated = true;
      changed += 1;
    }
    if (existing.imageId !== inc.imageId) {
      existing.imageId = inc.imageId;
      updated = true;
      changed += 1;
    }
  }

  const incomingNames = new Set(
    incoming
      .map((entry) => String(entry?.name || "").trim())
      .filter((name) => !!name)
  );
  const beforePruneCount = entries.length;
  entries = entries.filter((entry) => {
    const key = String(entry?.name || "").trim();
    if (!key) return false;
    return incomingNames.has(key);
  });
  pruned = Math.max(0, beforePruneCount - entries.length);
  if (pruned > 0) {
    updated = true;
    changed += pruned;
  }

  for (const entry of entries) {
    let imageId = entry?.imageId;

    if (imageId === undefined || imageId === null) {
      const desiredGray = fallbackIconPath || "";
      if (entry.icon !== "") {
        entry.icon = "";
        updated = true;
        changed += 1;
      }
      if (entry.icon_gray !== desiredGray) {
        entry.icon_gray = desiredGray;
        updated = true;
        changed += 1;
      }
      continue;
    }

    const imageKey = String(imageId);
    const desiredIcon = `img/${imageKey}.png`;
    const desiredGray = fallbackIconPath || "";
    if (entry.icon !== desiredIcon) {
      entry.icon = desiredIcon;
      updated = true;
      changed += 1;
    }
    if (entry.icon_gray !== desiredGray) {
      entry.icon_gray = desiredGray;
      updated = true;
      changed += 1;
    }
  }

  if (updated) {
    fs.writeFileSync(schemaPath, JSON.stringify(entries, null, 2), "utf8");
  }

  const hasSchemaChanges = updated || added > 0 || changed > 0;
  if (hasSchemaChanges) {
    schemaLogger.info("xenia:schema:updated", {
      appid: String(parsed?.appid || ""),
      dir: schemaDir,
      updated,
      added,
      changed,
      pruned,
      total: entries.length,
      incoming: incoming.length,
      images: imagesSaved,
    });
  }

  const bootMode = options.bootMode === true;
  if (bootMode && !hasSchemaChanges) {
    schemaLogger.info("xenia:exophase:skip", {
      appid: String(parsed?.appid || ""),
      reason: "schema-unchanged-boot",
    });
  } else if (added > 0 || !hasMultiLang(entries) || !hasAllRarityPct(entries)) {
    queueExophaseEnrich(schemaDir, parsed, { platform: "xenia" });
  }

  return { updated, images: imagesSaved };
}

function generateConfigFromGpd(gpdPath, configsDir, options = {}) {
  const appid = path.basename(gpdPath, path.extname(gpdPath));
  let parsed;
  try {
    parsed = parseGpdFile(gpdPath);
  } catch (err) {
    autoConfigLogger.error("xenia:gpd:parse:failed", {
      appid,
      path: gpdPath,
      error: err?.message || String(err),
    });
    throw err;
  }
  parsed.appid = appid;
  const title = parsed.title || appid;
  const rawAchievementCount = parsed.achievements?.length || 0;
  const validAchievementCount = getValidAchievements(parsed).length;
  const filteredCount = Math.max(0, rawAchievementCount - validAchievementCount);
  if (filteredCount > 0) {
    schemaLogger.info("xenia:schema:filtered-invalid", {
      appid,
      raw: rawAchievementCount,
      valid: validAchievementCount,
      filtered: filteredCount,
    });
  }
  const achievementCount = validAchievementCount;
  const snapshot = buildSnapshotFromGpd(parsed);
  const schemaRoot =
    options.schemaRoot || path.join(configsDir, "schema");
  const schemaDir = path.join(schemaRoot, "xenia", String(appid));

  if (achievementCount === 0) {
    return {
      skipped: true,
      appid,
      title,
      reason: rawAchievementCount > 0 ? "no-valid-achievements" : "no-achievements",
    };
  }

  const existing = findExistingXeniaConfig(configsDir, appid);
  const existingName = existing
    ? path.basename(existing.filePath, ".json")
    : "";
  const configName = existingName
    ? sanitizeConfigName(existingName)
    : ensureUniqueConfigName(title || appid, configsDir);
  const configPath = path.join(configsDir, `${configName}.json`);

  fs.mkdirSync(schemaDir, { recursive: true });
  const schemaPath = path.join(schemaDir, "achievements.json");
  let schemaReady = false;
  if (fs.existsSync(schemaPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
      schemaReady = Array.isArray(raw) && raw.length > 0;
    } catch {
      schemaReady = false;
    }
  }
  let schemaUpdated = false;
  if (schemaReady) {
    const schemaResult = updateSchemaFromGpd(schemaDir, parsed, {
      bootMode: options.bootMode === true,
    });
    schemaUpdated = !!schemaResult?.updated;
  } else {
    writeSchemaAssets(schemaDir, parsed);
    queueExophaseEnrich(schemaDir, parsed, { platform: "xenia" });
    schemaUpdated = true;
  }

  const payload = {
    name: configName,
    displayName: ensureXeniaDisplayName(title),
    appid: String(appid),
    platform: "xenia",
    config_path: schemaDir,
    save_path: path.dirname(gpdPath),
    gpd_path: gpdPath,
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
      autoConfigLogger.info("xenia:config:updated", {
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
      schemaUpdated,
      snapshot,
    };
  }

  fs.writeFileSync(configPath, JSON.stringify(payload, null, 2));
  autoConfigLogger.info("xenia:config:created", {
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
    schemaUpdated,
    snapshot,
  };
}

module.exports = { generateConfigFromGpd, updateSchemaFromGpd };
