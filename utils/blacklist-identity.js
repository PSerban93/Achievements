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

module.exports = {
  buildBlacklistConfigKey,
  normalizeAppIdValue,
  normalizeBlacklistConfigKey,
  normalizeBlacklistPlatformValue,
};
