"use strict";

window.AchievementEnablerView = { async mount(root, { enabler, onClose, isVisible }) {
const byId = id => root.getElementById(id);
const t = key => window.i18nUi.getString(`enabler.${key}`, key);
let state = null, ready = false, lastRun = "", lastSequence = 0, pendingAcknowledgement = null;
let pendingAction = "";
const exclusiveActions = new Set(["download", "check", "acknowledge", "choose-game", "start"]);
const queued = [];
const terminal = new Terminal({ cols: 100, rows: 25, scrollback: 1500, fontFamily: "Consolas, monospace", fontSize: 13,
  cursorBlink: true, theme: { background: "#101923", foreground: "#e0eaf4" } });
terminal.open(byId("terminal"));
const fit = new FitAddon.FitAddon(); terminal.loadAddon(fit);
function fitTerminal() { if (byId("details").open && byId("terminal").clientWidth && byId("terminal").clientHeight) fit.fit(); }
const resizeObserver = new ResizeObserver(fitTerminal); resizeObserver.observe(byId("terminal"));
byId("details").addEventListener("toggle", fitTerminal);
function showError(error) {
  byId("error").textContent = `${t("error")}: ${error?.message || error}`;
  byId("error").hidden = false;
}
function currentOutput() {
  if (!isVisible()) return;
  const buffer = terminal.buffer.active, lines = [];
  for (let i = 0; i < buffer.length; i++) {
    const row = buffer.getLine(i), line = row?.translateToString(true) || "";
    if (row?.isWrapped && lines.length) lines[lines.length - 1] += line;
    else lines.push(line);
  }
  const output = byId("currentOutput");
  const atBottom = output.scrollTop + output.clientHeight >= output.scrollHeight - 8;
  const previousScroll = output.scrollTop;
  output.textContent = lines.join("\n").trimEnd();
  output.scrollTop = atBottom ? output.scrollHeight : previousScroll;
}
function applyState(next) {
  state = next;
  if (next.run.runId !== lastRun) {
    lastRun = next.run.runId; lastSequence = 0; terminal.reset(); byId("currentOutput").textContent = ""; byId("answer").value = "";
  }
  const active = ["preparing", "running", "auxiliary"].includes(next.run.status);
  const busy = active || next.downloading || next.operation || !!pendingAction;
  const version = next.installed ? next.version : next.latest;
  byId("version").textContent = version || "";
  byId("version").hidden = !version;
  byId("version").title = version ? `${t(next.installed ? "installed" : "available")}: ${version}` : "";
  byId("download").hidden = next.installed && (!next.latest || next.latest === next.version);
  byId("download").textContent = t(next.installed ? "update" : "download");
  byId("download").disabled = busy || !next.supported;
  byId("check").disabled = busy;
  byId("files").disabled = !next.installed;
  byId("acknowledge").disabled = !next.installed || busy;
  byId("acknowledge").checked = pendingAcknowledgement ?? next.adaptersAcknowledged;
  byId("choose").disabled = busy || !next.supported;
  byId("start").disabled = busy || !next.supported || !next.installed || !next.adaptersAcknowledged || !next.gameFolder;
  byId("stop").disabled = !active && !next.downloading;
  byId("gameFolder").textContent = next.gameFolder || "";
  byId("gameFolder").title = next.gameFolder || "";
  byId("updateInfo").textContent = next.latest && next.latest !== next.version ? `${t("available")}: ${next.latest}` : next.installed ? t("installed") : "";
  byId("downloadProgress").hidden = !next.downloading;
  byId("downloadStep").dataset.complete = String(next.installed);
  byId("adapterStep").dataset.complete = String(next.adaptersAcknowledged);
  byId("status").textContent = !next.supported ? t("unsupported") : t(next.downloading ? "downloading" : next.run.status);
  root.querySelector(".ae-session").dataset.result = next.run.status;
  const knownReasons = new Set(["gseTools", "credentials", "requirements", "download", "write", "adapter"]);
  byId("resultReason").hidden = !knownReasons.has(next.run.resultReason);
  byId("resultReason").textContent = knownReasons.has(next.run.resultReason) ? t(`reason.${next.run.resultReason}`) : "";
  root.querySelector(".ae-session").setAttribute("aria-busy", String(active));
  for (const element of root.querySelectorAll("#answerForm input,#answerForm button,[data-key]")) element.disabled = next.run.status !== "running";
  if (next.run.error) showError(next.run.error);
}
async function action(name, payload) {
  const exclusive = exclusiveActions.has(name);
  if (exclusive && pendingAction) return null;
  if (exclusive) { pendingAction = name; if (state) applyState(state); }
  byId("error").hidden = true;
  try {
    const result = await enabler.command(name, payload);
    if (result && typeof result === "object" && result.run) applyState(result);
    return result;
  } catch (error) { showError(error); return null; }
  finally { if (exclusive) { pendingAction = ""; if (state) applyState(state); } }
}
function event(message) {
  if (!ready) { queued.push(message); return; }
  if (message.type === "state") applyState(message.payload);
  if (message.type === "error") showError(message.payload.error);
  if (message.type === "download") {
    const { received, total } = message.payload;
    byId("downloadProgress").hidden = false;
    if (total > 0) byId("downloadProgress").value = Math.min(100, received / total * 100);
    else byId("downloadProgress").removeAttribute("value");
  }
  if (message.type === "output") {
    const payload = message.payload;
    if (payload.runId !== lastRun || payload.sequence <= lastSequence) return;
    lastSequence = payload.sequence;
    terminal.write(payload.data, currentOutput);
  }
}
const unsubscribe = enabler.subscribe(event);
for (const [id, name] of Object.entries({ download: "download", check: "check", files: "open-folder", instructions: "instructions", reportIssue: "report-issue", choose: "choose-game", start: "start", stop: "stop" })) {
  byId(id).addEventListener("click", () => void action(name));
}
byId("acknowledge").addEventListener("change", async event => {
  pendingAcknowledgement = event.target.checked;
  event.target.disabled = true;
  await action("acknowledge", { checked: pendingAcknowledgement });
  pendingAcknowledgement = null;
  if (state) applyState(state);
});
byId("hideAnswer").addEventListener("change", event => { byId("answer").type = event.target.checked ? "password" : "text"; });
async function input(text, raw = false) {
  if (state?.run.status !== "running") return false;
  return await action("input", { runId: state.run.runId, text, raw }) === true;
}
let sendingAnswer = false;
async function sendAnswer(enter) {
  if (sendingAnswer || state?.run.status !== "running") return;
  sendingAnswer = true;
  const field = byId("answer"), text = field.value;
  try {
    if (await input(enter ? `${text}\r` : text || " ")) {
      if (field.value === text) field.value = "";
    }
  } finally { sendingAnswer = false; }
}
byId("answerForm").addEventListener("submit", event => {
  event.preventDefault(); void sendAnswer(true);
});
byId("sendKey").addEventListener("click", () => void sendAnswer(false));
for (const button of root.querySelectorAll("[data-key]")) button.addEventListener("click", () => void input(button.dataset.key === "enter" ? "\r" : button.dataset.key));
terminal.onData(data => void input(data, true));
terminal.onResize(({ cols, rows }) => { if (state?.run.status === "running") void enabler.command("resize", { runId: state.run.runId, cols, rows }).catch(showError); });
byId("closePanel").addEventListener("click", onClose);
root.addEventListener("keydown", event => {
  if (event.isComposing) { event.stopPropagation(); return; }
  if (event.repeat && event.key === "Enter" && !byId("terminal").contains(root.activeElement)) event.preventDefault();
  if (event.key === "Escape" && !byId("terminal").contains(root.activeElement)) {
    event.preventDefault(); onClose();
  }
  if (event.key === "Tab") {
    const items = [...root.querySelectorAll('button,input,summary,textarea,[tabindex]')].filter(isFocusable);
    const first = items[0], last = items[items.length - 1];
    if (items.length && (!root.activeElement || (event.shiftKey ? root.activeElement === first : root.activeElement === last))) {
      event.preventDefault();
      const target = event.shiftKey ? last : first;
      target.focus({ preventScroll: true }); target.scrollIntoView({ block: "nearest" });
    }
  }
  event.stopPropagation();
});

// The embedded panel owns input only while visible.
const controller = window.AchievementsMainControllerNavigation.createInputSession();
let previous = [], nextMove = 0, animationFrame = 0;
function isFocusable(el) {
  if (el.disabled || el.tabIndex < 0 || !el.getClientRects().length) return false;
  const closedDetails = el.closest("details:not([open])");
  return !closedDetails || closedDetails.querySelector("summary")?.contains(el);
}
const focusables = () => [...root.querySelectorAll("button,input,summary")].filter(el => isFocusable(el) && !el.closest(".xterm"));
for (const type of ["pointerdown", "wheel", "keydown"]) root.addEventListener(type, event => { if (event.isTrusted) { controller.noteManualInput(); previous = []; } }, { capture: true, passive: true });
function moveFocus(direction) {
  const items = focusables(); if (!items.length) return;
  const index = items.indexOf(root.activeElement);
  const target = items[index < 0 ? direction < 0 ? items.length - 1 : 0 : (index + direction + items.length) % items.length];
  target.focus({ preventScroll: true }); target.scrollIntoView({ block: "nearest" });
}
function pollController(now) {
  animationFrame = 0;
  if (!isVisible()) return;
  if (!document.hasFocus() || document.visibilityState === "hidden") { controller.suspend(); previous = []; animationFrame = requestAnimationFrame(pollController); return; }
  const sample = controller.sample(navigator.getGamepads?.() || [], now);
  if (sample.ready) {
    const buttons = sample.pad.buttons.map(button => button.pressed);
    if (buttons[1] && !previous[1]) onClose();
    else if (buttons[0] && !previous[0]) root.activeElement?.click();
    if (!isVisible()) return;
    const direction = buttons[12] || sample.pad.axes[1] < -.4 ? -1 : buttons[13] || sample.pad.axes[1] > .4 ? 1 : 0;
    if (direction && now >= nextMove) { moveFocus(direction); nextMove = now + 180; }
    if (!direction) nextMove = 0;
    root.querySelector("main").scrollTop += window.AchievementsMainControllerNavigation.scrollDelta(sample.pad.axes[3], sample.elapsedSeconds);
    previous = buttons;
  } else previous = [];
  animationFrame = requestAnimationFrame(pollController);
}

function refreshAppearance() {
  for (const [selector, attribute] of [["[data-i18n]", null], ["[data-i18n-aria-label]", "aria-label"], ["[data-i18n-title]", "title"]]) {
    for (const el of root.querySelectorAll(selector)) {
      const key = el.getAttribute(attribute ? "data-i18n-" + attribute : "data-i18n");
      const value = window.i18nUi.getString(key, el.textContent);
      if (attribute) el.setAttribute(attribute, value); else el.textContent = value;
    }
  }
  byId("answer").placeholder = t("answer");
  const style = getComputedStyle(root.host);
  terminal.options.theme = { background: style.getPropertyValue("--app-input-bg").trim() || "#101923",
    foreground: style.getPropertyValue("--app-text").trim() || "#e0eaf4",
    cursor: style.getPropertyValue("--app-accent").trim() || "#82d9f1" };
  if (state) applyState(state);
}
const themeObserver = new MutationObserver(refreshAppearance);
for (const element of [document.documentElement, document.body]) themeObserver.observe(element, { attributes: true, attributeFilter: ["class", "style", "data-theme", "data-app-theme-id", "lang"] });

try {
  const bootstrap = await enabler.command("bootstrap");
  refreshAppearance();
  byId("answer").placeholder = t("answer");
  applyState(bootstrap.state);
  lastSequence = bootstrap.outputSequence;
  terminal.write(bootstrap.transcript || "", currentOutput);
  ready = true;
  for (const message of queued.splice(0)) event(message);
  if (!state.downloading && !["preparing", "running", "auxiliary"].includes(state.run.status)) void action("check");
  animationFrame = requestAnimationFrame(pollController);
  return { refreshAppearance, suspend() { controller.suspend(); previous = []; cancelAnimationFrame(animationFrame); animationFrame = 0; },
    focus() { refreshAppearance(); fitTerminal(); currentOutput(); byId("closePanel").focus({ preventScroll: true }); if (!animationFrame) animationFrame = requestAnimationFrame(pollController); },
    destroy() { unsubscribe(); cancelAnimationFrame(animationFrame); resizeObserver.disconnect(); themeObserver.disconnect(); terminal.dispose(); } };
} catch (error) { unsubscribe(); resizeObserver.disconnect(); themeObserver.disconnect(); terminal.dispose(); throw error; }
} };
