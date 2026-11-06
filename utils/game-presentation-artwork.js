"use strict";
const fs = require("fs/promises"), path = require("path");
const { pathToFileURL } = require("url");
const policy = require("./game-artwork-policy");
const storage = require("./game-artwork-storage");
function createArtworkResolver(measure) {
  const cache = new Map(), inflight = new Map();
  async function inspect(file) {
    if (!file) return null;
    try {
      const stat = await fs.stat(file);
      if (!stat.isFile() || !stat.size || stat.size > policy.MAX_BYTES) return null;
      const key = `${file}:${stat.size}:${stat.mtimeMs}`;
      if (cache.has(key)) return cache.get(key);
      if (inflight.has(key)) return inflight.get(key);
      const job = (async () => {
        const size = await measure(await fs.readFile(file));
        const result = size?.width && size?.height ? { url: pathToFileURL(file).href + `?m=${stat.mtimeMs}`, width: size.width, height: size.height } : null;
        if (cache.size >= 96) cache.delete(cache.keys().next().value);
        cache.set(key, result); return result;
      })().finally(() => inflight.delete(key));
      inflight.set(key, job); return await job;
    } catch { return null; }
  }
  return async function resolve({ config, userDataDir, cover = "", header = "" }) {
    const platform = String(config.platform || ""), appid = String(config.appid || "");
    if (!/^[\p{L}\p{N}_.:-]{1,180}$/u.test(platform) || !/^[\p{L}\p{N}_.:-]{1,180}$/u.test(appid)) return { hero: null, cover: null };
    const dir = path.join(userDataDir, "images", platform, appid);
    const candidates = [config.custom_hero_path, config.custom_background_path, config.custom_header_path,
      ...storage.candidatePaths(dir, "game-cover-hero"), header];
    let hero = null;
    for (const file of new Set(candidates.filter(Boolean))) {
      const image = await inspect(file);
      // Never enlarge a small card header or portrait cover into a backdrop.
      if (policy.isHero(image)) { hero = image; break; }
    }
    const relativeCover = cover ? path.relative(dir, cover) : "..";
    const localCover = relativeCover && !relativeCover.startsWith("..") && !path.isAbsolute(relativeCover) ? cover : "";
    let portrait = null;
    for (const file of new Set([config.custom_cover_path, localCover,
      ...storage.candidatePaths(dir, appid)].filter(Boolean))) {
      portrait = await inspect(file); if (portrait) break;
    }
    return { hero, cover: portrait };
  };
}
module.exports = { createArtworkResolver };
