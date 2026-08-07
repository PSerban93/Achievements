"use strict";

const APP_NAVIGATION_VALUE_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const NOTIFICATION_NAVIGATION_TARGETS = new Set(["overlay", "application"]);

function normalizeNavigationAppId(value) {
  const normalized = String(value || "").trim();
  if (!APP_NAVIGATION_VALUE_RE.test(normalized)) return "";
  return normalized.toLowerCase();
}

function normalizeNavigationPlatform(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (!APP_NAVIGATION_VALUE_RE.test(normalized)) return "";
  return normalized;
}

function normalizeNotificationNavigationTarget(value, fallback = "overlay") {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (NOTIFICATION_NAVIGATION_TARGETS.has(normalized)) return normalized;
  const normalizedFallback = String(fallback || "")
    .trim()
    .toLowerCase();
  return NOTIFICATION_NAVIGATION_TARGETS.has(normalizedFallback)
    ? normalizedFallback
    : "overlay";
}

function readArgumentValues(argv, name) {
  const args = Array.isArray(argv) ? argv.map((value) => String(value)) : [];
  const prefix = `${name}=`;
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === name) {
      const next = args[index + 1];
      if (next !== undefined && !String(next).startsWith("--")) {
        values.push(String(next));
        index += 1;
      } else {
        values.push("");
      }
      continue;
    }
    if (arg.startsWith(prefix)) {
      values.push(arg.slice(prefix.length));
    }
  }
  return values;
}

function getSingleArgumentValue(argv, name) {
  const values = readArgumentValues(argv, name);
  if (!values.length) return { present: false, value: "", error: "" };
  const normalized = values.map((value) => String(value || "").trim());
  const distinct = Array.from(new Set(normalized));
  if (distinct.length > 1) {
    return { present: true, value: "", error: `conflicting-${name.slice(2)}` };
  }
  return { present: true, value: distinct[0] || "", error: "" };
}

function parseAppNavigationArgs(argv) {
  const appidArg = getSingleArgumentValue(argv, "--appid");
  const platformArg = getSingleArgumentValue(argv, "--platform");
  const hasNavigationArgs = appidArg.present || platformArg.present;

  if (!hasNavigationArgs) {
    return { hasNavigationArgs: false, route: null, error: "" };
  }
  if (appidArg.error || platformArg.error) {
    return {
      hasNavigationArgs: true,
      route: null,
      error: appidArg.error || platformArg.error,
    };
  }
  if (!appidArg.present) {
    return {
      hasNavigationArgs: true,
      route: null,
      error: "missing-appid",
    };
  }

  let appidValue = appidArg.value;
  let compactPlatformValue = "";
  if (appidValue.includes("/")) {
    const compactParts = appidValue.split("/");
    if (
      compactParts.length !== 2 ||
      !compactParts[0].trim() ||
      !compactParts[1].trim()
    ) {
      return {
        hasNavigationArgs: true,
        route: null,
        error: "invalid-appid-platform",
      };
    }
    [appidValue, compactPlatformValue] = compactParts;
  }

  if (!compactPlatformValue && !platformArg.present) {
    return {
      hasNavigationArgs: true,
      route: null,
      error: "missing-platform",
    };
  }

  const appid = normalizeNavigationAppId(appidValue);
  const compactPlatform = normalizeNavigationPlatform(compactPlatformValue);
  const explicitPlatform = platformArg.present
    ? normalizeNavigationPlatform(platformArg.value)
    : "";
  const platform = compactPlatform || explicitPlatform;
  if (!appid || !platform) {
    return {
      hasNavigationArgs: true,
      route: null,
      error: !appid ? "invalid-appid" : "invalid-platform",
    };
  }
  if (
    compactPlatform &&
    explicitPlatform &&
    compactPlatform !== explicitPlatform
  ) {
    return {
      hasNavigationArgs: true,
      route: null,
      error: "conflicting-platform",
    };
  }

  return {
    hasNavigationArgs: true,
    route: { appid, platform },
    error: "",
  };
}

function stripAppNavigationArgs(argv) {
  const args = Array.isArray(argv) ? argv.map((value) => String(value)) : [];
  const output = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--appid" || arg === "--platform") {
      if (
        args[index + 1] !== undefined &&
        !String(args[index + 1]).startsWith("--")
      ) {
        index += 1;
      }
      continue;
    }
    if (arg.startsWith("--appid=") || arg.startsWith("--platform=")) continue;
    output.push(arg);
  }
  return output;
}

function configMatchesNavigationRoute(
  config,
  route,
  normalizePlatform = normalizeNavigationPlatform,
) {
  const configAppId = normalizeNavigationAppId(config?.appid ?? config?.appId);
  const routeAppId = normalizeNavigationAppId(route?.appid);
  if (!configAppId || !routeAppId || configAppId !== routeAppId) return false;
  const configPlatform = normalizePlatform(config?.platform);
  const routePlatform = normalizePlatform(route?.platform);
  return !!configPlatform && configPlatform === routePlatform;
}

module.exports = {
  configMatchesNavigationRoute,
  normalizeNavigationAppId,
  normalizeNavigationPlatform,
  normalizeNotificationNavigationTarget,
  parseAppNavigationArgs,
  stripAppNavigationArgs,
};
