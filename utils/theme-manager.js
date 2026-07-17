const fs = require("fs");
const path = require("path");
const {
  defaultThemesFolder,
  userThemesFolder,
} = require("./paths");

const THEME_ID_RE = /^[a-z0-9][a-z0-9._-]{0,79}$/i;
const TOKEN_RE = /^(?:--)?app-[a-z0-9-]+$/i;

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
  if (!text || /[{};]/.test(text)) return "";
  return text;
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
    }
  }
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

module.exports = {
  ensureUserThemes,
  getThemeRegistryPayload,
  listThemes,
  normalizeThemeId,
};
