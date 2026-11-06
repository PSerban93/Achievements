(() => {
  const normalizeAppTheme = (value) => {
    if (window.AppTheme?.normalizeAppTheme) {
      return window.AppTheme.normalizeAppTheme(value);
    }
    return "dracula";
  };
  const applyAppTheme = (value) => {
    if (window.AppTheme?.applyAppThemeToDocument) {
      window.AppTheme.applyAppThemeToDocument(value);
      return;
    }
    document.documentElement.dataset.theme = normalizeAppTheme(value);
  };
  const registerThemes = (payload) => {
    if (window.AppTheme?.registerAppThemes && Array.isArray(payload?.themes)) {
      window.AppTheme.registerAppThemes(payload.themes);
    }
  };
  const loadThemes = async () => {
    try {
      if (typeof window.api?.listAppThemes === "function") {
        registerThemes(await window.api.listAppThemes());
      }
    } catch {}
  };
  const applyHardwareAccelerationPreference = (value) => {
    if (window.AppTheme?.applyHardwareAccelerationPreferenceToDocument) {
      window.AppTheme.applyHardwareAccelerationPreferenceToDocument(value);
      return;
    }
    document.documentElement.dataset.hardwareAcceleration =
      value === false ? "on" : "off";
  };
  applyHardwareAccelerationPreference(true);

  const sendAction = (action) => {
    if (window.api && typeof window.api.trayAction === "function") {
      window.api.trayAction(action);
    }
  };
  const resumeStartupBtn = document.getElementById("trayMenuResumeStartup");
  const recentGames = document.getElementById("trayMenuRecentGames");
  const recentSeparator = document.getElementById("trayMenuRecentSeparator");
  let recentSignature = "";
  const updateRecentPlayLabels = () => {
    const play = window.i18nUi?.getString("dashboard.play", "Play") || "Play";
    for (const button of recentGames?.querySelectorAll(".tray-menu__play") || []) {
      button.title = `${play}: ${button.dataset.gameName}`; button.setAttribute("aria-label", button.title);
    }
  };
  const refreshRecentGames = () => {
    if (document.visibilityState !== "hidden") window.api?.refreshTrayRecentGames?.().catch(error => console.warn("tray:recent-refresh-failed", error));
  };
  const renderRecentGames = (games) => {
    if (!recentGames || !recentSeparator) return;
    const entries = Array.isArray(games) ? games.filter(game => typeof game?.configName === "string" && typeof game?.name === "string").slice(0, 5) : [];
    const signature = JSON.stringify(entries.map(({ configName, name, icon, canPlay }) => ({ configName, name, icon, canPlay })));
    if (signature === recentSignature) return;
    recentSignature = signature;
    const focusedName = recentGames.contains(document.activeElement) ? document.activeElement.dataset.configName : null;
    const focusedPlay = document.activeElement?.classList.contains("tray-menu__play");
    const rows = entries.map(game => {
      const row = document.createElement("div");
      row.className = `tray-menu__game-row${game.canPlay ? " tray-menu__game-row--play" : ""}`;
      const button = document.createElement("button");
      button.className = "tray-menu__item tray-menu__game"; button.type = "button";
      button.dataset.configName = game.configName; button.title = game.name;
      const icon = document.createElement("img"); icon.className = "tray-menu__game-icon"; icon.alt = "";
      icon.src = game.icon || "assets/icon.png";
      icon.addEventListener("error", () => { icon.src = "assets/icon.png"; }, { once: true });
      const label = document.createElement("span"); label.className = "tray-menu__game-name"; label.textContent = game.name;
      button.append(icon, label);
      const activate = async (target, action) => {
        target.disabled = true;
        try { await window.api.activateRecentTrayGame(game.configName, action); }
        catch (error) { console.warn("tray:recent-action-failed", error); }
        finally { target.disabled = false; }
      };
      button.addEventListener("click", () => void activate(button, "open"));
      row.appendChild(button);
      if (game.canPlay) {
        const play = document.createElement("button"); play.className = "tray-menu__play"; play.type = "button";
        play.dataset.configName = game.configName; play.dataset.gameName = game.name;
        play.innerHTML = '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path fill="currentColor" d="M4 2.5v11L13 8z"/></svg>';
        play.addEventListener("click", () => void activate(play, "play")); row.appendChild(play);
      }
      return row;
    });
    recentGames.replaceChildren(...rows);
    recentGames.classList.toggle("hidden", !rows.length); recentSeparator.classList.toggle("hidden", !rows.length);
    updateRecentPlayLabels();
    if (focusedName) [...recentGames.querySelectorAll(focusedPlay ? ".tray-menu__play" : ".tray-menu__game")]
      .find(button => button.dataset.configName === focusedName)?.focus({ preventScroll: true });
  };
  window.api?.onTrayRecentGames?.(renderRecentGames);
  window.api?.onLastPlayedUpdate?.(refreshRecentGames);
  window.api?.on?.("configs:changed", refreshRecentGames);

  const setResumeStartupVisible = (visible) => {
    if (!resumeStartupBtn) return;
    resumeStartupBtn.classList.toggle("hidden", !visible);
    resumeStartupBtn.disabled = !visible;
  };

  const refreshResumeStartupState = async () => {
    if (!resumeStartupBtn) return;
    if (!window.api || typeof window.api.getBootStatus !== "function") {
      setResumeStartupVisible(false);
      return;
    }
    try {
      const status = await window.api.getBootStatus();
      const pending =
        status?.bootOnboardingGateOpen === false ||
        status?.bootOnboardingRequired === true;
      setResumeStartupVisible(pending);
    } catch {
      setResumeStartupVisible(false);
    }
  };

  // Setup button click actions
  document.querySelectorAll("[data-action]").forEach((button) => {
    button.addEventListener("click", () => {
      sendAction(button.dataset.action);
    });
  });

  // Escape key to hide tray menu
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      sendAction("hide");
    } else if (["ArrowUp", "ArrowDown", "Home", "End"].includes(e.key)) {
      const buttons = [...document.querySelectorAll("button")].filter(button => !button.disabled && button.getClientRects().length);
      if (!buttons.length) return;
      e.preventDefault();
      const index = buttons.indexOf(document.activeElement);
      const next = e.key === "Home" ? 0 : e.key === "End" ? buttons.length - 1
        : e.key === "ArrowUp" ? (index < 0 ? buttons.length - 1 : (index - 1 + buttons.length) % buttons.length)
        : (index + 1) % buttons.length;
      buttons[next].focus({ preventScroll: true }); buttons[next].scrollIntoView({ block: "nearest" });
    }
  });

  // Listen for language changes from main process
  if (window.api && typeof window.api.on === "function") {
    window.api.on("tray:language-changed", (data) => {
      if (data?.language && window.i18nUi?.setUiLanguage) {
        window.i18nUi.setUiLanguage(data.language).then(updateRecentPlayLabels);
      }
    });
    window.api.on("tray:theme-changed", (data) => {
      registerThemes(data);
      applyAppTheme(data?.appTheme);
    });
  }

  if (window.api && typeof window.api.loadPreferences === "function") {
    window.api
      .loadPreferences()
      .then(async (prefs) => {
        await loadThemes();
        if (window.i18nUi?.setUiLanguage) {
          await window.i18nUi.setUiLanguage(prefs?.uiLanguage || "english");
          updateRecentPlayLabels();
        }
        applyAppTheme(prefs?.appTheme);
        applyHardwareAccelerationPreference(
          prefs?.disableHardwareAcceleration,
        );
      })
      .catch(() => applyAppTheme(null));
  } else {
    applyAppTheme(null);
  }

  refreshResumeStartupState().catch(() => {});
  const refreshTimer = setInterval(() => {
    refreshResumeStartupState().catch(() => {});
  }, 3000);
  window.addEventListener("beforeunload", () => {
    clearInterval(refreshTimer);
  });
})();
