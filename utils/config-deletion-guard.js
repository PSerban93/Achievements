function normalizeAppId(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizePlatform(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeConfigName(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeIdentity(appid, options = {}) {
  if (appid && typeof appid === "object" && !Array.isArray(appid)) {
    options = appid;
    appid = options.appid;
  }
  const normalizedAppId = normalizeAppId(appid);
  const platform = normalizePlatform(options?.platform);
  const configName = normalizeConfigName(
    options?.configName || options?.config_name,
  );
  return {
    appid: normalizedAppId,
    platform,
    configName,
    key: `${normalizedAppId}::${platform || "*"}::${configName || "*"}`,
  };
}

function identitiesOverlap(left, right) {
  if (!left?.appid || !right?.appid || left.appid !== right.appid) return false;
  if (left.platform && right.platform && left.platform !== right.platform) {
    return false;
  }
  if (
    left.configName &&
    right.configName &&
    left.configName !== right.configName
  ) {
    return false;
  }
  return true;
}

function createTimeoutError(identity, timeoutMs) {
  const error = new Error(
    `Timed out waiting for config generation to finish for AppID ${identity.appid}.`,
  );
  error.code = "CONFIG_GENERATION_DRAIN_TIMEOUT";
  error.appid = identity.appid;
  error.platform = identity.platform || null;
  error.configName = identity.configName || null;
  error.timeoutMs = timeoutMs;
  return error;
}

function createConfigDeletionGuard() {
  const suppressionTokens = new Map();
  const activeGenerations = new Map();
  const idleWaiters = new Set();
  let nextTokenId = 1;

  const matchingSuppressionCount = (identity) => {
    let count = 0;
    for (const token of suppressionTokens.values()) {
      if (identitiesOverlap(identity, token)) count += 1;
    }
    return count;
  };

  const matchingGenerationCount = (identity) => {
    let count = 0;
    for (const entry of activeGenerations.values()) {
      if (identitiesOverlap(identity, entry.identity)) count += entry.count;
    }
    return count;
  };

  const isSuppressed = (appid, options = {}) => {
    const identity = normalizeIdentity(appid, options);
    return !!identity.appid && matchingSuppressionCount(identity) > 0;
  };

  const notifyIdle = () => {
    for (const waiter of Array.from(idleWaiters)) {
      if (matchingGenerationCount(waiter.identity) > 0) continue;
      idleWaiters.delete(waiter);
      try {
        waiter.resolve();
      } catch {}
    }
  };

  const waitForIdle = async (appid, options = {}, timeoutMs = 60000) => {
    if (typeof options === "number") {
      timeoutMs = options;
      options = {};
    }
    const identity = normalizeIdentity(appid, options);
    if (!identity.appid || matchingGenerationCount(identity) === 0) return;

    let waiter = null;
    const idlePromise = new Promise((resolve) => {
      waiter = { identity, resolve };
      idleWaiters.add(waiter);
    });
    const safeTimeoutMs = Math.max(1, Number(timeoutMs) || 60000);
    let timeout = null;
    try {
      await Promise.race([
        idlePromise,
        new Promise((_, reject) => {
          timeout = setTimeout(
            () => reject(createTimeoutError(identity, safeTimeoutMs)),
            safeTimeoutMs,
          );
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
      if (waiter) idleWaiters.delete(waiter);
    }
  };

  const releaseToken = (token) => {
    if (!token?.id || !suppressionTokens.has(token.id)) return false;
    suppressionTokens.delete(token.id);
    return true;
  };

  const begin = async (appid, options = {}) => {
    const identity = normalizeIdentity(appid, options);
    if (!identity.appid) {
      const error = new Error("AppID is required for config deletion guard.");
      error.code = "CONFIG_DELETION_APPID_MISSING";
      throw error;
    }
    const token = Object.freeze({ ...identity, id: nextTokenId++ });
    suppressionTokens.set(token.id, token);
    try {
      if (typeof options.onSuppressed === "function") {
        await options.onSuppressed(token);
      }
      await waitForIdle(identity, {}, options.timeoutMs);
      return token;
    } catch (error) {
      releaseToken(token);
      throw error;
    }
  };

  const end = async (token, options = {}) => {
    if (!token?.id || !token?.appid) return false;
    await waitForIdle(token, {}, options.timeoutMs);
    const settleMs = Math.max(0, Number(options.settleMs) || 0);
    if (settleMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, settleMs));
    }
    return releaseToken(token);
  };

  const tryStartGeneration = (appid, options = {}) => {
    const identity = normalizeIdentity(appid, options);
    if (!identity.appid || isSuppressed(identity)) return null;
    const existing = activeGenerations.get(identity.key);
    activeGenerations.set(identity.key, {
      identity,
      count: (existing?.count || 0) + 1,
    });
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      const entry = activeGenerations.get(identity.key);
      const nextCount = Math.max(0, (entry?.count || 0) - 1);
      if (nextCount === 0) activeGenerations.delete(identity.key);
      else activeGenerations.set(identity.key, { identity, count: nextCount });
      notifyIdle();
    };
  };

  const getState = (appid, options = {}) => {
    const identity = normalizeIdentity(appid, options);
    return {
      appid: identity.appid,
      suppressed: isSuppressed(identity),
      suppressionCount: matchingSuppressionCount(identity),
      activeGenerationCount: matchingGenerationCount(identity),
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
