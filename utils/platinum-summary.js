"use strict";

const ACCOUNT_SCOPED_PLATFORMS = new Set([
  "ea-official",
  "epic-official",
  "gog-official",
  "retroachievements",
  "steam-official",
  "ubisoft-official",
  "xbox-pc",
]);

function normalizeSummaryProgress(raw = null) {
  if (!raw || typeof raw !== "object") return null;
  const total = Math.max(0, Math.floor(Number(raw.total) || 0));
  const unlocked = Math.max(
    0,
    Math.min(
      total || Number.MAX_SAFE_INTEGER,
      Math.floor(Number(raw.unlocked) || 0),
    ),
  );
  return {
    total,
    unlocked,
    verified: raw.verified === true,
  };
}

function isVerifiedSummaryComplete(raw = null) {
  const summary = normalizeSummaryProgress(raw);
  return Boolean(
    summary?.verified &&
      summary.total > 0 &&
      summary.unlocked === summary.total,
  );
}

function isPlatinumFlagEnabled(value) {
  if (value === true || value === 1) return true;
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  return normalized === "true" || normalized === "1";
}

function normalizePlatinumBasis(raw = null) {
  const summary = normalizeSummaryProgress(raw);
  if (!summary || summary.total <= 0) return null;
  return {
    unlocked: summary.unlocked,
    total: summary.total,
  };
}

function normalizeFingerprintPart(raw = null) {
  if (!raw || typeof raw !== "object") return null;
  const filePath = String(raw.path || "").trim();
  const mtimeMs = Number(raw.mtimeMs);
  const size = Number(raw.size);
  if (
    !filePath ||
    !Number.isFinite(mtimeMs) ||
    mtimeMs < 0 ||
    !Number.isFinite(size) ||
    size < 0
  ) {
    return null;
  }
  return { path: filePath, mtimeMs, size };
}

function fingerprintPartsEqual(left, right) {
  const a = normalizeFingerprintPart(left);
  const b = normalizeFingerprintPart(right);
  if (!a || !b) return false;
  return (
    a.path.toLowerCase() === b.path.toLowerCase() &&
    a.mtimeMs === b.mtimeMs &&
    a.size === b.size
  );
}

function isPlatinumSummarySynchronized(raw = null) {
  const current = normalizeSummaryProgress(raw);
  const basis = normalizePlatinumBasis(raw?.platinumBasis);
  if (
    !current?.verified ||
    current.total <= 0 ||
    raw?.platinumSynced !== true ||
    typeof raw?.platinum !== "boolean" ||
    !basis ||
    basis.unlocked !== current.unlocked ||
    basis.total !== current.total
  ) {
    return false;
  }

  return fingerprintPartsEqual(
    raw?.platinumConfigFingerprint,
    raw?.fingerprint?.config,
  );
}

function shouldSuppressPlatinumNotification(options = {}) {
  // Initial watcher evaluations establish a baseline. They may persist the
  // completed state, but they are not runtime unlock transitions and must not
  // produce a visible Platinum notification.
  return (
    options.shouldSeed === true ||
    (options.initial === true && options.bootMode === true)
  );
}

function shouldResetPlatinumFromSummary(options = {}) {
  const current = normalizeSummaryProgress(options.current);
  if (
    !current?.verified ||
    current.total <= 0 ||
    current.unlocked === current.total ||
    options.nativePlatinum === true
  ) {
    return false;
  }

  const platform = String(options.platform || "")
    .trim()
    .toLowerCase();
  if (!ACCOUNT_SCOPED_PLATFORMS.has(platform)) return true;

  // A config-level Platinum flag is shared by all accounts. For account-scoped
  // sources, only revoke it when the schema demonstrably grew after a verified
  // completion; switching to another account must not clear another account's
  // historical completion flag.
  const previous = normalizeSummaryProgress(options.previous);
  const completedTotal = Math.max(
    0,
    Math.floor(Number(options.completedTotal) || 0),
  );
  const previousCompletedTotal =
    previous &&
    previous.total > 0 &&
    previous.unlocked === previous.total
      ? previous.total
      : completedTotal;
  return Boolean(
    previousCompletedTotal > 0 && current.total > previousCompletedTotal,
  );
}

module.exports = {
  ACCOUNT_SCOPED_PLATFORMS,
  fingerprintPartsEqual,
  isPlatinumFlagEnabled,
  isPlatinumSummarySynchronized,
  isVerifiedSummaryComplete,
  normalizePlatinumBasis,
  normalizeSummaryProgress,
  shouldResetPlatinumFromSummary,
  shouldSuppressPlatinumNotification,
};
