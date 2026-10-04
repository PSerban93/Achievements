const path = require("path");
const fs = require("fs");

module.exports = async (context) => {
  if (context.electronPlatformName !== "win32") return;

  const appOutDir = context.appOutDir;
  if (!appOutDir) {
    throw new Error("afterPack: appOutDir is missing");
  }

  const requiredUnpackedUtilities = [
    ["Screenshot capture", "screenshot-capture-worker.js"],
    ["Native screenshot capture", "native/achievements-hdr-screenshot.exe"],
    ["XLiveLessNess", "xlivelessness-worker.js"],
    ["Game Bar named pipe", "gamebar-widget-pipe-worker.js"],
    ["Profile backup", "profile-backup-worker.js"],
    ["Profile backup runtime", "profile-backup.js"],
  ];
  for (const [label, fileName] of requiredUnpackedUtilities) {
    const workerPath = path.join(
      appOutDir,
      "resources",
      "app.asar.unpacked",
      "utils",
      fileName,
    );
    if (!fs.existsSync(workerPath)) {
      throw new Error(`afterPack: ${label} worker missing at ${workerPath}`);
    }
  }
  const unpackedRuntimeDependencies = [
    ["adm-zip", "adm-zip.js"],
    ["tar-stream", "index.js"],
    ["b4a", "index.js"],
    ["bare-events", "index.js"],
    ["bare-fs", "index.js"],
    ["bare-path", "index.js"],
    ["bare-stream", "index.js"],
    ["bare-url", "index.js"],
    ["events-universal", "index.js"],
    ["fast-fifo", "index.js"],
    ["streamx", "index.js"],
    ["teex", "index.js"],
    ["text-decoder", "index.js"],
  ];
  for (const [packageName, entryFile] of unpackedRuntimeDependencies) {
    const dependencyPath = path.join(
      appOutDir,
      "resources",
      "app.asar.unpacked",
      "node_modules",
      packageName,
      entryFile,
    );
    if (!fs.existsSync(dependencyPath)) {
      throw new Error(
        `afterPack: Unpacked runtime dependency missing at ${dependencyPath}`,
      );
    }
  }

  // screenshot-desktop remains available on Linux/macOS; its Windows BAT/C#
  // implementation must never enter a Windows release, packed or unpacked.
  const legacyCapturePath = path.join(
    appOutDir, "resources", "app.asar.unpacked", "node_modules",
    "screenshot-desktop", "lib", "win32",
  );
  const { listPackage } = require("@electron/asar");
  const archive = path.join(appOutDir, "resources", "app.asar");
  if (fs.existsSync(legacyCapturePath) || listPackage(archive).some((entry) =>
    /\/node_modules\/screenshot-desktop\/lib\/win32(?:\/|$)/i.test(entry.replace(/\\/g, "/")),
  )) {
    throw new Error("afterPack: legacy Windows screenshot BAT was bundled");
  }

  const exeName = context.packager?.appInfo?.productFilename
    ? `${context.packager.appInfo.productFilename}.exe`
    : null;
  let exePath = exeName ? path.join(appOutDir, exeName) : null;
  if (!exePath || !fs.existsSync(exePath)) {
    const exeCandidates = fs
      .readdirSync(appOutDir)
      .filter((name) => name.toLowerCase().endsWith(".exe"));
    if (!exeCandidates.length) {
      throw new Error(`afterPack: no exe found in ${appOutDir}`);
    }
    exePath = path.join(appOutDir, exeCandidates[0]);
  }

  const projectDir = context.projectDir || process.cwd();
  const manifestPath = path.join(projectDir, "build", "app.manifest");
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`afterPack: manifest missing at ${manifestPath}`);
  }

  // Only patch DPI settings here. Preserve Electron's compatibility, common
  // controls and UAC manifest entries. Builder edits metadata/icon/UAC and signs
  // afterwards; writing resources after signing would invalidate the signature.
  const { NtExecutable, NtExecutableResource } = require("resedit");
  const executable = NtExecutable.from(fs.readFileSync(exePath), { ignoreCert: true });
  const resources = NtExecutableResource.from(executable);
  const manifests = resources.entries.filter((entry) => entry.type === 24 && entry.id === 1);
  if (!manifests.length) throw new Error("afterPack: Electron application manifest missing");
  const template = fs.readFileSync(manifestPath, "utf8");
  for (const entry of manifests) {
    let manifest = Buffer.from(entry.bin).toString("utf8");
    for (const tag of ["dpiAware", "dpiAwareness"]) {
      const setting = template.match(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`))?.[0];
      if (!setting) throw new Error(`afterPack: ${tag} setting missing`);
      const existing = new RegExp(`<(?:[\\w.-]+:)?${tag}\\b[^>]*>[\\s\\S]*?<\\/(?:[\\w.-]+:)?${tag}>`, "g");
      if (existing.test(manifest)) {
        manifest = manifest.replace(existing, setting);
      } else {
        const closingSettings = /<\/(?:[\w.-]+:)?windowsSettings>/;
        if (!closingSettings.test(manifest)) {
          throw new Error("afterPack: Electron Windows settings missing");
        }
        manifest = manifest.replace(closingSettings, `${setting}$&`);
      }
    }
    resources.replaceResourceEntryFromString(24, entry.id, entry.lang, manifest);
  }
  resources.outputResource(executable);
  fs.writeFileSync(exePath, Buffer.from(executable.generate()));
};
