const EMULATOR_PLATFORMS = new Set(["steam", "uplay", "gog", "epic"]);
const { getBlacklistMatch } = require("./blacklist-identity");

function isPositiveNumericId(appid, maximum) {
  const raw = String(appid ?? "").trim();
  if (!/^\d+$/.test(raw)) return false;
  const id = raw.replace(/^0+(?=\d)/, "");
  return id !== "0" && (id.length < maximum.length || id.length === maximum.length && id <= maximum);
}
function isSteamAppId(appid) { return isPositiveNumericId(appid, "4294967295"); }
function isGogProductId(appid) { return isPositiveNumericId(appid, "18446744073709551615"); }
function isEpicGameId(appid) { return /^[0-9a-fA-F]{32}$/.test(String(appid ?? "").trim()); }
function getEpicIdentityAliases(identity = {}) {
  if (!identity || typeof identity !== "object") return [];
  return [identity.productId, identity.namespace, identity.catalogItemId, identity.appName].filter(isEpicGameId);
}

function resolveEmulatorDiscoveryMeta(appid, mode = "auto", mapping = null) {
  const id = String(appid).trim();
  if (["steam", "epic", "gog"].includes(mode)) return { uplayId: id, steamId: id, strip: false, platform: mode };
  if (mapping?.steam_appid) return { uplayId: id, steamId: String(mapping.steam_appid), strip: true,
    platform: mode === "uplay" ? "uplay" : undefined };
  return { uplayId: id, steamId: id, strip: false, platform: mode === "uplay" ? "uplay" : undefined };
}

function getEmulatorProviderPlan(meta) {
  const appid = String(meta.uplayId);
  const hasMapping = meta.steamId !== appid && /^\d+$/.test(meta.steamId);
  const initialProviders = meta.platform === "epic" || !/^\d+$/.test(appid) ? ["epic"] :
    meta.platform === "gog" ? ["gog", "epic"] : ["steam", "gog", "epic"];
  return { hasMapping, initialProviders,
    providers: [...initialProviders, ...["steam", "gog", "epic"].filter((provider) => !initialProviders.includes(provider))] };
}

function getEmulatorGenerationPreflight(meta, state, { explicitPlatform = null, aliases = [] } = {}) {
  const appid = String(meta.uplayId);
  const initial = getBlacklistMatch(appid, explicitPlatform, state);
  const skipped = (details) => ({ skip: true, result: generationResult(appid, "blacklisted", {
    blacklistScope: null, ...details }) });
  if (initial) return skipped({ platform: explicitPlatform, matchedScope: initial.scope, reason: "target-blacklisted" });
  const { providers, hasMapping } = getEmulatorProviderPlan(meta);
  const attempts = [];
  let hasUnknownBlacklist = false;
  for (const provider of providers) {
    const platform = provider === "steam" && hasMapping ? "uplay" : provider;
    const match = getBlacklistMatch(appid, platform, state, provider === "epic" ? aliases : []);
    if (match) {
      attempts.push({ platform, status: "blacklisted", cachedStatus: match.status, durationMs: 0 });
      if (match.scope === "global" || match.identified) return skipped({ platform, matchedScope: match.scope,
        hasKnownIdentity: !!match.identified, attempts, reason: "known-blacklisted-identity" });
      hasUnknownBlacklist ||= match.status === "unknown";
      continue;
    }
    const applicable = provider === "steam" ? isSteamAppId(meta.steamId) : provider === "gog" ? isGogProductId(appid) : isEpicGameId(appid);
    if (applicable) return { skip: false };
    attempts.push({ platform, status: "not-applicable", durationMs: 0 });
  }
  // Only reuse blacklist decisions here. An entirely new invalid ID still
  // follows the existing generator's result/persistence flow.
  if (!attempts.some((entry) => entry.status === "blacklisted")) return { skip: false };
  return skipped({ attempts, exhausted: true, allProvidersChecked: true,
    checkedProviders: providers, hasKnownIdentity: false, hasUnknownBlacklist,
    hasTechnicalErrors: false, ambiguous: false, reason: "all-providers-skipped" });
}

function getGenerationBlacklistDecision(appid, mode, state, options = {}) {
  mode = String(mode || "auto").trim().toLowerCase();
  const explicitPlatform = Object.prototype.hasOwnProperty.call(options, "explicitPlatform")
    ? options.explicitPlatform : mode === "auto" ? null : mode;
  if (!isEmulatorGeneration(mode)) {
    const match = getBlacklistMatch(appid, explicitPlatform, state, options.aliases);
    return match ? { skip: true, result: generationResult(appid, "blacklisted", {
      platform: explicitPlatform, matchedScope: match.scope, blacklistScope: null, reason: "target-blacklisted" }) } : { skip: false };
  }
  return getEmulatorGenerationPreflight(resolveEmulatorDiscoveryMeta(appid, mode, options.mapping), state,
    { explicitPlatform, aliases: options.aliases || [] });
}

function isEmulatorGeneration(platform) {
  return !platform || platform === "auto" || EMULATOR_PLATFORMS.has(platform);
}

function generationResult(appid, status, details = {}) {
  return { ...details, appid: String(appid).trim(), status };
}

function blacklistScope(result) {
  if (result?.status === "identified-no-achievements" &&
      EMULATOR_PLATFORMS.has(result.platform) && result.identified === true) {
    return "platform";
  }
  // Exhausting a hinted subset alone must not blacklist another platform.
  if (result?.status === "not-found" && result.exhausted === true &&
      result.allProvidersChecked === true &&
      result.hasTechnicalErrors !== true && result.ambiguous !== true &&
      result.hasKnownIdentity !== true && result.hasUnknownBlacklist !== true) {
    return "global";
  }
  // A provider's confirmed negative lookup is independent of the other providers.
  if (result?.status === "not-found" && result.platformChecked === true &&
      EMULATOR_PLATFORMS.has(result.platform) && result.identified !== true &&
      result.hasTechnicalErrors !== true && result.ambiguous !== true &&
      !result.error && !(result.errors?.length)) {
    return "platform";
  }
  return null;
}

function generationDetail(result) {
  if (blacklistScope(result) === "platform") return result.status === "not-found"
    ? "Game name not found" : "No achievements found";
  if (blacklistScope(result) === "global") return "Game name not found";
  if (result?.status === "blacklisted") return "AppID is blacklisted";
  if (result?.status === "existing-schema") return "Config already up to date";
  return "Achievements schema generation failed";
}

module.exports = { isEmulatorGeneration, generationResult, blacklistScope, generationDetail,
  isSteamAppId, isGogProductId, isEpicGameId, getEpicIdentityAliases, resolveEmulatorDiscoveryMeta,
  getEmulatorProviderPlan, getEmulatorGenerationPreflight, getGenerationBlacklistDecision };
