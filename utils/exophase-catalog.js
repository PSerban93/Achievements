"use strict";

const SEARCH_PAGE = "https://www.exophase.com/games/";
const SEARCH_API = "https://api.exophase.com/public/archive/games";
const MAX_PAGES = 3;
const CACHE_TTL_MS = 5 * 60 * 1000;
const searches = new Map();

function catalogError(code, message, details = {}) {
  return Object.assign(new Error(message), { code, ...details });
}

function cleanExophaseTitle(value) {
  return String(value || "")
    .replace(/[™®©]/g, "")
    .replace(/\s*\((?:PS[345]|RPCS3|ShadPS4|KytyPS5|PS[34] Recomp|Xbox 360 Recomp|Xenia|Steam)\)(?:\s*\[\d+\])?\s*$/i, "")
    .replace(/\s+/g, " ").trim();
}

function normalizeTitle(value) {
  return cleanExophaseTitle(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/['’]/g, "").replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim().replace(/^the\s+|\s+the$/g, "");
}

function titleRank(requested, candidate) {
  const wanted = normalizeTitle(requested);
  if (!wanted) return 0;
  const titles = String(candidate || "").split(/\s*[|｜]\s*/).map(normalizeTitle);
  if (titles.includes(wanted)) return 2;
  const roman = { ii: "2", iii: "3", iv: "4", v: "5", vi: "6", vii: "7", viii: "8", ix: "9", x: "10" };
  const numbers = text => text.replace(/\b(?:ii|iii|iv|v|vi|vii|viii|ix|x)\b/g, word => roman[word]);
  if (titles.some(title => numbers(title) === numbers(wanted))) return 1;
  // Search results may abbreviate or omit an edition. Such results need
  // independent achievement matches before they can be selected.
  const words = wanted.split(" ");
  return words.length >= 2 && titles.some(title => {
    const candidateWords = new Set(title.split(" "));
    const overlap = words.filter(word => candidateWords.has(word)).length;
    return overlap >= 2 && (overlap === Math.min(words.length, candidateWords.size) ||
      overlap / Math.max(words.length, candidateWords.size) >= 0.75);
  }) ? 1 : 0;
}

function awardsUrl(value, platform) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== "www.exophase.com" ||
        url.port || url.username || url.password || url.search || url.hash) return "";
    const match = url.pathname.match(/^\/game\/([\w%.-]+)\/(trophies|achievements)\/$/i);
    if (!match || match[2] !== (/^ps[345]$/.test(platform) ? "trophies" : "achievements")) return "";
    return url.toString();
  } catch { return ""; }
}

function rankCatalogCandidates(games, title, platform) {
  const environment = /^ps[345]$/.test(platform) ? "psn" :
    /^xbox/.test(platform) ? "xbox" : platform;
  const seen = new Set();
  return games.flatMap(game => {
    if (game?.environment_slug !== environment || !Array.isArray(game.platforms)) return [];
    if (!game.platforms.some(item => item?.slug === platform)) return [];
    const rank = titleRank(title, game.title);
    const baseUrl = awardsUrl(game.endpoint_awards, platform);
    if (!rank || !baseUrl || seen.has(baseUrl) || Number(game.total_awards) <= 0) return [];
    seen.add(baseUrl);
    return [{ title: game.title, baseUrl, rank, masterId: game.master_id,
      expectedCount: Number(game.total_awards), regions: game.regions || [] }];
  }).sort((a, b) => b.rank - a.rank);
}

function english(value) {
  return typeof value === "string" ? value : String(value?.english || "");
}

function normalizeAward(value) {
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");
}

function compareAchievements(expected = [], actual = []) {
  const references = expected.map(entry => [
    { title: english(entry.displayName || entry.titles), description: english(entry.description || entry.descriptions) },
    ...Object.values(entry.kytyps5_english_variants || {}).map(variant => ({
      title: english(variant.displayName), description: english(variant.description),
    })),
  ].map(item => ({ title: normalizeAward(item.title), description: normalizeAward(item.description) }))
    .filter(item => item.title && !/^(?:(?:trophy|achievement|ach)(?:\s*\d+)?|(?:hidden|secret|unknown|locked)(?:\s+(?:trophy|achievement))?(?:\s*\d+)?)$/i.test(item.title)))
    .filter(variants => variants.length);
  const titles = new Map(), pairs = new Map();
  for (const [index, item] of actual.entries()) {
    const title = normalizeAward(item.title), pair = `${title}|${normalizeAward(item.description)}`;
    if (!title) continue;
    titles.set(title, titles.has(title) ? null : index);
    pairs.set(pair, pairs.has(pair) ? null : index);
  }
  const used = new Set();
  let pairMatches = 0, matches = 0;
  // Resolve exact pairs first so a title-only alias cannot take their match.
  for (const exact of [true, false]) for (const [index, variants] of references.entries()) {
    if (used.has(`local:${index}`)) continue;
    const candidates = new Set(variants.map(item => exact
      ? pairs.get(`${item.title}|${item.description}`) : titles.get(item.title))
      .filter(value => Number.isInteger(value) && !used.has(value)));
    if (candidates.size !== 1) continue;
    const remote = [...candidates][0];
    used.add(remote); used.add(`local:${index}`); matches += 1;
    if (exact) pairMatches += 1;
  }
  const compared = Math.min(references.length, actual.length);
  const hasReference = references.length > 0;
  const valid = hasReference ? compared > 0 && matches >= Math.min(3, compared) && matches / compared >= 0.7 : null;
  return { valid, matches, pairMatches, compared, hasReference };
}

function selectCatalogResult(results) {
  const valid = results.filter(result => result.comparison.hasReference
    ? result.comparison.valid : result.candidate.rank === 2);
  valid.sort((a, b) => b.candidate.rank - a.candidate.rank ||
    b.comparison.pairMatches - a.comparison.pairMatches || b.comparison.matches - a.comparison.matches);
  if (!valid.length) throw catalogError("EXOPHASE_SCHEMA_MISMATCH", "Exophase candidates do not match the local achievement schema");
  const [best, second] = valid;
  if (second && best.candidate.rank === second.candidate.rank &&
      best.comparison.pairMatches === second.comparison.pairMatches && best.comparison.matches === second.comparison.matches) {
    throw catalogError("EXOPHASE_AMBIGUOUS", "Exophase catalog returned multiple matching trophy lists");
  }
  return best;
}

async function searchExophaseCatalog(page, title, { deadline, logger } = {}) {
  title = cleanExophaseTitle(title);
  if (!title || /^(?:PPSA\d+|CUSA\d+|NPWR\d+_\d+|\d+)$/i.test(title)) {
    throw catalogError("EXOPHASE_TITLE_REQUIRED", "A game title is required for Exophase catalog lookup");
  }
  const key = title.toLowerCase();
  const cached = searches.get(key);
  if (cached && cached.expires > Date.now()) return cached.promise;
  const lookup = async () => {
    const remaining = () => {
      const ms = Math.min(20000, deadline - Date.now());
      if (ms <= 0) throw catalogError("EXOPHASE_TIMEOUT", "Exophase catalog lookup timed out");
      return ms;
    };
    logger?.info("exophase:catalog:search", { title });
    const response = await page.goto(`${SEARCH_PAGE}?q=${encodeURIComponent(title)}`, {
      waitUntil: "domcontentloaded", timeout: remaining(),
    });
    if (response && response.status() >= 400) {
      throw catalogError("EXOPHASE_HTTP_ERROR", `Exophase catalog HTTP ${response.status()}`, { statusCode: response.status() });
    }
    const games = [];
    for (let number = 1; number <= MAX_PAGES; number++) {
      const result = await page.evaluate(async ({ url, title, timeout }) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout);
        try {
          const target = new URL(url);
          target.searchParams.set("q", title); target.searchParams.set("sort", "updated");
          const response = await fetch(target.toString(), {
            headers: { "X-Requested-With": "XMLHttpRequest" }, signal: controller.signal,
          });
          if (!response.ok) return { status: response.status };
          return { status: response.status, data: await response.json() };
        } catch (error) { return { error: error.name === "AbortError" ? "timeout" : error.message }; }
        finally { clearTimeout(timer); }
      }, { url: number === 1 ? SEARCH_API : `${SEARCH_API}/page/${number}`, title, timeout: remaining() });
      if (result.error) throw catalogError(result.error === "timeout" ? "EXOPHASE_TIMEOUT" : "EXOPHASE_NETWORK_ERROR",
        `Exophase catalog request failed: ${result.error}`);
      if (result.status >= 400) throw catalogError("EXOPHASE_HTTP_ERROR", `Exophase catalog HTTP ${result.status}`, { statusCode: result.status });
      if (result.data?.success !== true || !(result.data.games === false || Array.isArray(result.data.games?.list))) {
        throw catalogError("EXOPHASE_INVALID_RESPONSE", "Exophase catalog response is invalid");
      }
      games.push(...(result.data.games?.list || []));
      const pages = Number(result.data.games?.pages || result.data.games?.paging?.last || 1);
      if (pages <= number) break;
      if (number === MAX_PAGES) throw catalogError("EXOPHASE_AMBIGUOUS", "Exophase catalog search is too broad");
    }
    if (!games.length) throw catalogError("EXOPHASE_NOT_FOUND", `No Exophase catalog result for ${title}`);
    logger?.info("exophase:catalog:results", { title, count: games.length });
    return games;
  };
  const entry = { expires: Infinity, promise: lookup() };
  searches.set(key, entry);
  try {
    const result = await entry.promise;
    entry.expires = Date.now() + CACHE_TTL_MS;
    while (searches.size > 128) searches.delete(searches.keys().next().value);
    return result;
  } catch (error) {
    if (searches.get(key) === entry) searches.delete(key);
    if (String(error.code || "").startsWith("EXOPHASE_")) throw error;
    throw catalogError(error.name === "TimeoutError" ? "EXOPHASE_TIMEOUT" : "EXOPHASE_NETWORK_ERROR",
      `Exophase catalog request failed: ${error.message}`, { cause: error });
  }
}

module.exports = { cleanExophaseTitle, normalizeTitle, rankCatalogCandidates, compareAchievements, selectCatalogResult, searchExophaseCatalog };
