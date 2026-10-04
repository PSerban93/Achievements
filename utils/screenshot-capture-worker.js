const fs = require("fs");
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

function captureWindows(outputPath, timeoutMs) {
  return captureNativeWindows(outputPath, timeoutMs, false);
}

function resolveCaptureHelper() {
  const executableName = "achievements-hdr-screenshot.exe";
  const candidates = [
    path.join(__dirname, "native", executableName),
    path.join(
      __dirname.replace(/app\.asar(?=[\\/]|$)/i, "app.asar.unpacked"),
      "native",
      executableName,
    ),
  ];
  if (process.resourcesPath) {
    candidates.push(
      path.join(
        process.resourcesPath,
        "app.asar.unpacked",
        "utils",
        "native",
        executableName,
      ),
    );
  }
  return candidates.find((candidate) => fs.existsSync(candidate)) || "";
}

function captureHdrWindows(outputPath, timeoutMs) {
  return captureNativeWindows(outputPath, timeoutMs, true);
}

function captureNativeWindows(outputPath, timeoutMs, hdr) {
  return new Promise((resolve, reject) => {
    const helper = resolveCaptureHelper();
    const prefix = hdr ? "hdr-capture" : "capture";
    if (!helper) {
      const err = new Error("Bundled Windows screenshot helper was not found");
      err.code = `${prefix}-unavailable`;
      reject(err);
      return;
    }

    execFile(
      helper,
      hdr ? [outputPath] : ["--sdr", outputPath],
      {
        windowsHide: true,
        timeout: timeoutMs,
        killSignal: "SIGKILL",
        maxBuffer: 64 * 1024,
      },
      (err, _stdout, stderr) => {
        // A killed/failed encoder may leave its atomic PNG staging file behind.
        try {
          fs.rmSync(`${outputPath}.tmp`, { force: true });
        } catch {}
        if (err) {
          const timedOut = err.killed || /timed out/i.test(err.message || "");
          err.code = `${prefix}-${timedOut ? "timeout" : "failed"}`;
          const detail = String(stderr || "").trim();
          if (detail) err.message = detail.slice(0, 1000);
          reject(err);
          return;
        }
        if (!fs.existsSync(outputPath)) {
          const missing = new Error(
            "Windows screenshot helper exited without creating the output file",
          );
          missing.code = `${prefix}-missing-output`;
          reject(missing);
          return;
        }
        resolve(outputPath);
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
    const hdrRequested = payload.enableHdrScreenshots === true;
    if (!outputPath) {
      throw new Error("Missing outputPath");
    }
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });

    let captureMode = "generic";
    let fallbackError = "";
    if (process.platform === "win32" && hdrRequested) {
      const startedAt = Date.now();
      const hdrTimeoutMs = Math.max(
        1000,
        Math.min(5000, timeoutMs - 1500),
      );
      try {
        await captureHdrWindows(outputPath, hdrTimeoutMs);
        captureMode = "windows-graphics-capture-fp16";
      } catch (err) {
        fallbackError = err?.message || String(err);
        const remainingMs = Math.max(1000, timeoutMs - (Date.now() - startedAt));
        await captureWindows(outputPath, remainingMs);
        captureMode = "windows-gdi-fallback";
      }
    } else if (process.platform === "win32") {
      await captureWindows(outputPath, timeoutMs);
      captureMode = "windows-gdi";
    } else {
      await captureGeneric(outputPath);
    }
    send({ ok: true, outputPath, captureMode, hdrRequested, fallbackError });
  } catch (err) {
    fail(err, err?.code || "capture-failed");
  }
})();
