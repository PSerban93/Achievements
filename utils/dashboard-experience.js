"use strict";

(() => {
  const panel = document.getElementById("dashboardPanel"), body = document.getElementById("dashboardBody"), grid = document.getElementById("dashboardGrid");
  if (!panel || !body || !grid) return;
  const spec = window.DashboardExperienceSettings, root = document.documentElement;
  let preferences = spec.normalize(), revision = 0, saves = Promise.resolve(), frame = 0, timer = 0, gamepadId = "", backgroundSource = "", imageSequence = 0;
  let detailState = { open: false }, backgroundSequence = 0, backgroundTimer = 0, backdropIndex = 0;
  let followTimer = 0;
  let hoverCard = null, pointerPosition = null;
  let lastPreviewName = "", appliedPersistent = false, pointerFocusCard = null;
  let appliedPreviewSize = "";
  const cancelFollow = () => { clearTimeout(followTimer); followTimer = 0; };
  const artworkCache = new Map();
  const imageVersions = new WeakMap();
  const settingsControls = new Map(), pending = new Set(), drafts = new Set();
  const text = (key, fallback) => window.i18nUi?.getString(key, fallback) || fallback;
  const element = (tag, className, value) => { const e = document.createElement(tag); if (className) e.className = className; if (value != null) e.textContent = value; return e; };
  const button = (value, action, cls = "") => { const e = element("button", cls, value); e.type = "button"; e.addEventListener("click", action); return e; };
  const cardFor = name => [...grid.querySelectorAll(".dash-card")].find(card => card.dataset.name === name);
  function openConfig(name) {
    const select = document.getElementById("configList");
    if (!select || ![...select.options].some(option => option.value === name && !option.disabled)) return;
    window.closeDashboard?.(); select.value = name; select.dispatchEvent(new Event("change", { bubbles: true }));
  }
  function play(name) {
    const cardButton = cardFor(name)?.querySelector(".dash-play:not(.is-disabled)");
    // Preserve the existing Dashboard launch pipeline and disabled rules.
    if (cardButton) { details.close(); cardButton.click(); }
  }
  const details = window.DashboardDetailView.create({ panel, getCard: cardFor, text, openConfig, play,
    isPersistent: () => preferences.dashboardPreviewEnabled && preferences.dashboardPreviewAlwaysVisible,
    getSize: () => preferences.dashboardPreviewSize,
    onSizeSave: size => void save({ dashboardPreviewSize: size }),
    onChange(state) {
      detailState = state;
      if (state.open) {
        lastPreviewName = state.name;
        clearTimeout(backgroundTimer); backgroundSequence++;
        if (state.artwork) { artworkCache.set(state.name, state.artwork); void updateBackground(state.artwork.hero); }
        else void updateBackground(null);
        if (state.artwork && state.name === mainBackgroundName) void updateMainBackground();
      } else { cancelFollow(); previewTarget(cardFor(document.activeElement?.closest?.(".dash-card")?.dataset.name || state.name)); }
      refreshHints();
    },
  });
  const backdrops = [0, 1].map(() => { const el = element("div", "dashboard-context-backdrop"); el.setAttribute("aria-hidden", "true"); panel.prepend(el); return el; });
  const mainScroll = document.getElementById("mainScroll");
  const mainBackdrops = [0, 1].map(() => { const el = element("div", "main-config-backdrop"); el.setAttribute("aria-hidden", "true"); mainScroll?.prepend(el); return el; });
  let mainBackgroundSequence = 0, mainBackgroundName = "", mainBackgroundSource = "", mainBackdropIndex = 0;
  function clearMainBackground() {
    mainBackgroundSequence++; mainBackgroundSource = "";
    mainBackdrops.forEach(el => { el.classList.remove("is-visible"); el.style.removeProperty("background-image"); });
  }
  async function updateMainBackground(name = mainBackgroundName) {
    mainBackgroundName = name;
    const ticket = ++mainBackgroundSequence;
    if (!preferences.dashboardContextBackground || !name) { clearMainBackground(); return; }
    // A pending selection must not leave the previous game's background visible.
    mainBackdrops.forEach(el => el.classList.remove("is-visible"));
    try {
      const artwork = await window.api.getDashboardArtwork(name);
      if (ticket !== mainBackgroundSequence || !preferences.dashboardContextBackground || document.getElementById("configList")?.value !== name) return;
      const src = artwork?.hero?.url || "";
      if (!src) { clearMainBackground(); return; }
      const image = new Image(); image.src = src; await image.decode();
      if (ticket !== mainBackgroundSequence || !preferences.dashboardContextBackground || document.getElementById("configList")?.value !== name) return;
      mainBackgroundSource = src; mainBackdropIndex = 1 - mainBackdropIndex;
      mainBackdrops[mainBackdropIndex].style.backgroundImage = `url(${JSON.stringify(src)})`;
      mainBackdrops[mainBackdropIndex].dataset.configName = name;
      mainBackdrops.forEach((el, i) => el.classList.toggle("is-visible", i === mainBackdropIndex));
    } catch (error) { if (ticket === mainBackgroundSequence) clearMainBackground(); console.warn("dashboard:main-background-failed", error); }
  }
  window.addEventListener("main:config-visual", event => void updateMainBackground(event.detail || ""));
  document.getElementById("configList")?.addEventListener("change", () => {
    const selected = document.getElementById("configList")?.value || "";
    if (selected === mainBackgroundName) return;
    mainBackgroundName = selected; clearMainBackground();
    if (selected) void updateMainBackground(selected);
  });
  const shelfHost = element("div", "dashboard-home-sections"); shelfHost.hidden = true; body.prepend(shelfHost);
  // Persist a disclosure change before the next animation frame can rebuild it.
  // The native toggle event is queued later and may target an already removed section.
  new MutationObserver(records => {
    let collapsed = [...preferences.dashboardCollapsedSections], changed = false;
    for (const section of new Set(records.map(record => record.target))) {
      const key = section.dataset.section;
      if (!key || !section.isConnected || !shelfHost.contains(section) || collapsed.includes(key) === !section.open) continue;
      collapsed = section.open ? collapsed.filter(value => value !== key) : [...collapsed, key]; changed = true;
    }
    if (changed) void save({ dashboardCollapsedSections: collapsed });
  }).observe(shelfHost, { subtree: true, attributes: true, attributeFilter: ["open"] });
  const hints = element("footer", "dashboard-controller-hints"); hints.hidden = true; panel.append(hints);
  function updateHintInset() {
    const value = `${preferences.dashboardControllerHints ? hints.offsetHeight + 10 : 10}px`;
    if (panel.style.getPropertyValue("--dashboard-details-bottom") !== value) {
      panel.style.setProperty("--dashboard-details-bottom", value); details.updateLayout();
    }
  }
  new ResizeObserver(updateHintInset).observe(hints);
  const settings = element("details", "settings-section settings-disclosure dashboard-appearance-settings");
  settings.id = "dashboardAppearanceSection";
  const summary = element("summary", "", "Dashboard appearance"); summary.dataset.i18n = "dashboard.ui.appearance"; settings.append(summary);
  const separator = element("hr"); separator.style.margin = "18px 0 14px";
  document.getElementById("settings-renderingSection")?.after(separator, settings);
  const density = element("div", "dashboard-appearance-density");
  const sectionLimits = element("div", "dashboard-section-limits");
  const sectionLimitsTitle = element("h5", "", text("dashboard.ui.sectionLimits", "Games per Dashboard section")); sectionLimitsTitle.dataset.i18n = "dashboard.ui.sectionLimits";
  const sectionLimitsControls = element("div", "dashboard-appearance-density");
  sectionLimits.append(sectionLimitsTitle, sectionLimitsControls); document.getElementById("settings-renderingSection")?.append(sectionLimits);
  const layout = window.DashboardGridLayout.create(panel);
  let densityToggle;
  for (const [key, label, fallback] of spec.flags) {
    const row = element("div", "checkbox-control"), input = element("input"), caption = element("label", "", fallback);
    if (["dashboardPreviewAlwaysVisible", "dashboardPreviewOnSelect", "dashboardPreviewOnHover"].includes(key)) row.classList.add("dashboard-preview-selection-setting");
    input.type = "checkbox"; input.id = `settings-${key}`; caption.htmlFor = input.id; caption.dataset.i18n = `dashboard.ui.${label}`;
    row.append(input, caption); if (key === "dashboardCustomDensity") densityToggle = row; else settings.append(row); settingsControls.set(key, input);
    input.addEventListener("change", () => void save({ [key]: input.checked }));
  }
  for (const [key, label, fallback, value, min, max, step, unit] of [...spec.numbers, ...spec.sectionNumbers]) {
    const row = element("div", "dashboard-appearance-number"), caption = element("label");
    const name = element("span", "", fallback); name.dataset.i18n = `dashboard.ui.${label}`;
    const input = element("input"); input.type = "number"; input.id = `settings-${key}`; input.value = value;
    input.min = min; input.max = max; input.step = step; caption.htmlFor = input.id;
    caption.append(name, document.createTextNode(unit ? ` (${unit})` : "")); row.append(caption, input);
    (spec.sectionNumbers.some(field=>field[0]===key) ? sectionLimitsControls : density).append(row); settingsControls.set(key, input);
    input.addEventListener("input", () => drafts.add(key));
    input.addEventListener("change", () => {
      drafts.delete(key); const patch = { [key]: Number(input.value) };
      if (key === "dashboardCardSpacing") patch.dashboardRowSpacing = preferences.dashboardRowSpacing;
      if (key === "dashboardMinCardsPerRow" && preferences.dashboardMaxCardsPerRow > 0 && patch[key] > preferences.dashboardMaxCardsPerRow) patch.dashboardMaxCardsPerRow = patch[key];
      if (key === "dashboardMaxCardsPerRow" && patch[key] > 0 && patch[key] < preferences.dashboardMinCardsPerRow) patch.dashboardMinCardsPerRow = patch[key];
      void save(patch);
    });
  }
  window.OnScreenKeyboard?.mountSettings(settings);
  const effects = element("div", "dashboard-3d-settings"), effectToggle = element("div", "checkbox-control");
  const effectInput = element("input"); effectInput.type = "checkbox"; effectInput.id = "settings-dashboard3dEffectsCheckbox";
  const effectLabel = element("label", "", text("settings.dashboard3dEffects", "Enable 3D effects on Dashboard"));
  effectLabel.htmlFor = effectInput.id; effectLabel.dataset.i18n = "settings.dashboard3dEffects";
  const effectControls = element("div", "dashboard-3d-controls"); effectControls.id = "settings-dashboard3dControls"; effectControls.hidden = true;
  effectToggle.append(effectInput, effectLabel); effects.append(effectToggle, effectControls);
  const densityGroup = element("div", "dashboard-custom-layout"); densityGroup.append(densityToggle, density);
  const limitsHelp = element("p", "hint", text("dashboard.ui.rowLimitsHelp", "0 means automatic. The minimum adapts to the available space to keep cards readable."));
  limitsHelp.dataset.i18n = "dashboard.ui.rowLimitsHelp";
  const resetLayout = button(text("dashboard.ui.resetLayout", "Reset card layout"), () => {
    const defaults = Object.fromEntries(spec.numbers.map(([key]) => [key, spec.defaults[key]]));
    for (const key of Object.keys(defaults)) drafts.delete(key); void save(defaults);
  });
  resetLayout.id = "settings-dashboardLayoutReset"; resetLayout.dataset.i18n = "dashboard.ui.resetLayout";
  const densityExtras = element("div", "dashboard-appearance-layout-footer"); densityExtras.append(limitsHelp, resetLayout);
  densityGroup.append(densityExtras); settings.append(effects, densityGroup);
  async function save(patch) {
    const ticket = ++revision;
    for (const key of Object.keys(patch)) pending.add(key);
    preferences = spec.normalize({ ...preferences, ...patch });
    apply();
    saves = saves.then(async () => {
      await window.api.savePreferences(patch);
      const latest = await window.api.loadPreferences();
      window.__preferencesCache = { ...(window.__preferencesCache || {}), ...latest };
      if (ticket === revision) {
        pending.clear(); hydrate(latest);
      }
    }).catch(error => {
      if (ticket === revision) { pending.clear(); void window.api.loadPreferences().then(hydrate).catch(console.warn); }
      console.warn("dashboard:appearance-save-failed", error);
    });
    return saves;
  }
  function hydrate(prefs = {}) {
    const next = spec.normalize(prefs);
    for (const key of pending) next[key] = preferences[key];
    preferences = next; apply();
  }
  function apply() {
    for (const [key, input] of settingsControls) {
      if (input.type === "checkbox") input.checked = preferences[key];
      else if (!drafts.has(key)) input.value = String(preferences[key]);
    }
    for (const key of ["dashboardPreviewAlwaysVisible", "dashboardPreviewOnSelect", "dashboardPreviewOnHover"])
      settingsControls.get(key).parentElement.hidden = !preferences.dashboardPreviewEnabled;
    const persistent = preferences.dashboardPreviewEnabled && preferences.dashboardPreviewAlwaysVisible;
    const sizeSignature = JSON.stringify(preferences.dashboardPreviewSize);
    if (persistent !== appliedPersistent || sizeSignature !== appliedPreviewSize) {
      appliedPersistent = persistent; appliedPreviewSize = sizeSignature; details.refreshAppearance();
    }
    if (!preferences.dashboardPreviewOnHover) { cancelFollow(); hoverCard = null; }
    density.hidden = !preferences.dashboardCustomDensity;
    densityExtras.hidden = !preferences.dashboardCustomDensity;
    root.setAttribute("data-dashboard-density", String(preferences.dashboardCustomDensity));
    root.removeAttribute("data-dashboard-metadata");
    root.setAttribute("data-dashboard-context-background", String(preferences.dashboardContextBackground));
    for (const [property, value] of Object.entries({
      "--dashboard-portrait-width": `${preferences.dashboardPortraitCardWidth}px`,
      "--dashboard-landscape-width": `${preferences.dashboardLandscapeCardWidth}px`,
      "--dashboard-card-spacing": `${preferences.dashboardCardSpacing}px`,
      "--dashboard-row-spacing": `${preferences.dashboardRowSpacing}px`,
      "--dashboard-card-title-lines": String(preferences.dashboardCardTitleLines),
    })) if (root.style.getPropertyValue(property) !== value) root.style.setProperty(property, value);
    layout.apply(preferences);
    shelfHost.hidden = !sectionsEnabled() || body.classList.contains("dashboard-collection-detail");
    hints.hidden = !preferences.dashboardControllerHints;
    updateHintInset();
    if (!preferences.dashboardPreviewEnabled && panel.classList.contains("has-game-preview")) details.close();
    if (!preferences.dashboardPreviewEnabled) grid.querySelectorAll(".dash-preview").forEach(control => { control.hidden = true; });
    if (!preferences.dashboardContextBackground) { backgroundSequence++; backdrops.forEach(el => { el.classList.remove("is-visible"); el.style.removeProperty("background-image"); }); backgroundSource = ""; clearMainBackground(); }
    else if (!mainBackgroundSource) void updateMainBackground(document.getElementById("configList")?.value || "");
    schedule(); refreshHints();
  }
  let hintSignature = "";
  function refreshHints() {
    if (!preferences.dashboardControllerHints) return;
    const ps = /dualshock|dualsense|playstation|sony/i.test(gamepadId);
    const controller = !!gamepadId;
    const pad = (xbox, playstation, xboxClass = "", psClass = "") => [[ps ? playstation : xbox, "btn " + (ps ? psClass : xboxClass)]];
    const keys = (...values) => values.map(value => [value, "kbd"]);
    const rows = [
      [controller ? pad("D-pad / LS", "D-pad / LS", "stick", "stick") : keys("↑", "↓", "←", "→"), text("shortcutsCommonMove", "Move")],
      [controller ? pad("A", "✕", "xb-a", "ps-cross") : keys("Enter"), text(detailState.open ? "dashboard.ui.activate" : preferences.dashboardPreviewEnabled && preferences.dashboardPreviewOnSelect ? "dashboard.ui.preview" : "dashboard.ui.open", detailState.open ? "Select" : preferences.dashboardPreviewEnabled && preferences.dashboardPreviewOnSelect ? "Game preview" : "Open")],
      ...(preferences.dashboardPreviewEnabled ? [[controller ? pad("R3", "R3", "stick", "stick") : keys("V", "Space"), text("dashboard.ui.preview", "Game preview"), "/"]] : []),
      ...(controller && !panel.classList.contains("has-game-page") && !panel.classList.contains("dashboard-narrow-details") && window.AchievementsDashboard3D?.isEnabled() ? [[
        [...pad("RT", "R2"), ...pad("LS / D-pad", "LS / D-pad", "stick", "stick")], text("dashboard.ui.rotateCard", "Rotate card"),
      ]] : []),
      [controller ? pad(text("shortcutsButtonMenu", "Menu"), text("shortcutsButtonOptions", "Options"), "xb-menu", "ps-options") : keys("P"), text("dashboard.play", "Play")],
      ...(!detailState.open ? [
        [controller ? pad("Y", "△", "xb-y", "ps-triangle") : keys("Shift", "F10"), text("dashboard.ui.actions", "Actions")],
        [controller ? pad("X", "☐", "xb-x", "ps-square") : keys("Ctrl", "F"), text("shortcutsDashboardSearch", "Search")],
      ] : []),
      [controller ? pad("RS", "RS", "stick", "stick") : keys("PageUp", "PageDown"), text("shortcutsGlobalPageScroll", "Page scroll"), "/"],
      ...(!controller ? [[keys("Tab"), text("dashboard.ui.controls", "Controls")]] : []),
      [controller ? pad("B", "◯", "xb-b", "ps-circle") : keys("Esc"), text("backButton", "Back")],
    ];
    const signature = JSON.stringify(rows);
    if (hintSignature === signature) return;
    hintSignature = signature;
    hints.replaceChildren(...rows.map(([tokens, label, separator = "+"]) => {
      const group = element("span", "dashboard-control-hint"), badges = element("span", controller ? "ctl " + (ps ? "ctl-ps" : "ctl-xb") : "ctl-line sub");
      tokens.forEach(([value, cls], index) => {
        if (index && tokens.length === 2) badges.append(document.createTextNode(separator));
        badges.append(element(cls === "kbd" ? "kbd" : "span", cls === "kbd" ? "" : cls, value));
      });
      group.append(badges, element("span", "", label)); return group;
    }));
    updateHintInset();
  }
  document.addEventListener("dashboard-3d:changed", refreshHints);
  async function updateBackground(hero) {
    const ticket = ++backgroundSequence, src = hero?.url || "";
    if (!preferences.dashboardContextBackground || src === backgroundSource) return;
    if (!src) { backdrops.forEach(el => el.classList.remove("is-visible")); backgroundSource = ""; return; }
    const preload = new Image(); preload.src = src;
    try { await preload.decode(); } catch { return; }
    if (ticket !== backgroundSequence || !preferences.dashboardContextBackground) return;
    backgroundSource = src; backdropIndex = 1 - backdropIndex;
    backdrops[backdropIndex].style.backgroundImage = `url(${JSON.stringify(src)})`;
    backdrops.forEach((el, index) => el.classList.toggle("is-visible", index === backdropIndex));
  }
  function canFollow() {
    return window.__dashboardOpen && !panel.closest("[inert]") &&
      !document.documentElement.classList.contains("settings-open") && !window.__dashboardContextMenuOpen &&
      !window.__dashboardContextMenuIgnoreClick && !window.GameArtworkControls?.isOpen() && !window.AchievementMediaViewer?.isOpen() &&
      !panel.querySelector("#dashboardViewMode[open],#dashboardSortMenu[open],select[data-sel-open='1']");
  }
  function previewTarget(card, hover = false) {
    if (!card || !canFollow()) return;
    cancelFollow();
    if (details.isOpen()) {
      if (hover && !preferences.dashboardPreviewOnHover) return;
      if (card.dataset.name === details.current()) return;
      const follow = () => {
        if (card.isConnected && canFollow() && details.isOpen() && card.dataset.name !== details.current()) void details.follow(card.dataset.name, card);
      };
      if (hover) followTimer = setTimeout(follow, 140); else follow();
      return;
    }
    if (!preferences.dashboardContextBackground) return;
    const name = card.dataset.name, ticket = ++backgroundSequence;
    clearTimeout(backgroundTimer);
    backgroundTimer = setTimeout(async () => {
      try {
        let artwork = artworkCache.get(name);
        if (!artwork) { artwork = await window.api.getDashboardArtwork(name); if (artworkCache.size >= 32) artworkCache.delete(artworkCache.keys().next().value); artworkCache.set(name, artwork || {}); }
        if (ticket === backgroundSequence && !detailState.open) void updateBackground(artwork?.hero);
      } catch (error) { console.warn("dashboard:background-failed", error); }
    }, 140);
  }
  async function preview(name, page = false, captures = false, options = {}) {
    cancelFollow();
    await details.open(name, page, captures, false, options);
  }
  function ensurePersistentPreview() {
    if (!preferences.dashboardPreviewEnabled || !preferences.dashboardPreviewAlwaysVisible || details.isOpen() || !canFollow()) return;
    const available = [...grid.querySelectorAll(".dash-card")].filter(card => !card.hidden && card.style.display !== "none");
    const focused = document.activeElement?.closest(".dash-card");
    const candidates = [focused, cardFor(lastPreviewName), cardFor(document.getElementById("configList")?.value),
      ...body.querySelectorAll(".dash-card.active"), ...available];
    const card = candidates.find(card => card?.isConnected && available.some(source => source.dataset.name === card.dataset.name));
    if (card) void preview(card.dataset.name, false, false, { keepFocus: true });
  }
  function previewFromShortcut() {
    if (!preferences.dashboardPreviewEnabled || !window.__dashboardOpen || panel.closest("[inert]") || document.documentElement.classList.contains("settings-open") || window.__dashboardContextMenuOpen || panel.querySelector("#dashboardViewMode[open],#dashboardSortMenu[open],select[data-sel-open='1']")) return;
    const card = window.DashboardNavigation?.focusedCard();
    if (preferences.dashboardPreviewAlwaysVisible) {
      cancelFollow();
      const focused = document.activeElement?.closest(".dash-card");
      const target = details.isOpen() ? focused : card;
      if (target?.matches(".dash-card") && target.dataset.name !== details.current())
        void preview(target.dataset.name, false, false, { keepFocus: true, origin: target });
      details.focus();
      return;
    }
    if (detailState.open && (!card || card.dataset.name === details.current())) { details.close(); return; }
    if (card?.matches(".dash-card")) void preview(card.dataset.name);
  }
  const viewSelection = () => window.DashboardViews?.get() || [];
  const sectionsEnabled = () => viewSelection().some(key => ["lastPlayed", "almostComplete", "recentUnlocks"].includes(key));
  window.addEventListener("dashboard:view-changed", () => { delete shelfHost.dataset.signature; shelfHost.hidden = !sectionsEnabled() || body.classList.contains("dashboard-collection-detail"); schedule(); });
  function schedule() {
    if (!window.__dashboardOpen || !(preferences.dashboardPreviewEnabled || sectionsEnabled())) return;
    if (!frame) frame = requestAnimationFrame(() => { frame = 0; decorate(); });
  }
  let shelvesRevision = 0;
  function decorate() {
    const cards = [...grid.querySelectorAll(".dash-card")];
    for (const card of cards) {
      let control = card.querySelector(".dash-preview");
      if (preferences.dashboardPreviewEnabled && !control) {
        control = button("ⓘ", () => {}, "dash-preview");
        card.append(control);
      }
      if (control) {
        control.hidden = !preferences.dashboardPreviewEnabled;
        control.title = control.ariaLabel = text("dashboard.ui.preview", "Game preview");
      }
    }
    syncShelfControls();
    ensurePersistentPreview();
    if (sectionsEnabled() && window.__dashboardOpen) void renderShelves(cards).catch(error => {
      delete shelfHost.dataset.signature; console.warn("dashboard:sections-failed", error);
    });
  }
  async function renderShelves(cards) {
    if (panel.classList.contains("has-game-page")) return;
    const signature = JSON.stringify([panel.dataset.cardLayout, viewSelection(), preferences.dashboardCollapsedSections, spec.sectionNumbers.map(([key])=>preferences[key]), cards.map(card => {
      const image = card.querySelector("img");
      if (image && !imageVersions.has(image)) imageVersions.set(image, ++imageSequence);
      return [card.dataset.name, card.dataset.pct, card.style.display, imageVersions.get(image) || 0, card.querySelectorAll("button").length];
    })]);
    if (shelfHost.dataset.signature === signature) return;
    shelfHost.dataset.signature = signature;
    const ticket = ++shelvesRevision;
    const lastPlayed = await window.api.getLastPlayedSnapshot();
    if (ticket !== shelvesRevision || !sectionsEnabled()) return;
    // The underlying grid may be hidden by the view selection; its card filters still apply.
    const eligible = cards.filter(card => card.style.display !== "none" && !card.hidden);
    const recent = [...eligible].filter(card => Number(lastPlayed[card.dataset.name]) > 0)
      .sort((a, b) => Number(lastPlayed[b.dataset.name]) - Number(lastPlayed[a.dataset.name])).slice(0, preferences.dashboardRecentPlayedLimit);
    const almost = [...eligible].filter(card => Number(card.dataset.pct) >= 70 && Number(card.dataset.pct) < 100)
      .sort((a, b) => Number(b.dataset.pct) - Number(a.dataset.pct)).slice(0, preferences.dashboardAlmostCompletedLimit);
    const unlocked = [...eligible].filter(card => Number(card.dataset.unlocked) > 0 && Number(card.dataset.updated) > 0)
      .sort((a, b) => Number(b.dataset.updated) - Number(a.dataset.updated)).slice(0, preferences.dashboardRecentUnlocksLimit);
    const fragment = document.createDocumentFragment();
    for (const [key, fallback, rows, enabled] of [["lastPlayed", "Recently played", recent, viewSelection().includes("lastPlayed")], ["almostComplete", "Almost completed", almost, viewSelection().includes("almostComplete")], ["recentUnlocks", "Recent unlocks", unlocked, viewSelection().includes("recentUnlocks")]]) {
      if (!rows.length || !enabled) continue;
      const section = element("details", "dashboard-home-section"), h = element("summary", "", text(`dashboard.ui.${key}`, fallback)), row = element("div", "dashboard-grid dashboard-shelf-row");
      section.dataset.section = key;
      section.open = !preferences.dashboardCollapsedSections.includes(key);
      for (const card of rows) {
        const b = card.cloneNode(true); b.classList.remove("dash-card-3d-hover", "active"); b.classList.add("dashboard-shelf-card"); b.removeAttribute("style"); b.removeAttribute("id");
        b.querySelectorAll("[id]").forEach(el => el.removeAttribute("id"));
        const img = b.querySelector(".dash-thumb"); if (img) { img.loading = "lazy"; img.src = panel.dataset.cardLayout === "landscape" ? img.dataset.landscapeSrc || img.src : img.dataset.portraitSrc || img.src; }
        row.append(b);
      }
      section.append(h, row); fragment.append(section);
    }
    const focused = shelfHost.contains(document.activeElement) ? document.activeElement : null;
    const previous = focused && { section: focused.closest(".dashboard-home-section")?.dataset.section,
      name: focused.closest(".dash-card")?.dataset.name,
      control: [".dash-play", ".dash-block", ".dash-preview"].find(selector => focused.matches(selector)) };
    shelfHost.replaceChildren(fragment);
    layout.refresh();
    syncShelfControls();
    if (previous) {
      const section = [...shelfHost.children].find(el => el.dataset.section === previous.section);
      const card = [...(section?.querySelectorAll(".dash-card") || [])].find(el => el.dataset.name === previous.name);
      const target = (previous.control ? card?.querySelector(previous.control) : card) || section?.querySelector("summary") || panel.querySelector("#dashboardViewMode summary");
      window.DashboardNavigation?.focus(target, { scroll: false });
    }
  }
  function syncShelfControls() {
    const sources = new Map([...grid.querySelectorAll(".dash-card")].map(card => [card.dataset.name, card]));
    for (const copy of shelfHost.querySelectorAll(".dashboard-shelf-card")) {
      const source = sources.get(copy.dataset.name); if (!source) continue;
      // Multi-selection belongs to the config; navigation focus belongs to one DOM card.
      copy.classList.toggle("selected", source.classList.contains("selected"));
      copy.setAttribute("aria-selected", source.getAttribute("aria-selected") || "false");
      copy.dataset.blacklisted = source.dataset.blacklisted || "0";
      const label = copy.querySelector(".dash-name"), originalLabel = source.querySelector(".dash-name");
      if (label && originalLabel && label.innerHTML !== originalLabel.innerHTML) label.innerHTML = originalLabel.innerHTML;
      for (const selector of [".dash-play", ".dash-block", ".dash-preview"]) {
        const control = copy.querySelector(selector), original = source.querySelector(selector); if (!control || !original) continue;
        control.className = original.className; control.classList.remove("force-show"); control.disabled = original.disabled; control.hidden = original.hidden;
        for (const attribute of ["title", "aria-label", "aria-disabled", "tabindex"]) {
          if (original.hasAttribute(attribute)) control.setAttribute(attribute, original.getAttribute(attribute)); else control.removeAttribute(attribute);
        }
      }
    }
  }
  // Cloned markup shares the existing card actions; it never creates another launch/config pipeline.
  shelfHost.addEventListener("click", event => {
    const copy = event.target.closest(".dashboard-shelf-card"), source = cardFor(copy?.dataset.name);
    if (!copy || !source) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (window.__dashboardContextMenuOpen || window.__dashboardContextMenuIgnoreClick) return;
    const control = event.target.closest("button");
    const selector = control?.matches(".dash-play") ? ".dash-play" : control?.matches(".dash-block") ? ".dash-block" : null;
    if (selector) source.querySelector(selector)?.click();
    else source.dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: event.ctrlKey, metaKey: event.metaKey, shiftKey: event.shiftKey }));
  });
  shelfHost.addEventListener("contextmenu", event => {
    const copy = event.target.closest(".dashboard-shelf-card"), source = cardFor(copy?.dataset.name);
    if (!source) return;
    event.preventDefault(); event.stopPropagation();
    source.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: event.clientX, clientY: event.clientY }));
  });
  shelfHost.addEventListener("pointerover", event => {
    const copy = event.target.closest(".dashboard-shelf-card");
    if (!copy || copy.contains(event.relatedTarget)) return;
    const source = cardFor(copy.dataset.name);
    if (source?.querySelector(".dash-play.is-disabled")) void source.__refreshPlayButton?.();
  });
  body.addEventListener("pointerdown", event => {
    const card = event.target.closest(".dash-card"); pointerFocusCard = card;
    setTimeout(() => { if (pointerFocusCard === card) pointerFocusCard = null; }, 0);
  }, true);
  body.addEventListener("focusin", event => {
    const card = event.target.closest(".dash-card");
    if (card) window.setActiveCard?.(card.dataset.name, card);
  });
  shelfHost.addEventListener("keydown", event => {
    const copy = event.target.closest(".dashboard-shelf-card");
    // Space belongs to the shared Preview shortcut while previews are enabled.
    if (copy && event.target === copy && (event.key === "Enter" || (event.key === " " && !preferences.dashboardPreviewEnabled))) {
      event.preventDefault(); event.stopImmediatePropagation(); copy.click();
    }
  });
  body.addEventListener("click", event => {
    cancelFollow();
    const control = event.target.closest(".dash-preview");
    if (control) {
      event.preventDefault(); event.stopImmediatePropagation();
      void preview(control.closest(".dash-card").dataset.name);
      return;
    }
    const card = event.target.closest(".dash-card");
    if (!card || event.target.closest("button,input,select,a") || event.ctrlKey || event.metaKey || event.shiftKey ||
      !preferences.dashboardPreviewEnabled || !(preferences.dashboardPreviewOnSelect || preferences.dashboardPreviewAlwaysVisible) || !canFollow()) return;
    const current = details.isOpen() && details.current() === card.dataset.name;
    if (current && details.isReady()) return;
    event.preventDefault(); event.stopImmediatePropagation();
    // A repeated click while the current request is pending is not a second
    // activation of loaded details and must not select the config or restart I/O.
    if (current) return;
    card.focus({ preventScroll: true });
    void preview(card.dataset.name, false, false, { keepFocus: true, origin: card });
  }, true);
  body.addEventListener("pointerover", event => {
    const card = event.target.closest(".dash-card");
    // Opening/resizing Preview can put a different card under a stationary
    // pointer. Follow only real pointer movement, not that layout change.
    if (!details.isOpen() && card && body.contains(card) && !card.contains(event.relatedTarget)) previewTarget(card, true);
  }, { passive: true });
  body.addEventListener("pointermove", event => {
    const moved = !pointerPosition || event.clientX !== pointerPosition.x || event.clientY !== pointerPosition.y;
    pointerPosition = { x: event.clientX, y: event.clientY };
    const card = event.target.closest(".dash-card");
    if (moved && card !== hoverCard) {
      hoverCard = card;
      if (card && details.isOpen()) previewTarget(card, true);
    }
  }, { passive: true });
  body.addEventListener("pointerout", event => {
    const card = event.target.closest(".dash-card");
    if (card && !card.contains(event.relatedTarget)) { hoverCard = null; cancelFollow(); }
  }, { passive: true });
  body.addEventListener("focusin", event => {
    const card = event.target.closest(".dash-card");
    if (card && card !== pointerFocusCard && body.contains(card)) previewTarget(card);
  });
  const observer = new MutationObserver(records => {
    for (const record of records) if (record.attributeName === "src" && record.target.tagName === "IMG") imageVersions.set(record.target, ++imageSequence);
    // 3D tilt updates CSS variables each frame. Only display changes from
    // filtering affect sections; they must not trigger per-frame grid work.
    if (!records.some(record => {
      if (record.target.closest?.(".dash-preview")) return false;
      if (record.type === "attributes" && record.attributeName === "style") {
        const previousDisplay = /(?:^|;)\s*display\s*:\s*([^;]+)/i.exec(record.oldValue || "")?.[1]?.trim() || "";
        return previousDisplay !== record.target.style.display;
      }
      return true;
    })) return;
    schedule();
  });
  observer.observe(grid, { childList: true, subtree: true, attributes: true, attributeOldValue: true, attributeFilter: ["data-platform", "data-pct", "data-unlocked", "data-total", "data-updated", "style", "src", "class", "aria-disabled", "disabled"] });
  new MutationObserver(() => { if (window.__dashboardOpen) { delete shelfHost.dataset.signature; schedule(); } })
    .observe(panel.parentElement, { attributes: true, attributeFilter: ["class", "aria-hidden"] });
  new MutationObserver(schedule).observe(panel, { attributes: true, attributeFilter: ["class", "data-card-layout"] });
  document.getElementById("dashboardPlatformFilter")?.addEventListener("change", () => { delete shelfHost.dataset.signature; schedule(); });
  document.getElementById("dashboardSearchInput")?.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(() => { delete shelfHost.dataset.signature; schedule(); }, 200); });
  for (const channel of ["configs:changed", "playtime:update", "playtime:last-played-updated", "achievements:file-updated"]) window.api.on(channel, payload => {
    delete shelfHost.dataset.signature;
    if (channel === "configs:changed") artworkCache.clear();
    if (channel === "configs:changed" && mainBackgroundName) void updateMainBackground();
    if (channel === "playtime:update") details.updatePlaytime(payload);
    else if ((channel === "configs:changed" && details.isOpen()) || payload?.configName === details.current()) details.refresh();
    schedule();
  });
    window.api.on("update-image", payload => { artworkCache.clear(); backgroundSource = ""; if (details.isOpen()) void details.refreshArtwork(payload); if (mainBackgroundName) void updateMainBackground(); });
  window.api.on("config:schema-ready", payload => { artworkCache.clear(); if (details.isOpen() && payload?.name === details.current()) details.refresh(); });
  function localize() {
    for (const [key, input] of settingsControls) {
      const label = input.parentElement.querySelector("label"), field = [...spec.flags, ...spec.numbers, ...spec.sectionNumbers].find(row => row[0] === key);
      if (label && field) (label.querySelector("span") || label).textContent = text(`dashboard.ui.${field[1]}`, field[2]);
    }
    summary.textContent = text("dashboard.ui.appearance", "Dashboard appearance");
    delete shelfHost.dataset.signature; refreshHints(); details.localize(); schedule();
  }
  document.addEventListener("keydown", event => {
    if (preferences.dashboardControllerHints) { gamepadId = ""; refreshHints(); }
    const menu = document.getElementById("dashboardViewMode");
    if (window.__dashboardOpen && menu?.open && !menu.closest("[inert]") && !document.documentElement.classList.contains("settings-open") && menu.contains(event.target) && ["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) {
      event.preventDefault(); event.stopImmediatePropagation();
      viewAction({ ArrowUp: "UP", ArrowDown: "DOWN", Home: "HOME", End: "END" }[event.key]); return;
    }
  }, true);
  function viewAction(action) {
    const menu = document.getElementById("dashboardViewMode");
    if (!window.__dashboardOpen || !menu?.open || menu.closest("[inert]") || window.__dashboardContextMenuOpen) return false;
    if (action === "BACK") { menu.open = false; menu.querySelector("summary").focus({ preventScroll: true }); return true; }
    const controls = [...menu.querySelectorAll("[data-view]")], current = controls.indexOf(document.activeElement);
    if (action === "CONFIRM") { if (current >= 0) controls[current].click(); else controls[0]?.focus(); return true; }
    if (["UP", "DOWN", "HOME", "END"].includes(action)) {
      const index = action === "HOME" ? 0 : action === "END" ? controls.length - 1 : (current + (action === "UP" ? -1 : 1) + controls.length) % controls.length;
      controls[index]?.focus({ preventScroll: true }); return true;
    }
    return false;
  }
  window.DashboardExperience = {
    hydrate, localize, readPreferences: () => ({ ...preferences }), preview, refreshLayout: layout.refresh,
    handleControllerAction: action => action === "PREVIEW" ? (previewFromShortcut(), true) : viewAction(action) || details.action(action),
    noteGamepad(pad) { window.DashboardNavigation?.noteInput("navigation"); const id = pad?.id || ""; if (id !== gamepadId) { gamepadId = id; refreshHints(); } },
  };
  void window.api.loadPreferences().then(hydrate).catch(console.warn);
})();
