"use strict";
(() => {
  let modal, content, layout, video, image, select, play, seek, time, volume, status, title;
  let current = null, returnFocus = null, revision = 0, frame = 0, previous = [], nextMove = 0;
  let saving = Promise.resolve();
  const background = new Map();
  const tr = (key, fallback) => window.i18nUi?.getString(key, fallback) || fallback;
  const isOpen = () => !!modal && !modal.classList.contains("hidden");
  const controller = window.AchievementsMainControllerNavigation.createInputSession();
  const clock = seconds => { const n = Math.max(0, Math.floor(Number(seconds) || 0)); return `${Math.floor(n/60)}:${String(n%60).padStart(2,"0")}`; };
  function release() {
    video?.pause();
    if (video?.hasAttribute("src")) { video.removeAttribute("src"); video.load(); }
    image?.removeAttribute("src");
  }
  function close() {
    revision++;
    if (!isOpen()) return;
    layout.finish(); release(); current = null;
    cancelAnimationFrame(frame); frame = 0; controller.suspend(); previous = [];
    modal.classList.add("hidden"); modal.inert = true; modal.setAttribute("aria-hidden", "true");
    for (const [element, inert] of background) if (element.isConnected) element.inert = inert;
    background.clear();
    if (returnFocus?.isConnected && !returnFocus.closest("[inert]")) returnFocus.focus({ preventScroll: true });
    returnFocus = null;
  }
  function controls() { return [...modal.querySelectorAll("button,select,input")].filter(el => !el.disabled && el.getClientRects().length); }
  function move(delta) {
    const items = controls(), at = items.indexOf(document.activeElement);
    items[(at + delta + items.length) % items.length]?.focus({ preventScroll: true });
  }
  function adjust(delta) {
    const target = document.activeElement;
    if (target === seek && !seek.disabled) { video.currentTime = Math.min(video.duration, Math.max(0, video.currentTime + delta * 5)); update(); }
    else if (target === volume) { volume.value = String(Math.min(1, Math.max(0, Number(volume.value) + delta * .1))); video.volume = Number(volume.value); }
    else if (target === select && !select.hidden) { select.selectedIndex = Math.min(select.options.length - 1, Math.max(0, select.selectedIndex + delta)); showFile(); }
    else move(delta);
  }
  function action(command) {
    if (!isOpen()) return;
    if (command === "BACK") close();
    else if (command === "CONFIRM") { if (document.activeElement === seek) toggle(); else document.activeElement?.click(); }
    else if (command === "LEFT" || command === "RIGHT") adjust(command === "LEFT" ? -1 : 1);
    else if (command === "UP" || command === "DOWN") move(command === "UP" ? -1 : 1);
  }
  function poll(now) {
    if (!isOpen()) return;
    if (!document.hasFocus() || document.visibilityState === "hidden") { controller.suspend(); previous = []; }
    else {
      const sample = controller.sample(navigator.getGamepads?.() || [], now);
      if (sample.ready && sample.pad) {
        const buttons = sample.pad.buttons.map(b => b.pressed === true);
        if (buttons[1] && !previous[1]) action("BACK");
        else if (buttons[0] && !previous[0]) action("CONFIRM");
        const direction = buttons[12] || sample.pad.axes[1] < -.4 ? "UP" : buttons[13] || sample.pad.axes[1] > .4 ? "DOWN" :
          buttons[14] || sample.pad.axes[0] < -.4 ? "LEFT" : buttons[15] || sample.pad.axes[0] > .4 ? "RIGHT" : "";
        if (direction && now >= nextMove) { action(direction); nextMove = now + 180; }
        if (!direction) nextMove = 0;
        previous = buttons;
      } else previous = [];
    }
    if (isOpen()) frame = requestAnimationFrame(poll);
  }
  function update() {
    if (!current || current.kind !== "record") return;
    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    seek.disabled = !duration; seek.max = String(duration || 1); seek.value = String(video.currentTime || 0);
    time.textContent = `${clock(video.currentTime)} / ${clock(duration)}`;
    play.textContent = tr(video.paused ? "achievementMedia.play" : "achievementMedia.pause", video.paused ? "Play" : "Pause");
  }
  function toggle() { if (!current || current.kind !== "record" || !video.hasAttribute("src")) return; if (video.paused) video.play().catch(failed); else video.pause(); }
  function failed() {
    status.textContent = tr("achievementMedia.unavailable", "This saved file is unavailable or cannot be played.");
    void window.api.logUiEvent("warn", "achievement-media:load-failed", {
      configName: current?.configName, achievementId: current?.achievementId,
      kind: current?.kind, filename: current?.files?.[select.selectedIndex]?.filename,
      mediaErrorCode: current?.kind === "record" ? video.error?.code : null,
    }).catch(() => {});
  }
  function showFile() {
    release(); status.textContent = "";
    const file = current?.files[select.selectedIndex];
    if (!file || !/^file:\/\//i.test(file.url)) { failed(); return; }
    const record = current.kind === "record";
    video.hidden = !record; image.hidden = record;
    modal.querySelector(".achievement-media-player-controls").hidden = !record;
    modal.querySelector(".achievement-media-caption").textContent = file.filename;
    if (record) { video.src = file.url; video.volume = Number(volume.value); update(); }
    else { image.alt = file.filename; image.src = file.url; }
  }
  function create() {
    modal = document.createElement("div"); modal.id = "achievementMediaModal"; modal.className = "modal hidden"; modal.inert = true;
    modal.setAttribute("role", "dialog"); modal.setAttribute("aria-modal", "true"); modal.setAttribute("aria-labelledby", "achievementMediaTitle");
    modal.innerHTML = `<section class="modal-content achievement-media-content"><header><h3 id="achievementMediaTitle"></h3><button type="button" class="settings-close-button" id="achievementMediaClose">×</button></header>
      <select id="achievementMediaFiles"></select><div class="achievement-media-stage"><img hidden><video hidden preload="metadata" playsinline></video></div>
      <div class="achievement-media-player-controls"><button type="button" id="achievementMediaPlay"></button><input id="achievementMediaSeek" type="range" min="0" max="1" step="0.01" value="0"><output id="achievementMediaTime">0:00 / 0:00</output><input id="achievementMediaVolume" type="range" min="0" max="1" step="0.05" value="1"></div>
      <footer><span class="achievement-media-caption"></span><span id="achievementMediaStatus" role="status"></span></footer></section>`;
    content = modal.querySelector("section"); video = modal.querySelector("video"); image = modal.querySelector("img");
    title = modal.querySelector("h3"); select = modal.querySelector("select"); play = modal.querySelector("#achievementMediaPlay"); seek = modal.querySelector("#achievementMediaSeek");
    time = modal.querySelector("output"); volume = modal.querySelector("#achievementMediaVolume"); status = modal.querySelector("#achievementMediaStatus");
    const handles = ["nw","ne","sw","se"].map(direction => { const el = document.createElement("div"); el.className = `settings-resize-handle settings-resize-handle--${direction}`; el.dataset.modalResize = direction; el.setAttribute("aria-hidden","true"); content.append(el); return el; });
    document.body.append(modal);
    layout = window.AchievementsModalLayout.create({ overlay: modal, content, handles, defaultWidth: 1100, defaultHeight: 760, minWidth: 360, minHeight: 300, isVisible: isOpen,
      onSave: size => { saving = saving.then(() => window.api.savePreferences({ achievementMediaModalSize: size })).catch(console.warn); } });
    modal.querySelector("#achievementMediaClose").onclick = close; select.onchange = showFile; play.onclick = toggle;
    seek.oninput = () => { if (Number.isFinite(video.duration)) video.currentTime = Number(seek.value); update(); };
    volume.oninput = () => { video.volume = Number(volume.value); };
    for (const event of ["loadedmetadata","durationchange","timeupdate","play","pause","ended"]) video.addEventListener(event, update);
    image.onerror = failed; video.onerror = failed;
    for (const event of ["pointerdown","wheel","keydown"]) modal.addEventListener(event, () => { controller.noteManualInput(); previous = []; }, { capture:true, passive:true });
    modal.addEventListener("pointerdown", event => { if (event.target === modal) close(); });
  }
  async function open(payload) {
    const ticket = ++revision;
    if (!payload?.files?.length) return;
    if (!modal) create();
    await saving;
    const prefs = await window.api.loadPreferences().catch(() => ({}));
    if (ticket !== revision) return;
    if (!isOpen()) {
      returnFocus = document.activeElement;
      if (!returnFocus?.getClientRects?.().length) {
        const sameConfig = document.getElementById("configList")?.value === payload.configName;
        returnFocus = sameConfig ? [...document.querySelectorAll("tr[data-achievement-name]")].find(row => row.dataset.achievementName === String(payload.achievementId)) : null;
        returnFocus ||= document.getElementById("configList");
      }
      for (const el of [...document.body.children, document.getElementById("settingsBtn")]) {
        if (!(el instanceof HTMLElement) || el === modal || el.id === "titlebar") continue;
        background.set(el, el.inert); el.inert = true;
      }
    }
    release(); current = payload;
    title.textContent = payload.configName;
    select.replaceChildren(...payload.files.map(file => { const option = document.createElement("option"); option.textContent = file.filename; return option; }));
    select.selectedIndex = 0; select.hidden = payload.files.length < 2;
    modal.inert = false; modal.classList.remove("hidden"); modal.setAttribute("aria-hidden","false");
    refresh(); layout.apply(prefs?.achievementMediaModalSize); showFile();
    modal.querySelector("#achievementMediaClose").focus({ preventScroll:true });
    controller.suspend(); previous = []; nextMove = 0; cancelAnimationFrame(frame); frame = requestAnimationFrame(poll);
  }
  function refresh() {
    if (!modal) return;
    for (const [el,key,fallback] of [[select,"achievementMedia.versions","Saved files"],[seek,"achievementMedia.seek","Playback position"],[volume,"achievementMedia.volume","Volume"],[modal.querySelector("#achievementMediaClose"),"achievementMedia.close","Close"]]) {
      el.setAttribute("aria-label",tr(key,fallback)); el.title = tr(key,fallback);
    }
    update();
  }
  document.addEventListener("keydown", event => {
    if (!isOpen()) return;
    if (event.key === "Escape") close();
    else if (event.key === "Tab") move(event.shiftKey ? -1 : 1);
    else if (event.code === "Space" && event.target === content.querySelector("#achievementMediaClose")) return;
    else if (event.code === "Space" && event.target !== select) toggle();
    else if (["ArrowLeft","ArrowRight"].includes(event.key) && event.target !== select) adjust(event.key === "ArrowLeft" ? -1 : 1);
    else return;
    event.preventDefault(); event.stopImmediatePropagation();
  }, true);
  window.addEventListener("beforeunload", () => { release(); cancelAnimationFrame(frame); });
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") video?.pause(); });
  window.AchievementMediaViewer = { open, close, isOpen, action, refresh };
  window.api.onAchievementMedia(payload => {
    void open(payload).catch(error => {
      console.warn("achievement-media:viewer-failed", error);
      void window.api.logUiEvent("warn", "achievement-media:viewer-failed", {
        configName: payload?.configName, achievementId: payload?.achievementId,
        kind: payload?.kind, error: error?.message || String(error),
      }).catch(() => {});
    });
  });
  window.api.achievementMediaReady();
})();
