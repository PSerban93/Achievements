// auto-config-generator.js
const { app } = require("electron");
const fs = require("fs");
const os = require("os");
const path = require("path");
const axios = require("axios");
const { fork, execFileSync } = require("child_process");
const ini = require("ini");
const CRC32 = require("crc-32");
const { loadAchievementsFromSaveFile } = require("./achievement-data");
const { createLogger } = require("./logger");
const {
  buildGogOfficialSnapshot,
  ensureGogOfficialSchema,
  parseGameplayDirIdentity,
  resolveGogGalaxyProductByProductId,
  resolveGogOfficialGameplayEntryForProduct,
  waitForStableGogGameplayDb,
} = require("./gog-galaxy-local");
const {
  buildUbisoftOfficialSnapshot,
  ensureUbisoftOfficialSchema,
  readUbisoftSpoolFile,
  resolveUbisoftAchievementsArchiveForAppId,
  resolveUbisoftOfficialSpoolEntryForAppId,
  resolveUbisoftSteamAppId,
} = require("./ubisoft-connect-local");
const {
  buildEaOfficialSnapshot,
  ensureEaOfficialSchema,
  resolveEaOfficialAchievementSetForAppId,
  resolveEaOfficialVerboseLogPath,
} = require("./ea-desktop-local");
const autoConfigLogger = createLogger("autoconfig");
const {
  normalizePlatform,
  inferPlatformAndSteamId,
  sanitizeAppId,
} = require("./config-platform-migrator");
const {
  lookupSteamDbName,
  lookupUplayMappingEntry,
} = require("./local-game-name-cache");
const { fetchSteamDbLaunchMetadata } = require("./steamdb-launch-metadata");
const {
  hasProcessNameValue,
  normalizeProcessNameValue,
} = require("./process-name-utils");
const userDataDir = app?.getPath("userData")
  ? app.getPath("userData")
  : path.join(os.tmpdir(), "Achievements");
let preferencesPath = path.join(userDataDir, "preferences.json");
const BLACKLIST_PREF_KEY = "blacklistedAppIds";
const defaultUplaySteamMapPath = path.join(
  __dirname,
  "..",
  "assets",
  "uplay-steam.json",
);
let uplaySteamMapPath = path.join(userDataDir, "uplay-steam.json");
function ensureUplayMappingFile() {
  try {
    if (fs.existsSync(uplaySteamMapPath)) return;
    const source =
      fs.existsSync(defaultUplaySteamMapPath) &&
      fs.statSync(defaultUplaySteamMapPath).isFile()
        ? defaultUplaySteamMapPath
        : null;
    fs.mkdirSync(path.dirname(uplaySteamMapPath), { recursive: true });
    if (source) {
      fs.copyFileSync(source, uplaySteamMapPath);
    } else {
      fs.writeFileSync(uplaySteamMapPath, "[]", "utf8");
    }
    autoConfigLogger.info("uplay-mapping:initialized", {
      path: uplaySteamMapPath,
      source: source || null,
    });
  } catch (err) {
    autoConfigLogger.warn("uplay-mapping:init-failed", {
      error: err?.message || String(err),
      target: uplaySteamMapPath,
    });
  }
}
ensureUplayMappingFile();
function loadUplayMapping() {
  try {
    const raw = fs.readFileSync(uplaySteamMapPath, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    autoConfigLogger.warn("uplay-mapping:load-failed", {
      error: err?.message || String(err),
    });
    return [];
  }
}
const uplaySteamMap = loadUplayMapping();
const uplayToSteam = new Map(
  uplaySteamMap.map((row) => [String(row.uplay_id), row]),
);
const SCHEMA_LANGUAGE_VALUES = [
  "arabic",
  "bulgarian",
  "schinese",
  "tchinese",
  "czech",
  "danish",
  "dutch",
  "english",
  "finnish",
  "french",
  "german",
  "greek",
  "hungarian",
  "indonesian",
  "italian",
  "japanese",
  "koreana",
  "norwegian",
  "polish",
  "portuguese",
  "brazilian",
  "romanian",
  "russian",
  "spanish",
  "latam",
  "swedish",
  "thai",
  "turkish",
  "ukrainian",
  "vietnamese",
];
const ACHGEN_UI_SUPPRESSED_MESSAGES = new Set([
  "rarity:steam:request",
  "rarity:steam:success",
  "rarity:steam:written",
  "rarity:epic:request",
  "rarity:epic:success",
  "rarity:epic:written",
  "rarity:gog:request",
  "rarity:gog:success",
  "rarity:gog:written",
]);
function shouldSuppressAchgenMessageInUi(message) {
  const msg = String(message || "")
    .trim()
    .replace(/^[\u2705\u2139\u23ed\u23e9\u26a0]\s*/i, "");
  if (!msg) return true;
  return ACHGEN_UI_SUPPRESSED_MESSAGES.has(msg);
}
const gogNameFallbackAppIds = new Set();
function reloadUplayMappingFromDisk() {
  try {
    const refreshed = JSON.parse(fs.readFileSync(uplaySteamMapPath, "utf8"));
    uplaySteamMap.length = 0;
    refreshed.forEach((row) => uplaySteamMap.push(row));
    uplayToSteam.clear();
    refreshed.forEach((row) => {
      uplayToSteam.set(String(row.uplay_id), row);
    });
    return true;
  } catch (err) {
    autoConfigLogger.warn("uplay-mapping:reload-failed", {
      error: err?.message || String(err),
    });
    return false;
  }
}
function refreshMappingViaScript() {
  try {
    execFileSync(process.execPath, [
      "--run-as-node",
      path.join(__dirname, "match-uplay-steam.js"),
      `--output=${uplaySteamMapPath}`,
    ]);
    reloadUplayMappingFromDisk();
  } catch (err) {
    autoConfigLogger.warn("uplay-mapping:script-failed", {
      error: err?.message || String(err),
    });
  }
}

function loadConfigVariantIndex(outputDir) {
  const map = new Map();
  try {
    if (!fs.existsSync(outputDir)) return map;
    const files = fs
      .readdirSync(outputDir)
      .filter((f) => f.toLowerCase().endsWith(".json"));
    for (const file of files) {
      const full = path.join(outputDir, file);
      try {
        const data = JSON.parse(fs.readFileSync(full, "utf8"));
        const appid = sanitizeAppId(
          data?.appid || data?.appId || data?.steamAppId,
        );
        if (!appid) continue;
        const platform = normalizePlatform(data?.platform) || "steam";
        const name = data?.name || path.basename(file, ".json");
        if (!map.has(appid)) map.set(appid, new Map());
        map.get(appid).set(platform, { filePath: full, name });
      } catch {}
    }
  } catch (err) {
    autoConfigLogger.warn("config-index:build-failed", {
      error: err?.message || String(err),
    });
  }
  return map;
}

function registerConfigVariant(index, appid, platform, info) {
  const key = sanitizeAppId(appid);
  if (!key || !info?.filePath) return;
  const normalizedPlatform = normalizePlatform(platform) || "steam";
  if (!index.has(key)) index.set(key, new Map());
  index.get(key).set(normalizedPlatform, {
    filePath: info.filePath,
    name: info.name,
  });
}

function resolveExistingVariant(index, appid, platform) {
  const key = sanitizeAppId(appid);
  if (!key) return null;
  const bucket = index.get(key);
  if (!bucket) return null;
  const normalizedPlatform = normalizePlatform(platform) || "steam";
  return bucket.get(normalizedPlatform) || null;
}

function resolveConfigTarget({ outputDir, baseName, appid, platform, index }) {
  const existing = resolveExistingVariant(index, appid, platform);
  if (existing) {
    return {
      filePath: existing.filePath,
      name: existing.name || baseName,
      reused: true,
    };
  }
  const platformLabel =
    platform === "uplay"
      ? "Uplay"
      : platform === "ubisoft-official"
        ? "Ubisoft Official"
        : platform === "ea-official"
          ? "EA Official"
          : platform === "gog"
            ? "GOG"
            : platform === "gog-official"
              ? "GOG Official"
              : platform === "epic"
                ? "Epic"
                : "Steam";
  let candidateName = baseName;
  let candidatePath = path.join(outputDir, `${candidateName}.json`);
  let suffix = 1;
  while (fs.existsSync(candidatePath)) {
    const label = suffix === 1 ? platformLabel : `${platformLabel} ${suffix}`;
    candidateName = `${baseName} (${label})`;
    candidatePath = path.join(outputDir, `${candidateName}.json`);
    suffix++;
  }
  return { filePath: candidatePath, name: candidateName, reused: false };
}

function resolvePlatformMetadata({ appid, mapping, forcePlatform }) {
  const normalizedForce = normalizePlatform(forcePlatform) || "";
  const sanitizedMappingSteamId = mapping?.steam_appid
    ? sanitizeAppId(mapping.steam_appid)
    : "";
  const mappingForInference =
    normalizedForce === "steam" || normalizedForce === "epic" ? null : mapping;
  const seed = {
    appid,
    platform: normalizedForce || undefined,
    steamAppId: sanitizedMappingSteamId || undefined,
  };
  const { platform, steamAppId } = inferPlatformAndSteamId({
    config: seed,
    mapping: mappingForInference,
  });
  return {
    platform: platform || normalizedForce || "steam",
    steamAppId: steamAppId || "",
  };
}
function stripAchievementPrefix(name) {
  if (typeof name !== "string") return name;
  const match = name.match(/Ach_(.+)$/i);
  if (match && match[1]) return match[1];
  return name;
}
function normalizeAchievementName(name, shouldStrip = false) {
  if (typeof name !== "string") return name;
  let result = name.trim();
  if (shouldStrip) {
    result = stripAchievementPrefix(result);
    const m = result.match(/^(.*)_(\d+)$/);
    if (m && m[1] && /[A-Za-z]/.test(m[1])) {
      result = m[2];
    }
  }
  return result;
}
function readPrefsSafe() {
  try {
    return fs.existsSync(preferencesPath)
      ? JSON.parse(fs.readFileSync(preferencesPath, "utf8"))
      : {};
  } catch {
    return {};
  }
}

function normalizeSchemaLanguageList(value) {
  const allowed = new Set(SCHEMA_LANGUAGE_VALUES);
  const list = Array.isArray(value) ? value : [];
  const out = [];
  const seen = new Set();
  for (const item of list) {
    const token = String(item || "")
      .trim()
      .toLowerCase();
    if (!token || !allowed.has(token) || seen.has(token)) continue;
    seen.add(token);
    out.push(token);
  }
  return out;
}

function resolveSchemaLanguagesForGenerator(candidate = undefined) {
  const source =
    candidate !== undefined ? candidate : readPrefsSafe()?.schemaLanguages;
  const normalized = normalizeSchemaLanguageList(source);
  if (normalized.length) return normalized;
  if (candidate !== undefined || source !== undefined) return ["english"];
  return [...SCHEMA_LANGUAGE_VALUES];
}
function getBlacklistedAppIdsSet() {
  const prefs = readPrefsSafe();
  const list = Array.isArray(prefs[BLACKLIST_PREF_KEY])
    ? prefs[BLACKLIST_PREF_KEY]
    : [];
  return new Set(
    list
      .map((id) => String(id || "").trim())
      .filter((id) => /^[0-9a-fA-F]+$/.test(id)),
  );
}
function readJsonSafe(fp) {
  try {
    return JSON.parse(fs.readFileSync(fp, "utf8"));
  } catch {
    return null;
  }
}
function normalizeSavePath(p) {
  if (!p) return "";
  return String(p)
    .trim()
    .replace(/[\\/]+/g, "\\")
    .replace(/\\+$/g, "")
    .toLowerCase();
}
function findExistingConfigBySavePath(index, appid, expectedSavePath) {
  const key = sanitizeAppId(appid);
  if (!key) return null;
  const normalizedExpected = normalizeSavePath(expectedSavePath);
  if (!normalizedExpected) return null;
  const bucket = index.get(key);
  if (!bucket) return null;
  for (const entry of bucket.values()) {
    if (!entry?.filePath) continue;
    const cfg = readJsonSafe(entry.filePath);
    if (!cfg) continue;
    const cfgSavePath = normalizeSavePath(cfg.save_path || cfg.savePath || "");
    if (cfgSavePath && cfgSavePath === normalizedExpected) {
      return {
        filePath: entry.filePath,
        name: cfg.name || entry.name || null,
        config: cfg,
      };
    }
  }
  return null;
}
async function maybeSeedAchCache({
  appid,
  configName,
  save_path,
  config_path,
  platform = "steam",
  onSeedCache,
}) {
  if (typeof onSeedCache !== "function" || !save_path) return;
  const id = String(appid);
  const meta = { appid: id, config_path, platform };
  const candidates = [
    path.join(save_path, "gameplay.db"),
    path.join(save_path, "achievements.json"),
    path.join(save_path, id, "achievements.json"),
    path.join(save_path, "steam_settings", id, "achievements.json"),
    path.join(save_path, "achievements.ini"),
    path.join(save_path, "SteamData", "user_stats.ini"),
    path.join(save_path, id, "SteamData", "user_stats.ini"),
    path.join(save_path, "Stats", "achievements.ini"),
    path.join(save_path, id, "achievements.ini"),
    path.join(save_path, "stats.bin"),
    path.join(save_path, id, "stats.bin"),
  ];
  let snapshot = null;
  for (const fp of candidates) {
    try {
      if (!fs.existsSync(fp)) continue;
      const cur = loadAchievementsFromSaveFile(
        path.dirname(fp),
        {},
        { configMeta: meta },
      );
      if (cur && Object.keys(cur).length) {
        snapshot = { ...(snapshot || {}), ...cur };
      }
    } catch (err) {
      autoConfigLogger.warn("seed-cache:candidate-failed", {
        appid: id,
        configName,
        path: fp,
        error: err?.message || String(err),
      });
    }
  }
  if (snapshot && Object.keys(snapshot).length) {
    try {
      onSeedCache({ appid: id, configName, snapshot });
      autoConfigLogger.info("seed-cache:success", {
        appid: id,
        configName,
        entries: Object.keys(snapshot).length,
      });
    } catch (err) {
      autoConfigLogger.error("seed-cache:handler-error", {
        appid: id,
        configName,
        error: err?.message || String(err),
      });
    }
  }
}
function sanitizeFilename(name) {
  return name.replace(/[\/\\:*?"<>|]/g, "");
}

function applyLaunchMetadataToConfig(configData, metadata) {
  if (!configData || !metadata) return false;
  let changed = false;
  const processName = normalizeProcessNameValue(metadata.process_name);
  const args = String(metadata.arguments || "");
  if (
    hasProcessNameValue(processName) &&
    !hasProcessNameValue(configData.process_name)
  ) {
    configData.process_name = processName;
    changed = true;
  }
  if (args && !String(configData.arguments || "").trim()) {
    configData.arguments = args;
    changed = true;
  }
  return changed;
}

async function generateGogOfficialConfigForProduct(
  appid,
  outputDir,
  opts = {},
) {
  const productId = String(appid || "").trim();
  if (!/^\d+$/.test(productId)) {
    autoConfigLogger.error("gog-official:invalid-product-id", {
      appid: productId,
    });
    throw new Error(`Invalid GOG Product ID: ${productId}`);
  }

  const configVariantIndex = loadConfigVariantIndex(outputDir);
  const product = resolveGogGalaxyProductByProductId(productId, {
    storageDbPath: opts.storageDbPath,
  });

  let gameplayDir =
    typeof opts.savePathOverride === "string"
      ? opts.savePathOverride.trim()
      : "";
  let gameplayDbPath =
    typeof opts.gogGameplayDbPath === "string"
      ? opts.gogGameplayDbPath.trim()
      : "";
  let clientId =
    typeof opts.gogClientId === "string" ? opts.gogClientId.trim() : "";
  let userId = typeof opts.gogUserId === "string" ? opts.gogUserId.trim() : "";

  if (gameplayDbPath && !gameplayDir) {
    gameplayDir = path.dirname(gameplayDbPath);
  }
  if (gameplayDir && (!clientId || !userId)) {
    const parsedIdentity = parseGameplayDirIdentity(gameplayDir);
    clientId = clientId || parsedIdentity.clientId || "";
    userId = userId || parsedIdentity.userId || "";
  }
  if (gameplayDir && (!gameplayDbPath || !fs.existsSync(gameplayDbPath))) {
    const candidateGameplayDb = path.join(gameplayDir, "gameplay.db");
    if (fs.existsSync(candidateGameplayDb)) {
      gameplayDbPath = candidateGameplayDb;
    }
  }

  let resolvedEntry = null;
  if (!gameplayDbPath || !fs.existsSync(gameplayDbPath)) {
    resolvedEntry = resolveGogOfficialGameplayEntryForProduct(productId, {
      applicationsRoot: opts.applicationsRoot,
      storageDbPath: opts.storageDbPath,
      clientId,
      userId,
    });
  }
  if (resolvedEntry) {
    gameplayDir = resolvedEntry.gameplayDir || gameplayDir;
    gameplayDbPath = resolvedEntry.gameplayDbPath || gameplayDbPath;
    clientId = resolvedEntry.clientId || clientId;
    userId = resolvedEntry.userId || userId;
  }

  if (!gameplayDbPath || !fs.existsSync(gameplayDbPath)) {
    autoConfigLogger.warn("gog-official:gameplay-db-missing", {
      appid: productId,
      clientId: clientId || null,
      userId: userId || null,
    });
    throw new Error("GOG Galaxy gameplay.db was not found for this product.");
  }
  gameplayDir = gameplayDir || path.dirname(gameplayDbPath);

  const existingVariant =
    resolveExistingVariant(configVariantIndex, productId, "gog-official") ||
    null;
  const resolvedBase =
    String(opts.preferredName || "").trim() ||
    String(product?.title || "").trim() ||
    `GOG ${productId}`;
  const defaultCfgName = `${resolvedBase} (GOG Official)`;
  const desiredFileBase = sanitizeFilename(defaultCfgName);
  const targetInfo = existingVariant
    ? {
        filePath: existingVariant.filePath,
        name: existingVariant.name || defaultCfgName,
        reused: true,
      }
    : {
        filePath: path.join(outputDir, `${desiredFileBase}.json`),
        name: defaultCfgName,
        reused: false,
      };

  const schemaBase = path.join(outputDir, "schema");
  const destSchemaDir = path.join(schemaBase, "gog-official", productId);
  fs.mkdirSync(destSchemaDir, { recursive: true });

  const stability = await waitForStableGogGameplayDb(gameplayDbPath, {
    maxWaitMs: 20000,
    pollMs: 1000,
    stableReadsRequired: 2,
  });
  if (!stability?.stable || !stability?.ready) {
    autoConfigLogger.info("gog-official:schema-pending", {
      appid: productId,
      clientId: clientId || null,
      userId: userId || null,
      gameplayDbPath,
      schemaDir: destSchemaDir,
      schemaCount: Number(stability?.count || 0),
      stable: stability?.stable === true,
      attempts: Number(stability?.attempts || 0),
      elapsedMs: Number(stability?.elapsedMs || 0),
    });
    return {
      appid: productId,
      platform: "gog-official",
      skipped: true,
      pendingSchema: true,
      save_path: gameplayDir,
      config_path: destSchemaDir,
      gog_client_id: clientId || "",
      gog_user_id: userId || "",
      gog_gameplay_db: gameplayDbPath,
      snapshot:
        stability?.gameplay && Array.isArray(stability.gameplay.achievements)
          ? buildGogOfficialSnapshot(stability.gameplay.achievements)
          : {},
    };
  }

  const schemaResult = await ensureGogOfficialSchema(productId, destSchemaDir, {
    preloadedGameplay: stability.gameplay,
    gameplayDbPath,
    applicationsRoot: opts.applicationsRoot,
    storageDbPath: opts.storageDbPath,
    clientId,
    userId,
  });
  const schemaCount = Number(schemaResult?.count || 0);
  if (!Number.isFinite(schemaCount) || schemaCount <= 0) {
    autoConfigLogger.info("gog-official:schema-pending", {
      appid: productId,
      clientId: clientId || null,
      userId: userId || null,
      gameplayDbPath,
      schemaDir: destSchemaDir,
      schemaCount,
      stable: true,
      attempts: Number(stability?.attempts || 0),
      elapsedMs: Number(stability?.elapsedMs || 0),
    });
    return {
      appid: productId,
      platform: "gog-official",
      skipped: true,
      pendingSchema: true,
      save_path: gameplayDir,
      config_path: destSchemaDir,
      gog_client_id: clientId || "",
      gog_user_id: userId || "",
      gog_gameplay_db: gameplayDbPath,
      snapshot: schemaResult?.snapshot || {},
    };
  }

  const existingConfig = readJsonSafe(targetInfo.filePath) || {};
  const nextConfig = {
    ...existingConfig,
    name: targetInfo.name,
    displayName: defaultCfgName,
    appid: productId,
    platform: "gog-official",
    config_path: destSchemaDir,
    save_path: gameplayDir,
    gog_client_id: clientId || existingConfig.gog_client_id || undefined,
    gog_user_id: userId || existingConfig.gog_user_id || undefined,
    gog_gameplay_db: gameplayDbPath,
    executable:
      typeof existingConfig.executable === "string"
        ? existingConfig.executable
        : "",
    arguments:
      typeof existingConfig.arguments === "string"
        ? existingConfig.arguments
        : "",
    process_name: normalizeProcessNameValue(existingConfig.process_name),
  };
  if (nextConfig.steamAppId) delete nextConfig.steamAppId;

  const previousSerialized = fs.existsSync(targetInfo.filePath)
    ? fs.readFileSync(targetInfo.filePath, "utf8")
    : null;
  const nextSerialized = JSON.stringify(nextConfig, null, 2);
  const created = !fs.existsSync(targetInfo.filePath);
  const updated = created || previousSerialized !== nextSerialized;
  if (updated) {
    fs.writeFileSync(targetInfo.filePath, nextSerialized);
  }

  registerConfigVariant(configVariantIndex, productId, "gog-official", {
    filePath: targetInfo.filePath,
    name: targetInfo.name,
  });

  if (
    typeof opts.onSeedCache === "function" &&
    schemaResult?.snapshot &&
    Object.keys(schemaResult.snapshot).length
  ) {
    try {
      opts.onSeedCache({
        appid: productId,
        configName: targetInfo.name,
        platform: "gog-official",
        savePath: gameplayDir,
        snapshot: schemaResult.snapshot,
      });
    } catch (err) {
      autoConfigLogger.warn("gog-official:seed-cache-failed", {
        appid: productId,
        configName: targetInfo.name,
        error: err?.message || String(err),
      });
    }
  }

  autoConfigLogger.info("gog-official:config-ready", {
    appid: productId,
    filePath: targetInfo.filePath,
    created,
    updated,
    clientId: clientId || null,
    userId: userId || null,
    gameplayDbPath,
  });

  return {
    appid: productId,
    name: targetInfo.name,
    filePath: targetInfo.filePath,
    platform: "gog-official",
    save_path: gameplayDir,
    config_path: destSchemaDir,
    gog_client_id: clientId || "",
    gog_user_id: userId || "",
    gog_gameplay_db: gameplayDbPath,
    created,
    updated,
    snapshot: schemaResult?.snapshot || {},
  };
}

async function generateUbisoftOfficialConfigForProduct(
  appid,
  outputDir,
  opts = {},
) {
  const productId = String(appid || "").trim();
  if (!/^\d+$/.test(productId)) {
    autoConfigLogger.error("ubisoft-official:invalid-product-id", {
      appid: productId,
    });
    throw new Error(`Invalid Ubisoft Product ID: ${productId}`);
  }

  const configVariantIndex = loadConfigVariantIndex(outputDir);
  let spoolDir =
    typeof opts.savePathOverride === "string"
      ? opts.savePathOverride.trim()
      : "";
  let spoolFilePath =
    typeof opts.ubisoftSpoolFile === "string"
      ? opts.ubisoftSpoolFile.trim()
      : typeof opts.ubisoft_spool_file === "string"
        ? opts.ubisoft_spool_file.trim()
        : "";
  let userId =
    typeof opts.ubisoftUserId === "string"
      ? opts.ubisoftUserId.trim()
      : typeof opts.ubisoft_user_id === "string"
        ? opts.ubisoft_user_id.trim()
        : "";

  if (spoolFilePath && !spoolDir) {
    spoolDir = path.dirname(spoolFilePath);
  }
  if (spoolDir && !userId) {
    userId = path.basename(spoolDir);
  }

  const resolvedSpool =
    resolveUbisoftOfficialSpoolEntryForAppId(productId, {
      userId,
      spoolFilePath,
      spoolRoot: spoolDir || opts.spoolRoot,
    }) || null;
  if (resolvedSpool) {
    spoolDir = resolvedSpool.spoolDir || spoolDir;
    spoolFilePath = resolvedSpool.spoolFilePath || spoolFilePath;
    userId = resolvedSpool.userId || userId;
  }

  if (!spoolFilePath || !fs.existsSync(spoolFilePath)) {
    autoConfigLogger.warn("ubisoft-official:spool-missing", {
      appid: productId,
      userId: userId || null,
    });
    throw new Error(
      "Ubisoft Connect spool file was not found for this product.",
    );
  }
  spoolDir = spoolDir || path.dirname(spoolFilePath);
  userId = userId || path.basename(spoolDir);

  let archiveInfo = null;
  try {
    archiveInfo = resolveUbisoftAchievementsArchiveForAppId(productId, {
      achievementsRoot: opts.achievementsRoot,
      configurationsPath: opts.configurationsPath,
    });
  } catch (err) {
    autoConfigLogger.info("ubisoft-official:schema-pending", {
      appid: productId,
      userId: userId || null,
      spoolFilePath,
      error: err?.message || String(err),
    });
    return {
      appid: productId,
      platform: "ubisoft-official",
      skipped: true,
      pendingSchema: true,
      save_path: spoolDir,
      ubisoft_user_id: userId || "",
      ubisoft_spool_file: spoolFilePath,
      snapshot:
        buildUbisoftOfficialSnapshot(
          readUbisoftSpoolFileSafe(spoolFilePath)?.records || [],
        ) || {},
    };
  }

  const schemaBase = path.join(outputDir, "schema");
  const destSchemaDir = path.join(schemaBase, "ubisoft-official", productId);
  fs.mkdirSync(destSchemaDir, { recursive: true });

  const steamAppId = String(
    opts.steamAppId || resolveUbisoftSteamAppId(productId) || "",
  ).trim();
  const schemaResult = await ensureUbisoftOfficialSchema(
    productId,
    destSchemaDir,
    {
      archivePath: archiveInfo.archivePath,
      achievementsSpec: archiveInfo.achievementsSpec,
      title: archiveInfo.title,
      gameIdentifier: archiveInfo.gameIdentifier,
      displayName: archiveInfo.displayName,
      rootName: archiveInfo.rootName,
      gameCode: archiveInfo.gameCode,
      achievementsSyncId: archiveInfo.achievementsSyncId,
      spaceId: archiveInfo.spaceId,
      configurationsPath: opts.configurationsPath,
      achievementsRoot: opts.achievementsRoot,
      steamAppId,
    },
  );
  const schemaCount = Number(schemaResult?.count || 0);
  if (!Number.isFinite(schemaCount) || schemaCount <= 0) {
    autoConfigLogger.info("ubisoft-official:schema-pending", {
      appid: productId,
      userId: userId || null,
      spoolFilePath,
      archivePath: archiveInfo.archivePath,
      schemaCount,
    });
    return {
      appid: productId,
      platform: "ubisoft-official",
      skipped: true,
      pendingSchema: true,
      save_path: spoolDir,
      config_path: destSchemaDir,
      ubisoft_user_id: userId || "",
      ubisoft_spool_file: spoolFilePath,
      snapshot:
        buildUbisoftOfficialSnapshot(
          readUbisoftSpoolFileSafe(spoolFilePath)?.records || [],
        ) || {},
    };
  }

  const existingVariant =
    resolveExistingVariant(configVariantIndex, productId, "ubisoft-official") ||
    null;
  const resolvedBase =
    String(opts.preferredName || "").trim() ||
    String(archiveInfo?.title || "").trim() ||
    `Ubisoft ${productId}`;
  const defaultCfgName = `${resolvedBase} (Ubisoft Official)`;
  const desiredFileBase = sanitizeFilename(defaultCfgName);
  const targetInfo = existingVariant
    ? {
        filePath: existingVariant.filePath,
        name: existingVariant.name || defaultCfgName,
        reused: true,
      }
    : {
        filePath: path.join(outputDir, `${desiredFileBase}.json`),
        name: defaultCfgName,
        reused: false,
      };

  const existingConfig = readJsonSafe(targetInfo.filePath) || {};
  const nextConfig = {
    ...existingConfig,
    name: path.basename(targetInfo.filePath, ".json"),
    displayName: defaultCfgName,
    appid: productId,
    platform: "ubisoft-official",
    config_path: destSchemaDir,
    save_path: spoolDir,
    ubisoft_user_id: userId || existingConfig.ubisoft_user_id || undefined,
    ubisoft_spool_file: spoolFilePath,
    ubisoft_achievements_archive:
      archiveInfo.archivePath ||
      existingConfig.ubisoft_achievements_archive ||
      undefined,
    steamAppId: steamAppId || existingConfig.steamAppId || undefined,
    executable:
      typeof existingConfig.executable === "string"
        ? existingConfig.executable
        : "",
    arguments:
      typeof existingConfig.arguments === "string"
        ? existingConfig.arguments
        : "",
    process_name: normalizeProcessNameValue(existingConfig.process_name),
  };

  const previousSerialized = fs.existsSync(targetInfo.filePath)
    ? fs.readFileSync(targetInfo.filePath, "utf8")
    : null;
  const nextSerialized = JSON.stringify(nextConfig, null, 2);
  const created = !fs.existsSync(targetInfo.filePath);
  const updated = created || previousSerialized !== nextSerialized;
  if (updated) {
    fs.writeFileSync(targetInfo.filePath, nextSerialized);
  }

  registerConfigVariant(configVariantIndex, productId, "ubisoft-official", {
    filePath: targetInfo.filePath,
    name: path.basename(targetInfo.filePath, ".json"),
  });

  const spoolSnapshot = buildUbisoftOfficialSnapshot(
    readUbisoftSpoolFileSafe(spoolFilePath)?.records || [],
  );
  if (
    typeof opts.onSeedCache === "function" &&
    spoolSnapshot &&
    Object.keys(spoolSnapshot).length
  ) {
    try {
      opts.onSeedCache({
        appid: productId,
        configName: path.basename(targetInfo.filePath, ".json"),
        platform: "ubisoft-official",
        savePath: spoolDir,
        snapshot: spoolSnapshot,
      });
    } catch (err) {
      autoConfigLogger.warn("ubisoft-official:seed-cache-failed", {
        appid: productId,
        error: err?.message || String(err),
      });
    }
  }

  autoConfigLogger.info("ubisoft-official:config-ready", {
    appid: productId,
    filePath: targetInfo.filePath,
    created,
    updated,
    userId: userId || null,
    spoolFilePath,
    archivePath: archiveInfo.archivePath,
  });

  return {
    appid: productId,
    name: path.basename(targetInfo.filePath, ".json"),
    filePath: targetInfo.filePath,
    platform: "ubisoft-official",
    save_path: spoolDir,
    config_path: destSchemaDir,
    ubisoft_user_id: userId || "",
    ubisoft_spool_file: spoolFilePath,
    ubisoft_achievements_archive: archiveInfo.archivePath || "",
    steamAppId,
    created,
    updated,
    snapshot: spoolSnapshot,
  };
}

function readUbisoftSpoolFileSafe(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return null;
    return readUbisoftSpoolFile(filePath);
  } catch {
    return null;
  }
}

async function generateEaOfficialConfigForProduct(appid, outputDir, opts = {}) {
  const productId = String(appid || "").trim();
  if (!/^\d+$/.test(productId)) {
    autoConfigLogger.error("ea-official:invalid-product-id", {
      appid: productId,
    });
    throw new Error(`Invalid EA Content ID: ${productId}`);
  }

  const configVariantIndex = loadConfigVariantIndex(outputDir);
  const logsDir =
    typeof opts.savePathOverride === "string"
      ? opts.savePathOverride.trim()
      : "";
  const explicitLogFile = String(
    opts.eaLogFile || opts.ea_log_file || "",
  ).trim();
  const achievementSet = String(
    opts.eaAchievementSet || opts.ea_achievement_set || "",
  ).trim();
  const logFilePath = resolveEaOfficialVerboseLogPath(
    {
      save_path: logsDir,
      ea_log_file: explicitLogFile,
    },
    {
      savePath: logsDir,
      logFilePath: explicitLogFile,
    },
  );
  if (!logFilePath || !fs.existsSync(logFilePath)) {
    autoConfigLogger.warn("ea-official:log-missing", {
      appid: productId,
      savePath: logsDir || null,
      eaLogFile: explicitLogFile || null,
    });
    throw new Error("EA Desktop verbose log was not found for this product.");
  }

  const entry = resolveEaOfficialAchievementSetForAppId(productId, {
    achievementSet,
    savePath: logsDir,
    logFilePath,
  });
  if (
    !entry ||
    !Array.isArray(entry.achievements) ||
    !entry.achievements.length
  ) {
    autoConfigLogger.info("ea-official:schema-pending", {
      appid: productId,
      achievementSet: achievementSet || null,
      logFilePath,
    });
    return {
      appid: productId,
      platform: "ea-official",
      skipped: true,
      pendingSchema: true,
      save_path: path.dirname(logFilePath),
      ea_log_file: logFilePath,
      ea_achievement_set: achievementSet || "",
      snapshot: {},
    };
  }

  const schemaBase = path.join(outputDir, "schema");
  const destSchemaDir = path.join(schemaBase, "ea-official", productId);
  fs.mkdirSync(destSchemaDir, { recursive: true });

  const schemaResult = await ensureEaOfficialSchema(productId, destSchemaDir, {
    entry,
    logFilePath,
    savePath: logsDir || path.dirname(logFilePath),
  });
  const schemaCount = Number(schemaResult?.count || 0);
  if (!Number.isFinite(schemaCount) || schemaCount <= 0) {
    autoConfigLogger.info("ea-official:schema-pending", {
      appid: productId,
      achievementSet: entry.achievementSet || null,
      logFilePath,
      schemaCount,
    });
    return {
      appid: productId,
      platform: "ea-official",
      skipped: true,
      pendingSchema: true,
      save_path: path.dirname(logFilePath),
      config_path: destSchemaDir,
      ea_log_file: logFilePath,
      ea_achievement_set: entry.achievementSet || "",
      snapshot: buildEaOfficialSnapshot(entry, null),
    };
  }

  const existingVariant =
    resolveExistingVariant(configVariantIndex, productId, "ea-official") ||
    null;
  const resolvedBase =
    String(opts.preferredName || "").trim() ||
    String(entry.gameName || schemaResult?.title || "").trim() ||
    `EA ${productId}`;
  const defaultCfgName = `${resolvedBase} (EA Official)`;
  const desiredFileBase = sanitizeFilename(defaultCfgName);
  const targetInfo = existingVariant
    ? {
        filePath: existingVariant.filePath,
        name: existingVariant.name || defaultCfgName,
        reused: true,
      }
    : {
        filePath: path.join(outputDir, `${desiredFileBase}.json`),
        name: defaultCfgName,
        reused: false,
      };

  const existingConfig = readJsonSafe(targetInfo.filePath) || {};
  const nextConfig = {
    ...existingConfig,
    name: path.basename(targetInfo.filePath, ".json"),
    displayName: defaultCfgName,
    appid: productId,
    platform: "ea-official",
    config_path: destSchemaDir,
    save_path: path.dirname(logFilePath),
    ea_log_file: logFilePath,
    ea_achievement_set:
      entry.achievementSet || existingConfig.ea_achievement_set || undefined,
    ea_offer_id: entry.offerId || existingConfig.ea_offer_id || undefined,
    ea_install_path:
      entry.installPath || existingConfig.ea_install_path || undefined,
    executable:
      entry.exePath ||
      (typeof existingConfig.executable === "string"
        ? existingConfig.executable
        : ""),
    arguments:
      typeof existingConfig.arguments === "string"
        ? existingConfig.arguments
        : "",
    process_name:
      entry.processName ||
      (hasProcessNameValue(existingConfig.process_name)
        ? normalizeProcessNameValue(existingConfig.process_name)
        : entry.exePath
          ? path.basename(entry.exePath)
          : ""),
  };
  if (nextConfig.steamAppId) delete nextConfig.steamAppId;

  const previousSerialized = fs.existsSync(targetInfo.filePath)
    ? fs.readFileSync(targetInfo.filePath, "utf8")
    : null;
  const nextSerialized = JSON.stringify(nextConfig, null, 2);
  const created = !fs.existsSync(targetInfo.filePath);
  const updated = created || previousSerialized !== nextSerialized;
  if (updated) {
    fs.writeFileSync(targetInfo.filePath, nextSerialized);
  }

  registerConfigVariant(configVariantIndex, productId, "ea-official", {
    filePath: targetInfo.filePath,
    name: path.basename(targetInfo.filePath, ".json"),
  });

  if (
    typeof opts.onSeedCache === "function" &&
    schemaResult?.snapshot &&
    Object.keys(schemaResult.snapshot).length
  ) {
    try {
      opts.onSeedCache({
        appid: productId,
        configName: path.basename(targetInfo.filePath, ".json"),
        platform: "ea-official",
        savePath: path.dirname(logFilePath),
        snapshot: schemaResult.snapshot,
      });
    } catch (err) {
      autoConfigLogger.warn("ea-official:seed-cache-failed", {
        appid: productId,
        error: err?.message || String(err),
      });
    }
  }

  autoConfigLogger.info("ea-official:config-ready", {
    appid: productId,
    filePath: targetInfo.filePath,
    created,
    updated,
    achievementSet: entry.achievementSet || null,
    offerId: entry.offerId || null,
    logFilePath,
  });

  return {
    appid: productId,
    name: path.basename(targetInfo.filePath, ".json"),
    filePath: targetInfo.filePath,
    platform: "ea-official",
    save_path: path.dirname(logFilePath),
    config_path: destSchemaDir,
    ea_log_file: logFilePath,
    ea_achievement_set: entry.achievementSet || "",
    ea_offer_id: entry.offerId || "",
    created,
    updated,
    snapshot: schemaResult?.snapshot || {},
  };
}
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121 Safari/537.36";
function decodeHtml(s) {
  return String(s || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}
function cleanText(x) {
  return decodeHtml(String(x || "").replace(/<[^>]*>/g, ""))
    .replace(/\s+/g, " ")
    .trim();
}
function isBadName(name) {
  const n = (name || "").trim();
  return !n || /^steam hunters$/i.test(n);
}
function extractNameFromSteamHuntersHtml(html) {
  const H = String(html || "");
  // 1) Banner: <span.flex-link-underline> din <h1><a>…</a></h1>
  //    (not “Steam Hunters”, second)
  let m =
    /<main[\s\S]*?<div[^>]*class="[^"]*\bbanner\b[^"]*"[^>]*>[\s\S]*?<div[^>]*class="[^"]*\bmedia-body\b[^"]*"[^>]*>[\s\S]*?<h1[^>]*>[\s\S]*?<a[^>]*>\s*<span[^>]*class="[^"]*\bflex-link-underline\b[^"]*"[^>]*>[\s\S]*?<\/span>\s*<span[^>]*class="[^"]*\bflex-link-underline\b[^"]*"[^>]*>([\s\S]*?)<\/span>/i.exec(
      H,
    );
  if (m && m[1]) {
    const name = cleanText(m[1]);
    if (!isBadName(name)) return name;
  }
  // 2) Breadcrumb: <span class="text-ellipsis app-name after">
  m =
    /<header[\s\S]*?<span[^>]*class="[^"]*\btext-ellipsis\b[^"]*\bapp-name\b[^"]*(?:\bafter\b)?[^"]*"[^>]*>([\s\S]*?)<\/span>/i.exec(
      H,
    );
  if (m && m[1]) {
    const name = cleanText(m[1]);
    if (!isBadName(name)) return name;
  }
  return null;
}
async function getGameNameFromSteamHunters(appid) {
  try {
    const url = `https://steamhunters.com/apps/${appid}/achievements`;
    const res = await axios.get(url, {
      headers: { "User-Agent": UA, Accept: "text/html" },
      timeout: 15000,
      validateStatus: (s) => s >= 200 && s < 500,
    });
    if (res.status >= 400) return null;
    const name = extractNameFromSteamHuntersHtml(res.data || "");
    if (!name) {
      autoConfigLogger.warn("steam-hunters:name-missing", { appid });
    }
    return name || null;
  } catch (e) {
    autoConfigLogger.warn("steam-hunters:request-failed", {
      appid,
      error: e?.message || String(e),
    });
    return null;
  }
}

function firstLocalizedText(value) {
  if (!value) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "object") {
    if (typeof value["*"] === "string" && value["*"].trim()) {
      return value["*"].trim();
    }
    if (typeof value.value === "string" && value.value.trim()) {
      return value.value.trim();
    }
    for (const candidate of Object.values(value)) {
      if (typeof candidate === "string" && candidate.trim()) {
        return candidate.trim();
      }
    }
  }
  return "";
}

function extractGogTitle(payload) {
  if (!payload) return "";
  if (typeof payload === "string") return payload.trim();
  if (Array.isArray(payload)) {
    for (const entry of payload) {
      const title = extractGogTitle(entry);
      if (title) return title;
    }
    return "";
  }
  if (typeof payload !== "object") return "";

  const candidates = [
    payload.title,
    payload.name,
    payload.productTitle,
    payload.game?.title,
    payload.game?.name,
    payload.product?.title,
    payload.product?.name,
    payload.products?.[0]?.name,
  ];

  for (const candidate of candidates) {
    const title = firstLocalizedText(candidate);
    if (title) return title;
  }
  return "";
}

async function getGameNameFromGogDb(appid) {
  const normalizedAppId = String(appid || "").trim();
  const attempts = [
    {
      source: "gamesdb.external_releases",
      url: `https://gamesdb.gog.com/platforms/gog/external_releases/${normalizedAppId}`,
    },
    {
      source: "api.gog.com/products",
      url: `https://api.gog.com/products/${normalizedAppId}?locale=en_US`,
    },
    {
      source: "api.gog.com/v2/games",
      url: `https://api.gog.com/v2/games/${normalizedAppId}?locale=en-US`,
    },
  ];
  const failures = [];

  for (const attempt of attempts) {
    try {
      const res = await axios.get(attempt.url, { timeout: 15000 });
      const title = extractGogTitle(res.data);
      if (title) {
        gogNameFallbackAppIds.add(normalizedAppId);
        autoConfigLogger.info("gog:name-resolved", {
          appid: normalizedAppId,
          title,
          source: attempt.source,
        });
        return title;
      }
      failures.push({
        source: attempt.source,
        reason: "title-missing",
      });
    } catch (err) {
      failures.push({
        source: attempt.source,
        status: err?.response?.status || null,
        error: err?.message || String(err),
      });
    }
  }

  autoConfigLogger.warn("gog:name-lookup-failed", {
    appid: normalizedAppId,
    attempts: failures,
  });
  return null;
}

// Epic name resolution helpers
let epicProductMap = null;
const epicEgdataTitleCache = new Map();
async function loadEpicProductMap() {
  if (epicProductMap) return epicProductMap;
  try {
    const url =
      "https://store-content.ak.epicgames.com/api/content/productmapping/";
    const res = await axios.get(url, { timeout: 20000 });
    if (res.data && typeof res.data === "object") {
      epicProductMap = res.data;
      return epicProductMap;
    }
  } catch (err) {
    autoConfigLogger.warn("epic-productmap:fetch-failed", {
      error: err?.message || String(err),
    });
  }
  epicProductMap = {};
  return epicProductMap;
}

async function getEpicSlug(appid) {
  const map = await loadEpicProductMap();
  const key = String(appid || "");
  return map?.[key] || map?.[key.toLowerCase()] || null;
}

async function getEpicTitle(appid) {
  const slug = await getEpicSlug(appid);
  if (!slug) return null;
  try {
    const url = `https://store-content.ak.epicgames.com/api/en-US/content/products/${slug}`;
    const res = await axios.get(url, { timeout: 15000 });
    const data = res.data || {};
    const candidates = [];
    if (typeof data.productName === "string") candidates.push(data.productName);
    else if (data.productName && typeof data.productName.value === "string")
      candidates.push(data.productName.value);
    // cache cover assets for epic
    const hero =
      data.hero ||
      (Array.isArray(data.pages)
        ? data.pages
            .map((p) => p?.data?.hero || p?.hero)
            .find(
              (h) =>
                h &&
                (h.portraitBackgroundImageUrl ||
                  h.backgroundImageUrl ||
                  h.title),
            )
        : null);
    if (hero) {
      if (typeof hero.title === "string") candidates.push(hero.title);
      try {
        const imagesRoot = path.join(
          userDataDir,
          "images",
          "epic",
          String(appid),
        );
        fs.mkdirSync(imagesRoot, { recursive: true });
        const downloadIf = async (url, fileName) => {
          if (!url) return;
          try {
            const resp = await axios.get(url, {
              responseType: "arraybuffer",
              timeout: 20000,
            });
            fs.writeFileSync(path.join(imagesRoot, fileName), resp.data);
          } catch (e) {
            autoConfigLogger.warn("epic:cover-download-failed", {
              appid,
              url,
              error: e?.message || String(e),
            });
          }
        };
        await downloadIf(hero.portraitBackgroundImageUrl, `${appid}.jpg`);
        await downloadIf(hero.backgroundImageUrl, "header.jpg");
      } catch (e) {
        autoConfigLogger.warn("epic:cover-save-failed", {
          appid,
          error: e?.message || String(e),
        });
      }
    }
    const title = candidates.find((t) => t && t.trim()) || "";
    if (title) {
      autoConfigLogger.info("epic:name-resolved", { appid, slug, title });
      return title.trim();
    }
  } catch (err) {
    autoConfigLogger.warn("epic:name-fetch-failed", {
      appid,
      slug,
      error: err?.message || String(err),
    });
  }
  return null;
}

function cleanEpicPageTitle(rawTitle) {
  return decodeHtml(String(rawTitle || ""))
    .replace(/\s*-\s*Achievements\s*\|\s*Sandbox\s*$/i, "")
    .replace(/\s*\|\s*EGDATA(?:\.APP)?\s*$/i, "")
    .replace(/\s*-\s*EGDATA(?:\.APP)?\s*$/i, "")
    .trim();
}

function extractMetaContentByKey(html, key) {
  const tags = String(html || "").match(/<meta\b[^>]*>/gi) || [];
  const wanted = String(key || "")
    .trim()
    .toLowerCase();
  for (const tag of tags) {
    const attrs = {};
    const re = /([:@\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
    let m;
    while ((m = re.exec(tag))) {
      const attrKey = String(m[1] || "").toLowerCase();
      attrs[attrKey] = m[2] ?? m[3] ?? m[4] ?? "";
    }
    const lookup = String(attrs.name || attrs.property || "")
      .trim()
      .toLowerCase();
    if (lookup === wanted && attrs.content) {
      return cleanEpicPageTitle(attrs.content);
    }
  }
  return null;
}

function extractEpicTitleFromHtml(html) {
  const source = String(html || "");
  const headMatch = source.match(
    /<head[\s\S]*?<title[^>]*>([\s\S]*?)<\/title>/i,
  );
  if (headMatch && headMatch[1]) {
    const headTitle = cleanEpicPageTitle(
      String(headMatch[1]).replace(/<[^>]*>/g, ""),
    );
    if (headTitle) return headTitle;
  }
  const ogTitle = extractMetaContentByKey(source, "og:title");
  if (ogTitle) return ogTitle;
  const twitterTitle = extractMetaContentByKey(source, "twitter:title");
  if (twitterTitle) return twitterTitle;
  return null;
}

async function getEpicTitleFromEgdata(appid) {
  const id = String(appid || "").trim();
  if (!id) return null;
  if (epicEgdataTitleCache.has(id)) {
    return epicEgdataTitleCache.get(id);
  }
  const pageUrl = `https://egdata.app/sandboxes/${id}/achievements`;
  try {
    const res = await axios.get(pageUrl, {
      headers: {
        "User-Agent": UA,
        Accept: "text/html,application/xhtml+xml,*/*",
        "Accept-Language": "en-US,en;q=0.9",
      },
      timeout: 15000,
      validateStatus: (s) => s >= 200 && s < 500,
    });
    if (res.status >= 400 || typeof res.data !== "string") {
      autoConfigLogger.warn("epic:name-egdata-http-failed", {
        appid: id,
        status: res.status,
      });
      epicEgdataTitleCache.set(id, null);
      return null;
    }
    const title = extractEpicTitleFromHtml(res.data);
    if (title) {
      autoConfigLogger.info("epic:name-resolved-egdata", {
        appid: id,
        title,
      });
      epicEgdataTitleCache.set(id, title);
      return title;
    }
    autoConfigLogger.warn("epic:name-egdata-missing", { appid: id });
  } catch (err) {
    autoConfigLogger.warn("epic:name-egdata-fetch-failed", {
      appid: id,
      error: err?.message || String(err),
    });
  }
  epicEgdataTitleCache.set(id, null);
  return null;
}

async function getGameName(appid, opts = {}, retries = 2) {
  const platformHint = normalizePlatform(opts?.platform);
  const preferredName = (opts?.preferredName || "").trim();
  if (
    preferredName &&
    (platformHint === "gog" || platformHint === "gog-official")
  ) {
    return preferredName;
  }
  const hasHex = /[a-f]/i.test(String(appid || ""));
  if (hasHex) {
    const epicName = await getEpicTitle(appid);
    if (epicName) return epicName;
    const egdataTitle = await getEpicTitleFromEgdata(appid);
    if (egdataTitle) return egdataTitle;
    // For Epic IDs, do not fall back to Steam/GOG
    return null;
  }
  if (platformHint === "gog" || platformHint === "gog-official") {
    const gogName = await getGameNameFromGogDb(appid);
    if (gogName) return gogName;
    return preferredName || null;
  }

  const localSteamDbName = lookupSteamDbName(appid, { userDataDir });
  if (localSteamDbName) {
    autoConfigLogger.info("local-name:steamdb-hit", {
      appid,
      platform: platformHint || "steam",
      name: localSteamDbName,
    });
    return localSteamDbName;
  }

  let nameFromStore = null;
  try {
    const url = `https://store.steampowered.com/api/appdetails?appids=${appid}`;
    const res = await axios.get(url, { timeout: 15000 });
    const entry = res.data?.[String(appid)];
    if (entry?.success && entry?.data?.name) {
      nameFromStore = entry.data.name;
    } else {
      autoConfigLogger.warn("store-api:name-missing", {
        appid,
        success: entry?.success ?? null,
      });
    }
  } catch (err) {
    if (err.response && err.response.status === 429 && retries > 0) {
      autoConfigLogger.warn("store-api:rate-limit", { appid, retries });
      await new Promise((r) => setTimeout(r, 2000));
      return getGameName(appid, opts, retries - 1);
    }
    autoConfigLogger.error("store-api:request-failed", {
      appid,
      error: err?.message || String(err),
    });
  }
  if (nameFromStore) return nameFromStore;
  // Fallback SteamHunters
  autoConfigLogger.info("fallback:steam-hunters", { appid });
  const shName = await getGameNameFromSteamHunters(appid);
  if (shName) return shName;
  autoConfigLogger.warn("fallback:steam-hunters-failed", { appid });
  autoConfigLogger.info("fallback:gog-name", { appid });
  const gogName = await getGameNameFromGogDb(appid);
  if (gogName) return gogName;
  autoConfigLogger.warn("fallback:gog-name-failed", { appid });
  return null;
}

function resolveLocalUplayName(appid, mapping = null) {
  const id = String(appid || "").trim();
  if (!id) return null;
  const entry =
    mapping && String(mapping?.uplay_id || "").trim() === id
      ? mapping
      : lookupUplayMappingEntry(id, { userDataDir });
  const steamName = String(entry?.steam_name || "").trim();
  if (steamName) return steamName;
  const uplayName = String(entry?.uplay_name || "").trim();
  if (uplayName) return uplayName;
  return null;
}

function clampGenerationProgressPercent(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  if (n <= 0) return 0;
  if (n >= 100) return 100;
  return Math.round(n);
}

function emitGenerationProgress(callback, payload = {}) {
  if (typeof callback !== "function") return;
  try {
    callback({
      ...payload,
      current:
        Number.isFinite(Number(payload.current)) && Number(payload.current) >= 0
          ? Number(payload.current)
          : 0,
      total:
        Number.isFinite(Number(payload.total)) && Number(payload.total) >= 0
          ? Number(payload.total)
          : 0,
      percent: clampGenerationProgressPercent(payload.percent, 0),
    });
  } catch {}
}

function formatGenerationCounter(current, total, label = "") {
  const cur =
    Number.isFinite(Number(current)) && Number(current) > 0
      ? Number(current)
      : 0;
  const max =
    Number.isFinite(Number(total)) && Number(total) > 0 ? Number(total) : 0;
  if (!cur || !max) return label || "";
  return label ? `${label} (${cur}/${max})` : `${cur}/${max}`;
}
// run generate_achievements_schema.js
function runAchievementsGenerator(
  appid,
  schemaBaseDir,
  userDataDir,
  opts = {},
) {
  return new Promise((resolve, reject) => {
    const script = path.join(__dirname, "generate_achievements_schema.js");
    const isElectron = !!process.versions.electron;
    const nodeBin = isElectron
      ? process.platform === "win32"
        ? "node.exe"
        : "node"
      : process.execPath;
    const platform =
      typeof opts.platform === "string" && opts.platform.length
        ? opts.platform.toLowerCase()
        : null;
    const schemaLangs = normalizeSchemaLanguageList(opts.langs);
    const args = [
      String(appid),
      "--apps-concurrency=1",
      `--out=${schemaBaseDir}`,
      `--user-data-dir=${userDataDir}`,
    ];
    if (platform) args.push(`--platform=${platform}`);
    if (schemaLangs.length) args.push(`--langs=${schemaLangs.join(",")}`);
    const logDir = path.join(app.getPath("userData"), "logs");
    try {
      fs.mkdirSync(logDir, { recursive: true });
    } catch {}
    autoConfigLogger.info("achgen:spawn", {
      appid,
      args,
      script,
    });
    let launchMetadata = null;
    const cp = fork(script, args, {
      stdio: ["pipe", "pipe", "pipe", "ipc"],
      env: {
        ...process.env,
        LOGGER_DIR: logDir,
        LOGGER_SUPPRESS_CLEAR: "1",
      },
      windowsHide: true,
    });
    // IPC messages
    cp.on("message", (msg) => {
      if (!msg) return;
      if (msg.type === "achgen:progress") {
        emitGenerationProgress(opts.onProgress, {
          appid: String(msg.appid || appid),
          phase: String(msg.phase || ""),
          detail: String(msg.detail || ""),
          current:
            Number.isFinite(Number(msg.current)) && Number(msg.current) >= 0
              ? Number(msg.current)
              : 0,
          total:
            Number.isFinite(Number(msg.total)) && Number(msg.total) >= 0
              ? Number(msg.total)
              : 0,
          percent: clampGenerationProgressPercent(msg.percent, 0),
        });
        return;
      }
      if (msg.type === "achgen:log") {
        const suppressUi = shouldSuppressAchgenMessageInUi(msg.message);
        if (global.mainWindow && !suppressUi) {
          global.mainWindow.webContents.send("achgen:log", msg);
        }
        const level =
          msg.level === "error"
            ? "error"
            : msg.level === "warn"
              ? "warn"
              : "info";
        const payload = {
          appid,
          message: msg.message,
        };
        try {
          autoConfigLogger[level]?.("achgen:child-log", payload);
        } catch {
          autoConfigLogger.info("achgen:child-log", payload);
        }
      } else if (msg && msg.type === "achgen:launch-metadata") {
        launchMetadata = {
          process_name: normalizeProcessNameValue(msg.process_name),
          arguments: String(msg.arguments || ""),
        };
        autoConfigLogger.info("achgen:launch-metadata", {
          appid,
          process_name: launchMetadata.process_name || null,
          hasArguments: !!launchMetadata.arguments,
        });
      }
    });
    cp.stdout.on("data", (buf) => {
      const line = buf.toString();
      if (global.mainWindow)
        global.mainWindow.webContents.send("achgen:stdout", line);
      process.stdout.write(line);
    });
    cp.stderr.on("data", (buf) => {
      const line = buf.toString();
      if (global.mainWindow)
        global.mainWindow.webContents.send("achgen:stderr", line);
      process.stderr.write(line);
    });
    cp.on("error", (err) => {
      autoConfigLogger.error("achgen:process-error", {
        appid,
        error: err?.message || String(err),
      });
      reject(err);
    });
    cp.on("close", (code) => {
      if (code === 0) {
        autoConfigLogger.info("achgen:process-exit", { appid, code });
        resolve({ launchMetadata });
      } else {
        autoConfigLogger.error("achgen:process-exit", { appid, code });
        reject(new Error(`Code: ${code}`));
      }
    });
  });
}
async function generateGameConfigs(folderPath, outputDir, opts = {}) {
  const onSeedCache = opts.onSeedCache || null;
  const onGenerationProgress =
    typeof opts.onGenerationProgress === "function"
      ? opts.onGenerationProgress
      : null;
  const forcedPlatform = normalizePlatform(opts.forcePlatform) || null;
  const schemaLanguages = resolveSchemaLanguagesForGenerator(
    opts.schemaLanguages,
  );
  if (forcedPlatform) {
    autoConfigLogger.info("generate:forced-platform", {
      targetPlatform: forcedPlatform,
      folderPath,
    });
  }
  const configVariantIndex = loadConfigVariantIndex(outputDir);
  if (!folderPath || !fs.existsSync(folderPath)) {
    throw new Error("Folder is not valid.");
  }
  autoConfigLogger.info("scan:start", {
    inputDir: folderPath,
    outputDir,
  });
  const dirents = fs.readdirSync(folderPath, { withFileTypes: true });
  const folders = dirents.filter((d) => d.isDirectory()).map((d) => d.name);
  const appidFolders = folders.filter((f) => /^[0-9a-fA-F]+$/.test(f));
  const blacklist = getBlacklistedAppIdsSet();
  // nothing found
  if (appidFolders.length === 0) {
    autoConfigLogger.warn("scan:no-appids", { folderPath });
    return {
      processed: 0,
      created: 0,
      updated: 0,
      skipped: 0,
      failed: 0,
      outputDir,
    };
  }
  // <outputDir>/schema/<platform>/<appid>
  const schemaBase = path.join(outputDir, "schema");
  if (!fs.existsSync(schemaBase)) fs.mkdirSync(schemaBase, { recursive: true });
  let processed = 0,
    created = 0,
    updated = 0,
    skipped = 0,
    failed = 0;
  const totalItems = appidFolders.length;
  const emitBatchProgress = (itemIndex, itemPercent, payload = {}) => {
    if (!totalItems) return;
    const normalizedItemPercent = clampGenerationProgressPercent(
      itemPercent,
      0,
    );
    const overallPercent =
      ((itemIndex + normalizedItemPercent / 100) / totalItems) * 100;
    emitGenerationProgress(onGenerationProgress, {
      kind: "config-generate",
      scope: totalItems > 1 ? "batch" : "single",
      current: Math.min(itemIndex + 1, totalItems),
      total: totalItems,
      percent: overallPercent,
      ...payload,
    });
  };
  for (let itemIndex = 0; itemIndex < appidFolders.length; itemIndex += 1) {
    const appid = appidFolders[itemIndex];
    processed++;
    emitBatchProgress(itemIndex, 2, {
      appid,
      itemName: appid,
      phase: "preparing",
      detail: "Preparing config generation",
    });
    if (blacklist.has(String(appid))) {
      autoConfigLogger.info("scan:skip-blacklisted", { appid });
      skipped++;
      emitBatchProgress(itemIndex, 100, {
        appid,
        itemName: appid,
        phase: "skipped",
        detail: "AppID is blacklisted",
      });
      continue;
    }
    const uplayId = String(appid);
    let mapping = uplayToSteam.get(uplayId);
    const isHexId = /[a-f]/i.test(uplayId);
    let mappingForRun =
      !forcedPlatform || forcedPlatform === "uplay" ? mapping : null;
    const nameSourceId = isHexId
      ? appid
      : mappingForRun?.steam_appid && mappingForRun.steam_appid !== uplayId
        ? String(mapping.steam_appid)
        : appid;
    let gameSaveDir =
      opts.savePathOverride && opts.savePathOverride.trim()
        ? opts.savePathOverride
        : path.join(folderPath);
    const maybeRemote = path.join(folderPath, "remote", appid);
    if (
      folderPath.toLowerCase().includes("empress") &&
      fs.existsSync(maybeRemote)
    ) {
      gameSaveDir = maybeRemote;
    }
    const existingByPath = findExistingConfigBySavePath(
      configVariantIndex,
      uplayId,
      gameSaveDir,
    );
    const initialPlatformMeta = resolvePlatformMetadata({
      appid: uplayId,
      mapping: mappingForRun,
      forcePlatform: forcedPlatform,
    });
    let name = existingByPath?.name || null;
    autoConfigLogger.info("scan:processing-appid", {
      appid,
      nameAppId: nameSourceId,
    });
    emitBatchProgress(itemIndex, 12, {
      appid: uplayId,
      itemName: uplayId,
      phase: "resolvingName",
      detail: "Resolving game name",
    });
    if (name) {
      autoConfigLogger.info("scan:skip-name-lookup", {
        appid: uplayId,
        savePath: gameSaveDir,
        configName: name,
      });
    } else {
      if (initialPlatformMeta.platform === "uplay") {
        const localUplayName = resolveLocalUplayName(uplayId, mappingForRun);
        if (localUplayName) {
          name = localUplayName;
          autoConfigLogger.info("local-name:uplay-map-hit", {
            appid: uplayId,
            name: localUplayName,
          });
        }
      }
    }
    if (!name) {
      name = await getGameName(nameSourceId, {
        platform: forcedPlatform || initialPlatformMeta.platform,
        preferredName: opts.preferredName || "",
      });
    }
    const effectiveSteamId =
      mappingForRun?.steam_appid && mappingForRun.steam_appid !== uplayId
        ? String(mapping.steam_appid)
        : null;
    if (!name) {
      autoConfigLogger.warn("scan:missing-game-name", { effectiveSteamId });
      skipped++;
      emitBatchProgress(itemIndex, 100, {
        appid: uplayId,
        itemName: uplayId,
        phase: "skipped",
        detail: "Game name not found",
      });
      continue;
    }
    let safeName = sanitizeFilename(name);
    const platformMeta = {
      platform: initialPlatformMeta.platform,
      steamAppId: initialPlatformMeta.steamAppId,
    };
    const existingPlatform = normalizePlatform(
      existingByPath?.config?.platform,
    );
    if (existingPlatform && !forcedPlatform) {
      platformMeta.platform = existingPlatform;
      if (existingByPath?.config?.steamAppId && !platformMeta.steamAppId) {
        platformMeta.steamAppId = String(existingByPath.config.steamAppId);
      }
    }
    if (isHexId && !forcedPlatform) {
      platformMeta.platform = "epic";
      platformMeta.steamAppId = "";
    } else {
      const preferGogPlatform =
        gogNameFallbackAppIds.has(String(nameSourceId)) ||
        gogNameFallbackAppIds.has(uplayId);
      if (preferGogPlatform && !forcedPlatform) {
        platformMeta.platform = "gog";
        platformMeta.steamAppId = "";
      }
    }
    autoConfigLogger.info("generate:platform-selected", {
      appid: uplayId,
      platform: platformMeta.platform,
      steamAppId: platformMeta.steamAppId || null,
      forced: !!forcedPlatform,
    });
    const targetInfo = resolveConfigTarget({
      outputDir,
      baseName: safeName,
      appid: uplayId,
      platform: platformMeta.platform,
      index: configVariantIndex,
    });
    safeName = targetInfo.name;
    const filePath = targetInfo.filePath;
    const storagePlatform =
      platformMeta.platform === "uplay"
        ? "uplay"
        : platformMeta.platform === "gog"
          ? "gog"
          : platformMeta.platform === "epic"
            ? "epic"
            : "steam";
    const destSchemaDir = path.join(schemaBase, storagePlatform, String(appid));
    const destAchievementsJson = path.join(destSchemaDir, "achievements.json");
    if (!fs.existsSync(destSchemaDir))
      fs.mkdirSync(destSchemaDir, { recursive: true });
    const ensureSchema = async () => {
      let schemaLaunchMetadata = null;
      try {
        if (!fs.existsSync(destAchievementsJson)) {
          emitBatchProgress(itemIndex, 28, {
            appid: uplayId,
            itemName: safeName || name || uplayId,
            phase: "generatingSchema",
            detail: "Starting schema generation",
          });
          const userDataDir = app.getPath("userData");
          const attemptPlatforms = (() => {
            if (platformMeta.platform === "steam") return ["steam"];
            if (platformMeta.platform === "uplay") return ["uplay"];
            if (platformMeta.platform === "gog") return ["gog"];
            if (platformMeta.platform === "epic") return ["epic"];
            return mappingForRun?.steam_appid &&
              mappingForRun.steam_appid !== uplayId
              ? ["uplay"]
              : ["uplay", "auto"];
          })();
          let generated = false;
          let lastError = null;
          for (const platformMode of attemptPlatforms) {
            try {
              const generatorResult = await runAchievementsGenerator(
                uplayId,
                schemaBase,
                userDataDir,
                {
                  platform: platformMode,
                  langs: schemaLanguages,
                  onProgress: (progress) => {
                    const childPercent = clampGenerationProgressPercent(
                      progress?.percent,
                      0,
                    );
                    emitBatchProgress(itemIndex, 30 + childPercent * 0.55, {
                      appid: uplayId,
                      itemName: safeName || name || uplayId,
                      phase: progress?.phase || "generatingSchema",
                      detail:
                        progress?.detail ||
                        formatGenerationCounter(
                          progress?.current,
                          progress?.total,
                          "Generating schema",
                        ),
                    });
                  },
                },
              );
              if (generatorResult?.launchMetadata) {
                schemaLaunchMetadata = generatorResult.launchMetadata;
              }
              if (
                platformMode === "uplay" &&
                (!mappingForRun || !mappingForRun.steam_appid)
              ) {
                if (reloadUplayMappingFromDisk()) {
                  mapping = uplayToSteam.get(uplayId) || mapping;
                  mappingForRun =
                    !forcedPlatform || forcedPlatform === "uplay"
                      ? mapping
                      : null;
                }
              }
              generated = true;
              break;
            } catch (err) {
              lastError = err;
              autoConfigLogger.warn("achgen:attempt-failed", {
                appid: uplayId,
                platform: platformMode,
                error: err?.message || String(err),
              });
            }
          }
          if (!generated) {
            throw lastError || new Error("achievements-generator failed");
          }
        } else {
          emitBatchProgress(itemIndex, 82, {
            appid: uplayId,
            itemName: safeName || name || uplayId,
            phase: "generatingSchema",
            detail: "Schema already exists",
          });
          const displayId = effectiveSteamId || appid;
          const txt = `⏭ [${displayId}] Achievements schema exists. Skip generating!`;
          if (global.mainWindow) {
            global.mainWindow.webContents.send("achgen:log", {
              type: "achgen:log",
              level: "info",
              message: txt,
            });
            global.mainWindow.webContents.send(
              "achgen:stdout",
              `[achgen] ${txt}\n`,
            );
          }
          autoConfigLogger.info("achgen:schema-exists", {
            appid,
            path: destAchievementsJson,
          });
        }
        if (mapping?.steam_appid) {
          try {
            const fileRaw = fs.readFileSync(destAchievementsJson, "utf8");
            const parsed = JSON.parse(fileRaw);
            const entries = Array.isArray(parsed)
              ? parsed
              : Array.isArray(parsed?.achievements)
                ? parsed.achievements
                : null;
            if (entries) {
              const normalized = entries.map((ach) => ({
                ...ach,
                name: normalizeAchievementName(ach.name, true),
              }));
              if (Array.isArray(parsed)) {
                fs.writeFileSync(
                  destAchievementsJson,
                  JSON.stringify(normalized, null, 2),
                );
              } else {
                parsed.achievements = normalized;
                fs.writeFileSync(
                  destAchievementsJson,
                  JSON.stringify(parsed, null, 2),
                );
              }
            }
          } catch (err) {
            autoConfigLogger.warn("schema:strip-prefix-failed", {
              appid: uplayId,
              error: err?.message || String(err),
            });
          }
        }
      } catch (e) {
        autoConfigLogger.error("achgen:schema-failed", {
          appid,
          error: e?.message || String(e),
        });
        failed++;
        emitBatchProgress(itemIndex, 88, {
          appid: uplayId,
          itemName: safeName || name || uplayId,
          phase: "failed",
          detail: e?.message || "Schema generation failed",
        });
        // continue
      }
      return schemaLaunchMetadata;
    };
    if (fs.existsSync(filePath)) {
      // if config exist, complete only
      emitBatchProgress(itemIndex, 84, {
        appid: uplayId,
        itemName: safeName || name || uplayId,
        phase: "writingConfig",
        detail: "Updating existing config",
      });
      const schemaLaunchMetadata = await ensureSchema();
      try {
        const curr = JSON.parse(fs.readFileSync(filePath, "utf8"));
        let changed = false;
        if (curr.platform !== platformMeta.platform) {
          curr.platform = platformMeta.platform;
          changed = true;
        }
        const nextSteamId = platformMeta.steamAppId || "";
        if (nextSteamId) {
          if (curr.steamAppId !== nextSteamId) {
            curr.steamAppId = nextSteamId;
            changed = true;
          }
        } else if (curr.steamAppId) {
          delete curr.steamAppId;
          changed = true;
        }
        if (!curr.config_path) {
          curr.config_path = destSchemaDir;
          changed = true;
        }
        if (opts.savePathOverride) {
          if (curr.save_path !== opts.savePathOverride) {
            curr.save_path = opts.savePathOverride;
            changed = true;
          }
        } else if (!curr.save_path) {
          curr.save_path = gameSaveDir;
          changed = true;
        }
        if (opts.emu && curr.emu !== opts.emu) {
          curr.emu = opts.emu;
          changed = true;
        }
        if (platformMeta.platform === "steam") {
          const launchMetadata =
            schemaLaunchMetadata ||
            (hasProcessNameValue(curr.process_name) &&
            String(curr.arguments || "").trim()
              ? null
              : await fetchSteamDbLaunchMetadata(appid));
          if (applyLaunchMetadataToConfig(curr, launchMetadata)) {
            changed = true;
          }
        }
        if (changed) {
          fs.writeFileSync(filePath, JSON.stringify(curr, null, 2));
          autoConfigLogger.info("config:updated", {
            filePath,
            appid,
            name: safeName,
          });
          updated++;
          emitBatchProgress(itemIndex, 100, {
            appid: uplayId,
            itemName: curr.name || safeName || uplayId,
            phase: "completed",
            detail: "Config updated",
          });
        } else {
          skipped++;
          emitBatchProgress(itemIndex, 100, {
            appid: uplayId,
            itemName: curr.name || safeName || uplayId,
            phase: "skipped",
            detail: "Config already up to date",
          });
        }
        registerConfigVariant(
          configVariantIndex,
          uplayId,
          platformMeta.platform,
          {
            filePath,
            name: curr.name || safeName,
          },
        );
        await maybeSeedAchCache({
          appid,
          configName: safeName,
          save_path: curr.save_path || gameSaveDir,
          config_path: curr.config_path || destSchemaDir,
          platform: curr.platform || platformMeta.platform,
          onSeedCache,
        });
      } catch (e) {
        autoConfigLogger.error("config:update-failed", {
          appid,
          error: e?.message || String(e),
        });
        failed++;
        emitBatchProgress(itemIndex, 100, {
          appid: uplayId,
          itemName: safeName || name || uplayId,
          phase: "failed",
          detail: e?.message || "Failed to update config",
        });
      }
      continue;
    }
    // generate schema if missing
    const schemaLaunchMetadata = await ensureSchema();
    const gameData = {
      name: safeName,
      appid,
      platform: platformMeta.platform,
      steamAppId: platformMeta.steamAppId || undefined,
      // IMPORTANT: set path, if achievements.json missing
      config_path: destSchemaDir,
      save_path: gameSaveDir,
      executable: "",
      arguments: "",
      process_name: "",
    };
    if (!platformMeta.steamAppId) delete gameData.steamAppId;
    if (opts.savePathOverride) {
      gameData.save_path = opts.savePathOverride;
    }
    if (opts.emu) {
      gameData.emu = opts.emu;
    }
    if (platformMeta.platform === "steam") {
      const launchMetadata =
        schemaLaunchMetadata || (await fetchSteamDbLaunchMetadata(appid));
      applyLaunchMetadataToConfig(gameData, launchMetadata);
    }
    emitBatchProgress(itemIndex, 92, {
      appid: uplayId,
      itemName: safeName || name || uplayId,
      phase: "writingConfig",
      detail: "Writing config",
    });
    fs.writeFileSync(filePath, JSON.stringify(gameData, null, 2));
    registerConfigVariant(configVariantIndex, uplayId, platformMeta.platform, {
      filePath,
      name: safeName,
    });
    autoConfigLogger.info("config:saved", {
      filePath,
      appid,
      name: safeName,
    });
    created++;
    emitBatchProgress(itemIndex, 100, {
      appid: uplayId,
      itemName: safeName || name || uplayId,
      phase: "completed",
      detail: "Config created",
    });
    await maybeSeedAchCache({
      appid,
      configName: safeName,
      save_path: gameSaveDir,
      config_path: destSchemaDir,
      platform: platformMeta.platform,
      onSeedCache,
    });
  }
  if (processed > 0) {
    autoConfigLogger.info("scan:complete", {
      processed,
      created,
      updated,
      skipped,
      failed,
      outputDir,
    });
  } else {
    autoConfigLogger.warn("scan:no-configs-generated", { outputDir });
  }
  return { processed, created, updated, skipped, failed, outputDir };
}
async function generateConfigForAppId(appid, outputDir, opts = {}) {
  const onSeedCache = opts.onSeedCache || null;
  const onGenerationProgress =
    typeof opts.onGenerationProgress === "function"
      ? opts.onGenerationProgress
      : null;
  appid = String(appid);
  if (!/^[0-9a-fA-F]+$/.test(appid)) {
    autoConfigLogger.error("generate-single:invalid-appid", { appid });
    throw new Error(`Invalid appid: ${appid}`);
  }
  autoConfigLogger.info("generate-single:start", { appid, outputDir });
  const desiredPlatform = normalizePlatform(opts.forcePlatform) || null;
  if (desiredPlatform === "gog-official") {
    return generateGogOfficialConfigForProduct(appid, outputDir, {
      ...opts,
      onSeedCache,
    });
  }
  if (desiredPlatform === "ubisoft-official") {
    return generateUbisoftOfficialConfigForProduct(appid, outputDir, {
      ...opts,
      onSeedCache,
    });
  }
  if (desiredPlatform === "ea-official") {
    return generateEaOfficialConfigForProduct(appid, outputDir, {
      ...opts,
      onSeedCache,
    });
  }
  const appDir = opts?.appDir || null;
  const tmpRoot = path.join(
    os.tmpdir(),
    `ach_single_root_${appid}_${Date.now()}`,
  );
  const tmpAppDir = path.join(tmpRoot, appid);
  fs.mkdirSync(tmpAppDir, { recursive: true });
  autoConfigLogger.debug("generate-single:tmp-created", {
    appid,
    tmpRoot,
  });
  await generateGameConfigs(tmpRoot, outputDir, {
    onSeedCache,
    onGenerationProgress,
    forcePlatform: opts.forcePlatform || null,
    emu: opts.emu || null,
    savePathOverride: opts.savePathOverride || null,
    preferredName: opts.preferredName || null,
    schemaLanguages: opts.schemaLanguages,
  });
  autoConfigLogger.debug("generate-single:batch-generated", {
    appid,
    tmpRoot,
    outputDir,
  });
  const files = fs
    .readdirSync(outputDir)
    .filter((f) => f.toLowerCase().endsWith(".json"));
  let targetFile = null;
  for (const f of files) {
    try {
      const full = path.join(outputDir, f);
      const data = JSON.parse(fs.readFileSync(full, "utf8"));
      const id = String(
        data?.appid || data?.appId || data?.steamAppId || "",
      ).trim();
      if (id === appid) {
        const platform = normalizePlatform(data?.platform) || "steam";
        if (desiredPlatform && platform !== desiredPlatform) {
          continue;
        }
        targetFile = full;
        break;
      }
    } catch (err) {
      autoConfigLogger.warn("generate-single:list-parse-failed", {
        appid,
        file: path.join(outputDir, f),
        error: err?.message || String(err),
      });
    }
  }
  if (!targetFile && desiredPlatform) {
    for (const f of files) {
      try {
        const full = path.join(outputDir, f);
        const data = JSON.parse(fs.readFileSync(full, "utf8"));
        const id = String(
          data?.appid || data?.appId || data?.steamAppId || "",
        ).trim();
        if (id === appid) {
          targetFile = full;
          break;
        }
      } catch {}
    }
  }
  if ((opts.savePathOverride || opts.emu) && targetFile) {
    try {
      const data = JSON.parse(fs.readFileSync(targetFile, "utf8"));
      if (opts.savePathOverride) data.save_path = opts.savePathOverride;
      if (opts.emu) data.emu = opts.emu;
      fs.writeFileSync(targetFile, JSON.stringify(data, null, 2));
      autoConfigLogger.info("generate-single:override-config", {
        appid,
        targetFile,
        save_path: opts.savePathOverride || data.save_path || null,
        emu: data.emu || null,
      });
    } catch (err) {
      autoConfigLogger.warn("generate-single:override-config-failed", {
        appid,
        targetFile,
        error: err?.message || String(err),
      });
    }
  }
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    autoConfigLogger.debug("generate-single:tmp-cleaned", { appid, tmpRoot });
  } catch (err) {
    autoConfigLogger.warn("generate-single:tmp-clean-failed", {
      appid,
      tmpRoot,
      error: err?.message || String(err),
    });
  }
  if (!targetFile) {
    autoConfigLogger.warn("generate-single:target-missing", { appid });
    return {
      appid,
      skipped: true,
      pendingSchema: false,
    };
  }
  if (appDir) {
    try {
      const cfg = JSON.parse(fs.readFileSync(targetFile, "utf8"));
      const fixPath = (p) => {
        if (!p || typeof p !== "string") return p;
        if (p.startsWith(tmpRoot)) {
          const rel = path.relative(tmpRoot, p);
          return path.join(appDir, rel.replace(/^(\d+[\\/])?/, ""));
        }
        return p;
      };
      if (cfg.config_path) cfg.config_path = fixPath(cfg.config_path);
      if (cfg.save_path) cfg.save_path = fixPath(cfg.save_path);
      if (cfg.executable) cfg.executable = fixPath(cfg.executable);
      fs.writeFileSync(targetFile, JSON.stringify(cfg, null, 2));
      await maybeSeedAchCache({
        appid,
        configName: cfg.name || path.basename(targetFile, ".json"),
        save_path: cfg.save_path,
        config_path: cfg.config_path,
        platform: cfg.platform,
        onSeedCache,
      });
      autoConfigLogger.info("generate-single:completed", {
        appid,
        targetFile,
        appDir,
      });
    } catch (err) {
      autoConfigLogger.error("generate-single:repath-failed", {
        appid,
        error: err?.message || String(err),
      });
    }
  }
  if (!appDir) {
    try {
      const cfg = JSON.parse(fs.readFileSync(targetFile, "utf8"));
      await maybeSeedAchCache({
        appid,
        configName: cfg.name || path.basename(targetFile, ".json"),
        save_path: cfg.save_path,
        config_path: cfg.config_path,
        platform: cfg.platform,
        onSeedCache,
      });
      autoConfigLogger.info("generate-single:seeded", {
        appid,
        targetFile,
      });
    } catch (err) {
      autoConfigLogger.warn("generate-single:seed-failed", {
        appid,
        error: err?.message || String(err),
      });
    }
  }
  autoConfigLogger.info("generate-single:finish", {
    appid,
    targetFile,
    appDir: appDir || null,
  });
  try {
    const cfg = JSON.parse(fs.readFileSync(targetFile, "utf8"));
    return {
      appid: String(cfg?.appid || appid),
      name: path.basename(targetFile, ".json"),
      filePath: targetFile,
      platform: normalizePlatform(cfg?.platform) || "steam",
      save_path: cfg?.save_path || "",
      config_path: cfg?.config_path || "",
      created: true,
      updated: true,
      skipped: false,
    };
  } catch (err) {
    autoConfigLogger.warn("generate-single:return-parse-failed", {
      appid,
      targetFile,
      error: err?.message || String(err),
    });
    return {
      appid,
      name: path.basename(targetFile, ".json"),
      filePath: targetFile,
      platform: desiredPlatform || "steam",
      created: true,
      updated: true,
      skipped: false,
    };
  }
}
module.exports = { generateGameConfigs, generateConfigForAppId };
