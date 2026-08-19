"use strict";

const { sanitizeConfigName } = require("./config-name");

function normalizePlatform(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function getNotificationConfigName(notificationData = {}) {
  const raw = String(
    notificationData.configName || notificationData.config_name || "",
  ).trim();
  return raw ? sanitizeConfigName(raw) : "";
}

function buildPendingRecordKey(notificationData = {}) {
  const configName = getNotificationConfigName(notificationData);
  if (!configName) return "";
  const platform = normalizePlatform(notificationData.platform);
  const achievement = String(
    notificationData.name || notificationData.displayName || "achievement",
  )
    .trim()
    .toLowerCase();
  return `${configName.toLowerCase()}\u0000${platform}\u0000${achievement}`;
}

class PendingAchievementRecordQueue {
  constructor(options = {}) {
    this.ttlMs = Math.max(1_000, Number(options.ttlMs) || 20_000);
    this.maxSize = Math.max(1, Number(options.maxSize) || 32);
    this.onDiscard =
      typeof options.onDiscard === "function" ? options.onDiscard : null;
    this.entries = new Map();
  }

  get size() {
    return this.entries.size;
  }

  discard(key, reason = "discarded") {
    const entry = this.entries.get(key);
    if (!entry) return false;
    this.entries.delete(key);
    if (entry.timer) clearTimeout(entry.timer);
    this.onDiscard?.({
      reason,
      configName: entry.configName,
      platform: entry.platform || null,
      achievement: entry.notificationData.name || null,
      displayName: entry.notificationData.displayName || null,
    });
    return true;
  }

  enqueue(notificationData = {}) {
    const key = buildPendingRecordKey(notificationData);
    const configName = getNotificationConfigName(notificationData);
    if (!key || !configName) {
      return { queued: false, reason: "config-missing" };
    }
    if (this.entries.has(key)) {
      return { queued: false, reason: "duplicate", key };
    }
    while (this.entries.size >= this.maxSize) {
      const oldestKey = this.entries.keys().next().value;
      if (!oldestKey) break;
      this.discard(oldestKey, "capacity");
    }

    const entry = {
      key,
      configName,
      platform: normalizePlatform(notificationData.platform),
      notificationData: { ...notificationData },
      timer: null,
    };
    entry.timer = setTimeout(() => this.discard(key, "expired"), this.ttlMs);
    entry.timer.unref?.();
    this.entries.set(key, entry);
    return { queued: true, key, configName, platform: entry.platform || null };
  }

  takeMatching(selection = {}) {
    const rawConfigName = String(selection.configName || "").trim();
    const configName = rawConfigName ? sanitizeConfigName(rawConfigName) : "";
    const configKey = configName.toLowerCase();
    const platform = normalizePlatform(selection.platform);
    if (!configName) return [];

    const matches = [];
    for (const [key, entry] of this.entries) {
      if (entry.configName.toLowerCase() !== configKey) continue;
      if (entry.platform && platform && entry.platform !== platform) continue;
      this.entries.delete(key);
      if (entry.timer) clearTimeout(entry.timer);
      matches.push(entry.notificationData);
    }
    return matches;
  }

  clear(reason = "cleared") {
    for (const key of Array.from(this.entries.keys())) {
      this.discard(key, reason);
    }
  }
}

module.exports = {
  PendingAchievementRecordQueue,
  buildPendingRecordKey,
  getNotificationConfigName,
};
