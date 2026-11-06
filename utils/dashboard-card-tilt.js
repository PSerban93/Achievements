"use strict";

(() => {
  const surface = document.getElementById("dashboardBody");
  if (!surface) return;
  const root = document.documentElement;
  const dashboard = document.getElementById("dashboardOverlay");
  const panel = document.getElementById("dashboardPanel");
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const values = window.Dashboard3DSettings;
  let settings = values.normalize();
  let enabled = false, card = null, bounds = null, frame = 0, pointer = null;
  let controllerCard = null, controllerHeld = false, controllerBlocked = false, controllerDraining = false;

  function resetVisual() {
    cancelAnimationFrame(frame); frame = 0; pointer = null;
    if (card) {
      card.classList.remove("dash-card-3d-hover");
      card.style.removeProperty("--dash-tilt-x");
      card.style.removeProperty("--dash-tilt-y");
    }
    card = bounds = null;
  }
  function reset() {
    if (controllerCard) {
      controllerBlocked = controllerHeld;
      controllerDraining = true;
    }
    controllerCard = null;
    resetVisual();
  }
  function available() {
    return enabled && !reducedMotion.matches && !document.hidden &&
      !document.body.classList.contains("booting") &&
      !root.classList.contains("settings-open") && !!surface.getClientRects().length;
  }
  function render() {
    frame = 0;
    if (!card?.isConnected || !card.getClientRects().length || !pointer || !available()) { reset(); return; }
    const x = Math.max(-1, Math.min(1, (pointer.x - bounds.left) / bounds.width * 2 - 1));
    const y = Math.max(-1, Math.min(1, (pointer.y - bounds.top) / bounds.height * 2 - 1));
    applyTilt(x, y);
  }
  function applyTilt(x, y) {
    for (const [property, value] of [["--dash-tilt-x", -y * settings.dashboard3dTiltX], ["--dash-tilt-y", x * settings.dashboard3dTiltY]]) {
      const next = `${value.toFixed(2)}deg`;
      if (card.style.getPropertyValue(property) !== next) card.style.setProperty(property, next);
    }
    card.classList.add("dash-card-3d-hover");
  }
  function controllerTarget(allowed) {
    const focused = document.activeElement;
    if (!allowed || !available() || !focused?.matches?.(".dash-card,.dashboard-collection-card") ||
        !surface.contains(focused) || !focused.getClientRects().length || focused.closest("[hidden],.hidden,[inert]") ||
        panel?.classList.contains("has-game-page") || panel?.classList.contains("dashboard-narrow-details") ||
        window.__dashboardContextMenuOpen || window.__dashboardContextMenuIgnoreClick ||
        window.OnScreenKeyboard?.isOpen() || window.ConfigListSearch?.isOpen() ||
        window.GameArtworkControls?.isOpen() || window.AchievementMediaViewer?.isOpen() ||
        panel?.querySelector("#dashboardViewMode[open],#dashboardSortMenu[open],select[data-sel-open='1']")) return null;
    return focused;
  }
  const analog = value => {
    const number = Number(value) || 0;
    return Math.abs(number) <= .15 ? 0 : Math.sign(number) * Math.min(1, (Math.abs(number) - .15) / .85);
  };
  function setControllerInput(input, allowed) {
    const level = Number(input.triggerValue) || 0;
    controllerHeld = input.triggerPressed === true || level > (controllerHeld ? .35 : .6);
    if (!controllerHeld) controllerBlocked = false;
    const neutral = !input.up && !input.down && !input.left && !input.right &&
      Math.abs(input.x || 0) <= .4 && Math.abs(input.y || 0) <= .4;
    const target = controllerTarget(allowed);
    if (controllerCard && (!controllerHeld || target !== controllerCard)) reset();
    if (!target) return false;
    if (!controllerHeld) {
      if (neutral) controllerDraining = false;
      return controllerDraining;
    }
    if (controllerBlocked) return controllerDraining;
    if (!controllerCard) {
      resetVisual();
      controllerCard = card = target;
      controllerDraining = true;
    }
    const x = input.left || input.right ? Number(!!input.right) - Number(!!input.left) : analog(input.x);
    const y = input.up || input.down ? Number(!!input.down) - Number(!!input.up) : analog(input.y);
    applyTilt(x, y);
    return true;
  }
  surface.addEventListener("pointermove", event => {
    if (controllerCard) return;
    if (event.pointerType !== "mouse" || !available()) { reset(); return; }
    // Keep the hit target stable during a click. Never cancel input events.
    if (event.buttons) return;
    const target = event.target.closest?.(".dash-card, .dashboard-collection-card");
    if (!target || !surface.contains(target)) { reset(); return; }
    if (target !== card) {
      reset(); card = target;
      // Re-reading a rotated bounding box on every move causes feedback jitter.
      bounds = card.getBoundingClientRect();
      if (!bounds.width || !bounds.height) { reset(); return; }
    }
    pointer = { x: event.clientX, y: event.clientY };
    if (!frame) frame = requestAnimationFrame(render);
  }, { passive: true });
  surface.addEventListener("pointerleave", () => { if (!controllerCard) reset(); });
  surface.addEventListener("pointercancel", reset);
  window.addEventListener("blur", reset);
  window.addEventListener("resize", reset);
  document.addEventListener("scroll", reset, { capture: true, passive: true });
  document.addEventListener("visibilitychange", reset);
  reducedMotion.addEventListener("change", reset);
  new MutationObserver(() => {
    if (card && (!card.isConnected || !card.getClientRects().length || !available())) reset();
  }).observe(surface, { childList: true, subtree: true });
  const layoutObserver = new MutationObserver(reset);
  if (panel) layoutObserver.observe(panel, { attributes: true, attributeFilter: ["data-card-layout"] });
  if (dashboard) layoutObserver.observe(dashboard, { attributes: true, attributeFilter: ["class", "style"] });
  layoutObserver.observe(surface, { attributes: true, attributeFilter: ["class", "style"] });
  layoutObserver.observe(root, { attributes: true, attributeFilter: ["class"] });

  window.AchievementsDashboard3D = {
    configure(preferences) {
      const next = values.normalize(preferences);
      if (values.fields.some(field => settings[field.key] !== next[field.key])) reset();
      settings = next;
      for (const [name, value] of Object.entries({
        "--dash-3d-zoom": String(settings.dashboard3dZoom / 100),
        "--dash-3d-lift": `${settings.dashboard3dLift}px`,
        "--dash-3d-perspective": `${settings.dashboard3dPerspective}px`,
        "--dash-3d-follow": `${settings.dashboard3dFollowMs}ms`,
        "--dash-3d-return": `${settings.dashboard3dReturnMs}ms`,
        "--dashboard-3d-clearance": `${Math.ceil(20 + settings.dashboard3dLift + (settings.dashboard3dZoom - 100) * 1.5 + Math.max(settings.dashboard3dTiltX, settings.dashboard3dTiltY) * 1.5)}px`,
      })) if (root.style.getPropertyValue(name) !== value) root.style.setProperty(name, value);
      this.setEnabled(preferences.dashboard3dEffects);
    },
    setEnabled(value) {
      const next = value === true;
      if (next !== enabled) reset();
      enabled = next;
      root.setAttribute("data-dashboard-3d", String(enabled));
      if (next !== window.__dashboard3dHintEnabled) {
        window.__dashboard3dHintEnabled = next;
        document.dispatchEvent(new CustomEvent("dashboard-3d:changed"));
      }
    },
    setControllerInput,
    resetController() { if (controllerCard) reset(); },
    isEnabled: () => enabled,
    reset,
  };
})();
