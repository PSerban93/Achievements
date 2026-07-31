function normalizeAppId(value) {
  return String(value || "").trim().toLowerCase();
}

function createTimeoutError(appid, timeoutMs) {
  const error = new Error(
    `Timed out waiting for config generation to finish for AppID ${appid}.`,
  );
  error.code = "CONFIG_GENERATION_DRAIN_TIMEOUT";
  error.appid = appid;
  error.timeoutMs = timeoutMs;
  return error;
}

function createConfigDeletionGuard() {
  const suppressionTokens = new Map();
  const activeGenerationCounts = new Map();
  const idleWaiters = new Map();
  let nextTokenId = 1;

  const isSuppressed = (appid) => {
    const key = normalizeAppId(appid);
    return !!key && (suppressionTokens.get(key)?.size || 0) > 0;
  };

  const notifyIdle = (appid) => {
    if ((activeGenerationCounts.get(appid) || 0) > 0) return;
    const waiters = idleWaiters.get(appid);
    if (!waiters?.size) return;
    idleWaiters.delete(appid);
    for (const resolve of waiters) {
      try {
        resolve();
      } catch {}
    }
  };

  const waitForIdle = async (appid, timeoutMs = 60000) => {
    const key = normalizeAppId(appid);
    if (!key || (activeGenerationCounts.get(key) || 0) === 0) return;

    let resolveWait;
    const idlePromise = new Promise((resolve) => {
      resolveWait = resolve;
      if (!idleWaiters.has(key)) idleWaiters.set(key, new Set());
      idleWaiters.get(key).add(resolve);
    });

    const safeTimeoutMs = Math.max(1, Number(timeoutMs) || 60000);
    let timeout = null;
    try {
      await Promise.race([
        idlePromise,
        new Promise((_, reject) => {
          timeout = setTimeout(
            () => reject(createTimeoutError(key, safeTimeoutMs)),
            safeTimeoutMs,
          );
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
      const waiters = idleWaiters.get(key);
      if (waiters) {
        waiters.delete(resolveWait);
        if (waiters.size === 0) idleWaiters.delete(key);
      }
    }
  };

  const releaseToken = (token) => {
    const key = normalizeAppId(token?.appid);
    if (!key || !token?.id) return false;
    const tokens = suppressionTokens.get(key);
    if (!tokens || !tokens.delete(token.id)) return false;
    if (tokens.size === 0) suppressionTokens.delete(key);
    return true;
  };

  const begin = async (appid, options = {}) => {
    const key = normalizeAppId(appid);
    if (!key) {
      const error = new Error("AppID is required for config deletion guard.");
      error.code = "CONFIG_DELETION_APPID_MISSING";
      throw error;
    }

    const token = Object.freeze({
      appid: key,
      id: nextTokenId++,
    });
    if (!suppressionTokens.has(key)) suppressionTokens.set(key, new Set());
    suppressionTokens.get(key).add(token.id);

    try {
      if (typeof options.onSuppressed === "function") {
        await options.onSuppressed(token);
      }
      await waitForIdle(key, options.timeoutMs);
      return token;
    } catch (error) {
      releaseToken(token);
      throw error;
    }
  };

  const end = async (token, options = {}) => {
    const key = normalizeAppId(token?.appid);
    if (!key || !token?.id) return false;
    await waitForIdle(key, options.timeoutMs);
    const settleMs = Math.max(0, Number(options.settleMs) || 0);
    if (settleMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, settleMs));
    }
    return releaseToken(token);
  };

  const tryStartGeneration = (appid) => {
    const key = normalizeAppId(appid);
    if (!key || isSuppressed(key)) return null;
    activeGenerationCounts.set(
      key,
      (activeGenerationCounts.get(key) || 0) + 1,
    );
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      const nextCount = Math.max(
        0,
        (activeGenerationCounts.get(key) || 0) - 1,
      );
      if (nextCount === 0) {
        activeGenerationCounts.delete(key);
        notifyIdle(key);
      } else {
        activeGenerationCounts.set(key, nextCount);
      }
    };
  };

  const getState = (appid) => {
    const key = normalizeAppId(appid);
    return {
      appid: key,
      suppressed: isSuppressed(key),
      suppressionCount: suppressionTokens.get(key)?.size || 0,
      activeGenerationCount: activeGenerationCounts.get(key) || 0,
    };
  };

  return {
    begin,
    end,
    getState,
    isSuppressed,
    tryStartGeneration,
    waitForIdle,
  };
}

module.exports = {
  createConfigDeletionGuard,
};
