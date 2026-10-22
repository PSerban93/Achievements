"use strict";
window.createNotificationMonitorControls = function ({ api, translate, saved, error }) {
  const select = document.getElementById("settings-notificationMonitorSelect");
  const status = document.getElementById("settings-notificationMonitorStatus");
  let state = null, saving = false;
  const t = (key, fallback) => translate(`notificationMonitor.${key}`, fallback);
  function render(payload = state) {
    if (!select || !payload || saving) return;
    state = payload;
    const options = [new Option(t("primary", "Primary monitor"), "")];
    for (const [index, display] of payload.displays.entries()) {
      options.push(new Option(`${index + 1} — ${display.label || `${display.bounds.width} × ${display.bounds.height}`} (${display.bounds.width} × ${display.bounds.height})`, display.id));
    }
    const missing = payload.preferredId && !payload.displays.some(d => d.id === payload.preferredId);
    if (missing) options.push(new Option(t("unavailable", "Selected monitor (disconnected)"), payload.preferredId));
    select.replaceChildren(...options);
    select.value = payload.preferredId || "";
    const active = payload.displays.find(d => d.id === payload.activeId);
    status.textContent = missing ? t("fallback", "Temporarily using: {monitor}").replace("{monitor}", active?.label || t("primary", "Primary monitor")) : "";
    status.hidden = !missing;
  }
  async function refresh() {
    try { render(await api.listNotificationDisplays()); } catch { /* Retain the last usable list. */ }
  }
  select?.addEventListener("change", async () => {
    saving = true;
    select.disabled = true;
    try { await api.savePreferences({ notificationMonitorId: select.value }); await saved?.(); }
    catch { error(t("saveFailed", "Could not save the selected monitor.")); }
    finally { saving = false; select.disabled = false; await refresh(); }
  });
  api.onNotificationDisplaysChanged?.(render);
  void refresh();
  return { refresh };
};
