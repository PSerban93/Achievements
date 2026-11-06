"use strict";

(function expose(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.Dashboard3DSettings = api;
})(typeof globalThis !== "undefined" ? globalThis : this, () => {
  const fields = Object.freeze([
    { key: "dashboard3dTiltX", label: "verticalTilt", text: "Vertical tilt", unit: "°", value: 5, min: 0, max: 20, step: 1 },
    { key: "dashboard3dTiltY", label: "horizontalTilt", text: "Horizontal tilt", unit: "°", value: 5, min: 0, max: 20, step: 1 },
    { key: "dashboard3dZoom", label: "zoom", text: "Zoom", unit: "%", value: 102, min: 100, max: 120, step: 1 },
    { key: "dashboard3dLift", label: "lift", text: "Lift", unit: "px", value: 2, min: 0, max: 20, step: 1 },
    { key: "dashboard3dPerspective", label: "perspective", text: "Perspective", unit: "px", value: 900, min: 300, max: 2000, step: 50 },
    { key: "dashboard3dFollowMs", label: "followDuration", text: "Follow duration", unit: "ms", value: 100, min: 0, max: 500, step: 10 },
    { key: "dashboard3dReturnMs", label: "returnDuration", text: "Return duration", unit: "ms", value: 200, min: 0, max: 1000, step: 10 },
  ].map(Object.freeze));
  const defaults = Object.freeze(Object.fromEntries(fields.map(field => [field.key, field.value])));
  function normalize(preferences = {}) {
    return Object.fromEntries(fields.map(field => {
      const raw = preferences[field.key];
      const number = typeof raw === "number" || typeof raw === "string" && raw.trim() ? Number(raw) : NaN;
      const value = Number.isFinite(number) ? Math.min(field.max, Math.max(field.min, number)) : field.value;
      return [field.key, field.min + Math.round((value - field.min) / field.step) * field.step];
    }));
  }
  return { fields, defaults, normalize };
});
