"use strict";

const path = require("path");
const identities = require("./game-presentation-sources"), metadata = require("./game-presentation-metadata");
const nameLookup = require("./game-presentation-search");
const storage = require("./game-artwork-storage");
const DEFINITIONS = [
  ["metadata", "Saved Product Artwork", storage.TYPES],
  ["steam-cache", "Steam Library Cache", ["cover", "header"]],
  ["steam-product", "Steam Product Assets", storage.TYPES],
  ["steam-cdn", "Steam CDN", storage.TYPES],
  ["steam-store", "Steam Store", storage.TYPES],
  ["epic-store", "Epic Store", storage.TYPES],
  ["epic-catalog", "Epic Catalog", storage.TYPES],
  ["gog-api", "GOG API", storage.TYPES],
  ["retroachievements", "RetroAchievements Artwork", storage.TYPES],
  ["xbox-title", "Xbox Title Artwork", ["cover", "header"]],
  ["xbox360-marketplace", "Xbox 360 Marketplace", storage.TYPES],
  ["gamesdb", "GOG GALAXY GamesDB", storage.TYPES],
  ["steamdb", "SteamDB", ["cover"]],
  ["steamgriddb", "SteamGridDB", storage.TYPES],
];
const cleanTitle = config => require("./game-cover-hero").normalizeGameCoverSearchTerm(config.displayName || config.name || "");
function list(config, type = "all") {
  const platform = String(config.platform || "").toLowerCase(), steam = identities.steamId(config);
  const saved = metadata.read({ config }), savedArtwork = saved?.artwork || {};
  const eligible = id => {
    if (id === "metadata") return type === "all" ? storage.TYPES.some(kind => savedArtwork[kind]) : !!savedArtwork[type];
    if (id === "steam-cache") return platform === "steam-official" && !!config.save_path;
    if (["steam-product", "steam-cdn", "steam-store", "steamdb"].includes(id)) return !!steam;
    if (id.startsWith("epic-")) return ["epic", "epic-official"].includes(platform);
    if (id === "gog-api") return ["gog", "gog-official"].includes(platform) && /^\d+$/.test(String(config.appid));
    if (id === "gamesdb") return identities.gamesDbSources(config).length > 0 || !!nameLookup.searchTitle(config, saved?.title);
    if (id === "retroachievements") return platform === id;
    if (id === "xbox-title") return platform === "xbox-pc";
    if (id === "xbox360-marketplace") return platform === "x360recomp";
    return id === "steamgriddb" && !!cleanTitle(config);
  };
  return DEFINITIONS.filter(([id, , types]) => eligible(id) && (type === "all" || types.includes(type)))
    .map(([id, label, types]) => ({ id, label, types: id === "metadata" ? types.filter(kind => savedArtwork[kind]) : types }));
}
function createProviders(options = {}) {
  const getJson = options.getJson || (async url => (await require("axios").get(url, { timeout: 12000, maxContentLength: 8 * 1024 * 1024 })).data);
  const grid = options.grid || require("./game-cover").fetchSteamGridDbImage;
  const db = options.db || require("./game-cover").fetchSteamDbLibraryCover;
  const product = options.product || require("./steam-product-assets").resolveSteamProductAssetUrls;
  const epicIdentity = options.epicIdentity || (appid => require("./epic-game-identity").resolveEpicGameIdentity(appid));
  const epicCatalog = options.epicCatalog || ((appid, input) => require("./epic-game-identity").resolveEpicCatalogImageUrls(appid, input));
  const searchByName = nameLookup.createNameLookup({ getJson });
  const uplaySteamId = options.uplaySteamId || (appid => require("./uplay-mapping-store").lookup(appid)?.steam_appid);
  const logger = options.logger || require("./logger").createLogger("covers");
  return { list, async candidates(context, type, provider, memo = new Map()) {
    const { config, userDataDir } = context, steamId = identities.steamId(config), appid = String(config.appid);
    const once = (key, run) => { if (!memo.has(key)) memo.set(key, Promise.resolve().then(run)); return memo.get(key); };
    const json = url => once(url, () => getJson(url));
    const artwork = data => {
      const value = data?.artwork?.[type]; return value ? [value] : [];
    };
    const native = metadata.read({ config, userDataDir });
    if (provider === "metadata") return artwork(native);
    if (provider === "steam-cache") {
      const cache = require("./game-artwork-steam-cache").pick(config.save_path, appid);
      return [type === "cover" ? cache.portraitPath : cache.headerPath].filter(Boolean).map(file => ({ file }));
    }
    if (provider === "steam-product") return product({ appid: steamId, configPath: config.config_path || "", purpose: type === "cover" ? "portrait" : type, language: config.language || "english" }).urls || [];
    if (provider === "steam-cdn") {
      const names = type === "cover" ? ["library_600x900.jpg", "portrait.png"] : type === "hero" ? ["library_hero.jpg"] : ["header.jpg", "library_header.jpg"];
      return names.flatMap(name => ["shared.cloudflare.steamstatic.com", "shared.fastly.steamstatic.com", "cdn.akamai.steamstatic.com"]
        .map(host => `https://${host}/store_item_assets/steam/apps/${steamId}/${name}`));
    }
    if (provider === "steam-store") {
      const response = await json(`https://store.steampowered.com/api/appdetails?appids=${steamId}&l=english`), data = response?.[steamId]?.data;
      if (response?.[steamId]?.success !== true) return [];
      return (type === "cover" ? [data.library_assets?.library_600x900] : type === "header" ? [data.header_image] : [data.background_raw, data.background]).filter(Boolean);
    }
    if (provider === "steamdb") return [await db(steamId)];
    if (provider === "steamgriddb") {
      const size = type === "hero" ? "3840x1240,1920x620" : type === "cover" ? "600x900" : require("./game-cover").STEAMGRID_GRID_LANDSCAPE_DIMENSIONS;
      const request = selectedSize => grid(cleanTitle(config), { appid: `${config.platform}:${appid}:${type}`, assetType: type === "hero" ? "heroes" : "grids", size: selectedSize });
      if (type !== "hero") return [await request(size)];
      try { return [await request(size), () => request("1920x620")]; }
      catch { return [await request("1920x620")]; }
    }
    if (provider === "xbox360-marketplace") return require("./x360-recomp-art").artworkUrls(appid, type === "cover" ? "portrait" : "landscape");
    if (provider === "xbox-title" || provider === "retroachievements") {
      const saved = storage.read(path.join(storage.directory(context), "sources.json"));
      const prior = saved.artwork?.[type]?.source === provider ? saved.artwork[type].url : "";
      return [...new Set([saved.providers?.[type]?.[provider], prior,
        ...(provider === "retroachievements" && native?.source === provider ? artwork(native) : []),
        ...(provider === "xbox-title" ? [type === "cover" ? saved.coverUrl : type === "header" ? saved.headerUrl : ""] : []),
      ].filter(Boolean))];
    }
    if (provider === "epic-store" || provider === "epic-catalog") {
      const identity = () => once("epic-identity", () => epicIdentity(appid));
      if (provider === "epic-catalog") {
        const resolved = config.epic_catalog_item_id ? config : { ...config, ...(await identity() || {}) };
        const result = await once("epic-catalog", () => epicCatalog(appid, {
          catalogItemId: resolved.epic_catalog_item_id || resolved.catalogItemId, namespace: resolved.epic_namespace || resolved.namespace,
        }));
        return type === "cover" ? result.portraitUrls : result.headerUrls;
      }
      let slug = config.epic_store_slug || config.epicStoreSlug;
      if (!slug) {
        const map = await json("https://store-content.ak.epicgames.com/api/content/productmapping/");
        slug = [appid, config.epic_product_id, config.epic_namespace, config.epic_catalog_item_id, config.epic_app_name].filter(Boolean)
          .map(id => map[id] || map[String(id).toLowerCase()]).find(Boolean);
      }
      if (!slug) slug = (await identity())?.storeSlug;
      if (!slug) return [];
      const data = await json(`https://store-content.ak.epicgames.com/api/en-US/content/products/${encodeURIComponent(slug)}`);
      const parsed = metadata.normalize({ kind: "epic", appid, payload: data });
      return type === "header" ? [parsed?.artwork?.hero].filter(Boolean) : artwork(parsed);
    }
    if (provider === "gog-api") {
      const urls = [];
      for (const endpoint of [`https://api.gog.com/products/${appid}?expand=description&locale=en-US`, `https://api.gog.com/v2/games/${appid}?locale=en-US`]) {
        try { const parsed = metadata.normalize({ kind: "gog", appid, payload: await json(endpoint) }); urls.push(...(type === "header" ? [parsed?.artwork?.hero].filter(Boolean) : artwork(parsed))); } catch {}
      }
      return [...new Set(urls)];
    }
    if (provider === "gamesdb") {
      const urls = [];
      for (const release of identities.gamesDbSources(config)) {
        try {
          const resolved = String(config.platform).toLowerCase() === "xlivelessness"
            ? await once("gfwl-release", () => require("./game-presentation-gfwl").resolveGfwlRelease(config, release.id, json, { nativeOnly: true }))
            : { id: release.id, payload: await json(`https://gamesdb.gog.com/platforms/${release.platform}/external_releases/${encodeURIComponent(release.id)}`) };
          if (!resolved) continue;
          const parsed = metadata.normalize({ kind: "gamesdb", appid, sourcePlatform: release.platform, externalId: resolved.id,
            payload: resolved.payload });
          urls.push(...(type === "header" ? [parsed?.artwork?.hero].filter(Boolean) : artwork(parsed)));
        } catch {}
      }
      if (["uplay", "ubisoft-official"].includes(String(config.platform).toLowerCase())) {
        // These are lazy candidates: only resolve the next identity if the
        // preceding release had no artwork or its image could not be loaded.
        // All requests stay in GamesDB; config/achievement identities stay native.
        const mappedSteamId = steamId || String(uplaySteamId(appid) || "");
        if (/^\d+$/.test(mappedSteamId)) urls.push(async () => {
          const payload = await json(`https://gamesdb.gog.com/platforms/steam/external_releases/${mappedSteamId}`);
          const parsed = metadata.normalize({ kind: "gamesdb", appid, sourcePlatform: "steam", externalId: mappedSteamId, payload });
          const url = (type === "header" ? parsed?.artwork?.hero : parsed?.artwork?.[type]) || "";
          if (url) logger.info("artwork:gamesdb:fallback", { platform: config.platform, appid, type, lookup: "mapped-steam", sourceId: mappedSteamId });
          return url || null;
        });
      }
      if (nameLookup.searchTitle(config, native?.title)) {
        // Share the same title/platform resolver as Game Data for every
        // platform, including configs with no GamesDB-compatible release ID.
        urls.push(async () => {
          const found = await once("gamesdb-name", () => searchByName({ config, userDataDir,
            fallbackTitle: native?.title, previousMatch: native?.gamesDbMatch }));
          if (found.code !== "selected") throw new Error(`GamesDB name search: ${found.code}`);
          const parsed = metadata.normalize({ kind: "gamesdb-game", appid, externalId: found.gameId, payload: found.payload });
          const url = (type === "header" ? parsed?.artwork?.hero : parsed?.artwork?.[type]) || "";
          if (url) logger.info("artwork:gamesdb:fallback", { platform: config.platform, appid, type, lookup: "name", gameId: found.gameId,
            sourcePlatform: found.platform, alternatePlatform: found.alternatePlatform, reused: found.reused === true });
          return url || null;
        });
      }
      return [...new Set(urls)];
    }
    return [];
  } };
}
module.exports = { createProviders, list };
