"use strict";

const NATIVE_NOTIFICATION_LAUNCH_PREFIX = "achievements-notification:";
const NATIVE_NOTIFICATION_PAYLOAD_VERSION = 1;
const MAX_LAUNCH_ARGUMENTS_LENGTH = 16 * 1024;

function escapeToastXml(value) {
  return String(value ?? "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function normalizePayloadString(value, maxLength) {
  const normalized = String(value ?? "").trim();
  if (!normalized || normalized.length > maxLength) return "";
  if (/[\u0000-\u001f\u007f]/.test(normalized)) return "";
  return normalized;
}

function normalizePayloadToken(value) {
  const token = normalizePayloadString(value, 128);
  return token && /^[A-Za-z0-9._-]+$/.test(token) ? token : "";
}

function encodeNativeWindowsNotificationLaunchArguments(payload = {}) {
  const token = normalizePayloadToken(payload?.token);
  const appid = normalizePayloadString(payload?.appid, 256);
  const platform = normalizePayloadString(payload?.platform, 64);
  const configName = normalizePayloadString(payload?.configName, 512);
  const achievementId = normalizePayloadString(payload?.achievementId, 256);
  if (!token || !achievementId || ((!appid || !platform) && !configName)) {
    throw new Error("Invalid native notification navigation payload");
  }

  const encoded = Buffer.from(
    JSON.stringify({
      v: NATIVE_NOTIFICATION_PAYLOAD_VERSION,
      t: token,
      a: appid,
      p: platform,
      c: configName,
      h: achievementId,
    }),
    "utf8",
  ).toString("base64url");
  return `${NATIVE_NOTIFICATION_LAUNCH_PREFIX}${encoded}`;
}

function decodeBase64UrlJson(value) {
  const encoded = String(value || "").replace(/=+$/g, "");
  if (!encoded || !/^[A-Za-z0-9_-]+$/.test(encoded)) return null;
  try {
    const buffer = Buffer.from(encoded, "base64url");
    if (!buffer.length || buffer.toString("base64url") !== encoded) return null;
    return JSON.parse(buffer.toString("utf8"));
  } catch {
    return null;
  }
}

function decodeNativeWindowsNotificationLaunchArguments(rawArguments) {
  const raw = String(rawArguments || "").trim();
  if (!raw || raw.length > MAX_LAUNCH_ARGUMENTS_LENGTH) return null;

  const candidates = [raw];
  try {
    const decoded = decodeURIComponent(raw);
    if (decoded !== raw) candidates.push(decoded);
  } catch {}

  for (const candidate of candidates) {
    if (!candidate.startsWith(NATIVE_NOTIFICATION_LAUNCH_PREFIX)) continue;
    const parsed = decodeBase64UrlJson(
      candidate.slice(NATIVE_NOTIFICATION_LAUNCH_PREFIX.length),
    );
    if (
      !parsed ||
      Number(parsed.v) !== NATIVE_NOTIFICATION_PAYLOAD_VERSION
    ) {
      continue;
    }

    const token = normalizePayloadToken(parsed.t);
    const appid = normalizePayloadString(parsed.a, 256);
    const platform = normalizePayloadString(parsed.p, 64);
    const configName = normalizePayloadString(parsed.c, 512);
    const achievementId = normalizePayloadString(parsed.h, 256);
    if (!token || !achievementId || ((!appid || !platform) && !configName)) {
      continue;
    }
    return {
      version: NATIVE_NOTIFICATION_PAYLOAD_VERSION,
      token,
      route: { appid, platform, configName, achievementId },
    };
  }
  return null;
}

function buildNativeWindowsAchievementToastXml(options = {}) {
  const launchArguments = String(options?.launchArguments || "").trim();
  if (!launchArguments) {
    throw new Error("Native notification launch arguments are required");
  }
  const groupId = String(options?.groupId || "").trim();
  const groupTitle = String(options?.groupTitle || "").trim();
  const title = String(options?.title || "Achievement");
  const body = String(options?.body || "");
  const iconUrl = String(options?.iconUrl || "").trim();
  const headerXml =
    groupId && groupTitle
      ? `<header id="${escapeToastXml(groupId)}" title="${escapeToastXml(groupTitle)}" arguments="${escapeToastXml(launchArguments)}"/>`
      : "";
  const imageXml = iconUrl
    ? `<image placement="appLogoOverride" src="${escapeToastXml(iconUrl)}"/>`
    : "";
  const bodyXml = body ? `<text>${escapeToastXml(body)}</text>` : "";
  return [
    `<toast launch="${escapeToastXml(launchArguments)}">`,
    headerXml,
    '<visual><binding template="ToastGeneric">',
    imageXml,
    `<text>${escapeToastXml(title)}</text>`,
    bodyXml,
    "</binding></visual>",
    '<audio silent="true"/>',
    "</toast>",
  ].join("");
}

class NativeWindowsNotificationReferenceStore {
  constructor(options = {}) {
    this.maxEntries = Math.max(1, Number(options.maxEntries) || 64);
    this.ttlMs = Math.max(1, Number(options.ttlMs) || 7 * 24 * 60 * 60 * 1000);
    this.onRelease =
      typeof options.onRelease === "function" ? options.onRelease : null;
    this.entries = new Map();
  }

  retain(token, notification) {
    const normalizedToken = normalizePayloadToken(token);
    if (!normalizedToken || !notification) return false;

    this.release(normalizedToken, "replaced");
    const timer = setTimeout(() => {
      this.release(normalizedToken, "ttl-expired", notification);
    }, this.ttlMs);
    timer.unref?.();
    this.entries.set(normalizedToken, {
      notification,
      timer,
      retainedAt: Date.now(),
    });

    while (this.entries.size > this.maxEntries) {
      const oldestToken = this.entries.keys().next().value;
      if (!oldestToken) break;
      this.release(oldestToken, "capacity-evicted");
    }
    return true;
  }

  release(token, reason = "unknown", expectedNotification = null) {
    const normalizedToken = normalizePayloadToken(token);
    if (!normalizedToken) return false;
    const entry = this.entries.get(normalizedToken);
    if (!entry) return false;
    if (
      expectedNotification &&
      entry.notification !== expectedNotification
    ) {
      return false;
    }
    if (entry.timer) clearTimeout(entry.timer);
    this.entries.delete(normalizedToken);
    try {
      this.onRelease?.({
        token: normalizedToken,
        reason: String(reason || "unknown"),
        retainedMs: Math.max(0, Date.now() - Number(entry.retainedAt || 0)),
        remaining: this.entries.size,
      });
    } catch {}
    return true;
  }

  releaseAll(reason = "unknown") {
    for (const token of Array.from(this.entries.keys())) {
      this.release(token, reason);
    }
  }

  has(token) {
    return this.entries.has(normalizePayloadToken(token));
  }

  get size() {
    return this.entries.size;
  }
}

module.exports = {
  NATIVE_NOTIFICATION_LAUNCH_PREFIX,
  NativeWindowsNotificationReferenceStore,
  buildNativeWindowsAchievementToastXml,
  decodeNativeWindowsNotificationLaunchArguments,
  encodeNativeWindowsNotificationLaunchArguments,
  escapeToastXml,
};
