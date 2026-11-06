"use strict";
const path = require("path");
const metadata = require("./game-presentation-metadata");
const sources = require("./game-presentation-sources");
const { createLogger } = require("./logger");
const logger = createLogger("game-details");
const MAP_URL = "https://store-content.ak.epicgames.com/api/content/productmapping/";
const clean = value => typeof value === "string" ? value.trim() : "";

function createMetadataService({ getJson = async url => (await require("axios").get(url, { timeout: 10000, maxContentLength: 8 * 1024 * 1024 })).data,
  epicIdentity = id => require("./epic-game-identity").resolveEpicGameIdentity(id) } = {}) {
  const pending = new Map(), checked = new Map();
  const searchByName = require("./game-presentation-search").createNameLookup({ getJson });
  let productMap, mapPromise;
  async function epicMap() {
    if (productMap?.expires > Date.now()) return productMap.value;
    if (!mapPromise) mapPromise = getJson(MAP_URL).then(value => {
      productMap = { value, expires: Date.now() + 3600000 }; return value;
    }).finally(() => { mapPromise = null; });
    return mapPromise;
  }
  async function execute({ config, userDataDir, force = false, reason = "manual" }) {
    const platform = clean(config.platform).toLowerCase(), appid = String(config.appid || "");
    const previous = metadata.read({ userDataDir, config });
    const options = { directory: config.config_path, userDataDir, platform, appid };
    const persist = data => metadata.storeNormalized({ ...options, data });
    const base = { platform, appid, reason };
    if (!force && sources.complete(previous)) { const data = persist(previous); return { ok: true, code: "unchanged", metadata: data || previous }; }
    let result, lastError, nameLookupCode;
    const steamId = sources.steamId(config), nativeSteam = ["steam", "steam-official", "markerpatch", "madnesspatch"].includes(platform);
    let lookupConfig = config;
    const fetchSteam = async () => {
      const response = await getJson(`https://store.steampowered.com/api/appdetails?appids=${steamId}&l=english`);
      if (response?.[steamId]?.success !== true) throw new Error("Steam Store returned no product details");
      return metadata.normalize({ kind: "steam", appid: steamId, payload: response });
    };
    try {
      try {
        if (nativeSteam && steamId) result = await fetchSteam();
        else if (["epic", "epic-official"].includes(platform)) {
          // Reuse the discovery resolver for namespace, product, catalog item
          // and supported artifact IDs. Keep the config/schema AppID intact.
          const ids = [...new Set([appid, config.epic_namespace, config.epicNamespace, config.epic_sandbox_id,
            config.epic_product_id, config.epicProductId, config.epic_catalog_item_id, config.epic_app_name].map(clean).filter(Boolean))];
          let identity;
          for (const id of ids) {
            try { identity = await epicIdentity(id); if (identity) break; }
            catch (error) { lastError = error; }
          }
          if (identity) {
            lookupConfig = { ...config, epic_app_name: identity.appName || config.epic_app_name };
            logger.info("game-details:identity", { ...base, source: "epic", namespace: identity.namespace,
              catalogItemId: identity.catalogItemId, appName: identity.appName });
          }
          let slug = clean(identity?.storeSlug || config.epic_store_slug || config.epicStoreSlug);
          if (!slug) {
            const map = await epicMap();
            for (const id of [identity?.namespace, identity?.productId, identity?.catalogItemId, identity?.appName, ...ids]) {
              if (!id) continue;
              slug = clean(map?.[id] || map?.[String(id).toLowerCase()]); if (slug) break;
            }
          }
          if (!slug) throw new Error("Epic product has no verified store mapping");
          const response = await getJson(`https://store-content.ak.epicgames.com/api/en-US/content/products/${encodeURIComponent(slug)}`);
          result = metadata.normalize({ kind: "epic", appid, payload: response });
        } else if (["gog", "gog-official"].includes(platform) && /^\d+$/.test(appid)) {
          for (const endpoint of [`https://gamesdb.gog.com/platforms/gog/external_releases/${appid}`,
            `https://api.gog.com/products/${appid}?expand=description&locale=en-US`, `https://api.gog.com/v2/games/${appid}?locale=en-US`]) {
            try { result = metadata.merge(result, metadata.normalize({ kind: "gog", appid, payload: await getJson(endpoint) })); if (sources.complete(metadata.merge(result, previous))) break; }
            catch (error) { lastError = error; }
          }
        }
      } catch (error) { lastError = error; }
      // Complete optional fields from an exact platform/release record. This
      // database also covers non-GOG games; numeric IDs never cross namespaces.
      if (((force && !result) || !sources.complete(metadata.merge(result, previous))) && !["gog", "gog-official"].includes(platform)) {
        for (const identity of sources.gamesDbSources(lookupConfig)) {
          try {
            const resolved = platform === "xlivelessness"
              ? await require("./game-presentation-gfwl").resolveGfwlRelease(config, identity.id, getJson, { nativeOnly: true })
              : { id: identity.id, payload: await getJson(`https://gamesdb.gog.com/platforms/${identity.platform}/external_releases/${encodeURIComponent(identity.id)}`) };
            if (!resolved) { logger.info("game-details:unavailable", { ...base, code: "release-unverified", source: "gamesdb" }); continue; }
            const extra = metadata.normalize({ kind: "gamesdb", appid, sourcePlatform: identity.platform, externalId: resolved.id, payload: resolved.payload });
            if (extra) { result = metadata.merge(result, extra); logger.info("game-details:supplement", { ...base, source: "gamesdb", sourcePlatform: identity.platform, sourceId: resolved.id, fallback: !!resolved.fallback }); }
            if (sources.complete(metadata.merge(result, previous))) break;
          } catch (error) { lastError = error; }
        }
      }
      if (!nativeSteam && steamId && (!result || !sources.complete(metadata.merge(result, previous)))) {
        try {
          result = metadata.merge(result, await fetchSteam());
          logger.info("game-details:supplement", { ...base, source: "steam", sourceId: steamId });
        }
        catch (error) { lastError = error; }
      }
      const current = metadata.merge(result, previous);
      if (!sources.complete(current)) {
        try {
          const found = await searchByName({ config: lookupConfig, userDataDir, force, fallbackTitle: current?.title,
            previousMatch: previous?.gamesDbMatch });
          nameLookupCode = found.code;
          if (found.code === "selected") {
            const extra = metadata.normalize({ kind: "gamesdb-game", appid, externalId: found.gameId, payload: found.payload });
            if (extra) {
              extra.gamesDbMatch = { gameId: found.gameId, query: found.query, platform: found.platform, alternatePlatform: found.alternatePlatform };
              // Existing fields are authoritative; name lookup only fills holes.
              result = metadata.merge(current, extra);
              result.gamesDbMatch = extra.gamesDbMatch;
              logger.info("game-details:name-search:selected", { ...base, ...extra.gamesDbMatch, reused: !!found.reused });
            }
          } else logger.info("game-details:name-search:unavailable", { ...base, code: found.code, query: found.query, candidates: found.candidates });
        } catch (error) {
          lastError = error;
          logger.warn("game-details:name-search:failed", { ...base, error: error.message });
        }
      }
      if (!result && ["ambiguous", "not-found"].includes(nameLookupCode)) {
        if (previous) persist(previous);
        return { ok: false, code: nameLookupCode, metadata: previous };
      }
      if (!result && !lastError) {
        if (previous) persist(previous);
        logger.info("game-details:unavailable", { ...base, code: "source-unsupported" });
        return { ok: false, code: "source-unsupported", metadata: previous };
      }
      if (!result) throw lastError || new Error("The source returned no game details");
      result.platform = platform;
      const data = persist(metadata.merge(result, previous));
      if (!data) throw new Error("Game details could not be saved");
      const comparable = value => JSON.stringify(value && { ...value, updatedAt: null });
      const code = comparable(previous) === comparable(data) ? "unchanged" : "updated";
      logger.info(`game-details:${code}`, { ...base, source: data.source, path: config.config_path ? path.join(config.config_path, "game-details.json") : null,
        fields: ["description", "developers", "publishers", "genres", "releaseDate"].filter(key => data[key]?.length) });
      return { ok: true, code, metadata: data };
    } catch (error) {
      if (previous) persist(previous);
      logger.warn("game-details:failed", { ...base, error: error?.message || String(error) });
      return { ok: false, code: "request-failed", metadata: previous, error: error?.message || String(error) };
    }
  }
  return { refresh(options) {
    const key = JSON.stringify([options.userDataDir, options.config.platform, options.config.appid, options.config.config_path,
      sources.steamId(options.config), sources.gamesDbSources(options.config), options.config.epic_store_slug || options.config.epicStoreSlug,
      options.config.epic_namespace, options.config.epicNamespace, options.config.epic_sandbox_id, options.config.epic_product_id,
      options.config.epicProductId, options.config.epic_catalog_item_id, options.config.epic_app_name,
      require("./game-presentation-search").searchTitle(options.config),
      require("./game-presentation-search").preferredPlatforms(options.config)]);
    if (pending.has(key)) return pending.get(key);
    if (!options.force && checked.get(key)?.expires > Date.now()) return Promise.resolve({ ...checked.get(key).result,
      metadata: metadata.read({ userDataDir: options.userDataDir, config: options.config }) });
    const job = execute(options).then(result => {
      if (checked.size >= 256) checked.delete(checked.keys().next().value);
      checked.set(key, { result, expires: Date.now() + (result.ok ? 600000 : 120000) }); return result;
    }).finally(() => pending.delete(key)); pending.set(key, job); return job;
  } };
}
const service = createMetadataService();
module.exports = { createMetadataService, refresh: service.refresh };
