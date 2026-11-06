"use strict";
async function download(url, { httpClient = require("axios"), timeoutMs = 25000 } = {}) {
  if (!/^https?:\/\//i.test(String(url))) throw new Error("invalid-artwork-url");
  const response = await httpClient.get(url, {
    responseType: "arraybuffer", timeout: Math.max(3000, Math.min(25000, Number(timeoutMs) || 25000)),
    maxContentLength: 40 * 1024 * 1024, maxBodyLength: 40 * 1024 * 1024,
    validateStatus: status => status >= 200 && status < 300,
    headers: { "User-Agent": "Achievements", Accept: "image/*" },
  });
  const status = Number(response.status || 200), buffer = Buffer.from(response.data || []);
  if (status < 200 || status >= 300) throw new Error(`HTTP ${status}`);
  if (buffer.length < 12 || buffer.length > 40 * 1024 * 1024 || !require("./game-artwork-storage").signature(buffer)) throw new Error("invalid-artwork-response");
  return buffer;
}
module.exports = { download };
