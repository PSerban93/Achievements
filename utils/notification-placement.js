"use strict";

(function expose(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.AchievementsNotificationPlacement = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const profiles = Object.freeze([
    "main", "rare", "platinum", "xenia", "x360recomp", "ps3recomp", "ps4recomp",
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
  function apply({ x, y, position, ...offsets }) {
    const anchor = axes(position);
    const dx = normalizeOffset(offsets.notificationOffsetX);
    const dy = normalizeOffset(offsets.notificationOffsetY);
    // Zero must preserve authored margins and existing oversized-window behavior.
    if (!dx && !dy) return { x, y };
    // Positive edge offsets move inward; negative ones move outward. Centered
    // axes retain their screen directions. Deliberately allow off-screen content.
    x += anchor.horizontal === "right" ? -dx : dx;
    y += anchor.vertical === "bottom" ? -dy : dy;
    return { x: Math.round(x), y: Math.round(y) };
  }
  return { profiles, limit, normalizeOffset, preferenceKey, defaults, read, axes, apply };
});
