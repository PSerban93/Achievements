const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const DEFAULT_RESTART_DELAY_MS = 1500;
const HEARTBEAT_INTERVAL_MS = 15000;
const WATCHDOG_INTERVAL_MS = 15000;
const WATCHDOG_TIMEOUT_MS = 60000;
const GRACEFUL_STOP_TIMEOUT_MS = 2500;
const RESTART_WINDOW_MS = 60000;
const RESTART_THRESHOLD = 3;
const CIRCUIT_COOLDOWN_MS = 5 * 60 * 1000;
const STABLE_RESET_MS = 10 * 60 * 1000;
const MAX_RESTART_DELAY_MS = 30000;
const DEFAULT_MAX_WORKING_SET_MB = 192;
const DEFAULT_MAX_PRIVATE_MEMORY_MB = 256;
const DEFAULT_MAX_HANDLE_COUNT = 1500;

const state = {
  subscriptions: new Set(),
  watcherProcess: null,
  launching: false,
  ready: false,
  lastMessageAt: 0,
  generation: 0,
  restartCount: 0,
  consecutiveFailures: 0,
  restartTimestamps: [],
  circuitOpenUntil: 0,
  startedAt: 0,
  restartTimer: null,
  circuitTimer: null,
  stableTimer: null,
  watchdogTimer: null,
};

function resolvePowerShellPath() {
  if (process.env.SystemRoot) {
    return path.join(
      process.env.SystemRoot,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
  }
  return "powershell.exe";
}

function quotePowerShell(value) {
  return String(value || "").replace(/'/g, "''");
}

function positiveNumber(value, fallback, minimum = 1) {
  const number = Number(value);
  return Number.isFinite(number) && number >= minimum
    ? Math.floor(number)
    : fallback;
}

function buildLumaPlayWatchScript(options = {}) {
  const stopFile = quotePowerShell(options.stopFilePath);
  const heartbeatMs = positiveNumber(
    options.heartbeatIntervalMs,
    HEARTBEAT_INTERVAL_MS,
    1000,
  );
  const workingSetLimit = positiveNumber(
    options.maxWorkingSetMb,
    DEFAULT_MAX_WORKING_SET_MB,
    64,
  );
  const privateMemoryLimit = positiveNumber(
    options.maxPrivateMemoryMb,
    DEFAULT_MAX_PRIVATE_MEMORY_MB,
    128,
  );
  const handleLimit = positiveNumber(
    options.maxHandleCount,
    DEFAULT_MAX_HANDLE_COUNT,
    256,
  );
  return [
    "$ErrorActionPreference = 'Stop'",
    `$stopFile = '${stopFile}'`,
    `$heartbeatMs = ${heartbeatMs}`,
    `$workingSetLimit = ${workingSetLimit}`,
    `$privateMemoryLimit = ${privateMemoryLimit}`,
    `$handleLimit = ${handleLimit}`,
    "$nativeSource = @'",
    "using System;",
    "using System.Runtime.InteropServices;",
    "",
    "public static class AchRegistryNative",
    "{",
    "    public const uint REG_NOTIFY_CHANGE_NAME = 0x00000001;",
    "    public const uint REG_NOTIFY_CHANGE_LAST_SET = 0x00000004;",
    "",
    "    [DllImport(\"advapi32.dll\", SetLastError = true)]",
    "    public static extern int RegNotifyChangeKeyValue(",
    "        IntPtr hKey,",
    "        [MarshalAs(UnmanagedType.Bool)] bool watchSubtree,",
    "        uint notifyFilter,",
    "        IntPtr eventHandle,",
    "        [MarshalAs(UnmanagedType.Bool)] bool asynchronous);",
    "}",
    "'@",
    "Add-Type -TypeDefinition $nativeSource -Language CSharp",
    "$lumaPlayPath = 'Software\\LumaPlay'",
    "$softwarePath = 'Software'",
    "$startedAt = [DateTime]::UtcNow",
    "$lastHeartbeatAt = $startedAt",
    "$registryKey = $null",
    "$watchingParent = $false",
    "$changeEvent = New-Object System.Threading.AutoResetEvent($false)",
    "$waitHandles = [System.Threading.WaitHandle[]]@($changeEvent)",
    "function Emit($value) {",
    "  [Console]::WriteLine(($value | ConvertTo-Json -Compress -Depth 4))",
    "}",
    "function Close-WatchKey {",
    "  if ($null -ne $script:registryKey) {",
    "    try { $script:registryKey.Dispose() } catch {}",
    "    $script:registryKey = $null",
    "  }",
    "}",
    "function Open-WatchKey {",
    "  Close-WatchKey",
    "  $script:registryKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($lumaPlayPath, $false)",
    "  $script:watchingParent = $false",
    "  if ($null -eq $script:registryKey) {",
    "    $script:registryKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($softwarePath, $false)",
    "    $script:watchingParent = $true",
    "  }",
    "  if ($null -eq $script:registryKey) {",
    "    throw 'Unable to open HKCU\\Software for LumaPlay monitoring'",
    "  }",
    "}",
    "function Arm-Watch {",
    "  if ($null -eq $script:registryKey) { throw 'LumaPlay registry watch key is not open' }",
    "  $filter = [AchRegistryNative]::REG_NOTIFY_CHANGE_NAME",
    "  $watchSubtree = $false",
    "  if (-not $script:watchingParent) {",
    "    $filter = $filter -bor [AchRegistryNative]::REG_NOTIFY_CHANGE_LAST_SET",
    "    $watchSubtree = $true",
    "  }",
    "  $result = [AchRegistryNative]::RegNotifyChangeKeyValue(",
    "    $script:registryKey.Handle.DangerousGetHandle(),",
    "    $watchSubtree,",
    "    $filter,",
    "    $changeEvent.SafeWaitHandle.DangerousGetHandle(),",
    "    $true",
    "  )",
    "  if ($result -ne 0) {",
    "    throw (New-Object System.ComponentModel.Win32Exception($result))",
    "  }",
    "}",
    "try {",
    "  Open-WatchKey",
    "  Arm-Watch",
    "  [Console]::WriteLine('__ACH_LUMAPLAY_READY__')",
    "  Emit @{ kind='control'; type='ready'; lumaplayEnabled=$true; watchMode='reg-notify'; watchingParent=$watchingParent }",
    "  while ($true) {",
    "    if ($stopFile -and [System.IO.File]::Exists($stopFile)) { break }",
    "    $waitResult = [System.Threading.WaitHandle]::WaitAny($waitHandles, 1000)",
    "    if ($waitResult -eq 0) {",
    "      $wasWatchingParent = $watchingParent",
    "      if ($watchingParent) { Open-WatchKey }",
    "      try {",
    "        Arm-Watch",
    "      } catch {",
    "        Open-WatchKey",
    "        Arm-Watch",
    "      }",
    "      if ((-not $wasWatchingParent) -or (-not $watchingParent)) {",
    "        Emit @{ kind='lumaplay'; type='change'; coalesced=1; watchMode='reg-notify' }",
    "      }",
    "    }",
    "    $now = [DateTime]::UtcNow",
    "    if (($now - $lastHeartbeatAt).TotalMilliseconds -ge $heartbeatMs) {",
    "      $currentProcess = [System.Diagnostics.Process]::GetCurrentProcess()",
    "      $workingSetMb = [Math]::Round(($currentProcess.WorkingSet64 / 1MB), 1)",
    "      $privateMemoryMb = [Math]::Round(($currentProcess.PrivateMemorySize64 / 1MB), 1)",
    "      $uptimeMs = [Math]::Round(($now - $startedAt).TotalMilliseconds)",
    "      Emit @{ kind='control'; type='heartbeat'; workingSetMb=$workingSetMb; privateMemoryMb=$privateMemoryMb; handleCount=$currentProcess.HandleCount; uptimeMs=$uptimeMs; watchMode='reg-notify'; watchingParent=$watchingParent }",
    "      $reason = ''",
    "      if ($workingSetMb -gt $workingSetLimit) { $reason = 'working-set' }",
    "      elseif ($privateMemoryMb -gt $privateMemoryLimit) { $reason = 'private-memory' }",
    "      elseif ($currentProcess.HandleCount -gt $handleLimit) { $reason = 'handle-count' }",
    "      if ($reason) {",
    "        Emit @{ kind='control'; type='resource-limit'; reason=$reason; workingSetMb=$workingSetMb; privateMemoryMb=$privateMemoryMb; handleCount=$currentProcess.HandleCount; limitMb=$workingSetLimit; privateLimitMb=$privateMemoryLimit; handleLimit=$handleLimit; uptimeMs=$uptimeMs }",
    "        exit 75",
    "      }",
    "      $currentProcess = $null",
    "      $lastHeartbeatAt = $now",
    "    }",
    "  }",
    "} catch {",
    "  [Console]::Error.WriteLine(\"__ACH_LUMAPLAY_WARN__:$($_.Exception.Message)\")",
    "  exit 1",
    "} finally {",
    "  Close-WatchKey",
    "  if ($null -ne $changeEvent) { try { $changeEvent.Dispose() } catch {} }",
    "  if ($stopFile) { Remove-Item -LiteralPath $stopFile -Force -ErrorAction SilentlyContinue }",
    "}",
  ].join("\n");
}

function forEachSubscription(callback) {
  for (const subscription of Array.from(state.subscriptions)) {
    try {
      callback(subscription);
    } catch {}
  }
}

function emitLifecycle(event = {}) {
  const rawExitCode = event?.exitCode;
  const payload = {
    state: String(event?.state || "unknown"),
    pid: Number(event?.pid) || 0,
    generation: state.generation,
    restartCount: state.restartCount,
    consecutiveFailures: state.consecutiveFailures,
    circuitOpenUntil: state.circuitOpenUntil,
    startedAt: Number(event?.startedAt) || state.startedAt || 0,
    reason: String(event?.reason || ""),
    exitCode:
      rawExitCode === null ||
      rawExitCode === undefined ||
      !Number.isFinite(Number(rawExitCode))
        ? null
        : Number(rawExitCode),
    signal: event?.signal ? String(event.signal) : "",
    at: Date.now(),
  };
  forEachSubscription((subscription) => subscription.onLifecycle?.(payload));
}

function emitWarning(message) {
  const normalized =
    String(message || "").trim() || "LumaPlay registry watcher warning";
  forEachSubscription((subscription) => subscription.onWarn(normalized));
}

function emitStatus(payload = {}) {
  const status = {
    type: String(payload?.type || ""),
    workingSetMb: Number(payload?.workingSetMb) || 0,
    privateMemoryMb: Number(payload?.privateMemoryMb) || 0,
    handleCount: Number(payload?.handleCount) || 0,
    uptimeMs: Number(payload?.uptimeMs) || 0,
    limitMb: Number(payload?.limitMb) || 0,
    privateLimitMb: Number(payload?.privateLimitMb) || 0,
    handleLimit: Number(payload?.handleLimit) || 0,
    reason: String(payload?.reason || ""),
    watchMode: String(payload?.watchMode || ""),
  };
  if (typeof payload?.lumaplayEnabled === "boolean") {
    status.lumaplayEnabled = payload.lumaplayEnabled;
  }
  if (typeof payload?.watchingParent === "boolean") {
    status.watchingParent = payload.watchingParent;
  }
  forEachSubscription((subscription) => subscription.onStatus?.(status));
}

function clearTimer(name, clearFn = clearTimeout) {
  if (!state[name]) return;
  clearFn(state[name]);
  state[name] = null;
}

function cleanupControlFile(watcherProcess) {
  const filePath = String(watcherProcess?.__achControlFilePath || "").trim();
  if (!filePath) return;
  try {
    fs.unlinkSync(filePath);
  } catch {}
  watcherProcess.__achControlFilePath = "";
}

function requestStop(watcherProcess, reason, suppressRestart) {
  if (!watcherProcess || state.watcherProcess !== watcherProcess) return false;
  watcherProcess.__achSuppressRestart = suppressRestart === true;
  watcherProcess.__achStopReason = String(reason || "stop");
  if (watcherProcess.__achStopRequested !== true) {
    watcherProcess.__achStopRequested = true;
    try {
      const filePath = String(
        watcherProcess.__achControlFilePath || "",
      ).trim();
      if (!filePath) throw new Error("Missing LumaPlay control file");
      fs.writeFileSync(filePath, watcherProcess.__achStopReason, "utf8");
    } catch {
      try {
        watcherProcess.kill();
      } catch {}
    }
  }
  if (!watcherProcess.__achForceKillTimer) {
    watcherProcess.__achForceKillTimer = setTimeout(() => {
      watcherProcess.__achForceKillTimer = null;
      if (state.watcherProcess !== watcherProcess) return;
      emitLifecycle({
        state: "force-stopping",
        pid: watcherProcess.pid,
        reason: watcherProcess.__achStopReason,
      });
      try {
        watcherProcess.kill();
      } catch {}
      watcherProcess.__achForceKillTimer = setTimeout(() => {
        watcherProcess.__achForceKillTimer = null;
        if (state.watcherProcess !== watcherProcess) return;
        const pid = Number(watcherProcess.pid) || 0;
        emitWarning(`LumaPlay event host PID ${pid || "unknown"} did not stop`);
        if (pid > 0) {
          try {
            const forceStop = spawn(
              "taskkill.exe",
              ["/pid", String(pid), "/t", "/f"],
              { windowsHide: true, stdio: "ignore" },
            );
            forceStop.unref();
          } catch {}
        }
      }, 1500);
    }, GRACEFUL_STOP_TIMEOUT_MS);
  }
  return true;
}

function startStableTimer(watcherProcess) {
  clearTimer("stableTimer");
  state.stableTimer = setTimeout(() => {
    if (state.watcherProcess !== watcherProcess || !state.ready) return;
    state.consecutiveFailures = 0;
    state.restartTimestamps = [];
    state.circuitOpenUntil = 0;
    emitLifecycle({
      state: "stable",
      pid: watcherProcess.pid,
      reason: "stable-window-complete",
    });
  }, STABLE_RESET_MS);
}

function startWatchdog(watcherProcess) {
  clearTimer("watchdogTimer", clearInterval);
  state.lastMessageAt = Date.now();
  state.watchdogTimer = setInterval(() => {
    if (state.watcherProcess !== watcherProcess) return;
    const silenceMs = Date.now() - state.lastMessageAt;
    if (silenceMs < WATCHDOG_TIMEOUT_MS) return;
    clearTimer("watchdogTimer", clearInterval);
    state.ready = false;
    emitWarning(`LumaPlay event host unresponsive for ${silenceMs}ms`);
    emitLifecycle({
      state: "restarting",
      pid: watcherProcess.pid,
      reason: "watchdog-timeout",
    });
    requestStop(watcherProcess, "watchdog-timeout", false);
  }, WATCHDOG_INTERVAL_MS);
}

function getRestartDelay() {
  let delay = DEFAULT_RESTART_DELAY_MS;
  for (const subscription of state.subscriptions) {
    delay = Math.max(delay, Number(subscription.restartDelayMs) || 0);
  }
  return Math.max(500, delay);
}

function scheduleRestart(reason) {
  if (!state.subscriptions.size) return;
  clearTimer("restartTimer");
  clearTimer("stableTimer");
  const now = Date.now();
  state.restartTimestamps = state.restartTimestamps.filter(
    (timestamp) => now - timestamp <= RESTART_WINDOW_MS,
  );
  state.restartTimestamps.push(now);
  state.consecutiveFailures += 1;
  if (state.restartTimestamps.length >= RESTART_THRESHOLD) {
    clearTimer("circuitTimer");
    state.circuitOpenUntil = now + CIRCUIT_COOLDOWN_MS;
    emitLifecycle({ state: "circuit-open", reason });
    state.circuitTimer = setTimeout(() => {
      state.circuitTimer = null;
      state.circuitOpenUntil = 0;
      state.restartTimestamps = [];
      emitLifecycle({
        state: "circuit-half-open",
        reason: "cooldown-complete",
      });
      launch();
    }, CIRCUIT_COOLDOWN_MS);
    return;
  }
  const delay = Math.min(
    MAX_RESTART_DELAY_MS,
    getRestartDelay() * 2 ** Math.max(0, state.consecutiveFailures - 1),
  );
  emitLifecycle({ state: "restart-scheduled", reason });
  state.restartTimer = setTimeout(launch, delay);
}

function parseStream(stream, isError) {
  if (!stream?.on) return;
  let buffer = "";
  stream.on("data", (chunk) => {
    state.lastMessageAt = Date.now();
    buffer += String(chunk || "");
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";
    for (const rawLine of lines) {
      const line = String(rawLine || "").trim();
      if (!line) continue;
      if (line === "__ACH_LUMAPLAY_READY__") {
        state.ready = true;
        startStableTimer(state.watcherProcess);
        emitLifecycle({
          state: "ready",
          pid: state.watcherProcess?.pid,
        });
        forEachSubscription((subscription) => subscription.onReady());
        continue;
      }
      if (line.startsWith("__ACH_LUMAPLAY_WARN__:")) {
        emitWarning(line.replace("__ACH_LUMAPLAY_WARN__:", "").trim());
        continue;
      }
      try {
        const parsed = JSON.parse(line);
        if (parsed?.kind === "lumaplay" && parsed?.type === "change") {
          forEachSubscription((subscription) => subscription.onChange());
        } else if (parsed?.kind === "control") {
          emitStatus(parsed);
          if (parsed?.type === "resource-limit") {
            state.ready = false;
            emitWarning(
              `LumaPlay event host exceeded the ${
                parsed?.reason || "resource"
              } limit`,
            );
          }
        }
      } catch {
        if (isError) emitWarning(line);
      }
    }
  });
}

function launch() {
  if (
    process.platform !== "win32" ||
    !state.subscriptions.size ||
    state.launching ||
    state.watcherProcess ||
    state.circuitOpenUntil > Date.now()
  ) {
    return;
  }
  state.launching = true;
  state.ready = false;
  clearTimer("restartTimer");
  emitLifecycle({
    state: "starting",
    reason: state.generation > 0 ? "restart" : "initial-start",
  });
  const controlFilePath = path.join(
    os.tmpdir(),
    `ach-lumaplay-host-${process.pid}-${Date.now()}-${Math.random()
      .toString(16)
      .slice(2)}.stop`,
  );
  const script = buildLumaPlayWatchScript({
    stopFilePath: controlFilePath,
    heartbeatIntervalMs:
      process.env.ACH_LUMAPLAY_HOST_HEARTBEAT_MS ||
      process.env.ACH_EVENT_HOST_HEARTBEAT_MS,
    maxWorkingSetMb:
      process.env.ACH_LUMAPLAY_HOST_MAX_WORKING_SET_MB ||
      process.env.ACH_EVENT_HOST_MAX_WORKING_SET_MB,
    maxPrivateMemoryMb:
      process.env.ACH_LUMAPLAY_HOST_MAX_PRIVATE_MEMORY_MB ||
      process.env.ACH_EVENT_HOST_MAX_PRIVATE_MEMORY_MB,
    maxHandleCount:
      process.env.ACH_LUMAPLAY_HOST_MAX_HANDLE_COUNT ||
      process.env.ACH_EVENT_HOST_MAX_HANDLE_COUNT,
  });
  let watcherProcess;
  try {
    watcherProcess = spawn(
      resolvePowerShellPath(),
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-WindowStyle",
        "Hidden",
        "-Command",
        script,
      ],
      { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (error) {
    state.launching = false;
    emitWarning(error?.message || String(error));
    scheduleRestart("spawn-failed");
    return;
  }
  watcherProcess.__achControlFilePath = controlFilePath;
  watcherProcess.__achForceKillTimer = null;
  watcherProcess.__achStopRequested = false;
  watcherProcess.__achSuppressRestart = false;
  watcherProcess.__achStopReason = "";
  state.generation += 1;
  if (state.generation > 1) state.restartCount += 1;
  state.startedAt = Date.now();
  watcherProcess.__achStartedAt = state.startedAt;
  state.watcherProcess = watcherProcess;
  state.launching = false;
  startWatchdog(watcherProcess);
  emitLifecycle({ state: "spawned", pid: watcherProcess.pid });
  parseStream(watcherProcess.stdout, false);
  parseStream(watcherProcess.stderr, true);
  watcherProcess.on("error", (error) => {
    emitWarning(error?.message || String(error));
  });
  watcherProcess.on("close", (code, signal) => {
    const suppressRestart = watcherProcess.__achSuppressRestart === true;
    if (watcherProcess.__achForceKillTimer) {
      clearTimeout(watcherProcess.__achForceKillTimer);
      watcherProcess.__achForceKillTimer = null;
    }
    cleanupControlFile(watcherProcess);
    if (state.watcherProcess !== watcherProcess) return;
    clearTimer("watchdogTimer", clearInterval);
    clearTimer("stableTimer");
    state.watcherProcess = null;
    state.ready = false;
    state.lastMessageAt = 0;
    state.startedAt = 0;
    const reason =
      watcherProcess.__achStopReason ||
      (code === 75 ? "resource-limit" : "unexpected-exit");
    emitLifecycle({
      state: suppressRestart ? "stopped" : "exited",
      pid: watcherProcess.pid,
      reason,
      exitCode: code,
      signal,
      startedAt: watcherProcess.__achStartedAt,
    });
    if (suppressRestart && state.subscriptions.size > 0) {
      launch();
    } else if (!suppressRestart) {
      scheduleRestart(reason);
    }
  });
}

function stopHost(reason = "no-subscribers") {
  clearTimer("restartTimer");
  clearTimer("watchdogTimer", clearInterval);
  state.ready = false;
  if (reason === "no-subscribers") {
    clearTimer("circuitTimer");
    clearTimer("stableTimer");
    state.consecutiveFailures = 0;
    state.restartTimestamps = [];
    state.circuitOpenUntil = 0;
  }
  const watcherProcess = state.watcherProcess;
  if (!watcherProcess) return;
  emitLifecycle({ state: "stopping", pid: watcherProcess.pid, reason });
  requestStop(watcherProcess, reason, true);
}

function subscribeLumaPlayRegistryEvents(options = {}) {
  if (process.platform !== "win32") {
    return { stop() {}, isRunning: () => false };
  }
  const subscription = {
    onChange:
      typeof options.onChange === "function" ? options.onChange : () => {},
    onReady:
      typeof options.onReady === "function" ? options.onReady : () => {},
    onWarn:
      typeof options.onWarn === "function" ? options.onWarn : () => {},
    onStatus:
      typeof options.onStatus === "function" ? options.onStatus : null,
    onLifecycle:
      typeof options.onLifecycle === "function" ? options.onLifecycle : null,
    restartDelayMs: Math.max(
      500,
      Number(options.restartDelayMs) || DEFAULT_RESTART_DELAY_MS,
    ),
  };
  state.subscriptions.add(subscription);
  launch();
  if (state.ready) {
    queueMicrotask(() => {
      if (state.subscriptions.has(subscription)) subscription.onReady();
    });
  }
  let stopped = false;
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      state.subscriptions.delete(subscription);
      if (!state.subscriptions.size) stopHost();
    },
    isRunning() {
      return (
        state.subscriptions.has(subscription) &&
        !!state.watcherProcess &&
        !state.watcherProcess.killed
      );
    },
  };
}

module.exports = {
  subscribeLumaPlayRegistryEvents,
  _buildLumaPlayWatchScript: buildLumaPlayWatchScript,
};
