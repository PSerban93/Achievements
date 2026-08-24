"use strict";

if (process.platform !== "win32") {
  console.log(
    `Achievement Recorder verification skipped: unsupported on ${process.platform}.`,
  );
  process.exit(0);
}

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const packageJson = JSON.parse(
  fs.readFileSync(path.join(root, "package.json"), "utf8"),
);
const outputDirectory =
  packageJson?.build?.directories?.output || "dist";

const files = [
  {
    label: "compiled",
    filePath: path.join(
      root,
      "native",
      "achievement-recorder",
      "target",
      "release",
      "achievements-recorder.exe",
    ),
  },
  {
    label: "bundled source",
    filePath: path.join(
      root,
      "utils",
      "native",
      "achievements-recorder.exe",
    ),
  },
];

if (process.argv.includes("--packaged")) {
  files.push({
    label: "packaged",
    filePath: path.join(
      root,
      outputDirectory,
      "win-unpacked",
      "resources",
      "app.asar.unpacked",
      "utils",
      "native",
      "achievements-recorder.exe",
    ),
  });
}

function sha256(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Recorder verification failed: missing ${filePath}`);
  }
  const stat = fs.statSync(filePath);
  if (!stat.isFile() || stat.size === 0) {
    throw new Error(`Recorder verification failed: invalid ${filePath}`);
  }
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(filePath))
    .digest("hex")
    .toUpperCase();
}

const results = files.map((entry) => ({
  ...entry,
  hash: sha256(entry.filePath),
}));
const expectedHash = results[0].hash;
const mismatch = results.find((entry) => entry.hash !== expectedHash);

for (const result of results) {
  console.log(
    `achievement-recorder ${result.label} SHA256: ${result.hash}`,
  );
}

if (mismatch) {
  throw new Error(
    `Recorder verification failed: ${mismatch.label} binary does not match the compiled binary`,
  );
}

console.log(`Recorder binaries verified (${results.length} matching files).`);
