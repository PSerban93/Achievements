const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { execFile } = require("child_process");
const axios = require("axios");
const { live, xnet } = require("@xboxreplay/xboxlive-auth");
const { createLogger } = require("./logger");
const {
  RARITY_SOURCES,
  writeAchievementPercentagesSidecar,
} = require("./achievement-rarity");

const XBOX_PC_PLATFORM = "xbox-pc";
const XBOX_PC_AUTH_FILE = "xbox-pc-microsoft-auth.enc";
const XBOX_PC_LEGACY_KEY_FILE = "xbox-pc-openxbl-key.enc";
const XBOX_PC_AUTH_SECRET = "achievements-xbox-pc-microsoft-auth-v1";
const XBOX_PC_OAUTH_SCOPE = "Xboxlive.signin Xboxlive.offline_access";
const XBOX_PC_REDIRECT_URI = "http://localhost:8080/auth/callback";
const XBOX_PC_RELYING_PARTY = "http://xboxlive.com";
const XBOX_ACHIEVEMENTS_URL = "https://achievements.xboxlive.com";
const XBOX_TITLEHUB_URL = "https://titlehub.xboxlive.com";
const XBOX_ACHIEVEMENTS_CONTRACT_VERSION = "4";
const XBOX_SCHEMA_LANGUAGE_LOCALES = Object.freeze({
  arabic: "ar-SA",
  bulgarian: "bg-BG",
  schinese: "zh-CN",
  tchinese: "zh-TW",
  czech: "cs-CZ",
  danish: "da-DK",
  dutch: "nl-NL",
  english: "en-US",
  finnish: "fi-FI",
  french: "fr-FR",
  german: "de-DE",
  greek: "el-GR",
  hungarian: "hu-HU",
  indonesian: "id-ID",
  italian: "it-IT",
  japanese: "ja-JP",
  koreana: "ko-KR",
  norwegian: "nb-NO",
  polish: "pl-PL",
  portuguese: "pt-PT",
  brazilian: "pt-BR",
  romanian: "ro-RO",
  russian: "ru-RU",
  spanish: "es-ES",
  latam: "es-MX",
  swedish: "sv-SE",
  thai: "th-TH",
  turkish: "tr-TR",
  ukrainian: "uk-UA",
  vietnamese: "vi-VN",
});
const XBOX_PC_CLIENT_ID =
  normalizeXboxClientId(process.env.XBOX_PC_CLIENT_ID) ||
  "388ea51c-0b25-4029-aae2-17df49d23905";
const xboxPcLogger = createLogger("xbox-pc", {
  level: process.env.XBOX_PC_LOG_LEVEL || "info",
});

function firstNonEmpty(...values) {
  for (const value of values) {
    const text = String(value || "").trim();
    if (text) return text;
  }
  return "";
}

function sanitizeSegment(value, fallback = "xbox-pc") {
  const result = String(value || "")
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, "_")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 160);
  return result || fallback;
}

function sanitizeConfigName(value) {
  const result = String(value || "")
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
  return result || "Xbox PC Game";
}

function normalizeTitleId(value) {
  const raw = String(value ?? "").trim();
  if (/^0x[0-9a-f]{1,16}$/i.test(raw)) {
    try {
      return BigInt(raw).toString(10);
    } catch {
      return "";
    }
  }
  return /^\d{1,20}$/.test(raw) ? raw : "";
}

function normalizeMicrosoftGameTitleId(value) {
  const raw = String(value ?? "").trim();
  if (/^[0-9a-f]{1,16}$/i.test(raw)) {
    try {
      return BigInt(`0x${raw}`).toString(10);
    } catch {
      return "";
    }
  }
  return normalizeTitleId(raw);
}

function normalizeXuid(value) {
  const raw = String(value ?? "").trim();
  return /^\d{8,20}$/.test(raw) ? raw : "";
}

function normalizeXboxSchemaLanguages(value) {
  const source = Array.isArray(value) ? value : [];
  const languages = [];
  const seen = new Set();
  for (const item of source) {
    const language = String(item || "")
      .trim()
      .toLowerCase();
    if (
      !language ||
      !XBOX_SCHEMA_LANGUAGE_LOCALES[language] ||
      seen.has(language)
    ) {
      continue;
    }
    seen.add(language);
    languages.push(language);
  }
  return languages.length ? languages : ["english"];
}

function normalizeXboxClientId(value) {
  const raw = String(value || "").trim();
  if (
    !raw ||
    raw.length < 16 ||
    raw.length > 128 ||
    !/^[a-zA-Z0-9._-]+$/.test(raw)
  ) {
    return "";
  }
  return raw;
}

function resolveAuthPath(userDataDir) {
  return path.join(path.resolve(String(userDataDir || ".")), XBOX_PC_AUTH_FILE);
}

function resolveLegacyKeyPath(userDataDir) {
  return path.join(
    path.resolve(String(userDataDir || ".")),
    XBOX_PC_LEGACY_KEY_FILE,
  );
}

function getElectronSafeStorage() {
  try {
    const electron = require("electron");
    const safeStorage = electron?.safeStorage;
    if (
      safeStorage &&
      typeof safeStorage.isEncryptionAvailable === "function" &&
      safeStorage.isEncryptionAvailable()
    ) {
      return safeStorage;
    }
  } catch {}
  return null;
}

function encryptAuthPayload(payload) {
  const serialized = JSON.stringify(payload);
  const safeStorage = getElectronSafeStorage();
  if (safeStorage) {
    return Buffer.from(
      JSON.stringify({
        v: 2,
        mode: "electron-safe-storage",
        data: safeStorage.encryptString(serialized).toString("base64"),
      }),
      "utf8",
    );
  }
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(XBOX_PC_AUTH_SECRET, salt, 32);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([
    cipher.update(Buffer.from(serialized, "utf8")),
    cipher.final(),
  ]);
  return Buffer.from(
    JSON.stringify({
      v: 1,
      salt: salt.toString("base64"),
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      data: encrypted.toString("base64"),
    }),
    "utf8",
  );
}

function decryptAuthPayload(buffer) {
  const payload = JSON.parse(Buffer.from(buffer).toString("utf8"));
  if (payload?.v === 2 && payload?.mode === "electron-safe-storage") {
    const safeStorage = getElectronSafeStorage();
    if (!safeStorage) throw new Error("xbox-pc-safe-storage-unavailable");
    return JSON.parse(
      safeStorage.decryptString(Buffer.from(payload.data, "base64")),
    );
  }
  if (payload?.v !== 1) throw new Error("xbox-pc-auth-version-unsupported");
  const key = crypto.scryptSync(
    XBOX_PC_AUTH_SECRET,
    Buffer.from(payload.salt, "base64"),
    32,
  );
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(payload.iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(payload.tag, "base64"));
  return JSON.parse(
    Buffer.concat([
      decipher.update(Buffer.from(payload.data, "base64")),
      decipher.final(),
    ]).toString("utf8"),
  );
}

function normalizeStoredAuth(payload = {}) {
  const clientId = normalizeXboxClientId(payload.clientId);
  const refreshToken = String(payload.refreshToken || "").trim();
  if (!clientId || !refreshToken) return null;
  return {
    clientId,
    refreshToken,
    accessToken: String(payload.accessToken || "").trim(),
    accessExpiresAt: Number(payload.accessExpiresAt) || 0,
    xstsToken: String(payload.xstsToken || "").trim(),
    xstsExpiresAt: Number(payload.xstsExpiresAt) || 0,
    xuid: normalizeXuid(payload.xuid),
    uhs: String(payload.uhs || "").trim(),
    gamertag: String(payload.gamertag || "").trim(),
  };
}

async function saveXboxDirectAuth(userDataDir, auth) {
  const normalized = normalizeStoredAuth(auth);
  if (!normalized) throw new Error("xbox-pc-auth-invalid");
  const filePath = resolveAuthPath(userDataDir);
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, encryptAuthPayload(normalized));
  try {
    await fsp.unlink(resolveLegacyKeyPath(userDataDir));
  } catch (error) {
    if (error?.code !== "ENOENT") {
      xboxPcLogger.warn("xbox-pc:legacy-openxbl-key-remove-failed", {
        error: error?.message || String(error),
      });
    }
  }
  return filePath;
}

async function loadXboxDirectAuth(userDataDir) {
  try {
    return normalizeStoredAuth(
      decryptAuthPayload(await fsp.readFile(resolveAuthPath(userDataDir))),
    );
  } catch {
    return null;
  }
}

async function clearXboxDirectAuth(userDataDir) {
  for (const filePath of [
    resolveAuthPath(userDataDir),
    resolveLegacyKeyPath(userDataDir),
  ]) {
    try {
      await fsp.unlink(filePath);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

function buildXboxDirectAuthorizeUrl(clientId, state = "") {
  const normalized = normalizeXboxClientId(clientId || XBOX_PC_CLIENT_ID);
  if (!normalized) throw new Error("xbox-pc-client-id-invalid");
  const url = new URL(
    live.getAuthorizeUrl(
      normalized,
      XBOX_PC_OAUTH_SCOPE,
      "code",
      XBOX_PC_REDIRECT_URI,
    ),
  );
  if (state) url.searchParams.set("state", String(state));
  return url.toString();
}

function extractXboxDirectAuthResult(rawUrl, expectedState = "") {
  let url;
  try {
    url = new URL(String(rawUrl || ""));
  } catch {
    return null;
  }
  const expectedRedirect = new URL(XBOX_PC_REDIRECT_URI);
  if (
    url.origin !== expectedRedirect.origin ||
    url.pathname.toLowerCase() !== expectedRedirect.pathname.toLowerCase()
  ) {
    return null;
  }
  const fragment = new URLSearchParams(url.hash.replace(/^#/, ""));
  const getParameter = (name) =>
    fragment.get(name) || url.searchParams.get(name) || "";
  const state = getParameter("state");
  if (expectedState && state !== expectedState) {
    return { error: "xbox-pc-oauth-state-mismatch" };
  }
  const error = getParameter("error");
  if (error) {
    return {
      error:
        getParameter("error_description") ||
        error ||
        "xbox-pc-oauth-failed",
    };
  }
  const code = getParameter("code");
  return code ? { code } : null;
}

function xboxAuthExpiry(expiresIn) {
  return Date.now() + Math.max(0, Number(expiresIn) || 0) * 1000;
}

function getXboxPcAuthErrorInfo(error, stage = "") {
  const extra = error?.data?.attributes?.extra || {};
  const response = extra?.response || {};
  const body =
    response?.body && typeof response.body === "object"
      ? response.body
      : {};
  let service = "";
  try {
    const parsed = new URL(String(extra?.url || ""));
    service = `${parsed.hostname}${parsed.pathname}`;
  } catch {}
  return {
    stage: String(error?.xboxAuthStage || stage || "").trim(),
    statusCode: Number(extra?.statusCode) || Number(error?.status) || 0,
    xerr: Number(body?.XErr ?? body?.xerr) || 0,
    service,
    serviceMessage: firstNonEmpty(body?.Message, body?.message),
  };
}

function attachXboxAuthStage(error, stage) {
  if (error && typeof error === "object") error.xboxAuthStage = stage;
  return error;
}

async function exchangeLiveTokenForXboxSession(liveTokens, clientId) {
  const accessToken = String(liveTokens?.access_token || "").trim();
  const refreshToken = String(liveTokens?.refresh_token || "").trim();
  if (!accessToken || !refreshToken) {
    throw attachXboxAuthStage(
      new Error("xbox-pc-oauth-token-invalid"),
      "microsoft-token",
    );
  }
  let userToken = null;
  let userTokenError = null;
  for (const preamble of ["d", "t"]) {
    try {
      userToken = await xnet.exchangeRpsTicketForUserToken(
        accessToken,
        preamble,
      );
      if (preamble !== "d") {
        xboxPcLogger.info("xbox-pc:auth-rps-fallback-success", { preamble });
      }
      break;
    } catch (error) {
      userTokenError = attachXboxAuthStage(error, `user-token:${preamble}`);
      const info = getXboxPcAuthErrorInfo(userTokenError);
      xboxPcLogger.warn("xbox-pc:auth-rps-attempt-failed", info);
      if (
        info.statusCode &&
        info.statusCode !== 400 &&
        info.statusCode !== 401
      ) {
        break;
      }
    }
  }
  if (!userToken?.Token) {
    throw userTokenError || new Error("xbox-pc-user-token-invalid");
  }
  let xsts;
  try {
    xsts = await xnet.exchangeTokenForXSTSToken(userToken.Token, {
      XSTSRelyingParty: XBOX_PC_RELYING_PARTY,
      sandboxId: "RETAIL",
    });
  } catch (error) {
    throw attachXboxAuthStage(error, "xsts-token");
  }
  const claims = xsts?.DisplayClaims?.xui?.[0] || {};
  const session = normalizeStoredAuth({
    clientId,
    refreshToken,
    accessToken,
    accessExpiresAt: xboxAuthExpiry(liveTokens.expires_in),
    xstsToken: xsts?.Token,
    xstsExpiresAt: Date.parse(xsts?.NotAfter) || 0,
    xuid: claims.xid,
    uhs: claims.uhs,
    gamertag: claims.gtg,
  });
  if (!session?.xstsToken || !session.xuid || !session.uhs) {
    throw attachXboxAuthStage(
      new Error("xbox-pc-xsts-claims-invalid"),
      "xsts-claims",
    );
  }
  return session;
}

async function completeXboxDirectAuthentication(userDataDir, authResult) {
  const clientId = XBOX_PC_CLIENT_ID;
  const normalizedClientId = normalizeXboxClientId(clientId);
  if (!normalizedClientId) throw new Error("xbox-pc-client-id-invalid");
  let liveTokens = authResult?.tokens || null;
  if (!liveTokens && authResult?.code) {
    try {
      liveTokens = await live.exchangeCodeForAccessToken(
        String(authResult.code),
        normalizedClientId,
        XBOX_PC_OAUTH_SCOPE,
        XBOX_PC_REDIRECT_URI,
      );
    } catch (error) {
      throw attachXboxAuthStage(error, "microsoft-code-exchange");
    }
  }
  if (!liveTokens) {
    throw attachXboxAuthStage(
      new Error("xbox-pc-oauth-result-invalid"),
      "microsoft-callback",
    );
  }
  const auth = await exchangeLiveTokenForXboxSession(
    liveTokens,
    normalizedClientId,
  );
  await saveXboxDirectAuth(userDataDir, auth);
  return auth;
}

async function ensureXboxDirectSession(options = {}) {
  let auth = await loadXboxDirectAuth(options.userDataDir);
  if (!auth) throw new Error("xbox-pc-microsoft-login-required");
  if (
    options.allowStoredClientId !== true &&
    auth.clientId !== XBOX_PC_CLIENT_ID
  ) {
    throw new Error("xbox-pc-client-id-changed-reconnect-required");
  }
  const minimumValidityMs = Math.max(
    60_000,
    Number(options.minimumValidityMs) || 300_000,
  );
  if (
    auth.xstsToken &&
    auth.xuid &&
    auth.uhs &&
    auth.xstsExpiresAt > Date.now() + minimumValidityMs
  ) {
    return auth;
  }
  let refreshed;
  try {
    refreshed = await live.refreshAccessToken(
      auth.refreshToken,
      auth.clientId,
      XBOX_PC_OAUTH_SCOPE,
    );
  } catch (error) {
    throw attachXboxAuthStage(error, "microsoft-refresh");
  }
  if (!refreshed.refresh_token) refreshed.refresh_token = auth.refreshToken;
  auth = await exchangeLiveTokenForXboxSession(refreshed, auth.clientId);
  await saveXboxDirectAuth(options.userDataDir, auth);
  return auth;
}

function buildXboxAuthorizationHeader(auth = {}) {
  const uhs = String(auth.uhs || "").trim();
  const token = String(auth.xstsToken || "").trim();
  if (!uhs || !token) throw new Error("xbox-pc-xsts-required");
  return `XBL3.0 x=${uhs};${token}`;
}

async function xboxServiceGet(baseUrl, endpoint, options = {}) {
  const auth = options.auth || (await ensureXboxDirectSession(options));
  const url = `${baseUrl}/${String(endpoint || "").replace(/^\/+/, "")}`;
  const requestedContractVersion = String(
    options.contractVersion || "2",
  ).trim();
  const contractVersion = /^\d+$/.test(requestedContractVersion)
    ? requestedContractVersion
    : "2";
  const response = await axios.get(url, {
    timeout: Math.max(3000, Number(options.timeoutMs) || 15000),
    headers: {
      Authorization: buildXboxAuthorizationHeader(auth),
      "x-xbl-contract-version": contractVersion,
      Accept: "application/json",
      "Accept-Language": options.locale || "en-US,en",
    },
    validateStatus: (status) => status >= 200 && status < 500,
  });
  if (response.status >= 400) {
    const error = new Error(`xbox-network-http-${response.status}`);
    error.status = response.status;
    throw error;
  }
  return response.data || {};
}

async function xboxNetworkGet(endpoint, options = {}) {
  return xboxServiceGet(XBOX_ACHIEVEMENTS_URL, endpoint, options);
}

async function xboxServiceGetAll(baseUrl, endpoint, keys, options = {}) {
  const rows = [];
  const seenTokens = new Set();
  let continuationToken = "";
  for (let page = 0; page < 20; page += 1) {
    const url = new URL(endpoint, `${baseUrl}/`);
    if (continuationToken) {
      url.searchParams.set("continuationToken", continuationToken);
    }
    const payload = await xboxServiceGet(
      baseUrl,
      `${url.pathname.replace(/^\/+/, "")}${url.search}`,
      options,
    );
    rows.push(...extractArray(payload, keys));
    continuationToken = String(
      payload?.pagingInfo?.continuationToken || "",
    ).trim();
    if (!continuationToken || seenTokens.has(continuationToken)) break;
    seenTokens.add(continuationToken);
  }
  return rows;
}

async function xboxNetworkGetAll(endpoint, keys, options = {}) {
  return xboxServiceGetAll(
    XBOX_ACHIEVEMENTS_URL,
    endpoint,
    keys,
    options,
  );
}

async function getXboxPcStatus(options = {}) {
  const stored = await loadXboxDirectAuth(options.userDataDir);
  if (!stored) {
    return {
      connected: false,
      configured: false,
      provider: "Microsoft / Xbox Network",
    };
  }
  try {
    const auth = await ensureXboxDirectSession(options);
    return {
      connected: true,
      configured: true,
      provider: "Microsoft / Xbox Network",
      clientId: auth.clientId,
      xuid: auth.xuid,
      gamertag: auth.gamertag,
    };
  } catch (error) {
    return {
      connected: false,
      configured: true,
      provider: "Microsoft / Xbox Network",
      clientId: stored.clientId,
      error: error?.message || String(error),
    };
  }
}

function decodeXml(value) {
  return String(value || "")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function readXmlAttribute(xml, elementNames, attributeNames) {
  for (const elementName of elementNames) {
    const tag = new RegExp(`<${elementName}\\b([^>]*)>`, "i").exec(xml);
    if (!tag) continue;
    for (const attributeName of attributeNames) {
      const match = new RegExp(
        `\\b${attributeName}\\s*=\\s*["']([^"']*)["']`,
        "i",
      ).exec(tag[1]);
      if (match) return decodeXml(match[1]).trim();
    }
  }
  return "";
}

function readXmlText(xml, elementNames) {
  for (const elementName of elementNames) {
    const match = new RegExp(
      `<${elementName}\\b[^>]*>([^<]+)</${elementName}>`,
      "i",
    ).exec(xml);
    if (match) return decodeXml(match[1]).trim();
  }
  return "";
}

function parseMicrosoftGameConfig(configPath) {
  const xml = fs.readFileSync(configPath, "utf8");
  const installDir = path.dirname(configPath);
  const executableName = readXmlAttribute(
    xml,
    ["Executable", "GameExecutable"],
    ["Name", "Path", "Executable"],
  );
  const executable = executableName
    ? path.resolve(installDir, executableName)
    : "";
  const packageFamilyName = readXmlAttribute(
    xml,
    ["Identity"],
    ["PackageFamilyName"],
  );
  const applicationId = readXmlAttribute(
    xml,
    ["Application", "Executable"],
    ["Id", "ApplicationId"],
  );
  const titleId = normalizeMicrosoftGameTitleId(
    firstNonEmpty(
      readXmlAttribute(
        xml,
        ["XboxLive", "XboxServices", "Game"],
        ["TitleId", "TitleID", "XboxTitleId"],
      ),
      readXmlText(xml, ["TitleId", "TitleID", "XboxTitleId"]),
    ),
  );
  return {
    configPath,
    installLocation: installDir,
    title: firstNonEmpty(
      readXmlAttribute(
        xml,
        ["ShellVisuals", "Game", "Application"],
        ["DefaultDisplayName", "DisplayName", "Name"],
      ),
      path.basename(path.dirname(configPath)),
    ),
    titleId,
    scid: firstNonEmpty(
      readXmlAttribute(
        xml,
        ["XboxLive", "XboxServices"],
        ["PrimaryServiceConfigId", "ServiceConfigId", "SCID"],
      ),
      readXmlText(xml, [
        "PrimaryServiceConfigId",
        "ServiceConfigId",
        "SCID",
      ]),
    ),
    storeId: firstNonEmpty(
      readXmlAttribute(
        xml,
        ["Store", "Game", "Identity"],
        ["StoreId", "StoreID", "ProductId"],
      ),
      readXmlText(xml, ["StoreId", "StoreID", "ProductId"]),
    ),
    packageFamilyName,
    applicationId,
    aumid:
      packageFamilyName && applicationId
        ? `${packageFamilyName}!${applicationId}`
        : "",
    executable: executable && fs.existsSync(executable) ? executable : "",
    processName: executableName ? path.basename(executableName) : "",
  };
}

function findMicrosoftGameConfigs(root, maxDepth = 3) {
  const found = [];
  const walk = (current, depth) => {
    if (depth > maxDepth) return;
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isFile() && entry.name.toLowerCase() === "microsoftgame.config") {
        found.push(fullPath);
      } else if (
        entry.isDirectory() &&
        !["content", "mods"].includes(entry.name.toLowerCase())
      ) {
        walk(fullPath, depth + 1);
      } else if (entry.isDirectory() && entry.name.toLowerCase() === "content") {
        walk(fullPath, depth + 1);
      }
    }
  };
  walk(root, 0);
  return found;
}

function parseGamingRootMarker(markerPath) {
  try {
    const bytes = fs.readFileSync(markerPath);
    if (
      bytes.length <= 8 ||
      bytes.subarray(0, 4).toString("ascii") !== "RGBX"
    ) {
      return "";
    }
    const relativePath = bytes
      .subarray(8)
      .toString("utf16le")
      .replace(/\0+$/g, "")
      .trim();
    if (!relativePath) return "";
    const driveRoot = path.parse(path.resolve(markerPath)).root;
    const resolved = path.resolve(driveRoot, relativePath);
    if (
      !driveRoot ||
      path.parse(resolved).root.toLowerCase() !== driveRoot.toLowerCase()
    ) {
      return "";
    }
    return resolved;
  } catch {
    return "";
  }
}

function listXboxGamesRoots() {
  const roots = [];
  const seen = new Set();
  const addRoot = (candidate) => {
    const resolved = String(candidate || "").trim();
    if (!resolved || !fs.existsSync(resolved)) return;
    const key = path.resolve(resolved).toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    roots.push(resolved);
  };
  for (let code = 65; code <= 90; code += 1) {
    const drive = `${String.fromCharCode(code)}:\\`;
    try {
      addRoot(path.join(drive, "XboxGames"));
      addRoot(parseGamingRootMarker(path.join(drive, ".GamingRoot")));
    } catch {}
  }
  return roots;
}

function execFileJson(file, args, options = {}) {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        windowsHide: true,
        timeout: Number(options.timeoutMs) || 30000,
        maxBuffer: 16 * 1024 * 1024,
      },
      (error, stdout) => {
        if (error || !String(stdout || "").trim()) return resolve([]);
        try {
          const parsed = JSON.parse(stdout);
          resolve(Array.isArray(parsed) ? parsed : parsed ? [parsed] : []);
        } catch {
          resolve([]);
        }
      },
    );
  });
}

async function listPackagedGameConfigPaths() {
  if (process.platform !== "win32") return [];
  const command =
    "Get-AppxPackage | Where-Object { $_.InstallLocation } | " +
    "ForEach-Object { $p = Join-Path $_.InstallLocation 'MicrosoftGame.config'; " +
    "if (Test-Path -LiteralPath $p) { [pscustomobject]@{ Path=$p; PackageFamilyName=$_.PackageFamilyName } } } | " +
    "ConvertTo-Json -Compress";
  return execFileJson(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", command],
    { timeoutMs: 30000 },
  );
}

async function discoverXboxPcInstallations() {
  const candidates = new Map();
  for (const root of listXboxGamesRoots()) {
    for (const configPath of findMicrosoftGameConfigs(root, 4)) {
      candidates.set(configPath.toLowerCase(), {
        path: configPath,
        packageFamilyName: "",
      });
    }
  }
  for (const entry of await listPackagedGameConfigPaths()) {
    const configPath = String(entry?.Path || "").trim();
    if (configPath) {
      candidates.set(configPath.toLowerCase(), {
        path: configPath,
        packageFamilyName: String(entry?.PackageFamilyName || "").trim(),
      });
    }
  }

  const installationsByTitleId = new Map();
  const installationsWithoutTitleId = [];
  for (const candidate of candidates.values()) {
    try {
      const parsed = parseMicrosoftGameConfig(candidate.path);
      if (!parsed.packageFamilyName && candidate.packageFamilyName) {
        parsed.packageFamilyName = candidate.packageFamilyName;
        if (parsed.applicationId) {
          parsed.aumid = `${candidate.packageFamilyName}!${parsed.applicationId}`;
        }
      }
      if (!parsed.titleId) {
        installationsWithoutTitleId.push(parsed);
        continue;
      }
      const existing = installationsByTitleId.get(parsed.titleId);
      if (!existing) {
        installationsByTitleId.set(parsed.titleId, parsed);
        continue;
      }
      const existingIsWindowsApps = /[\\/]WindowsApps[\\/]/i.test(
        existing.installLocation,
      );
      const parsedIsWindowsApps = /[\\/]WindowsApps[\\/]/i.test(
        parsed.installLocation,
      );
      const primary =
        existingIsWindowsApps && !parsedIsWindowsApps ? parsed : existing;
      const secondary = primary === existing ? parsed : existing;
      installationsByTitleId.set(parsed.titleId, {
        ...secondary,
        ...primary,
        scid: primary.scid || secondary.scid || "",
        storeId: primary.storeId || secondary.storeId || "",
        packageFamilyName:
          primary.packageFamilyName || secondary.packageFamilyName || "",
        applicationId:
          primary.applicationId || secondary.applicationId || "",
        aumid: primary.aumid || secondary.aumid || "",
        executable: primary.executable || secondary.executable || "",
        processName: primary.processName || secondary.processName || "",
      });
    } catch (error) {
      xboxPcLogger.warn("xbox-pc:local-config-parse-failed", {
        configPath: candidate.path,
        error: error?.message || String(error),
      });
    }
  }
  return [
    ...installationsByTitleId.values(),
    ...installationsWithoutTitleId,
  ];
}

function extractArray(payload, keys) {
  for (const key of keys) {
    if (Array.isArray(payload?.[key])) return payload[key];
  }
  if (Array.isArray(payload)) return payload;
  return [];
}

function normalizeDeviceNames(title = {}) {
  const devices = [
    ...(Array.isArray(title?.devices) ? title.devices : []),
    ...(Array.isArray(title?.deviceTypes) ? title.deviceTypes : []),
    title?.deviceType,
    title?.platform,
  ];
  return devices
    .map((entry) =>
      String(
        typeof entry === "object"
          ? entry?.name || entry?.type || entry?.deviceType
          : entry || "",
      )
        .trim()
        .toLowerCase(),
    )
    .filter(Boolean);
}

function isWindowsPcTitle(title, installedTitleIds = new Set()) {
  const titleId = normalizeTitleId(title?.titleId ?? title?.id);
  const devices = normalizeDeviceNames(title);
  if (titleId && installedTitleIds.has(titleId)) return true;
  if (devices.some((device) => device === "win32")) return false;
  return devices.some((device) =>
    /(?:^|[^a-z])(pc|windows|windowsonecore)(?:$|[^a-z])/.test(device),
  );
}

async function fetchXboxTitleHistory(options = {}) {
  const auth = options.auth || (await ensureXboxDirectSession(options));
  try {
    return await xboxServiceGetAll(
      XBOX_TITLEHUB_URL,
      `users/xuid(${auth.xuid})/titles/titleHistory/decoration/` +
        "GamePass,TitleHistory,Achievement,Stats,Image?maxItems=1000",
      ["titles", "titleHistory", "items"],
      { ...options, auth },
    );
  } catch (error) {
    xboxPcLogger.warn("xbox-pc:titlehub-history-fallback", {
      error: error?.message || String(error),
      status: error?.status || error?.response?.status || null,
    });
    return xboxNetworkGetAll(
      `users/xuid(${auth.xuid})/history/titles?maxItems=1000`,
      ["titles", "titleHistory", "items"],
      { ...options, auth },
    );
  }
}

async function fetchXboxTitleAchievements(xuid, titleId, options = {}) {
  const safeXuid = normalizeXuid(xuid);
  const safeTitleId = normalizeTitleId(titleId);
  if (!safeXuid) throw new Error("xbox-xuid-required");
  if (!safeTitleId) throw new Error("xbox-title-id-required");
  const auth = options.auth || (await ensureXboxDirectSession(options));
  if (auth.xuid !== safeXuid) throw new Error("xbox-pc-xuid-mismatch");
  const unlockedFilter = options.unlockedOnly ? "&unlockedOnly=true" : "";
  return xboxNetworkGetAll(
    `users/xuid(${safeXuid})/achievements?titleId=${encodeURIComponent(
      safeTitleId,
    )}&maxItems=1000${unlockedFilter}`,
    ["achievements", "items"],
    {
      ...options,
      auth,
      contractVersion: XBOX_ACHIEVEMENTS_CONTRACT_VERSION,
    },
  );
}

async function fetchXboxLocalizedTitleAchievements(
  xuid,
  titleId,
  schemaLanguages,
  options = {},
) {
  const languages = normalizeXboxSchemaLanguages(schemaLanguages);
  const auth = options.auth || (await ensureXboxDirectSession(options));
  const localizedAchievements = new Map();
  for (const language of languages) {
    const achievements = await fetchXboxTitleAchievements(xuid, titleId, {
      ...options,
      auth,
      locale: XBOX_SCHEMA_LANGUAGE_LOCALES[language],
      unlockedOnly: false,
    });
    localizedAchievements.set(language, achievements);
  }
  return {
    languages,
    localizedAchievements,
    achievements: localizedAchievements.get(languages[0]) || [],
  };
}

function parseUnlockTime(value) {
  if (!value) return 0;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function parseAchievementProgress(achievement = {}) {
  const requirements = Array.isArray(achievement?.progression?.requirements)
    ? achievement.progression.requirements
    : [];
  const requirement = requirements[0] || {};
  const current = Number(requirement.current);
  const target = Number(requirement.target);
  return {
    progress: Number.isFinite(current) ? current : undefined,
    maxProgress: Number.isFinite(target) ? target : undefined,
  };
}

function parseAchievementMedia(achievement = {}, preferredType = "") {
  const media = Array.isArray(achievement?.mediaAssets)
    ? achievement.mediaAssets
    : [];
  const preferred = media.find(
    (entry) =>
      String(entry?.type || "").toLowerCase() === preferredType.toLowerCase(),
  );
  return firstNonEmpty(
    preferred?.url,
    media[0]?.url,
    achievement?.icon,
    achievement?.imageUrl,
  );
}

function normalizeXboxAchievement(achievement = {}) {
  const id = firstNonEmpty(
    achievement?.id,
    achievement?.achievementId,
    achievement?.name,
  );
  if (!id) return null;
  const state = String(
    achievement?.progressState || achievement?.state || "",
  ).toLowerCase();
  const earned =
    state === "achieved" ||
    state === "unlocked" ||
    achievement?.earned === true ||
    achievement?.unlocked === true;
  const progress = parseAchievementProgress(achievement);
  const reward = (Array.isArray(achievement?.rewards)
    ? achievement.rewards
    : []
  ).find((entry) => /gamerscore/i.test(String(entry?.type || "")));
  const rarity = Number(
    achievement?.rarity?.currentPercentage ??
      achievement?.rarity?.percentage ??
      achievement?.rarityPercentage,
  );
  return {
    id,
    displayName: firstNonEmpty(
      achievement?.name,
      achievement?.displayName,
      id,
    ),
    description: firstNonEmpty(
      achievement?.description,
      achievement?.lockedDescription,
    ),
    hidden:
      achievement?.isSecret === true ||
      String(achievement?.visibility || "").toLowerCase() === "secret",
    icon: parseAchievementMedia(achievement, "Icon"),
    gamerscore: Number(reward?.value) || 0,
    rarity: Number.isFinite(rarity) ? Math.min(100, Math.max(0, rarity)) : null,
    snapshot: {
      earned,
      earned_time: earned
        ? parseUnlockTime(
            achievement?.progression?.timeUnlocked ||
              achievement?.timeUnlocked ||
              achievement?.unlockTime,
          )
        : 0,
      ...(progress.progress !== undefined
        ? { progress: progress.progress }
        : {}),
      ...(progress.maxProgress !== undefined
        ? { max_progress: progress.maxProgress }
        : {}),
    },
  };
}

function getXboxPcSnapshotDelta(
  previousSnapshot = {},
  nextSnapshot = {},
) {
  const unlockedKeys = [];
  const progressKeys = [];
  let changed = false;
  const previousEntries =
    previousSnapshot && typeof previousSnapshot === "object"
      ? previousSnapshot
      : {};
  const nextEntries =
    nextSnapshot && typeof nextSnapshot === "object" ? nextSnapshot : {};
  const allKeys = new Set([
    ...Object.keys(previousEntries),
    ...Object.keys(nextEntries),
  ]);

  for (const key of allKeys) {
    const hasPreviousEntry = Object.prototype.hasOwnProperty.call(
      previousEntries,
      key,
    );
    const previous = previousEntries[key] || {};
    const next = nextEntries[key] || {};
    const previousEarned = Boolean(previous?.earned);
    const nextEarned = Boolean(next?.earned);
    const previousEarnedTime = Number(previous?.earned_time || 0);
    const nextEarnedTime = Number(next?.earned_time || 0);
    const previousProgress = Number(previous?.progress);
    const nextProgress = Number(next?.progress);
    const previousMax = Number(previous?.max_progress);
    const nextMax = Number(next?.max_progress);
    const progressChanged =
      Number.isFinite(previousProgress) !== Number.isFinite(nextProgress) ||
      (Number.isFinite(previousProgress) &&
        Number.isFinite(nextProgress) &&
        previousProgress !== nextProgress);
    const maxProgressChanged =
      Number.isFinite(previousMax) !== Number.isFinite(nextMax) ||
      (Number.isFinite(previousMax) &&
        Number.isFinite(nextMax) &&
        previousMax !== nextMax);

    if (
      previousEarned !== nextEarned ||
      previousEarnedTime !== nextEarnedTime ||
      progressChanged ||
      maxProgressChanged
    ) {
      changed = true;
    }
    if (nextEarned && !previousEarned) {
      unlockedKeys.push(key);
    }

    const progressBaseline = Number.isFinite(previousProgress)
      ? previousProgress
      : 0;
    if (
      hasPreviousEntry &&
      !nextEarned &&
      Number.isFinite(nextProgress) &&
      Number.isFinite(nextMax) &&
      nextMax > 0 &&
      nextProgress > progressBaseline
    ) {
      progressKeys.push(key);
    }
  }

  return { changed, unlockedKeys, progressKeys };
}

function buildXboxAchievementRarityMap(achievements = []) {
  const rarityById = new Map();
  for (const raw of Array.isArray(achievements) ? achievements : []) {
    const achievement = normalizeXboxAchievement(raw);
    if (!achievement || achievement.rarity === null) continue;
    rarityById.set(achievement.id, achievement.rarity);
  }
  return rarityById;
}

function buildXboxAchievementLocalizationIndex(
  localizedAchievements = new Map(),
  schemaLanguages = [],
) {
  const languages = normalizeXboxSchemaLanguages(schemaLanguages);
  const index = new Map();
  for (const language of languages) {
    const rows =
      localizedAchievements instanceof Map
        ? localizedAchievements.get(language)
        : localizedAchievements?.[language];
    for (const raw of Array.isArray(rows) ? rows : []) {
      const achievement = normalizeXboxAchievement(raw);
      if (!achievement) continue;
      if (!index.has(achievement.id)) {
        index.set(achievement.id, {
          displayName: {},
          description: {},
        });
      }
      const localized = index.get(achievement.id);
      localized.displayName[language] = achievement.displayName;
      localized.description[language] = achievement.description;
    }
  }
  return index;
}

async function fetchXboxAchievementRarityPercentages(
  xuid,
  titleId,
  options = {},
) {
  const achievements = await fetchXboxTitleAchievements(xuid, titleId, {
    ...options,
    unlockedOnly: false,
  });
  return buildXboxAchievementRarityMap(achievements);
}

async function downloadImage(url, outputPath, timeoutMs, options = {}) {
  if (!/^https?:\/\//i.test(String(url || ""))) return "";
  try {
    if (
      options.overwrite !== true &&
      fs.existsSync(outputPath) &&
      fs.statSync(outputPath).size > 0
    ) {
      return outputPath;
    }
  } catch {}
  const response = await axios.get(url, {
    timeout: Math.max(3000, Number(timeoutMs) || 15000),
    responseType: "arraybuffer",
    validateStatus: (status) => status >= 200 && status < 500,
  });
  if (response.status >= 400 || !response.data) return "";
  await fsp.mkdir(path.dirname(outputPath), { recursive: true });
  await fsp.writeFile(outputPath, Buffer.from(response.data));
  return outputPath;
}

function findXboxTitleImage(title = {}, preferredTypes = []) {
  const images = Array.isArray(title?.images) ? title.images : [];
  for (const preferredType of preferredTypes) {
    const match = images.find(
      (image) =>
        String(image?.type || "").toLowerCase() ===
          String(preferredType || "").toLowerCase() &&
        /^https?:\/\//i.test(String(image?.url || "")),
    );
    if (match) return String(match.url).trim();
  }
  return "";
}

function resolveXboxTitleArtwork(title = {}) {
  const displayImage = firstNonEmpty(
    title?.displayImage,
    title?.image,
    title?.titleImage,
    title?.titleImageUrl,
  );
  const coverUrl =
    findXboxTitleImage(title, [
      "Poster",
      "BoxArt",
      "BrandedKeyArt",
      "FeaturePromotionalSquareArt",
    ]) || displayImage;
  const headerUrl =
    findXboxTitleImage(title, [
      "TitledHeroArt",
      "SuperHeroArt",
      "BrandedKeyArt",
      "Hero",
    ]) ||
    displayImage ||
    coverUrl;
  return { coverUrl, headerUrl };
}

function readXboxCoverSources(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return {};
  }
}

async function writeXboxPcSchema(schemaDir, titleId, achievements, options = {}) {
  const imgDir = path.join(schemaDir, "img");
  await fsp.mkdir(imgDir, { recursive: true });
  const schemaLanguages = normalizeXboxSchemaLanguages(
    options.schemaLanguages,
  );
  const localizationIndex = buildXboxAchievementLocalizationIndex(
    options.localizedAchievements,
    schemaLanguages,
  );
  const schema = [];
  const rarity = [];
  const snapshot = {};
  for (const raw of achievements) {
    const achievement = normalizeXboxAchievement(raw);
    if (!achievement) continue;
    const iconName = `${sanitizeSegment(achievement.id, "achievement")}.png`;
    let icon = "";
    try {
      const saved = await downloadImage(
        achievement.icon,
        path.join(imgDir, iconName),
        options.timeoutMs,
      );
      if (saved) icon = `img/${iconName}`;
    } catch {}
    const localized = localizationIndex.get(achievement.id);
    const displayName = {};
    const description = {};
    for (const language of schemaLanguages) {
      displayName[language] =
        localized?.displayName?.[language] || achievement.displayName;
      description[language] =
        localized?.description?.[language] || achievement.description;
    }
    schema.push({
      hidden: achievement.hidden ? 1 : 0,
      displayName,
      description,
      icon,
      icon_gray: icon,
      name: achievement.id,
      ...(achievement.gamerscore
        ? { points: achievement.gamerscore }
        : {}),
    });
    snapshot[achievement.id] = achievement.snapshot;
    if (achievement.rarity !== null) {
      rarity.push({
        name: achievement.id,
        percent: Number(achievement.rarity.toFixed(4)),
      });
    }
  }
  if (!schema.length) throw new Error("xbox-pc-achievements-empty");
  await fsp.writeFile(
    path.join(schemaDir, "achievements.json"),
    JSON.stringify(schema, null, 2),
    "utf8",
  );
  writeAchievementPercentagesSidecar(schemaDir, titleId, rarity, {
    source: RARITY_SOURCES.xboxNetwork,
  });
  return { schema, snapshot };
}

function indexExistingXboxConfigs(configsDir) {
  const byTitleId = new Map();
  let files = [];
  try {
    files = fs
      .readdirSync(configsDir)
      .filter((entry) => entry.toLowerCase().endsWith(".json"));
  } catch {
    return byTitleId;
  }
  for (const file of files) {
    try {
      const filePath = path.join(configsDir, file);
      const config = JSON.parse(fs.readFileSync(filePath, "utf8"));
      if (String(config?.platform || "").toLowerCase() !== XBOX_PC_PLATFORM) {
        continue;
      }
      const titleId = normalizeTitleId(config?.xbox_title_id || config?.appid);
      if (titleId) byTitleId.set(titleId, { filePath, config });
    } catch {}
  }
  return byTitleId;
}

function reserveConfigPath(configsDir, title, existingPath = "") {
  if (existingPath) return existingPath;
  const base = sanitizeConfigName(`${title} (Xbox PC)`);
  let candidate = path.join(configsDir, `${base}.json`);
  let suffix = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(configsDir, `${base} ${suffix}.json`);
    suffix += 1;
  }
  return candidate;
}

function isXboxPcTitleBlacklisted(titleId, options = {}) {
  const normalizedTitleId = normalizeTitleId(titleId);
  const checker = options?.isTitleBlacklisted;
  if (!normalizedTitleId || typeof checker !== "function") return false;
  try {
    return checker(normalizedTitleId, XBOX_PC_PLATFORM) === true;
  } catch {
    return false;
  }
}

async function importXboxPcLibrary(configsDir, options = {}) {
  const userDataDir = String(options.userDataDir || "").trim();
  const schemaRoot = path.join(
    options.schemaRootDir || path.join(configsDir, "schema"),
    XBOX_PC_PLATFORM,
  );
  const stateRoot = path.join(
    options.stateRootDir || path.join(userDataDir, "xbox-pc"),
    "titles",
  );
  const auth = await ensureXboxDirectSession({ ...options, userDataDir });
  const account = {
    xuid: auth.xuid,
    gamertag: auth.gamertag,
  };

  const installations = await discoverXboxPcInstallations();
  const installedByTitleId = new Map(
    installations
      .filter((entry) => entry.titleId)
      .map((entry) => [entry.titleId, entry]),
  );
  const history = await fetchXboxTitleHistory({ ...options, auth });
  const pcTitleMap = new Map();
  for (const title of history) {
    if (!isWindowsPcTitle(title, new Set(installedByTitleId.keys()))) continue;
    const titleId = normalizeTitleId(title?.titleId ?? title?.id);
    if (titleId) pcTitleMap.set(titleId, title);
  }
  for (const installation of installations) {
    if (!installation.titleId || pcTitleMap.has(installation.titleId)) continue;
    pcTitleMap.set(installation.titleId, {
      titleId: installation.titleId,
      name: installation.title,
      devices: ["PC"],
      productId: installation.storeId,
      discoveredLocally: true,
    });
  }
  const pcTitles = [...pcTitleMap.values()];
  const existing = indexExistingXboxConfigs(configsDir);
  const result = {
    provider: "Microsoft / Xbox Network",
    account,
    installedDetected: installations.length,
    historyTotal: history.length,
    pcTitles: pcTitles.length,
    created: 0,
    updated: 0,
    skipped: 0,
    blacklistedSkipped: 0,
    failed: 0,
    imported: [],
  };
  await fsp.mkdir(configsDir, { recursive: true });

  let index = 0;
  for (const title of pcTitles) {
    index += 1;
    const titleId = normalizeTitleId(title?.titleId ?? title?.id);
    const titleName = firstNonEmpty(
      title?.name,
      title?.titleName,
      title?.displayName,
      `Xbox ${titleId}`,
    );
    options.onProgress?.({
      current: index,
      total: pcTitles.length,
      percent: Math.round((index / Math.max(1, pcTitles.length)) * 100),
      detail: titleName,
      appid: titleId,
    });
    if (!titleId) {
      result.skipped += 1;
      continue;
    }
    if (isXboxPcTitleBlacklisted(titleId, options)) {
      result.skipped += 1;
      result.blacklistedSkipped += 1;
      xboxPcLogger.info("xbox-pc:import-title-skipped-blacklisted", {
        titleId,
        title: titleName,
      });
      continue;
    }
    try {
      const localized = await fetchXboxLocalizedTitleAchievements(
        account.xuid,
        titleId,
        options.schemaLanguages,
        { ...options, auth },
      );
      const achievementRows = localized.achievements;
      if (!achievementRows.length) {
        result.skipped += 1;
        continue;
      }
      const schemaDir = path.join(schemaRoot, sanitizeSegment(titleId));
      const stateDir = path.join(stateRoot, sanitizeSegment(titleId));
      const { schema, snapshot } = await writeXboxPcSchema(
        schemaDir,
        titleId,
        achievementRows,
        {
          ...options,
          schemaLanguages: localized.languages,
          localizedAchievements: localized.localizedAchievements,
        },
      );
      const artwork = resolveXboxTitleArtwork(title);
      if ((artwork.coverUrl || artwork.headerUrl) && userDataDir) {
        const coverDir = path.join(
          userDataDir,
          "images",
          XBOX_PC_PLATFORM,
          titleId,
        );
        const coverPath = path.join(coverDir, `${titleId}.jpg`);
        const headerPath = path.join(coverDir, "header.jpg");
        const sourcesPath = path.join(coverDir, "sources.json");
        const previousSources = readXboxCoverSources(sourcesPath);
        const savedSources = {};
        try {
          if (artwork.coverUrl) {
            const savedCover = await downloadImage(
              artwork.coverUrl,
              coverPath,
              options.timeoutMs,
              { overwrite: previousSources.coverUrl !== artwork.coverUrl },
            );
            if (savedCover) savedSources.coverUrl = artwork.coverUrl;
          }
          if (
            artwork.headerUrl &&
            artwork.headerUrl === artwork.coverUrl &&
            savedSources.coverUrl
          ) {
            await fsp.copyFile(coverPath, headerPath);
            savedSources.headerUrl = artwork.headerUrl;
          } else if (artwork.headerUrl) {
            const savedHeader = await downloadImage(
              artwork.headerUrl,
              headerPath,
              options.timeoutMs,
              { overwrite: previousSources.headerUrl !== artwork.headerUrl },
            );
            if (savedHeader) savedSources.headerUrl = artwork.headerUrl;
          }
          if (savedSources.coverUrl || savedSources.headerUrl) {
            await fsp.mkdir(coverDir, { recursive: true });
            await fsp.writeFile(
              sourcesPath,
              JSON.stringify(savedSources, null, 2),
              "utf8",
            );
          }
        } catch {}
      }
      await fsp.mkdir(stateDir, { recursive: true });
      await fsp.writeFile(
        path.join(stateDir, "achievements.json"),
        JSON.stringify(snapshot, null, 2),
        "utf8",
      );
      const previousEntry = existing.get(titleId);
      const previous = previousEntry?.config || {};
      const local = installedByTitleId.get(titleId) || {};
      const displayName = `${titleName} (Xbox PC)`;
      const filePath = reserveConfigPath(
        configsDir,
        titleName,
        previousEntry?.filePath,
      );
      const executable =
        local.executable ||
        (local.aumid ? `shell:AppsFolder\\${local.aumid}` : "");
      const config = {
        ...previous,
        name: previous.name || path.basename(filePath, ".json"),
        displayName: previous.displayName || displayName,
        appid: titleId,
        platform: XBOX_PC_PLATFORM,
        xbox_title_id: titleId,
        xbox_xuid: account.xuid,
        xbox_gamertag: account.gamertag,
        xbox_scid: local.scid || previous.xbox_scid || "",
        xbox_store_id:
          local.storeId ||
          firstNonEmpty(title?.productId, title?.storeId) ||
          previous.xbox_store_id ||
          "",
        xbox_aumid: local.aumid || previous.xbox_aumid || "",
        xbox_package_family_name:
          local.packageFamilyName ||
          previous.xbox_package_family_name ||
          "",
        xbox_devices: normalizeDeviceNames(title),
        config_path: schemaDir,
        save_path: stateDir,
        executable: executable || previous.executable || "",
        arguments: previous.arguments || "",
        process_name: local.processName || previous.process_name || "",
      };
      await fsp.writeFile(filePath, JSON.stringify(config, null, 2), "utf8");
      if (previousEntry) result.updated += 1;
      else result.created += 1;
      result.imported.push({
        name: config.name,
        title: titleName,
        appid: titleId,
        snapshot,
        achievementsCount: schema.length,
        installed: Boolean(local.installLocation),
      });
    } catch (error) {
      result.failed += 1;
      xboxPcLogger.warn("xbox-pc:import-title-failed", {
        titleId,
        title: titleName,
        error: error?.message || String(error),
      });
    }
  }
  xboxPcLogger.info("xbox-pc:import-library-complete", {
    xuid: account.xuid,
    historyTotal: result.historyTotal,
    pcTitles: result.pcTitles,
    created: result.created,
    updated: result.updated,
    skipped: result.skipped,
    blacklistedSkipped: result.blacklistedSkipped,
    failed: result.failed,
  });
  return result;
}

async function syncXboxPcAchievements(config = {}, options = {}) {
  const xuid = normalizeXuid(options.xuid || config.xbox_xuid);
  const titleId = normalizeTitleId(
    options.titleId || config.xbox_title_id || config.appid,
  );
  const achievements = await fetchXboxTitleAchievements(xuid, titleId, {
    ...options,
    // Keep locked achievements in the polling snapshot as well. An
    // unlocked-only snapshot is empty for a 0% game, which makes its first
    // unlock indistinguishable from an initial cache seed.
    unlockedOnly: false,
  });
  const snapshot = {};
  for (const raw of achievements) {
    const achievement = normalizeXboxAchievement(raw);
    if (achievement) snapshot[achievement.id] = achievement.snapshot;
  }
  return { xuid, titleId, snapshot, total: achievements.length };
}

module.exports = {
  XBOX_PC_CLIENT_ID,
  XBOX_PC_PLATFORM,
  XBOX_PC_REDIRECT_URI,
  buildXboxAuthorizationHeader,
  buildXboxAchievementRarityMap,
  buildXboxAchievementLocalizationIndex,
  buildXboxDirectAuthorizeUrl,
  clearXboxDirectAuth,
  completeXboxDirectAuthentication,
  discoverXboxPcInstallations,
  ensureXboxDirectSession,
  extractXboxDirectAuthResult,
  fetchXboxTitleAchievements,
  fetchXboxAchievementRarityPercentages,
  fetchXboxLocalizedTitleAchievements,
  fetchXboxTitleHistory,
  getXboxPcSnapshotDelta,
  getXboxPcAuthErrorInfo,
  getXboxPcStatus,
  importXboxPcLibrary,
  isXboxPcTitleBlacklisted,
  isWindowsPcTitle,
  loadXboxDirectAuth,
  normalizeXboxClientId,
  normalizeTitleId,
  normalizeMicrosoftGameTitleId,
  normalizeXboxAchievement,
  normalizeXboxSchemaLanguages,
  parseMicrosoftGameConfig,
  parseGamingRootMarker,
  resolveXboxTitleArtwork,
  saveXboxDirectAuth,
  syncXboxPcAchievements,
};
