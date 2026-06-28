const fs = require("fs");
const path = require("path");

function readCString(buf, off) {
  let i = off;
  while (i < buf.length && buf[i] !== 0x00) i++;
  const s = buf.toString("utf8", off, i);
  return { s, next: i + 1 };
}

function addKey(obj, key, value) {
  if (Object.prototype.hasOwnProperty.call(obj, key)) {
    const cur = obj[key];
    if (Array.isArray(cur)) cur.push(value);
    else obj[key] = [cur, value];
  } else obj[key] = value;
}

function recordKeyType(obj, key, type) {
  if (!obj || !key) return;
  if (!Object.prototype.hasOwnProperty.call(obj, "__kvTypes")) {
    Object.defineProperty(obj, "__kvTypes", {
      value: {},
      enumerable: false,
      configurable: true,
      writable: true,
    });
  }
  obj.__kvTypes[key] = type;
}

function parseNodeChildren(buf, offset) {
  let off = offset;
  const obj = {};
  while (off < buf.length) {
    const type = buf.readUInt8(off);
    off += 1;
    if (type === 0x08) return { obj, next: off };
    const k = readCString(buf, off);
    const key = k.s;
    off = k.next;
    if (type === 0x00) {
      const child = parseNodeChildren(buf, off);
      addKey(obj, key, child.obj);
      off = child.next;
      continue;
    }
    if (type === 0x01) {
      const v = readCString(buf, off);
      addKey(obj, key, v.s);
      recordKeyType(obj, key, "string");
      off = v.next;
      continue;
    }
    if (type === 0x02) {
      const v = buf.readInt32LE(off);
      off += 4;
      addKey(obj, key, v);
      recordKeyType(obj, key, "int32");
      continue;
    }
    if (type === 0x03) {
      const v = buf.readFloatLE(off);
      off += 4;
      addKey(obj, key, v);
      recordKeyType(obj, key, "float");
      continue;
    }
    if (type === 0x07) {
      const v = buf.readBigUInt64LE(off);
      off += 8;
      addKey(obj, key, v.toString());
      recordKeyType(obj, key, "uint64");
      continue;
    }
    throw new Error(`Unsupported KV type 0x${type.toString(16)} (key="${key}")`);
  }
  return { obj, next: off };
}

function parseKVBinary(buf) {
  if (!buf || buf.length < 2) throw new Error("Empty/invalid file");
  let off = 0;
  const firstType = buf.readUInt8(off);
  off += 1;
  let rootName = "root";
  let rootObj = {};
  if (firstType === 0x00) {
    const r = readCString(buf, off);
    rootName = r.s || "root";
    off = r.next;
    const parsed = parseNodeChildren(buf, off);
    rootObj = parsed.obj;
  } else {
    off = 0;
    const parsed = parseNodeChildren(buf, off);
    rootObj = parsed.obj;
  }
  return { rootName, data: rootObj };
}

function extractUserStats(rootObj) {
  const stats = {};
  function findTimes(node) {
    return (
      node.AchievementTimes ||
      node.achievementTimes ||
      node.AchievementsTimes ||
      node.achievement_times ||
      null
    );
  }
  function toTs(v) {
    if (typeof v === "number") return v;
    if (typeof v === "string" && /^\d+$/.test(v)) {
      const n = Number(v);
      return Number.isSafeInteger(n) ? n : null;
    }
    return null;
  }
  function walk(node, pathArr) {
    if (!node || typeof node !== "object") return;
    if (Object.prototype.hasOwnProperty.call(node, "data") && typeof node.data === "number") {
      const statId = String(pathArr[pathArr.length - 1]);
      const data_u32 = node.data >>> 0;
      const data_type = node.__kvTypes?.data || "";
      const times = {};
      const tn = findTimes(node);
      if (tn && typeof tn === "object") {
        for (const [k, v] of Object.entries(tn)) {
          const ts = toTs(v);
          if (ts != null) times[String(k)] = ts;
        }
      }
      stats[statId] = { data_u32, data_value: node.data, data_type, times };
    }
    for (const [k, v] of Object.entries(node)) {
      if (v && typeof v === "object") walk(v, pathArr.concat(k));
    }
  }
  walk(rootObj, ["root"]);
  return stats;
}

function inferStatIdAndBit(pathArr) {
  const isNum = (s) => typeof s === "string" && /^\d+$/.test(s);
  let bit = null;
  let statId = null;
  for (let i = pathArr.length - 1; i >= 0; i--) {
    if (isNum(pathArr[i])) {
      bit = Number(pathArr[i]);
      for (let j = i - 1; j >= 0; j--) {
        if (isNum(pathArr[j])) {
          statId = Number(pathArr[j]);
          return { statId, bit };
        }
      }
      break;
    }
  }
  return { statId, bit };
}

function ensureLangObj(val) {
  if (val && typeof val === "object" && !Array.isArray(val)) return { ...val };
  if (typeof val === "string") return { english: val };
  return {};
}

function normalizeHidden(v) {
  if (typeof v === "number") return v ? 1 : 0;
  const s = String(v ?? "").toLowerCase().trim();
  return s === "1" || s === "true" || s === "yes" ? 1 : 0;
}

function toFiniteNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function toInteger(value) {
  const n = toFiniteNumber(value);
  return n != null && Number.isInteger(n) ? n : null;
}

function normalizeProgressStatType(value) {
  const raw = String(value || "").trim().toUpperCase();
  if (!raw) return "";
  if (raw === "FLOAT" || raw === "FLOAT32") return "FLOAT";
  if (raw === "INT" || raw === "INTEGER" || raw === "UINT32") return "INT";
  return raw;
}

function extractSchemaStatDefinitions(schemaRootObj) {
  const byName = new Map();

  function walk(node, pathArr) {
    if (!node || typeof node !== "object") return;
    if (
      typeof node.name === "string" &&
      node.name &&
      !node.bits &&
      String(node.type || "").toUpperCase() !== "ACHIEVEMENTS"
    ) {
      const statId = toInteger(pathArr[pathArr.length - 1]);
      if (statId != null) {
        byName.set(node.name, {
          statId,
          min: toFiniteNumber(node.min),
          max: toFiniteNumber(node.max),
          type: normalizeProgressStatType(node.type),
        });
      }
    }
    for (const [k, v] of Object.entries(node)) {
      if (v && typeof v === "object") walk(v, pathArr.concat(k));
    }
  }

  walk(schemaRootObj, ["root"]);
  return byName;
}

function extractProgressMetadata(bitVal, statDefinitions) {
  const progress = bitVal?.progress;
  if (!progress || typeof progress !== "object") return null;
  const valueNode =
    progress.value && typeof progress.value === "object"
      ? progress.value
      : progress;
  const operation = String(
    valueNode.operation || progress.operation || "",
  ).toLowerCase();
  const progressStatName = String(
    valueNode.operand1 || progress.operand1 || "",
  ).trim();
  if (operation !== "statvalue" || !progressStatName) return null;

  const statInfo = statDefinitions.get(progressStatName) || {};
  const progressStatId = toInteger(statInfo.statId);
  const progressMin =
    toFiniteNumber(progress.min_val) ??
    toFiniteNumber(progress.min) ??
    toFiniteNumber(statInfo.min) ??
    0;
  const progressMax =
    toFiniteNumber(progress.max_val) ??
    toFiniteNumber(progress.max) ??
    toFiniteNumber(statInfo.max);
  if (progressMax == null || progressMax <= 0) return null;

  return {
    progressOperation: operation,
    progressStatName,
    progressStatId,
    progressStatType: statInfo.type || "",
    progressMin,
    progressMax,
  };
}

function copyProgressFields(target, source) {
  if (!target || !source) return target;
  const progressStatName = String(
    source.progressStatName ||
      source.progress_stat_name ||
      source.progress?.statName ||
      source.progress?.stat ||
      "",
  ).trim();
  const progressStatId = toInteger(
    source.progressStatId ??
      source.progress_stat_id ??
      source.progress?.statId ??
      source.progress?.stat_id,
  );
  const progressMin =
    toFiniteNumber(
      source.progressMin ?? source.progress_min ?? source.progress?.min,
    ) ?? 0;
  const progressMax = toFiniteNumber(
    source.progressMax ?? source.progress_max ?? source.progress?.max,
  );
  const progressStatType = normalizeProgressStatType(
    source.progressStatType ??
      source.progress_stat_type ??
      source.progress?.statType ??
      source.progress?.stat_type ??
      source.progress?.type,
  );
  if (!progressStatName && progressStatId == null) return target;
  if (progressMax == null || progressMax <= 0) return target;
  if (progressStatName) target.progressStatName = progressStatName;
  if (progressStatId != null) target.progressStatId = progressStatId;
  if (progressStatType) target.progressStatType = progressStatType;
  target.progressMin = progressMin;
  target.progressMax = progressMax;
  return target;
}

function extractSchemaAchievements(schemaRootObj) {
  const results = [];
  const statDefinitions = extractSchemaStatDefinitions(schemaRootObj);

  const pushEntry = ({
    api,
    display,
    desc,
    icon,
    iconGray,
    hidden,
    statId,
    bit,
    progress,
  }) => {
    if (!api || statId == null || bit == null) return;
    const entry = {
      api: String(api),
      displayName: ensureLangObj(display || api),
      description: ensureLangObj(desc || ""),
      hidden: normalizeHidden(hidden),
      icon,
      icon_gray: iconGray || icon,
      statId,
      bit,
    };
    copyProgressFields(entry, progress);
    results.push(entry);
  };

  function walk(node, pathArr) {
    if (!node || typeof node !== "object") return;

    // Modern appcache schema shape: { "0": { type: "4", bits: { "0": { name, display, bit } } } }
    if (node.bits && typeof node.bits === "object") {
      const statId = Number(pathArr[pathArr.length - 1]);
      for (const [bitKey, bitVal] of Object.entries(node.bits)) {
        const bit = Number(bitVal?.bit ?? bitKey);
        const name =
          bitVal?.name ||
          bitVal?.api ||
          bitVal?.statname ||
          bitVal?.display?.name?.token ||
          bitVal?.display?.name ||
          null;
        const display = bitVal?.display?.name || bitVal?.displayName || bitVal?.name;
        const desc = bitVal?.display?.desc || bitVal?.description || "";
        const icon = bitVal?.display?.icon || bitVal?.icon;
        const iconGray =
          bitVal?.display?.icon_gray ||
          bitVal?.display?.icongray ||
          bitVal?.icon_gray;
        const hiddenVal = bitVal?.display?.hidden ?? bitVal?.hidden ?? node.hidden;
        const progress = extractProgressMetadata(bitVal, statDefinitions);
        pushEntry({
          api: name || `stat${statId}_bit${bit}`,
          display,
          desc,
          icon,
          iconGray,
          hidden: hiddenVal,
          statId: Number.isFinite(statId) ? statId : null,
          bit: Number.isFinite(bit) ? bit : null,
          progress,
        });
      }
    }

    // Fallback: legacy name+bit inference
    if (typeof node.name === "string" && node.name) {
      const { statId, bit } = inferStatIdAndBit(pathArr);
      pushEntry({
        api: node.name,
        display: node.display || node.DisplayName || node.displayName || node.name,
        desc: node.desc || node.description || node.Desc || "",
        icon: node.icon || node.Icon || null,
        iconGray: node.icon_gray || node.iconGray || null,
        hidden: node.hidden,
        statId,
        bit,
      });
    }

    for (const [k, v] of Object.entries(node)) {
      if (v && typeof v === "object") walk(v, pathArr.concat(k));
    }
  }

  walk(schemaRootObj, ["root"]);
  const seen = new Set();
  const dedup = [];
  for (const r of results) {
    if (seen.has(r.api)) continue;
    seen.add(r.api);
    dedup.push(r);
  }
  return dedup;
}

function normalizeSchemaEntry(entry) {
  if (!entry || typeof entry !== "object") return null;
  const api = entry.name || entry.api;
  const statId = toInteger(entry.statId);
  const bit = toInteger(entry.bit);
  if (!api || statId == null || bit == null) return null;
  const normalized = {
    api: String(api),
    statId,
    bit,
  };
  copyProgressFields(normalized, entry);
  return normalized;
}

function normalizeAppcacheSchemaEntries(schemaArr) {
  if (!Array.isArray(schemaArr)) return [];
  return schemaArr.map(normalizeSchemaEntry).filter(Boolean);
}

function hasProgressMetadata(entry) {
  return (
    entry &&
    toInteger(entry.progressStatId) != null &&
    toFiniteNumber(entry.progressMax) != null &&
    toFiniteNumber(entry.progressMax) > 0
  );
}

function needsProgressMetadataEnrichment(entry, source) {
  if (!hasProgressMetadata(entry)) return true;
  if (!source || !hasProgressMetadata(source)) return false;
  const sourceType = normalizeProgressStatType(source.progressStatType);
  const entryType = normalizeProgressStatType(entry.progressStatType);
  return !!sourceType && sourceType !== entryType;
}

function enrichSchemaEntriesFromAppcacheSchema(schemaEntries, schemaRootObj) {
  const entries = normalizeAppcacheSchemaEntries(schemaEntries);
  if (!entries.length || !schemaRootObj) return entries;
  const extracted = extractSchemaAchievements(schemaRootObj);
  const byApi = new Map(extracted.map((entry) => [entry.api, entry]));
  return entries.map((entry) => {
    const source = byApi.get(entry.api);
    if (!needsProgressMetadataEnrichment(entry, source)) return entry;
    if (!source || !hasProgressMetadata(source)) return entry;
    return copyProgressFields({ ...entry }, source);
  });
}

function enrichSchemaEntriesFromAppcacheSchemaFile(schemaEntries, schemaBinPath) {
  const entries = normalizeAppcacheSchemaEntries(schemaEntries);
  if (!entries.length || !schemaBinPath || !fs.existsSync(schemaBinPath)) {
    return entries;
  }
  try {
    const schemaKV = parseKVBinary(fs.readFileSync(schemaBinPath));
    return enrichSchemaEntriesFromAppcacheSchema(entries, schemaKV.data);
  } catch {
    return entries;
  }
}

function buildSnapshotFromAppcache(schemaEntries, userStats) {
  const snap = {};

  function decodeProgressValue(stat, statType) {
    if (!stat || typeof stat !== "object") return 0;
    const normalizedType = normalizeProgressStatType(statType);
    const value = stat.data_value;
    if (
      normalizedType === "FLOAT" &&
      typeof value === "number" &&
      Number.isFinite(value) &&
      (stat.data_type === "float" || !Number.isInteger(value))
    ) {
      return value;
    }
    const raw = stat.data_u32 >>> 0;
    if (normalizedType !== "FLOAT") return raw;
    const buf = Buffer.allocUnsafe(4);
    buf.writeUInt32LE(raw, 0);
    const decoded = buf.readFloatLE(0);
    return Number.isFinite(decoded) ? decoded : 0;
  }

  for (const a of schemaEntries || []) {
    const stat = userStats[String(a.statId)] || { data_u32: 0, times: {} };
    const data = stat.data_u32 >>> 0;
    const earned = ((data >>> a.bit) & 1) === 1;
    const ts = stat.times && Object.prototype.hasOwnProperty.call(stat.times, String(a.bit))
      ? stat.times[String(a.bit)]
      : null;
    const item = {
      earned,
      earned_time: earned ? ts || 0 : 0,
    };
    const progressStatId = toInteger(a.progressStatId);
    const progressMax = toFiniteNumber(a.progressMax);
    if (progressStatId != null && progressMax != null && progressMax > 0) {
      const progressStat = userStats[String(progressStatId)] || {
        data_u32: 0,
      };
      const rawProgress = decodeProgressValue(
        progressStat,
        a.progressStatType,
      );
      item.progress = Math.max(0, Math.min(rawProgress, progressMax));
      item.max_progress = progressMax;
    }
    snap[a.api] = item;
  }
  return snap;
}

function normalizeSteamIconUrl(appid, hash) {
  if (!hash) return "";
  if (/^https?:\/\//i.test(hash)) return hash;
  if (hash.startsWith("//")) return "https:" + hash;
  return `https://steamcdn-a.akamaihd.net/steamcommunity/public/images/apps/${appid}/${hash}`;
}

function extractGameName(rootObj) {
  let hit = null;
  function walk(node) {
    if (!node || typeof node !== "object") return;
    for (const [k, v] of Object.entries(node)) {
      if (typeof v === "string") {
        const lk = String(k).toLowerCase();
        // Only accept explicit gamename to avoid picking achievement strings.
        if (lk === "gamename") {
          hit = v;
          return;
        }
      }
      if (hit) return;
      if (v && typeof v === "object") walk(v);
      if (hit) return;
    }
  }
  walk(rootObj);
  return hit;
}

function parseUserBinName(filePath) {
  const base = path.basename(String(filePath || ""));
  const match = base.match(/^UserGameStats_(\d+)_(\d+)\.bin$/i);
  if (!match) return null;
  return {
    accountId: String(match[1] || ""),
    appid: String(match[2] || ""),
    fileName: base,
  };
}

function listUserBins(statsDir, appid) {
  try {
    const targetAppId = String(appid || "").trim().toLowerCase();
    if (!statsDir || !targetAppId || !fs.existsSync(statsDir)) return [];
    return fs
      .readdirSync(statsDir)
      .map((fileName) => {
        const parsed = parseUserBinName(fileName);
        if (!parsed) return null;
        if (parsed.appid.toLowerCase() !== targetAppId) return null;
        const fullPath = path.join(statsDir, fileName);
        let mtimeMs = 0;
        try {
          mtimeMs = fs.statSync(fullPath).mtimeMs;
        } catch {}
        return {
          ...parsed,
          path: fullPath,
          mtimeMs,
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
  } catch {
    return [];
  }
}

function pickLatestUserBin(statsDir, appid) {
  const entries = listUserBins(statsDir, appid);
  return entries.length ? entries[0].path : null;
}

function pickPreferredUserBin(statsDir, appid, preferredAccountId = "") {
  const entries = listUserBins(statsDir, appid);
  if (!entries.length) return null;
  const preferred = String(preferredAccountId || "").trim();
  if (!preferred) return entries[0].path;
  const exact = entries.find((entry) => entry.accountId === preferred);
  return exact ? exact.path : null;
}

module.exports = {
  parseKVBinary,
  extractSchemaAchievements,
  normalizeAppcacheSchemaEntries,
  enrichSchemaEntriesFromAppcacheSchema,
  enrichSchemaEntriesFromAppcacheSchemaFile,
  extractUserStats,
  buildSnapshotFromAppcache,
  normalizeSteamIconUrl,
  listUserBins,
  parseUserBinName,
  pickPreferredUserBin,
  pickLatestUserBin,
  extractGameName,
};
