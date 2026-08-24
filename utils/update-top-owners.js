const path = require("path");
const fs = require("fs");

const {
  launchChromiumSafe: launchPlaywrightChromium,
} = require("./playwright-runtime");

const cheerio = require("cheerio");
const { createLogger } = require("./logger");

const DEFAULT_URL = "https://steamladder.com/ladder/games/";
const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36";
const logger = createLogger("schema-parse");

function normalizeOutputPath(outputPath = "") {
  return path.resolve(String(outputPath || "").trim());
}

function extractSteamIdsFromHtml(html = "", limit = 250) {
  const $ = cheerio.load(String(html || ""));
  const steamIds = [];
  const seen = new Set();

  $('a[href^="/profile/"]').each((_, node) => {
    const href = String($(node).attr("href") || "");
    const digits = href.replace(/\D+/g, "");
    if (digits.length !== 17) return;
    if (seen.has(digits)) return;
    seen.add(digits);
    steamIds.push(digits);
    if (steamIds.length >= limit) return false;
  });

  return steamIds;
}

async function scrapeSteamIdsWithPlaywright(options = {}) {
  const url = String(options.url || DEFAULT_URL);
  const timeoutMs = Math.max(
    10000,
    Number(options.timeoutMs || 30000) || 30000,
  );
  const headless = options.headless !== false;
  let browser = null;
  try {
    browser = await launchPlaywrightChromium("playwright", {
      headless,
      args: ["--disable-blink-features=AutomationControlled"],
    });
    const context = await browser.newContext({
      userAgent: DEFAULT_UA,
      viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();
    const response = await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: timeoutMs,
    });
    if (response && response.status() >= 400) {
      throw new Error(`SteamLadder returned HTTP ${response.status()}`);
    }
    await page.waitForSelector('a[href^="/profile/"]', {
      timeout: Math.min(timeoutMs, 15000),
    });
    return await page.content();
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch {}
    }
  }
}

async function updateTopOwnersIds(options = {}) {
  const outputPath = normalizeOutputPath(
    options.outputPath || "top_owners_ids.txt",
  );
  const limit = Math.max(10, Number(options.limit || 250) || 250);
  const timeoutMs = Math.max(
    10000,
    Number(options.timeoutMs || 30000) || 30000,
  );
  const headless = options.headless !== false;

  logger.info("schema-parse:top-owners:update:start", {
    outputPath,
    limit,
  });

  const html = await scrapeSteamIdsWithPlaywright({
    url: options.url || DEFAULT_URL,
    timeoutMs,
    headless,
  });
  const steamIds = extractSteamIdsFromHtml(html, limit);
  if (steamIds.length < 10) {
    throw new Error(`Not enough Steam IDs found (${steamIds.length})`);
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${steamIds.join("\n")}\n`, "utf8");

  logger.info("schema-parse:top-owners:update:success", {
    outputPath,
    count: steamIds.length,
  });

  return {
    outputPath,
    count: steamIds.length,
  };
}

module.exports = {
  extractSteamIdsFromHtml,
  scrapeSteamIdsWithPlaywright,
  updateTopOwnersIds,
};
