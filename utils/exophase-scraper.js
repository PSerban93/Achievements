const fs = require("fs");
const path = require("path");

// Electron main process may not define File; undici expects it.
if (typeof global.File === "undefined") {
  global.File = class File {};
}

const cheerio = require("cheerio");
const {
  cleanExophaseTitle, normalizeTitle, rankCatalogCandidates, compareAchievements,
  selectCatalogResult, searchExophaseCatalog,
} = require("./exophase-catalog");

const {
  launchBrowserSafe: launchPlaywrightBrowser,
} = require("./playwright-runtime");

const DEFAULT_WAIT_MS = 30000;
const EXOPHASE_RARITY_SOURCE = "exophase-achievement-percentages";
const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121 Safari/537.36";

const EXOPHASE_PLATFORM_MAP = {
  x360recomp: "xbox-360",
  xenia: "xbox-360",
  ps3recomp: "ps3",
  rpcs3: "ps3",
  ps4recomp: "ps4",
  shadps4: "ps4",
  kytyps5: "ps5",
};

const EXOPHASE_LANG_MAP = {
  arabic: "ar",
  bulgarian: "bg",
  brazilian: "pt_BR",
  czech: "cs",
  danish: "dk",
  dutch: "nl",
  english: "us",
  finnish: "fi",
  french: "fr",
  german: "de",
  greek: "el",
  hungarian: "hu",
  indonesian: "in",
  italian: "it",
  japanese: "jp",
  koreana: "ko",
  latam: "es_MX",
  norwegian: "no",
  polish: "pl",
  portuguese: "pt",
  romanian: "ro",
  russian: "ru",
  spanish: "es",
  schinese: "zh-CN",
  tchinese: "zh-TW",
  thai: "th",
  turkish: "tr",
  swedish: "se",
  ukrainian: "uk",
  vietnamese: "vi",
};

const EXOPHASE_LANG_KEYS = [
  "arabic",
  "bulgarian",
  "brazilian",
  "czech",
  "danish",
  "dutch",
  "english",
  "finnish",
  "french",
  "german",
  "greek",
  "hungarian",
  "indonesian",
  "italian",
  "japanese",
  "koreana",
  "latam",
  "norwegian",
  "polish",
  "portuguese",
  "romanian",
  "russian",
  "spanish",
  "schinese",
  "tchinese",
  "thai",
  "turkish",
  "swedish",
  "ukrainian",
  "vietnamese",
];

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

async function launchBrowserSafe(opts = {}) {
  const baseArgs = ["--disable-blink-features=AutomationControlled"];

  return launchPlaywrightBrowser(
    "playwright-core",
    {
      headless: true,
      args: baseArgs,
      ...opts,
    },
    {
      headless: true,
      args: baseArgs,
    },
  );
}

function mapExophasePlatform(platform) {
  const key = String(platform || "")
    .trim()
    .toLowerCase();
  if (!key) return "";
  return EXOPHASE_PLATFORM_MAP[key] || key;
}

function ensureLangUrl(baseUrl, code) {
  let u = baseUrl;
  if (!u.endsWith("/")) u += "/";
  u = u.replace(/\/achievements\/[^/]+\/$/i, "/achievements/");
  u = u.replace(/\/trophies\/[^/]+\/$/i, "/trophies/");
  return u + encodeURIComponent(code) + "/";
}

function normalizeExophaseRarityPercent(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") {
    return Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : null;
  }
  const raw = String(value || "")
    .replace(",", ".")
    .trim();
  if (!raw) return null;
  if (/^\d+(?:\.\d+)?$/.test(raw)) {
    const parsed = Number(raw);
    return Number.isFinite(parsed)
      ? Number(Math.min(100, Math.max(0, parsed)).toFixed(4))
      : null;
  }
  const match = raw.match(/(\d+(?:\.\d+)?)\s*%/);
  if (!match) return null;
  const parsed = Number(match[1]);
  if (!Number.isFinite(parsed)) return null;
  return Number(parsed.toFixed(4));
}

function extractRarityPctFromText(value) {
  return normalizeExophaseRarityPercent(value);
}

function elementLooksLikeRarityNode($, el) {
  const node = $(el);
  const haystack = [
    node.attr("class"),
    node.attr("id"),
    node.attr("title"),
    node.attr("aria-label"),
    node.attr("data-title"),
    node.attr("data-label"),
    node.attr("data-percent"),
    node.attr("data-percentage"),
    node.attr("data-rarity"),
  ]
    .filter(Boolean)
    .join(" ");
  return /\b(rarity|rare|percent|percentage|unlock|unlocked|earned|owners|players|completion|completed)\b/i.test(
    haystack,
  );
}

function extractRarityPctFromCard($, card) {
  const average = card.find(".award-average.text-center > span").first();
  if (average && average.length) {
    const pct = extractRarityPctFromText(average.text());
    if (pct !== null) return pct;
  }

  const nodes = card.find("*").toArray();
  for (const el of nodes) {
    if (!elementLooksLikeRarityNode($, el)) continue;
    const node = $(el);
    const values = [
      node.attr("data-percent"),
      node.attr("data-percentage"),
      node.attr("data-rarity"),
      node.attr("title"),
      node.attr("aria-label"),
      node.text(),
    ];
    for (const value of values) {
      const pct = extractRarityPctFromText(value);
      if (pct !== null) return pct;
    }
  }

  const clone = card.clone();
  clone.find("[class*=award-title], [class*=award-description]").remove();
  return extractRarityPctFromText(clone.text());
}

function isAdHost(host) {
  const h = (host || "").toLowerCase();
  return (
    h.includes("doubleclick") ||
    h.includes("googlesyndication") ||
    h.includes("googleadservices") ||
    h.includes("adservice") ||
    h.includes("adsystem") ||
    h.includes("adnxs") ||
    h.includes("taboola") ||
    h.includes("outbrain") ||
    h.includes("criteo") ||
    h.includes("pubmatic") ||
    h.includes("rubiconproject") ||
    h.includes("openx") ||
    h.includes("mgid") ||
    h.includes("zedo") ||
    h.includes("scorecardresearch") ||
    h.includes("quantserve")
  );
}

async function installAdBlockRouting(context) {
  await context.route("**/*", async (route) => {
    const req = route.request();
    const url = req.url();
    const type = req.resourceType();

    let host = "";
    try {
      host = new URL(url).hostname;
    } catch {}

    if (type === "document") return route.continue();
    if (host && isAdHost(host)) return route.abort();
    if (type === "frame" && host && !host.endsWith("exophase.com"))
      return route.abort();
    if (type === "media" || type === "font") return route.abort();
    if (type === "image" && host && !host.endsWith("exophase.com"))
      return route.abort();

    return route.continue();
  });
}

async function nukeOverlays(page) {
  await page.evaluate(() => {
    const killSelectors = [
      "iframe",
      ".adsbygoogle",
      "[id*='ad' i]",
      "[class*='ad' i]",
      "[id*='ads' i]",
      "[class*='ads' i]",
      "[class*='overlay' i]",
      "[id*='overlay' i]",
      "[class*='modal' i]",
      "[id*='modal' i]",
    ];

    for (const sel of killSelectors) {
      document.querySelectorAll(sel).forEach((el) => {
        const st = window.getComputedStyle(el);
        const zi = parseInt(st.zIndex || "0", 10);
        const pos = st.position;
        if (pos === "fixed" || pos === "sticky" || zi >= 1000) el.remove();
      });
    }

    document.documentElement.style.overflow = "auto";
    document.body.style.overflow = "auto";
  });
}

async function looksBlocked(page) {
  try {
    const html = (await page.content()).toLowerCase();
    if (
      html.includes("error 403") ||
      html.includes("access denied") ||
      html.includes("request blocked")
    )
      return true;
    if (html.includes("attention required") && html.includes("cloudflare"))
      return true;
  } catch {}
  return false;
}

async function loadAwardsPage(page, url, deadline = Infinity) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw Object.assign(new Error("Exophase lookup timed out"), { code: "EXOPHASE_TIMEOUT" });
  let resp;
  try {
    resp = await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: Math.min(DEFAULT_WAIT_MS, remaining),
    });
  } catch (error) {
    throw Object.assign(new Error(`Exophase page request failed: ${error.message}`), {
      code: error.name === "TimeoutError" ? "EXOPHASE_TIMEOUT" : "EXOPHASE_NETWORK_ERROR", cause: error,
    });
  }
  if (resp && resp.status() >= 400) {
    throw Object.assign(new Error(`Exophase HTTP ${resp.status()}`), {
      code: "EXOPHASE_HTTP_ERROR", statusCode: resp.status(),
    });
  }
  if (Date.now() >= deadline) throw Object.assign(new Error("Exophase lookup timed out"), { code: "EXOPHASE_TIMEOUT" });
  await page
    .waitForSelector("[class*=award-detail]", {
      timeout: Math.max(1, Math.min(15000, deadline - Date.now())),
    })
    .catch(() => {});
  const html = await page.content();
  const status = resp ? resp.status() : 0;
  return { html, status };
}

function extractAchievementsFromHtml(html, baseUrl) {
  const $ = cheerio.load(html || "");
  const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
  const abs = (u) => {
    try {
      return new URL(u, baseUrl).toString();
    } catch {
      return u;
    }
  };

  const details = $("[class*=award-detail]").toArray();
  const items = [];

  details.forEach((detail, idx) => {
    const title = clean($(detail).find("[class*=award-title]").first().text());
    if (!title) return;
    const description = clean(
      $(detail).find("[class*=award-description]").first().text(),
    );

    const card = $(detail).closest("li").length
      ? $(detail).closest("li")
      : $(detail).closest("[class*=award]").length
        ? $(detail).closest("[class*=award]")
        : $(detail).parent();

    let iconUrl = "";
    const img = card.find("[class*=award-image] img").first();
    if (img && img.length) {
      iconUrl = abs(img.attr("src") || "");
    } else {
      const imgEl = card.find("[class*=award-image]").first();
      const bg = imgEl.css("background-image") || "";
      const m = bg.match(/url\(["']?(.*?)["']?\)/i);
      const directSrc = imgEl.attr("src") || "";
      if (directSrc) iconUrl = abs(directSrc);
      else if (m && m[1]) iconUrl = abs(m[1]);
    }

    const rarityPct = extractRarityPctFromCard($, card);

    items.push({
      index: idx + 1,
      title,
      description,
      icon_url: iconUrl,
      rarityPct,
      raritySource: rarityPct !== null ? EXOPHASE_RARITY_SOURCE : "",
    });
  });

  return items;
}

async function downloadExophaseIcon(iconUrl, outPath) {
  if (!iconUrl || !outPath) return false;
  if (typeof fetch !== "function") return false;
  try {
    const resp = await fetch(iconUrl);
    if (!resp.ok) return false;
    const buf = Buffer.from(await resp.arrayBuffer());
    ensureDir(path.dirname(outPath));
    fs.writeFileSync(outPath, buf);
    return true;
  } catch {
    return false;
  }
}

async function fetchExophaseAchievementsMultiLang(options = {}) {
  const platform = mapExophasePlatform(options.platform || "");
  if (!platform) {
    throw new Error("Missing platform for Exophase");
  }
  const title = cleanExophaseTitle(options.title);
  if (!title) throw new Error("Missing game title for Exophase catalog lookup");
  const schemaAchievements = Array.isArray(options.schemaAchievements) ? options.schemaAchievements : [];

  const langMap = options.langMap || EXOPHASE_LANG_MAP;
  const langKeysRaw = options.langKeys || EXOPHASE_LANG_KEYS;
  const langKeys = langKeysRaw.filter((k) => langMap[k]);
  if (!langKeys.includes("english")) langKeys.unshift("english");

  const headed = options.headed === true;
  const logger = options.logger || null;
  const storageState = options.storageState;

  const ctxOpts = {
    userAgent: options.userAgent || DEFAULT_UA,
    locale: "en-US",
    viewport: { width: 1400, height: 1000 },
  };
  let browser = null;
  let context = null;
  let page = null;
  let ownsBrowser = false;
  let ownsContext = false;
  let ownsPage = false;

  if (options.page) {
    page = options.page;
    context = page.context();
  } else if (options.context) {
    context = options.context;
    page = await context.newPage();
    ownsPage = true;
  } else if (options.browser) {
    browser = options.browser;
    context = await browser.newContext(ctxOpts);
    ownsContext = true;
    page = await context.newPage();
    ownsPage = true;
  } else {
    browser = await launchBrowserSafe({ headless: !headed });
    ownsBrowser = true;
    if (storageState && fs.existsSync(storageState)) {
      ctxOpts.storageState = storageState;
    }
    context = await browser.newContext(ctxOpts);
    ownsContext = true;
    page = await context.newPage();
    ownsPage = true;
  }

  if (context) {
    await context
      .addInitScript(() => {
        try {
          Object.defineProperty(navigator, "webdriver", {
            get: () => undefined,
          });
        } catch {}
      })
      .catch(() => {});

    await installAdBlockRouting(context).catch(() => {});
  }

  if (page && options.page) {
    await page
      .addInitScript(() => {
        try {
          Object.defineProperty(navigator, "webdriver", {
            get: () => undefined,
          });
        } catch {}
      })
      .catch(() => {});
  }

  try {
    const deadline = Date.now() + 60000;
    const games = await searchExophaseCatalog(page, title, { deadline, logger });
    const ranked = rankCatalogCandidates(games, title, platform);
    const exact = ranked.filter(candidate => candidate.rank === 2);
    const candidates = exact.length ? exact : ranked;
    if (!candidates.length) throw Object.assign(new Error(`No Exophase ${platform} achievement list matches ${title}`), { code: "EXOPHASE_NOT_FOUND" });
    if (candidates.length > 6) throw Object.assign(new Error("Exophase catalog returned too many matching lists"), { code: "EXOPHASE_AMBIGUOUS" });
    const results = [];
    for (const candidate of candidates) {
      const testUrl = ensureLangUrl(candidate.baseUrl, langMap.english);
      const { html } = await loadAwardsPage(page, testUrl, deadline);
      const $ = cheerio.load(html);
      const gameTitle = $("h1, h2").first().text().replace(/\s+/g, " ").trim();
      const pageTitles = [candidate.title, ...candidate.title.split(/\s*[|｜]\s*/)].map(normalizeTitle);
      if (!pageTitles.includes(normalizeTitle(gameTitle))) {
        logger?.warn("exophase:catalog:page-mismatch", { title, platform, url: candidate.baseUrl, gameTitle });
        continue;
      }
      if (/^ps[345]$/.test(platform) &&
          !new RegExp(`[-|][^-|]*\\b${platform}\\b[^-|]*[-|]\\s*Exophase\\.com`, "i").test($("title").text())) continue;
      const items = extractAchievementsFromHtml(html, testUrl);
      if (!items.length) throw Object.assign(new Error("No achievements extracted for english baseline."), { code: "EXOPHASE_EMPTY_PAGE" });
      const comparison = compareAchievements(schemaAchievements, items);
      logger?.info("exophase:catalog:candidate", { title, platform, url: candidate.baseUrl, ...comparison });
      results.push({ candidate, comparison, items, gameTitle });
    }
    const selected = selectCatalogResult(results);
    const baseUrl = selected.candidate.baseUrl;
    const baseItems = selected.items;
    const gameTitle = selected.gameTitle;
    logger?.info("exophase:catalog:selected", {
      title, platform, baseUrl, masterId: selected.candidate.masterId,
      fetchedCount: baseItems.length, ...selected.comparison,
    });

    const achievements = baseItems.map((it) => ({
      index: it.index,
      titles: { english: it.title },
      descriptions: { english: it.description },
      icon_url: it.icon_url || "",
      rarityPct: normalizeExophaseRarityPercent(it.rarityPct),
      raritySource:
        normalizeExophaseRarityPercent(it.rarityPct) !== null
          ? EXOPHASE_RARITY_SOURCE
          : "",
    }));

    const normalizePair = (a, b) =>
      `${String(a || "")
        .trim()
        .toLowerCase()}|${String(b || "")
        .trim()
        .toLowerCase()}`;
    const englishSignature = baseItems
      .map((it) => normalizePair(it.title, it.description))
      .join("\n");

    for (const langKey of langKeys) {
      if (langKey === "english") continue;
      const exoCode = langMap[langKey];
      if (!exoCode) continue;
      const langUrl = ensureLangUrl(baseUrl, exoCode);
      if (logger) {
        logger.info("exophase:lang:load", { lang: langKey, url: langUrl });
      }
      const { html: langHtml } = await loadAwardsPage(page, langUrl);
      const items = extractAchievementsFromHtml(langHtml, langUrl);
      if (!items.length) {
        if (logger) {
          logger.warn("exophase:lang:empty", { lang: langKey, url: langUrl });
        }
        continue;
      }
      const langSignature = items
        .map((it) => normalizePair(it.title, it.description))
        .join("\n");
      if (langSignature === englishSignature) {
        if (logger) {
          logger.warn("exophase:lang:default-english", {
            lang: langKey,
            url: langUrl,
          });
        }
        continue;
      }
      if (items.length !== achievements.length && logger) {
        logger.warn("exophase:lang:mismatch", {
          lang: langKey,
          got: items.length,
          expected: achievements.length,
        });
      }
      const min = Math.min(items.length, achievements.length);
      for (let i = 0; i < min; i += 1) {
        achievements[i].titles[langKey] = items[i].title;
        achievements[i].descriptions[langKey] = items[i].description;
        const rarityPct = normalizeExophaseRarityPercent(items[i].rarityPct);
        if (achievements[i].rarityPct === null && rarityPct !== null) {
          achievements[i].rarityPct = rarityPct;
          achievements[i].raritySource = EXOPHASE_RARITY_SOURCE;
        }
      }
    }

    return {
      baseUrl,
      gameTitle: String(gameTitle || "").trim(),
      masterId: selected.candidate.masterId,
      usedSlug: new URL(baseUrl).pathname.split("/")[2],
      items: achievements,
    };
  } finally {
    if (ownsPage && page) {
      await page.close().catch(() => {});
    }
    if (ownsContext && context) {
      await context.close().catch(() => {});
    }
    if (ownsBrowser && browser) {
      await browser.close().catch(() => {});
    }
  }
}

module.exports = {
  EXOPHASE_LANG_KEYS,
  EXOPHASE_LANG_MAP,
  EXOPHASE_RARITY_SOURCE,
  mapExophasePlatform,
  fetchExophaseAchievementsMultiLang,
  downloadExophaseIcon,
};
