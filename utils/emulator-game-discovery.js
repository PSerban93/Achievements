const axios = require("axios");
const { generationResult } = require("./emulator-generation-result");

function isPositiveNumericId(appid, maximum) {
  const raw = String(appid ?? "").trim();
  if (!/^\d+$/.test(raw)) return false;
  const id = raw.replace(/^0+(?=\d)/, "");
  return id !== "0" && (id.length < maximum.length ||
    (id.length === maximum.length && id <= maximum));
}

// Validate each provider independently: Steam AppIDs are uint32, while
// GOG product IDs are uint64. Compare strings to preserve integer precision.
function isSteamAppId(appid) {
  return isPositiveNumericId(appid, "4294967295");
}

function isGogProductId(appid) {
  return isPositiveNumericId(appid, "18446744073709551615");
}

async function readPublicJson(url) {
  // A failed request is never converted into a valid empty payload.
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await axios.get(url, {
        timeout: 15000,
        responseType: "json",
        transitional: { silentJSONParsing: false },
        validateStatus: (status) => status >= 200 && status < 500,
      });
      if (response.status === 404) return { absent: true, httpStatus: 404 };
      if (response.status !== 200 || !response.data || typeof response.data !== "object") {
        throw new Error(`Catalog response HTTP ${response.status} or invalid JSON`);
      }
      return { data: response.data, httpStatus: response.status };
    } catch (error) {
      if (attempt >= 1 || !/timeout|ECONNRESET|ETIMEDOUT|HTTP 429|HTTP 5\d\d|status code 5\d\d/i.test(error.message)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

async function probeSteamGame(appid) {
  const source = "steam-store";
  if (!isSteamAppId(appid)) {
    return generationResult(appid, "not-applicable", {
      platform: "steam", source, reason: "invalid-steam-appid",
    });
  }
  const steamId = String(appid).trim().replace(/^0+(?=\d)/, "");
  try {
    const { data, absent } = await readPublicJson(
      `https://store.steampowered.com/api/appdetails?appids=${encodeURIComponent(steamId)}`,
    );
    const entry = data?.[steamId] || data?.[String(appid)];
    if (absent || entry?.success === false) return generationResult(appid, "not-found", { platform: "steam", source });
    if (entry?.success !== true || typeof entry.data?.name !== "string" || !entry.data.name.trim()) {
      throw new Error("Steam Store returned an incomplete application response");
    }
    const game = entry.data;
    const total = game.achievements?.total;
    const explicitZero = typeof total === "number" && total === 0;
    // Category metadata helps identify the game, but absence of category 22
    // alone must not create a permanent blacklist entry. Confirm through an
    // achievements provider instead.
    const noSupport = !Object.hasOwn(game, "achievements") && Array.isArray(game.categories) &&
      !game.categories.some((category) => Number(category?.id) === 22);
    return generationResult(appid, explicitZero ? "identified-no-achievements" : "identified", {
      platform: "steam", source, identified: true, displayName: game.name,
      count: explicitZero ? 0 : total,
      reason: explicitZero ? "explicit-zero" : noSupport ? "no-achievements-category" : "store-identified",
    });
  } catch (error) {
    return generationResult(appid, "technical-error", { platform: "steam", source, error: error.message });
  }
}

function gogTitle(data) {
  if (Array.isArray(data)) {
    for (const entry of data) {
      const title = gogTitle(entry);
      if (title) return title;
    }
    return "";
  }
  const payload = data?.data || data;
  const candidates = [payload?.title, payload?.name, payload?.productTitle,
    payload?.game?.title, payload?.game?.name, payload?._embedded?.product?.title,
    payload?.product?.title, payload?.product?.name, payload?.products?.[0]?.name];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
    if (candidate && typeof candidate === "object") {
      const text = [candidate["*"], candidate.value, ...Object.values(candidate)]
        .find((value) => typeof value === "string" && value.trim());
      if (text) return text.trim();
    }
  }
  return "";
}

async function probeGogGame(appid) {
  if (!isGogProductId(appid)) {
    return generationResult(appid, "not-applicable", {
      platform: "gog", reason: "invalid-gog-product-id",
    });
  }
  const attempts = [];
  const sources = [
    ["gamesdb.external_releases", `https://gamesdb.gog.com/platforms/gog/external_releases/${encodeURIComponent(appid)}`],
    ["api.gog.com/products", `https://api.gog.com/products/${encodeURIComponent(appid)}?locale=en_US`],
    ["api.gog.com/v2/games", `https://api.gog.com/v2/games/${encodeURIComponent(appid)}?locale=en-US`],
  ];
  for (const [source, url] of sources) {
    try {
      const result = await readPublicJson(url);
      const displayName = gogTitle(result.data);
      if (displayName) return generationResult(appid, "identified", { platform: "gog", source, identified: true, displayName });
      attempts.push({ source, status: result.absent ? "not-found" : "ambiguous" });
    } catch (error) {
      attempts.push({ source, status: "technical-error", error: error.message });
    }
  }
  const status = attempts.some((entry) => entry.status === "technical-error") ? "technical-error"
    : attempts.some((entry) => entry.status === "ambiguous") ? "ambiguous" : "not-found";
  return generationResult(appid, status, { platform: "gog", attempts });
}

module.exports = { probeSteamGame, probeGogGame };
