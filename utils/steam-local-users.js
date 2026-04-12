const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { createLogger } = require("./logger");

const steamLocalUsersLogger = createLogger("steam-local-users");
const STEAM_ID64_BASE = 76561197960265728n;

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function pushUnique(out, seen, candidate) {
  const raw = String(candidate || "").trim();
  if (!raw) return;
  const normalized = path.normalize(raw);
  const key =
    process.platform === "win32" ? normalized.toLowerCase() : normalized;
  if (seen.has(key)) return;
  seen.add(key);
  out.push(normalized);
}

function readRegistryValue(key, valueName) {
  if (process.platform !== "win32") return "";
  try {
    const output = execFileSync("reg.exe", ["query", key, "/v", valueName], {
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const lines = String(output || "").split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.toLowerCase().startsWith(valueName.toLowerCase())) continue;
      const match = trimmed.match(/REG_\w+\s+(.+)$/i);
      if (match) return String(match[1] || "").trim();
    }
  } catch {}
  return "";
}

function deriveSteamRootFromHint(hintPath) {
  const normalized = path.normalize(String(hintPath || "").trim());
  if (!normalized) return "";
  const parts = normalized.split(path.sep).filter(Boolean);
  const lower = parts.map((part) => part.toLowerCase());
  const appcacheIndex = lower.lastIndexOf("appcache");
  if (appcacheIndex > 0 && lower[appcacheIndex + 1] === "stats") {
    return path.dirname(path.dirname(normalized));
  }
  const configIndex = lower.lastIndexOf("config");
  if (configIndex > 0 && lower[configIndex + 1] === "loginusers.vdf") {
    return path.dirname(path.dirname(normalized));
  }
  if (
    lower[lower.length - 1] === "steam" &&
    fs.existsSync(path.join(normalized, "config", "loginusers.vdf"))
  ) {
    return normalized;
  }
  return "";
}

function getSteamRootCandidates(hintPaths = []) {
  const out = [];
  const seen = new Set();

  for (const hintPath of Array.isArray(hintPaths) ? hintPaths : []) {
    pushUnique(out, seen, deriveSteamRootFromHint(hintPath));
  }

  pushUnique(
    out,
    seen,
    readRegistryValue("HKCU\\Software\\Valve\\Steam", "SteamPath"),
  );
  pushUnique(
    out,
    seen,
    readRegistryValue("HKCU\\Software\\Valve\\Steam", "InstallPath"),
  );
  pushUnique(
    out,
    seen,
    readRegistryValue(
      "HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam",
      "InstallPath",
    ),
  );
  pushUnique(
    out,
    seen,
    readRegistryValue("HKLM\\SOFTWARE\\Valve\\Steam", "InstallPath"),
  );

  const envCandidates = [
    process.env["ProgramFiles(x86)"]
      ? path.join(process.env["ProgramFiles(x86)"], "Steam")
      : "",
    process.env.ProgramFiles
      ? path.join(process.env.ProgramFiles, "Steam")
      : "",
    "C:\\Program Files (x86)\\Steam",
    "C:\\Program Files\\Steam",
    "D:\\Steam",
    "E:\\Steam",
    "F:\\Steam",
    "G:\\Steam",
  ];
  for (const candidate of envCandidates) {
    pushUnique(out, seen, candidate);
  }
  return out;
}

function resolveSteamRoot(hintPaths = []) {
  const candidates = getSteamRootCandidates(hintPaths);
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (fs.existsSync(path.join(candidate, "config", "loginusers.vdf"))) {
      return candidate;
    }
    if (fs.existsSync(path.join(candidate, "appcache", "stats"))) {
      return candidate;
    }
  }
  console.warn("steam-local-users:resolveSteamRoot-not-found", {
    hintPaths,
    candidates,
  });
  return "";
}

function steamId64ToAccountId(steamId64) {
  const raw = String(steamId64 || "").trim();
  if (!/^\d{17,20}$/.test(raw)) return "";
  try {
    const value = BigInt(raw);
    if (value < STEAM_ID64_BASE) return "";
    return (value - STEAM_ID64_BASE).toString();
  } catch {
    return "";
  }
}

function parseLoginUsersVdf(raw) {
  const text = String(raw || "");
  const tokens = [];
  const tokenRegex = /"([^"\\]*(?:\\.[^"\\]*)*)"|([{}])/g;
  let match;

  while ((match = tokenRegex.exec(text))) {
    if (match[1] !== undefined) {
      tokens.push({ type: "string", value: match[1] });
    } else if (match[2] !== undefined) {
      tokens.push({ type: "brace", value: match[2] });
    }
  }

  let index = 0;
  const parseObject = () => {
    const obj = {};
    while (index < tokens.length) {
      const token = tokens[index++];
      if (token.type === "brace") {
        if (token.value === "}") return obj;
        continue;
      }
      const key = token.value;
      if (!key) continue;
      if (index >= tokens.length) break;
      const next = tokens[index++];
      if (next.type === "brace" && next.value === "{") {
        obj[key] = parseObject();
      } else if (next.type === "string") {
        obj[key] = next.value;
      }
    }
    return obj;
  };

  const parsed = parseObject();
  const users =
    parsed &&
    typeof parsed === "object" &&
    parsed.users &&
    typeof parsed.users === "object"
      ? parsed.users
      : parsed;

  const extractUsersBlock = (rawText) => {
    const startIndex = rawText.search(/"users"\s*\{/i);
    if (startIndex === -1) return "";
    const braceIndex = rawText.indexOf("{", startIndex);
    if (braceIndex === -1) return "";

    let depth = 0;
    for (let i = braceIndex; i < rawText.length; i += 1) {
      const char = rawText[i];
      if (char === "{") depth += 1;
      else if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          return rawText.slice(braceIndex + 1, i);
        }
      }
    }
    return "";
  };

  const parseBodyFields = (bodyText) => {
    const fields = {};
    const fieldRegex = /"([^"\\]*)"\s+"([^"\\]*)"/g;
    let fieldMatch;
    while ((fieldMatch = fieldRegex.exec(bodyText))) {
      fields[fieldMatch[1]] = fieldMatch[2];
    }
    return fields;
  };

  const out = [];
  if (users && typeof users === "object") {
    for (const [steamid64, account] of Object.entries(users)) {
      if (!/^\d{17,20}$/.test(steamid64)) continue;
      const body = account || {};
      out.push({
        steamid64,
        accountId: steamId64ToAccountId(steamid64),
        accountName: String(body.AccountName || "").trim(),
        personaName: String(body.PersonaName || "").trim(),
        mostRecent: String(body.MostRecent || "").trim() === "1",
        timestamp: String(body.Timestamp || "").trim(),
      });
    }
  }

  if (out.length === 0) {
    const fallbackContent = extractUsersBlock(text) || text;
    const entryRegex = /"(\d{17,20})"\s*\{([\s\S]*?)\n[ \t]*\}/g;
    while ((match = entryRegex.exec(fallbackContent))) {
      const steamid64 = String(match[1] || "").trim();
      if (!steamid64) continue;
      const bodyText = String(match[2] || "");
      const fields = parseBodyFields(bodyText);
      out.push({
        steamid64,
        accountId: steamId64ToAccountId(steamid64),
        accountName: String(fields.AccountName || "").trim(),
        personaName: String(fields.PersonaName || "").trim(),
        mostRecent: String(fields.MostRecent || "").trim() === "1",
        timestamp: String(fields.Timestamp || "").trim(),
      });
    }
  }

  return out;
}

function buildSteamAccountLabels(accounts) {
  const byBase = new Map();
  for (const account of accounts) {
    const base =
      account.personaName ||
      account.accountName ||
      account.steamid64 ||
      account.accountId ||
      "Unknown";
    byBase.set(base, (byBase.get(base) || 0) + 1);
  }
  return accounts.map((account) => {
    const base =
      account.personaName ||
      account.accountName ||
      account.steamid64 ||
      account.accountId ||
      "Unknown";
    const duplicateCount = byBase.get(base) || 0;
    const label =
      duplicateCount > 1 && isNonEmptyString(account.accountName)
        ? `${base} (${account.accountName})`
        : base;
    return {
      ...account,
      label,
    };
  });
}

function listSteamLoginUsers(options = {}) {
  const steamRoot = resolveSteamRoot(options.hintPaths || []);
  if (!steamRoot) {
    steamLocalUsersLogger.warn("listSteamLoginUsers-no-root", {
      hintPaths: options.hintPaths,
    });
    return { steamRoot: "", loginUsersPath: "", accounts: [] };
  }
  const loginUsersPath = path.join(steamRoot, "config", "loginusers.vdf");
  if (!fs.existsSync(loginUsersPath)) {
    steamLocalUsersLogger.warn("listSteamLoginUsers-no-loginusers", {
      steamRoot,
      loginUsersPath,
    });
    return { steamRoot, loginUsersPath, accounts: [] };
  }
  try {
    const raw = fs.readFileSync(loginUsersPath, "utf8");
    const accounts = buildSteamAccountLabels(parseLoginUsersVdf(raw)).sort(
      (a, b) => {
        if (!!a.mostRecent !== !!b.mostRecent) return a.mostRecent ? -1 : 1;
        return String(a.label || "").localeCompare(String(b.label || ""));
      },
    );
    steamLocalUsersLogger.info("listSteamLoginUsers-success", {
      steamRoot,
      loginUsersPath,
      accountCount: accounts.length,
    });
    return { steamRoot, loginUsersPath, accounts };
  } catch (err) {
    steamLocalUsersLogger.warn("listSteamLoginUsers-read-failed", {
      steamRoot,
      loginUsersPath,
      error: String(err?.message || err),
    });
    return { steamRoot, loginUsersPath, accounts: [] };
  }
}

module.exports = {
  listSteamLoginUsers,
  resolveSteamRoot,
  steamId64ToAccountId,
};
