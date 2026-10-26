"use strict";

const COMMUNITY_ASSETS = "https://shared.fastly.steamstatic.com/community_assets/";

function httpImageUrl(value, baseUrl) {
  const text = String(value || "").trim();
  if (!text || /^(?:data|blob|javascript|about):/i.test(text)) return "";
  try {
    const url = new URL(text, baseUrl);
    return /^https?:$/.test(url.protocol) ? url.href : "";
  } catch { return ""; }
}

function resolveSteamDbImageUrl(attributes, baseUrl, appid, communityAssets) {
  if (!attributes) return "";
  const srcsetUrls = (value) => String(value || "").split(",")
    .map((entry) => {
      const [url, descriptor] = entry.trim().split(/\s+/);
      return { url, density: parseFloat(descriptor) || 1 };
    }).filter((entry) => entry.url)
    .sort((a, b) => b.density - a.density).map((entry) => entry.url);
  for (const value of [attributes.src, attributes["data-src"], attributes["data-original"],
    ...srcsetUrls(attributes.srcset), ...srcsetUrls(attributes["data-srcset"])]) {
    const url = httpImageUrl(value, baseUrl);
    if (url) return url;
  }
  const name = String(attributes["data-name"] || "").trim();
  if (!name || !/^\d+$/.test(String(appid))) return "";
  const root = httpImageUrl(communityAssets || COMMUNITY_ASSETS, baseUrl);
  if (!root) return "";
  return httpImageUrl(`images/apps/${appid}/${encodeURIComponent(name)}`, root.endsWith("/") ? root : `${root}/`);
}

module.exports = { resolveSteamDbImageUrl };
