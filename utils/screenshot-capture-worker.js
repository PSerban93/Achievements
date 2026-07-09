const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");

function send(message) {
  try {
    if (typeof process.send === "function") {
      process.send(message);
    }
  } catch {}
}

function fail(error, code = "capture-failed") {
  const message = error?.message || String(error || "Screenshot failed");
  send({ ok: false, code, error: message });
  process.exitCode = 1;
}

function copyWindowsCaptureFiles() {
  const pkgDir = path.dirname(require.resolve("screenshot-desktop/package.json"));
  const sourceDir = path.join(pkgDir, "lib", "win32");
  const tempDir = path.join(os.tmpdir(), "screenCapture");
  const targetBat = path.join(tempDir, "screenCapture_1.3.2.bat");
  const targetManifest = path.join(tempDir, "app.manifest");

  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }
  if (!fs.existsSync(targetBat)) {
    fs.copyFileSync(path.join(sourceDir, "screenCapture_1.3.2.bat"), targetBat);
  }
  if (!fs.existsSync(targetManifest)) {
    fs.copyFileSync(path.join(sourceDir, "app.manifest"), targetManifest);
  }
  return { tempDir, targetBat };
}

function captureWindows(outputPath, timeoutMs) {
  return new Promise((resolve, reject) => {
    const { tempDir, targetBat } = copyWindowsCaptureFiles();
    const tempFile = path.join(
      os.tmpdir(),
      `achievements-screenshot-${process.pid}-${Date.now()}.png`,
    );
    const args = ["/c", targetBat, tempFile];

    execFile(
      "cmd.exe",
      args,
      {
        cwd: tempDir,
        windowsHide: true,
        timeout: timeoutMs,
        killSignal: "SIGKILL",
      },
      (err) => {
        try {
          if (err) {
            const timedOut = err.killed || /timed out/i.test(err.message || "");
            err.code = timedOut ? "capture-timeout" : err.code;
            reject(err);
            return;
          }
          fs.copyFileSync(tempFile, outputPath);
          resolve(outputPath);
        } finally {
          try {
            fs.rmSync(tempFile, { force: true });
          } catch {}
        }
      },
    );
  });
}

async function captureGeneric(outputPath) {
  const screenshot = require("screenshot-desktop");
  const buf = await screenshot({ format: "png" });
  fs.writeFileSync(outputPath, buf);
  return outputPath;
}

(async () => {
  try {
    const payload = JSON.parse(process.argv[2] || "{}");
    const outputPath = String(payload.outputPath || "").trim();
    const timeoutMs = Math.max(1000, Number(payload.timeoutMs) || 8000);
    if (!outputPath) {
      throw new Error("Missing outputPath");
    }
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });

    if (process.platform === "win32") {
      await captureWindows(outputPath, timeoutMs);
    } else {
      await captureGeneric(outputPath);
    }
    send({ ok: true, outputPath });
  } catch (err) {
    fail(err, err?.code || "capture-failed");
  }
})();
