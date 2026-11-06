"use strict";

const crypto = require("crypto");
const path = require("path");
const fs = require("fs");
const { classifyCompletion, createDiagnosticTracker, expectsSelfDelete } = require("./completion");

function createWindowsSession({ pty, koffi, gatePath, script, folder, env = process.env, onData = () => {}, onState = () => {} }) {
  if (process.platform !== "win32" || process.arch !== "x64") throw new Error("Achievement Enabler requires Windows x64.");
  const lib = koffi.load("kernel32.dll");
  const createJob = lib.func("void * __stdcall CreateJobObjectW(void *, str16)");
  const setJob = lib.func("int __stdcall SetInformationJobObject(void *, int, void *, uint32_t)");
  const assign = lib.func("int __stdcall AssignProcessToJobObject(void *, void *)");
  const openProcess = lib.func("void * __stdcall OpenProcess(uint32_t, int, uint32_t)");
  const closeHandle = lib.func("int __stdcall CloseHandle(void *)");
  const createEvent = lib.func("void * __stdcall CreateEventW(void *, int, int, str16)");
  const setEvent = lib.func("int __stdcall SetEvent(void *)");
  const queryJob = lib.func("int __stdcall QueryInformationJobObject(void *, int, void *, uint32_t, void *)");
  const lastError = lib.func("uint32_t __stdcall GetLastError()");
  const check = (ok, label) => { if (!ok) throw new Error(`${label}: Windows error ${lastError()}`); };
  let job = null, event = null, processHandle = null, terminal = null, timer = null;
  let rootExited = false, stopped = false, finished = false, exitCode = null, modeTail = "", win32Input = false;
  let finishDelay = null;
  let outputTail = "", rootResult = null;
  const diagnostics = createDiagnosticTracker();
  let selfDeleteExpected = false;
  function cleanup() {
    clearInterval(timer); clearTimeout(finishDelay);
    if (job) { closeHandle(job); job = null; }
    if (processHandle) { closeHandle(processHandle); processHandle = null; }
    if (event) { closeHandle(event); event = null; }
  }
  function countProcesses() {
    if (!job) return 0;
    const info = Buffer.alloc(48);
    check(queryJob(job, 1, info, info.length, null), "QueryInformationJobObject");
    return info.readUInt32LE(40);
  }
  function complete(status, error = "") {
    if (finished) return;
    finished = true; cleanup();
    // Closing the job already terminates every owned process. A second PTY
    // kill can try to attach to a console that no longer exists on Stop.
    onState({ ...rootResult, status, exitCode, error, pid: terminal?.pid || 0, activeProcesses: 0, cleanupPending: false });
  }
  function poll() {
    if (finished || !rootExited || finishDelay) return;
    try {
      const activeProcesses = countProcesses();
      if (!rootResult) {
        rootResult = classifyCompletion(exitCode, outputTail, !fs.existsSync(script), diagnostics.snapshot(), selfDeleteExpected);
        // The UI follows the original script. Keep the job alive independently
        // until its auxiliary config-patch watcher and other helpers drain.
        if (activeProcesses) onState({ ...rootResult, pid: terminal.pid, activeProcesses, cleanupPending: true });
      }
      if (!activeProcesses) complete(stopped ? "stopped" : rootResult.status);
    } catch (error) {
      complete("failed", error.message);
    }
  }
  try {
    selfDeleteExpected = expectsSelfDelete(fs.readFileSync(script, "utf8"));
    job = createJob(null, null); check(job, "CreateJobObject");
    const limits = Buffer.alloc(144); limits.writeUInt32LE(0x2000, 16);
    check(setJob(job, 9, limits, limits.length), "SetInformationJobObject");
    const gate = `Local\\Achievements-Enabler-${crypto.randomUUID()}`;
    event = createEvent(null, 1, 0, gate); check(event, "CreateEvent");
    const childEnv = { ...env, ACHIEVEMENTS_ENABLER_GATE: gate, ACHIEVEMENTS_ENABLER_SCRIPT: script };
    delete childEnv.ELECTRON_RUN_AS_NODE;
    // We explicitly launch Windows PowerShell. An inherited PowerShell 7 module
    // path can hide its built-in cmdlets (including Get-FileHash in upstream
    // checks). Let Windows PowerShell build its own compatible module path.
    for (const key of Object.keys(childEnv)) {
      if (key.toLowerCase() === "psmodulepath") delete childEnv[key];
    }
    terminal = pty.spawn(path.join(env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), [
      "-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", gatePath,
    ], { cwd: folder, env: childEnv, cols: 100, rows: 25, name: "xterm-256color", useConpty: true });
    terminal.onData(data => {
      outputTail = (outputTail + data).slice(-65536);
      diagnostics.append(data);
      const scan = modeTail + data;
      for (const match of scan.matchAll(/\x1b\[\?9001([hl])/g)) win32Input = match[1] === "h";
      modeTail = scan.slice(-12);
      onData(data);
    });
    terminal.onExit(result => {
      rootExited = true; exitCode = result.exitCode;
      if (finished) return;
      // ConPTY may flush its final output after process exit.
      finishDelay = setTimeout(() => { finishDelay = null; poll(); }, 100);
    });
    processHandle = openProcess(0x100 | 1 | 0x1000, 0, terminal.pid); check(processHandle, "OpenProcess");
    check(assign(job, processHandle), "AssignProcessToJobObject");
    onState({ status: "running", pid: terminal.pid, activeProcesses: 1 });
    check(setEvent(event), "SetEvent");
    timer = setInterval(poll, 1000); timer.unref?.();
  } catch (error) {
    finished = true; cleanup();
    if (terminal && !rootExited) { try { terminal.kill(); } catch {} }
    throw error;
  }
  return {
    input(text, raw = false) {
      if (finished || rootExited) throw new Error("The script is no longer accepting input.");
      if (typeof text !== "string" || text.length > 4096) throw new Error("Invalid input.");
      let data = text;
      if (win32Input && !text.includes("\x1b")) {
        data = text.split("").map(char => {
          const uc = char.charCodeAt(0);
          const vk = [8, 9, 13, 27, 32].includes(uc) ? uc : /^[a-z0-9]$/i.test(char) ? char.toUpperCase().charCodeAt(0) : 0;
          return `\x1b[${vk};0;${uc};1;0;1_\x1b[${vk};0;${uc};0;0;1_`;
        }).join("");
      } else if (!raw && text.includes("\x1b")) throw new Error("Use the terminal for special keys.");
      terminal.write(data);
    },
    resize(cols, rows) {
      if (!finished && !rootExited && Number.isInteger(cols) && Number.isInteger(rows) && cols >= 40 && cols <= 240 && rows >= 10 && rows <= 100) terminal.resize(cols, rows);
    },
    stop() { stopped = true; complete("stopped"); },
    get finished() { return finished; },
  };
}

module.exports = { createWindowsSession };
