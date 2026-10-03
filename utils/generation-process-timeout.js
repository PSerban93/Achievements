const { execFile } = require("child_process");

function watchGenerationProcess(child, timeoutMs) {
  let timer = null;
  let error = null;
  const clear = () => { clearTimeout(timer); timer = null; };
  const touch = () => {
    if (error || !child || child.exitCode !== null) return;
    clear();
    timer = setTimeout(() => {
      error = new Error(`Generation process exceeded ${timeoutMs} ms`);
      error.code = "GENERATION_TIMEOUT";
      if (process.platform === "win32" && Number.isInteger(child.pid)) {
        execFile("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"],
          { windowsHide: true, timeout: 10000 }, (killError) => {
            if (killError && child.exitCode === null) child.kill("SIGKILL");
          });
      } else {
        child.kill("SIGKILL");
      }
    }, timeoutMs);
    timer.unref?.();
  };
  child?.once("close", clear);
  child?.once("error", clear);
  touch();
  return { touch, clear, get error() { return error; } };
}

module.exports = { watchGenerationProcess };
