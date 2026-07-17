const path = require("path");
const { execFile } = require("child_process");

const DEFAULT_TIMEOUT_MS = 2000;
const DEFAULT_MAX_PIDS = 64;

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

function normalizeProcessIds(values, maxPids = DEFAULT_MAX_PIDS) {
  const ids = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const pid = Math.floor(Number(value));
    if (!Number.isFinite(pid) || pid <= 0 || seen.has(pid)) continue;
    seen.add(pid);
    ids.push(pid);
    if (ids.length >= maxPids) break;
  }
  return ids;
}

function buildCommandLineQueryScript() {
  return [
    "$ErrorActionPreference = 'Stop'",
    "$ids = @($env:ACH_PROCESS_QUERY_IDS -split ',' | ForEach-Object {",
    "  $value = 0",
    "  if ([int]::TryParse($_, [ref]$value) -and $value -gt 0) { $value }",
    "})",
    "if ($ids.Count -eq 0) { [Console]::WriteLine('[]'); exit 0 }",
    "$filter = ($ids | ForEach-Object { \"ProcessId=$_\" }) -join ' OR '",
    "$rows = @(Get-CimInstance Win32_Process -Filter $filter | ForEach-Object {",
    "  @{ pid=[int]$_.ProcessId; cmd=[string]$_.CommandLine }",
    "})",
    "[Console]::WriteLine((ConvertTo-Json -InputObject $rows -Compress -Depth 3))",
  ].join("\n");
}

function readWindowsProcessCommandLines(processIds, options = {}) {
  const maxPids = Math.max(1, Number(options.maxPids) || DEFAULT_MAX_PIDS);
  const ids = normalizeProcessIds(processIds, maxPids);
  if (process.platform !== "win32" || ids.length === 0) {
    return Promise.resolve(new Map());
  }

  const timeoutMs = Math.max(
    250,
    Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS,
  );
  const script = buildCommandLineQueryScript();
  const encoded = Buffer.from(script, "utf16le").toString("base64");

  return new Promise((resolve, reject) => {
    execFile(
      resolvePowerShellPath(),
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
        encoded,
      ],
      {
        windowsHide: true,
        timeout: timeoutMs,
        killSignal: "SIGKILL",
        maxBuffer: 1024 * 1024,
        env: {
          ...process.env,
          ACH_PROCESS_QUERY_IDS: ids.join(","),
        },
      },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        try {
          const parsed = JSON.parse(String(stdout || "[]").trim() || "[]");
          const rows = Array.isArray(parsed) ? parsed : [parsed];
          const result = new Map();
          for (const row of rows) {
            const pid = Math.floor(Number(row?.pid));
            const cmd = String(row?.cmd || "").trim();
            if (Number.isFinite(pid) && pid > 0 && cmd) result.set(pid, cmd);
          }
          resolve(result);
        } catch (parseError) {
          reject(parseError);
        }
      },
    );
  });
}

module.exports = {
  readWindowsProcessCommandLines,
};
