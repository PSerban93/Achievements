(function initAppTheme(root) {
  const APP_THEME_VALUES = [
    "dracula",
    "dark",
    "light",
    "oled",
    "metro",
    "metro-dark",
    "aero",
    "aero-dark",
  ];
  const APP_THEME_SET = new Set(APP_THEME_VALUES);
  const CUSTOM_THEME_ID_RE = /^[a-z0-9][a-z0-9._-]{0,79}$/;
  const APPLIED_STYLE_PROPS = new Set();
  let themeRegistry = new Map();

  function normalizeAppTheme(value) {
    const theme = String(value || "").trim().toLowerCase();
    if (APP_THEME_SET.has(theme)) return theme;
    return CUSTOM_THEME_ID_RE.test(theme) ? theme : "dracula";
  }

  function normalizeThemeEntry(entry) {
    if (!entry || typeof entry !== "object") return null;
    const id = normalizeAppTheme(entry.id);
    if (!id || id === "dracula" && String(entry.id || "").trim().toLowerCase() !== "dracula") {
      return null;
    }
    return {
      ...entry,
      id,
      base: normalizeAppTheme(entry.base || id),
      name: String(entry.name || id).trim() || id,
      tokens: entry.tokens && typeof entry.tokens === "object" ? entry.tokens : {},
      overlayTokens:
        entry.overlayTokens && typeof entry.overlayTokens === "object"
          ? entry.overlayTokens
          : {},
      effects:
        entry.effects && typeof entry.effects === "object" ? entry.effects : {},
    };
  }

  function registerAppThemes(themes) {
    const next = new Map();
    if (Array.isArray(themes)) {
      for (const entry of themes) {
        const theme = normalizeThemeEntry(entry);
        if (theme) next.set(theme.id, theme);
      }
    }
    themeRegistry = next;
    return Array.from(themeRegistry.values());
  }

  function getAppTheme(id) {
    return themeRegistry.get(normalizeAppTheme(id)) || null;
  }

  function clearAppliedThemeStyles(targetDocument) {
    const style = targetDocument?.documentElement?.style;
    if (!style) return;
    for (const prop of APPLIED_STYLE_PROPS) {
      style.removeProperty(prop);
    }
    APPLIED_STYLE_PROPS.clear();
  }

  function setThemeStyle(targetDocument, prop, value) {
    const style = targetDocument?.documentElement?.style;
    if (!style) return;
    const cssProp = prop.startsWith("--") ? prop : `--${prop}`;
    const text = String(value || "").trim();
    if (!text) return;
    style.setProperty(cssProp, text);
    APPLIED_STYLE_PROPS.add(cssProp);
  }

  function applyThemeTokensToDocument(theme, targetDocument) {
    clearAppliedThemeStyles(targetDocument);
    if (!theme) return;
    const tokens = {
      ...(theme.tokens || {}),
      ...(theme.overlayTokens || {}),
    };
    for (const [key, value] of Object.entries(tokens)) {
      setThemeStyle(targetDocument, key, value);
    }
    if (theme.effects?.bodyBackground) {
      setThemeStyle(targetDocument, "app-body-bg", theme.effects.bodyBackground);
    }
  }

  function applyAppThemeToDocument(value, doc) {
    const requestedTheme = normalizeAppTheme(value);
    const externalTheme = getAppTheme(requestedTheme);
    const theme = externalTheme?.base || requestedTheme;
    const targetDocument =
      doc ||
      (root && root.document && typeof root.document === "object"
        ? root.document
        : null);
    if (targetDocument?.documentElement) {
      targetDocument.documentElement.dataset.theme = theme;
      targetDocument.documentElement.dataset.appThemeId = requestedTheme;
      applyThemeTokensToDocument(externalTheme, targetDocument);
    }
    return requestedTheme;
  }

  function applyHardwareAccelerationPreferenceToDocument(value, doc) {
    const targetDocument =
      doc ||
      (root && root.document && typeof root.document === "object"
        ? root.document
        : null);
    const disabled = value !== false;
    if (targetDocument?.documentElement) {
      targetDocument.documentElement.dataset.hardwareAcceleration = disabled
        ? "off"
        : "on";
    }
    return disabled ? "off" : "on";
  }

  const api = {
    APP_THEME_VALUES,
    getAppTheme,
    normalizeAppTheme,
    applyAppThemeToDocument,
    applyHardwareAccelerationPreferenceToDocument,
    registerAppThemes,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  if (root && typeof root === "object") {
    root.AppTheme = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
