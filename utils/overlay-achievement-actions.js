/* Renderer-only controls. Never activate the overlay window or open native menus. */
(() => {
  "use strict";
  window.createOverlayAchievementActions = ({ api, list, t, closeFilters, reload }) => {
    let interactive = false, visible = false, configName = "", renderedConfig = "";
    let snapshot = {}, generation = 0, busy = false, anchor = "", confirmation = null;
    const selected = new Set();
    const menu = document.createElement("div");
    menu.id = "overlayAchievementMenu";
    menu.className = "overlay-action-menu";
    menu.hidden = true;
    menu.setAttribute("role", "menu");
    const dialog = document.createElement("div");
    dialog.id = "overlayAchievementDialog";
    dialog.className = "overlay-action-backdrop";
    dialog.hidden = true;
    const notice = document.createElement("div");
    notice.id = "overlayAchievementNotice";
    notice.className = "overlay-action-notice";
    notice.setAttribute("role", "status");
    notice.hidden = true;
    document.body.append(menu, dialog, notice);
    const tr = (key, fallback, values = {}) => String(t(key, fallback))
      .replace(/\{(\w+)\}/g, (whole, key) => Object.hasOwn(values, key) ? String(values[key]) : whole);
    const allowed = () => interactive && visible && configName && renderedConfig === configName;
    const rows = () => [...list.querySelectorAll(".achievement-item[data-achievement-name]")];
    const paint = () => rows().forEach(row => row.classList.toggle("overlay-action-selected",
      interactive && selected.has(row.dataset.achievementName)));
    const closeMenu = () => { menu.hidden = true; menu.replaceChildren(); };
    function cancel() {
      generation++;
      closeMenu();
      if (confirmation) confirmation(false);
      dialog.hidden = true;
      notice.hidden = true;
    }
    function notify(message, error = false) {
      if (!allowed()) return;
      notice.textContent = message;
      notice.classList.toggle("is-error", error);
      notice.hidden = false;
    }
    // Mouse interaction must not transfer Windows focus away from the game.
    for (const control of [menu, dialog, notice]) control.addEventListener("pointerdown", event => event.preventDefault());
    const itemButton = (text, action) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = text;
      button.dataset.action = action;
      return button;
    };
    function confirm({ title, message, detail, notes }, ticket) {
      if (!allowed() || generation !== ticket) return Promise.resolve(false);
      closeFilters();
      const panel = document.createElement("section");
      panel.className = "overlay-action-panel";
      panel.setAttribute("role", "dialog");
      panel.setAttribute("aria-modal", "true");
      panel.setAttribute("aria-labelledby", "overlayAchievementDialogTitle");
      for (const [tag, text, id] of [["h3", title, "overlayAchievementDialogTitle"], ["p", message],
        ["pre", detail], ["p", notes]]) {
        if (!text) continue;
        const element = document.createElement(tag);
        element.textContent = text;
        if (id) element.id = id;
        panel.append(element);
      }
      const buttons = document.createElement("div");
      buttons.className = "overlay-action-buttons";
      const cancelButton = itemButton(tr("main.dialog.confirm.cancel", "Cancel"), "cancel");
      const ok = itemButton(tr("main.dialog.confirm.ok", "OK"), "confirm");
      buttons.append(cancelButton, ok);
      panel.append(buttons);
      dialog.replaceChildren(panel);
      dialog.hidden = false;
      return new Promise(resolve => {
        const finish = answer => {
          confirmation = null;
          dialog.hidden = true;
          resolve(answer && allowed() && generation === ticket);
        };
        confirmation = finish;
        cancelButton.onclick = () => finish(false);
        ok.onclick = () => finish(true);
      });
    }
    async function run(action, target, ticket) {
      if (!allowed() || busy || generation !== ticket) return;
      busy = true;
      closeMenu();
      const restoring = action === "restore-locked";
      const sourceEdit = restoring || action === "mark-locked";
      try {
        let token;
        if (sourceEdit) {
          const prepared = await api.setAchievementManualState({ configName: target.configName,
            achievementNames: target.names, action: restoring ? "prepare-restore" : "prepare-lock" });
          if (!allowed() || generation !== ticket) return;
          if (!prepared?.success) throw new Error(prepared?.error || "Unable to prepare achievement edit");
          token = prepared.token;
          const confirmed = await confirm({
            title: restoring ? tr("achievementManualLockRestore", "Restore Last Achievement Backup") : tr("achievementManualLockTitle", "Lock achievements"),
            message: restoring ? tr("achievementManualLockRestoreConfirm", "Restore the achievement files and cache from the last backup? Changes made since that backup will be replaced.") :
              tr("achievementManualLockConfirm", "Lock {count} selected achievement(s) in the local save?", { count: prepared.updatedCount }),
            detail: [...(prepared.achievements || []).map(name => `• ${name}`), "", ...(prepared.files || []).map(file => `• ${file}`)].join("\n"),
            notes: tr("achievementManualLockNotes", "Close the game first. A backup is created before editing. Game saves and shared progress counters are preserved; the game may unlock an achievement again."),
          }, ticket);
          if (!confirmed) return;
        }
        if (!allowed() || generation !== ticket) return;
        const result = await api.setAchievementManualState({ configName: target.configName,
          achievementNames: target.names, action, ...(token ? { token } : {}) });
        if (!allowed() || generation !== ticket) return;
        if (!result?.success) throw new Error(result?.error || "Unable to update achievement state");
        await reload(target.configName);
        if (configName !== target.configName || !allowed()) return;
        const key = restoring ? "achievementManualLockRestored" : action === "mark-locked" ? "achievementManualLockDone" :
          action === "clear-manual" ? "achievementManualClearDone" : "achievementManualUnlockDone";
        notify(tr(key, "Achievement state updated."));
      } catch (error) {
        console.error("Overlay achievement action failed:", error);
        if (generation === ticket) notify(tr(sourceEdit ? "achievementManualLockFailed" : "achievementManualFailed", "Failed to update achievement state."), true);
      } finally { busy = false; }
    }
    async function open(row, event) {
      event.preventDefault();
      if (!allowed() || busy || !dialog.hidden) return;
      cancel();
      closeFilters();
      const name = row.dataset.achievementName;
      if (!selected.has(name)) { selected.clear(); selected.add(name); }
      anchor = name;
      paint();
      const ticket = generation, targetConfig = configName;
      let capabilities;
      try { capabilities = await api.setAchievementManualState({ configName: targetConfig, action: "lock-capabilities" }); }
      catch { return; }
      if (!allowed() || generation !== ticket || targetConfig !== configName) return;
      const ids = [...selected];
      const manual = ids.filter(id => snapshot[id]?.manual === true);
      const locked = ids.filter(id => !snapshot[id]?.earned && snapshot[id]?.manual !== true);
      const earned = ids.filter(id => snapshot[id]?.earned);
      const clear = snapshot[name]?.manual === true || (!locked.length && manual.length);
      const targets = clear ? manual : locked;
      if (targets.length) {
        const key = clear ? "achievementManualClearSelected" : "achievementManualUnlockSelected";
        const button = itemButton(tr(key, clear ? "Clear Manual Unlock ({count})" : "Mark Selected as Manually Unlocked ({count})", { count: targets.length }), clear ? "clear-manual" : "mark-unlocked");
        button.onclick = () => run(button.dataset.action, { configName: targetConfig, names: targets }, ticket);
        menu.append(button);
      }
      if (capabilities?.supported && earned.length) {
        const button = itemButton(tr("achievementManualLock", "Mark as Manually Locked ({count})", { count: earned.length }), "mark-locked");
        button.onclick = () => run("mark-locked", { configName: targetConfig, names: earned }, ticket);
        menu.append(button);
      }
      if (capabilities?.restorable) {
        const button = itemButton(tr("achievementManualLockRestore", "Restore Last Achievement Backup"), "restore-locked");
        button.onclick = () => run("restore-locked", { configName: targetConfig, names: [] }, ticket);
        menu.append(button);
      }
      if (!menu.childElementCount) return;
      menu.querySelectorAll("button").forEach(button => button.setAttribute("role", "menuitem"));
      menu.hidden = false;
      const pad = 8, bounds = menu.getBoundingClientRect();
      menu.style.left = `${Math.max(pad, Math.min(event.clientX, window.innerWidth - bounds.width - pad))}px`;
      menu.style.top = `${Math.max(pad, Math.min(event.clientY, window.innerHeight - bounds.height - pad))}px`;
    }
    list.addEventListener("contextmenu", event => {
      const row = event.target.closest(".achievement-item[data-achievement-name]");
      if (row) void open(row, event);
    });
    list.addEventListener("pointerdown", event => {
      if (!allowed() || busy || event.button !== 0 || !dialog.hidden || event.target.closest("button")) return;
      const row = event.target.closest(".achievement-item[data-achievement-name]");
      if (!row) return;
      const name = row.dataset.achievementName;
      if (event.shiftKey && anchor) {
        const shown = rows().filter(item => !item.hidden && item.style.display !== "none");
        const a = shown.findIndex(item => item.dataset.achievementName === anchor), b = shown.indexOf(row);
        if (a >= 0 && b >= 0) {
          if (!event.ctrlKey && !event.metaKey) selected.clear();
          shown.slice(Math.min(a, b), Math.max(a, b) + 1).forEach(item => selected.add(item.dataset.achievementName));
        }
      } else if (event.ctrlKey || event.metaKey) {
        if (selected.has(name)) selected.delete(name); else selected.add(name);
        anchor = name;
      } else { selected.clear(); selected.add(name); anchor = name; }
      if (event.ctrlKey || event.metaKey || event.shiftKey) event.preventDefault();
      paint();
    });
    document.addEventListener("pointerdown", event => {
      if (!menu.contains(event.target)) closeMenu();
      if (!notice.contains(event.target)) notice.hidden = true;
    });
    // Use only events already delivered to this renderer; no new global hooks.
    document.addEventListener("keydown", event => {
      if (event.key === "Escape" && (!menu.hidden || !dialog.hidden)) { cancel(); event.preventDefault(); }
    });
    list.closest(".overlay-container")?.addEventListener("scroll", closeMenu, { passive: true });
    window.addEventListener("resize", closeMenu);
    return {
      setInteractive(value) { interactive = value === true; if (!interactive) { cancel(); selected.clear(); } paint(); },
      setVisible(value) { visible = value === true; if (!visible) { cancel(); selected.clear(); } paint(); },
      setConfig(value) {
        const next = String(value || "");
        if (next !== configName) { cancel(); selected.clear(); renderedConfig = ""; snapshot = {}; configName = next; }
      },
      setData(name, data) {
        if (name !== configName) return;
        cancel(); snapshot = data || {}; renderedConfig = name;
        const ids = new Set(rows().map(row => row.dataset.achievementName));
        for (const id of selected) if (!ids.has(id)) selected.delete(id);
        paint();
      },
    };
  };
})();
