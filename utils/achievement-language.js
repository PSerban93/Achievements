const ACHIEVEMENT_LANGUAGES = Object.freeze([
  "english",
  "german",
  "french",
  "italian",
  "koreana",
  "spanish",
  "thai",
  "schinese",
  "tchinese",
  "arabic",
  "russian",
  "japanese",
  "portuguese",
  "danish",
  "dutch",
  "swedish",
  "hungarian",
  "turkish",
  "polish",
  "brazilian",
  "ukrainian",
  "vietnamese",
  "bulgarian",
  "czech",
  "finnish",
  "greek",
  "indonesian",
  "norwegian",
  "romanian",
  "latam",
]);

const ACHIEVEMENT_LANGUAGE_SET = new Set(ACHIEVEMENT_LANGUAGES);

function normalizeAchievementLanguage(value, fallback = "") {
  const raw = String(value || "")
    .trim()
    .toLowerCase();
  const normalized = raw === "es-419" ? "latam" : raw;
  if (ACHIEVEMENT_LANGUAGE_SET.has(normalized)) return normalized;

  const fallbackRaw = String(fallback || "")
    .trim()
    .toLowerCase();
  const normalizedFallback = fallbackRaw === "es-419" ? "latam" : fallbackRaw;
  return ACHIEVEMENT_LANGUAGE_SET.has(normalizedFallback)
    ? normalizedFallback
    : "";
}

function resolveAchievementLanguage(config, globalLanguage = "english") {
  const override = normalizeAchievementLanguage(config?.language);
  if (override) return override;
  return normalizeAchievementLanguage(globalLanguage, "english") || "english";
}

module.exports = {
  ACHIEVEMENT_LANGUAGES,
  normalizeAchievementLanguage,
  resolveAchievementLanguage,
};
