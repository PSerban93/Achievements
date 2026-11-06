/* Shared table presentation; never changes window focus or reads save files. */
(() => {
  "use strict";
  window.createAchievementPinsView = ({ api, getConfig, rows, sort, t, preserveFocus = false }) => {
    let configName = "", state = { ids: [], revision: 0, scope: "" };
    function paint() {
      const pinned = new Set(state.ids);
      for (const row of rows()) {
        const active = pinned.has(row.dataset.achievementName) && row.dataset.sortUnlocked !== "1";
        row.dataset.pinned = active ? "1" : "0";
        let badge = row.querySelector(".achievement-pin-badge");
        if (active && !badge) {
          const title = row.querySelector("td.displayName > strong, .achievement-name");
          if (title) {
            badge = document.createElement("span");
            badge.className = "achievement-pin-badge";
            badge.textContent = "📌";
            title.prepend(badge);
          }
        }
        if (badge) {
          badge.hidden = !active;
          badge.title = t("achievementPins.pinned", "Pinned achievement");
          badge.setAttribute("aria-label", badge.title);
        }
      }
    }
    function setData(name, next) {
      if (name !== getConfig()) return false;
      const previous = JSON.stringify([configName, state]);
      if (name !== configName || (next?.scope && next.scope !== state.scope)) {
        configName = name; state = { ids: [], revision: 0, scope: next?.scope || "" };
      }
      if ((Number(next?.revision) || 0) >= state.revision) state = { ids: next?.ids || [], revision: Number(next?.revision) || 0, scope: next?.scope || state.scope };
      paint();
      return previous !== JSON.stringify([configName, state]);
    }
    function refresh() {
      const elements = rows(), focus = document.activeElement;
      const keepFocus = preserveFocus && elements.some(row => row.contains(focus));
      const positions = [];
      for (let element = elements[0]?.parentElement; element; element = element.parentElement) {
        positions.push([element, element.scrollTop, element.scrollLeft]);
      }
      paint();
      sort();
      if (keepFocus && focus?.isConnected) focus.focus({ preventScroll: true });
      for (const [element, top, left] of positions) { element.scrollTop = top; element.scrollLeft = left; }
    }
    api.on("achievement-pins:changed", payload => {
      if (payload?.configName !== getConfig() || payload.configName !== configName) return;
      if (state.scope && payload.scope !== state.scope) return;
      setData(payload.configName, payload);
      refresh();
    });
    api.on("configs:changed", () => {
      // Renames/deletions/replacements can reuse a config name and schema path.
      state = { ...state, revision: 0 };
    });
    return { setData, paint, refresh };
  };
})();
