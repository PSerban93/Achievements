"use strict";
const { createHash } = require("crypto");
const { selectCatalogResult } = require("./exophase-catalog");

const normalize = value => String(value || "").normalize("NFC").replace(/\s+/g, " ").trim();
function platinumDetails(result) {
  const entries = (result.items || []).filter(item => /^(?:p|platinum)$/i.test(item.trophyType || ""));
  if (entries.length !== 1) return null;
  const item = entries[0], title = normalize(item.title), description = normalize(item.description);
  try {
    const icon = new URL(item.icon_url);
    if (!title || !description || icon.protocol !== "https:" || icon.hostname !== "m.exophase.com" || icon.port || icon.username || icon.password) return null;
    return { text: JSON.stringify([title, description]), icon: icon.href };
  } catch { return null; }
}
async function fingerprintImage(url, deadline, imagePage) {
  const remaining = Math.min(10000, deadline - Date.now());
  if (remaining <= 0) return null;
  const response = await require("axios").get(url, { responseType: "arraybuffer", timeout: remaining,
    maxContentLength: 4 * 1024 * 1024, maxBodyLength: 4 * 1024 * 1024, maxRedirects: 0 });
  const bytes = Buffer.from(response.data || []);
  if (!/^image\//i.test(response.headers?.["content-type"] || "") || !bytes.length) return null;
  if (imagePage) return imagePage.evaluate(async ({ base64, type }) => {
    // PNG metadata/encoding may differ between regions while the icon's pixels
    // are identical. Decode in the existing renderer; never rewrite the asset.
    const bitmap = await createImageBitmap(new Blob([Uint8Array.from(atob(base64), char => char.charCodeAt(0))], { type }));
    try {
      if (!bitmap.width || !bitmap.height || bitmap.width > 512 || bitmap.height > 512) return null;
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height), context = canvas.getContext("2d", { willReadFrequently: true });
      context.drawImage(bitmap, 0, 0);
      const pixels = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
      const digest = await crypto.subtle.digest("SHA-256", pixels);
      return `${bitmap.width}x${bitmap.height}:` + Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
    } finally { bitmap.close(); }
  }, { base64: bytes.toString("base64"), type: response.headers["content-type"] });
  return createHash("sha256").update(bytes).digest("hex");
}

// This exception is intentionally separate from the schema/rarity selector.
// A region may change rarity, IDs and URLs without changing the Platinum award.
async function selectPlatinumCatalogResult(results, { hashImage = fingerprintImage, deadline = Date.now() + 30000, logger, imagePage } = {}) {
  let ambiguity;
  try { return selectCatalogResult(results); }
  catch (error) { if (error.code !== "EXOPHASE_AMBIGUOUS") throw error; ambiguity = error; }
  const valid = results.filter(result => result.comparison.hasReference && result.comparison.valid)
    .sort((a, b) => b.candidate.rank - a.candidate.rank || b.comparison.pairMatches - a.comparison.pairMatches || b.comparison.matches - a.comparison.matches);
  const best = valid[0];
  if (!best) throw ambiguity;
  const tied = valid.filter(result => result.candidate.rank === best.candidate.rank &&
    result.comparison.pairMatches === best.comparison.pairMatches && result.comparison.matches === best.comparison.matches);
  if (tied.length < 2 || tied.some(result => !result.comparison.compared || result.comparison.matches / result.comparison.compared < .9)) throw ambiguity;
  const details = tied.map(platinumDetails);
  if (details.some(item => !item || item.text !== details[0].text)) throw ambiguity;
  const icons = [...new Set(details.map(item => item.icon))];
  if (icons.length > 1) {
    let hashes;
    try { hashes = await Promise.all(icons.map(icon => hashImage(icon, deadline, imagePage))); }
    catch (error) {
      logger?.info("exophase:platinum:equivalence-unverified", { reason: "icon-request-failed", error: error.message }); throw ambiguity;
    }
    if (hashes.some(hash => !hash || hash !== hashes[0])) throw ambiguity;
  }
  const selected = tied.slice().sort((a, b) => a.candidate.baseUrl.localeCompare(b.candidate.baseUrl))[0];
  logger?.info("exophase:platinum:regional-equivalent", { baseUrl: selected.candidate.baseUrl,
    candidates: tied.map(result => result.candidate.baseUrl).sort(), matches: selected.comparison.matches,
    compared: selected.comparison.compared, iconComparison: icons.length === 1 ? "same-url" : imagePage ? "pixels-sha256" : "sha256", rarityUsedForIdentity: false });
  return selected;
}
module.exports = { selectPlatinumCatalogResult };
