/**
 * Run with:  node utils/match-uplay-steam.js
 * Output:    assets/uplay-steam.json
 */

const https = require("https");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { writeJsonAtomicSync } = require("./atomic-json-store");
const HTTP_TIMEOUT_MS = 15000;

const UPLAY_URL =
  "https://raw.githubusercontent.com/PSerban93/UPLAY_GAME_ID/master/README.md";
const STEAM_URL =
  "https://raw.githubusercontent.com/jsnli/steamappidlist/refs/heads/master/data/games_appid.json";
const DEFAULT_STEAM_DB_ASSET = path.join(
  __dirname,
  "..",
  "assets",
  "steamdb.json",
);
const DEFAULT_STEAM_DB_RUNTIME = (() => {
  const base =
    process.env.APPDATA ||
    (process.platform === "win32"
      ? path.join(os.homedir(), "AppData", "Roaming")
      : path.join(os.homedir(), ".local", "share"));
  return path.join(base, "Achievements", "steamdb.json");
})();
const STEAM_DB_PATH = path.resolve(
  process.env.STEAM_DB_PATH || DEFAULT_STEAM_DB_RUNTIME,
);
const MIN_TOKEN_SCORE = 0.72;

const DEFAULT_OUTPUT = path.join(__dirname, "..", "assets", "uplay-steam.json");
const outputFlag = process.argv
  .slice(2)
  .find((arg) => arg.startsWith("--output="));
const OUTPUT_FILE = path.resolve(
  outputFlag
    ? outputFlag.slice("--output=".length)
    : process.env.UPLAY_STEAM_MAP_PATH || DEFAULT_OUTPUT,
);

const STOP_WORDS = new Set([
  "hd",
  "remastered",
  "edition",
  "ultimate",
  "definitive",
  "complete",
  "gold",
  "deluxe",
  "version",
  "steam",
  "uplay",
  "asia",
  "ru",
  "jp",
  "jpn",
  "cz",
  "pack",
  "collection",
  "trilogy",
]);

const GENERIC_SERIES_WORDS = new Set([
  "tom",
  "clancy",
  "clancy's",
  "ghost",
  "recon",
  "beta",
  "closed",
  "open",
  "game",
  "edition",
  "demo",
]);

const NEGATIVE_NAME_PATTERNS = [
  /activation/i,
  /bundle/i,
  /pack/i,
  /dlc/i,
  /beta/i,
  /demo/i,
  /soundtrack/i,
  /test/i,
  /companion/i,
  /trailer/i,
];

function loadExistingData() {
  if (!fs.existsSync(OUTPUT_FILE)) return [];
  try {
    const raw = fs.readFileSync(OUTPUT_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.warn("⚠️ Failed to load existing mapping:", err.message);
    return [];
  }
}

function loadLocalSteamDb() {
  try {
    if (!fs.existsSync(STEAM_DB_PATH)) {
      // seed runtime copy from assets if available
      if (fs.existsSync(DEFAULT_STEAM_DB_ASSET)) {
        fs.mkdirSync(path.dirname(STEAM_DB_PATH), { recursive: true });
        fs.copyFileSync(DEFAULT_STEAM_DB_ASSET, STEAM_DB_PATH);
      } else {
        fs.mkdirSync(path.dirname(STEAM_DB_PATH), { recursive: true });
        fs.writeFileSync(STEAM_DB_PATH, "[]", "utf8");
      }
    }
  } catch {}

  if (!fs.existsSync(STEAM_DB_PATH)) return [];
  try {
    const raw = fs.readFileSync(STEAM_DB_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.warn("⚠️ Failed to load steamdb.json:", err.message);
    return [];
  }
}

function persistSteamDb(apps) {
  try {
    fs.mkdirSync(path.dirname(STEAM_DB_PATH), { recursive: true });
    fs.writeFileSync(STEAM_DB_PATH, JSON.stringify(apps), "utf8");
    console.log(
      `💾 updated Steam DB: ${apps.length} entries -> ${STEAM_DB_PATH}`,
    );
  } catch (err) {
    console.warn("⚠️ Failed to persist steamdb.json:", err.message);
  }
}

function isWhitespaceByte(byte) {
  return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;
}

function appendSteamDbEntries(entries) {
  if (!Array.isArray(entries) || !entries.length) return true;
  let fd = null;
  try {
    fs.mkdirSync(path.dirname(STEAM_DB_PATH), { recursive: true });
    if (!fs.existsSync(STEAM_DB_PATH)) {
      fs.writeFileSync(STEAM_DB_PATH, "[]", "utf8");
    }

    fd = fs.openSync(STEAM_DB_PATH, "r+");
    const stats = fs.fstatSync(fd);
    if (!stats || stats.size < 2) return false;

    const one = Buffer.alloc(1);
    let lastPos = stats.size - 1;
    let lastByte = -1;
    while (lastPos >= 0) {
      fs.readSync(fd, one, 0, 1, lastPos);
      const byte = one[0];
      if (!isWhitespaceByte(byte)) {
        lastByte = byte;
        break;
      }
      lastPos -= 1;
    }
    if (lastPos < 0 || lastByte !== 0x5d) return false; // ']'

    let prevPos = lastPos - 1;
    let prevByte = -1;
    while (prevPos >= 0) {
      fs.readSync(fd, one, 0, 1, prevPos);
      const byte = one[0];
      if (!isWhitespaceByte(byte)) {
        prevByte = byte;
        break;
      }
      prevPos -= 1;
    }

    const isEmptyArray = prevByte === 0x5b; // '['
    const payload = entries
      .map((row) =>
        JSON.stringify({
          appid: Number(row.appid),
          name: String(row.name || ""),
        }),
      )
      .join(",");
    if (!payload) return true;

    const insertion = isEmptyArray ? payload : `,${payload}`;
    const suffix = "]";
    const finalChunk = `${insertion}${suffix}`;
    fs.writeSync(fd, finalChunk, lastPos, "utf8");
    fs.ftruncateSync(fd, lastPos + Buffer.byteLength(finalChunk));

    console.log(
      `💾 appended Steam DB: +${entries.length} entries -> ${STEAM_DB_PATH}`,
    );
    return true;
  } catch (err) {
    console.warn("⚠️ Failed to append steamdb.json:", err.message);
    return false;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        res.resume();
        return;
      }
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve(data));
    });

    req.setTimeout(HTTP_TIMEOUT_MS, () => {
      req.destroy(new Error(`Request timed out for ${url}`));
    });

    req.on("error", reject);
  });
}

function normalizeBase(str) {
  return String(str || "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[’‘`]/g, "'")
    .replace(/[™©®]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9&'():/+\- ]/gi, " ")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function stripEdition(txt) {
  return txt
    .replace(
      /\s*\((ru|jpn|jp|cz|asia|steam version|steam|uplay version(?:\/australia)?|australia|kr|cn)\)\s*/gi,
      "",
    )
    .replace(
      /\b(ultimate|gold|deluxe|definitive|complete|remastered|hd|pack)\b/gi,
      "",
    )
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeUplayName(str) {
  return normalizeBase(stripEdition(str));
}

function normalizeSteamName(str) {
  return normalizeBase(str);
}

function normalizeLoose(str) {
  return normalizeBase(str)
    .replace(/[:\-_,./+()]/g, " ")
    .replace(/\s+/g, " ");
}

function normalizeTokenWord(word) {
  let w = String(word || "")
    .replace(/[’‘`]/g, "'")
    .replace(/^'+/, "")
    .replace(/'+$/, "");
  if (w.endsWith("'s") && w.length > 2) {
    w = w.slice(0, -2);
  } else if (w.endsWith("s'") && w.length > 2) {
    w = w.slice(0, -1);
  }
  if (w.endsWith("ies") && w.length > 4) {
    w = w.slice(0, -3) + "y";
  } else if (w.endsWith("ves") && w.length > 4) {
    w = w.slice(0, -3) + "f";
  } else if (w.endsWith("es") && w.length > 3) {
    w = w.slice(0, -2);
  } else if (w.endsWith("s") && w.length > 3) {
    w = w.slice(0, -1);
  }
  const roman = romanToInt(w);
  if (roman !== null) {
    return String(roman);
  }
  return w;
}

function romanToInt(str) {
  const upper = str.toUpperCase();
  if (!/^[IVXLCDM]+$/.test(upper)) return null;
  const map = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
  let total = 0;
  let prev = 0;
  for (let i = upper.length - 1; i >= 0; i--) {
    const val = map[upper[i]];
    if (!val) return null;
    if (val < prev) {
      total -= val;
    } else {
      total += val;
      prev = val;
    }
  }
  if (total <= 0 || total > 50) return null;
  return total;
}

function tokenizeImportant(str) {
  return normalizeLoose(str)
    .split(" ")
    .map(normalizeTokenWord)
    .filter((w) => w && !STOP_WORDS.has(w));
}

function buildDistinctiveTokens(str) {
  const tokens = tokenizeImportant(str);
  const filtered = tokens.filter((t) => !GENERIC_SERIES_WORDS.has(t));
  return filtered.length ? filtered : tokens;
}

function containsAllDistinctiveTokens(app, requiredTokens) {
  if (!requiredTokens.length) return true;
  return requiredTokens.every((token) => app.tokens.includes(token));
}

function stripParentheses(str) {
  return String(str || "")
    .replace(/\s*\([^)]*\)\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function generateVariants(rawName) {
  const variants = new Set();
  const cleaned = stripParentheses(
    String(rawName || "")
      .replace(/[™®]/g, "")
      .trim(),
  );
  const base = stripEdition(cleaned);

  const addVariant = (value) => {
    if (!value) return;
    const norm = value.replace(/\s+/g, " ").trim();
    if (norm) variants.add(norm);
  };

  addVariant(base);
  addVariant(stripEdition(stripParentheses(rawName)));

  return Array.from(variants);
}

function scoreTokens(uTokens, sTokens) {
  if (!uTokens.length || !sTokens.length) return 0;
  const overlap = tokenOverlapCount(uTokens, sTokens);
  if (!overlap) return 0;
  const uSet = new Set(uTokens);
  const sSet = new Set(sTokens);
  return (2 * overlap) / (uSet.size + sSet.size);
}

function tokenOverlapCount(uTokens, sTokens) {
  if (!uTokens.length || !sTokens.length) return 0;
  const uSet = new Set(uTokens);
  const sSet = new Set(sTokens);
  let overlap = 0;
  for (const token of uSet) {
    if (sSet.has(token)) overlap++;
  }
  return overlap;
}

function collectTokenCandidates(tokens, tokenIndex) {
  const seen = new Set();
  const candidates = [];
  for (const token of tokens) {
    const bucket = tokenIndex.get(token);
    if (!bucket) continue;
    for (const app of bucket) {
      if (seen.has(app.appid)) continue;
      seen.add(app.appid);
      candidates.push(app);
    }
  }
  return candidates;
}

function hasRequiredBaseOverlap(app, baseTokens) {
  if (!baseTokens.length) return true;
  const baseNumbers = baseTokens.filter((tok) => /^\d+$/.test(tok));
  if (baseNumbers.length) {
    const hasAllNumbers = baseNumbers.every((num) => app.tokens.includes(num));
    if (!hasAllNumbers) return false;
  }
  const overlap = tokenOverlapCount(baseTokens, app.tokens);
  if (baseTokens.length <= 4) {
    return overlap === baseTokens.length;
  }
  const minRequired = Math.max(3, baseTokens.length - 1);
  return overlap >= minRequired;
}

function hasNegativeKeywords(app) {
  const lower = app.name.toLowerCase();
  return NEGATIVE_NAME_PATTERNS.some((re) => re.test(lower));
}

function filterPreferred(list) {
  const sanitized = list.filter((app) => !hasNegativeKeywords(app));
  return sanitized.length ? sanitized : list;
}

function pushIndexedCandidate(map, key, app) {
  if (!key) return;
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(app);
}

function collectUniqueApps(list) {
  const seen = new Set();
  const out = [];
  for (const app of Array.isArray(list) ? list : []) {
    const key = String(app?.appid || "");
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(app);
  }
  return out;
}

function scoreCandidateForVariant(
  app,
  {
    variantTokens,
    requiredTokens,
    baseTokens,
    variantLength,
    sourceBonus = 0,
    requireLooseScore = false,
  },
) {
  if (!app) return null;
  if (!containsAllDistinctiveTokens(app, requiredTokens)) return null;
  if (!hasRequiredBaseOverlap(app, baseTokens)) return null;

  const baseOverlap = tokenOverlapCount(baseTokens, app.tokens);
  const requiredOverlap = tokenOverlapCount(requiredTokens, app.tokens);
  const looseScore = scoreTokens(variantTokens, app.tokens);
  if (requireLooseScore && looseScore < MIN_TOKEN_SCORE) return null;

  const negativePenalty = hasNegativeKeywords(app) ? 1 : 0;
  const lengthDiff = Math.abs(app.name.length - variantLength);
  const specificityBonus = baseTokens.length
    ? Math.round((requiredTokens.length / baseTokens.length) * 250)
    : 0;
  const score =
    sourceBonus +
    requiredOverlap * 1600 +
    baseOverlap * 1000 +
    looseScore * 250 +
    specificityBonus -
    negativePenalty * 500 -
    lengthDiff;

  return {
    app,
    score,
  };
}

function updateBestCandidate(bestByAppId, scored) {
  if (!scored?.app) return;
  const key = String(scored.app.appid || "");
  if (!key) return;
  const existing = bestByAppId.get(key);
  if (
    !existing ||
    scored.score > existing.score ||
    (scored.score === existing.score &&
      Number(scored.app.appid) < Number(existing.app.appid))
  ) {
    bestByAppId.set(key, scored);
  }
}

function scoreCandidateList(bestByAppId, list, context) {
  const unique = collectUniqueApps(filterPreferred(list));
  for (const app of unique) {
    const scored = scoreCandidateForVariant(app, context);
    if (scored) updateBestCandidate(bestByAppId, scored);
  }
}

function tryMatchVariant(variant, indexes, baseTokens) {
  const { byExact, byLoose, bySignature } = indexes;
  const norm = normalizeUplayName(variant);
  const loose = normalizeLoose(variant);
  const tokens = tokenizeImportant(variant);
  const requiredTokens = buildDistinctiveTokens(variant);
  const signature = tokenSignature(tokens);
  const variantLength = variant.length;
  const bestByAppId = new Map();

  const scoreContext = {
    variantTokens: tokens,
    requiredTokens,
    baseTokens,
    variantLength,
  };

  if (norm && byExact.has(norm)) {
    scoreCandidateList(bestByAppId, byExact.get(norm), {
      ...scoreContext,
      sourceBonus: 5000,
    });
  }

  if (loose && byLoose.has(loose)) {
    scoreCandidateList(bestByAppId, byLoose.get(loose), {
      ...scoreContext,
      sourceBonus: 4200,
    });
  }

  if (signature && bySignature.has(signature)) {
    scoreCandidateList(bestByAppId, bySignature.get(signature), {
      ...scoreContext,
      sourceBonus: 3600,
    });
  }

  let best = null;
  for (const scored of bestByAppId.values()) {
    if (
      !best ||
      scored.score > best.score ||
      (scored.score === best.score &&
        Number(scored.app.appid) < Number(best.app.appid))
    ) {
      best = scored;
    }
  }
  return best?.app || null;
}

function findBestSteamForUplay(uplayName, indexes) {
  const cleanedBase = stripEdition(stripParentheses(uplayName));
  const baseTokens = buildDistinctiveTokens(cleanedBase || uplayName);
  const variants = generateVariants(uplayName);
  let best = null;
  for (const variant of variants) {
    const variantBase = stripEdition(stripParentheses(variant));
    const variantBaseTokens = buildDistinctiveTokens(variantBase || variant);
    const effectiveBaseTokens = variantBaseTokens.length
      ? variantBaseTokens
      : baseTokens;
    const match = tryMatchVariant(variant, indexes, effectiveBaseTokens);
    if (!match) continue;
    const tokens = tokenizeImportant(variant);
    const requiredTokens = buildDistinctiveTokens(variant);
    const scored = scoreCandidateForVariant(match, {
      variantTokens: tokens,
      requiredTokens,
      baseTokens: effectiveBaseTokens,
      variantLength: variant.length,
    });
    if (!scored) continue;
    if (
      !best ||
      scored.score > best.score ||
      (scored.score === best.score &&
        Number(scored.app.appid) < Number(best.app.appid))
    ) {
      best = scored;
    }
  }
  return best?.app || null;
}

function tokenSignature(tokens) {
  if (!tokens.length) return "";
  return [...new Set(tokens)].sort().join("|");
}

async function fetchUplayList() {
  const txt = await httpGet(UPLAY_URL);
  const lines = txt.split(/\r?\n/);
  const out = [];

  for (const line of lines) {
    const match = line.match(/^\s*(\d+)\s*-\s*(.+?)\s*$/);
    if (!match) continue;
    out.push({
      uplay_id: match[1],
      uplay_name: match[2],
    });
  }

  if (!out.length) {
    throw new Error("Uplay list parse failed - format changed?");
  }

  return out;
}

async function fetchSteamList() {
  const local = loadLocalSteamDb().filter(
    (app) => Number.isInteger(app.appid) && app.name?.trim(),
  );
  let remote = null;

  try {
    const raw = await httpGet(STEAM_URL);
    const json = JSON.parse(raw);
    const apps = Array.isArray(json) ? json : json?.applist?.apps || [];
    if (apps.length) {
      remote = apps.filter(
        (app) => Number.isInteger(app.appid) && app.name?.trim(),
      );
    } else {
      throw new Error("Steam app list source returned no entries.");
    }
  } catch (err) {
    console.warn(
      "⚠️ Steam app list fetch failed, using local steamdb.json:",
      err.message,
    );
  }

  if (remote && remote.length) {
    const map = new Map(local.map((a) => [a.appid, a.name]));
    const additions = [];
    let renamed = 0;
    for (const app of remote) {
      const existingName = map.get(app.appid);
      if (existingName === undefined) {
        map.set(app.appid, app.name);
        additions.push({ appid: app.appid, name: app.name });
      } else if (existingName !== app.name) {
        map.set(app.appid, app.name);
        renamed += 1;
      }
    }
    const merged = Array.from(map.entries())
      .map(([appid, name]) => ({ appid, name }))
      .sort((a, b) => a.appid - b.appid);
    if (additions.length || renamed > 0) {
      if (renamed === 0 && additions.length > 0) {
        const appended = appendSteamDbEntries(additions);
        if (!appended) {
          persistSteamDb(merged);
        }
      } else {
        persistSteamDb(merged);
      }
    }
    return merged;
  }

  if (local.length) return local;
  throw new Error(
    "Steam app list unavailable (remote failed and no steamdb.json).",
  );
}

function buildSteamIndexes(steamApps) {
  const enriched = steamApps.map((app) => {
    const normalized = normalizeSteamName(app.name);
    const loose = normalizeLoose(app.name);
    const tokens = tokenizeImportant(app.name);
    const signature = tokenSignature(tokens);
    return { ...app, normalized, loose, tokens, signature };
  });

  const byExact = new Map();
  const byLoose = new Map();
  const bySignature = new Map();
  const tokenIndex = new Map();

  for (const app of enriched) {
    pushIndexedCandidate(byExact, app.normalized, app);
    pushIndexedCandidate(byLoose, app.loose, app);
    pushIndexedCandidate(bySignature, app.signature, app);

    for (const token of new Set(app.tokens)) {
      if (!tokenIndex.has(token)) tokenIndex.set(token, []);
      tokenIndex.get(token).push(app);
    }
  }

  return { steamApps: enriched, byExact, byLoose, bySignature, tokenIndex };
}

async function main() {
  console.log("⬇️ downloading Uplay list.");
  const uplay = await fetchUplayList();
  console.log("✅ Uplay entries:", uplay.length);

  console.log("⬇️ downloading Steam list.");
  const steam = await fetchSteamList();
  console.log("✅ Steam entries:", steam.length);

  const indexes = buildSteamIndexes(steam);
  const existing = loadExistingData();
  const existingMap = new Map(
    existing.map((item) => [String(item.uplay_id), item]),
  );
  const result = existing.slice();
  let added = 0;

  for (const entry of uplay) {
    if (existingMap.has(entry.uplay_id)) continue;

    const match = findBestSteamForUplay(entry.uplay_name, indexes);

    const record = {
      uplay_id: entry.uplay_id,
      uplay_name: entry.uplay_name,
      steam_appid: match ? match.appid : null,
      steam_name: match ? match.name : null,
    };
    result.push(record);
    existingMap.set(entry.uplay_id, record);
    added++;
  }

  if (existing.length && added === 0) {
    console.log("ℹ️ No new Uplay entries detected. Mapping unchanged.");
    return;
  }

  fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
  writeJsonAtomicSync(OUTPUT_FILE, result, { trailingNewline: true });
  console.log(
    added
      ? `💾 appended ${added} new entries to ${OUTPUT_FILE}`
      : `💾 generated mapping with ${result.length} entries`,
  );
}

main().catch((err) => {
  console.error("ERROR:", err);
  process.exit(1);
});
