const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("customApi", {
  minimizeWindow: () => ipcRenderer.send("minimize-window"),
  maximizeWindow: () => ipcRenderer.send("maximize-window"),
  closeWindow: () => ipcRenderer.send("close-window"),
});
let overlayDataHandler = null;
contextBridge.exposeInMainWorld("api", {
  // Config management
  saveConfig: (config) => ipcRenderer.invoke("saveConfig", config),
  regenerateSchema: (payload) =>
    ipcRenderer.invoke("schema:regenerate", payload),
  getActiveGenerationProgress: () =>
    ipcRenderer.invoke("generation:progress:get-active"),
  loadConfigs: () => ipcRenderer.invoke("loadConfigs"),
  loadDashboardSummary: () => ipcRenderer.invoke("dashboard:summary"),
  selectFolder: () => ipcRenderer.invoke("selectFolder"),
  deleteConfig: (configName, options = {}) => {
    if (configName && typeof configName === "object") {
      return ipcRenderer.invoke("delete-config", configName);
    }
    return ipcRenderer.invoke("delete-config", {
      configName,
      ...(options || {}),
    });
  },
  clearActiveConfig: (payload = {}) =>
    ipcRenderer.invoke("config:clear-active", payload),
  blacklistConfig: (payload) => ipcRenderer.invoke("config:blacklist", payload),
  getBlacklist: () => ipcRenderer.invoke("blacklist:list"),
  resetBlacklist: () => ipcRenderer.invoke("blacklist:reset"),
  isAppIdBlacklisted: (appid) => ipcRenderer.invoke("blacklist:check", appid),
  getConfigByAppId: (appid) => ipcRenderer.invoke("config:get-by-appid", appid),

  // Achievements loading
  loadAchievementData: async (configName, options = {}) => {
    try {
      return await ipcRenderer.invoke("load-achievements", configName, options);
    } catch (e) {
      return { achievements: null, error: String(e?.message || e) };
    }
  },
  loadSavedAchievements: async (configName) => {
    try {
      return await ipcRenderer.invoke("load-saved-achievements", configName);
    } catch (e) {
      return { achievements: {}, error: String(e?.message || e) };
    }
  },
  refreshSelectedConfigRarity: async (configName) => {
    try {
      return await ipcRenderer.invoke("rarity:refresh-selected-config", {
        configName,
      });
    } catch (e) {
      return {
        success: false,
        code: "ipc-failed",
        message: String(e?.message || e),
      };
    }
  },

  // Presets
  loadPresets: () => ipcRenderer.invoke("load-presets"),

  // Notification
  showNotification: (data) => ipcRenderer.send("show-notification", data),
  showTestNotification: (options) =>
    ipcRenderer.send("show-test-notification", options),
  queueAchievementNotification: (data) =>
    ipcRenderer.send("queue-achievement-notification", data),
  queueProgressNotification: (data) =>
    ipcRenderer.send("queue-progress-notification", data),
  onNotification: (callback) =>
    ipcRenderer.on("show-notification", (event, data) => callback(data)),
  onNotify: (callback) => ipcRenderer.on("notify", (_, data) => callback(data)),
  notifyMain: (msg) => ipcRenderer.send("notify-from-child", msg),
  once: (channel, callback) => {
    ipcRenderer.once(channel, (_, data) => callback(data));
  },
  disableProgress: (value) => ipcRenderer.send("set-disable-progress", value),
  setDisablePlaytime: (value) =>
    ipcRenderer.send("set-disable-playtime", value),
  getDisablePlaytimeSync: () => ipcRenderer.sendSync("disable-playtime-check"),
  resolveIconUrl: (configPath, rel) =>
    ipcRenderer.invoke("resolve-icon-url", configPath, rel),
  getDisplayWorkArea: () => ipcRenderer.invoke("get-display-workarea"),
  // Event for receiving a new monitored achievement
  onNewAchievement: (callback) =>
    ipcRenderer.on("new-achievement", (event, data) => callback(data)),
  onRefreshAchievementsTable: (callback) =>
    ipcRenderer.on("refresh-achievements-table", (event, data) =>
      callback(data),
    ),

  // Update the configuration (now uses the 'update-config' event)
  updateConfig: (configData) => ipcRenderer.send("update-config", configData),
  toggleOverlay: (selectedConfig) =>
    ipcRenderer.send("toggle-overlay", selectedConfig),
  syncAchievementTableViewState: (state) =>
    ipcRenderer.send("ach-table:view-state", state),
  onLoadOverlayData: (callback) => {
    if (overlayDataHandler) {
      ipcRenderer.removeListener("load-overlay-data", overlayDataHandler);
      overlayDataHandler = null;
    }
    if (typeof callback !== "function") return;
    overlayDataHandler = (_event, config) => callback(config);
    ipcRenderer.on("load-overlay-data", overlayDataHandler);
  },
  onToggleOverlayShortcut: (callback) =>
    ipcRenderer.on("toggle-overlay-shortcut", () => callback()),
  onSetLanguage: (callback) =>
    ipcRenderer.on("set-language", (event, lang) => callback(lang)),

  // Other functionalities
  savePreferences: (prefs) => ipcRenderer.invoke("preferences:update", prefs),
  updatePreferences: (prefs) => ipcRenderer.invoke("preferences:update", prefs),
  loadPreferences: () => ipcRenderer.invoke("load-preferences"),
  listSteamOfficialAccounts: () =>
    ipcRenderer.invoke("steam-official:list-accounts"),
  getSounds: () => ipcRenderer.invoke("get-sound-files"),
  getSoundFullPath: (fileName) =>
    ipcRenderer.invoke("get-sound-path", fileName),
  onPlaySound: (callback) =>
    ipcRenderer.on("play-sound", (event, sound) => callback(sound)),
  onProgressUpdate: (callback) =>
    ipcRenderer.on("show-progress", (event, data) => callback(data)),
  closeNotificationWindow: () => ipcRenderer.send("close-notification-window"),
  notificationRenderReady: () =>
    ipcRenderer.send("notification-render-ready"),
  parseStatsBin: (filePath) => ipcRenderer.invoke("parse-stats-bin", filePath),
  selectFile: () => ipcRenderer.invoke("select-file"),
  getConfigByName: async (name) => {
    try {
      return await ipcRenderer.invoke("get-config-by-name", name);
    } catch (e) {
      return { __failed: true, __error: String(e?.message || e), name };
    }
  },
  renameAndSaveConfig: (oldName, config) =>
    ipcRenderer.invoke("renameAndSaveConfig", oldName, config),
  selectExecutable: () => ipcRenderer.invoke("selectExecutable"),
  launchExecutable: (exe, args) =>
    ipcRenderer.invoke("launchExecutable", exe, args),
  requestPlatinumManual: (payload) =>
    ipcRenderer.invoke("platinum:manual", payload),
  onAchievementsMissing: (callback) =>
    ipcRenderer.on("achievements-missing", (e, configName) =>
      callback(configName),
    ),
  logCoverEvent: (level, message, meta) =>
    ipcRenderer.invoke("covers:ui-log", { level, message, meta }),
  logUiEvent: (level, message, meta) =>
    ipcRenderer.invoke("ui:log", { level, message, meta }),
  logOverlayEvent: (level, message, meta) =>
    ipcRenderer.invoke("overlay:log", { level, message, meta }),
  overlayVisibilityAck: (payload) =>
    ipcRenderer.send("overlay:visibility-ack", payload),
  checkLocalGameImage: (appid, platform) =>
    ipcRenderer.invoke("checkLocalGameImage", appid, platform),
  saveGameImage: (appid, buffer, platform) =>
    ipcRenderer.invoke("saveGameImage", appid, buffer, platform),
  onImageUpdate: (callback) =>
    ipcRenderer.on("update-image", (_, url) => callback(url)),
  on: (channel, callback) =>
    ipcRenderer.on(channel, (_, data) => callback(data)),
  setZoom: (zoomFactor) => ipcRenderer.send("set-zoom", zoomFactor),
  updateOverlayShortcut: (combo) =>
    ipcRenderer.send("update-overlay-shortcut", combo),
  requestCurrentConfig: () => ipcRenderer.send("request-current-config"),
  getWindowPosition: () => ipcRenderer.invoke("window:get-position"),
  setWindowPosition: (x, y) =>
    ipcRenderer.send("window:set-position", { x, y }),
  setOverlayDragRegionHeight: (height) =>
    ipcRenderer.send("overlay:drag-region", { height }),
  requestOverlayFocus: () => ipcRenderer.send("overlay:request-focus"),
  // language
  refreshUILanguage: (language) =>
    ipcRenderer.send("refresh-ui-after-language-change", language),
  setLanguage: (lang) => {
    window.currentLang = lang;
  },
  onConfigsChanged: (handler) => ipcRenderer.on("configs:changed", handler),
  onSchemaReady: (handler) => ipcRenderer.on("config:schema-ready", handler),
  onAutoSelectConfig: (handler) =>
    ipcRenderer.on("auto-select-config", (_e, name) => handler(name)),
  getBootStatus: () => ipcRenderer.invoke("boot:status"),
  getAppVersion: () => ipcRenderer.invoke("app:get-version"),
  bootOverlayHidden: () => ipcRenderer.send("boot:overlay-hidden"),
  getBootOnboardingState: () => ipcRenderer.invoke("boot:onboarding:get-state"),
  discoverBootOnboardingFolders: () =>
    ipcRenderer.invoke("boot:onboarding:discover-folders"),
  applyBootOnboardingSelection: (selectedPaths = []) =>
    ipcRenderer.invoke("boot:onboarding:apply-selection", { selectedPaths }),
  skipBootOnboarding: () => ipcRenderer.invoke("boot:onboarding:skip-all"),
  getSteamDbCover: (payload) => ipcRenderer.invoke("covers:steamdb", payload),
  getSteamGridDbCover: (payload) =>
    ipcRenderer.invoke("covers:steamgriddb", payload),
  openExternalUrl: (url) => ipcRenderer.invoke("open-external-url", url),
  trayAction: (action) => ipcRenderer.send("tray:action", action),
  setStartWithWindows: (enabled) =>
    ipcRenderer.invoke("startup:set-start-with-windows", enabled),
  getStartWithWindows: () =>
    ipcRenderer.invoke("startup:get-start-with-windows"),
  getTotalPlaytime: (configName) =>
    ipcRenderer.invoke("playtime:get-total", configName),
  setDashboardOpen: (state) => ipcRenderer.invoke("dashboard:set-open", state),
  isDashboardOpen: () => ipcRenderer.invoke("dashboard:is-open"),
  dashboardReady: () => ipcRenderer.send("dashboard:ready"),
  onDashboardPollPause: (handler) =>
    ipcRenderer.on("dashboard:poll-pause", (_e, state) => handler(state)),
  onOverlayControllerRuntimeState: (callback) => {
    if (typeof callback !== "function") return () => {};
    const handler = (_event, data) => callback(data);
    ipcRenderer.on("overlay-controller-runtime-state", handler);
    return () =>
      ipcRenderer.removeListener("overlay-controller-runtime-state", handler);
  },
  onAppUpdateAvailable: (callback) => {
    if (typeof callback !== "function") return () => {};
    const handler = (_event, data) => callback(data);
    ipcRenderer.on("app-update:available", handler);
    return () => ipcRenderer.removeListener("app-update:available", handler);
  },
  onAppUpdateDownloaded: (callback) => {
    if (typeof callback !== "function") return () => {};
    const handler = (_event, data) => callback(data);
    ipcRenderer.on("app-update:downloaded", handler);
    return () => ipcRenderer.removeListener("app-update:downloaded", handler);
  },
  downloadAppUpdate: () => ipcRenderer.invoke("app:update-download"),
  installAppUpdate: () => ipcRenderer.invoke("app:update-install"),
  onPlaytimeUpdate: (callback) => {
    if (typeof callback !== "function") return () => {};
    const handler = (_event, data) => callback(data);
    ipcRenderer.on("playtime:update", handler);
    return () => ipcRenderer.removeListener("playtime:update", handler);
  },
  getSteamLookupAppId: (appid) =>
    ipcRenderer.invoke("uplay:steam-appid", appid),
});

contextBridge.exposeInMainWorld("electron", {
  ipcRenderer: {
    on: (channel, func) => {
      const validChannels = [
        "window-state-change",
        "window-fullscreen-change",
        "notify",
        "achievements-missing",
        "show-progress",
        "show-playtime",
        "playtime:update",
        "start-close-animation",
        "configs:changed",
        "refresh-achievements-table",
        "auto-select-config",
        "achievements:file-updated",
        "update-image",
        "play-sound",
        "achgen:log",
        "set-language",
        "load-overlay-data",
        "overlay-controller-runtime-state",
        "show-notification",
        "zoom-factor-changed",
        "request-current-config",
        "tray:language-changed",
      ];
      if (validChannels.includes(channel)) {
        ipcRenderer.on(channel, (event, ...args) => func(...args));
      }
    },
    send: (channel, data) => {
      const validChannels = [
        "refresh-ui-after-language-change",
        "update-overlay-shortcut",
        "close-playtime-window",
        "request-current-config",
      ];
      if (validChannels.includes(channel)) {
        ipcRenderer.send(channel, data);
      }
    },
    invoke: (channel, ...args) => {
      const valid = [
        "folders:list",
        "folders:add",
        "folders:remove",
        "folders:rescan",
        "folders:block",
        "folders:unblock",
        "config:blacklist",
        "saveConfig",
        "loadConfigs",
        "selectFolder",
        "delete-config",
        "load-achievements",
        "load-saved-achievements",
        "load-presets",
        "preferences:update",
        "save-preferences",
        "load-preferences",
        "steam-official:list-accounts",
        "get-sound-files",
        "get-sound-path",
        "resolve-icon-url",
        "get-config-by-name",
        "renameAndSaveConfig",
        "selectExecutable",
        "launchExecutable",
        "checkLocalGameImage",
        "saveGameImage",
        "generate-auto-configs",
        "blacklist:list",
        "blacklist:reset",
        "ui:confirm",
        "ui:refocus",
        "achgen:get-backlog",
        "request-current-config",
        "uplay:steam-appid",
        "dashboard:set-open",
        "dashboard:is-open",
        "dashboard:poll-pause",
        "boot:onboarding:get-state",
        "boot:onboarding:discover-folders",
        "boot:onboarding:apply-selection",
        "boot:onboarding:skip-all",
      ];
      if (!valid.includes(channel))
        throw new Error(`Blocked invoke on channel: ${channel}`);
      return ipcRenderer.invoke(channel, ...args);
    },
  },
});

contextBridge.exposeInMainWorld("autoConfigApi", {
  generateConfigs: (folderPath) =>
    ipcRenderer.invoke("generate-auto-configs", folderPath),
});

(function () {
  const normalizeFileUrl = (raw) => {
    if (!raw) return "";
    const s = String(raw);
    return s.startsWith("file://") ? s : `file:///${s.replace(/\\/g, "/")}`;
  };

  contextBridge.exposeInMainWorld("electronAPI", {
    onNotification: (cb) => {
      ipcRenderer.on("show-notification", (_e, data) => {
        const raw = data?.iconPath || data?.icon || "";
        const normalized = raw ? normalizeFileUrl(raw) : "";
        cb({
          ...data,
          icon: normalized,
          iconPath: normalized,
        });
      });
    },
  });
})();

contextBridge.exposeInMainWorld("ui", {
  confirm: (opts) => ipcRenderer.invoke("ui:confirm", opts),
  refocus: () => ipcRenderer.invoke("ui:refocus"),
});

// Achievements schema
contextBridge.exposeInMainWorld("achgen", {
  onLog: (callback) => {
    const handler = (_e, msg) => callback(msg); // msg: {type, level, message, ...}
    ipcRenderer.on("achgen:log", handler);
    return () => ipcRenderer.removeListener("achgen:log", handler); // unsubscribe
  },
  onStdout: (callback) => {
    const handler = (_e, line) => callback(line);
    ipcRenderer.on("achgen:stdout", handler);
    return () => ipcRenderer.removeListener("achgen:stdout", handler);
  },
  onStderr: (callback) => {
    const handler = (_e, line) => callback(line);
    ipcRenderer.on("achgen:stderr", handler);
    return () => ipcRenderer.removeListener("achgen:stderr", handler);
  },
});

// Folders
contextBridge.exposeInMainWorld("folders", {
  list: () => ipcRenderer.invoke("folders:list"),
  add: (dirPath) => ipcRenderer.invoke("folders:add", dirPath),
  remove: (dirPath) => ipcRenderer.invoke("folders:remove", dirPath),
  rescan: () => ipcRenderer.invoke("folders:rescan"),
  block: (dirPath) => ipcRenderer.invoke("folders:block", dirPath),
  unblock: (dirPath) => ipcRenderer.invoke("folders:unblock", dirPath),
});
