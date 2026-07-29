const fs = require("fs");
const os = require("os");
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
const DEFAULT_MAX_PRIVATE_MEMORY_MB = 384;
const DEFAULT_MAX_HANDLE_COUNT = 2500;
const HOST_WATCHDOG_INTERVAL_MS = 15000;
const HOST_WATCHDOG_TIMEOUT_MS = 60000;
const HOST_GRACEFUL_STOP_TIMEOUT_MS = 2500;
const HOST_RESTART_WINDOW_MS = 60000;
const HOST_RESTART_THRESHOLD = 3;
const HOST_CIRCUIT_COOLDOWN_MS = 5 * 60 * 1000;
const HOST_STABLE_RESET_MS = 10 * 60 * 1000;
const HOST_MAX_RESTART_DELAY_MS = 30000;

const CHANNEL_PROCESS = "process";
const CHANNEL_LUMAPLAY = "lumaplay";

const PROCESS_EVENT_BRIDGE_CSHARP = String.raw`
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading;

public sealed class AchievementsProcessEventRecord
{
    public string Type;
    public int Pid;
    public string Name;
    public int Ppid;
}

public sealed class AchievementsProcessEventBridge : IDisposable
{
    private const uint TH32CS_SNAPPROCESS = 0x00000002;
    private static readonly IntPtr INVALID_HANDLE_VALUE = new IntPtr(-1);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct PROCESSENTRY32
    {
        public uint dwSize;
        public uint cntUsage;
        public uint th32ProcessID;
        public IntPtr th32DefaultHeapID;
        public uint th32ModuleID;
        public uint cntThreads;
        public uint th32ParentProcessID;
        public int pcPriClassBase;
        public uint dwFlags;

        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
        public string szExeFile;
    }

    private sealed class ProcessSnapshotEntry
    {
        public int Pid;
        public int Ppid;
        public string Name;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr CreateToolhelp32Snapshot(
        uint dwFlags,
        uint th32ProcessID);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool Process32FirstW(
        IntPtr hSnapshot,
        ref PROCESSENTRY32 lppe);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool Process32NextW(
        IntPtr hSnapshot,
        ref PROCESSENTRY32 lppe);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(IntPtr hObject);

    private readonly Queue<AchievementsProcessEventRecord> queue =
        new Queue<AchievementsProcessEventRecord>();
    private readonly int maxPending;
    private Dictionary<int, ProcessSnapshotEntry> previous =
        new Dictionary<int, ProcessSnapshotEntry>();
    private int dropped;
    private int disposed;

    public AchievementsProcessEventBridge(int maxPending)
    {
        this.maxPending = Math.Max(1, maxPending);
    }

    public int QueueDepth
    {
        get { return queue.Count; }
    }

    public void Start()
    {
        ThrowIfDisposed();
        previous = CaptureSnapshot();
    }

    public AchievementsProcessEventRecord[] TakeBatch(int maxBatchSize, int waitMs)
    {
        ThrowIfDisposed();
        int limit = Math.Max(1, maxBatchSize);
        if (queue.Count == 0)
        {
            if (waitMs > 0) Thread.Sleep(waitMs);
            Refresh();
        }

        List<AchievementsProcessEventRecord> batch =
            new List<AchievementsProcessEventRecord>(limit);
        while (batch.Count < limit && queue.Count > 0)
        {
            batch.Add(queue.Dequeue());
        }
        return batch.ToArray();
    }

    public int DrainDroppedCount()
    {
        return Interlocked.Exchange(ref dropped, 0);
    }

    private void Refresh()
    {
        Dictionary<int, ProcessSnapshotEntry> current = CaptureSnapshot();

        foreach (KeyValuePair<int, ProcessSnapshotEntry> pair in current)
        {
            ProcessSnapshotEntry oldEntry;
            if (!previous.TryGetValue(pair.Key, out oldEntry))
            {
                Enqueue("start", pair.Value);
                continue;
            }
            if (!String.Equals(
                    oldEntry.Name,
                    pair.Value.Name,
                    StringComparison.OrdinalIgnoreCase) ||
                oldEntry.Ppid != pair.Value.Ppid)
            {
                Enqueue("stop", oldEntry);
                Enqueue("start", pair.Value);
            }
        }

        foreach (KeyValuePair<int, ProcessSnapshotEntry> pair in previous)
        {
            if (current.ContainsKey(pair.Key)) continue;
            Enqueue("stop", pair.Value);
        }

        previous = current;
    }

    private void Enqueue(string type, ProcessSnapshotEntry entry)
    {
        if (entry == null || entry.Pid <= 0 ||
            String.IsNullOrWhiteSpace(entry.Name))
        {
            return;
        }

        if (queue.Count >= maxPending)
        {
            Interlocked.Increment(ref dropped);
            return;
        }

        AchievementsProcessEventRecord record =
            new AchievementsProcessEventRecord();
        record.Type = type;
        record.Pid = entry.Pid;
        record.Name = entry.Name;
        record.Ppid = entry.Ppid;
        queue.Enqueue(record);
    }

    private static Dictionary<int, ProcessSnapshotEntry> CaptureSnapshot()
    {
        Dictionary<int, ProcessSnapshotEntry> result =
            new Dictionary<int, ProcessSnapshotEntry>();
        IntPtr snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if (snapshot == INVALID_HANDLE_VALUE)
        {
            throw new System.ComponentModel.Win32Exception(
                Marshal.GetLastWin32Error());
        }

        try
        {
            PROCESSENTRY32 entry = new PROCESSENTRY32();
            entry.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32));
            if (!Process32FirstW(snapshot, ref entry))
            {
                int error = Marshal.GetLastWin32Error();
                if (error == 18) return result;
                throw new System.ComponentModel.Win32Exception(error);
            }

            do
            {
                int pid = unchecked((int)entry.th32ProcessID);
                string name = entry.szExeFile ?? String.Empty;
                if (pid > 0 && !String.IsNullOrWhiteSpace(name))
                {
                    ProcessSnapshotEntry item = new ProcessSnapshotEntry();
                    item.Pid = pid;
                    item.Ppid = unchecked((int)entry.th32ParentProcessID);
                    item.Name = name;
                    result[pid] = item;
                }
                entry.dwSize =
                    (uint)Marshal.SizeOf(typeof(PROCESSENTRY32));
            }
            while (Process32NextW(snapshot, ref entry));
        }
        finally
        {
            CloseHandle(snapshot);
        }
        return result;
    }

    private void ThrowIfDisposed()
    {
        if (Volatile.Read(ref disposed) != 0)
        {
            throw new ObjectDisposedException(
                "AchievementsProcessEventBridge");
        }
    }

    public void Dispose()
    {
        if (Interlocked.Exchange(ref disposed, 1) != 0) return;
        queue.Clear();
        previous.Clear();
    }
}
`;

function pruneStaleWatcherControlFiles() {
  if (process.platform !== "win32") return;
  let names = [];
  try {
    names = fs.readdirSync(os.tmpdir());
  } catch {
    return;
  }
  let inspected = 0;
  for (const name of names) {
    const match = /^ach-events-host-(\d+)-.*\.stop$/i.exec(name);
    if (!match) continue;
    inspected += 1;
    if (inspected > 256) break;
    const ownerPid = Number(match[1]) || 0;
    let ownerAlive = false;
    if (ownerPid > 0) {
      try {
        process.kill(ownerPid, 0);
        ownerAlive = true;
      } catch {}
    }
    if (ownerAlive) continue;
    try {
      fs.unlinkSync(path.join(os.tmpdir(), name));
    } catch {}
  }
}

pruneStaleWatcherControlFiles();

const hubState = {
  subscriptions: new Set(),
  watcherProcess: null,
  launching: false,
  restartTimer: null,
  circuitTimer: null,
  stableTimer: null,
  watchdogTimer: null,
  ready: false,
  lastMessageAt: 0,
  warnCache: new Map(),
  generation: 0,
  restartCount: 0,
  consecutiveFailures: 0,
  restartTimestamps: [],
  circuitOpenUntil: 0,
  startedAt: 0,
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
  const stopFilePath = toSafeQuoted(options.stopFilePath, "");
  const parentPid = Math.max(0, Math.floor(Number(options.parentPid) || 0));
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
  const maxPrivateMemoryMb = Math.max(
    128,
    Number(options.maxPrivateMemoryMb) || DEFAULT_MAX_PRIVATE_MEMORY_MB,
  );
  const maxHandleCount = Math.max(
    256,
    Number(options.maxHandleCount) || DEFAULT_MAX_HANDLE_COUNT,
  );
  const processBridgeSourceBase64 = Buffer.from(
    PROCESS_EVENT_BRIDGE_CSHARP,
    "utf8",
  ).toString("base64");
  return [
    "$ErrorActionPreference = 'Stop'",
    `$hostTag = '${hostTag}'`,
    `$sourceBase = '${sourceBase}'`,
    `$enableProcess = $${enableProcess ? "true" : "false"}`,
    `$enableLumaplay = $${enableLumaplay ? "true" : "false"}`,
    `$stopFile = '${stopFilePath}'`,
    `$parentPid = ${parentPid}`,
    `$maxBatchSize = ${Math.floor(maxBatchSize)}`,
    `$maxPendingEvents = ${Math.floor(maxPendingEvents)}`,
    `$batchWindowMs = ${Math.floor(batchWindowMs)}`,
    `$heartbeatIntervalMs = ${Math.floor(heartbeatIntervalMs)}`,
    `$maxWorkingSetMb = ${Math.floor(maxWorkingSetMb)}`,
    `$maxPrivateMemoryMb = ${Math.floor(maxPrivateMemoryMb)}`,
    `$maxHandleCount = ${Math.floor(maxHandleCount)}`,
    "$lumaSource      = \"$sourceBase-lumaplay\"",
    `$processBridgeSourceBase64 = '${processBridgeSourceBase64}'`,
    "$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
    "$rootPath = \"$sid\\\\Software\\\\LumaPlay\"",
    "$escapedRootPath = $rootPath -replace '\\\\', '\\\\\\\\'",
    "function Emit([hashtable]$obj) {",
    "  try { [Console]::WriteLine(($obj | ConvertTo-Json -Compress -Depth 6)) } catch {}",
    "}",
    "$processedCount = 0",
    "$droppedCount = 0",
    "$startedAt = [DateTime]::UtcNow",
    "$lastHeartbeatAt = [DateTime]::UtcNow",
    "$procBridge = $null",
    "try {",
    "  $procEnabled = $false",
    "  $lumaEnabled = $false",
    "  if ($enableProcess) {",
    "    try {",
    "      $processBridgeSource = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($processBridgeSourceBase64))",
    "      Add-Type -TypeDefinition $processBridgeSource",
    "      $procBridge = New-Object AchievementsProcessEventBridge -ArgumentList ([int]$maxPendingEvents)",
    "      $procBridge.Start()",
    "      $procEnabled = $true",
    "    } catch {",
    "      [Console]::Error.WriteLine(\"__ACH_EVENT_HOST_WARN__:process:$($_.Exception.Message)\")",
    "      if ($null -ne $procBridge) { try { $procBridge.Dispose() } catch {} }",
    "      $procBridge = $null",
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
    "  Emit @{ kind='control'; type='ready'; processEnabled=$procEnabled; lumaplayEnabled=$lumaEnabled; watchMode=$(if ($procEnabled) { 'native-snapshot' } else { '' }); tag=$hostTag }",
    "  while ($true) {",
    "    if ($stopFile -and [System.IO.File]::Exists($stopFile)) { break }",
    "    if ($parentPid -gt 0) {",
    "      $parentProcess = $null",
    "      try {",
    "        $parentProcess = [System.Diagnostics.Process]::GetProcessById($parentPid)",
    "        if ($parentProcess.HasExited) { break }",
    "      } catch {",
    "        break",
    "      } finally {",
    "        if ($null -ne $parentProcess) { $parentProcess.Dispose() }",
    "        $parentProcess = $null",
    "      }",
    "    }",
    "    $batch = New-Object System.Collections.ArrayList",
    "    $droppedNow = 0",
    "    if ($procEnabled -and $null -ne $procBridge) {",
    "      $processRecords = @($procBridge.TakeBatch($maxBatchSize, 1000))",
    "      if ($processRecords.Count -gt 0 -and $batchWindowMs -gt 0) {",
    "        Start-Sleep -Milliseconds $batchWindowMs",
    "        $remaining = [Math]::Max(0, $maxBatchSize - $processRecords.Count)",
    "        if ($remaining -gt 0) {",
    "          $processRecords += @($procBridge.TakeBatch($remaining, 0))",
    "        }",
    "      }",
    "      foreach ($record in $processRecords) {",
    "        [void]$batch.Add(@{ kind='process'; type=[string]$record.Type; pid=[int]$record.Pid; name=[string]$record.Name; ppid=[int]$record.Ppid })",
    "      }",
    "      $droppedNow += [int]$procBridge.DrainDroppedCount()",
    "    } elseif (-not $lumaEnabled) {",
    "      Start-Sleep -Seconds 1",
    "    }",
    "    if ($lumaEnabled -and $batch.Count -lt $maxBatchSize) {",
    "      $remaining = [Math]::Max(1, $maxBatchSize - $batch.Count)",
    "      $lumaEvents = @(Get-Event -SourceIdentifier $lumaSource -ErrorAction SilentlyContinue | Select-Object -First $remaining)",
    "      foreach ($lumaEvent in $lumaEvents) {",
    "        [void]$batch.Add(@{ kind='lumaplay'; type='change' })",
    "        Remove-Event -EventIdentifier $lumaEvent.EventIdentifier -ErrorAction SilentlyContinue",
    "      }",
    "      if (-not $procEnabled -and $lumaEvents.Count -eq 0) { Start-Sleep -Milliseconds 250 }",
    "    }",
    "    $queueDepth = 0",
    "    if ($procEnabled -and $null -ne $procBridge) { $queueDepth += [int]$procBridge.QueueDepth }",
    "    if ($lumaEnabled -and $null -ne (Get-Event -SourceIdentifier $lumaSource -ErrorAction SilentlyContinue | Select-Object -First 1)) { $queueDepth += 1 }",
    "    if ($droppedNow -gt 0) { $droppedCount += $droppedNow }",
    "    if ($batch.Count -gt 0 -or $droppedNow -gt 0) {",
    "      $processedCount += $batch.Count",
    "      Emit @{ kind='batch'; type='events'; events=$batch.ToArray(); queueDepth=$queueDepth; dropped=$droppedNow; resync=($droppedNow -gt 0); tag=$hostTag }",
    "    }",
    "    $processRecords = $null",
    "    $record = $null",
    "    $lumaEvents = $null",
    "    $lumaEvent = $null",
    "    $batch = $null",
    "    $now = [DateTime]::UtcNow",
    "    if (($now - $lastHeartbeatAt).TotalMilliseconds -ge $heartbeatIntervalMs) {",
    "      $currentProcess = [System.Diagnostics.Process]::GetCurrentProcess()",
    "      $workingSetMb = [Math]::Round(($currentProcess.WorkingSet64 / 1MB), 1)",
    "      $privateMemoryMb = [Math]::Round(($currentProcess.PrivateMemorySize64 / 1MB), 1)",
    "      $uptimeMs = [Math]::Round(($now - $startedAt).TotalMilliseconds)",
    "      $heartbeatQueueDepth = 0",
    "      if ($procEnabled -and $null -ne $procBridge) { $heartbeatQueueDepth += [int]$procBridge.QueueDepth }",
    "      if ($lumaEnabled -and $null -ne (Get-Event -SourceIdentifier $lumaSource -ErrorAction SilentlyContinue | Select-Object -First 1)) { $heartbeatQueueDepth += 1 }",
    "      Emit @{ kind='control'; type='heartbeat'; queueDepth=$heartbeatQueueDepth; processed=$processedCount; dropped=$droppedCount; workingSetMb=$workingSetMb; privateMemoryMb=$privateMemoryMb; handleCount=$currentProcess.HandleCount; uptimeMs=$uptimeMs; watchMode=$(if ($procEnabled) { 'native-snapshot' } else { '' }); tag=$hostTag }",
    "      $lastHeartbeatAt = $now",
    "      $resourceReason = ''",
    "      if ($workingSetMb -gt $maxWorkingSetMb) { $resourceReason = 'working-set' }",
    "      elseif ($privateMemoryMb -gt $maxPrivateMemoryMb) { $resourceReason = 'private-memory' }",
    "      elseif ($currentProcess.HandleCount -gt $maxHandleCount) { $resourceReason = 'handle-count' }",
    "      if ($resourceReason) {",
    "        Emit @{ kind='control'; type='resource-limit'; reason=$resourceReason; workingSetMb=$workingSetMb; privateMemoryMb=$privateMemoryMb; handleCount=$currentProcess.HandleCount; uptimeMs=$uptimeMs; limitMb=$maxWorkingSetMb; privateLimitMb=$maxPrivateMemoryMb; handleLimit=$maxHandleCount; tag=$hostTag }",
    "        exit 75",
    "      }",
    "      $currentProcess = $null",
    "      $heartbeatQueueDepth = 0",
    "      $resourceReason = ''",
    "    }",
    "  }",
    "} catch {",
    "  [Console]::Error.WriteLine(\"__ACH_EVENT_HOST_WARN__:$($_.Exception.Message)\")",
    "  exit 1",
    "} finally {",
    "  if ($null -ne $procBridge) { try { $procBridge.Dispose() } catch {} }",
    "  $procBridge = $null",
    "  Unregister-Event -SourceIdentifier $lumaSource -ErrorAction SilentlyContinue",
    "  Remove-Event -SourceIdentifier $lumaSource -ErrorAction SilentlyContinue",
    "  if ($stopFile) { Remove-Item -LiteralPath $stopFile -Force -ErrorAction SilentlyContinue }",
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

function clearCircuitTimer() {
  if (hubState.circuitTimer) {
    clearTimeout(hubState.circuitTimer);
    hubState.circuitTimer = null;
  }
}

function clearStableTimer() {
  if (hubState.stableTimer) {
    clearTimeout(hubState.stableTimer);
    hubState.stableTimer = null;
  }
}

function clearWatchdogTimer() {
  if (hubState.watchdogTimer) {
    clearInterval(hubState.watchdogTimer);
    hubState.watchdogTimer = null;
  }
}

function armForcedWatcherStop(watcherProcess, reason) {
  if (!watcherProcess || watcherProcess.__achForceKillTimer) return;
  watcherProcess.__achForceKillTimer = setTimeout(() => {
    watcherProcess.__achForceKillTimer = null;
    if (hubState.watcherProcess !== watcherProcess) return;
    notifyLifecycle({
      state: "force-stopping",
      pid: Number(watcherProcess.pid) || 0,
      reason,
    });
    let killRequested = false;
    try {
      killRequested = watcherProcess.kill() !== false;
    } catch {}
    watcherProcess.__achForceKillTimer = setTimeout(() => {
      watcherProcess.__achForceKillTimer = null;
      if (hubState.watcherProcess !== watcherProcess) return;
      const pid = Number(watcherProcess.pid) || 0;
      notifyWarn(
        `Windows event host PID ${pid || "unknown"} did not stop after ${
          killRequested ? "termination" : "the first force-stop attempt"
        }`,
      );
      if (process.platform === "win32" && pid > 0) {
        try {
          const forceStop = spawn(
            "taskkill.exe",
            ["/pid", String(pid), "/t", "/f"],
            {
              windowsHide: true,
              stdio: "ignore",
            },
          );
          forceStop.unref();
        } catch {}
      } else {
        try {
          watcherProcess.kill("SIGKILL");
        } catch {}
      }
    }, 1500);
  }, HOST_GRACEFUL_STOP_TIMEOUT_MS);
}

function requestWatcherStop(
  watcherProcess,
  {
    reason = "stop",
    suppressRestart = true,
    relaunchAfterStop = false,
  } = {},
) {
  if (!watcherProcess || hubState.watcherProcess !== watcherProcess) {
    return false;
  }
  watcherProcess.__achSuppressRestart = suppressRestart === true;
  watcherProcess.__achStopReason = String(reason || "stop");
  watcherProcess.__achRelaunchAfterStop = relaunchAfterStop === true;
  if (watcherProcess.__achStopRequested !== true) {
    watcherProcess.__achStopRequested = true;
    const controlFilePath = String(
      watcherProcess.__achControlFilePath || "",
    ).trim();
    try {
      if (!controlFilePath) throw new Error("Missing event host control file");
      fs.writeFileSync(controlFilePath, watcherProcess.__achStopReason, "utf8");
    } catch {
      try {
        watcherProcess.kill();
      } catch {}
    }
  }
  armForcedWatcherStop(watcherProcess, watcherProcess.__achStopReason);
  return true;
}

function startWatchdogTimer(watcherProcess) {
  clearWatchdogTimer();
  hubState.lastMessageAt = Date.now();
  hubState.watchdogTimer = setInterval(() => {
    if (hubState.watcherProcess !== watcherProcess) return;
    const silenceMs = Date.now() - hubState.lastMessageAt;
    if (silenceMs < HOST_WATCHDOG_TIMEOUT_MS) return;
    hubState.ready = false;
    notifyLifecycle({
      state: "restarting",
      pid: Number(watcherProcess?.pid) || 0,
      reason: "watchdog-timeout",
    });
    notifyWarn(`Windows event host unresponsive for ${silenceMs}ms`);
    clearWatchdogTimer();
    if (
      !requestWatcherStop(watcherProcess, {
        reason: "watchdog-timeout",
        suppressRestart: false,
      })
    ) {
      hubState.watcherProcess = null;
      scheduleRestart("watchdog-timeout");
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

function notifyLifecycle(event = {}) {
  const rawExitCode = event?.exitCode;
  const payload = {
    state: String(event?.state || "").trim() || "unknown",
    pid: Number(event?.pid) || 0,
    generation: Number(event?.generation) || hubState.generation || 0,
    restartCount: Number(event?.restartCount) || hubState.restartCount || 0,
    consecutiveFailures:
      Number(event?.consecutiveFailures) || hubState.consecutiveFailures || 0,
    circuitOpenUntil:
      Number(event?.circuitOpenUntil) || hubState.circuitOpenUntil || 0,
    startedAt: Number(event?.startedAt) || hubState.startedAt || 0,
    reason: String(event?.reason || "").trim(),
    exitCode:
      rawExitCode !== null &&
      rawExitCode !== undefined &&
      Number.isFinite(Number(rawExitCode))
        ? Number(rawExitCode)
        : null,
    signal: event?.signal ? String(event.signal) : "",
    at: Date.now(),
  };
  for (const sub of Array.from(hubState.subscriptions)) {
    try {
      if (typeof sub?.onLifecycle === "function") sub.onLifecycle(payload);
    } catch {}
  }
}

function notifyReady() {
  hubState.ready = true;
  clearStableTimer();
  hubState.stableTimer = setTimeout(() => {
    hubState.consecutiveFailures = 0;
    hubState.restartTimestamps = [];
    hubState.circuitOpenUntil = 0;
    notifyLifecycle({
      state: "stable",
      pid: Number(hubState.watcherProcess?.pid) || 0,
      reason: "stable-window-complete",
    });
  }, HOST_STABLE_RESET_MS);
  notifyLifecycle({
    state: "ready",
    pid: Number(hubState.watcherProcess?.pid) || 0,
  });
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
      privateMemoryMb: normalizeHostMetric(parsed.privateMemoryMb),
      handleCount: normalizeHostMetric(parsed.handleCount),
      uptimeMs: normalizeHostMetric(parsed.uptimeMs),
      limitMb: normalizeHostMetric(parsed.limitMb),
      privateLimitMb: normalizeHostMetric(parsed.privateLimitMb),
      handleLimit: normalizeHostMetric(parsed.handleLimit),
      reason: String(parsed.reason || "").trim(),
      watchMode: String(parsed.watchMode || "").trim(),
    };
    if (typeof parsed.processEnabled === "boolean") {
      status.processEnabled = parsed.processEnabled;
    }
    if (typeof parsed.lumaplayEnabled === "boolean") {
      status.lumaplayEnabled = parsed.lumaplayEnabled;
    }
    notifyHostStatus(status);
    if (type === "resource-limit") {
      hubState.ready = false;
      notifyLifecycle({
        state: "restarting",
        pid: Number(hubState.watcherProcess?.pid) || 0,
        reason: "resource-limit",
        exitCode: 75,
      });
      const channels = getSubscribedChannelFlags();
      notifyWarn(
        `Windows event host exceeded the ${status.reason || "resource"} limit`,
        channels.hasProcess ? CHANNEL_PROCESS : CHANNEL_LUMAPLAY,
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

function cleanupWatcherControlFile(watcherProcess) {
  const controlFilePath = String(
    watcherProcess?.__achControlFilePath || "",
  ).trim();
  if (!controlFilePath) return;
  try {
    fs.unlinkSync(controlFilePath);
  } catch {}
  watcherProcess.__achControlFilePath = "";
}

function stopHubProcess(reason = "stop") {
  clearRestartTimer();
  if (reason === "no-subscribers") {
    clearCircuitTimer();
    clearStableTimer();
    hubState.consecutiveFailures = 0;
    hubState.restartTimestamps = [];
    hubState.circuitOpenUntil = 0;
  }
  clearWatchdogTimer();
  hubState.ready = false;
  hubState.lastMessageAt = 0;
  const watcherProcess = hubState.watcherProcess;
  if (watcherProcess) {
    notifyLifecycle({
      state: "stopping",
      pid: Number(watcherProcess.pid) || 0,
      reason,
    });
    requestWatcherStop(watcherProcess, {
      reason,
      suppressRestart: true,
      relaunchAfterStop:
        reason === "channels-changed" && hubState.subscriptions.size > 0,
    });
    return;
  }
  hubState.startedAt = 0;
}

function scheduleRestart(reason = "unexpected-exit") {
  if (!hubState.subscriptions.size) return;
  clearRestartTimer();
  clearStableTimer();
  const now = Date.now();
  hubState.restartTimestamps = hubState.restartTimestamps.filter(
    (timestamp) => now - timestamp <= HOST_RESTART_WINDOW_MS,
  );
  hubState.restartTimestamps.push(now);
  hubState.consecutiveFailures += 1;
  if (hubState.restartTimestamps.length >= HOST_RESTART_THRESHOLD) {
    clearCircuitTimer();
    hubState.circuitOpenUntil = now + HOST_CIRCUIT_COOLDOWN_MS;
    notifyLifecycle({
      state: "circuit-open",
      reason,
    });
    hubState.circuitTimer = setTimeout(() => {
      hubState.circuitTimer = null;
      hubState.circuitOpenUntil = 0;
      hubState.restartTimestamps = [];
      notifyLifecycle({
        state: "circuit-half-open",
        reason: "cooldown-complete",
      });
      launchHubProcess();
    }, HOST_CIRCUIT_COOLDOWN_MS);
    return;
  }
  const baseDelayMs = getMaxRestartDelayMs();
  const delayMs = Math.min(
    HOST_MAX_RESTART_DELAY_MS,
    baseDelayMs * 2 ** Math.max(0, hubState.consecutiveFailures - 1),
  );
  notifyLifecycle({
    state: "restart-scheduled",
    reason,
  });
  hubState.restartTimer = setTimeout(() => {
    launchHubProcess();
  }, delayMs);
}

function launchHubProcess() {
  if (process.platform !== "win32") return;
  if (!hubState.subscriptions.size) return;
  if (hubState.launching || hubState.watcherProcess) return;
  if (hubState.circuitOpenUntil > Date.now()) return;

  hubState.launching = true;
  hubState.ready = false;
  clearRestartTimer();
  notifyLifecycle({
    state: "starting",
    reason: hubState.generation > 0 ? "restart" : "initial-start",
  });

  const hostTag =
    process.env.ACH_EVENT_HOST_TAG &&
    String(process.env.ACH_EVENT_HOST_TAG).trim()
      ? String(process.env.ACH_EVENT_HOST_TAG).trim()
      : DEFAULT_HOST_TAG;
  const channelFlags = getSubscribedChannelFlags();
  const controlFilePath = path.join(
    os.tmpdir(),
    `ach-events-host-${process.pid}-${Date.now()}-${Math.random()
      .toString(16)
      .slice(2)}.stop`,
  );
  try {
    fs.unlinkSync(controlFilePath);
  } catch {}
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
    maxPrivateMemoryMb:
      process.env.ACH_EVENT_HOST_MAX_PRIVATE_MEMORY_MB,
    maxHandleCount: process.env.ACH_EVENT_HOST_MAX_HANDLE_COUNT,
    stopFilePath: controlFilePath,
    parentPid: process.pid,
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
    watcherProcess.__achStopReason = "";
    watcherProcess.__achRelaunchAfterStop = false;
    watcherProcess.__achForceKillTimer = null;
    watcherProcess.__achStopRequested = false;
    watcherProcess.__achControlFilePath = controlFilePath;
    hubState.generation += 1;
    if (hubState.generation > 1) hubState.restartCount += 1;
    hubState.startedAt = Date.now();
    watcherProcess.__achStartedAt = hubState.startedAt;
    hubState.watcherProcess = watcherProcess;
    startWatchdogTimer(watcherProcess);
    notifyLifecycle({
      state: "spawned",
      pid: Number(watcherProcess.pid) || 0,
    });
  } catch (err) {
    try {
      fs.unlinkSync(controlFilePath);
    } catch {}
    hubState.launching = false;
    notifyLifecycle({
      state: "failed",
      reason: "spawn-failed",
    });
    notifyWarn(err?.message || String(err));
    scheduleRestart("spawn-failed");
    return;
  }

  parseStream(watcherProcess.stdout, false);
  parseStream(watcherProcess.stderr, true);

  watcherProcess.on("error", (err) => {
    notifyWarn(err?.message || String(err));
  });
  watcherProcess.on("close", (code, signal) => {
    const suppressRestart = watcherProcess.__achSuppressRestart === true;
    const relaunchAfterStop =
      hubState.subscriptions.size > 0 &&
      (watcherProcess.__achRelaunchAfterStop === true || suppressRestart);
    if (watcherProcess.__achForceKillTimer) {
      clearTimeout(watcherProcess.__achForceKillTimer);
      watcherProcess.__achForceKillTimer = null;
    }
    cleanupWatcherControlFile(watcherProcess);
    if (hubState.watcherProcess !== watcherProcess) return;
    clearWatchdogTimer();
    hubState.watcherProcess = null;
    hubState.ready = false;
    hubState.lastMessageAt = 0;
    hubState.startedAt = 0;
    hubState.launching = false;
    const reason =
      watcherProcess.__achStopReason ||
      (code === 75 ? "resource-limit" : "unexpected-exit");
    notifyLifecycle({
      state: suppressRestart ? "stopped" : "exited",
      pid: Number(watcherProcess.pid) || 0,
      reason,
      exitCode: code,
      signal,
      startedAt: Number(watcherProcess.__achStartedAt) || 0,
    });
    if (relaunchAfterStop) {
      launchHubProcess();
    } else if (!suppressRestart) {
      scheduleRestart(reason);
    }
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
    onLifecycle:
      typeof options.onLifecycle === "function" ? options.onLifecycle : null,
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
  if (channelsChanged && hubState.watcherProcess) {
    stopHubProcess("channels-changed");
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
        stopHubProcess("no-subscribers");
      } else if (
        prevStopFlags.hasProcess !== nextStopFlags.hasProcess ||
        prevStopFlags.hasLumaplay !== nextStopFlags.hasLumaplay
      ) {
        stopHubProcess("channels-changed");
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
    onLifecycle: options.onLifecycle,
    onReady: options.onReady,
    onWarn: options.onWarn,
    restartDelayMs: options.restartDelayMs,
  });
}

function subscribeLumaPlayRegistryEvents(options = {}) {
  const {
    subscribeLumaPlayRegistryEvents: subscribeDedicatedLumaPlayHost,
  } = require("./lumaplay-event-watcher");
  return subscribeDedicatedLumaPlayHost(options);
}

module.exports = {
  startProcessEventWatcher,
  subscribeLumaPlayRegistryEvents,
};
