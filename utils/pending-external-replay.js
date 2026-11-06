"use strict";

const { performance } = require("perf_hooks");
const { PendingAchievementRecordQueue, getNotificationConfigName } = require("./pending-achievement-records");
const { backend } = require("./external-replay-controller");

// Reuse native recording's config/platform matching, deduplication and expiry.
// External replay has its own queue because it waits for selection, not native
// capture startup, and its anchor is notification visibility rather than unlock.
class PendingExternalReplay {
  constructor({ getPreferences, isActive, submit, log = () => {}, ttlMs = 20_000 }) {
    Object.assign(this, { getPreferences, isActive, submit, log });
    this.queue = new PendingAchievementRecordQueue({ ttlMs, maxSize: 32,
      onDiscard: details => log("pending-discarded", details) });
  }
  eligible(data, prefs = this.getPreferences()) {
    return backend(prefs) !== "native" && prefs?.disableAchievementRecords === false &&
      data?.isTest !== true && data?.notificationType !== "progress";
  }
  visible(data, { visibleAt = performance.now() } = {}) {
    const preferences = { ...this.getPreferences() };
    if (!this.eligible(data, preferences)) return null;
    const entry = { ...data, __externalReplay: { visibleAt, preferences } };
    if (this.isActive(entry)) return this.dispatch(entry);
    const result = this.queue.enqueue(entry);
    this.log(result.queued ? "pending-queued" : "pending-skipped", {
      ...result, displayName: data.displayName, provider: backend(preferences), pendingCount: this.queue.size,
    });
    return result;
  }
  dispatch(entry) {
    const { __externalReplay: context, ...data } = entry;
    if (!context || !this.eligible(data) || !this.isActive(data) || backend(this.getPreferences()) !== backend(context.preferences)) {
      this.log("pending-skipped", { reason: "selection-or-backend-changed", configName: getNotificationConfigName(data) });
      return null;
    }
    return this.submit(data, { visibleAt: context.visibleAt, preferences: context.preferences });
  }
  flush(selection) {
    const pending = this.queue.takeMatching(selection);
    if (pending.length) this.log("pending-flush", {
      configName: selection.configName, platform: selection.platform, count: pending.length, remaining: this.queue.size,
      maxWaitMs: Math.max(...pending.map(data => performance.now() - data.__externalReplay.visibleAt)),
    });
    return pending.map(entry => this.dispatch(entry));
  }
  clear(reason) { this.queue.clear(reason); }
}

module.exports = { PendingExternalReplay };
