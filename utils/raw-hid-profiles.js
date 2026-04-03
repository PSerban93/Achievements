const TARGET_VENDOR_IDS = new Set([
  0x054c, // Sony
  0x045e, // Microsoft
  0x2dc8, // 8BitDo
  0x057e, // Nintendo
  0xfe0f, // FakerInput / DS4Windows virtual device
]);

const TARGET_TEXT_PATTERNS = [
  /sony/i,
  /dualsense/i,
  /dualshock/i,
  /wireless controller/i,
  /playstation/i,
  /xbox/i,
  /microsoft/i,
  /8bitdo/i,
  /nintendo/i,
  /switch/i,
  /pro controller/i,
  /fakerinput/i,
  /ryochan/i,
];

const HID_GENERIC_USAGES = {
  X: 0x30,
  Y: 0x31,
  Z: 0x32,
  RX: 0x33,
  RY: 0x34,
  RZ: 0x35,
  SLIDER: 0x36,
  DIAL: 0x37,
  HAT: 0x39,
  START: 0x3d,
  SELECT: 0x3e,
};

function matchesTargetRawHidDevice(device = {}) {
  const vid = Number(device?.vid) >>> 0;
  if (TARGET_VENDOR_IDS.has(vid)) return true;
  const haystack = `${device?.manufacturer || ""} ${device?.product || ""} ${device?.path || ""}`;
  return TARGET_TEXT_PATTERNS.some((pattern) => pattern.test(haystack));
}

function isLikelyDualSense(device = {}) {
  const pid = Number(device?.pid) >>> 0;
  const product = `${device?.product || ""}`.toLowerCase();
  return pid === 0x0ce6 || product.includes("dualsense");
}

function isLikelySonyBluetoothHid(device = {}) {
  const path = `${device?.path || ""}`.toLowerCase();
  return (
    path.includes("bthenum") ||
    path.includes("00001124-0000-1000-8000-00805f9b34fb")
  );
}

function clampUnit(value) {
  return Math.max(-1, Math.min(1, Number(value) || 0));
}

function normalizeSonyAxisByte(value, invert = false) {
  const raw = Math.max(0, Math.min(255, Number(value) || 0));
  const centered = (raw - 128) / 127;
  const normalized = clampUnit(centered);
  return invert ? -normalized : normalized;
}

function decodeHatValue(value) {
  const hat = Number(value) & 0x0f;
  const map = {
    0x0: "up",
    0x1: "up-right",
    0x2: "right",
    0x3: "down-right",
    0x4: "down",
    0x5: "down-left",
    0x6: "left",
    0x7: "up-left",
    0x8: "neutral",
  };
  return map[hat] || "neutral";
}

function normalizeHatValue(value) {
  const raw = Number(value);
  if (!Number.isFinite(raw)) return "neutral";
  if (raw >= 1 && raw <= 8) return decodeHatValue(raw - 1);
  return decodeHatValue(raw);
}

function decodeCommonSonyButtons(buttons1, buttons2, buttons3, extra = {}) {
  return {
    dpad: decodeHatValue(buttons1),
    square: !!(buttons1 & 0x10),
    cross: !!(buttons1 & 0x20),
    circle: !!(buttons1 & 0x40),
    triangle: !!(buttons1 & 0x80),
    l1: !!(buttons2 & 0x01),
    r1: !!(buttons2 & 0x02),
    l2Button: !!(buttons2 & 0x04),
    r2Button: !!(buttons2 & 0x08),
    shareOrCreate: !!(buttons2 & 0x10),
    options: !!(buttons2 & 0x20),
    l3: !!(buttons2 & 0x40),
    r3: !!(buttons2 & 0x80),
    ps: !!(buttons3 & 0x01),
    touchpad: !!(buttons3 & 0x02),
    ...extra,
  };
}

function decodeSonyState(device, report) {
  const vid = Number(device?.vid) >>> 0;
  if (vid !== 0x054c) return null;
  if (!report || report.length < 11) return null;

  const reportId = Number(report[0]) >>> 0;
  const sonyDiag = {
    reportId,
    reportLength: report.length,
    isDualSense: isLikelyDualSense(device),
  };
  const decodeSonyLayout = (family, mode, baseOffset, options = {}) => {
    const buttons0Index = baseOffset + Number(options.buttons0Offset ?? 5);
    const buttons1Index = baseOffset + Number(options.buttons1Offset ?? 6);
    const buttons2Index = baseOffset + Number(options.buttons2Offset ?? 7);
    const leftTriggerIndex = baseOffset + Number(options.leftTriggerOffset ?? 8);
    const rightTriggerIndex =
      baseOffset + Number(options.rightTriggerOffset ?? 9);
    const requiredIndex = Math.max(
      baseOffset + 3,
      buttons2Index,
      rightTriggerIndex,
    );
    if (report.length <= requiredIndex) return null;

    const buttons0 = Number(report[buttons0Index]) >>> 0;
    const buttons1 = Number(report[buttons1Index]) >>> 0;
    const buttons2 = Number(report[buttons2Index]) >>> 0;
    if ((buttons0 & 0x0f) > 0x08) return null;

    return {
      family,
      mode,
      ...decodeCommonSonyButtons(buttons0, buttons1, buttons2, {
        leftStickX: normalizeSonyAxisByte(report[baseOffset]),
        leftStickY: normalizeSonyAxisByte(report[baseOffset + 1], true),
        rightStickX: normalizeSonyAxisByte(report[baseOffset + 2]),
        rightStickY: normalizeSonyAxisByte(report[baseOffset + 3], true),
        mute:
          options.includeMute === true ? !!(buttons2 & 0x04) : undefined,
        l2:
          report.length > leftTriggerIndex ? report[leftTriggerIndex] : undefined,
        r2:
          report.length > rightTriggerIndex
            ? report[rightTriggerIndex]
            : undefined,
        sonyDiagnostic: {
          ...sonyDiag,
          mode,
          baseOffset,
          buttons0Index,
          buttons1Index,
          buttons2Index,
          buttons0,
          buttons1,
          buttons2,
        },
      }),
    };
  };

  if (isLikelyDualSense(device)) {
    if (reportId === 0x01) {
      const btMinCandidate = decodeSonyLayout(
        "sony-dualsense",
        "dualsense-bt-min",
        1,
        {
          buttons0Offset: 4,
          buttons1Offset: 5,
          buttons2Offset: 6,
          leftTriggerOffset: 7,
          rightTriggerOffset: 8,
          includeMute: false,
        },
      );
      const usbCandidate = decodeSonyLayout("sony-dualsense", "dualsense-usb", 1, {
        buttons0Offset: 7,
        buttons1Offset: 8,
        buttons2Offset: 9,
        leftTriggerOffset: 4,
        rightTriggerOffset: 5,
        includeMute: true,
      });
      if (isLikelySonyBluetoothHid(device)) {
        return btMinCandidate || usbCandidate;
      }
      if (report.length <= 12) {
        return btMinCandidate || usbCandidate;
      }
      return usbCandidate || btMinCandidate;
    }
    if (reportId === 0x31) {
      return decodeSonyLayout("sony-dualsense", "dualsense-bt", 2, {
        buttons0Offset: 7,
        buttons1Offset: 8,
        buttons2Offset: 9,
        leftTriggerOffset: 4,
        rightTriggerOffset: 5,
        includeMute: true,
      });
    }
    if (report.length >= 9) {
      return decodeSonyLayout("sony-dualsense", "dualsense-bt-min-noid", 0, {
        buttons0Offset: 4,
        buttons1Offset: 5,
        buttons2Offset: 6,
        leftTriggerOffset: 7,
        rightTriggerOffset: 8,
        includeMute: false,
      });
    }
    return null;
  }

  if (reportId === 0x01) {
    const preferredCandidate = decodeSonyLayout("sony-ds4", "dualshock4-usb", 1, {
      buttons0Offset: 4,
      buttons1Offset: 5,
      buttons2Offset: 6,
      leftTriggerOffset: 7,
      rightTriggerOffset: 8,
    });
    const legacyCandidate = decodeSonyLayout("sony-ds4", "dualshock4-usb-legacy", 1);
    return preferredCandidate || legacyCandidate;
  }
  if (reportId === 0x11) {
    const preferredCandidate = decodeSonyLayout("sony-ds4", "dualshock4-bt", 3, {
      buttons0Offset: 4,
      buttons1Offset: 5,
      buttons2Offset: 6,
      leftTriggerOffset: 7,
      rightTriggerOffset: 8,
    });
    const legacyCandidate = decodeSonyLayout("sony-ds4", "dualshock4-bt-legacy", 3);
    return preferredCandidate || legacyCandidate;
  }
  if (report.length >= 9) {
    const preferredCandidate = decodeSonyLayout("sony-ds4", "dualshock4-bt-noid", 0, {
      buttons0Offset: 4,
      buttons1Offset: 5,
      buttons2Offset: 6,
      leftTriggerOffset: 7,
      rightTriggerOffset: 8,
    });
    const legacyCandidate = decodeSonyLayout(
      "sony-ds4",
      "dualshock4-bt-noid-legacy",
      0,
    );
    return preferredCandidate || legacyCandidate;
  }

  return null;
}

function pushIf(buttons, condition, name) {
  if (condition) buttons.push(name);
}

function addDpadButtons(buttons, dpad) {
  switch (dpad) {
    case "up":
      buttons.push("DPAD_UP");
      break;
    case "up-right":
      buttons.push("DPAD_UP", "DPAD_RIGHT");
      break;
    case "right":
      buttons.push("DPAD_RIGHT");
      break;
    case "down-right":
      buttons.push("DPAD_DOWN", "DPAD_RIGHT");
      break;
    case "down":
      buttons.push("DPAD_DOWN");
      break;
    case "down-left":
      buttons.push("DPAD_DOWN", "DPAD_LEFT");
      break;
    case "left":
      buttons.push("DPAD_LEFT");
      break;
    case "up-left":
      buttons.push("DPAD_UP", "DPAD_LEFT");
      break;
    default:
      break;
  }
}

function finalizeRawState(device, profileId, payload = {}) {
  const buttons = Array.isArray(payload.buttons)
    ? [...new Set(payload.buttons)]
    : [];
  const systemButtons = Array.isArray(payload.systemButtons)
    ? [...new Set(payload.systemButtons)]
    : [];
  return {
    profileId: String(profileId || "unknown"),
    family: String(payload.family || profileId || "unknown"),
    deviceKey: String(payload.deviceKey || device?.deviceKey || device?.path || ""),
    vid: Number(device?.vid) >>> 0,
    pid: Number(device?.pid) >>> 0,
    manufacturer: device?.manufacturer || null,
    product: device?.product || null,
    buttons,
    systemButtons,
    leftTrigger: Math.max(0, Math.min(1, Number(payload.leftTrigger) || 0)),
    rightTrigger: Math.max(0, Math.min(1, Number(payload.rightTrigger) || 0)),
    leftStickX: clampUnit(payload.leftStickX),
    leftStickY: clampUnit(payload.leftStickY),
    rightStickX: clampUnit(payload.rightStickX),
    rightStickY: clampUnit(payload.rightStickY),
    extras: payload.extras && typeof payload.extras === "object"
      ? payload.extras
      : {},
  };
}

function extractSonyDiagnosticBytes(report, indices = []) {
  const out = {};
  for (const index of indices) {
    const key = `b${Number(index)}`;
    out[key] = report && index >= 0 && index < report.length ? Number(report[index]) >>> 0 : null;
  }
  return out;
}

function normalizeGenericAxis(rawValue, logicalRange = null, invert = false) {
  const raw = Number(rawValue);
  if (!Number.isFinite(raw)) return 0;
  const logicalMin = Number(logicalRange?.min);
  const logicalMax = Number(logicalRange?.max);
  if (!Number.isFinite(logicalMin) || !Number.isFinite(logicalMax) || logicalMax === logicalMin) {
    const fallback = clampUnit(raw);
    return invert ? -fallback : fallback;
  }
  const mid = logicalMin + (logicalMax - logicalMin) / 2;
  const span = Math.max(1, (logicalMax - logicalMin) / 2);
  const normalized = clampUnit((raw - mid) / span);
  return invert ? -normalized : normalized;
}

function getNormalizedValue(genericState, usage) {
  const entry = genericState?.values?.[usage];
  if (!entry) return 0;
  return clampUnit(entry.normalized);
}

function getRawValue(genericState, usage) {
  const entry = genericState?.values?.[usage];
  if (!entry) return null;
  return Number(entry.raw);
}

function mapGenericPressedButtons(pressedButtons, mapping) {
  const out = [];
  const pressed = new Set(
    Array.isArray(pressedButtons)
      ? pressedButtons.map((value) => Number(value) >>> 0)
      : [],
  );
  for (const [usage, buttonName] of Object.entries(mapping || {})) {
    if (pressed.has(Number(usage) >>> 0) && buttonName) out.push(buttonName);
  }
  return out;
}

function appendGenericUsagesButton(out, genericState, usage, buttonName) {
  const raw = getRawValue(genericState, usage);
  if (Number.isFinite(raw) && raw > 0 && buttonName) out.push(buttonName);
}

function decodeSonyProfile(device, report, options = {}) {
  const includeDiagnostics = options.debugLoggingEnabled === true;
  const sonyState = decodeSonyState(device, report);
  if (!sonyState) return null;
  const buttons = [];
  pushIf(buttons, sonyState.cross, "A");
  pushIf(buttons, sonyState.circle, "B");
  pushIf(buttons, sonyState.square, "X");
  pushIf(buttons, sonyState.triangle, "Y");
  pushIf(buttons, sonyState.l1, "LEFT_SHOULDER");
  pushIf(buttons, sonyState.r1, "RIGHT_SHOULDER");
  pushIf(buttons, sonyState.shareOrCreate, "BACK");
  pushIf(buttons, sonyState.options, "START");
  pushIf(buttons, sonyState.l3, "LEFT_THUMB");
  pushIf(buttons, sonyState.r3, "RIGHT_THUMB");
  pushIf(buttons, sonyState.touchpad, "TOUCHPAD_CLICK");
  addDpadButtons(buttons, sonyState.dpad);
  return finalizeRawState(device, sonyState.family, {
    family: sonyState.family,
    buttons,
    systemButtons: sonyState.ps ? ["GUIDE"] : [],
    leftTrigger: Math.max(0, Math.min(1, (Number(sonyState.l2) || 0) / 255)),
    rightTrigger: Math.max(0, Math.min(1, (Number(sonyState.r2) || 0) / 255)),
    leftStickX: sonyState.leftStickX,
    leftStickY: sonyState.leftStickY,
    rightStickX: sonyState.rightStickX,
    rightStickY: sonyState.rightStickY,
    extras: {
      dpad: sonyState.dpad,
      mute: sonyState.mute === true,
      sonyDiagnostic:
        includeDiagnostics &&
        sonyState.sonyDiagnostic &&
        typeof sonyState.sonyDiagnostic === "object"
          ? {
              ...sonyState.sonyDiagnostic,
              leftStickX: sonyState.leftStickX,
              leftStickY: sonyState.leftStickY,
              rightStickX: sonyState.rightStickX,
              rightStickY: sonyState.rightStickY,
              rawBytes: extractSonyDiagnosticBytes(report, [
                0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11,
              ]),
            }
          : null,
    },
  });
}

function buildGenericState(device, profileId, genericState, options = {}) {
  if (!genericState) return null;
  const buttons = mapGenericPressedButtons(
    genericState.pressedButtons,
    options.buttonUsageMap,
  );
  if (options.startUsage) {
    appendGenericUsagesButton(buttons, genericState, options.startUsage, "START");
  }
  if (options.selectUsage) {
    appendGenericUsagesButton(buttons, genericState, options.selectUsage, "BACK");
  }
  if (options.guideUsage) {
    appendGenericUsagesButton(buttons, genericState, options.guideUsage, "GUIDE");
  }
  if (options.captureUsage) {
    appendGenericUsagesButton(buttons, genericState, options.captureUsage, "CAPTURE");
  }
  const systemButtons = buttons.includes("GUIDE") ? ["GUIDE"] : [];
  const filteredButtons = buttons.filter((button) => button !== "GUIDE" && button !== "CAPTURE");
  addDpadButtons(filteredButtons, normalizeHatValue(getRawValue(genericState, HID_GENERIC_USAGES.HAT)));

  const axisCandidates = options.axisMap || {};
  const leftStickX = getNormalizedValue(genericState, axisCandidates.leftStickX ?? HID_GENERIC_USAGES.X);
  const leftStickY = -getNormalizedValue(genericState, axisCandidates.leftStickY ?? HID_GENERIC_USAGES.Y);

  const rightXUsageCandidates = Array.isArray(axisCandidates.rightStickX)
    ? axisCandidates.rightStickX
    : [axisCandidates.rightStickX ?? HID_GENERIC_USAGES.RX, HID_GENERIC_USAGES.Z];
  const rightYUsageCandidates = Array.isArray(axisCandidates.rightStickY)
    ? axisCandidates.rightStickY
    : [axisCandidates.rightStickY ?? HID_GENERIC_USAGES.RY, HID_GENERIC_USAGES.RZ];

  const firstNormalized = (usages) => {
    for (const usage of usages) {
      const value = getNormalizedValue(genericState, usage);
      if (Math.abs(value) > 0.0001) return value;
    }
    return getNormalizedValue(genericState, usages[0]);
  };

  const rightStickX = firstNormalized(rightXUsageCandidates);
  const rightStickY = -firstNormalized(rightYUsageCandidates);

  const leftTriggerUsage = axisCandidates.leftTrigger ?? HID_GENERIC_USAGES.Z;
  const rightTriggerUsage = axisCandidates.rightTrigger ?? HID_GENERIC_USAGES.RZ;

  const leftTriggerRaw = getRawValue(genericState, leftTriggerUsage);
  const rightTriggerRaw = getRawValue(genericState, rightTriggerUsage);

  const normalizeTrigger = (usage, raw) => {
    const entry = genericState?.values?.[usage];
    if (!entry || !Number.isFinite(raw)) return 0;
    const min = Number(entry.min);
    const max = Number(entry.max);
    if (!Number.isFinite(min) || !Number.isFinite(max) || max === min) {
      return Math.max(0, Math.min(1, Number(entry.normalized) || 0));
    }
    return Math.max(0, Math.min(1, (raw - min) / (max - min)));
  };

  return finalizeRawState(device, profileId, {
    family: profileId,
    buttons: filteredButtons,
    systemButtons,
    leftStickX,
    leftStickY,
    rightStickX,
    rightStickY,
    leftTrigger: normalizeTrigger(leftTriggerUsage, leftTriggerRaw),
    rightTrigger: normalizeTrigger(rightTriggerUsage, rightTriggerRaw),
    extras: {
      hat: normalizeHatValue(getRawValue(genericState, HID_GENERIC_USAGES.HAT)),
      capture: buttons.includes("CAPTURE"),
    },
  });
}

const XBOX_BUTTON_USAGE_MAP = {
  1: "A",
  2: "B",
  3: "X",
  4: "Y",
  5: "LEFT_SHOULDER",
  6: "RIGHT_SHOULDER",
  9: "BACK",
  10: "START",
  11: "LEFT_THUMB",
  12: "RIGHT_THUMB",
  13: "GUIDE",
};

const SWITCH_BUTTON_USAGE_MAP = {
  1: "B",
  2: "A",
  3: "Y",
  4: "X",
  5: "LEFT_SHOULDER",
  6: "RIGHT_SHOULDER",
  9: "BACK",
  10: "START",
  11: "LEFT_THUMB",
  12: "RIGHT_THUMB",
  13: "GUIDE",
  14: "CAPTURE",
};

function getRawHidDeviceProfile(device = {}) {
  const vid = Number(device?.vid) >>> 0;
  const pid = Number(device?.pid) >>> 0;
  const product = `${device?.product || ""}`.toLowerCase();
  const manufacturer = `${device?.manufacturer || ""}`.toLowerCase();
  const path = `${device?.path || ""}`.toLowerCase();

  if (vid === 0x054c) {
    return {
      id: isLikelyDualSense(device) ? "sony-dualsense" : "sony-ds4",
      family: "sony",
      parser: "sony-raw",
    };
  }

  if (vid === 0x057e || /nintendo|switch|pro controller/.test(`${manufacturer} ${product} ${path}`)) {
    return {
      id: "switch-pro",
      family: "switch",
      parser: "generic-hid",
      buttonUsageMap: SWITCH_BUTTON_USAGE_MAP,
      axisMap: {
        leftStickX: HID_GENERIC_USAGES.X,
        leftStickY: HID_GENERIC_USAGES.Y,
        rightStickX: [HID_GENERIC_USAGES.Z, HID_GENERIC_USAGES.RX],
        rightStickY: [HID_GENERIC_USAGES.RZ, HID_GENERIC_USAGES.RY],
        leftTrigger: HID_GENERIC_USAGES.Z,
        rightTrigger: HID_GENERIC_USAGES.RZ,
      },
    };
  }

  if (vid === 0x2dc8 || /8bitdo/.test(`${manufacturer} ${product} ${path}`)) {
    const switchLike = /switch|nintendo/.test(`${manufacturer} ${product} ${path}`);
    return {
      id: switchLike ? "8bitdo-switch" : "8bitdo-xbox",
      family: "8bitdo",
      parser: "generic-hid",
      buttonUsageMap: switchLike ? SWITCH_BUTTON_USAGE_MAP : XBOX_BUTTON_USAGE_MAP,
      axisMap: {
        leftStickX: HID_GENERIC_USAGES.X,
        leftStickY: HID_GENERIC_USAGES.Y,
        rightStickX: [HID_GENERIC_USAGES.RX, HID_GENERIC_USAGES.Z],
        rightStickY: [HID_GENERIC_USAGES.RY, HID_GENERIC_USAGES.RZ],
        leftTrigger: HID_GENERIC_USAGES.Z,
        rightTrigger: HID_GENERIC_USAGES.RZ,
      },
    };
  }

  if (vid === 0xfe0f || /fakerinput|ryochan/.test(`${manufacturer} ${product} ${path}`)) {
    return {
      id: "fakerinput-xbox",
      family: "fakerinput",
      parser: "generic-hid",
      buttonUsageMap: XBOX_BUTTON_USAGE_MAP,
      axisMap: {
        leftStickX: HID_GENERIC_USAGES.X,
        leftStickY: HID_GENERIC_USAGES.Y,
        rightStickX: [HID_GENERIC_USAGES.RX, HID_GENERIC_USAGES.Z],
        rightStickY: [HID_GENERIC_USAGES.RY, HID_GENERIC_USAGES.RZ],
        leftTrigger: HID_GENERIC_USAGES.Z,
        rightTrigger: HID_GENERIC_USAGES.RZ,
      },
    };
  }

  if (vid === 0x045e || /xbox|microsoft/.test(`${manufacturer} ${product} ${path}`)) {
    return {
      id: "xbox-hid",
      family: "xbox",
      parser: "generic-hid",
      buttonUsageMap: XBOX_BUTTON_USAGE_MAP,
      axisMap: {
        leftStickX: HID_GENERIC_USAGES.X,
        leftStickY: HID_GENERIC_USAGES.Y,
        rightStickX: [HID_GENERIC_USAGES.RX, HID_GENERIC_USAGES.Z],
        rightStickY: [HID_GENERIC_USAGES.RY, HID_GENERIC_USAGES.RZ],
        leftTrigger: HID_GENERIC_USAGES.Z,
        rightTrigger: HID_GENERIC_USAGES.RZ,
      },
    };
  }

  return {
    id: "generic-gamepad",
    family: "generic",
    parser: "generic-hid",
    buttonUsageMap: XBOX_BUTTON_USAGE_MAP,
    axisMap: {
      leftStickX: HID_GENERIC_USAGES.X,
      leftStickY: HID_GENERIC_USAGES.Y,
      rightStickX: [HID_GENERIC_USAGES.RX, HID_GENERIC_USAGES.Z],
      rightStickY: [HID_GENERIC_USAGES.RY, HID_GENERIC_USAGES.RZ],
      leftTrigger: HID_GENERIC_USAGES.Z,
      rightTrigger: HID_GENERIC_USAGES.RZ,
    },
  };
}

function decodeRawHidProfileState(profile, device, input = {}) {
  if (!profile || !device) return null;
  if (profile.parser === "sony-raw") {
    return decodeSonyProfile(device, input.report, {
      debugLoggingEnabled: input.debugLoggingEnabled === true,
    });
  }
  if (profile.parser === "generic-hid") {
    return buildGenericState(device, profile.id, input.genericState, {
      buttonUsageMap: profile.buttonUsageMap,
      axisMap: profile.axisMap,
    });
  }
  return null;
}

module.exports = {
  HID_GENERIC_USAGES,
  matchesTargetRawHidDevice,
  getRawHidDeviceProfile,
  decodeRawHidProfileState,
};
