"use strict";

(function expose(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.AchievementsProgress = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  function parseProgressPreset(value) {
    const raw = typeof value === "string" ? value.trim() : "";
    if (raw.startsWith("san:") && raw.length > 4) return { type: "san", sanPreset: raw.slice(4) };
    if (raw.startsWith("native:") && raw.length > 7 && !/[\\/:]|^\.+$/.test(raw.slice(7))) {
      const preset = raw.slice(7);
      if (!["native windows", "game bar notifications"].includes(preset.toLowerCase())) return { type: "native", preset };
    }
    return { type: "default" };
  }

  function getProgressValues(data = {}) {
    const numeric = value => (typeof value === "number" || (typeof value === "string" && value.trim() !== "")) && Number.isFinite(Number(value));
    const current = numeric(data.progress) ? Math.max(0, Number(data.progress)) : null;
    const maximum = numeric(data.max_progress) && Number(data.max_progress) > 0 ? Number(data.max_progress) : null;
    const ratio = current !== null && maximum !== null ? Math.max(0, Math.min(1, current / maximum)) : null;
    return { current, maximum, ratio,
      count: current === null ? "—" : maximum === null ? String(current) : `${current} / ${maximum}`,
      percent: ratio === null ? "—" : `${Math.round(ratio * 100)}%` };
  }

  // Self-contained: also injected into native preset renderers without changing
  // their files. Only progress windows install this listener.
  function installProgressNotificationRenderer() {
    if (window.__achievementsProgressRenderer) return;
    let dispose = () => {};
    let lastPayload = null;
    function render(data) {
      if (data?.notificationType !== "progress") return;
      lastPayload = data;
      dispose();
      const values = data.progressValues;
      if (!values) return;
      let observer, resizeObserver, frame = 0, component, host, root;
      const timers = [], restores = [];
      let panelClips = [];
      const rotatingIcons = new WeakSet();
      const write = (element, property, value) => {
        const old = element.style.getPropertyValue(property), priority = element.style.getPropertyPriority(property);
        restores.push(() => old ? element.style.setProperty(property, old, priority) : element.style.removeProperty(property));
        element.style.setProperty(property, value, "important");
      };
      const style = document.createElement("style");
      style.textContent = `
        [data-ach-progress-host] > :not([data-ach-progress]){visibility:hidden!important;pointer-events:none!important}
        #achcontent[data-ach-progress-host]::before,#achcontent[data-ach-progress-host]::after,[data-ach-progress-host] #decoration,[data-ach-progress-host] #hiddenicon{visibility:hidden!important}
        [data-ach-progress]{position:absolute!important;display:grid!important;grid-template-columns:minmax(0,1fr)!important;align-content:center!important;box-sizing:border-box!important;min-width:0!important;margin:0!important;padding:0!important;overflow:hidden!important;pointer-events:none!important;z-index:20!important;visibility:inherit;opacity:1;animation:none!important;transform:none;translate:none;white-space:normal!important;line-height:1.15!important}
        [data-ach-progress] *{box-sizing:border-box!important;margin:0!important;padding:0!important;min-width:0!important;visibility:inherit!important;opacity:1!important;position:static!important;animation:none!important;transform:none!important;text-indent:0!important;letter-spacing:normal!important}
        [data-ach-progress-title]{display:block!important;font-weight:600!important;overflow:hidden!important;text-overflow:ellipsis!important;white-space:nowrap!important;line-height:1.15!important}
        [data-ach-progress-values]{display:flex!important;justify-content:space-between!important;gap:8px!important;line-height:1.15!important;font-weight:500!important;font-variant-numeric:tabular-nums!important}
        [data-ach-progress-values] span{overflow:hidden!important;text-overflow:ellipsis!important;white-space:nowrap!important}
        [data-ach-progress-track]{display:block!important;position:relative!important;overflow:hidden!important;border-radius:99px!important;background:color-mix(in srgb,currentColor 25%,transparent)!important;width:100%!important}
        [data-ach-progress-fill]{display:block!important;position:absolute!important;inset:0 auto 0 0!important;height:100%!important;border-radius:inherit!important;background:currentColor!important}
      `;
      document.head.appendChild(style);
      const textSelector = ".title,.title-inner,.achievement-title,#title,#unlockmsg";
      const hostSelector = ".text_wrap,.text-container,.copy,.text,#achcontent";
      const rootSelector = ".achievement-banner,.award-container,.banner,.notification,.arcade-card,.achievement,.dock,.ach,#achcont,#outerwrapper";
      const iconSelector = "#achiconwrapper,#achicon,.icon-frame,.badge,.icon-container,.icon,.icon img,.achievement-icon,.achievement-icon img,.ani_icon,.ani_icon img,.circle,.ringring";
      let titleSize = 16;
      // Work in layout pixels. Screen rectangles include pulse/entry scales;
      // using them to size the contents made text change size independently.
      const localBox = element => {
        let left = 0, top = 0;
        for (let current = element; current && current !== root; current = current.offsetParent) {
          left += current.offsetLeft;
          top += current.offsetTop;
          const transform = getComputedStyle(current).transform;
          if (transform && transform !== "none") {
            const matrix = new DOMMatrixReadOnly(transform);
            // Preserve placement translations (e.g. centred Batman copy),
            // while leaving scale/pulse to the preset's own compositor.
            left += matrix.e;
            top += matrix.f;
          }
        }
        return { left, top, width: element.offsetWidth, height: element.offsetHeight };
      };
      const centredIcon = element => {
        for (let current = element; current && current !== root; current = current.parentElement) {
          if (getComputedStyle(current).position !== "absolute" || current.offsetParent !== root) continue;
          if (Math.abs(current.offsetLeft - root.clientWidth / 2) < 2 ||
              Math.abs(current.offsetLeft + current.offsetWidth / 2 - root.clientWidth / 2) < 2) return true;
        }
        return false;
      };
      const clipInset = (value, size) => value?.endsWith("%") ? parseFloat(value) * size / 100 : parseFloat(value) || 0;
      const layout = () => {
        frame = 0;
        if (!component?.isConnected || !host?.isConnected || !root?.isConnected) return;
        const box = localBox(host), plate = { width: root.clientWidth, height: root.clientHeight };
        if (!(plate.width > 0 && plate.height > 0)) return;
        // Size against the panel, not the old title/description's intrinsic
        // height. Keep typography stable while a panel expands horizontally.
        const availableHeight = Math.max(0, plate.height - 12);
        const font = Math.max(12, Math.min(titleSize, 24, availableHeight / 2.5));
        const metric = Math.max(11, font * 0.78), gap = Math.max(2, font * 0.16), bar = Math.max(4, font * 0.28);
        const height = font * 1.15 + metric * 1.15 + gap * 2 + bar;
        const hostStyle = getComputedStyle(host);
        const paddingLeft = parseFloat(hostStyle.paddingLeft) || 0, paddingRight = parseFloat(hostStyle.paddingRight) || 0;
        let left = Math.max(box.left + paddingLeft, 10);
        let right = Math.min(box.left + box.width - paddingRight, plate.width - 10);
        const top = Math.max(4, Math.min(box.top + (box.height - height) / 2, plate.height - height - 4));
        // A docked panel reveals via clip-path rather than width. Progress
        // follows that exact reveal, with no separate delayed text animation.
        const inset = hostStyle.clipPath.match(/^inset\(([^)]*?)(?:\s+round\s+[^)]*)?\)$/);
        if (panelClips.length && inset) {
          const parts = inset[1].trim().split(/\s+/);
          const end = clipInset(parts[1] || parts[0], box.width);
          const start = clipInset(parts[3] || parts[1] || parts[0], box.width);
          left = Math.max(left, box.left + start + paddingLeft);
          right = Math.min(right, box.left + box.width - end - paddingRight);
        }
        // Docked text already has its own clipped panel. A moving icon in
        // front of it must not postpone or shift that panel's reveal.
        for (const element of panelClips.length ? [] : root.querySelectorAll(iconSelector)) {
          if (host.contains(element) || element.contains(host)) continue;
          // A centred morphing icon is a separate animation phase, not a text
          // column. Reserving its moving bounds made xqjan jump left/right.
          if (centredIcon(element)) continue;
          const icon = localBox(element);
          if (rotatingIcons.has(element)) {
            const extent = Math.hypot(icon.width, icon.height);
            icon.left -= (extent - icon.width) / 2;
            icon.top -= (extent - icon.height) / 2;
            icon.width = icon.height = extent;
          }
          if (!icon.width || !icon.height || icon.top + icon.height <= top || icon.top >= top + height) continue;
          if (icon.left < right + 14 && icon.left + icon.width + 14 > left) {
            // Use the panel's side rather than the changing text midpoint.
            if (icon.left + icon.width / 2 < plate.width / 2) left = Math.max(left, icon.left + icon.width + 14);
            else right = Math.min(right, icon.left - 14);
          }
        }
        const width = Math.max(0, right - left);
        const set = (property, value) => { if (component.style.getPropertyValue(property) !== value) component.style.setProperty(property, value, "important"); };
        set("left", `${left - box.left - host.clientLeft}px`);
        set("top", `${top - box.top - host.clientTop}px`);
        set("width", `${width}px`);
        set("height", `${height}px`);
        set("gap", `${gap}px`);
        // Zero-width content stays clipped rather than toggling visibility at
        // an arbitrary threshold. The host keeps its authored fade/scale.
        component.querySelector("[data-ach-progress-title]").style.setProperty("font-size", `${font}px`, "important");
        component.querySelector("[data-ach-progress-values]").style.setProperty("font-size", `${metric}px`, "important");
        component.querySelector("[data-ach-progress-track]").style.setProperty("height", `${bar}px`, "important");
        if (panelClips.some(a => {
          const progress = a.effect.getComputedTiming().progress;
          return a.playState === "running" && progress !== null && progress >= 0 && progress < 1;
        })) schedule();
      };
      const schedule = () => { if (!frame) frame = requestAnimationFrame(layout); };
      const onPanelStart = event => {
        if (event.target === host && panelClips.some(a => a.animationName === event.animationName)) schedule();
      };
      function attach() {
        if (component?.isConnected) return;
        const title = [...document.querySelectorAll(textSelector)].find(el => el.textContent.trim() === String(data.displayName || "").trim()) || document.querySelector(textSelector);
        host = title?.closest(hostSelector) || document.querySelector("#achcontent") || title?.parentElement;
        if (!host || ["BODY", "HTML"].includes(host.tagName)) return;
        root = host.parentElement?.closest(rootSelector) || host.parentElement;
        if (!root || root === document.body) return;
        for (const icon of root.querySelectorAll(iconSelector)) {
          const transform = getComputedStyle(icon).transform;
          const matrix = new DOMMatrixReadOnly(transform === "none" ? undefined : transform);
          if (Math.abs(matrix.b) > 0.001 || Math.abs(matrix.c) > 0.001 ||
              icon.getAnimations().some(a => a.effect?.getKeyframes().some(key => /rotate/i.test(key.transform || "")))) {
            rotatingIcons.add(icon);
          }
        }
        const textStyle = getComputedStyle(title || host);
        titleSize = Math.max(12, parseFloat(textStyle.fontSize) || 16);
        host.setAttribute("data-ach-progress-host", "");
        const hostAnimations = host.getAnimations();
        panelClips = hostAnimations.filter(a => a.effect?.getKeyframes().some(key => "clipPath" in key));
        const hasWidthSwitch = hostAnimations.some(a => a.effect?.getKeyframes().some(key => key.width === "auto"));
        if (hasWidthSwitch) {
          // SAN's docked panel switches 0 -> auto after expansion. Let its
          // grid text column grow with the panel instead of popping in late.
          write(host, "width", "auto");
          write(host, "min-width", "0");
          write(host, "justify-self", "stretch");
        }
        if (host.id === "achcontent" && host.computedStyleMap?.().get("width")?.toString() === "auto") {
          // Intrinsic grid items otherwise stay only as wide as the old short
          // description, leaving the available text column unused.
          write(host, "justify-self", "stretch");
          if (getComputedStyle(host).position === "absolute") {
            // Absolute SAN text slots otherwise remain shrink-to-fit even
            // with justify-self:stretch (including the SAN Steam template).
            write(host, "width", "100%");
          }
        }
        if (host.classList.contains("text_wrap") && getComputedStyle(root).display === "flex") {
          // Flex text columns should fill the space after the icon, including
          // LAZ0RBOX / PS5 enhanced, whose original text can be very short.
          write(host, "flex", "1 1 auto");
          if (root.computedStyleMap?.().get("width")?.toString() === "auto") {
            // Auto-sized plates must account for the progress heading's own
            // weight, not just the hidden original title (e.g. Indiana).
            const context = document.createElement("canvas").getContext("2d");
            if (context) {
              const font = Math.max(12, Math.min(titleSize, 24, Math.max(0, root.clientHeight - 12) / 2.5));
              context.font = `600 ${font}px ${textStyle.fontFamily}`;
              const rootStyle = getComputedStyle(root);
              const siblings = [...root.children].filter(el => el !== host && getComputedStyle(el).position !== "absolute");
              const reserved = siblings.reduce((sum, el) => sum + el.offsetWidth, 0) +
                (parseFloat(rootStyle.columnGap) || 0) * siblings.length +
                (parseFloat(rootStyle.paddingLeft) || 0) + (parseFloat(rootStyle.paddingRight) || 0);
              const width = Math.min(Math.ceil(context.measureText(String(data.displayName || "")).width) + 4,
                Math.max(0, window.innerWidth - reserved - 20));
              write(host, "min-width", `${width}px`);
            }
          }
        }
        if (getComputedStyle(host).position === "static") write(host, "position", "relative");
        write(host, "overflow", "visible");
        if (!root.getAnimations().some(a => a.effect?.getKeyframes().some(key => "width" in key))) {
          // Fixed panels keep the progress block steady. Morphing panels
          // retain their authored text-hide phase while changing shape.
          write(host, "opacity", "1");
        }
        // Text rows keep the authored layout footprint; a single independent
        // block avoids the preset's alternating title/description animations.
        component = document.createElement("div");
        component.setAttribute("data-ach-progress", "");
        component.style.color = textStyle.color;
        component.style.fontFamily = textStyle.fontFamily;
        const heading = document.createElement("div");
        heading.setAttribute("data-ach-progress-title", "");
        heading.textContent = String(data.displayName || "");
        heading.title = heading.textContent;
        const row = document.createElement("div");
        row.setAttribute("data-ach-progress-values", "");
        for (const text of [values.count, values.percent]) {
          const span = document.createElement("span"); span.textContent = text; span.title = text; row.appendChild(span);
        }
        const track = document.createElement("div");
        track.setAttribute("data-ach-progress-track", "");
        track.setAttribute("role", "progressbar");
        track.setAttribute("aria-label", heading.textContent);
        track.setAttribute("aria-valuemin", "0");
        if (values.ratio !== null) {
          track.setAttribute("aria-valuemax", String(values.maximum));
          track.setAttribute("aria-valuenow", String(Math.min(values.current, values.maximum)));
        }
        track.setAttribute("aria-valuetext", values.count);
        const fill = document.createElement("div");
        fill.setAttribute("data-ach-progress-fill", "");
        fill.style.setProperty("width", `${(values.ratio || 0) * 100}%`, "important");
        track.appendChild(fill);
        component.append(heading, row, track);
        host.appendChild(component);
        // Authored countdown bars (e.g. Modern) are not achievement progress.
        root.querySelectorAll(".progress-bar").forEach(el => { if (!host.contains(el)) write(el, "display", "none"); });
        resizeObserver = new ResizeObserver(schedule);
        for (const element of new Set([host, root, ...root.querySelectorAll(iconSelector)])) resizeObserver.observe(element);
        observer?.disconnect();
        root.addEventListener("animationend", schedule, true);
        root.addEventListener("animationiteration", schedule, true);
        root.addEventListener("animationstart", onPanelStart, true);
        for (const delay of [80, 250, 500, 1000, 1800, 3000]) timers.push(setTimeout(schedule, delay));
        schedule();
      }
      observer = new MutationObserver(attach);
      observer.observe(document.body, { childList: true, subtree: true });
      timers.push(setTimeout(() => observer?.disconnect(), 5000));
      dispose = () => {
        observer?.disconnect(); resizeObserver?.disconnect(); cancelAnimationFrame(frame);
        timers.forEach(clearTimeout);
        root?.removeEventListener("animationend", schedule, true);
        root?.removeEventListener("animationiteration", schedule, true);
        root?.removeEventListener("animationstart", onPanelStart, true);
        component?.remove(); host?.removeAttribute("data-ach-progress-host");
        restores.reverse().forEach(restore => restore()); style.remove();
      };
      attach();
    }
    window.__achievementsProgressRenderer = { render, dispose: () => dispose(), refresh: () => {
      if (lastPayload && !document.querySelector("[data-ach-progress]")) render(lastPayload);
    } };
    window.api?.onNotification?.(render);
    window.addEventListener("pagehide", () => dispose(), { once: true });
  }
  return { parseProgressPreset, getProgressValues, installProgressNotificationRenderer };
});
