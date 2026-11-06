"use strict";
const cheerio = require("cheerio");
const tier = item => /^(?:p|platinum)$/i.test(item?.trophyType || "");
const codeKey = code => String(code).toLowerCase().replace(/_/g, "-");
function availableLanguages(html, baseUrl, langMap, requested) {
  const codes = new Map(Object.entries(langMap).map(([key, code]) => [codeKey(code), key]));
  for (const [code, key] of Object.entries({ kr: "koreana", ja: "japanese", "en-us": "english", "es-419": "latam" })) codes.set(code, key);
  const $ = cheerio.load(html), found = new Map(), base = new URL(baseUrl);
  for (const el of $("dt.languages + dd a[href]").toArray()) {
    try {
      const url = new URL($(el).attr("href"), base);
      if (url.origin !== base.origin || url.search || url.hash || !url.pathname.startsWith(base.pathname)) continue;
      const suffix = decodeURIComponent(url.pathname.slice(base.pathname.length)).replace(/\/$/, "");
      const key = codes.get(codeKey(suffix));
      if (key && key !== "english" && !suffix.includes("/")) found.set(key, url.href);
    } catch {}
  }
  // Some older pages omit the language list. Retain bounded support for the
  // existing supported language map, never guess another game's URL.
  if (!found.size) for (const key of requested) if (key !== "english" && langMap[key]) {
    found.set(key, baseUrl + encodeURIComponent(langMap[key]) + "/");
  }
  return found;
}
async function loadPlatinumLanguages({ html, baseUrl, baseItems, achievements, langMap, requested, loadPage, extract, logger }) {
  const candidates = baseItems.filter(tier), target = achievements.filter(tier);
  const languages = availableLanguages(html, baseUrl, langMap, requested);
  const status = { version: 1, available: ["english", ...languages.keys()], loaded: ["english"], failed: [] };
  if (candidates.length !== 1 || target.length !== 1) return status;
  for (const [lang, url] of languages) {
    try {
      logger?.info("exophase:lang:load", { lang, url, purpose: "platinum" });
      const { html } = await loadPage(url), items = extract(html, url), translated = items.filter(tier);
      const source = candidates[0], match = translated[0];
      if (translated.length !== 1 || (source.awardId ? match?.awardId !== source.awardId :
          items.length !== baseItems.length || match?.index !== source.index || !source.icon_url || match?.icon_url !== source.icon_url)) {
        throw new Error("Localized Platinum identity does not match the English baseline");
      }
      if (!match.title?.trim() || !match.description?.trim()) throw new Error("Localized Platinum text is incomplete");
      if (match.title === source.title && match.description === source.description) {
        logger?.info("exophase:lang:default-english", { lang, url, purpose: "platinum" }); continue;
      }
      target[0].titles[lang] = match.title;
      target[0].descriptions[lang] = match.description;
      status.loaded.push(lang);
    } catch (error) {
      status.failed.push(lang);
      logger?.warn("exophase:lang:failed", { lang, url, purpose: "platinum", error: error.message });
    }
  }
  logger?.info("exophase:platinum:languages", status);
  return status;
}
module.exports = { availableLanguages, loadPlatinumLanguages };
