"use strict";
const policy = require("./game-artwork-policy");
function createImageProcessor(nativeImage) {
  return async (buffer, extension, kind = "hero", config = {}) => {
    const decoded = await require("./game-artwork-validation").decodeImage(buffer, nativeImage);
    let image = decoded.image;
    const size = decoded.size;
    if (kind === "hero" && !policy.isHero(size)) throw new Error("artwork-too-small-for-hero");
    const retro = config.platform === "retroachievements";
    if (kind === "cover" && !(retro ? size.width >= 32 && size.height >= 32 : size.width >= 160 && size.height >= 200 && size.width / size.height <= 1.35)) throw new Error("invalid-portrait-dimensions");
    if (kind === "header" && !(retro ? size.width >= 32 && size.height >= 32 : size.width >= 320 && size.height >= 120 && size.width / size.height >= 1.3)) throw new Error("invalid-landscape-dimensions");
    const maxWidth = kind === "cover" ? 1200 : 3840, maxHeight = kind === "cover" ? 1800 : 2160;
    const ratio = Math.min(1, maxWidth / size.width, maxHeight / size.height);
    if (ratio === 1 && [".gif", ".webp"].includes(extension)) return { buffer, extension };
    if (image.isEmpty()) {
      if (ratio < 1) throw new Error("artwork-needs-resizing");
      return { buffer, extension };
    }
    if (ratio < 1) image = image.resize({ width: Math.round(size.width * ratio), height: Math.round(size.height * ratio), quality: "best" });
    if (kind === "hero" && !policy.isHero(image.getSize())) throw new Error("artwork-too-small-after-resize");
    if (ratio < 1 || buffer.length > 15 * 1024 * 1024 || ![".jpg", ".jpeg", ".png", ".webp", ".gif"].includes(extension)) return { buffer: image.toJPEG(90), extension: ".jpg" };
    return { buffer, extension };
  };
}
module.exports = { createImageProcessor };
