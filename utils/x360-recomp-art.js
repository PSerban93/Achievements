"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const axios = require("axios");
const { titleId } = require("./x360-recomp-state");
const pending = new Map();
const iconMisses = new Map();
let iconHostRetryAt = 0;

async function fillAchievementIcons(id, schemaDir, entries, options = {}) {
  const safe = titleId(id), queue = entries.filter((entry) => !entry.icon &&
    Number.isSafeInteger(entry.imageId) && entry.imageId > 0 && entry.imageId <= 0xffffffff);
  if (!safe || !queue.length) return { downloaded: 0, missing: [] };
  let downloaded = 0;
  const deadline = Date.now() + 30000;
  const worker = async () => {
    while (queue.length && Date.now() < deadline && !options.isCancelled?.()) {
      const entry = queue.shift(), key = `${safe}:${entry.imageId}`;
      const relative = `img/${entry.name}.png`, destination = path.join(schemaDir, relative);
      if (fs.existsSync(destination)) { entry.icon = entry.icon_gray = relative; continue; }
      if (Date.now() < iconHostRetryAt || Date.now() < (iconMisses.get(key) || 0)) continue;
      let temporary, answered = false;
      try {
        for (const protocol of ["https", "http"]) {
          try {
            const response = await axios.get(`${protocol}://image.xboxlive.com/global/t.${safe}/ach/0/${entry.imageId.toString(16)}`, {
              responseType: "arraybuffer", timeout: Math.min(8000, Math.max(1, deadline - Date.now())),
              maxContentLength: 8 * 1024 * 1024, maxRedirects: 3,
            });
            answered = true;
            const bytes = Buffer.from(response.data);
            if (bytes.length < 24 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) continue;
            if (options.isCancelled?.()) return;
            await fs.promises.mkdir(path.dirname(destination), { recursive: true });
            temporary = path.join(path.dirname(destination), `.icon-${crypto.randomBytes(8).toString("hex")}.tmp`);
            await fs.promises.writeFile(temporary, bytes, { flag: "wx" });
            await fs.promises.rename(temporary, destination);
            entry.icon = entry.icon_gray = relative; downloaded++; break;
          } catch (error) {
            if (error.response) answered = true;
            if (error.response?.status === 404) { iconMisses.set(key, Date.now() + 10 * 60 * 1000); break; }
          }
        }
        if (!answered) iconHostRetryAt = Date.now() + 60000;
      } finally { if (temporary) await fs.promises.unlink(temporary).catch(() => {}); }
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, queue.length) }, worker));
  return { downloaded, missing: entries.filter((entry) => !entry.icon).map((entry) => entry.name) };
}

function artworkUrls(id, variant = "portrait") {
  const safe = titleId(id);
  if (!safe || !["portrait", "landscape"].includes(variant)) return [];
  const file = variant === "portrait" ? "boxartlg.jpg" : "background.jpg";
  const resource = `/content/images/66acd000-77fe-1000-9115-d802${safe.toLowerCase()}/1033/${file}`;
  return [`https://download-ssl.xbox.com${resource}`, `http://download.xbox.com${resource}`];
}

async function ensurePortrait(userData, id) {
  const safe = titleId(id);
  if (!safe) return null;
  const directory = path.join(userData, "images", "x360recomp", safe);
  const destination = path.join(directory, `${safe}.jpg`);
  const key = process.platform === "win32" ? destination.toLowerCase() : destination;
  if (pending.has(key)) return pending.get(key);
  const task = (async () => {
    if (fs.existsSync(destination) && fs.statSync(destination).size > 0) return destination;
    for (const url of artworkUrls(safe)) {
      let temporary;
      try {
        const response = await axios.get(url, { responseType: "arraybuffer", timeout: 8000, maxContentLength: 8 * 1024 * 1024 });
        const bytes = Buffer.from(response.data);
        if (bytes.length < 12 || bytes[0] !== 0xff || bytes[1] !== 0xd8) continue;
        await fs.promises.mkdir(directory, { recursive: true });
        temporary = path.join(directory, `.portrait-${crypto.randomBytes(8).toString("hex")}.tmp`);
        await fs.promises.writeFile(temporary, bytes, { flag: "wx" });
        await fs.promises.rename(temporary, destination);
        return destination;
      } catch {} finally { if (temporary) await fs.promises.unlink(temporary).catch(() => {}); }
    }
    return null;
  })().finally(() => pending.delete(key));
  pending.set(key, task);
  return task;
}

module.exports = { artworkUrls, ensurePortrait, fillAchievementIcons };
