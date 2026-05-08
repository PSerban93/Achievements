const axios = require("axios");
const { normalizeEpicAccountId } = require("./epic-auth");
const { createLogger } = require("./logger");

const epicApiLogger = createLogger("epic-official");

const EPIC_GRAPHQL_URL = "https://launcher.store.epicgames.com/graphql";
const EPIC_PUBLIC_ACHIEVEMENTS_BASE =
  "https://api.epicgames.dev/epic/achievements/v1/public/achievements";
const EPIC_LIBRARY_ASSETS_URL =
  "https://library-service.live.use1a.on.epicgames.com/library/api/public/items";
const EPIC_ECOM_ENTITLEMENTS_BASE =
  "https://api.epicgames.dev/epic/ecom/v4/identities";
const EPIC_CATALOG_BASE_URL =
  "https://catalog-public-service-prod06.ol.epicgames.com/catalog/api/shared/namespace";

function normalizeRows(value) {
  return Array.isArray(value) ? value : [];
}

function getEpicAuthHeader(options = {}) {
  const accessToken = String(options?.accessToken || "").trim();
  const tokenType = String(options?.tokenType || "bearer").trim() || "bearer";
  return accessToken ? { Authorization: `${tokenType} ${accessToken}` } : {};
}

function normalizeEpicRecords(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.records)) return value.records;
  if (Array.isArray(value?.Records)) return value.Records;
  if (Array.isArray(value?.items)) return value.items;
  if (Array.isArray(value?.Items)) return value.Items;
  if (Array.isArray(value?.elements)) return value.elements;
  if (Array.isArray(value?.Elements)) return value.Elements;
  if (value && typeof value === "object") return Object.values(value);
  return [];
}

async function epicGraphQL(query, variables = {}, options = {}) {
  const timeoutMs =
    Number.isFinite(options?.timeoutMs) && options.timeoutMs > 0
      ? Number(options.timeoutMs)
      : 15000;
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json",
    "User-Agent": "EpicGamesLauncher",
    ...getEpicAuthHeader(options),
  };
  const res = await axios.post(
    EPIC_GRAPHQL_URL,
    { query, variables },
    {
      timeout: timeoutMs,
      headers,
      responseType: "json",
      validateStatus: (status) => status >= 200 && status < 500,
    },
  );
  if (res.status >= 400) {
    throw new Error(`Epic GraphQL ${res.status}`);
  }
  if (Array.isArray(res?.data?.errors) && res.data.errors.length) {
    const message = res.data.errors
      .map((err) => err?.message)
      .filter(Boolean)
      .join("; ");
    throw new Error(message || "Epic GraphQL error");
  }
  return res.data || {};
}

async function fetchEpicLibraryAssets(options = {}) {
  const timeoutMs =
    Number.isFinite(options?.timeoutMs) && options.timeoutMs > 0
      ? Number(options.timeoutMs)
      : 15000;
  const pageSize =
    Number.isFinite(options?.pageSize) && options.pageSize > 0
      ? Math.max(1, Math.min(1000, Number(options.pageSize)))
      : 1000;
  const allPages = options?.allPages !== false;
  const maxPages =
    Number.isFinite(options?.maxPages) && options.maxPages > 0
      ? Math.max(1, Number(options.maxPages))
      : 100;
  const assets = [];
  const pages = [];
  let nextCursor = String(options?.cursor || "").trim();
  let page = 0;

  do {
    const result = await fetchEpicLibraryAssetsPage({
      ...options,
      timeoutMs,
      cursor: nextCursor,
      limit: pageSize,
    });
    assets.push(...normalizeEpicRecords(result?.assets));
    pages.push(result?.raw || {});
    nextCursor = String(
      result?.nextCursor ||
        result?.raw?.responseMetadata?.nextCursor ||
        result?.raw?.nextCursor ||
        "",
    ).trim();
    page += 1;
    if (!allPages || !nextCursor || page >= maxPages) break;
  } while (true);

  epicApiLogger.info("epic-official:library-assets:complete", {
    platform: String(options?.platform || "").trim() || "all",
    total: assets.length,
    pageCount: pages.length,
    nextCursor: nextCursor || null,
    pageSize,
  });

  return {
    assets,
    raw: pages.length === 1 ? pages[0] || {} : { pages },
    nextCursor,
    pageCount: pages.length,
  };
}

async function fetchEpicLibraryAssetsPage(options = {}) {
  const timeoutMs =
    Number.isFinite(options?.timeoutMs) && options.timeoutMs > 0
      ? Number(options.timeoutMs)
      : 15000;
  const res = await axios.get(EPIC_LIBRARY_ASSETS_URL, {
    timeout: timeoutMs,
    responseType: "json",
    validateStatus: (status) => status >= 200 && status < 500,
    headers: {
      Accept: "application/json",
      "User-Agent": "EpicGamesLauncher",
      ...getEpicAuthHeader(options),
    },
    params: {
      includeMetadata: options?.includeMetadata !== false,
      ...(String(options?.cursor || "").trim()
        ? { cursor: String(options.cursor).trim() }
        : {}),
      ...(Number.isFinite(options?.limit) && Number(options.limit) > 0
        ? { limit: Number(options.limit) }
        : {}),
      ...(String(options?.platform || "").trim()
        ? { platform: String(options.platform).trim() }
        : {}),
    },
  });
  if (res.status >= 400) {
    throw new Error(`Epic library assets ${res.status}`);
  }
  const payload = res?.data || {};
  const nextCursor = String(
    payload?.responseMetadata?.nextCursor || payload?.nextCursor || "",
  ).trim();
  epicApiLogger.info("epic-official:library-assets:page", {
    platform: String(options?.platform || "").trim() || "all",
    cursor: String(options?.cursor || "").trim() || null,
    limit:
      Number.isFinite(options?.limit) && Number(options.limit) > 0
        ? Number(options.limit)
        : null,
    count: normalizeEpicRecords(payload).length,
    nextCursor: nextCursor || null,
  });
  return {
    assets: normalizeEpicRecords(payload),
    nextCursor,
    raw: payload,
  };
}

async function fetchEpicOwnedGames(options = {}) {
  const timeoutMs =
    Number.isFinite(options?.timeoutMs) && options.timeoutMs > 0
      ? Number(options.timeoutMs)
      : 15000;
  const accountId = normalizeEpicAccountId(options?.accountId);
  if (!accountId) throw new Error("accountId-required");
  const url = `https://www.epicgames.com/account/v2/accounts/${encodeURIComponent(accountId)}/ownedGames`;
  const res = await axios.get(url, {
    timeout: timeoutMs,
    responseType: "json",
    validateStatus: (status) => status >= 200 && status < 500,
    headers: {
      Accept: "application/json",
      "User-Agent": "EpicGamesLauncher",
      ...getEpicAuthHeader(options),
    },
  });
  if (res.status >= 400) {
    throw new Error(`Epic owned games ${res.status}`);
  }
  const payload = res?.data || {};
  epicApiLogger.info("epic-official:owned-games:result", {
    accountId,
    count: normalizeRows(payload?.ownedGames || payload).length,
  });
  return {
    games: normalizeRows(payload?.ownedGames || payload),
    raw: payload,
  };
}

async function fetchEpicEntitlementsPage(options = {}) {
  const timeoutMs =
    Number.isFinite(options?.timeoutMs) && options.timeoutMs > 0
      ? Number(options.timeoutMs)
      : 15000;
  const accountId = normalizeEpicAccountId(
    options?.accountId || options?.identityId,
  );
  if (!accountId) throw new Error("accountId-required");
  const start =
    Number.isFinite(options?.start) && options.start >= 0
      ? Number(options.start)
      : 0;
  const count =
    Number.isFinite(options?.count) && options.count > 0
      ? Math.max(1, Math.min(1000, Number(options.count)))
      : 1000;
  const res = await axios.get(
    `${EPIC_ECOM_ENTITLEMENTS_BASE}/${encodeURIComponent(
      accountId,
    )}/entitlements`,
    {
      timeout: timeoutMs,
      responseType: "json",
      validateStatus: (status) => status >= 200 && status < 500,
      headers: {
        Accept: "application/json",
        "User-Agent": "EpicGamesLauncher",
        ...getEpicAuthHeader(options),
      },
      params: {
        start,
        count,
        ...(String(options?.sandboxId || "").trim()
          ? { sandboxId: String(options.sandboxId).trim() }
          : {}),
        ...(String(options?.entitlementName || "").trim()
          ? { entitlementName: String(options.entitlementName).trim() }
          : {}),
      },
    },
  );
  if (res.status >= 400) {
    throw new Error(`Epic entitlements ${res.status}`);
  }
  const payload = res?.data || {};
  const entitlements = normalizeRows(
    payload?.entitlements ||
      payload?.records ||
      payload?.items ||
      payload?.elements ||
      payload,
  );
  let nextStart = null;
  if (Number.isFinite(Number(payload?.paging?.next))) {
    nextStart = Number(payload.paging.next);
  } else if (
    Number.isFinite(Number(payload?.paging?.start)) &&
    Number.isFinite(Number(payload?.paging?.count)) &&
    Number.isFinite(Number(payload?.paging?.total))
  ) {
    const pagingStart = Number(payload.paging.start);
    const pagingCount = Number(payload.paging.count);
    const pagingTotal = Number(payload.paging.total);
    if (pagingStart + pagingCount < pagingTotal) {
      nextStart = pagingStart + pagingCount;
    }
  } else if (Number.isFinite(Number(payload?.next))) {
    nextStart = Number(payload.next);
  } else if (entitlements.length === count) {
    nextStart = start + entitlements.length;
  }
  epicApiLogger.info("epic-official:entitlements:page", {
    accountId,
    start,
    count,
    returned: entitlements.length,
    nextStart,
    sandboxId: String(options?.sandboxId || "").trim() || null,
  });
  return {
    entitlements,
    raw: payload,
    nextStart,
  };
}

async function fetchEpicEntitlements(options = {}) {
  const timeoutMs =
    Number.isFinite(options?.timeoutMs) && options.timeoutMs > 0
      ? Number(options.timeoutMs)
      : 15000;
  const pageSize =
    Number.isFinite(options?.pageSize) && options.pageSize > 0
      ? Math.max(1, Math.min(1000, Number(options.pageSize)))
      : 1000;
  const maxPages =
    Number.isFinite(options?.maxPages) && options.maxPages > 0
      ? Math.max(1, Number(options.maxPages))
      : 100;
  const entitlements = [];
  const pages = [];
  let start =
    Number.isFinite(options?.start) && options.start >= 0
      ? Number(options.start)
      : 0;
  for (let page = 0; page < maxPages; page += 1) {
    const result = await fetchEpicEntitlementsPage({
      ...options,
      timeoutMs,
      start,
      count: pageSize,
    });
    entitlements.push(...normalizeRows(result?.entitlements));
    pages.push(result?.raw || {});
    if (
      result?.nextStart == null ||
      !Number.isFinite(Number(result.nextStart)) ||
      Number(result.nextStart) <= start
    ) {
      break;
    }
    start = Number(result.nextStart);
  }
  epicApiLogger.info("epic-official:entitlements:complete", {
    accountId: normalizeEpicAccountId(options?.accountId || options?.identityId),
    total: entitlements.length,
    pageCount: pages.length,
    pageSize,
  });
  return {
    entitlements,
    raw: pages.length === 1 ? pages[0] || {} : { pages },
    pageCount: pages.length,
  };
}

async function fetchEpicCatalogItem(namespace, catalogItemId, options = {}) {
  const safeNamespace = String(namespace || "").trim();
  const safeCatalogItemId = String(catalogItemId || "").trim();
  if (!safeNamespace) throw new Error("namespace-required");
  if (!safeCatalogItemId) throw new Error("catalogItemId-required");
  const timeoutMs =
    Number.isFinite(options?.timeoutMs) && options.timeoutMs > 0
      ? Number(options.timeoutMs)
      : 15000;
  const url = `${EPIC_CATALOG_BASE_URL}/${encodeURIComponent(
    safeNamespace,
  )}/bulk/items`;
  const res = await axios.get(url, {
    timeout: timeoutMs,
    responseType: "json",
    validateStatus: (status) => status >= 200 && status < 500,
    params: {
      id: safeCatalogItemId,
      country: options?.country || "US",
      locale: options?.locale || "en-US",
      includeMainGameDetails: true,
    },
    headers: {
      Accept: "application/json",
      "User-Agent": "EpicGamesLauncher",
      ...getEpicAuthHeader(options),
    },
  });
  if (res.status >= 400) {
    throw new Error(`Epic catalog item ${res.status}`);
  }
  const raw = res?.data || {};
  const items = raw?.elements || raw?.items || raw?.data || raw;
  const item = Array.isArray(items)
    ? items.find(
        (entry) =>
          String(entry?.id || entry?.catalogItemId || "").trim() ===
          safeCatalogItemId,
      ) ||
      items[0] ||
      null
    : items?.[safeCatalogItemId] || items || null;
  return { item, raw };
}

async function fetchEpicPublicProductAchievements(productId, options = {}) {
  const safeProductId = String(productId || "").trim();
  if (!safeProductId) throw new Error("productId-required");
  const timeoutMs =
    Number.isFinite(options?.timeoutMs) && options.timeoutMs > 0
      ? Number(options.timeoutMs)
      : 15000;
  const locale = String(options?.locale || "en").trim() || "en";
  const url = `${EPIC_PUBLIC_ACHIEVEMENTS_BASE}/product/${encodeURIComponent(
    safeProductId,
  )}/locale/${encodeURIComponent(locale)}?includeAchievements=true`;
  const res = await axios.get(url, {
    timeout: timeoutMs,
    responseType: "json",
    validateStatus: (status) => status >= 200 && status < 500,
    headers: { Accept: "application/json" },
  });
  if (res.status >= 400) {
    throw new Error(`Epic public achievements ${res.status}`);
  }
  const achievements = normalizeRows(res?.data?.achievements);
  let actualProductId = safeProductId;
  if (Array.isArray(achievements) && achievements.length > 0) {
    for (const entry of achievements) {
      const achievement = entry?.achievement || entry || {};
      const candidate = String(
        achievement?.productId || achievement?.product_id || "",
      ).trim();
      if (candidate) {
        actualProductId = candidate;
        break;
      }
    }
  }
  if (!actualProductId && typeof res?.data?.productId === "string") {
    actualProductId = String(res.data.productId).trim() || actualProductId;
  }
  return {
    productId: actualProductId,
    achievements,
    raw: res?.data || {},
  };
}

async function fetchEpicAchievementSchemaBySandbox(sandboxId, options = {}) {
  const safeSandboxId = String(sandboxId || "").trim();
  if (!safeSandboxId) throw new Error("sandboxId-required");
  const locale = String(options?.locale || "en-US").trim() || "en-US";
  const query = `
    query Achievement($SandboxId: String!, $Locale: String!) {
      Achievement {
        productAchievementsRecordBySandbox(
          sandboxId: $SandboxId,
          locale: $Locale
        ) {
          productId
          sandboxId
          totalAchievements
          totalProductXP
          achievements {
            achievement {
              name
              unlockedDisplayName
              unlockedDescription
              unlockedIconLink
              lockedIconLink
              XP
              hidden
              rarity {
                percent
              }
            }
          }
        }
      }
    }
  `;
  const payload = await epicGraphQL(
    query,
    { SandboxId: safeSandboxId, Locale: locale },
    options,
  );
  const record =
    payload?.data?.Achievement?.productAchievementsRecordBySandbox ||
    payload?.Achievement?.productAchievementsRecordBySandbox ||
    null;
  if (!record) throw new Error("epic-achievements-schema-missing");
  return {
    productId: String(record?.productId || "").trim(),
    sandboxId: String(record?.sandboxId || safeSandboxId).trim(),
    achievements: normalizeRows(record?.achievements),
    raw: record,
  };
}

async function fetchEpicPlayerAchievements(
  epicAccountId,
  productId,
  options = {},
) {
  const safeAccountId = String(epicAccountId || "").trim();
  const safeProductId = String(productId || "").trim();
  if (!safeAccountId) throw new Error("epic-account-id-required");
  if (!safeProductId) throw new Error("productId-required");
  const query = `
    query playerProfileAchievementsByProductId(
      $EpicAccountId: String!,
      $ProductId: String!
    ) {
      PlayerProfile {
        playerProfile(epicAccountId: $EpicAccountId) {
          epicAccountId
          displayName
          productAchievements(productId: $ProductId) {
            ... on PlayerProductAchievementsResponseSuccess {
              data {
                totalXP
                totalUnlocked
                playerAchievements {
                  playerAchievement {
                    achievementName
                    unlocked
                    unlockDate
                    XP
                  }
                }
              }
            }
          }
        }
      }
    }
  `;
  const payload = await epicGraphQL(
    query,
    { EpicAccountId: safeAccountId, ProductId: safeProductId },
    options,
  );
  const profile =
    payload?.data?.PlayerProfile?.playerProfile ||
    payload?.PlayerProfile?.playerProfile ||
    null;
  const productAchievements = profile?.productAchievements || null;
  const data = productAchievements?.data || productAchievements || {};
  return {
    epicAccountId: String(profile?.epicAccountId || safeAccountId).trim(),
    displayName: String(profile?.displayName || "").trim(),
    totalXP: Number(data?.totalXP || 0) || 0,
    totalUnlocked: Number(data?.totalUnlocked || 0) || 0,
    playerAchievements: normalizeRows(data?.playerAchievements),
    raw: data,
  };
}

module.exports = {
  EPIC_GRAPHQL_URL,
  EPIC_ECOM_ENTITLEMENTS_BASE,
  normalizeRows,
  fetchEpicEntitlements,
  fetchEpicEntitlementsPage,
  fetchEpicLibraryAssets,
  fetchEpicLibraryAssetsPage,
  fetchEpicOwnedGames,
  fetchEpicCatalogItem,
  fetchEpicPublicProductAchievements,
  fetchEpicAchievementSchemaBySandbox,
  fetchEpicPlayerAchievements,
  epicGraphQL,
};
