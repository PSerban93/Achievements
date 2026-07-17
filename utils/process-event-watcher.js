const path = require("path");
const { spawn } = require("child_process");

const DEFAULT_RESTART_DELAY_MS = 1500;
const DEFAULT_HOST_TAG = "ACH_EVENTS_HOST_V1";
const WARN_DEDUP_WINDOW_MS = 5000;
const MAX_WARN_CACHE_SIZE = 128;
const DEFAULT_MAX_BATCH_SIZE = 128;
const DEFAULT_MAX_PENDING_EVENTS = 1024;
const DEFAULT_BATCH_WINDOW_MS = 50;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 15000;
const DEFAULT_MAX_WORKING_SET_MB = 256;
const HOST_WATCHDOG_INTERVAL_MS = 15000;
const HOST_WATCHDOG_TIMEOUT_MS = 60000;

const CHANNEL_PROCESS = "process";
const CHANNEL_LUMAPLAY = "lumaplay";

const hubState = {
  subscriptions: new Set(),
  watcherProcess: null,
  launching: false,
  restartTimer: null,
  watchdogTimer: null,
  ready: false,
  lastMessageAt: 0,
  warnCache: new Map(),
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
  const maxBatchSize = Math.max(
    1,
    Number(options.maxBatchSize) || DEFAULT_MAX_BATCH_SIZE,
  );
  const maxPendingEvents = Math.max(
    maxBatchSize,
    Number(options.maxPendingEvents) || DEFAULT_MAX_PENDING_EVENTS,
  );
  const batchWindowMs = Math.max(
    0,
    Number(options.batchWindowMs) || DEFAULT_BATCH_WINDOW_MS,
  );
  const heartbeatIntervalMs = Math.max(
    1000,
    Number(options.heartbeatIntervalMs) || DEFAULT_HEARTBEAT_INTERVAL_MS,
  );
  const maxWorkingSetMb = Math.max(
    64,
    Number(options.maxWorkingSetMb) || DEFAULT_MAX_WORKING_SET_MB,
  );
  return [
    "$ErrorActionPreference = 'Stop'",
    `$hostTag = '${hostTag}'`,
    `$sourceBase = '${sourceBase}'`,
    `$enableProcess = $${enableProcess ? "true" : "false"}`,
    `$enableLumaplay = $${enableLumaplay ? "true" : "false"}`,
    `$maxBatchSize = ${Math.floor(maxBatchSize)}`,
    `$maxPendingEvents = ${Math.floor(maxPendingEvents)}`,
    `$batchWindowMs = ${Math.floor(batchWindowMs)}`,
    `$heartbeatIntervalMs = ${Math.floor(heartbeatIntervalMs)}`,
    `$maxWorkingSetMb = ${Math.floor(maxWorkingSetMb)}`,
    "$procStartSource = \"$sourceBase-proc-start\"",
    "$procStopSource  = \"$sourceBase-proc-stop\"",
    "$lumaSource      = \"$sourceBase-lumaplay\"",
    "$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
    "$rootPath = \"$sid\\\\Software\\\\LumaPlay\"",
    "$escapedRootPath = $rootPath -replace '\\\\', '\\\\\\\\'",
    "function Emit([hashtable]$obj) {",
    "  try { [Console]::WriteLine(($obj | ConvertTo-Json -Compress -Depth 6)) } catch {}",
    "}",
    "$processedCount = 0",
    "$droppedCount = 0",
    "$lastHeartbeatAt = [DateTime]::UtcNow",
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
    "    $null = Wait-Event -Timeout 1",
    "    if ($batchWindowMs -gt 0 -and (Get-Event)) { Start-Sleep -Milliseconds $batchWindowMs }",
    "    $queuedEvents = @(Get-Event)",
    "    $queueDepthBefore = $queuedEvents.Count",
    "    $droppedNow = 0",
    "    if ($queueDepthBefore -gt $maxPendingEvents) {",
    "      $droppedNow = $queueDepthBefore - $maxPendingEvents",
    "      foreach ($staleEvent in @($queuedEvents | Select-Object -First $droppedNow)) {",
    "        Remove-Event -EventIdentifier $staleEvent.EventIdentifier -ErrorAction SilentlyContinue",
    "      }",
    "      $droppedCount += $droppedNow",
    "      $queuedEvents = @($queuedEvents | Select-Object -Last $maxPendingEvents)",
    "    }",
    "    $selectedEvents = @($queuedEvents | Select-Object -First $maxBatchSize)",
    "    $batch = New-Object System.Collections.ArrayList",
    "    foreach ($event in $selectedEvents) {",
    "      try {",
    "        $src = [string]$event.SourceIdentifier",
    "        $evt = $event.SourceEventArgs.NewEvent",
    "        if ($procEnabled -and $src -eq $procStartSource) {",
    "          $item = @{ kind='process'; type='start'; pid=[int]$evt.ProcessID; name=[string]$evt.ProcessName; ppid=[int]$evt.ParentProcessID }",
    "          [void]$batch.Add($item)",
    "        } elseif ($procEnabled -and $src -eq $procStopSource) {",
    "          $item = @{ kind='process'; type='stop'; pid=[int]$evt.ProcessID; name=[string]$evt.ProcessName }",
    "          [void]$batch.Add($item)",
    "        } elseif ($lumaEnabled -and $src -eq $lumaSource) {",
    "          [void]$batch.Add(@{ kind='lumaplay'; type='change' })",
    "        }",
    "      } catch {",
    "        [Console]::Error.WriteLine(\"__ACH_EVENT_HOST_WARN__:$($_.Exception.Message)\")",
    "      } finally {",
    "        Remove-Event -EventIdentifier $event.EventIdentifier -ErrorAction SilentlyContinue",
    "      }",
    "    }",
    "    if ($batch.Count -gt 0 -or $droppedNow -gt 0) {",
    "      $processedCount += $batch.Count",
    "      Emit @{ kind='batch'; type='events'; events=$batch.ToArray(); queueDepth=[Math]::Max(0, $queuedEvents.Count - $selectedEvents.Count); dropped=$droppedNow; resync=($droppedNow -gt 0); tag=$hostTag }",
    "    }",
    "    $now = [DateTime]::UtcNow",
    "    if (($now - $lastHeartbeatAt).TotalMilliseconds -ge $heartbeatIntervalMs) {",
    "      $workingSetMb = [Math]::Round(([System.Diagnostics.Process]::GetCurrentProcess().WorkingSet64 / 1MB), 1)",
    "      Emit @{ kind='control'; type='heartbeat'; queueDepth=@(Get-Event).Count; processed=$processedCount; dropped=$droppedCount; workingSetMb=$workingSetMb; tag=$hostTag }",
    "      $lastHeartbeatAt = $now",
    "      if ($workingSetMb -gt $maxWorkingSetMb) {",
    "        Emit @{ kind='control'; type='resource-limit'; workingSetMb=$workingSetMb; limitMb=$maxWorkingSetMb; tag=$hostTag }",
    "        exit 75",
    "      }",
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

function clearWatchdogTimer() {
  if (hubState.watchdogTimer) {
    clearInterval(hubState.watchdogTimer);
    hubState.watchdogTimer = null;
  }
}

function startWatchdogTimer(watcherProcess) {
  clearWatchdogTimer();
  hubState.lastMessageAt = Date.now();
  hubState.watchdogTimer = setInterval(() => {
    if (hubState.watcherProcess !== watcherProcess) return;
    const silenceMs = Date.now() - hubState.lastMessageAt;
    if (silenceMs < HOST_WATCHDOG_TIMEOUT_MS) return;
    notifyWarn(`Windows event host unresponsive for ${silenceMs}ms`);
    try {
      watcherProcess.__achSuppressRestart = false;
      watcherProcess.kill();
    } catch {
      hubState.watcherProcess = null;
      clearWatchdogTimer();
      scheduleRestart();
    }
  }, HOST_WATCHDOG_INTERVAL_MS);
}

function pruneWarnCache(now) {
  if (hubState.warnCache.size <= MAX_WARN_CACHE_SIZE) return;
  for (const [key, lastAt] of hubState.warnCache) {
    if (now - lastAt > WARN_DEDUP_WINDOW_MS) {
      hubState.warnCache.delete(key);
    }
  }
  while (hubState.warnCache.size > MAX_WARN_CACHE_SIZE) {
    const firstKey = hubState.warnCache.keys().next().value;
    if (!firstKey) break;
    hubState.warnCache.delete(firstKey);
  }
}

function notifyWarn(message, channel = "") {
  const msg = String(message || "").trim() || "Windows event host warning";
  const normalizedChannel = String(channel || "").trim().toLowerCase();
  const now = Date.now();
  const dedupKey = `${normalizedChannel || "*"}:${msg}`;
  const lastAt = hubState.warnCache.get(dedupKey);
  if (Number.isFinite(lastAt) && now - lastAt < WARN_DEDUP_WINDOW_MS) return;
  hubState.warnCache.set(dedupKey, now);
  pruneWarnCache(now);
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

function emitProcessEvents(payloads, meta = {}) {
  const events = Array.isArray(payloads) ? payloads.filter(Boolean) : [];
  if (!events.length) return;
  for (const sub of Array.from(hubState.subscriptions)) {
    if (sub?.channel !== CHANNEL_PROCESS) continue;
    try {
      if (typeof sub?.onBatch === "function") {
        sub.onBatch(events, meta);
      } else if (typeof sub?.onEvent === "function") {
        for (const payload of events) sub.onEvent(payload);
      }
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

function notifyResync(meta = {}) {
  for (const sub of Array.from(hubState.subscriptions)) {
    try {
      if (typeof sub?.onResync === "function") sub.onResync(meta);
    } catch {}
  }
}

function notifyHostStatus(status = {}) {
  for (const sub of Array.from(hubState.subscriptions)) {
    try {
      if (typeof sub?.onStatus === "function") sub.onStatus(status);
    } catch {}
  }
}

function normalizeHostMetric(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function handleHostPayload(parsed) {
  if (!parsed || typeof parsed !== "object") return false;
  const kind = String(parsed.kind || "").toLowerCase();
  const type = String(parsed.type || "").toLowerCase();

  if (kind === "batch" && type === "events") {
    const processEvents = [];
    let lumaPlayChanged = false;
    for (const entry of Array.isArray(parsed.events) ? parsed.events : []) {
      const processPayload = normalizeProcessEventPayload(entry);
      if (processPayload) {
        processEvents.push(processPayload);
        continue;
      }
      if (normalizeLumaplayEventPayload(entry)) lumaPlayChanged = true;
    }
    const meta = {
      queueDepth: normalizeHostMetric(parsed.queueDepth),
      dropped: normalizeHostMetric(parsed.dropped),
    };
    emitProcessEvents(processEvents, meta);
    if (lumaPlayChanged) emitLumaplayEvent({ type: "change" });
    if (parsed.resync === true || meta.dropped > 0) notifyResync(meta);
    return true;
  }

  if (kind === "control") {
    const status = {
      type,
      queueDepth: normalizeHostMetric(parsed.queueDepth),
      processed: normalizeHostMetric(parsed.processed),
      dropped: normalizeHostMetric(parsed.dropped),
      workingSetMb: normalizeHostMetric(parsed.workingSetMb),
      limitMb: normalizeHostMetric(parsed.limitMb),
    };
    notifyHostStatus(status);
    if (type === "resource-limit") {
      notifyWarn(
        `Windows event host exceeded ${status.limitMb || "the"} MB memory limit`,
      );
    }
    return true;
  }
  return false;
}

function parseStream(stream, isError = false) {
  if (!stream || typeof stream.on !== "function") return;
  let buffer = "";
  stream.on("data", (chunk) => {
    hubState.lastMessageAt = Date.now();
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
        if (handleHostPayload(parsed)) continue;
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
  clearWatchdogTimer();
  hubState.ready = false;
  hubState.lastMessageAt = 0;
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
    maxBatchSize: process.env.ACH_EVENT_HOST_MAX_BATCH_SIZE,
    maxPendingEvents: process.env.ACH_EVENT_HOST_MAX_PENDING,
    batchWindowMs: process.env.ACH_EVENT_HOST_BATCH_WINDOW_MS,
    heartbeatIntervalMs: process.env.ACH_EVENT_HOST_HEARTBEAT_MS,
    maxWorkingSetMb: process.env.ACH_EVENT_HOST_MAX_WORKING_SET_MB,
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
    startWatchdogTimer(watcherProcess);
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
    clearWatchdogTimer();
    hubState.watcherProcess = null;
    hubState.ready = false;
    hubState.lastMessageAt = 0;
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
    onBatch: typeof options.onBatch === "function" ? options.onBatch : null,
    onResync: typeof options.onResync === "function" ? options.onResync : null,
    onStatus: typeof options.onStatus === "function" ? options.onStatus : null,
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
    onBatch: options.onBatch,
    onResync: options.onResync,
    onStatus: options.onStatus,
    onReady: options.onReady,
    onWarn: options.onWarn,
    restartDelayMs: options.restartDelayMs,
  });
}

function subscribeLumaPlayRegistryEvents(options = {}) {
  return createSubscription(CHANNEL_LUMAPLAY, {
    onEvent: options.onChange,
    onResync: options.onChange,
    onStatus: options.onStatus,
    onReady: options.onReady,
    onWarn: options.onWarn,
    restartDelayMs: options.restartDelayMs,
  });
}

module.exports = {
  startProcessEventWatcher,
  subscribeLumaPlayRegistryEvents,
};
