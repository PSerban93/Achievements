const {
  parentPort,
  workerData: threadWorkerData,
} = require("node:worker_threads");

function readProcessWorkerData() {
  if (threadWorkerData && typeof threadWorkerData === "object") {
    return threadWorkerData;
  }
  try {
    return JSON.parse(String(process.env.GAMEBAR_WIDGET_WORKER_DATA || "{}"));
  } catch {
    return {};
  }
}

const workerData = readProcessWorkerData();
const processIpcAvailable = typeof process.send === "function";
const koffi = require(workerData?.koffiModulePath || "koffi");

if ((!parentPort && !processIpcAvailable) || process.platform !== "win32") {
  process.exit(0);
}

const PIPE_ACCESS_DUPLEX = 0x00000003;
const PIPE_TYPE_BYTE = 0x00000000;
const PIPE_READMODE_BYTE = 0x00000000;
const PIPE_WAIT = 0x00000000;
const PIPE_REJECT_REMOTE_CLIENTS = 0x00000008;
const ERROR_PATH_NOT_FOUND = 3;
const ERROR_BROKEN_PIPE = 109;
const ERROR_PIPE_BUSY = 231;
const ERROR_NO_DATA = 232;
const ERROR_PIPE_NOT_CONNECTED = 233;
const ERROR_PIPE_CONNECTED = 535;
const ENDPOINT_RETRY_DELAY_MS = 1000;
const SUBSCRIBER_DISCONNECTED_EXIT_CODE = 12;
const MAX_REQUEST_BYTES = Math.max(
  1024,
  Number(workerData?.maxRequestBytes) || 16 * 1024,
);
const RESPONSE_TIMEOUT_MS = Math.max(
  1000,
  Number(workerData?.responseTimeoutMs) || 30000,
);
const REQUESTED_PIPE_PATH = String(workerData?.pipePath || "").trim();
const USE_WIDGET_APP_CONTAINER_NAMESPACE =
  workerData?.useWidgetAppContainerNamespace === true;
const SHUTDOWN_TOKEN = String(workerData?.shutdownToken || "");
const WIDGET_PACKAGE_FAMILY_NAME = String(
  workerData?.widgetPackageFamilyName || "",
).trim();
const ENFORCE_CLIENT_IDENTITY = workerData?.enforceClientIdentity === true;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const ERROR_INSUFFICIENT_BUFFER = 122;
const APPMODEL_ERROR_NO_PACKAGE = 15700;
const INVALID_HANDLE_VALUE = BigInt.asUintN(64, -1n);

const SECURITY_ATTRIBUTES = koffi.struct(
  "GAMEBAR_WIDGET_SECURITY_ATTRIBUTES",
  {
    nLength: "uint32_t",
    lpSecurityDescriptor: "void *",
    bInheritHandle: "int32_t",
  },
);

const kernel32 = koffi.load("kernel32.dll");
const advapi32 = koffi.load("advapi32.dll");
const userenv = koffi.load("userenv.dll");
const CreateNamedPipeW = kernel32.func(
  "void * __stdcall CreateNamedPipeW(const wchar_t *lpName, uint32_t dwOpenMode, uint32_t dwPipeMode, uint32_t nMaxInstances, uint32_t nOutBufferSize, uint32_t nInBufferSize, uint32_t nDefaultTimeOut, const GAMEBAR_WIDGET_SECURITY_ATTRIBUTES *lpSecurityAttributes)",
);
const ConnectNamedPipe = kernel32.func(
  "int __stdcall ConnectNamedPipe(void *hNamedPipe, void *lpOverlapped)",
);
const ReadFile = kernel32.func(
  "int __stdcall ReadFile(void *hFile, void *lpBuffer, uint32_t nNumberOfBytesToRead, _Out_ uint32_t *lpNumberOfBytesRead, void *lpOverlapped)",
);
const WriteFile = kernel32.func(
  "int __stdcall WriteFile(void *hFile, const void *lpBuffer, uint32_t nNumberOfBytesToWrite, _Out_ uint32_t *lpNumberOfBytesWritten, void *lpOverlapped)",
);
const FlushFileBuffers = kernel32.func(
  "int __stdcall FlushFileBuffers(void *hFile)",
);
const CloseHandle = kernel32.func(
  "int __stdcall CloseHandle(void *hObject)",
);
const LocalFree = kernel32.func("void * __stdcall LocalFree(void *hMem)");
const GetLastError = kernel32.func("uint32_t __stdcall GetLastError(void)");
const GetNamedPipeClientProcessId = kernel32.func(
  "int __stdcall GetNamedPipeClientProcessId(void *Pipe, _Out_ uint32_t *ClientProcessId)",
);
const OpenProcess = kernel32.func(
  "void * __stdcall OpenProcess(uint32_t dwDesiredAccess, int bInheritHandle, uint32_t dwProcessId)",
);
const GetPackageFamilyName = kernel32.func(
  "int32_t __stdcall GetPackageFamilyName(void *hProcess, _Inout_ uint32_t *packageFamilyNameLength, _Out_ wchar_t *packageFamilyName)",
);
const ProcessIdToSessionId = kernel32.func(
  "int __stdcall ProcessIdToSessionId(uint32_t dwProcessId, _Out_ uint32_t *pSessionId)",
);
const ConvertStringSecurityDescriptorToSecurityDescriptorW = advapi32.func(
  "int __stdcall ConvertStringSecurityDescriptorToSecurityDescriptorW(const wchar_t *StringSecurityDescriptor, uint32_t StringSDRevision, _Out_ void **SecurityDescriptor, uint32_t *SecurityDescriptorSize)",
);
const ConvertSidToStringSidW = advapi32.func(
  "int __stdcall ConvertSidToStringSidW(void *Sid, _Out_ void **StringSid)",
);
const DeriveAppContainerSidFromAppContainerName = userenv.func(
  "int32_t __stdcall DeriveAppContainerSidFromAppContainerName(const wchar_t *pszAppContainerName, _Out_ void **ppsidAppContainerSid)",
);

function isInvalidHandle(handle) {
  if (!handle) return true;
  return BigInt(koffi.address(handle)) === INVALID_HANDLE_VALUE;
}

function post(type, payload = {}) {
  try {
    const message = { type, ...payload };
    if (parentPort) parentPort.postMessage(message);
    else process.send?.(message);
  } catch {}
}

function isPipeDisconnectError(errorCode) {
  return (
    errorCode === ERROR_BROKEN_PIPE ||
    errorCode === ERROR_NO_DATA ||
    errorCode === ERROR_PIPE_NOT_CONNECTED
  );
}

function deriveWidgetPackageSid() {
  if (!WIDGET_PACKAGE_FAMILY_NAME) {
    throw new Error("widget-package-family-name-required");
  }
  const sidOut = [null];
  const result = DeriveAppContainerSidFromAppContainerName(
    WIDGET_PACKAGE_FAMILY_NAME,
    sidOut,
  );
  if (result !== 0 || !sidOut[0]) {
    throw new Error(`widget-package-sid-derive-failed:${result}`);
  }
  try {
    const stringSidOut = [null];
    if (!ConvertSidToStringSidW(sidOut[0], stringSidOut) || !stringSidOut[0]) {
      throw new Error(`widget-package-sid-format-failed:${GetLastError()}`);
    }
    try {
      return String(koffi.decode(stringSidOut[0], "wchar_t", 256) || "");
    } finally {
      LocalFree(stringSidOut[0]);
    }
  } finally {
    LocalFree(sidOut[0]);
  }
}

function resolveServerPipePath(widgetPackageSid) {
  if (!USE_WIDGET_APP_CONTAINER_NAMESPACE) return REQUESTED_PIPE_PATH;
  const sessionIdOut = [0];
  if (!ProcessIdToSessionId(process.pid, sessionIdOut)) {
    throw new Error(`pipe-session-id-failed:${GetLastError()}`);
  }
  const pipePrefix = "\\\\.\\pipe\\";
  let relativeName = REQUESTED_PIPE_PATH.toLowerCase().startsWith(
    pipePrefix.toLowerCase(),
  )
    ? REQUESTED_PIPE_PATH.slice(pipePrefix.length)
    : REQUESTED_PIPE_PATH;
  relativeName = relativeName.replace(/^local\\/i, "");
  if (!relativeName || relativeName.includes("..")) {
    throw new Error("invalid-widget-pipe-name");
  }
  return `${pipePrefix}Sessions\\${sessionIdOut[0]}\\AppContainerNamedObjects\\${widgetPackageSid}\\${relativeName}`;
}

function createSecurityDescriptor(widgetPackageSid) {
  const descriptorOut = [null];
  // AppContainer access uses a dual access check. Microsoft requires both the
  // world SID and the exact widget package SID; granting only the generic
  // All Application Packages SID still leaves a Game Bar client unable to
  // open an endpoint owned by an unpackaged desktop process.
  const converted = ConvertStringSecurityDescriptorToSecurityDescriptorW(
    `D:(A;;GA;;;WD)(A;;GA;;;${widgetPackageSid})S:(ML;;NW;;;LW)`,
    1,
    descriptorOut,
    null,
  );
  if (!converted || !descriptorOut[0]) {
    throw new Error(`security-descriptor-failed:${GetLastError()}`);
  }
  return descriptorOut[0];
}

function createPipe(pipePath, securityDescriptor) {
  const securityAttributes = {
    nLength: koffi.sizeof(SECURITY_ATTRIBUTES),
    lpSecurityDescriptor: securityDescriptor,
    bInheritHandle: 0,
  };
  const handle = CreateNamedPipeW(
    pipePath,
    PIPE_ACCESS_DUPLEX,
    PIPE_TYPE_BYTE |
      PIPE_READMODE_BYTE |
      PIPE_WAIT |
      PIPE_REJECT_REMOTE_CLIENTS,
    1,
    64 * 1024,
    MAX_REQUEST_BYTES,
    2000,
    securityAttributes,
  );
  if (isInvalidHandle(handle)) {
    const errorCode = GetLastError();
    const error = new Error(`create-pipe-failed:${errorCode}`);
    error.win32Code = errorCode;
    throw error;
  }
  return handle;
}

function getClientIdentity(handle) {
  const pidOut = [0];
  if (!GetNamedPipeClientProcessId(handle, pidOut)) {
    throw new Error(`client-pid-query-failed:${GetLastError()}`);
  }
  const pid = Number(pidOut[0]) || 0;
  if (!pid) throw new Error("client-pid-invalid");
  const processHandle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
  if (isInvalidHandle(processHandle)) {
    throw new Error(`client-process-open-failed:${GetLastError()}`);
  }
  try {
    const length = [0];
    const firstResult = GetPackageFamilyName(processHandle, length, null);
    if (firstResult === APPMODEL_ERROR_NO_PACKAGE) {
      return { pid, packageFamilyName: "" };
    }
    if (firstResult !== ERROR_INSUFFICIENT_BUFFER || Number(length[0]) <= 1) {
      throw new Error(`client-package-query-failed:${firstResult}`);
    }
    const buffer = Buffer.alloc(Number(length[0]) * 2);
    const secondResult = GetPackageFamilyName(processHandle, length, buffer);
    if (secondResult !== 0) {
      throw new Error(`client-package-read-failed:${secondResult}`);
    }
    return {
      pid,
      packageFamilyName: String(
        koffi.decode(buffer, "wchar_t", Number(length[0])) || "",
      ).replace(/\0+$/, ""),
    };
  } finally {
    CloseHandle(processHandle);
  }
}

function validateClientIdentity(handle) {
  if (!ENFORCE_CLIENT_IDENTITY) return { accepted: true };
  try {
    const identity = getClientIdentity(handle);
    return {
      ...identity,
      accepted:
        identity.packageFamilyName.toLowerCase() ===
        WIDGET_PACKAGE_FAMILY_NAME.toLowerCase(),
    };
  } catch (error) {
    return { accepted: false, error: error?.message || String(error) };
  }
}

function readRequest(handle) {
  const chunks = [];
  let totalBytes = 0;
  while (totalBytes <= MAX_REQUEST_BYTES) {
    const buffer = Buffer.allocUnsafe(Math.min(4096, MAX_REQUEST_BYTES + 1));
    const bytesRead = [0];
    const ok = ReadFile(handle, buffer, buffer.length, bytesRead, null);
    const count = Number(bytesRead[0]) || 0;
    if (count > 0) {
      chunks.push(buffer.subarray(0, count));
      totalBytes += count;
      const combined = Buffer.concat(chunks, totalBytes);
      const newlineIndex = combined.indexOf(0x0a);
      if (newlineIndex >= 0) {
        if (newlineIndex > MAX_REQUEST_BYTES) {
          return { error: "request-too-large" };
        }
        return { line: combined.subarray(0, newlineIndex).toString("utf8") };
      }
    }
    if (!ok) {
      const errorCode = GetLastError();
      if (isPipeDisconnectError(errorCode)) return { disconnected: true };
      throw new Error(`read-pipe-failed:${errorCode}`);
    }
    if (count === 0) return { disconnected: true };
  }
  return { error: "request-too-large" };
}

function writeResponse(handle, response) {
  const payload = Buffer.from(`${JSON.stringify(response)}\n`, "utf8");
  let offset = 0;
  while (offset < payload.length) {
    const bytesWritten = [0];
    const remaining = payload.subarray(offset);
    const ok = WriteFile(
      handle,
      remaining,
      remaining.length,
      bytesWritten,
      null,
    );
    const count = Number(bytesWritten[0]) || 0;
    if (!ok) {
      const errorCode = GetLastError();
      if (isPipeDisconnectError(errorCode)) return false;
      throw new Error(`write-pipe-failed:${errorCode}`);
    }
    if (count <= 0) throw new Error("write-pipe-failed:no-progress");
    offset += count;
  }
  // Flush before closing the instance so the client can consume the complete
  // response and observe a clean EOF instead of a truncated payload.
  if (!FlushFileBuffers(handle)) {
    const errorCode = GetLastError();
    if (isPipeDisconnectError(errorCode)) return false;
    throw new Error(`flush-pipe-failed:${errorCode}`);
  }
  return true;
}

let stopping = false;
let nextRequestId = 1;
const pendingResponses = new Map();
const pendingNotificationPushes = [];
let pendingStatePush = null;
let pendingHeartbeatPush = null;
let resolveNextPush = null;

function waitForResponse(requestId) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingResponses.delete(requestId);
      resolve({
        protocolVersion: 1,
        status: "error",
        error: "snapshot-timeout",
      });
    }, RESPONSE_TIMEOUT_MS);
    pendingResponses.set(requestId, (response) => {
      clearTimeout(timer);
      resolve(response);
    });
  });
}

function enqueuePush(entry) {
  const response = entry?.response;
  if (resolveNextPush) {
    const resolve = resolveNextPush;
    resolveNextPush = null;
    resolve(entry);
    return;
  }
  if (response?.status === "notification") {
    pendingNotificationPushes.push(entry);
    return;
  }
  if (response?.status === "heartbeat") {
    if (pendingNotificationPushes.length || pendingStatePush) return;
    pendingHeartbeatPush = entry;
    return;
  }
  // State is replaceable, event notifications are not. Keep only the newest
  // snapshot while preserving every queued achievement/progress notification.
  pendingStatePush = entry;
  pendingHeartbeatPush = null;
}

function waitForPush() {
  if (pendingNotificationPushes.length) {
    return Promise.resolve(pendingNotificationPushes.shift());
  }
  if (pendingStatePush) {
    const entry = pendingStatePush;
    pendingStatePush = null;
    return Promise.resolve(entry);
  }
  if (pendingHeartbeatPush) {
    const entry = pendingHeartbeatPush;
    pendingHeartbeatPush = null;
    return Promise.resolve(entry);
  }
  if (stopping) return Promise.resolve(null);
  return new Promise((resolve) => {
    resolveNextPush = resolve;
  });
}

const controlPort = parentPort || process;
controlPort.on("message", (message) => {
  if (!message || typeof message !== "object") return;
  if (message.type === "snapshot-response") {
    const resolve = pendingResponses.get(message.requestId);
    if (!resolve) return;
    pendingResponses.delete(message.requestId);
    resolve(message.response);
    return;
  }
  if (message.type === "push-response") {
    enqueuePush({
      pushId: Number(message.pushId) || 0,
      response: message.response,
    });
    return;
  }
  if (message.type === "stop") {
    stopping = true;
    for (const [requestId, resolve] of pendingResponses) {
      pendingResponses.delete(requestId);
      resolve({
        protocolVersion: 1,
        status: "error",
        error: "bridge-stopping",
      });
    }
    pendingNotificationPushes.length = 0;
    pendingStatePush = null;
    pendingHeartbeatPush = null;
    if (resolveNextPush) {
      const resolve = resolveNextPush;
      resolveNextPush = null;
      resolve(null);
    }
  }
});

async function run() {
  if (!REQUESTED_PIPE_PATH) throw new Error("pipe-path-required");
  const widgetPackageSid = deriveWidgetPackageSid();
  const pipePath = resolveServerPipePath(widgetPackageSid);
  const securityDescriptor = createSecurityDescriptor(widgetPackageSid);
  let announcedReady = false;
  let announcedWaitingForNamespace = false;
  let announcedEndpointBusy = false;
  try {
    while (!stopping) {
      let handle = null;
      try {
        handle = createPipe(pipePath, securityDescriptor);
        announcedEndpointBusy = false;
        if (!announcedReady) {
          announcedReady = true;
          post("ready", {
            runtime: parentPort ? "worker-thread" : "child-process",
            widgetPackageFamilyName: WIDGET_PACKAGE_FAMILY_NAME,
            widgetPackageSid,
            pipePath,
          });
        }
        const connected = ConnectNamedPipe(handle, null);
        if (!connected && GetLastError() !== ERROR_PIPE_CONNECTED) {
          throw new Error(`connect-pipe-failed:${GetLastError()}`);
        }

        const requestResult = readRequest(handle);
        if (requestResult.disconnected) continue;
        if (requestResult.error) {
          writeResponse(handle, {
            protocolVersion: 1,
            status: "error",
            error: requestResult.error,
          });
          continue;
        }

        let request;
        try {
          request = JSON.parse(String(requestResult.line || "").trim());
        } catch {
          writeResponse(handle, {
            protocolVersion: 1,
            status: "error",
            error: "invalid-json",
          });
          continue;
        }

        if (
          request?.type === "bridge-shutdown" &&
          SHUTDOWN_TOKEN &&
          request?.token === SHUTDOWN_TOKEN
        ) {
          stopping = true;
          continue;
        }

        const clientIdentity = validateClientIdentity(handle);
        if (!clientIdentity.accepted) {
          post("client-rejected", clientIdentity);
          continue;
        }

        const requestId = nextRequestId++;
        post("request", { requestId, request });
        const response = await waitForResponse(requestId);
        const responseWritten = writeResponse(handle, response);
        if (
          responseWritten &&
          request?.type === "subscribe" &&
          Number(request?.protocolVersion) === 2
        ) {
          post("subscriber-connected", {
            revision: String(response?.revision || request?.knownRevision || ""),
            imageCacheDirectory: String(request?.imageCacheDirectory || ""),
            capabilities: Array.isArray(request?.capabilities)
              ? request.capabilities
              : [],
          });
          try {
            while (!stopping) {
              const pushed = await waitForPush();
              if (!pushed || stopping) break;
              const pushId = Number(pushed.pushId) || 0;
              post("push-started", { pushId });
              try {
                if (!writeResponse(handle, pushed.response)) {
                  post("push-failed", {
                    pushId,
                    error: "client-disconnected",
                  });
                  break;
                }
                let notificationResult = null;
                if (pushed.response?.status === "notification") {
                  const expectedNotificationId = String(
                    pushed.response?.notification?.notificationId || "",
                  );
                  const acknowledgement = readRequest(handle);
                  if (acknowledgement.disconnected) {
                    throw new Error("notification-ack-client-disconnected");
                  }
                  if (acknowledgement.error) {
                    throw new Error(
                      `notification-ack-${acknowledgement.error}`,
                    );
                  }
                  let parsedAcknowledgement;
                  try {
                    parsedAcknowledgement = JSON.parse(
                      String(acknowledgement.line || "").trim(),
                    );
                  } catch {
                    throw new Error("notification-ack-invalid-json");
                  }
                  if (
                    parsedAcknowledgement?.type !== "notification-result" ||
                    Number(parsedAcknowledgement?.protocolVersion) !== 2 ||
                    String(parsedAcknowledgement?.notificationId || "") !==
                      expectedNotificationId
                  ) {
                    throw new Error("notification-ack-invalid");
                  }
                  notificationResult = {
                    status: String(
                      parsedAcknowledgement?.status || "error",
                    ),
                    reason: String(parsedAcknowledgement?.reason || ""),
                  };
                }
                post("push-complete", {
                  pushId,
                  ...(notificationResult
                    ? { result: notificationResult }
                    : {}),
                });
              } catch (error) {
                post("push-failed", {
                  pushId,
                  error: error?.message || String(error),
                });
                throw error;
              }
            }
          } finally {
            pendingNotificationPushes.length = 0;
            pendingStatePush = null;
            pendingHeartbeatPush = null;
            resolveNextPush = null;
            post("subscriber-disconnected");
            // A synchronous named-pipe instance can remain inside a native
            // reconnect call after its long-lived subscriber disappears. End
            // this isolated helper cleanly here; the parent starts a fresh
            // process after Windows has released every handle owned by this
            // one.
            stopping = true;
            if (!parentPort) {
              process.exit(SUBSCRIBER_DISCONNECTED_EXIT_CODE);
            }
          }
        }
      } catch (error) {
        if (!handle) {
          // ERROR_PATH_NOT_FOUND is expected when Electron starts before the
          // widget package has created its per-session AppContainer namespace.
          // Keep the optional bridge dormant and retry after the widget opens.
          if (
            USE_WIDGET_APP_CONTAINER_NAMESPACE &&
            error?.win32Code === ERROR_PATH_NOT_FOUND &&
            !stopping
          ) {
            if (!announcedWaitingForNamespace) {
              announcedWaitingForNamespace = true;
              post("endpoint-waiting", {
                pipePath,
                widgetPackageFamilyName: WIDGET_PACKAGE_FAMILY_NAME,
                widgetPackageSid,
              });
            }
            await new Promise((resolve) =>
              setTimeout(resolve, ENDPOINT_RETRY_DELAY_MS),
            );
            continue;
          }
          // An existing instance can briefly retain the endpoint while the
          // Store widget is installed, updated, closed, or reconnecting. Keep
          // retrying inside this worker: recycling the worker cannot release a
          // process-owned native handle and previously caused an exit/restart
          // loop when Windows returned ERROR_PIPE_BUSY.
          if (error?.win32Code === ERROR_PIPE_BUSY && !stopping) {
            if (!announcedEndpointBusy) {
              announcedEndpointBusy = true;
              post("endpoint-busy", {
                pipePath,
                retryDelayMs: ENDPOINT_RETRY_DELAY_MS,
                widgetPackageFamilyName: WIDGET_PACKAGE_FAMILY_NAME,
                widgetPackageSid,
              });
            }
            await new Promise((resolve) =>
              setTimeout(resolve, ENDPOINT_RETRY_DELAY_MS),
            );
            continue;
          }
          throw error;
        }
        if (!stopping) {
          post("client-error", { error: error?.message || String(error) });
        }
      } finally {
        if (handle && !isInvalidHandle(handle)) {
          // Closing a flushed one-client instance gives StreamReader a clean
          // EOF. An explicit DisconnectNamedPipe is surfaced by Node clients
          // as EPIPE even after they received the complete response.
          CloseHandle(handle);
        }
      }
    }
  } finally {
    LocalFree(securityDescriptor);
  }
}

run()
  .then(() => {
    post("stopped");
    if (parentPort) parentPort.close();
    else {
      process.disconnect?.();
      process.exit(0);
    }
  })
  .catch((error) => {
    post("fatal", { error: error?.message || String(error) });
    if (parentPort) parentPort.close();
    else {
      process.disconnect?.();
      process.exit(1);
    }
    process.exitCode = 1;
  });
