const path = require("path");
const fs = require("fs");

module.exports = async (context) => {
  if (context.electronPlatformName !== "win32") return;

  const appOutDir = context.appOutDir;
  if (!appOutDir) {
    throw new Error("afterPack: appOutDir is missing");
  }

  const xLiveLessNessWorkerPath = path.join(
    appOutDir,
    "resources",
    "app.asar.unpacked",
    "utils",
    "xlivelessness-worker.js",
  );
  if (!fs.existsSync(xLiveLessNessWorkerPath)) {
    throw new Error(
      `afterPack: XLiveLessNess worker missing at ${xLiveLessNessWorkerPath}`,
    );
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

  const mod = await import("rcedit");
  const rceditFn = mod?.rcedit || mod?.default;
  if (typeof rceditFn !== "function") {
    throw new Error("afterPack: rcedit export is not a function");
  }

  const appInfo = context.packager?.appInfo;
  const productName = appInfo?.productName || "Achievements";
  const companyName = appInfo?.companyName || "";
  const copyright = appInfo?.copyright || "";
  const rawVersion =
    appInfo?.version ||
    appInfo?.buildVersion ||
    appInfo?.shortVersion ||
    "1.0.0";
  const versionParts = String(rawVersion)
    .split(".")
    .filter(Boolean);
  while (versionParts.length < 4) versionParts.push("0");
  const fileVersion = versionParts.slice(0, 4).join(".");

  const requestedExecutionLevel =
    context.packager?.platformSpecificBuildOptions?.requestedExecutionLevel ||
    null;
  const relIcon =
    context.packager?.platformSpecificBuildOptions?.icon || "icon.ico";
  const iconPath = path.isAbsolute(relIcon)
    ? relIcon
    : path.join(projectDir, relIcon);
  const hasIcon = iconPath && fs.existsSync(iconPath);

  const versionStrings = {
    FileDescription: productName,
    ProductName: productName,
    InternalName: productName,
    OriginalFilename: path.basename(exePath),
  };
  if (companyName) versionStrings.CompanyName = companyName;
  if (copyright) versionStrings.LegalCopyright = copyright;

  await rceditFn(exePath, {
    "application-manifest": manifestPath,
    "version-string": versionStrings,
    "file-version": fileVersion,
    "product-version": fileVersion,
    ...(requestedExecutionLevel
      ? { "requested-execution-level": requestedExecutionLevel }
      : {}),
    ...(hasIcon ? { icon: iconPath } : {}),
  });
};
