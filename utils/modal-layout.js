"use strict";

(function expose(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.AchievementsModalLayout = api;
})(typeof globalThis !== "undefined" ? globalThis : this, () => {
  const clamp = (value, min, max) => Math.min(Math.max(Number(value) || min, min), max);
  function create({ overlay, content, handles, defaultWidth = 1100, defaultHeight = 880,
    minWidth = 560, minHeight = 520, edgeGap = 12, onSave = () => {}, isVisible = () => true }) {
    const doc = overlay.ownerDocument, win = doc.defaultView;
    let active = null;
    const limits = () => ({ width: overlay.clientWidth, height: overlay.clientHeight,
      maxWidth: Math.max(0, overlay.clientWidth - edgeGap * 2),
      maxHeight: Math.max(0, overlay.clientHeight - edgeGap * 2) });
    function apply(value) {
      const bound = limits();
      if (!bound.maxWidth || !bound.maxHeight) return;
      const size = {
        width: Math.round(clamp(value?.width || defaultWidth, Math.min(minWidth, bound.maxWidth), bound.maxWidth)),
        height: Math.round(clamp(value?.height || defaultHeight, Math.min(minHeight, bound.maxHeight), bound.maxHeight)),
      };
      content.classList.add("modal-resize-positioned");
      Object.assign(content.style, { width: `${size.width}px`, height: `${size.height}px`,
        maxWidth: `${bound.maxWidth}px`, maxHeight: `${bound.maxHeight}px`,
        left: `${Math.round((bound.width - size.width) / 2)}px`,
        top: `${Math.round((bound.height - size.height) / 2)}px` });
    }
    function finish(persist = true) {
      const state = active;
      if (!state) return;
      active = null;
      for (const [event, handler] of [["pointermove", state.move], ["pointerup", state.end],
        ["pointercancel", state.end], ["lostpointercapture", state.end]]) state.handle.removeEventListener(event, handler);
      try { if (state.handle.hasPointerCapture(state.id)) state.handle.releasePointerCapture(state.id); } catch {}
      content.classList.remove("modal-resizing");
      doc.documentElement.style.cursor = state.cursor;
      if (persist) {
        const rect = content.getBoundingClientRect();
        onSave({ width: Math.round(rect.width), height: Math.round(rect.height) });
      }
    }
    function begin(event) {
      if (event.button !== 0 || active || !isVisible()) return;
      const handle = event.currentTarget, direction = handle.dataset.modalResize;
      if (!/^(?:nw|ne|sw|se)$/.test(direction)) return;
      const parent = overlay.getBoundingClientRect(), rect = content.getBoundingClientRect();
      const start = { x: event.clientX, y: event.clientY, width: rect.width, height: rect.height,
        centerX: rect.left - parent.left + rect.width / 2, centerY: rect.top - parent.top + rect.height / 2 };
      const move = ev => {
        if (ev.pointerId !== event.pointerId) return;
        const bound = limits();
        const maxWidth = Math.max(0, Math.min(start.centerX - edgeGap, bound.width - edgeGap - start.centerX) * 2);
        const maxHeight = Math.max(0, Math.min(start.centerY - edgeGap, bound.height - edgeGap - start.centerY) * 2);
        const width = clamp(start.width + (ev.clientX - start.x) * (direction.includes("w") ? -2 : 2), Math.min(minWidth, maxWidth), maxWidth);
        const height = clamp(start.height + (ev.clientY - start.y) * (direction.includes("n") ? -2 : 2), Math.min(minHeight, maxHeight), maxHeight);
        Object.assign(content.style, { width: `${Math.round(width)}px`, height: `${Math.round(height)}px`,
          left: `${Math.round(start.centerX - width / 2)}px`, top: `${Math.round(start.centerY - height / 2)}px` });
        ev.preventDefault();
      };
      const end = ev => { if (ev.pointerId === event.pointerId) finish(); };
      active = { handle, id: event.pointerId, move, end, cursor: doc.documentElement.style.cursor };
      content.classList.add("modal-resizing"); doc.documentElement.style.cursor = win.getComputedStyle(handle).cursor;
      for (const [name, handler] of [["pointermove", move], ["pointerup", end], ["pointercancel", end], ["lostpointercapture", end]]) handle.addEventListener(name, handler);
      try { handle.setPointerCapture(event.pointerId); } catch { finish(false); return; }
      event.preventDefault(); event.stopPropagation();
    }
    const resize = () => {
      if (!isVisible()) return;
      finish(false);
      const rect = content.getBoundingClientRect();
      apply({ width: rect.width, height: rect.height });
    };
    for (const handle of handles) handle.addEventListener("pointerdown", begin);
    win.addEventListener("resize", resize);
    return { apply, finish, destroy() {
      finish(false); win.removeEventListener("resize", resize);
      for (const handle of handles) handle.removeEventListener("pointerdown", begin);
    } };
  }
  return { create };
});
