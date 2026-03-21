(() => {
  const DEFAULT_LANG = "english";
  const LOCALE_BASE = "assets/locales";
  let cachedLang = "";
  let cachedStrings = null;

  const cssEscape = (value) => {
    if (window.CSS && typeof window.CSS.escape === "function") {
      return window.CSS.escape(value);
    }
    return String(value || "").replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  };

  const normalizeLang = (value) => {
    const raw = String(value || "").trim().toLowerCase();
    if (!raw) return DEFAULT_LANG;
    return raw === "latam" || raw === "es-419" ? "latam" : raw;
  };

  async function fetchLocaleFile(lang) {
    const normalized = normalizeLang(lang);
    const url = `${LOCALE_BASE}/${encodeURIComponent(normalized)}.json`;
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (res.ok) return await res.json();
    } catch {}
    return {};
  }

  async function fetchLocale(lang) {
    const normalized = normalizeLang(lang);
    const englishStrings = await fetchLocaleFile(DEFAULT_LANG);
    if (normalized === DEFAULT_LANG) return englishStrings;
    const localizedStrings = await fetchLocaleFile(normalized);
    return {
      ...(englishStrings && typeof englishStrings === "object"
        ? englishStrings
        : {}),
      ...(localizedStrings && typeof localizedStrings === "object"
        ? localizedStrings
        : {}),
    };
  }

  function applyLocaleStrings(strings) {
    if (!strings || typeof strings !== "object") return;
    for (const [key, value] of Object.entries(strings)) {
      if (typeof value !== "string") continue;
      if (key.startsWith("label.")) {
        const id = key.slice("label.".length);
        const el = document.querySelector(`label[for="${cssEscape(id)}"]`);
        if (el) {
          const hasElementChild = Array.from(el.childNodes).some(
            (node) => node.nodeType === 1,
          );
          let textNode = null;
          for (const node of el.childNodes) {
            if (node.nodeType === 3 && node.textContent.trim() !== "") {
              textNode = node;
              break;
            }
          }
          if (!textNode) {
            textNode = document.createTextNode("");
            el.insertBefore(textNode, el.firstChild);
          }
          const suffix = hasElementChild && !/\\s$/.test(value) ? " " : "";
          textNode.textContent = value + suffix;
        }
        continue;
      }
      if (key.startsWith("placeholder.")) {
        const id = key.slice("placeholder.".length);
        const el = document.getElementById(id);
        if (el) el.setAttribute("placeholder", value);
        continue;
      }
      if (key.startsWith("title.")) {
        const id = key.slice("title.".length);
        const el = document.getElementById(id);
        if (el) el.setAttribute("title", value);
        continue;
      }
      if (key.startsWith("aria.")) {
        const id = key.slice("aria.".length);
        const el = document.getElementById(id);
        if (el) el.setAttribute("aria-label", value);
        continue;
      }
      if (key.startsWith("option.")) {
        const rest = key.slice("option.".length);
        const [selectId, optionValue] = rest.split(".");
        if (!selectId || optionValue === undefined) continue;
        const select = document.getElementById(selectId);
        if (!select) continue;
        const opt = select.querySelector(
          `option[value="${cssEscape(optionValue)}"]`,
        );
        if (opt) opt.textContent = value;
        continue;
      }
      const el = document.getElementById(key);
      if (el) el.textContent = value;
    }

    document.querySelectorAll("[data-i18n]").forEach((el) => {
      const key = el.getAttribute("data-i18n");
      if (!key) return;
      const value = strings[key];
      if (typeof value === "string") {
        el.textContent = value;
      }
    });
  }

  async function setUiLanguage(lang) {
    const normalized = normalizeLang(lang);
    if (cachedLang === normalized && cachedStrings) {
      applyLocaleStrings(cachedStrings);
      return cachedStrings;
    }
    const strings = await fetchLocale(normalized);
    cachedLang = normalized;
    cachedStrings = strings;
    applyLocaleStrings(strings);
    return strings;
  }

  function getString(key, fallback = "") {
    if (!key) return fallback;
    const strings = cachedStrings || {};
    const value = strings[key];
    if (typeof value === "string") return value;
    return fallback || String(key);
  }

  async function autoApplyFromPrefs() {
    if (!window.api || typeof window.api.loadPreferences !== "function") return;
    try {
      const prefs = await window.api.loadPreferences();
      const lang = prefs?.uiLanguage || prefs?.language || DEFAULT_LANG;
      await setUiLanguage(lang);
    } catch {}
  }

  window.i18nUi = {
    setUiLanguage,
    applyLocaleStrings,
    getString,
    getStrings: () => cachedStrings,
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", autoApplyFromPrefs);
  } else {
    autoApplyFromPrefs();
  }
})();
