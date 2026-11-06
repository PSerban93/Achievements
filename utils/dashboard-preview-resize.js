"use strict";

// Preview shares the Settings grips and pointer-capture lifecycle. Its compact
// layout stays docked, while floating/expanded details resize around the center.
window.DashboardPreviewResize = {
  create({ panel, view, library, getSize, onSave, isExpanded, isVisible, onLayout }) {
    const doc = view.ownerDocument, win = doc.defaultView;
    const clamp = (n, min, max) => Math.min(max, Math.max(Math.min(min, max), n));
    let active = null, draft = null;
    const mode = () => isExpanded() ? "expanded" : "compact";
    const docked = () => !isExpanded() && !panel.classList.contains("dashboard-narrow-details");
    const handles = ["nw", "ne", "sw", "se", "w", "s"].map(direction => {
      const handle = doc.createElement("div");
      handle.className = `settings-resize-handle settings-resize-handle--${direction} dashboard-preview-resize`;
      handle.dataset.previewResize = direction; handle.setAttribute("aria-hidden", "true"); view.append(handle);
      return handle;
    });
    function bounds() {
      const rect = panel.getBoundingClientRect();
      const scaleX = rect.width / panel.offsetWidth || 1, scaleY = rect.height / panel.offsetHeight || 1;
      const width = panel.clientWidth, height = panel.clientHeight;
      const top = isExpanded() ? 12 : parseFloat(panel.style.getPropertyValue("--dashboard-details-top")) || 12;
      const bottom = parseFloat(panel.style.getPropertyValue("--dashboard-details-bottom")) || 10;
      const dock = docked();
      return { width, height, top, bottom, dock, scaleX, scaleY,
        maxWidth: Math.max(1, dock ? width - Math.min(260, width * 0.45) - 10 : width - 24),
        maxHeight: Math.max(1, dock ? library.clientHeight - 20 : height - top - bottom),
        minWidth: isExpanded() ? 560 : 280, minHeight: isExpanded() ? 400 : 260 };
    }
    function setStyle(el, key, value) { if (el.style.getPropertyValue(key) !== value) el.style.setProperty(key, value); }
    function apply() {
      if (!isVisible()) return;
      const b = bounds(), value = draft || getSize()?.[mode()];
      const fallbackWidth = b.dock ? clamp(b.width * 0.36, 350, 460) - 10 : b.maxWidth;
      const size = { width: Math.round(clamp(value?.width || fallbackWidth, b.minWidth, b.maxWidth)),
        height: Math.round(clamp(value?.height || b.maxHeight, b.minHeight, b.maxHeight)) };
      setStyle(view, "width", `${size.width}px`); setStyle(view, "height", `${size.height}px`);
      for (const key of ["left", "right", "top", "bottom"]) view.style.removeProperty(key);
      if (b.dock) setStyle(panel, "--dashboard-preview-width", `${size.width + 10}px`);
      else {
        panel.style.removeProperty("--dashboard-preview-width");
        setStyle(view, "left", `${Math.round((b.width - size.width) / 2)}px`);
        setStyle(view, "top", `${Math.round(b.top + (b.maxHeight - size.height) / 2)}px`);
        setStyle(view, "right", "auto"); setStyle(view, "bottom", "auto");
      }
      for (const handle of handles) handle.hidden = b.dock
        ? !["w", "sw", "s"].includes(handle.dataset.previewResize)
        : ["w", "s"].includes(handle.dataset.previewResize);
      view.classList.toggle("dashboard-preview-docked", b.dock);
      onLayout();
    }
    function finish(persist = true) {
      const state = active;
      if (!state) return;
      active = null;
      for (const [name, fn] of [["pointermove", state.move], ["pointerup", state.end], ["pointercancel", state.end], ["lostpointercapture", state.end]]) state.handle.removeEventListener(name, fn);
      try { if (state.handle.hasPointerCapture(state.id)) state.handle.releasePointerCapture(state.id); } catch {}
      view.classList.remove("dashboard-preview-resizing"); doc.documentElement.style.cursor = state.cursor;
      const size = draft; draft = null;
      if (persist && size) onSave({ ...getSize(), [state.mode]: size });
      else apply();
    }
    function begin(event) {
      if (event.button !== 0 || active || !isVisible()) return;
      const handle = event.currentTarget, direction = handle.dataset.previewResize;
      const b = bounds(), rect = view.getBoundingClientRect(), startMode = mode();
      const start = { x: event.clientX, y: event.clientY, width: rect.width / b.scaleX, height: rect.height / b.scaleY };
      const move = ev => {
        if (ev.pointerId !== event.pointerId) return;
        if (!isVisible() || mode() !== startMode || docked() !== b.dock) { finish(false); return; }
        const limit = bounds(), factor = b.dock ? 1 : 2;
        const dx = (ev.clientX - start.x) / b.scaleX, dy = (ev.clientY - start.y) / b.scaleY;
        draft = {
          width: Math.round(clamp(start.width + (/[we]/.test(direction) ? dx * (direction.includes("w") ? -factor : factor) : 0), limit.minWidth, limit.maxWidth)),
          height: Math.round(clamp(start.height + (/[ns]/.test(direction) ? dy * (direction.includes("n") ? -factor : factor) : 0), limit.minHeight, limit.maxHeight)),
        };
        apply(); ev.preventDefault();
      };
      const end = ev => { if (ev.pointerId === event.pointerId) finish(); };
      active = { handle, id: event.pointerId, move, end, mode: startMode, cursor: doc.documentElement.style.cursor };
      view.classList.add("dashboard-preview-resizing"); doc.documentElement.style.cursor = win.getComputedStyle(handle).cursor;
      for (const [name, fn] of [["pointermove", move], ["pointerup", end], ["pointercancel", end], ["lostpointercapture", end]]) handle.addEventListener(name, fn);
      try { handle.setPointerCapture(event.pointerId); } catch { finish(false); return; }
      event.preventDefault(); event.stopPropagation();
    }
    for (const handle of handles) handle.addEventListener("pointerdown", begin);
    return { apply, finish };
  },
};
