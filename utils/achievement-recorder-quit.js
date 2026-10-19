"use strict";

// Only the recording phase defers quit. Resume the normal application cleanup
// once terminal recorder messages have been consumed, or the deadline expires.
async function drainAchievementRecorderForQuit(controller, { reportError, timeoutMs = 75_000 } = {}) {
  if (!controller) return;
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("Recorder quit deadline expired")), timeoutMs);
  });
  try {
    await Promise.race([controller.stop("app-before-quit"), deadline]);
  } catch (error) {
    try { reportError?.(error); } catch {}
    try { controller.forceStop("app-before-quit-deadline"); } catch {}
  } finally {
    clearTimeout(timer);
  }
}

function createAchievementRecorderQuitGuard({ getController, resumeQuit, reportError, timeoutMs = 75_000 }) {
  let allowed = false;
  let draining = false;
  return function deferRecorderQuit(event) {
    if (allowed) return false;
    const controller = getController();
    const status = controller?.status;
    if (!draining && !status?.running && !status?.closing && !status?.pid) return false;
    event.preventDefault();
    if (draining) return true;
    draining = true;
    void drainAchievementRecorderForQuit(controller, { reportError, timeoutMs })
      .then(() => {
        allowed = true;
        resumeQuit();
      });
    return true;
  };
}

module.exports = { createAchievementRecorderQuitGuard, drainAchievementRecorderForQuit };
