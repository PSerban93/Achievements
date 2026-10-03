const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const axios = require("axios");

const {
  fetchSteamGridDbImage,
  STEAMGRID_HERO_DIMENSIONS,
} = require("./game-cover");
const { createLogger } = require("./logger");

const GAME_COVER_HERO_BASENAME = "game-cover-hero";
const GAME_COVER_LANDSCAPE_SOURCE_FILENAME = "landscape-source.txt";
const GAME_COVER_HERO_DIMENSIONS = STEAMGRID_HERO_DIMENSIONS;
const GAME_COVER_HERO_MAX_BYTES = 15 * 1024 * 1024;
const GAME_COVER_HERO_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp", ".gif"];
const gameCoverHeroLogger = createLogger("covers");
const pendingGameCoverHeroes = new Map();
let gameCoverHeroQueue = Promise.resolve();

function sanitizePathSegment(value) {
  const sanitized = String(value || "")
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_");
  return sanitized === "." || sanitized === ".." ? "" : sanitized;
}

function normalizeGameCoverSearchTerm(value) {
  let normalized = String(value || "").trim();
  if (!normalized) return "";
  const suffixPattern =
    /\s*\((?:steam|steam[-\s]?official|epic|epic[-\s]?official|uplay|ubisoft|ubisoft[-\s]?official|ea|ea[-\s]?official|gog|gog[-\s]?official|xbox(?:[-\s]?pc)?|retroachievements|xenia|rpcs3|ps4|shadps4|markerpatch|madnesspatch|xlivelessness)\)\s*$/i;
  while (suffixPattern.test(normalized)) {
    normalized = normalized.replace(suffixPattern, "").trim();
  }
  return normalized;
}

function getGameCoverHeroDirectory(userDataPath, platform, appid) {
  const safePlatform = sanitizePathSegment(platform);
  const safeAppId = sanitizePathSegment(appid);
  if (!userDataPath || !safePlatform || !safeAppId) return "";
  return path.join(userDataPath, "images", safePlatform, safeAppId);
}

function resolveExistingGameCoverHeroPath(userDataPath, platform, appid) {
  const imageDir = getGameCoverHeroDirectory(userDataPath, platform, appid);
  if (!imageDir) return "";
  for (const extension of GAME_COVER_HERO_EXTENSIONS) {
    const candidate = path.join(
      imageDir,
      `${GAME_COVER_HERO_BASENAME}${extension}`,
    );
    try {
      const stats = fs.statSync(candidate);
      if (stats.isFile() && stats.size > 0) {
        return candidate;
      }
    } catch {}
  }
  return "";
}

function detectImageExtension(buffer, contentType = "", sourceUrl = "") {
  const type = String(contentType || "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (type === "image/jpeg" || type === "image/jpg") return ".jpg";
  if (type === "image/png") return ".png";
  if (type === "image/webp") return ".webp";
  if (type === "image/gif") return ".gif";
  if (type && !type.startsWith("image/")) return "";

  if (
    buffer?.length >= 3 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff
  ) {
    return ".jpg";
  }
  if (buffer?.length >= 4) {
    if (
      buffer[0] === 0x89 &&
      buffer[1] === 0x50 &&
      buffer[2] === 0x4e &&
      buffer[3] === 0x47
    ) {
      return ".png";
    }
    if (buffer.subarray(0, 4).toString("ascii") === "GIF8") return ".gif";
  }
  if (buffer?.length >= 12) {
    if (
      buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
      buffer.subarray(8, 12).toString("ascii") === "WEBP"
    ) {
      return ".webp";
    }
  }

  try {
    const extension = path.extname(new URL(sourceUrl).pathname).toLowerCase();
    if (GAME_COVER_HERO_EXTENSIONS.includes(extension)) return extension;
  } catch {}
  return "";
}

async function downloadGameCoverHero(url, imageDir) {
  const response = await axios.get(url, {
    responseType: "arraybuffer",
    timeout: 25000,
    maxContentLength: GAME_COVER_HERO_MAX_BYTES,
    maxBodyLength: GAME_COVER_HERO_MAX_BYTES,
    headers: {
      Accept: "image/webp,image/apng,image/*,*/*;q=0.8",
      "User-Agent": "Achievements",
    },
  });
  const buffer = Buffer.from(response?.data || []);
  if (!buffer.length || buffer.length > GAME_COVER_HERO_MAX_BYTES) {
    throw new Error("invalid-hero-image-size");
  }
  const extension = detectImageExtension(
    buffer,
    response?.headers?.["content-type"],
    url,
  );
  if (!extension) throw new Error("unsupported-hero-image-format");

  await fs.promises.mkdir(imageDir, { recursive: true });
  const destination = path.join(
    imageDir,
    `${GAME_COVER_HERO_BASENAME}${extension}`,
  );
  const temporary = path.join(
    imageDir,
    `.${GAME_COVER_HERO_BASENAME}-${process.pid}-${crypto.randomBytes(6).toString("hex")}.tmp`,
  );
  try {
    await fs.promises.writeFile(temporary, buffer, { flag: "wx" });
    await fs.promises.rename(temporary, destination);
    await Promise.all(
      GAME_COVER_HERO_EXTENSIONS.filter((item) => item !== extension).map(
        async (item) => {
          try {
            await fs.promises.unlink(
              path.join(imageDir, `${GAME_COVER_HERO_BASENAME}${item}`),
            );
          } catch {}
        },
      ),
    );
    return destination;
  } finally {
    try {
      await fs.promises.unlink(temporary);
    } catch {}
  }
}

async function ensureGameCoverHero(options = {}) {
  const userDataPath = String(options.userDataPath || "").trim();
  const platform = sanitizePathSegment(options.platform);
  const appid = sanitizePathSegment(options.appid);
  const searchTerm = normalizeGameCoverSearchTerm(options.title);
  const existingPath = resolveExistingGameCoverHeroPath(
    userDataPath,
    platform,
    appid,
  );
  if (existingPath) {
    gameCoverHeroLogger.info("game-cover-hero:already-exists", {
      appid,
      platform,
      path: existingPath,
    });
    return { ok: true, existing: true, path: existingPath };
  }
  if (!userDataPath || !platform || !appid || !searchTerm) {
    return { ok: false, skipped: true, reason: "missing-identity" };
  }

  gameCoverHeroLogger.info("game-cover-hero:fetch-start", {
    appid,
    platform,
    term: searchTerm,
    dimensions: GAME_COVER_HERO_DIMENSIONS,
  });
  const url = await fetchSteamGridDbImage(searchTerm, {
    appid: `${platform}:${appid}:game-cover-hero`,
    size: GAME_COVER_HERO_DIMENSIONS,
    assetType: "heroes",
  });
  const imageDir = getGameCoverHeroDirectory(userDataPath, platform, appid);
  const savedPath = await downloadGameCoverHero(url, imageDir);
  gameCoverHeroLogger.info("game-cover-hero:downloaded", {
    appid,
    platform,
    term: searchTerm,
    path: savedPath,
    url,
  });
  return { ok: true, existing: false, path: savedPath, url };
}

function queueGameCoverHero(options = {}) {
  const platform = sanitizePathSegment(options.platform);
  const appid = sanitizePathSegment(options.appid);
  const key = `${platform.toLowerCase()}::${appid.toLowerCase()}`;
  if (!platform || !appid) {
    return Promise.resolve({
      ok: false,
      skipped: true,
      reason: "missing-identity",
    });
  }
  const existingPath = resolveExistingGameCoverHeroPath(
    options.userDataPath,
    platform,
    appid,
  );
  if (existingPath) {
    return Promise.resolve({ ok: true, existing: true, path: existingPath });
  }
  if (pendingGameCoverHeroes.has(key)) return pendingGameCoverHeroes.get(key);

  gameCoverHeroLogger.info("game-cover-hero:queued", {
    appid,
    platform,
    reason: options.reason || null,
  });
  const queued = gameCoverHeroQueue
    .catch(() => {})
    .then(() => ensureGameCoverHero({ ...options, platform, appid }))
    .catch((error) => {
      gameCoverHeroLogger.warn("game-cover-hero:failed", {
        appid,
        platform,
        reason: options.reason || null,
        error: error?.message || String(error),
      });
      return {
        ok: false,
        error: error?.message || String(error),
      };
    })
    .finally(() => {
      pendingGameCoverHeroes.delete(key);
    });
  pendingGameCoverHeroes.set(key, queued);
  gameCoverHeroQueue = queued;
  return queued;
}

module.exports = {
  GAME_COVER_HERO_BASENAME,
  GAME_COVER_LANDSCAPE_SOURCE_FILENAME,
  GAME_COVER_HERO_DIMENSIONS,
  detectImageExtension,
  downloadGameCoverHero,
  getGameCoverHeroDirectory,
  normalizeGameCoverSearchTerm,
  queueGameCoverHero,
  resolveExistingGameCoverHeroPath,
};
