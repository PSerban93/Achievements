const path = require("path");
const fs = require("fs");
const fsp = require("fs/promises");

function unAsarPath(value) {
  return String(value || "").replace(
    /app\.asar(?!\.unpacked)/,
    "app.asar.unpacked",
  );
}

function pushUnique(list, value) {
  const normalized = String(value || "").trim();
  if (!normalized) return;

  const resolved = path.resolve(normalized);

  if (!list.some((item) => item.toLowerCase() === resolved.toLowerCase())) {
    list.push(resolved);
  }
}

function getPlaywrightBrowserRoots() {
  const roots = [];

  // 1. Explicit PLAYWRIGHT_BROWSERS_PATH.
  const envRoot = String(process.env.PLAYWRIGHT_BROWSERS_PATH || "").trim();

  if (envRoot && envRoot !== "0") {
    pushUnique(roots, envRoot);
  }

  // 2. Browser folder copied as Electron extraResource.
  if (process.resourcesPath) {
    pushUnique(
      roots,
      path.join(process.resourcesPath, "playwright-browsers"),
    );
  }

  // 3. Browser folders next to the installed Playwright packages.
  for (const pkg of ["playwright-core", "playwright"]) {
    try {
      const pkgDir = path.dirname(require.resolve(`${pkg}/package.json`));
      const localBrowsers = path.join(pkgDir, ".local-browsers");

      pushUnique(roots, localBrowsers);
      pushUnique(roots, unAsarPath(localBrowsers));
    } catch {}
  }

  // 4. Explicit packaged Electron fallback.
  if (process.resourcesPath) {
    pushUnique(
      roots,
      path.join(
        process.resourcesPath,
        "app.asar.unpacked",
        "node_modules",
        "playwright-core",
        ".local-browsers",
      ),
    );

    pushUnique(
      roots,
      path.join(
        process.resourcesPath,
        "app.asar.unpacked",
        "node_modules",
        "playwright",
        ".local-browsers",
      ),
    );
  }

  return roots;
}

function resolvePlaywrightBrowsersPath() {
  const current = String(process.env.PLAYWRIGHT_BROWSERS_PATH || "").trim();

  // Respect an explicitly configured non-zero path.
  if (current && current !== "0" && fs.existsSync(current)) {
    return current;
  }

  const roots = getPlaywrightBrowserRoots();

  for (const root of roots) {
    try {
      if (fs.existsSync(root)) {
        return root;
      }
    } catch {}
  }

  // Preserve Playwright's local-browser mode as last fallback.
  return current || "0";
}

function configurePlaywrightBrowsersPath() {
  const resolved = resolvePlaywrightBrowsersPath();

  process.env.PLAYWRIGHT_BROWSERS_PATH = resolved;

  return resolved;
}

function getChromium(packageName = "playwright") {
  // Important: configure the browser path BEFORE loading Playwright.
  configurePlaywrightBrowsersPath();

  const mod = require(packageName);

  if (!mod?.chromium) {
    throw new Error(`${packageName} does not export chromium`);
  }

  return mod.chromium;
}

async function collectChromiumExecutables() {
  const roots = getPlaywrightBrowserRoots();
  const candidates = [];

  const addCandidate = (candidate) => {
    if (!candidate) return;

    if (
      !candidates.some(
        (item) => item.toLowerCase() === candidate.toLowerCase(),
      )
    ) {
      candidates.push(candidate);
    }
  };

  for (const root of roots) {
    const dirs = await fsp.readdir(root).catch(() => []);

    for (const dir of dirs) {
      if (/^chromium-/i.test(dir)) {
        addCandidate(
          path.join(root, dir, "chrome-win", "chrome.exe"),
        );

        addCandidate(
          path.join(root, dir, "chrome-win64", "chrome.exe"),
        );

        addCandidate(
          path.join(root, dir, "chrome-win32", "chrome.exe"),
        );
      }
    }
  }

  const existing = [];

  for (const candidate of candidates) {
    try {
      await fsp.access(candidate);
      existing.push(candidate);
    } catch {}
  }

  return existing;
}

function normalizeChromiumLaunchOptions(options = {}) {
  const normalized = { ...options };

  // Playwright's default headless mode targets Chromium Headless Shell.
  // The packaged app intentionally ships full Chromium only, so force
  // Chromium's new headless mode for every headless launch.
  if (
    normalized.headless !== false &&
    !normalized.channel &&
    !normalized.executablePath
  ) {
    normalized.channel = "chromium";
  }

  return normalized;
}

async function launchChromiumSafe(
  packageName,
  launchOptions = {},
  fallbackLaunchOptions = null,
) {
  const chromium = getChromium(packageName);

  const primaryLaunchOptions =
    normalizeChromiumLaunchOptions(launchOptions);

  let firstError = null;

  try {
    return await chromium.launch(primaryLaunchOptions);
  } catch (err) {
    firstError = err;
  }

  // Some existing callers intentionally retry with simpler options.
  const effectiveFallbackOptions = normalizeChromiumLaunchOptions(
    fallbackLaunchOptions || launchOptions,
  );

  if (fallbackLaunchOptions) {
    try {
      return await chromium.launch(
        normalizeChromiumLaunchOptions(fallbackLaunchOptions),
      );
    } catch {}
  }

  const executables = await collectChromiumExecutables();

  for (const executablePath of executables) {
    try {
      // executablePath already selects the browser binary explicitly.
      // Do not combine it with a Playwright channel.
      const {
        channel: _channel,
        executablePath: _ignoredExecutablePath,
        ...manualLaunchOptions
      } = effectiveFallbackOptions;

      return await chromium.launch({
        ...manualLaunchOptions,
        executablePath,
      });
    } catch {}
  }

  throw firstError;
}

function getPlaywrightRuntimeInfo() {
  return {
    browsersPath: process.env.PLAYWRIGHT_BROWSERS_PATH || null,
    resolvedBrowsersPath: resolvePlaywrightBrowsersPath(),
    resourcesPath: process.resourcesPath || null,
    roots: getPlaywrightBrowserRoots(),
  };
}

module.exports = {
  configurePlaywrightBrowsersPath,
  resolvePlaywrightBrowsersPath,
  getPlaywrightBrowserRoots,
  getPlaywrightRuntimeInfo,
  getChromium,
  launchChromiumSafe,
};