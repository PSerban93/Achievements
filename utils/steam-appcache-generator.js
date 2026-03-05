const fs = require("fs");
const path = require("path");
const https = require("https");
const axios = require("axios");
const { createLogger } = require("./logger");
const { sanitizeConfigName } = require("./playtime-store");
const {
  parseKVBinary,
  extractSchemaAchievements,
  extractUserStats,
  buildSnapshotFromAppcache,
  normalizeSteamIconUrl,
  pickLatestUserBin,
} = require("./steam-appcache");
const autoConfigLogger = createLogger("autoconfig");
const schemaLogger = createLogger("achschema");
const coverLogger = createLogger("covers");

function sanitizeFileName(name) {
  return sanitizeConfigName(name);
}

const steamStoreCache = new Map();

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
      H
    );
  if (m && m[1]) {
    const name = cleanText(m[1]);
    if (!isBadName(name)) return name;
  }
  // 2) Breadcrumb: <span class="text-ellipsis app-name after">
  m =
    /<header[\s\S]*?<span[^>]*class="[^"]*\btext-ellipsis\b[^"]*\bapp-name\b[^"]*(?:\bafter\b)?[^"]*"[^>]*>([\s\S]*?)<\/span>/i.exec(
      H
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

async function fetchSteamStoreName(appid, fetchImpl = global.fetch) {
  if (!appid) return null;
  const key = String(appid);
  if (steamStoreCache.has(key)) return steamStoreCache.get(key);
  if (typeof fetchImpl !== "function") {
    const fallback = await getGameNameFromSteamHunters(appid);
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
    if (!res.ok) return null;
    const data = await res.json();
    const entry = data?.[String(appid)];
    const name = entry?.success ? entry?.data?.name : null;
    const resolved = name && typeof name === "string" ? name : null;
    if (resolved) {
      steamStoreCache.set(key, resolved);
      return resolved;
    }
  } catch {
    // fallthrough to SteamHunters
  } finally {
    clearTimeout(t);
  }
  const fallback = await getGameNameFromSteamHunters(appid);
  if (fallback) {
    steamStoreCache.set(key, fallback);
    return fallback;
  }
  return null;
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function resolveSteamOfficialLibraryCacheDir(statsDir, appid) {
  const statsPath = path.resolve(String(statsDir || ""));
  const baseName = path.basename(statsPath).toLowerCase();
  const appcacheDir =
    baseName === "stats"
      ? path.dirname(statsPath)
      : baseName === "appcache"
      ? statsPath
      : path.join(statsPath, "appcache");
  return path.join(appcacheDir, "librarycache", String(appid));
}

function listFilesRecursive(rootDir, maxDepth = 6) {
  const out = [];
  const walk = (dir, depth) => {
    if (depth > maxDepth) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
      } else if (entry.isFile()) {
        out.push(full);
      }
    }
  };
  walk(rootDir, 0);
  return out;
}

function pickSteamOfficialLibraryCacheImages(statsDir, appid) {
  const libraryCacheDir = resolveSteamOfficialLibraryCacheDir(statsDir, appid);
  if (!fs.existsSync(libraryCacheDir)) {
    return {
      libraryCacheDir,
      headerPath: "",
      portraitPath: "",
    };
  }
  const files = listFilesRecursive(libraryCacheDir, 6);
  const byName = new Map();
  for (const file of files) {
    const lower = path.basename(file).toLowerCase();
    if (!byName.has(lower)) byName.set(lower, []);
    byName.get(lower).push(file);
  }
  const first = (name) => (byName.get(name) || [])[0] || "";
  const firstMatch = (matcher) => {
    for (const [name, matches] of byName.entries()) {
      if (matcher(name)) return matches[0] || "";
    }
    return "";
  };
  const headerPath = first("header.jpg");
  const portraitPath =
    first("library_600x900.jpg") ||
    first("library_capsule.jpg") ||
    firstMatch((name) => /^library_capsule(?:_[a-z0-9]+)*\.jpg$/i.test(name));
  return {
    libraryCacheDir,
    headerPath,
    portraitPath,
  };
}

function importSteamOfficialLibraryCacheImages(statsDir, appid, configsDir) {
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
        fs.copyFileSync(picked.headerPath, headerDest);
        copiedHeader = true;
      } else {
        skippedHeaderExisting = true;
      }
    }
    if (picked.portraitPath) {
      ensureDir(targetDir);
      if (!fs.existsSync(portraitDest)) {
        fs.copyFileSync(picked.portraitPath, portraitDest);
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

function downloadViaHttps(url, dest) {
  return new Promise((resolve) => {
    let settled = false;
    let response = null;
    const finalize = (ok) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    const cleanupFile = () => {
      try {
        fs.unlinkSync(dest);
      } catch {}
    };
    const handleError = () => {
      try {
        if (response && typeof response.destroy === "function") {
          response.destroy();
        }
      } catch {}
      try {
        file.destroy();
      } catch {}
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
    https
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
      .setTimeout(20000, function () {
        this.destroy(new Error("Download timed out"));
      });
  });
}

async function download(url, dest, fetchImpl = global.fetch) {
  if (!url) return false;
  const targetUrl = url.replace(/^http:/, "https:");
  if (typeof fetchImpl !== "function") {
    return await downloadViaHttps(targetUrl, dest);
  }
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
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

function writeSchemaFromEntries(appid, entries, schemaDir) {
  ensureDir(schemaDir);
  const imgDir = path.join(schemaDir, "img");
  ensureDir(imgDir);

  const rewritten = [];
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
      download(iconUrl, path.join(imgDir, file)).catch(() => {});
    }
    if (grayUrl) {
      const ext = path.extname(new URL(grayUrl).pathname) || ".jpg";
      const file = `${baseName}_gray${ext}`;
      grayRel = `img/${file}`;
      download(grayUrl, path.join(imgDir, file)).catch(() => {});
    }
    if (!grayRel) grayRel = iconRel;
    rewritten.push({
      name: e.api,
      hidden: e.hidden ? 1 : 0,
      displayName: e.displayName || { english: "" },
      description: e.description || { english: "" },
      icon: iconRel,
      icon_gray: grayRel,
      statId: e.statId,
      bit: e.bit,
    });
  }

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

function updateSchemaFromAppcache(appid, entries, schemaDir) {
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

  for (const e of entries) {
    const existing = byName.get(e.api);
    if (!existing) {
      added++;
      updated = true;
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
        download(iconUrl, path.join(schemaDir, iconRel)).catch(() => {});
      }
      if (grayUrl) {
        const ext = path.extname(new URL(grayUrl).pathname) || ".jpg";
        const file = `${baseName}_gray${ext}`;
        grayRel = `img/${file}`;
        download(grayUrl, path.join(schemaDir, grayRel)).catch(() => {});
      }
      if (!grayRel) grayRel = iconRel;
      cur.push({
        name: e.api,
        hidden: e.hidden ? 1 : 0,
        displayName: e.displayName || { english: "" },
        description: e.description || { english: "" },
        icon: iconRel,
        icon_gray: grayRel,
        statId: e.statId,
        bit: e.bit,
      });
      continue;
    }
  }
  if (updated) {
    fs.writeFileSync(schemaPath, JSON.stringify(cur, null, 2), "utf8");
  }
  const hasSchemaChanges = updated || added > 0 || changed > 0;
  if (hasSchemaChanges) {
    schemaLogger.info("steam-appcache:schema:updated", {
      appid: String(appid),
      dir: schemaDir,
      updated,
      added,
      changed,
      total: cur.length,
      incoming: entries.length,
    });
  }
  return { updated, added, changed, entries: cur };
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

async function generateConfigFromAppcacheBin(statsDir, schemaBinPath, configsDir) {
  const appidMatch = path.basename(schemaBinPath).match(/UserGameStatsSchema_(\d+)\.bin/i);
  if (!appidMatch) return null;
  const appid = appidMatch[1];
  const userBin = pickLatestUserBin(statsDir, appid);
  if (!userBin) return null;

  const schemaKV = parseKVBinary(fs.readFileSync(schemaBinPath));
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
    schemaEntries = writeSchemaFromEntries(appid, entries, schemaRoot);
    schemaUpdated = true;
  }

  const userKV = parseKVBinary(fs.readFileSync(userBin));
  const userStats = extractUserStats(userKV.data);
  const snapshot = buildSnapshotFromAppcache(
    (schemaEntries || []).map((e) => ({
      api: e.name || e.api,
      statId: e.statId,
      bit: e.bit,
    })),
    userStats,
  );

  const storeName = await fetchSteamStoreName(appid);
  const resolvedBase = storeName || String(appid || "");
  const defaultCfgName = `${resolvedBase} (Steam)`;
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
  };
  let created = true;
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
      if (existingData?.displayName == null) {
        existingData.displayName = defaultCfgName;
        dirty = true;
      }
      const existingDisplay = existingData?.displayName || existingData?.name || "";
      if (storeName && typeof storeName === "string") {
        const desiredDisplay = `${storeName} (Steam)`;
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
      if (dirty) {
        fs.writeFileSync(cfgPath, JSON.stringify(existingData, null, 2));
      }
    } catch {}
  } else {
    fs.writeFileSync(cfgPath, JSON.stringify(payload, null, 2));
    autoConfigLogger.info("steam-appcache:config:created", {
      appid,
      name: cfgName,
      filePath: cfgPath,
    });
  }

  const importedImages = importSteamOfficialLibraryCacheImages(
    statsDir,
    appid,
    configsDir
  );

  return {
    appid,
    name: cfgName,
    configPath: cfgPath,
    config_path: schemaRoot,
    save_path: statsDir,
    created,
    schemaUpdated,
    snapshot: created || schemaUpdated ? snapshot : null,
    importedImages,
  };
}

module.exports = {
  generateConfigFromAppcacheBin,
  writeSchemaFromEntries,
  updateSchemaFromAppcache,
};
