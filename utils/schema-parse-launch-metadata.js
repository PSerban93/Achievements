const path = require("path");
const fs = require("fs");
const { normalizeProcessNameValue } = require("./process-name-utils");

function normalizeText(value) {
  return String(value || "")
    .replace(/\u00A0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeLaunchOption(raw = {}) {
  const config = raw?.config && typeof raw.config === "object" ? raw.config : {};
  return {
    executable: normalizeText(raw.executable),
    arguments: normalizeText(raw.arguments),
    workingDirectory: normalizeText(raw.workingdir),
    launchType: normalizeText(raw.type).toLowerCase(),
    operatingSystem: normalizeText(config.oslist || raw.oslist).toLowerCase(),
    cpuArchitecture: normalizeText(config.osarch || raw.osarch),
  };
}

function scoreLaunchOption(option) {
  let score = 0;
  if (option?.executable) score += 100;
  if (String(option?.operatingSystem || "").includes("windows")) score += 50;
  if (String(option?.launchType || "").includes("default")) score += 25;
  if (!String(option?.launchType || "").includes("dlc")) score += 10;
  return score;
}

function getSortedLaunchOptions(options = []) {
  const normalized = options
    .map(normalizeLaunchOption)
    .filter((option) => option.executable);
  normalized.sort((left, right) => scoreLaunchOption(right) - scoreLaunchOption(left));
  return normalized;
}

function getCandidateLaunchOptions(options = []) {
  const sorted = getSortedLaunchOptions(options);
  if (!sorted.length) return [];

  const windowsPreferred = sorted.filter((option) => {
    const os = String(option.operatingSystem || "");
    return !os || os.includes("windows");
  });
  const osFiltered = windowsPreferred.length ? windowsPreferred : sorted;
  const nonDlcPreferred = osFiltered.filter(
    (option) => !String(option.launchType || "").includes("dlc"),
  );
  return nonDlcPreferred.length ? nonDlcPreferred : osFiltered;
}

function collectProcessNames(options = []) {
  return normalizeProcessNameValue(
    getCandidateLaunchOptions(options).map((option) =>
      path.win32.basename(String(option.executable).replace(/\//g, "\\")),
    ),
  );
}

function parseSchemaParseLaunchMetadata(raw = {}, appid = "") {
  const rows =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? Object.values(raw)
      : Array.isArray(raw)
        ? raw
        : [];
  const candidates = getCandidateLaunchOptions(rows);
  const best = candidates[0] || null;
  if (!best?.executable) return null;
  return {
    appid: String(appid || "").trim(),
    process_name: collectProcessNames(rows),
    arguments: String(best.arguments || ""),
  };
}

function readSchemaParseLaunchMetadata(configLaunchPath, appid = "") {
  const fullPath = path.resolve(String(configLaunchPath || "").trim());
  if (!fullPath || !fs.existsSync(fullPath)) return null;
  const raw = JSON.parse(fs.readFileSync(fullPath, "utf8"));
  return parseSchemaParseLaunchMetadata(raw, appid);
}

module.exports = {
  parseSchemaParseLaunchMetadata,
  readSchemaParseLaunchMetadata,
};
