"use strict";
const { pathToFileURL } = require("url");
const { findAchievementMedia, findGameMedia } = require("./achievement-media");

function registerAchievementMedia({ ipcMain, getMainWindow, owner, validateOwner, getContext, roots, showMain, logger, getConfigNames }) {
  let ready = null, pending = null, sequence = 0;
  const attached = new WeakSet();
  function flush() {
    const window = getMainWindow();
    if (!pending || !window || window.isDestroyed() || window.webContents.isLoadingMainFrame() || ready !== window.webContents) return;
    window.webContents.send("achievement-media:show", pending);
    logger.info("achievement-media:show", { configName: pending.configName, achievementId: pending.achievementId,
      kind: pending.kind, files: pending.files.length });
    pending = null;
  }
  ipcMain.on("achievement-media:ready", event => {
    const window = getMainWindow();
    if (!window || event.sender !== window.webContents || event.senderFrame !== event.sender.mainFrame) return;
    ready = event.sender;
    if (!attached.has(ready)) {
      const wc = ready;
      attached.add(wc);
      // Theme previews load an iframe after this viewer is already ready.
      // Only replacing the main document invalidates its registered listener.
      wc.on("did-start-navigation", (details, _url, isInPlace, isMainFrame) => {
        if ((details.isMainFrame ?? isMainFrame) &&
          !(details.isSameDocument ?? isInPlace) && ready === wc) ready = null;
      });
      wc.on("did-finish-load", flush);
      wc.once("destroyed", () => { if (ready === wc) ready = null; });
    }
    flush();
  });
  async function resolve(event, payload, all = false) {
    if (event.senderFrame !== event.sender.mainFrame) throw new Error("Invalid achievement media sender");
    const identity = owner(event, payload.configName);
    const context = await getContext(payload.configName);
    const media = context ? await (all ? findGameMedia : findAchievementMedia)({ ...context, configName: payload.configName, achievementId: payload.achievementId, roots: roots(), getConfigNames }) : { screenshot: [], record: [] };
    validateOwner(event, payload.configName, identity);
    return media;
  }
  ipcMain.handle("achievement-media:list", async (event, payload = {}) => {
    try { const media = await resolve(event, payload); return { screenshot: media.screenshot.length, record: media.record.length }; }
    catch (error) {
      logger.warn("achievement-media:list-failed", { configName: payload.configName, achievementId: payload.achievementId, error: error.message });
      return { screenshot: 0, record: 0 };
    }
  });
  ipcMain.handle("achievement-media:gallery", async (event, payload = {}) => {
    try {
      if (event.sender !== getMainWindow()?.webContents) throw new Error("Gallery requires the application window");
      const media = await resolve(event, payload, true);
      return Object.fromEntries(Object.entries(media).map(([kind, files]) => [kind,
        files.map(({ path, ...file }) => ({ ...file, url: pathToFileURL(path).href }))]));
    } catch (error) {
      logger.warn("achievement-media:gallery-failed", { configName: payload.configName, error: error.message });
      return { screenshot: [], record: [], error: "unavailable" };
    }
  });
  ipcMain.handle("achievement-media:open", async (event, payload = {}) => {
    try {
      if (!["screenshot", "record"].includes(payload.kind)) throw new Error("Invalid achievement media type");
      const request = ++sequence;
      const media = await resolve(event, payload), files = media[payload.kind];
      if (request !== sequence) return { success: false, error: "superseded" };
      if (!files.length) {
        logger.info("achievement-media:unavailable", { configName: payload.configName, achievementId: payload.achievementId, kind: payload.kind });
        return { success: false, error: "unavailable" };
      }
      if (payload.filename != null) {
        const index = files.findIndex(file => file.filename === payload.filename);
        if (index < 0) return { success: false, error: "unavailable" };
        files.unshift(...files.splice(index, 1));
      }
      pending = { configName: payload.configName, achievementId: payload.achievementId, kind: payload.kind,
        files: files.map(({ path, ...file }) => ({ ...file, url: pathToFileURL(path).href })) };
      logger.info("achievement-media:queued", { configName: pending.configName, achievementId: pending.achievementId,
        kind: pending.kind, files: pending.files.length });
      showMain(); flush();
      return { success: true };
    } catch (error) { logger.warn("achievement-media:open-failed", { configName: payload.configName, achievementId: payload.achievementId, error: error.message }); return { success: false, error: "unavailable" }; }
  });
}
module.exports = { registerAchievementMedia };
