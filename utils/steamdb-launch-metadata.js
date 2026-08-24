const path = require("path");

const { createLogger } = require("./logger");
const { normalizeProcessNameValue } = require("./process-name-utils");

const {
  launchChromiumSafe: launchPlaywrightChromium,
} = require("./playwright-runtime");

const autoConfigLogger = createLogger("autoconfig");
const baseLaunchArgs = ["--disable-blink-features=AutomationControlled"];

async function launchChromiumSafe(opts = {}) {
  return launchPlaywrightChromium("playwright-core", {
    headless: true,
    args: baseLaunchArgs,
    ...opts,
  });
}

function normalizeText(value) {
  return String(value || "")
    .replace(/\u00A0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeLaunchOption(raw = {}) {
  return {
    executable: normalizeText(raw.Executable || raw.executable),
    arguments: normalizeText(raw.Arguments || raw.arguments),
    workingDirectory: normalizeText(
      raw["Working Directory"] || raw.workingDirectory,
    ),
    launchType: normalizeText(raw["Launch Type"] || raw.launchType),
    operatingSystem: normalizeText(
      raw["Operating System"] || raw.operatingSystem,
    ).toLowerCase(),
    cpuArchitecture: normalizeText(
      raw["CPU Architecture"] || raw.cpuArchitecture,
    ),
  };
}

function scoreLaunchOption(option) {
  const os = String(option?.operatingSystem || "").toLowerCase();
  const launchType = String(option?.launchType || "").toLowerCase();
  let score = 0;
  if (option?.executable) score += 100;
  if (os.includes("windows")) score += 50;
  if (launchType.includes("default")) score += 25;
  if (launchType.includes("launch")) score += 10;
  return score;
}

function getSortedLaunchOptions(options = []) {
  const normalized = options
    .map(normalizeLaunchOption)
    .filter((option) => option.executable);
  if (!normalized.length) return null;
  normalized.sort((a, b) => scoreLaunchOption(b) - scoreLaunchOption(a));
  return normalized;
}

function pickBestLaunchOption(options = []) {
  const sorted = getSortedLaunchOptions(options);
  return sorted?.[0] || null;
}

function getCandidateLaunchOptions(options = []) {
  const sorted = getSortedLaunchOptions(options) || [];
  if (!sorted.length) return [];

  const windowsPreferred = sorted.filter((option) => {
    const os = String(option?.operatingSystem || "").toLowerCase();
    return !os || os.includes("windows");
  });
  const osFiltered = windowsPreferred.length ? windowsPreferred : sorted;

  const nonDlcPreferred = osFiltered.filter((option) => {
    const launchType = String(option?.launchType || "").toLowerCase();
    return !launchType.includes("dlc");
  });
  return nonDlcPreferred.length ? nonDlcPreferred : osFiltered;
}

function collectProcessNames(options = []) {
  const sorted = getCandidateLaunchOptions(options);
  return normalizeProcessNameValue(
    sorted.map((option) =>
      path.win32.basename(String(option.executable).replace(/\//g, "\\")),
    ),
  );
}

function toLaunchMetadata(option, appid, allOptions = []) {
  if (!option?.executable) return null;
  const processNames = collectProcessNames(allOptions);
  return {
    appid: String(appid || ""),
    process_name: processNames || "",
    arguments: String(option.arguments || ""),
  };
}

async function extractLaunchOptionsFromPage(page) {
  return await page.evaluate(() => {
    const norm = (value) =>
      String(value || "")
        .replace(/\u00A0/g, " ")
        .replace(/\s+/g, " ")
        .trim();

    const heading = Array.from(document.querySelectorAll("h2")).find(
      (el) => norm(el.textContent) === "Launch Options",
    );
    if (!heading) return [];

    const panels = [];
    let node = heading.nextElementSibling;
    while (node) {
      if (node.tagName === "H2") break;
      if (
        node.tagName === "DIV" &&
        String(node.className || "").includes("launch-option")
      ) {
        panels.push(node);
      }
      node = node.nextElementSibling;
    }

    return panels.map((panel) => {
      const rowMap = {};
      const table = panel.querySelector("table");
      if (!table) return rowMap;
      table.querySelectorAll("tr").forEach((tr) => {
        const cells = Array.from(tr.children)
          .map((cell) => norm(cell.textContent))
          .filter(Boolean);
        if (cells.length >= 2) {
          rowMap[cells[0]] = cells.slice(1).join(" ");
        }
      });
      return rowMap;
    });
  });
}

async function fetchSteamDbLaunchMetadata(appid, sharedSession = null) {
  const id = String(appid || "").trim();
  if (!/^\d+$/.test(id)) return null;

  const url = `https://steamdb.info/app/${id}/config/`;
  const sharedPage =
    sharedSession && typeof sharedSession === "object"
      ? sharedSession.page || null
      : null;

  let browser = null;
  let ctx = null;
  let page = sharedPage;

  try {
    if (!page) {
      browser = await launchChromiumSafe({
        headless: true,
        args: ["--disable-blink-features=AutomationControlled"],
      });
      ctx = await browser.newContext({
        userAgent:
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121 Safari/537.36",
        viewport: { width: 1400, height: 1000 },
      });
      page = await ctx.newPage();
    }

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    const options = await extractLaunchOptionsFromPage(page);
    const option = pickBestLaunchOption(options);
    const metadata = toLaunchMetadata(option, id, options);

    if (metadata) {
      autoConfigLogger.info("steamdb:launch-metadata:resolved", {
        appid: id,
        process_name: metadata.process_name || null,
        hasArguments: !!metadata.arguments,
        source: sharedPage ? "steamdb-shared-session" : "steamdb-direct",
      });
    } else {
      autoConfigLogger.warn("steamdb:launch-metadata:missing", {
        appid: id,
        source: sharedPage ? "steamdb-shared-session" : "steamdb-direct",
      });
    }

    return metadata;
  } catch (err) {
    autoConfigLogger.warn("steamdb:launch-metadata:failed", {
      appid: id,
      error: err?.message || String(err),
      source: sharedPage ? "steamdb-shared-session" : "steamdb-direct",
    });
    return null;
  } finally {
    if (ctx) {
      await ctx.close().catch(() => {});
    }
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

module.exports = {
  fetchSteamDbLaunchMetadata,
};
