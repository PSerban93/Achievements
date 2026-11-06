"use strict";

// Dashboard focus is based on visible DOM nodes, never on indexes from another grid.
(() => {
  const panel = document.getElementById("dashboardPanel"), body = document.getElementById("dashboardBody");
  if (!panel || !body) return;
  const cardSelector = ".dash-card,.dashboard-collection-card";
  let input = "mouse", pointer = null;
  const visible = el => !!el?.isConnected && !el.disabled && !el.closest("[hidden],.hidden,[inert]") &&
    el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden" && getComputedStyle(el).display !== "none";
  const enabled = el => visible(el) && el.getAttribute("aria-disabled") !== "true" && !el.classList.contains("is-disabled");
  const expanded = () => panel.classList.contains("has-game-page") || panel.classList.contains("dashboard-narrow-details");
  const detail = () => document.getElementById("dashboardGameDetails");
  function noteInput(value) { input = value; window.__dashboardInputMode = value; }
  panel.addEventListener("pointermove", event => {
    if (event.pointerType && event.pointerType !== "mouse") return;
    if (pointer && (event.clientX !== pointer.x || event.clientY !== pointer.y)) noteInput("mouse");
    pointer = { x: event.clientX, y: event.clientY };
  }, { passive: true });
  function targets({ buttons = false } = {}) {
    const scope = expanded() && visible(detail()) ? detail() : panel;
    const selector = "button,input,select,summary,.dash-card,.dashboard-collection-card";
    return [...scope.querySelectorAll(selector)].filter(el => {
      if (!enabled(el)) return false;
      if (el.matches(cardSelector)) return true;
      const card = el.closest(cardSelector);
      if (card) return buttons && (card.contains(document.activeElement) || getComputedStyle(el).opacity !== "0");
      return !el.matches('input[type="hidden"]');
    });
  }
  function focus(el, { scroll = true } = {}) {
    if (!enabled(el)) return false;
    noteInput("navigation");
    el.focus({ preventScroll: true });
    const card = el.closest(cardSelector);
    if (card?.matches(".dash-card")) window.setActiveCard?.(card.dataset.name, card);
    if (scroll) el.scrollIntoView({ block: "nearest", inline: "nearest" });
    return document.activeElement === el;
  }
  function initial() {
    const available = targets(), cards = available.filter(el => el.matches(cardSelector));
    const rectangle = body.getBoundingClientRect();
    const inViewport = el => { const r = el.getBoundingClientRect(); return r.bottom > rectangle.top && r.top < rectangle.bottom; };
    return cards.find(el => el.classList.contains("active") && inViewport(el)) || cards.find(inViewport) || cards[0] || available[0];
  }
  function menuControls() {
    const menu = [...panel.querySelectorAll("#dashboardViewMode[open],#dashboardSortMenu[open]")].find(visible);
    return menu ? { menu, controls: [...menu.querySelectorAll("button")].filter(enabled), summary: menu.querySelector("summary") } : null;
  }
  function tab(reverse = false) {
    const menu = menuControls();
    const available = menu ? [menu.summary, ...menu.controls].filter(enabled) : targets({ buttons: true });
    if (!available.length) return false;
    const index = available.indexOf(document.activeElement);
    return focus(available[index < 0 ? reverse ? available.length - 1 : 0 : (index + (reverse ? -1 : 1) + available.length) % available.length]);
  }
  function move(command) {
    const menu = menuControls();
    if (menu) {
      const items = [menu.summary, ...menu.controls], current = items.indexOf(document.activeElement);
      const next = command === "HOME" ? 1 : command === "END" ? items.length - 1 :
        Math.max(0, Math.min(items.length - 1, current + (["UP", "LEFT"].includes(command) ? -1 : 1)));
      focus(items[next]); return;
    }
    const available = targets(), current = available.includes(document.activeElement) ? document.activeElement : document.activeElement?.closest(cardSelector);
    if (document.activeElement !== current && document.activeElement?.closest(cardSelector)) return moveFromControl(command);
    if (!available.includes(current)) {
      if (document.activeElement?.closest(cardSelector)) return moveFromControl(command);
      focus(initial()); return;
    }
    const grid = current.matches(cardSelector) ? current.parentElement : null;
    const siblings = grid ? [...grid.children].filter(el => el.matches(cardSelector) && enabled(el)) : null;
    if (command === "HOME" || command === "END") {
      const scope = current.closest("#dashboardGameDetails,#dashboardHeader");
      const group = siblings || available.filter(el => scope ? scope.contains(el) : !el.matches(cardSelector));
      focus(command === "HOME" ? group[0] : group.at(-1)); return;
    }
    if (siblings) {
      const columns = Math.max(1, getComputedStyle(grid).gridTemplateColumns.split(" ").filter(Boolean).length);
      const index = siblings.indexOf(current), offset = { LEFT: -1, RIGHT: 1, UP: -columns, DOWN: columns }[command];
      const next = index + offset;
      const sameRow = !["LEFT", "RIGHT"].includes(command) || Math.floor(index / columns) === Math.floor(next / columns);
      if (next >= 0 && next < siblings.length && sameRow) { focus(siblings[next]); return; }
    }
    spatial(current, available.filter(el => el !== current && !(grid && el.parentElement === grid)), command);
  }
  function spatial(current, available, command) {
    const direction = { LEFT: [-1, 0], RIGHT: [1, 0], UP: [0, -1], DOWN: [0, 1] }[command];
    if (!direction) return;
    const r = current.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
    const next = available.map(el => {
      const b = el.getBoundingClientRect(), dx = b.left + b.width / 2 - x, dy = b.top + b.height / 2 - y;
      const primary = dx * direction[0] + dy * direction[1], cross = Math.abs(dx * direction[1] - dy * direction[0]);
      return { el, primary, score: primary + cross * 2 };
    }).filter(item => item.primary > 4).sort((a, b) => a.score - b.score)[0];
    if (next) focus(next.el);
    else if (command === "RIGHT" && current.matches(".dash-card")) focus([...current.querySelectorAll("button")].find(enabled));
  }
  function moveFromControl(command) {
    const control = document.activeElement, card = control?.closest(cardSelector);
    if (!card || !enabled(card)) { focus(initial()); return; }
    if (command === "LEFT" || command === "UP") { focus(card); return; }
    const controls = [...card.querySelectorAll("button")].filter(enabled), index = controls.indexOf(control);
    if (command === "RIGHT" && index >= 0 && controls[index + 1]) focus(controls[index + 1]);
    else { focus(card, { scroll: false }); move(command); }
  }
  function confirm(openSelect) {
    const active = document.activeElement;
    if (targets({ buttons: true }).includes(active)) {
      if (active.tagName === "SELECT") openSelect?.(active);
      else if (!active.matches("input,textarea")) active.click();
    } else focus(initial());
  }
  function focusedCard() {
    const focused = document.activeElement?.closest(cardSelector);
    if (enabled(focused)) return focused;
    const available = targets().filter(el => el.matches(cardSelector));
    return available.find(el => el.classList.contains("active")) || available[0];
  }
  function play() { const button = focusedCard()?.querySelector(".dash-play"); if (enabled(button)) button.click(); }
  function context() {
    const card = focusedCard(); if (!card) return;
    const r = card.getBoundingClientRect();
    card.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.left + 20, clientY: r.top + 20 }));
  }
  function firstVisible() {
    const bounds = body.getBoundingClientRect();
    const card = targets().filter(el => el.matches(cardSelector)).find(el => { const r = el.getBoundingClientRect(); return r.bottom > bounds.top && r.top < bounds.bottom; });
    return card && focus(card, { scroll: false }) ? card : null;
  }
  window.DashboardNavigation = { visible, enabled, targets, focus, initial, tab, move, confirm, play, context, focusedCard, firstVisible, noteInput,
    getInputMode: () => input };
})();
