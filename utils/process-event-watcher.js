const path = require("path");
const { spawn } = require("child_process");

const DEFAULT_RESTART_DELAY_MS = 1500;
const DEFAULT_HOST_TAG = "ACH_EVENTS_HOST_V1";

const CHANNEL_PROCESS = "process";
const CHANNEL_LUMAPLAY = "lumaplay";

const hubState = {
  subscriptions: new Set(),
  watcherProcess: null,
  launching: false,
  restartTimer: null,
  ready: false,
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

function toSafeQuoted(value, fallback = "") {
  const normalized = String(value || fallback || "").trim() || fallback;
  return normalized.replace(/'/g, "''");
}

function buildUnifiedEventWatchScript(options = {}) {
  const hostTag = toSafeQuoted(options.hostTag, DEFAULT_HOST_TAG);
  const sourceBase = toSafeQuoted(
    options.sourceBase,
    `ach-events-host-${process.pid}-${Date.now()}`,
  );
  const enableProcess = options.enableProcess !== false;
  const enableLumaplay = options.enableLumaplay !== false;
  return [
    "$ErrorActionPreference = 'Stop'",
    `$hostTag = '${hostTag}'`,
    `$sourceBase = '${sourceBase}'`,
    `$enableProcess = $${enableProcess ? "true" : "false"}`,
    `$enableLumaplay = $${enableLumaplay ? "true" : "false"}`,
    "$procStartSource = \"$sourceBase-proc-start\"",
    "$procStopSource  = \"$sourceBase-proc-stop\"",
    "$lumaSource      = \"$sourceBase-lumaplay\"",
    "$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
    "$rootPath = \"$sid\\\\Software\\\\LumaPlay\"",
    "$escapedRootPath = $rootPath -replace '\\\\', '\\\\\\\\'",
    "function Emit([hashtable]$obj) {",
    "  try { [Console]::WriteLine(($obj | ConvertTo-Json -Compress -Depth 6)) } catch {}",
    "}",
    "try {",
    "  $procEnabled = $false",
    "  $lumaEnabled = $false",
    "  if ($enableProcess) {",
    "    try {",
    "      Register-WmiEvent -Class Win32_ProcessStartTrace -SourceIdentifier $procStartSource | Out-Null",
    "      Register-WmiEvent -Class Win32_ProcessStopTrace -SourceIdentifier $procStopSource | Out-Null",
    "      $procEnabled = $true",
    "    } catch {",
    "      [Console]::Error.WriteLine(\"__ACH_EVENT_HOST_WARN__:process:$($_.Exception.Message)\")",
    "      Unregister-Event -SourceIdentifier $procStartSource -ErrorAction SilentlyContinue",
    "      Unregister-Event -SourceIdentifier $procStopSource -ErrorAction SilentlyContinue",
    "      Remove-Event -SourceIdentifier $procStartSource -ErrorAction SilentlyContinue",
    "      Remove-Event -SourceIdentifier $procStopSource -ErrorAction SilentlyContinue",
    "    }",
    "  }",
    "  if ($enableLumaplay) {",
    "    try {",
    "      $lumaQuery = \"SELECT * FROM RegistryTreeChangeEvent WHERE Hive='HKEY_USERS' AND RootPath='$escapedRootPath'\"",
    "      Register-WmiEvent -Namespace root/default -Query $lumaQuery -SourceIdentifier $lumaSource | Out-Null",
    "      $lumaEnabled = $true",
    "    } catch {",
    "      [Console]::Error.WriteLine(\"__ACH_EVENT_HOST_WARN__:lumaplay:$($_.Exception.Message)\")",
    "      Unregister-Event -SourceIdentifier $lumaSource -ErrorAction SilentlyContinue",
    "      Remove-Event -SourceIdentifier $lumaSource -ErrorAction SilentlyContinue",
    "    }",
    "  }",
    "  $hasAnyChannel = $procEnabled -or $lumaEnabled",
    "  if (-not $hasAnyChannel) {",
    "    [Console]::Error.WriteLine('__ACH_EVENT_HOST_WARN__:No event channels could be registered')",
    "  }",
    "  [Console]::WriteLine(\"__ACH_EVENT_HOST_READY__:$hostTag\")",
    "  while ($true) {",
    "    if (-not $hasAnyChannel) {",
    "      Start-Sleep -Seconds 3600",
    "      continue",
    "    }",
    "    $event = Wait-Event -Timeout 3600",
    "    if (-not $event) { continue }",
    "    try {",
      "      $src = [string]$event.SourceIdentifier",
      "      $evt = $event.SourceEventArgs.NewEvent",
      "      if ($procEnabled -and $src -eq $procStartSource) {",
      "        $pid = [int]$evt.ProcessID",
      "        $name = [string]$evt.ProcessName",
      "        $cmd = ''",
      "        $ppid = 0",
      "        try {",
    "          $proc = Get-CimInstance Win32_Process -Filter \"ProcessId=$pid\" -ErrorAction Stop",
    "          if ($proc -and $proc.CommandLine) { $cmd = [string]$proc.CommandLine }",
    "          if ($proc -and $proc.ParentProcessId) { $ppid = [int]$proc.ParentProcessId }",
    "        } catch {}",
    "        Emit @{ kind='process'; type='start'; pid=$pid; name=$name; cmd=$cmd; ppid=$ppid; tag=$hostTag }",
      "      } elseif ($procEnabled -and $src -eq $procStopSource) {",
      "        Emit @{ kind='process'; type='stop'; pid=[int]$evt.ProcessID; name=[string]$evt.ProcessName; tag=$hostTag }",
      "      } elseif ($lumaEnabled -and $src -eq $lumaSource) {",
      "        Emit @{ kind='lumaplay'; type='change'; tag=$hostTag }",
      "      }",
    "    } catch {",
    "      [Console]::Error.WriteLine(\"__ACH_EVENT_HOST_WARN__:$($_.Exception.Message)\")",
    "    } finally {",
    "      Remove-Event -EventIdentifier $event.EventIdentifier -ErrorAction SilentlyContinue",
    "    }",
    "  }",
    "} catch {",
    "  [Console]::Error.WriteLine(\"__ACH_EVENT_HOST_WARN__:$($_.Exception.Message)\")",
    "  exit 1",
    "} finally {",
    "  Unregister-Event -SourceIdentifier $procStartSource -ErrorAction SilentlyContinue",
    "  Unregister-Event -SourceIdentifier $procStopSource -ErrorAction SilentlyContinue",
    "  Unregister-Event -SourceIdentifier $lumaSource -ErrorAction SilentlyContinue",
    "  Remove-Event -SourceIdentifier $procStartSource -ErrorAction SilentlyContinue",
    "  Remove-Event -SourceIdentifier $procStopSource -ErrorAction SilentlyContinue",
    "  Remove-Event -SourceIdentifier $lumaSource -ErrorAction SilentlyContinue",
    "}",
  ].join("\n");
}

function normalizeProcessEventPayload(input) {
  if (!input || typeof input !== "object") return null;
  if (String(input.kind || "").toLowerCase() !== CHANNEL_PROCESS) return null;

  const type = String(input.type || "").toLowerCase();
  if (type !== "start" && type !== "stop") return null;

  const pid = Number(input.pid);
  if (!Number.isFinite(pid) || pid <= 0) return null;

  const name = String(input.name || "").trim();
  if (!name) return null;

  const out = {
    type,
    pid: Math.floor(pid),
    name,
  };
  if (type === "start") {
    const cmd = String(input.cmd || "");
    if (cmd) out.cmd = cmd;
    const ppid = Number(input.ppid);
    if (Number.isFinite(ppid) && ppid > 0) out.ppid = Math.floor(ppid);
  }
  return out;
}

function normalizeLumaplayEventPayload(input) {
  if (!input || typeof input !== "object") return null;
  if (String(input.kind || "").toLowerCase() !== CHANNEL_LUMAPLAY) return null;
  if (String(input.type || "").toLowerCase() !== "change") return null;
  return { type: "change" };
}

function getMaxRestartDelayMs() {
  let maxDelay = DEFAULT_RESTART_DELAY_MS;
  for (const sub of hubState.subscriptions) {
    const next = Number(sub?.restartDelayMs);
    if (!Number.isFinite(next) || next <= 0) continue;
    maxDelay = Math.max(maxDelay, Math.floor(next));
  }
  return Math.max(500, maxDelay);
}

function clearRestartTimer() {
  if (hubState.restartTimer) {
    clearTimeout(hubState.restartTimer);
    hubState.restartTimer = null;
  }
}

function notifyWarn(message, channel = "") {
  const msg = String(message || "").trim() || "Windows event host warning";
  const normalizedChannel = String(channel || "").trim().toLowerCase();
  for (const sub of Array.from(hubState.subscriptions)) {
    if (normalizedChannel && sub?.channel !== normalizedChannel) continue;
    try {
      if (typeof sub?.onWarn === "function") sub.onWarn(msg);
    } catch {}
  }
}

function notifyReady() {
  hubState.ready = true;
  for (const sub of Array.from(hubState.subscriptions)) {
    try {
      if (typeof sub?.onReady === "function") sub.onReady();
    } catch {}
  }
}

function emitProcessEvent(payload) {
  for (const sub of Array.from(hubState.subscriptions)) {
    if (sub?.channel !== CHANNEL_PROCESS) continue;
    try {
      if (typeof sub?.onEvent === "function") sub.onEvent(payload);
    } catch {}
  }
}

function emitLumaplayEvent(payload) {
  for (const sub of Array.from(hubState.subscriptions)) {
    if (sub?.channel !== CHANNEL_LUMAPLAY) continue;
    try {
      if (typeof sub?.onEvent === "function") sub.onEvent(payload);
    } catch {}
  }
}

function parseStream(stream, isError = false) {
  if (!stream || typeof stream.on !== "function") return;
  let buffer = "";
  stream.on("data", (chunk) => {
    buffer += String(chunk || "");
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";
    for (const rawLine of lines) {
      const line = String(rawLine || "").trim();
      if (!line) continue;
      if (line.startsWith("__ACH_EVENT_HOST_READY__")) {
        notifyReady();
        continue;
      }
      if (line.startsWith("__ACH_EVENT_HOST_WARN__:")) {
        const payload = line.replace("__ACH_EVENT_HOST_WARN__:", "").trim();
        const idx = payload.indexOf(":");
        if (idx > 0) {
          const channel = payload.slice(0, idx).trim().toLowerCase();
          const message = payload.slice(idx + 1).trim();
          notifyWarn(message, channel);
        } else {
          notifyWarn(payload);
        }
        continue;
      }
      try {
        const parsed = JSON.parse(line);
        const processPayload = normalizeProcessEventPayload(parsed);
        if (processPayload) {
          emitProcessEvent(processPayload);
          continue;
        }
        const lumaplayPayload = normalizeLumaplayEventPayload(parsed);
        if (lumaplayPayload) {
          emitLumaplayEvent(lumaplayPayload);
        }
      } catch {
        if (isError) notifyWarn(line);
      }
    }
  });
}

function stopHubProcess() {
  clearRestartTimer();
  hubState.ready = false;
  const watcherProcess = hubState.watcherProcess;
  if (watcherProcess) {
    try {
      watcherProcess.__achSuppressRestart = true;
      watcherProcess.kill();
    } catch {}
  }
  hubState.watcherProcess = null;
}

function scheduleRestart() {
  if (!hubState.subscriptions.size) return;
  clearRestartTimer();
  const delayMs = getMaxRestartDelayMs();
  hubState.restartTimer = setTimeout(() => {
    launchHubProcess();
  }, delayMs);
}

function launchHubProcess() {
  if (process.platform !== "win32") return;
  if (!hubState.subscriptions.size) return;
  if (hubState.launching || hubState.watcherProcess) return;

  hubState.launching = true;
  hubState.ready = false;
  clearRestartTimer();

  const hostTag =
    process.env.ACH_EVENT_HOST_TAG &&
    String(process.env.ACH_EVENT_HOST_TAG).trim()
      ? String(process.env.ACH_EVENT_HOST_TAG).trim()
      : DEFAULT_HOST_TAG;
  const channelFlags = getSubscribedChannelFlags();
  const script = buildUnifiedEventWatchScript({
    hostTag,
    sourceBase: `ach-events-host-${process.pid}-${Date.now()}`,
    enableProcess: channelFlags.hasProcess,
    enableLumaplay: channelFlags.hasLumaplay,
  });
  const powershellPath = resolvePowerShellPath();
  let watcherProcess = null;

  try {
    watcherProcess = spawn(
      powershellPath,
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
      {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    watcherProcess.__achSuppressRestart = false;
    hubState.watcherProcess = watcherProcess;
  } catch (err) {
    hubState.launching = false;
    notifyWarn(err?.message || String(err));
    scheduleRestart();
    return;
  }

  parseStream(watcherProcess.stdout, false);
  parseStream(watcherProcess.stderr, true);

  watcherProcess.on("error", (err) => {
    notifyWarn(err?.message || String(err));
  });
  watcherProcess.on("exit", () => {
    const suppressRestart = watcherProcess.__achSuppressRestart === true;
    if (hubState.watcherProcess !== watcherProcess) return;
    hubState.watcherProcess = null;
    hubState.ready = false;
    hubState.launching = false;
    if (!suppressRestart) scheduleRestart();
  });
  hubState.launching = false;
}

function getSubscribedChannelFlags() {
  let hasProcess = false;
  let hasLumaplay = false;
  for (const sub of hubState.subscriptions) {
    if (sub?.channel === CHANNEL_PROCESS) hasProcess = true;
    if (sub?.channel === CHANNEL_LUMAPLAY) hasLumaplay = true;
  }
  return { hasProcess, hasLumaplay };
}

function createSubscription(channel, options = {}) {
  if (process.platform !== "win32") {
    return {
      stop() {},
      isRunning() {
        return false;
      },
    };
  }

  const sub = {
    channel,
    onEvent: typeof options.onEvent === "function" ? options.onEvent : () => {},
    onReady: typeof options.onReady === "function" ? options.onReady : () => {},
    onWarn: typeof options.onWarn === "function" ? options.onWarn : () => {},
    restartDelayMs: Math.max(
      500,
      Number(options.restartDelayMs) || DEFAULT_RESTART_DELAY_MS,
    ),
  };

  const prevFlags = getSubscribedChannelFlags();
  hubState.subscriptions.add(sub);
  const nextFlags = getSubscribedChannelFlags();
  const channelsChanged =
    prevFlags.hasProcess !== nextFlags.hasProcess ||
    prevFlags.hasLumaplay !== nextFlags.hasLumaplay;
  if (channelsChanged) {
    stopHubProcess();
  }
  launchHubProcess();
  if (hubState.ready) {
    try {
      sub.onReady();
    } catch {}
  }

  return {
    stop() {
      const prevStopFlags = getSubscribedChannelFlags();
      hubState.subscriptions.delete(sub);
      const nextStopFlags = getSubscribedChannelFlags();
      if (!hubState.subscriptions.size) {
        stopHubProcess();
      } else if (
        prevStopFlags.hasProcess !== nextStopFlags.hasProcess ||
        prevStopFlags.hasLumaplay !== nextStopFlags.hasLumaplay
      ) {
        stopHubProcess();
        launchHubProcess();
      }
    },
    isRunning() {
      return !!hubState.watcherProcess && !hubState.watcherProcess.killed;
    },
  };
}

function startProcessEventWatcher(options = {}) {
  return createSubscription(CHANNEL_PROCESS, {
    onEvent: options.onEvent,
    onReady: options.onReady,
    onWarn: options.onWarn,
    restartDelayMs: options.restartDelayMs,
  });
}

function subscribeLumaPlayRegistryEvents(options = {}) {
  return createSubscription(CHANNEL_LUMAPLAY, {
    onEvent: options.onChange,
    onReady: options.onReady,
    onWarn: options.onWarn,
    restartDelayMs: options.restartDelayMs,
  });
}

module.exports = {
  startProcessEventWatcher,
  subscribeLumaPlayRegistryEvents,
};
