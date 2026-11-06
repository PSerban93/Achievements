"use strict";

(() => {
  function init() {
    const select = document.getElementById("configList");
    if (!select) return;
    let panel = null, input = null, list = null, empty = null, rows = [], active = -1;
    const normalize = value => String(value || "").normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
    const t = (key, fallback) => window.i18nUi?.getString(key, fallback) || fallback;
    const isOpen = () => !!panel;
    const editingSearch = () => !!panel && window.OnScreenKeyboard?.isEditing(input) === true;

    function position() {
      if (!panel) return;
      const rect = select.getBoundingClientRect();
      if (!select.isConnected || !rect.width || !rect.height) { close(false); return; }
      const width = Math.min(Math.max(rect.width, 240), window.innerWidth - 16);
      const below = window.innerHeight - rect.bottom - 14, above = rect.top - 14;
      const upwards = below < 200 && above > below;
      const height = Math.min(360, Math.max(90, upwards ? above : below));
      panel.style.width = `${width}px`;
      panel.style.maxHeight = `${height}px`;
      panel.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))}px`;
      list.style.maxHeight = `${Math.max(30, height - 58)}px`;
      panel.style.top = `${upwards ? Math.max(8, rect.top - panel.getBoundingClientRect().height - 6) : rect.bottom + 6}px`;
    }

    function highlight(index, scroll = true) {
      active = rows.length ? Math.max(0, Math.min(rows.length - 1, index)) : -1;
      for (let i = 0; i < rows.length; i++) rows[i].element.setAttribute("aria-selected", String(i === active));
      if (active >= 0) {
        input.setAttribute("aria-activedescendant", rows[active].element.id);
        if (scroll) rows[active].element.scrollIntoView({ block: "nearest" });
      } else input.removeAttribute("aria-activedescendant");
    }

    function render() {
      if (!panel) return;
      if (select.disabled) { close(false); return; }
      const previous = rows[active]?.value || select.value;
      const terms = normalize(input.value).split(/\s+/).filter(Boolean);
      const fragment = document.createDocumentFragment();
      rows = [];
      for (const option of select.options) {
        if (option.disabled || option.hidden || !option.value) continue;
        const text = option.label || option.textContent || option.value;
        const haystack = normalize(`${text} ${option.value}`);
        if (!terms.every(term => haystack.includes(term))) continue;
        const element = document.createElement("button");
        element.type = "button"; element.tabIndex = -1;
        element.className = "config-search-option";
        element.id = `configSearchOption-${rows.length}`;
        element.setAttribute("role", "option");
        element.textContent = text; element.title = text;
        const value = option.value;
        element.addEventListener("pointerdown", event => event.preventDefault());
        element.addEventListener("click", () => commit(value));
        rows.push({ value, element }); fragment.appendChild(element);
      }
      list.replaceChildren(fragment);
      empty.hidden = rows.length > 0;
      empty.textContent = t("configSearch.noResults", "No matching configs.");
      input.placeholder = t("configSearch.placeholder", "Search configs…");
      input.setAttribute("aria-label", input.placeholder);
      highlight(Math.max(0, rows.findIndex(row => row.value === previous)), false);
      position();
    }

    function close(restoreFocus = true) {
      if (!panel) return;
      const focusedInside = panel.contains(document.activeElement);
      panel.remove(); panel = input = list = empty = null; rows = []; active = -1;
      select.removeAttribute("aria-expanded"); select.removeAttribute("aria-controls");
      window.removeEventListener("resize", position);
      document.removeEventListener("scroll", position, true);
      if (restoreFocus && focusedInside && select.isConnected) select.focus({ preventScroll: true });
    }

    function commit(value = rows[active]?.value) {
      if (!panel || !value) return;
      const option = Array.from(select.options).find(item => item.value === value && !item.disabled && !item.hidden);
      if (!option) { render(); return; }
      const previous = select.value;
      close();
      select.value = value;
      if (select.value !== previous) select.dispatchEvent(new Event("change", { bubbles: true }));
    }

    function open(query = "") {
      if (select.disabled || panel) return;
      panel = document.createElement("div");
      panel.id = "configSearchPopup"; panel.className = "config-search-popup";
      panel.style.font = getComputedStyle(select).font;
      input = document.createElement("input");
      input.id = "configSearchInput"; input.type = "search"; input.autocomplete = "off";
      input.spellcheck = false; input.value = query;
      input.setAttribute("role", "combobox"); input.setAttribute("aria-expanded", "true");
      input.setAttribute("aria-controls", "configSearchResults"); input.setAttribute("aria-autocomplete", "list");
      list = document.createElement("div"); list.id = "configSearchResults";
      list.className = "config-search-results"; list.setAttribute("role", "listbox");
      list.setAttribute("aria-label", select.labels?.[0]?.textContent.trim() || "Select Config");
      empty = document.createElement("div"); empty.className = "config-search-empty";
      empty.setAttribute("role", "status");
      panel.append(input, list, empty); document.body.appendChild(panel);
      select.setAttribute("aria-expanded", "true"); select.setAttribute("aria-controls", list.id);
      input.addEventListener("input", event => { if (!event.isComposing) render(); });
      input.addEventListener("compositionend", render);
      render(); input.focus({ preventScroll: true });
      highlight(active);
      window.addEventListener("resize", position);
      document.addEventListener("scroll", position, true);
    }

    function action(name) {
      if (!panel) return false;
      if (name === "UP" || name === "DOWN") highlight(active + (name === "DOWN" ? 1 : -1));
      else if (name === "HOME" || name === "END") highlight(name === "HOME" ? 0 : rows.length - 1);
      else if (name === "CONFIRM") commit();
      else if (name === "BACK") close();
      else if (name === "LEFT" || name === "RIGHT") return true;
      else { close(false); return false; }
      return true;
    }

    window.addEventListener("keydown", event => {
      if (panel) {
        // The keyboard owns these events while editing this popup's field.
        // In particular, Escape/Enter must not close or commit the config list.
        if (editingSearch()) return;
        if (event.isComposing) return;
        const actions = { ArrowUp: "UP", ArrowDown: "DOWN", Enter: "CONFIRM", Escape: "BACK" };
        if (actions[event.key] && !event.ctrlKey && !event.metaKey && !event.altKey) {
          event.preventDefault(); event.stopImmediatePropagation(); action(actions[event.key]);
        } else if (event.key === "Tab") close();
      } else if (event.target === select && !event.ctrlKey && !event.metaKey &&
        ((!event.altKey && (["Enter", " ", "ArrowDown", "F4"].includes(event.key) || event.key.length === 1)) ||
          event.altKey && event.key === "ArrowDown")) {
        event.preventDefault(); event.stopImmediatePropagation();
        open(["Enter", " ", "ArrowDown", "F4"].includes(event.key) ? "" : event.key);
      }
    }, true);
    select.addEventListener("pointerdown", event => {
      if (event.button !== 0 || select.disabled) return;
      event.preventDefault();
      if (panel) close(); else open();
    });
    select.addEventListener("change", () => close(false));
    document.addEventListener("pointerdown", event => {
      if (!editingSearch() && panel && event.target !== select && !panel.contains(event.target)) close(false);
    }, true);
    document.addEventListener("focusin", event => {
      if (!editingSearch() && panel && event.target !== select && !panel.contains(event.target)) close(false);
    });
    window.addEventListener("blur", () => { if (!editingSearch()) close(false); });
    new MutationObserver(render).observe(select, { childList: true, subtree: true, characterData: true,
      attributes: true, attributeFilter: ["value", "label", "disabled", "hidden", "selected"] });
    new MutationObserver(render).observe(document.documentElement, { attributes: true, attributeFilter: ["lang"] });
    window.ConfigListSearch = { open, close, isOpen, action,
      scroll(delta) { if (!panel) return false; list.scrollTop += delta; return true; } };
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init, { once: true });
  else init();
})();
