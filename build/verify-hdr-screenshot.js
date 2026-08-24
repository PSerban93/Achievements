"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

function isHdrScreenshotBuildSupported(platform = process.platform) {
  return platform === "win32";
}

function sha256(filePath) {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(filePath))
    .digest("hex")
    .toUpperCase();
}

function verifyFile(filePath, label) {
  if (!fs.existsSync(filePath)) {
    console.error(`${label} was not found: ${filePath}`);
    return null;
  }

  const stat = fs.statSync(filePath);
  if (!stat.isFile() || stat.size <= 0) {
    console.error(`${label} is invalid or empty: ${filePath}`);
    return null;
  }

  const hash = sha256(filePath);

  console.log(`${label}: ${filePath}`);
  console.log(`${label} size: ${stat.size} bytes`);
  console.log(`${label} SHA256: ${hash}`);

  return {
    path: filePath,
    size: stat.size,
    hash,
  };
}

function verifyHdrScreenshot(options = {}) {
  if (!isHdrScreenshotBuildSupported()) {
    console.log(
      `HDR screenshot helper verification skipped: unsupported on ${process.platform}.`,
    );
    return 0;
  }

  const packaged = options.packaged === true;

  const sourcePath = path.resolve(
    "utils",
    "native",
    "achievements-hdr-screenshot.exe",
  );

  const source = verifyFile(sourcePath, "HDR screenshot helper");
  if (!source) return 1;

  if (!packaged) {
    return 0;
  }

  const packagedPath = path.resolve(
    "dist",
    "win-unpacked",
    "resources",
    "app.asar.unpacked",
    "utils",
    "native",
    "achievements-hdr-screenshot.exe",
  );

  const packagedFile = verifyFile(
    packagedPath,
    "Packaged HDR screenshot helper",
  );
  if (!packagedFile) return 1;

  if (source.hash !== packagedFile.hash) {
    console.error(
      "Packaged HDR screenshot helper does not match the freshly built source binary.",
    );
    return 1;
  }

  console.log(
    "Packaged HDR screenshot helper matches the freshly built source binary.",
  );
  return 0;
}

if (require.main === module) {
  process.exitCode = verifyHdrScreenshot({
    packaged: process.argv.includes("--packaged"),
  });
}

module.exports = {
  isHdrScreenshotBuildSupported,
  sha256,
  verifyFile,
  verifyHdrScreenshot,
};
