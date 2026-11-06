"use strict";

(() => {
  let modal = null, host = null, view = null, layout = null, opening = null, returnFocus = null;
  let pendingSizeSave = Promise.resolve();
  const background = new Map();
  const scripts = new Map();
  const isOpen = () => !!modal && !modal.classList.contains("hidden");
  function loadScript(src) {
    if (scripts.has(src)) return scripts.get(src);
    const promise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = src;
      script.onload = resolve;
      script.onerror = () => { scripts.delete(src); script.remove(); reject(new Error(`Cannot load ${src}`)); };
      document.head.appendChild(script);
    });
    scripts.set(src, promise);
    return promise;
  }
  function stylesheet(root, href) {
    return new Promise((resolve, reject) => {
      const link = document.createElement("link");
      link.rel = "stylesheet"; link.href = href;
      link.onload = resolve;
      link.onerror = () => reject(new Error(`Cannot load ${href}`));
      root.appendChild(link);
    });
  }
  function close() {
    if (!isOpen()) return;
    layout?.finish();
    view?.suspend();
    host.shadowRoot.activeElement?.blur();
    modal.classList.add("hidden"); modal.inert = true;
    modal.setAttribute("aria-hidden", "true");
    for (const [element, wasInert] of background) if (element.isConnected) element.inert = wasInert;
    background.clear();
    if (returnFocus?.isConnected && !returnFocus.closest("[inert]")) returnFocus.focus({ preventScroll: true });
    returnFocus = null;
  }
  async function createPanel() {
    const response = await fetch("utils/achievement-enabler/index.html");
    if (!response.ok) throw new Error("Cannot load Achievement Enabler.");
    const template = new DOMParser().parseFromString(await response.text(), "text/html")
      .getElementById("achievementEnablerTemplate");
    if (!(template instanceof HTMLTemplateElement)) throw new Error("Invalid Achievement Enabler interface.");
    await loadScript("node_modules/@xterm/xterm/lib/xterm.js");
    await loadScript("node_modules/@xterm/addon-fit/lib/addon-fit.js");
    await loadScript("utils/achievement-enabler/renderer.js");
    await loadScript("utils/modal-layout.js");
    modal = document.createElement("div");
    modal.id = "achievementEnablerModal"; modal.className = "modal hidden";
    modal.setAttribute("role", "dialog"); modal.setAttribute("aria-modal", "true");
    modal.setAttribute("aria-label", "Achievement Enabler"); modal.setAttribute("aria-hidden", "true");
    modal.inert = true;
    host = document.createElement("div"); host.className = "modal-content achievement-enabler-content";
    const root = host.attachShadow({ mode: "open" });
    root.appendChild(template.content.cloneNode(true));
    const handles = ["nw", "ne", "sw", "se"].map(direction => {
      const handle = document.createElement("div");
      handle.className = `settings-resize-handle settings-resize-handle--${direction}`;
      handle.slot = "resize-handles"; handle.dataset.modalResize = direction;
      handle.setAttribute("aria-hidden", "true"); host.appendChild(handle);
      return handle;
    });
    modal.appendChild(host); document.body.appendChild(modal);
    try {
      await Promise.all([
        stylesheet(root, "node_modules/@xterm/xterm/css/xterm.css"),
        stylesheet(root, "utils/achievement-enabler/style.css"),
      ]);
      view = await window.AchievementEnablerView.mount(root, {
        enabler: { command: window.api.achievementEnablerCommand, subscribe: window.api.onAchievementEnablerEvent },
        onClose: close, isVisible: isOpen,
      });
      layout = window.AchievementsModalLayout.create({ overlay: modal, content: host, handles, isVisible: isOpen,
        onSave: size => {
          pendingSizeSave = pendingSizeSave.then(() => window.api.savePreferences({ achievementEnablerModalSize: size }))
            .catch(error => console.warn("achievement-enabler:size-save-failed", error));
        },
      });
    } catch (error) {
      layout?.destroy(); view?.destroy(); layout = view = null;
      modal.remove(); modal = host = null; throw error;
    }
  }
  async function open() {
    if (opening) return opening;
    if (isOpen()) { view.focus(); return; }
    const opener = document.activeElement;
    opening = (async () => {
      await window.api.openAchievementEnabler();
      if (!view) await createPanel();
      await pendingSizeSave;
      const preferences = await window.api.loadPreferences();
      returnFocus = opener;
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      for (const element of [...document.body.children, document.getElementById("settingsBtn")]) {
        if (!(element instanceof HTMLElement) || element === modal || element.id === "titlebar") continue;
        background.set(element, element.inert); element.inert = true;
      }
      modal.inert = false; modal.classList.remove("hidden"); modal.setAttribute("aria-hidden", "false");
      layout.apply(preferences?.achievementEnablerModalSize);
      view.suspend(); view.focus();
    })();
    try { await opening; } catch (error) { close(); throw error; } finally { opening = null; }
  }
  window.AchievementEnablerPanel = { open, close, isOpen, refreshAppearance: () => view?.refreshAppearance() };
})();
