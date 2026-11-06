"use strict";

// Validate browser-only image formats without displaying/focusing a window or
// sharing the application's renderer, credentials or scraping contexts.
let worker = null, chain = Promise.resolve(), idle = null, stopping = false, hooked = false;
function close() {
  clearTimeout(idle); idle = null;
  const previous = worker; worker = null;
  if (previous) void previous.then(value => value.close()).catch(() => {});
}
async function createWorker() {
  let electron = {};
  // ELECTRON_RUN_AS_NODE processes have the Electron version/executable but
  // may have neither the main-process API nor the development npm package.
  if (process.versions.electron) try { electron = require("electron"); } catch {}
  if (electron.WebContentsView && electron.app) {
    if (!hooked) { hooked = true; electron.app.once("will-quit", () => { stopping = true; close(); }); }
    await electron.app.whenReady();
    if (stopping) throw new Error("artwork-decoder-closing");
    const view = new electron.WebContentsView({ webPreferences: {
      sandbox: true, contextIsolation: true, nodeIntegration: false,
      backgroundThrottling: false, partition: "artwork-validation",
    } });
    const contents = view.webContents;
    const destroy = () => { if (!contents.isDestroyed()) contents.close({ waitForBeforeUnload: false }); };
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    contents.on("will-navigate", event => event.preventDefault());
    contents.session.setPermissionRequestHandler((_contents, _permission, done) => done(false));
    contents.session.setPermissionCheckHandler(() => false);
    try {
      await contents.loadURL("data:text/html,<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'\">");
      return { view, evaluate: (fn, argument) => contents.executeJavaScript(`(${fn.toString()})(${JSON.stringify(argument)})`), close: destroy };
    } catch (error) { destroy(); throw error; }
  }
  // Standalone Node generators use the existing Electron browser adapter. This
  // requires no downloaded Chromium and owns its context independently.
  const browser = await require("./playwright-runtime").launchBrowserSafe();
  try {
    const context = await browser.newContext(), page = await context.newPage();
    await page.route("**/*", route => route.abort());
    return { evaluate: (fn, argument) => page.evaluate(fn, argument), close: () => browser.close() };
  } catch (error) { await browser.close(); throw error; }
}
function decode(buffer, mime) {
  const operation = chain.then(async () => {
    if (stopping) throw new Error("artwork-decoder-closing");
    clearTimeout(idle);
    let timer;
    try {
      return await Promise.race([
        (async () => {
          const active = worker ||= createWorker(), page = await active;
          if (active !== worker) throw new Error("artwork-decoder-closed");
          return page.evaluate(async ({ base64, mime }) => {
            const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
            const bitmap = await createImageBitmap(new Blob([bytes], { type: mime }));
            try { return { width: bitmap.width, height: bitmap.height }; }
            finally { bitmap.close(); }
          }, { base64: buffer.toString("base64"), mime });
        })(),
        new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error("artwork-decode-timeout")), 12000); }),
      ]);
    } catch (error) { close(); throw error; }
    finally {
      clearTimeout(timer);
      idle = setTimeout(close, process.versions.electron ? 5000 : 500);
      idle.unref?.();
    }
  });
  chain = operation.catch(() => {});
  return operation;
}
module.exports = { decode, close };
