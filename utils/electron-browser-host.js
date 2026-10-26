"use strict";

// This process only hosts scraping pages, with its own temporary profile.
function startBrowserHost() {
  const { app, BrowserWindow, session } = require("electron");
  const profile = process.env.ACHIEVEMENTS_BROWSER_PROFILE;
  if (!profile || !process.send) { app.exit(1); return; }
  app.setPath("userData", profile);
  app.setPath("sessionData", profile);
  app.on("window-all-closed", () => {});
  process.once("disconnect", () => app.exit(0));
  app.whenReady().then(() => {
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, done) => done(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    session.defaultSession.on("will-download", (event) => event.preventDefault());
    process.on("message", async (message) => {
      if (message?.type !== "ach-browser:request") return;
      const reply = (result, error) => {
        if (process.connected) process.send({ type: "ach-browser:reply", id: message.id, result, error });
      };
      try {
        if (message.command === "close") { reply(true); app.exit(0); return; }
        if (message.command !== "new-page") throw new Error("Unknown browser host command");
        const options = message.options || {};
        const dimension = (value, fallback) => Math.max(100, Math.min(8192, Number(value) || fallback));
        const window = new BrowserWindow({
          show: options.visible === true,
          width: dimension(options.viewport?.width, 1400),
          height: dimension(options.viewport?.height, 1000),
          useContentSize: true,
          autoHideMenuBar: true,
          webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
        });
        if (options.userAgent) window.webContents.setUserAgent(String(options.userAgent));
        window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
        await window.loadURL("about:blank");
        if (options.visible === true) window.show();
        reply({ visible: window.isVisible() });
      } catch (error) { reply(null, error.message); }
    });
    if (process.connected) process.send({ type: "ach-browser:ready" });
  }).catch(() => app.exit(1));
}

if (process.env.ACHIEVEMENTS_BROWSER_HELPER === "1") startBrowserHost();
module.exports = { startBrowserHost };
