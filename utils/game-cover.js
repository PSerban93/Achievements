const path = require("path");

const {
  launchChromiumSafe: launchPlaywrightChromium,
} = require("./playwright-runtime");
const { createLogger } = require("./logger");

const STEAM_DB_NOT_FOUND_TAG = Symbol.for("steamdb-miss");
const STEAMGRID_NOT_FOUND_TAG = Symbol.for("steamgriddb-miss");
const STEAMGRID_GRID_PORTRAIT_DIMENSIONS = "600x900";
const STEAMGRID_GRID_LANDSCAPE_DIMENSIONS = "460x215,920x430";
const STEAMGRID_HERO_DIMENSIONS = "3840x1240,1920x620";
const coverLogger = createLogger("covers");

const CDN_BASE = "https://shared.fastly.steamstatic.com";
const baseLaunchArgs = ["--disable-blink-features=AutomationControlled"];
const browserByApp = new Map();
const imageRequests = new Map();

function sharedRequest(key, operation) {
  if (imageRequests.has(key)) return imageRequests.get(key);
  const pending = Promise.resolve().then(operation).finally(() => {
    if (imageRequests.get(key) === pending) imageRequests.delete(key);
  });
  imageRequests.set(key, pending);
  return pending;
}

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
  let entry = browserByApp.get(key);
  if (!entry || entry.browser && !entry.browser.isConnected()) {
    entry = { browser: null, users: 0, promise: null };
    // Publish the pending launch, so concurrent acquisitions share one browser.
    browserByApp.set(key, entry);
    entry.promise = launchChromiumSafe(opts).then((browser) => {
      entry.browser = browser;
      return browser;
    });
  }
  entry.users++;
  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    if (--entry.users > 0) return;
    // Retire this particular browser before awaiting close. A late release
    // cannot remove or close a replacement acquired under the same key.
    if (browserByApp.get(key) === entry) browserByApp.delete(key);
    try { if (entry.browser?.isConnected()) await entry.browser.close(); } catch {}
  };
  try { return { browser: await entry.promise, release }; }
  catch (error) { await release(); throw error; }
}

function normalizeSteamDbRel(appid, relOrAbs) {
  if (/^https?:\/\//i.test(relOrAbs)) return relOrAbs;
  const clean = relOrAbs
    .replace(/^\//, "")
    .replace(/^store_item_assets\/steam\/apps\/\d+\//i, "");
  return `${CDN_BASE}/store_item_assets/steam/apps/${appid}/${clean}`;
}

function fetchSteamDbLibraryCover(appid) {
  return sharedRequest(`steamdb:${String(appid)}`, () => fetchSteamDbLibraryCoverRequest(appid));
}
async function fetchSteamDbLibraryCoverRequest(appid) {
  coverLogger.info("steamdb:fetch:start", { appid: String(appid) });
  const url = `https://steamdb.info/app/${appid}/info/`;
  const lease = await getBrowserForApp(appid, { headless: true });
  const { browser } = lease;
  const steamDbCapsuleFallbackSelector =
    "#js-assets-table > tbody > tr:nth-child(6) > td:nth-child(2) > table > tbody > tr:nth-child(2) > td:nth-child(2) > a";

  let ctx;
  try {
    ctx = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121 Safari/537.36",
      viewport: { width: 1400, height: 1000 },
    });

    await ctx.route("**/*", (route) => {
      const u = route.request().url();
      if (/\.(mp4|webm|gif|woff2?|ttf|otf)$/i.test(u)) return route.abort();
      route.continue();
    });

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
    await ctx?.close().catch(() => {});
    await lease.release();
  }
}

function normalizeSteamGridAssetType(value) {
  return String(value || "")
    .trim()
    .toLowerCase() === "heroes"
    ? "heroes"
    : "grids";
}

function buildSteamGridSearchUrl(
  term,
  size = "",
  assetType = "grids",
) {
  const sanitized = String(term || "")
    .trim()
    .replace(/\+/g, " ")
    .replace(/\s+/g, "+");
  if (!sanitized.length) throw markSteamGridNotFound(null, "term-empty");
  const normalizedAssetType = normalizeSteamGridAssetType(assetType);
  const dimensions =
    String(size || "").trim() ||
    (normalizedAssetType === "heroes"
      ? STEAMGRID_HERO_DIMENSIONS
      : STEAMGRID_GRID_PORTRAIT_DIMENSIONS);
  if (
    (normalizedAssetType === "heroes" &&
      [
        STEAMGRID_GRID_PORTRAIT_DIMENSIONS,
        STEAMGRID_GRID_LANDSCAPE_DIMENSIONS,
      ].includes(dimensions)) ||
    (normalizedAssetType === "grids" &&
      dimensions === STEAMGRID_HERO_DIMENSIONS)
  ) {
    throw new Error(`SteamGridDB ${normalizedAssetType} cannot use ${dimensions}`);
  }
  return `https://www.steamgriddb.com/search/${normalizedAssetType}/${dimensions}/all/all?term=${sanitized}`;
}

async function fetchSteamGridDbImage(term, options = {}) {
  options = { ...options };
  const url = buildSteamGridSearchUrl(term, options.size, options.assetType);
  const key = `${String(options.appid || term)}|${url}`;
  return sharedRequest(`steamgrid:${key}`, () => fetchSteamGridDbImageRequest(term, options));
}
async function fetchSteamGridDbImageRequest(term, options = {}) {
  const assetType = normalizeSteamGridAssetType(options.assetType);
  const size =
    String(options.size || "").trim() ||
    (assetType === "heroes"
      ? STEAMGRID_HERO_DIMENSIONS
      : STEAMGRID_GRID_PORTRAIT_DIMENSIONS);
  const url = buildSteamGridSearchUrl(term, size, assetType);
  coverLogger.info("steamgrid:fetch:start", { term, size, assetType });
  let browser, lease;
  try {
    lease = await getBrowserForApp(options?.appid || term, {
      headless: true,
    });
    browser = lease.browser;
  } catch (err) {
    coverLogger.error("steamgrid:browser-failed", {
      term,
      size,
      assetType,
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
      assetType,
      error: err?.message || String(err),
    });
    await lease.release();
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

    const src = await page.evaluate((requestedAssetType) => {
      const target =
        document.querySelector(
          "div.asset-container.compact div.preview div.img-container img",
        ) ||
        document.querySelector("div.asset-container img") ||
        document.querySelector("img.grid-image");
      if (!target) return "";
      if (requestedAssetType === "heroes") {
        const assetContainer = target.closest("div.asset-container");
        const downloadLink = assetContainer?.querySelector(
          ".btn-download a[href]",
        );
        const downloadHref = downloadLink?.getAttribute("href") || "";
        if (downloadHref) return downloadHref.trim().split("?")[0];
      }
      return (
        target.getAttribute("src") ||
        target.getAttribute("data-src") ||
        target.getAttribute("data-original") ||
        target.src ||
        ""
      )
        .trim()
        .split("?")[0];
    }, assetType);

    if (!src) {
      coverLogger.warn("steamgrid:fetch:missing", { term, size, assetType });
      throw markSteamGridNotFound(
        null,
        assetType === "heroes" ? "hero-miss" : "grid-miss",
      );
    }
    const resolved = /^https?:\/\//i.test(src)
      ? src
      : new URL(
          src.replace(/^\//, ""),
          "https://www.steamgriddb.com/",
        ).toString();
    coverLogger.info("steamgrid:fetch:success", {
      term,
      size,
      assetType,
      url: resolved,
    });
    return resolved;
  } catch (err) {
    coverLogger.warn("steamgrid:fetch:error", {
      term,
      size,
      assetType,
      error: err?.message || String(err),
    });
    throw markSteamGridNotFound(err);
  } finally {
    await ctx?.close().catch(() => {});
    await lease.release();
  }
}

module.exports = {
  STEAMGRID_GRID_PORTRAIT_DIMENSIONS,
  STEAMGRID_GRID_LANDSCAPE_DIMENSIONS,
  STEAMGRID_HERO_DIMENSIONS,
  buildSteamGridSearchUrl,
  fetchSteamDbLibraryCover,
  fetchSteamGridDbImage,
  launchChromiumSafe,
  STEAM_DB_NOT_FOUND_TAG,
  STEAMGRID_NOT_FOUND_TAG,
};
