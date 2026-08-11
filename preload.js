const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("customApi", {
  minimizeWindow: () => ipcRenderer.send("minimize-window"),
  maximizeWindow: () => ipcRenderer.send("maximize-window"),
  closeWindow: () => ipcRenderer.send("close-window"),
});
let overlayDataHandler = null;

function subscribeIpc(channel, callback, mapArgs = (_event, data) => [data]) {
  if (typeof callback !== "function") return () => {};
  const handler = (event, ...args) => callback(...mapArgs(event, ...args));
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

const RARITY_BORDER_STYLE_ID = "achievements-rarity-border-style";
const RARITY_PERCENTAGE_ID = "achievements-rarity-percentage";
const RARITY_BORDER_CLASSES = [
  "achievements-rarity-border-gold",
  "achievements-rarity-border-silver",
  "achievements-rarity-border-bronze",
];
let rarityBorderObserver = null;
let rarityBorderTimer = null;
let rarityPercentageFrame = null;
let rarityPercentageElement = null;

function parseNotificationRarityPercent(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.min(100, Math.max(0, value));
  }
  if (typeof value !== "string") return null;
  const match = value.replace(",", ".").trim().match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const parsed = Number(match[0]);
  return Number.isFinite(parsed)
    ? Math.min(100, Math.max(0, parsed))
    : null;
}

function getNotificationRarityTier(value) {
  const percent = parseNotificationRarityPercent(value);
  if (percent === null || percent > 10) return "";
  if (percent <= 1) return "gold";
  if (percent <= 5) return "silver";
  return "bronze";
}

function getExplicitNotificationRarityTier(data = {}) {
  const value = String(data?.rarityTier || data?.trophyType || "")
    .trim()
    .toLowerCase();
  if (value === "gold" || value === "silver" || value === "bronze") {
    return value;
  }
  return "";
}

function isLaz0rboxNotificationPreset(data = {}) {
  const presetName = String(data?.preset || "")
    .trim()
    .toLowerCase();
  if (presetName === "laz0rbox") return true;
  try {
    const pathname = decodeURIComponent(window.location.pathname || "")
      .replace(/\\/g, "/")
      .toLowerCase();
    return pathname.includes("/laz0rbox/");
  } catch {
    return false;
  }
}

function normalizeComparableAssetUrl(value) {
  if (!value) return "";
  try {
    return new URL(String(value), window.location.href).href
      .replace(/\\/g, "/")
      .toLowerCase();
  } catch {
    return String(value).replace(/\\/g, "/").toLowerCase();
  }
}

function getAssetBasename(value) {
  const normalized = normalizeComparableAssetUrl(value).split(/[?#]/, 1)[0];
  return normalized.split("/").pop() || "";
}

function ensureRarityBorderStyles() {
  if (!document?.head || document.getElementById(RARITY_BORDER_STYLE_ID)) {
    return;
  }
  const style = document.createElement("style");
  style.id = RARITY_BORDER_STYLE_ID;
  style.textContent = `
    .achievements-rarity-border-gold {
      box-sizing: border-box !important;
      border: 2px solid #f9c74f !important;
      box-shadow:
        0 0 0 1px rgba(249, 199, 79, 0.55),
        0 0 14px rgba(249, 199, 79, 0.78) !important;
    }
    .achievements-rarity-border-silver {
      box-sizing: border-box !important;
      border: 2px solid #c7d0d9 !important;
      box-shadow:
        0 0 0 1px rgba(199, 208, 217, 0.55),
        0 0 12px rgba(199, 208, 217, 0.68) !important;
    }
    .achievements-rarity-border-bronze {
      box-sizing: border-box !important;
      border: 2px solid #cd7f32 !important;
      box-shadow:
        0 0 0 1px rgba(205, 127, 50, 0.55),
        0 0 12px rgba(205, 127, 50, 0.68) !important;
    }
    #${RARITY_PERCENTAGE_ID} {
      position: fixed;
      z-index: 2147483647;
      min-width: var(--notification-rarity-min-width, 34px);
      padding:
        var(--notification-rarity-padding-y, 2px)
        var(--notification-rarity-padding-x, 7px);
      box-sizing: border-box;
      border: 1px solid rgba(255, 255, 255, 0.42);
      border-radius: 999px;
      background: rgba(10, 13, 18, 0.82);
      color: #ffffff;
      font-family: "Segoe UI", sans-serif;
      font-size: var(--notification-rarity-font-size, 14px);
      font-weight: 700;
      line-height: 1.25;
      opacity: 0;
      visibility: hidden;
      text-align: center;
      white-space: nowrap;
      pointer-events: none;
      transform: translateX(-50%);
      text-shadow: 0 1px 2px rgba(0, 0, 0, 0.9);
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35);
    }
    #${RARITY_PERCENTAGE_ID}.achievements-rarity-percentage-gold {
      border-color: rgba(249, 199, 79, 0.88);
      color: #ffe08a;
    }
    #${RARITY_PERCENTAGE_ID}.achievements-rarity-percentage-silver {
      border-color: rgba(199, 208, 217, 0.88);
      color: #edf3f8;
    }
    #${RARITY_PERCENTAGE_ID}.achievements-rarity-percentage-bronze {
      border-color: rgba(205, 127, 50, 0.88);
      color: #efb475;
    }
  `;
  document.head.appendChild(style);
}

function clearNotificationRarityBorder() {
  if (rarityBorderObserver) {
    rarityBorderObserver.disconnect();
    rarityBorderObserver = null;
  }
  if (rarityBorderTimer) {
    clearTimeout(rarityBorderTimer);
    rarityBorderTimer = null;
  }
  if (rarityPercentageFrame !== null) {
    cancelAnimationFrame(rarityPercentageFrame);
    rarityPercentageFrame = null;
  }
  rarityPercentageElement?.remove();
  rarityPercentageElement = null;
  try {
    document
      .querySelectorAll(RARITY_BORDER_CLASSES.map((name) => `.${name}`).join(","))
      .forEach((element) => element.classList.remove(...RARITY_BORDER_CLASSES));
  } catch {}
}

function formatNotificationRarityPercent(value) {
  const percent = parseNotificationRarityPercent(value);
  if (percent === null) return "";
  const formatted = Number.isInteger(percent)
    ? String(percent)
    : percent.toFixed(2).replace(/\.?0+$/, "");
  return `${formatted}%`;
}

function normalizeNotificationRarityScale(value) {
  const scale = Number(value);
  return Number.isFinite(scale) && scale > 0 ? scale : 1;
}

function getNotificationPresetName(data = {}) {
  const explicit = String(data?.preset || "")
    .trim()
    .toLowerCase();
  if (explicit) return explicit;
  try {
    const pathname = decodeURIComponent(window.location.pathname || "")
      .replace(/\\/g, "/")
      .toLowerCase();
    const parts = pathname.split("/").filter(Boolean);
    return parts.length > 1 ? parts[parts.length - 2] : "";
  } catch {
    return "";
  }
}

function getElementVisualOpacity(element) {
  let opacity = 1;
  let current = element;
  while (current instanceof Element) {
    const style = window.getComputedStyle(current);
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      style.visibility === "collapse"
    ) {
      return 0;
    }
    const currentOpacity = Number.parseFloat(style.opacity);
    if (Number.isFinite(currentOpacity)) opacity *= currentOpacity;
    if (opacity < 0.01) return 0;
    current = current.parentElement;
  }
  return opacity;
}

function isXbox360ExitSpinActive(icon, presetName) {
  if (presetName !== "xbox 360") return false;
  const container = icon.closest(".ach");
  if (!container) return false;
  try {
    const exitAnimation = container.getAnimations().find((animation) =>
      String(animation.animationName || "")
        .toLowerCase()
        .includes("open-close-banner"),
    );
    const progress = exitAnimation?.effect?.getComputedTiming?.().progress;
    if (Number.isFinite(progress) && progress >= 0.9) return true;
  } catch {}
  try {
    const transform = window.getComputedStyle(container).transform;
    const match = String(transform).match(
      /^matrix\(([-+\d.e]+),\s*([-+\d.e]+),/,
    );
    if (!match) return false;
    const angle = Math.abs(
      (Math.atan2(Number(match[2]), Number(match[1])) * 180) / Math.PI,
    );
    return angle > 3 && Math.abs(angle - 360) > 3;
  } catch {
    return false;
  }
}

function isNotificationIconVisuallyReady(icon, rect, scale, presetName) {
  const centerX = rect.left + rect.width / 2;
  const centerY = rect.top + rect.height / 2;
  if (
    !icon.complete ||
    icon.naturalWidth <= 0 ||
    icon.naturalHeight <= 0 ||
    rect.width < 8 * scale ||
    rect.height < 8 * scale ||
    centerX <= 0 ||
    centerX >= window.innerWidth ||
    centerY <= 0 ||
    centerY >= window.innerHeight
  ) {
    return false;
  }
  if (getElementVisualOpacity(icon) < 0.35) return false;
  return !isXbox360ExitSpinActive(icon, presetName);
}

function attachNotificationRarityPercentage(
  icon,
  percent,
  tier,
  scaleValue,
  presetName,
) {
  const scale = normalizeNotificationRarityScale(scaleValue);
  const badge = document.createElement("div");
  badge.id = RARITY_PERCENTAGE_ID;
  badge.textContent = formatNotificationRarityPercent(percent);
  badge.style.setProperty(
    "--notification-rarity-min-width",
    `${34 * scale}px`,
  );
  badge.style.setProperty(
    "--notification-rarity-padding-y",
    `${2 * scale}px`,
  );
  badge.style.setProperty(
    "--notification-rarity-padding-x",
    `${7 * scale}px`,
  );
  badge.style.setProperty(
    "--notification-rarity-font-size",
    `${14 * scale}px`,
  );
  if (tier) {
    badge.classList.add(`achievements-rarity-percentage-${tier}`);
  }
  document.documentElement.appendChild(badge);
  rarityPercentageElement = badge;

  const position = () => {
    if (!icon.isConnected || !badge.isConnected) {
      rarityPercentageFrame = null;
      return;
    }
    const rect = icon.getBoundingClientRect();
    const isVisible = isNotificationIconVisuallyReady(
      icon,
      rect,
      scale,
      presetName,
    );
    badge.style.opacity = isVisible ? "1" : "0";
    badge.style.visibility = isVisible ? "visible" : "hidden";
    if (!isVisible) {
      rarityPercentageFrame = requestAnimationFrame(position);
      return;
    }
    const badgeHeight = badge.offsetHeight || 18 * scale;
    const centerX = rect.left + rect.width / 2;
    badge.style.left = `${centerX}px`;
    badge.style.top = `${Math.min(
      rect.bottom + 4 * scale,
      Math.max(0, window.innerHeight - badgeHeight - 2 * scale),
    )}px`;
    rarityPercentageFrame = requestAnimationFrame(position);
  };
  position();
}

function findMatchingNotificationIcon(iconPath) {
  const expectedUrl = normalizeComparableAssetUrl(iconPath);
  const expectedBasename = getAssetBasename(iconPath);
  if (!expectedUrl || !expectedBasename) return null;
  const selectors = [
    ".icon img",
    "img.achievement-icon",
    ".achievement-icon img",
    "#icon",
    ".ani_icon img",
    ".icon-frame img",
  ];
  const candidates = Array.from(
    document.querySelectorAll(selectors.join(",")),
  ).filter((element) => element instanceof HTMLImageElement);

  return (
    candidates.find((element) => {
      const currentUrl = normalizeComparableAssetUrl(
        element.currentSrc || element.src || element.getAttribute("src"),
      );
      if (!currentUrl) return false;
      return (
        currentUrl === expectedUrl ||
        getAssetBasename(currentUrl) === expectedBasename
      );
    }) || null
  );
}

function applyNotificationRarityBorder(data = {}) {
  clearNotificationRarityBorder();
  const percent = parseNotificationRarityPercent(data?.rarityPct);
  const tier =
    getExplicitNotificationRarityTier(data) ||
    getNotificationRarityTier(data?.rarityPct);
  const showPercentage =
    data?.showRarityPercentage === true && percent !== null;
  const showBorder =
    !!tier && (data?.isRare === true || !!getExplicitNotificationRarityTier(data));
  if (
    (!showBorder && !showPercentage) ||
    isLaz0rboxNotificationPreset(data)
  ) {
    return;
  }
  const iconPath = data?.iconPath || data?.icon || "";
  if (!iconPath) return;
  const presetName = getNotificationPresetName(data);
  ensureRarityBorderStyles();

  const apply = () => {
    const icon = findMatchingNotificationIcon(iconPath);
    if (!icon) return false;
    if (showBorder) {
      icon.classList.remove(...RARITY_BORDER_CLASSES);
      icon.classList.add(`achievements-rarity-border-${tier}`);
    }
    if (showPercentage && !rarityPercentageElement) {
      attachNotificationRarityPercentage(
        icon,
        percent,
        tier,
        data?.scale,
        presetName,
      );
    }
    return true;
  };

  if (apply()) return;
  rarityBorderObserver = new MutationObserver(() => {
    if (!apply()) return;
    rarityBorderObserver?.disconnect();
    rarityBorderObserver = null;
  });
  const observe = () => {
    if (!document.documentElement) return;
    rarityBorderObserver?.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["src"],
    });
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", observe, { once: true });
  } else {
    observe();
  }
  rarityBorderTimer = setTimeout(() => {
    rarityBorderObserver?.disconnect();
    rarityBorderObserver = null;
    rarityBorderTimer = null;
  }, 2000);
}

ipcRenderer.on("show-notification", (_event, data) => {
  applyNotificationRarityBorder(data);
});

let notificationNavigationClickEnabled = false;

function handleNotificationNavigationClick(event) {
  if (!notificationNavigationClickEnabled || event?.button !== 0) return;
  notificationNavigationClickEnabled = false;
  try {
    document.documentElement.style.cursor = "";
  } catch {}
  ipcRenderer.send("notification-navigation:click");
}

ipcRenderer.on("notification-navigation:enable", () => {
  if (notificationNavigationClickEnabled) return;
  notificationNavigationClickEnabled = true;
  try {
    document.documentElement.style.cursor = "pointer";
  } catch {}
  window.addEventListener("click", handleNotificationNavigationClick, true);
});

ipcRenderer.on("notification-navigation:disable", () => {
  notificationNavigationClickEnabled = false;
  try {
    document.documentElement.style.cursor = "";
  } catch {}
  window.removeEventListener("click", handleNotificationNavigationClick, true);
});

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
  getActiveConfigSelection: () =>
    ipcRenderer.invoke("config:get-active-selection"),
  blacklistConfig: (payload) => ipcRenderer.invoke("config:blacklist", payload),
  addManualBlacklistedAppIds: (appids) =>
    ipcRenderer.invoke("blacklist:add-manual", { appids }),
  getBlacklist: () => ipcRenderer.invoke("blacklist:list"),
  resetBlacklist: () => ipcRenderer.invoke("blacklist:reset"),
  isAppIdBlacklisted: (appid, platform = null) =>
    ipcRenderer.invoke(
      "blacklist:check",
      appid && typeof appid === "object" ? appid : { appid, platform },
    ),
  getConfigByAppId: (appid) => ipcRenderer.invoke("config:get-by-appid", appid),

  // Achievements loading
  loadAchievementData: async (configName, options = {}) => {
    try {
      return await ipcRenderer.invoke("load-achievements", configName, options);
    } catch (e) {
      return { achievements: null, error: String(e?.message || e) };
    }
  },
  loadSavedAchievements: async (configName, options = {}) => {
    try {
      return await ipcRenderer.invoke(
        "load-saved-achievements",
        configName,
        options,
      );
    } catch (e) {
      return { achievements: {}, error: String(e?.message || e) };
    }
  },
  setAchievementManualState: async (payload) => {
    try {
      return await ipcRenderer.invoke("achievement:manual-state", payload);
    } catch (e) {
      return { success: false, error: String(e?.message || e) };
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
  loadSanPresets: () => ipcRenderer.invoke("load-san-presets"),

  // Notification
  showNotification: (data) => ipcRenderer.send("show-notification", data),
  showTestNotification: (options) =>
    ipcRenderer.send("show-test-notification", options),
  showTestRareNotification: (options) =>
    ipcRenderer.send("show-test-rare-notification", options),
  showTestEmulatorNotification: (options) =>
    ipcRenderer.send("show-test-emulator-notification", options),
  showTestPlatinumNotification: (options) =>
    ipcRenderer.send("show-test-platinum-notification", options),
  showTestProgressNotification: (options) =>
    ipcRenderer.send("show-test-progress-notification", options),
  showTestPlaytimeNotification: () =>
    ipcRenderer.send("show-test-playtime-notification"),
  queueAchievementNotification: (data) =>
    ipcRenderer.send("queue-achievement-notification", data),
  queueProgressNotification: (data) =>
    ipcRenderer.send("queue-progress-notification", data),
  onNotification: (callback) =>
    subscribeIpc("show-notification", callback, (_event, data) => [data]),
  onNotify: (callback) =>
    subscribeIpc("notify", callback, (_event, data) => [data]),
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
    subscribeIpc("new-achievement", callback, (_event, data) => [data]),
  onRefreshAchievementsTable: (callback) =>
    subscribeIpc(
      "refresh-achievements-table",
      callback,
      (_event, data) => [data],
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
    if (typeof callback !== "function") return () => {};
    overlayDataHandler = (_event, config) => callback(config);
    ipcRenderer.on("load-overlay-data", overlayDataHandler);
    return () => {
      if (!overlayDataHandler) return;
      ipcRenderer.removeListener("load-overlay-data", overlayDataHandler);
      overlayDataHandler = null;
    };
  },
  onToggleOverlayShortcut: (callback) =>
    subscribeIpc("toggle-overlay-shortcut", callback, () => []),
  onSetLanguage: (callback) =>
    subscribeIpc("set-language", callback, (_event, lang) => [lang]),

  // Other functionalities
  savePreferences: (prefs) => ipcRenderer.invoke("preferences:update", prefs),
  updatePreferences: (prefs) => ipcRenderer.invoke("preferences:update", prefs),
  loadPreferences: () => ipcRenderer.invoke("load-preferences"),
  listAppThemes: () => ipcRenderer.invoke("themes:list"),
  reloadAppThemes: () => ipcRenderer.invoke("themes:reload"),
  listSteamOfficialAccounts: () =>
    ipcRenderer.invoke("steam-official:list-accounts"),
  getEpicOfficialStatus: () => ipcRenderer.invoke("epic-official:status"),
  connectEpicOfficial: () => ipcRenderer.invoke("epic-official:connect"),
  disconnectEpicOfficial: () => ipcRenderer.invoke("epic-official:disconnect"),
  importEpicOfficialLibrary: () =>
    ipcRenderer.invoke("epic-official:import-library"),
  getXboxPcStatus: () => ipcRenderer.invoke("xbox-pc:status"),
  connectXboxPc: () => ipcRenderer.invoke("xbox-pc:connect"),
  disconnectXboxPc: () => ipcRenderer.invoke("xbox-pc:disconnect"),
  importXboxPcLibrary: () => ipcRenderer.invoke("xbox-pc:import-library"),
  getSounds: () => ipcRenderer.invoke("get-sound-files"),
  getSoundFullPath: (fileName) =>
    ipcRenderer.invoke("get-sound-path", fileName),
  onPlaySound: (callback) =>
    subscribeIpc("play-sound", callback, (_event, sound) => [sound]),
  onProgressUpdate: (callback) =>
    subscribeIpc("show-progress", callback, (_event, data) => [data]),
  closeNotificationWindow: () => ipcRenderer.send("close-notification-window"),
  notificationRenderReady: () => ipcRenderer.send("notification-render-ready"),
  parseStatsBin: (filePath) => ipcRenderer.invoke("parse-stats-bin", filePath),
  selectFile: () => ipcRenderer.invoke("select-file"),
  selectImageFile: () => ipcRenderer.invoke("select-image-file"),
  readLocalImageDataUrl: (filePath) =>
    ipcRenderer.invoke("read-local-image-data-url", filePath),
  getConfigByName: async (name) => {
    try {
      return await ipcRenderer.invoke("get-config-by-name", name);
    } catch (e) {
      return { __failed: true, __error: String(e?.message || e), name };
    }
  },
  renameAndSaveConfig: (oldName, config) =>
    ipcRenderer.invoke("renameAndSaveConfig", oldName, config),
  selectExecutable: (currentPath) =>
    ipcRenderer.invoke("selectExecutable", currentPath),
  launchExecutable: (exe, args, workingDirectory) =>
    ipcRenderer.invoke("launchExecutable", exe, args, workingDirectory),
  requestPlatinumManual: (payload) =>
    ipcRenderer.invoke("platinum:manual", payload),
  onAchievementsMissing: (callback) =>
    subscribeIpc("achievements-missing", callback, (_event, configName) => [
      configName,
    ]),
  logCoverEvent: (level, message, meta) =>
    ipcRenderer.invoke("covers:ui-log", { level, message, meta }),
  logUiEvent: (level, message, meta) =>
    ipcRenderer.invoke("ui:log", { level, message, meta }),
  logOverlayEvent: (level, message, meta) =>
    ipcRenderer.invoke("overlay:log", { level, message, meta }),
  overlayVisibilityAck: (payload) =>
    ipcRenderer.send("overlay:visibility-ack", payload),
  overlayNavigationReady: () =>
    ipcRenderer.send("overlay:navigation-ready"),
  overlayNavigationResult: (payload) =>
    ipcRenderer.send("overlay:navigation-result", payload),
  checkLocalGameImage: (appid, platform) =>
    ipcRenderer.invoke("checkLocalGameImage", appid, platform),
  checkExecutableExists: (exePath) =>
    ipcRenderer.invoke("checkExecutableExists", exePath),
  saveGameImage: (appid, buffer, platform, meta = {}) =>
    ipcRenderer.invoke("saveGameImage", appid, buffer, platform, meta),
  setCustomCoverPath: (configName, coverPath) =>
    ipcRenderer.invoke("config:set-custom-cover-path", { configName, coverPath }),
  onImageUpdate: (callback) =>
    subscribeIpc("update-image", callback, (_event, data) => [data]),
  on: (channel, callback) =>
    subscribeIpc(channel, callback, (_event, data) => [data]),
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
  onConfigsChanged: (handler) =>
    subscribeIpc("configs:changed", handler, (_event, data) => [data]),
  onSchemaReady: (handler) =>
    subscribeIpc("config:schema-ready", handler, (_event, data) => [data]),
  onAutoSelectConfig: (handler) =>
    subscribeIpc("auto-select-config", handler, (_event, name) => [name]),
  appNavigationReady: () => ipcRenderer.send("app-navigation:ready"),
  appNavigationResult: (payload) =>
    ipcRenderer.send("app-navigation:result", payload),
  onAppNavigationOpen: (handler) =>
    subscribeIpc("app-navigation:open", handler, (_event, data) => [data]),
  onAppNavigationError: (handler) =>
    subscribeIpc("app-navigation:error", handler, (_event, data) => [data]),
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
  getSteamProductAssetUrls: (payload) =>
    ipcRenderer.invoke("covers:steam-product-assets", payload),
  getSteamGridDbCover: (payload) =>
    ipcRenderer.invoke("covers:steamgriddb", payload),
  resolveEpicStoreUrl: (payload) =>
    ipcRenderer.invoke("epic:store-url", payload),
  resolveGogStoreUrl: (payload) => ipcRenderer.invoke("gog:store-url", payload),
  resolvePlayStationStoreUrl: (payload) =>
    ipcRenderer.invoke("playstation:store-url", payload),
  openEaApp: (payload) => ipcRenderer.invoke("ea-app:open", payload),
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
    subscribeIpc("dashboard:poll-pause", handler, (_event, state) => [state]),
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
        "overlay-preferences-updated",
        "show-notification",
        "zoom-factor-changed",
        "request-current-config",
        "tray:language-changed",
        "tray:theme-changed",
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
        "blacklist:add-manual",
        "saveConfig",
        "loadConfigs",
        "selectFolder",
        "delete-config",
        "load-achievements",
        "load-saved-achievements",
        "achievement:manual-state",
        "load-presets",
        "preferences:update",
        "save-preferences",
        "load-preferences",
        "themes:list",
        "themes:reload",
        "steam-official:list-accounts",
        "epic-official:status",
        "epic-official:connect",
        "epic-official:disconnect",
        "epic-official:import-library",
        "xbox-pc:status",
        "xbox-pc:connect",
        "xbox-pc:disconnect",
        "xbox-pc:import-library",
        "get-sound-files",
        "get-sound-path",
        "resolve-icon-url",
        "get-config-by-name",
        "renameAndSaveConfig",
        "selectExecutable",
        "launchExecutable",
        "checkLocalGameImage",
        "checkExecutableExists",
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
  rescan: (selectedPaths = null) =>
    ipcRenderer.invoke(
      "folders:rescan",
      Array.isArray(selectedPaths) ? { selectedPaths } : null,
    ),
  block: (dirPath) => ipcRenderer.invoke("folders:block", dirPath),
  unblock: (dirPath) => ipcRenderer.invoke("folders:unblock", dirPath),
});
