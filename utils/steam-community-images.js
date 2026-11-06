"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const MODERN_BASES = [
  "https://shared.fastly.steamstatic.com/community_assets/images/apps",
  "https://shared.akamai.steamstatic.com/community_assets/images/apps",
];
const LEGACY_BASES = [
  "https://steamcdn-a.akamaihd.net/steamcommunity/public/images/apps",
  "https://cdn.cloudflare.steamstatic.com/steamcommunity/public/images/apps",
  "https://cdn.akamai.steamstatic.com/steamcommunity/public/images/apps",
];
const STEAM_HOSTS = new Set([
  ...MODERN_BASES, ...LEGACY_BASES,
  "https://cdn.steamstatic.com", "https://cdn.fastly.steamstatic.com",
  "https://shared.cloudflare.steamstatic.com", "https://shared.steamstatic.com",
  "https://media.steampowered.com",
].map((value) => new URL(value).hostname));
const pending = new Map();
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

function steamCommunityImageCandidates(appid, value) {
  const id = String(appid || "").trim();
  let input = String(value || "").trim();
  if (!input) return [];
  if (input.startsWith("//")) input = `https:${input}`;
  let filename = input;
  let original = "";
  if (/^https?:\/\//i.test(input)) {
    let url;
    try { url = new URL(input); } catch { return []; }
    original = input;
    const match = url.pathname.match(/^\/(?:steamcommunity\/public|community_assets)\/images\/apps\/(\d+)\/([^/]+)$/);
    // Do not reinterpret store artwork, another app's images or other providers.
    if (!STEAM_HOSTS.has(url.hostname) || url.port || url.username || url.password ||
        !match || match[1] !== id) return [original];
    try { filename = decodeURIComponent(match[2]); } catch { return [original]; }
  }
  if (!/^\d+$/.test(id) || !/^[^/\\?#:\s][^/\\?#:]*\.(?:jpe?g|png|webp|gif)$/i.test(filename) ||
      filename === "." || filename === "..") return original ? [original] : [];
  const suffix = `${id}/${encodeURIComponent(filename)}`;
  return [...new Set([
    ...MODERN_BASES.map((base) => `${base}/${suffix}`),
    ...(original ? [original] : []),
    ...LEGACY_BASES.map((base) => `${base}/${suffix}`),
  ])];
}

function normalizeSteamIconUrl(appid, value) {
  return steamCommunityImageCandidates(appid, value)[0] || "";
}

function isSteamImageFile(file) {
  let handle;
  try {
    handle = fs.openSync(file, "r");
    const stat = fs.fstatSync(handle);
    if (!stat.isFile() || stat.size < 20 || stat.size > MAX_IMAGE_BYTES) return false;
    // Inspect bounded headers/trailers rather than rereading every cached image
    // in full on each Steam Official update.
    const bytes = Buffer.alloc(Math.min(32, stat.size));
    const tail = Buffer.alloc(Math.min(32, stat.size));
    fs.readSync(handle, bytes, 0, bytes.length, 0);
    fs.readSync(handle, tail, 0, tail.length, stat.size - tail.length);
    if (bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) {
      return stat.size >= 45 && bytes.toString("ascii", 12, 16) === "IHDR" &&
        bytes.readUInt32BE(16) > 0 && bytes.readUInt32BE(20) > 0 &&
        tail.subarray(-8).equals(Buffer.from("49454e44ae426082", "hex"));
    }
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
      const end = tail.lastIndexOf(Buffer.from([0xff, 0xd9]));
      return end >= 0 && stat.size - tail.length + end >= 3;
    }
    if (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") {
      return stat.size >= 30 && bytes.readUInt32LE(4) + 8 === stat.size;
    }
    return /^(?:GIF87a|GIF89a)$/.test(bytes.toString("ascii", 0, 6)) &&
      bytes.readUInt16LE(6) > 0 && bytes.readUInt16LE(8) > 0 && tail[tail.length - 1] === 0x3b;
  } catch { return false; }
  finally { if (handle !== undefined) fs.closeSync(handle); }
}

// Keep each caller's transport and logging; share CDN selection, validation and
// publication. A failed request never truncates an existing destination file.
function downloadSteamCommunityImage({ appid, value, dest, download, timeoutMs = 20000, onFailure }) {
  const target = path.resolve(dest);
  const key = process.platform === "win32" ? target.toLowerCase() : target;
  if (pending.has(key)) return pending.get(key);
  const operation = (async () => {
    if (isSteamImageFile(target)) return true;
    const urls = steamCommunityImageCandidates(appid, value);
    const deadline = Date.now() + timeoutMs;
    const attempted = [];
    let lastError = "";
    for (const url of urls) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const temporary = `${target}.${crypto.randomBytes(8).toString("hex")}.image-tmp`;
      attempted.push(url);
      try {
        await fs.promises.mkdir(path.dirname(target), { recursive: true });
        const ok = await download(url, temporary, Math.min(5000, remaining));
        if (ok && isSteamImageFile(temporary)) {
          await fs.promises.rename(temporary, target);
          return true;
        }
      } catch (error) { lastError = String(error?.message || error); }
      finally { await fs.promises.rm(temporary, { force: true }).catch(() => {}); }
    }
    try { onFailure?.({ appid: String(appid), dest: target, attempted, error: lastError }); } catch {}
    return false;
  })();
  pending.set(key, operation);
  const finish = () => { if (pending.get(key) === operation) pending.delete(key); };
  operation.then(finish, finish);
  return operation;
}

module.exports = {
  steamCommunityImageCandidates,
  normalizeSteamIconUrl,
  isSteamImageFile,
  downloadSteamCommunityImage,
};
