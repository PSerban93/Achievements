const { execFile } = require("child_process");

function watchGenerationProcess(child, timeoutMs, options = {}) {
  let timer = null;
  let error = null;
  let remainingMs = timeoutMs;
  let startedAt = 0;
  let paused = false;
  let finished = false;
  const clear = () => { clearTimeout(timer); timer = null; };
  const kill = () => {
    if (!child || child.exitCode !== null || child.signalCode) return;
    if (process.platform === "win32" && Number.isInteger(child.pid)) {
      execFile("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"],
        { windowsHide: true, timeout: 10000 }, (killError) => {
          if (killError && child.exitCode === null) child.kill("SIGKILL");
        });
    } else child.kill("SIGKILL");
  };
  const arm = () => {
    if (finished || error || !child || child.exitCode !== null || child.signalCode) return;
    clear();
    if (paused) return;
    startedAt = Date.now();
    timer = setTimeout(() => {
      error = new Error(`Generation process exceeded ${timeoutMs} ms`);
      error.code = "GENERATION_TIMEOUT";
      kill();
    }, Math.max(1, remainingMs));
    timer.unref?.();
  };
  const touch = () => { remainingMs = timeoutMs; arm(); };
  const pause = () => {
    if (finished || paused || error) return;
    if (timer) remainingMs = Math.max(1, remainingMs - (Date.now() - startedAt));
    paused = true; clear();
  };
  const resume = () => { if (!paused) return; paused = false; arm(); };
  const abort = () => {
    if (error) return;
    error = options.signal?.reason instanceof Error ? options.signal.reason : new Error("Generation cancelled");
    error.code ||= "GENERATION_CANCELLED";
    clear(); kill();
  };
  const dispose = () => { finished = true; clear(); options.signal?.removeEventListener("abort", abort); };
  child?.once("close", dispose);
  child?.once("error", dispose);
  touch();
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  return { touch, clear: dispose, pause, resume, get error() { return error; } };
}

module.exports = { watchGenerationProcess };
