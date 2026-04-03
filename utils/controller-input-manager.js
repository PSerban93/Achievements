const { createRawHidControllerHub } = require("./raw-hid-controller-hub");

const GAMEINPUT_DLL_CANDIDATES = ["GameInputRedist.dll", "GameInput.dll"];
const GAMEINPUT_KIND_CONTROLLER = 0x0000000e;
const GAMEINPUT_KIND_CONTROLLER_BUTTON = 0x00000004;
const GAMEINPUT_KIND_GAMEPAD = 0x00040000;
const GAMEINPUT_POLL_KIND =
  GAMEINPUT_KIND_GAMEPAD | GAMEINPUT_KIND_CONTROLLER;
const GAMEINPUT_DEFAULT_FOCUS_POLICY = 0x00000000;
const GAMEINPUT_FOCUS_ENABLE_BACKGROUND_INPUT = 0x00000040;
const GAMEINPUT_E_DEVICE_DISCONNECTED = 0x838a0001;
const GAMEINPUT_E_DEVICE_NOT_FOUND = 0x838a0002;
const GAMEINPUT_E_READING_NOT_FOUND = 0x838a0003;
const GAMEINPUT_DEVICE_FAMILY_HID = 3;
const GAMEINPUT_SYSTEM_BUTTONS = {
  GUIDE: 0x00000001,
};

const GAMEINPUT_LABELS = {
  XBOX_GUIDE: 1,
  XBOX_BACK: 2,
  XBOX_START: 3,
  XBOX_MENU: 4,
  XBOX_VIEW: 5,
  XBOX_A: 7,
  XBOX_B: 8,
  XBOX_X: 9,
  XBOX_Y: 10,
  XBOX_DPAD_UP: 11,
  XBOX_DPAD_DOWN: 12,
  XBOX_DPAD_LEFT: 13,
  XBOX_DPAD_RIGHT: 14,
  XBOX_LEFT_SHOULDER: 15,
  XBOX_LEFT_TRIGGER: 16,
  XBOX_LEFT_STICK_BUTTON: 17,
  XBOX_RIGHT_SHOULDER: 18,
  XBOX_RIGHT_TRIGGER: 19,
  XBOX_RIGHT_STICK_BUTTON: 20,
  ICON_BRANDING: 75,
  ICON_HOME: 76,
  ICON_MENU: 77,
  ICON_CROSS: 78,
  ICON_CIRCLE: 79,
  ICON_SQUARE: 80,
  ICON_TRIANGLE: 81,
  ICON_DPAD_UP: 83,
  ICON_DPAD_DOWN: 84,
  ICON_DPAD_LEFT: 85,
  ICON_DPAD_RIGHT: 86,
  HOME: 95,
  GUIDE: 96,
  MODE: 97,
  SELECT: 98,
  MENU: 99,
  VIEW: 100,
  BACK: 101,
  START: 102,
  OPTIONS: 103,
  SHARE: 104,
  UP: 105,
  DOWN: 106,
  LEFT: 107,
  RIGHT: 108,
  LB: 109,
  LT: 110,
  LSB: 111,
  L1: 112,
  L2: 113,
  L3: 114,
  RB: 115,
  RT: 116,
  RSB: 117,
  R1: 118,
  R2: 119,
  R3: 120,
};

const GAMEINPUT_GUIDE_LIKE_CONTROLLER_LABELS = new Set([
  GAMEINPUT_LABELS.XBOX_GUIDE,
  GAMEINPUT_LABELS.ICON_BRANDING,
  GAMEINPUT_LABELS.ICON_HOME,
  GAMEINPUT_LABELS.HOME,
  GAMEINPUT_LABELS.GUIDE,
  GAMEINPUT_LABELS.MODE,
]);

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

const GAMEINPUT_CONTROLLER_LABEL_TO_BUTTON_MASK = new Map([
  [GAMEINPUT_LABELS.XBOX_BACK, XINPUT_BUTTONS.BACK],
  [GAMEINPUT_LABELS.XBOX_VIEW, XINPUT_BUTTONS.BACK],
  [GAMEINPUT_LABELS.SELECT, XINPUT_BUTTONS.BACK],
  [GAMEINPUT_LABELS.BACK, XINPUT_BUTTONS.BACK],
  [GAMEINPUT_LABELS.SHARE, XINPUT_BUTTONS.BACK],
  [GAMEINPUT_LABELS.XBOX_START, XINPUT_BUTTONS.START],
  [GAMEINPUT_LABELS.XBOX_MENU, XINPUT_BUTTONS.START],
  [GAMEINPUT_LABELS.ICON_MENU, XINPUT_BUTTONS.START],
  [GAMEINPUT_LABELS.MENU, XINPUT_BUTTONS.START],
  [GAMEINPUT_LABELS.START, XINPUT_BUTTONS.START],
  [GAMEINPUT_LABELS.OPTIONS, XINPUT_BUTTONS.START],
  [GAMEINPUT_LABELS.XBOX_A, XINPUT_BUTTONS.A],
  [GAMEINPUT_LABELS.ICON_CROSS, XINPUT_BUTTONS.A],
  [GAMEINPUT_LABELS.XBOX_B, XINPUT_BUTTONS.B],
  [GAMEINPUT_LABELS.ICON_CIRCLE, XINPUT_BUTTONS.B],
  [GAMEINPUT_LABELS.XBOX_X, XINPUT_BUTTONS.X],
  [GAMEINPUT_LABELS.ICON_SQUARE, XINPUT_BUTTONS.X],
  [GAMEINPUT_LABELS.XBOX_Y, XINPUT_BUTTONS.Y],
  [GAMEINPUT_LABELS.ICON_TRIANGLE, XINPUT_BUTTONS.Y],
  [GAMEINPUT_LABELS.XBOX_DPAD_UP, XINPUT_BUTTONS.DPAD_UP],
  [GAMEINPUT_LABELS.ICON_DPAD_UP, XINPUT_BUTTONS.DPAD_UP],
  [GAMEINPUT_LABELS.UP, XINPUT_BUTTONS.DPAD_UP],
  [GAMEINPUT_LABELS.XBOX_DPAD_DOWN, XINPUT_BUTTONS.DPAD_DOWN],
  [GAMEINPUT_LABELS.ICON_DPAD_DOWN, XINPUT_BUTTONS.DPAD_DOWN],
  [GAMEINPUT_LABELS.DOWN, XINPUT_BUTTONS.DPAD_DOWN],
  [GAMEINPUT_LABELS.XBOX_DPAD_LEFT, XINPUT_BUTTONS.DPAD_LEFT],
  [GAMEINPUT_LABELS.ICON_DPAD_LEFT, XINPUT_BUTTONS.DPAD_LEFT],
  [GAMEINPUT_LABELS.LEFT, XINPUT_BUTTONS.DPAD_LEFT],
  [GAMEINPUT_LABELS.XBOX_DPAD_RIGHT, XINPUT_BUTTONS.DPAD_RIGHT],
  [GAMEINPUT_LABELS.ICON_DPAD_RIGHT, XINPUT_BUTTONS.DPAD_RIGHT],
  [GAMEINPUT_LABELS.RIGHT, XINPUT_BUTTONS.DPAD_RIGHT],
  [GAMEINPUT_LABELS.XBOX_LEFT_SHOULDER, XINPUT_BUTTONS.LEFT_SHOULDER],
  [GAMEINPUT_LABELS.LB, XINPUT_BUTTONS.LEFT_SHOULDER],
  [GAMEINPUT_LABELS.L1, XINPUT_BUTTONS.LEFT_SHOULDER],
  [GAMEINPUT_LABELS.XBOX_RIGHT_SHOULDER, XINPUT_BUTTONS.RIGHT_SHOULDER],
  [GAMEINPUT_LABELS.RB, XINPUT_BUTTONS.RIGHT_SHOULDER],
  [GAMEINPUT_LABELS.R1, XINPUT_BUTTONS.RIGHT_SHOULDER],
  [GAMEINPUT_LABELS.XBOX_LEFT_STICK_BUTTON, XINPUT_BUTTONS.LEFT_THUMB],
  [GAMEINPUT_LABELS.LSB, XINPUT_BUTTONS.LEFT_THUMB],
  [GAMEINPUT_LABELS.L3, XINPUT_BUTTONS.LEFT_THUMB],
  [GAMEINPUT_LABELS.XBOX_RIGHT_STICK_BUTTON, XINPUT_BUTTONS.RIGHT_THUMB],
  [GAMEINPUT_LABELS.RSB, XINPUT_BUTTONS.RIGHT_THUMB],
  [GAMEINPUT_LABELS.R3, XINPUT_BUTTONS.RIGHT_THUMB],
]);

const CONTROLLER_BUTTON_MASKS = {
  A: XINPUT_BUTTONS.A,
  B: XINPUT_BUTTONS.B,
  X: XINPUT_BUTTONS.X,
  Y: XINPUT_BUTTONS.Y,
  BACK: XINPUT_BUTTONS.BACK,
  START: XINPUT_BUTTONS.START,
  LEFT_SHOULDER: XINPUT_BUTTONS.LEFT_SHOULDER,
  RIGHT_SHOULDER: XINPUT_BUTTONS.RIGHT_SHOULDER,
  LEFT_THUMB: XINPUT_BUTTONS.LEFT_THUMB,
  RIGHT_THUMB: XINPUT_BUTTONS.RIGHT_THUMB,
  DPAD_UP: XINPUT_BUTTONS.DPAD_UP,
  DPAD_DOWN: XINPUT_BUTTONS.DPAD_DOWN,
  DPAD_LEFT: XINPUT_BUTTONS.DPAD_LEFT,
  DPAD_RIGHT: XINPUT_BUTTONS.DPAD_RIGHT,
};
const CONTROLLER_BINDING_BUTTON_NAMES = [
  ...Object.keys(CONTROLLER_BUTTON_MASKS),
  "GUIDE",
];

const CONTROLLER_BUTTON_ORDER = [
  "BACK",
  "START",
  "GUIDE",
  "A",
  "B",
  "X",
  "Y",
  "LEFT_SHOULDER",
  "RIGHT_SHOULDER",
  "LEFT_THUMB",
  "RIGHT_THUMB",
  "DPAD_UP",
  "DPAD_DOWN",
  "DPAD_LEFT",
  "DPAD_RIGHT",
];

const DEFAULT_OVERLAY_CONTROLLER_TOGGLE_BINDING = ["BACK", "START"];
const OVERLAY_CONTROLLER_TOGGLE_ALLOWED_BUTTONS = [
  "BACK",
  "START",
  "GUIDE",
  "A",
  "B",
  "X",
  "LEFT_THUMB",
  "RIGHT_THUMB",
];
const DEFAULT_OVERLAY_CONTROLLER_CONTROL_MODE_BINDING = [
  "LEFT_SHOULDER",
  "RIGHT_SHOULDER",
];
const OVERLAY_CONTROLLER_CONTROL_MODE_ALLOWED_BUTTONS = [
  "BACK",
  "START",
  "A",
  "B",
  "X",
  "LEFT_SHOULDER",
  "RIGHT_SHOULDER",
  "LEFT_THUMB",
  "RIGHT_THUMB",
];

const DEFAULTS = {
  pollIntervalMs: 16,
  armedPollIntervalMs: 66,
  hiddenOverlayPollIntervalMs: 150,
  idlePollIntervalMs: 800,
  overlayMoveSpeedPxPerSec: 900,
  overlayScrollRepeatMs: 220,
  controlModeMoveStickDeadzone: 0.2,
  controlModeMoveStickDeadzoneXInput: 0.35,
  toggleCooldownMs: 500,
  toggleReleaseDebounceMs: 120,
  controlModeSnapCooldownMs: 220,
  controlModeSnapReleaseDebounceMs: 80,
  dpadInitialRepeatMs: 220,
  dpadRepeatMs: 90,
  gameInputLeftStickDeadzone: 0.18,
  gameInputRightStickDeadzone: 0.22,
  backendRefreshNoControllerMs: 1500,
};

let cachedKoffi = undefined;
let cachedKoffiError = undefined;
let cachedXInputApi = undefined;
let cachedXInputApiError = undefined;
const cachedGameInputApis = {
  default: undefined,
  system: undefined,
};
const cachedGameInputApiErrors = {
  default: undefined,
  system: undefined,
};
let cachedGameInputTypes = undefined;
const comMethodCache = new Map();
const comProtoCache = new Map();

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

function normalizeControllerButtonName(value) {
  const raw = String(value || "")
    .trim()
    .toUpperCase();
  return CONTROLLER_BINDING_BUTTON_NAMES.includes(raw) ? raw : null;
}

function normalizeControllerBinding(value, options = {}) {
  const allowSingle = options.allowSingle !== false;
  const maxButtons = Math.max(1, Number(options.maxButtons) || 2);
  const defaultBinding = Array.isArray(options.defaultBinding)
    ? options.defaultBinding
    : null;
  const allowedButtonsSource = Array.isArray(options.allowedButtons)
    ? options.allowedButtons
    : CONTROLLER_BUTTON_ORDER;
  const allowedButtons = new Set(
    allowedButtonsSource
      .map((entry) => normalizeControllerButtonName(entry))
      .filter(Boolean),
  );

  let rawButtons = [];
  if (Array.isArray(value)) {
    rawButtons = value;
  } else if (value && typeof value === "object" && Array.isArray(value.buttons)) {
    rawButtons = value.buttons;
  } else if (typeof value === "string") {
    rawButtons = value.split("+");
  }

  const seen = new Set();
  const out = [];
  for (const rawButton of rawButtons) {
    const normalized = normalizeControllerButtonName(rawButton);
    if (!normalized || !allowedButtons.has(normalized) || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    out.push(normalized);
  }

  out.sort((a, b) => {
    const ai = CONTROLLER_BUTTON_ORDER.indexOf(a);
    const bi = CONTROLLER_BUTTON_ORDER.indexOf(b);
    return (ai < 0 ? Number.MAX_SAFE_INTEGER : ai) -
      (bi < 0 ? Number.MAX_SAFE_INTEGER : bi);
  });

  const isValid =
    (allowSingle ? out.length >= 1 : out.length >= 2) && out.length <= maxButtons;
  if (isValid) return out;
  if (defaultBinding) {
    return normalizeControllerBinding(defaultBinding, {
      allowSingle,
      maxButtons,
      allowedButtons: [...allowedButtons],
    });
  }
  return null;
}

function matchesControllerBinding(buttonState, binding) {
  const normalized = normalizeControllerBinding(binding, {
    allowSingle: true,
    maxButtons: 2,
  });
  if (!normalized || !normalized.length) return false;
  const buttons = Number(
    buttonState && typeof buttonState === "object"
      ? buttonState.buttons
      : buttonState,
  ) >>> 0;
  const systemButtons = Number(
    buttonState && typeof buttonState === "object"
      ? buttonState.systemButtons
      : 0,
  ) >>> 0;
  return normalized.every((buttonName) => {
    if (buttonName === "GUIDE") {
      return (
        (systemButtons & GAMEINPUT_SYSTEM_BUTTONS.GUIDE) ===
        GAMEINPUT_SYSTEM_BUTTONS.GUIDE
      );
    }
    const mask = CONTROLLER_BUTTON_MASKS[buttonName];
    return Number.isFinite(mask) && hasButtons(buttons, mask);
  });
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

function toDiagnosticFloat(value, digits = 4) {
  const num = Number(value) || 0;
  return Number(num.toFixed(digits));
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

function applyStickDeadzones(state, leftDeadzone, rightDeadzone) {
  if (!state) return state;
  const left = applyRadialDeadzone(
    state.leftStickX,
    state.leftStickY,
    leftDeadzone,
  );
  const right = applyRadialDeadzone(
    state.rightStickX,
    state.rightStickY,
    rightDeadzone,
  );
  return {
    ...state,
    leftStickX: left.x,
    leftStickY: left.y,
    rightStickX: right.x,
    rightStickY: right.y,
  };
}

function createSlotState() {
  return {
    connected: false,
    previousButtons: 0,
    previousSystemButtons: 0,
    toggleLatched: false,
    toggleReleaseCandidateAt: 0,
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
  systemButtons = 0,
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
    systemButtons: Number(systemButtons) >>> 0,
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
  const APP_LOCAL_DEVICE_ID = koffi.struct("CONTROLLER_APP_LOCAL_DEVICE_ID", {
    value: koffi.array("uint8_t", 32),
  });
  const GameInputUsage = koffi.struct("CONTROLLER_GameInputUsage", {
    page: "uint16_t",
    id: "uint16_t",
  });
  const GameInputVersion = koffi.struct("CONTROLLER_GameInputVersion", {
    major: "uint16_t",
    minor: "uint16_t",
    build: "uint16_t",
    revision: "uint16_t",
  });
  const GameInputControllerButtonInfo = koffi.struct(
    "CONTROLLER_GameInputControllerButtonInfo",
    {
      mappedInputKinds: "uint32_t",
      label: "int32_t",
      legacyDInputIndex: "uint16_t",
      legacyHidIndex: "uint16_t",
      rawReportIndex: "uint32_t",
      inputReport: "void *",
      inputReportItem: "void *",
    },
  );
  const GameInputDeviceInfo = koffi.struct("CONTROLLER_GameInputDeviceInfo", {
    infoSize: "uint32_t",
    vendorId: "uint16_t",
    productId: "uint16_t",
    revisionNumber: "uint16_t",
    interfaceNumber: "uint8_t",
    collectionNumber: "uint8_t",
    usage: GameInputUsage,
    hardwareVersion: GameInputVersion,
    firmwareVersion: GameInputVersion,
    deviceId: APP_LOCAL_DEVICE_ID,
    deviceRootId: APP_LOCAL_DEVICE_ID,
    deviceFamily: "int32_t",
    capabilities: "uint32_t",
    supportedInput: "uint32_t",
    supportedRumbleMotors: "uint32_t",
    inputReportCount: "uint32_t",
    outputReportCount: "uint32_t",
    featureReportCount: "uint32_t",
    controllerAxisCount: "uint32_t",
    controllerButtonCount: "uint32_t",
    controllerSwitchCount: "uint32_t",
    touchPointCount: "uint32_t",
    touchSensorCount: "uint32_t",
    forceFeedbackMotorCount: "uint32_t",
    hapticFeedbackMotorCount: "uint32_t",
    deviceStringCount: "uint32_t",
    deviceDescriptorSize: "uint32_t",
    inputReportInfo: "void *",
    outputReportInfo: "void *",
    featureReportInfo: "void *",
    controllerAxisInfo: "void *",
    controllerButtonInfo: "void *",
  });
  const GameInputSystemButtonCallback = koffi.proto(
    "void __stdcall CONTROLLER_GameInputSystemButtonCallback(uint64_t callbackToken, void *context, void *device, uint64_t timestamp, uint32_t currentButtons, uint32_t previousButtons)",
  );
  cachedGameInputTypes = {
    GUID,
    APP_LOCAL_DEVICE_ID,
    GameInputGamepadState,
    GameInputUsage,
    GameInputVersion,
    GameInputControllerButtonInfo,
    GameInputDeviceInfo,
    GameInputSystemButtonCallback,
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
  let proto = comProtoCache.get(signature);
  if (!proto) {
    proto = koffi.proto(signature);
    comProtoCache.set(signature, proto);
  }
  const fn = koffi.decode(methodPtr, proto);
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

function resolveGameInputApi(mode = "default") {
  const cacheKey = mode === "system" ? "system" : "default";
  if (cachedGameInputApiErrors[cacheKey]) throw cachedGameInputApiErrors[cacheKey];
  if (cachedGameInputApis[cacheKey] !== undefined) {
    return cachedGameInputApis[cacheKey];
  }
  if (process.platform !== "win32") {
    cachedGameInputApis[cacheKey] = null;
    return cachedGameInputApis[cacheKey];
  }

  const koffi = getKoffi();
  const { IID_IGAMEINPUT } = getGameInputTypes();
  const errors = [];
  const candidates =
    cacheKey === "system"
      ? ["GameInput.dll", "GameInputRedist.dll"]
      : GAMEINPUT_DLL_CANDIDATES;
  for (const dllName of candidates) {
    try {
      const lib = koffi.load(dllName);
      let GameInputCreate = null;
      let GameInputInitialize = null;
      try {
        GameInputCreate = lib.func(
          "int32_t __stdcall GameInputCreate(_Out_ void **ppv)",
        );
      } catch {}
      try {
        GameInputInitialize = lib.func(
          "int32_t __stdcall GameInputInitialize(const CONTROLLER_GUID *riid, _Out_ void **ppv)",
        );
      } catch {}
      if (!GameInputCreate && !GameInputInitialize) {
        throw new Error("no supported GameInput entry point");
      }
      cachedGameInputApis[cacheKey] = {
        type: "gameinput",
        dllName,
        IID_IGAMEINPUT,
        GameInputCreate,
        GameInputInitialize,
      };
      return cachedGameInputApis[cacheKey];
    } catch (err) {
      errors.push(`${dllName}: ${err?.message || String(err)}`);
    }
  }

  cachedGameInputApiErrors[cacheKey] = new Error(
    `Unable to load GameInput backend (${errors.join(" | ") || "no candidates"})`,
  );
  throw cachedGameInputApiErrors[cacheKey];
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

function normalizeGameInputState(rawState, timestamp, deviceKey, systemButtons = 0) {
  const packetNumber =
    typeof timestamp === "bigint"
      ? Number(timestamp & 0xffffffffn)
      : Number(timestamp) >>> 0;
  return normalizeGamepadState({
    packetNumber,
    buttons: normalizeGameInputButtons(rawState?.buttons),
    systemButtons,
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

function mapRawHidButtonsToMask(rawSnapshot) {
  let buttons = 0;
  const names = Array.isArray(rawSnapshot?.buttons) ? rawSnapshot.buttons : [];
  for (const name of names) {
    const mask = CONTROLLER_BUTTON_MASKS[String(name || "").trim().toUpperCase()];
    if (Number.isFinite(mask)) {
      buttons |= Number(mask) >>> 0;
    }
  }
  return buttons >>> 0;
}

function mapRawHidSystemButtons(rawSnapshot) {
  let systemButtons = 0;
  const names = Array.isArray(rawSnapshot?.systemButtons)
    ? rawSnapshot.systemButtons
    : [];
  for (const name of names) {
    if (String(name || "").trim().toUpperCase() === "GUIDE") {
      systemButtons |= GAMEINPUT_SYSTEM_BUTTONS.GUIDE;
    }
  }
  return systemButtons >>> 0;
}

function createRawHidGamepadState(rawSnapshot, preferredDeviceKey = null) {
  if (!rawSnapshot || typeof rawSnapshot !== "object") return null;
  return normalizeGamepadState({
    packetNumber: Number(rawSnapshot.packetNumber || 0) >>> 0,
    buttons: mapRawHidButtonsToMask(rawSnapshot),
    systemButtons: mapRawHidSystemButtons(rawSnapshot),
    leftTrigger: Number(rawSnapshot.leftTrigger) || 0,
    rightTrigger: Number(rawSnapshot.rightTrigger) || 0,
    leftStickX: Number(rawSnapshot.leftStickX) || 0,
    leftStickY: Number(rawSnapshot.leftStickY) || 0,
    rightStickX: Number(rawSnapshot.rightStickX) || 0,
    rightStickY: Number(rawSnapshot.rightStickY) || 0,
    deviceKey: preferredDeviceKey || rawSnapshot.deviceKey || null,
  });
}

function isSonyRawHidSnapshot(rawSnapshot) {
  if (!rawSnapshot || typeof rawSnapshot !== "object") return false;
  const profileId = String(rawSnapshot.profileId || rawSnapshot.family || "").toLowerCase();
  return profileId.startsWith("sony-") || Number(rawSnapshot.vid) === 0x054c;
}

function mergeSonyRawHidStandardState(baseState, rawHidState, options = {}) {
  if (!baseState) return rawHidState || null;
  if (!rawHidState) return baseState;

  const analogFallbackThreshold = 0.05;
  const sonyProfileId = String(options.profileId || "").trim().toLowerCase();
  const preferDs4RawStickThreshold = 0.1;
  const ds4BaseStickDriftThreshold = 0.12;
  const ds4RawStickPreferMargin = 0.12;
  const preferBaseAnalog = (baseValue, fallbackValue) =>
    Math.abs(Number(baseValue) || 0) > analogFallbackThreshold
      ? Number(baseValue) || 0
      : Number(fallbackValue) || 0;
  const preferBaseTrigger = (baseValue, fallbackValue) =>
    Number(baseValue) > analogFallbackThreshold
      ? Number(baseValue) || 0
      : Number(fallbackValue) || 0;
  const chooseStickPair = (
    baseX,
    baseY,
    fallbackX,
    fallbackY,
    preferSonyDs4Raw = false,
  ) => {
    const normalizedBaseX = Number(baseX) || 0;
    const normalizedBaseY = Number(baseY) || 0;
    const normalizedFallbackX = Number(fallbackX) || 0;
    const normalizedFallbackY = Number(fallbackY) || 0;
    if (!preferSonyDs4Raw) {
      return [
        preferBaseAnalog(normalizedBaseX, normalizedFallbackX),
        preferBaseAnalog(normalizedBaseY, normalizedFallbackY),
      ];
    }

    const baseMagnitude = Math.hypot(normalizedBaseX, normalizedBaseY);
    const fallbackMagnitude = Math.hypot(
      normalizedFallbackX,
      normalizedFallbackY,
    );

    if (
      baseMagnitude <= ds4BaseStickDriftThreshold &&
      fallbackMagnitude >= preferDs4RawStickThreshold
    ) {
      return [normalizedFallbackX, normalizedFallbackY];
    }
    if (fallbackMagnitude >= baseMagnitude + ds4RawStickPreferMargin) {
      return [normalizedFallbackX, normalizedFallbackY];
    }
    return [normalizedBaseX, normalizedBaseY];
  };
  const [leftStickX, leftStickY] = chooseStickPair(
    baseState.leftStickX,
    baseState.leftStickY,
    rawHidState.leftStickX,
    rawHidState.leftStickY,
    sonyProfileId === "sony-ds4",
  );
  const [rightStickX, rightStickY] = chooseStickPair(
    baseState.rightStickX,
    baseState.rightStickY,
    rawHidState.rightStickX,
    rawHidState.rightStickY,
    sonyProfileId === "sony-ds4",
  );

  return normalizeGamepadState({
    packetNumber: Math.max(
      Number(baseState.packetNumber || 0),
      Number(rawHidState.packetNumber || 0),
    ),
    buttons:
      (Number(baseState.buttons || 0) | Number(rawHidState.buttons || 0)) >>> 0,
    systemButtons:
      (Number(baseState.systemButtons || 0) |
        Number(rawHidState.systemButtons || 0)) >>>
      0,
    leftTrigger: preferBaseTrigger(baseState.leftTrigger, rawHidState.leftTrigger),
    rightTrigger: preferBaseTrigger(baseState.rightTrigger, rawHidState.rightTrigger),
    leftStickX,
    leftStickY,
    rightStickX,
    rightStickY,
    deviceKey: baseState.deviceKey || rawHidState.deviceKey || null,
  });
}

function createGameInputSystemGuideMonitor(logger, options = {}) {
  const api = resolveGameInputApi("system");
  if (!api?.GameInputCreate) {
    throw new Error("GameInput system-button monitor requires GameInputCreate.");
  }

  const koffi = getKoffi();
  const gameInputOut = [null];
  const hr = api.GameInputCreate(gameInputOut);
  if (!isHRESULTSuccess(hr) || !gameInputOut[0]) {
    throw new Error(
      `GameInputCreate failed with HRESULT 0x${normalizeHRESULT(hr).toString(16)}`,
    );
  }

  const gameInput = gameInputOut[0];
  const systemButtonsByDeviceKey = new Map();
  let systemButtonCallbackToken = 0n;
  let systemButtonCallbackPtr = null;
  let backgroundInputCapable = true;
  let focusPolicyError = null;
  const onGuideButtonChanged =
    typeof options.onGuideButtonChanged === "function"
      ? options.onGuideButtonChanged
      : null;

  try {
    const SetFocusPolicy = decodeComMethod(
      gameInput,
      21,
      "void __stdcall SetFocusPolicy(void *self, uint32_t policy)",
    );
    SetFocusPolicy(gameInput, GAMEINPUT_FOCUS_ENABLE_BACKGROUND_INPUT);
  } catch (err) {
    backgroundInputCapable = false;
    focusPolicyError = err?.message || String(err);
    logger.warn("controller:gameinput:guide-monitor-focus-policy-failed", {
      error: focusPolicyError,
      dllName: api.dllName,
    });
  }

  try {
    const { GameInputSystemButtonCallback } = getGameInputTypes();
    systemButtonCallbackPtr = koffi.register(
      (
        callbackToken,
        context,
        device,
        timestamp,
        currentButtons,
        previousButtons,
      ) => {
        const deviceKey = getPointerKey(device);
        if (!deviceKey) return;
        const current = Number(currentButtons) >>> 0;
        const ts =
          typeof timestamp === "bigint"
            ? Number(timestamp & 0xffffffffn)
            : Number(timestamp) >>> 0;
        const currentPressed =
          (current & GAMEINPUT_SYSTEM_BUTTONS.GUIDE) ===
          GAMEINPUT_SYSTEM_BUTTONS.GUIDE;
        const previousPressed =
          (Number(previousButtons) & GAMEINPUT_SYSTEM_BUTTONS.GUIDE) ===
          GAMEINPUT_SYSTEM_BUTTONS.GUIDE;
        if (current) {
          systemButtonsByDeviceKey.set(deviceKey, {
            buttons: current,
            packetNumber: ts >>> 0,
          });
        } else {
          systemButtonsByDeviceKey.delete(deviceKey);
        }
        if (currentPressed !== previousPressed) {
          try {
            onGuideButtonChanged?.({
              source: "gameinput-system",
              deviceKey,
              pressed: currentPressed,
              packetNumber: ts >>> 0,
            });
          } catch {}
        }
      },
      koffi.pointer(GameInputSystemButtonCallback),
    );

    const callbackTokenOut = [0n];
    const RegisterSystemButtonCallback = decodeComMethod(
      gameInput,
      10,
      "int32_t __stdcall RegisterSystemButtonCallback(void *self, void *device, uint32_t buttonFilter, void *context, void *callbackFunc, _Out_ uint64_t *callbackToken)",
    );
    const callbackHr = RegisterSystemButtonCallback(
      gameInput,
      null,
      GAMEINPUT_SYSTEM_BUTTONS.GUIDE,
      null,
      systemButtonCallbackPtr,
      callbackTokenOut,
    );
    if (!isHRESULTSuccess(callbackHr)) {
      throw new Error(
        `RegisterSystemButtonCallback failed with HRESULT 0x${normalizeHRESULT(callbackHr).toString(16)}`,
      );
    }
    systemButtonCallbackToken = callbackTokenOut[0] || 0n;
    logger.info("controller:gameinput:guide-monitor-ready", {
      dllName: api.dllName,
      backgroundInputCapable,
      focusPolicyError,
    });
  } catch (err) {
    if (systemButtonCallbackPtr) {
      try {
        koffi.unregister(systemButtonCallbackPtr);
      } catch {}
      systemButtonCallbackPtr = null;
    }
    try {
      releaseComPtr(gameInput);
    } catch {}
    throw err;
  }

  function getLatestSnapshot() {
    let latest = null;
    for (const [deviceKey, snapshot] of systemButtonsByDeviceKey.entries()) {
      if (
        !latest ||
        Number(snapshot?.packetNumber || 0) >=
          Number(latest?.packetNumber || 0)
      ) {
        latest = {
          deviceKey,
          ...(snapshot || {}),
        };
      }
    }
    return latest;
  }

  return {
    dllName: api.dllName,
    backgroundInputCapable,
    focusPolicyError,
    eventDrivenGuideSupported: true,
    poll() {
      return getLatestSnapshot();
    },
    shutdown() {
      if (systemButtonCallbackToken) {
        try {
          const StopCallback = decodeComMethod(
            gameInput,
            12,
            "void __stdcall StopCallback(void *self, uint64_t callbackToken)",
          );
          StopCallback(gameInput, systemButtonCallbackToken);
        } catch {}
        try {
          const UnregisterCallback = decodeComMethod(
            gameInput,
            13,
            "bool __stdcall UnregisterCallback(void *self, uint64_t callbackToken, uint64_t timeoutInMicroseconds)",
          );
          UnregisterCallback(gameInput, systemButtonCallbackToken, 0n);
        } catch {}
        systemButtonCallbackToken = 0n;
      }
      if (systemButtonCallbackPtr) {
        try {
          koffi.unregister(systemButtonCallbackPtr);
        } catch {}
        systemButtonCallbackPtr = null;
      }
      systemButtonsByDeviceKey.clear();
      releaseComPtr(gameInput);
    },
  };
}

function createXInputPollingBackend(logger, options = {}) {
  const api = resolveXInputApi();
  if (!api) throw new Error("XInput is only available on Windows.");
  const enableGuideFallback = !!options.enableGuideFallback;
  const enableRawHidFallback = !!options.enableRawHidFallback;
  const debugLoggingEnabled = options.debugLoggingEnabled === true;
  const leftStickDeadzone = Math.max(
    0,
    Math.min(
      0.95,
      Number(options.leftStickDeadzone) || DEFAULTS.gameInputLeftStickDeadzone,
    ),
  );
  const rightStickDeadzone = Math.max(
    0,
    Math.min(
      0.95,
      Number(options.rightStickDeadzone) ||
        DEFAULTS.gameInputRightStickDeadzone,
    ),
  );
  let guideMonitor = null;
  let rawHidHub = null;
  let lastRawHidDiagnosticAt = 0;
  if (enableGuideFallback) {
    try {
      guideMonitor = createGameInputSystemGuideMonitor(logger, {
        onGuideButtonChanged: options.onGuideButtonChanged,
      });
    } catch (err) {
      logger.warn("controller:xinput:guide-fallback-unavailable", {
        error: err?.message || String(err),
      });
      guideMonitor = null;
    }
  }
  if (enableRawHidFallback) {
    try {
      rawHidHub = createRawHidControllerHub({
        logger,
        onGuideButtonChanged: options.onGuideButtonChanged,
        debugLoggingEnabled,
      });
    } catch (err) {
      logger.warn("controller:xinput:raw-hid-fallback-unavailable", {
        error: err?.message || String(err),
      });
      rawHidHub = null;
    }
  }
  return {
    type: "xinput",
    dllName: api.dllName,
    eventDrivenGuideSupported: !!guideMonitor || !!rawHidHub,
    poll(runtimeContext = {}) {
      try {
        rawHidHub?.setActive(
          runtimeContext.controlModeActive === true ||
            runtimeContext.overlayPresented === true,
        );
      } catch {}
      const states = [];
      for (let userIndex = 0; userIndex < MAX_CONTROLLER_SLOTS; userIndex += 1) {
        const rawState = {};
        const status = api.XInputGetState(userIndex, rawState);
        if (status === XINPUT_SUCCESS) {
          states[userIndex] = applyStickDeadzones(
            normalizeXInputState(rawState, `xinput:${userIndex}`),
            leftStickDeadzone,
            rightStickDeadzone,
          );
          continue;
        }
        if (status !== XINPUT_ERROR_DEVICE_NOT_CONNECTED) {
          throw new Error(
            `XInputGetState(${userIndex}) failed with status ${status}`,
          );
        }
      }
      const guideSnapshot = guideMonitor?.poll() || null;
      const rawHidSnapshot = rawHidHub?.poll() || null;
      if (
        guideSnapshot &&
        (Number(guideSnapshot.buttons) & GAMEINPUT_SYSTEM_BUTTONS.GUIDE) ===
          GAMEINPUT_SYSTEM_BUTTONS.GUIDE
      ) {
        const connectedIndexes = [];
        for (let i = 0; i < states.length; i += 1) {
          if (states[i]) connectedIndexes.push(i);
        }
        if (connectedIndexes.length > 0) {
          const targetIndex = connectedIndexes[0];
          const current = states[targetIndex];
          states[targetIndex] = normalizeGamepadState({
            ...current,
            packetNumber: Math.max(
              Number(current?.packetNumber || 0),
              Number(guideSnapshot.packetNumber || 0),
            ),
            buttons: Number(current?.buttons || 0) >>> 0,
            systemButtons:
              (Number(current?.systemButtons || 0) |
                GAMEINPUT_SYSTEM_BUTTONS.GUIDE) >>>
              0,
            deviceKey: current?.deviceKey || `xinput:${targetIndex}`,
          });
        }
      }
      if (rawHidSnapshot) {
        const rawState = createRawHidGamepadState(rawHidSnapshot);
        const now = Date.now();
        const hasNotableRawInput =
          Math.abs(Number(rawState?.leftStickX) || 0) > 0.01 ||
          Math.abs(Number(rawState?.leftStickY) || 0) > 0.01 ||
          Math.abs(Number(rawState?.rightStickX) || 0) > 0.01 ||
          Math.abs(Number(rawState?.rightStickY) || 0) > 0.01 ||
          Number(rawState?.buttons || 0) !== 0 ||
          Number(rawState?.systemButtons || 0) !== 0;
        if (
          debugLoggingEnabled &&
          hasNotableRawInput &&
          now - lastRawHidDiagnosticAt >= 750
        ) {
          lastRawHidDiagnosticAt = now;
          logger.info("controller:xinput:raw-hid-snapshot", {
            profileId: rawHidSnapshot.profileId || null,
            rawDeviceKey: rawHidSnapshot.deviceKey || null,
            leftStickX: toDiagnosticFloat(rawState?.leftStickX),
            leftStickY: toDiagnosticFloat(rawState?.leftStickY),
            rightStickX: toDiagnosticFloat(rawState?.rightStickX),
            rightStickY: toDiagnosticFloat(rawState?.rightStickY),
            buttons: `0x${(Number(rawState?.buttons || 0) >>> 0).toString(16)}`,
            systemButtons: `0x${(Number(rawState?.systemButtons || 0) >>> 0).toString(16)}`,
          });
        }
        const connectedIndexes = [];
        for (let i = 0; i < states.length; i += 1) {
          if (states[i]) connectedIndexes.push(i);
        }
        if (connectedIndexes.length > 0) {
          const targetIndex = connectedIndexes[0];
          const current = states[targetIndex];
          states[targetIndex] = normalizeGamepadState({
            ...current,
            packetNumber: Math.max(
              Number(current?.packetNumber || 0),
              Number(rawState?.packetNumber || 0),
            ),
            systemButtons:
              (Number(current?.systemButtons || 0) |
                Number(rawState?.systemButtons || 0)) >>>
              0,
            deviceKey: current?.deviceKey || rawState?.deviceKey || `xinput:${targetIndex}`,
          });
        }
      }
      return states;
    },
    shutdown() {
      try {
        guideMonitor?.shutdown();
      } catch {}
      try {
        rawHidHub?.shutdown();
      } catch {}
    },
  };
}

function createLegacyGameInputPollingBackend(logger, api = null) {
  const resolvedApi = api || resolveGameInputApi();
  if (!resolvedApi?.GameInputInitialize) {
    throw new Error("Legacy GameInputInitialize entry point is unavailable.");
  }
  const apiRef = resolvedApi;
  if (!apiRef) throw new Error("GameInput is only available on Windows.");

  const gameInputOut = [null];
  const hr = apiRef.GameInputInitialize(apiRef.IID_IGAMEINPUT, gameInputOut);
  if (!isHRESULTSuccess(hr) || !gameInputOut[0]) {
    throw new Error(
      `GameInputInitialize failed with HRESULT 0x${normalizeHRESULT(hr).toString(16)}`,
    );
  }

  const gameInput = gameInputOut[0];
  let lockedDevice = null;
  let lastLoggedError = null;
  let backgroundInputCapable = true;
  let focusPolicyError = null;

  try {
    const SetFocusPolicy = decodeComMethod(
      gameInput,
      16,
      "void __stdcall SetFocusPolicy(void *self, uint32_t policy)",
    );
    SetFocusPolicy(gameInput, GAMEINPUT_FOCUS_ENABLE_BACKGROUND_INPUT);
  } catch (err) {
    backgroundInputCapable = false;
    focusPolicyError = err?.message || String(err);
    logger.warn("controller:gameinput:focus-policy-failed", {
      error: focusPolicyError,
      dllName: apiRef.dllName,
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

    const timestamp = GetTimestamp(reading);
    const deviceOut = [null];
    GetDevice(reading, deviceOut);
    if (deviceOut[0]) updateLockedDevice(deviceOut[0]);
    return normalizeGameInputState(
      rawState,
      timestamp,
      getPointerKey(lockedDevice),
      0,
    );
  }

  return {
    type: "gameinput",
    dllName: apiRef.dllName,
    apiFlavor: "initialize",
    backgroundInputCapable,
    focusPolicyError,
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

function createModernGameInputPollingBackend(logger, api = null, options = {}) {
  const resolvedApi = api || resolveGameInputApi();
  if (!resolvedApi?.GameInputCreate) {
    throw new Error("Modern GameInputCreate entry point is unavailable.");
  }
  if (!resolvedApi) throw new Error("GameInput is only available on Windows.");

  const koffi = getKoffi();
  const gameInputOut = [null];
  const hr = resolvedApi.GameInputCreate(gameInputOut);
  if (!isHRESULTSuccess(hr) || !gameInputOut[0]) {
    throw new Error(
      `GameInputCreate failed with HRESULT 0x${normalizeHRESULT(hr).toString(16)}`,
    );
  }

  const gameInput = gameInputOut[0];
  let lockedDevice = null;
  let lastLoggedError = null;
  let backgroundInputCapable = true;
  let focusPolicyError = null;
  const systemButtonsByDeviceKey = new Map();
  const guideLikeControllerButtonsByDeviceKey = new Map();
  const controllerButtonMappingsByDeviceKey = new Map();
  const runtimeFallbackB16LoggedByDeviceKey = new Set();
  const guideLikeControllerButtonCountLoggedByDeviceKey = new Set();
  const dedicatedGamepadFallbackLoggedByDeviceKey = new Set();
  const sonyRawHidStandardFallbackLoggedByDeviceKey = new Set();
  const gameInputDeviceInfoByDeviceKey = new Map();
  const debugLoggingEnabled = options.debugLoggingEnabled === true;
  let systemButtonCallbackToken = 0n;
  let systemButtonCallbackPtr = null;
  const rawHidControllerHub = options.enableRawHidFallback
    ? createRawHidControllerHub({
        logger,
        onGuideButtonChanged: options.onGuideButtonChanged,
        debugLoggingEnabled,
      })
    : null;
  const onGuideButtonChanged =
    typeof options.onGuideButtonChanged === "function"
      ? options.onGuideButtonChanged
      : null;

  try {
    const SetFocusPolicy = decodeComMethod(
      gameInput,
      21,
      "void __stdcall SetFocusPolicy(void *self, uint32_t policy)",
    );
    SetFocusPolicy(gameInput, GAMEINPUT_FOCUS_ENABLE_BACKGROUND_INPUT);
  } catch (err) {
    backgroundInputCapable = false;
    focusPolicyError = err?.message || String(err);
    logger.warn("controller:gameinput:focus-policy-failed", {
      error: focusPolicyError,
      dllName: resolvedApi.dllName,
    });
  }

  try {
    const { GameInputSystemButtonCallback } = getGameInputTypes();
    systemButtonCallbackPtr = koffi.register(
      (
        callbackToken,
        context,
        device,
        timestamp,
        currentButtons,
        previousButtons,
      ) => {
        const deviceKey = getPointerKey(device);
        if (!deviceKey) return;
        const current = Number(currentButtons) >>> 0;
        const ts =
          typeof timestamp === "bigint"
            ? Number(timestamp & 0xffffffffn)
            : Number(timestamp) >>> 0;
        const currentPressed =
          (current & GAMEINPUT_SYSTEM_BUTTONS.GUIDE) ===
          GAMEINPUT_SYSTEM_BUTTONS.GUIDE;
        const previousPressed =
          (Number(previousButtons) & GAMEINPUT_SYSTEM_BUTTONS.GUIDE) ===
          GAMEINPUT_SYSTEM_BUTTONS.GUIDE;
        if (current) {
          systemButtonsByDeviceKey.set(deviceKey, {
            buttons: current,
            packetNumber: ts >>> 0,
          });
        } else {
          systemButtonsByDeviceKey.delete(deviceKey);
        }
        if (currentPressed !== previousPressed) {
          try {
            onGuideButtonChanged?.({
              source: "gameinput-system",
              deviceKey,
              pressed: currentPressed,
              packetNumber: ts >>> 0,
            });
          } catch {}
        }
      },
      koffi.pointer(GameInputSystemButtonCallback),
    );
    const callbackTokenOut = [0n];
    const RegisterSystemButtonCallback = decodeComMethod(
      gameInput,
      10,
      "int32_t __stdcall RegisterSystemButtonCallback(void *self, void *device, uint32_t buttonFilter, void *context, void *callbackFunc, _Out_ uint64_t *callbackToken)",
    );
    const callbackHr = RegisterSystemButtonCallback(
      gameInput,
      null,
      GAMEINPUT_SYSTEM_BUTTONS.GUIDE,
      null,
      systemButtonCallbackPtr,
      callbackTokenOut,
    );
    if (!isHRESULTSuccess(callbackHr)) {
      throw new Error(
        `RegisterSystemButtonCallback failed with HRESULT 0x${normalizeHRESULT(callbackHr).toString(16)}`,
      );
    }
    systemButtonCallbackToken = callbackTokenOut[0] || 0n;
    logger.info("controller:gameinput:system-buttons-ready", {
      dllName: resolvedApi.dllName,
      guideSupported: true,
    });
  } catch (err) {
    if (systemButtonCallbackPtr) {
      try {
        koffi.unregister(systemButtonCallbackPtr);
      } catch {}
      systemButtonCallbackPtr = null;
    }
    logger.warn("controller:gameinput:system-buttons-failed", {
      dllName: resolvedApi.dllName,
      error: err?.message || String(err),
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

  function tryGetCurrentReadingOfKind(inputKind, devicePtr) {
    const GetCurrentReading = decodeComMethod(
      gameInput,
      4,
      "int32_t __stdcall GetCurrentReading(void *self, uint32_t inputKind, void *device, _Out_ void **reading)",
    );
    const out = [null];
    const readingHr = GetCurrentReading(
      gameInput,
      inputKind,
      devicePtr || null,
      out,
    );
    return { hr: readingHr, reading: out[0] || null };
  }

  function tryGetCurrentReading(devicePtr) {
    return tryGetCurrentReadingOfKind(GAMEINPUT_POLL_KIND, devicePtr);
  }

  function getGameInputDeviceInfoSummary(devicePtr) {
    const deviceKey = getPointerKey(devicePtr);
    if (!deviceKey) return null;
    if (gameInputDeviceInfoByDeviceKey.has(deviceKey)) {
      return gameInputDeviceInfoByDeviceKey.get(deviceKey) || null;
    }
    try {
      const { GameInputDeviceInfo } = getGameInputTypes();
      const GetDeviceInfo = decodeComMethod(
        devicePtr,
        3,
        "void * __stdcall GetDeviceInfo(void *self)",
      );
      const deviceInfoPtr = GetDeviceInfo(devicePtr);
      if (!deviceInfoPtr) {
        gameInputDeviceInfoByDeviceKey.set(deviceKey, null);
        return null;
      }
      const deviceInfo = koffi.decode(deviceInfoPtr, GameInputDeviceInfo);
      const summary = {
        deviceKey,
        vendorId: Number(deviceInfo?.vendorId) >>> 0,
        productId: Number(deviceInfo?.productId) >>> 0,
        deviceFamily: Number(deviceInfo?.deviceFamily) || 0,
      };
      gameInputDeviceInfoByDeviceKey.set(deviceKey, summary);
      return summary;
    } catch (err) {
      logger.debug("controller:gameinput:device-info-failed", {
        deviceKey,
        error: err?.message || String(err),
      });
      gameInputDeviceInfoByDeviceKey.set(deviceKey, null);
      return null;
    }
  }

  function getSystemButtonSnapshot(preferredDeviceKey = null) {
    if (
      preferredDeviceKey &&
      systemButtonsByDeviceKey.has(preferredDeviceKey)
    ) {
      return {
        deviceKey: preferredDeviceKey,
        ...(systemButtonsByDeviceKey.get(preferredDeviceKey) || {}),
      };
    }

    if (
      preferredDeviceKey &&
      systemButtonsByDeviceKey.size === 1
    ) {
      const [soleEntry] = systemButtonsByDeviceKey.entries();
      if (soleEntry) {
        return {
          deviceKey: soleEntry[0],
          ...(soleEntry[1] || {}),
        };
      }
    }

    let latest = null;
    for (const [deviceKey, snapshot] of systemButtonsByDeviceKey.entries()) {
      if (
        !latest ||
        Number(snapshot?.packetNumber || 0) >=
          Number(latest?.packetNumber || 0)
      ) {
        latest = {
          deviceKey,
          ...(snapshot || {}),
        };
      }
    }
    return latest;
  }

  function getGuideLikeControllerButtons(devicePtr) {
    const deviceKey = getPointerKey(devicePtr);
    if (!deviceKey) return { indexes: [], labels: [] };
    if (guideLikeControllerButtonsByDeviceKey.has(deviceKey)) {
      return (
        guideLikeControllerButtonsByDeviceKey.get(deviceKey) || {
          indexes: [],
          labels: [],
        }
      );
    }

    const fallback = { indexes: [], labels: [] };
    try {
      const { GameInputControllerButtonInfo, GameInputDeviceInfo } =
        getGameInputTypes();
      const GetDeviceInfo = decodeComMethod(
        devicePtr,
        3,
        "void * __stdcall GetDeviceInfo(void *self)",
      );
      const deviceInfoPtr = GetDeviceInfo(devicePtr);
      if (!deviceInfoPtr) {
        guideLikeControllerButtonsByDeviceKey.set(deviceKey, fallback);
        return fallback;
      }

      const deviceInfo = koffi.decode(deviceInfoPtr, GameInputDeviceInfo);
      const buttonCount = Math.max(
        0,
        Number(deviceInfo?.controllerButtonCount) || 0,
      );
      const buttonInfoPtr = deviceInfo?.controllerButtonInfo || null;
      if (!buttonCount || !buttonInfoPtr) {
        guideLikeControllerButtonsByDeviceKey.set(deviceKey, fallback);
        return fallback;
      }

      const stride = koffi.sizeof(GameInputControllerButtonInfo);
      const mapping = { indexes: [], labels: [] };
      const deviceFamily = Number(deviceInfo?.deviceFamily);
      for (let index = 0; index < buttonCount; index += 1) {
        const buttonInfo = koffi.decode(
          buttonInfoPtr,
          index * stride,
          GameInputControllerButtonInfo,
        );
        const label = Number(buttonInfo?.label);
        if (!GAMEINPUT_GUIDE_LIKE_CONTROLLER_LABELS.has(label)) {
          continue;
        }
        mapping.indexes.push(index);
        if (!mapping.labels.includes(label)) {
          mapping.labels.push(label);
        }
      }

      if (
        !mapping.indexes.length &&
        deviceFamily === GAMEINPUT_DEVICE_FAMILY_HID &&
        buttonCount > 16
      ) {
        mapping.indexes.push(16);
        mapping.labels.push("fallback-b16");
        logger.info("controller:gameinput:guide-like-buttons-fallback-b16", {
          dllName: resolvedApi.dllName,
          deviceKey,
          buttonCount,
          deviceFamily,
          index: 16,
        });
      }

      guideLikeControllerButtonsByDeviceKey.set(deviceKey, mapping);
      if (mapping.indexes.length) {
        logger.info("controller:gameinput:guide-like-buttons-mapped", {
          dllName: resolvedApi.dllName,
          deviceKey,
          indexes: mapping.indexes,
          labels: mapping.labels,
        });
      }
      return mapping;
    } catch (err) {
      logger.warn("controller:gameinput:guide-like-buttons-failed", {
        dllName: resolvedApi.dllName,
        deviceKey,
        error: err?.message || String(err),
      });
      guideLikeControllerButtonsByDeviceKey.set(deviceKey, fallback);
      return fallback;
    }
  }

  function getControllerButtonMappings(devicePtr) {
    const deviceKey = getPointerKey(devicePtr);
    if (!deviceKey) return { entries: [] };
    if (controllerButtonMappingsByDeviceKey.has(deviceKey)) {
      return (
        controllerButtonMappingsByDeviceKey.get(deviceKey) || {
          entries: [],
        }
      );
    }

    const fallback = { entries: [] };
    try {
      const { GameInputControllerButtonInfo, GameInputDeviceInfo } =
        getGameInputTypes();
      const GetDeviceInfo = decodeComMethod(
        devicePtr,
        3,
        "void * __stdcall GetDeviceInfo(void *self)",
      );
      const deviceInfoPtr = GetDeviceInfo(devicePtr);
      if (!deviceInfoPtr) {
        controllerButtonMappingsByDeviceKey.set(deviceKey, fallback);
        return fallback;
      }

      const deviceInfo = koffi.decode(deviceInfoPtr, GameInputDeviceInfo);
      const buttonCount = Math.max(
        0,
        Number(deviceInfo?.controllerButtonCount) || 0,
      );
      const buttonInfoPtr = deviceInfo?.controllerButtonInfo || null;
      if (!buttonCount || !buttonInfoPtr) {
        controllerButtonMappingsByDeviceKey.set(deviceKey, fallback);
        return fallback;
      }

      const stride = koffi.sizeof(GameInputControllerButtonInfo);
      const mapping = { entries: [] };
      for (let index = 0; index < buttonCount; index += 1) {
        const buttonInfo = koffi.decode(
          buttonInfoPtr,
          index * stride,
          GameInputControllerButtonInfo,
        );
        const label = Number(buttonInfo?.label);
        const mask = GAMEINPUT_CONTROLLER_LABEL_TO_BUTTON_MASK.get(label);
        if (!mask) continue;
        mapping.entries.push({
          index,
          label,
          mask,
        });
      }

      controllerButtonMappingsByDeviceKey.set(deviceKey, mapping);
      if (mapping.entries.length) {
        logger.info("controller:gameinput:controller-buttons-mapped", {
          dllName: resolvedApi.dllName,
          deviceKey,
          mappings: mapping.entries.map((entry) => ({
            index: entry.index,
            label: entry.label,
            mask: entry.mask,
          })),
        });
      }
      return mapping;
    } catch (err) {
      logger.warn("controller:gameinput:controller-buttons-failed", {
        dllName: resolvedApi.dllName,
        deviceKey,
        error: err?.message || String(err),
      });
      controllerButtonMappingsByDeviceKey.set(deviceKey, fallback);
      return fallback;
    }
  }

  function getControllerButtonSnapshot(reading, devicePtr) {
    if (!reading || !devicePtr) {
      return {
        buttons: 0,
        hasUsableButtons: false,
      };
    }

    let buttonReading = reading;
    let shouldReleaseButtonReading = false;

    const readControllerButtonCount = (targetReading) => {
      const GetControllerButtonCount = decodeComMethod(
        targetReading,
        10,
        "uint32_t __stdcall GetControllerButtonCount(void *self)",
      );
      return Number(GetControllerButtonCount(targetReading)) >>> 0;
    };

    let buttonCount = readControllerButtonCount(buttonReading);
    if (!buttonCount) {
      const buttonAttempt = tryGetCurrentReadingOfKind(
        GAMEINPUT_KIND_CONTROLLER_BUTTON,
        devicePtr,
      );
      if (isHRESULTSuccess(buttonAttempt.hr) && buttonAttempt.reading) {
        buttonReading = buttonAttempt.reading;
        shouldReleaseButtonReading = buttonReading !== reading;
        buttonCount = readControllerButtonCount(buttonReading);
      }
    }

    const mapping = getControllerButtonMappings(devicePtr);
    if (!buttonCount || !mapping.entries.length) {
      if (shouldReleaseButtonReading && buttonReading) {
        releaseComPtr(buttonReading);
      }
      return {
        buttons: 0,
        hasUsableButtons: false,
      };
    }

    const ReadControllerButtonState = decodeComMethod(
      buttonReading,
      11,
      "uint32_t __stdcall GetControllerButtonState(void *self, uint32_t stateArrayCount, uint8_t *stateArray)",
    );
    const stateBuffer = Buffer.alloc(buttonCount);
    const writtenCount = Number(
      ReadControllerButtonState(buttonReading, buttonCount, stateBuffer),
    ) >>> 0;
    const effectiveCount =
      writtenCount > 0 ? Math.min(writtenCount, buttonCount) : buttonCount;

    let buttons = 0;
    for (const entry of mapping.entries) {
      if (entry.index < effectiveCount && stateBuffer[entry.index]) {
        buttons |= Number(entry.mask) >>> 0;
      }
    }

    if (shouldReleaseButtonReading && buttonReading) {
      releaseComPtr(buttonReading);
    }

    return {
      buttons: buttons >>> 0,
      hasUsableButtons: true,
    };
  }

  function tryReadDedicatedGamepadState(devicePtr) {
    if (!devicePtr) return null;
    const attempt = tryGetCurrentReadingOfKind(GAMEINPUT_KIND_GAMEPAD, devicePtr);
    if (!isHRESULTSuccess(attempt.hr) || !attempt.reading) return null;

    try {
      const GetGamepadState = decodeComMethod(
        attempt.reading,
        22,
        "bool __stdcall GetGamepadState(void *self, _Out_ CONTROLLER_GameInputGamepadState *state)",
      );
      const GetTimestamp = decodeComMethod(
        attempt.reading,
        5,
        "uint64_t __stdcall GetTimestamp(void *self)",
      );

      const rawState = {};
      if (!GetGamepadState(attempt.reading, rawState)) {
        return null;
      }

      return {
        rawState,
        timestamp: GetTimestamp(attempt.reading),
      };
    } finally {
      releaseComPtr(attempt.reading);
    }
  }

  function readGuideLikeControllerSystemButtons(reading, devicePtr) {
    if (!reading || !devicePtr) return 0;
    const deviceKey = getPointerKey(devicePtr);
    const mapping = getGuideLikeControllerButtons(devicePtr);

    let buttonReading = reading;
    let shouldReleaseButtonReading = false;

    const readControllerButtonCount = (targetReading) => {
      const GetControllerButtonCount = decodeComMethod(
        targetReading,
        10,
        "uint32_t __stdcall GetControllerButtonCount(void *self)",
      );
      return Number(GetControllerButtonCount(targetReading)) >>> 0;
    };

    let buttonCount = readControllerButtonCount(buttonReading);
    if (!buttonCount) {
      const buttonAttempt = tryGetCurrentReadingOfKind(
        GAMEINPUT_KIND_CONTROLLER_BUTTON,
        devicePtr,
      );
      if (isHRESULTSuccess(buttonAttempt.hr) && buttonAttempt.reading) {
        buttonReading = buttonAttempt.reading;
        shouldReleaseButtonReading = buttonReading !== reading;
        buttonCount = readControllerButtonCount(buttonReading);
      }
    }
    if (!buttonCount) {
      if (shouldReleaseButtonReading && buttonReading) {
        releaseComPtr(buttonReading);
      }
      return 0;
    }
    if (
      deviceKey &&
      !guideLikeControllerButtonCountLoggedByDeviceKey.has(deviceKey)
    ) {
      guideLikeControllerButtonCountLoggedByDeviceKey.add(deviceKey);
      logger.info("controller:gameinput:guide-like-button-count", {
        dllName: resolvedApi.dllName,
        deviceKey,
        buttonCount,
      });
    }

    const indexesToCheck = mapping.indexes.length
      ? mapping.indexes
      : buttonCount > 16
        ? [16]
        : [];
    if (!indexesToCheck.length) {
      if (shouldReleaseButtonReading && buttonReading) {
        releaseComPtr(buttonReading);
      }
      return 0;
    }
    if (
      !mapping.indexes.length &&
      deviceKey &&
      !runtimeFallbackB16LoggedByDeviceKey.has(deviceKey)
    ) {
      runtimeFallbackB16LoggedByDeviceKey.add(deviceKey);
      logger.info("controller:gameinput:guide-like-buttons-runtime-fallback-b16", {
        dllName: resolvedApi.dllName,
        deviceKey,
        buttonCount,
        index: 16,
      });
    }

    const effectiveButtonCount = buttonCount;

    const ReadControllerButtonState = decodeComMethod(
      buttonReading,
      11,
      "uint32_t __stdcall GetControllerButtonState(void *self, uint32_t stateArrayCount, uint8_t *stateArray)",
    );
    const stateBuffer = Buffer.alloc(effectiveButtonCount);
    const writtenCount = Number(
      ReadControllerButtonState(
        buttonReading,
        effectiveButtonCount,
        stateBuffer,
      ),
    ) >>> 0;
    const effectiveCount =
      writtenCount > 0
        ? Math.min(writtenCount, effectiveButtonCount)
        : effectiveButtonCount;
    let matched = false;
    for (const index of indexesToCheck) {
      if (index < effectiveCount && stateBuffer[index]) {
        matched = true;
        break;
      }
    }
    if (shouldReleaseButtonReading && buttonReading) {
      releaseComPtr(buttonReading);
    }
    return matched ? GAMEINPUT_SYSTEM_BUTTONS.GUIDE : 0;
  }

  function readRawHidGuideSystemButtons(devicePtr, rawHidSnapshot) {
    if (!rawHidSnapshot) return 0;
    const rawSystemButtons = mapRawHidSystemButtons(rawHidSnapshot);
    if (!rawSystemButtons) return 0;
    const deviceInfo = getGameInputDeviceInfoSummary(devicePtr);
    if (!deviceInfo) return rawSystemButtons;
    if (Number(deviceInfo.vendorId) === Number(rawHidSnapshot.vid || 0)) {
      return rawSystemButtons;
    }
    return rawSystemButtons;
  }

  function createSyntheticSystemButtonState(snapshot) {
    if (!snapshot?.deviceKey || !snapshot?.buttons) return null;
    return normalizeGamepadState({
      packetNumber: Number(snapshot.packetNumber) >>> 0,
      buttons: 0,
      systemButtons: Number(snapshot.buttons) >>> 0,
      deviceKey: snapshot.deviceKey,
    });
  }

  function readGamepad(reading, rawHidSnapshot = null) {
    const GetGamepadState = decodeComMethod(
      reading,
      22,
      "bool __stdcall GetGamepadState(void *self, _Out_ CONTROLLER_GameInputGamepadState *state)",
    );
    const GetTimestamp = decodeComMethod(
      reading,
      5,
      "uint64_t __stdcall GetTimestamp(void *self)",
    );
    const GetDevice = decodeComMethod(
      reading,
      6,
      "void __stdcall GetDevice(void *self, _Out_ void **device)",
    );

    const rawState = {};
    let ok = GetGamepadState(reading, rawState);
    let timestamp = GetTimestamp(reading);
    const deviceOut = [null];
    GetDevice(reading, deviceOut);
    if (deviceOut[0]) updateLockedDevice(deviceOut[0]);
    const devicePtr = deviceOut[0] || lockedDevice;
    const deviceKey = getPointerKey(devicePtr);
    const rawHidFallbackState = createRawHidGamepadState(
      rawHidSnapshot,
      deviceKey,
    );
    if (!ok) {
      const dedicatedGamepadState = tryReadDedicatedGamepadState(devicePtr);
      if (dedicatedGamepadState) {
        Object.assign(rawState, dedicatedGamepadState.rawState);
        timestamp = dedicatedGamepadState.timestamp;
        ok = true;
        if (
          deviceKey &&
          !dedicatedGamepadFallbackLoggedByDeviceKey.has(deviceKey)
        ) {
          dedicatedGamepadFallbackLoggedByDeviceKey.add(deviceKey);
          logger.info("controller:gameinput:gamepad-kind-fallback", {
            dllName: resolvedApi.dllName,
            deviceKey,
          });
        }
      }
    }
    const controllerButtonSnapshot = getControllerButtonSnapshot(reading, devicePtr);
    const controllerButtons = Number(controllerButtonSnapshot.buttons || 0) >>> 0;
    const guideLikeSystemButtons = readGuideLikeControllerSystemButtons(
      reading,
      devicePtr,
    );
    const rawHidGuideSystemButtons = readRawHidGuideSystemButtons(
      devicePtr,
      rawHidSnapshot,
    );
    const systemButtonSnapshot = getSystemButtonSnapshot(deviceKey);
    const systemButtons =
      (Number(systemButtonSnapshot?.buttons || 0) |
        Number(guideLikeSystemButtons || 0) |
        Number(rawHidGuideSystemButtons || 0)) >>>
      0;
    if (!ok) {
      if (rawHidFallbackState) {
        return {
          ...rawHidFallbackState,
          buttons:
            (Number(rawHidFallbackState.buttons) | controllerButtons) >>> 0,
          systemButtons:
            (Number(rawHidFallbackState.systemButtons) | systemButtons) >>> 0,
          deviceKey: deviceKey || rawHidFallbackState.deviceKey,
        };
      }
      if (!systemButtons && !controllerButtonSnapshot.hasUsableButtons) return null;
      return normalizeGamepadState({
        packetNumber:
          typeof timestamp === "bigint"
            ? Number(timestamp & 0xffffffffn)
            : Number(timestamp) >>> 0,
        buttons: controllerButtons,
        systemButtons,
        deviceKey,
      });
    }
    const normalizedState = normalizeGameInputState(
      rawState,
      timestamp,
      deviceKey,
      systemButtons,
    );
    let mergedState = {
      ...normalizedState,
      buttons:
        (Number(normalizedState.buttons) | controllerButtons) >>>
        0,
      systemButtons:
        (Number(normalizedState.systemButtons) |
          Number(rawHidFallbackState?.systemButtons || 0)) >>>
        0,
    };
    if (rawHidFallbackState && isSonyRawHidSnapshot(rawHidSnapshot)) {
      mergedState = mergeSonyRawHidStandardState(mergedState, rawHidFallbackState, {
        profileId: rawHidSnapshot?.profileId || null,
      });
      const sonyDeviceKey =
        String(deviceKey || rawHidSnapshot?.deviceKey || rawHidFallbackState?.deviceKey || "");
      if (
        sonyDeviceKey &&
        !sonyRawHidStandardFallbackLoggedByDeviceKey.has(sonyDeviceKey)
      ) {
        sonyRawHidStandardFallbackLoggedByDeviceKey.add(sonyDeviceKey);
        logger.info("controller:gameinput:sony-raw-standard-fallback", {
          dllName: resolvedApi.dllName,
          gameInputDeviceKey: deviceKey || null,
          rawDeviceKey: rawHidSnapshot?.deviceKey || null,
          profileId: rawHidSnapshot?.profileId || null,
        });
      }
    } else if (!controllerButtons && !rawHidFallbackState) {
      return normalizedState;
    }
    return mergedState;
  }

  return {
    type: "gameinput",
    dllName: resolvedApi.dllName,
    apiFlavor: "create",
    backgroundInputCapable,
    focusPolicyError,
    eventDrivenGuideSupported:
      !!systemButtonCallbackPtr || !!rawHidControllerHub,
    poll(runtimeContext = {}) {
      try {
        rawHidControllerHub?.setActive(
          runtimeContext.controlModeActive === true ||
            runtimeContext.overlayPresented === true,
        );
      } catch {}
      const rawHidSnapshot = rawHidControllerHub?.poll() || null;
      let attempt = tryGetCurrentReading(lockedDevice);
      let hrCode = normalizeHRESULT(attempt.hr);
      const lockedDeviceKey = getPointerKey(lockedDevice);

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
        const syntheticState =
          createSyntheticSystemButtonState(
            getSystemButtonSnapshot(lockedDeviceKey),
          ) || createRawHidGamepadState(rawHidSnapshot, lockedDeviceKey);
        if (syntheticState) {
          lastLoggedError = null;
          return [syntheticState];
        }

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
        const state = readGamepad(attempt.reading, rawHidSnapshot);
        return state ? [state] : [];
      } finally {
        releaseComPtr(attempt.reading);
      }
    },
    getLatestRawHidSnapshot() {
      return rawHidControllerHub?.poll() || null;
    },
    shutdown() {
      if (systemButtonCallbackToken) {
        try {
          const StopCallback = decodeComMethod(
            gameInput,
            12,
            "void __stdcall StopCallback(void *self, uint64_t callbackToken)",
          );
          StopCallback(gameInput, systemButtonCallbackToken);
        } catch {}
        try {
          const UnregisterCallback = decodeComMethod(
            gameInput,
            13,
            "bool __stdcall UnregisterCallback(void *self, uint64_t callbackToken, uint64_t timeoutInMicroseconds)",
          );
          UnregisterCallback(gameInput, systemButtonCallbackToken, 0n);
        } catch {}
        systemButtonCallbackToken = 0n;
      }
      if (systemButtonCallbackPtr) {
        try {
          koffi.unregister(systemButtonCallbackPtr);
        } catch {}
        systemButtonCallbackPtr = null;
      }
      systemButtonsByDeviceKey.clear();
      guideLikeControllerButtonsByDeviceKey.clear();
      controllerButtonMappingsByDeviceKey.clear();
      runtimeFallbackB16LoggedByDeviceKey.clear();
      guideLikeControllerButtonCountLoggedByDeviceKey.clear();
      dedicatedGamepadFallbackLoggedByDeviceKey.clear();
      sonyRawHidStandardFallbackLoggedByDeviceKey.clear();
      gameInputDeviceInfoByDeviceKey.clear();
      try {
        rawHidControllerHub?.shutdown();
      } catch {}
      clearLockedDevice("backend-shutdown");
      releaseComPtr(gameInput);
    },
  };
}

function createGameInputPollingBackend(logger) {
  const requiresSystemButtons = false;
  const api = resolveGameInputApi();
  if (!api) throw new Error("GameInput is only available on Windows.");

  if (!requiresSystemButtons && typeof api.GameInputInitialize === "function") {
    return createLegacyGameInputPollingBackend(logger, api);
  }

  if (typeof api.GameInputCreate === "function") {
    try {
      return createModernGameInputPollingBackend(logger, api);
    } catch (err) {
      logger.warn("controller:gameinput:create-backend-failed", {
        dllName: api.dllName,
        error: err?.message || String(err),
      });
    }
  }

  if (typeof api.GameInputInitialize === "function") {
    return createLegacyGameInputPollingBackend(logger, api);
  }

  throw new Error("No supported GameInput backend entry point is available.");
}

function bindingUsesSystemButtons(binding) {
  return Array.isArray(binding) && binding.includes("GUIDE");
}

function createGameInputPollingBackendForBindings(logger, bindings = [], options = {}) {
  const requiresSystemButtons = bindings.some(bindingUsesSystemButtons);
  const api = resolveGameInputApi(requiresSystemButtons ? "system" : "default");
  if (!api) throw new Error("GameInput is only available on Windows.");

  if (!requiresSystemButtons && typeof api.GameInputInitialize === "function") {
    return createLegacyGameInputPollingBackend(logger, api);
  }

  if (typeof api.GameInputCreate === "function") {
    try {
      return createModernGameInputPollingBackend(logger, api, {
        enableRawHidFallback: true,
        onGuideButtonChanged: options.onGuideButtonChanged,
        debugLoggingEnabled: options.debugLoggingEnabled === true,
      });
    } catch (err) {
      logger.warn("controller:gameinput:create-backend-failed", {
        dllName: api.dllName,
        error: err?.message || String(err),
      });
    }
  }

  if (typeof api.GameInputInitialize === "function") {
    return createLegacyGameInputPollingBackend(logger, api);
  }

  throw new Error("No supported GameInput backend entry point is available.");
}

function normalizeBackendPreference(value) {
  const raw = String(value || "auto")
    .trim()
    .toLowerCase();
  if (raw === "gameinput" || raw === "xinput") return raw;
  return "auto";
}

function resolvePreferredBackend(logger, preferredBackend = "auto", options = {}) {
  const requestedBackend = normalizeBackendPreference(preferredBackend);
  const errors = [];
  const relevantBindings = Array.isArray(options.bindings)
    ? options.bindings
    : [];
  const onGuideButtonChanged =
    typeof options.onGuideButtonChanged === "function"
      ? options.onGuideButtonChanged
      : null;
  const leftStickDeadzone = Number(options.leftStickDeadzone);
  const rightStickDeadzone = Number(options.rightStickDeadzone);

  const tryGameInput = () => {
    try {
      return createGameInputPollingBackendForBindings(logger, relevantBindings, {
        onGuideButtonChanged,
        debugLoggingEnabled: options.debugLoggingEnabled === true,
      });
    } catch (err) {
      errors.push(`gameinput: ${err?.message || String(err)}`);
      return null;
    }
  };

  const tryXInput = () => {
    try {
      return createXInputPollingBackend(logger, {
        enableGuideFallback: relevantBindings.some(bindingUsesSystemButtons),
        enableRawHidFallback: true,
        onGuideButtonChanged,
        debugLoggingEnabled: options.debugLoggingEnabled === true,
        leftStickDeadzone,
        rightStickDeadzone,
      });
    } catch (err) {
      errors.push(`xinput: ${err?.message || String(err)}`);
      return null;
    }
  };

  if (requestedBackend === "gameinput") {
    const backend = tryGameInput();
    if (backend) return backend;
    throw new Error(errors.join(" | ") || "No controller backend available");
  }

  if (requestedBackend === "xinput") {
    const backend = tryXInput();
    if (backend) return backend;
    throw new Error(errors.join(" | ") || "No controller backend available");
  }

  const gameInputBackend = tryGameInput();
  if (gameInputBackend?.backgroundInputCapable !== false) {
    return gameInputBackend;
  }

  const xInputBackend = tryXInput();
  if (xInputBackend) {
    logger.info("controller:backend:auto-fallback", {
      requestedBackend,
      from: "gameinput",
      to: "xinput",
      reason: "gameinput-background-unavailable",
      gameInputFocusPolicyError: gameInputBackend?.focusPolicyError || null,
      xInputDllName: xInputBackend.dllName || null,
    });
    return xInputBackend;
  }

  if (gameInputBackend) {
    logger.warn("controller:backend:auto-fallback-unavailable", {
      requestedBackend,
      preferred: "gameinput",
      reason: "xinput-unavailable",
      gameInputFocusPolicyError: gameInputBackend.focusPolicyError || null,
    });
    return gameInputBackend;
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
  const debugLoggingEnabled = options.debugLoggingEnabled === true;
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
  const armedPollIntervalMs = Math.max(
    pollIntervalMs,
    Number(options.armedPollIntervalMs) || DEFAULTS.armedPollIntervalMs,
  );
  const hiddenOverlayPollIntervalMs = Math.max(
    armedPollIntervalMs,
    Number(options.hiddenOverlayPollIntervalMs) ||
      DEFAULTS.hiddenOverlayPollIntervalMs,
  );
  const idlePollIntervalMs = Math.max(
    hiddenOverlayPollIntervalMs,
    Number(options.idlePollIntervalMs) || DEFAULTS.idlePollIntervalMs,
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
  const controlModeMoveStickDeadzone = Math.max(
    0,
    Math.min(
      0.95,
      Number(options.controlModeMoveStickDeadzone) ||
        DEFAULTS.controlModeMoveStickDeadzone,
    ),
  );
  const controlModeMoveStickDeadzoneXInput = Math.max(
    0,
    Math.min(
      0.95,
      Number(options.controlModeMoveStickDeadzoneXInput) ||
        DEFAULTS.controlModeMoveStickDeadzoneXInput,
    ),
  );
  const toggleCooldownMs = Math.max(
    150,
    Number(options.toggleCooldownMs) || DEFAULTS.toggleCooldownMs,
  );
  const toggleReleaseDebounceMs = Math.max(
    40,
    Number(options.toggleReleaseDebounceMs) || DEFAULTS.toggleReleaseDebounceMs,
  );
  const dpadInitialRepeatMs = Math.max(
    100,
    Number(options.dpadInitialRepeatMs) || DEFAULTS.dpadInitialRepeatMs,
  );
  const dpadRepeatMs = Math.max(
    40,
    Number(options.dpadRepeatMs) || DEFAULTS.dpadRepeatMs,
  );
  const controlModeSnapCooldownMs = Math.max(
    120,
    Number(options.controlModeSnapCooldownMs) ||
      DEFAULTS.controlModeSnapCooldownMs,
  );
  const controlModeSnapReleaseDebounceMs = Math.max(
    40,
    Number(options.controlModeSnapReleaseDebounceMs) ||
      DEFAULTS.controlModeSnapReleaseDebounceMs,
  );
  const controlModeSnapStableReleaseMs = Math.max(
    controlModeSnapReleaseDebounceMs,
    controlModeSnapCooldownMs,
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
  const backendRefreshNoControllerMs = Math.max(
    500,
    Number(options.backendRefreshNoControllerMs) ||
      DEFAULTS.backendRefreshNoControllerMs,
  );
  const getPreferredBackend =
    typeof options.getPreferredBackend === "function"
      ? options.getPreferredBackend
      : () => options.preferredBackend;
  const getOverlayToggleBinding =
    typeof options.getOverlayToggleBinding === "function"
      ? options.getOverlayToggleBinding
      : () => DEFAULT_OVERLAY_CONTROLLER_TOGGLE_BINDING;
  const getOverlayControlModeBinding =
    typeof options.getOverlayControlModeBinding === "function"
      ? options.getOverlayControlModeBinding
      : () => DEFAULT_OVERLAY_CONTROLLER_CONTROL_MODE_BINDING;
  const isOverlayPresented =
    typeof options.isOverlayPresented === "function"
      ? options.isOverlayPresented
      : () => false;

  let enabled = false;
  let timer = null;
  let lastTickAt = 0;
  let lastToggleAt = 0;
  let noControllerSince = 0;
  let lastBackendRefreshAt = 0;
  let noControllerRefreshPerformed = false;
  let backend = null;
  let backendFailure = null;
  let backendFailureLogged = false;
  const directGuideToggleLatch = new Map();
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
    snapLatched: false,
    snapReleaseCandidateAt: 0,
    lastSnapAt: 0,
    lastMoveDiagnosticAt: 0,
  };
  const GUIDE_ONLY_TOGGLE_LATCH_KEY = "__guide_only_toggle__";

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
    return applyStickDeadzones(
      state,
      gameInputLeftStickDeadzone,
      gameInputRightStickDeadzone,
    );
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
    controlMode.snapLatched = false;
    controlMode.snapReleaseCandidateAt = 0;
    controlMode.lastSnapAt = 0;
    controlMode.lastMoveDiagnosticAt = 0;
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
      slot.previousSystemButtons = 0;
      slot.toggleLatched = false;
      slot.toggleReleaseCandidateAt = 0;
      slot.current = null;
      slot.lastPacketNumber = null;
      slot.deviceKey = null;
    }
    lastToggleAt = 0;
    noControllerSince = 0;
    noControllerRefreshPerformed = false;
    directGuideToggleLatch.clear();
    resetControlModeState();
  }

  function logConnectedSlotsAsDisconnected(reason = "backend-refresh") {
    for (let userIndex = 0; userIndex < slots.length; userIndex += 1) {
      const slot = slots[userIndex];
      if (!slot?.connected) continue;
      logger.info("controller:disconnected", {
        userIndex,
        backendType: backend?.type || null,
        deviceKey: slot.deviceKey,
        reason: String(reason || "backend-refresh"),
      });
    }
  }

  function stopPolling(reason) {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (controlMode.active) {
      exitControlMode(reason || "polling-stopped");
    }
    lastTickAt = 0;
  }

  function getNormalizedToggleBinding() {
    return normalizeControllerBinding(
      getOverlayToggleBinding?.() || DEFAULT_OVERLAY_CONTROLLER_TOGGLE_BINDING,
      {
        allowSingle: true,
        maxButtons: 2,
        defaultBinding: DEFAULT_OVERLAY_CONTROLLER_TOGGLE_BINDING,
      },
    );
  }

  function isGuideOnlyToggleBinding() {
    const binding = getNormalizedToggleBinding();
    return Array.isArray(binding) && binding.length === 1 && binding[0] === "GUIDE";
  }

  function canHandleEventDrivenGuideToggle() {
    return (
      enabled &&
      !controlMode.active &&
      backend?.eventDrivenGuideSupported === true &&
      backend?.backgroundInputCapable !== false &&
      isGuideOnlyToggleBinding()
    );
  }

  function canSleepForGuideOnlyToggle() {
    return canHandleEventDrivenGuideToggle() && !isOverlayPresented();
  }

  function hasAnyConnectedController() {
    return slots.some((slot) => !!slot.connected);
  }

  function getNextPollDelayMs() {
    if (controlMode.active) return pollIntervalMs;
    if (canSleepForGuideOnlyToggle()) return null;
    if (hasAnyConnectedController()) {
      return isOverlayPresented() ? armedPollIntervalMs : hiddenOverlayPollIntervalMs;
    }
    return idlePollIntervalMs;
  }

  function scheduleNextPoll(delayMs = null) {
    if (!enabled) return;
    const resolvedDelay = Number.isFinite(delayMs)
      ? Number(delayMs)
      : getNextPollDelayMs();
    if (resolvedDelay == null) {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      return;
    }
    const nextDelay = Math.max(0, resolvedDelay);
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    timer = setTimeout(() => {
      timer = null;
      poll();
    }, nextDelay);
    if (typeof timer.unref === "function") timer.unref();
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
      backend = resolvePreferredBackend(
        logger,
        normalizeBackendPreference(getPreferredBackend()),
        {
          bindings: [
            getOverlayToggleBinding?.() || DEFAULT_OVERLAY_CONTROLLER_TOGGLE_BINDING,
            getOverlayControlModeBinding?.() ||
              DEFAULT_OVERLAY_CONTROLLER_CONTROL_MODE_BINDING,
          ],
          onGuideButtonChanged: handleGuideButtonChanged,
          debugLoggingEnabled,
          leftStickDeadzone: gameInputLeftStickDeadzone,
          rightStickDeadzone: gameInputRightStickDeadzone,
        },
      );
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

  function refreshBackend(reason = "refresh") {
    const previousBackendType = backend?.type || null;
    const previousDllName = backend?.dllName || null;
    logConnectedSlotsAsDisconnected(reason);
    if (backend && typeof backend.shutdown === "function") {
      try {
        backend.shutdown();
      } catch {}
    }
    backend = null;
    backendFailure = null;
    backendFailureLogged = false;
    clearRuntimeState();
    lastBackendRefreshAt = Date.now();
    logger.info("controller:backend:refresh", {
      reason: String(reason || "refresh"),
      previousBackendType,
      previousDllName,
    });
    return ensureBackend();
  }

  function isToggleComboPressed(buttons) {
    return matchesControllerBinding(
      buttons,
      getOverlayToggleBinding?.() || DEFAULT_OVERLAY_CONTROLLER_TOGGLE_BINDING,
    );
  }

  function isControlModeHoldPressed(buttons) {
    return matchesControllerBinding(
      buttons,
      getOverlayControlModeBinding?.() ||
        DEFAULT_OVERLAY_CONTROLLER_CONTROL_MODE_BINDING,
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
      const pressedNow = isToggleComboPressed(slot.current);
      const guideOnlyBinding = isGuideOnlyToggleBinding();
      const guideLatchKey = GUIDE_ONLY_TOGGLE_LATCH_KEY;
      if (!pressedNow) {
        if (guideOnlyBinding) {
          directGuideToggleLatch.delete(guideLatchKey);
        }
        if (slot.toggleLatched) {
          if (!slot.toggleReleaseCandidateAt) {
            slot.toggleReleaseCandidateAt = now;
          } else if (
            now - slot.toggleReleaseCandidateAt >= toggleReleaseDebounceMs
          ) {
            slot.toggleLatched = false;
            slot.toggleReleaseCandidateAt = 0;
          }
        } else {
          slot.toggleReleaseCandidateAt = 0;
        }
        continue;
      }

      slot.toggleReleaseCandidateAt = 0;
      if (guideOnlyBinding && directGuideToggleLatch.get(guideLatchKey) === true) {
        continue;
      }
      if (slot.toggleLatched) continue;
      if (now - lastToggleAt < toggleCooldownMs) continue;
      lastToggleAt = now;
      slot.toggleLatched = true;
      if (guideOnlyBinding) {
        directGuideToggleLatch.set(guideLatchKey, true);
      }
      logger.info("controller:overlay-toggle", {
        userIndex,
        backendType: backend?.type || null,
        deviceKey: slot.deviceKey,
      });
      emitAction("overlay.toggle", {
        userIndex,
        combo: (
          getOverlayToggleBinding?.() || DEFAULT_OVERLAY_CONTROLLER_TOGGLE_BINDING
        )
          .join("+")
          .toLowerCase(),
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
      if (!isControlModeHoldPressed(slot.current)) {
        exitControlMode("shoulders-released");
      }
      return;
    }

    for (let userIndex = 0; userIndex < slots.length; userIndex += 1) {
      const slot = slots[userIndex];
      if (!slot || !slot.connected || !slot.current) continue;
      const holdNow = isControlModeHoldPressed(slot.current);
      const holdBefore = isControlModeHoldPressed({
        buttons: slot.previousButtons,
        systemButtons: slot.previousSystemButtons,
      });
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

    const snapPressed = hasButtons(buttons, XINPUT_BUTTONS.Y);
    const snapPressedBefore = hasButtons(previousButtons, XINPUT_BUTTONS.Y);
    if (!snapPressed) {
      if (controlMode.snapLatched) {
        if (!controlMode.snapReleaseCandidateAt) {
          controlMode.snapReleaseCandidateAt = now;
        } else if (
          now - controlMode.snapReleaseCandidateAt >=
            controlModeSnapStableReleaseMs &&
          now - controlMode.lastSnapAt >= controlModeSnapCooldownMs
        ) {
          controlMode.snapLatched = false;
          controlMode.snapReleaseCandidateAt = 0;
        }
      } else {
        controlMode.snapReleaseCandidateAt = 0;
      }
    } else {
      controlMode.snapReleaseCandidateAt = 0;
    }

    if (
      snapPressed &&
      !snapPressedBefore &&
      !controlMode.snapLatched &&
      now - controlMode.lastSnapAt >= controlModeSnapCooldownMs
    ) {
      controlMode.snapLatched = true;
      controlMode.lastSnapAt = now;
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

    const moveDeadzone =
      backend?.type === "xinput"
        ? controlModeMoveStickDeadzoneXInput
        : controlModeMoveStickDeadzone;
    const moveVector = applyRadialDeadzone(
      Number(slot.current.leftStickX) || 0,
      Number(slot.current.leftStickY) || 0,
      moveDeadzone,
    );
    const moveStickX = moveVector.x;
    const moveStickY = moveVector.y;
    if (!moveStickX && !moveStickY) {
      controlMode.moveRemainderX = 0;
      controlMode.moveRemainderY = 0;
    }
    const scaledMoveX =
      moveStickX * overlayMoveSpeedPxPerSec * (deltaMs / 1000);
    const scaledMoveY =
      -moveStickY * overlayMoveSpeedPxPerSec * (deltaMs / 1000);
    const nextMoveX = controlMode.moveRemainderX + scaledMoveX;
    const nextMoveY = controlMode.moveRemainderY + scaledMoveY;
    const moveX = roundTowardZero(nextMoveX);
    const moveY = roundTowardZero(nextMoveY);
    controlMode.moveRemainderX = nextMoveX - moveX;
    controlMode.moveRemainderY = nextMoveY - moveY;
    if (
      debugLoggingEnabled &&
      now - controlMode.lastMoveDiagnosticAt >= 250 &&
      ((Math.abs(Number(slot.current.leftStickX) || 0) > 0.01 ||
        Math.abs(Number(slot.current.leftStickY) || 0) > 0.01 ||
        Math.abs(Number(slot.current.rightStickX) || 0) > 0.01 ||
        Math.abs(Number(slot.current.rightStickY) || 0) > 0.01 ||
        moveX ||
        moveY) ||
        backend?.type === "gameinput")
    ) {
      controlMode.lastMoveDiagnosticAt = now;
      const rawHidSnapshot = backend?.getLatestRawHidSnapshot?.() || null;
      logger.info("controller:control-mode:move-sample", {
        userIndex: controlMode.userIndex,
        backendType: backend?.type || null,
        deviceKey: slot.current.deviceKey || null,
        leftStickX: toDiagnosticFloat(slot.current.leftStickX),
        leftStickY: toDiagnosticFloat(slot.current.leftStickY),
        rightStickX: toDiagnosticFloat(slot.current.rightStickX),
        rightStickY: toDiagnosticFloat(slot.current.rightStickY),
        moveDeadzone: toDiagnosticFloat(moveDeadzone, 3),
        moveVectorX: toDiagnosticFloat(moveStickX),
        moveVectorY: toDiagnosticFloat(moveStickY),
        dx: moveX,
        dy: moveY,
        remainderX: toDiagnosticFloat(controlMode.moveRemainderX),
        remainderY: toDiagnosticFloat(controlMode.moveRemainderY),
        rawProfileId: rawHidSnapshot?.profileId || null,
        rawDeviceKey: rawHidSnapshot?.deviceKey || null,
        rawDiagnostic:
          rawHidSnapshot?.extras && typeof rawHidSnapshot.extras === "object"
            ? rawHidSnapshot.extras.sonyDiagnostic || null
            : null,
      });
    }
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
      slot.previousSystemButtons = slot.current?.systemButtons || 0;
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
      slot.previousSystemButtons = 0;
      slot.toggleLatched = false;
      slot.toggleReleaseCandidateAt = 0;
    }
  }

  function poll() {
    if (!enabled) return;
    if (!backend) {
      if (!ensureBackend()) {
        scheduleNextPoll(idlePollIntervalMs);
        return;
      }
      scheduleNextPoll(0);
      return;
    }
    const now = Date.now();
    const deltaMs =
      lastTickAt > 0
        ? Math.max(8, Math.min(40, now - lastTickAt))
        : pollIntervalMs;
    lastTickAt = now;

    let nextStates = [];
    try {
      const polled = backend.poll({
        overlayPresented: !!isOverlayPresented(),
        controlModeActive: controlMode.active,
      });
      nextStates = Array.isArray(polled) ? polled : [];
    } catch (err) {
      logger.error("controller:poll:failed", {
        backendType: backend?.type || null,
        error: err?.message || String(err),
      });
      nextStates = [];
    }

    applyPolledStates(nextStates);
    const anyConnected = slots.some((slot) => !!slot.connected);
    if (!anyConnected) {
      if (!noControllerSince) {
        noControllerSince = now;
        noControllerRefreshPerformed = false;
      } else if (
        !noControllerRefreshPerformed &&
        now - noControllerSince >= backendRefreshNoControllerMs &&
        now - lastBackendRefreshAt >= backendRefreshNoControllerMs
      ) {
        noControllerRefreshPerformed = true;
        if (refreshBackend("no-controllers-detected")) {
          noControllerSince = now;
          noControllerRefreshPerformed = true;
          scheduleNextPoll();
          return;
        }
      }
    } else {
      noControllerSince = 0;
      noControllerRefreshPerformed = false;
    }
    processToggleActions(now);
    updateControlMode(now);
    processControlModeActions(now, deltaMs);
    storePreviousButtons();
    scheduleNextPoll();
  }

  function handleGuideButtonChanged(payload = {}) {
    const deviceKey = String(payload?.deviceKey || payload?.source || "guide");
    const latchKey = isGuideOnlyToggleBinding()
      ? GUIDE_ONLY_TOGGLE_LATCH_KEY
      : deviceKey;
    const pressed = payload?.pressed === true;
    if (!pressed) {
      directGuideToggleLatch.delete(latchKey);
      return;
    }
    if (!canHandleEventDrivenGuideToggle()) return;
    if (directGuideToggleLatch.get(latchKey) === true) return;
    directGuideToggleLatch.set(latchKey, true);
    if (Date.now() - lastToggleAt < toggleCooldownMs) return;
    lastToggleAt = Date.now();
    logger.info("controller:overlay-toggle", {
      backendType: backend?.type || null,
      deviceKey,
      eventDriven: true,
    });
    emitAction("overlay.toggle", {
      combo: "guide",
      eventDriven: true,
    });
    scheduleNextPoll(0);
  }

  function setEnabled(next, reason = "manual") {
    const resolved = !!next;
    if (resolved === enabled) {
      if (enabled && !timer && ensureBackend()) {
        lastTickAt = 0;
        scheduleNextPoll(0);
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
    scheduleNextPoll(0);
    logger.info("controller:enabled", {
      reason: String(reason || "manual"),
      backendType: backend?.type || null,
      dllName: backend.dllName,
      pollIntervalMs,
      armedPollIntervalMs,
      hiddenOverlayPollIntervalMs,
      idlePollIntervalMs,
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

  function notifyOverlayPresentationChanged(presented, reason = "overlay-presented-changed") {
    if (!enabled) return getStatus();
    if (presented !== true && controlMode.active) {
      exitControlMode("overlay-hidden");
    }
    if (ensureBackend()) {
      scheduleNextPoll(0);
    }
    logger.debug("controller:overlay-presentation-changed", {
      presented: presented === true,
      reason: String(reason || "overlay-presented-changed"),
      controlModeActive: controlMode.active,
    });
    return getStatus();
  }

  return {
    setEnabled,
    notifyOverlayPresentationChanged,
    shutdown,
    getStatus,
  };
}

module.exports = {
  createControllerInputManager,
  inspectControllerBackendAvailability,
  normalizeBackendPreference,
  normalizeControllerBinding,
  matchesControllerBinding,
  normalizeControllerButtonName,
  DEFAULT_OVERLAY_CONTROLLER_TOGGLE_BINDING,
  DEFAULT_OVERLAY_CONTROLLER_CONTROL_MODE_BINDING,
  OVERLAY_CONTROLLER_TOGGLE_ALLOWED_BUTTONS,
  OVERLAY_CONTROLLER_CONTROL_MODE_ALLOWED_BUTTONS,
  XINPUT_BUTTONS,
};
