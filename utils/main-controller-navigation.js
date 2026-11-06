"use strict";

(function expose(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.AchievementsMainControllerNavigation = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const LEFT_DEADZONE = 0.4;
  const RIGHT_DEADZONE = 0.5;
  const axis = (value) => Number.isFinite(Number(value)) ? Math.max(-1, Math.min(1, Number(value))) : 0;
  const identity = (pad, slot) => `${Number.isInteger(pad.index) ? pad.index : slot}:${String(pad.id || "")}`;

  function normalizeStandardGamepad(pad, slot = 0) {
    if (!pad || pad.connected === false || pad.mapping !== "standard" || !(pad.buttons?.length >= 4) || !(pad.axes?.length >= 2)) return null;
    return { key: identity(pad, slot), id: String(pad.id || "").slice(0, 200), index: Number.isInteger(pad.index) ? pad.index : slot,
      mapping: "standard", buttons: pad.buttons, axes: [0, 1, 2, 3].map((i) => axis(pad.axes[i])) };
  }

  function isNeutral(pad) {
    return !Array.from(pad.buttons).some((button) => button?.pressed === true) &&
      Math.abs(pad.axes[0]) <= LEFT_DEADZONE && Math.abs(pad.axes[1]) <= LEFT_DEADZONE &&
      Math.abs(pad.axes[2]) <= RIGHT_DEADZONE && Math.abs(pad.axes[3]) <= RIGHT_DEADZONE;
  }

  function scrollDelta(value, elapsedSeconds, maxSpeed = 1500) {
    const v = axis(value), magnitude = Math.abs(v);
    if (magnitude <= RIGHT_DEADZONE || !Number.isFinite(elapsedSeconds) || elapsedSeconds <= 0) return 0;
    const t = (magnitude - RIGHT_DEADZONE) / (1 - RIGHT_DEADZONE);
    return Math.sign(v) * maxSpeed * (0.25 * t + 0.75 * t * t) * Math.min(0.05, elapsedSeconds);
  }

  function createInputSession({ onDiagnostic } = {}) {
    let selectedKey = null, armed = false, previousTime = null, inventory = "";
    let lastDiagnosticAt = -Infinity, samplesLeft = 12;
    const previousPressed = new Map();
    const emit = (name, data) => { try { onDiagnostic?.(name, data); } catch {} };
    function suspend() { armed = false; previousTime = null; }
    function getGamepad(rawPads) {
      const candidates = Array.from(rawPads || []).map((pad, slot) => normalizeStandardGamepad(pad, slot)).filter(Boolean);
      return candidates.find((pad) => pad.key === selectedKey) || candidates[0] || null;
    }
    function sample(rawPads, now) {
      const present = Array.from(rawPads || []).map((pad, slot) => ({ pad, slot })).filter(({ pad }) => pad && pad.connected !== false);
      const summary = present.map(({ pad, slot }) => ({ id: String(pad.id || "").slice(0, 200),
        index: Number.isInteger(pad.index) ? pad.index : slot, mapping: String(pad.mapping || ""),
        buttons: pad.buttons?.length || 0, axes: pad.axes?.length || 0 }));
      const signature = JSON.stringify(summary);
      const next = getGamepad(rawPads);
      const changed = (next?.key || null) !== selectedKey;
      if (changed) { selectedKey = next?.key || null; suspend(); }
      if (signature !== inventory) {
        inventory = signature;
        const keys = new Set(present.map(({ pad, slot }) => identity(pad, slot)));
        for (const key of previousPressed.keys()) if (!keys.has(key)) previousPressed.delete(key);
        emit("controller:main:devices", { devices: summary, selected: next ? { id: next.id, index: next.index, mapping: next.mapping } : null,
          states: present.map(({ pad, slot }) => ({ index: Number.isInteger(pad.index) ? pad.index : slot,
            axes: Array.from(pad.axes || []).slice(0, 8).map((v) => Math.round(axis(v) * 1000) / 1000) })) });
      }
      // Capture only a bounded number of button transitions, including unknown
      // layouts, so a remote report can identify its actual physical button index.
      for (const { pad, slot } of present) {
        const key = identity(pad, slot);
        const pressed = Array.from(pad.buttons || []).map((b) => b?.pressed === true);
        const before = previousPressed.get(key) || [];
        if (samplesLeft > 0 && now - lastDiagnosticAt >= 300 && pressed.some((v, i) => v && !before[i])) {
          samplesLeft--; lastDiagnosticAt = now;
          emit("controller:main:input-sample", { id: String(pad.id || "").slice(0, 200), index: Number.isInteger(pad.index) ? pad.index : slot,
            mapping: String(pad.mapping || ""), selected: key === selectedKey,
            pressed: pressed.flatMap((v, i) => v ? [i] : []), axes: Array.from(pad.axes || []).slice(0, 8).map((v) => Math.round(axis(v) * 1000) / 1000) });
        }
        previousPressed.set(key, pressed);
      }
      if (!next) { suspend(); return { pad: null, ready: false, changed, elapsedSeconds: 0 }; }
      if (!armed) {
        if (isNeutral(next)) armed = true;
        previousTime = now;
        return { pad: next, ready: false, changed, elapsedSeconds: 0 };
      }
      const elapsedSeconds = previousTime === null ? 0 : Math.max(0, Math.min(0.05, (now - previousTime) / 1000));
      previousTime = now;
      return { pad: next, ready: true, changed, elapsedSeconds };
    }
    return { sample, getGamepad, suspend, noteManualInput: suspend };
  }

  return { LEFT_DEADZONE, RIGHT_DEADZONE, normalizeStandardGamepad, scrollDelta, createInputSession };
});
