"use strict";

const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const hosts = new Set();
process.once("exit", () => { for (const host of hosts) host.kill(); });

function resolveElectronExecutable() {
  if (process.versions.electron) return process.execPath;
  const configured = process.env.ACHIEVEMENTS_ELECTRON_EXECUTABLE;
  if (configured && path.isAbsolute(configured) && fs.existsSync(configured)) return configured;
  const executable = require("electron");
  if (typeof executable !== "string" || !fs.existsSync(executable)) {
    throw new Error("Electron executable is unavailable for browser extraction");
  }
  return executable;
}

async function createContext(options, launchOptions) {
  const profile = await fsp.mkdtemp(path.join(os.tmpdir(), "achievements-browser-"));
  const env = { ...process.env, ACHIEVEMENTS_BROWSER_HELPER: "1", ACHIEVEMENTS_BROWSER_PROFILE: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  const args = (launchOptions.args || []).filter((arg) =>
    !/^--(?:inspect|remote-debugging|user-data-dir|require|app)(?:[=-]|$)/i.test(arg));
  let child;
  try {
    child = spawn(resolveElectronExecutable(), [
      path.join(__dirname, "electron-browser-host.js"), ...args,
      "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0",
    ], { env, windowsHide: launchOptions.headless !== false, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  } catch (error) {
    await fsp.rm(profile, { recursive: true, force: true });
    throw error;
  }
  hosts.add(child);
  child.stdout.resume();
  let browser, closed = false, closing, sequence = 0;
  const pending = new Map();
  let resolveExit;
  const exited = new Promise((resolve) => { resolveExit = resolve; });
  const failure = new Error("Electron browser host exited");
  const stopped = () => {
    closed = true;
    hosts.delete(child);
    for (const request of pending.values()) request.reject(failure);
    pending.clear();
    resolveExit();
  };
  child.once("exit", stopped);
  child.once("error", stopped);
  child.on("message", (message) => {
    if (message?.type !== "ach-browser:reply") return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    message.error ? request.reject(new Error(message.error)) : request.resolve(message.result);
  });
  function request(command, options) {
    if (closed || !child.connected) return Promise.reject(failure);
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Electron browser ${command} timed out`));
      }, 15000);
      pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      child.send({ type: "ach-browser:request", id, command, options }, (error) => {
        if (error && pending.has(id)) {
          pending.get(id).reject(error);
          pending.delete(id);
        }
      });
    });
  }
  const close = () => closing ||= (async () => {
    if (!closed) {
      // IPC disconnect also closes the host when its owning process exits.
      if (child.connected) child.disconnect();
      const timer = setTimeout(() => child.kill(), 2000);
      try { await exited; } finally { clearTimeout(timer); }
    }
    await browser?.close().catch(() => {});
    await fsp.rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
  })();
  try {
    const endpoint = await new Promise((resolve, reject) => {
      let text = "", websocket, ready = false;
      const timer = setTimeout(() => finish(new Error("Electron browser startup timed out")), 30000);
      const finish = (error) => {
        clearTimeout(timer);
        child.stderr.off("data", data);
        child.off("message", message);
        child.off("error", failed);
        child.off("exit", failed);
        error ? reject(error) : resolve(websocket);
      };
      const check = () => { if (ready && websocket) finish(); };
      const data = (chunk) => {
        text = (text + chunk.toString()).slice(-16384);
        websocket = text.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/[^\s]+)/)?.[1];
        check();
      };
      const message = (value) => { if (value?.type === "ach-browser:ready") { ready = true; check(); } };
      const failed = (error) => finish(error instanceof Error ? error : new Error("Electron browser failed to start"));
      child.stderr.on("data", data);
      child.on("message", message);
      child.once("error", failed);
      child.once("exit", failed);
    });
    child.stderr.resume();
    browser = await require("playwright-core").chromium.connectOverCDP(endpoint, { timeout: 30000 });
    const context = browser.contexts()[0];
    if (!context) throw new Error("Electron browser context unavailable");
    if (options.extraHTTPHeaders) await context.setExtraHTTPHeaders(options.extraHTTPHeaders);
    let creatingPage = Promise.resolve();
    const newPage = () => {
      const operation = creatingPage.then(async () => {
        if (closed) throw failure;
        const waiting = context.waitForEvent("page", { timeout: 15000 });
        const [page, window] = await Promise.all([waiting, request("new-page", {
          viewport: options.viewport, userAgent: options.userAgent, visible: launchOptions.headless === false,
        })]);
        if (window.visible !== (launchOptions.headless === false)) {
          await page.close();
          throw new Error("Electron browser window visibility does not match the requested mode");
        }
        return page;
      });
      creatingPage = operation.catch(() => {});
      return operation;
    };
    if (options.storageState) {
      const state = typeof options.storageState === "string"
        ? JSON.parse(await fsp.readFile(options.storageState, "utf8")) : options.storageState;
      if (!state || typeof state !== "object" || Array.isArray(state) ||
          !Array.isArray(state.cookies || []) || !Array.isArray(state.origins || [])) {
        throw new Error("Invalid Electron browser storageState");
      }
      const origins = state.origins || [];
      for (const origin of origins) {
        if (!origin || !/^https?:\/\//.test(origin.origin) || new URL(origin.origin).origin !== origin.origin ||
            !Array.isArray(origin.localStorage || []) || (origin.localStorage || []).some((entry) =>
              typeof entry?.name !== "string" || typeof entry.value !== "string")) {
          throw new Error("Invalid Electron browser storageState origin");
        }
      }
      if (state.credentials?.length || origins.some((origin) => origin.indexedDB?.length || origin.opfs?.length)) {
        throw new Error("Electron browser storageState supports cookies and localStorage; additional storage types cannot be restored");
      }
      if (state.cookies?.length) await context.addCookies(state.cookies);
      if (origins.length) {
        // Playwright's setStorageState creates a CDP target, which Electron
        // does not support. Use our real BrowserWindow instead. Fulfil origin
        // navigation locally, so restoring state never contacts the website.
        const page = await newPage();
        try {
          await page.route("**/*", (route) => route.fulfill({ contentType: "text/html", body: "<!doctype html><html></html>" }));
          for (const origin of origins) {
            await page.goto(origin.origin, { waitUntil: "domcontentloaded", timeout: 15000 });
            await page.evaluate((entries) => {
              localStorage.clear();
              for (const { name, value } of entries) localStorage.setItem(name, value);
            }, origin.localStorage || []);
          }
        } finally { await page.close(); }
      }
    }
    return new Proxy(context, {
      get(target, key) {
        if (key === "close") return close;
        if (key === "newPage") return newPage;
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  } catch (error) { await close(); throw error; }
}

async function launchBrowserSafe(_packageName, launchOptions = {}) {
  let connected = true, closing;
  const contexts = new Set();
  return {
    isConnected: () => connected,
    async newContext(options = {}) {
      if (!connected) throw new Error("Electron browser is closed");
      const context = await createContext(options, launchOptions);
      if (!connected) { await context.close(); throw new Error("Electron browser is closed"); }
      contexts.add(context);
      return context;
    },
    async newPage(options = {}) {
      const context = await this.newContext(options);
      try {
        const page = await context.newPage();
        const closePage = page.close.bind(page);
        page.close = async (...args) => {
          try { await closePage(...args); } finally { await context.close(); }
        };
        return page;
      } catch (error) { await context.close(); throw error; }
    },
    close() {
      connected = false;
      return closing ||= Promise.allSettled([...contexts].map((context) => context.close())).then(() => contexts.clear());
    },
  };
}

function getPlaywrightRuntimeInfo() {
  return { engine: "electron", executablePath: resolveElectronExecutable(), separateChromium: false };
}

module.exports = { launchBrowserSafe, getPlaywrightRuntimeInfo };
