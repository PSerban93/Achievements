const axios = require("axios");
const {
  epicGraphQL,
  fetchEpicAchievementSchemaBySandbox,
  fetchEpicPublicProductAchievements,
} = require("./epic-api");
const { createLogger } = require("./logger");

const logger = createLogger("autoconfig");
const EGDATA_BASE = "https://api.egdata.app";
const PRODUCT_MAP_URL =
  "https://store-content.ak.epicgames.com/api/content/productmapping/";
const POSITIVE_TTL_MS = 6 * 60 * 60 * 1000;
const NEGATIVE_TTL_MS = 5 * 60 * 1000;
const cache = new Map();
let productMapCache = null;

function clean(value) {
  return String(value || "").trim();
}

function unwrap(value) {
  if (!value || typeof value !== "object") return null;
  return value.data || value.asset || value.item || value;
}

function isWindowsAsset(asset) {
  const platforms = asset?.platform || asset?.platforms || [];
  const values = Array.isArray(platforms) ? platforms : [platforms];
  return (
    values.length === 0 ||
    values.every((value) => !clean(value)) ||
    values.some((value) => clean(value).toLowerCase() === "windows")
  );
}

function isPlayableItem(item) {
  const categories = Array.isArray(item?.categories) ? item.categories : [];
  if (!categories.length) return true;
  const names = categories.map((entry) =>
    clean(entry?.path || entry).toLowerCase(),
  );
  return names.includes("applications") || names.includes("addons/launchable");
}

function isApplicationItem(item) {
  return Array.isArray(item?.categories) && item.categories.some(
    (entry) => clean(entry?.path || entry).toLowerCase() === "applications",
  );
}

function isGenericSandboxName(value) {
  return ["live", "dev", "stage", "staging", "test", "production"].includes(
    clean(value).toLowerCase(),
  );
}

async function getEgdata(kind, id, strict = false) {
  const response = await axios.get(
    `${EGDATA_BASE}/${kind}/${encodeURIComponent(id)}`,
    {
      timeout: 15000,
      responseType: "json",
      validateStatus: (status) => status >= 200 && status < 500,
      headers: { Accept: "application/json", "User-Agent": "Achievements-App" },
    },
  );
  if (response.status === 404) return null;
  if (response.status >= 400) {
    throw new Error(`EGData ${kind} lookup ${response.status}`);
  }
  const value = unwrap(response.data);
  if (strict && (!value || Array.isArray(value) || !Object.keys(value).length)) {
    throw new Error(`EGData ${kind} lookup returned an incomplete response`);
  }
  return value;
}

async function getProductSandboxes(productId, strict = false) {
  const query = `
    query Product($productId: String!) {
      Product {
        productSandboxes(productId: $productId) {
          id
          productId
          defaultPublic
        }
      }
    }
  `;
  let response;
  try {
    response = await epicGraphQL(query, { productId });
  } catch (error) {
    // A successful GraphQL request can contain a product-service 404. Only
    // its explicit product_not_found code confirms absence; transport errors
    // or failures in another field must remain technical errors.
    const errors = error?.response?.errors;
    const productNotFound = strict && Number(error?.status) === 200 &&
      Array.isArray(errors) && errors.length > 0 && errors.every((entry) => {
        if (Number(entry?.status) !== 404 || !Array.isArray(entry?.path) ||
            entry.path.length !== 2 || entry.path[0] !== "Product" ||
            entry.path[1] !== "productSandboxes") return false;
        try {
          const service = typeof entry.serviceResponse === "string"
            ? JSON.parse(entry.serviceResponse) : entry.serviceResponse;
          return service?.errorCode === "errors.com.epicgames.ecommerce.product.product_not_found";
        } catch {
          return false;
        }
      });
    if (!productNotFound) throw error;
    logger.info("epic-identity:product-not-found", { productId, source: "product-query" });
    return [];
  }
  const product = response?.data?.Product;
  if (strict && ((Object.hasOwn(response?.data || {}, "Product") && product === null) ||
      (product && Object.hasOwn(product, "productSandboxes") && product.productSandboxes === null))) {
    return [];
  }
  if (strict && !Array.isArray(response?.data?.Product?.productSandboxes)) {
    throw new Error("Epic product lookup returned an incomplete sandbox list");
  }
  return (response?.data?.Product?.productSandboxes || []).filter(
    (entry) =>
      clean(entry?.id) &&
      (!clean(entry?.productId) ||
        clean(entry.productId).toLowerCase() === productId.toLowerCase()),
  );
}

async function getProductMap() {
  if (productMapCache && productMapCache.expiresAt > Date.now()) {
    return productMapCache.value;
  }
  try {
    const response = await axios.get(PRODUCT_MAP_URL, { timeout: 20000 });
    if (response.data && typeof response.data === "object") {
      productMapCache = {
        value: response.data,
        expiresAt: Date.now() + POSITIVE_TTL_MS,
      };
      return response.data;
    }
  } catch (error) {
    logger.warn("epic-identity:product-map-failed", {
      error: error?.message || String(error),
    });
  }
  productMapCache = { value: {}, expiresAt: Date.now() + NEGATIVE_TTL_MS };
  return {};
}

function itemSlug(item) {
  const direct = [item?.productSlug, item?.urlSlug, item?.slug];
  const attributes = Array.isArray(item?.customAttributes)
    ? item.customAttributes
    : [];
  for (const attribute of attributes) {
    if (
      ["com.epicgames.app.productSlug", "com.epicgames.app.slug", "productSlug", "urlSlug"].includes(
        clean(attribute?.key),
      )
    ) {
      direct.push(attribute?.value);
    }
  }
  for (const value of direct) {
    const slug = clean(value).replace(/^https?:\/\/[^/]+\/p\//i, "").replace(/^\/+|\/+$/g, "");
    if (slug && !slug.includes("/") && !slug.includes("?")) return slug;
  }
  return "";
}

function itemImages(item, types) {
  const images = Array.isArray(item?.keyImages) ? item.keyImages : [];
  const urls = [];
  for (const type of types) {
    const matches = images.filter(
      (entry) => clean(entry?.type).toLowerCase() === type.toLowerCase(),
    );
    for (const match of matches) {
      const url = clean(match?.url);
      if (url && !urls.includes(url)) urls.push(url);
    }
  }
  return urls;
}

async function getStoreContent(slug) {
  if (!slug) return null;
  const response = await axios.get(
    `https://store-content.ak.epicgames.com/api/en-US/content/products/${encodeURIComponent(slug)}`,
    {
      timeout: 15000,
      responseType: "json",
      validateStatus: (status) => status >= 200 && status < 500,
    },
  );
  if (response.status >= 400) return null;
  return response.data && typeof response.data === "object"
    ? response.data
    : null;
}

function storeHero(data) {
  if (data?.hero) return data.hero;
  return Array.isArray(data?.pages)
    ? data.pages
        .map((page) => page?.data?.hero || page?.hero)
        .find(
          (hero) =>
            hero &&
            (hero.portraitBackgroundImageUrl || hero.backgroundImageUrl),
        ) || null
    : null;
}

function comparableTitle(value) {
  return clean(value).normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

async function findAssetForSandbox(namespace, expectedTitle) {
  const response = await axios.get(
    `${EGDATA_BASE}/sandboxes/${encodeURIComponent(namespace)}/builds`,
    {
      timeout: 15000,
      responseType: "json",
      validateStatus: (status) => status >= 200 && status < 500,
      headers: { Accept: "application/json", "User-Agent": "Achievements-App" },
    },
  );
  if (response.status >= 400) return null;
  const builds = Array.isArray(response.data?.elements)
    ? response.data.elements
    : [];
  const appNames = Array.from(
    new Set(
      builds
        .filter((build) => clean(build?.platform).toLowerCase() === "windows")
        .map((build) => clean(build?.appName))
        .filter(Boolean),
    ),
  ).slice(0, 8);
  const assets = await Promise.allSettled(
    appNames.map((appName) => getEgdata("assets", appName)),
  );
  const matches = assets
    .filter((result) => result.status === "fulfilled")
    .map((result) => result.value)
    .filter(
      (asset) =>
        asset &&
        isWindowsAsset(asset) &&
        clean(asset.namespace).toLowerCase() === namespace.toLowerCase() &&
        clean(asset.itemId || asset.catalogItemId),
    );
  const unique = Array.from(
    new Map(matches.map((candidate) => [
      clean(candidate.itemId || candidate.catalogItemId).toLowerCase(),
      candidate,
    ])).values(),
  );
  if (unique.length === 1) return unique[0];
  const items = await Promise.allSettled(
    unique.map((candidate) =>
      getEgdata("items", clean(candidate.itemId || candidate.catalogItemId)),
    ),
  );
  const expected = comparableTitle(expectedTitle);
  const matching = unique.filter((candidate, index) => {
    const result = items[index];
    const item = result?.status === "fulfilled" ? result.value : null;
    return item && isPlayableItem(item) &&
      clean(item.namespace).toLowerCase() === namespace.toLowerCase() &&
      expected && comparableTitle(item.title) === expected;
  });
  return matching.length === 1 ? matching[0] : null;
}

async function getSandboxEntries(namespace, kind) {
  const entries = [];
  const limit = 100;
  for (let page = 1; page <= 5; page += 1) {
    const response = await axios.get(
      `${EGDATA_BASE}/sandboxes/${encodeURIComponent(namespace)}/${kind}`,
      {
        params: { page, limit },
        timeout: 15000,
        responseType: "json",
        validateStatus: (status) => status >= 200 && status < 500,
        headers: { Accept: "application/json", "User-Agent": "Achievements-App" },
      },
    );
    if (response.status >= 400) return [];
    const batch = response.data?.elements;
    if (!Array.isArray(batch)) return [];
    entries.push(...batch);
    const count = Number(response.data?.count);
    if (batch.length === 0 || (Number.isFinite(count) && entries.length >= count)) {
      return entries;
    }
    if (!Number.isFinite(count) && batch.length < limit) return entries;
  }
  return [];
}

async function findCatalogItemForSandbox(namespace) {
  const items = await getSandboxEntries(namespace, "items");
  const playable = items.filter((entry) =>
    clean(entry?.id) &&
    clean(entry?.namespace).toLowerCase() === namespace.toLowerCase() &&
    clean(entry?.title) &&
    isPlayableItem(entry),
  );
  const applications = playable.filter(isApplicationItem);
  const candidates = applications.length ? applications : playable;
  if (candidates.length === 1) return candidates[0];
  if (candidates.length < 2) return null;

  const offers = await getSandboxEntries(namespace, "offers");
  const baseTitles = new Set(offers
    .filter((offer) =>
      clean(offer?.namespace).toLowerCase() === namespace.toLowerCase() &&
      (clean(offer?.offerType).toUpperCase() === "BASE_GAME" ||
        offer?.categories?.includes("games/edition/base")),
    )
    .map((offer) => comparableTitle(offer?.title))
    .filter(Boolean));
  const matching = candidates.filter((entry) =>
    baseTitles.has(comparableTitle(entry.title)),
  );
  return matching.length === 1 ? matching[0] : null;
}

async function findAssetForCatalogItem(item, namespace) {
  const itemId = clean(item?.id);
  if (!itemId) return null;
  const response = await axios.get(
    `${EGDATA_BASE}/items/${encodeURIComponent(itemId)}/assets`,
    {
      timeout: 15000,
      responseType: "json",
      validateStatus: (status) => status >= 200 && status < 500,
      headers: { Accept: "application/json", "User-Agent": "Achievements-App" },
    },
  );
  if (response.status >= 400 || !Array.isArray(response.data)) return null;
  const assets = response.data.filter((asset) =>
    isWindowsAsset(asset) &&
    clean(asset?.namespace).toLowerCase() === namespace.toLowerCase() &&
    clean(asset?.itemId || asset?.catalogItemId).toLowerCase() === itemId.toLowerCase() &&
    clean(asset?.artifactId || asset?.appId || asset?.appName),
  );
  const unique = new Map(assets.map((asset) => [
    clean(asset.artifactId || asset.appId || asset.appName).toLowerCase(),
    asset,
  ]));
  return unique.size === 1 ? unique.values().next().value : null;
}

async function resolveUncached(sourceId, diagnostics = null) {
  const probes = await Promise.allSettled([
    getProductSandboxes(sourceId, !!diagnostics),
    getEgdata("sandboxes", sourceId, !!diagnostics),
    getEgdata("items", sourceId, !!diagnostics),
    getEgdata("assets", sourceId, !!diagnostics),
  ]);
  const values = probes.map((result) =>
    result.status === "fulfilled" ? result.value : null,
  );
  if (diagnostics) {
    for (const result of probes) {
      if (result.status === "rejected") diagnostics.errors.push(String(result.reason?.message || result.reason));
    }
  }
  const [sandboxes, sandbox, directItem, directAsset] = values;
  const item =
    directItem && clean(directItem.id || directItem._id).toLowerCase() === sourceId.toLowerCase()
      ? directItem
      : null;
  const assetId = clean(
    directAsset?.artifactId || directAsset?.appId || directAsset?.appName,
  );
  const asset =
    directAsset &&
    isWindowsAsset(directAsset) &&
    (assetId.toLowerCase() === sourceId.toLowerCase() ||
      clean(directAsset._id || directAsset.id).toLowerCase() === sourceId.toLowerCase())
      ? directAsset
      : null;
  const candidates = new Set();
  if (sandbox && clean(sandbox.namespaceType)) candidates.add(sourceId);
  if (item && isPlayableItem(item) && clean(item.namespace)) {
    candidates.add(clean(item.namespace));
  }
  if (asset && clean(asset.namespace)) candidates.add(clean(asset.namespace));
  for (const entry of Array.isArray(sandboxes) ? sandboxes : []) {
    if (entry?.id) candidates.add(clean(entry.id));
  }
  if (!candidates.size) return null;

  let namespace = "";
  if (diagnostics) {
    const directNamespaces = new Set([
      sandbox && clean(sandbox.namespaceType) ? sourceId : "",
      item && isPlayableItem(item) ? clean(item.namespace) : "",
      asset ? clean(asset.namespace) : "",
    ].filter(Boolean));
    const publicSandboxes = (Array.isArray(sandboxes) ? sandboxes : [])
      .filter((entry) => entry.defaultPublic === true);
    if (directNamespaces.size === 1) namespace = [...directNamespaces][0];
    else if (!directNamespaces.size && publicSandboxes.length === 1) namespace = clean(publicSandboxes[0].id);
  }
  if (!namespace && candidates.size === 1) {
    namespace = Array.from(candidates)[0];
  } else if (!namespace) {
    const matches = [];
    for (const candidate of candidates) {
      try {
        const result = await fetchEpicPublicProductAchievements(candidate, {
          locale: "en-US",
        });
        if (
          result.achievements.length &&
          (!Array.isArray(sandboxes) || !sandboxes.length ||
            clean(result.productId).toLowerCase() === sourceId.toLowerCase())
        ) {
          matches.push(candidate);
        }
      } catch {}
    }
    if (matches.length !== 1) {
      if (diagnostics) diagnostics.ambiguous = true;
      return null;
    }
    namespace = matches[0];
  }

  const productMatch = (Array.isArray(sandboxes) ? sandboxes : []).find(
    (entry) => clean(entry?.id).toLowerCase() === namespace.toLowerCase(),
  );
  let productId = productMatch ? sourceId : "";
  if (!productId) {
    try {
      const result = await fetchEpicPublicProductAchievements(namespace, {
        locale: "en-US",
      });
      if (result.achievements.length) productId = clean(result.productId);
    } catch {
      try {
        const result = await fetchEpicAchievementSchemaBySandbox(namespace, {
          locale: "en-US",
        });
        if (result.achievements.length) productId = clean(result.productId);
      } catch {}
    }
  }

  let sandboxDetails = sandbox;
  if (!sandboxDetails) {
    try {
      sandboxDetails = await getEgdata("sandboxes", namespace);
    } catch {}
  }
  let resolvedAsset = asset;
  if (!resolvedAsset) {
    try {
      resolvedAsset = await findAssetForSandbox(
        namespace,
        item?.title || sandboxDetails?.displayName,
      );
    } catch {}
  }
  let catalogItem = item;
  if (!catalogItem && !resolvedAsset) {
    try {
      catalogItem = await findCatalogItemForSandbox(namespace);
    } catch (error) {
      logger.warn("epic-identity:sandbox-items-failed", {
        namespace,
        error: error?.message || String(error),
      });
    }
  }
  if (catalogItem && !resolvedAsset) {
    try {
      resolvedAsset = await findAssetForCatalogItem(catalogItem, namespace);
    } catch {}
  }
  const appName = clean(
    resolvedAsset?.artifactId || resolvedAsset?.appId || resolvedAsset?.appName,
  );
  const catalogItemId = clean(
    catalogItem?.id || resolvedAsset?.itemId || resolvedAsset?.catalogItemId,
  );
  if (!catalogItem && catalogItemId) {
    try {
      catalogItem = await getEgdata("items", catalogItemId);
    } catch {}
  }
  if (
    catalogItem &&
    (clean(catalogItem.namespace).toLowerCase() !== namespace.toLowerCase() ||
      !isPlayableItem(catalogItem))
  ) {
    catalogItem = null;
  }

  let storeSlug = "";
  try {
    const map = await getProductMap();
    for (const id of [sourceId, namespace, catalogItemId, appName, productId]) {
      if (!id) continue;
      storeSlug = clean(map[id] || map[id.toLowerCase()]);
      if (storeSlug) break;
    }
  } catch {}
  if (!storeSlug) storeSlug = itemSlug(catalogItem);
  let store = null;
  try {
    store = await getStoreContent(storeSlug);
  } catch {}
  const hero = storeHero(store);
  const title = clean(
    (typeof store?.productName === "string"
      ? store.productName
      : store?.productName?.value) ||
      catalogItem?.title ||
      resolvedAsset?.displayName ||
      (isGenericSandboxName(sandboxDetails?.displayName)
        ? ""
        : sandboxDetails?.displayName),
  );
  if (!title) {
    if (diagnostics) diagnostics.ambiguous = true;
    return null;
  }
  const portraitUrls = [
    clean(hero?.portraitBackgroundImageUrl),
    ...itemImages(catalogItem, ["DieselGameBoxTall", "OfferImageTall"]),
  ].filter((url, index, urls) => url && urls.indexOf(url) === index);
  const headerUrls = [
    clean(hero?.backgroundImageUrl),
    ...itemImages(catalogItem, [
      "DieselGameBoxWide",
      "DieselGameBox",
      "OfferImageWide",
    ]),
  ].filter((url, index, urls) => url && urls.indexOf(url) === index);
  return {
    sourceId,
    namespace,
    productId,
    catalogItemId: catalogItem ? catalogItemId : "",
    appName,
    title,
    storeSlug,
    portraitUrl: portraitUrls[0] || "",
    headerUrl: headerUrls[0] || "",
    portraitUrls,
    headerUrls,
  };
}

async function resolveEpicGameIdentity(sourceId, options = {}) {
  const id = clean(sourceId);
  if (!/^[0-9a-fA-F]+$/.test(id)) return null;
  const key = id.toLowerCase();
  if (options.bypassCache !== true) {
    const existing = cache.get(key);
    if (existing && existing.expiresAt > Date.now()) return existing.promise;
  }
  const promise = resolveUncached(id).catch((error) => {
    logger.warn("epic-identity:resolve-failed", {
      appid: id,
      error: error?.message || String(error),
    });
    return null;
  });
  const entry = { promise, expiresAt: Date.now() + NEGATIVE_TTL_MS };
  cache.set(key, entry);
  promise.then((identity) => {
    entry.expiresAt = Date.now() + (identity ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS);
    if (identity) {
      logger.info("epic-identity:resolved", {
        appid: id,
        namespace: identity.namespace,
        productId: identity.productId || null,
        catalogItemId: identity.catalogItemId || null,
        appName: identity.appName || null,
        storeSlug: identity.storeSlug || null,
      });
    }
  });
  while (cache.size > 512) cache.delete(cache.keys().next().value);
  return promise;
}

// Discovery callers need to distinguish an absent identity from failed probes.
// Keep the existing nullable API and its cache unchanged for other consumers.
async function resolveEpicGameIdentityDetailed(sourceId) {
  const id = clean(sourceId);
  if (!/^[0-9a-fA-F]{32}$/.test(id)) return { status: "not-applicable", identity: null };
  const diagnostics = { errors: [], ambiguous: false };
  try {
    const identity = await resolveUncached(id, diagnostics);
    return {
      status: identity ? "identified" : diagnostics.errors.length ? "technical-error"
        : diagnostics.ambiguous ? "ambiguous" : "not-found",
      identity,
      ...diagnostics,
    };
  } catch (error) {
    return { status: "technical-error", identity: null, errors: [String(error.message || error)] };
  }
}

async function resolveEpicCatalogImageUrls(sourceId, options = {}) {
  const knownItemId = clean(options.catalogItemId);
  const knownNamespace = clean(options.namespace);
  let identity = knownItemId ? null : await resolveEpicGameIdentity(sourceId);
  if (!knownItemId && !identity && knownNamespace && knownNamespace !== sourceId) {
    identity = await resolveEpicGameIdentity(knownNamespace);
  }
  const itemId = knownItemId || clean(identity?.catalogItemId);
  const namespace = clean(knownNamespace || identity?.namespace);
  const empty = { portraitUrls: [], headerUrls: [] };
  if (!itemId) return empty;

  let item;
  try {
    item = await getEgdata("items", itemId);
  } catch (error) {
    logger.warn("epic-identity:catalog-images-failed", {
      catalogItemId: itemId,
      error: error?.message || String(error),
    });
    return empty;
  }
  if (
    !item ||
    clean(item.id || item._id).toLowerCase() !== itemId.toLowerCase() ||
    (namespace && clean(item.namespace).toLowerCase() !== namespace.toLowerCase()) ||
    !isPlayableItem(item)
  ) {
    return empty;
  }
  return {
    portraitUrls: itemImages(item, ["DieselGameBoxTall", "OfferImageTall"]),
    headerUrls: itemImages(item, [
      "DieselGameBoxWide",
      "DieselGameBox",
      "OfferImageWide",
    ]),
  };
}

module.exports = { resolveEpicGameIdentity, resolveEpicGameIdentityDetailed, resolveEpicCatalogImageUrls };
