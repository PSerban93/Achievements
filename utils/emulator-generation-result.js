const EMULATOR_PLATFORMS = new Set(["steam", "uplay", "gog", "epic"]);

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
      result.hasTechnicalErrors !== true && result.ambiguous !== true) {
    return "global";
  }
  return null;
}

function generationDetail(result) {
  if (blacklistScope(result) === "platform") return "No achievements found";
  if (blacklistScope(result) === "global") return "Game name not found";
  if (result?.status === "blacklisted") return "AppID is blacklisted";
  if (result?.status === "existing-schema") return "Config already up to date";
  return "Achievements schema generation failed";
}

module.exports = { isEmulatorGeneration, generationResult, blacklistScope, generationDetail };
