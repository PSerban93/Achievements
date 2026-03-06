const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const axios = require("axios");

const GOG_AUTH_BASE = "https://auth.gog.com";
const GOG_CLIENT_ID = "46899977096215655";
const GOG_CLIENT_SECRET =
  "9d85c43b1482497dbbce61f6e4aa173a433796eeae2ca8c5f6129f2dc4de46d9";
const GOG_REDIRECT_URI = "https://embed.gog.com/on_login_success?origin=client";
const DEFAULT_GOG_TOKEN_SECRET = "gog_default_passphrase";

function resolveGogTokensFile(userDataDir = "", explicitPath = "") {
  const fromFlag = String(explicitPath || "").trim();
  if (fromFlag) return path.resolve(fromFlag);
  const base = String(userDataDir || "").trim();
  if (base) return path.join(path.resolve(base), "gog_tokens.enc");
  return path.join(process.cwd(), "gog_tokens.enc");
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
  const secret = String(tokenSecret || DEFAULT_GOG_TOKEN_SECRET);
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(secret, salt, 32);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const raw = Buffer.from(JSON.stringify(payload || {}), "utf8");
  const encrypted = Buffer.concat([cipher.update(raw), cipher.final()]);
  const tag = cipher.getAuthTag();
  const body = {
    v: 1,
    s: salt.toString("base64"),
    i: iv.toString("base64"),
    t: tag.toString("base64"),
    c: encrypted.toString("base64"),
  };
  return Buffer.from(JSON.stringify(body), "utf8");
}

function decryptTokens(buffer, tokenSecret) {
  if (!buffer) return null;
  const secret = String(tokenSecret || DEFAULT_GOG_TOKEN_SECRET);
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

async function loadGogTokensEncrypted(filePath, tokenSecret) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return null;
    const buffer = await fsp.readFile(filePath);
    return decryptTokens(buffer, tokenSecret);
  } catch {
    return null;
  }
}

async function saveGogTokensEncrypted(filePath, token, tokenSecret) {
  if (!filePath || !token) return;
  ensureTokenDir(filePath);
  const normalized = normalizeTokenLifetimes(token);
  await fsp.writeFile(filePath, encryptTokens(normalized, tokenSecret));
}

async function requestGogToken(grant, options = {}) {
  const timeoutMs =
    Number.isFinite(options?.timeoutMs) && options.timeoutMs > 0
      ? Number(options.timeoutMs)
      : 15000;
  const body = new URLSearchParams({
    client_id: GOG_CLIENT_ID,
    client_secret: GOG_CLIENT_SECRET,
    redirect_uri: GOG_REDIRECT_URI,
    ...grant,
  });
  const res = await axios.post(`${GOG_AUTH_BASE}/token`, body.toString(), {
    timeout: timeoutMs,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    validateStatus: (status) => status >= 200 && status < 500,
    responseType: "json",
  });
  if (res.status >= 400) {
    throw new Error(`GOG token ${res.status}`);
  }
  return normalizeTokenLifetimes(res?.data || {});
}

async function ensureGogAccessToken(options = {}) {
  const filePath = resolveGogTokensFile(
    options?.userDataDir,
    options?.tokensFile,
  );
  const tokenSecret = String(
    options?.tokenSecret || process.env.GOG_TOKEN_SECRET || DEFAULT_GOG_TOKEN_SECRET,
  );
  const timeoutMs =
    Number.isFinite(options?.timeoutMs) && options.timeoutMs > 0
      ? Number(options.timeoutMs)
      : 15000;
  let token = await loadGogTokensEncrypted(filePath, tokenSecret);
  if (!token) throw new Error("gog-token-missing");
  if (token?.access_token && token?.user_id && token?.expires_at && Date.now() < token.expires_at) {
    return token;
  }
  if (!token?.refresh_token) throw new Error("gog-refresh-token-missing");
  const refreshed = await requestGogToken(
    {
      grant_type: "refresh_token",
      refresh_token: token.refresh_token,
    },
    { timeoutMs },
  );
  if (!refreshed.user_id && token.user_id) {
    refreshed.user_id = token.user_id;
  }
  await saveGogTokensEncrypted(filePath, refreshed, tokenSecret);
  return refreshed;
}

module.exports = {
  DEFAULT_GOG_TOKEN_SECRET,
  resolveGogTokensFile,
  loadGogTokensEncrypted,
  saveGogTokensEncrypted,
  ensureGogAccessToken,
};

