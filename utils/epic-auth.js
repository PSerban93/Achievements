const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const axios = require("axios");

const EPIC_ACCOUNT_AUTH_BASE =
  "https://account-public-service-prod03.ol.epicgames.com/account/api";
const EPIC_AUTHORIZATION_URL = "https://www.epicgames.com/id/authorize";
const EPIC_LOGIN_URL = "https://www.epicgames.com/id/login";
const EPIC_AUTH_REDIRECT_URL = "https://www.epicgames.com/id/api/redirect";
const DEFAULT_EPIC_REDIRECT_URI = "https://www.epicgames.com/id/api/redirect";
const DEFAULT_EPIC_TOKEN_SECRET = "epic_default_passphrase";
const EPIC_LAUNCHER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) EpicGamesLauncher";
const EPIC_CLIENT_ID = "34a02cf8f4414e29b15921876da36f9a";
const EPIC_BASIC_TOKEN =
  "MzRhMDJjZjhmNDQxNGUyOWIxNTkyMTg3NmRhMzZmOWE6ZGFhZmJjY2M3Mzc3NDUwMzlkZmZlNTNkOTRmYzc2Y2Y=";

function firstNonEmpty(...values) {
  for (const value of values) {
    const text = String(value || "").trim();
    if (text) return text;
  }
  return "";
}

function resolveEpicTokensFile(userDataDir = "", explicitPath = "") {
  const fromFlag = String(explicitPath || "").trim();
  if (fromFlag) return path.resolve(fromFlag);
  const base = String(userDataDir || "").trim();
  if (base) return path.join(path.resolve(base), "epic_tokens.enc");
  return path.join(process.cwd(), "epic_tokens.enc");
}

function normalizeEpicAccountId(value) {
  const raw = String(value || "").trim();
  return /^[0-9a-f-]{16,64}$/i.test(raw) ? raw : "";
}

function normalizeTokenLifetimes(token = {}) {
  const out = { ...token };
  out.expires_at =
    Date.now() + Math.max(0, (Number(out.expires_in) || 3600) - 60) * 1000;
  return out;
}

function ensureTokenDir(filePath) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  } catch {}
}

function encryptTokens(payload, tokenSecret) {
  const secret = String(tokenSecret || DEFAULT_EPIC_TOKEN_SECRET);
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(secret, salt, 32);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const raw = Buffer.from(JSON.stringify(payload || {}), "utf8");
  const encrypted = Buffer.concat([cipher.update(raw), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.from(
    JSON.stringify({
      v: 1,
      s: salt.toString("base64"),
      i: iv.toString("base64"),
      t: tag.toString("base64"),
      c: encrypted.toString("base64"),
    }),
    "utf8",
  );
}

function decryptTokens(buffer, tokenSecret) {
  if (!buffer) return null;
  const secret = String(tokenSecret || DEFAULT_EPIC_TOKEN_SECRET);
  const payload = JSON.parse(
    Buffer.isBuffer(buffer) ? buffer.toString("utf8") : String(buffer),
  );
  const salt = Buffer.from(payload.s, "base64");
  const iv = Buffer.from(payload.i, "base64");
  const tag = Buffer.from(payload.t, "base64");
  const ct = Buffer.from(payload.c, "base64");
  const key = crypto.scryptSync(secret, salt, 32);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const decoded = Buffer.concat([decipher.update(ct), decipher.final()]);
  return JSON.parse(decoded.toString("utf8"));
}

function getEpicAuthConfig(options = {}) {
  const optionClientId = firstNonEmpty(options?.clientId);
  const optionClientSecret = firstNonEmpty(options?.clientSecret);
  const optionBasicToken = firstNonEmpty(options?.basicToken).replace(
    /^Basic\s+/i,
    "",
  );
  const envClientId = firstNonEmpty(process.env.EPIC_CLIENT_ID);
  const envClientSecret = firstNonEmpty(process.env.EPIC_CLIENT_SECRET);
  const envBasicToken = firstNonEmpty(process.env.EPIC_BASIC_TOKEN).replace(
    /^Basic\s+/i,
    "",
  );
  const allowFallback =
    options?.allowFallback !== false &&
    String(process.env.EPIC_DISABLE_OAUTH || "").trim() !== "1";
  const fallbackClientId = allowFallback ? EPIC_CLIENT_ID : "";
  const fallbackBasicToken = allowFallback ? EPIC_BASIC_TOKEN : "";
  const clientId = firstNonEmpty(optionClientId, envClientId);
  const clientSecret = firstNonEmpty(optionClientSecret, envClientSecret);
  const basicToken = firstNonEmpty(
    optionBasicToken,
    envBasicToken,
    fallbackBasicToken,
  );
  const effectiveClientId = firstNonEmpty(clientId, fallbackClientId);
  const redirectUri = firstNonEmpty(
    options?.redirectUri,
    process.env.EPIC_REDIRECT_URI,
    DEFAULT_EPIC_REDIRECT_URI,
  );
  const tokenType = firstNonEmpty(
    options?.tokenType,
    process.env.EPIC_TOKEN_TYPE,
    basicToken === fallbackBasicToken && fallbackBasicToken ? "eg1" : "",
  );
  const source =
    optionClientId || optionClientSecret || optionBasicToken
      ? "options"
      : envClientId || envClientSecret || envBasicToken
        ? "env"
        : fallbackBasicToken
          ? "epic"
          : "";
  return {
    clientId: effectiveClientId,
    clientSecret,
    basicToken,
    redirectUri,
    tokenType,
    configured: !!effectiveClientId && (!!clientSecret || !!basicToken),
    source,
  };
}

function buildEpicLoginUrl(options = {}) {
  const cfg = getEpicAuthConfig(options);
  if (!cfg.clientId) throw new Error("epic-auth-client-missing");
  if (cfg.source === "epic" && !options?.forceAuthorizeEndpoint) {
    const login = new URL(EPIC_LOGIN_URL);
    login.searchParams.set("responseType", "code");
    return login.toString();
  }
  const url = new URL(EPIC_AUTHORIZATION_URL);
  url.searchParams.set("client_id", cfg.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", cfg.redirectUri);
  if (options?.state) url.searchParams.set("state", String(options.state));
  return url.toString();
}

function buildEpicAuthCodeUrl(options = {}) {
  const cfg = getEpicAuthConfig(options);
  if (!cfg.clientId) throw new Error("epic-auth-client-missing");
  const url = new URL(EPIC_AUTH_REDIRECT_URL);
  url.searchParams.set("clientId", cfg.clientId);
  url.searchParams.set("responseType", "code");
  return url.toString();
}

async function loadEpicTokensEncrypted(filePath, tokenSecret) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return null;
    const buffer = await fsp.readFile(filePath);
    return decryptTokens(buffer, tokenSecret);
  } catch {
    return null;
  }
}

async function saveEpicTokensEncrypted(filePath, token, tokenSecret) {
  if (!filePath || !token) return;
  ensureTokenDir(filePath);
  await fsp.writeFile(
    filePath,
    encryptTokens(normalizeTokenLifetimes(token), tokenSecret),
  );
}

async function clearEpicTokens(options = {}) {
  const filePath = resolveEpicTokensFile(
    options?.userDataDir,
    options?.tokensFile,
  );
  try {
    if (filePath && fs.existsSync(filePath)) await fsp.unlink(filePath);
  } catch {}
}

async function requestEpicToken(grant, options = {}) {
  const cfg = getEpicAuthConfig(options);
  if (!cfg.configured) throw new Error("epic-auth-client-missing");
  const timeoutMs =
    Number.isFinite(options?.timeoutMs) && options.timeoutMs > 0
      ? Number(options.timeoutMs)
      : 15000;
  const bodyParams = { ...grant };
  if (
    bodyParams.grant_type === "authorization_code" &&
    (cfg.source !== "epic" || options?.forceRedirectUri === true)
  ) {
    bodyParams.redirect_uri = cfg.redirectUri;
  }
  if (cfg.tokenType && !bodyParams.token_type) {
    bodyParams.token_type = cfg.tokenType;
  }
  const body = new URLSearchParams(bodyParams);
  const basicToken =
    cfg.basicToken ||
    Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`, "utf8").toString(
      "base64",
    );
  const res = await axios.post(
    `${EPIC_ACCOUNT_AUTH_BASE}/oauth/token`,
    body.toString(),
    {
      timeout: timeoutMs,
      headers: {
        Authorization: `basic ${basicToken}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      validateStatus: (status) => status >= 200 && status < 500,
      responseType: "json",
    },
  );
  if (res.status >= 400) {
    const details =
      res?.data && typeof res.data === "object"
        ? res.data.errorMessage ||
          res.data.error_description ||
          res.data.error ||
          res.data.message
        : typeof res?.data === "string"
          ? res.data
          : "";
    throw new Error(
      details
        ? `Epic token ${res.status}: ${details}`
        : `Epic token ${res.status}`,
    );
  }
  return normalizeTokenLifetimes(res?.data || {});
}

async function authenticateEpicWithCode(code, options = {}) {
  const authCode = String(code || "").trim();
  if (!authCode) throw new Error("epic-auth-code-missing");
  const token = await requestEpicToken(
    { grant_type: "authorization_code", code: authCode },
    options,
  );
  const filePath = resolveEpicTokensFile(
    options?.userDataDir,
    options?.tokensFile,
  );
  const tokenSecret = String(
    options?.tokenSecret ||
      process.env.EPIC_TOKEN_SECRET ||
      DEFAULT_EPIC_TOKEN_SECRET,
  );
  await saveEpicTokensEncrypted(filePath, token, tokenSecret);
  return token;
}

async function ensureEpicAccessToken(options = {}) {
  const filePath = resolveEpicTokensFile(
    options?.userDataDir,
    options?.tokensFile,
  );
  const tokenSecret = String(
    options?.tokenSecret ||
      process.env.EPIC_TOKEN_SECRET ||
      DEFAULT_EPIC_TOKEN_SECRET,
  );
  const token = await loadEpicTokensEncrypted(filePath, tokenSecret);
  if (!token) throw new Error("epic-token-missing");
  if (
    options?.forceRefresh !== true &&
    token?.access_token &&
    token?.expires_at &&
    Date.now() < token.expires_at
  ) {
    return token;
  }
  if (!token?.refresh_token) throw new Error("epic-refresh-token-missing");
  const refreshed = await requestEpicToken(
    {
      grant_type: "refresh_token",
      refresh_token: token.refresh_token,
    },
    options,
  );
  if (!refreshed.account_id && token.account_id) {
    refreshed.account_id = token.account_id;
  }
  if (!refreshed.displayName && token.displayName) {
    refreshed.displayName = token.displayName;
  }
  await saveEpicTokensEncrypted(filePath, refreshed, tokenSecret);
  return refreshed;
}

async function getEpicAuthStatus(options = {}) {
  const filePath = resolveEpicTokensFile(
    options?.userDataDir,
    options?.tokensFile,
  );
  const tokenSecret = String(
    options?.tokenSecret ||
      process.env.EPIC_TOKEN_SECRET ||
      DEFAULT_EPIC_TOKEN_SECRET,
  );
  const token = await loadEpicTokensEncrypted(filePath, tokenSecret);
  const cfg = getEpicAuthConfig(options);
  const accountId = normalizeEpicAccountId(token?.account_id);
  return {
    configured: cfg.configured,
    configSource: cfg.source || "",
    connected: !!token?.access_token && !!accountId,
    accountId,
    displayName: String(token?.displayName || token?.display_name || "").trim(),
    expiresAt: Number(token?.expires_at || 0) || 0,
    needsRefresh:
      !!token?.refresh_token && Date.now() >= Number(token?.expires_at || 0),
    tokensFile: filePath,
  };
}

module.exports = {
  DEFAULT_EPIC_TOKEN_SECRET,
  DEFAULT_EPIC_REDIRECT_URI,
  EPIC_LAUNCHER_USER_AGENT,
  getEpicAuthConfig,
  buildEpicLoginUrl,
  buildEpicAuthCodeUrl,
  resolveEpicTokensFile,
  normalizeEpicAccountId,
  loadEpicTokensEncrypted,
  saveEpicTokensEncrypted,
  clearEpicTokens,
  authenticateEpicWithCode,
  ensureEpicAccessToken,
  getEpicAuthStatus,
};
