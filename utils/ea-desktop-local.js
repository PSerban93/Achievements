const fs = require("fs");
const os = require("os");
const path = require("path");
const axios = require("axios");
const { createLogger } = require("./logger");

const eaLogger = createLogger("ea-local");

const DEFAULT_EA_LOGS_ROOT = process.env.LOCALAPPDATA
  ? path.join(
      process.env.LOCALAPPDATA,
      "Electronic Arts",
      "EA Desktop",
      "Logs",
    )
  : "";
const EA_VERBOSE_LOG_NAME = "EADesktopVerbose.log";
const EA_VERBOSE_LOG_BAK_NAME = "EADesktopVerbose.bak";

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function normalizePathForCompare(inputPath) {
  if (!inputPath) return "";
  try {
    return path.normalize(String(inputPath)).toLowerCase();
  } catch {
    return "";
  }
}

function decodeXmlEntities(value) {
  return String(value || "")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function parseXmlAttributes(fragment) {
  const out = {};
  const regex = /([A-Za-z0-9_:-]+)="([^"]*)"/g;
  let match = null;
  while ((match = regex.exec(String(fragment || "")))) {
    out[match[1]] = decodeXmlEntities(match[2]);
  }
  return out;
}

function normalizeEpochMs(value) {
  const numeric = Number(value || 0);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
}

function parseGrantDateMs(value) {
  const raw = String(value || "").trim();
  if (!raw || /^0{4}-0{2}-0{2}t0{2}:0{2}:0{2}$/i.test(raw)) return 0;
  const timestamp = Date.parse(raw);
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : 0;
}

function unescapeLoggedPath(value) {
  return String(value || "")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\")
    .trim();
}

function parseEaContentIdFromAchievementSet(setName) {
  const raw = String(setName || "").trim();
  const strict = raw.match(/^\d+_(\d+)_\d+$/);
  if (strict && strict[1]) return strict[1];
  const parts = raw.split("_").filter(Boolean);
  return parts.length >= 2 && /^\d+$/.test(parts[1]) ? parts[1] : "";
}

function normalizeEaImageId(value) {
  return String(value || "")
    .trim()
    .replace(/^achieve:/i, "");
}

function parseAchievementSetFromImageId(value) {
  const raw = normalizeEaImageId(value);
  const match = raw.match(/^(.+)-(\d+)$/);
  if (!match) return { achievementSet: "", achievementId: "" };
  return {
    achievementSet: String(match[1] || "").trim(),
    achievementId: String(match[2] || "").trim(),
  };
}

function isEaEarnedAchievement(attrs = {}) {
  const count = Number(attrs.Count || 0);
  const progress = Number(attrs.Progress || 0);
  const total = Number(attrs.Total || 0);
  return count > 0 || (total > 0 && progress >= total);
}

function normalizeEaAchievement(attrs = {}) {
  const imageId = normalizeEaImageId(attrs.ImageId || "");
  const imageInfo = parseAchievementSetFromImageId(imageId);
  const achievementId = String(attrs.Id || imageInfo.achievementId || "").trim();
  if (!achievementId) return null;
  return {
    id: achievementId,
    name: String(attrs.Name || "").trim(),
    description: String(attrs.Description || "").trim(),
    howTo: String(attrs.HowTo || "").trim(),
    imageId,
    achievementSet: String(
      imageInfo.achievementSet || parseEaContentIdFromAchievementSet(imageId),
    ).trim(),
    earned: isEaEarnedAchievement(attrs),
    earned_time: parseGrantDateMs(attrs.GrantDate),
    progress: Number.isFinite(Number(attrs.Progress))
      ? Number(attrs.Progress)
      : 0,
    total: Number.isFinite(Number(attrs.Total)) ? Number(attrs.Total) : 0,
  };
}

function mergeGameInfo(target, patch) {
  return {
    contentId: patch.contentId || target.contentId || "",
    offerId: patch.offerId || target.offerId || "",
    gameName: patch.gameName || target.gameName || "",
    installPath: patch.installPath || target.installPath || "",
    exePath: patch.exePath || target.exePath || "",
    cwd: patch.cwd || target.cwd || "",
    processName:
      patch.processName ||
      target.processName ||
      (patch.exePath ? path.basename(patch.exePath) : ""),
    slug: patch.slug || target.slug || "",
    order:
      Number.isFinite(Number(patch.order)) && Number(patch.order) >= 0
        ? Number(patch.order)
        : Number(target.order || 0),
  };
}

let cachedVerboseLog = {
  cacheKey: "",
  parsed: null,
};

function resolveEaOfficialLogsRoots(rootPath) {
  const out = [];
  const seen = new Set();
  const push = (candidate) => {
    if (!candidate) return;
    let resolved = "";
    try {
      resolved = fs.realpathSync(candidate);
    } catch {
      try {
        resolved = path.resolve(String(candidate));
      } catch {
        resolved = "";
      }
    }
    if (!resolved) return;
    const key = resolved.toLowerCase();
    if (seen.has(key)) return;
    try {
      if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
        return;
      }
    } catch {
      return;
    }
    seen.add(key);
    out.push(resolved);
  };

  if (!rootPath) return out;

  let cursor = "";
  try {
    cursor = fs.realpathSync(rootPath);
  } catch {
    try {
      cursor = path.resolve(String(rootPath));
    } catch {
      cursor = "";
    }
  }

  while (cursor) {
    const base = path.basename(cursor).toLowerCase();
    const parent = path.dirname(cursor);
    const parentBase = path.basename(parent).toLowerCase();
    const grandParent = path.dirname(parent);
    const grandParentBase = path.basename(grandParent).toLowerCase();

    if (
      base === "logs" &&
      parentBase === "ea desktop" &&
      grandParentBase === "electronic arts"
    ) {
      push(cursor);
    }
    if (
      base === EA_VERBOSE_LOG_NAME.toLowerCase() &&
      parentBase === "logs" &&
      path.basename(grandParent).toLowerCase() === "ea desktop"
    ) {
      push(parent);
    }

    if (!parent || parent === cursor) break;
    cursor = parent;
  }

  return out;
}

function resolveEaOfficialVerboseLogPath(input, options = {}) {
  const explicitFile = String(
    options?.logFilePath ||
      options?.eaLogFile ||
      options?.ea_log_file ||
      input?.ea_log_file ||
      input?.eaLogFile ||
      "",
  ).trim();
  if (explicitFile && fs.existsSync(explicitFile)) {
    return explicitFile;
  }

  const savePath =
    typeof input === "string"
      ? input
      : String(input?.save_path || options?.savePath || "").trim();
  const roots = resolveEaOfficialLogsRoots(
    savePath || options?.logsRoot || options?.rootPath || "",
  );
  for (const logsRoot of roots) {
    const candidate = path.join(logsRoot, EA_VERBOSE_LOG_NAME);
    if (fs.existsSync(candidate)) return candidate;
  }
  return "";
}

function resolveEaOfficialVerboseLogBundle(input, options = {}) {
  const filePath = resolveEaOfficialVerboseLogPath(input, options);
  let logsRoot = "";
  if (filePath) {
    logsRoot = path.dirname(filePath);
  } else {
    const savePath =
      typeof input === "string"
        ? input
        : String(input?.save_path || options?.savePath || "").trim();
    const roots = resolveEaOfficialLogsRoots(
      savePath || options?.logsRoot || options?.rootPath || "",
    );
    logsRoot = roots[0] || "";
  }

  const filePaths = [];
  if (logsRoot) {
    const bakPath = path.join(logsRoot, EA_VERBOSE_LOG_BAK_NAME);
    const currentPath = path.join(logsRoot, EA_VERBOSE_LOG_NAME);
    if (fs.existsSync(bakPath)) filePaths.push(bakPath);
    if (fs.existsSync(currentPath)) filePaths.push(currentPath);
  } else if (filePath && fs.existsSync(filePath)) {
    filePaths.push(filePath);
  }

  return {
    logsRoot,
    filePath: filePath || filePaths[filePaths.length - 1] || "",
    filePaths,
  };
}

function readEaDesktopVerboseLog(logFilePath) {
  const bundle = resolveEaOfficialVerboseLogBundle(logFilePath);
  const filePath = String(bundle?.filePath || logFilePath || "").trim();
  const filePaths = Array.isArray(bundle?.filePaths) ? bundle.filePaths : [];
  if (!filePaths.length) {
    return {
      filePath,
      filePaths: [],
      logsRoot: String(bundle?.logsRoot || "").trim(),
      achievementSets: new Map(),
      completionEventsBySet: new Map(),
      gameInfoByContentId: new Map(),
    };
  }

  const cacheKey = filePaths
    .map((candidatePath) => {
      try {
        const stat = fs.statSync(candidatePath);
        return `${candidatePath.toLowerCase()}:${Number(stat.mtimeMs || 0)}:${Number(stat.size || 0)}`;
      } catch {
        return `${candidatePath.toLowerCase()}:missing`;
      }
    })
    .join("|");
  if (cachedVerboseLog.cacheKey === cacheKey && cachedVerboseLog.parsed) {
    return cachedVerboseLog.parsed;
  }

  const parts = [];
  for (const candidatePath of filePaths) {
    try {
      parts.push(fs.readFileSync(candidatePath, "utf8").replace(/\0/g, ""));
    } catch {
      /* ignore unreadable segment */
    }
  }
  const text = parts.join("\n");
  if (!text) {
    return {
      filePath,
      filePaths,
      logsRoot: String(bundle?.logsRoot || "").trim(),
      achievementSets: new Map(),
      completionEventsBySet: new Map(),
      gameInfoByContentId: new Map(),
    };
  }

  const gameInfoByContentId = new Map();
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = String(lines[index] || "");

    const installMatch = line.match(
      /"installPath":"([^"]+)".*?"masterTitleId":"?(\d+)"?.*?"offerId":"([^"]+)"/i,
    );
    if (installMatch) {
      const contentId = String(installMatch[2] || "").trim();
      if (contentId) {
        const current = gameInfoByContentId.get(contentId) || {};
        gameInfoByContentId.set(
          contentId,
          mergeGameInfo(current, {
            contentId,
            offerId: String(installMatch[3] || "").trim(),
            installPath: unescapeLoggedPath(installMatch[1]),
            order: index,
          }),
        );
      }
    }

    const launchMatch = line.match(
      /Processing launch request:\s+offerId\[([^\]]+)\]\s+contentId\[(\d+)\]\s+exe\[([^\]]+)\]\s+cwd\[([^\]]*)\]/i,
    );
    if (launchMatch) {
      const contentId = String(launchMatch[2] || "").trim();
      if (contentId) {
        const exePath = unescapeLoggedPath(launchMatch[3]);
        const current = gameInfoByContentId.get(contentId) || {};
        gameInfoByContentId.set(
          contentId,
          mergeGameInfo(current, {
            contentId,
            offerId: String(launchMatch[1] || "").trim(),
            exePath,
            cwd: unescapeLoggedPath(launchMatch[4]),
            processName: exePath ? path.basename(exePath) : "",
            order: index,
          }),
        );
      }
    }

    const launchedDetailsMatch = line.match(
      /Launched game details:\s+titleName\[([^\]]+)\]\s+offerId\[([^\]]+)\]\s+masterTitleId\[(\d+)\]/i,
    );
    if (launchedDetailsMatch) {
      const contentId = String(launchedDetailsMatch[3] || "").trim();
      if (contentId) {
        const current = gameInfoByContentId.get(contentId) || {};
        gameInfoByContentId.set(
          contentId,
          mergeGameInfo(current, {
            contentId,
            gameName: String(launchedDetailsMatch[1] || "").trim(),
            offerId: String(launchedDetailsMatch[2] || "").trim(),
            order: index,
          }),
        );
      }
    }

    const connectionMatch = line.match(
      /Connection Details:\s+idIsOffer\[true\]\s+contentId\[([^\]]+)\]\s+masterTitleId\[(\d+)\]\s+titleName\[([^\]]+)\]\s+offerId\[([^\]]+)\]/i,
    );
    if (connectionMatch) {
      const contentId = String(connectionMatch[2] || "").trim();
      if (contentId) {
        const current = gameInfoByContentId.get(contentId) || {};
        gameInfoByContentId.set(
          contentId,
          mergeGameInfo(current, {
            contentId,
            gameName: String(connectionMatch[3] || "").trim(),
            offerId: String(connectionMatch[4] || "").trim(),
            order: index,
          }),
        );
      }
    }

    const gameResponseMatch = line.match(
      /<Game\b[^>]*displayName="([^"]+)"[^>]*contentID="([^"]+)"/i,
    );
    if (gameResponseMatch) {
      const offerId = String(gameResponseMatch[2] || "").trim();
      const contentIdMatch = offerId.match(/(\d+)\s*$/);
      const contentId = contentIdMatch?.[1]
        ? contentIdMatch[1]
        : "";
      if (contentId) {
        const current = gameInfoByContentId.get(contentId) || {};
        gameInfoByContentId.set(
          contentId,
          mergeGameInfo(current, {
            contentId,
            gameName: String(gameResponseMatch[1] || "").trim(),
            offerId,
            order: index,
          }),
        );
      }
    }
  }

  const achievementSets = new Map();
  const setRegex = /<AchievementSet\b([^>]*)>([\s\S]*?)<\/AchievementSet>/gi;
  let setMatch = null;
  while ((setMatch = setRegex.exec(text))) {
    const attrs = parseXmlAttributes(setMatch[1]);
    const achievementSet = String(attrs.Name || "").trim();
    if (!achievementSet) continue;
    const contentId = parseEaContentIdFromAchievementSet(achievementSet);
    const gameInfo = gameInfoByContentId.get(contentId) || {};
    const achievements = [];
    const achievementRegex = /<Achievement\b([^>]*)\/>/gi;
    let achievementMatch = null;
    while ((achievementMatch = achievementRegex.exec(setMatch[2]))) {
      const achievement = normalizeEaAchievement(
        parseXmlAttributes(achievementMatch[1]),
      );
      if (!achievement) continue;
      achievements.push(achievement);
    }
    achievementSets.set(achievementSet, {
      achievementSet,
      appid: contentId,
      gameName: String(attrs.GameName || gameInfo.gameName || "").trim(),
      achievements,
      offerId: gameInfo.offerId || "",
      installPath: gameInfo.installPath || "",
      exePath: gameInfo.exePath || "",
      cwd: gameInfo.cwd || "",
      processName: gameInfo.processName || "",
      order: setMatch.index,
      logFilePath: filePath,
    });
  }

  const completionEventsBySet = new Map();
  const responseRegex =
    /<Response\b[^>]*>\s*<Achievement\b([^>]*?)\/>\s*<\/Response>/gis;
  let responseMatch = null;
  while ((responseMatch = responseRegex.exec(text))) {
    const achievement = normalizeEaAchievement(
      parseXmlAttributes(responseMatch[1]),
    );
    if (!achievement?.achievementSet || !achievement.earned) continue;
    const events = completionEventsBySet.get(achievement.achievementSet) || [];
    events.push({
      achievementId: achievement.id,
      earned_time: achievement.earned_time || 0,
      name: achievement.name,
      description: achievement.description,
      howTo: achievement.howTo,
      imageId: achievement.imageId,
      order: responseMatch.index,
    });
    completionEventsBySet.set(achievement.achievementSet, events);
  }

  const parsed = {
    filePath,
    filePaths,
    logsRoot: String(bundle?.logsRoot || "").trim(),
    achievementSets,
    completionEventsBySet,
    gameInfoByContentId,
  };
  cachedVerboseLog = {
    cacheKey,
    parsed,
  };
  return parsed;
}

function buildEaOfficialSnapshot(entryOrSetName, parsedLog = null, baseSnapshot = null) {
  const setName =
    typeof entryOrSetName === "string"
      ? String(entryOrSetName).trim()
      : String(entryOrSetName?.achievementSet || "").trim();
  const entry =
    typeof entryOrSetName === "object" && entryOrSetName
      ? entryOrSetName
      : setName && parsedLog?.achievementSets instanceof Map
        ? parsedLog.achievementSets.get(setName) || null
        : null;
  const baseOrder = Number(entry?.order || -1);
  const snapshot = {};

  if (baseSnapshot && typeof baseSnapshot === "object") {
    for (const [key, value] of Object.entries(baseSnapshot)) {
      if (!value || typeof value !== "object" || !value.earned) continue;
      const normalizedKey = String(key || "").trim();
      if (!normalizedKey) continue;
      snapshot[normalizedKey] = {
        earned: true,
        earned_time: normalizeEpochMs(value.earned_time || 0),
      };
    }
  }

  for (const achievement of Array.isArray(entry?.achievements)
    ? entry.achievements
    : []) {
    if (!achievement?.earned) continue;
    const key = String(achievement.id || "").trim();
    if (!key) continue;
    snapshot[key] = {
      earned: true,
      earned_time: normalizeEpochMs(achievement.earned_time || 0),
    };
  }

  const completionEvents =
    setName && parsedLog?.completionEventsBySet instanceof Map
      ? parsedLog.completionEventsBySet.get(setName) || []
      : [];
  for (const event of completionEvents) {
    if (!event || Number(event.order || -1) <= baseOrder) continue;
    const key = String(event.achievementId || "").trim();
    if (!key) continue;
    const earnedTime = normalizeEpochMs(event.earned_time || 0);
    const previous = snapshot[key];
    if (!previous || !previous.earned) {
      snapshot[key] = {
        earned: true,
        earned_time: earnedTime,
      };
      continue;
    }
    if (earnedTime && (!previous.earned_time || earnedTime < previous.earned_time)) {
      snapshot[key] = {
        earned: true,
        earned_time: earnedTime,
      };
    }
  }

  return snapshot;
}

function listEaOfficialAchievementSets(rootPath, options = {}) {
  const roots = Array.isArray(rootPath)
    ? rootPath
    : resolveEaOfficialLogsRoots(rootPath || options?.logsRoot || "");
  const out = [];
  const seen = new Set();

  for (const logsRoot of roots) {
    const logFilePath = resolveEaOfficialVerboseLogPath(logsRoot, options);
    if (!logFilePath) continue;
    const parsed = readEaDesktopVerboseLog(logFilePath);
    for (const entry of parsed.achievementSets.values()) {
      if (!entry?.appid || !entry?.achievementSet) continue;
      const key = `${entry.appid}:${entry.achievementSet}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        ...entry,
        logsRoot,
        logFilePath,
        snapshot: buildEaOfficialSnapshot(entry, parsed),
      });
    }
  }

  out.sort((a, b) => {
    const appCmp = String(a.appid || "").localeCompare(
      String(b.appid || ""),
      undefined,
      { numeric: true },
    );
    if (appCmp !== 0) return appCmp;
    return String(a.gameName || "").localeCompare(String(b.gameName || ""));
  });
  return out;
}

function resolveEaOfficialAchievementSetForAppId(appid, options = {}) {
  const targetAppId = String(appid || "").trim();
  if (!/^\d+$/.test(targetAppId)) return null;

  const targetSet = String(
    options?.achievementSet || options?.eaAchievementSet || "",
  ).trim();
  const logFilePath =
    String(options?.logFilePath || "").trim() ||
    resolveEaOfficialVerboseLogPath(options?.savePath || options?.logsRoot || "", options);
  const parsed = options?.parsedLog || readEaDesktopVerboseLog(logFilePath);
  if (!parsed?.achievementSets || !(parsed.achievementSets instanceof Map)) {
    return null;
  }

  let best = null;
  for (const entry of parsed.achievementSets.values()) {
    if (!entry || String(entry.appid || "").trim() !== targetAppId) continue;
    if (targetSet && entry.achievementSet !== targetSet) continue;
    if (!best || Number(entry.order || 0) > Number(best.order || 0)) {
      best = entry;
    }
  }
  if (!best) return null;
  return {
    ...best,
    logFilePath: logFilePath || best.logFilePath || "",
    logsRoot: path.dirname(logFilePath || best.logFilePath || ""),
    snapshot: buildEaOfficialSnapshot(best, parsed),
  };
}

function resolveEaOfficialVerboseLogForConfig(config = {}, options = {}) {
  const appid = String(config?.appid || "").trim();
  if (appid && !/^\d+$/.test(appid)) return null;
  const logFilePath = resolveEaOfficialVerboseLogPath(config, options);
  if (!logFilePath) return null;
  const logsRoot = path.dirname(logFilePath);
  return {
    appid,
    logFilePath,
    logsRoot,
  };
}

async function downloadEaAchievementIcon(imageId, destPath) {
  try {
    if (fs.existsSync(destPath) && fs.statSync(destPath).size > 0) {
      return true;
    }
  } catch {}

  const normalizedImageId = normalizeEaImageId(imageId);
  if (!normalizedImageId) return false;
  try {
    const res = await axios.get(
      `https://achievements.gameservices.ea.com/achievements/icons/${normalizedImageId}-208.png`,
      {
        responseType: "arraybuffer",
        timeout: 15000,
        validateStatus: (status) => status >= 200 && status < 400,
      },
    );
    if (!res?.data) return false;
    ensureDir(path.dirname(destPath));
    fs.writeFileSync(destPath, Buffer.from(res.data));
    return true;
  } catch (err) {
    eaLogger.warn("ea-official:icon-download-failed", {
      imageId: normalizedImageId,
      destPath,
      error: err?.message || String(err),
    });
    return false;
  }
}

async function ensureEaOfficialSchema(appid, schemaDir, options = {}) {
  const safeAppId = String(appid || "").trim();
  if (!/^\d+$/.test(safeAppId)) {
    throw new Error("ea-official:invalid-appid");
  }
  if (!schemaDir || typeof schemaDir !== "string") {
    throw new Error("ea-official:invalid-schema-dir");
  }

  const explicitLogFile = String(
    options?.logFilePath || options?.eaLogFile || options?.ea_log_file || "",
  ).trim();
  const parsed =
    options?.parsedLog ||
    readEaDesktopVerboseLog(
      explicitLogFile ||
        resolveEaOfficialVerboseLogPath(
          options?.savePath || options?.logsRoot || "",
          options,
        ),
    );
  const entry =
    options?.entry ||
    resolveEaOfficialAchievementSetForAppId(safeAppId, {
      ...options,
      parsedLog: parsed,
      logFilePath: explicitLogFile || parsed?.filePath || "",
    });
  if (!entry || !Array.isArray(entry.achievements) || !entry.achievements.length) {
    throw new Error("ea-official:achievement-set-missing");
  }

  ensureDir(schemaDir);
  const imgDir = path.join(schemaDir, "img");
  ensureDir(imgDir);

  const rows = [];
  for (const achievement of entry.achievements) {
    const key = String(achievement?.id || "").trim();
    if (!key) continue;
    let iconRel = "";
    const imageId = normalizeEaImageId(achievement.imageId || "");
    if (imageId) {
      const iconPath = path.join(imgDir, `${key}.png`);
      const downloaded = await downloadEaAchievementIcon(imageId, iconPath);
      if (downloaded || fs.existsSync(iconPath)) {
        iconRel = `img/${key}.png`;
      }
    }
    rows.push({
      hidden: 0,
      displayName: achievement.name
        ? { english: achievement.name }
        : {},
      description:
        achievement.description || achievement.howTo
          ? { english: achievement.description || achievement.howTo }
          : {},
      icon: iconRel,
      icon_gray: iconRel,
      name: key,
    });
  }

  fs.writeFileSync(
    path.join(schemaDir, "achievements.json"),
    JSON.stringify(rows, null, 2),
    "utf8",
  );

  const snapshot = buildEaOfficialSnapshot(entry, parsed);
  eaLogger.info("ea-official:schema-written", {
    appid: safeAppId,
    achievementSet: entry.achievementSet,
    schemaDir,
    achievements: rows.length,
    logFilePath: entry.logFilePath || parsed?.filePath || null,
  });

  return {
    dir: schemaDir,
    count: rows.length,
    title: entry.gameName || "",
    achievementSet: entry.achievementSet,
    offerId: entry.offerId || "",
    installPath: entry.installPath || "",
    exePath: entry.exePath || "",
    processName: entry.processName || "",
    logFilePath: entry.logFilePath || parsed?.filePath || "",
    snapshot,
  };
}

module.exports = {
  DEFAULT_EA_LOGS_ROOT,
  EA_VERBOSE_LOG_NAME,
  buildEaOfficialSnapshot,
  ensureEaOfficialSchema,
  listEaOfficialAchievementSets,
  readEaDesktopVerboseLog,
  resolveEaOfficialAchievementSetForAppId,
  resolveEaOfficialLogsRoots,
  resolveEaOfficialVerboseLogForConfig,
  resolveEaOfficialVerboseLogPath,
};
