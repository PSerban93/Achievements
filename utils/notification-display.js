"use strict";
const path = require("path");
const fs = require("fs");
const { execFile } = require("child_process");

function resolveScreenshotHelper() {
  const root = __dirname.replace(/app\.asar(?=[\\/]|$)/i, "app.asar.unpacked");
  return [path.join(root, "native", "achievements-hdr-screenshot.exe"),
    process.resourcesPath && path.join(process.resourcesPath, "app.asar.unpacked", "utils", "native", "achievements-hdr-screenshot.exe")]
    .find(file => file && fs.existsSync(file)) || "";
}

function listNativeDisplays() {
  return new Promise((resolve, reject) => {
    const helper = resolveScreenshotHelper();
    if (!helper) return reject(new Error("Screenshot helper is missing"));
    execFile(helper, ["--list-monitors"], { windowsHide: true, timeout: 5000, maxBuffer: 256 * 1024 }, (error, stdout) => {
      if (error) return reject(error);
      try {
        const value = JSON.parse(stdout);
        if (!Array.isArray(value) || !value.length || value.some(d => !d.id || !d.bounds)) throw new Error("Invalid monitor inventory");
        resolve(value);
      } catch (error) { reject(error); }
    });
  });
}

function sameBounds(a, b) {
  return a && b && ["x", "y", "width", "height"].every(key => Math.abs(a[key] - b[key]) <= 1);
}

function captureIdForDisplay(display, platform) {
  if (platform !== "win32" || !display.id.startsWith("electron:")) return display.id;
  const b = display.bounds;
  return `bounds:${b.x},${b.y},${b.width},${b.height}`;
}

class NotificationDisplayService {
  constructor({ screen, platform = process.platform, enumerate = listNativeDisplays, getPreference, changed = () => {}, failed = () => {} }) {
    Object.assign(this, { screen, platform, enumerate, getPreference, changed, failed });
    this.displays = [];
    this.revision = 0;
  }
  physicalBounds(display) {
    return this.screen.dipToScreenRect ? this.screen.dipToScreenRect(null, display.bounds) : display.bounds;
  }
  async refresh() {
    const revision = ++this.revision;
    const electronDisplays = this.screen.getAllDisplays();
    let native = null;
    try { if (this.platform === "win32") native = await this.enumerate(); }
    catch (error) { this.failed(error); }
    if (revision !== this.revision) return this.payload();
    // Bounds bridge Electron DIP coordinates to the native physical desktop.
    // Persist hardware paths, never a transient enumeration index or label.
    const knownNative = native || this.displays.filter(d => !d.id.startsWith("electron:"));
    const primaryId = this.screen.getPrimaryDisplay().id;
    this.displays = this.platform === "win32" ? knownNative.map(item => {
      const display = electronDisplays.find(d => sameBounds(this.physicalBounds(d), item.bounds));
      return display ? { ...item, display, primary: display.id === primaryId } : null;
    }).filter(Boolean) : [];
    // Inventory may fail or cover only part of the desktop. Keep every live
    // display available, with an explicit physical target for native capture.
    for (const display of electronDisplays) {
      if (!this.displays.some(item => item.display.id === display.id)) this.displays.push(this.fallbackDisplay(display));
    }
    this.changed(this.payload());
    return this.payload();
  }
  resolve(preference = this.getPreference()) {
    const currentDisplays = this.screen.getAllDisplays();
    const availableIds = new Set(currentDisplays.map(d => String(d.id)));
    const available = this.displays.filter(d => availableIds.has(String(d.display.id)));
    const selected = preference ? available.find(d => d.id === preference || `electron:${d.display.id}` === preference) : available.find(d => d.primary);
    const target = selected || (preference ? available[0] || this.fallbackDisplay(currentDisplays[0] || this.screen.getPrimaryDisplay())
      : this.fallbackDisplay(this.screen.getPrimaryDisplay()));
    return { ...target, captureId: captureIdForDisplay(target, this.platform) };
  }
  fallbackDisplay(display) {
    return { id: `electron:${display.id}`, display, bounds: this.physicalBounds(display), label: display.label || "", primary: display.id === this.screen.getPrimaryDisplay().id };
  }
  payload() {
    return { preferredId: this.getPreference() || "", activeId: this.resolve().id,
      displays: this.displays.map(({ display, ...item }) => ({ ...item,
        id: this.getPreference() === `electron:${display.id}` ? this.getPreference() : item.id,
        displayId: String(display.id) })) };
  }
}
module.exports = { NotificationDisplayService, listNativeDisplays, sameBounds };
