const fs = require("fs");
const path = require("path");
const { createLogger } = require("./logger");
const {
  normalizeProcessNameList,
  normalizeProcessNameValue,
} = require("./process-name-utils");

const epicLocalLogger = createLogger("epic-official");
const CACHE_TTL_MS = 60 * 1000;
let cachedIndex = null;
let cachedAt = 0;

function firstNonEmpty(...values) {
  for (const value of values) {
    const text = String(value || "").trim();
    if (text) return text;
  }
  return "";
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function getEpicDataRoot() {
  const programData = process.env.ProgramData || "C:\\ProgramData";
  return path.join(programData, "Epic", "EpicGamesLauncher", "Data");
}

function buildExecutablePath(installLocation, launchExecutable) {
  const baseDir = String(installLocation || "").trim();
  const relExe = String(launchExecutable || "").trim();
  if (!baseDir || !relExe) return "";
  try {
    return path.join(baseDir, relExe);
  } catch {
    return "";
  }
}

function buildProcessNameValue(rawNames = []) {
  const list = normalizeProcessNameList(rawNames, { splitString: true });
  return normalizeProcessNameValue(list);
}

function normalizeNativeManifest(item = {}, filePath = "") {
  const installLocation = firstNonEmpty(item.InstallLocation, item.installLocation);
  const launchExecutable = firstNonEmpty(
    item.LaunchExecutable,
    item.launchExecutable,
  );
  const processNames = normalizeProcessNameList([
    ...(Array.isArray(item.ProcessNames) ? item.ProcessNames : []),
    item.MainWindowProcessName,
    launchExecutable,
  ]);
  return {
    source: "native-manifest",
    filePath,
    title: firstNonEmpty(item.DisplayName, item.displayName),
    namespace: firstNonEmpty(item.CatalogNamespace, item.catalogNamespace),
    catalogItemId: firstNonEmpty(item.CatalogItemId, item.catalogItemId),
    appName: firstNonEmpty(item.AppName, item.appName),
    installLocation,
    launchExecutable,
    executablePath: buildExecutablePath(installLocation, launchExecutable),
    processNames,
    processName: buildProcessNameValue(processNames),
    additionalCommandArgs: firstNonEmpty(
      item.LaunchCommand,
      item.launchCommand,
    ),
    provider: "Epic Games",
  };
}

function normalizeThirdPartyEntry(item = {}, filePath = "") {
  const processNames = normalizeProcessNameList([
    ...(Array.isArray(item.ProcessNames) ? item.ProcessNames : []),
    item.MainWindowProcessName,
  ]);
  return {
    source: "third-party-managed",
    filePath,
    title: firstNonEmpty(item.Title, item.title),
    namespace: firstNonEmpty(item.Namespace, item.namespace),
    catalogItemId: firstNonEmpty(item.CatalogID, item.CatalogId, item.catalogId),
    appName: firstNonEmpty(item.AppName, item.appName),
    installLocation: "",
    launchExecutable: "",
    executablePath: "",
    processNames,
    processName: buildProcessNameValue(processNames),
    additionalCommandArgs: firstNonEmpty(
      item.AdditionalCommandArgs,
      item.additionalCommandArgs,
    ),
    provider: firstNonEmpty(item.Provider, item.provider),
  };
}

function addIndexEntry(index, entry) {
  if (!entry || typeof entry !== "object") return;
  index.entries.push(entry);
  const namespace = String(entry.namespace || "").trim().toLowerCase();
  const catalogItemId = String(entry.catalogItemId || "").trim().toLowerCase();
  const appName = String(entry.appName || "").trim().toLowerCase();
  if (namespace && catalogItemId) {
    index.byNamespaceCatalog.set(`${namespace}|${catalogItemId}`, entry);
  }
  if (appName) {
    index.byAppName.set(appName, entry);
  }
}

function buildEpicLocalInstallIndex(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && cachedIndex && now - cachedAt < CACHE_TTL_MS) {
    return cachedIndex;
  }

  const dataRoot = getEpicDataRoot();
  const manifestsDir = path.join(dataRoot, "Manifests");
  const thirdPartyDir = path.join(dataRoot, "ThirPartyManagedApps");
  const index = {
    entries: [],
    byNamespaceCatalog: new Map(),
    byAppName: new Map(),
  };

  try {
    if (fs.existsSync(manifestsDir)) {
      for (const file of fs.readdirSync(manifestsDir)) {
        if (!String(file || "").toLowerCase().endsWith(".item")) continue;
        const fullPath = path.join(manifestsDir, file);
        const payload = readJsonFile(fullPath);
        if (!payload || typeof payload !== "object") continue;
        addIndexEntry(index, normalizeNativeManifest(payload, fullPath));
      }
    }
  } catch (error) {
    epicLocalLogger.warn("epic-official:local-index:manifests-failed", {
      error: error?.message || String(error),
    });
  }

  try {
    if (fs.existsSync(thirdPartyDir)) {
      for (const file of fs.readdirSync(thirdPartyDir)) {
        if (!String(file || "").toLowerCase().endsWith(".json")) continue;
        const fullPath = path.join(thirdPartyDir, file);
        const payload = readJsonFile(fullPath);
        if (!payload || typeof payload !== "object") continue;
        addIndexEntry(index, normalizeThirdPartyEntry(payload, fullPath));
      }
    }
  } catch (error) {
    epicLocalLogger.warn("epic-official:local-index:third-party-failed", {
      error: error?.message || String(error),
    });
  }

  cachedIndex = index;
  cachedAt = now;
  return index;
}

function resolveEpicLocalInstallation(identifiers = {}, options = {}) {
  const index = buildEpicLocalInstallIndex(options?.forceRefresh === true);
  const namespace = String(
    identifiers?.namespace || identifiers?.epic_namespace || "",
  )
    .trim()
    .toLowerCase();
  const catalogItemId = String(
    identifiers?.catalogItemId ||
      identifiers?.epic_catalog_item_id ||
      identifiers?.catalogId ||
      "",
  )
    .trim()
    .toLowerCase();
  const appName = String(
    identifiers?.appName || identifiers?.epic_app_name || "",
  )
    .trim()
    .toLowerCase();

  if (namespace && catalogItemId) {
    const exact = index.byNamespaceCatalog.get(`${namespace}|${catalogItemId}`);
    if (exact) return exact;
  }
  if (appName) {
    const byApp = index.byAppName.get(appName);
    if (byApp) return byApp;
  }
  return null;
}

module.exports = {
  buildEpicLocalInstallIndex,
  resolveEpicLocalInstallation,
};
