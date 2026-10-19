"use strict";

const fs = require("fs");
const path = require("path");
const { withGameSource } = require("./kytyps5-game-source");

const PLATFORM = "kytyps5";
const ENGLISH_VARIANTS_VERSION = 1;
const LANGUAGES = {
  "en-US": "english", "en-GB": "english", "ja-JP": "japanese",
  "fr-FR": "french", "fr-CA": "french", "es-ES": "spanish",
  "es-419": "latam", "de-DE": "german", "it-IT": "italian",
  "nl-NL": "dutch", "pt-PT": "portuguese", "pt-BR": "brazilian",
  "ru-RU": "russian", "ko-KR": "koreana", "zh-Hans": "schinese",
  "zh-Hant": "tchinese", "fi-FI": "finnish", "sv-SE": "swedish",
  "da-DK": "danish", "no-NO": "norwegian", "pl-PL": "polish",
  "tr-TR": "turkish", "ar-AE": "arabic", "cs-CZ": "czech",
  "hu-HU": "hungarian", "el-GR": "greek", "ro-RO": "romanian",
  "th-TH": "thai", "vi-VN": "vietnamese", "id-ID": "indonesian",
  "uk-UA": "ukrainian",
};
const EPOCH_TICK = 62135596800000000n;

function readUcp(filePathOrBuffer) {
  const buffer = Buffer.isBuffer(filePathOrBuffer) ? filePathOrBuffer : (() => {
    const stat = fs.statSync(filePathOrBuffer);
    if (!stat.isFile() || stat.size > 256 * 1024 * 1024) {
      throw new Error("Invalid KytyPS5 trophy package size");
    }
    return fs.readFileSync(filePathOrBuffer);
  })();
  if (buffer.length < 32 || buffer.length > 256 * 1024 * 1024) {
    throw new Error("Invalid KytyPS5 trophy package size");
  }
  if (buffer.readUInt32BE(0) !== 0xb228c60a || buffer.readUInt32BE(4) !== 1) {
    throw new Error("Unsupported KytyPS5 UCP package");
  }
  const declaredSize = buffer.readBigUInt64BE(8);
  const count = buffer.readUInt32BE(16);
  const toc = buffer.readUInt32BE(20);
  if (declaredSize !== BigInt(buffer.length) || count > 4096 ||
      toc + 32 + count * 64 > buffer.length) {
    throw new Error("Incomplete KytyPS5 UCP package");
  }
  const files = new Map();
  for (let i = 0; i < count; i += 1) {
    const entry = toc + 32 + i * 64;
    const name = buffer.subarray(entry, entry + 32).toString("utf8").split("\0")[0];
    const offset = buffer.readBigUInt64BE(entry + 32);
    const size = buffer.readBigUInt64BE(entry + 40);
    if (!name || files.has(name) || offset + size > BigInt(buffer.length)) {
      throw new Error("Invalid KytyPS5 UCP entry");
    }
    // Entry names are lookup keys only; never extract arbitrary archive paths.
    files.set(name, buffer.subarray(Number(offset), Number(offset + size)));
  }
  return files;
}

function readGameIdentity(gamePath) {
  return withGameSource(gamePath, (source) => readIdentityFromSource(gamePath, source));
}

function readIdentityFromSource(gamePath, source) {
  const param = JSON.parse(source.read("sce_sys/param.json", 1024 * 1024)
    .toString("utf8").replace(/^\uFEFF/, ""));
  const titleId = String(param.titleId || "").trim().toUpperCase();
  if (!/^PPSA\d+$/.test(titleId)) throw new Error("Invalid PS5 title ID");
  const localized = param.localizedParameters || {};
  const title = localized["en-US"]?.titleName || localized["en-GB"]?.titleName ||
    localized[localized.defaultLanguage]?.titleName ||
    Object.values(localized).find((value) => value?.titleName)?.titleName || titleId;
  return { titleId, title: String(title), gamePath: path.resolve(gamePath) };
}

function parseTrophyPackage(gamePath, serviceLabel = 0) {
  if (!Number.isInteger(serviceLabel) || serviceLabel < 0 || serviceLabel > 99) {
    throw new Error("Unsupported PS5 trophy service label");
  }
  const member = `sce_sys/trophy2/trophy${String(serviceLabel).padStart(2, "0")}.ucp`;
  const { identity, files } = withGameSource(gamePath, (source) => ({
    identity: readIdentityFromSource(gamePath, source),
    files: readUcp(source.read(member, 256 * 1024 * 1024)),
  }));
  const packagePath = fs.statSync(gamePath).isFile() ? `${gamePath}!/${member}` :
    path.join(gamePath, ...member.split("/"));
  const definition = JSON.parse(files.get("tropconf.json")?.toString("utf8") || "null");
  if (!Array.isArray(definition?.trophies)) throw new Error("Missing PS5 trophy definitions");
  const metadata = [];
  // Prefer US English if multiple locales map to the same application language.
  for (const [name, bytes] of files) {
    const match = /^tropmeta_(.+)\.json$/.exec(name);
    if (!match || !LANGUAGES[match[1]]) continue;
    const data = JSON.parse(bytes.toString("utf8"));
    if (Array.isArray(data?.metadata?.trophyMetadata)) {
      metadata.push({ locale: match[1], entries: data.metadata.trophyMetadata });
    }
  }
  metadata.sort((a, b) => Number(b.locale === "en-US") - Number(a.locale === "en-US"));
  const seen = new Set();
  const trophies = definition.trophies.map((trophy) => {
    const rawId = String(trophy.id);
    if (!/^\d{1,8}$/.test(rawId)) throw new Error("Invalid PS5 trophy ID");
    const id = String(Number(rawId));
    if (seen.has(id)) throw new Error("Duplicate PS5 trophy ID");
    seen.add(id);
    const displayName = {}, description = {}, englishVariants = {};
    for (const { locale, entries } of metadata) {
      const item = entries.find((entry) => Number(entry.id) === Number(id));
      const language = LANGUAGES[locale];
      if (item?.name && !displayName[language]) displayName[language] = String(item.name);
      if (item?.detail && !description[language]) description[language] = String(item.detail);
      if ((locale === "en-US" || locale === "en-GB") && item?.name) {
        englishVariants[locale] = {
          displayName: String(item.name), description: String(item.detail || ""),
        };
      }
    }
    const fallback = LANGUAGES[definition.defaultLanguage];
    displayName.english ||= displayName[fallback] || Object.values(displayName)[0] || `Trophy ${id}`;
    description.english ||= description[fallback] || Object.values(description)[0] || "";
    const imageName = `trop${String(Number(id)).padStart(4, "0")}.png`;
    const grade = { B: "bronze", S: "silver", G: "gold", P: "platinum" }[trophy.grade];
    if (!grade) throw new Error("Invalid PS5 trophy grade");
    return {
      name: id, displayName, description, hidden: trophy.hidden === true ? 1 : 0,
      trophyType: grade, icon: `img/${imageName}`, icon_gray: `img/${imageName}`,
      imageId: Number(id), imageName,
      kytyps5_trophy_id: id, kytyps5_service_label: serviceLabel,
      kytyps5_english_variants: englishVariants,
      kytyps5_group_id: trophy.groupId == null ? null : String(trophy.groupId),
    };
  });
  const titles = {}, groups = {};
  for (const { locale } of metadata) {
    const data = JSON.parse(files.get(`tropmeta_${locale}.json`).toString("utf8"));
    const language = LANGUAGES[locale];
    if (data.metadata.titleMetadata?.name) titles[language] ||= data.metadata.titleMetadata.name;
    for (const group of data.metadata.groupMetadata || []) {
      if (group.id != null && group.name) (groups[String(group.id)] ||= {})[language] ||= group.name;
    }
  }
  return { ...identity, serviceLabel, packagePath, trophies, files,
    set: { serviceLabel, npCommId: definition.trophyNpCommId || "",
      englishVariantsVersion: ENGLISH_VARIANTS_VERSION,
      version: definition.trophySetVersion || "", revision: definition.trophyDefinitionRevision,
      titles, groups } };
}

function parseProgressPath(filePath) {
  const match = /^trophies_(\d+)_(\d+)\.json$/i.exec(path.basename(filePath || ""));
  const titleId = path.basename(path.dirname(filePath || "")).toUpperCase();
  if (!match || !/^PPSA\d+$/.test(titleId) ||
      path.basename(path.dirname(path.dirname(filePath || ""))).toLowerCase() !== "_trophies" ||
      Number(match[2]) > 99) return null;
  return { titleId, userId: match[1], serviceLabel: Number(match[2]),
    emulatorRoot: path.dirname(path.dirname(path.dirname(filePath))), progressPath: filePath };
}

function resolveProgressPath(config) {
  return resolveProgressPaths(config)[0] || "";
}

function trophyKey(serviceLabel, id) {
  return Number(serviceLabel) === 0 ? String(Number(id)) : `s${Number(serviceLabel)}_${Number(id)}`;
}

function serviceLabels(config) {
  const labels = Array.isArray(config?.kytyps5_service_labels)
    ? config.kytyps5_service_labels : [config?.kytyps5_service_label ?? 0];
  return [...new Set(labels.map(Number).filter((label) => Number.isInteger(label) && label >= 0 && label <= 99))]
    .sort((a, b) => a - b);
}

function resolveProgressPaths(config, userId = config?.kytyps5_user_id) {
  const legacyPath = String(config?.kytyps5_progress_path || config?.save_path || "").trim();
  const parsed = parseProgressPath(legacyPath);
  const root = config?.kytyps5_emulator_root || parsed?.emulatorRoot;
  const titleId = config?.kytyps5_title_id || parsed?.titleId || String(config?.appid || "").split("-s")[0];
  const user = String(userId ?? parsed?.userId ?? "");
  if (!root || !/^PPSA\d+$/i.test(titleId) || !/^\d+$/.test(user)) return parsed ? [legacyPath] : [];
  return serviceLabels(config).map((label) => path.join(root, "_Trophies", titleId, `trophies_${user}_${label}.json`));
}

function profileOptions(config, userId = config?.kytyps5_user_id) {
  return { kytyps5UserId: String(userId ?? ""), kytyps5EmulatorRoot: config?.kytyps5_emulator_root || "",
    savePath: resolveProgressPaths(config, userId)[0] || "", appid: config?.appid || "" };
}

function readProgressSnapshot(filePath, schema = [], previous = {}) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error("Invalid PS5 progress size");
    const data = JSON.parse(fs.readFileSync(filePath, "utf8"), (_key, value, context) => {
      // JSON numbers contain microseconds since year 1, exceeding Number precision.
      if (typeof value === "number" && !Number.isSafeInteger(value)) {
        if (!context?.source) throw new Error("Lossless JSON number parsing unavailable");
        return context.source;
      }
      return value;
    });
    if (!Array.isArray(data?.unlockedTrophies) ||
        data.unlockedTrophies.some((id) => !Number.isSafeInteger(id) || id < 0)) {
      throw new Error("Invalid PS5 unlocked trophy list");
    }
    const unlocked = new Set(data.unlockedTrophies.map(String));
    const snapshot = {};
    for (const trophy of schema) {
      const key = String(trophy.name);
      const id = String(trophy.kytyps5_trophy_id ?? trophy.name);
      const earned = unlocked.has(id);
      let earnedTime = 0;
      const tick = data.unlockedAt?.[id];
      if (earned && /^(?:0|[1-9]\d*)$/.test(String(tick ?? ""))) {
        const milliseconds = (BigInt(tick) - EPOCH_TICK) / 1000n;
        if (milliseconds > 0n && milliseconds <= 8640000000000000n) {
          earnedTime = Number(milliseconds);
        }
      }
      if (earned && !earnedTime) earnedTime = previous[key]?.earned_time || 0;
      snapshot[key] = { earned, earned_time: earnedTime };
    }
    return { valid: true, snapshot };
  } catch (error) {
    return { valid: false, snapshot: previous, reason: error.code || error.message };
  }
}

function loadConfigSnapshot(config, previous = {}, options = {}) {
  try {
    const schema = JSON.parse(fs.readFileSync(path.join(config.config_path, "achievements.json"), "utf8"));
    if (!Array.isArray(schema)) throw new Error("Invalid PS5 achievement schema");
    const snapshot = {}, failures = [];
    const progressPaths = resolveProgressPaths(config, options.userId ?? config.kytyps5_user_id);
    if (!progressPaths.length) throw new Error("Missing PS5 progress identity");
    for (const progressPath of progressPaths) {
      const label = parseProgressPath(progressPath).serviceLabel;
      const entries = schema.filter((item) => Number(item.kytyps5_service_label ?? config.kytyps5_service_label ?? 0) === label);
      const fallback = Object.fromEntries(entries.map((item) =>
        [String(item.name), previous[item.name] || { earned: false, earned_time: 0 }]));
      if (!fs.existsSync(progressPath)) { Object.assign(snapshot, fallback); continue; }
      const parsed = readProgressSnapshot(progressPath, entries, fallback);
      Object.assign(snapshot, parsed.snapshot);
      if (!parsed.valid) failures.push({ progressPath, reason: parsed.reason });
    }
    // One incomplete user's set must not hide valid updates from other sets.
    return { valid: true, snapshot, failures };
  } catch (error) {
    return { valid: false, snapshot: previous, reason: error.message };
  }
}

module.exports = { PLATFORM, LANGUAGES, ENGLISH_VARIANTS_VERSION, readUcp, readGameIdentity, parseTrophyPackage,
  parseProgressPath, resolveProgressPath, resolveProgressPaths, serviceLabels, trophyKey,
  profileOptions, readProgressSnapshot, loadConfigSnapshot };
