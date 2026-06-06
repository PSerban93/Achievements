const fs = require("fs");
const path = require("path");
const os = require("os");
const axios = require("axios");
const { DatabaseSync } = require("node:sqlite");
const { createLogger } = require("./logger");
const {
  writeAchievementPercentagesSidecar,
  RARITY_SOURCES,
} = require("./achievement-rarity");
const { normalizeProcessNameValue } = require("./process-name-utils");

const gogGalaxyLogger = createLogger("gog-galaxy");

const DEFAULT_GOG_GALAXY_STORAGE_DB_PATH = path.join(
  process.env.ProgramData || "C:\\ProgramData",
  "GOG.com",
  "Galaxy",
  "storage",
  "galaxy-2.0.db",
);

const DEFAULT_GOG_GALAXY_APPLICATIONS_ROOT = path.join(
  process.env.LOCALAPPDATA ||
    path.join(os.homedir(), "AppData", "Local"),
  "GOG.com",
  "Galaxy",
  "Applications",
);

const GAMEPLAY_DB_NAME = "gameplay.db";
const PRODUCT_CACHE = new Map();
const DEFAULT_GAMEPLAY_STABILITY_POLL_MS = 1000;
const DEFAULT_GAMEPLAY_STABILITY_MAX_WAIT_MS = 20000;
const DEFAULT_GAMEPLAY_STABILITY_READS = 2;

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeId(value) {
  const raw = String(value || "").trim();
  return /^[0-9]+$/.test(raw) ? raw : "";
}

function normalizePath(inputPath) {
  if (!isNonEmptyString(inputPath)) return "";
  try {
    return path.resolve(inputPath);
  } catch {
    return "";
  }
}

function fileSignature(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return `${stat.size}:${stat.mtimeMs}`;
  } catch {
    return "missing";
  }
}

function makeGalaxyCacheKey(storageDbPath) {
  const dbPath = normalizePath(storageDbPath);
  if (!dbPath) return "";
  const walPath = `${dbPath}-wal`;
  const shmPath = `${dbPath}-shm`;
  return [dbPath, fileSignature(dbPath), fileSignature(walPath), fileSignature(shmPath)].join("|");
}

function openReadOnlyDatabase(dbPath) {
  const targetPath = normalizePath(dbPath);
  if (!targetPath || !fs.existsSync(targetPath)) {
    throw new Error(`sqlite-missing:${dbPath}`);
  }
  return new DatabaseSync(targetPath, { readOnly: true });
}

function prepareAll(db, sql, options = {}) {
  const stmt = db.prepare(sql);
  if (options.readBigInts === true && typeof stmt.setReadBigInts === "function") {
    stmt.setReadBigInts(true);
  }
  return stmt.all();
}

function safeCloseDatabase(db) {
  if (!db) return;
  try {
    db.close();
  } catch {
    /* ignore */
  }
}

function normalizeLaunchExecutablePath(value) {
  return isNonEmptyString(value) ? String(value).trim() : "";
}

function processNameFromExecutablePath(executablePath) {
  const normalized = normalizeLaunchExecutablePath(executablePath);
  if (!normalized) return "";
  return path.win32.basename(normalized.replace(/\//g, "\\"));
}

function scoreGogLaunchCandidate(row) {
  const executablePath = normalizeLaunchExecutablePath(row?.executablePath);
  if (!executablePath || !/\.exe$/i.test(executablePath)) return -1000;
  let score = 1000;
  if (Number(row?.isPrimary) === 1) score += 250;
  const type = String(row?.taskType || "").toLowerCase();
  if (type === "builtinprimary") score += 150;
  else if (type === "builtin") score += 75;
  else if (type === "custom") score += 25;
  const baseName = processNameFromExecutablePath(executablePath).toLowerCase();
  if (/(updater|update|patch|launcher|setup|install|unins|uninstall)/i.test(baseName)) {
    score -= 500;
  }
  if (/(editor|benchmark|settings|config|crash|reporter|support|server)/i.test(baseName)) {
    score -= 250;
  }
  const order = Number(row?.taskOrder);
  if (Number.isFinite(order)) score -= Math.max(0, Math.min(order, 100));
  return score;
}

function buildGogLaunchMetadata(row) {
  const executable = normalizeLaunchExecutablePath(row?.executablePath);
  if (!executable) return null;
  const processName = normalizeProcessNameValue(
    row?.processName || processNameFromExecutablePath(executable),
  );
  return {
    executable,
    arguments: isNonEmptyString(row?.commandLineArgs)
      ? String(row.commandLineArgs)
      : "",
    process_name: processName,
  };
}

function titleScore(row) {
  if (!row) return -1;
  let score = 0;
  if (String(row.languageId) === "16") score += 5;
  if (Number.isFinite(Number(row.stored_at))) score += Number(row.stored_at) / 1e15;
  return score;
}

function sanitizeFileSegment(input) {
  const value = String(input || "")
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, "_")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return value || "gog_asset";
}

function extFromUrl(inputUrl) {
  try {
    const parsed = new URL(String(inputUrl || ""));
    const ext = path.extname(parsed.pathname || "");
    if (ext && ext.length <= 8) return ext.toLowerCase();
  } catch {
    /* ignore */
  }
  return ".png";
}

function parseUnlockTime(value) {
  if (!isNonEmptyString(value)) return 0;
  const epochMs = Date.parse(value);
  return Number.isFinite(epochMs) && epochMs > 0 ? epochMs : 0;
}

function sleep(ms) {
  const waitMs = Number(ms);
  return new Promise((resolve) =>
    setTimeout(resolve, Number.isFinite(waitMs) && waitMs > 0 ? waitMs : 0),
  );
}

function parseGameplayDirIdentity(gameplayDirPath) {
  const normalized = normalizePath(gameplayDirPath);
  if (!normalized) return { clientId: "", userId: "" };
  const parts = normalized.split(/[\\/]+/).filter(Boolean);
  const gameplayIdx = parts.findIndex(
    (part) => String(part || "").toLowerCase() === "gameplay",
  );
  if (gameplayIdx <= 0 || gameplayIdx + 1 >= parts.length) {
    return { clientId: "", userId: "" };
  }
  return {
    clientId: normalizeId(parts[gameplayIdx - 1]),
    userId: normalizeId(parts[gameplayIdx + 1]),
  };
}

function buildGogOfficialSnapshot(achievements) {
  const out = {};
  for (const achievement of achievements || []) {
    const key = String(achievement?.key || "").trim();
    if (!key) continue;
    const earnedTime = parseUnlockTime(achievement?.unlock_time);
    out[key] = {
      earned: earnedTime > 0,
      earned_time: earnedTime,
    };
  }
  return out;
}

function buildGogOfficialRarityEntries(achievements) {
  return (achievements || [])
    .map((achievement) => {
      const name = String(achievement?.key || "").trim();
      const percent = Number(achievement?.rarity);
      if (!name || !Number.isFinite(percent)) return null;
      return {
        name,
        percent: Number(Math.min(100, Math.max(0, percent)).toFixed(4)),
      };
    })
    .filter(Boolean)
    .sort((a, b) =>
      String(a.name).localeCompare(String(b.name), undefined, {
        sensitivity: "base",
        numeric: true,
      }),
    );
}

function buildGogOfficialSchemaRows(achievements, iconMap = new Map()) {
  return (achievements || []).map((achievement, index) => {
    const key = String(achievement?.key || "").trim() || `gog_${index}`;
    const unlockedUrl = String(achievement?.image_url_unlocked || "").trim();
    const lockedUrl = String(achievement?.image_url_locked || "").trim();
    const downloadedUnlocked = unlockedUrl ? iconMap.get(unlockedUrl) || "" : "";
    const downloadedLocked = lockedUrl ? iconMap.get(lockedUrl) || "" : "";
    return {
      hidden: Number(achievement?.visible_while_locked) ? 0 : 1,
      displayName: { english: String(achievement?.name || "").trim() },
      description: { english: String(achievement?.description || "").trim() },
      icon: downloadedUnlocked,
      icon_gray: downloadedLocked || downloadedUnlocked,
      name: key,
    };
  });
}

function isGogGameplayReadyForSchema(gameplay) {
  const count = Array.isArray(gameplay?.achievements)
    ? gameplay.achievements.length
    : 0;
  if (count <= 0) return false;
  const retrievedValue = String(
    gameplay?.databaseInfo?.achievements_retrieved ?? "",
  ).trim();
  return retrievedValue !== "0";
}

function makeGameplayDbRuntimeSignature(gameplayDbPath) {
  const normalized = normalizePath(gameplayDbPath);
  if (!normalized) return "missing";
  return [
    fileSignature(normalized),
    fileSignature(`${normalized}-wal`),
    fileSignature(`${normalized}-shm`),
  ].join("|");
}

function makeGameplayContentSignature(gameplay) {
  const achievements = Array.isArray(gameplay?.achievements)
    ? gameplay.achievements
    : [];
  return achievements
    .map((achievement) => {
      const key = String(achievement?.key || "").trim();
      const unlockTime = String(achievement?.unlock_time || "").trim();
      const rarity = Number(achievement?.rarity);
      const rarityPart = Number.isFinite(rarity) ? rarity.toFixed(4) : "";
      return [key, unlockTime, rarityPart].join(":");
    })
    .join("|");
}

async function waitForStableGogGameplayDb(gameplayDbPath, options = {}) {
  const normalizedPath = normalizePath(gameplayDbPath);
  if (!normalizedPath || !fs.existsSync(normalizedPath)) {
    throw new Error("gog-official:gameplay-db-missing");
  }

  const pollMs = Math.max(
    250,
    Number(options.pollMs) || DEFAULT_GAMEPLAY_STABILITY_POLL_MS,
  );
  const maxWaitMs = Math.max(
    0,
    Number(options.maxWaitMs) || DEFAULT_GAMEPLAY_STABILITY_MAX_WAIT_MS,
  );
  const stableReadsRequired = Math.max(
    2,
    Number(options.stableReadsRequired) || DEFAULT_GAMEPLAY_STABILITY_READS,
  );
  const startedAt = Date.now();
  const deadline = startedAt + maxWaitMs;
  let attempts = 0;
  let stableReads = 0;
  let lastSignature = "";
  let lastGameplay = null;

  while (true) {
    attempts += 1;
    const gameplay = readGogGameplayDb(normalizedPath);
    const count = Array.isArray(gameplay?.achievements)
      ? gameplay.achievements.length
      : 0;
    const ready = isGogGameplayReadyForSchema(gameplay);
    const signature = ready
      ? [
          makeGameplayDbRuntimeSignature(normalizedPath),
          count,
          makeGameplayContentSignature(gameplay),
        ].join("||")
      : "";

    if (ready && signature === lastSignature) {
      stableReads += 1;
    } else if (ready) {
      stableReads = 1;
    } else {
      stableReads = 0;
    }

    lastSignature = signature;
    lastGameplay = gameplay;

    if (ready && stableReads >= stableReadsRequired) {
      return {
        ready: true,
        stable: true,
        gameplay,
        count,
        attempts,
        elapsedMs: Date.now() - startedAt,
      };
    }

    if (Date.now() >= deadline) {
      return {
        ready,
        stable: false,
        gameplay: lastGameplay,
        count,
        attempts,
        elapsedMs: Date.now() - startedAt,
      };
    }

    await sleep(pollMs);
  }
}

async function downloadGameplayIcons(achievements, imgDir) {
  const out = new Map();
  if (!Array.isArray(achievements) || !achievements.length) return out;
  try {
    fs.mkdirSync(imgDir, { recursive: true });
  } catch {
    return out;
  }

  const seen = new Set();
  for (const achievement of achievements) {
    const pairs = [
      ["unlocked", String(achievement?.image_url_unlocked || "").trim()],
      ["locked", String(achievement?.image_url_locked || "").trim()],
    ];
    for (const [variant, url] of pairs) {
      if (!url || seen.has(url)) continue;
      seen.add(url);
      const baseName = sanitizeFileSegment(`${achievement?.key || "gog"}_${variant}`);
      const fileName = `${baseName}${extFromUrl(url)}`;
      const targetPath = path.join(imgDir, fileName);
      try {
        if (!fs.existsSync(targetPath)) {
          const res = await axios.get(url, {
            timeout: 15000,
            responseType: "arraybuffer",
            validateStatus: (status) => status >= 200 && status < 500,
          });
          if (res.status >= 400 || !res.data) {
            throw new Error(`HTTP ${res.status}`);
          }
          fs.writeFileSync(targetPath, Buffer.from(res.data));
        }
        out.set(url, path.join("img", fileName).replace(/\\/g, "/"));
      } catch (err) {
        gogGalaxyLogger.warn("gog-official:icon-download-failed", {
          achievement: String(achievement?.key || ""),
          variant,
          url,
          error: err?.message || String(err),
        });
      }
    }
  }
  return out;
}

function readGogGalaxyProducts(options = {}) {
  const storageDbPath =
    normalizePath(options.storageDbPath) || DEFAULT_GOG_GALAXY_STORAGE_DB_PATH;
  const cacheKey = makeGalaxyCacheKey(storageDbPath);
  if (cacheKey && PRODUCT_CACHE.has(cacheKey)) {
    return PRODUCT_CACHE.get(cacheKey);
  }

  const db = openReadOnlyDatabase(storageDbPath);
  try {
    const authRows = prepareAll(
      db,
        `
          SELECT
            pa.productId AS productId,
            pa.clientId AS clientId,
            pa.createdAt AS createdAt,
            ibp.installationPath AS installationPath,
            ibp.buildId AS buildId,
            ibp.installationId AS installationId,
            ibp.branch AS branch,
            ibp.installationDate AS installationDate,
            ptrk.releaseKey AS releaseKey,
            csc.enabled AS cloudSavesEnabled
          FROM ProductAuthorizations pa
          LEFT JOIN InstalledBaseProducts ibp ON ibp.productId = pa.productId
          LEFT JOIN ProductsToReleaseKeys ptrk ON ptrk.gogId = pa.productId
          LEFT JOIN CloudSavesConfiguration csc ON csc.productId = pa.productId
        `,
      { readBigInts: true },
    );

    const titleRows = db
      .prepare(
        `
          SELECT
            productId,
            title,
            languageId,
            stored_at
          FROM LimitedDetails
          WHERE title IS NOT NULL AND TRIM(title) <> ''
        `,
      )
      .all();

    const titleByProductId = new Map();
    for (const row of titleRows) {
      const productId = normalizeId(row?.productId);
      if (!productId) continue;
      const title = String(row?.title || "").trim();
      if (!title) continue;
      const prev = titleByProductId.get(productId);
      if (!prev || titleScore(row) > titleScore(prev)) {
        titleByProductId.set(productId, row);
      }
    }

    const launchRows = prepareAll(
      db,
        `
          SELECT
            ptrk.gogId AS productId,
            pt.id AS playTaskId,
            ptt.type AS taskType,
            pt.isPrimary AS isPrimary,
            pt."order" AS taskOrder,
            ptlp.executablePath AS executablePath,
            ptlp.commandLineArgs AS commandLineArgs,
            ptlp.label AS label
          FROM ProductsToReleaseKeys ptrk
          INNER JOIN PlayTasks pt ON pt.gameReleaseKey = ptrk.releaseKey
          LEFT JOIN PlayTaskTypes ptt ON ptt.id = pt.typeId
          INNER JOIN PlayTaskLaunchParameters ptlp ON ptlp.playTaskId = pt.id
          WHERE ptlp.executablePath IS NOT NULL AND TRIM(ptlp.executablePath) <> ''
        `,
      { readBigInts: true },
    );
    const launchByProductId = new Map();
    for (const row of launchRows) {
      const productId = normalizeId(row?.productId);
      if (!productId) continue;
      const score = scoreGogLaunchCandidate(row);
      if (score <= 0) continue;
      const prev = launchByProductId.get(productId);
      if (!prev || score > prev.score) {
        launchByProductId.set(productId, { row, score });
      }
    }

    const rows = [];
    const byClientId = new Map();
    const byProductId = new Map();
    for (const row of authRows) {
      const productId = normalizeId(row?.productId);
      const clientId = normalizeId(row?.clientId);
      if (!productId || !clientId) continue;
      const titleRow = titleByProductId.get(productId);
      const launchMetadata = buildGogLaunchMetadata(
        launchByProductId.get(productId)?.row,
      );
      const entry = {
        productId,
        clientId,
        title: String(titleRow?.title || "").trim(),
        installationPath: isNonEmptyString(row?.installationPath)
          ? String(row.installationPath)
          : "",
        buildId: normalizeId(row?.buildId),
        installationId: normalizeId(row?.installationId),
        releaseKey: isNonEmptyString(row?.releaseKey)
          ? String(row.releaseKey)
          : "",
        branch: isNonEmptyString(row?.branch) ? String(row.branch) : "",
        installationDate: isNonEmptyString(row?.installationDate)
          ? String(row.installationDate)
          : "",
        cloudSavesEnabled: Number(row?.cloudSavesEnabled) === 1,
        createdAt: isNonEmptyString(row?.createdAt) ? String(row.createdAt) : "",
        executablePath: launchMetadata?.executable || "",
        launchArguments: launchMetadata?.arguments || "",
        processName: launchMetadata?.process_name || "",
      };
      rows.push(entry);
      byClientId.set(clientId, entry);
      if (!byProductId.has(productId)) byProductId.set(productId, []);
      byProductId.get(productId).push(entry);
    }

    const result = { rows, byClientId, byProductId };
    if (cacheKey) {
      PRODUCT_CACHE.clear();
      PRODUCT_CACHE.set(cacheKey, result);
    }
    return result;
  } finally {
    safeCloseDatabase(db);
  }
}

function resolveGogGalaxyProductByClientId(clientId, options = {}) {
  const normalizedClientId = normalizeId(clientId);
  if (!normalizedClientId) return null;
  const products = readGogGalaxyProducts(options);
  return products.byClientId.get(normalizedClientId) || null;
}

function resolveGogGalaxyProductByProductId(productId, options = {}) {
  const normalizedProductId = normalizeId(productId);
  if (!normalizedProductId) return null;
  const products = readGogGalaxyProducts(options);
  const rows = products.byProductId.get(normalizedProductId) || [];
  return rows[0] || null;
}

function resolveGogGalaxyLaunchMetadataByProductId(productId, options = {}) {
  const product = resolveGogGalaxyProductByProductId(productId, options);
  if (!product) return null;
  const metadata = {
    executable: product.executablePath || "",
    arguments: product.launchArguments || "",
    process_name: product.processName || "",
  };
  if (
    !metadata.executable &&
    !metadata.arguments &&
    !metadata.process_name
  ) {
    return null;
  }
  return metadata;
}

function listGogGalaxyUsers(options = {}) {
  const storageDbPath =
    normalizePath(options.storageDbPath) || DEFAULT_GOG_GALAXY_STORAGE_DB_PATH;
  const db = openReadOnlyDatabase(storageDbPath);
  try {
    return prepareAll(db, `SELECT id FROM Users`, { readBigInts: true })
      .map((row) => normalizeId(row?.id))
      .filter(Boolean);
  } finally {
    safeCloseDatabase(db);
  }
}

function listGogOfficialGameplayEntries(rootPath, options = {}) {
  const applicationsRoot =
    normalizePath(rootPath) || DEFAULT_GOG_GALAXY_APPLICATIONS_ROOT;
  if (!applicationsRoot || !fs.existsSync(applicationsRoot)) return [];
  const products = readGogGalaxyProducts(options);
  const out = [];
  let clientDirs = [];
  try {
    clientDirs = fs.readdirSync(applicationsRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const entry of clientDirs) {
    if (!entry.isDirectory()) continue;
    const clientId = normalizeId(entry.name);
    if (!clientId) continue;
    const product = products.byClientId.get(clientId);
    if (!product?.productId) continue;
    const gameplayRoot = path.join(applicationsRoot, clientId, "Gameplay");
    let userDirs = [];
    try {
      userDirs = fs.readdirSync(gameplayRoot, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const userDir of userDirs) {
      if (!userDir.isDirectory()) continue;
      const userId = normalizeId(userDir.name);
      if (!userId) continue;
      const gameplayDir = path.join(gameplayRoot, userId);
      const gameplayDbPath = path.join(gameplayDir, GAMEPLAY_DB_NAME);
      if (!fs.existsSync(gameplayDbPath)) continue;
      out.push({
        productId: product.productId,
        clientId,
        title: product.title || "",
        userId,
        gameplayDir,
        gameplayDbPath,
        installationPath: product.installationPath || "",
        releaseKey: product.releaseKey || "",
      });
    }
  }

  return out;
}

function resolveGogOfficialGameplayEntryForProduct(productId, options = {}) {
  const normalizedProductId = normalizeId(productId);
  if (!normalizedProductId) return null;
  const preferredClientId = normalizeId(options.clientId);
  const preferredUserId = normalizeId(options.userId);
  const entries = listGogOfficialGameplayEntries(
    options.applicationsRoot || DEFAULT_GOG_GALAXY_APPLICATIONS_ROOT,
    options,
  ).filter((entry) => entry.productId === normalizedProductId);
  if (!entries.length) return null;
  if (preferredClientId) {
    const exact = entries.find(
      (entry) =>
        entry.clientId === preferredClientId &&
        (!preferredUserId || entry.userId === preferredUserId),
    );
    if (exact) return exact;
  }
  if (preferredUserId) {
    const exactUser = entries.find((entry) => entry.userId === preferredUserId);
    if (exactUser) return exactUser;
  }
  return entries[0];
}

function resolveGogOfficialGameplayDbForConfig(config = {}, options = {}) {
  const directPath = normalizePath(config?.gog_gameplay_db || config?.gogGameplayDb);
  if (directPath && fs.existsSync(directPath)) {
    return {
      gameplayDbPath: directPath,
      gameplayDir: path.dirname(directPath),
      ...parseGameplayDirIdentity(path.dirname(directPath)),
    };
  }

  const savePath = normalizePath(config?.save_path || config?.savePath);
  if (savePath) {
    const directDb = path.join(savePath, GAMEPLAY_DB_NAME);
    if (fs.existsSync(directDb)) {
      return {
        gameplayDbPath: directDb,
        gameplayDir: savePath,
        ...parseGameplayDirIdentity(savePath),
      };
    }
  }

  const productId = normalizeId(config?.appid || config?.appId);
  if (!productId) return null;
  const resolved = resolveGogOfficialGameplayEntryForProduct(productId, {
    ...options,
    clientId: config?.gog_client_id || config?.gogClientId || options.clientId,
    userId: config?.gog_user_id || config?.gogUserId || options.userId,
  });
  if (!resolved) return null;
  return {
    gameplayDbPath: resolved.gameplayDbPath,
    gameplayDir: resolved.gameplayDir,
    clientId: resolved.clientId,
    userId: resolved.userId,
  };
}

function readGogGameplayDb(gameplayDbPath) {
  const db = openReadOnlyDatabase(gameplayDbPath);
  try {
    const databaseInfoRows = db.prepare(`SELECT key, value FROM database_info`).all();
    const databaseInfo = {};
    for (const row of databaseInfoRows) {
      if (!isNonEmptyString(row?.key)) continue;
      databaseInfo[String(row.key)] = row?.value;
    }

    const achievements = prepareAll(
      db,
        `
          SELECT
            id,
            key,
            name,
            description,
            visible_while_locked,
            unlock_time,
            image_url_locked,
            image_url_unlocked,
            changed,
            rarity,
            rarity_level_description,
            rarity_level_slug
          FROM achievement
          ORDER BY id ASC
        `,
      { readBigInts: true },
    );

    return {
      gameplayDbPath: normalizePath(gameplayDbPath),
      databaseInfo,
      achievements: Array.isArray(achievements) ? achievements : [],
    };
  } finally {
    safeCloseDatabase(db);
  }
}

async function ensureGogOfficialSchema(productId, schemaDir, options = {}) {
  const normalizedProductId = normalizeId(productId);
  if (!normalizedProductId) {
    throw new Error("gog-official:invalid-product-id");
  }

  const resolvedDir = normalizePath(schemaDir);
  if (!resolvedDir) {
    throw new Error("gog-official:invalid-schema-dir");
  }

  let gameplayDbPath = normalizePath(options.gameplayDbPath);
  if (!gameplayDbPath || !fs.existsSync(gameplayDbPath)) {
    const resolved = resolveGogOfficialGameplayEntryForProduct(normalizedProductId, {
      applicationsRoot: options.applicationsRoot,
      storageDbPath: options.storageDbPath,
      clientId: options.clientId,
      userId: options.userId,
    });
    gameplayDbPath = resolved?.gameplayDbPath || "";
  }
  if (!gameplayDbPath || !fs.existsSync(gameplayDbPath)) {
    throw new Error("gog-official:gameplay-db-missing");
  }

  const gameplay =
    options.preloadedGameplay &&
    Array.isArray(options.preloadedGameplay.achievements)
      ? options.preloadedGameplay
      : readGogGameplayDb(gameplayDbPath);
  try {
    fs.mkdirSync(resolvedDir, { recursive: true });
  } catch {
    /* ignore */
  }

  const iconMap = await downloadGameplayIcons(
    gameplay.achievements,
    path.join(resolvedDir, "img"),
  );
  const schemaRows = buildGogOfficialSchemaRows(gameplay.achievements, iconMap);
  const rarityEntries = buildGogOfficialRarityEntries(gameplay.achievements);
  const snapshot = buildGogOfficialSnapshot(gameplay.achievements);
  const achievementsPath = path.join(resolvedDir, "achievements.json");
  fs.writeFileSync(achievementsPath, JSON.stringify(schemaRows, null, 2), "utf8");
  const sidecarPath = writeAchievementPercentagesSidecar(
    resolvedDir,
    normalizedProductId,
    rarityEntries,
    { source: RARITY_SOURCES.gogGameplay },
  );
  return {
    dir: resolvedDir,
    achievementsPath,
    sidecarPath,
    gameplayDbPath,
    snapshot,
    count: schemaRows.length,
  };
}

module.exports = {
  DEFAULT_GOG_GALAXY_STORAGE_DB_PATH,
  DEFAULT_GOG_GALAXY_APPLICATIONS_ROOT,
  GAMEPLAY_DB_NAME,
  buildGogOfficialRarityEntries,
  buildGogOfficialSchemaRows,
  buildGogOfficialSnapshot,
  ensureGogOfficialSchema,
  listGogGalaxyUsers,
  listGogOfficialGameplayEntries,
  parseGameplayDirIdentity,
  readGogGalaxyProducts,
  readGogGameplayDb,
  resolveGogGalaxyLaunchMetadataByProductId,
  resolveGogGalaxyProductByClientId,
  resolveGogGalaxyProductByProductId,
  resolveGogOfficialGameplayDbForConfig,
  resolveGogOfficialGameplayEntryForProduct,
  waitForStableGogGameplayDb,
};
