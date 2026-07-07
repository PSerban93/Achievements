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

  function normalizeAppTheme(value) {
    const theme = String(value || "").trim().toLowerCase();
    return APP_THEME_SET.has(theme) ? theme : "dracula";
  }

  function applyAppThemeToDocument(value, doc) {
    const theme = normalizeAppTheme(value);
    const targetDocument =
      doc ||
      (root && root.document && typeof root.document === "object"
        ? root.document
        : null);
    if (targetDocument?.documentElement) {
      targetDocument.documentElement.dataset.theme = theme;
    }
    return theme;
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
    normalizeAppTheme,
    applyAppThemeToDocument,
    applyHardwareAccelerationPreferenceToDocument,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  if (root && typeof root === "object") {
    root.AppTheme = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
