const axios = require("axios");

const EGDATA_API_BASE = "https://api.egdata.app";
const POSITIVE_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const NEGATIVE_CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_CACHE_ENTRIES = 512;
const identityCache = new Map();

function cleanId(value) {
  return String(value || "").trim();
}

function normalizePlatform(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry || "").trim()).filter(Boolean);
  }
  const platform = String(value || "").trim();
  return platform ? [platform] : [];
}

function isWindowsAsset(asset) {
  const platforms = normalizePlatform(asset?.platform || asset?.platforms);
  return (
    platforms.length === 0 ||
    platforms.some((platform) => platform.toLowerCase() === "windows")
  );
}

function unwrapPayload(value) {
  if (!value || typeof value !== "object") return null;
  if (value.data && typeof value.data === "object") return value.data;
  if (value.asset && typeof value.asset === "object") return value.asset;
  if (value.item && typeof value.item === "object") return value.item;
  return value;
}

function pickDisplayName(item) {
  const candidates = [
    item?.title,
    item?.displayName,
    item?.name,
    item?.productName,
  ];
  for (const candidate of candidates) {
    const value = String(candidate || "").trim();
    if (value) return value;
  }
  return "";
}

async function requestEgdata(pathname, options = {}) {
  const timeoutMs =
    Number.isFinite(Number(options?.timeoutMs)) && Number(options.timeoutMs) > 0
      ? Number(options.timeoutMs)
      : 15000;
  const client = options?.httpClient || axios;
  return client.get(`${EGDATA_API_BASE}${pathname}`, {
    timeout: timeoutMs,
    responseType: "json",
    validateStatus: (status) => status >= 200 && status < 500,
    headers: {
      Accept: "application/json",
      "User-Agent": "Achievements-App",
    },
  });
}

async function resolveEpicArtifactIdentityUncached(sourceId, options = {}) {
  const id = cleanId(sourceId);
  if (!/^[0-9a-fA-F]+$/.test(id)) return null;

  const assetResponse = await requestEgdata(
    `/assets/${encodeURIComponent(id)}`,
    options,
  );
  if (assetResponse.status === 404) return null;
  if (assetResponse.status >= 400) {
    throw new Error(`EGData asset lookup ${assetResponse.status}`);
  }

  const asset = unwrapPayload(assetResponse.data);
  if (!asset || !isWindowsAsset(asset)) return null;
  const artifactId = cleanId(asset.artifactId || asset.appId || asset.appName);
  const internalAssetId = cleanId(asset._id || asset.id);
  if (
    !artifactId ||
    (artifactId.toLowerCase() !== id.toLowerCase() &&
      internalAssetId.toLowerCase() !== id.toLowerCase())
  ) {
    return null;
  }

  const catalogItemId = cleanId(
    asset.itemId || asset.catalogItemId || asset.catalog_item_id,
  );
  let namespace = cleanId(
    asset.namespace || asset.catalogNamespace || asset.catalog_namespace,
  );
  let item = null;
  let displayName = "";

  if (catalogItemId) {
    try {
      const itemResponse = await requestEgdata(
        `/items/${encodeURIComponent(catalogItemId)}`,
        options,
      );
      if (itemResponse.status >= 200 && itemResponse.status < 300) {
        item = unwrapPayload(itemResponse.data);
        displayName = pickDisplayName(item);
        if (!namespace) {
          namespace = cleanId(
            item?.namespace || item?.catalogNamespace || item?.catalog_namespace,
          );
        }
      }
    } catch {}
  }

  return {
    sourceId: id,
    sourceType: "artifact",
    artifactId,
    catalogItemId,
    namespace,
    platform: "Windows",
    displayName,
  };
}

async function resolveEpicArtifactIdentity(sourceId, options = {}) {
  const id = cleanId(sourceId);
  if (!id) return null;
  if (options?.bypassCache === true || options?.httpClient) {
    return resolveEpicArtifactIdentityUncached(id, options);
  }
  const key = id.toLowerCase();
  const cached = identityCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.promise;
  if (cached) identityCache.delete(key);
  const cacheEntry = {
    expiresAt: Date.now() + NEGATIVE_CACHE_TTL_MS,
    promise: null,
  };
  const pending = resolveEpicArtifactIdentityUncached(id, options).catch(
    (error) => {
      identityCache.delete(key);
      throw error;
    },
  );
  cacheEntry.promise = pending.then((identity) => {
    cacheEntry.expiresAt =
      Date.now() +
      (identity ? POSITIVE_CACHE_TTL_MS : NEGATIVE_CACHE_TTL_MS);
    return identity;
  });
  identityCache.set(key, cacheEntry);
  while (identityCache.size > MAX_CACHE_ENTRIES) {
    const oldestKey = identityCache.keys().next().value;
    if (!oldestKey) break;
    identityCache.delete(oldestKey);
  }
  return cacheEntry.promise;
}

function clearEpicIdentityCache() {
  identityCache.clear();
}

module.exports = {
  EGDATA_API_BASE,
  resolveEpicArtifactIdentity,
  clearEpicIdentityCache,
};
