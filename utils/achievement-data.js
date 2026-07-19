const fs = require("fs");
const path = require("path");
const ini = require("ini");
const CRC32 = require("crc-32");
const parseStatsBin = require("./parseStatsBin");

function parseIniWithEncoding(filePath) {
  try {
    const buf = fs.readFileSync(filePath);
    const looksUtf16le = buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe;
    const looksUtf16be = buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff;
    const hasNulls = buf.includes(0x00);

    const decode = (enc) => {
      const text = buf.toString(enc);
      const clean = text.replace(/^\uFEFF/, "");
      return ini.parse(clean);
    };

    if (looksUtf16le) return decode("utf16le");
    if (looksUtf16be) return decode("utf16be");

    // Try utf8 first; if we see NUL bytes, fallback to utf16le (UniverseLAN often Unicode)
    try {
      if (!hasNulls) return decode("utf8");
    } catch {
      /* fallthrough */
    }
    return decode("utf16le");
  } catch {
    return null;
  }
}

function hexLE32FromAny(raw) {
  const hex = String(raw ?? "").replace(/[^0-9a-f]/gi, "");
  if (hex.length < 8) return undefined;
  try {
    const buf = Buffer.from(hex.slice(0, 8), "hex");
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    return view.getUint32(0, true);
  } catch {
    return undefined;
  }
}

function normalizeEpoch(t) {
  if (!Number.isFinite(t) || t <= 0) return 0;
  return t < 10_000_000_000 ? t * 1000 : t;
}

function parseType2Section(sec) {
  const get = (...keys) => {
    for (const k of keys) if (k in (sec || {})) return sec[k];
    return undefined;
  };

  const achRaw = get(
    "Achieved",
    "achieved",
    "ACHIEVED",
    "Earned",
    "earned",
    "Unlock",
    "unlock",
    "UNLOCK",
    "Unlocked",
    "unlocked",
    "UNLOCKED"
  );
  const achieved =
    typeof achRaw === "boolean"
      ? achRaw
      : typeof achRaw === "number"
      ? achRaw === 1
      : typeof achRaw === "string"
      ? ["1", "true", "yes"].includes(achRaw.trim().toLowerCase())
      : false;

  const curRaw = get("CurProgress", "curProgress", "progress", "Progress");
  const maxRaw = get(
    "MaxProgress",
    "maxProgress",
    "max_progress",
    "Max",
    "max"
  );

  const cur =
    typeof curRaw === "string" && /^[0-9]$/.test(curRaw)
      ? Number(curRaw)
      : Number.isFinite(Number(curRaw))
      ? Number(curRaw)
      : undefined;
  const max =
    typeof maxRaw === "string" && /^[0-9]$/.test(maxRaw)
      ? Number(maxRaw)
      : Number.isFinite(Number(maxRaw))
      ? Number(maxRaw)
      : undefined;

  const tRaw = get(
    "UnlockTime",
    "unlockTime",
    "UnlockedTime",
    "unlockedTime",
    "UNLOCKEDTIME",
    "timestamp",
    "earned_time",
    "earnedTime",
    "Time",
    "time"
  );
  const tNum = Number(tRaw);
  const time = Number.isFinite(tNum) ? tNum : 0;

  return {
    earned: achieved,
    earned_time: normalizeEpoch(time),
    ...(cur !== undefined ? { progress: cur } : {}),
    ...(max !== undefined ? { max_progress: max } : {}),
  };
}

function parseType1Section(sec) {
  const curRaw =
    sec.CurProgress ?? sec.curProgress ?? sec.progress ?? sec.Progress;
  const maxRaw =
    sec.MaxProgress ??
    sec.maxProgress ??
    sec.max_progress ??
    sec.Max ??
    sec.max;
  const timeRaw =
    sec.Time ??
    sec.UnlockTime ??
    sec.unlockTime ??
    sec.UnlockedTime ??
    sec.unlockedTime ??
    sec.UNLOCKEDTIME ??
    sec.timestamp ??
    sec.time;
  const unlockedRaw =
    sec.Unlock ??
    sec.unlock ??
    sec.UNLOCK ??
    sec.Unlocked ??
    sec.unlocked ??
    sec.UNLOCKED;

  const stateHex = hexLE32FromAny(sec.State);
  const curHex = hexLE32FromAny(curRaw);
  const maxHex = hexLE32FromAny(maxRaw);
  const timeHex = hexLE32FromAny(timeRaw);

  const toNumber = (raw) =>
    raw !== undefined && raw !== null && raw !== "" ? Number(raw) : undefined;

  const curVal = curHex !== undefined ? curHex : toNumber(curRaw);
  const maxVal = maxHex !== undefined ? maxHex : toNumber(maxRaw);
  const timeVal = timeHex !== undefined ? timeHex : toNumber(timeRaw);
  const unlocked =
    typeof unlockedRaw === "boolean"
      ? unlockedRaw
      : typeof unlockedRaw === "number"
      ? unlockedRaw === 1
      : typeof unlockedRaw === "string"
      ? ["1", "true", "yes"].includes(unlockedRaw.trim().toLowerCase())
      : false;

  const earned =
    String(sec.achieved ?? sec.Achieved ?? "").trim() === "1" ||
    unlocked ||
    (typeof stateHex === "number" && stateHex > 0) ||
    (typeof curVal === "number" &&
      typeof maxVal === "number" &&
      maxVal > 0 &&
      curVal >= maxVal);

  return {
    earned,
    earned_time: normalizeEpoch(timeVal || 0),
    ...(curVal !== undefined ? { progress: curVal } : {}),
    ...(maxVal !== undefined ? { max_progress: maxVal } : {}),
  };
}

function parseAchievementIniSection(sec) {
  const hasType2 =
    "Achieved" in sec ||
    "achieved" in sec ||
    "Unlocked" in sec ||
    "unlocked" in sec ||
    "Unlock" in sec ||
    "unlock" in sec ||
    "UnlockTime" in sec ||
    "unlocktime" in sec ||
    "UnlockedTime" in sec ||
    "unlockedTime" in sec ||
    "UNLOCKEDTIME" in sec;
  const hasType1 =
    "State" in sec ||
    "Time" in sec ||
    "CurProgress" in sec ||
    "MaxProgress" in sec ||
    "curProgress" in sec ||
    "maxProgress" in sec ||
    "Progress" in sec ||
    "Max" in sec ||
    "max" in sec;

  if (hasType2 && !hasType1) return parseType2Section(sec);
  if (hasType2 && hasType1) return parseType2Section(sec);
  return parseType1Section(sec);
}

function flattenIniSections(obj) {
  const out = {};
  const isLeaf = (o) =>
    o &&
    typeof o === "object" &&
    ("State" in o ||
      "Time" in o ||
      "CurProgress" in o ||
      "MaxProgress" in o ||
      "Achieved" in o ||
      "achieved" in o ||
      "Unlock" in o ||
      "unlock" in o ||
      "Unlocked" in o ||
      "unlocked" in o ||
      "UnlockTime" in o ||
      "UnlockedTime" in o ||
      "timestamp" in o);

  const walk = (node, parts) => {
    if (!node || typeof node !== "object") return;
    if (isLeaf(node)) {
      out[parts.join(".")] = node;
      return;
    }
    for (const [k, v] of Object.entries(node)) {
      if (k === "Steam") continue;
      walk(v, parts.concat(k));
    }
  };

  for (const [k, v] of Object.entries(obj || {})) {
    if (k === "Steam") continue;
    walk(v, [k]);
  }

  return out;
}

function normSectionTitle(s) {
  return String(s || "")
    .normalize("NFKC")
    .replace(/\u2026/g, "...")
    .replace(/\s/g, " ")
    .trim()
    .toLowerCase();
}

function buildNameOnlyIndex(configArray) {
  const byName = new Map();
  for (const a of configArray || []) {
    if (!a || !a.name) continue;
    const canonical = String(a.name);
    byName.set(normSectionTitle(canonical), canonical);
    if (!/^ach_/i.test(canonical)) {
      const alias = `ach_${canonical}`;
      byName.set(normSectionTitle(alias), canonical);
    }
  }
  return byName;
}

function buildDisplayToNameIndex(configArray) {
  const byDisp = new Map();
  for (const a of configArray || []) {
    if (!a || !a.name) continue;
    const dn = a.displayName;
    if (typeof dn === "string") {
      byDisp.set(normSectionTitle(dn), a.name);
    } else if (dn && typeof dn === "object") {
      for (const v of Object.values(dn)) {
        if (typeof v === "string" && v.trim()) {
          byDisp.set(normSectionTitle(v), a.name);
        }
      }
    }
  }
  return byDisp;
}

function getNameIndexFromConfigPath(
  configPath,
  schemaOverride = null,
  appid = null
) {
  try {
    const candidates = [];
    if (schemaOverride) candidates.push(schemaOverride);
    if (configPath) {
      candidates.push(path.join(configPath, "achievements.json"));
      if (appid) {
        candidates.push(
          path.join(configPath, String(appid), "achievements.json")
        );
      }
    }
    for (const candidate of candidates) {
      if (!candidate || !fs.existsSync(candidate)) continue;
      const arr = JSON.parse(fs.readFileSync(candidate, "utf8"));
      return {
        byName: buildNameOnlyIndex(arr),
        byDisp: buildDisplayToNameIndex(arr),
      };
    }
  } catch {}
  return { byName: new Map(), byDisp: new Map() };
}

function canonNameFromIniSection(sectionTitle, nameIndex) {
  const key = normSectionTitle(sectionTitle);
  return (
    nameIndex?.byDisp.get(key) || nameIndex?.byName.get(key) || sectionTitle
  );
}

function resolveConfigSchemaPath(meta, fallbackConfigPath = null) {
  const appid =
    meta?.appid != null && String(meta.appid).trim().length
      ? String(meta.appid).trim()
      : "";
  const normalizedPlatform = (meta?.platform || "")
    .toString()
    .trim()
    .toLowerCase();
  const baseCandidates = [];
  if (typeof meta?.config_path === "string" && meta.config_path.length) {
    baseCandidates.push(meta.config_path);
  }
  if (fallbackConfigPath) baseCandidates.push(fallbackConfigPath);

  for (const base of baseCandidates) {
    if (!base) continue;
    const candidates = new Set();
    candidates.add(path.join(base, "achievements.json"));
      if (appid) {
        candidates.add(path.join(base, appid, "achievements.json"));
        if (normalizedPlatform) {
          candidates.add(
            path.join(base, normalizedPlatform, appid, "achievements.json")
          );
        }
      [
        "uplay",
        "ubisoft-official",
        "ea-official",
        "steam",
        "epic",
        "epic-official",
        "gog",
        "gog-official",
        "xbox-pc",
        "xenia",
        "rpcs3",
        "shadps4",
      ].forEach((plat) =>
        candidates.add(path.join(base, plat, appid, "achievements.json"))
      );
    }
    for (const candidate of candidates) {
      try {
        if (fs.existsSync(candidate)) return candidate;
      } catch {
        /* ignore */
      }
    }
  }
  return null;
}

function buildCrcNameMap(achievements) {
  const map = {};
  for (const ach of achievements || []) {
    if (!ach?.name) continue;
    const crc = CRC32.str(ach.name) >>> 0;
    const hex = crc.toString(16).padStart(8, "0").toLowerCase();
    map[hex] = ach;
  }
  return map;
}

function getSafeLocalizedText(input, lang = "english") {
  if (input === null || input === undefined) return "Hidden";
  if (typeof input === "string") {
    return input.trim() !== "" ? input.trim() : "Hidden";
  }
  if (typeof input === "object") {
    const requestedLang = String(lang || "english").trim();
    const requestedLower = requestedLang.toLowerCase();
    if (
      requestedLang &&
      typeof input[requestedLang] === "string" &&
      input[requestedLang].trim() !== ""
    ) {
      return input[requestedLang];
    }
    const caseInsensitiveKey = Object.keys(input).find((key) => {
      return (
        String(key || "").toLowerCase() === requestedLower &&
        typeof input[key] === "string" &&
        input[key].trim() !== ""
      );
    });
    if (caseInsensitiveKey) {
      return input[caseInsensitiveKey];
    }
    return (
      input.english ||
      Object.values(input).find(
        (v) => typeof v === "string" && v.trim() !== ""
      ) ||
      "Hidden"
    );
  }
  return "Hidden";
}
function canonNameFromEntry(rawName, nameIndex) {
  const key = normSectionTitle(rawName);
  return nameIndex?.byName.get(key) || nameIndex?.byDisp.get(key) || rawName;
}

function parseTenokeAchievementsIni(filePath, nameIndex) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const lines = raw.split(/\r?\n/);
    let section = "";
    const statsMap = new Map();
    const achievementsMap = new Map();

    const toBool = (value) => {
      const v = String(value || "")
        .trim()
        .toLowerCase();
      return v === "true" || v === "1" || v === "yes";
    };

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith(";") || trimmed.startsWith("#"))
        continue;

      const sectionMatch = trimmed.match(/^\[(.+?)\]$/);
      if (sectionMatch) {
        section = sectionMatch[1].trim().toUpperCase();
        continue;
      }

      const kvMatch = trimmed.match(/^"([^"]+)"\s*=\s*(.+)$/);
      if (!kvMatch) continue;

      const entryName = kvMatch[1];
      const value = kvMatch[2].trim();

      if (section === "STATS") {
        const numeric = Number(value.replace(/,$/, ""));
        if (Number.isFinite(numeric)) statsMap.set(entryName, numeric);
        continue;
      }

      if (section === "ACHIEVEMENTS") {
        let unlocked = false;
        let time = 0;
        let progress = undefined;

        if (value.startsWith("{") && value.endsWith("}")) {
          const inner = value.slice(1, -1);
          for (const part of inner.split(",")) {
            const [rawKey, rawVal] = part.split("=").map((p) => p && p.trim());
            if (!rawKey) continue;
            const key = rawKey.toLowerCase();
            if (key === "unlocked") {
              unlocked = toBool(rawVal);
            } else if (key === "time") {
              const t = Number(rawVal);
              if (Number.isFinite(t)) time = t;
            } else if (key === "progress" || key === "value") {
              const p = Number(rawVal);
              if (Number.isFinite(p)) progress = p;
            }
          }
        }

        achievementsMap.set(entryName, { unlocked, time, progress });
      }
    }

    const allNames = new Set([...statsMap.keys(), ...achievementsMap.keys()]);

    const result = {};
    for (const rawName of allNames) {
      const canonical = canonNameFromEntry(rawName, nameIndex);
      const statVal = statsMap.get(rawName);
      const achData = achievementsMap.get(rawName) || {};

      const entry = {
        earned: achData.unlocked === true,
        earned_time: normalizeEpoch(achData.time || 0),
      };

      const progressValue =
        achData.progress !== undefined ? achData.progress : statVal;
      if (Number.isFinite(progressValue)) entry.progress = progressValue;

      result[canonical] = entry;
    }

    return Object.keys(result).length ? result : null;
  } catch {
    return null;
  }
}

function loadAchievementsFromSaveFile(saveDir, fallback = {}, options = {}) {
  const {
    configMeta = null,
    selectedConfigPath = null,
    fullSchemaPath = null,
  } = options || {};

  const appid = configMeta?.appid != null ? String(configMeta.appid) : null;
  const configPathOverride =
    (configMeta && configMeta.config_path) || selectedConfigPath || null;
  const normalizedPlatform = String(configMeta?.platform || "")
    .trim()
    .toLowerCase();

  const nameIndex = getNameIndexFromConfigPath(
    configPathOverride,
    fullSchemaPath,
    appid
  );

  const findCaseInsensitive = (dir, target, options = {}) => {
    const maxDepth = Number.isFinite(options.maxDepth)
      ? Math.max(0, options.maxDepth)
      : 0;
    const targetLc = String(target || "").toLowerCase();
    if (!dir || !targetLc) return null;
    const stack = [{ dir, depth: 0 }];

    while (stack.length) {
      const { dir: curDir, depth } = stack.pop();
      try {
        const entries = fs.readdirSync(curDir, { withFileTypes: true });
        for (const ent of entries) {
          if (ent.isFile() && ent.name.toLowerCase() === targetLc) {
            return path.join(curDir, ent.name);
          }
        }
        if (depth < maxDepth) {
          for (const ent of entries) {
            if (ent.isDirectory()) {
              stack.push({
                dir: path.join(curDir, ent.name),
                depth: depth + 1,
              });
            }
          }
        }
      } catch {
        /* ignore this branch */
      }
    }
    return null;
  };

  const saveJsonPath =
    findCaseInsensitive(saveDir, "achievements.json") ||
    path.join(saveDir, "achievements.json");
  if (normalizedPlatform === "gog-official") {
    const gameplayDbPath =
      findCaseInsensitive(saveDir, "gameplay.db") ||
      path.join(saveDir, "gameplay.db");
    if (fs.existsSync(gameplayDbPath)) {
      try {
        const {
          readGogGameplayDb,
          buildGogOfficialSnapshot,
        } = require("./gog-galaxy-local");
        const parsed = readGogGameplayDb(gameplayDbPath);
        const snapshot = buildGogOfficialSnapshot(parsed?.achievements || []);
        return snapshot && Object.keys(snapshot).length ? snapshot : fallback || {};
      } catch {
        return fallback || {};
      }
    }
  }
  if (normalizedPlatform === "ubisoft-official") {
    const spoolFilePath =
      (appid &&
        (findCaseInsensitive(saveDir, `${appid}.spool`) ||
          path.join(saveDir, `${appid}.spool`))) ||
      "";
    if (spoolFilePath && fs.existsSync(spoolFilePath)) {
      try {
        const {
          buildUbisoftOfficialSnapshot,
          readUbisoftSpoolFile,
        } = require("./ubisoft-connect-local");
        const parsed = readUbisoftSpoolFile(spoolFilePath);
        const snapshot = buildUbisoftOfficialSnapshot(parsed?.records || []);
        return snapshot && Object.keys(snapshot).length ? snapshot : fallback || {};
      } catch {
        return fallback || {};
      }
    }
  }
  if (normalizedPlatform === "ea-official") {
    try {
      const {
        buildEaOfficialSnapshot,
        readEaDesktopVerboseLog,
        resolveEaOfficialAchievementSetForAppId,
        resolveEaOfficialVerboseLogPath,
      } = require("./ea-desktop-local");
      const logFilePath = resolveEaOfficialVerboseLogPath(
        configMeta || {},
        {
          savePath: saveDir,
        },
      );
      if (logFilePath && fs.existsSync(logFilePath)) {
        const parsed = readEaDesktopVerboseLog(logFilePath);
        const entry = resolveEaOfficialAchievementSetForAppId(appid, {
          achievementSet:
            configMeta?.ea_achievement_set || configMeta?.eaAchievementSet || "",
          parsedLog: parsed,
          logFilePath,
        });
        const achievementSet =
          entry?.achievementSet ||
          configMeta?.ea_achievement_set ||
          configMeta?.eaAchievementSet ||
          "";
        const snapshot = buildEaOfficialSnapshot(
          entry || achievementSet,
          parsed,
          fallback || {},
        );
        return snapshot && Object.keys(snapshot).length
          ? snapshot
          : fallback || {};
      }
    } catch {
      return fallback || {};
    }
  }
  // UniverseLAN sometimes nests the ini; allow a shallow search (depth 2)
  const iniPath =
    findCaseInsensitive(saveDir, "achievements.ini", { maxDepth: 2 }) ||
    path.join(saveDir, "achievements.ini");
  const tenokeIniDirect = path.join(saveDir, "user_stats.ini");
  const tenokeIniNested = path.join(saveDir, "SteamData", "user_stats.ini");
  const tenokeIniPath = fs.existsSync(tenokeIniDirect)
    ? tenokeIniDirect
    : tenokeIniNested;
  const isStatsDir = path.basename(saveDir).toLowerCase() === "stats";
  const statsDir = path.join(saveDir, "Stats");
  const statsIni =
    findCaseInsensitive(statsDir, "achievements.ini", { maxDepth: 2 }) ||
    path.join(statsDir, "achievements.ini");
  const onlineFixIniPath = isStatsDir ? iniPath : statsIni;
  const binPath = path.join(saveDir, "stats.bin");
  const fromIniSection = (sec) => parseAchievementIniSection(sec);

  if (fs.existsSync(saveJsonPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(saveJsonPath, "utf-8"));
      if (parsed === null) return fallback || {};

      const out = {};
      const hasRawUnlockTime = (item) =>
        item && typeof item.unlock_time !== "undefined";
      const put = (name, item) => {
        if (!name) return;
        const achRaw =
          item?.achieved ?? item?.Achieved ?? item?.ACHIEVED ?? item?.earned;
        const earned =
          typeof achRaw === "boolean"
            ? achRaw
            : typeof achRaw === "number"
            ? achRaw === 1
            : typeof achRaw === "string"
            ? ["1", "true", "yes"].includes(achRaw.trim().toLowerCase())
            : false;
        const prog =
          item?.CurProgress ??
          item?.curProgress ??
          item?.progress ??
          item?.Progress;
        const maxp =
          item?.MaxProgress ??
          item?.maxProgress ??
          item?.max_progress ??
          item?.Max ??
          item?.max;
        const tsRaw =
          item?.UnlockTime ??
          item?.unlockTime ??
          item?.timestamp ??
          item?.earned_time ??
          item?.earnedTime ??
          item?.unlock_time;
        const ts = Number(tsRaw) || 0;

        out[name] = {
          earned: earned || normalizeEpoch(ts) > 0,
          earned_time: ts,
          ...(prog !== undefined ? { progress: Number(prog) } : {}),
          ...(maxp !== undefined ? { max_progress: Number(maxp) } : {}),
        };
      };

      if (Array.isArray(parsed)) {
        parsed.forEach((item) =>
          put(
            item?.name ||
              item?.Name ||
              item?.id ||
              item?.AchievementId ||
              item?.achievementId,
            item
          )
        );
      } else if (parsed && typeof parsed === "object") {
        for (const [name, item] of Object.entries(parsed)) put(name, item);
      }

      const normalized = {};
      for (const [rawName, entry] of Object.entries(out)) {
        if (!rawName) continue;
        const canonical = canonNameFromEntry(rawName, nameIndex);
        if (!canonical) continue;
        normalized[canonical] = entry;
      }

      if (Object.keys(normalized).length) return normalized;

      // Epic-style: array of objects with AchievementId + UnlockTime
      const epicOut = {};
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (!item || typeof item !== "object") continue;
          const rawName =
            item.AchievementId ||
            item.achievementId ||
            item.id ||
            item.ID ||
            item.name ||
            item.Name;
          if (!rawName) continue;
          const t =
            Number(
              item.UnlockTime ??
                item.unlock_time ??
                item.unlockTime ??
                item.timestamp ??
                item.time
            ) || 0;
          const earned =
            item.Achieved === true ||
            item.achieved === true ||
            item.Achieved === 1 ||
            item.achieved === 1 ||
            normalizeEpoch(t) > 0;
          const canonical = canonNameFromEntry(rawName, nameIndex);
          epicOut[canonical || rawName] = {
            earned,
            earned_time: normalizeEpoch(t),
          };
        }
      }
      if (Object.keys(epicOut).length) return epicOut;

      // GOG-style: flat object with unlock_time +/- unlocked
      const gogOut = {};
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const [rawName, item] of Object.entries(parsed)) {
          if (!rawName || !item || typeof item !== "object") continue;
          const t =
            Number(
              item.unlock_time ??
                item.UnlockTime ??
                item.unlockTime ??
                item.timestamp ??
                item.time
            ) || 0;
          const earned =
            item.unlocked === true ||
            item.unlocked === 1 ||
            normalizeEpoch(t) > 0;
          const canonical = canonNameFromEntry(rawName, nameIndex);
          gogOut[canonical || rawName] = {
            earned,
            earned_time: normalizeEpoch(t),
          };
        }
      }
      if (Object.keys(gogOut).length) return gogOut;

      return fallback || {};
    } catch {
      return fallback || {};
    }
  }

  if (fs.existsSync(tenokeIniPath)) {
    const tenokeData = parseTenokeAchievementsIni(tenokeIniPath, nameIndex);
    if (tenokeData) return tenokeData;
  }

  if (fs.existsSync(onlineFixIniPath)) {
    try {
      const parsed = parseIniWithEncoding(onlineFixIniPath);
      const flat = flattenIniSections(parsed);
      const converted = {};
      for (const [secTitle, secObj] of Object.entries(flat)) {
        const key = canonNameFromIniSection(secTitle, nameIndex);
        if (!key) continue;
        converted[key] = fromIniSection(secObj || {});
      }
      return converted;
    } catch {
      return fallback || {};
    }
  }

  if (fs.existsSync(iniPath)) {
    try {
      const parsed = parseIniWithEncoding(iniPath);
      const flat = flattenIniSections(parsed);
      const converted = {};
      for (const [secTitle, secObj] of Object.entries(flat)) {
        const key = canonNameFromIniSection(secTitle, nameIndex);
        if (!key) continue;
        converted[key] = fromIniSection(secObj || {});
      }
      return converted;
    } catch {
      return fallback || {};
    }
  }

  if (fs.existsSync(binPath)) {
    try {
      const schemaPath =
        resolveConfigSchemaPath(configMeta, configPathOverride) ||
        fullSchemaPath ||
        (configPathOverride
          ? path.join(configPathOverride, "achievements.json")
          : null);

      let crcMap = {};
      if (schemaPath && fs.existsSync(schemaPath)) {
        const configJson = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
        crcMap = buildCrcNameMap(configJson);
      }

      const raw = parseStatsBin(binPath);
      const converted = {};
      for (const [crc, item] of Object.entries(raw)) {
        const key = crcMap[crc.toLowerCase()]?.name || crc.toLowerCase();
        converted[key] = {
          earned: item.earned,
          earned_time: item.earned_time,
        };
      }
      return converted;
    } catch {
      return fallback || {};
    }
  }

  return fallback || {};
}

module.exports = {
  loadAchievementsFromSaveFile,
  parseAchievementIniSection,
  flattenIniSections,
  canonNameFromIniSection,
  getNameIndexFromConfigPath,
  normalizeEpoch,
  hexLE32FromAny,
  getSafeLocalizedText,
  buildCrcNameMap,
  resolveConfigSchemaPath,
};
