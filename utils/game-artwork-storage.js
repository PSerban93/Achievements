"use strict";

const fs = require("fs"), path = require("path"), crypto = require("crypto");
const { writeJsonAtomicSync } = require("./atomic-json-store");
const TYPES = ["cover", "header", "hero"];
const EXTENSIONS = [".jpg", ".jpeg", ".jpe", ".jfif", ".png", ".webp", ".gif", ".bmp", ".avif"];
const safe = value => /^[\p{L}\p{N}_.:-]{1,180}$/u.test(String(value || "")) && ![".", ".."].includes(String(value));
const read = file => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return {}; } };
function directory({ userDataDir, config }) {
  if (!userDataDir || !safe(config?.platform) || !safe(config?.appid)) throw new Error("invalid-artwork-identity");
  return path.join(userDataDir, "images", String(config.platform), String(config.appid));
}
function basename(config, type) {
  if (!TYPES.includes(type)) throw new Error("invalid-artwork-type");
  return type === "cover" ? String(config.appid) : type === "header" ? "header" : "game-cover-hero";
}
function selectedFile(dir, base, extensions = EXTENSIONS) {
  const type = base === "header" ? "header" : base === "game-cover-hero" ? "hero" : "cover";
  const entry = selection(dir, type), file = entry?.file;
  if (typeof file !== "string" || path.basename(file) !== file || /[\\/:\u0000-\u001f]/.test(file)) return "";
  const folded = value => process.platform === "win32" ? value.toLowerCase() : value;
  if (folded(path.parse(file).name) !== folded(base) || !extensions.includes(path.extname(file).toLowerCase())) return "";
  return path.join(dir, file);
}
function candidatePaths(dir, base, extensions = EXTENSIONS) {
  return [...new Set([selectedFile(dir, base, extensions), ...extensions.map(ext => path.join(dir, base + ext))].filter(Boolean))];
}
function existingAt(dir, base, extensions = EXTENSIONS) {
  for (const file of candidatePaths(dir, base, extensions)) { try { const stat = fs.statSync(file); if (stat.isFile() && stat.size > 0) return file; } catch {} }
  return "";
}
function selection(dir, type) { return read(path.join(dir, "sources.json"))?.artwork?.[type] || null; }
function protectedPath(dir, type) {
  const entry = selection(dir, type);
  if (!entry?.manual || typeof entry.file !== "string" || path.basename(entry.file) !== entry.file) return "";
  const file = path.join(dir, entry.file);
  try { const stat = fs.statSync(file); return stat.isFile() && stat.size > 0 ? file : ""; } catch { return ""; }
}
function signature(buffer) {
  if (buffer.length >= 3 && buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) return ".jpg";
  if (buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return ".png";
  if (/^GIF8[79]a$/.test(buffer.subarray(0, 6).toString("ascii"))) return ".gif";
  if (buffer.subarray(0, 4).toString() === "RIFF" && buffer.subarray(8, 12).toString() === "WEBP") return ".webp";
  if (buffer.subarray(0, 2).toString() === "BM") return ".bmp";
  if (buffer.subarray(4, 8).toString() === "ftyp" && /avif|avis/.test(buffer.subarray(8, 32).toString())) return ".avif";
  return "";
}
async function lock(dir, type) {
  const file = path.join(dir, ".artwork-publish.lock"), started = Date.now();
  for (;;) {
    try { const fd = fs.openSync(file, "wx"); fs.writeFileSync(fd, String(process.pid)); return () => { try { fs.closeSync(fd); } catch {} try { fs.unlinkSync(file); } catch {} }; }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      try { const pid = Number(fs.readFileSync(file, "utf8")); if (pid > 0) { try { process.kill(pid, 0); } catch (e) { if (e.code === "ESRCH") { fs.unlinkSync(file); continue; } } } } catch {}
      if (Date.now() - started > 15000) throw new Error("artwork-publish-busy");
      await new Promise(resolve => setTimeout(resolve, 40));
    }
  }
}
async function publish({ dir, base, type, buffer, extension, source = "import", url = "", manual = false, canPublish = () => true, fixedPath = "" }) {
  if (!TYPES.includes(type) || !Buffer.isBuffer(buffer) || buffer.length < 12 || buffer.length > 40 * 1024 * 1024 || !signature(buffer)) throw new Error("invalid-artwork-file");
  if (!safe(base) || !EXTENSIONS.includes(extension)) throw new Error("invalid-artwork-destination");
  await fs.promises.mkdir(dir, { recursive: true });
  const destination = fixedPath || path.join(dir, base + extension);
  if (path.dirname(path.resolve(destination)) !== path.resolve(dir)) throw new Error("invalid-artwork-destination");
  const temporary = path.join(dir, `.artwork-${crypto.randomUUID()}.tmp`);
  await fs.promises.writeFile(temporary, buffer, { flag: "wx" });
  let release;
  try {
    release = await lock(dir, type);
    if (!canPublish()) return { ok: false, code: "superseded" };
    const protectedFile = !manual && protectedPath(dir, type);
    if (protectedFile) {
      const file = path.join(dir, "sources.json"), current = read(file);
      if (url) writeJsonAtomicSync(file, { ...current, providers: { ...current.providers, [type]: { ...current.providers?.[type], [source]: url } } });
      return { ok: true, existing: true, path: protectedFile, code: "manual-preserved" };
    }
    // Large file I/O stays asynchronous. The final publish/index update below
    // is synchronous while the directory lock is held.
    const sourcesFile = path.join(dir, "sources.json"), previous = read(sourcesFile);
    const artwork = previous.artwork && typeof previous.artwork === "object" ? previous.artwork : {};
    const backup = path.join(dir, `.artwork-${crypto.randomUUID()}.previous`);
    const hadPrevious = fs.existsSync(destination);
    let recoveryRequired = false;
    let published = false;
    const landscapeFile = path.join(dir, "landscape-source.txt");
    let landscapeBefore; try { landscapeBefore = fs.readFileSync(landscapeFile); } catch {}
    try {
      if (hadPrevious) await fs.promises.copyFile(destination, backup);
      if (!canPublish()) return { ok: false, code: "superseded" };
      fs.renameSync(temporary, destination);
      published = true;
      if (type === "header") fs.writeFileSync(landscapeFile, "header");
      writeJsonAtomicSync(sourcesFile, { ...previous, providers: { ...previous.providers, [type]: { ...previous.providers?.[type], ...(url ? { [source]: url } : {}) } }, artwork: { ...artwork, [type]: {
        source, url, manual, file: path.basename(destination), updatedAt: Date.now(),
      } } });
    } catch (error) {
      if (published && hadPrevious) {
        try { fs.renameSync(backup, destination); }
        catch (restoreError) {
          recoveryRequired = true;
          require("./logger").createLogger("covers").error("artwork:restore-failed", { path: destination, backup, error: restoreError.message });
        }
      }
      else if (published) try { fs.unlinkSync(destination); } catch {}
      if (published && type === "header") try { if (landscapeBefore) fs.writeFileSync(landscapeFile, landscapeBefore); else fs.unlinkSync(landscapeFile); } catch {}
      throw error;
    } finally { if (!recoveryRequired) try { fs.unlinkSync(backup); } catch {} }
    for (const ext of EXTENSIONS) {
      const sibling = path.join(dir, base + ext);
      const same = process.platform === "win32" ? path.resolve(sibling).toLowerCase() === path.resolve(destination).toLowerCase() : path.resolve(sibling) === path.resolve(destination);
      if (same) continue;
      for (let attempt = 0; attempt < 3; attempt++) {
        try { await fs.promises.unlink(sibling); break; }
        catch (error) {
          if (error.code === "ENOENT") break;
          if (attempt < 2 && ["EBUSY", "EPERM", "EACCES"].includes(error.code)) { await new Promise(resolve => setTimeout(resolve, 40 * (attempt + 1))); continue; }
          require("./logger").createLogger("covers").warn("artwork:obsolete-file-retained", { path: sibling, selected: destination, type, code: error.code, error: error.message });
          break;
        }
      }
    }
    return { ok: true, path: destination, source, type };
  } finally { release?.(); try { await fs.promises.unlink(temporary); } catch {} }
}
async function importBuffer(outputPath, buffer, { source = "import", url = "" } = {}) {
  buffer = Buffer.from(buffer);
  await require("./game-artwork-validation").decodeImage(buffer);
  const dir = path.dirname(outputPath), base = path.basename(outputPath, path.extname(outputPath));
  const type = base === "header" ? "header" : base === "game-cover-hero" ? "hero" : "cover";
  const result = await publish({ dir, base, type, buffer, extension: path.extname(outputPath).toLowerCase(), source, url, fixedPath: outputPath });
  return result.path || "";
}
async function rememberUrls(dir, values) {
  await fs.promises.mkdir(dir, { recursive: true });
  const release = await lock(dir, "sources");
  try { const file = path.join(dir, "sources.json"); writeJsonAtomicSync(file, { ...read(file), ...values }); }
  finally { release(); }
}
async function importUrl(url, outputPath, options = {}) {
  const dir = path.dirname(outputPath), name = path.basename(outputPath, path.extname(outputPath));
  const type = name === "header" ? "header" : name === "game-cover-hero" ? "hero" : "cover";
  const chosen = protectedPath(dir, type);
  if (chosen) {
    const release = await lock(dir, type);
    try {
      const file = path.join(dir, "sources.json"), current = read(file);
      writeJsonAtomicSync(file, { ...current, providers: { ...current.providers, [type]: { ...current.providers?.[type], [options.source || "import"]: url } } });
    } finally { release(); }
    return chosen;
  }
  const buffer = await require("./game-artwork-http").download(url, options);
  return importBuffer(outputPath, buffer, { source: options.source, url });
}
module.exports = { TYPES, EXTENSIONS, directory, basename, candidatePaths, existingAt, selection, protectedPath, signature, publish, importBuffer, importUrl, rememberUrls, read };
