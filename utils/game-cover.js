const path = require("path");

const {
  launchChromiumSafe: launchPlaywrightChromium,
} = require("./playwright-runtime");
const { createLogger } = require("./logger");

const STEAM_DB_NOT_FOUND_TAG = Symbol.for("steamdb-miss");
const STEAMGRID_NOT_FOUND_TAG = Symbol.for("steamgriddb-miss");
const coverLogger = createLogger("covers");

const CDN_BASE = "https://shared.fastly.steamstatic.com";
const baseLaunchArgs = ["--disable-blink-features=AutomationControlled"];
const browserByApp = new Map();

function markSteamDbNotFound(err, message) {
  const e = err instanceof Error ? err : new Error(message || String(err));
  e.tag = STEAM_DB_NOT_FOUND_TAG;
  return e;
}

function markSteamGridNotFound(err, message) {
  const error =
    err instanceof Error
      ? err
      : new Error(message || String(err || "not found"));
  error.tag = STEAMGRID_NOT_FOUND_TAG;
  return error;
}

async function launchChromiumSafe(opts = {}) {
  return launchPlaywrightChromium("playwright-core", {
    headless: true,
    args: baseLaunchArgs,
    ...opts,
  });
}

async function getBrowserForApp(appid, opts = {}) {
  const key = String(appid || "");
  if (browserByApp.has(key)) {
    const existing = browserByApp.get(key);
    if (existing && existing.isConnected && existing.isConnected()) {
      return existing;
    }
    try {
      await existing?.close();
    } catch {}
    browserByApp.delete(key);
  }
  const browser = await launchChromiumSafe(opts);
  browserByApp.set(key, browser);
  return browser;
}

function normalizeSteamDbRel(appid, relOrAbs) {
  if (/^https?:\/\//i.test(relOrAbs)) return relOrAbs;
  const clean = relOrAbs
    .replace(/^\//, "")
    .replace(/^store_item_assets\/steam\/apps\/\d+\//i, "");
  return `${CDN_BASE}/store_item_assets/steam/apps/${appid}/${clean}`;
}

async function fetchSteamDbLibraryCover(appid) {
  coverLogger.info("steamdb:fetch:start", { appid: String(appid) });
  const url = `https://steamdb.info/app/${appid}/info/`;
  const browser = await getBrowserForApp(appid, { headless: true });
  const steamDbCapsuleFallbackSelector =
    "#js-assets-table > tbody > tr:nth-child(6) > td:nth-child(2) > table > tbody > tr:nth-child(2) > td:nth-child(2) > a";

  const ctx = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121 Safari/537.36",
    viewport: { width: 1400, height: 1000 },
  });

  await ctx.route("**/*", (route) => {
    const u = route.request().url();
    if (/\.(mp4|webm|gif|woff2?|ttf|otf)$/i.test(u)) return route.abort();
    route.continue();
  });

  try {
    const page = await ctx.newPage();
    page.setDefaultTimeout(20000);

    const res = await page.goto(url, { waitUntil: "domcontentloaded" });
    if (!res || !res.ok())
      throw markSteamDbNotFound(null, `HTTP ${res?.status?.() ?? "??"}`);

    await page
      .waitForSelector(
        `a.image-hover, a[href*="library_600x900.jpg"], a[href*="library_capsule.jpg"], ${steamDbCapsuleFallbackSelector}`,
        {
          timeout: 5000,
        },
      )
      .catch(() => {});

    const found = await page.evaluate((capsuleSelector) => {
      const isLib = (s) => /library_600x900\.jpg/i.test(s || "");
      const isCapsule = (s) =>
        /library_capsule(?:_[a-z0-9]+)*\.jpg/i.test(s || "");
      const anchors = Array.from(
        document.querySelectorAll(
          `a.image-hover, a[href*="library_600x900.jpg"], a[href*="library_capsule.jpg"], ${capsuleSelector}`,
        ),
      );
      for (const a of anchors) {
        const href = a.getAttribute("href") || "";
        if (isLib(href)) return href.split("?")[0];
        if (isCapsule(href)) return href.split("?")[0];
        const txt = (a.textContent || "").trim();
        if (isLib(txt)) return txt.split("?")[0].replace(/^\/+/, "");
        if (isCapsule(txt)) return txt.split("?")[0].replace(/^\/+/, "");
      }
      const html = document.documentElement.innerHTML;
      const abs = html.match(
        /https?:\/\/[^"'<\s]*(?:library_600x900\.jpg|library_capsule(?:_[a-z0-9]+)*\.jpg)/i,
      );
      if (abs) return abs[0].split("?")[0];
      const rel = html.match(
        /store_item_assets\/steam\/apps\/\d+\/[^"'<\s]*(?:library_600x900\.jpg|library_capsule(?:_[a-z0-9]+)*\.jpg)/i,
      );
      if (rel) return rel[0].replace(/^\/+/, "");
      return "";
    }, steamDbCapsuleFallbackSelector);

    if (!found) {
      coverLogger.warn("steamdb:fetch:missing", { appid: String(appid) });
      throw markSteamDbNotFound(null, "cover missing");
    }
    const resolved = normalizeSteamDbRel(appid, found);
    coverLogger.info("steamdb:fetch:success", {
      appid: String(appid),
      url: resolved,
    });
    return resolved;
  } catch (err) {
    coverLogger.warn("steamdb:fetch:error", {
      appid: String(appid),
      error: err?.message || String(err),
    });
    throw markSteamDbNotFound(err);
  } finally {
    await ctx.close().catch(() => {});
    try {
      if (browser && browser.isConnected && browser.isConnected()) {
        await browser.close();
      }
    } catch {}
    browserByApp.delete(String(appid || ""));
  }
}

function buildSteamGridSearchUrl(term, size = "600x900") {
  const sanitized = String(term || "")
    .trim()
    .replace(/\+/g, " ")
    .replace(/\s+/g, "+");
  if (!sanitized.length) throw markSteamGridNotFound(null, "term-empty");
  return `https://www.steamgriddb.com/search/grids/${size}/all/all?term=${sanitized}`;
}

async function fetchSteamGridDbImage(term, options = {}) {
  const size = options.size || "600x900";
  const url = buildSteamGridSearchUrl(term, size);
  coverLogger.info("steamgrid:fetch:start", { term, size });
  let browser;
  try {
    browser = await getBrowserForApp(options?.appid || term, {
      headless: true,
    });
  } catch (err) {
    coverLogger.error("steamgrid:browser-failed", {
      term,
      size,
      error: err?.message || String(err),
    });
    throw markSteamGridNotFound(err, "browser-launch-failed");
  }
  let ctx;
  try {
    ctx = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
      viewport: { width: 1280, height: 900 },
    });
  } catch (err) {
    coverLogger.error("steamgrid:context-failed", {
      term,
      size,
      error: err?.message || String(err),
    });
    throw markSteamGridNotFound(err, "context-create-failed");
  }
  try {
    const page = await ctx.newPage();
    page.setDefaultTimeout(20000);
    const res = await page.goto(url, { waitUntil: "domcontentloaded" });
    if (!res || !res.ok()) {
      throw markSteamGridNotFound(null, `HTTP ${res?.status?.() ?? "??"}`);
    }
    await page.waitForTimeout(7000);
    await page
      .$("div.asset-container.compact div.preview div.img-container img", {
        timeout: 7000,
      })
      .catch(() => {});

    const src = await page.evaluate(() => {
      const target =
        document.querySelector(
          "div.asset-container.compact div.preview div.img-container img",
        ) ||
        document.querySelector("div.asset-container img") ||
        document.querySelector("img.grid-image");
      if (!target) return "";
      return (
        target.getAttribute("src") ||
        target.getAttribute("data-src") ||
        target.getAttribute("data-original") ||
        target.src ||
        ""
      )
        .trim()
        .split("?")[0];
    });

    if (!src) {
      coverLogger.warn("steamgrid:fetch:missing", { term, size });
      throw markSteamGridNotFound(null, "grid-miss");
    }
    const resolved = /^https?:\/\//i.test(src)
      ? src
      : new URL(
          src.replace(/^\//, ""),
          "https://www.steamgriddb.com/",
        ).toString();
    coverLogger.info("steamgrid:fetch:success", { term, size, url: resolved });
    return resolved;
  } catch (err) {
    coverLogger.warn("steamgrid:fetch:error", {
      term,
      size,
      error: err?.message || String(err),
    });
    throw markSteamGridNotFound(err);
  } finally {
    await ctx?.close().catch(() => {});
    try {
      const key = String(options?.appid || term);
      const b = browserByApp.get(key);
      if (b && b.isConnected && b.isConnected()) {
        await b.close();
      }
      browserByApp.delete(key);
    } catch {}
  }
}

module.exports = {
  fetchSteamDbLibraryCover,
  fetchSteamGridDbImage,
  launchChromiumSafe,
  STEAM_DB_NOT_FOUND_TAG,
  STEAMGRID_NOT_FOUND_TAG,
};
