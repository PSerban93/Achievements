"use strict";

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const axios = require("axios");
const { createLogger } = require("./logger");
const { writeJsonAtomicSync } = require("./atomic-json-store");
const { writeAchievementPercentagesSidecar } = require("./achievement-rarity");

const RETROACHIEVEMENTS_PLATFORM = "retroachievements";
const RETROACHIEVEMENTS_AUTH_FILE = "retroachievements-auth.enc";
const RETROACHIEVEMENTS_API_ROOT = "https://retroachievements.org/API";
const RETROACHIEVEMENTS_MEDIA_ROOT = "https://media.retroachievements.org";
const RETROACHIEVEMENTS_RARITY_SOURCE = "retroachievements";
const RETROACHIEVEMENTS_PAGE_SIZE = 500;

const retroAchievementsLogger = createLogger(RETROACHIEVEMENTS_PLATFORM, {
  level: process.env.RETROACHIEVEMENTS_LOG_LEVEL || "info",
});

function firstNonEmpty(...values) {
  for (const value of values) {
    const text = String(value ?? "").trim();
    if (text) return text;
  }
  return "";
}

function normalizeRetroAchievementsUsername(value) {
  const raw = String(value || "").trim();
  if (!raw || raw.length > 64 || /[\u0000-\u001f\u007f]/.test(raw)) return "";
  return raw;
}

function normalizeRetroAchievementsApiKey(value) {
  const raw = String(value || "").trim();
  return /^[A-Za-z0-9._-]{16,160}$/.test(raw) ? raw : "";
}

function normalizeRetroAchievementsGameId(value) {
  const raw = String(value ?? "").trim();
  return /^\d{1,12}$/.test(raw) && Number(raw) > 0 ? raw : "";
}

function normalizeRetroAchievementsUlid(value) {
  const raw = String(value || "").trim().toUpperCase();
  return /^[0-9A-HJKMNP-TV-Z]{26}$/.test(raw) ? raw : "";
}

function sanitizeSegment(value, fallback = "retroachievements") {
  const result = String(value || "")
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, "_")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 160);
  return result || fallback;
}

function sanitizeConfigName(value) {
  const result = String(value || "")
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
  return result || "RetroAchievements Game";
}

function resolveAuthPath(userDataDir) {
  return path.join(
    path.resolve(String(userDataDir || ".")),
    RETROACHIEVEMENTS_AUTH_FILE,
  );
}

function getElectronSafeStorage(options = {}) {
  if (options?.safeStorage) return options.safeStorage;
  try {
    const safeStorage = require("electron")?.safeStorage;
    if (
      safeStorage &&
      typeof safeStorage.isEncryptionAvailable === "function" &&
      safeStorage.isEncryptionAvailable()
    ) {
      return safeStorage;
    }
  } catch {}
  return null;
}

function normalizeStoredAuth(payload = {}) {
  const username = normalizeRetroAchievementsUsername(payload.username);
  const webApiKey = normalizeRetroAchievementsApiKey(payload.webApiKey);
  if (!username || !webApiKey) return null;
  return {
    username,
    webApiKey,
    ulid: normalizeRetroAchievementsUlid(payload.ulid),
    userId: Number(payload.userId) || 0,
    userPic: String(payload.userPic || "").trim(),
  };
}

async function saveRetroAchievementsAuth(userDataDir, auth, options = {}) {
  const normalized = normalizeStoredAuth(auth);
  if (!normalized) throw new Error("retroachievements-auth-invalid");
  const safeStorage = getElectronSafeStorage(options);
  if (!safeStorage) {
    throw new Error("retroachievements-safe-storage-unavailable");
  }
  const encrypted = safeStorage
    .encryptString(JSON.stringify(normalized))
    .toString("base64");
  const filePath = resolveAuthPath(userDataDir);
  writeJsonAtomicSync(filePath, {
    version: 1,
    mode: "electron-safe-storage",
    data: encrypted,
  });
  return filePath;
}

async function loadRetroAchievementsAuth(userDataDir, options = {}) {
  try {
    const wrapper = JSON.parse(
      await fsp.readFile(resolveAuthPath(userDataDir), "utf8"),
    );
    if (
      wrapper?.version !== 1 ||
      wrapper?.mode !== "electron-safe-storage" ||
      !wrapper?.data
    ) {
      return null;
    }
    const safeStorage = getElectronSafeStorage(options);
    if (!safeStorage) return null;
    const decrypted = safeStorage.decryptString(
      Buffer.from(String(wrapper.data), "base64"),
    );
    return normalizeStoredAuth(JSON.parse(decrypted));
  } catch {
    return null;
  }
}

async function clearRetroAchievementsAuth(userDataDir) {
  try {
    await fsp.unlink(resolveAuthPath(userDataDir));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function makeApiError(status, payload = null) {
  const serverMessage = firstNonEmpty(
    payload?.Error,
    payload?.error,
    payload?.Message,
    payload?.message,
  );
  const error = new Error(
    serverMessage ||
      (status ? `RetroAchievements API request failed (HTTP ${status}).` : "RetroAchievements API request failed."),
  );
  error.statusCode = Number(status) || 0;
  return error;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runWithConcurrency(items, limit, worker) {
  const rows = Array.isArray(items) ? items : [];
  if (!rows.length) return;
  let cursor = 0;
  const count = Math.max(1, Math.min(rows.length, Number(limit) || 1));
  await Promise.all(
    Array.from({ length: count }, async () => {
      while (cursor < rows.length) {
        const index = cursor;
        cursor += 1;
        await worker(rows[index], index);
      }
    }),
  );
}

async function retroAchievementsApiGet(endpoint, auth, params = {}, options = {}) {
  const normalized = normalizeStoredAuth(auth);
  if (!normalized) throw new Error("retroachievements-login-required");
  const timeoutMs = Math.max(3000, Number(options.timeoutMs) || 15000);
  const httpClient = options.httpClient || axios;
  const requestedRetries = Number(options.maxRetries);
  const maxRetries = Math.max(
    0,
    Math.min(3, Number.isFinite(requestedRetries) ? requestedRetries : 2),
  );
  let lastError = null;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      const response = await httpClient.get(
        `${RETROACHIEVEMENTS_API_ROOT}/${String(endpoint || "").replace(/^\/+/, "")}`,
        {
          timeout: timeoutMs,
          responseType: "json",
          params: {
            y: normalized.webApiKey,
            ...params,
          },
          validateStatus: () => true,
          headers: {
            Accept: "application/json",
            "User-Agent": "Achievements-App/RetroAchievements",
          },
        },
      );
      const status = Number(response?.status) || 0;
      const payload = response?.data;
      if (
        status >= 200 &&
        status < 300 &&
        payload &&
        payload?.Success !== false &&
        payload?.success !== false &&
        !payload?.Error &&
        !payload?.error
      ) {
        return payload;
      }
      const error = makeApiError(status, payload);
      if (
        ![408, 429, 500, 502, 503, 504].includes(status) ||
        attempt >= maxRetries
      ) {
        throw error;
      }
      lastError = error;
      const retryAfterSeconds = Number(response?.headers?.["retry-after"]);
      await sleep(
        Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
          ? Math.min(30000, retryAfterSeconds * 1000)
          : 1000 * 2 ** attempt,
      );
    } catch (error) {
      lastError = error;
      const status = Number(error?.statusCode || error?.response?.status) || 0;
      const transient =
        !status ||
        [408, 429, 500, 502, 503, 504].includes(status) ||
        error?.code === "ECONNRESET";
      if (!transient || attempt >= maxRetries) throw error;
      await sleep(1000 * 2 ** attempt);
    }
  }
  throw lastError || new Error("retroachievements-api-failed");
}

function normalizeUserProfile(payload = {}) {
  const username = normalizeRetroAchievementsUsername(
    payload?.User ?? payload?.user,
  );
  if (!username) throw new Error("retroachievements-user-not-found");
  return {
    username,
    ulid: normalizeRetroAchievementsUlid(payload?.ULID ?? payload?.ulid),
    userId: Number(payload?.ID ?? payload?.id) || 0,
    userPic: firstNonEmpty(payload?.UserPic, payload?.userPic),
    lastGameId: normalizeRetroAchievementsGameId(
      payload?.LastGameID ?? payload?.lastGameId,
    ),
    totalPoints: Number(payload?.TotalPoints ?? payload?.totalPoints) || 0,
  };
}

async function fetchRetroAchievementsUserProfile(auth, options = {}) {
  const payload = await retroAchievementsApiGet(
    "API_GetUserProfile.php",
    auth,
    { u: auth?.ulid || auth?.username },
    options,
  );
  return normalizeUserProfile(payload);
}

async function connectRetroAchievements(userDataDir, credentials, options = {}) {
  const requestedAuth = normalizeStoredAuth({
    username: credentials?.username,
    webApiKey: credentials?.webApiKey,
  });
  if (!requestedAuth) throw new Error("retroachievements-credentials-invalid");
  const profile = await fetchRetroAchievementsUserProfile(requestedAuth, options);
  const auth = {
    ...requestedAuth,
    username: profile.username,
    ulid: profile.ulid,
    userId: profile.userId,
    userPic: profile.userPic,
  };
  await saveRetroAchievementsAuth(userDataDir, auth, options);
  return { auth, profile };
}

async function ensureRetroAchievementsAuth(options = {}) {
  const auth = options.auth
    ? normalizeStoredAuth(options.auth)
    : await loadRetroAchievementsAuth(options.userDataDir, options);
  if (!auth) throw new Error("retroachievements-login-required");
  return auth;
}

async function getRetroAchievementsStatus(options = {}) {
  const configured = fs.existsSync(resolveAuthPath(options.userDataDir));
  const auth = await loadRetroAchievementsAuth(options.userDataDir, options);
  if (!auth) {
    return { connected: false, configured };
  }
  return {
    connected: true,
    configured: true,
    username: auth.username,
    ulid: auth.ulid,
    userId: auth.userId,
    userPic: auth.userPic,
  };
}

function normalizeCompletionPage(payload = {}) {
  const results = Array.isArray(payload?.Results)
    ? payload.Results
    : Array.isArray(payload?.results)
      ? payload.results
      : [];
  return {
    count: Number(payload?.Count ?? payload?.count) || results.length,
    total: Number(payload?.Total ?? payload?.total) || results.length,
    results,
  };
}

async function fetchRetroAchievementsCompletionProgress(auth, options = {}) {
  const all = [];
  let offset = 0;
  let total = Infinity;
  while (offset < total && offset < 10000) {
    const payload = await retroAchievementsApiGet(
      "API_GetUserCompletionProgress.php",
      auth,
      {
        u: auth.ulid || auth.username,
        c: RETROACHIEVEMENTS_PAGE_SIZE,
        o: offset,
      },
      options,
    );
    const page = normalizeCompletionPage(payload);
    total = page.total;
    all.push(...page.results);
    if (!page.results.length || page.results.length < RETROACHIEVEMENTS_PAGE_SIZE) {
      break;
    }
    offset += page.results.length;
  }
  return all;
}

function normalizeMediaUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/^https?:\/\//i.test(raw)) return raw;
  return `${RETROACHIEVEMENTS_MEDIA_ROOT}/${raw.replace(/^\/+/, "")}`;
}

function buildBadgeUrl(badgeName, locked = false) {
  const badge = String(badgeName || "").trim();
  if (!/^[A-Za-z0-9_-]+$/.test(badge)) return "";
  return `${RETROACHIEVEMENTS_MEDIA_ROOT}/Badge/${badge}${locked ? "_lock" : ""}.png`;
}

function parseRetroAchievementsDate(value) {
  const raw = String(value || "").trim();
  if (!raw) return 0;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw)
    ? `${raw.replace(" ", "T")}Z`
    : raw;
  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) ? Math.floor(timestamp / 1000) : 0;
}

function normalizeRetroAchievementsGame(payload = {}) {
  const gameId = normalizeRetroAchievementsGameId(payload?.ID ?? payload?.id);
  const title = firstNonEmpty(payload?.Title, payload?.title, `Game ${gameId}`);
  const rawAchievements = payload?.Achievements ?? payload?.achievements ?? {};
  const achievementRows = Array.isArray(rawAchievements)
    ? rawAchievements
    : rawAchievements && typeof rawAchievements === "object"
      ? Object.entries(rawAchievements).map(([id, entry]) => ({
          ...(entry && typeof entry === "object" ? entry : {}),
          ID: entry?.ID ?? entry?.id ?? id,
        }))
      : [];
  return {
    gameId,
    title,
    consoleId: Number(payload?.ConsoleID ?? payload?.consoleId) || 0,
    consoleName: firstNonEmpty(payload?.ConsoleName, payload?.consoleName),
    imageIcon: normalizeMediaUrl(payload?.ImageIcon ?? payload?.imageIcon),
    imageTitle: normalizeMediaUrl(payload?.ImageTitle ?? payload?.imageTitle),
    imageIngame: normalizeMediaUrl(payload?.ImageIngame ?? payload?.imageIngame),
    imageBoxArt: normalizeMediaUrl(payload?.ImageBoxArt ?? payload?.imageBoxArt),
    publisher: firstNonEmpty(payload?.Publisher, payload?.publisher),
    developer: firstNonEmpty(payload?.Developer, payload?.developer),
    genre: firstNonEmpty(payload?.Genre, payload?.genre),
    released: firstNonEmpty(payload?.Released, payload?.released),
    numDistinctPlayers:
      Number(payload?.NumDistinctPlayers ?? payload?.numDistinctPlayers) || 0,
    numDistinctPlayersCasual:
      Number(
        payload?.NumDistinctPlayersCasual ?? payload?.numDistinctPlayersCasual,
      ) || 0,
    numDistinctPlayersHardcore:
      Number(
        payload?.NumDistinctPlayersHardcore ?? payload?.numDistinctPlayersHardcore,
      ) || 0,
    achievements: achievementRows,
    userTotalPlaytime:
      Number(payload?.UserTotalPlaytime ?? payload?.userTotalPlaytime) || 0,
    highestAwardKind: firstNonEmpty(
      payload?.HighestAwardKind,
      payload?.highestAwardKind,
    ),
    highestAwardDate: firstNonEmpty(
      payload?.HighestAwardDate,
      payload?.highestAwardDate,
    ),
  };
}

function normalizeRetroAchievement(raw = {}, game = {}) {
  const id = normalizeRetroAchievementsGameId(raw?.ID ?? raw?.id);
  if (!id) return null;
  const dateEarned = firstNonEmpty(raw?.DateEarned, raw?.dateEarned);
  const dateEarnedHardcore = firstNonEmpty(
    raw?.DateEarnedHardcore,
    raw?.dateEarnedHardcore,
  );
  const casualPlayers =
    Number(game?.numDistinctPlayersCasual) || Number(game?.numDistinctPlayers) || 0;
  const hardcorePlayers = Number(game?.numDistinctPlayersHardcore) || 0;
  const numAwarded = Number(raw?.NumAwarded ?? raw?.numAwarded) || 0;
  const numAwardedHardcore =
    Number(raw?.NumAwardedHardcore ?? raw?.numAwardedHardcore) || 0;
  const rarity =
    casualPlayers > 0 ? Math.min(100, (numAwarded / casualPlayers) * 100) : null;
  const hardcoreRarity =
    hardcorePlayers > 0
      ? Math.min(100, (numAwardedHardcore / hardcorePlayers) * 100)
      : null;
  return {
    id,
    title: firstNonEmpty(raw?.Title, raw?.title, `Achievement ${id}`),
    description: firstNonEmpty(raw?.Description, raw?.description),
    points: Number(raw?.Points ?? raw?.points) || 0,
    trueRatio: Number(raw?.TrueRatio ?? raw?.trueRatio) || 0,
    author: firstNonEmpty(raw?.Author, raw?.author),
    badgeName: firstNonEmpty(raw?.BadgeName, raw?.badgeName),
    displayOrder: Number(raw?.DisplayOrder ?? raw?.displayOrder) || 0,
    type: firstNonEmpty(raw?.Type, raw?.type),
    dateEarned,
    dateEarnedHardcore,
    rarity,
    hardcoreRarity,
    snapshot: {
      earned: Boolean(dateEarned || dateEarnedHardcore),
      earned_time: parseRetroAchievementsDate(dateEarned || dateEarnedHardcore),
      hardcore: Boolean(dateEarnedHardcore),
      hardcore_time: parseRetroAchievementsDate(dateEarnedHardcore),
    },
  };
}

async function fetchRetroAchievementsGameProgress(auth, gameId, options = {}) {
  const normalizedGameId = normalizeRetroAchievementsGameId(gameId);
  if (!normalizedGameId) throw new Error("retroachievements-game-id-invalid");
  const payload = await retroAchievementsApiGet(
    "API_GetGameInfoAndUserProgress.php",
    auth,
    {
      u: auth.ulid || auth.username,
      g: normalizedGameId,
      a: 1,
    },
    options,
  );
  const game = normalizeRetroAchievementsGame(payload);
  if (!game.gameId) game.gameId = normalizedGameId;
  return game;
}

async function downloadImage(url, outputPath, options = {}) {
  if (!/^https?:\/\//i.test(String(url || ""))) return "";
  try {
    if (
      options.overwrite !== true &&
      fs.existsSync(outputPath) &&
      fs.statSync(outputPath).size > 0
    ) {
      return outputPath;
    }
  } catch {}
  const httpClient = options.httpClient || axios;
  const response = await httpClient.get(url, {
    timeout: Math.max(3000, Number(options.timeoutMs) || 15000),
    responseType: "arraybuffer",
    validateStatus: () => true,
  });
  if (Number(response?.status) < 200 || Number(response?.status) >= 300) {
    return "";
  }
  const data = Buffer.from(response?.data || []);
  if (!data.length) return "";
  await fsp.mkdir(path.dirname(outputPath), { recursive: true });
  await fsp.writeFile(outputPath, data);
  return outputPath;
}

function buildRetroAchievementsSchema(game) {
  const rows = [];
  const snapshot = {};
  const rarity = [];
  const normalizedAchievements = game.achievements
    .map((entry) => normalizeRetroAchievement(entry, game))
    .filter(Boolean)
    .sort((left, right) => left.displayOrder - right.displayOrder);
  for (const achievement of normalizedAchievements) {
    const iconName = `${sanitizeSegment(achievement.id, "achievement")}.png`;
    const lockedIconName = `${sanitizeSegment(achievement.id, "achievement")}_locked.png`;
    const schemaEntry = {
      hidden: 0,
      displayName: { english: achievement.title },
      description: { english: achievement.description },
      icon: `img/${iconName}`,
      icon_gray: `img/${lockedIconName}`,
      name: achievement.id,
      points: achievement.points,
      trueRatio: achievement.trueRatio,
      author: achievement.author,
      achievementType: achievement.type,
      ...(achievement.rarity !== null
        ? {
            rarityPct: Number(achievement.rarity.toFixed(4)),
            raritySource: RETROACHIEVEMENTS_RARITY_SOURCE,
          }
        : {}),
      ...(achievement.hardcoreRarity !== null
        ? { hardcoreRarityPct: Number(achievement.hardcoreRarity.toFixed(4)) }
        : {}),
    };
    rows.push({ achievement, schemaEntry, iconName, lockedIconName });
    snapshot[achievement.id] = achievement.snapshot;
    if (achievement.rarity !== null) {
      rarity.push({
        name: achievement.id,
        percent: Number(achievement.rarity.toFixed(4)),
      });
    }
  }
  return { rows, snapshot, rarity };
}

async function writeRetroAchievementsSchema(schemaDir, game, options = {}) {
  const built = buildRetroAchievementsSchema(game);
  if (!built.rows.length) throw new Error("retroachievements-achievements-empty");
  const imgDir = path.join(schemaDir, "img");
  await fsp.mkdir(imgDir, { recursive: true });
  await runWithConcurrency(
    built.rows,
    Math.max(1, Math.min(12, Number(options.imageConcurrency) || 6)),
    async (row) => {
      const unlockedUrl = buildBadgeUrl(row.achievement.badgeName, false);
      const lockedUrl = buildBadgeUrl(row.achievement.badgeName, true);
      try {
        await downloadImage(
          unlockedUrl,
          path.join(imgDir, row.iconName),
          options,
        );
      } catch {}
      try {
        const lockedPath = path.join(imgDir, row.lockedIconName);
        const saved = await downloadImage(lockedUrl, lockedPath, options);
        if (!saved) {
          await fsp.copyFile(path.join(imgDir, row.iconName), lockedPath);
        }
      } catch {}
    },
  );
  writeJsonAtomicSync(
    path.join(schemaDir, "achievements.json"),
    built.rows.map((entry) => entry.schemaEntry),
  );
  writeAchievementPercentagesSidecar(schemaDir, game.gameId, built.rarity, {
    source: RETROACHIEVEMENTS_RARITY_SOURCE,
  });
  return {
    schema: built.rows.map((entry) => entry.schemaEntry),
    snapshot: built.snapshot,
  };
}

function buildRetroAchievementsSnapshot(game) {
  const snapshot = {};
  for (const raw of Array.isArray(game?.achievements) ? game.achievements : []) {
    const achievement = normalizeRetroAchievement(raw, game);
    if (achievement) snapshot[achievement.id] = achievement.snapshot;
  }
  return snapshot;
}

function getRetroAchievementsSnapshotDelta(previous = {}, next = {}) {
  let changed = false;
  const unlockedKeys = [];
  const allKeys = new Set([
    ...Object.keys(previous || {}),
    ...Object.keys(next || {}),
  ]);
  for (const key of allKeys) {
    const before = previous?.[key];
    const after = next?.[key];
    if (JSON.stringify(before) !== JSON.stringify(after)) changed = true;
    // A missing prior entry usually means the achievement set changed. Seed it
    // silently instead of presenting an old unlock as a new notification.
    if (
      Object.prototype.hasOwnProperty.call(previous || {}, key) &&
      before?.earned !== true &&
      after?.earned === true
    ) {
      unlockedKeys.push(key);
    }
  }
  return { changed, unlockedKeys };
}

function preserveRetroAchievementsEarnedState(next = {}, previous = {}) {
  const merged = { ...(next || {}) };
  for (const [key, before] of Object.entries(previous || {})) {
    if (before?.earned !== true) continue;
    const after = merged[key];
    if (after?.earned === true) continue;
    merged[key] = { ...(after || {}), ...before, earned: true };
  }
  return merged;
}

function indexExistingConfigs(configsDir) {
  const byGameId = new Map();
  let files = [];
  try {
    files = fs
      .readdirSync(configsDir)
      .filter((entry) => entry.toLowerCase().endsWith(".json"));
  } catch {
    return byGameId;
  }
  for (const file of files) {
    try {
      const filePath = path.join(configsDir, file);
      const config = JSON.parse(fs.readFileSync(filePath, "utf8"));
      if (
        String(config?.platform || "").trim().toLowerCase() !==
        RETROACHIEVEMENTS_PLATFORM
      ) {
        continue;
      }
      const gameId = normalizeRetroAchievementsGameId(
        config?.retroachievements_game_id || config?.appid,
      );
      if (gameId) byGameId.set(gameId, { filePath, config });
    } catch {}
  }
  return byGameId;
}

function reserveConfigPath(configsDir, title, existingPath = "") {
  if (existingPath) return existingPath;
  const base = sanitizeConfigName(`${title} (RetroAchievements)`);
  let candidate = path.join(configsDir, `${base}.json`);
  let suffix = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(configsDir, `${base} ${suffix}.json`);
    suffix += 1;
  }
  return candidate;
}

async function cacheGameArtwork(game, userDataDir, options = {}) {
  if (!userDataDir || !game?.gameId) return;
  const coverDir = path.join(
    userDataDir,
    "images",
    RETROACHIEVEMENTS_PLATFORM,
    game.gameId,
  );
  const coverUrl = game.imageBoxArt || game.imageIcon;
  const headerUrl = game.imageTitle || game.imageIngame || coverUrl;
  try {
    if (coverUrl) {
      await downloadImage(
        coverUrl,
        path.join(coverDir, `${game.gameId}.jpg`),
        options,
      );
    }
    if (headerUrl) {
      await downloadImage(headerUrl, path.join(coverDir, "header.jpg"), options);
    }
  } catch (error) {
    retroAchievementsLogger.warn("retroachievements:artwork-failed", {
      gameId: game.gameId,
      error: error?.message || String(error),
    });
  }
}

async function importRetroAchievementsLibrary(configsDir, options = {}) {
  const userDataDir = String(options.userDataDir || "").trim();
  const auth = await ensureRetroAchievementsAuth({ ...options, userDataDir });
  const completionRows = await fetchRetroAchievementsCompletionProgress(
    auth,
    options,
  );
  const existing = indexExistingConfigs(configsDir);
  const schemaRoot = path.join(
    options.schemaRootDir || path.join(configsDir, "schema"),
    RETROACHIEVEMENTS_PLATFORM,
  );
  const stateRoot = path.join(userDataDir, RETROACHIEVEMENTS_PLATFORM, "titles");
  const result = {
    provider: "RetroAchievements",
    account: { username: auth.username, ulid: auth.ulid },
    libraryTotal: completionRows.length,
    created: 0,
    updated: 0,
    skipped: 0,
    blacklistedSkipped: 0,
    failed: 0,
    imported: [],
  };
  const seenGameIds = new Set();
  await fsp.mkdir(configsDir, { recursive: true });

  for (let index = 0; index < completionRows.length; index += 1) {
    const completion = completionRows[index] || {};
    const gameId = normalizeRetroAchievementsGameId(
      completion?.GameID ?? completion?.gameId,
    );
    const fallbackTitle = firstNonEmpty(
      completion?.Title,
      completion?.title,
      `Game ${gameId}`,
    );
    options.onProgress?.({
      current: index + 1,
      total: completionRows.length,
      percent:
        5 +
        Math.round(
          ((index + 1) / Math.max(1, completionRows.length)) * 90,
        ),
      detail: fallbackTitle,
      appid: gameId,
    });
    if (!gameId) {
      result.skipped += 1;
      continue;
    }
    if (seenGameIds.has(gameId)) {
      result.skipped += 1;
      continue;
    }
    seenGameIds.add(gameId);
    const rawMaxPossible = completion?.MaxPossible ?? completion?.maxPossible;
    if (
      rawMaxPossible !== undefined &&
      Number.isFinite(Number(rawMaxPossible)) &&
      Number(rawMaxPossible) <= 0
    ) {
      result.skipped += 1;
      continue;
    }
    if (options.isTitleBlacklisted?.(gameId, RETROACHIEVEMENTS_PLATFORM)) {
      result.skipped += 1;
      result.blacklistedSkipped += 1;
      retroAchievementsLogger.info(
        "retroachievements:import-game-skipped-blacklisted",
        { gameId, title: fallbackTitle },
      );
      continue;
    }
    try {
      const game = await fetchRetroAchievementsGameProgress(auth, gameId, options);
      if (!game.achievements.length) {
        result.skipped += 1;
        continue;
      }
      const schemaDir = path.join(schemaRoot, gameId);
      const stateDir = path.join(stateRoot, gameId);
      const { schema, snapshot } = await writeRetroAchievementsSchema(
        schemaDir,
        game,
        options,
      );
      await cacheGameArtwork(game, userDataDir, options);
      writeJsonAtomicSync(path.join(stateDir, "achievements.json"), snapshot);

      const previousEntry = existing.get(gameId);
      const previous = previousEntry?.config || {};
      const filePath = reserveConfigPath(
        configsDir,
        game.title,
        previousEntry?.filePath,
      );
      const displayName = `${game.title} (RetroAchievements)`;
      const config = {
        ...previous,
        name: previous.name || path.basename(filePath, ".json"),
        displayName: previous.displayName || displayName,
        appid: gameId,
        platform: RETROACHIEVEMENTS_PLATFORM,
        retroachievements_game_id: gameId,
        retroachievements_username: auth.username,
        retroachievements_ulid: auth.ulid,
        retroachievements_console_id: game.consoleId,
        retroachievements_console_name: game.consoleName,
        retroachievements_highest_award_kind: game.highestAwardKind,
        retroachievements_highest_award_date: game.highestAwardDate,
        config_path: schemaDir,
        save_path: stateDir,
        executable: previous.executable || "",
        arguments: previous.arguments || "",
        process_name: previous.process_name || "",
      };
      writeJsonAtomicSync(filePath, config);
      if (previousEntry) result.updated += 1;
      else result.created += 1;
      result.imported.push({
        name: config.name,
        title: game.title,
        appid: gameId,
        snapshot,
        achievementsCount: schema.length,
      });
    } catch (error) {
      result.failed += 1;
      retroAchievementsLogger.warn("retroachievements:import-game-failed", {
        gameId,
        title: fallbackTitle,
        statusCode: Number(error?.statusCode) || 0,
        error: error?.message || String(error),
      });
    } finally {
      const configuredDelay = Number(options.importApiDelayMs);
      const delayMs = Number.isFinite(configuredDelay)
        ? Math.max(0, Math.min(5000, configuredDelay))
        : 200;
      if (delayMs > 0) await sleep(delayMs);
    }
  }
  retroAchievementsLogger.info("retroachievements:import-library-complete", {
    username: auth.username,
    libraryTotal: result.libraryTotal,
    created: result.created,
    updated: result.updated,
    skipped: result.skipped,
    blacklistedSkipped: result.blacklistedSkipped,
    failed: result.failed,
  });
  return result;
}

async function syncRetroAchievements(config = {}, options = {}) {
  const auth = await ensureRetroAchievementsAuth(options);
  const gameId = normalizeRetroAchievementsGameId(
    options.gameId || config.retroachievements_game_id || config.appid,
  );
  if (!gameId) throw new Error("retroachievements-game-id-invalid");
  const configUlid = normalizeRetroAchievementsUlid(
    config.retroachievements_ulid,
  );
  if (configUlid && auth.ulid && configUlid !== auth.ulid) {
    throw new Error("retroachievements-account-changed-import-required");
  }
  const game = await fetchRetroAchievementsGameProgress(auth, gameId, options);
  if (!game.achievements.length) {
    throw new Error("retroachievements-achievements-empty");
  }
  return {
    gameId,
    username: auth.username,
    ulid: auth.ulid,
    game,
    snapshot: buildRetroAchievementsSnapshot(game),
    total: game.achievements.length,
  };
}

async function fetchRetroAchievementsRarityPercentages(
  gameId,
  options = {},
) {
  const auth = await ensureRetroAchievementsAuth(options);
  const game = await fetchRetroAchievementsGameProgress(auth, gameId, options);
  const map = new Map();
  for (const raw of game.achievements) {
    const achievement = normalizeRetroAchievement(raw, game);
    if (achievement?.rarity !== null && achievement?.rarity !== undefined) {
      map.set(achievement.id, achievement.rarity);
    }
  }
  return map;
}

module.exports = {
  RETROACHIEVEMENTS_PLATFORM,
  RETROACHIEVEMENTS_RARITY_SOURCE,
  buildBadgeUrl,
  buildRetroAchievementsSchema,
  buildRetroAchievementsSnapshot,
  clearRetroAchievementsAuth,
  connectRetroAchievements,
  ensureRetroAchievementsAuth,
  fetchRetroAchievementsCompletionProgress,
  fetchRetroAchievementsGameProgress,
  fetchRetroAchievementsRarityPercentages,
  getRetroAchievementsSnapshotDelta,
  getRetroAchievementsStatus,
  importRetroAchievementsLibrary,
  loadRetroAchievementsAuth,
  normalizeRetroAchievement,
  normalizeRetroAchievementsGame,
  normalizeRetroAchievementsGameId,
  normalizeRetroAchievementsUsername,
  parseRetroAchievementsDate,
  preserveRetroAchievementsEarnedState,
  retroAchievementsApiGet,
  saveRetroAchievementsAuth,
  syncRetroAchievements,
  writeRetroAchievementsSchema,
};
