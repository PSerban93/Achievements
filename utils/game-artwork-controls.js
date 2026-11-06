"use strict";

(() => {
  const element = (tag, cls, text) => { const el = document.createElement(tag); if (cls) el.className = cls; if (text != null) el.textContent = text; return el; };
  const text = (key, fallback) => window.i18nUi?.getString(key, fallback) || fallback;
  const labels = () => ({ cover: text("artwork.cover", "Cover / Portrait"), header: text("artwork.header", "Header / Landscape"), hero: text("artwork.hero", "Hero / Background"), all: text("artwork.all", "All game images") });
  const modal = element("dialog", "game-artwork-modal"); modal.id = "gameArtworkModal"; modal.setAttribute("aria-labelledby", "gameArtworkTitle");
  const header = element("header", "game-artwork-heading"), heading = element("div"), title = element("h3", "", text("artwork.title", "Redownload Images")); title.id = "gameArtworkTitle";
  const game = element("p", "hint"), close = element("button", "settings-close-button", "×"); close.type = "button"; close.setAttribute("aria-label", text("achievementMedia.close", "Close"));
  heading.append(title, game); header.append(heading, close);
  const types = element("div", "game-artwork-types"), hint = element("p", "hint"), sources = element("div", "game-artwork-sources"), status = element("div", "game-artwork-status");
  status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite");
  modal.append(header, types, hint, sources, status); document.body.append(modal);
  let revision = 0, configName = "", type = "cover", busy = false, back = null, identity = {}, sourceLabels = new Map();
  const controls = () => [...modal.querySelectorAll("button:not(:disabled)")];
  function closeModal() {
    revision++; modal.close(); busy = false;
    if (back?.isConnected && back.getClientRects().length) back.focus({ preventScroll: true });
    else document.querySelector(`[data-artwork-type="${type}"][data-artwork-config="${CSS.escape(configName)}"]`)?.focus({ preventScroll: true });
  }
  close.addEventListener("click", closeModal);
  modal.addEventListener("cancel", event => { event.preventDefault(); closeModal(); });
  function setBusy(value) { busy = value; modal.setAttribute("aria-busy", String(value)); for (const button of modal.querySelectorAll("button")) if (button !== close) button.disabled = value; }
  async function download(source) {
    if (busy) return;
    const ticket = revision, selectedName = configName, selectedType = type;
    setBusy(true); status.replaceChildren(element("p", "", text("artwork.downloading", "Downloading images…")));
    try {
      const response = await window.api.downloadGameArtwork({ configName: selectedName, type: selectedType, source: source.id, ...identity });
      if (ticket !== revision || !modal.open) return;
      status.replaceChildren();
      for (const result of response.results || []) {
        const message = result.ok ? text("artwork.saved", "Saved") : result.code === "source-unsupported" ? text("artwork.unsupported", "Not supported by this source") : result.code === "custom-image-active" ? text("artwork.custom", "A custom image is active. Clear it before redownloading.") : result.code === "superseded" ? text("artwork.superseded", "Replaced by a newer request") : text("artwork.failed", "Download failed; the previous image was kept.");
        const row = element("p", result.ok ? "is-success" : result.skipped ? "" : "is-error");
        row.textContent = `${labels()[result.type]} — ${message}${result.source ? ` (${sourceLabels.get(result.source) || result.source})` : ""}`;
        if (result.error) row.title = result.error; status.append(row);
      }
    } catch (error) {
      if (ticket === revision && modal.open) status.replaceChildren(element("p", "is-error", error.message));
    } finally { if (ticket === revision && modal.open) setBusy(false); }
  }
  async function loadSources(ticket) {
    sources.replaceChildren(element("p", "hint", text("artwork.loading", "Loading sources…")));
    try {
      const response = await window.api.getGameArtworkSources({ configName, type });
      if (ticket !== revision || !modal.open) return;
      identity = { appid: response.appid, platform: response.platform }; game.textContent = response.title || configName;
      const choices = [{ id: "automatic", label: text("artwork.automatic", "Automatic"), types: ["cover", "header", "hero"] }, ...(response.sources || [])];
      sources.replaceChildren();
      for (const source of choices) {
        if (source.id === "metadata") source.label = text("artwork.sourceMetadata", source.label);
        sourceLabels.set(source.id, source.label);
        const button = element("button", "game-artwork-source"); button.type = "button"; button.dataset.artworkSource = source.id;
        button.append(element("strong", "", source.label));
        if (type === "all") button.append(element("small", "hint", source.types.map(kind => labels()[kind]).join(" · ")));
        button.addEventListener("click", () => void download(source)); sources.append(button);
      }
      hint.textContent = text("artwork.help", "Automatic tries eligible sources in order. Choosing a source uses only that source. Existing images are kept if downloading fails.");
      sources.querySelector("button")?.focus({ preventScroll: true });
    } catch (error) { if (ticket === revision) sources.replaceChildren(element("p", "is-error", error.message)); }
  }
  async function open(name, kind = "cover", trigger = document.activeElement) {
    if (!name || !labels()[kind]) return;
    const ticket = ++revision; configName = name; type = kind; back = trigger; busy = false; identity = {}; sourceLabels = new Map();
    title.textContent = text("artwork.title", "Redownload Images"); close.setAttribute("aria-label", text("achievementMedia.close", "Close"));
    status.replaceChildren(); types.replaceChildren();
    for (const [value, label] of Object.entries(labels())) {
      const button = element("button", "", label); button.type = "button"; button.setAttribute("aria-pressed", String(type === value));
      button.addEventListener("click", () => { if (!busy) void open(configName, value, back); }); types.append(button);
    }
    modal.inert = false; modal.removeAttribute("aria-hidden");
    if (!modal.open) modal.showModal();
    await loadSources(ticket);
  }
  function action(command) {
    if (!modal.open) return false;
    if (["BACK", "CLOSE"].includes(command)) { closeModal(); return true; }
    const list = controls(), current = list.indexOf(document.activeElement);
    if (["UP", "LEFT", "DOWN", "RIGHT"].includes(command)) { list[(current + (command === "UP" || command === "LEFT" ? -1 : 1) + list.length) % list.length]?.focus({ preventScroll: true }); document.activeElement?.scrollIntoView({ block: "nearest" }); }
    if (command === "CONFIRM") document.activeElement?.closest("button")?.click();
    return true;
  }
  document.addEventListener("keydown", event => {
    if (!modal.open) return;
    if (event.key === "Escape") { closeModal(); event.preventDefault(); }
    else if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) { action({ ArrowUp: "UP", ArrowDown: "DOWN", ArrowLeft: "LEFT", ArrowRight: "RIGHT" }[event.key]); event.preventDefault(); }
    else if (event.key === "Enter" || event.key === " ") { action("CONFIRM"); event.preventDefault(); }
    event.stopImmediatePropagation();
  }, true);
  window.GameArtworkControls = { open, close: closeModal, action, isOpen: () => modal.open };
})();
