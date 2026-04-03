const { createControllerInputManager } = require("./controller-input-manager");

function createDisabledStatus() {
  return {
    enabled: false,
    running: false,
    available: false,
    dllName: null,
    backendError: null,
    controlModeActive: false,
    controlModeUserIndex: null,
  };
}

function bindingRequiresSystemButtons(binding) {
  return Array.isArray(binding) && binding.includes("GUIDE");
}

function createOverlayControllerService(options = {}) {
  const logger = options.logger || console;
  const isSupportEnabled =
    typeof options.isSupportEnabled === "function"
      ? options.isSupportEnabled
      : () => false;
  const getPreferredBackend =
    typeof options.getPreferredBackend === "function"
      ? options.getPreferredBackend
      : () => "auto";
  const isDebugLoggingEnabled =
    typeof options.isDebugLoggingEnabled === "function"
      ? options.isDebugLoggingEnabled
      : () => false;
  const getOverlayToggleBinding =
    typeof options.getOverlayToggleBinding === "function"
      ? options.getOverlayToggleBinding
      : () => [];
  const getOverlayControlModeBinding =
    typeof options.getOverlayControlModeBinding === "function"
      ? options.getOverlayControlModeBinding
      : () => [];
  const canEnterOverlayControlMode =
    typeof options.canEnterOverlayControlMode === "function"
      ? options.canEnterOverlayControlMode
      : () => false;
  const isOverlayPresented =
    typeof options.isOverlayPresented === "function"
      ? options.isOverlayPresented
      : () => false;
  const onAction =
    typeof options.onAction === "function" ? options.onAction : () => {};

  let manager = null;
  let managerBackendPreference = "auto";
  let managerRequiresSystemButtons = false;
  let managerDebugLoggingEnabled = false;

  function getBindingsRequireSystemButtons(prefs = null) {
    return [
      getOverlayToggleBinding(prefs),
      getOverlayControlModeBinding(prefs),
    ].some(bindingRequiresSystemButtons);
  }

  function ensureManager(prefs = null) {
    const preferredBackend = getPreferredBackend(prefs);
    const requiresSystemButtons = getBindingsRequireSystemButtons(prefs);
    const debugLoggingEnabled = isDebugLoggingEnabled(prefs);
    if (
      manager &&
      managerBackendPreference === preferredBackend &&
      managerRequiresSystemButtons === requiresSystemButtons &&
      managerDebugLoggingEnabled === debugLoggingEnabled
    ) {
      return manager;
    }
    shutdown("binding-or-backend-preference-changed");
    managerBackendPreference = preferredBackend;
    managerRequiresSystemButtons = requiresSystemButtons;
    managerDebugLoggingEnabled = debugLoggingEnabled;
    manager = createControllerInputManager({
      logger,
      canEnterOverlayControlMode,
      isOverlayPresented,
      onAction,
      debugLoggingEnabled,
      getPreferredBackend: () => preferredBackend,
      getOverlayToggleBinding: () => getOverlayToggleBinding(),
      getOverlayControlModeBinding: () => getOverlayControlModeBinding(),
    });
    return manager;
  }

  function sync(reason, prefs = null) {
    const enabled = isSupportEnabled(prefs);
    if (!enabled && !manager) {
      return createDisabledStatus();
    }
    const currentManager = ensureManager(prefs);
    const status = currentManager.setEnabled(enabled, reason || "preferences");
    if (enabled && !status.available) {
      logger.warn?.("controller:preference-sync:unavailable", {
        reason: String(reason || "preferences"),
        preferredBackend: getPreferredBackend(prefs),
        backendError: status.backendError || null,
      });
    }
    return status;
  }

  function notifyOverlayPresentationChanged(
    presented,
    reason = "overlay-presented-changed",
  ) {
    manager?.notifyOverlayPresentationChanged?.(presented, reason);
  }

  function shutdown(reason = "manual") {
    if (!manager) return;
    try {
      manager.shutdown(reason);
    } catch {}
    manager = null;
    managerBackendPreference = "auto";
    managerRequiresSystemButtons = false;
    managerDebugLoggingEnabled = false;
  }

  return {
    sync,
    shutdown,
    notifyOverlayPresentationChanged,
    hasManager: () => !!manager,
  };
}

module.exports = {
  createOverlayControllerService,
};
