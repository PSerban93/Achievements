const fs = require("fs");
const path = require("path");

const STORE_CDN_BASES = [
  "https://shared.fastly.steamstatic.com/store_item_assets/steam/apps",
  "https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps",
];

const LEGACY_CDN_BASES = [
  "https://cdn.akamai.steamstatic.com/steam/apps",
  "https://cdn.steamstatic.com/steam/apps",
];

function normalizeLanguage(value = "") {
  return String(value || "english").trim().toLowerCase() || "english";
}

function readJsonSafe(filePath = "") {
  try {
    if (!filePath || !fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function resolveProductInfoPath(input = {}) {
  const explicit = String(input.productInfoPath || "").trim();
  if (explicit) return path.resolve(explicit);
  const configPath = String(input.configPath || input.config_path || "").trim();
  if (!configPath) return "";
  return path.join(
    path.resolve(configPath),
    "steam_misc",
    "app_info",
    "app_product_info.json",
  );
}

function pickLocalizedValue(container, language = "english") {
  if (!container) return "";
  if (typeof container === "string") return container.trim();
  if (typeof container !== "object" || Array.isArray(container)) return "";

  const lang = normalizeLanguage(language);
  const languageCandidates = [
    lang,
    lang.replace(/-/g, "_"),
    "english",
    "en",
  ].filter(Boolean);

  for (const key of languageCandidates) {
    const value = container[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }

  for (const value of Object.values(container)) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function addCandidate(candidates, value) {
  const text = String(value || "").trim();
  if (!text) return;
  if (!/\.(?:jpe?g|png|webp)(?:$|\?)/i.test(text)) return;
  candidates.push(text);
}

function collectAssetImageValues(assetNode, language, candidates) {
  if (!assetNode || typeof assetNode !== "object") return;
  addCandidate(candidates, pickLocalizedValue(assetNode.image, language));
  addCandidate(candidates, pickLocalizedValue(assetNode.image2x, language));
}

function collectSteamProductAssetValues(productInfo, purpose, language) {
  const common = productInfo?.common || {};
  const full = common?.library_assets_full || {};
  const flags = common?.library_assets || {};
  const candidates = [];

  if (purpose === "header") {
    collectAssetImageValues(full.library_header, language, candidates);
    addCandidate(candidates, pickLocalizedValue(common.header_image, language));
    if (flags?.library_header) addCandidate(candidates, "library_header.jpg");
    if (common.header_image) addCandidate(candidates, "header.jpg");
    return candidates;
  }

  if (purpose === "portrait") {
    collectAssetImageValues(full.library_capsule, language, candidates);
    if (flags?.library_capsule) {
      addCandidate(candidates, "library_600x900.jpg");
      addCandidate(candidates, "library_capsule.jpg");
    }
    return candidates;
  }

  if (purpose === "hero") {
    collectAssetImageValues(full.library_hero, language, candidates);
    if (flags?.library_hero) addCandidate(candidates, "library_hero.jpg");
    return candidates;
  }

  return candidates;
}

function buildSteamAssetUrls(appid, values = []) {
  const id = String(appid || "").trim();
  if (!/^\d+$/.test(id)) return [];
  const urls = [];
  const seen = new Set();
  const push = (url) => {
    const text = String(url || "").trim();
    if (!text || seen.has(text)) return;
    seen.add(text);
    urls.push(text);
  };

  for (const raw of values) {
    const value = String(raw || "").trim().replace(/^\/+/, "");
    if (!value) continue;
    if (/^https?:\/\//i.test(value)) {
      push(value);
      continue;
    }
    const encodedPath = value
      .split("/")
      .map((part) => encodeURIComponent(part))
      .join("/");
    const hasSubdir = value.includes("/");
    for (const base of STORE_CDN_BASES) {
      push(`${base}/${id}/${encodedPath}`);
    }
    if (!hasSubdir) {
      for (const base of LEGACY_CDN_BASES) {
        push(`${base}/${id}/${encodedPath}`);
      }
    }
  }
  return urls;
}

function resolveSteamProductAssetUrls(input = {}) {
  const appid = String(input.appid || input.steamAppId || "").trim();
  const purpose = String(input.purpose || "portrait").trim().toLowerCase();
  if (!/^\d+$/.test(appid)) {
    return { ok: false, reason: "invalid-appid", urls: [] };
  }
  const productInfoPath = resolveProductInfoPath(input);
  const productInfo = readJsonSafe(productInfoPath);
  if (!productInfo) {
    return { ok: false, reason: "product-info-missing", urls: [] };
  }
  const values = collectSteamProductAssetValues(
    productInfo,
    purpose,
    input.language || "english",
  );
  const urls = buildSteamAssetUrls(appid, values);
  return {
    ok: urls.length > 0,
    reason: urls.length > 0 ? "" : "asset-missing",
    appid,
    purpose,
    productInfoPath,
    urls,
  };
}

module.exports = {
  buildSteamAssetUrls,
  collectSteamProductAssetValues,
  resolveProductInfoPath,
  resolveSteamProductAssetUrls,
};
