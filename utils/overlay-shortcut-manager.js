"use strict";

const DEFAULT_KEY_ALIASES = new Map([
  ["\\", "Backslash"],
  ["|", "Backslash"],
  ["backslash", "Backslash"],
  ["oem5", "Backslash"],
  ["oem_5", "Backslash"],
  ["-", "Minus"],
  ["_", "Minus"],
  ["minus", "Minus"],
  ["=", "Equal"],
  ["+", "Equal"],
  ["equal", "Equal"],
  ["[", "BracketLeft"],
  ["{", "BracketLeft"],
  ["bracketleft", "BracketLeft"],
  ["]", "BracketRight"],
  ["}", "BracketRight"],
  ["bracketright", "BracketRight"],
  [";", "Semicolon"],
  [":", "Semicolon"],
  ["semicolon", "Semicolon"],
  ["'", "Quote"],
  ['"', "Quote"],
  ["quote", "Quote"],
  [",", "Comma"],
  ["<", "Comma"],
  ["comma", "Comma"],
  [".", "Period"],
  [">", "Period"],
  ["period", "Period"],
  ["/", "Slash"],
  ["?", "Slash"],
  ["slash", "Slash"],
  ["`", "Backquote"],
  ["~", "Backquote"],
  ["backquote", "Backquote"],
  ["grave", "Backquote"],
  ["graveaccent", "Backquote"],
  ["space", "Space"],
  ["spacebar", "Space"],
  ["esc", "Escape"],
  ["escape", "Escape"],
  ["enter", "Enter"],
  ["return", "Enter"],
  ["tab", "Tab"],
  ["backspace", "Backspace"],
  ["capslock", "CapsLock"],
  ["pageup", "PageUp"],
  ["pagedown", "PageDown"],
  ["home", "Home"],
  ["end", "End"],
  ["insert", "Insert"],
  ["ins", "Insert"],
  ["delete", "Delete"],
  ["del", "Delete"],
  ["left", "ArrowLeft"],
  ["arrowleft", "ArrowLeft"],
  ["up", "ArrowUp"],
  ["arrowup", "ArrowUp"],
  ["right", "ArrowRight"],
  ["arrowright", "ArrowRight"],
  ["down", "ArrowDown"],
  ["arrowdown", "ArrowDown"],
  ["printscreen", "PrintScreen"],
  ["printscr", "PrintScreen"],
  ["prtsc", "PrintScreen"],
  ["prtscr", "PrintScreen"],
  ["numlock", "NumLock"],
  ["scrolllock", "ScrollLock"],
  ["!", "1"],
  ["@", "2"],
  ["#", "3"],
  ["$", "4"],
  ["%", "5"],
  ["^", "6"],
  ["&", "7"],
  ["*", "8"],
  ["(", "9"],
  [")", "0"],
]);

function normalizeShortcutAccelerator(shortcut, { allowSingle = false } = {}) {
  if (!shortcut || typeof shortcut !== "string") return null;

  const parts = shortcut
    .trim()
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);
  if (!parts.length) return null;

  const modifiers = new Set();
  let mainToken = null;
  for (const part of parts) {
    const lower = part.toLowerCase();
    if (lower === "altgr" || lower === "altgraph") {
      modifiers.add("Control");
      modifiers.add("Alt");
      continue;
    }
    if (
      lower === "control" ||
      lower === "ctrl" ||
      lower === "cmdorctrl" ||
      lower === "commandorcontrol"
    ) {
      modifiers.add("Control");
      continue;
    }
    if (lower === "shift") {
      modifiers.add("Shift");
      continue;
    }
    if (lower === "alt" || lower === "option") {
      modifiers.add("Alt");
      continue;
    }
    if (
      lower === "meta" ||
      lower === "super" ||
      lower === "command" ||
      lower === "cmd"
    ) {
      modifiers.add("Meta");
      continue;
    }
    if (mainToken !== null) {
      return null;
    }
    mainToken = part;
  }

  if (!mainToken) return null;
  if (!allowSingle && !modifiers.size) return null;

  const normalized = [];
  if (modifiers.has("Control")) normalized.push("Control");
  if (modifiers.has("Shift")) normalized.push("Shift");
  if (modifiers.has("Alt")) normalized.push("Alt");
  if (modifiers.has("Meta")) normalized.push("Meta");
  normalized.push(mainToken);
  return normalized.join("+");
}

function resolveShortcutKeyToken(token, keyMap) {
  if (!keyMap) return null;

  const raw = String(token || "").trim();
  if (!raw) return null;

  const compact = raw.replace(/\s+/g, "");
  const lowerCompact = compact.toLowerCase();
  const candidates = [];
  const pushCandidate = (value) => {
    if (!value) return;
    if (!candidates.includes(value)) candidates.push(value);
  };

  const alias = DEFAULT_KEY_ALIASES.get(lowerCompact);
  if (alias) pushCandidate(alias);

  const numpadMatch = lowerCompact.match(/^num(?:pad)?([0-9])$/);
  if (numpadMatch) {
    pushCandidate(`Numpad${numpadMatch[1]}`);
  }

  if (/^[a-z]$/i.test(compact)) pushCandidate(compact.toUpperCase());
  if (/^\d$/.test(compact)) pushCandidate(compact);
  if (/^f\d{1,2}$/i.test(compact)) pushCandidate(compact.toUpperCase());

  pushCandidate(raw);
  pushCandidate(compact);
  pushCandidate(compact.toUpperCase());
  pushCandidate(compact.charAt(0).toUpperCase() + compact.slice(1));
  pushCandidate(
    compact.charAt(0).toUpperCase() + compact.slice(1).toLowerCase(),
  );

  for (const candidate of candidates) {
    if (Object.prototype.hasOwnProperty.call(keyMap, candidate)) {
      const alternateKeycodes = [];
      if (
        lowerCompact === "." &&
        candidate === "Period" &&
        Number.isFinite(Number(keyMap.NumpadDecimal))
      ) {
        alternateKeycodes.push(Number(keyMap.NumpadDecimal));
      }
      return {
        keyName: candidate,
        keycode: keyMap[candidate],
        alternateKeycodes,
      };
    }
  }

  return null;
}

function parseShortcutAccelerator(
  shortcut,
  { allowSingle = false, keyMap, matchMode = "exact" } = {},
) {
  const normalized = normalizeShortcutAccelerator(shortcut, { allowSingle });
  if (!normalized || !keyMap) return null;

  const parts = normalized
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);

  let mainToken = null;
  let requireCtrl = false;
  let requireShift = false;
  let requireAlt = false;
  let requireMeta = false;

  for (const part of parts) {
    switch (part.toLowerCase()) {
      case "control":
        requireCtrl = true;
        break;
      case "shift":
        requireShift = true;
        break;
      case "alt":
        requireAlt = true;
        break;
      case "meta":
        requireMeta = true;
        break;
      default:
        if (mainToken !== null) return null;
        mainToken = part;
        break;
    }
  }

  if (!mainToken) return null;
  if (matchMode !== "exact" && matchMode !== "required") return null;

  const resolvedKey = resolveShortcutKeyToken(mainToken, keyMap);
  if (!resolvedKey) return null;

  return {
    normalized,
    keyName: resolvedKey.keyName,
    triggerKey: resolvedKey.keycode,
    triggerKeys: [
      resolvedKey.keycode,
      ...((Array.isArray(resolvedKey.alternateKeycodes) &&
      resolvedKey.alternateKeycodes.length
        ? resolvedKey.alternateKeycodes
        : []
      ).filter((keycode) => Number.isFinite(Number(keycode)))),
    ].filter((keycode, index, array) => array.indexOf(keycode) === index),
    requireCtrl,
    requireShift,
    requireAlt,
    requireMeta,
    matchMode,
  };
}

function getBindingTriggerKeys(binding) {
  if (!binding) return [];
  if (Array.isArray(binding.triggerKeys) && binding.triggerKeys.length) {
    return binding.triggerKeys
      .map((keycode) => Number(keycode))
      .filter((keycode) => Number.isFinite(keycode));
  }
  const triggerKey = Number(binding.triggerKey);
  return Number.isFinite(triggerKey) ? [triggerKey] : [];
}

function matchesShortcutBinding(binding, event) {
  if (!binding || !event) return false;
  if (!getBindingTriggerKeys(binding).includes(Number(event.keycode))) {
    return false;
  }

  const actualCtrl = !!event.ctrlKey;
  const actualShift = !!event.shiftKey;
  const actualAlt = !!event.altKey;
  const actualMeta = !!event.metaKey;

  if (binding.matchMode === "required") {
    if (binding.requireCtrl && !actualCtrl) return false;
    if (binding.requireShift && !actualShift) return false;
    if (binding.requireAlt && !actualAlt) return false;
    if (binding.requireMeta && !actualMeta) return false;
    return true;
  }

  if (!!binding.requireCtrl !== actualCtrl) return false;
  if (!!binding.requireShift !== actualShift) return false;
  if (!!binding.requireAlt !== actualAlt) return false;
  if (!!binding.requireMeta !== actualMeta) return false;
  return true;
}

function bindingsCanConflict(first, second) {
  if (!first || !second) return false;
  const overlappingKeycodes = getBindingTriggerKeys(first).filter((keycode) =>
    getBindingTriggerKeys(second).includes(keycode),
  );
  if (!overlappingKeycodes.length) return false;

  const bools = [false, true];
  for (const keycode of overlappingKeycodes) {
    for (const ctrlKey of bools) {
      for (const shiftKey of bools) {
        for (const altKey of bools) {
          for (const metaKey of bools) {
            const event = {
              keycode,
              ctrlKey,
              shiftKey,
              altKey,
              metaKey,
            };
            if (
              matchesShortcutBinding(first, event) &&
              matchesShortcutBinding(second, event)
            ) {
              return true;
            }
          }
        }
      }
    }
  }

  return false;
}

function getShortcutBindingSignature(binding) {
  if (!binding) return null;
  const triggerKeys = getBindingTriggerKeys(binding).sort((left, right) => left - right);
  if (!triggerKeys.length) return null;
  return [
    triggerKeys.join(","),
    binding.requireCtrl ? 1 : 0,
    binding.requireShift ? 1 : 0,
    binding.requireAlt ? 1 : 0,
    binding.requireMeta ? 1 : 0,
    binding.matchMode === "required" ? "required" : "exact",
  ].join(":");
}

function summarizeBinding(binding) {
  if (!binding) return null;
  return {
    id: binding.id,
    source: binding.source || binding.id,
    scope: binding.scope || "builtin",
    normalized: binding.normalized,
    keyName: binding.keyName,
    keycode: binding.triggerKey,
    keycodes: getBindingTriggerKeys(binding),
    priority: Number(binding.priority) || 0,
    matchMode: binding.matchMode || "exact",
  };
}

function createOverlayShortcutManager({ loadHook, logger } = {}) {
  let hook = null;
  let keyMap = null;
  let hookLoadAttempted = false;
  let hookStarted = false;
  let keyboardHandlersAttached = false;
  let keydownListener = null;
  let keyupListener = null;
  let bindingOrder = 0;
  const bindings = new Map();

  const logWithLevel = (level, event, meta) => {
    const fn = logger && typeof logger[level] === "function" ? logger[level] : null;
    if (fn) {
      fn.call(logger, event, meta);
      return;
    }
    const fallback = level === "warn" ? console.warn : console.log;
    fallback(`[${event}]`, meta || {});
  };

  const summarizeKeyboardEvent = (event) => ({
    keycode: Number(event?.keycode),
    ctrlKey: !!event?.ctrlKey,
    shiftKey: !!event?.shiftKey,
    altKey: !!event?.altKey,
    metaKey: !!event?.metaKey,
  });

  const getHookDeps = () => {
    if (hook && keyMap) return { hook, keyMap };
    if (hookLoadAttempted && (!hook || !keyMap)) return null;

    try {
      const loaded =
        typeof loadHook === "function" ? loadHook() : require("uiohook-napi");
      hook = loaded?.hook || loaded?.uIOhook || null;
      keyMap = loaded?.keyMap || loaded?.UiohookKey || null;
      hookLoadAttempted = true;
      if (!hook || !keyMap) {
        logWithLevel("warn", "overlay:input-hook:invalid-load", {
          hasHook: !!hook,
          hasKeyMap: !!keyMap,
        });
        return null;
      }
      return { hook, keyMap };
    } catch (err) {
      hookLoadAttempted = true;
      logWithLevel("warn", "overlay:input-hook:load-failed", {
        error: err?.message || String(err),
      });
      return null;
    }
  };

  const ensureStarted = (reason = "overlay") => {
    const deps = getHookDeps();
    if (!deps) return false;
    if (hookStarted) return true;

    try {
      deps.hook.start();
      hookStarted = true;
      logWithLevel("info", "overlay:input-hook:started", { reason });
      return true;
    } catch (err) {
      logWithLevel("warn", "overlay:input-hook:start-failed", {
        reason,
        error: err?.message || String(err),
      });
      return false;
    }
  };

  const handleKeydown = (event) => {
    const orderedBindings = Array.from(bindings.values()).sort((left, right) => {
      const priorityDelta =
        (Number(right.priority) || 0) - (Number(left.priority) || 0);
      if (priorityDelta !== 0) return priorityDelta;
      return (Number(left.order) || 0) - (Number(right.order) || 0);
    });
    const eventKeycode = Number(event?.keycode);
    const sameKeyBindings = Number.isFinite(eventKeycode)
      ? orderedBindings.filter((binding) =>
          getBindingTriggerKeys(binding).includes(eventKeycode),
        )
      : [];
    if (sameKeyBindings.length) {
      logWithLevel("debug", "overlay:input-hook:keydown", {
        event: summarizeKeyboardEvent(event),
        candidates: sameKeyBindings.map((binding) => summarizeBinding(binding)),
      });
    }

    const matchedIds = [];
    const skippedActiveIds = [];
    const skippedCooldownIds = [];
    const whenRejectedIds = [];
    const firedIds = [];
    const now = Date.now();

    for (const binding of orderedBindings) {
      if (!matchesShortcutBinding(binding, event)) continue;
      matchedIds.push(binding.id);
      if (binding.cooldownMs > 0) {
        if (now - binding.lastTriggeredAt < binding.cooldownMs) {
          skippedCooldownIds.push(binding.id);
          continue;
        }
      } else if (binding.active) {
        skippedActiveIds.push(binding.id);
        continue;
      }

      if (typeof binding.when === "function") {
        let shouldFire = false;
        try {
          shouldFire = binding.when(event, binding) !== false;
        } catch (err) {
          logWithLevel("warn", "overlay:shortcut:when-failed", {
            id: binding.id,
            error: err?.message || String(err),
          });
        }
        if (!shouldFire) {
          whenRejectedIds.push(binding.id);
          continue;
        }
      }

      if (binding.cooldownMs > 0) {
        binding.lastTriggeredAt = now;
      } else {
        binding.active = true;
      }
      try {
        binding.onFire?.(event, binding);
        firedIds.push(binding.id);
      } catch (err) {
        logWithLevel("warn", "overlay:shortcut:fire-failed", {
          id: binding.id,
          error: err?.message || String(err),
        });
      }

      if (binding.continueOnMatch === true) continue;
      break;
    }

    if (sameKeyBindings.length) {
      logWithLevel("debug", "overlay:input-hook:keydown-result", {
        event: summarizeKeyboardEvent(event),
        matchedIds,
        skippedActiveIds,
        skippedCooldownIds,
        whenRejectedIds,
        firedIds,
      });
    }
  };

  const handleKeyup = (event) => {
    const keycode = Number(event?.keycode);
    if (!Number.isFinite(keycode)) return;
    const resetIds = [];

    for (const binding of bindings.values()) {
      if (!getBindingTriggerKeys(binding).includes(keycode)) continue;
      if (binding.cooldownMs > 0) continue;
      binding.active = false;
      resetIds.push(binding.id);
    }

    if (resetIds.length) {
      logWithLevel("debug", "overlay:input-hook:keyup", {
        event: summarizeKeyboardEvent(event),
        resetIds,
      });
    }
  };

  const ensureKeyboardHandlers = () => {
    const deps = getHookDeps();
    if (!deps) return false;
    if (keyboardHandlersAttached) {
      return ensureStarted("keyboard");
    }

    keydownListener = handleKeydown;
    keyupListener = handleKeyup;
    deps.hook.on("keydown", keydownListener);
    deps.hook.on("keyup", keyupListener);
    keyboardHandlersAttached = true;
    return ensureStarted("keyboard");
  };

  const buildConflictList = (candidate, id) => {
    const conflicts = [];
    for (const existing of bindings.values()) {
      if (!existing || existing.id === id) continue;
      if (!bindingsCanConflict(candidate, existing)) continue;
      conflicts.push(summarizeBinding(existing));
    }
    return conflicts;
  };

  const registerBinding = (id, shortcut, options = {}) => {
    unregisterBinding(id);

    const deps = getHookDeps();
    if (!deps) {
      return { ok: false, reason: "hook-unavailable" };
    }

    const parsed = parseShortcutAccelerator(shortcut, {
      allowSingle: options.allowSingle === true,
      keyMap: deps.keyMap,
      matchMode: options.matchMode || "exact",
    });
    if (!parsed) {
      logWithLevel("warn", "overlay:shortcut:parse-failed", {
        id,
        shortcut,
        allowSingle: options.allowSingle === true,
        matchMode: options.matchMode || "exact",
      });
      return { ok: false, reason: "invalid-shortcut" };
    }

    const binding = {
      id,
      source: options.source || id,
      scope: options.scope || "builtin",
      priority: Number(options.priority) || 0,
      continueOnMatch: options.continueOnMatch === true,
      cooldownMs: Math.max(0, Number(options.cooldownMs) || 0),
      lastTriggeredAt: 0,
      when: typeof options.when === "function" ? options.when : null,
      onFire:
        typeof options.onFire === "function" ? options.onFire : () => undefined,
      active: false,
      order: bindingOrder++,
      ...parsed,
    };
    const conflicts = buildConflictList(binding, id);
    if (conflicts.length) {
      logWithLevel("warn", "overlay:shortcut:conflict", {
        id,
        shortcut,
        normalized: binding.normalized,
        priority: binding.priority,
        conflicts,
      });
    }

    let shouldReject = false;
    if (typeof options.rejectOnConflict === "function") {
      shouldReject = conflicts.some((conflict) =>
        options.rejectOnConflict(conflict, summarizeBinding(binding)),
      );
    } else if (options.rejectOnConflict === true) {
      shouldReject = conflicts.length > 0;
    }
    if (shouldReject) {
      logWithLevel("warn", "overlay:shortcut:register-rejected", {
        id,
        shortcut,
        normalized: binding.normalized,
        reason: "conflict",
        conflicts,
      });
      return { ok: false, reason: "conflict", conflicts, parsed: binding };
    }

    if (!ensureKeyboardHandlers()) {
      return { ok: false, reason: "hook-unavailable" };
    }

    bindings.set(id, binding);
    logWithLevel("debug", "overlay:shortcut:registered", {
      id,
      shortcut,
      normalized: binding.normalized,
      keyName: binding.keyName,
      keycode: binding.triggerKey,
      priority: binding.priority,
      matchMode: binding.matchMode,
      conflicts,
    });
    return { ok: true, parsed: binding, conflicts };
  };

  const unregisterBinding = (id) => {
    const existing = bindings.get(id);
    if (!existing) return false;
    existing.active = false;
    bindings.delete(id);
    logWithLevel("debug", "overlay:shortcut:unregistered", {
      id,
      normalized: existing.normalized,
    });
    return true;
  };

  const on = (event, listener) => {
    const deps = getHookDeps();
    if (!deps || typeof listener !== "function") return false;
    deps.hook.on(event, listener);
    return true;
  };

  const off = (event, listener) => {
    if (!hook || typeof listener !== "function") return false;
    try {
      hook.off(event, listener);
      return true;
    } catch {
      return false;
    }
  };

  const shutdown = () => {
    if (hook && keydownListener) {
      try {
        hook.off("keydown", keydownListener);
      } catch {}
    }
    if (hook && keyupListener) {
      try {
        hook.off("keyup", keyupListener);
      } catch {}
    }

    bindings.clear();
    keydownListener = null;
    keyupListener = null;
    keyboardHandlersAttached = false;

    if (hook && hookStarted) {
      try {
        hook.stop();
      } catch {}
    }
    hookStarted = false;
  };

  return {
    ensureStarted,
    getHookDeps,
    on,
    off,
    registerBinding,
    unregisterBinding,
    shutdown,
  };
}

module.exports = {
  DEFAULT_KEY_ALIASES,
  bindingsCanConflict,
  createOverlayShortcutManager,
  getShortcutBindingSignature,
  matchesShortcutBinding,
  normalizeShortcutAccelerator,
  parseShortcutAccelerator,
  resolveShortcutKeyToken,
};
