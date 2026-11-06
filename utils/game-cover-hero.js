const fs = require("fs");
const path = require("path");

const {
  STEAMGRID_HERO_DIMENSIONS,
} = require("./game-cover");
const { createLogger } = require("./logger");

const GAME_COVER_HERO_BASENAME = "game-cover-hero";
const GAME_COVER_LANDSCAPE_SOURCE_FILENAME = "landscape-source.txt";
const GAME_COVER_HERO_DIMENSIONS = STEAMGRID_HERO_DIMENSIONS;
const GAME_COVER_HERO_MAX_BYTES = require("./game-artwork-policy").MAX_BYTES;
const GAME_COVER_HERO_EXTENSIONS = require("./game-artwork-storage").EXTENSIONS;
const gameCoverHeroLogger = createLogger("covers");

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
    /\s*\((?:steam|steam[-\s]?official|epic|epic[-\s]?official|uplay|ubisoft|ubisoft[-\s]?official|ea|ea[-\s]?official|gog|gog[-\s]?official|xbox(?:[-\s]?pc)?|retroachievements|ps4 recomp|pc ports?|xbox 360 recomp|xenia|rpcs3|ps4|shadps4|ps5|kytyps5|markerpatch|madnesspatch|xlivelessness)\)\s*$/i;
  const withoutVariant = normalized.replace(/(?:\s+\[\d+\])+$/, "");
  if (suffixPattern.test(withoutVariant)) normalized = withoutVariant;
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
  return require("./game-artwork-storage").existingAt(imageDir, GAME_COVER_HERO_BASENAME);
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

async function downloadGameCoverHero(url, imageDir, options = {}) {
  let buffer = await require("./game-artwork-http").download(url);
  let extension = require("./game-artwork-storage").signature(buffer);
  if (!GAME_COVER_HERO_EXTENSIONS.includes(extension)) throw new Error("unsupported-hero-image-format");
  if (options.imageProcessor) {
    const processed = await options.imageProcessor(buffer, extension);
    buffer = processed.buffer; extension = processed.extension;
    if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > GAME_COVER_HERO_MAX_BYTES || !GAME_COVER_HERO_EXTENSIONS.includes(extension)) throw new Error("invalid-processed-artwork");
  } else await require("./game-artwork-validation").decodeImage(buffer);
  const basename = sanitizePathSegment(options.basename || GAME_COVER_HERO_BASENAME);
  if (!basename) throw new Error("invalid-artwork-name");

  const storage = require("./game-artwork-storage");
  const type = basename === "game-cover-hero" ? "hero" : basename === "header" ? "header" : "cover";
  const result = await storage.publish({ dir: imageDir, base: basename, type, buffer, extension, source: "legacy-download", url });
  return result.path;
}

function queueGameCoverHero(options = {}) {
  const config = { ...(options.config || {}), platform: options.platform, appid: String(options.appid || ""),
    displayName: options.title || options.config?.displayName || "" };
  return require("./game-artwork-service").get().ensure({ config, userDataDir: options.userDataPath }, { type: "hero", force: options.force === true })
    .then(result => result.results[0]).catch(error => {
      gameCoverHeroLogger.warn("game-cover-hero:failed", { appid: config.appid, platform: config.platform, error: error.message });
      return { ok: false, error: error.message };
    });
}

module.exports = {
  GAME_COVER_HERO_BASENAME,
  GAME_COVER_LANDSCAPE_SOURCE_FILENAME,
  GAME_COVER_HERO_DIMENSIONS,
  GAME_COVER_HERO_MAX_BYTES,
  detectImageExtension,
  downloadGameCoverHero,
  getGameCoverHeroDirectory,
  normalizeGameCoverSearchTerm,
  queueGameCoverHero,
  resolveExistingGameCoverHeroPath,
};
