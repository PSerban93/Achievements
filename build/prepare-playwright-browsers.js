const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const playwrightCoreDir = path.dirname(
  require.resolve("playwright-core/package.json"),
);

const browsersDir = path.join(playwrightCoreDir, ".local-browsers");
const playwrightCli = path.join(playwrightCoreDir, "cli.js");

function listBrowserDirectories() {
  if (!fs.existsSync(browsersDir)) return [];

  return fs
    .readdirSync(browsersDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

const install = spawnSync(
  process.execPath,
  [playwrightCli, "install", "chromium", "--no-shell"],
  {
    cwd: path.resolve(__dirname, ".."),
    env: {
      ...process.env,
      PLAYWRIGHT_BROWSERS_PATH: "0",
      // Playwright normally garbage-collects old revisions before downloading.
      // Keep them until the new executable has passed our validation below.
      PLAYWRIGHT_SKIP_BROWSER_GC: "1",
    },
    stdio: "inherit",
  },
);

if (install.error) {
  console.error(
    `Playwright browser installation failed: ${install.error.message}`,
  );
  process.exit(1);
}

if (install.status !== 0) {
  process.exit(install.status ?? 1);
}

// Validate the current Playwright revision before removing any previously
// working runtime. A failed/incomplete download therefore cannot destroy the
// browser used by the local development environment.
process.env.PLAYWRIGHT_BROWSERS_PATH = "0";

const expectedChromiumExecutable = require("playwright-core").chromium.executablePath();
const expectedChromiumDirectory = path.relative(
  browsersDir,
  expectedChromiumExecutable,
).split(path.sep)[0];

if (
  !/^chromium-\d+$/.test(expectedChromiumDirectory) ||
  !fs.existsSync(expectedChromiumExecutable) ||
  !fs.existsSync(
    path.join(browsersDir, expectedChromiumDirectory, "INSTALLATION_COMPLETE"),
  )
) {
  console.error(
    `Playwright full Chromium validation failed: ${expectedChromiumExecutable}`,
  );
  process.exit(1);
}

// The new revision is valid. Remove only obsolete Chromium revisions and all
// Headless Shell variants so electron-builder receives one deterministic
// browser payload.
for (const directoryName of listBrowserDirectories()) {
  const isObsoleteFullChromium =
    /^chromium-\d+$/.test(directoryName) &&
    directoryName !== expectedChromiumDirectory;
  const isHeadlessShell =
    /^chromium_headless_shell-\d+$/.test(directoryName);

  if (!isObsoleteFullChromium && !isHeadlessShell) continue;

  fs.rmSync(path.join(browsersDir, directoryName), {
    recursive: true,
    force: true,
  });
  console.log(`Removed stale Playwright Chromium runtime: ${directoryName}`);
}

const installedDirectories = listBrowserDirectories();

const fullChromiumDirectories = installedDirectories.filter((directoryName) =>
  /^chromium-\d+$/.test(directoryName),
);

const headlessShellDirectories = installedDirectories.filter((directoryName) =>
  /^chromium_headless_shell-\d+$/.test(directoryName),
);

if (!fullChromiumDirectories.length) {
  console.error("Playwright full Chromium was not installed.");
  process.exit(1);
}

if (
  fullChromiumDirectories.length !== 1 ||
  fullChromiumDirectories[0] !== expectedChromiumDirectory
) {
  console.error(
    `Unexpected full Chromium payload: ${fullChromiumDirectories.join(", ")}`,
  );
  process.exit(1);
}

if (headlessShellDirectories.length) {
  console.error(
    `Chromium Headless Shell is still present: ${headlessShellDirectories.join(", ")}`,
  );
  process.exit(1);
}

console.log(
  `Playwright runtime prepared: full Chromium only (${fullChromiumDirectories.join(", ")}).`,
);
