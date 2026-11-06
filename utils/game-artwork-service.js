"use strict";

const fs = require("fs"), path = require("path");
const storage = require("./game-artwork-storage");
const { createLogger } = require("./logger");
function createService({ providers = require("./game-artwork-providers").createProviders(), processImage, measure,
  load = async candidate => candidate.file ? fs.promises.readFile(candidate.file) : require("./game-artwork-http").download(candidate.url),
  onSaved = () => {}, logger = createLogger("covers") } = {}) {
  const jobs = new Map(), epochs = new Map(), failures = new Map();
  const validFiles = new Map();
  let active = 0, automaticActive = 0; const waiters = [];
  function pump() {
    while (active < 3) {
      let index = waiters.findIndex(item => item.manual);
      if (index < 0 && automaticActive < 2) index = waiters.findIndex(item => !item.manual);
      if (index < 0) return;
      const item = waiters.splice(index, 1)[0]; active++; if (!item.manual) automaticActive++;
      Promise.resolve().then(item.run).then(item.resolve, item.reject).finally(() => { active--; if (!item.manual) automaticActive--; pump(); });
    }
  }
  const limited = (run, manual) => new Promise((resolve, reject) => { waiters.push({ run, manual, resolve, reject }); pump(); });
  async function validExisting(file, type) {
    if (!file) return false;
    try {
      const stat = await fs.promises.stat(file); if (!stat.isFile() || !stat.size || stat.size > 40 * 1024 * 1024) return false;
      const key = JSON.stringify([file, stat.size, stat.mtimeMs, type]);
      if (validFiles.has(key)) return validFiles.get(key);
      const valid = fs.promises.readFile(file).then(measure).then(size => size.width > 0 && size.height > 0 &&
        (type !== "hero" || require("./game-artwork-policy").isHero(size))).catch(() => false);
      if (validFiles.size >= 128) validFiles.delete(validFiles.keys().next().value);
      validFiles.set(key, valid); return valid;
    } catch { return false; }
  }
  async function custom(config, type) {
    for (const file of type === "cover" ? [config.custom_cover_path] : type === "header" ? [config.custom_header_path] : [config.custom_hero_path, config.custom_background_path, config.custom_header_path])
      if (await validExisting(file, type)) return file;
    return "";
  }
  async function one(context, type, options, memo) {
    const { config } = context, dir = storage.directory(context), manual = options.manual === true;
    const previousSelection = storage.selection(dir, type);
    let repair = options.repair === true && !manual && previousSelection?.manual === true;
    let source = repair ? previousSelection.source : options.source || "automatic";
    const identity = JSON.stringify([path.resolve(context.userDataDir), config.platform, String(config.appid), type]);
    const choices = providers.list(config, type);
    if (source !== "automatic" && !choices.some(item => item.id === source)) return Promise.resolve({ ok: false, type, source, code: "source-unsupported", skipped: true });
    // Reserve manual ordering before asynchronous file validation, so a slower
    // older request cannot supersede a later source choice.
    let epoch = epochs.get(identity) || 0;
    if (manual) { epoch++; epochs.set(identity, epoch); }
    const customPath = await custom(config, type);
    if (customPath) return Promise.resolve({ ok: !manual, type, path: customPath, existing: true, code: "custom-image-active" });
    const current = storage.existingAt(dir, storage.basename(config, type));
    if (!manual && !options.force && await validExisting(current, type)) return { ok: true, type, path: current, existing: true };
    const protectedFile = storage.protectedPath(dir, type);
    if (!manual && !repair && protectedFile) {
      if (await validExisting(protectedFile, type)) return { ok: true, type, path: protectedFile, existing: true, code: "manual-preserved" };
      // Repair corruption using the same explicitly selected provider.
      repair = true; source = previousSelection.source;
      if (source !== "automatic" && !choices.some(item => item.id === source)) return { ok: false, type, source, code: "source-unsupported", skipped: true };
    }
    if (!manual && !options.force && failures.get(identity) > Date.now()) return Promise.resolve({ ok: false, type, code: "retry-later" });
    const key = JSON.stringify([identity, source, manual, epoch]);
    if (jobs.has(key)) return jobs.get(key);
    const job = limited(async () => {
      const canPublish = () => (epochs.get(identity) || 0) === epoch && (!repair || storage.selection(dir, type)?.updatedAt === previousSelection.updatedAt);
      let error = "No image was available from this source";
      for (const choice of source === "automatic" ? choices : choices.filter(item => item.id === source)) {
        if (!canPublish()) return { ok: false, type, code: "superseded" };
        let candidates;
        try { candidates = await providers.candidates(context, type, choice.id, memo); }
        catch (e) { error = e.message; logger.info("artwork:source-miss", { platform: config.platform, appid: config.appid, type, source: choice.id, error }); continue; }
        for (const entry of candidates || []) {
          try {
            const resolved = typeof entry === "function" ? await entry() : entry;
            const candidate = typeof resolved === "string" ? { url: resolved } : resolved;
            if (!candidate?.file && !/^https?:\/\//i.test(candidate?.url || "")) continue;
            if (candidate.file && fs.statSync(candidate.file).size > 40 * 1024 * 1024) throw new Error("image-too-large");
            const buffer = Buffer.from(await load(candidate));
            if (!buffer.length || buffer.length > 40 * 1024 * 1024) throw new Error("image-too-large-or-empty");
            const extension = storage.signature(buffer); if (!extension) throw new Error("unsupported-image-format");
            const processed = await processImage(buffer, extension, type, config);
            const result = await storage.publish({ dir, base: storage.basename(config, type), type, buffer: processed.buffer,
              extension: processed.extension, source: choice.id, url: candidate.url || "", manual: manual || repair, canPublish });
            if (result.ok) {
              failures.delete(identity);
              logger.info("artwork:saved", { platform: config.platform, appid: config.appid, type, source: choice.id, path: result.path, manual, repair, existing: result.existing === true });
              if (!result.existing) try { await onSaved(context, { ...result, type }); } catch (e) { logger.warn("artwork:refresh-failed", { path: result.path, error: e.message }); }
            }
            return { ...result, type, source: result.source || choice.id };
          } catch (e) {
            error = e.message; logger.info("artwork:candidate-miss", { platform: config.platform, appid: config.appid, type, source: choice.id, error });
          }
        }
      }
      if (!manual) {
        if (failures.size >= 256) failures.delete(failures.keys().next().value);
        failures.set(identity, Date.now() + 120000);
      }
      logger.warn("artwork:failed", { platform: config.platform, appid: config.appid, type, source, manual, error });
      return { ok: false, type, source, code: "download-failed", error };
    }, manual).finally(() => jobs.delete(key));
    jobs.set(key, job); return job;
  }
  return { list: providers.list, async ensure(context, options = {}) {
    storage.directory(context);
    const types = options.type === "all" ? storage.TYPES : [options.type || "cover"];
    if (types.some(type => !storage.TYPES.includes(type))) throw new Error("invalid-artwork-type");
    const memo = new Map(), results = await Promise.all(types.map(type => one(context, type, options, memo)));
    return { ok: results.every(item => item.ok), partial: results.some(item => item.ok) && results.some(item => !item.ok), results };
  } };
}
let singleton;
function configure(options) { singleton = createService(options); return singleton; }
function get() {
  if (!singleton) {
    const { nativeImage } = require("electron");
    singleton = createService({ processImage: require("./game-artwork-process").createImageProcessor(nativeImage), measure: buffer => require("./game-artwork-validation").size(nativeImage, buffer) });
  }
  return singleton;
}
module.exports = { createService, configure, get };
