const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const axios = require("axios");
const { createLogger } = require("./logger");
const {
  RARITY_SOURCES,
  normalizeRarityPercent,
  writeAchievementPercentagesSidecar,
} = require("./achievement-rarity");
const {
  ensureEpicAccessToken,
  normalizeEpicAccountId,
} = require("./epic-auth");
const {
  inferOfficialPlatformFromMarkers,
  normalizePlatform,
} = require("./config-platform-migrator");
const { resolveEpicLocalInstallation } = require("./epic-local-installations");
const {
  normalizeRows,
  fetchEpicAchievementSchemaBySandbox,
  fetchEpicCatalogItem,
  fetchEpicEntitlements,
  fetchEpicLibraryAssets,
  fetchEpicOwnedGames,
  fetchEpicPlayerAchievements,
  fetchEpicPublicProductAchievements,
} = require("./epic-api");

const epicOfficialLogger = createLogger("epic-official");
let epicProductMap = null;
const EPIC_OFFICIAL_IMPORT_META_FILE = "epic-official-import-meta.json";
const EPIC_OFFICIAL_IMPORT_CONCURRENCY = 5;

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function sanitizeFileSegment(input) {
  const value = String(input || "")
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, "_")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return value || "epic_asset";
}

function sanitizeConfigFileName(input) {
  const value = String(input || "")
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return value || "Epic Official Game";
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const text = String(value || "").trim();
    if (text) return text;
  }
  return "";
}

function normalizeEpicStoreSlug(value) {
  let text = String(value || "").trim();
  if (!text) return "";
  text = text.replace(/^https?:\/\/[^/]+\/(?:[a-z]{2}(?:-[A-Z]{2})?\/)?(?:p|product)\//i, "");
  text = text.replace(/^\/?(?:[a-z]{2}(?:-[A-Z]{2})?\/)?(?:p|product)\//i, "");
  text = text.split(/[?#]/)[0].replace(/^\/+|\/+$/g, "").trim();
  return text && !/\s/.test(text) ? text : "";
}

function readEpicCustomAttributeValue(customAttributes, keys = []) {
  const wanted = new Set(
    keys.map((key) =>
      String(key || "")
        .trim()
        .toLowerCase(),
    ),
  );
  if (!wanted.size) return "";
  const list = Array.isArray(customAttributes)
    ? customAttributes
    : customAttributes && typeof customAttributes === "object"
      ? Object.entries(customAttributes).map(([key, value]) => ({ key, value }))
      : [];
  for (const entry of list) {
    const key = String(entry?.key || entry?.name || "").trim().toLowerCase();
    if (!wanted.has(key)) continue;
    const value = firstNonEmpty(entry?.value, entry?.Value);
    if (value) return value;
  }
  return "";
}

function extractEpicStoreSlugFromCatalogItem(catalogItem = null) {
  if (!catalogItem || typeof catalogItem !== "object") return "";
  return normalizeEpicStoreSlug(
    firstNonEmpty(
      catalogItem.productSlug,
      catalogItem.ProductSlug,
      catalogItem.urlSlug,
      catalogItem.UrlSlug,
      catalogItem.slug,
      catalogItem.Slug,
      catalogItem.url,
      catalogItem.Url,
      readEpicCustomAttributeValue(catalogItem.customAttributes, [
        "com.epicgames.app.productSlug",
        "com.epicgames.app.slug",
        "productSlug",
        "urlSlug",
      ]),
    ),
  );
}

async function loadEpicProductMap(timeoutMs = 20000) {
  if (epicProductMap && typeof epicProductMap === "object") return epicProductMap;
  try {
    const url =
      "https://store-content.ak.epicgames.com/api/content/productmapping/";
    const res = await axios.get(url, {
      timeout: timeoutMs,
      responseType: "json",
      validateStatus: (status) => status >= 200 && status < 500,
    });
    if (res.status < 400 && res.data && typeof res.data === "object") {
      epicProductMap = res.data;
      return epicProductMap;
    }
  } catch (err) {
    epicOfficialLogger.warn("epic-official:productmap-fetch-failed", {
      error: err?.message || String(err),
    });
  }
  epicProductMap = {};
  return epicProductMap;
}

async function resolveEpicStoreSlug(candidates = [], timeoutMs = 20000) {
  const map = await loadEpicProductMap(timeoutMs);
  for (const candidate of candidates) {
    const key = String(candidate || "").trim();
    if (!key) continue;
    const slug = map?.[key] || map?.[key.toLowerCase()] || null;
    if (slug) return slug;
  }
  return null;
}

function extractEpicHero(data = {}) {
  return (
    data?.hero ||
    (Array.isArray(data?.pages)
      ? data.pages
          .map((page) => page?.data?.hero || page?.hero)
          .find(
            (hero) =>
              hero &&
              (hero.portraitBackgroundImageUrl ||
                hero.backgroundImageUrl ||
                hero.title),
          )
      : null) ||
    null
  );
}

async function downloadEpicStoreImage(url, outPath, timeoutMs = 20000) {
  const sourceUrl = String(url || "").trim();
  if (!sourceUrl) return false;
  try {
    if (outPath && fs.existsSync(outPath)) {
      const stat = fs.statSync(outPath);
      if (stat.size > 0) return true;
      fs.unlinkSync(outPath);
    }
  } catch {}
  try {
    const res = await axios.get(sourceUrl, {
      responseType: "arraybuffer",
      timeout: timeoutMs,
      validateStatus: (status) => status >= 200 && status < 500,
    });
    if (res.status >= 400 || !res.data) return false;
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, res.data);
    return true;
  } catch (err) {
    return false;
  }
}

async function cacheEpicOfficialStoreImages(asset = {}, options = {}) {
  const userDataDir = String(options?.userDataDir || "").trim();
  const productId = firstNonEmpty(
    options?.productId,
    asset.productId,
    asset.appName,
    asset.namespace,
  );
  if (!userDataDir || !productId) {
    return { slug: "", portraitSaved: false, headerSaved: false, title: "" };
  }
  const timeoutMs =
    Number.isFinite(options?.timeoutMs) && options.timeoutMs > 0
      ? Number(options.timeoutMs)
      : 20000;
  const existingImages = getEpicOfficialStoreImageState(userDataDir, productId);
  const explicitSlug = normalizeEpicStoreSlug(
    firstNonEmpty(
      options?.epic_store_slug,
      options?.epicStoreSlug,
      asset?.epic_store_slug,
      asset?.epicStoreSlug,
      asset?.storeSlug,
      asset?.slug,
      asset?.urlSlug,
      asset?.productSlug,
    ),
  );
  const resolveMappedSlug = () =>
    resolveEpicStoreSlug(
      [
        options?.epic_app_name,
        asset.appName,
        options?.epic_catalog_item_id,
        asset.catalogItemId,
        options?.epic_namespace,
        asset.namespace,
        options?.productId,
        asset.productId,
      ],
      timeoutMs,
    );
  if (existingImages.complete) {
    const slug = explicitSlug || (await resolveMappedSlug());
    return {
      slug,
      portraitSaved: true,
      headerSaved: true,
      title: String(options?.title || asset?.title || "").trim(),
      skippedExisting: true,
    };
  }
  const slug = explicitSlug || (await resolveMappedSlug());
  if (!slug) {
    return { slug: "", portraitSaved: false, headerSaved: false, title: "" };
  }
  try {
    const url = `https://store-content.ak.epicgames.com/api/en-US/content/products/${encodeURIComponent(
      slug,
    )}`;
    const res = await axios.get(url, {
      timeout: timeoutMs,
      responseType: "json",
      validateStatus: (status) => status >= 200 && status < 500,
    });
    if (res.status >= 400 || !res.data || typeof res.data !== "object") {
      return { slug, portraitSaved: false, headerSaved: false, title: "" };
    }
    const data = res.data || {};
    const hero = extractEpicHero(data);
    const title = firstNonEmpty(
      data?.productName,
      data?.productName?.value,
      hero?.title,
      options?.title,
      asset.title,
    );
    const imageDir = existingImages.imageDir;
    const portraitSaved = hero?.portraitBackgroundImageUrl
      ? await downloadEpicStoreImage(
          hero.portraitBackgroundImageUrl,
          existingImages.portraitPath || path.join(imageDir, `${productId}.jpg`),
          timeoutMs,
        )
      : existingImages.portraitExists;
    const headerSaved = hero?.backgroundImageUrl
      ? await downloadEpicStoreImage(
          hero.backgroundImageUrl,
          existingImages.headerPath || path.join(imageDir, "header.jpg"),
          timeoutMs,
        )
      : existingImages.headerExists;
    epicOfficialLogger.info("epic-official:store-images-cached", {
      productId,
      namespace: asset?.namespace || null,
      appName: asset?.appName || null,
      slug,
      portraitSaved,
      headerSaved,
      skippedExisting: existingImages.complete === true,
    });
    return { slug, portraitSaved, headerSaved, title };
  } catch (err) {
    epicOfficialLogger.warn("epic-official:store-images-cache-failed", {
      productId,
      namespace: asset?.namespace || null,
      appName: asset?.appName || null,
      slug,
      error: err?.message || String(err),
    });
    return { slug, portraitSaved: false, headerSaved: false, title: "" };
  }
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  return value ? [value] : [];
}

function readJsonIfExists(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function jsonStableEqual(left, right) {
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

function hasNonEmptyFile(filePath) {
  try {
    return !!(
      filePath &&
      fs.existsSync(filePath) &&
      fs.statSync(filePath).size > 0
    );
  } catch {
    return false;
  }
}

function getEpicOfficialStoreImageState(userDataDir, productId) {
  const safeUserDataDir = String(userDataDir || "").trim();
  const safeProductId = String(productId || "").trim();
  if (!safeUserDataDir || !safeProductId) {
    return {
      imageDir: "",
      portraitPath: "",
      headerPath: "",
      portraitExists: false,
      headerExists: false,
      complete: false,
    };
  }
  const imageDir = path.join(
    safeUserDataDir,
    "images",
    "epic-official",
    safeProductId,
  );
  const portraitPath = path.join(imageDir, `${safeProductId}.jpg`);
  const headerPath = path.join(imageDir, "header.jpg");
  const portraitExists = hasNonEmptyFile(portraitPath);
  const headerExists = hasNonEmptyFile(headerPath);
  return {
    imageDir,
    portraitPath,
    headerPath,
    portraitExists,
    headerExists,
    complete: portraitExists && headerExists,
  };
}

function resolveEpicOfficialImportMetaPath(outputDir, userDataDir = "") {
  const safeUserDataDir = String(userDataDir || "").trim();
  if (safeUserDataDir) {
    return path.join(safeUserDataDir, EPIC_OFFICIAL_IMPORT_META_FILE);
  }
  const safeOutputDir = String(outputDir || "").trim();
  if (!safeOutputDir) return "";
  const base =
    path.basename(safeOutputDir).toLowerCase() === "configs"
      ? path.dirname(safeOutputDir)
      : safeOutputDir;
  return path.join(base, EPIC_OFFICIAL_IMPORT_META_FILE);
}

function makeEpicOfficialImportMetaKey(asset = {}) {
  const namespace = String(asset?.namespace || "").trim();
  const catalogItemId = String(asset?.catalogItemId || "").trim();
  const productId = String(asset?.productId || "").trim();
  const appName = String(asset?.appName || "").trim();
  return [
    namespace ? `ns:${namespace.toLowerCase()}` : "",
    catalogItemId ? `cat:${catalogItemId.toLowerCase()}` : "",
    productId ? `prod:${productId.toLowerCase()}` : "",
    appName ? `app:${appName.toLowerCase()}` : "",
  ]
    .filter(Boolean)
    .join("|");
}

function normalizeEpicOfficialImportMeta(raw = null) {
  const noAchievements = {};
  const source =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? raw.noAchievements || raw.entries || raw
      : {};
  if (source && typeof source === "object" && !Array.isArray(source)) {
    for (const [key, value] of Object.entries(source)) {
      if (!key || !value || typeof value !== "object") continue;
      const status = String(value.status || "").trim();
      if (status && status !== "no-achievements") continue;
      noAchievements[key] = {
        namespace: String(value.namespace || "").trim(),
        catalogItemId: String(value.catalogItemId || "").trim(),
        productId: String(value.productId || "").trim(),
        appName: String(value.appName || "").trim(),
        title: String(value.title || "").trim(),
        status: "no-achievements",
        reason: String(value.reason || "").trim() || "no-achievements",
        lastChecked: String(value.lastChecked || "").trim(),
      };
    }
  }
  return {
    version: 1,
    updatedAt:
      String(raw?.updatedAt || raw?.lastUpdated || "").trim() ||
      new Date(0).toISOString(),
    noAchievements,
  };
}

function loadEpicOfficialImportMeta(outputDir, userDataDir = "") {
  const metaPath = resolveEpicOfficialImportMetaPath(outputDir, userDataDir);
  if (!metaPath || !fs.existsSync(metaPath)) {
    return {
      path: metaPath,
      meta: normalizeEpicOfficialImportMeta(null),
      loaded: false,
    };
  }
  try {
    return {
      path: metaPath,
      meta: normalizeEpicOfficialImportMeta(
        JSON.parse(fs.readFileSync(metaPath, "utf8")),
      ),
      loaded: true,
    };
  } catch (err) {
    epicOfficialLogger.warn("epic-official:import-meta:load-failed", {
      path: metaPath,
      error: err?.message || String(err),
    });
    return {
      path: metaPath,
      meta: normalizeEpicOfficialImportMeta(null),
      loaded: false,
    };
  }
}

function saveEpicOfficialImportMeta(metaPath, meta) {
  if (!metaPath || !meta || typeof meta !== "object") return false;
  try {
    const payload = {
      version: 1,
      updatedAt: new Date().toISOString(),
      noAchievements:
        meta.noAchievements && typeof meta.noAchievements === "object"
          ? meta.noAchievements
          : {},
    };
    fs.mkdirSync(path.dirname(metaPath), { recursive: true });
    const tmpPath = `${metaPath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), "utf8");
    fs.renameSync(tmpPath, metaPath);
    return true;
  } catch (err) {
    epicOfficialLogger.warn("epic-official:import-meta:save-failed", {
      path: metaPath,
      error: err?.message || String(err),
    });
    return false;
  }
}

function rememberEpicOfficialNoAchievements(meta, asset = {}, reason = "") {
  if (!meta || typeof meta !== "object") return false;
  const key = makeEpicOfficialImportMetaKey(asset);
  if (!key) return false;
  const next = {
    namespace: String(asset?.namespace || "").trim(),
    catalogItemId: String(asset?.catalogItemId || "").trim(),
    productId: String(asset?.productId || "").trim(),
    appName: String(asset?.appName || "").trim(),
    title: String(asset?.title || asset?.appName || "").trim(),
    status: "no-achievements",
    reason: String(reason || "").trim() || "no-achievements",
    lastChecked: new Date().toISOString(),
  };
  const previous = meta.noAchievements?.[key] || null;
  if (jsonStableEqual(previous, next)) return false;
  if (!meta.noAchievements || typeof meta.noAchievements !== "object") {
    meta.noAchievements = {};
  }
  meta.noAchievements[key] = next;
  return true;
}

function forgetEpicOfficialNoAchievements(meta, asset = {}) {
  if (!meta?.noAchievements || typeof meta.noAchievements !== "object") {
    return false;
  }
  const candidates = new Set();
  const directKey = makeEpicOfficialImportMetaKey(asset);
  if (directKey) candidates.add(directKey);

  const namespace = String(asset?.namespace || "").trim().toLowerCase();
  const catalogItemId = String(asset?.catalogItemId || "").trim().toLowerCase();
  const productId = String(asset?.productId || "").trim().toLowerCase();
  const appName = String(asset?.appName || "").trim().toLowerCase();
  let changed = false;

  for (const [key, value] of Object.entries(meta.noAchievements)) {
    const valueNamespace = String(value?.namespace || "").trim().toLowerCase();
    const valueCatalogItemId = String(value?.catalogItemId || "")
      .trim()
      .toLowerCase();
    const valueProductId = String(value?.productId || "").trim().toLowerCase();
    const valueAppName = String(value?.appName || "").trim().toLowerCase();
    if (
      candidates.has(key) ||
      (namespace && valueNamespace === namespace) ||
      (catalogItemId && valueCatalogItemId === catalogItemId) ||
      (productId && valueProductId === productId) ||
      (appName && valueAppName === appName)
    ) {
      delete meta.noAchievements[key];
      changed = true;
    }
  }
  return changed;
}

function shouldSkipByEpicOfficialNoAchievementsCache(entry, asset = {}) {
  if (!entry) return false;
  const reason = String(entry?.reason || "").trim();
  const hasNamespace = Boolean(String(asset?.namespace || "").trim());
  if (hasNamespace && /\b404\b|public achievements/i.test(reason)) {
    return false;
  }
  return true;
}

function isRetryableEpicImportError(err) {
  const message = String(err?.message || err || "");
  return /\b(429|500|502|503|504)\b|timeout|network|ECONNRESET|ETIMEDOUT/i.test(
    message,
  );
}

function isNoAchievementsSchemaError(err) {
  const message = String(err?.message || err || "");
  if (isRetryableEpicImportError(err)) return false;
  return /empty|missing|404|not\s*found|schema/i.test(message);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms || 0)));
}

async function withEpicImportRetry(fn, options = {}) {
  const maxAttempts =
    Number.isFinite(Number(options?.attempts)) && Number(options.attempts) > 0
      ? Math.max(1, Number(options.attempts))
      : 2;
  const baseDelayMs =
    Number.isFinite(Number(options?.baseDelayMs)) &&
    Number(options.baseDelayMs) > 0
      ? Number(options.baseDelayMs)
      : 1500;
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt >= maxAttempts || !isRetryableEpicImportError(err)) {
        throw err;
      }
      await delay(baseDelayMs * attempt);
    }
  }
  throw lastError;
}

function resolveExistingEpicOfficialSchema(existing = null, schemaRoot = "") {
  const config = existing?.config || {};
  const productId = firstNonEmpty(
    config.epic_product_id,
    config.epicProductId,
    config.appid,
  );
  const candidates = [];
  const configPath = String(config.config_path || "").trim();
  if (configPath) candidates.push(path.join(configPath, "achievements.json"));
  if (schemaRoot && productId) {
    candidates.push(
      path.join(schemaRoot, sanitizeFileSegment(productId), "achievements.json"),
    );
  }
  for (const candidate of candidates) {
    if (!hasNonEmptyFile(candidate)) continue;
    const parsed = readJsonIfExists(candidate);
    if (Array.isArray(parsed) && parsed.length) {
      return {
        achievementsPath: candidate,
        schemaDir: path.dirname(candidate),
        achievementsCount: parsed.length,
        productId,
      };
    }
  }
  return null;
}

function buildEpicOfficialManagedConfig(existingConfig = {}, nextConfig = {}) {
  return {
    name: String(nextConfig?.name || existingConfig?.name || "").trim(),
    displayName: String(
      nextConfig?.displayName || existingConfig?.displayName || "",
    ).trim(),
    appid: String(nextConfig?.appid || existingConfig?.appid || "").trim(),
    platform: String(
      nextConfig?.platform || existingConfig?.platform || "",
    ).trim(),
    epic_product_id: String(
      nextConfig?.epic_product_id || existingConfig?.epic_product_id || "",
    ).trim(),
    epic_namespace: String(
      nextConfig?.epic_namespace || existingConfig?.epic_namespace || "",
    ).trim(),
    epic_catalog_item_id: String(
      nextConfig?.epic_catalog_item_id ||
        existingConfig?.epic_catalog_item_id ||
        "",
    ).trim(),
    epic_app_name: String(
      nextConfig?.epic_app_name || existingConfig?.epic_app_name || "",
    ).trim(),
    epic_account_id: String(
      nextConfig?.epic_account_id || existingConfig?.epic_account_id || "",
    ).trim(),
    epic_store_slug: String(
      nextConfig?.epic_store_slug || existingConfig?.epic_store_slug || "",
    ).trim(),
    config_path: String(
      nextConfig?.config_path || existingConfig?.config_path || "",
    ).trim(),
    save_path: String(
      nextConfig?.save_path || existingConfig?.save_path || "",
    ).trim(),
    executable: String(
      nextConfig?.executable || existingConfig?.executable || "",
    ).trim(),
    arguments: String(
      nextConfig?.arguments || existingConfig?.arguments || "",
    ).trim(),
    process_name: String(
      nextConfig?.process_name || existingConfig?.process_name || "",
    ).trim(),
  };
}

function normalizeRaritySidecarForCompare(payload = null) {
  if (!payload || typeof payload !== "object") return null;
  return {
    appid: String(payload.appid || "").trim(),
    source: String(payload.source || "").trim(),
    achievements: Array.isArray(payload.achievements)
      ? payload.achievements
      : [],
  };
}

function extFromUrl(inputUrl) {
  try {
    const parsed = new URL(String(inputUrl || ""));
    const ext = path.extname(parsed.pathname || "");
    if (ext && ext.length <= 8) return ext.toLowerCase();
  } catch {}
  return ".png";
}

function parseUnlockTime(value) {
  if (!isNonEmptyString(value)) return 0;
  const epochMs = Date.parse(value);
  return Number.isFinite(epochMs) && epochMs > 0 ? epochMs : 0;
}

function parseEpicAchievement(entry) {
  const achievement = entry?.achievement || entry || {};
  const apiName = String(
    achievement?.name ||
      achievement?.id ||
      achievement?.apiName ||
      achievement?.achievementName ||
      "",
  ).trim();
  if (!apiName) return null;
  return {
    apiName,
    displayName:
      achievement?.unlockedDisplayName ||
      achievement?.lockedDisplayName ||
      achievement?.displayName ||
      apiName,
    description:
      achievement?.unlockedDescription ||
      achievement?.lockedDescription ||
      achievement?.description ||
      "",
    hidden: achievement?.hidden === true,
    icon:
      achievement?.unlockedIconLink ||
      achievement?.unlockedIcon ||
      achievement?.unlockedIconUrl ||
      "",
    icon_gray:
      achievement?.lockedIconLink ||
      achievement?.lockedIcon ||
      achievement?.lockedIconUrl ||
      "",
    rarityPercent: normalizeRarityPercent(
      achievement?.rarity?.percent ?? entry?.rarity?.percent,
    ),
  };
}

async function downloadIcon(iconUrl, imgDir, fallbackName, timeoutMs = 15000) {
  const url = String(iconUrl || "").trim();
  if (!url) return "";
  let parsed = null;
  try {
    parsed = new URL(url);
  } catch {
    return "";
  }
  if (!["http:", "https:"].includes(parsed.protocol)) return "";
  fs.mkdirSync(imgDir, { recursive: true });
  const hash = crypto.createHash("sha1").update(url).digest("hex").slice(0, 16);
  const base =
    sanitizeFileSegment(
      path.basename(parsed.pathname || "").replace(/\.[^.]+$/, ""),
    ) || sanitizeFileSegment(fallbackName);
  const fileName = `${base}_${hash}${extFromUrl(url)}`;
  const fullPath = path.join(imgDir, fileName);
  if (!fs.existsSync(fullPath)) {
    const res = await axios.get(url, {
      timeout: timeoutMs,
      responseType: "arraybuffer",
      validateStatus: (status) => status >= 200 && status < 500,
    });
    if (res.status >= 400) throw new Error(`icon ${res.status}`);
    fs.writeFileSync(fullPath, Buffer.from(res.data));
  }
  return `img/${fileName}`;
}

async function fetchBestEpicSchema(appid, options = {}) {
  const timeoutMs =
    Number.isFinite(options?.timeoutMs) && options.timeoutMs > 0
      ? Number(options.timeoutMs)
      : 15000;
  const productId = String(
    options?.productId ||
      options?.epic_product_id ||
      options?.epicProductId ||
      "",
  ).trim();
  const sandboxId = String(
    options?.sandboxId ||
      options?.epic_sandbox_id ||
      options?.epicSandboxId ||
      options?.epic_namespace ||
      options?.epicNamespace ||
      "",
  ).trim();
  const fallbackId = String(appid || "").trim();
  let lastError = null;

  const publicIds = [];
  for (const candidate of [sandboxId, productId, fallbackId]) {
    const id = String(candidate || "").trim();
    if (id && !publicIds.includes(id)) publicIds.push(id);
  }

  for (const publicId of publicIds) {
    try {
      const result = await fetchEpicPublicProductAchievements(publicId, {
        timeoutMs,
        locale: options?.locale || "en",
      });
      if (result.achievements.length) {
        return {
          source: publicId === sandboxId ? "public-sandbox" : "public-product",
          productId: result.productId || productId || publicId,
          sandboxId,
          achievements: result.achievements,
        };
      }
    } catch (err) {
      lastError = err;
    }
  }

  if (sandboxId) {
    try {
      const result = await fetchEpicAchievementSchemaBySandbox(sandboxId, {
        timeoutMs,
        locale: options?.locale || "en-US",
      });
      if (result.achievements.length) {
        return {
          source: "sandbox",
          productId: result.productId || productId || fallbackId,
          sandboxId: result.sandboxId || sandboxId,
          achievements: result.achievements,
        };
      }
    } catch (err) {
      lastError = err;
    }
  }

  if (lastError) throw lastError;
  throw new Error("epic-achievements-schema-empty");
}

async function writeEpicOfficialSchema(
  safeAppId,
  destDir,
  schema,
  options = {},
) {
  if (!destDir) throw new Error("destDir-required");
  const timeoutMs =
    Number.isFinite(options?.timeoutMs) && options.timeoutMs > 0
      ? Number(options.timeoutMs)
      : 15000;
  const imgDir = path.join(destDir, "img");
  fs.mkdirSync(destDir, { recursive: true });
  fs.mkdirSync(imgDir, { recursive: true });
  const achievementsPath = path.join(destDir, "achievements.json");
  const sidecarExpectedPath = path.join(destDir, "achievementpercentages.json");

  const achievements = [];
  const rarityEntries = [];
  for (const row of schema.achievements) {
    const parsed = parseEpicAchievement(row);
    if (!parsed) continue;
    let iconRel = "";
    let iconGrayRel = "";
    try {
      iconRel = await downloadIcon(
        parsed.icon,
        imgDir,
        parsed.apiName,
        timeoutMs,
      );
    } catch {}
    try {
      iconGrayRel = await downloadIcon(
        parsed.icon_gray,
        imgDir,
        `${parsed.apiName}_gray`,
        timeoutMs,
      );
    } catch {}
    achievements.push({
      hidden: parsed.hidden ? 1 : 0,
      displayName: {
        english: parsed.displayName || parsed.apiName,
      },
      description: {
        english: parsed.description || "",
      },
      icon: iconRel,
      icon_gray: iconGrayRel || iconRel,
      name: parsed.apiName,
    });
    if (parsed.rarityPercent !== null) {
      rarityEntries.push({
        name: parsed.apiName,
        percent: Number(parsed.rarityPercent.toFixed(4)),
      });
    }
  }

  if (!achievements.length) throw new Error("epic-achievements-schema-empty");
  const previousAchievements = readJsonIfExists(achievementsPath);
  const achievementsChanged = !jsonStableEqual(
    previousAchievements,
    achievements,
  );
  if (achievementsChanged) {
    fs.writeFileSync(
      achievementsPath,
      JSON.stringify(achievements, null, 2),
      "utf8",
    );
  }
  const nextSidecar =
    rarityEntries.length > 0
      ? {
          appid: schema.productId || safeAppId,
          source: RARITY_SOURCES.epicPublic,
          achievements: rarityEntries,
        }
      : null;
  const previousSidecar = normalizeRaritySidecarForCompare(
    readJsonIfExists(sidecarExpectedPath),
  );
  const sidecarChanged = !jsonStableEqual(previousSidecar, nextSidecar);
  let sidecarPath = "";
  if (rarityEntries.length) {
    if (sidecarChanged) {
      sidecarPath = writeAchievementPercentagesSidecar(
        destDir,
        schema.productId || safeAppId,
        rarityEntries,
        { source: RARITY_SOURCES.epicPublic },
      );
    } else {
      sidecarPath = sidecarExpectedPath;
    }
  } else if (fs.existsSync(sidecarExpectedPath)) {
    fs.unlinkSync(sidecarExpectedPath);
  }

  return {
    dir: destDir,
    productId: schema.productId || safeAppId,
    sandboxId: schema.sandboxId || "",
    achievementsCount: achievements.length,
    sidecarPath,
    source: schema.source,
    changed: achievementsChanged || sidecarChanged,
  };
}

async function ensureEpicOfficialSchema(appid, destDir, options = {}) {
  const safeAppId = String(appid || "").trim();
  if (!safeAppId) throw new Error("appid-required");
  const timeoutMs =
    Number.isFinite(options?.timeoutMs) && options.timeoutMs > 0
      ? Number(options.timeoutMs)
      : 15000;
  epicOfficialLogger.info("epic-official:schema:ensure-start", {
    appid: safeAppId,
    destDir,
    sandboxId:
      String(
        options?.sandboxId ||
          options?.epic_sandbox_id ||
          options?.epicSandboxId ||
          options?.epic_namespace ||
          options?.epicNamespace ||
          "",
      ).trim() || null,
    productId:
      String(
        options?.productId ||
          options?.epic_product_id ||
          options?.epicProductId ||
          "",
      ).trim() || null,
  });
  const schema = await fetchBestEpicSchema(safeAppId, {
    ...options,
    timeoutMs,
  });
  const result = await writeEpicOfficialSchema(safeAppId, destDir, schema, {
    ...options,
    timeoutMs,
  });
  epicOfficialLogger.info("epic-official:schema:ensure-success", {
    appid: safeAppId,
    productId: result?.productId || null,
    sandboxId: result?.sandboxId || null,
    achievementsCount: result?.achievementsCount || 0,
    source: result?.source || null,
  });
  return result;
}

function normalizeEpicOwnedGame(game = {}) {
  const namespace = firstNonEmpty(
    game.namespace,
    game.Namespace,
    game.sandboxId,
    game.SandboxId,
    game.sandbox_id,
  );
  const appName = firstNonEmpty(
    game.gameId,
    game.GameId,
    game.appName,
    game.AppName,
    game.app_name,
    game.appId,
    game.AppId,
    game.productId,
    game.ProductId,
  );
  const productId = firstNonEmpty(
    game.productId,
    game.ProductId,
    game.product_id,
  );
  const catalogItemId = firstNonEmpty(
    game.catalogItemId,
    game.CatalogItemId,
    game.catalog_item_id,
    game.catalogItemID,
  );
  const title = firstNonEmpty(
    game.title,
    game.Title,
    game.displayName,
    game.DisplayName,
    appName,
    namespace,
  );
  const storeSlug = normalizeEpicStoreSlug(
    firstNonEmpty(
      game.epic_store_slug,
      game.epicStoreSlug,
      game.storeSlug,
      game.slug,
      game.productSlug,
      game.urlSlug,
      game.url,
    ),
  );
  return {
    namespace,
    appName,
    catalogItemId,
    productId,
    title,
    storeSlug,
    sandboxType: "LIVE", // assume live
    raw: game,
  };
}

function normalizeEpicLibraryAsset(asset = {}) {
  const metadata = asset?.metadata || asset?.Metadata || {};
  const namespace = firstNonEmpty(
    asset.namespace,
    asset.Namespace,
    asset.sandboxId,
    asset.SandboxId,
    asset.sandbox_id,
  );
  const appName = firstNonEmpty(
    asset.appName,
    asset.AppName,
    asset.app_name,
    asset.appId,
    asset.AppId,
    metadata.appId,
    metadata.AppId,
  );
  const catalogItemId = firstNonEmpty(
    asset.catalogItemId,
    asset.CatalogItemId,
    asset.catalog_item_id,
    asset.catalogItemID,
    metadata.catalogItemId,
    metadata.catalogItemID,
  );
  const productId = firstNonEmpty(
    asset.productId,
    asset.ProductId,
    asset.product_id,
    metadata.productId,
    metadata.ProductId,
    metadata.product_id,
  );
  const title = firstNonEmpty(
    asset.title,
    asset.Title,
    asset.displayName,
    asset.DisplayName,
    metadata.title,
    metadata.displayName,
    metadata.name,
    appName,
    namespace,
  );
  const storeSlug = normalizeEpicStoreSlug(
    firstNonEmpty(
      asset.epic_store_slug,
      asset.epicStoreSlug,
      asset.storeSlug,
      asset.slug,
      asset.productSlug,
      asset.urlSlug,
      asset.url,
      metadata.epic_store_slug,
      metadata.epicStoreSlug,
      metadata.storeSlug,
      metadata.slug,
      metadata.productSlug,
      metadata.urlSlug,
      metadata.url,
    ),
  );
  return {
    namespace,
    appName,
    catalogItemId,
    productId,
    title,
    storeSlug,
    sandboxType: firstNonEmpty(
      asset.sandboxType,
      asset.SandboxType,
      asset.sandbox_type,
    ),
    raw: asset,
  };
}

function normalizeEpicEntitlement(entitlement = {}) {
  const namespace = firstNonEmpty(
    entitlement.namespace,
    entitlement.Namespace,
    entitlement.sandboxId,
    entitlement.SandboxId,
    entitlement.sandbox_id,
  );
  const appName = firstNonEmpty(
    entitlement.appName,
    entitlement.AppName,
    entitlement.app_name,
    entitlement.appId,
    entitlement.AppId,
    entitlement.artifactId,
    entitlement.ArtifactId,
  );
  const catalogItemId = firstNonEmpty(
    entitlement.catalogItemId,
    entitlement.CatalogItemId,
    entitlement.catalog_item_id,
  );
  const productId = firstNonEmpty(
    entitlement.productId,
    entitlement.ProductId,
    entitlement.product_id,
  );
  const title = firstNonEmpty(
    entitlement.title,
    entitlement.Title,
    entitlement.displayName,
    entitlement.DisplayName,
    entitlement.entitlementName,
    appName,
    namespace,
  );
  const storeSlug = normalizeEpicStoreSlug(
    firstNonEmpty(
      entitlement.epic_store_slug,
      entitlement.epicStoreSlug,
      entitlement.storeSlug,
      entitlement.slug,
      entitlement.productSlug,
      entitlement.urlSlug,
      entitlement.url,
    ),
  );
  return {
    namespace,
    appName,
    catalogItemId,
    productId,
    title,
    storeSlug,
    source: "entitlements",
    entitlementId: firstNonEmpty(entitlement.id, entitlement.Id),
    status: firstNonEmpty(entitlement.status, entitlement.Status),
    active: entitlement?.active !== false,
    raw: entitlement,
  };
}

function mergeEpicImportAssets(entries = []) {
  const merged = new Map();
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const namespace = String(entry.namespace || "").trim().toLowerCase();
    const catalogItemId = String(entry.catalogItemId || "")
      .trim()
      .toLowerCase();
    const appName = String(entry.appName || "").trim().toLowerCase();
    const productId = String(entry.productId || "").trim().toLowerCase();
    const key = catalogItemId
      ? `${namespace}|catalog|${catalogItemId}`
      : appName
        ? `${namespace}|app|${appName}`
        : productId
          ? `${namespace}|product|${productId}`
          : `${namespace}|namespace`;
    if (!key.replace(/\|/g, "")) continue;
    if (!merged.has(key)) {
      merged.set(key, { ...entry, sources: [entry.source].filter(Boolean) });
      continue;
    }
    const current = merged.get(key);
    if (!current.namespace && entry.namespace) current.namespace = entry.namespace;
    if (!current.appName && entry.appName) current.appName = entry.appName;
    if (!current.catalogItemId && entry.catalogItemId) {
      current.catalogItemId = entry.catalogItemId;
    }
    if (!current.productId && entry.productId) current.productId = entry.productId;
    if (!current.title && entry.title) current.title = entry.title;
    if (!current.storeSlug && entry.storeSlug) current.storeSlug = entry.storeSlug;
    if (entry.raw && !current.raw) current.raw = entry.raw;
    if (entry.source && !current.sources.includes(entry.source)) {
      current.sources.push(entry.source);
    }
    const nextStatus = String(entry.status || "").trim();
    if (!current.status && nextStatus) current.status = nextStatus;
    if (current.active !== true && entry.active === true) current.active = true;
  }
  return Array.from(merged.values());
}

function extractCatalogCategories(catalogItem = {}) {
  return asArray(catalogItem?.categories || catalogItem?.Categories)
    .map((category) =>
      String(category?.path || category?.Path || category || "")
        .trim()
        .toLowerCase(),
    )
    .filter(Boolean);
}

function catalogItemLooksPlayable(catalogItem = null) {
  if (!catalogItem || typeof catalogItem !== "object") return true;
  const categories = extractCatalogCategories(catalogItem);
  if (categories.length && !categories.includes("applications")) return false;
  if (
    categories.some((pathValue) =>
      ["digitalextras", "plugins", "plugins/engine"].includes(pathValue),
    )
  ) {
    return false;
  }
  const mainGameItem = catalogItem?.mainGameItem || catalogItem?.MainGameItem;
  if (mainGameItem && !categories.includes("addons/launchable")) {
    return false;
  }
  return true;
}

function resolveCatalogTitle(catalogItem = null, fallback = "") {
  if (!catalogItem || typeof catalogItem !== "object") return fallback;
  return firstNonEmpty(
    catalogItem.title,
    catalogItem.Title,
    catalogItem.displayName,
    catalogItem.DisplayName,
    catalogItem.keyImages?.title,
    fallback,
  );
}

function loadEpicOfficialConfigIndex(outputDir) {
  const byProductId = new Map();
  const byNamespace = new Map();
  try {
    if (!fs.existsSync(outputDir)) return { byProductId, byNamespace };
    const files = fs
      .readdirSync(outputDir)
      .filter((entry) => entry.toLowerCase().endsWith(".json"));
    for (const file of files) {
      const fullPath = path.join(outputDir, file);
      try {
        const config = JSON.parse(fs.readFileSync(fullPath, "utf8"));
        const inferredPlatform =
          inferOfficialPlatformFromMarkers(config) ||
          normalizePlatform(config?.platform);
        if (inferredPlatform !== "epic-official") {
          continue;
        }
        if (config?.platform !== inferredPlatform) {
          config.platform = inferredPlatform;
          try {
            fs.writeFileSync(fullPath, JSON.stringify(config, null, 2), "utf8");
          } catch {}
        }
        const productId = firstNonEmpty(
          config.epic_product_id,
          config.epicProductId,
          config.appid,
        );
        const namespace = firstNonEmpty(
          config.epic_namespace,
          config.epicNamespace,
          config.epic_sandbox_id,
        );
        const info = {
          filePath: fullPath,
          fileName: file,
          config,
        };
        if (productId) byProductId.set(productId, info);
        if (namespace) byNamespace.set(namespace, info);
      } catch {}
    }
  } catch {}
  return { byProductId, byNamespace };
}

function resolveUniqueConfigPath(outputDir, baseName) {
  const safeBase = sanitizeConfigFileName(baseName);
  let candidate = path.join(outputDir, `${safeBase}.json`);
  let suffix = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(outputDir, `${safeBase} ${suffix}.json`);
    suffix += 1;
  }
  return candidate;
}

async function importEpicOfficialLibrary(outputDir, options = {}) {
  if (!outputDir) throw new Error("outputDir-required");
  const timeoutMs =
    Number.isFinite(options?.timeoutMs) && options.timeoutMs > 0
      ? Number(options.timeoutMs)
      : 15000;
  const token =
    options?.token ||
    (await ensureEpicAccessToken({
      userDataDir: options?.userDataDir,
      tokensFile: options?.tokensFile,
      tokenSecret: options?.tokenSecret,
      timeoutMs,
      clientId: options?.clientId,
      clientSecret: options?.clientSecret,
      basicToken: options?.basicToken,
      redirectUri: options?.redirectUri,
    }));
  const accountId =
    normalizeEpicAccountId(options?.accountId) ||
    normalizeEpicAccountId(token?.account_id);
  const progress =
    typeof options?.onProgress === "function" ? options.onProgress : null;
  fs.mkdirSync(outputDir, { recursive: true });
  const schemaRootBase = isNonEmptyString(options?.schemaRootDir)
    ? String(options.schemaRootDir).trim()
    : path.join(outputDir, "schema");
  epicOfficialLogger.info("epic-official:import-library:start", {
    accountId: accountId || null,
    outputDir,
    schemaRootBase,
  });

  progress?.({
    phase: "fetchingLibrary",
    detail: "Fetching Epic entitlements",
    percent: 5,
  });
  let entitlements = [];
  try {
    const result = await fetchEpicEntitlements({
      accountId,
      accessToken: token?.access_token,
      tokenType: token?.token_type || "bearer",
      timeoutMs,
      pageSize: 1000,
    });
    entitlements = normalizeRows(result?.entitlements);
  } catch (err) {
    epicOfficialLogger.warn("epic-official:import-library:entitlements-failed", {
      accountId: accountId || null,
      error: err?.message || String(err),
    });
    entitlements = [];
  }

  progress?.({
    phase: "fetchingLibrary",
    detail: "Fetching Epic library items",
    percent: 6,
  });
  let libraryAssets = [];
  try {
    const result = await fetchEpicLibraryAssets({
      accessToken: token?.access_token,
      tokenType: token?.token_type || "bearer",
      timeoutMs,
      pageSize: 1000,
    });
    libraryAssets = normalizeRows(result?.assets);
  } catch (err) {
    epicOfficialLogger.warn("epic-official:import-library:library-assets-failed", {
      accountId: accountId || null,
      error: err?.message || String(err),
    });
    libraryAssets = [];
  }

  let ownedGames = [];
  if (!entitlements.length && !libraryAssets.length) {
    epicOfficialLogger.warn("epic-official:import-library:fallback-owned-games", {
      accountId: accountId || null,
      reason: "entitlements-and-library-assets-empty",
    });
    try {
      const result = await fetchEpicOwnedGames({
        accountId,
        accessToken: token?.access_token,
        tokenType: token?.token_type || "bearer",
        timeoutMs,
      });
      ownedGames = normalizeRows(result?.games);
    } catch (err) {
      epicOfficialLogger.warn("epic-official:import-library:owned-games-failed", {
        accountId: accountId || null,
        error: err?.message || String(err),
      });
      ownedGames = [];
    }
  }

  const mergedAssets = mergeEpicImportAssets([
    ...entitlements.map(normalizeEpicEntitlement),
    ...libraryAssets.map(normalizeEpicLibraryAsset),
    ...ownedGames.map(normalizeEpicOwnedGame),
  ]);
  let skippedMissingNamespace = 0;
  let skippedUeNamespace = 0;
  let skippedInactive = 0;
  let skippedStatus = 0;
  const assets = mergedAssets.filter((asset) => {
    if (!asset.namespace) {
      skippedMissingNamespace += 1;
      return false;
    }
    if (asset.namespace.toLowerCase() === "ue") {
      skippedUeNamespace += 1;
      return false;
    }
    if (asset.active === false) {
      skippedInactive += 1;
      return false;
    }
    const status = String(asset.status || "").trim().toUpperCase();
    if (status && status !== "ACTIVE") {
      skippedStatus += 1;
      return false;
    }
    return true;
  });
  epicOfficialLogger.info("epic-official:import-library:sources", {
    accountId: accountId || null,
    entitlementsTotal: entitlements.length,
    libraryAssetsTotal: libraryAssets.length,
    ownedGamesTotal: ownedGames.length,
    mergedTotal: mergedAssets.length,
    eligibleTotal: assets.length,
    skippedMissingNamespace,
    skippedUeNamespace,
    skippedInactive,
    skippedStatus,
  });

  const configIndex = loadEpicOfficialConfigIndex(outputDir);
  const schemaRoot = path.join(schemaRootBase, "epic-official");
  const importMetaState = loadEpicOfficialImportMeta(
    outputDir,
    options?.userDataDir,
  );
  const importMeta = importMetaState.meta;
  const reservedConfigPaths = new Set();
  let processed = 0;
  let created = 0;
  let updated = 0;
  let skipped = 0;
  let skippedUnchanged = 0;
  let skippedNoAchievementsCached = 0;
  let failed = 0;
  let withoutAchievements = 0;
  let schemaChecked = 0;
  let existingSchemaSkipped = 0;
  let imageSkippedExisting = 0;
  let localInstallUpdated = 0;
  let importMetaChanged = false;
  const schemaFailureSamples = [];
  const playableSkipSamples = [];
  const imported = [];
  let completed = 0;

  const getExistingForAsset = (asset, options = {}) => {
    const byProductId = configIndex.byProductId.get(asset.productId);
    if (byProductId) return byProductId;
    if (options.allowNamespace === true) {
      return configIndex.byNamespace.get(asset.namespace) || null;
    }
    return null;
  };

  const reserveConfigPath = (displayName, existingPath = "") => {
    if (existingPath) return existingPath;
    const safeBase = sanitizeConfigFileName(displayName);
    let candidate = path.join(outputDir, `${safeBase}.json`);
    let suffix = 2;
    while (fs.existsSync(candidate) || reservedConfigPaths.has(candidate)) {
      candidate = path.join(outputDir, `${safeBase} ${suffix}.json`);
      suffix += 1;
    }
    reservedConfigPaths.add(candidate);
    return candidate;
  };

  const processAsset = async (asset, index) => {
    const detail = asset.title || asset.appName || asset.namespace;
    try {
      const existingBeforeSchema = getExistingForAsset(asset, {
        allowNamespace: false,
      });
      const existingSchema = resolveExistingEpicOfficialSchema(
        existingBeforeSchema,
        schemaRoot,
      );
      if (existingBeforeSchema && existingSchema) {
        const previous = existingBeforeSchema.config || {};
        const productId = firstNonEmpty(
          existingSchema.productId,
          previous.epic_product_id,
          previous.appid,
          asset.productId,
          asset.namespace,
        );
        const displayName =
          previous.displayName ||
          `${sanitizeConfigFileName(asset.title || asset.appName)} (Epic Official)`;
        const localInstall = resolveEpicLocalInstallation({
          namespace: asset.namespace,
          catalogItemId: asset.catalogItemId,
          appName: asset.appName,
        });
        let catalogStoreSlug = "";
        if (!previous.epic_store_slug && asset.catalogItemId) {
          try {
            const catalog = await withEpicImportRetry(
              () =>
                fetchEpicCatalogItem(asset.namespace, asset.catalogItemId, {
                  accessToken: token?.access_token,
                  tokenType: token?.token_type || "bearer",
                  timeoutMs,
                }),
              { attempts: 2, baseDelayMs: 1500 },
            );
            catalogStoreSlug = extractEpicStoreSlugFromCatalogItem(
              catalog?.item || null,
            );
          } catch {}
        }
        const imageState = getEpicOfficialStoreImageState(
          options?.userDataDir,
          productId,
        );
        let storeImages = {
          slug: previous.epic_store_slug || catalogStoreSlug || "",
          portraitSaved: imageState.portraitExists,
          headerSaved: imageState.headerExists,
          title: displayName,
          skippedExisting: imageState.complete,
        };
        if (imageState.complete && storeImages.slug) {
          imageSkippedExisting += 1;
        } else {
          storeImages = await cacheEpicOfficialStoreImages(asset, {
            userDataDir: options?.userDataDir,
            timeoutMs,
            productId,
            epic_namespace: asset.namespace || "",
            epic_catalog_item_id: asset.catalogItemId || "",
            epic_app_name: asset.appName || "",
            epic_store_slug: previous.epic_store_slug || catalogStoreSlug || "",
            title: displayName,
          });
          if (storeImages?.skippedExisting) imageSkippedExisting += 1;
        }
        const nextConfig = {
          ...previous,
          name:
            previous.name ||
            path.basename(existingBeforeSchema.filePath || "", ".json"),
          displayName,
          appid: productId,
          platform: "epic-official",
          epic_product_id: productId,
          epic_namespace: previous.epic_namespace || asset.namespace || "",
          epic_catalog_item_id:
            previous.epic_catalog_item_id || asset.catalogItemId || "",
          epic_app_name: previous.epic_app_name || asset.appName || "",
          epic_account_id: accountId || previous.epic_account_id || "",
          epic_store_slug: storeImages?.slug || previous.epic_store_slug || "",
          config_path:
            previous.config_path ||
            existingSchema.schemaDir ||
            path.dirname(existingSchema.achievementsPath),
          save_path: previous.save_path || localInstall?.installLocation || "",
          executable: previous.executable || localInstall?.executablePath || "",
          arguments:
            previous.arguments || localInstall?.additionalCommandArgs || "",
          process_name: previous.process_name || localInstall?.processName || "",
        };
        const managedPrevious = buildEpicOfficialManagedConfig(
          previous,
          previous,
        );
        const managedNext = buildEpicOfficialManagedConfig(
          previous,
          nextConfig,
        );
        const configChanged = !jsonStableEqual(managedPrevious, managedNext);
        if (configChanged) {
          fs.writeFileSync(
            existingBeforeSchema.filePath,
            JSON.stringify(nextConfig, null, 2),
            "utf8",
          );
          const info = {
            filePath: existingBeforeSchema.filePath,
            fileName: path.basename(existingBeforeSchema.filePath),
            config: nextConfig,
          };
          configIndex.byProductId.set(productId, info);
          if (nextConfig.epic_namespace) {
            configIndex.byNamespace.set(nextConfig.epic_namespace, info);
          }
          processed += 1;
          updated += 1;
          if (
            (!previous.save_path && nextConfig.save_path) ||
            (!previous.executable && nextConfig.executable) ||
            (!previous.process_name && nextConfig.process_name)
          ) {
            localInstallUpdated += 1;
          }
        } else {
          skippedUnchanged += 1;
        }
        existingSchemaSkipped += 1;
        imported.push({
          name: nextConfig.name,
          appid: productId,
          namespace: nextConfig.epic_namespace || asset.namespace,
          title: displayName,
          epicStoreSlug: storeImages?.slug || "",
          portraitSaved: storeImages?.portraitSaved === true,
          headerSaved: storeImages?.headerSaved === true,
          created: false,
          updated: configChanged,
          skippedUnchanged: !configChanged,
          achievementsCount: existingSchema.achievementsCount || 0,
        });
        return;
      }

      const metaKey = makeEpicOfficialImportMetaKey(asset);
      const noAchievementsCacheEntry = metaKey
        ? importMeta.noAchievements?.[metaKey]
        : null;
      if (
        noAchievementsCacheEntry &&
        shouldSkipByEpicOfficialNoAchievementsCache(
          noAchievementsCacheEntry,
          asset,
        )
      ) {
        withoutAchievements += 1;
        skippedNoAchievementsCached += 1;
        return;
      }

      let catalogItem = null;
      let catalogPlayable = true;
      if (asset.catalogItemId) {
        try {
          const catalog = await withEpicImportRetry(
            () =>
              fetchEpicCatalogItem(asset.namespace, asset.catalogItemId, {
                accessToken: token?.access_token,
                tokenType: token?.token_type || "bearer",
                timeoutMs,
              }),
            { attempts: 2, baseDelayMs: 1500 },
          );
          catalogItem = catalog.item || null;
        } catch {}
      }
      catalogPlayable = catalogItemLooksPlayable(catalogItem);
      if (!catalogPlayable) {
        if (playableSkipSamples.length < 10) {
          playableSkipSamples.push({
            namespace: asset.namespace || "",
            catalogItemId: asset.catalogItemId || "",
            title: asset.title || asset.appName || "",
          });
        }
      }

      const title = sanitizeConfigFileName(
        resolveCatalogTitle(catalogItem, asset.title || asset.appName),
      );
      const catalogStoreSlug = extractEpicStoreSlugFromCatalogItem(catalogItem);
      let schema = null;
      try {
        schemaChecked += 1;
        schema = await withEpicImportRetry(
          () =>
            fetchBestEpicSchema(
              asset.productId || asset.catalogItemId || asset.namespace,
              {
                productId: asset.productId || "",
                sandboxId: asset.namespace,
                timeoutMs,
                locale: options?.locale || "en-US",
              },
            ),
          { attempts: 2, baseDelayMs: 2000 },
        );
      } catch (err) {
        const message = String(err?.message || err || "");
        if (!catalogPlayable) {
          skipped += 1;
        } else if (isNoAchievementsSchemaError(err)) {
          withoutAchievements += 1;
          if (rememberEpicOfficialNoAchievements(importMeta, asset, message)) {
            importMetaChanged = true;
          }
        } else {
          failed += 1;
        }
        if (schemaFailureSamples.length < 10) {
          schemaFailureSamples.push({
            namespace: asset.namespace || "",
            catalogItemId: asset.catalogItemId || "",
            productId: asset.productId || "",
            title: asset.title || asset.appName || "",
            error: message,
          });
        }
        return;
      }
      const productId = firstNonEmpty(
        schema.productId,
        asset.productId,
        asset.namespace,
      );
      if (!productId || !schema?.achievements?.length) {
        withoutAchievements += 1;
        if (
          rememberEpicOfficialNoAchievements(
            importMeta,
            { ...asset, productId },
            "epic-achievements-schema-empty",
          )
        ) {
          importMetaChanged = true;
        }
        return;
      }
      if (
        forgetEpicOfficialNoAchievements(importMeta, {
          ...asset,
          productId,
        })
      ) {
        importMetaChanged = true;
      }

      const storeImages = await cacheEpicOfficialStoreImages(asset, {
        userDataDir: options?.userDataDir,
        timeoutMs,
        productId,
        epic_namespace: asset.namespace || "",
        epic_catalog_item_id: asset.catalogItemId || "",
        epic_app_name: asset.appName || "",
        epic_store_slug: catalogStoreSlug,
        title,
      });
      if (storeImages?.skippedExisting) imageSkippedExisting += 1;

      const schemaDir = path.join(schemaRoot, sanitizeFileSegment(productId));
      const schemaResult = await writeEpicOfficialSchema(
        productId,
        schemaDir,
        {
          ...schema,
          productId,
          sandboxId: schema.sandboxId || asset.namespace,
        },
        { timeoutMs },
      );
      const existing =
        configIndex.byProductId.get(productId) ||
        configIndex.byNamespace.get(asset.namespace) ||
        null;
      const displayName = `${title} (Epic Official)`;
      const filePath = reserveConfigPath(displayName, existing?.filePath || "");
      const previous = existing?.config || {};
      const localInstall = resolveEpicLocalInstallation({
        namespace: asset.namespace,
        catalogItemId: asset.catalogItemId,
        appName: asset.appName,
      });
      const nextConfig = {
        ...previous,
        name: previous.name || path.basename(filePath, ".json"),
        displayName: previous.displayName || displayName,
        appid: productId,
        platform: "epic-official",
        epic_product_id: productId,
        epic_namespace: asset.namespace,
        epic_catalog_item_id:
          asset.catalogItemId || previous.epic_catalog_item_id || "",
        epic_app_name: asset.appName || previous.epic_app_name || "",
        epic_account_id: accountId || previous.epic_account_id || "",
        epic_store_slug: storeImages?.slug || previous.epic_store_slug || "",
        config_path: schemaResult.dir,
        save_path: previous.save_path || localInstall?.installLocation || "",
        executable: previous.executable || localInstall?.executablePath || "",
        arguments:
          previous.arguments || localInstall?.additionalCommandArgs || "",
        process_name: previous.process_name || localInstall?.processName || "",
      };
      const managedPrevious = buildEpicOfficialManagedConfig(
        previous,
        previous,
      );
      const managedNext = buildEpicOfficialManagedConfig(previous, nextConfig);
      const configChanged = !jsonStableEqual(managedPrevious, managedNext);
      const hasStructuralChange =
        !existing || configChanged || schemaResult.changed === true;
      if (!hasStructuralChange) {
        skippedUnchanged += 1;
        imported.push({
          name: nextConfig.name,
          appid: productId,
          namespace: asset.namespace,
          title,
          epicStoreSlug: storeImages?.slug || "",
          portraitSaved: storeImages?.portraitSaved === true,
          headerSaved: storeImages?.headerSaved === true,
          created: false,
          updated: false,
          skippedUnchanged: true,
          achievementsCount: schemaResult.achievementsCount || 0,
        });
        return;
      }
      fs.writeFileSync(filePath, JSON.stringify(nextConfig, null, 2), "utf8");
      const info = {
        filePath,
        fileName: path.basename(filePath),
        config: nextConfig,
      };
      configIndex.byProductId.set(productId, info);
      configIndex.byNamespace.set(asset.namespace, info);
      processed += 1;
      if (existing) {
        updated += 1;
      } else {
        created += 1;
      }
      imported.push({
        name: nextConfig.name,
        appid: productId,
        namespace: asset.namespace,
        title,
        epicStoreSlug: storeImages?.slug || "",
        portraitSaved: storeImages?.portraitSaved === true,
        headerSaved: storeImages?.headerSaved === true,
        created: !existing,
        updated: !!existing,
        skippedUnchanged: false,
        achievementsCount: schemaResult.achievementsCount || 0,
      });
    } finally {
      completed += 1;
      const basePercent =
        8 + Math.round((completed / Math.max(assets.length, 1)) * 82);
      progress?.({
        phase: "checkingGame",
        detail,
        current: completed,
        total: assets.length,
        percent: basePercent,
      });
    }
  };

  let nextAssetIndex = 0;
  const concurrency = Math.min(
    EPIC_OFFICIAL_IMPORT_CONCURRENCY,
    Math.max(1, assets.length),
  );
  epicOfficialLogger.info("epic-official:import-library:processing-start", {
    accountId: accountId || null,
    totalAssets: assets.length,
    concurrency,
    negativeCacheEntries: Object.keys(importMeta.noAchievements || {}).length,
  });
  const runners = Array.from({ length: concurrency }, async () => {
    while (nextAssetIndex < assets.length) {
      const index = nextAssetIndex;
      nextAssetIndex += 1;
      await processAsset(assets[index], index);
    }
  });
  await Promise.all(runners);

  if (importMetaChanged) {
    saveEpicOfficialImportMeta(importMetaState.path, importMeta);
  }

  progress?.({
    phase: "completed",
    detail: "Epic library import completed",
    current: assets.length,
    total: assets.length,
    percent: 100,
  });
  epicOfficialLogger.info("epic-official:import-library:summary", {
    accountId: accountId || null,
    totalAssets: assets.length,
    entitlementsTotal: entitlements.length,
    libraryAssetsTotal: libraryAssets.length,
    ownedGamesTotal: ownedGames.length,
    processed,
    created,
    updated,
    skipped,
    skippedUnchanged,
    skippedNoAchievementsCached,
    failed,
    withoutAchievements,
    schemaChecked,
    existingSchemaSkipped,
    imageSkippedExisting,
    localInstallUpdated,
    importMetaPath: importMetaState.path || "",
    importMetaUpdated: importMetaChanged === true,
    playableSkipSamples,
    schemaFailureSamples,
  });

  return {
    accountId,
    totalAssets: assets.length,
    entitlementsTotal: entitlements.length,
    libraryAssetsTotal: libraryAssets.length,
    ownedGamesTotal: ownedGames.length,
    processed,
    created,
    updated,
    skipped,
    skippedUnchanged,
    skippedNoAchievementsCached,
    failed,
    withoutAchievements,
    schemaChecked,
    existingSchemaSkipped,
    imageSkippedExisting,
    localInstallUpdated,
    importMetaPath: importMetaState.path || "",
    importMetaUpdated: importMetaChanged === true,
    imported,
  };
}

function buildEpicOfficialSnapshot(
  playerAchievements,
  schemaAchievements = [],
) {
  const out = {};
  if (Array.isArray(schemaAchievements)) {
    for (const entry of schemaAchievements) {
      const key = String(entry?.name || entry?.api || "").trim();
      if (!key) continue;
      out[key] = { earned: false, earned_time: 0 };
    }
  }
  for (const row of playerAchievements || []) {
    const achievement = row?.playerAchievement || row || {};
    const key = String(
      achievement?.achievementName ||
        achievement?.name ||
        achievement?.apiName ||
        "",
    ).trim();
    if (!key) continue;
    const earned = achievement?.unlocked === true;
    const earnedTime = parseUnlockTime(achievement?.unlockDate);
    out[key] = {
      ...(out[key] || {}),
      earned,
      earned_time: earned ? earnedTime : 0,
    };
  }
  return out;
}

async function syncEpicOfficialAchievements(config = {}, options = {}) {
  const token =
    options?.token ||
    (await ensureEpicAccessToken({
      userDataDir: options?.userDataDir,
      tokensFile: options?.tokensFile,
      tokenSecret: options?.tokenSecret,
      timeoutMs: options?.timeoutMs,
      clientId: options?.clientId,
      clientSecret: options?.clientSecret,
      basicToken: options?.basicToken,
      redirectUri: options?.redirectUri,
    }));
  const accountId =
    normalizeEpicAccountId(options?.accountId) ||
    normalizeEpicAccountId(token?.account_id) ||
    normalizeEpicAccountId(config?.epic_account_id);
  let productId = String(
    options?.productId ||
      config?.epic_product_id ||
      config?.epicProductId ||
      config?.appid ||
      "",
  ).trim();
  if (!accountId) throw new Error("epic-account-id-required");
  if (!productId) throw new Error("productId-required");
  epicOfficialLogger.info("epic-official:sync:start", {
    accountId,
    productId,
    configName: String(config?.name || config?.displayName || "").trim() || null,
    namespace:
      String(
        config?.epic_namespace ||
          config?.epicNamespace ||
          config?.epic_sandbox_id ||
          config?.epicSandboxId ||
          "",
      ).trim() || null,
  });
  let response = await fetchEpicPlayerAchievements(accountId, productId, {
    accessToken: token?.access_token,
    tokenType: token?.token_type || "bearer",
    timeoutMs: options?.timeoutMs || 15000,
  });

  if (
    Array.isArray(response.playerAchievements) &&
    response.playerAchievements.length === 0 &&
    productId &&
    String(
      config?.epic_namespace ||
        config?.epicNamespace ||
        config?.epic_sandbox_id ||
        config?.epicSandboxId ||
        config?.appid ||
        "",
    ).trim() === productId
  ) {
    try {
      const fallbackSchema = await fetchBestEpicSchema(productId, {
        sandboxId: productId,
        timeoutMs: options?.timeoutMs || 15000,
        locale: options?.locale || "en-US",
      });
      if (fallbackSchema?.productId && fallbackSchema.productId !== productId) {
        epicOfficialLogger.info("epic-official:sync:retry-product-id", {
          accountId,
          fromProductId: productId,
          toProductId: fallbackSchema.productId,
        });
        const retryResponse = await fetchEpicPlayerAchievements(
          accountId,
          fallbackSchema.productId,
          {
            accessToken: token?.access_token,
            tokenType: token?.token_type || "bearer",
            timeoutMs: options?.timeoutMs || 15000,
          },
        );
        if (
          Array.isArray(retryResponse.playerAchievements) &&
          retryResponse.playerAchievements.length > 0
        ) {
          response = retryResponse;
          productId = fallbackSchema.productId;
        }
      }
    } catch (err) {
    }
  }

  const result = {
    accountId: response.epicAccountId || accountId,
    displayName: response.displayName || "",
    productId,
    snapshot: buildEpicOfficialSnapshot(
      response.playerAchievements,
      options?.schemaAchievements || [],
    ),
    totalUnlocked: response.totalUnlocked,
    totalXP: response.totalXP,
  };
  epicOfficialLogger.info("epic-official:sync:success", {
    accountId: result.accountId || accountId,
    productId: result.productId || productId,
    totalUnlocked: result.totalUnlocked || 0,
    totalXP: result.totalXP || 0,
    snapshotCount: Object.keys(result.snapshot || {}).length,
  });
  return result;
}

module.exports = {
  ensureEpicOfficialSchema,
  importEpicOfficialLibrary,
  buildEpicOfficialSnapshot,
  syncEpicOfficialAchievements,
};
