"use strict";

// Runs in the real notification renderer, only when a screenshot is requested.
// Keep it self contained: main serialises this function into the page. It does
// not seek, pause or otherwise alter the preset's animations.
function installNotificationScreenshotReadiness(options = {}) {
  window.__achievementsScreenshotReadiness?.dispose();
  const startedAt = performance.now();
  const duration = Math.max(500, Number(options.durationMs) || 5000);
  const deadline = startedAt + duration;
  let timer = null;
  let disposed = false;
  let reported = false;
  let assetSignal = false;
  let stableSince = 0;
  let previousSignature = "";
  let last = { ready: false, reason: "waiting-for-content" };
  let obstruction = "";
  const normalize = (text) => String(text || "").replace(/\s+/g, " ").trim();
  const titleSelectors = "[data-notification-content='title'],.title,#title,.achievement-title";
  const descriptionSelectors = "[data-notification-content='desc'],.detail,.desc,#desc,.achievement-description,.achievement-desc";
  const motionProperties = ["opacity", "transform", "translate", "scale", "rotate",
    "width", "height", "maxWidth", "maxHeight", "clipPath", "left", "top",
    "right", "bottom", "marginLeft", "marginTop", "paddingLeft", "paddingTop"];

  function rendered(element) {
    if (!element?.isConnected || !normalize(element.textContent)) return false;
    for (let node = element; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.display === "none" || style.visibility !== "visible") return false;
    }
    return true;
  }

  // Only changing segments of finite content/plate animations gate the shot.
  // Full entry/hold/exit timelines are ready during their hold segment, not at
  // animationend. Infinite glow, particles and title marquees keep running.
  function moving(element) {
    for (const animation of element.getAnimations()) {
      const effect = animation.effect;
      const timing = effect?.getComputedTiming();
      if (!timing || timing.iterations === Infinity ||
          animation.playState === "finished" || animation.playState === "idle") continue;
      if (effect.target !== element || effect.pseudoElement) continue;
      if (/^(?:ach-hold|ach_current)$/.test(animation.animationName || "")) continue;
      if (!animation.animationName && element.matches(".marquee,.title-inner,.detail-inner") &&
          effect.getKeyframes().every((frame) => Object.keys(frame).every((key) =>
            ["offset", "computedOffset", "easing", "composite", "transform"].includes(key)))) continue;
      const activeTime = Number(animation.currentTime) - Number(effect.getTiming().delay || 0);
      if (activeTime < 0) {
        // Delayed image entries can start after the text is revealed. Wait for
        // those entries, while ignoring scheduled hold/exit animations.
        const name = animation.animationName || "";
        if (/^(?:icon-pop|icon-left)$/.test(name)) {
          obstruction = `pending-entry:${element.id || element.className}:${name}`;
          return true;
        }
        continue;
      }
      if (timing.progress === null) continue;
      const frames = effect.getKeyframes();
      const progress = timing.progress;
      for (const property of motionProperties) {
        const values = frames.filter((frame) => frame[property] !== undefined);
        if (values.length < 2) continue;
        for (let i = 1; i < values.length; i++) {
          if (progress >= values[i - 1].computedOffset && progress < values[i].computedOffset &&
              !sameValue(property, values[i - 1][property], values[i][property])) {
            obstruction = `moving:${element.id || element.className}:${animation.animationName || "web-animation"}:${property}`;
            return true;
          }
        }
      }
    }
    return false;
  }

  function sameValue(property, left, right) {
    if (left === right) return true;
    // Identity transforms can be authored as none, rotate(0deg), scale(1), etc.
    if (property === "transform") {
      try {
        const a = new DOMMatrix(left === "none" ? undefined : left).toFloat64Array();
        const b = new DOMMatrix(right === "none" ? undefined : right).toFloat64Array();
        return a.every((value, index) => Math.abs(value - b[index]) < 0.000001);
      } catch {}
    }
    return false;
  }

  function inheritsInfiniteMotion(element) {
    for (let node = element; node; node = node.parentElement) {
      if (node.getAnimations().some((animation) => animation.effect?.target === node &&
          animation.effect.getComputedTiming().iterations === Infinity &&
          animation.effect.getKeyframes().some((frame) =>
            ["transform", "translate", "scale", "rotate"].some((key) => frame[key] !== undefined)))) return true;
    }
    return false;
  }

  function inspect(element) {
    const reject = (reason) => { obstruction = `${reason}:${element.id || element.className}`; return null; };
    const rect = element.getBoundingClientRect();
    if (!(rect.width > 0 && rect.height > 0)) return reject("empty-text-slot");
    // Measure the text line rather than its full-width wrapper. Intentional
    // ellipsis/marquee remains supported; the visible slot must fit the plate.
    const range = document.createRange();
    range.selectNodeContents(element);
    const textRect = range.getBoundingClientRect();
    const bounds = {
      left: Math.max(rect.left, textRect.left), top: Math.max(rect.top, textRect.top),
      right: Math.min(rect.right, textRect.right), bottom: Math.min(rect.bottom, textRect.bottom),
    };
    if (!(bounds.right > bounds.left && bounds.bottom > bounds.top)) return reject("empty-text-bounds");
    // Custom presets override innerWidth/innerHeight to their original layout
    // rectangle. The document viewport still includes the glow paint gutter.
    if (bounds.left < -1 || bounds.top < -1 || bounds.right > document.documentElement.clientWidth + 1 ||
        bounds.bottom > document.documentElement.clientHeight + 1) return reject("outside-viewport");
    const signature = [];
    const infiniteMotion = inheritsInfiniteMotion(element);
    let opacity = 1;
    for (let node = element; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      opacity *= Number(style.opacity);
      if (style.display === "none" || style.visibility !== "visible" || opacity < 0.03) return reject("text-hidden");
      if (moving(node)) return null;
      const clip = node.getBoundingClientRect();
      if (node !== element && node !== document.body && node !== document.documentElement) {
        if (/hidden|clip|scroll|auto/.test(style.overflowX) &&
            (bounds.left < clip.left - 1 || bounds.right > clip.right + 1)) return reject(`horizontal-clip-${node.id || node.className}`);
        if (/hidden|clip|scroll|auto/.test(style.overflowY) &&
            (bounds.top < clip.top - 1 || bounds.bottom > clip.bottom + 1)) return reject(`vertical-clip-${node.id || node.className}`);
      }
      // Infinite decorative animations may move the plate slightly. Their
      // geometry is intentionally omitted from stability, but clipping and
      // opacity are still checked above on every paint.
      const infinite = node.getAnimations().some((animation) =>
        animation.effect?.target === node && animation.effect.getComputedTiming().iterations === Infinity);
      if (!infinite) {
        if (!infiniteMotion) signature.push([clip.x, clip.y, clip.width, clip.height]
          .map((number) => Math.round(number * 10)).join(","));
        signature.push(style.clipPath, style.opacity);
      }
    }
    return signature.join(";");
  }

  function sample() {
    obstruction = "";
    if (disposed) return { ready: false, reason: "disposed" };
    if (document.fonts?.status === "loading") return { ready: false, reason: "loading-fonts" };
    const san = !!options.san;
    const titles = [...document.querySelectorAll(san
      ? "[data-notification-content='title']" : titleSelectors)].filter(rendered);
    // SAN can move the title between rows or replace it with the game name.
    // Prefer the semantic row, including renamed/custom presets.
    const title = (san ? titles.find((el) => el.dataset.notificationContent === "title") : null) ||
      titles.find((el) => normalize(el.textContent).includes(normalize(options.displayName))) || titles[0];
    const fallback = san ? [...document.querySelectorAll("[data-notification-content]")].find(rendered) : null;
    const primary = title || fallback;
    if (!primary) return { ready: false, reason: "waiting-for-title" };
    // LAZ0RBOX's icon is itself an animated GIF. Its authored readiness signal
    // includes decode and a playback settle period; CSS visibility alone
    // cannot identify the GIF's displayed frame. Preserve this extra gate for
    // the base and its renamed custom copies.
    if (!san && document.querySelector(".ring-container") &&
        [...document.querySelectorAll(".icon img")].some((image) => /(?:^|\/)giphy\.gif(?:[?#]|$)/i.test(image.src)) &&
        !assetSignal) return { ready: false, reason: "waiting-for-gif-frame" };
    const sequential = (!san && !!document.querySelector(".achievement-banner .achievement-loader")) ||
      (san && ["xboxone", "xqjan"].includes(options.sanPreset));
    let required = [primary];
    if (!sequential) {
      const descriptions = [...document.querySelectorAll(san
        ? "[data-notification-content='desc']" : descriptionSelectors)].filter(rendered);
      // Duplicate native selectors may name the same nested row.
      required.push(...descriptions.filter((el) => !primary.contains(el) && !el.contains(primary)));
    }
    const signatures = required.map(inspect);
    if (signatures.some((value) => value === null)) return { ready: false, reason: obstruction || "content-entering-or-clipped" };
    const alternatingImage = !san && document.getAnimations().some((animation) =>
      animation.animationName === "iconPopOut");
    if (!sequential && !alternatingImage) {
      // Some panels reveal text while the achievement image is still sliding
      // across it (Epic Preset). The image's entry is part of the readable
      // stage too; decorative logos/particles are deliberately excluded.
      for (const image of document.querySelectorAll(
        ".icon img,.icon-container img,.icon-frame img,#achicon,img#icon,.ani_icon img,.badge img,img.achievement-icon",
      )) {
        if (!image.naturalWidth) continue;
        let opacity = 1;
        const infiniteMotion = inheritsInfiniteMotion(image);
        const imageSignature = [];
        for (let node = image; node; node = node.parentElement) {
          const style = getComputedStyle(node);
          if (style.display === "none" || style.visibility !== "visible") break;
          opacity *= Number(style.opacity);
          if (opacity < 0.03 || moving(node)) return { ready: false, reason: obstruction || "image-entering" };
          const rect = node.getBoundingClientRect();
          const infinite = node.getAnimations().some((animation) =>
            animation.effect?.target === node && animation.effect.getComputedTiming().iterations === Infinity);
          if (!infinite && !infiniteMotion) imageSignature.push([rect.x, rect.y, rect.width, rect.height]
            .map((number) => Math.round(number * 10)).join(","));
        }
        signatures.push(imageSignature.join(";"));
      }
    }
    // Decode relevant images before capture. Broken assets cannot become ready;
    // count them in diagnostics, while keeping text capture usable.
    let brokenImages = 0;
    for (const image of document.images) {
      if (!image.getAttribute("src")) continue;
      const style = getComputedStyle(image);
      if (style.display === "none" || style.visibility === "hidden") continue;
      if (!image.complete) return { ready: false, reason: "loading-images" };
      if (!image.naturalWidth) brokenImages++;
    }
    return { ready: true, reason: sequential ? "title-stage" : "content-stage",
      signature: signatures.join("|"), title: normalize(primary.textContent), brokenImages,
      elapsedMs: Math.round(performance.now() - startedAt) };
  }

  function tick() {
    if (disposed || reported) return;
    last = sample();
    const now = performance.now();
    if (last.ready) {
      if (last.signature !== previousSignature) stableSince = now;
      previousSignature = last.signature;
      // Entry motion is checked from its effective keyframes above. Keep a
      // short paint confirmation: some short SAN title stages last <200ms,
      // so a fixed extra 120ms would consume most of the capture opportunity.
      if (now - stableSince >= 32) {
        requestAnimationFrame(() => requestAnimationFrame(() => {
          if (disposed || reported) return;
          last = sample();
          if (!last.ready) { stableSince = performance.now(); previousSignature = ""; tick(); return; }
          reported = true;
          const { signature, ...details } = last;
          window.api?.notificationScreenshotReady?.(details);
        }));
        return;
      }
    } else {
      previousSignature = "";
      stableSince = now;
    }
    if (now >= deadline) {
      reported = true;
      window.api?.notificationScreenshotReady?.({ ready: false, reason: last.reason,
        elapsedMs: Math.round(now - startedAt) });
      return;
    }
    timer = setTimeout(() => requestAnimationFrame(tick), 30);
  }

  const controller = { check: sample, assetReady() { assetSignal = true; },
    dispose() { disposed = true; clearTimeout(timer); } };
  window.__achievementsScreenshotReadiness = controller;
  requestAnimationFrame(tick);
  return true;
}

module.exports = { installNotificationScreenshotReadiness };
