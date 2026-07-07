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
    }
  });

  // Listen for language changes from main process
  if (window.api && typeof window.api.on === "function") {
    window.api.on("tray:language-changed", (data) => {
      if (data?.language && window.i18nUi?.setUiLanguage) {
        window.i18nUi.setUiLanguage(data.language);
      }
    });
    window.api.on("tray:theme-changed", (data) => {
      applyAppTheme(data?.appTheme);
    });
  }

  if (window.api && typeof window.api.loadPreferences === "function") {
    window.api
      .loadPreferences()
      .then((prefs) => {
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
