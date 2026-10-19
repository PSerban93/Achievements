function normalizeAppIdValue(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) return "";

  if (/^\d+$/.test(trimmed)) return trimmed;
  if (/^[0-9a-fA-F]+$/.test(trimmed)) return trimmed.toLowerCase();
  if (/^CUSA\d+$/i.test(trimmed)) return trimmed.toUpperCase();
  if (/^NP[A-Z0-9_]+$/i.test(trimmed)) return trimmed.toUpperCase();
  if (/^0x[0-9a-f]+$/i.test(trimmed)) {
    return `0x${trimmed.slice(2).toLowerCase()}`;
  }
  if (/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(trimmed)) {
    return trimmed;
  }
  return "";
}

function normalizeBlacklistPlatformValue(value) {
  const trimmed = String(value || "")
    .trim()
    .toLowerCase();
  return trimmed || "steam";
}

function buildBlacklistConfigKey(appid, platform) {
  const normalizedAppId = normalizeAppIdValue(appid);
  if (!normalizedAppId) return "";
  return `${normalizedAppId}::${normalizeBlacklistPlatformValue(platform)}`;
}

function normalizeBlacklistConfigKey(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const sepIndex = raw.indexOf("::");
  if (sepIndex <= 0) return "";
  const appid = normalizeAppIdValue(raw.slice(0, sepIndex));
  if (!appid) return "";
  const platform = normalizeBlacklistPlatformValue(raw.slice(sepIndex + 2));
  return `${appid}::${platform}`;
}

function createBlacklistState(preferences = {}) {
  if (!preferences || typeof preferences !== "object") preferences = {};
  const generationResults = {};
  for (const [rawKey, value] of Object.entries(preferences.blacklistedGenerationResults || {})) {
    const key = normalizeBlacklistConfigKey(rawKey);
    if (key) generationResults[key] = value;
  }
  return {
    appIds: new Set((Array.isArray(preferences.blacklistedAppIds) ? preferences.blacklistedAppIds : [])
      .map(normalizeAppIdValue).filter(Boolean)),
    configKeys: new Set((Array.isArray(preferences.blacklistedConfigKeys) ? preferences.blacklistedConfigKeys : [])
      .map(normalizeBlacklistConfigKey).filter(Boolean)),
    generationResults,
  };
}

function getBlacklistMatch(appid, platform, state, aliases = []) {
  if (!Array.isArray(aliases)) aliases = [];
  const ids = [appid, ...aliases].map(normalizeAppIdValue).filter(Boolean);
  if (ids.some((id) => state?.appIds?.has(id))) return { scope: "global" };
  if (!String(platform || "").trim()) return null;
  const matches = ids.map((id) => buildBlacklistConfigKey(id, platform)).filter((key) => state?.configKeys?.has(key));
  if (!matches.length) return null;
  const evidence = matches.map((key) => state.generationResults?.[key]);
  const identified = evidence.some((entry) => entry?.status === "identified-no-achievements" && entry.identified === true);
  const confirmedNotFound = evidence.every((entry) => entry?.status === "not-found");
  return { scope: "platform", identified, confirmedNotFound,
    status: identified ? "identified-no-achievements" : confirmedNotFound ? "not-found" : "unknown" };
}

module.exports = {
  buildBlacklistConfigKey,
  normalizeAppIdValue,
  normalizeBlacklistConfigKey,
  normalizeBlacklistPlatformValue,
  createBlacklistState,
  getBlacklistMatch,
};
