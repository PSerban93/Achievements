const { parentPort, workerData } = require("node:worker_threads");
const koffi = require("koffi");
const {
  HID_GENERIC_USAGES,
  matchesTargetRawHidDevice,
  getRawHidDeviceProfile,
  decodeRawHidProfileState,
} = require("./raw-hid-profiles");

if (!parentPort || process.platform !== "win32") {
  process.exit(0);
}

const POINTER_SIZE = process.arch === "x64" ? 8 : 4;
const INVALID_HANDLE_64 = 0xffffffffffffffffn;
const GENERIC_READ = 0x80000000;
const FILE_SHARE_READ = 0x00000001;
const FILE_SHARE_WRITE = 0x00000002;
const OPEN_EXISTING = 3;
const FILE_FLAG_OVERLAPPED = 0x40000000;
const DIGCF_PRESENT = 0x00000002;
const DIGCF_DEVICEINTERFACE = 0x00000010;
const WAIT_OBJECT_0 = 0;
const WAIT_TIMEOUT = 258;
const WAIT_FAILED = 0xffffffff;
const ERROR_NO_MORE_ITEMS = 259;
const ERROR_INSUFFICIENT_BUFFER = 122;
const ERROR_IO_PENDING = 997;
const DEFAULT_REPORT_BUFFER_LENGTH = 128;
const HIDP_REPORT_TYPE_INPUT = 0;
const HID_USAGE_PAGE_BUTTON = 0x09;
const HID_USAGE_PAGE_GENERIC = 0x01;

const rediscoveryIntervalMs = Math.max(
  500,
  Number(workerData?.rediscoveryIntervalMs) || 1500,
);
const idleRediscoveryIntervalMs = Math.max(
  rediscoveryIntervalMs,
  Number(workerData?.idleRediscoveryIntervalMs) || 5000,
);
const debugLoggingEnabled = workerData?.debugLoggingEnabled === true;

const GUID = koffi.struct("CONTROLLER_RAW_HID_GUID", {
  Data1: "uint32_t",
  Data2: "uint16_t",
  Data3: "uint16_t",
  Data4: koffi.array("uint8_t", 8),
});

const HIDD_ATTRIBUTES = koffi.struct("CONTROLLER_RAW_HID_HIDD_ATTRIBUTES", {
  Size: "uint32_t",
  VendorID: "uint16_t",
  ProductID: "uint16_t",
  VersionNumber: "uint16_t",
});

const OVERLAPPED = koffi.struct("CONTROLLER_RAW_HID_OVERLAPPED", {
  Internal: "uintptr_t",
  InternalHigh: "uintptr_t",
  Offset: "uint32_t",
  OffsetHigh: "uint32_t",
  hEvent: "void *",
});

const HIDP_CAPS = koffi.struct("CONTROLLER_RAW_HIDP_CAPS", {
  Usage: "uint16_t",
  UsagePage: "uint16_t",
  InputReportByteLength: "uint16_t",
  OutputReportByteLength: "uint16_t",
  FeatureReportByteLength: "uint16_t",
  Reserved: koffi.array("uint16_t", 17),
  NumberLinkCollectionNodes: "uint16_t",
  NumberInputButtonCaps: "uint16_t",
  NumberInputValueCaps: "uint16_t",
  NumberInputDataIndices: "uint16_t",
  NumberOutputButtonCaps: "uint16_t",
  NumberOutputValueCaps: "uint16_t",
  NumberOutputDataIndices: "uint16_t",
  NumberFeatureButtonCaps: "uint16_t",
  NumberFeatureValueCaps: "uint16_t",
  NumberFeatureDataIndices: "uint16_t",
});

const HIDP_VALUE_CAPS = koffi.struct("CONTROLLER_RAW_HIDP_VALUE_CAPS", {
  UsagePage: "uint16_t",
  ReportID: "uint8_t",
  IsAlias: "uint8_t",
  BitField: "uint16_t",
  LinkCollection: "uint16_t",
  LinkUsage: "uint16_t",
  LinkUsagePage: "uint16_t",
  IsRange: "uint8_t",
  IsStringRange: "uint8_t",
  IsDesignatorRange: "uint8_t",
  IsAbsolute: "uint8_t",
  HasNull: "uint8_t",
  Reserved: "uint8_t",
  BitSize: "uint16_t",
  ReportCount: "uint16_t",
  Reserved2: koffi.array("uint16_t", 5),
  UnitsExp: "uint32_t",
  Units: "uint32_t",
  LogicalMin: "int32_t",
  LogicalMax: "int32_t",
  PhysicalMin: "int32_t",
  PhysicalMax: "int32_t",
  UsageMin: "uint16_t",
  UsageMax: "uint16_t",
  StringMin: "uint16_t",
  StringMax: "uint16_t",
  DesignatorMin: "uint16_t",
  DesignatorMax: "uint16_t",
  DataIndexMin: "uint16_t",
  DataIndexMax: "uint16_t",
});

const hid = koffi.load("hid.dll");
const setupapi = koffi.load("setupapi.dll");
const kernel32 = koffi.load("kernel32.dll");

const HidD_GetHidGuid = hid.func(
  "void __stdcall HidD_GetHidGuid(_Out_ CONTROLLER_RAW_HID_GUID *guid)",
);
const HidD_GetAttributes = hid.func(
  "int __stdcall HidD_GetAttributes(void *HidDeviceObject, _Out_ CONTROLLER_RAW_HID_HIDD_ATTRIBUTES *Attributes)",
);
const HidD_GetManufacturerString = hid.func(
  "int __stdcall HidD_GetManufacturerString(void *HidDeviceObject, void *Buffer, uint32_t BufferLength)",
);
const HidD_GetProductString = hid.func(
  "int __stdcall HidD_GetProductString(void *HidDeviceObject, void *Buffer, uint32_t BufferLength)",
);
const HidD_GetPreparsedData = hid.func(
  "int __stdcall HidD_GetPreparsedData(void *HidDeviceObject, _Out_ void **PreparsedData)",
);
const HidD_FreePreparsedData = hid.func(
  "int __stdcall HidD_FreePreparsedData(void *PreparsedData)",
);
const HidP_GetCaps = hid.func(
  "int32_t __stdcall HidP_GetCaps(void *PreparsedData, _Out_ CONTROLLER_RAW_HIDP_CAPS *Capabilities)",
);
const HidP_GetValueCaps = hid.func(
  "int32_t __stdcall HidP_GetValueCaps(int32_t ReportType, void *ValueCaps, uint16_t *ValueCapsLength, void *PreparsedData)",
);
const HidP_GetUsages = hid.func(
  "int32_t __stdcall HidP_GetUsages(int32_t ReportType, uint16_t UsagePage, uint16_t LinkCollection, void *UsageList, uint32_t *UsageLength, void *PreparsedData, void *Report, uint32_t ReportLength)",
);
const HidP_GetUsageValue = hid.func(
  "int32_t __stdcall HidP_GetUsageValue(int32_t ReportType, uint16_t UsagePage, uint16_t LinkCollection, uint16_t Usage, uint32_t *UsageValue, void *PreparsedData, void *Report, uint32_t ReportLength)",
);
const SetupDiGetClassDevsW = setupapi.func(
  "void * __stdcall SetupDiGetClassDevsW(const CONTROLLER_RAW_HID_GUID *ClassGuid, const wchar_t *Enumerator, void *hwndParent, uint32_t Flags)",
);
const SetupDiEnumDeviceInterfaces = setupapi.func(
  "int __stdcall SetupDiEnumDeviceInterfaces(void *DeviceInfoSet, void *DeviceInfoData, const CONTROLLER_RAW_HID_GUID *InterfaceClassGuid, uint32_t MemberIndex, void *DeviceInterfaceData)",
);
const SetupDiGetDeviceInterfaceDetailW = setupapi.func(
  "int __stdcall SetupDiGetDeviceInterfaceDetailW(void *DeviceInfoSet, void *DeviceInterfaceData, void *DeviceInterfaceDetailData, uint32_t DeviceInterfaceDetailDataSize, void *RequiredSize, void *DeviceInfoData)",
);
const SetupDiDestroyDeviceInfoList = setupapi.func(
  "int __stdcall SetupDiDestroyDeviceInfoList(void *DeviceInfoSet)",
);
const CreateFileW = kernel32.func(
  "void * __stdcall CreateFileW(const wchar_t *lpFileName, uint32_t dwDesiredAccess, uint32_t dwShareMode, void *lpSecurityAttributes, uint32_t dwCreationDisposition, uint32_t dwFlagsAndAttributes, void *hTemplateFile)",
);
const ReadFile = kernel32.func(
  "int __stdcall ReadFile(void *hFile, void *lpBuffer, uint32_t nNumberOfBytesToRead, uint32_t *lpNumberOfBytesRead, CONTROLLER_RAW_HID_OVERLAPPED *lpOverlapped)",
);
const CreateEventW = kernel32.func(
  "void * __stdcall CreateEventW(void *lpEventAttributes, int bManualReset, int bInitialState, const wchar_t *lpName)",
);
const WaitForSingleObject = kernel32.func(
  "uint32_t __stdcall WaitForSingleObject(void *hHandle, uint32_t dwMilliseconds)",
);
const CancelIoEx = kernel32.func(
  "int __stdcall CancelIoEx(void *hFile, CONTROLLER_RAW_HID_OVERLAPPED *lpOverlapped)",
);
const CloseHandle = kernel32.func(
  "int __stdcall CloseHandle(void *hObject)",
);
const GetLastError = kernel32.func(
  "uint32_t __stdcall GetLastError(void)",
);

let active = false;
let timer = null;
let readers = [];
let lastRediscoveryAt = 0;
const rawHidReportDiagnostics = new Map();

function post(type, payload = {}) {
  try {
    parentPort.postMessage({ type, ...payload });
  } catch {}
}

function getLastError() {
  return Number(GetLastError()) >>> 0;
}

function ptrAddress(ptr) {
  if (!ptr) return 0n;
  try {
    const value = koffi.address(ptr);
    return typeof value === "bigint" ? value : BigInt(value >>> 0);
  } catch {
    return 0n;
  }
}

function isInvalidHandle(handle) {
  if (!handle) return true;
  return ptrAddress(handle) === INVALID_HANDLE_64;
}

function isNullHandle(handle) {
  return !handle || ptrAddress(handle) === 0n;
}

function isNtSuccess(value) {
  return Number(value) >= 0;
}

function readWideString(getter, handle) {
  const buf = Buffer.alloc(256);
  if (!getter(handle, buf, buf.length)) return null;
  const raw = buf.toString("utf16le");
  const end = raw.indexOf("\u0000");
  return (end >= 0 ? raw.slice(0, end) : raw).trim() || null;
}

function formatInterfacePath(detailBuffer) {
  return detailBuffer.toString("utf16le", 4).split("\u0000")[0];
}

function getDevicePathKey(device) {
  return String(device?.path || "").trim().toLowerCase();
}

function openReadHandle(devicePath) {
  const handle = CreateFileW(
    devicePath,
    GENERIC_READ,
    FILE_SHARE_READ | FILE_SHARE_WRITE,
    null,
    OPEN_EXISTING,
    FILE_FLAG_OVERLAPPED,
    null,
  );
  if (!isInvalidHandle(handle) && !isNullHandle(handle)) return handle;
  return CreateFileW(
    devicePath,
    0,
    FILE_SHARE_READ | FILE_SHARE_WRITE,
    null,
    OPEN_EXISTING,
    FILE_FLAG_OVERLAPPED,
    null,
  );
}

function enumerateTargetDevices() {
  const hidGuid = {};
  HidD_GetHidGuid(hidGuid);
  const infoSet = SetupDiGetClassDevsW(
    hidGuid,
    null,
    null,
    DIGCF_PRESENT | DIGCF_DEVICEINTERFACE,
  );
  if (isInvalidHandle(infoSet)) {
    throw new Error(
      `SetupDiGetClassDevsW failed: 0x${getLastError().toString(16)}`,
    );
  }

  const devices = [];
  try {
    for (let index = 0; ; index += 1) {
      const interfaceDataBuffer = Buffer.alloc(POINTER_SIZE === 8 ? 32 : 28);
      interfaceDataBuffer.writeUInt32LE(interfaceDataBuffer.length, 0);

      const ok = SetupDiEnumDeviceInterfaces(
        infoSet,
        null,
        hidGuid,
        index,
        interfaceDataBuffer,
      );
      if (!ok) {
        const error = getLastError();
        if (error === ERROR_NO_MORE_ITEMS) break;
        throw new Error(
          `SetupDiEnumDeviceInterfaces failed at index ${index}: 0x${error.toString(16)}`,
        );
      }

      const requiredSizeBuffer = Buffer.alloc(4);
      SetupDiGetDeviceInterfaceDetailW(
        infoSet,
        interfaceDataBuffer,
        null,
        0,
        requiredSizeBuffer,
        null,
      );
      const requiredSize = requiredSizeBuffer.readUInt32LE(0);
      const detailError = getLastError();
      if (!requiredSize || detailError !== ERROR_INSUFFICIENT_BUFFER) {
        continue;
      }

      const detailBuffer = Buffer.alloc(requiredSize);
      detailBuffer.writeUInt32LE(POINTER_SIZE === 8 ? 8 : 6, 0);
      const detailOk = SetupDiGetDeviceInterfaceDetailW(
        infoSet,
        interfaceDataBuffer,
        detailBuffer,
        requiredSize,
        requiredSizeBuffer,
        null,
      );
      if (!detailOk) continue;

      const devicePath = formatInterfacePath(detailBuffer);
      const metadataHandle = CreateFileW(
        devicePath,
        0,
        FILE_SHARE_READ | FILE_SHARE_WRITE,
        null,
        OPEN_EXISTING,
        0,
        null,
      );
      if (isInvalidHandle(metadataHandle) || isNullHandle(metadataHandle)) {
        continue;
      }

      try {
        const attributes = { Size: koffi.sizeof(HIDD_ATTRIBUTES) };
        const hasAttributes = !!HidD_GetAttributes(metadataHandle, attributes);
        const device = {
          index,
          path: devicePath,
          vid: hasAttributes ? Number(attributes.VendorID) >>> 0 : 0,
          pid: hasAttributes ? Number(attributes.ProductID) >>> 0 : 0,
          manufacturer: readWideString(HidD_GetManufacturerString, metadataHandle),
          product: readWideString(HidD_GetProductString, metadataHandle),
        };
        if (!matchesTargetRawHidDevice(device)) continue;
        device.profile = getRawHidDeviceProfile(device);
        devices.push(device);
      } finally {
        CloseHandle(metadataHandle);
      }
    }
  } finally {
    SetupDiDestroyDeviceInfoList(infoSet);
  }

  return devices;
}

function buildLogicalRangeMap(preparsedData, caps) {
  const count = Math.max(0, Number(caps?.NumberInputValueCaps) || 0);
  if (!count) return new Map();
  const buffer = Buffer.alloc(koffi.sizeof(HIDP_VALUE_CAPS) * count);
  const countRef = [count];
  const status = HidP_GetValueCaps(
    HIDP_REPORT_TYPE_INPUT,
    buffer,
    countRef,
    preparsedData,
  );
  if (!isNtSuccess(status)) return new Map();

  const valueCapsCount = Math.max(0, Number(countRef[0]) || 0);
  const map = new Map();
  const stride = koffi.sizeof(HIDP_VALUE_CAPS);
  for (let index = 0; index < valueCapsCount; index += 1) {
    const cap = koffi.decode(buffer, index * stride, HIDP_VALUE_CAPS);
    if (Number(cap?.UsagePage) !== HID_USAGE_PAGE_GENERIC) continue;
    const min = Number(cap?.LogicalMin);
    const max = Number(cap?.LogicalMax);
    if (Number(cap?.IsRange) === 1) {
      for (let usage = Number(cap?.UsageMin) || 0; usage <= (Number(cap?.UsageMax) || 0); usage += 1) {
        map.set(usage >>> 0, { min, max });
      }
      continue;
    }
    map.set((Number(cap?.UsageMin) || 0) >>> 0, { min, max });
  }
  return map;
}

function createReader(device) {
  const handle = openReadHandle(device.path);
  if (isInvalidHandle(handle) || isNullHandle(handle)) {
    return null;
  }

  const eventHandle = CreateEventW(null, 0, 0, null);
  if (isInvalidHandle(eventHandle) || isNullHandle(eventHandle)) {
    try {
      CloseHandle(handle);
    } catch {}
    return null;
  }

  const preparsedDataOut = [null];
  let preparsedData = null;
  let caps = null;
  let logicalRanges = new Map();
  let readBufferLength = DEFAULT_REPORT_BUFFER_LENGTH;

  try {
    if (HidD_GetPreparsedData(handle, preparsedDataOut)) {
      preparsedData = preparsedDataOut[0] || null;
      if (preparsedData) {
        const nextCaps = {};
        const status = HidP_GetCaps(preparsedData, nextCaps);
        if (isNtSuccess(status)) {
          caps = nextCaps;
          readBufferLength = Math.max(
            DEFAULT_REPORT_BUFFER_LENGTH,
            Number(caps?.InputReportByteLength) || DEFAULT_REPORT_BUFFER_LENGTH,
          );
          logicalRanges = buildLogicalRangeMap(preparsedData, caps);
        }
      }
    }
  } catch {}

  return {
    ...device,
    handle,
    eventHandle,
    preparsedData,
    caps,
    logicalRanges,
    pending: false,
    readBuffer: Buffer.alloc(readBufferLength),
    lastPacketNumber: 0,
    lastSnapshotKey: "",
    lastGuidePressed: false,
    failed: false,
    deviceKey: `rawhid:${getDevicePathKey(device)}`,
    overlapped: {
      Internal: 0,
      InternalHigh: 0,
      Offset: 0,
      OffsetHigh: 0,
      hEvent: eventHandle,
    },
  };
}

function issueRead(reader) {
  reader.readBuffer.fill(0);
  reader.overlapped = {
    Internal: 0,
    InternalHigh: 0,
    Offset: 0,
    OffsetHigh: 0,
    hEvent: reader.eventHandle,
  };
  const bytesRead = [0];
  const ok = ReadFile(
    reader.handle,
    reader.readBuffer,
    reader.readBuffer.length,
    bytesRead,
    reader.overlapped,
  );
  const error = getLastError();
  if (ok || error === ERROR_IO_PENDING) {
    reader.pending = true;
    reader.failed = false;
    return true;
  }
  reader.pending = false;
  reader.failed = true;
  return false;
}

function normalizeGenericAxis(rawValue, range) {
  const raw = Number(rawValue);
  if (!Number.isFinite(raw)) return 0;
  const min = Number(range?.min);
  const max = Number(range?.max);
  if (!Number.isFinite(min) || !Number.isFinite(max) || max === min) {
    return Math.max(-1, Math.min(1, raw));
  }
  const mid = min + (max - min) / 2;
  const span = Math.max(1, (max - min) / 2);
  return Math.max(-1, Math.min(1, (raw - mid) / span));
}

function getPressedButtonUsages(reader, report) {
  if (!reader?.preparsedData) return [];
  const usageLength = [128];
  const usageBuffer = Buffer.alloc(usageLength[0] * 2);
  const status = HidP_GetUsages(
    HIDP_REPORT_TYPE_INPUT,
    HID_USAGE_PAGE_BUTTON,
    0,
    usageBuffer,
    usageLength,
    reader.preparsedData,
    report,
    report.length,
  );
  if (!isNtSuccess(status)) return [];
  const count = Math.max(0, Number(usageLength[0]) || 0);
  const usages = [];
  for (let i = 0; i < count; i += 1) {
    usages.push(usageBuffer.readUInt16LE(i * 2));
  }
  return usages;
}

function getGenericUsageValue(reader, report, usage) {
  if (!reader?.preparsedData) return null;
  const valueOut = [0];
  const status = HidP_GetUsageValue(
    HIDP_REPORT_TYPE_INPUT,
    HID_USAGE_PAGE_GENERIC,
    0,
    usage,
    valueOut,
    reader.preparsedData,
    report,
    report.length,
  );
  if (!isNtSuccess(status)) return null;
  const raw = Number(valueOut[0]) >>> 0;
  const logicalRange = reader.logicalRanges.get(Number(usage) >>> 0) || null;
  return {
    raw,
    normalized: normalizeGenericAxis(raw, logicalRange),
    min: Number(logicalRange?.min),
    max: Number(logicalRange?.max),
  };
}

function buildGenericState(reader, report) {
  const usages = [
    HID_GENERIC_USAGES.X,
    HID_GENERIC_USAGES.Y,
    HID_GENERIC_USAGES.Z,
    HID_GENERIC_USAGES.RX,
    HID_GENERIC_USAGES.RY,
    HID_GENERIC_USAGES.RZ,
    HID_GENERIC_USAGES.SLIDER,
    HID_GENERIC_USAGES.DIAL,
    HID_GENERIC_USAGES.HAT,
    HID_GENERIC_USAGES.START,
    HID_GENERIC_USAGES.SELECT,
  ];
  const values = {};
  for (const usage of usages) {
    const value = getGenericUsageValue(reader, report, usage);
    if (value) values[usage] = value;
  }
  return {
    pressedButtons: getPressedButtonUsages(reader, report),
    values,
  };
}

function summarizeGenericState(genericState) {
  if (!genericState || typeof genericState !== "object") return null;
  const usages = genericState.values && typeof genericState.values === "object"
    ? genericState.values
    : {};
  const summarizeUsage = (usage) => {
    const value = usages[usage];
    if (!value || typeof value !== "object") return null;
    return {
      raw: Number(value.raw) >>> 0,
      normalized: Number.isFinite(Number(value.normalized))
        ? Number(Number(value.normalized).toFixed(4))
        : null,
      min: Number.isFinite(Number(value.min)) ? Number(value.min) : null,
      max: Number.isFinite(Number(value.max)) ? Number(value.max) : null,
    };
  };
  return {
    pressedButtons: Array.isArray(genericState.pressedButtons)
      ? [...genericState.pressedButtons]
      : [],
    usages: {
      x: summarizeUsage(HID_GENERIC_USAGES.X),
      y: summarizeUsage(HID_GENERIC_USAGES.Y),
      z: summarizeUsage(HID_GENERIC_USAGES.Z),
      rx: summarizeUsage(HID_GENERIC_USAGES.RX),
      ry: summarizeUsage(HID_GENERIC_USAGES.RY),
      rz: summarizeUsage(HID_GENERIC_USAGES.RZ),
      hat: summarizeUsage(HID_GENERIC_USAGES.HAT),
      start: summarizeUsage(HID_GENERIC_USAGES.START),
      select: summarizeUsage(HID_GENERIC_USAGES.SELECT),
    },
  };
}

function processCompletedRead(reader) {
  if (!reader || reader.failed) return false;
  if (!reader.pending) return true;

  const wait = WaitForSingleObject(reader.eventHandle, 0);
  if (wait === WAIT_TIMEOUT) return true;
  if (wait === WAIT_FAILED) {
    reader.pending = false;
    reader.failed = true;
    return false;
  }
  if (wait !== WAIT_OBJECT_0) return true;

  reader.pending = false;
  const report = Buffer.from(reader.readBuffer);
  const genericState = buildGenericState(reader, report);
  const snapshot = decodeRawHidProfileState(reader.profile, reader, {
    report,
    genericState,
    debugLoggingEnabled,
  });
  if (debugLoggingEnabled) {
    const sampleKey = `${String(reader.deviceKey || "")}:${String(
      reader.profile?.id || "unknown",
    )}:${report.length}:${Number(report[0] || 0)}`;
    if (!rawHidReportDiagnostics.has(sampleKey)) {
      rawHidReportDiagnostics.set(sampleKey, true);
      post("warn", {
        event: "controller:raw-hid:report-sample",
        payload: {
          deviceKey: reader.deviceKey,
          product: reader.product || null,
          vid: Number(reader.vid) >>> 0,
          pid: Number(reader.pid) >>> 0,
          profileId: reader.profile?.id || null,
          parser: reader.profile?.parser || null,
          reportLength: report.length,
          reportId: Number(report[0] || 0) >>> 0,
          head: Array.from(report.slice(0, Math.min(report.length, 16))).map(
            (value) => Number(value) >>> 0,
          ),
          genericState: summarizeGenericState(genericState),
          snapshot:
            snapshot && typeof snapshot === "object"
              ? {
                  profileId: snapshot.profileId || null,
                  family: snapshot.family || null,
                  buttons: Array.isArray(snapshot.buttons)
                    ? [...snapshot.buttons]
                    : [],
                  systemButtons: Array.isArray(snapshot.systemButtons)
                    ? [...snapshot.systemButtons]
                    : [],
                  leftStickX: Number.isFinite(Number(snapshot.leftStickX))
                    ? Number(Number(snapshot.leftStickX).toFixed(4))
                    : null,
                  leftStickY: Number.isFinite(Number(snapshot.leftStickY))
                    ? Number(Number(snapshot.leftStickY).toFixed(4))
                    : null,
                  rightStickX: Number.isFinite(Number(snapshot.rightStickX))
                    ? Number(Number(snapshot.rightStickX).toFixed(4))
                    : null,
                  rightStickY: Number.isFinite(Number(snapshot.rightStickY))
                    ? Number(Number(snapshot.rightStickY).toFixed(4))
                    : null,
                  extras:
                    snapshot.extras && typeof snapshot.extras === "object"
                      ? snapshot.extras
                      : null,
                }
              : null,
        },
      });
    }
  }

  if (snapshot) {
    const packetNumber = Date.now() >>> 0;
    const nextSnapshot = {
      ...snapshot,
      packetNumber,
      deviceKey: reader.deviceKey,
    };
    const snapshotKey = JSON.stringify([
      nextSnapshot.profileId,
      nextSnapshot.deviceKey,
      nextSnapshot.buttons,
      nextSnapshot.systemButtons,
      Number(nextSnapshot.leftTrigger || 0).toFixed(3),
      Number(nextSnapshot.rightTrigger || 0).toFixed(3),
      Number(nextSnapshot.leftStickX || 0).toFixed(3),
      Number(nextSnapshot.leftStickY || 0).toFixed(3),
      Number(nextSnapshot.rightStickX || 0).toFixed(3),
      Number(nextSnapshot.rightStickY || 0).toFixed(3),
    ]);
    if (snapshotKey !== reader.lastSnapshotKey) {
      reader.lastSnapshotKey = snapshotKey;
      reader.lastPacketNumber = packetNumber;
      post("snapshot", { snapshot: nextSnapshot });
    }

    const guidePressed =
      Array.isArray(nextSnapshot.systemButtons) &&
      nextSnapshot.systemButtons.includes("GUIDE");
    if (guidePressed !== reader.lastGuidePressed) {
      reader.lastGuidePressed = guidePressed;
      post("guide-button", {
        source: "raw-hid",
        deviceKey: reader.deviceKey,
        product: reader.product || null,
        pressed: guidePressed,
        packetNumber,
      });
    }
  }

  return issueRead(reader);
}

function cleanupReaders(targetReaders) {
  for (const reader of targetReaders) {
    try {
      if (reader.pending) CancelIoEx(reader.handle, reader.overlapped);
    } catch {}
    try {
      if (reader.preparsedData) HidD_FreePreparsedData(reader.preparsedData);
    } catch {}
    try {
      CloseHandle(reader.eventHandle);
    } catch {}
    try {
      CloseHandle(reader.handle);
    } catch {}
  }
}

function discoverReaders(reason = "periodic") {
  const previousCount = readers.length;
  const devices = enumerateTargetDevices();
  const nextDevicesByPath = new Map();
  for (const device of devices) {
    const pathKey = getDevicePathKey(device);
    if (!pathKey || nextDevicesByPath.has(pathKey)) continue;
    nextDevicesByPath.set(pathKey, device);
  }

  const existingByPath = new Map();
  const nextReaders = [];
  const removedReaders = [];

  for (const reader of readers) {
    const pathKey = getDevicePathKey(reader);
    if (!pathKey || reader.failed || !nextDevicesByPath.has(pathKey)) {
      removedReaders.push(reader);
      continue;
    }
    existingByPath.set(pathKey, reader);
    nextReaders.push(reader);
  }

  for (const reader of removedReaders) {
    post("disconnected", {
      reason: reader.failed ? "reader-failed" : reason,
      deviceKey: reader.deviceKey,
      product: reader.product || null,
      vid: Number(reader.vid) >>> 0,
      pid: Number(reader.pid) >>> 0,
    });
  }
  if (removedReaders.length) cleanupReaders(removedReaders);

  const addedReaders = [];
  for (const [pathKey, device] of nextDevicesByPath.entries()) {
    if (existingByPath.has(pathKey)) continue;
    const reader = createReader(device);
    if (!reader) continue;
    if (!issueRead(reader)) {
      cleanupReaders([reader]);
      continue;
    }
    addedReaders.push(reader);
    nextReaders.push(reader);
    post("connected", {
      reason,
      deviceKey: reader.deviceKey,
      product: reader.product || null,
      vid: Number(reader.vid) >>> 0,
      pid: Number(reader.pid) >>> 0,
      profileId: reader.profile?.id || null,
    });
  }

  readers = nextReaders;
  lastRediscoveryAt = Date.now();

  const changed =
    reason === "startup" ||
    previousCount !== readers.length ||
    removedReaders.length > 0 ||
    addedReaders.length > 0;
  if (changed) {
    post("ready", {
      reason,
      readers: readers.length,
      products: readers.map((reader) => reader.product || null).filter(Boolean),
    });
  }
}

function getNextDelayMs() {
  return active ? 16 : 25;
}

function schedule() {
  if (timer) clearTimeout(timer);
  timer = setTimeout(loop, getNextDelayMs());
  if (typeof timer.unref === "function") timer.unref();
}

function loop() {
  timer = null;
  const rediscoveryMs = active ? rediscoveryIntervalMs : idleRediscoveryIntervalMs;
  if (Date.now() - lastRediscoveryAt >= rediscoveryMs) {
    try {
      discoverReaders(readers.length ? "periodic" : "rediscovery");
    } catch (err) {
      lastRediscoveryAt = Date.now();
      post("warn", {
        event: "controller:raw-hid:rediscovery-failed",
        payload: { error: err?.message || String(err) },
      });
    }
  }

  for (const reader of readers) {
    if (processCompletedRead(reader) === false) {
      // handled in next rediscovery
    }
  }

  schedule();
}

parentPort.on("message", (message) => {
  if (!message || typeof message !== "object") return;
  if (message.type === "set-active") {
    active = message.active === true;
    return;
  }
  if (message.type === "shutdown") {
    try {
      cleanupReaders(readers);
    } catch {}
    readers = [];
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    process.exit(0);
  }
});

try {
  discoverReaders("startup");
} catch (err) {
  post("warn", {
    event: "controller:raw-hid:init-failed",
    payload: { error: err?.message || String(err) },
  });
}
schedule();
