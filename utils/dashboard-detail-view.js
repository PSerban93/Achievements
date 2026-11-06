"use strict";

window.DashboardDetailView = {
  create({ panel, getCard, text, openConfig, play, onChange, isPersistent = () => false, getSize = () => ({}), onSizeSave = () => {} }) {
    const view = document.createElement("aside");
    view.id = "dashboardGameDetails"; view.className = "dashboard-game-details"; view.hidden = true;
    view.setAttribute("role", "region"); view.tabIndex = -1; panel.append(view);
    const surface = document.createElement("div"); surface.className = "dashboard-details-surface"; view.append(surface);
    let revision = 0, name = "", data = null, focusBack = null, expanded = false, tab = "overview", mediaLoaded = false;
    let refreshing = false, artworkPending = false, statusKey = "", aboutOpen = true;
    let artworkTimer = 0;
    const library = panel.querySelector("#dashboardBody");
    let libraryPosition = null;
    const resize = window.DashboardPreviewResize.create({ panel, view, library, getSize, onSave: onSizeSave,
      isExpanded: () => expanded, isVisible: () => !view.hidden,
      onLayout: () => window.DashboardExperience?.refreshLayout() });
    const element = (tag, cls, value) => { const el = document.createElement(tag); if (cls) el.className = cls; if (value != null) el.textContent = value; return el; };
    const button = (value, handler, cls = "") => { const el = element("button", cls, value); el.type = "button"; el.addEventListener("click", handler); return el; };
    const label = value => {
      if (typeof value === "string") return value;
      const language = String(data?.config?.language || window.__preferencesCache?.language || "english").toLowerCase();
      const key = Object.keys(value || {}).find(key => key.toLowerCase() === language);
      return value?.[key] || value?.english || Object.values(value || {}).find(value => typeof value === "string") || "";
    };
    const earned = entry => entry?.earned === true || entry?.earned === 1;
    const time = ms => window.PlaytimeDuration?.formatMinutes(ms) || Math.floor(Math.max(0, Number(ms) || 0) / 60000) + "m";
    const date = timestamp => new Date(timestamp).toLocaleDateString(undefined, { year: "2-digit", month: "short", day: "numeric" });
    const notify = () => onChange?.({ open: !view.hidden, name, expanded, tab, artwork: data?.artwork });
    const icon = cls => { const el = element("i", cls); el.setAttribute("aria-hidden", "true"); return el; };
    function iconButton(cls, title, handler) {
      const el = button("", handler, "dashboard-detail-icon"); el.append(icon(cls)); el.title = title; el.setAttribute("aria-label", title); return el;
    }
    function imageURL(base, relative) {
      if (!relative) return "";
      if (/^(file:|https:\/\/)/i.test(relative)) return relative;
      const absolute = /^[A-Za-z]:[\\/]|^[/\\]{2}/.test(relative) ? relative : base + "/" + relative;
      return "file:///" + absolute.replace(/\\/g, "/").replace(/^\/+/, "").split("/").map((part, i) => i === 0 && /^[A-Za-z]:$/.test(part) ? part : encodeURIComponent(part)).join("/");
    }
    function captureLibraryPosition() {
      if (!library) return null;
      const bounds = library.getBoundingClientRect();
      const inViewport = el => el && el.getClientRects().length && getComputedStyle(el).visibility !== "hidden" &&
        el.getBoundingClientRect().bottom > bounds.top && el.getBoundingClientRect().top < bounds.bottom;
      const selected = document.activeElement?.closest(".dash-card,.dashboard-collection-card");
      const anchor = library.contains(selected) && inViewport(selected) ? selected :
        [...library.querySelectorAll(".dash-card,.dashboard-collection-card")].find(inViewport);
      return { top: library.scrollTop, anchor, name: anchor?.dataset.name,
        section: anchor?.closest(".dashboard-home-section")?.dataset.section,
        offset: anchor ? anchor.getBoundingClientRect().top - bounds.top : 0 };
    }
    function restoreLibraryPosition(position) {
      if (!library || !position) return;
      const anchor = position.anchor?.isConnected ? position.anchor : [...library.querySelectorAll(".dash-card")]
        .find(el => el.dataset.name === position.name && el.closest(".dashboard-home-section")?.dataset.section === position.section);
      library.scrollTop = position.top;
      if (anchor?.getClientRects().length) library.scrollTop += anchor.getBoundingClientRect().top - library.getBoundingClientRect().top - position.offset;
    }
    function toggleExpanded(ticket) {
      resize.finish();
      const scroll = view.querySelector(".dashboard-details-scroll")?.scrollTop || 0;
      if (!expanded && !panel.classList.contains("dashboard-narrow-details")) libraryPosition = captureLibraryPosition();
      expanded = !expanded;
      panel.classList.toggle("has-game-page", expanded); panel.classList.toggle("has-game-preview", !expanded);
      draw(ticket); position(); restoreLibraryPosition(libraryPosition); notify();
      view.querySelector(".dashboard-details-scroll").scrollTop = scroll;
      view.querySelector(".dashboard-details-window-actions button")?.focus({ preventScroll: true });
    }
    function position() {
      if (view.hidden) return;
      const p = panel.getBoundingClientRect(), h = panel.querySelector("#dashboardHeader").getBoundingClientRect();
      const scale = p.height / panel.offsetHeight || 1;
      // Persistent compact details keep the library usable even on a narrow
      // window; expanded details retain the existing full-panel navigation.
      panel.classList.toggle("dashboard-narrow-details", p.width / scale < 980 && !(isPersistent() && !expanded));
      panel.style.setProperty("--dashboard-details-top", expanded ? "12px" : Math.round((h.bottom - p.top) / scale + 10) + "px");
      resize.apply();
    }
    function focusLibrary() {
      const targets = window.DashboardNavigation?.targets() || [];
      const target = targets.find(el => el.matches(".dash-card") && el.dataset.name === name) || targets.find(el => el.matches(".dash-card"));
      if (!window.DashboardNavigation?.focus(target, { scroll: false })) document.getElementById("closeDashboard")?.focus({ preventScroll: true });
    }
    function focusPreview() {
      if (view.hidden) return false;
      const target = view.querySelector(".dashboard-details-play:not(:disabled)") ||
        view.querySelector(".dashboard-details-achievements:not(:disabled)") ||
        view.querySelector(".dashboard-details-window-actions button:not([hidden]):not(:disabled)") || view;
      // The region itself receives focus while loading. Once actions exist,
      // open() transfers that focus, unless the user has already moved away.
      return window.DashboardNavigation?.focus(target) || false;
    }
    function close(options = {}) {
      resize.finish(false);
      clearTimeout(artworkTimer);
      if (view.hidden) return;
      if (!options.force && isPersistent() && window.__dashboardOpen) {
        if (expanded) toggleExpanded(revision);
        focusLibrary(); return;
      }
      const position = expanded || panel.classList.contains("dashboard-narrow-details") ? libraryPosition : captureLibraryPosition();
      const card = getCard(name), previous = focusBack, previousName = name, ticket = ++revision;
      view.hidden = true; name = ""; data = null; mediaLoaded = false;
      refreshing = artworkPending = false; statusKey = "";
      panel.classList.remove("has-game-preview", "has-game-page", "dashboard-narrow-details"); panel.style.removeProperty("--dashboard-preview-width"); surface.replaceChildren(); notify(); window.DashboardExperience?.refreshLayout(); restoreLibraryPosition(position);
      const restore = () => {
        if (previous?.isConnected && panel.contains(previous) && !previous.closest("[inert]") && previous.getClientRects().length) previous.focus({ preventScroll: true });
        else if (window.__dashboardOpen) {
          const target = window.DashboardNavigation?.targets().find(el => el.matches(".dash-card") && el.dataset.name === previousName) || card;
          if (!window.DashboardNavigation?.focus(target, { scroll: false })) document.getElementById("closeDashboard")?.focus({ preventScroll: true });
        }
      };
      restore(); requestAnimationFrame(() => setTimeout(() => {
        if (ticket === revision && view.hidden && window.__dashboardOpen && document.activeElement === document.body && !panel.closest("[inert]")) restore();
      }, 0)); focusBack = null;
    }
    async function showGallery(ticket) {
      const host = view.querySelector(".dashboard-details-media");
      if (!host || !data || ticket !== revision || mediaLoaded) return;
      mediaLoaded = true;
      host.replaceChildren(element("p", "hint", text("achievementMedia.checking", "Checking saved captures…")));
      try {
        const media = await window.api.getGameMediaGallery(name);
        if (ticket !== revision || view.hidden) return;
        const fragment = document.createDocumentFragment(); let count = 0;
        for (const kind of ["screenshot", "record"]) for (const file of media[kind] || []) {
          count++;
          const achievement = data.schema.find(entry => String(entry.name) === String(file.achievementId));
          const title = label(achievement?.displayName) || file.achievementId;
          const el = button("", async () => {
            const result = await window.api.openAchievementMedia({ configName: name, achievementId: file.achievementId, kind, filename: file.filename });
            if (!result?.success) el.title = text("achievementMedia.unavailable", "Saved file unavailable.");
          }, "dashboard-gallery-item");
          el.title = title; el.dataset.filename = file.filename; el.dataset.kind = kind;
          if (kind === "screenshot") { const img = element("img"); img.loading = "lazy"; img.src = file.url; img.alt = ""; el.append(img); }
          else el.append(element("span", "dashboard-gallery-video", "▶"));
          el.append(element("strong", "", title), element("small", "", date(file.modifiedAt))); fragment.append(el);
        }
        host.replaceChildren(count ? fragment : element("p", "hint", media.error ? text("achievementMedia.unavailable", "Saved captures unavailable.") : text("dashboard.ui.noCaptures", "No saved captures for this game.")));
      } catch (error) {
        if (ticket === revision) { mediaLoaded = false; host.replaceChildren(element("p", "hint", text("achievementMedia.unavailable", "Saved captures unavailable."))); }
        console.warn("dashboard:gallery-failed", error);
      }
    }
    function switchTab(value, ticket) {
      tab = value;
      view.querySelector(".dashboard-details-overview").hidden = tab !== "overview";
      view.querySelector(".dashboard-details-media").hidden = tab !== "captures";
      view.querySelectorAll("[data-detail-tab]").forEach(el => el.setAttribute("aria-selected", String(el.dataset.detailTab === tab)));
      if (tab === "captures") void showGallery(ticket); notify();
    }
    function draw(ticket) {
      if (!data || ticket !== revision) return;
      const { config, schema, saved, playtime, metadata, artwork } = data;
      mediaLoaded = false;
      view.setAttribute("aria-label", text("dashboard.ui.details", "Game details"));
      const head = element("header", "dashboard-details-header"), heading = element("div");
      heading.className = "dashboard-details-heading";
      heading.append(element("h3", "", config.displayName || config.name || name),
        element("small", "dashboard-details-platform", [...document.querySelectorAll("#dashboardPlatformFilter option")].find(option => option.value === config.platform)?.textContent || config.platform || ""));
      const controls = element("div", "dashboard-details-window-actions");
      const closeButton = iconButton("fa-solid fa-xmark", text("achievementMedia.close", "Close"), close);
      closeButton.hidden = isPersistent() && !expanded;
      controls.append(iconButton(expanded ? "fa-solid fa-compress" : "fa-solid fa-expand", text(expanded ? "dashboard.ui.collapse" : "dashboard.ui.expand", expanded ? "Compact view" : "Expand details"), () => toggleExpanded(ticket)),
      iconButton("fa-solid fa-rotate", text("dashboard.ui.refreshDetails", "Refresh game details"), () => void refreshPresentation(ticket)),
      closeButton);
      const refreshButton = controls.children[1]; refreshButton.dataset.detailAction = "refresh"; refreshButton.disabled = refreshing;
      refreshButton.setAttribute("aria-busy", String(refreshing));
      controls.lastChild.classList.add("settings-close-button"); head.append(controls);
      const scroll = element("div", "dashboard-details-scroll"), hero = element("div", "dashboard-details-hero");
      if (artwork?.hero) { const img = element("img", "dashboard-details-hero-art"); img.src = artwork.hero.url; img.alt = ""; hero.append(img); }
      else hero.classList.add("without-hero");
      const configNameForArtwork = name;
      const change = iconButton("fa-solid fa-download", text("artwork.redownloadHero", "Redownload background"),
        event => void window.GameArtworkControls?.open(configNameForArtwork, "hero", event.currentTarget));
      change.classList.add("dashboard-artwork-action", "dashboard-artwork-hero");
      change.dataset.artworkType = "hero"; change.dataset.artworkConfig = configNameForArtwork;
      hero.append(change);
      if (artworkPending) hero.append(element("p", "dashboard-artwork-loading", text("dashboard.ui.loadingArtwork", "Loading artwork…")));
      if (artwork?.cover) { const img = element("img", "dashboard-details-cover"); if (artwork.cover.width / artwork.cover.height > 1.3) img.classList.add("is-landscape"); img.src = artwork.cover.url; img.alt = ""; hero.append(img); }
      const content = element("div", "dashboard-details-content"), actions = element("div", "dashboard-details-actions");
      const playButton = button("", () => play(name), "dashboard-details-play"); playButton.append(icon("fa-solid fa-play"), document.createTextNode(text("dashboard.play", "Play")));
      playButton.disabled = !getCard(name)?.querySelector(".dash-play:not(.is-disabled)");
      const configName = data.configName;
      const achievementsButton = button("", () => { close(); openConfig(configName); }, "dashboard-details-achievements");
      achievementsButton.append(icon("fa-solid fa-trophy"), document.createTextNode(text("dashboard.ui.achievements", "Achievements")));
      actions.append(playButton, achievementsButton);
      const links = element("nav", "dashboard-details-links"); links.setAttribute("aria-label", text("dashboard.ui.links", "Game links"));
      for (const item of window.DashboardGameLinks?.list(name, config) || []) {
        const el = button("", () => void window.DashboardGameLinks.run(configName, item.id, config), "dashboard-detail-link");
        el.append(icon(item.icon), element("span", "", item.label)); el.title = item.label; el.disabled = item.disabled; el.dataset.linkAction = item.id; links.append(el);
      }
      const navigation = element("div", "dashboard-details-tabs"); navigation.setAttribute("role", "tablist");
      const overview = element("section", "dashboard-details-overview"), media = element("section", "dashboard-details-media");
      overview.id = "dashboardDetailsOverview"; media.id = "dashboardDetailsCaptures";
      overview.setAttribute("role", "tabpanel"); media.setAttribute("role", "tabpanel");
      for (const [id, key, fallback] of [["overview", "overview", "Overview"], ["captures", "captures", "Captures"]]) {
        const el = button(text("dashboard.ui." + key, fallback), () => switchTab(id, ticket)); el.dataset.detailTab = id; el.id = "dashboardDetailTab-" + id;
        el.setAttribute("role", "tab"); el.setAttribute("aria-controls", id === "overview" ? overview.id : media.id); navigation.append(el);
      }
      overview.setAttribute("aria-labelledby", "dashboardDetailTab-overview"); media.setAttribute("aria-labelledby", "dashboardDetailTab-captures");
      const real = schema.filter(entry => entry.synthetic_platinum !== true), unlocked = real.filter(entry => earned(saved[entry.name])).length;
      const progress = real.length ? Math.round(unlocked / real.length * 100) : 0, facts = element("dl", "dashboard-details-facts");
      for (const [key, fallback, value, cls] of [["progress", "Progress", unlocked + "/" + real.length + " · " + progress + "%", ""],
        ["playtime", "Playtime", time(playtime.totalMs), "dashboard-details-playtime"], ["lastSession", "Last played", playtime.updatedAt ? date(playtime.updatedAt) : "—", ""]]) {
        const group = element("div"); group.append(element("dt", "", text("dashboard.ui." + key, fallback)), element("dd", cls, value)); facts.append(group);
      }
      const bar = element("div", "dashboard-details-progress"); bar.setAttribute("role", "progressbar"); bar.setAttribute("aria-label", text("dashboard.ui.progress", "Progress"));
      bar.setAttribute("aria-valuemin", "0"); bar.setAttribute("aria-valuemax", "100"); bar.setAttribute("aria-valuenow", progress);
      const fill = element("span"); fill.style.width = progress + "%"; bar.append(fill); overview.append(facts, bar);
      if (metadata?.description) {
        const about = element("details", "dashboard-details-about"); about.open = aboutOpen;
        about.append(element("summary", "", text("dashboard.ui.about", "About the game")), element("p", "", metadata.description));
        about.addEventListener("toggle", () => { if (about.isConnected) aboutOpen = about.open; }); overview.append(about);
      }
      const properties = element("dl", "dashboard-details-properties");
      for (const [key, fallback, value] of [["developer", "Developer", metadata?.developers?.join(", ")], ["publisher", "Publisher", metadata?.publishers?.join(", ")],
        ["genres", "Genres", metadata?.genres?.join(" · ")], ["released", "Release date", metadata?.releaseDate]]) if (value) {
        properties.append(element("dt", "", text("dashboard.ui." + key, fallback)), element("dd", "", value));
      }
      if (properties.children.length) overview.append(properties);
      const latest = element("section", "dashboard-details-recent"); latest.append(element("h4", "", text("dashboard.ui.recentUnlocks", "Recent unlocks")));
      const rows = real.filter(entry => earned(saved[entry.name])).sort((a, b) => Number(saved[b.name]?.earned_time || 0) - Number(saved[a.name]?.earned_time || 0)).slice(0, 5);
      if (!rows.length) latest.append(element("p", "hint", text("dashboard.ui.noUnlocks", "No unlocked achievements yet.")));
      for (const entry of rows) {
        const row = element("article", "dashboard-details-achievement");
        if (entry.icon) { const img = element("img"); img.loading = "lazy"; img.src = imageURL(data.schemaRoot, entry.icon); img.alt = ""; img.addEventListener("error", () => { img.hidden = true; }, { once: true }); row.append(img); }
        const body = element("div"); body.append(element("strong", "", label(entry.displayName) || entry.name), element("p", "", label(entry.description)));
        if (window.AchievementOrder?.isPlatinum(entry)) body.append(element("span", "trophy-tier-label trophy-tier-platinum", text("settings.notificationCustomisation.state.platinum", "Platinum")));
        row.append(body); latest.append(row);
      }
      const intro = element("section", "dashboard-details-intro"); intro.append(heading, actions);
      overview.append(latest); content.append(intro); if (links.children.length) content.append(links); content.append(navigation, overview, media);
      if (statusKey) { const status = element("p", "dashboard-details-status", text("dashboard.ui." + statusKey, statusKey === "detailsUpdated" ? "Game details updated." : statusKey === "detailsUnchanged" ? "Game details are up to date." : "Additional game details are unavailable. Existing information was kept.")); status.setAttribute("role", "status"); content.prepend(status); }
      scroll.append(hero, content); surface.replaceChildren(head, scroll); switchTab(tab, ticket);
    }
    function applyPresentation(presentation, ticket) {
      if (ticket !== revision || view.hidden || !data) return;
      const scroll = view.querySelector(".dashboard-details-scroll")?.scrollTop || 0;
      const focused = view.contains(document.activeElement) ? [...view.querySelectorAll("button,summary")].indexOf(document.activeElement) : -1;
      if (presentation) { data.artwork = presentation.artwork || data.artwork; data.metadata = presentation.metadata || data.metadata; }
      draw(ticket); position(); notify();
      view.querySelector(".dashboard-details-scroll").scrollTop = scroll;
      if (focused >= 0) view.querySelectorAll("button,summary")[focused]?.focus({ preventScroll: true });
    }
    async function refreshPresentation(ticket) {
      if (refreshing || !data) return;
      const configName = name; refreshing = true; statusKey = ""; applyPresentation(null, ticket);
      try {
        const presentation = await window.api.refreshDashboardGameDetails(configName);
        if (ticket !== revision || view.hidden) return;
        refreshing = false;
        statusKey = presentation?.result?.ok ? presentation.result.code === "unchanged" ? "detailsUnchanged" : "detailsUpdated" : "detailsUnavailable";
        applyPresentation(presentation, ticket);
      } catch (error) {
        if (ticket === revision && !view.hidden) { refreshing = false; statusKey = "detailsUnavailable"; applyPresentation(null, ticket); }
        console.warn("dashboard:details-refresh-failed", error);
      }
    }
    async function ensureArtwork(ticket) {
      if (!data || (data.artwork?.hero && data.artwork?.cover && data.metadata?.description && data.metadata?.genres?.length &&
        data.metadata?.releaseDate && data.metadata?.developers?.length && data.metadata?.publishers?.length)) return;
      const configName = name; artworkPending = true; applyPresentation(null, ticket);
      try {
        const presentation = await window.api.ensureDashboardArtwork(configName);
        if (ticket !== revision || view.hidden) return;
        artworkPending = false; applyPresentation(presentation, ticket);
      } catch (error) {
        if (ticket === revision && !view.hidden) { artworkPending = false; applyPresentation(null, ticket); }
        console.warn("dashboard:artwork-failed", error);
      }
    }
    async function open(configName, full = false, captures = false, refresh = false, { keepFocus = false, localOnly = false, artworkDelay = 0, origin = null } = {}) {
      clearTimeout(artworkTimer);
      const ticket = ++revision, previousScroll = view.querySelector(".dashboard-details-scroll")?.scrollTop || 0;
      const preserveLibrary = view.hidden || (!expanded && !panel.classList.contains("dashboard-narrow-details"));
      if (preserveLibrary) libraryPosition = captureLibraryPosition();
      if (view.hidden) focusBack = document.activeElement;
      if (origin) focusBack = origin;
      if (name !== configName) aboutOpen = true;
      name = configName; expanded = full; data = null; if (!refresh) tab = captures ? "captures" : "overview";
      refreshing = artworkPending = false; statusKey = "";
      if (!window.__dashboardOpen) await window.openDashboard?.();
      if (!window.__dashboardOpen || ticket !== revision) return;
      view.hidden = false; panel.classList.toggle("has-game-page", expanded); panel.classList.toggle("has-game-preview", !expanded);
      restoreLibraryPosition(libraryPosition);
      if (!refresh) surface.replaceChildren(element("p", "hint", text("achievementMedia.checking", "Loading…"))); position(); notify(); restoreLibraryPosition(libraryPosition);
      try {
        const context = await window.api.getDashboardGameDetails(configName);
        if (ticket !== revision || view.hidden) return;
        if (!context?.config) { close({ force: true }); return; }
        data = { ...context, configName, schema: Array.isArray(context.schema) ? context.schema : [], saved: context.snapshot || {}, playtime: context.playtime || {} };
        const liveFocused = refresh && view.contains(document.activeElement) ? [...view.querySelectorAll("button,summary")].indexOf(document.activeElement) : -1;
        draw(ticket); position(); notify();
        if (document.activeElement === view) focusPreview();
        else if (refresh) { view.querySelector(".dashboard-details-scroll").scrollTop = previousScroll; if (liveFocused >= 0) view.querySelectorAll("button,summary")[liveFocused]?.focus({ preventScroll: true }); }
        else if (!keepFocus) [...view.querySelectorAll(".dashboard-details-window-actions button:not([hidden])")].at(-1)?.focus({ preventScroll: true });
        else if (panel.classList.contains("dashboard-narrow-details")) view.querySelector(".dashboard-details-achievements")?.focus({ preventScroll: true });
        if (!refresh && !localOnly) {
          if (artworkDelay > 0) artworkTimer = setTimeout(() => {
            if (ticket === revision && !view.hidden && window.__dashboardOpen) void ensureArtwork(ticket);
          }, artworkDelay);
          else void ensureArtwork(ticket);
        }
      } catch (error) {
        if (ticket === revision) surface.replaceChildren(button(text("achievementMedia.close", "Close"), close), element("p", "hint", text("achievementMedia.unavailable", "Unavailable")));
        console.warn("dashboard:details-failed", error);
      }
    }
    function action(command) {
      if (view.hidden || window.AchievementMediaViewer?.isOpen() || window.__dashboardContextMenuOpen || panel.querySelector("#dashboardViewMode[open],#dashboardSortMenu[open],select[data-sel-open='1']")) return false;
      if (command === "BACK") {
        if (tab === "captures") switchTab("overview", revision);
        else if (isPersistent() && !expanded && !view.contains(document.activeElement)) return false;
        else close();
        return true;
      }
      const hasFocus = view.contains(document.activeElement);
      if (!hasFocus && !expanded && !panel.classList.contains("dashboard-narrow-details")) return false;
      if (command === "PLAY") { if (data && !view.querySelector(".dashboard-details-play")?.disabled) play(name); return true; }
      if (command === "CONFIRM") {
        if (view.contains(document.activeElement)) document.activeElement.click();
        else window.DashboardNavigation?.focus(window.DashboardNavigation.initial());
        return true;
      }
      if (command === "MENU") { view.querySelector(".dashboard-details-links button:not(:disabled)")?.focus(); return true; }
      if (["UP", "DOWN", "LEFT", "RIGHT", "HOME", "END"].includes(command)) {
        window.DashboardNavigation?.move(command); return true;
      }
      return false;
    }
    document.addEventListener("keydown", event => {
      if (view.hidden || !window.__dashboardOpen || document.documentElement.classList.contains("settings-open") || window.GameArtworkControls?.isOpen() || window.AchievementMediaViewer?.isOpen() || window.__dashboardContextMenuOpen || panel.querySelector("#dashboardViewMode[open],#dashboardSortMenu[open],select[data-sel-open='1']") || view.closest("[inert]")) return;
      if (event.key === "Escape" && action("BACK")) { event.preventDefault(); event.stopImmediatePropagation(); }
      else if (event.key === "Tab" && window.DashboardNavigation?.tab(event.shiftKey)) { event.preventDefault(); event.stopImmediatePropagation(); }
    }, true);
    const layoutObserver = new ResizeObserver(position); layoutObserver.observe(panel); layoutObserver.observe(panel.querySelector("#dashboardHeader"));
    new MutationObserver(() => { if (!window.__dashboardOpen && !view.hidden) close(); }).observe(panel.parentElement, { attributes: true, attributeFilter: ["class", "aria-hidden"] });
    return { open, close, action, focus: focusPreview, isOpen: () => !view.hidden, current: () => name,
      isReady: () => !view.hidden && data?.configName === name,
      refreshAppearance() { if (data && !view.hidden) applyPresentation(null, revision); },
      updateLayout: position,
      follow: (configName, origin) => open(configName, expanded, tab === "captures", false, { keepFocus: true, artworkDelay: 250, origin }),
      async refreshArtwork(payload) {
        if (!data || view.hidden || (payload?.appid && String(payload.appid) !== String(data.config.appid)) ||
          (payload?.platform && data.config.platform && payload.platform !== data.config.platform)) return;
        const ticket = revision, updated = await window.api.getDashboardArtwork(name);
        if (ticket === revision && !view.hidden) applyPresentation({ artwork: updated }, ticket);
      },
      updatePlaytime(payload) { if (data && payload?.configName === name) { data.playtime = { ...data.playtime, ...payload }; const label = view.querySelector(".dashboard-details-playtime"); if (label) label.textContent = time(payload.totalMs); } },
      localize() { if (data) applyPresentation(null, revision); },
      refresh: () => { if (name) void open(name, expanded, tab === "captures", true); } };
  },
};
