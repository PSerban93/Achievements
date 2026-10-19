"use strict";

const { AsyncLocalStorage } = require("async_hooks");
const context = new AsyncLocalStorage();
let notificationHandler = null;

// This classifies request failures only. It never changes a provider's result,
// retry policy or blacklist decision. A 404 can be valid absence evidence.
function schemaConnectionFailure(error, seen = new Set()) {
  if (!error || seen.has(error)) return false;
  seen.add(error);
  const code = String(error.code || "");
  if (/CANCELLED|CANCELED|GENERATION_TIMEOUT/.test(code)) return false;
  const status = Number(error.status || error.statusCode || error.response?.status);
  if (status >= 400 && status <= 599 && status !== 404) return true;
  const message = typeof error === "string" ? error : String(error.message || "");
  if (/\b(?:HTTP(?:\s+Error)?|status(?:\s+code)?|Epic(?:\s+GraphQL)?|GOG\s+token|EGData\s+\w+\s+lookup)\s*[:=]?\s*(?!404\b)[45]\d\d\b/i.test(message)) return true;
  if (/\b(?!404\b)[45]\d\d\s+(?:Client|Server)\s+Error\b/i.test(message)) return true;
  if (/\b(?:net::ERR_[A-Z0-9_]+|EAI_AGAIN|ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ECONNABORTED|ENETUNREACH|EHOSTUNREACH|EPROTO|UND_ERR_[A-Z_]+|CERT_[A-Z_]+|CERTIFICATE_VERIFY_FAILED|ERR_TLS_[A-Z_]+|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE|SSLError)\b/i.test(`${code} ${message}`)) return true;
  if (/\b(?:fetch failed|network error|network request failed|socket hang up|connection (?:reset|refused|aborted)|name resolution|connectionerror|connecttimeout|readtimeout|timeouterror|timed?\s*out|timeout)\b/i.test(message)) return true;
  if (["TimeoutError", "AbortError"].includes(error.name)) return true;
  return schemaConnectionFailure(error.cause, seen) ||
    (Array.isArray(error.errors) && error.errors.some((entry) => schemaConnectionFailure(entry, seen)));
}

function withSchemaDownloadContext(state, fn) {
  return context.run(state, fn);
}

function setSchemaDownloadName(name, options = {}) {
  const state = context.getStore();
  if (state && typeof name === "string" && (name.trim() || options.clear === true)) state.displayName = name.trim();
}

function reportSchemaDownloadError(error, source = "schema") {
  const state = context.getStore();
  if (!state || state.warned || !schemaConnectionFailure(error)) return;
  state.warned = true;
  try {
    const rawReason = typeof error === "string" ? error : error.message || error.code ||
      (error.status ? `HTTP ${error.status}` : "Request failed");
    const reason = String(rawReason).replace(/([?&](?:key|api_key|token|access_token|password)=)[^&\s]+/gi, "$1[redacted]").slice(0, 512);
    state.onWarning?.({ type: "achgen:download-warning", appid: state.appid,
      displayName: state.displayName || "", source, reason });
  } catch {} // Reporting must never interrupt generation.
}

async function schemaDownloadRequest(source, request) {
  try { return await request(); }
  catch (error) { reportSchemaDownloadError(error, source); throw error; }
}

function reportSchemaDownloadDiagnostics(result, source, seen = new Set()) {
  if (!result || seen.has(result)) return;
  seen.add(result);
  if (typeof result === "string" || result instanceof Error) {
    reportSchemaDownloadError(result, source); return;
  }
  if (Array.isArray(result)) {
    for (const entry of result) reportSchemaDownloadDiagnostics(entry, source, seen);
    return;
  }
  for (const key of ["error", "errors", "attempts", "downloadWarnings"]) {
    reportSchemaDownloadDiagnostics(result[key], source, seen);
  }
}

function configureSchemaDownloadNotifications(handler) {
  notificationHandler = typeof handler === "function" ? handler : null;
}

// One receiver per child/generation operation, not a persistent suppression list.
function createSchemaDownloadWarningReceiver() {
  const notified = new Set();
  return (message) => {
    if (message?.type !== "achgen:download-warning") return false;
    const appid = String(message.appid || "").trim().slice(0, 128);
    if (appid && !notified.has(appid)) {
      notified.add(appid);
      try { notificationHandler?.({ appid, displayName: String(message.displayName || "").trim().slice(0, 256) }); } catch {}
    }
    return true;
  };
}

module.exports = { schemaConnectionFailure, withSchemaDownloadContext,
  setSchemaDownloadName, reportSchemaDownloadError, schemaDownloadRequest,
  reportSchemaDownloadDiagnostics, configureSchemaDownloadNotifications,
  createSchemaDownloadWarningReceiver };
