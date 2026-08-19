"use strict";

const fs = require("fs");
const path = require("path");

function normalizeDirectoryPath(value) {
  const raw = String(value || "").trim();
  return raw ? path.resolve(raw) : "";
}

function sanitizeAchievementMediaFilename(value) {
  return (
    String(value || "achievement")
      .replace(/[\\/:*?"<>|]/g, "_")
      .replace(/\s+/g, " ")
      .slice(0, 120)
      .trim() || "achievement"
  );
}

function buildUniqueAchievementMediaPath(options = {}) {
  const root = normalizeDirectoryPath(options.root);
  if (!root) throw new TypeError("An achievement media root is required.");

  const extensionRaw = String(options.extension || "").trim().toLowerCase();
  const extension = extensionRaw.startsWith(".")
    ? extensionRaw
    : `.${extensionRaw}`;
  if (!/^\.[a-z0-9]+$/.test(extension)) {
    throw new TypeError("A valid achievement media extension is required.");
  }

  const gameFolder = path.join(
    root,
    sanitizeAchievementMediaFilename(options.gameName || "Unknown Game"),
  );
  const achievementName = sanitizeAchievementMediaFilename(
    options.achievementName || "Achievement",
  );
  const existsSync =
    typeof options.existsSync === "function"
      ? options.existsSync
      : fs.existsSync;
  let filePath = path.join(gameFolder, `${achievementName}${extension}`);
  if (existsSync(filePath)) {
    const now = options.now instanceof Date ? options.now : new Date();
    const timestamp = now.toISOString().replace(/[:.]/g, "-");
    filePath = path.join(
      gameFolder,
      `${achievementName}_${timestamp}${extension}`,
    );
  }
  return { gameFolder, filePath };
}

async function assertWritableDirectory(directoryPath, options = {}) {
  const resolved = normalizeDirectoryPath(directoryPath);
  if (!resolved) {
    throw new TypeError("A screenshot directory is required.");
  }

  let stat = null;
  try {
    stat = await fs.promises.stat(resolved);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    if (options.create === false) {
      throw new Error(`Screenshot directory does not exist: ${resolved}`);
    }
    await fs.promises.mkdir(resolved, { recursive: true });
    stat = await fs.promises.stat(resolved);
  }
  if (!stat.isDirectory()) {
    throw new Error(`Screenshot path is not a directory: ${resolved}`);
  }

  await fs.promises.access(resolved, fs.constants.W_OK);

  if (options.probe !== false) {
    const probePath = path.join(
      resolved,
      `.achievements-write-test-${process.pid}-${Date.now()}-${Math.random()
        .toString(16)
        .slice(2)}.tmp`,
    );
    let handle = null;
    try {
      handle = await fs.promises.open(probePath, "wx");
      await handle.writeFile("ok", "utf8");
    } finally {
      if (handle) {
        try {
          await handle.close();
        } catch {}
      }
      try {
        await fs.promises.rm(probePath, { force: true });
      } catch {}
    }
  }

  return resolved;
}

async function resolveWritableMediaRootFolder(options = {}) {
  const preferredPath = normalizeDirectoryPath(options.preferredPath);
  const fallbackPath = normalizeDirectoryPath(options.fallbackPath);
  const candidates = [];
  if (preferredPath) candidates.push({ path: preferredPath, fallback: false });
  if (fallbackPath && fallbackPath !== preferredPath) {
    candidates.push({ path: fallbackPath, fallback: true });
  }

  let preferredError = null;
  let lastError = null;
  for (const candidate of candidates) {
    try {
      const root = await assertWritableDirectory(candidate.path, {
        create: true,
        probe: options.probe !== false,
      });
      return {
        root,
        usedFallback: candidate.fallback,
        preferredError,
      };
    } catch (error) {
      lastError = error;
      if (!candidate.fallback) preferredError = error;
    }
  }

  const error = new Error(
    lastError?.message || "No writable screenshot directory is available.",
  );
  error.code = "screenshot-root-unavailable";
  error.preferredError = preferredError;
  error.cause = lastError || undefined;
  throw error;
}

function resolveScreenshotRootFolder(options = {}) {
  return resolveWritableMediaRootFolder(options);
}

function resolveScreenshotGameName(notificationData = {}, selectedConfig = "") {
  const notificationConfig = String(
    notificationData?.configName || notificationData?.config_name || "",
  ).trim();
  if (notificationConfig) return notificationConfig;

  const activeConfig = String(selectedConfig || "").trim();
  return activeConfig || "Unknown Game";
}

module.exports = {
  assertWritableDirectory,
  buildUniqueAchievementMediaPath,
  normalizeDirectoryPath,
  resolveScreenshotGameName,
  resolveScreenshotRootFolder,
  resolveWritableMediaRootFolder,
  sanitizeAchievementMediaFilename,
};
