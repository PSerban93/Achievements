"use strict";
(function expose(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.DashboardGridLayout = api;
})(typeof globalThis !== "undefined" ? globalThis : this, () => {
  function columns({ width, cardWidth, gap, minimum, maximum, smallestWidth }) {
    const capacity = Math.max(1, Math.floor((width + gap) / (smallestWidth + gap)));
    const upper = Math.min(capacity, maximum > 0 ? maximum : Infinity);
    const lower = Math.min(minimum, upper);
    const natural = Math.max(1, Math.floor((width + gap) / (cardWidth + gap)));
    return Math.max(lower, Math.min(natural, upper));
  }
  function create(panel) {
    const selector = ".dashboard-grid,.dashboard-collection-cards", observed = new Set();
    let preferences = {}, frame = 0;
    function update(grid) {
      if (!preferences.dashboardCustomDensity) { grid.style.removeProperty("--dashboard-grid-columns"); return; }
      const style = getComputedStyle(grid);
      const width = grid.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0);
      if (width <= 0) return;
      const landscape = panel.dataset.cardLayout === "landscape";
      const value = String(columns({ width, cardWidth: landscape ? preferences.dashboardLandscapeCardWidth : preferences.dashboardPortraitCardWidth,
        gap: preferences.dashboardCardSpacing, minimum: preferences.dashboardMinCardsPerRow, maximum: preferences.dashboardMaxCardsPerRow,
        smallestWidth: landscape ? 220 : 140 }));
      if (grid.style.getPropertyValue("--dashboard-grid-columns") !== value) grid.style.setProperty("--dashboard-grid-columns", value);
    }
    function schedule() {
      if (!frame) frame = requestAnimationFrame(() => { frame = 0; observed.forEach(update); });
    }
    const resize = new ResizeObserver(schedule);
    function refresh() {
      for (const grid of observed) if (!grid.isConnected) { resize.unobserve(grid); observed.delete(grid); }
      for (const grid of panel.querySelectorAll(selector)) if (!observed.has(grid)) { observed.add(grid); resize.observe(grid); }
      observed.forEach(update);
    }
    new MutationObserver(schedule).observe(panel, { attributes: true, attributeFilter: ["data-card-layout"] });
    return { refresh, apply(next) { preferences = next; refresh(); } };
  }
  return { columns, create };
});
