(() => {
  if (window.__achievementsPreviewClock) return;
  // This runtime is installed only in the Settings preview, before its payload.
  // CSS timelines alone cannot hold presets that advance through JS timers/RAF.
  const native = {
    setTimeout: window.setTimeout.bind(window),
    clearTimeout: window.clearTimeout.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  };
  const tasks = new Map();
  let nextId = -1;
  let paused = false;
  let pauseStartedAt = 0;
  let pausedDuration = 0;
  let pauseStyle = null;
  const cancelNative = (task) => {
    if (task.nativeId == null) return;
    if (task.kind === "frame") native.cancelAnimationFrame(task.nativeId);
    else native.clearTimeout(task.nativeId);
    task.nativeId = null;
  };
  const schedule = (id, task) => {
    if (paused || !tasks.has(id)) return;
    const run = (timestamp) => {
      task.nativeId = null;
      if (paused || !tasks.has(id)) return;
      if (task.kind !== "interval") tasks.delete(id);
      try {
        if (typeof task.callback === "function") {
          if (task.kind === "frame") task.callback.call(window, timestamp);
          else task.callback.apply(window, task.args);
        } else window.eval(String(task.callback));
      } finally {
        if (task.kind === "interval" && tasks.has(id)) {
          task.remaining = task.delay;
          schedule(id, task);
        }
      }
    };
    task.dueAt = performance.now() + task.remaining;
    task.nativeId = task.kind === "frame"
      ? native.requestAnimationFrame(run)
      : native.setTimeout(run, task.remaining);
  };
  const add = (kind, callback, delay, args = []) => {
    const id = nextId--;
    const duration = Math.max(kind === "interval" ? 1 : 0, Number(delay) || 0);
    const task = { kind, callback, args, delay: duration, remaining: duration, nativeId: null };
    tasks.set(id, task);
    schedule(id, task);
    return id;
  };
  const remove = (id, fallback) => {
    const task = tasks.get(id);
    if (!task) {
      if (id >= 0) fallback(id);
      return;
    }
    cancelNative(task);
    tasks.delete(id);
  };
  window.setTimeout = (callback, delay, ...args) => add("timeout", callback, delay, args);
  window.setInterval = (callback, delay, ...args) => add("interval", callback, delay, args);
  window.clearTimeout = window.clearInterval = (id) => remove(id, native.clearTimeout);
  window.requestAnimationFrame = (callback) => add("frame", callback, 0);
  window.cancelAnimationFrame = (id) => remove(id, native.cancelAnimationFrame);
  window.__achievementsPreviewClock = {
    // Asset readiness deadlines must keep running while preset timers are held.
    setTimeout: native.setTimeout,
    now: () => (paused ? pauseStartedAt : performance.now()) - pausedDuration,
    pause() {
      if (paused) return;
      paused = true;
      pauseStartedAt = performance.now();
      window.api?.setPresetPreviewPaused?.(true);
      const now = performance.now();
      for (const task of tasks.values()) {
        if (task.kind !== "frame") task.remaining = Math.max(0, task.dueAt - now);
        cancelNative(task);
      }
      // Also hold CSS animations created by a changed background/effect option.
      pauseStyle = document.createElement("style");
      pauseStyle.textContent = "*,*::before,*::after{animation-play-state:paused!important}";
      document.head.appendChild(pauseStyle);
    },
    resume() {
      if (!paused) return;
      pauseStyle?.remove();
      pauseStyle = null;
      pausedDuration += performance.now() - pauseStartedAt;
      paused = false;
      window.api?.setPresetPreviewPaused?.(false);
      for (const [id, task] of tasks) schedule(id, task);
      for (const animation of document.getAnimations({ subtree: true })) {
        try {
          const end = Number(animation.effect?.getComputedTiming?.().endTime);
          if (!Number.isFinite(end) || Number(animation.currentTime) < end) animation.play();
        } catch {}
      }
    },
  };
})();
