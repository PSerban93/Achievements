"use strict";
const path = require("path");
const metadata = require("./game-presentation-metadata");
const { createLogger } = require("./logger");
const logger = createLogger("game-details");

function createAssetService({ resolve, refreshMetadata, imageProcessor, ensureArtwork,
  queueHero = options => require("./game-cover-hero").queueGameCoverHero(options),
  downloadImage = (...args) => require("./game-cover-hero").downloadGameCoverHero(...args),
  findCover = (title, identity) => require("./game-cover").fetchSteamGridDbImage(title, { appid: `${identity}:preview-cover`, size: "600x900", assetType: "grids" }) }) {
  const pending = new Map(), failures = new Map();
  return { async ensure({ config, userDataDir, force = false }) {
    const key = JSON.stringify([userDataDir, config.platform, config.appid]);
    if (pending.has(key)) {
      const result = await pending.get(key);
      // Shared downloads do not share per-config artwork overrides or schema metadata.
      return { ...result, ...(await resolve(config)) };
    }
    const job = (async () => {
      let presentation = await resolve(config), data = presentation.metadata;
      if (!require("./game-presentation-sources").complete(data)) {
        try {
          const refreshed = await refreshMetadata({ config, userDataDir, reason: "game-preview" });
          presentation = await resolve(config); data = refreshed.metadata || presentation.metadata;
        } catch (error) { logger.warn("game-details:metadata-failed", { platform: config.platform, appid: config.appid, error: error.message }); }
      }
      if (presentation.artwork.hero && presentation.artwork.cover) return { ...presentation, code: "ready" };
      if (!force && failures.get(key) > Date.now()) return { ...presentation, code: "retry-later" };
      logger.info("game-details:artwork-start", { platform: config.platform, appid: config.appid });
      data ||= metadata.read({ config, userDataDir });
      if (ensureArtwork) {
        const types = [!presentation.artwork.hero && "hero", !presentation.artwork.cover && "cover"].filter(Boolean);
        await Promise.all(types.map(type => ensureArtwork({ config, userDataDir }, type, { force })));
        presentation = await resolve(config);
        const complete = !!presentation.artwork.hero && !!presentation.artwork.cover;
        if (!complete) {
          if (failures.size >= 128) failures.delete(failures.keys().next().value);
          failures.set(key, Date.now() + 120000);
        } else failures.delete(key);
        return { ...presentation, code: complete ? "ready" : "partial" };
      }
      const identity = `${config.platform}:${config.appid}`, title = config.displayName || config.name || data?.title || "";
      const urls = data?.artwork || {};
      if (!presentation.artwork.hero) {
        try { await queueHero({ userDataPath: userDataDir, platform: config.platform, appid: config.appid, title,
          sourceUrls: [urls.hero, urls.header].filter(Boolean), force: true, reason: "game-preview",
          imageProcessor: (buffer, extension) => imageProcessor(buffer, extension, "hero") }); }
        catch (error) { logger.warn("game-details:hero-failed", { identity, error: error.message }); }
      }
      if (!presentation.artwork.cover) {
        let saved = false;
        const directory = path.join(userDataDir, "images", String(config.platform), String(config.appid));
        if (urls.cover) {
          try { await downloadImage(urls.cover, directory, { basename: String(config.appid), imageProcessor: (buffer, extension) => imageProcessor(buffer, extension, "cover") }); saved = true; }
          catch (error) { logger.info("game-details:cover-source-miss", { identity, error: error.message }); }
        }
        if (!saved && title) {
          try { await downloadImage(await findCover(title, identity), directory, { basename: String(config.appid), imageProcessor: (buffer, extension) => imageProcessor(buffer, extension, "cover") }); }
          catch (error) { logger.warn("game-details:cover-failed", { identity, error: error.message }); }
        }
      }
      presentation = await resolve(config);
      const complete = !!presentation.artwork.hero && !!presentation.artwork.cover;
      if (!complete) {
        if (failures.size >= 128) failures.delete(failures.keys().next().value);
        failures.set(key, Date.now() + 120000);
      } else failures.delete(key);
      logger.info("game-details:artwork-result", { identity, hero: !!presentation.artwork.hero, cover: !!presentation.artwork.cover, complete });
      return { ...presentation, code: complete ? "ready" : "partial" };
    })().finally(() => pending.delete(key));
    pending.set(key, job); return job;
  } };
}
module.exports = { createAssetService };
