const path = require("path");
const fs = require("fs/promises");
const fsSync = require("fs");
const { createLogger } = require("./logger");
const { normalizeProcessNameValue } = require("./process-name-utils");

const resolvePlaywrightBrowsersPath = () => {
  const current = process.env.PLAYWRIGHT_BROWSERS_PATH || "";
  if (current && current !== "0") return current;
  const resourcesRoot = process.resourcesPath;
  if (resourcesRoot) {
    const candidate = path.join(resourcesRoot, "playwright-browsers");
    if (fsSync.existsSync(candidate)) return candidate;
  }
  return current || "0";
};

process.env.PLAYWRIGHT_BROWSERS_PATH = resolvePlaywrightBrowsersPath();
const { chromium } = require("playwright-core");

const autoConfigLogger = createLogger("autoconfig");
const baseLaunchArgs = ["--disable-blink-features=AutomationControlled"];

async function launchChromiumSafe(opts = {}) {
  try {
    return await chromium.launch({
      headless: true,
      args: baseLaunchArgs,
      ...opts,
    });
  } catch (firstErr) {
    const unAsar = (p) =>
      p.replace(/app\.asar(?!\.unpacked)/, "app.asar.unpacked");

    const roots = [];
    const envRoot = process.env.PLAYWRIGHT_BROWSERS_PATH || "";
    if (envRoot && envRoot !== "0") {
      roots.push(envRoot);
    }

    for (const pkg of ["playwright-core", "playwright"]) {
      try {
        const pkgDir = path.dirname(require.resolve(`${pkg}/package.json`));
        const rootA = path.join(pkgDir, ".local-browsers");
        const rootB = unAsar(rootA);
        roots.push(rootA, rootB);
      } catch {}
    }

    if (process.resourcesPath) {
      roots.push(
        path.join(
          process.resourcesPath,
          "app.asar.unpacked",
          "node_modules",
          "playwright-core",
          ".local-browsers"
        ),
        path.join(
          process.resourcesPath,
          "app.asar.unpacked",
          "node_modules",
          "playwright",
          ".local-browsers"
        ),
        path.join(process.resourcesPath, "playwright-browsers")
      );
    }

    const exeCandidates = [];
    for (const root of roots) {
      const dirs = await fs.readdir(root).catch(() => []);
      for (const d of dirs) {
        if (/^chromium_headless_shell-/i.test(d)) {
          exeCandidates.push(
            path.join(root, d, "chrome-win", "headless_shell.exe")
          );
          exeCandidates.push(
            path.join(
              root,
              d,
              "chrome-headless-shell-win64",
              "chrome-headless-shell.exe"
            )
          );
          exeCandidates.push(
            path.join(
              root,
              d,
              "chrome-headless-shell-win32",
              "chrome-headless-shell.exe"
            )
          );
        }
        if (/^chromium-/i.test(d)) {
          exeCandidates.push(path.join(root, d, "chrome-win", "chrome.exe"));
          exeCandidates.push(path.join(root, d, "chrome-win64", "chrome.exe"));
          exeCandidates.push(path.join(root, d, "chrome-win32", "chrome.exe"));
        }
      }
    }

    for (const exe of exeCandidates) {
      try {
        await fs.access(exe);
        return await chromium.launch({
          executablePath: exe,
          headless: true,
          args: baseLaunchArgs,
          ...opts,
        });
      } catch {}
    }

    throw firstErr;
  }
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
      raw["Working Directory"] || raw.workingDirectory
    ),
    launchType: normalizeText(raw["Launch Type"] || raw.launchType),
    operatingSystem: normalizeText(
      raw["Operating System"] || raw.operatingSystem
    ).toLowerCase(),
    cpuArchitecture: normalizeText(
      raw["CPU Architecture"] || raw.cpuArchitecture
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
      path.win32.basename(String(option.executable).replace(/\//g, "\\"))
    )
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
      (el) => norm(el.textContent) === "Launch Options"
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
