"use strict";

(function expose(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.AchievementsNotificationPlacement = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const profiles = Object.freeze([
    "main", "rare", "platinum", "xenia", "x360recomp", "ps4recomp",
    "rpcs3", "shadps4", "kytyps5", "progress", "playtime",
  ]);
  const limit = 4096;
  function normalizeOffset(value) {
    if (value == null || value === "" || typeof value === "boolean") return 0;
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(-limit, Math.min(limit, Math.round(number))) : 0;
  }
  function preferenceKey(profile, axis) {
    return `${profiles.includes(profile) ? profile : "main"}NotificationOffset${axis}`;
  }
  function defaults() {
    return Object.fromEntries(profiles.flatMap((profile) =>
      ["X", "Y"].map((axis) => [preferenceKey(profile, axis), 0])));
  }
  function read(profile, prefs = {}, overrides = null) {
    const value = (axis) => normalizeOffset(overrides?.[`notificationOffset${axis}`] ?? prefs[preferenceKey(profile, axis)]);
    return { notificationOffsetX: value("X"), notificationOffsetY: value("Y") };
  }
  function axes(position = "center-bottom") {
    return {
      horizontal: position.endsWith("left") ? "left" : position.endsWith("right") ? "right" : "center",
      vertical: position.startsWith("middle") ? "center" : position.includes("top") ? "top" : "bottom",
    };
  }
  function apply({ x, y, width, height, position, workArea, insets = {}, ...offsets }) {
    const anchor = axes(position);
    const dx = normalizeOffset(offsets.notificationOffsetX);
    const dy = normalizeOffset(offsets.notificationOffsetY);
    // Zero must preserve authored margins and existing oversized-window behavior.
    if (!dx && !dy) return { x, y };
    x += anchor.horizontal === "right" ? -Math.max(0, dx) : anchor.horizontal === "left" ? Math.max(0, dx) : dx;
    y += anchor.vertical === "bottom" ? -Math.max(0, dy) : anchor.vertical === "top" ? Math.max(0, dy) : dy;
    // Keep the layout visible, allowing transparent paint gutters off-screen.
    const minX = workArea.x - (insets.left || 0);
    const minY = workArea.y - (insets.top || 0);
    const maxX = Math.max(minX, workArea.x + workArea.width - width + (insets.right || 0));
    const maxY = Math.max(minY, workArea.y + workArea.height - height + (insets.bottom || 0));
    return { x: Math.round(Math.max(minX, Math.min(maxX, x))), y: Math.round(Math.max(minY, Math.min(maxY, y))) };
  }
  return { profiles, limit, normalizeOffset, preferenceKey, defaults, read, axes, apply };
});
