const fs = require("fs");
const path = require("path");
const {
  defaultThemesFolder,
  userThemesFolder,
} = require("./paths");
const { writeJsonAtomicSync } = require("./atomic-json-store");

const THEME_ID_RE = /^[a-z0-9][a-z0-9._-]{0,79}$/i;
const TOKEN_RE = /^(?:--)?app-[a-z0-9-]+$/i;
const BUILTIN_THEME_IDS = new Set([
  "dracula",
  "dark",
  "light",
  "oled",
  "metro",
  "metro-dark",
  "aero",
  "aero-dark",
]);
const CUSTOM_THEME_TOKEN_NAMES = new Set([
  "app-bg",
  "app-surface",
  "app-text",
  "app-muted",
  "app-accent",
  "app-accent-2",
  "app-success",
  "app-warning",
  "app-attention",
  "app-danger",
  "app-pink",
  "app-backdrop",
  "app-panel-bg",
  "app-panel-bg-strong",
  "app-card-bg",
  "app-card-footer-bg",
  "app-hover-bg",
  "app-border-subtle",
  "app-input-bg",
  "app-input-bg-focus",
  "app-select-bg",
  "app-select-bg-focus",
  "app-select-hover-bg",
  "app-select-border",
  "app-select-border-focus",
  "app-select-text",
  "app-select-option-bg",
  "app-select-option-text",
  "app-select-option-hover-bg",
  "app-select-option-selected-bg",
  "app-select-option-selected-text",
  "app-select-option-disabled-text",
  "app-image-bg",
  "app-radius-xs",
  "app-radius-sm",
  "app-radius-md",
  "app-radius-lg",
  "app-radius-xl",
  "app-radius-panel",
  "app-radius-pill",
]);
const CUSTOM_OVERLAY_TOKEN_NAMES = new Set([
  "app-overlay-bg",
  "app-overlay-bg-strong",
  "app-overlay-surface",
  "app-overlay-surface-soft",
  "app-overlay-hover",
]);
const RADIUS_TOKEN_RE = /^app-radius-/;

function normalizeThemeId(value) {
  const id = String(value || "").trim().toLowerCase();
  return THEME_ID_RE.test(id) ? id : "";
}

function normalizeThemeName(value, fallback) {
  const name = String(value || "").trim();
  return name || fallback;
}

function sanitizeCssValue(value) {
  const text = String(value || "").trim();
  if (
    !text ||
    /[{};]/.test(text) ||
    /(?:url\s*\(|@import|expression\s*\(|javascript:)/i.test(text)
  ) {
    return "";
  }
  return text;
}

function createCustomThemeId(value) {
  const slug = String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, 72);
  return normalizeThemeId(slug ? `custom-${slug}` : "");
}

function sanitizeCustomThemeTokens(tokens, allowedNames) {
  const sanitized = sanitizeTokens(tokens);
  const out = {};
  for (const [key, value] of Object.entries(sanitized)) {
    if (!allowedNames.has(key)) continue;
    if (RADIUS_TOKEN_RE.test(key)) {
      const match = value.match(/^(\d+(?:\.\d+)?)(px|rem|em|%)$/i);
      if (!match || Number(match[1]) > 999) continue;
    }
    out[key] = value;
  }
  return out;
}

function sanitizeTokens(tokens) {
  if (!tokens || typeof tokens !== "object" || Array.isArray(tokens)) {
    return {};
  }
  const out = {};
  for (const [rawKey, rawValue] of Object.entries(tokens)) {
    const key = String(rawKey || "").trim().replace(/^--/, "");
    if (!TOKEN_RE.test(key)) continue;
    const value = sanitizeCssValue(rawValue);
    if (value) out[key] = value;
  }
  return out;
}

function sanitizeEffects(effects) {
  if (!effects || typeof effects !== "object" || Array.isArray(effects)) {
    return {};
  }
  const out = {};
  const bodyBackground = sanitizeCssValue(effects.bodyBackground);
  if (bodyBackground) out.bodyBackground = bodyBackground;
  if (Object.prototype.hasOwnProperty.call(effects, "glass")) {
    out.glass = effects.glass === true;
  }
  return out;
}

function stripJsonComments(text) {
  let out = "";
  let inString = false;
  let stringQuote = "";
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];

    if (inString) {
      out += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === stringQuote) {
        inString = false;
        stringQuote = "";
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      inString = true;
      stringQuote = ch;
      out += ch;
      continue;
    }

    if (ch === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
      out += "\n";
      continue;
    }

    if (ch === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) {
        if (text[i] === "\n") out += "\n";
        i += 1;
      }
      i += 1;
      continue;
    }

    out += ch;
  }
  return out;
}

function parseThemeJson(text) {
  return JSON.parse(stripJsonComments(text));
}

function readThemeFile(filePath) {
  const raw = parseThemeJson(fs.readFileSync(filePath, "utf8"));
  const fileBase = path.basename(filePath, path.extname(filePath));
  const id = normalizeThemeId(raw.id || fileBase);
  if (!id) return null;
  const name = normalizeThemeName(raw.name, fileBase);
  const base = normalizeThemeId(raw.base || id) || "dracula";
  const tokens = sanitizeTokens(raw.tokens);
  const overlayTokens = sanitizeTokens(raw.overlayTokens);
  const effects = sanitizeEffects(raw.effects);

  return {
    id,
    name,
    base,
    version: Number.isFinite(Number(raw.version)) ? Number(raw.version) : 1,
    source: raw.source === "user" ? "user" : "local",
    filePath,
    tokens,
    overlayTokens,
    effects,
  };
}

function ensureUserThemes() {
  fs.mkdirSync(userThemesFolder, { recursive: true });
  if (!fs.existsSync(defaultThemesFolder)) return;
  for (const entry of fs.readdirSync(defaultThemesFolder, {
    withFileTypes: true,
  })) {
    if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== ".json") {
      continue;
    }
    const source = path.join(defaultThemesFolder, entry.name);
    const target = path.join(userThemesFolder, entry.name);
    if (!fs.existsSync(target)) {
      fs.copyFileSync(source, target);
    } else {
      mergeMissingThemeDefaults(source, target);
    }
  }
}

function mergeMissingObjectKeys(target, defaults) {
  if (!target || typeof target !== "object" || Array.isArray(target)) {
    return false;
  }
  if (!defaults || typeof defaults !== "object" || Array.isArray(defaults)) {
    return false;
  }
  let changed = false;
  for (const [key, value] of Object.entries(defaults)) {
    if (!Object.prototype.hasOwnProperty.call(target, key)) {
      target[key] = value;
      changed = true;
    }
  }
  return changed;
}

function mergeMissingThemeDefaults(sourcePath, targetPath) {
  try {
    const defaults = parseThemeJson(fs.readFileSync(sourcePath, "utf8"));
    const current = parseThemeJson(fs.readFileSync(targetPath, "utf8"));
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return;
    }
    let changed = false;
    if (!current._comments || typeof current._comments !== "object") {
      current._comments = {};
      changed = true;
    }
    if (!current.tokens || typeof current.tokens !== "object") {
      current.tokens = {};
      changed = true;
    }
    changed =
      mergeMissingObjectKeys(current._comments, defaults?._comments) || changed;
    changed = mergeMissingObjectKeys(current.tokens, defaults?.tokens) || changed;
    changed =
      upgradeGeneratedSelectThemeTokens(current.tokens, defaults?.tokens) ||
      changed;
    if (changed) {
      fs.writeFileSync(
        targetPath,
        `${JSON.stringify(current, null, 2)}\n`,
        "utf8",
      );
    }
  } catch {
    // Invalid or locked user theme files are ignored so boot remains safe.
  }
}

function upgradeGeneratedSelectThemeTokens(tokens, defaults) {
  if (!tokens || typeof tokens !== "object" || Array.isArray(tokens)) {
    return false;
  }
  if (!defaults || typeof defaults !== "object" || Array.isArray(defaults)) {
    return false;
  }
  const selectedBg = String(tokens["app-select-option-selected-bg"] || "").trim();
  const hoverBg = String(tokens["app-select-option-hover-bg"] || "").trim();
  const defaultSelectedBg = String(
    defaults["app-select-option-selected-bg"] || "",
  ).trim();
  if (!selectedBg || !hoverBg || !defaultSelectedBg || selectedBg !== hoverBg) {
    return false;
  }
  tokens["app-select-option-selected-bg"] = defaultSelectedBg;
  return true;
}

function listThemes() {
  ensureUserThemes();
  const themes = [];
  const seen = new Set();
  for (const entry of fs.readdirSync(userThemesFolder, { withFileTypes: true })) {
    if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== ".json") {
      continue;
    }
    const filePath = path.join(userThemesFolder, entry.name);
    try {
      const theme = readThemeFile(filePath);
      if (!theme || seen.has(theme.id)) continue;
      seen.add(theme.id);
      themes.push(theme);
    } catch {
      // Invalid user theme files are ignored so a bad edit cannot break boot.
    }
  }
  themes.sort((a, b) => a.name.localeCompare(b.name));
  return themes;
}

function getThemeRegistryPayload() {
  return {
    folder: userThemesFolder,
    themes: listThemes(),
  };
}

function saveCustomTheme(draft, options = {}) {
  if (!draft || typeof draft !== "object" || Array.isArray(draft)) {
    throw new TypeError("Theme draft must be an object.");
  }
  const name = String(draft.name || "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 80);
  if (!name) throw new Error("Theme name is required.");
  const id = createCustomThemeId(draft.id || name);
  if (!id || BUILTIN_THEME_IDS.has(id)) {
    throw new Error("Theme name cannot be used.");
  }
  const base = normalizeThemeId(draft.base);
  if (!BUILTIN_THEME_IDS.has(base)) {
    throw new Error("Theme base is invalid.");
  }
  const tokens = sanitizeCustomThemeTokens(
    draft.tokens,
    CUSTOM_THEME_TOKEN_NAMES,
  );
  const overlayTokens = sanitizeCustomThemeTokens(
    draft.overlayTokens,
    CUSTOM_OVERLAY_TOKEN_NAMES,
  );
  if (!Object.keys(tokens).length) {
    throw new Error("Theme must contain at least one valid token.");
  }
  const effects = sanitizeEffects(draft.effects);
  const targetFolder = path.resolve(options.userThemesFolder || userThemesFolder);
  fs.mkdirSync(targetFolder, { recursive: true });
  const filePath = path.resolve(targetFolder, `${id}.json`);
  if (path.dirname(filePath) !== targetFolder) {
    throw new Error("Theme path is invalid.");
  }
  if (fs.existsSync(filePath)) {
    const error = new Error("A theme with this name already exists.");
    error.code = "THEME_EXISTS";
    throw error;
  }
  const payload = {
    id,
    name,
    version: 1,
    source: "user",
    base,
    tokens,
    overlayTokens,
    effects,
  };
  writeJsonAtomicSync(filePath, payload, { backup: false });
  return readThemeFile(filePath);
}

module.exports = {
  ensureUserThemes,
  getThemeRegistryPayload,
  listThemes,
  normalizeThemeId,
  createCustomThemeId,
  saveCustomTheme,
};
