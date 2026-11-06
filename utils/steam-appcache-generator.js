const { parseSteamCommunityTitle } = require("./steam-community-schema");
const fs = require("fs");
const path = require("path");
const https = require("https");
const { downloadSteamCommunityImage, isSteamImageFile } = require("./steam-community-images");
const axios = require("axios");
const { createLogger } = require("./logger");
const { sanitizeConfigName } = require("./playtime-store");
const {
  parseKVBinary,
  extractSchemaAchievements,
  extractGameName,
  extractUserStats,
  buildSnapshotFromAppcache,
  normalizeAppcacheSchemaEntries,
  normalizeSteamIconUrl,
  pickPreferredUserBin,
} = require("./steam-appcache");
const {
  RARITY_SOURCES,
  fetchSteamGlobalAchievementPercentages,
  buildRarityEntriesForSchema,
  writeAchievementPercentagesSidecar,
} = require("./achievement-rarity");
const { lookupSteamDbName } = require("./local-game-name-cache");
const { fetchSteamDbLaunchMetadata } = require("./steamdb-launch-metadata");
const {
  hasProcessNameValue,
  normalizeProcessNameValue,
} = require("./process-name-utils");
const autoConfigLogger = createLogger("autoconfig");
const schemaLogger = createLogger("achschema");
const coverLogger = createLogger("covers");
const rarityLogger = createLogger("rarity");

function sanitizeFileName(name) {
  return sanitizeConfigName(name);
}

function applyLaunchMetadataToConfig(configData, metadata) {
  if (!configData || !metadata) return false;
  let changed = false;
  for (const field of ["relative_executable", "relative_working_directory"]) {
    if (typeof metadata[field] === "string" && metadata[field].trim() && !String(configData.launch_metadata?.[field] || "").trim()) {
      configData.launch_metadata = { ...configData.launch_metadata, [field]: metadata[field] };
      changed = true;
    }
  }
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

const steamStoreCache = new Map();

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121 Safari/537.36";
async function getGameNameFromSteamCommunity(appid) {
  try {
    const url = `https://steamcommunity.com/achievements/${appid}?l=english`;
    const res = await axios.get(url, {
      headers: { "User-Agent": UA, Accept: "text/html" },
      timeout: 15000,
      validateStatus: (s) => s >= 200 && s < 500,
    });
    if (res.status >= 400) return null;
    const name = parseSteamCommunityTitle(res.data, appid);
    if (!name) {
      autoConfigLogger.warn("steamcommunity:name-missing", { appid });
    }
    return name || null;
  } catch (e) {
    autoConfigLogger.warn("steamcommunity:request-failed", {
      appid,
      error: e?.message || String(e),
    });
    return null;
  }
}

async function fetchSteamStoreName(appid, fetchImpl = global.fetch, userDataDir = "") {
  if (!appid) return null;
  const key = String(appid);
  if (steamStoreCache.has(key)) return steamStoreCache.get(key);
  const localSteamDbName = lookupSteamDbName(appid);
  if (localSteamDbName) {
    steamStoreCache.set(key, localSteamDbName);
    autoConfigLogger.info("local-name:steamdb-hit", {
      appid,
      platform: "steam-official",
      name: localSteamDbName,
    });
    return localSteamDbName;
  }
  if (typeof fetchImpl !== "function") {
    const fallback = await getGameNameFromSteamCommunity(appid);
    if (fallback) {
      steamStoreCache.set(key, fallback);
      return fallback;
    }
    return null;
  }
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 6000);
  try {
    const url = `https://store.steampowered.com/api/appdetails?appids=${appid}`;
    const res = await fetchImpl(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`Steam store HTTP ${res.status}`);
    const data = await res.json();
    require("./game-presentation-metadata").store({ userDataDir, platform: "steam-official", appid, kind: "steam", payload: data });
    const entry = data?.[String(appid)];
    const name = entry?.success ? entry?.data?.name : null;
    const resolved = name && typeof name === "string" ? name : null;
    if (resolved) {
      steamStoreCache.set(key, resolved);
      return resolved;
    }
  } catch {
    // fallthrough to SteamCommunity
  } finally {
    clearTimeout(t);
  }
  const fallback = await getGameNameFromSteamCommunity(appid);
  if (fallback) {
    steamStoreCache.set(key, fallback);
    return fallback;
  }
  return null;
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

async function writeSteamOfficialAchievementPercentages(schemaRoot, appid, schemaEntries) {
  const source = RARITY_SOURCES.steamGlobal;
  rarityLogger.info("rarity:steam:request", {
    appid: String(appid),
    source,
  });
  try {
    const fetchedMap = await fetchSteamGlobalAchievementPercentages(appid, {
      timeoutMs: 15000,
    });
    if (!fetchedMap.size) {
      rarityLogger.warn("rarity:steam:empty", {
        appid: String(appid),
        source,
      });
    } else {
      rarityLogger.info("rarity:steam:success", {
        appid: String(appid),
        source,
        fetchedCount: fetchedMap.size,
      });
    }
    const achievements = buildRarityEntriesForSchema(fetchedMap, schemaEntries, {
      normalizeName: (name) => String(name ?? "").trim(),
    });
    const filePath = writeAchievementPercentagesSidecar(
      schemaRoot,
      appid,
      achievements,
      {
        source,
      },
    );
    rarityLogger.info("rarity:steam:written", {
      appid: String(appid),
      source,
      sidecarPath: filePath,
      fetchedCount: fetchedMap.size,
      matchedCount: achievements.length,
    });
    return {
      written: true,
      fetched: fetchedMap.size,
      matched: achievements.length,
    };
  } catch (err) {
    rarityLogger.warn("rarity:steam:failed", {
      appid: String(appid),
      source,
      error: err?.message || String(err),
    });
    return { written: false, fetched: 0, matched: 0 };
  }
}

const pickSteamOfficialLibraryCacheImages = require("./game-artwork-steam-cache").pick;

async function importSteamOfficialLibraryCacheImages(statsDir, appid, configsDir) {
  const appidStr = String(appid || "");
  const picked = pickSteamOfficialLibraryCacheImages(statsDir, appidStr);
  const targetDir = path.join(
    path.dirname(configsDir),
    "images",
    "steam-official",
    appidStr
  );
  let copiedHeader = false;
  let copiedPortrait = false;
  let skippedHeaderExisting = false;
  let skippedPortraitExisting = false;
  const headerDest = path.join(targetDir, "header.jpg");
  const portraitDest = path.join(targetDir, `${appidStr}.jpg`);
  try {
    if (picked.headerPath) {
      ensureDir(targetDir);
      if (!fs.existsSync(headerDest)) {
        await require("./game-artwork-storage").importBuffer(headerDest, await fs.promises.readFile(picked.headerPath), { source: "steam-cache" });
        copiedHeader = true;
      } else {
        skippedHeaderExisting = true;
      }
    }
    if (picked.portraitPath) {
      ensureDir(targetDir);
      if (!fs.existsSync(portraitDest)) {
        await require("./game-artwork-storage").importBuffer(portraitDest, await fs.promises.readFile(picked.portraitPath), { source: "steam-cache" });
        copiedPortrait = true;
      } else {
        skippedPortraitExisting = true;
      }
    }
  } catch (err) {
    coverLogger.warn("steam-official:librarycache:copy-failed", {
      appid: appidStr,
      error: err?.message || String(err),
      source: picked.libraryCacheDir,
      target: targetDir,
    });
    return {
      copiedHeader: false,
      copiedPortrait: false,
      skippedHeaderExisting: false,
      skippedPortraitExisting: false,
      headerPath: picked.headerPath,
      portraitPath: picked.portraitPath,
      libraryCacheDir: picked.libraryCacheDir,
    };
  }
  if (
    copiedHeader ||
    copiedPortrait ||
    skippedHeaderExisting ||
    skippedPortraitExisting
  ) {
    coverLogger.info("steam-official:librarycache:copied", {
      appid: appidStr,
      copiedHeader,
      copiedPortrait,
      skippedHeaderExisting,
      skippedPortraitExisting,
      source: picked.libraryCacheDir,
      target: targetDir,
      headerPath: copiedHeader ? picked.headerPath : "",
      portraitPath: copiedPortrait ? picked.portraitPath : "",
    });
  } else {
    coverLogger.info("steam-official:librarycache:not-found", {
      appid: appidStr,
      source: picked.libraryCacheDir,
    });
  }
  return {
    copiedHeader,
    copiedPortrait,
    skippedHeaderExisting,
    skippedPortraitExisting,
    headerPath: picked.headerPath,
    portraitPath: picked.portraitPath,
    libraryCacheDir: picked.libraryCacheDir,
  };
}

function downloadViaHttps(url, dest, timeoutMs = 20000) {
  return new Promise((resolve) => {
    let settled = false;
    let response = null;
    let request = null;
    let deadline = null;
    const finalize = (ok) => {
      if (settled) return;
      settled = true;
      if (deadline) clearTimeout(deadline);
      resolve(ok);
    };
    const cleanupFile = () => {
      try {
        fs.unlinkSync(dest);
      } catch {}
    };
    const handleError = () => {
      if (settled) return;
      try {
        if (response && typeof response.destroy === "function") {
          response.destroy();
        }
      } catch {}
      try {
        file.destroy();
      } catch {}
      try { if (request && !request.destroyed) request.destroy(); } catch {}
      cleanupFile();
      finalize(false);
    };

    let file;
    try {
      ensureDir(path.dirname(dest));
      file = fs.createWriteStream(dest);
    } catch {
      return finalize(false);
    }

    file.on("error", handleError);
    request = https
      .get(url, { headers: { "User-Agent": UA } }, (res) => {
        response = res;
        if (res.statusCode !== 200) {
          res.resume();
          handleError();
          return;
        }
        res.on("error", handleError);
        res.pipe(file);
        file.on("finish", () => file.close(() => finalize(true)));
      })
      .on("error", handleError)
      .setTimeout(timeoutMs, function () {
        this.destroy(new Error("Download timed out"));
      });
    deadline = setTimeout(handleError, timeoutMs);
  });
}

async function download(url, dest, fetchImpl = global.fetch, timeoutMs = 20000) {
  if (!url) return false;
  const targetUrl = url.replace(/^http:/, "https:");
  if (typeof fetchImpl !== "function") {
    return await downloadViaHttps(targetUrl, dest, timeoutMs);
  }
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetchImpl(targetUrl, {
      signal: ctrl.signal,
    });
    if (!r.ok) return false;
    const ab = await r.arrayBuffer();
    ensureDir(path.dirname(dest));
    fs.writeFileSync(dest, Buffer.from(ab));
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

function queueSteamOfficialImageDownload(queue, appid, url, dest, label) {
  if (!url || !dest) return;
  const key = path.normalize(dest).toLowerCase();
  if (queue.has(key)) return;
  if (isSteamImageFile(dest)) return;
  queue.set(key, {
    url,
    dest,
    label,
  });
}

async function waitForSteamOfficialImageDownloads(appid, queue, context) {
  const downloads = Array.from(queue.values());
  if (!downloads.length) {
    return { requested: 0, downloaded: 0, failed: 0 };
  }
  let downloaded = 0;
  let failed = 0;
  let nextIndex = 0;
  const concurrency = 12;
  async function worker() {
    while (nextIndex < downloads.length) {
      const item = downloads[nextIndex++];
      let ok = false;
      let error = "";
      let attempted = [];
      try {
        ok = await downloadSteamCommunityImage({
          appid, value: item.url, dest: item.dest,
          download: (url, target, ms) => download(url, target, global.fetch, ms),
          onFailure: (details) => { attempted = details.attempted; error = details.error; },
        });
      } catch (err) {
        error = err?.message || String(err);
        ok = false;
      }
      if (ok && isSteamImageFile(item.dest)) {
        downloaded++;
        continue;
      }
      failed++;
      schemaLogger.warn("steam-appcache:image-download-failed", {
        appid: String(appid),
        context,
        label: item.label || "",
        url: item.url,
        dest: item.dest,
        error,
        attempted,
      });
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, downloads.length) }, () =>
      worker(),
    ),
  );
  schemaLogger.info("steam-appcache:images:downloaded", {
    appid: String(appid),
    context,
    requested: downloads.length,
    downloaded,
    failed,
  });
  return { requested: downloads.length, downloaded, failed };
}

function applyProgressMetadata(target, source) {
  if (!target || !source) return false;
  let changed = false;
  const fields = [
    "progressStatName",
    "progressStatId",
    "progressStatType",
    "progressMin",
    "progressMax",
  ];
  for (const field of fields) {
    if (source[field] == null || source[field] === "") continue;
    if (target[field] !== source[field]) {
      target[field] = source[field];
      changed = true;
    }
  }
  return changed;
}

function clearMissingImageReferences(entries, schemaDir, attemptedImages = null) {
  let cleared = 0;
  for (const entry of entries) {
    for (const field of ["icon", "icon_gray"]) {
      if (!entry[field]) continue;
      const file = path.join(schemaDir, entry[field]);
      if (attemptedImages && !attemptedImages.has(path.normalize(file).toLowerCase())) continue;
      if (!isSteamImageFile(file)) {
        entry[field] = "";
        cleared++;
      }
    }
  }
  return cleared;
}

async function writeSchemaFromEntries(appid, entries, schemaDir) {
  ensureDir(schemaDir);
  const imgDir = path.join(schemaDir, "img");
  ensureDir(imgDir);

  const rewritten = [];
  const imageDownloads = new Map();
  for (const e of entries) {
    const baseName = e.icon
      ? path.basename(String(e.icon)).replace(/\.[^.]+$/, "")
      : String(e.api);
    let iconRel = "";
    let grayRel = "";
    const iconUrl = normalizeSteamIconUrl(appid, e.icon || "");
    const grayUrl = normalizeSteamIconUrl(appid, e.icon_gray || e.icon || "");
    if (iconUrl) {
      const ext = path.extname(new URL(iconUrl).pathname) || ".jpg";
      const file = `${baseName}${ext}`;
      iconRel = `img/${file}`;
      queueSteamOfficialImageDownload(
        imageDownloads,
        appid,
        iconUrl,
        path.join(imgDir, file),
        `${e.api}:icon`,
      );
    }
    if (grayUrl) {
      const ext = path.extname(new URL(grayUrl).pathname) || ".jpg";
      const file = `${baseName}_gray${ext}`;
      grayRel = `img/${file}`;
      queueSteamOfficialImageDownload(
        imageDownloads,
        appid,
        grayUrl,
        path.join(imgDir, file),
        `${e.api}:icon_gray`,
      );
    }
    if (!grayRel) grayRel = iconRel;
    const item = {
      name: e.api,
      hidden: e.hidden ? 1 : 0,
      displayName: e.displayName || { english: "" },
      description: e.description || { english: "" },
      icon: iconRel,
      icon_gray: grayRel,
      statId: e.statId,
      bit: e.bit,
    };
    applyProgressMetadata(item, e);
    rewritten.push(item);
  }

  if (!rewritten.length) {
    throw new Error("steam-official:schema-empty");
  }

  await waitForSteamOfficialImageDownloads(
    appid,
    imageDownloads,
    "write-schema",
  );
  clearMissingImageReferences(rewritten, schemaDir);

  fs.writeFileSync(
    path.join(schemaDir, "achievements.json"),
    JSON.stringify(rewritten, null, 2),
    "utf8",
  );
  schemaLogger.info("steam-appcache:schema:written", {
    appid: String(appid),
    dir: schemaDir,
    achievements: rewritten.length,
  });
  return rewritten;
}

async function updateSchemaFromAppcache(appid, entries, schemaDir) {
  const schemaPath = path.join(schemaDir, "achievements.json");
  if (!fs.existsSync(schemaPath))
    return { updated: false, added: 0, changed: 0, entries: [] };
  let cur;
  try {
    cur = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
  } catch {
    return { updated: false, added: 0, changed: 0, entries: [] };
  }
  if (!Array.isArray(cur))
    return { updated: false, added: 0, changed: 0, entries: [] };

  const byName = new Map();
  for (const c of cur) byName.set(c.name, c);
  let updated = false;
  let added = 0;
  let changed = 0;
  let repairedImages = 0;
  const imageDownloads = new Map();

  for (const e of entries) {
    const baseName = e.icon
      ? path.basename(String(e.icon)).replace(/\.[^.]+$/, "")
      : String(e.api);
    const iconUrl = normalizeSteamIconUrl(appid, e.icon || "");
    const grayUrl = normalizeSteamIconUrl(appid, e.icon_gray || e.icon || "");
    const existing = byName.get(e.api);
    if (!existing) {
      added++;
      updated = true;
      let iconRel = "";
      let grayRel = "";
      if (iconUrl) {
        const ext = path.extname(new URL(iconUrl).pathname) || ".jpg";
        const file = `${baseName}${ext}`;
        iconRel = `img/${file}`;
        queueSteamOfficialImageDownload(
          imageDownloads,
          appid,
          iconUrl,
          path.join(schemaDir, iconRel),
          `${e.api}:icon`,
        );
      }
      if (grayUrl) {
        const ext = path.extname(new URL(grayUrl).pathname) || ".jpg";
        const file = `${baseName}_gray${ext}`;
        grayRel = `img/${file}`;
        queueSteamOfficialImageDownload(
          imageDownloads,
          appid,
          grayUrl,
          path.join(schemaDir, grayRel),
          `${e.api}:icon_gray`,
        );
      }
      if (!grayRel) grayRel = iconRel;
      const item = {
        name: e.api,
        hidden: e.hidden ? 1 : 0,
        displayName: e.displayName || { english: "" },
        description: e.description || { english: "" },
        icon: iconRel,
        icon_gray: grayRel,
        statId: e.statId,
        bit: e.bit,
      };
      applyProgressMetadata(item, e);
      cur.push(item);
      continue;
    }
    if (!existing.icon && iconUrl) {
      const ext = path.extname(new URL(iconUrl).pathname) || ".jpg";
      existing.icon = `img/${baseName}${ext}`;
      changed++;
      updated = true;
    }
    if (!existing.icon_gray && grayUrl) {
      const ext = path.extname(new URL(grayUrl).pathname) || ".jpg";
      existing.icon_gray = `img/${baseName}_gray${ext}`;
      changed++;
      updated = true;
    }
    if (existing.icon && iconUrl) {
      const iconPath = path.join(schemaDir, existing.icon);
      if (!isSteamImageFile(iconPath)) {
        repairedImages++;
        queueSteamOfficialImageDownload(
          imageDownloads,
          appid,
          iconUrl,
          iconPath,
          `${e.api}:icon`,
        );
      }
    }
    if (existing.icon_gray && grayUrl) {
      const grayPath = path.join(schemaDir, existing.icon_gray);
      if (!isSteamImageFile(grayPath)) {
        repairedImages++;
        queueSteamOfficialImageDownload(
          imageDownloads,
          appid,
          grayUrl,
          grayPath,
          `${e.api}:icon_gray`,
        );
      }
    }
    if (applyProgressMetadata(existing, e)) {
      changed++;
      updated = true;
    }
  }
  const imageResult = await waitForSteamOfficialImageDownloads(
    appid,
    imageDownloads,
    "update-schema",
  );
  const clearedImages = clearMissingImageReferences(cur, schemaDir, imageDownloads);
  if (clearedImages) {
    changed += clearedImages;
    updated = true;
  }
  const imagesUpdated = imageResult.downloaded > 0;
  if (updated) {
    fs.writeFileSync(schemaPath, JSON.stringify(cur, null, 2), "utf8");
  }
  const hasSchemaChanges =
    updated || added > 0 || changed > 0 || imageResult.requested > 0;
  if (hasSchemaChanges) {
    schemaLogger.info("steam-appcache:schema:updated", {
      appid: String(appid),
      dir: schemaDir,
      updated,
      added,
      changed,
      imagesUpdated,
      repairedImages,
      imageDownloads: imageResult,
      total: cur.length,
      incoming: entries.length,
    });
  }
  return { updated, added, changed, imagesUpdated, entries: cur };
}

function findExistingSteamOfficialConfig(configsDir, appid) {
  try {
    const entries = fs.readdirSync(configsDir, { withFileTypes: true });
    for (const ent of entries) {
      if (!ent.isFile()) continue;
      if (!ent.name.toLowerCase().endsWith(".json")) continue;
      const full = path.join(configsDir, ent.name);
      try {
        const data = JSON.parse(fs.readFileSync(full, "utf8"));
        if (String(data?.appid || "") !== String(appid)) continue;
        if (String(data?.platform || "").toLowerCase() !== "steam-official")
          continue;
        return {
          path: full,
          data,
        };
      } catch {}
    }
  } catch {}
  return null;
}

async function generateConfigFromAppcacheBin(
  statsDir,
  schemaBinPath,
  configsDir,
  options = {},
) {
  const appidMatch = path.basename(schemaBinPath).match(/UserGameStatsSchema_(\d+)\.bin/i);
  if (!appidMatch) return null;
  const appid = appidMatch[1];
  if (
    typeof options?.shouldSkipAppId === "function" &&
    options.shouldSkipAppId(appid) === true
  ) {
    return { appid, skipped: true, reason: "blacklisted" };
  }
  const onGenerationProgress =
    typeof options?.onGenerationProgress === "function"
      ? options.onGenerationProgress
      : null;
  const emitProgress = (progress = {}) => {
    if (!onGenerationProgress) return;
    try {
      onGenerationProgress({
        appid,
        itemName: String(progress.itemName || appid),
        ...progress,
      });
    } catch {}
  };
  const userBin = pickPreferredUserBin(
    statsDir,
    appid,
    options?.preferredAccountId,
  );
  if (!userBin) return null;

  emitProgress({
    phase: "preparing",
    percent: 12,
  });
  const schemaKV = parseKVBinary(fs.readFileSync(schemaBinPath));
  const schemaGameName = extractGameName(schemaKV.data);
  const schemaDisplayName = schemaGameName
    ? `${schemaGameName} (Steam)`
    : "";
  if (schemaDisplayName) {
    emitProgress({
      itemName: schemaDisplayName,
      phase: "preparing",
      percent: 16,
    });
  }
  const entries = extractSchemaAchievements(schemaKV.data);
  if (!entries.length) return null;

  const schemaRoot = path.join(
    configsDir,
    "schema",
    "steam-official",
    String(appid),
  );
  ensureDir(schemaRoot);
  let schemaEntries = [];
  let schemaUpdated = false;
  const schemaPath = path.join(schemaRoot, "achievements.json");
  if (fs.existsSync(schemaPath)) {
    // do not rewrite existing schema; just reuse
    try {
      schemaEntries = JSON.parse(fs.readFileSync(schemaPath, "utf8")) || [];
    } catch {
      schemaEntries = [];
    }
  }
  if (!schemaEntries.length) {
    emitProgress({
      phase: "generatingSchema",
      percent: 35,
    });
    schemaEntries = await writeSchemaFromEntries(appid, entries, schemaRoot);
    schemaUpdated = true;
  } else {
    const updateResult = await updateSchemaFromAppcache(
      appid,
      entries,
      schemaRoot,
    );
    if (updateResult.entries.length) {
      schemaEntries = updateResult.entries;
    }
    schemaUpdated =
      schemaUpdated || updateResult.updated || updateResult.imagesUpdated;
    if (updateResult.updated || updateResult.imagesUpdated) {
      emitProgress({
        phase: "generatingSchema",
        percent: 35,
      });
    }
  }
  if (schemaUpdated) {
    emitProgress({
      phase: "fetchSteamApi",
      percent: 48,
    });
  }
  const rarity = await writeSteamOfficialAchievementPercentages(
    schemaRoot,
    appid,
    schemaEntries,
  );

  emitProgress({
    phase: "generatingSchema",
    percent: 58,
  });
  const userKV = parseKVBinary(fs.readFileSync(userBin));
  const userStats = extractUserStats(userKV.data);
  const snapshot = buildSnapshotFromAppcache(
    normalizeAppcacheSchemaEntries(schemaEntries || []),
    userStats,
  );

  const storeName = await fetchSteamStoreName(appid, global.fetch, path.dirname(configsDir));
  const resolvedBase = storeName || schemaGameName || String(appid || "");
  const defaultCfgName = `${resolvedBase} (Steam)`;
  emitProgress({
    itemName: defaultCfgName,
    phase: "writingConfig",
    percent: 72,
  });
  const existing = findExistingSteamOfficialConfig(configsDir, appid);
  const desiredFileBase = sanitizeFileName(defaultCfgName);
  const cfgPath = existing?.path
    ? existing.path
    : path.join(configsDir, `${desiredFileBase}.json`);
  const cfgName = path.basename(cfgPath, ".json");
  const payload = {
    name: cfgName,
    displayName: defaultCfgName,
    appid: String(appid),
    platform: "steam-official",
    config_path: schemaRoot,
    save_path: statsDir,
    executable: "",
    arguments: "",
    process_name: "",
  };
  let created = true;
  let configUpdated = false;
  if (existing || fs.existsSync(cfgPath)) {
    created = false;
    try {
      const existingData =
        existing?.data || JSON.parse(fs.readFileSync(cfgPath, "utf8"));
      let dirty = false;
      if (existingData?.name !== cfgName) {
        existingData.name = cfgName;
        dirty = true;
      }
      if (
        existingData?.displayName == null ||
        String(existingData?.displayName || "") === `${appid} (Steam)`
      ) {
        existingData.displayName = defaultCfgName;
        dirty = true;
      }
      const existingDisplay = existingData?.displayName || existingData?.name || "";
      if (resolvedBase && resolvedBase !== String(appid)) {
        const desiredDisplay = `${resolvedBase} (Steam)`;
        if (desiredDisplay && desiredDisplay !== existingDisplay) {
          existingData.displayName = desiredDisplay;
          dirty = true;
          autoConfigLogger.info("steam-appcache:config:display-updated", {
            appid,
            name: existingData?.name || cfgName,
            displayName: desiredDisplay,
            filePath: cfgPath,
          });
        }
      }
      const needsLaunchMetadata =
        !hasProcessNameValue(existingData.process_name) ||
        !String(existingData.arguments || "").trim();
      if (
        needsLaunchMetadata &&
        applyLaunchMetadataToConfig(
          existingData,
          await fetchSteamDbLaunchMetadata(appid)
        )
      ) {
        dirty = true;
      }
      if (dirty) {
        configUpdated = true;
        emitProgress({
          phase: "writingConfig",
          percent: 82,
        });
        fs.writeFileSync(cfgPath, JSON.stringify(existingData, null, 2));
      }
    } catch {}
  } else {
    applyLaunchMetadataToConfig(
      payload,
      await fetchSteamDbLaunchMetadata(appid)
    );
    await require("./game-executable-finder").autoFindExecutable(payload);
    emitProgress({
      phase: "writingConfig",
      percent: 82,
    });
    fs.writeFileSync(cfgPath, JSON.stringify(payload, null, 2));
    autoConfigLogger.info("steam-appcache:config:created", {
      appid,
      name: cfgName,
      filePath: cfgPath,
    });
  }

  if (created || schemaUpdated || configUpdated) {
    emitProgress({
      phase: "finalizing",
      percent: 95,
    });
  }

  const importedImages = await importSteamOfficialLibraryCacheImages(
    statsDir,
    appid,
    configsDir
  );
  if (created || schemaUpdated) await require("./game-presentation-service").refresh({
    userDataDir: path.dirname(configsDir), config: payload, force: true, reason: "steam-official-schema" });

  return {
    appid,
    name: cfgName,
    configPath: cfgPath,
    config_path: schemaRoot,
    save_path: statsDir,
    created,
    schemaUpdated,
    configUpdated,
    snapshot: created || schemaUpdated ? snapshot : null,
    importedImages,
    rarity,
  };
}

module.exports = {
  pickSteamOfficialLibraryCacheImages,
  generateConfigFromAppcacheBin,
  writeSchemaFromEntries,
  updateSchemaFromAppcache,
};
