const GAMEINPUT_DLL_CANDIDATES = ["GameInputRedist.dll", "GameInput.dll"];
const GAMEINPUT_KIND_CONTROLLER = 0x0000000e;
const GAMEINPUT_KIND_GAMEPAD = 0x00040000;
const GAMEINPUT_POLL_KIND =
  GAMEINPUT_KIND_GAMEPAD | GAMEINPUT_KIND_CONTROLLER;
const GAMEINPUT_FOCUS_ENABLE_BACKGROUND_INPUT = 0x00000040;
const GAMEINPUT_E_DEVICE_DISCONNECTED = 0x838a0001;
const GAMEINPUT_E_DEVICE_NOT_FOUND = 0x838a0002;
const GAMEINPUT_E_READING_NOT_FOUND = 0x838a0003;

const GAMEINPUT_GAMEPAD_BUTTONS = {
  MENU: 0x00000001,
  VIEW: 0x00000002,
  A: 0x00000004,
  B: 0x00000008,
  X: 0x00000010,
  Y: 0x00000020,
  DPAD_UP: 0x00000040,
  DPAD_DOWN: 0x00000080,
  DPAD_LEFT: 0x00000100,
  DPAD_RIGHT: 0x00000200,
  LEFT_SHOULDER: 0x00000400,
  RIGHT_SHOULDER: 0x00000800,
  LEFT_THUMBSTICK: 0x00001000,
  RIGHT_THUMBSTICK: 0x00002000,
};

const XINPUT_DLL_CANDIDATES = [
  "xinput1_4.dll",
  "xinput9_1_0.dll",
  "xinput1_3.dll",
];

const XINPUT_SUCCESS = 0;
const XINPUT_ERROR_DEVICE_NOT_CONNECTED = 1167;
const XINPUT_LEFT_THUMB_DEADZONE = 7849;
const XINPUT_RIGHT_THUMB_DEADZONE = 8689;
const MAX_CONTROLLER_SLOTS = 4;
const POINTER_SIZE = process.arch === "x64" ? 8 : 4;

const XINPUT_BUTTONS = {
  DPAD_UP: 0x0001,
  DPAD_DOWN: 0x0002,
  DPAD_LEFT: 0x0004,
  DPAD_RIGHT: 0x0008,
  START: 0x0010,
  BACK: 0x0020,
  LEFT_THUMB: 0x0040,
  RIGHT_THUMB: 0x0080,
  LEFT_SHOULDER: 0x0100,
  RIGHT_SHOULDER: 0x0200,
  A: 0x1000,
  B: 0x2000,
  X: 0x4000,
  Y: 0x8000,
};

const DEFAULTS = {
  pollIntervalMs: 16,
  overlayMoveSpeedPxPerSec: 900,
  overlayScrollRepeatMs: 220,
  toggleCooldownMs: 500,
  dpadInitialRepeatMs: 220,
  dpadRepeatMs: 90,
  gameInputLeftStickDeadzone: 0.18,
  gameInputRightStickDeadzone: 0.22,
};

let cachedKoffi = undefined;
let cachedKoffiError = undefined;
let cachedXInputApi = undefined;
let cachedXInputApiError = undefined;
let cachedGameInputApi = undefined;
let cachedGameInputApiError = undefined;
let cachedGameInputTypes = undefined;
const comMethodCache = new Map();

function getKoffi() {
  if (cachedKoffiError) throw cachedKoffiError;
  if (cachedKoffi) return cachedKoffi;
  try {
    cachedKoffi = require("koffi");
    return cachedKoffi;
  } catch (err) {
    err.message = `Failed to load koffi: ${err.message || String(err)}`;
    cachedKoffiError = err;
    throw err;
  }
}

function resolveXInputApi() {
  if (cachedXInputApiError) throw cachedXInputApiError;
  if (cachedXInputApi !== undefined) return cachedXInputApi;
  if (process.platform !== "win32") {
    cachedXInputApi = null;
    return cachedXInputApi;
  }

  const koffi = getKoffi();
  const XINPUT_GAMEPAD = koffi.struct("CONTROLLER_XINPUT_GAMEPAD", {
    wButtons: "uint16_t",
    bLeftTrigger: "uint8_t",
    bRightTrigger: "uint8_t",
    sThumbLX: "int16_t",
    sThumbLY: "int16_t",
    sThumbRX: "int16_t",
    sThumbRY: "int16_t",
  });
  const XINPUT_STATE = koffi.struct("CONTROLLER_XINPUT_STATE", {
    dwPacketNumber: "uint32_t",
    Gamepad: XINPUT_GAMEPAD,
  });

  const errors = [];
  for (const dllName of XINPUT_DLL_CANDIDATES) {
    try {
      const lib = koffi.load(dllName);
      cachedXInputApi = {
        type: "xinput",
        dllName,
        XInputGetState: lib.func(
          "uint32_t __stdcall XInputGetState(uint32_t dwUserIndex, _Out_ CONTROLLER_XINPUT_STATE *pState)",
        ),
      };
      return cachedXInputApi;
    } catch (err) {
      errors.push(`${dllName}: ${err?.message || String(err)}`);
    }
  }

  cachedXInputApiError = new Error(
    `Unable to load XInput backend (${errors.join(" | ") || "no candidates"})`,
  );
  throw cachedXInputApiError;
}

function hasButtons(buttons, mask) {
  return (Number(buttons) & Number(mask)) === Number(mask);
}

function normalizeAxis(rawValue, deadzone) {
  const raw = Number(rawValue) || 0;
  const magnitude = Math.min(32767, Math.abs(raw));
  if (magnitude <= deadzone) return 0;
  const sign = raw < 0 ? -1 : 1;
  const scaled = (magnitude - deadzone) / (32767 - deadzone);
  return Math.min(1, Math.max(-1, scaled * sign));
}

function roundTowardZero(value) {
  return value < 0 ? Math.ceil(value) : Math.floor(value);
}

function clampUnit(value) {
  return Math.max(-1, Math.min(1, Number(value) || 0));
}

function applyRadialDeadzone(x, y, deadzone) {
  const safeX = clampUnit(x);
  const safeY = clampUnit(y);
  const safeDeadzone = Math.max(0, Math.min(0.95, Number(deadzone) || 0));
  if (safeDeadzone <= 0) return { x: safeX, y: safeY };

  const magnitude = Math.hypot(safeX, safeY);
  if (!Number.isFinite(magnitude) || magnitude <= safeDeadzone) {
    return { x: 0, y: 0 };
  }
  if (magnitude <= 0) return { x: 0, y: 0 };

  const normalizedX = safeX / magnitude;
  const normalizedY = safeY / magnitude;
  const scaledMagnitude = Math.min(
    1,
    (magnitude - safeDeadzone) / (1 - safeDeadzone),
  );

  return {
    x: clampUnit(normalizedX * scaledMagnitude),
    y: clampUnit(normalizedY * scaledMagnitude),
  };
}

function createSlotState() {
  return {
    connected: false,
    previousButtons: 0,
    current: null,
    lastPacketNumber: null,
    deviceKey: null,
  };
}

function createLogger(logger) {
  const noop = () => {};
  if (!logger || typeof logger !== "object") {
    return {
      info: noop,
      warn: noop,
      error: noop,
      debug: noop,
    };
  }
  return {
    info: typeof logger.info === "function" ? logger.info.bind(logger) : noop,
    warn: typeof logger.warn === "function" ? logger.warn.bind(logger) : noop,
    error:
      typeof logger.error === "function" ? logger.error.bind(logger) : noop,
    debug:
      typeof logger.debug === "function" ? logger.debug.bind(logger) : noop,
  };
}

function normalizeGamepadState({
  packetNumber = 0,
  buttons = 0,
  leftTrigger = 0,
  rightTrigger = 0,
  leftStickX = 0,
  leftStickY = 0,
  rightStickX = 0,
  rightStickY = 0,
  deviceKey = null,
} = {}) {
  return {
    packetNumber: Number(packetNumber) >>> 0,
    buttons: Number(buttons) >>> 0,
    leftTrigger: Number(leftTrigger) || 0,
    rightTrigger: Number(rightTrigger) || 0,
    leftStickX: Math.max(-1, Math.min(1, Number(leftStickX) || 0)),
    leftStickY: Math.max(-1, Math.min(1, Number(leftStickY) || 0)),
    rightStickX: Math.max(-1, Math.min(1, Number(rightStickX) || 0)),
    rightStickY: Math.max(-1, Math.min(1, Number(rightStickY) || 0)),
    deviceKey: deviceKey ? String(deviceKey) : null,
  };
}

function getGameInputTypes() {
  if (cachedGameInputTypes) return cachedGameInputTypes;
  const koffi = getKoffi();
  const GUID = koffi.struct("CONTROLLER_GUID", {
    Data1: "uint32_t",
    Data2: "uint16_t",
    Data3: "uint16_t",
    Data4: koffi.array("uint8_t", 8),
  });
  const GameInputGamepadState = koffi.struct(
    "CONTROLLER_GameInputGamepadState",
    {
      buttons: "uint32_t",
      leftTrigger: "float",
      rightTrigger: "float",
      leftThumbstickX: "float",
      leftThumbstickY: "float",
      rightThumbstickX: "float",
      rightThumbstickY: "float",
    },
  );
  cachedGameInputTypes = {
    GUID,
    GameInputGamepadState,
    IID_IGAMEINPUT: {
      Data1: 0x20efc1c7,
      Data2: 0x5d9a,
      Data3: 0x43ba,
      Data4: [0xb2, 0x6f, 0xb8, 0x07, 0xfa, 0x48, 0x60, 0x9c],
    },
  };
  return cachedGameInputTypes;
}

function getPointerKey(ptr) {
  if (!ptr) return null;
  try {
    const address = getKoffi().address(ptr);
    return typeof address === "bigint" ? address.toString(16) : String(address);
  } catch {
    return null;
  }
}

function isHRESULTSuccess(value) {
  return Number(value) >= 0;
}

function normalizeHRESULT(value) {
  return Number(value) >>> 0;
}

function decodeComMethod(ptr, index, signature) {
  const koffi = getKoffi();
  const vtable = koffi.decode(ptr, "void *");
  const methodPtr = koffi.decode(vtable, index * POINTER_SIZE, "void *");
  const key = `${signature}:${getPointerKey(methodPtr) || index}`;
  if (comMethodCache.has(key)) return comMethodCache.get(key);
  const fn = koffi.decode(methodPtr, koffi.proto(signature));
  comMethodCache.set(key, fn);
  return fn;
}

function releaseComPtr(ptr) {
  if (!ptr) return 0;
  try {
    const Release = decodeComMethod(
      ptr,
      2,
      "uint32_t __stdcall Release(void *self)",
    );
    return Number(Release(ptr)) >>> 0;
  } catch {
    return 0;
  }
}

function resolveGameInputApi() {
  if (cachedGameInputApiError) throw cachedGameInputApiError;
  if (cachedGameInputApi !== undefined) return cachedGameInputApi;
  if (process.platform !== "win32") {
    cachedGameInputApi = null;
    return cachedGameInputApi;
  }

  const koffi = getKoffi();
  const { IID_IGAMEINPUT } = getGameInputTypes();
  const errors = [];
  for (const dllName of GAMEINPUT_DLL_CANDIDATES) {
    try {
      const lib = koffi.load(dllName);
      cachedGameInputApi = {
        type: "gameinput",
        dllName,
        IID_IGAMEINPUT,
        GameInputInitialize: lib.func(
          "int32_t __stdcall GameInputInitialize(const CONTROLLER_GUID *riid, _Out_ void **ppv)",
        ),
      };
      return cachedGameInputApi;
    } catch (err) {
      errors.push(`${dllName}: ${err?.message || String(err)}`);
    }
  }

  cachedGameInputApiError = new Error(
    `Unable to load GameInput backend (${errors.join(" | ") || "no candidates"})`,
  );
  throw cachedGameInputApiError;
}

function normalizeGameInputButtons(rawButtons) {
  let buttons = 0;
  const source = Number(rawButtons) >>> 0;
  if (source & GAMEINPUT_GAMEPAD_BUTTONS.DPAD_UP) buttons |= XINPUT_BUTTONS.DPAD_UP;
  if (source & GAMEINPUT_GAMEPAD_BUTTONS.DPAD_DOWN)
    buttons |= XINPUT_BUTTONS.DPAD_DOWN;
  if (source & GAMEINPUT_GAMEPAD_BUTTONS.DPAD_LEFT)
    buttons |= XINPUT_BUTTONS.DPAD_LEFT;
  if (source & GAMEINPUT_GAMEPAD_BUTTONS.DPAD_RIGHT)
    buttons |= XINPUT_BUTTONS.DPAD_RIGHT;
  if (source & GAMEINPUT_GAMEPAD_BUTTONS.MENU) buttons |= XINPUT_BUTTONS.START;
  if (source & GAMEINPUT_GAMEPAD_BUTTONS.VIEW) buttons |= XINPUT_BUTTONS.BACK;
  if (source & GAMEINPUT_GAMEPAD_BUTTONS.LEFT_THUMBSTICK)
    buttons |= XINPUT_BUTTONS.LEFT_THUMB;
  if (source & GAMEINPUT_GAMEPAD_BUTTONS.RIGHT_THUMBSTICK)
    buttons |= XINPUT_BUTTONS.RIGHT_THUMB;
  if (source & GAMEINPUT_GAMEPAD_BUTTONS.LEFT_SHOULDER)
    buttons |= XINPUT_BUTTONS.LEFT_SHOULDER;
  if (source & GAMEINPUT_GAMEPAD_BUTTONS.RIGHT_SHOULDER)
    buttons |= XINPUT_BUTTONS.RIGHT_SHOULDER;
  if (source & GAMEINPUT_GAMEPAD_BUTTONS.A) buttons |= XINPUT_BUTTONS.A;
  if (source & GAMEINPUT_GAMEPAD_BUTTONS.B) buttons |= XINPUT_BUTTONS.B;
  if (source & GAMEINPUT_GAMEPAD_BUTTONS.X) buttons |= XINPUT_BUTTONS.X;
  if (source & GAMEINPUT_GAMEPAD_BUTTONS.Y) buttons |= XINPUT_BUTTONS.Y;
  return buttons >>> 0;
}

function normalizeGameInputState(rawState, timestamp, deviceKey) {
  const packetNumber =
    typeof timestamp === "bigint"
      ? Number(timestamp & 0xffffffffn)
      : Number(timestamp) >>> 0;
  return normalizeGamepadState({
    packetNumber,
    buttons: normalizeGameInputButtons(rawState?.buttons),
    leftTrigger: Number(rawState?.leftTrigger) || 0,
    rightTrigger: Number(rawState?.rightTrigger) || 0,
    leftStickX: Number(rawState?.leftThumbstickX) || 0,
    leftStickY: Number(rawState?.leftThumbstickY) || 0,
    rightStickX: Number(rawState?.rightThumbstickX) || 0,
    rightStickY: Number(rawState?.rightThumbstickY) || 0,
    deviceKey,
  });
}

function normalizeXInputState(rawState, deviceKey) {
  const gamepad = rawState?.Gamepad || {};
  return normalizeGamepadState({
    packetNumber: rawState?.dwPacketNumber >>> 0,
    buttons: Number(gamepad?.wButtons) >>> 0,
    leftTrigger: Number(gamepad?.bLeftTrigger) || 0,
    rightTrigger: Number(gamepad?.bRightTrigger) || 0,
    leftStickX: normalizeAxis(gamepad?.sThumbLX, XINPUT_LEFT_THUMB_DEADZONE),
    leftStickY: normalizeAxis(gamepad?.sThumbLY, XINPUT_LEFT_THUMB_DEADZONE),
    rightStickX: normalizeAxis(
      gamepad?.sThumbRX,
      XINPUT_RIGHT_THUMB_DEADZONE,
    ),
    rightStickY: normalizeAxis(
      gamepad?.sThumbRY,
      XINPUT_RIGHT_THUMB_DEADZONE,
    ),
    deviceKey,
  });
}

function createXInputPollingBackend() {
  const api = resolveXInputApi();
  if (!api) throw new Error("XInput is only available on Windows.");
  return {
    type: "xinput",
    dllName: api.dllName,
    poll() {
      const states = [];
      for (let userIndex = 0; userIndex < MAX_CONTROLLER_SLOTS; userIndex += 1) {
        const rawState = {};
        const status = api.XInputGetState(userIndex, rawState);
        if (status === XINPUT_SUCCESS) {
          states[userIndex] = normalizeXInputState(
            rawState,
            `xinput:${userIndex}`,
          );
          continue;
        }
        if (status !== XINPUT_ERROR_DEVICE_NOT_CONNECTED) {
          throw new Error(
            `XInputGetState(${userIndex}) failed with status ${status}`,
          );
        }
      }
      return states;
    },
    shutdown() {},
  };
}

function createGameInputPollingBackend(logger) {
  const api = resolveGameInputApi();
  if (!api) throw new Error("GameInput is only available on Windows.");

  const gameInputOut = [null];
  const hr = api.GameInputInitialize(api.IID_IGAMEINPUT, gameInputOut);
  if (!isHRESULTSuccess(hr) || !gameInputOut[0]) {
    throw new Error(
      `GameInputInitialize failed with HRESULT 0x${normalizeHRESULT(hr).toString(16)}`,
    );
  }

  const gameInput = gameInputOut[0];
  let lockedDevice = null;
  let lastLoggedError = null;

  try {
    const SetFocusPolicy = decodeComMethod(
      gameInput,
      16,
      "void __stdcall SetFocusPolicy(void *self, uint32_t policy)",
    );
    SetFocusPolicy(gameInput, GAMEINPUT_FOCUS_ENABLE_BACKGROUND_INPUT);
  } catch (err) {
    logger.warn("controller:gameinput:focus-policy-failed", {
      error: err?.message || String(err),
      dllName: api.dllName,
    });
  }

  function clearLockedDevice(reason) {
    if (!lockedDevice) return;
    logger.info("controller:device:released", {
      backendType: "gameinput",
      deviceKey: getPointerKey(lockedDevice),
      reason: String(reason || "unknown"),
    });
    releaseComPtr(lockedDevice);
    lockedDevice = null;
  }

  function updateLockedDevice(devicePtr) {
    if (!devicePtr) return;
    const nextKey = getPointerKey(devicePtr);
    if (!nextKey) {
      releaseComPtr(devicePtr);
      return;
    }

    const currentKey = getPointerKey(lockedDevice);
    if (lockedDevice && currentKey === nextKey) {
      releaseComPtr(devicePtr);
      return;
    }

    if (lockedDevice) {
      logger.info("controller:device:switch", {
        backendType: "gameinput",
        from: currentKey,
        to: nextKey,
      });
      releaseComPtr(lockedDevice);
    } else {
      logger.info("controller:device:locked", {
        backendType: "gameinput",
        deviceKey: nextKey,
      });
    }

    lockedDevice = devicePtr;
  }

  function tryGetCurrentReading(devicePtr) {
    const GetCurrentReading = decodeComMethod(
      gameInput,
      4,
      "int32_t __stdcall GetCurrentReading(void *self, uint32_t inputKind, void *device, _Out_ void **reading)",
    );
    const out = [null];
    const readingHr = GetCurrentReading(
      gameInput,
      GAMEINPUT_POLL_KIND,
      devicePtr || null,
      out,
    );
    return { hr: readingHr, reading: out[0] || null };
  }

  function readGamepad(reading) {
    const GetGamepadState = decodeComMethod(
      reading,
      18,
      "bool __stdcall GetGamepadState(void *self, _Out_ CONTROLLER_GameInputGamepadState *state)",
    );
    const GetTimestamp = decodeComMethod(
      reading,
      4,
      "uint64_t __stdcall GetTimestamp(void *self)",
    );
    const GetDevice = decodeComMethod(
      reading,
      5,
      "void __stdcall GetDevice(void *self, _Out_ void **device)",
    );

    const rawState = {};
    const ok = GetGamepadState(reading, rawState);
    if (!ok) return null;

    const timestamp = GetTimestamp(reading);
    const deviceOut = [null];
    GetDevice(reading, deviceOut);
    if (deviceOut[0]) updateLockedDevice(deviceOut[0]);
    return normalizeGameInputState(rawState, timestamp, getPointerKey(lockedDevice));
  }

  return {
    type: "gameinput",
    dllName: api.dllName,
    poll() {
      let attempt = tryGetCurrentReading(lockedDevice);
      let hrCode = normalizeHRESULT(attempt.hr);

      if (
        lockedDevice &&
        !isHRESULTSuccess(attempt.hr) &&
        (hrCode === GAMEINPUT_E_DEVICE_DISCONNECTED ||
          hrCode === GAMEINPUT_E_DEVICE_NOT_FOUND ||
          hrCode === GAMEINPUT_E_READING_NOT_FOUND)
      ) {
        clearLockedDevice("stale-lock");
        attempt = tryGetCurrentReading(null);
        hrCode = normalizeHRESULT(attempt.hr);
      }

      if (!isHRESULTSuccess(attempt.hr) || !attempt.reading) {
        if (
          hrCode === GAMEINPUT_E_READING_NOT_FOUND ||
          hrCode === GAMEINPUT_E_DEVICE_NOT_FOUND ||
          hrCode === GAMEINPUT_E_DEVICE_DISCONNECTED
        ) {
          lastLoggedError = null;
          return [];
        }

        const nextErrorKey = `0x${hrCode.toString(16)}`;
        if (lastLoggedError !== nextErrorKey) {
          lastLoggedError = nextErrorKey;
          logger.warn("controller:gameinput:poll-failed", {
            hresult: nextErrorKey,
          });
        }
        return [];
      }

      lastLoggedError = null;
      try {
        const state = readGamepad(attempt.reading);
        return state ? [state] : [];
      } finally {
        releaseComPtr(attempt.reading);
      }
    },
    shutdown() {
      clearLockedDevice("backend-shutdown");
      releaseComPtr(gameInput);
    },
  };
}

function resolvePreferredBackend(logger) {
  const errors = [];

  try {
    const backend = createGameInputPollingBackend(logger);
    if (backend) return backend;
  } catch (err) {
    errors.push(`gameinput: ${err?.message || String(err)}`);
  }

  try {
    const backend = createXInputPollingBackend();
    if (backend) return backend;
  } catch (err) {
    errors.push(`xinput: ${err?.message || String(err)}`);
  }

  throw new Error(errors.join(" | ") || "No controller backend available");
}

function inspectControllerBackendAvailability() {
  const gameInput = {
    available: false,
    dllName: null,
    error: null,
  };
  const xInput = {
    available: false,
    dllName: null,
    error: null,
  };

  try {
    const api = resolveGameInputApi();
    gameInput.available = !!api;
    gameInput.dllName = api?.dllName || null;
  } catch (err) {
    gameInput.error = err?.message || String(err);
  }

  try {
    const api = resolveXInputApi();
    xInput.available = !!api;
    xInput.dllName = api?.dllName || null;
  } catch (err) {
    xInput.error = err?.message || String(err);
  }

  return {
    anyAvailable: gameInput.available || xInput.available,
    gameInput,
    xInput,
  };
}

function createControllerInputManager(options = {}) {
  const logger = createLogger(options.logger);
  const onAction =
    typeof options.onAction === "function" ? options.onAction : () => {};
  const canEnterOverlayControlMode =
    typeof options.canEnterOverlayControlMode === "function"
      ? options.canEnterOverlayControlMode
      : () => true;
  const pollIntervalMs = Math.max(
    8,
    Number(options.pollIntervalMs) || DEFAULTS.pollIntervalMs,
  );
  const overlayMoveSpeedPxPerSec = Math.max(
    120,
    Number(options.overlayMoveSpeedPxPerSec) ||
      DEFAULTS.overlayMoveSpeedPxPerSec,
  );
  const overlayScrollRepeatMs = Math.max(
    80,
    Number(options.overlayScrollRepeatMs) || DEFAULTS.overlayScrollRepeatMs,
  );
  const toggleCooldownMs = Math.max(
    150,
    Number(options.toggleCooldownMs) || DEFAULTS.toggleCooldownMs,
  );
  const dpadInitialRepeatMs = Math.max(
    100,
    Number(options.dpadInitialRepeatMs) || DEFAULTS.dpadInitialRepeatMs,
  );
  const dpadRepeatMs = Math.max(
    40,
    Number(options.dpadRepeatMs) || DEFAULTS.dpadRepeatMs,
  );
  const gameInputLeftStickDeadzone = Math.max(
    0,
    Math.min(
      0.95,
      Number(options.gameInputLeftStickDeadzone) ||
        DEFAULTS.gameInputLeftStickDeadzone,
    ),
  );
  const gameInputRightStickDeadzone = Math.max(
    0,
    Math.min(
      0.95,
      Number(options.gameInputRightStickDeadzone) ||
        DEFAULTS.gameInputRightStickDeadzone,
    ),
  );

  let enabled = false;
  let timer = null;
  let lastTickAt = 0;
  let lastToggleAt = 0;
  let backend = null;
  let backendFailure = null;
  let backendFailureLogged = false;
  const slots = Array.from({ length: MAX_CONTROLLER_SLOTS }, () =>
    createSlotState(),
  );
  const controlMode = {
    active: false,
    userIndex: -1,
    moveRemainderX: 0,
    moveRemainderY: 0,
    lastScrollDirection: null,
    lastScrollAt: 0,
    dpadNextRepeatAt: {
      up: 0,
      down: 0,
      left: 0,
      right: 0,
    },
  };

  function getStatus() {
    return {
      enabled,
      running: !!timer,
      available: !!backend,
      backendType: backend?.type || null,
      dllName: backend?.dllName || null,
      backendError: backendFailure?.message || null,
      controlModeActive: controlMode.active,
      controlModeUserIndex:
        controlMode.active && controlMode.userIndex >= 0
          ? controlMode.userIndex
          : null,
    };
  }

  function emitAction(type, payload = {}) {
    try {
      onAction(type, {
        source:
          backend?.type === "gameinput"
            ? "controller-gameinput"
            : "controller-xinput",
        ...payload,
      });
    } catch (err) {
      logger.warn("controller:action-dispatch-failed", {
        type,
        error: err?.message || String(err),
      });
    }
  }

  function applyGameInputStickDeadzones(state) {
    if (!state || backend?.type !== "gameinput") return state;
    const left = applyRadialDeadzone(
      state.leftStickX,
      state.leftStickY,
      gameInputLeftStickDeadzone,
    );
    const right = applyRadialDeadzone(
      state.rightStickX,
      state.rightStickY,
      gameInputRightStickDeadzone,
    );
    return {
      ...state,
      leftStickX: left.x,
      leftStickY: left.y,
      rightStickX: right.x,
      rightStickY: right.y,
    };
  }

  function resetControlModeState() {
    controlMode.active = false;
    controlMode.userIndex = -1;
    controlMode.moveRemainderX = 0;
    controlMode.moveRemainderY = 0;
    controlMode.lastScrollDirection = null;
    controlMode.lastScrollAt = 0;
    controlMode.dpadNextRepeatAt.up = 0;
    controlMode.dpadNextRepeatAt.down = 0;
    controlMode.dpadNextRepeatAt.left = 0;
    controlMode.dpadNextRepeatAt.right = 0;
  }

  function exitControlMode(reason) {
    if (!controlMode.active) return;
    const userIndex = controlMode.userIndex;
    resetControlModeState();
    logger.info("controller:control-mode:exit", {
      reason: String(reason || "unknown"),
      userIndex,
      backendType: backend?.type || null,
    });
    emitAction("overlay.control-mode", {
      active: false,
      reason: String(reason || "unknown"),
      userIndex,
    });
  }

  function enterControlMode(userIndex, reason) {
    if (
      controlMode.active ||
      userIndex < 0 ||
      userIndex >= slots.length ||
      !canEnterOverlayControlMode()
    ) {
      return false;
    }
    resetControlModeState();
    controlMode.active = true;
    controlMode.userIndex = userIndex;
    logger.info("controller:control-mode:enter", {
      reason: String(reason || "unknown"),
      userIndex,
      backendType: backend?.type || null,
    });
    emitAction("overlay.control-mode", {
      active: true,
      reason: String(reason || "unknown"),
      userIndex,
    });
    return true;
  }

  function clearRuntimeState() {
    for (const slot of slots) {
      slot.connected = false;
      slot.previousButtons = 0;
      slot.current = null;
      slot.lastPacketNumber = null;
      slot.deviceKey = null;
    }
    lastToggleAt = 0;
    resetControlModeState();
  }

  function stopPolling(reason) {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    if (controlMode.active) {
      exitControlMode(reason || "polling-stopped");
    }
    lastTickAt = 0;
  }

  function ensureBackend() {
    if (backend) return true;
    if (backendFailure) {
      if (!backendFailureLogged) {
        backendFailureLogged = true;
        logger.error("controller:backend:unavailable", {
          error: backendFailure.message || String(backendFailure),
        });
      }
      return false;
    }
    try {
      backend = resolvePreferredBackend(logger);
    } catch (err) {
      backendFailure = err instanceof Error ? err : new Error(String(err));
    }
    if (!backend) {
      if (!backendFailureLogged) {
        backendFailureLogged = true;
        logger.error("controller:backend:unavailable", {
          error: backendFailure?.message || "XInput backend missing",
        });
      }
      return false;
    }
    logger.info("controller:backend:ready", {
      backendType: backend.type,
      dllName: backend.dllName,
      pollIntervalMs,
      gameInputLeftStickDeadzone:
        backend.type === "gameinput" ? gameInputLeftStickDeadzone : null,
      gameInputRightStickDeadzone:
        backend.type === "gameinput" ? gameInputRightStickDeadzone : null,
    });
    return true;
  }

  function isToggleComboPressed(buttons) {
    return (
      hasButtons(buttons, XINPUT_BUTTONS.START) &&
      hasButtons(buttons, XINPUT_BUTTONS.BACK)
    );
  }

  function isControlModeHoldPressed(buttons) {
    return (
      hasButtons(buttons, XINPUT_BUTTONS.LEFT_SHOULDER) &&
      hasButtons(buttons, XINPUT_BUTTONS.RIGHT_SHOULDER)
    );
  }

  function wasButtonPressed(previousButtons, buttons, mask) {
    return hasButtons(buttons, mask) && !hasButtons(previousButtons, mask);
  }

  function emitDpadRepeat(
    actionType,
    direction,
    previousButtons,
    buttons,
    mask,
    now,
  ) {
    const isPressed = hasButtons(buttons, mask);
    const wasPressed = hasButtons(previousButtons, mask);
    if (!isPressed) {
      controlMode.dpadNextRepeatAt[direction] = 0;
      return;
    }
    if (!wasPressed || now >= controlMode.dpadNextRepeatAt[direction]) {
      emitAction(actionType, {
        userIndex: controlMode.userIndex,
        direction,
      });
      controlMode.dpadNextRepeatAt[direction] =
        now + (wasPressed ? dpadRepeatMs : dpadInitialRepeatMs);
    }
  }

  function processToggleActions(now) {
    for (let userIndex = 0; userIndex < slots.length; userIndex += 1) {
      const slot = slots[userIndex];
      if (!slot.connected || !slot.current) continue;
      const pressedNow = isToggleComboPressed(slot.current.buttons);
      const pressedBefore = isToggleComboPressed(slot.previousButtons);
      if (!pressedNow || pressedBefore) continue;
      if (now - lastToggleAt < toggleCooldownMs) continue;
      lastToggleAt = now;
      logger.info("controller:overlay-toggle", {
        userIndex,
        backendType: backend?.type || null,
        deviceKey: slot.deviceKey,
      });
      emitAction("overlay.toggle", {
        userIndex,
        combo: "back+start",
      });
    }
  }

  function updateControlMode(now) {
    if (controlMode.active) {
      const slot = slots[controlMode.userIndex];
      if (!slot || !slot.connected || !slot.current) {
        exitControlMode("controller-disconnected");
        return;
      }
      if (!canEnterOverlayControlMode()) {
        exitControlMode("overlay-unavailable");
        return;
      }
      if (!isControlModeHoldPressed(slot.current.buttons)) {
        exitControlMode("shoulders-released");
      }
      return;
    }

    for (let userIndex = 0; userIndex < slots.length; userIndex += 1) {
      const slot = slots[userIndex];
      if (!slot || !slot.connected || !slot.current) continue;
      const holdNow = isControlModeHoldPressed(slot.current.buttons);
      const holdBefore = isControlModeHoldPressed(slot.previousButtons);
      if (!holdNow || holdBefore) continue;
      if (enterControlMode(userIndex, "shoulders-held")) {
        return;
      }
    }
  }

  function processControlModeActions(now, deltaMs) {
    if (!controlMode.active) return;
    const slot = slots[controlMode.userIndex];
    if (!slot || !slot.connected || !slot.current) return;

    const previousButtons = slot.previousButtons;
    const buttons = slot.current.buttons;

    if (wasButtonPressed(previousButtons, buttons, XINPUT_BUTTONS.Y)) {
      emitAction("overlay.snap-cycle", {
        userIndex: controlMode.userIndex,
      });
    }

    emitDpadRepeat(
      "overlay.nudge",
      "up",
      previousButtons,
      buttons,
      XINPUT_BUTTONS.DPAD_UP,
      now,
    );
    emitDpadRepeat(
      "overlay.nudge",
      "down",
      previousButtons,
      buttons,
      XINPUT_BUTTONS.DPAD_DOWN,
      now,
    );
    emitDpadRepeat(
      "overlay.nudge",
      "left",
      previousButtons,
      buttons,
      XINPUT_BUTTONS.DPAD_LEFT,
      now,
    );
    emitDpadRepeat(
      "overlay.nudge",
      "right",
      previousButtons,
      buttons,
      XINPUT_BUTTONS.DPAD_RIGHT,
      now,
    );

    const scaledMoveX =
      slot.current.leftStickX * overlayMoveSpeedPxPerSec * (deltaMs / 1000);
    const scaledMoveY =
      -slot.current.leftStickY * overlayMoveSpeedPxPerSec * (deltaMs / 1000);
    const nextMoveX = controlMode.moveRemainderX + scaledMoveX;
    const nextMoveY = controlMode.moveRemainderY + scaledMoveY;
    const moveX = roundTowardZero(nextMoveX);
    const moveY = roundTowardZero(nextMoveY);
    controlMode.moveRemainderX = nextMoveX - moveX;
    controlMode.moveRemainderY = nextMoveY - moveY;
    if (moveX || moveY) {
      emitAction("overlay.move-relative", {
        userIndex: controlMode.userIndex,
        dx: moveX,
        dy: moveY,
      });
    }

    let scrollDirection = null;
    if (slot.current.rightStickY >= 0.55) scrollDirection = "up";
    else if (slot.current.rightStickY <= -0.55) scrollDirection = "down";

    if (!scrollDirection) {
      controlMode.lastScrollDirection = null;
      return;
    }

    const shouldFireScroll =
      controlMode.lastScrollDirection !== scrollDirection ||
      now - controlMode.lastScrollAt >= overlayScrollRepeatMs;
    if (!shouldFireScroll) return;
    controlMode.lastScrollDirection = scrollDirection;
    controlMode.lastScrollAt = now;
    emitAction("overlay.scroll-page", {
      userIndex: controlMode.userIndex,
      direction: scrollDirection,
    });
  }

  function storePreviousButtons() {
    for (const slot of slots) {
      slot.previousButtons = slot.current?.buttons || 0;
    }
  }

  function applyPolledStates(nextStates) {
    for (let userIndex = 0; userIndex < slots.length; userIndex += 1) {
      const slot = slots[userIndex];
      const rawNextState = nextStates[userIndex] || null;
      const nextState = rawNextState
        ? applyGameInputStickDeadzones(rawNextState)
        : null;
      const nextDeviceKey = nextState?.deviceKey || null;

      if (nextState) {
        if (!slot.connected) {
          logger.info("controller:connected", {
            userIndex,
            backendType: backend?.type || null,
            dllName: backend?.dllName || null,
            deviceKey: nextDeviceKey,
          });
        } else if (slot.deviceKey && nextDeviceKey && slot.deviceKey !== nextDeviceKey) {
          logger.info("controller:device:slot-switch", {
            userIndex,
            backendType: backend?.type || null,
            from: slot.deviceKey,
            to: nextDeviceKey,
          });
        }

        slot.connected = true;
        slot.current = nextState;
        slot.lastPacketNumber = nextState.packetNumber;
        slot.deviceKey = nextDeviceKey;
        continue;
      }

      if (slot.connected) {
        logger.info("controller:disconnected", {
          userIndex,
          backendType: backend?.type || null,
          deviceKey: slot.deviceKey,
        });
      }
      slot.connected = false;
      slot.current = null;
      slot.lastPacketNumber = null;
      slot.deviceKey = null;
    }
  }

  function poll() {
    if (!enabled || !backend) return;
    const now = Date.now();
    const deltaMs =
      lastTickAt > 0
        ? Math.max(8, Math.min(40, now - lastTickAt))
        : pollIntervalMs;
    lastTickAt = now;

    let nextStates = [];
    try {
      const polled = backend.poll();
      nextStates = Array.isArray(polled) ? polled : [];
    } catch (err) {
      logger.error("controller:poll:failed", {
        backendType: backend?.type || null,
        error: err?.message || String(err),
      });
      nextStates = [];
    }

    applyPolledStates(nextStates);
    processToggleActions(now);
    updateControlMode(now);
    processControlModeActions(now, deltaMs);
    storePreviousButtons();
  }

  function setEnabled(next, reason = "manual") {
    const resolved = !!next;
    if (resolved === enabled) {
      if (enabled && !timer && ensureBackend()) {
        lastTickAt = 0;
        timer = setInterval(poll, pollIntervalMs);
        if (typeof timer.unref === "function") timer.unref();
      }
      return getStatus();
    }

    enabled = resolved;
    if (!enabled) {
      stopPolling(reason || "disabled");
      if (backend && typeof backend.shutdown === "function") {
        try {
          backend.shutdown();
        } catch {}
      }
      backend = null;
      clearRuntimeState();
      logger.info("controller:disabled", {
        reason: String(reason || "manual"),
      });
      return getStatus();
    }

    if (!ensureBackend()) {
      enabled = false;
      clearRuntimeState();
      return getStatus();
    }

    clearRuntimeState();
    lastTickAt = 0;
    timer = setInterval(poll, pollIntervalMs);
    if (typeof timer.unref === "function") timer.unref();
    logger.info("controller:enabled", {
      reason: String(reason || "manual"),
      backendType: backend?.type || null,
      dllName: backend.dllName,
      pollIntervalMs,
      gameInputLeftStickDeadzone:
        backend?.type === "gameinput" ? gameInputLeftStickDeadzone : null,
      gameInputRightStickDeadzone:
        backend?.type === "gameinput" ? gameInputRightStickDeadzone : null,
    });
    return getStatus();
  }

  function shutdown(reason = "shutdown") {
    stopPolling(reason);
    enabled = false;
    if (backend && typeof backend.shutdown === "function") {
      try {
        backend.shutdown();
      } catch {}
    }
    backend = null;
    clearRuntimeState();
    logger.info("controller:shutdown", {
      reason: String(reason || "shutdown"),
    });
  }

  return {
    setEnabled,
    shutdown,
    getStatus,
  };
}

module.exports = {
  createControllerInputManager,
  inspectControllerBackendAvailability,
  XINPUT_BUTTONS,
};
