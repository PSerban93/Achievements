"use strict";

const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { parseSpaFile, buildSchemaFromSpa, getSpaTitleName, XLLN_LANGUAGE_BY_ID } = require("./xlivelessness-spa");
const { readMetadataFile, achievementId, parseJsonState, readStateBytes, titleId, readStateText } = require("./x360-recomp-state");
const { NAME: MANIFEST_NAME, readManifest } = require("./x360-recomp-manifest");
const { parseGpd } = require("./x360-recomp-extra-state");
const { extractSpaFromXex } = require("./x360-recomp-xex");
const { loadXexSpa } = require("./x360-recomp-xex-client");
const { writeJsonAtomicSync } = require("./atomic-json-store");
const { fillAchievementIcons } = require("./x360-recomp-art");
const MAX_IMAGE = 128 * 1024 * 1024;
const LOCALES = { en_US: "english", ja_JP: "japanese", de_DE: "german", fr_FR: "french", es_ES: "spanish",
  it_IT: "italian", ko_KR: "koreana", pt_PT: "portuguese", pt_BR: "brazilian", ru_RU: "russian", pl_PL: "polish",
  zh_CN: "schinese", zh_TW: "tchinese", nl_NL: "dutch" };

function inRoot(root, relative) {
  if (!relative || path.isAbsolute(relative)) return "";
  const target = path.resolve(root, relative), rel = path.relative(root, target);
  return rel && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel) ? target : "";
}

function bounded(file, limit = MAX_IMAGE) {
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > limit) throw new Error("Oversized Xbox metadata file");
  return fs.readFileSync(file);
}

// Synchronous compatibility helper. Production generation uses the bounded
// worker below so decoding does not block Electron's main process.
function spaFromXex(file) {
  return parseSpaFile(extractSpaFromXex(file).spa);
}

function imageFor(schemaDir, id, bytes, extension = ".png") {
  const relative = `img/${achievementId(id)}${extension}`;
  if (bytes) {
    fs.mkdirSync(path.join(schemaDir, "img"), { recursive: true });
    const target = path.join(schemaDir, relative);
    let same = false; try { same = fs.readFileSync(target).equals(bytes); } catch {}
    if (!same) fs.writeFileSync(target, bytes);
  }
  return fs.existsSync(path.join(schemaDir, relative)) ? relative : "";
}

function spaMetadata(parsed, schemaDir) {
  const languages = Object.keys(require("./xlivelessness-spa").XLLN_LANGUAGE_BY_ID).map((key) =>
    require("./xlivelessness-spa").XLLN_LANGUAGE_BY_ID[key]);
  const result = buildSchemaFromSpa(parsed, { schemaLanguages: languages });
  result.schema = result.schema.map((entry, index) => {
    const original = parsed.achievements[index], icon = imageFor(schemaDir, entry.name, parsed.images.get(original.imageId));
    const { xlln_flags, xlln_image_id, ...rest } = entry;
    // 0x8 is ShowUnachieved, not a secret-achievement flag.
    return { ...rest, hidden: original.flags & 8 ? 0 : 1, icon, icon_gray: icon,
      gamerscore: original.gamerscore, points: original.gamerscore, imageId: original.imageId, x360_recomp_origin: "xex" };
  });
  return { ...result, title: getSpaTitleName(parsed, "english"), source: "xex",
    imageIdsMatchAchievementIds: parsed.achievements.length > 0 &&
      parsed.achievements.every((entry) => entry.id === entry.imageId) };
}

function localImage(schemaDir, id, file) {
  const extension = path.extname(file || "").toLowerCase();
  if (![".png", ".jpg", ".jpeg", ".webp"].includes(extension) || !fs.existsSync(file)) throw new Error(`Missing or unsupported achievement icon ${id}`);
  return imageFor(schemaDir, id, bounded(file, 8 * 1024 * 1024), extension);
}

function jsonMetadata(file, game, schemaDir) {
  const doc = JSON.parse(readStateText(file)), rawId = Array.isArray(doc) ? null : doc.title_id ?? doc.titleId;
  if (rawId != null && titleId(rawId) !== game.titleId) throw new Error("JSON metadata TitleID mismatch");
  const entries = Array.isArray(doc) ? doc : doc.achievements;
  if (!Array.isArray(entries) || !entries.length) throw new Error("Missing JSON achievement metadata");
  const seen = new Set(), text = (value) => {
    if (typeof value === "string") return value;
    if (!value || typeof value !== "object" || Array.isArray(value) || !Object.keys(value).length ||
        Object.entries(value).some(([key, content]) => !/^[a-z_]+$/i.test(key) || typeof content !== "string")) throw new Error("Invalid JSON localized text");
    return value;
  };
  const schema = entries.map((entry) => {
    const id = achievementId(entry.id ?? entry.name), displayName = text(entry.displayName ?? entry.label ?? entry.name);
    if (seen.has(id) || typeof displayName === "string" && !displayName.trim()) throw new Error("Duplicate or unnamed JSON achievement");
    seen.add(id);
    const points = entry.gamerscore ?? entry.points ?? 0;
    if (!Number.isSafeInteger(points) || points < 0 || points > 0xffffffff || entry.hidden !== undefined && ![true, false, 0, 1].includes(entry.hidden)) throw new Error("Invalid JSON points/hidden flag");
    let icon = imageFor(schemaDir, id);
    const imagePath = entry.icon_path ?? entry.icon;
    if (imagePath) {
      const image = inRoot(path.dirname(file), imagePath);
      if (!image) throw new Error("JSON icon must stay inside metadata directory");
      icon = localImage(schemaDir, id, image);
    }
    return { name: id, displayName, description: text(entry.description ?? ""), lockedDescription: text(entry.lockedDescription ?? entry.description ?? ""),
      hidden: entry.hidden ? 1 : 0, gamerscore: points, points, icon, icon_gray: icon, x360_recomp_origin: "metadata-json" };
  });
  return { schema, title: typeof doc.title === "string" ? doc.title : game.title, source: "metadata-json" };
}

function gpdMetadata(file, schemaDir) {
  const parsed = parseGpd(readStateBytes(file), file), gpd = require("./xenia-gpd");
  return { title: parsed.title, source: "gpd", schema: gpd.buildSchemaFromGpd(parsed).map((entry) => {
    const icon = imageFor(schemaDir, entry.name, parsed.imagesById.get(String(entry.imageId)));
    return { ...entry, points: entry.gamerscore, icon, icon_gray: icon, x360_recomp_origin: "gpd" };
  }) };
}

// Definition-only signatures avoid rebuilding a GPD schema for each unlock.
function progressDefinitions(game) {
  return Object.values(game.manifest?.progress || game.progress || {}).filter((entry) => ["json", "gpd"].includes(entry.format)).map((entry) => {
    if (!fs.existsSync(entry.file)) return [entry.file, null];
    if (entry.format === "json") return [entry.file, parseJsonState(entry.file).entries.map(({ unlocked, ...definition }) => definition)];
    const parsed = parseGpd(readStateBytes(entry.file), entry.file);
    return [entry.file, require("./xenia-gpd").buildSchemaFromGpd(parsed),
      [...parsed.imagesById].map(([id, image]) => [id, require("crypto").createHash("sha256").update(image).digest("hex")])];
  });
}

async function catalogMetadata(game, schemaDir) {
  const cacheFile = path.join(schemaDir, "xbox-catalog.json");
  let cached; try { cached = JSON.parse(fs.readFileSync(cacheFile, "utf8")); } catch {}
  let data = cached;
  if (!Array.isArray(data?.achievements) || !data.achievements.length) {
    const response = await axios.get(`https://dbox.tools/api/achievements/v1/${game.titleId}`, {
      timeout: 15000, maxContentLength: 8 * 1024 * 1024, responseType: "json" });
    if (!Array.isArray(response.data) || !response.data.length) throw new Error("Xbox catalog has no achievement definitions");
    // The endpoint can also contain DLC. Only explicit DLC/revoked markers
    // are excluded below; a numeric achievement type is not a DLC indicator.
    let title = game.title;
    try {
      const details = await axios.get(`https://dbox.tools/api/title_ids/${game.titleId}`, { timeout: 8000, maxContentLength: 512 * 1024 });
      if (String(details.data?.title_id).toUpperCase() === game.titleId && typeof details.data?.name === "string" && details.data.name.trim()) title = details.data.name.trim();
    } catch {}
    data = { titleId: game.titleId, title, achievements: response.data, fetchedAt: Date.now() };
    writeJsonAtomicSync(cacheFile, data, { backup: true });
  }
  if (data.titleId !== game.titleId) throw new Error("Xbox catalog Title ID mismatch");
  const schema = data.achievements.filter((entry) => !entry.is_revoked && entry.type !== "dlc" && entry.is_dlc !== true).map((entry) => {
    if (String(entry.title_id).replace(/^0x/, "").toUpperCase() !== game.titleId && Number(entry.title_id).toString(16).toUpperCase() !== game.titleId) {
      throw new Error("Xbox catalog achievement belongs to another title");
    }
    const displayName = {}, description = {}, lockedDescription = {};
    for (const text of entry.localizations || []) {
      const language = LOCALES[text.locale?.identifier];
      if (!language || !text.name) continue;
      displayName[language] = text.name;
      description[language] = text.description || text.locked_description || "";
      lockedDescription[language] = text.locked_description || description[language];
    }
    if (!Object.keys(displayName).length) throw new Error("Xbox catalog entry has no text");
    const id = achievementId(entry.achievement_id), points = Number(entry.gamerscore);
    const imageId = Number(entry.image_id ?? entry.imageId);
    return { name: id, displayName, description, lockedDescription, hidden: entry.is_secret ? 1 : 0,
      gamerscore: Number.isFinite(points) ? points : 0, points: Number.isFinite(points) ? points : 0,
      ...(Number.isSafeInteger(imageId) && imageId > 0 && imageId <= 0xffffffff ? { imageId } : {}),
      icon: imageFor(schemaDir, id), icon_gray: imageFor(schemaDir, id), x360_recomp_origin: "catalog" };
  });
  if (!schema.length) throw new Error("No supported Xbox catalog definitions");
  return { schema, title: data.title || game.title, source: "catalog" };
}

async function loadMetadata(game, schemaDir, logger, options = {}) {
  let result, pending = [];
  const needsJsonIcons = () => result && ["json", "metadata-json"].includes(result.source) && result.schema.some((entry) => !entry.icon);
  const manifestFile = (game.metadataPaths || []).find((file) => path.basename(file).toLowerCase() === MANIFEST_NAME);
  const manifest = manifestFile ? readManifest(manifestFile) : null;
  if (manifest && manifest.titleId !== game.titleId) throw new Error("Recomp manifest TitleID changed during generation");
  const exports = (game.metadataPaths || []).filter((file) => file !== manifestFile);
  // This native-port JSON is both definitions and progress. Its exact list is
  // authoritative; the Xbox catalog may contain DLC the port does not support.
  const jsonFiles = [...new Set(Object.values(game.manifest?.progress || game.progress || {}).filter((entry) => entry.format === "json" && fs.existsSync(entry.file)).map((entry) => entry.file))];
  if (jsonFiles.length > 1) throw new Error("Ambiguous JSON achievement definitions");
  if (jsonFiles.length) {
    const json = parseJsonState(jsonFiles[0]);
    if (json.titleId && json.titleId !== game.titleId) throw new Error("JSON metadata TitleID mismatch");
    result = { title: json.title || game.title, source: "json", schema: json.entries.map((entry) => {
      const image = entry.icon_path || entry.icon;
      const candidate = image && inRoot(path.dirname(jsonFiles[0]), image);
      if (image && !candidate) throw new Error("JSON icon must stay inside state directory");
      const icon = candidate ? localImage(schemaDir, entry.id, candidate) : imageFor(schemaDir, entry.id);
      return { name: entry.id, displayName: entry.name, description: entry.description, lockedDescription: entry.description,
        hidden: entry.hidden === true ? 1 : 0, gamerscore: entry.gamerscore, points: entry.gamerscore,
        icon, icon_gray: icon, x360_recomp_origin: "json" };
    }) };
  }
  for (const file of exports.filter((file) => /\.json$/i.test(file))) {
    const metadata = jsonMetadata(file, game, schemaDir);
    if (result) {
      const byId = new Map(result.schema.map((entry) => [entry.name, entry]));
      for (const entry of metadata.schema) byId.set(entry.name, entry);
      result.schema = [...byId.values()];
    } else result = metadata;
  }
  const gpdFiles = [...new Set([...exports.filter((file) => /\.gpd$/i.test(file)),
    ...Object.values(game.manifest?.progress || game.progress || {}).filter((entry) => entry.format === "gpd" && fs.existsSync(entry.file)).map((entry) => entry.file)])];
  for (const file of gpdFiles) if (!result || result.source === "gpd" || needsJsonIcons()) {
    const metadata = gpdMetadata(file, schemaDir);
    if (!result) result = metadata;
    else if (["json", "metadata-json"].includes(result.source)) {
      const icons = new Map(metadata.schema.map((entry) => [entry.name, entry.icon]));
      result.schema = result.schema.map((entry) => entry.icon || !icons.get(entry.name) ? entry : { ...entry, icon: icons.get(entry.name), icon_gray: icons.get(entry.name) });
    } else {
      const byId = new Map(result.schema.map((entry) => [entry.name, entry]));
      for (const entry of metadata.schema) {
        const previous = byId.get(entry.name);
        if (previous && (JSON.stringify(previous.displayName) !== JSON.stringify(entry.displayName) || previous.gamerscore !== entry.gamerscore)) throw new Error("Conflicting GPD profile definitions");
        byId.set(entry.name, previous?.icon ? previous : entry);
      }
      result.schema = [...byId.values()];
    }
  }
  const exportedSpa = [...exports.filter((file) => /\.(spa|xdbf)$/i.test(file)),
    path.join(game.installRoot, "metadata", `${game.titleId}.spa`), path.join(game.installRoot, `${game.titleId}.spa`)];
  for (const file of exportedSpa) if ((!result || needsJsonIcons()) && fs.existsSync(file)) {
    try {
      const parsed = parseSpaFile(bounded(file));
      if (!parsed.titleId || parsed.titleId.toString(16).padStart(8, "0").toUpperCase() !== game.titleId) throw new Error("SPA Title ID mismatch");
      const metadata = spaMetadata(parsed, schemaDir);
      if (result) {
        const icons = new Map(metadata.schema.map((entry) => [entry.name, entry.icon]));
        result.schema = result.schema.map((entry) => entry.icon || !icons.get(entry.name) ? entry : { ...entry, icon: icons.get(entry.name), icon_gray: icons.get(entry.name) });
      } else result = metadata;
      break;
    } catch (error) { pending.push({ file, error: error.message }); }
  }
  if ((!result || needsJsonIcons()) && game.xexPath) {
    try {
      const extracted = await loadXexSpa(game.xexPath, game.titleId, schemaDir, logger, options);
      const metadata = spaMetadata(extracted.parsed, schemaDir);
      if (result) {
        const icons = new Map(metadata.schema.map((entry) => [entry.name, entry.icon]));
        result.schema = result.schema.map((entry) => entry.icon || !icons.get(entry.name) ? entry : { ...entry, icon: icons.get(entry.name), icon_gray: icons.get(entry.name) });
      } else result = metadata;
    } catch (error) {
      if (error.code === "XEX_CANCELLED" || options.isCancelled?.()) throw error;
      logger?.info("x360recomp:metadata:fallback", { appid: game.titleId,
        source: "xex", code: error.code || "XEX_DECODE", error: error.message });
    }
  }
  const overrides = [];
  for (const file of exports.filter((file) => /\.toml$/i.test(file))) {
    const metadata = readMetadataFile(file), doc = metadata.doc;
    if (metadata.titleId && metadata.titleId !== game.titleId) throw new Error("TOML metadata TitleID mismatch");
    const language = XLLN_LANGUAGE_BY_ID[metadata.language];
    if (!language) throw new Error("Unsupported Xbox metadata language");
    if (!Array.isArray(doc.achievements)) throw new Error("Missing [[achievements]] metadata");
    for (const entry of doc.achievements) {
      const id = achievementId(entry.id), points = Number(entry.gamerscore || 0);
      if (!Number.isSafeInteger(points) || points < 0 || points > 0xffffffff || typeof entry.label !== "string") throw new Error(`Invalid achievement metadata ${id}`);
      if (entry.flags !== undefined && (!Number.isSafeInteger(Number(entry.flags)) || Number(entry.flags) < 0 || Number(entry.flags) > 0xffffffff)) throw new Error(`Invalid achievement flags ${id}`);
      let icon = imageFor(schemaDir, id);
      if (entry.icon_path) {
        const image = [inRoot(path.dirname(file), entry.icon_path), inRoot(game.installRoot, entry.icon_path)].find((candidate) => candidate && fs.existsSync(candidate)) || "";
        const extension = path.extname(image).toLowerCase();
        if (image && [".png", ".jpg", ".jpeg", ".webp"].includes(extension) && fs.existsSync(image)) icon = imageFor(schemaDir, id, bounded(image, 8 * 1024 * 1024), extension);
      }
      if (!entry.label) throw new Error(`Missing achievement label ${id}`);
      overrides.push({ name: id, displayName: { [language]: entry.label }, description: { [language]: entry.description || "" },
        lockedDescription: { [language]: entry.unachieved_description || entry.description || "" },
        ...(entry.flags === undefined ? {} : { hidden: Number(entry.flags) & 8 ? 0 : 1 }),
        gamerscore: points, points, icon, icon_gray: icon, imageId: Number(entry.image_id || 0), x360_recomp_origin: "metadata" });
    }
  }
  if (!result) {
    try { result = await catalogMetadata(game, schemaDir); }
    catch (error) {
      if (!overrides.length) throw error;
      pending.push({ source: "catalog", error: error.message });
      result = { schema: [], title: game.title, source: "metadata" };
    }
  }
  // The local SPA owns its texts, image mapping and title. Supplement its list
  // with catalog-only IDs (updates/DLC), after checking the overlapping IDs.
  // Never extend a port's own JSON list, or overwrite local definitions.
  if (result.source === "xex") {
    try {
      const catalog = await catalogMetadata(game, schemaDir);
      const local = new Map(result.schema.map((entry) => [entry.name, entry]));
      const overlap = catalog.schema.filter((entry) => local.has(entry.name));
      if (!overlap.length || overlap.some((entry) => entry.gamerscore !== local.get(entry.name).gamerscore)) {
        throw new Error("Catalog does not match local Xbox achievement definitions");
      }
      const extras = catalog.schema.filter((entry) => !local.has(entry.name));
      // Dante's local SPA confirms ID == image ID for every base achievement.
      // Its DLC follows that convention. Other titles need explicit image IDs.
      if (game.titleId === "454108CF" && result.imageIdsMatchAchievementIds) {
        for (const entry of extras) entry.imageId ??= Number(entry.name);
      }
      result.schema.push(...extras);
      if (extras.length) logger?.info("x360recomp:catalog:supplement", { appid: game.titleId, local: local.size, extra: extras.length });
    } catch (error) {
      pending.push({ source: "catalog-supplement", error: error.message });
      logger?.info("x360recomp:catalog:supplement-pending", { appid: game.titleId, error: error.message });
    }
  }
  // A catalog-only import can recover Dante icons using its verified mapping.
  // Do not infer image IDs from achievement IDs for arbitrary Xbox titles.
  if (result.source === "catalog" && game.titleId === "454108CF") {
    for (const entry of result.schema) entry.imageId ??= Number(entry.name);
  }
  const byId = new Map(result.schema.map((entry) => [entry.name, entry]));
  for (const entry of overrides) {
    const previous = byId.get(entry.name);
    const merged = { hidden: 0, ...previous, ...entry };
    for (const key of ["displayName", "description", "lockedDescription"]) {
      const text = previous?.[key];
      merged[key] = { ...(typeof text === "string" ? { english: text } : text || {}), ...entry[key] };
    }
    byId.set(entry.name, merged);
  }
  if (game.adapter === "reblue") {
    const extras = await require("./x360-recomp-reblue").loadReblueMetadata(game, schemaDir, logger, options);
    for (const { image, iconPath, ...entry } of extras.entries) {
      const icon = imageFor(schemaDir, entry.name, Buffer.from(image, "base64"));
      byId.set(entry.name, { ...entry, displayName: { english: entry.displayName }, description: { english: entry.description },
        lockedDescription: { english: entry.lockedDescription }, hidden: 0, icon, icon_gray: icon, x360_recomp_origin: "reblue" });
    }
  }
  for (const [id, file] of Object.entries(manifest?.icons || {})) {
    const entry = byId.get(id);
    if (!entry) throw new Error(`Icon references unknown achievement ${id}`);
    const icon = localImage(schemaDir, id, file);
    byId.set(id, { ...entry, icon, icon_gray: icon });
  }
  result.schema = [...byId.values()].sort((a, b) => Number(a.name) - Number(b.name));
  if (options.isCancelled?.()) throw Object.assign(new Error("Recomp generation cancelled"), { code: "XEX_CANCELLED" });
  const icons = await fillAchievementIcons(game.titleId, schemaDir, result.schema, options);
  const pendingIcons = result.schema.filter((entry) => !entry.icon &&
    Number.isSafeInteger(entry.imageId) && entry.imageId > 0).map((entry) => entry.name);
  if (pendingIcons.length) pending.push({ source: "icons", ids: pendingIcons });
  logger?.info("x360recomp:icons:ready", { appid: game.titleId, total: result.schema.length,
    present: result.schema.filter((entry) => !!entry.icon).length, downloaded: icons.downloaded,
    missing: result.schema.filter((entry) => !entry.icon).map((entry) => entry.name) });
  result.pending = pending;
  return result;
}

// Recover optional remote data without decoding the XEX or regenerating the
// config. Re-read before merging so a concurrent rarity refresh is preserved.
async function retryOptionalMetadata(game, schemaDir, pending, logger, options = {}) {
  const schemaFile = path.join(schemaDir, "achievements.json");
  const before = JSON.parse(fs.readFileSync(schemaFile, "utf8"));
  if (!Array.isArray(before) || !before.length) throw new Error("Missing recomp schema for optional recovery");
  const working = before.map((entry) => ({ ...entry })), remaining = [];
  const catalogPending = pending.filter((entry) => ["catalog", "catalog-supplement"].includes(entry.source));
  if (catalogPending.length) {
    try {
      const catalog = await catalogMetadata(game, schemaDir);
      const local = new Map(working.map((entry) => [entry.name, entry]));
      const overlap = catalog.schema.filter((entry) => local.has(entry.name));
      if (catalogPending.some((entry) => entry.source === "catalog-supplement") &&
          (!overlap.length || overlap.some((entry) => entry.gamerscore !== local.get(entry.name).gamerscore))) {
        throw new Error("Catalog does not match local Xbox achievement definitions");
      }
      for (const entry of catalog.schema) if (!local.has(entry.name)) {
        if (game.titleId === "454108CF" && working.every((item) => item.imageId === Number(item.name))) entry.imageId ??= Number(entry.name);
        working.push(entry);
      }
    } catch (error) {
      remaining.push(...catalogPending.map((entry) => ({ ...entry, error: error.message })));
    }
  }
  if (options.isCancelled?.()) throw new Error("Recomp optional recovery cancelled");
  const icons = await fillAchievementIcons(game.titleId, schemaDir, working, options);
  if (options.isCancelled?.()) throw new Error("Recomp optional recovery cancelled");
  const current = JSON.parse(fs.readFileSync(schemaFile, "utf8"));
  if (!Array.isArray(current) || !current.length) throw new Error("Recomp schema changed during optional recovery");
  const originals = new Map(before.map((entry) => [entry.name, entry]));
  const recovered = new Map(working.map((entry) => [entry.name, entry]));
  const currentIds = new Set(current.map((entry) => entry.name));
  // A source/schema replacement requires discovery again; do not extend it
  // with results fetched for the previous set of definitions.
  if (current.length !== before.length || current.some((entry) => {
    const old = originals.get(entry.name);
    return !old || old.gamerscore !== entry.gamerscore || JSON.stringify(old.displayName) !== JSON.stringify(entry.displayName);
  })) throw new Error("Recomp definitions changed during optional recovery");
  let changed = false;
  for (const entry of current) {
    const candidate = recovered.get(entry.name);
    if (!entry.icon && candidate?.icon) { entry.icon = candidate.icon; entry.icon_gray = candidate.icon_gray || candidate.icon; changed = true; }
  }
  for (const entry of working) if (!currentIds.has(entry.name)) { current.push(entry); changed = true; }
  const missing = current.filter((entry) => !entry.icon && Number.isSafeInteger(entry.imageId) && entry.imageId > 0).map((entry) => entry.name);
  if (missing.length) remaining.push({ source: "icons", ids: missing });
  if (changed) writeJsonAtomicSync(schemaFile, current.sort((a, b) => Number(a.name) - Number(b.name)), { backup: true });
  logger?.info("x360recomp:optional:retry", { appid: game.titleId, schemaUpdated: changed, downloaded: icons.downloaded, pending: remaining });
  return { schemaUpdated: changed, pending: remaining };
}

module.exports = { loadMetadata, retryOptionalMetadata, spaFromXex, inRoot, progressDefinitions };
