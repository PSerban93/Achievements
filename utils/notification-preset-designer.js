(() => {
  let options = window.__achievementsDesignerOptions || {};
  const selectors = [
    ".hellblade-shell > .banner", ".bat-shell > .banner",
    ".overlay .award-container", ".wrapper#outerwrapper", ".notification", ".dock",
    ".achievement-container > .arcade-card",
    ".achievement-container > .achievement", ".overlay > .shell",
    ".shell > .banner", ".ach",
  ];
  const surface = () => selectors.map((selector) => document.querySelector(selector)).find(Boolean) ||
    document.body?.firstElementChild;
  let cachedVisualSurface = null;
  let activeGlowSurface = null;
  const visualSurface = (root) => {
    if (cachedVisualSurface?.isConnected) return cachedVisualSurface;
    const rootRect = root.getBoundingClientRect();
    const candidates = [root, ...root.querySelectorAll("div, section, article")];
    let best = root;
    let bestArea = 0;
    for (const candidate of candidates) {
      if (candidate !== root &&
          /(?:^|\s)(?:icon|logo|loader|badge|glow|progress)(?:-|\s|$)/i.test(candidate.className || "")) continue;
      const rect = candidate.getBoundingClientRect();
      if (rect.width < rootRect.width * 0.45 ||
          rect.height < rootRect.height * 0.45) continue;
      const style = getComputedStyle(candidate);
      if (style.backgroundImage === "none" &&
          ["transparent", "rgba(0, 0, 0, 0)"].includes(style.backgroundColor)) continue;
      const area = rect.width * rect.height;
      if (area >= bestArea) {
        best = candidate;
        bestArea = area;
      }
    }
    cachedVisualSurface = best;
    best.dataset.achievementsDesignerVisualSurface = "true";
    return best;
  };
  const assetUrl = (name) => name ? new URL(name, options.assetBaseUrl || document.baseURI).href : "";
  const fileUrl = (name) => {
    if (!name) return "";
    if (/^file:/i.test(name)) return name;
    return `file:///${String(name).replace(/\\/g, "/").replace(/^\/+/, "")}`;
  };
  const achievementIcon = (root) => root.querySelector(
    "img.icon, .icon img:not(.laurel-wreath), img.achievement-icon, .achievement-icon img, .icon-frame img, .ani_icon img, .badge img, #icon, .icon-container img",
  );
  const originalIconTranslations = new WeakMap();
  const nativeLogoSlots = new WeakMap();
  const LOGO_HIDE_SELECTOR = ".xbox-logo, .platform-logo, .steam-logo, .ps-logo, img[src$='psicon.png'], img[src$='steamicon.png'], [data-achievements-designer-native-logo]";
  const logoSlot = (root) => {
    const cached = nativeLogoSlots.get(root);
    if (cached?.element.isConnected && root.contains(cached.element)) return cached;
    const img = root.querySelector("img[data-achievements-designer-native-logo], img[src$='psicon.png'], img[src$='steamicon.png']");
    const glyph = root.querySelector(".achievement-trophy.xbox-logo");
    const slot = img ? { kind: "img", element: img }
      : glyph ? { kind: "glyph", element: glyph } : null;
    if (slot) {
      slot.element.setAttribute("data-achievements-designer-native-logo", "");
      nativeLogoSlots.set(root, slot);
    }
    return slot;
  };
  const clearInlineLogo = (root) => {
    root.querySelectorAll(".achievements-designer-logo-inline").forEach((element) => element.remove());
    root.querySelectorAll(".achievement-trophy.xbox-logo").forEach((element) => {
      element.style.fontSize = "";
      element.style.lineHeight = "";
    });
  };
  // Text-driven height must not move a user-positioned corner between normal,
  // rare and Platinum samples. Measure the authored plate without payload text;
  // keep its centre and animation transform, rather than freezing its layout.
  const placementHeightAttribute = "data-achievements-designer-placement-height";
  const capturePlacementGeometry = () => {
    const root = (options.placementSelector ? document.querySelector(options.placementSelector) : null) || surface();
    if (!root || root === document.body || !root.parentElement) return;
    root.removeAttribute(placementHeightAttribute);
    const parentStyle = getComputedStyle(root.parentElement);
    const style = getComputedStyle(root);
    const column = parentStyle.flexDirection.startsWith("column");
    const alignment = column ? parentStyle.justifyContent
      : style.alignSelf === "auto" ? parentStyle.alignItems : style.alignSelf;
    const centred = parentStyle.display.includes("flex") ? alignment === "center"
      : parentStyle.display.includes("grid") &&
        (alignment === "center" || parentStyle.alignContent === "center");
    // Fixed/animated heights and non-centred layouts retain their own geometry.
    if (!centred ||
        !["static", "relative"].includes(style.position) ||
        root.computedStyleMap?.().get("height")?.toString() !== "auto" ||
        !(root.offsetWidth > 0 && root.offsetHeight > 0)) return;
    const measure = root.cloneNode(true);
    measure.removeAttribute(placementHeightAttribute);
    measure.querySelectorAll(".title,.title-inner,.detail,.desc,.desc-inner," +
      ".achievement-title,.achievement-description,.achievement-desc,#title,#desc,#unlockmsg")
      .forEach((element) => element.replaceChildren());
    for (const [property, value] of Object.entries({
      position: "absolute", visibility: "hidden", animation: "none", transition: "none",
      transform: "none", translate: "none", pointerEvents: "none", margin: "0",
      width: `${root.offsetWidth}px`, boxSizing: "border-box",
    })) measure.style.setProperty(property.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`), value, "important");
    let height;
    try {
      root.parentElement.appendChild(measure);
      height = measure.offsetHeight;
    } finally { measure.remove(); }
    if (height > 0) root.setAttribute(placementHeightAttribute, String(height));
  };
  const placementRect = (root, rect = root.getBoundingClientRect()) => {
    const height = Number(root.getAttribute(placementHeightAttribute));
    if (!(height > 0 && root.offsetHeight > 0) ||
        root.computedStyleMap?.().get("height")?.toString() !== "auto") return rect;
    const stableHeight = height * rect.height / root.offsetHeight;
    const top = rect.top + (rect.height - stableHeight) / 2;
    return { ...rect.toJSON(), y: top, top, bottom: top + stableHeight, height: stableHeight };
  };
  window.__achievementsDesignerCapturePlacement = capturePlacementGeometry;
  // Position outside clipped artwork layers using the plate's painted rectangle.
  // Coordinates and offsets stay local to the preset regardless of its screen anchor.
  const positionFloatingAsset = (element) => {
    const root = element.__achievementsDesignerRoot;
    const anchor = element.__achievementsDesignerAnchor || root;
    if (!element.isConnected || !root?.isConnected || !anchor?.isConnected) {
      element.__achievementsDesignerPositioning = false;
      return;
    }
    const measured = root.getBoundingClientRect();
    const plate = placementRect(root, measured);
    const spec = element.__achievementsDesignerPlacement;
    const scaleX = root.offsetWidth > 0 ? measured.width / root.offsetWidth : 1;
    const scaleY = root.offsetHeight > 0 ? measured.height / root.offsetHeight : scaleX;
    const width = spec.size * scaleX;
    const height = spec.size * scaleY;
    const x = spec.corner.endsWith("left") ? plate.left + 8 * scaleX
      : spec.corner.endsWith("right") ? plate.right - width - 8 * scaleX
        : plate.left + (plate.width - width) / 2;
    const y = spec.corner.startsWith("top") ? plate.top + 8 * scaleY
      : spec.corner.startsWith("middle") ? plate.top + (plate.height - height) / 2
        : plate.bottom - height - 8 * scaleY;
    element.style.left = `${x + spec.offsetX * scaleX}px`;
    element.style.top = `${y + spec.offsetY * scaleY}px`;
    element.style.width = `${width}px`;
    element.style.height = `${height}px`;
    let visible = plate.width > 0 && plate.height > 0;
    let opacity = 1;
    for (let node = anchor; visible && node instanceof Element; node = node.parentElement) {
      const style = getComputedStyle(node);
      opacity *= Number(style.opacity);
      visible = style.display !== "none" && style.visibility === "visible";
    }
    element.style.opacity = String(opacity);
    element.style.visibility = visible ? "visible" : "hidden";
    // Detached assets live outside the clipped plate, so they do not inherit
    // its filter. Read the animated value to keep their Glow in the same phase.
    element.style.filter = activeGlowSurface?.isConnected
      ? getComputedStyle(activeGlowSurface).filter.replace(/(-?[\d.]+)px\b/g,
          (_, pixels) => `${Number(pixels) * scaleX}px`) : "none";
    element.__achievementsDesignerPositionFrame = requestAnimationFrame(() => positionFloatingAsset(element));
  };
  const floatingAsset = (root, className, image, size, corner, offsetX, offsetY, anchor = root) => {
    let element = document.querySelector(`.${className}`);
    if (!element) {
      element = document.createElement("img");
      element.className = className;
      element.alt = "";
    }
    if (element.parentElement !== document.documentElement) document.documentElement.appendChild(element);
    if (element.src !== image) element.src = image;
    Object.assign(element.style, { position: "fixed", zIndex: "2147483646",
      pointerEvents: "none", objectFit: "contain", display: "block",
      right: "auto", bottom: "auto", transform: "none", translate: "none" });
    element.__achievementsDesignerRoot = root;
    element.__achievementsDesignerAnchor = anchor;
    element.__achievementsDesignerPlacement = { size: Number(size) || 32, corner,
      offsetX: Number(offsetX) || 0, offsetY: Number(offsetY) || 0 };
    if (!element.__achievementsDesignerPositioning) {
      element.__achievementsDesignerPositioning = true;
      positionFloatingAsset(element);
    }
    return element;
  };
  const cssTimeToMilliseconds = (value) => {
    if (typeof value !== "string") return NaN;
    const trimmed = value.trim();
    if (trimmed.endsWith("ms")) return parseFloat(trimmed);
    if (trimmed.endsWith("s")) return parseFloat(trimmed) * 1000;
    return NaN;
  };
  const backgroundAlpha = (value) => {
    if (typeof value !== "string") return 1;
    const trimmed = value.trim();
    if (!trimmed || trimmed === "transparent") return 0;
    const match = trimmed.match(/rgba?\(([^)]*)\)/i);
    if (!match) return 1;
    const parts = match[1].split(",").map((part) => parseFloat(part.trim()));
    const alpha = parts.length >= 4 ? parts[3] : 1;
    return Number.isFinite(alpha) ? Math.max(0, Math.min(1, alpha)) : 1;
  };
  // The Xbox preset fades its solid fill in and out through background-color
  // keyframes on the banner, so blanking the banner and painting a static
  // gradient/game-cover layer behind it froze the reveal: the artwork was
  // visible during the pre-delay with no fade-in. Mirror those fill keyframes
  // onto the backdrop layer's opacity and share the stock animation's start
  // time: the artwork then hides during the delay, fades in along the exact
  // same curve and fades out at the end, just like the solid colour does.
  const XBOX_FILL_ANIMATIONS = [
    "mainAnimationFrames",
    "mainManualEnterFrames",
    "mainManualExitFrames",
  ];
  const syncXboxBackgroundReveal = (banner, layer) => {
    if (!banner?.getAnimations || !layer?.animate) return;
    const computed = getComputedStyle(banner);
    const names = (computed.animationName || "").split(",").map((name) => name.trim());
    const durations = (computed.animationDuration || "").split(",").map(cssTimeToMilliseconds);
    const delays = (computed.animationDelay || "").split(",").map(cssTimeToMilliseconds);
    const easings = (computed.animationTimingFunction || "").split(",").map((name) => name.trim());
    (layer.getAnimations?.() || []).forEach((animation) => animation.cancel());
    banner.getAnimations().forEach((animation) => {
      if (!XBOX_FILL_ANIMATIONS.includes(animation.animationName)) return;
      const effect = animation.effect;
      const source = typeof effect?.getKeyframes === "function" ? effect.getKeyframes() : null;
      if (!Array.isArray(source) || !source.some((frame) => frame?.backgroundColor != null)) return;
      const index = names.indexOf(animation.animationName);
      const duration = Number.isFinite(durations[index]) ? durations[index] : 1000;
      const delay = Number.isFinite(delays[index]) ? delays[index] : 0;
      const frames = source
        .filter((frame) => frame && frame.offset != null && frame.backgroundColor != null)
        .map((frame) => ({
          offset: Math.max(0, Math.min(1, frame.offset)),
          opacity: String(backgroundAlpha(frame.backgroundColor)),
        }));
      if (!frames.length) return;
      if (!frames.some((frame) => frame.offset === 0)) frames.unshift({ offset: 0, opacity: "0" });
      if (!frames.some((frame) => frame.offset === 1)) frames.push({ offset: 1, opacity: "0" });
      frames.sort((left, right) => left.offset - right.offset);
      // Fill behaviour per mirror: the auto keyframes already fade in and out
      // (both). Manual enter must hide before it starts (backwards) and manual
      // exit must hold the fill during its long delay and land on 0 (forwards),
      // otherwise a mirror would leak opacity into another mirror's phase.
      const fill = animation.animationName === "mainAnimationFrames"
        ? "both"
        : animation.animationName === "mainManualEnterFrames"
          ? "backwards"
          : animation.animationName === "mainManualExitFrames"
            ? "forwards"
            : "both";
      const mirror = layer.animate(frames, {
        duration,
        delay,
        easing: easings[index] || "linear",
        iterations: 1,
        fill,
      });
      // Lock the layer to the banner timeline so a late update() (or the preview
      // timeline driver) keeps the reveal exactly in step with the stock fill.
      if (animation.startTime != null) mirror.startTime = animation.startTime;
      if (window.__achievementsPreviewClock && animation.playState === "paused") {
        mirror.pause();
        mirror.currentTime = animation.currentTime;
      }
    });
  };
  // The Xbox rings use two alternating shades. When the designer takes over the
  // backdrop (gradient / game cover / blur — the banner is blanked and a layer
  // shows the artwork) the rings must follow the Customisation Background /
  // Secondary colour pickers: odd rings get the main colour, even rings the
  // secondary one. The rings are painted as lighter variants of those colours
  // (mixed towards white) so they stay visible while the backdrop fades in and
  // out beneath them — exactly like the default preset's lighter green rings
  // on the darker pill; the exact picker hex would merge with the gradient.
  // Unset pickers fall back to the preset's own .achievement-loader rules
  // (style.css is not rewritten at save time) so an unedited preset keeps its
  // ring colours.
  const paintXboxLoaderColors = (banner) => {
    const loaders = banner.querySelectorAll(".achievement-loader");
    if (!loaders.length) return;
    const main = options.background;
    const secondary = options.background2;
    if (!main && !secondary) return;
    const byIndex = new Map();
    const rules = [...document.styleSheets].flatMap((sheet) => {
      try { return [...sheet.cssRules]; } catch { return []; }
    });
    for (const rule of rules) {
      if (rule.type !== CSSRule.STYLE_RULE) continue;
      const match = String(rule.selectorText || "").match(
        /^\.achievement-loader(?::nth-of-type\((\d+)\))?$/,
      );
      if (!match) continue;
      const color = rule.style.backgroundColor;
      if (color) byIndex.set(match[1] ? Number(match[1]) - 1 : 0, color);
    }
    loaders.forEach((element, index) => {
      const source = index % 2 === 0 ? main : secondary;
      const base = source || byIndex.get(index) || byIndex.get(0);
      if (!base) return;
      element.style.setProperty(
        "background-color",
        `color-mix(in srgb, ${base} 60%, white)`,
        "important",
      );
    });
  };
  const applyOptions = (data = {}) => {
    const root = surface();
    if (!root) return;
    let fontStyle = document.getElementById("achievements-designer-font");
    if (options.customFont) {
      if (!fontStyle) {
        fontStyle = document.createElement("style");
        fontStyle.id = "achievements-designer-font";
        document.head.appendChild(fontStyle);
      }
      fontStyle.textContent = `@font-face{font-family:AchievementsDesignerFont;src:url(${JSON.stringify(assetUrl(options.customFont))})}
        .title,.title-inner,.detail,.desc,.desc-inner,.achievement-title,.achievement-description,.achievement-desc,#title,#desc,#unlockmsg{font-family:AchievementsDesignerFont,sans-serif!important}`;
    } else fontStyle?.remove();
    const icon = achievementIcon(root);
    if (icon && (options.iconOffsetX || options.iconOffsetY)) {
      const slot = icon.closest(".icon-container,.icon-frame,.ani_icon,.icon") || icon;
      if (!originalIconTranslations.has(slot))
        originalIconTranslations.set(slot, getComputedStyle(slot).translate);
      const original = originalIconTranslations.get(slot);
      const [x = "0px", y = "0px"] = original === "none" ? [] : original.split(/\s+/);
      slot.style.setProperty("translate", `calc(${x} + ${Number(options.iconOffsetX) || 0}px) calc(${y} + ${Number(options.iconOffsetY) || 0}px)`, "important");
    }
    if (options.applyEffects) {
      const effects = options.effects || {};
      const effectFields = new Set(options.effectFields || Object.keys(effects));
      const changedEffect = (...keys) => keys.some((key) => effectFields.has(key));
      const target = options.visualFallback ? visualSurface(root)
        : document.querySelector(options.borderSelector || options.backgroundSelector || "") || root;
      if (changedEffect("useoutline") && !effects.useoutline)
        target.style.setProperty("border-style", "none", "important");
      const shadow = effects.fontshadow
        ? Array(3).fill(`${effects.fontshadowx}px ${effects.fontshadowy}px 1px ${effects.fontshadowcolor}`).join(",") : "none";
      if (changedEffect("fontshadow", "fontshadowcolor", "fontshadowx", "fontshadowy"))
        root.querySelectorAll(".title,.title-inner,.detail,.detail-inner,.desc,.desc-inner,.achievement-title,.achievement-description,.achievement-desc,#title,#desc")
          .forEach((element) => element.style.setProperty("text-shadow", shadow, "important"));
      if (changedEffect("glow", "glowcolor", "glowanim", "glowsize") && !root.__designerGlowApplied) {
        root.__designerGlowApplied = true;
        if (effects.glow) {
          const glowSurface = root.closest(".hellblade-shell,.bat-shell,.achievement-container,.overlay,.wrapper#outerwrapper") || root;
          activeGlowSurface = glowSurface;
          glowSurface.style.setProperty("--glowsize", `${Number(effects.glowsize) * 0.096}px`);
          glowSurface.style.setProperty("--glowcolor", effects.glowcolor);
          const originalFilter = getComputedStyle(glowSurface).filter;
          const prefix = originalFilter === "none" ? "" : `${originalFilter} `;
          glowSurface.style.filter = `${prefix}drop-shadow(0 0 var(--glowsize) var(--glowcolor))`;
          if (effects.glowanim !== "off") {
            // Use SAN's actual glow keyframes, independently of preset motion.
            const rules = [...document.styleSheets].flatMap((sheet) => {
              try { return [...sheet.cssRules]; } catch { return []; }
            });
            const keyframes = rules.find((rule) => rule.name === `achievements-designer-${effects.glowanim}`);
            if (keyframes) {
              const frames = [...keyframes.cssRules].flatMap((rule) =>
                rule.keyText.split(",").map((key) => ({
                  offset: key.trim() === "from" ? 0 : key.trim() === "to" ? 1 : parseFloat(key) / 100,
                  filter: prefix + rule.style.filter,
                })));
              glowSurface.animate(frames, { duration: 7500, iterations: Infinity, easing: "linear" });
            }
          }
        }
      }
    }

    if (options.visualFallback && (options.applyColors || options.applyRadius || options.applyBorder)) {
      const target = visualSurface(root);
      if (options.applyColors) {
        const paint = options.gradient
          ? `linear-gradient(${options.gradientAngle}deg,${options.background},${options.background2})`
          : options.background;
        target.style.setProperty("background", paint, "important");
      }
      if (options.applyRadius) {
        target.style.setProperty("border-radius", `${options.radius}px`, "important");
        if (getComputedStyle(target).overflow === "visible")
          target.style.setProperty("overflow", "hidden", "important");
      }
      if (options.applyBorder) {
        target.style.setProperty("border", `${options.borderWidth}px solid ${options.accent}`, "important");
        target.style.setProperty("box-sizing", "border-box", "important");
      }
    }

    if (options.backgroundMode === "gamecover") {
      const header = fileUrl(data.headerPath);
      if (header) {
        if (options.xboxLayered || options.gameCoverCard) {
          // Xbox uses the banner layer below; Game Cover has its own image layer.
        } else if (options.steamCard) {
          root.style.setProperty("--bg-image", `url("${header}")`, "important");
        } else if (options.hellbladeBanner || options.batmanBanner) {
          root.style.setProperty("--achievements-designer-cover", `url("${header}")`);
          root.dataset.achievementsDesignerCover = "true";
        } else {
          const target = document.querySelector(options.backgroundSelector || "") || root;
          const transparency = Math.max(0, Math.min(100,
            Number(options.backgroundCoverTransparency) || 0));
          const mainTint = `color-mix(in srgb, ${options.background || "#171a21"} ${transparency}%, transparent)`;
          const secondaryTint = `color-mix(in srgb, ${options.background2 || "#252b36"} ${transparency}%, transparent)`;
          const angle = Math.max(0, Math.min(360, Number(options.gradientAngle) || 135));
          target.style.setProperty("background-image",
            `linear-gradient(${angle}deg,${mainTint},${secondaryTint}),linear-gradient(rgba(0,0,0,.35),rgba(0,0,0,.65)),url("${header}")`, "important");
          target.style.setProperty("background-size", "cover", "important");
          target.style.setProperty("background-position", "center", "important");
        }
      }
    }

    const blurPixels = ["gamecover", "image"].includes(options.backgroundMode)
      ? Math.max(0, Math.min(4, Number(options.backgroundBlur) / 50 || 0)) : 0;
    const needsXboxArtwork = options.xboxLayered &&
      ["image", "gamecover"].includes(options.backgroundMode);
    const xboxGradientFill = Boolean(options.xboxLayered &&
      options.backgroundMode === "colors" && options.gradient &&
      options.backgroundColorsChanged);
    if ((blurPixels > 0 || needsXboxArtwork || xboxGradientFill) &&
        !options.steamCard && !options.hellbladeBanner &&
        !options.batmanBanner &&
        !(options.gameCoverCard && options.backgroundMode === "gamecover")) {
      const target = options.xboxLayered
        ? root.querySelector(".achievement-banner")
        : options.visualFallback ? visualSurface(root)
          : document.querySelector(options.backgroundSelector || "") || root;
      if (target) {
        const style = getComputedStyle(target);
        if (!target.__achievementsDesignerBackground) {
          target.__achievementsDesignerBackground = {
            image: style.backgroundImage,
            color: style.backgroundColor,
          };
        }
        const original = target.__achievementsDesignerBackground;
        const cover = options.backgroundMode === "gamecover" ? fileUrl(data.headerPath) : "";
        const image = options.backgroundMode === "image"
          ? assetUrl(options.backgroundImage) : "";
        const tint = Math.max(0, Math.min(100, Number(options.backgroundCoverTransparency) || 0));
        const mainTint = `color-mix(in srgb, ${options.background || "#171a21"} ${tint}%, transparent)`;
        const secondaryTint = `color-mix(in srgb, ${options.background2 || "#252b36"} ${tint}%, transparent)`;
        const angle = Math.max(0, Math.min(360, Number(options.gradientAngle) || 135));
        const artwork = image || cover;
        let clip = target.querySelector(":scope > .achievements-designer-background-clip");
        if (!clip) {
          clip = document.createElement("div");
          clip.className = "achievements-designer-background-clip";
          Object.assign(clip.style, {
            position: "absolute", inset: "0", borderRadius: "inherit",
            overflow: "hidden", pointerEvents: "none", zIndex: "-1",
          });
          target.prepend(clip);
        }
        let layer = clip.querySelector(".achievements-designer-blurred-background");
        if (!layer) {
          layer = document.createElement("div");
          layer.className = "achievements-designer-blurred-background";
          clip.appendChild(layer);
        }
        layer.style.backgroundImage = artwork
          ? `linear-gradient(${angle}deg,${mainTint},${secondaryTint}),url("${artwork}")`
          : xboxGradientFill
            ? `linear-gradient(${angle}deg,${options.background},${options.background2})`
            : original.image !== "none" ? original.image
              : "none";
        layer.style.backgroundColor = artwork ? "transparent"
          : options.xboxLayered && options.backgroundMode === "colors"
            ? options.background || original.color : original.color;
        layer.style.backgroundSize = "cover";
        layer.style.backgroundPosition = "center";
        layer.style.position = "absolute";
        layer.style.inset = `${-Math.ceil(blurPixels * 2)}px`;
        layer.style.filter = blurPixels > 0 ? `blur(${blurPixels}px)` : "none";
        layer.style.pointerEvents = "none";
        layer.style.zIndex = "-1";
        if (options.xboxLayered) {
          layer.dataset.achievementsDesignerVisualSurface = "true";
        }
        if (style.position === "static") target.style.position = "relative";
        target.style.isolation = "isolate";
        target.style.setProperty("background", "transparent", "important");
        if (options.xboxLayered) {
          paintXboxLoaderColors(target);
          syncXboxBackgroundReveal(target, layer);
        }
      }
    }

    if (options.achievementImage) {
      const image = achievementIcon(root);
      if (image) {
        const wanted = assetUrl(options.achievementImage);
        const enforce = () => { if (image.src !== wanted) image.src = wanted; };
        enforce();
        if (!image.__achievementsDesignerIconObserver) {
          const observer = new MutationObserver(enforce);
          observer.observe(image, { attributes: true, attributeFilter: ["src"] });
          image.__achievementsDesignerIconObserver = observer;
        }
      }
    }

    const slot = options.logoMode === "custom" && options.logoImage &&
      options.logoUseNativeSlot !== false ? logoSlot(root) : null;
    if (options.logoMode && options.logoMode !== "original") {
      root.querySelectorAll(LOGO_HIDE_SELECTOR)
        .forEach((element) => {
          if (slot && element === slot.element) return;
          element.style.display = "none";
        });
    }
    if (options.logoMode === "custom" && options.logoImage) {
      const src = assetUrl(options.logoImage);
      if (slot) document.querySelectorAll(".achievements-designer-logo").forEach((element) => element.remove());
      if (slot?.kind === "img") {
        clearInlineLogo(root);
        slot.element.style.display = "";
        slot.element.removeAttribute("height");
        slot.element.removeAttribute("width");
        slot.element.style.maxWidth = "100%";
        slot.element.style.maxHeight = "100%";
        slot.element.style.objectFit = "contain";
        if (slot.element.src !== src) slot.element.src = src;
      } else if (slot?.kind === "glyph") {
        const box = slot.element;
        box.style.display = "";
        const measured = box.getBoundingClientRect();
        box.style.fontSize = "0px";
        box.style.lineHeight = "0";
        let logo = box.querySelector(":scope > img.achievements-designer-logo-inline");
        if (!logo) {
          logo = document.createElement("img");
          logo.className = "achievements-designer-logo-inline";
          logo.alt = "";
          box.appendChild(logo);
        }
        if (logo.src !== src) logo.src = src;
        const size = measured.height >= 16 && measured.height <= 128
          ? Math.round(measured.height)
          : Number(options.logoSize) || 32;
        logo.style.display = "block";
        logo.style.width = `${size}px`;
        logo.style.height = `${size}px`;
        logo.style.objectFit = "contain";
      } else {
        clearInlineLogo(root);
        const plate = (options.placementSelector ? document.querySelector(options.placementSelector) : null) || root;
        floatingAsset(plate, "achievements-designer-logo", src, options.logoSize,
          options.logoPosition || "topright", options.logoOffsetX, options.logoOffsetY);
      }
    } else {
      clearInlineLogo(root);
      document.querySelectorAll(".achievements-designer-logo").forEach((element) => element.remove());
    }
    const originalDecoration = root.querySelector(
      "img.laurel-wreath, .ring-container .ringring",
    );
    if (options.decorationChanged && originalDecoration) {
      originalDecoration.style.display = options.decorationMode === "original"
        ? "" : "none";
    }
    if (options.decorationMode === "custom" && options.decorationImage) {
      const icon = achievementIcon(root);
      if (icon) {
        const plate = (options.placementSelector ? document.querySelector(options.placementSelector) : null) || root;
        floatingAsset(plate, "achievements-designer-decoration", assetUrl(options.decorationImage),
          options.decorationSize, options.decorationPosition || "bottomleft",
          options.decorationOffsetX, options.decorationOffsetY, icon);
      }
    }

    if (options.showDescription === false) {
      root.querySelectorAll(".detail, .desc, .achievement-description, .achievement-desc, #desc")
        .forEach((element) => { element.style.setProperty("display", "none", "important"); });
    }

    // Apply after the fallback's border shorthand, which resets border-style.
    if (options.applyEffects && options.effects?.useoutline === false &&
        (!options.effectFields || options.effectFields.includes("useoutline"))) {
      const target = options.visualFallback ? visualSurface(root)
        : document.querySelector(options.borderSelector || options.backgroundSelector || "") || root;
      target.style.setProperty("border-style", "none", "important");
    }
    // Border/image/layout edits can change the authored reference too. Re-read
    // it after overrides, and place detached assets immediately even when paused.
    capturePlacementGeometry();
    document.querySelectorAll(".achievements-designer-logo,.achievements-designer-decoration")
      .forEach((element) => {
        if (element.__achievementsDesignerPositionFrame)
          cancelAnimationFrame(element.__achievementsDesignerPositionFrame);
        positionFloatingAsset(element);
      });

  };
  // Remember only changes made by the designer. Preview updates must undo an
  // old override without resetting the preset's own classes, styles or timers.
  const previewStyles = new Map();
  const previewAttributes = new Map();
  const previewAnimations = new Set();
  const trackedAttributes = ["src", "width", "height", "data-achievements-designer-cover",
    "data-achievements-designer-visual-surface", "data-achievements-designer-native-logo"];
  const readStyle = (element) => new Map(Array.from(element.style || []).map((property) =>
    [property, [element.style.getPropertyValue(property), element.style.getPropertyPriority(property)]]));
  const update = (data = {}) => {
    if (!window.__achievementsPreviewClock) return applyOptions(data);
    const before = new Map(Array.from(document.querySelectorAll("body, body *")).map((element) =>
      [element, { style: readStyle(element), attributes: new Map(trackedAttributes.map((name) =>
        [name, element.getAttribute(name)])) }]));
    const animations = new Set(document.getAnimations({ subtree: true }));
    applyOptions(data);
    for (const [element, original] of before) {
      const current = readStyle(element);
      for (const property of new Set([...original.style.keys(), ...current.keys()])) {
        const old = original.style.get(property) || ["", ""];
        const value = current.get(property) || ["", ""];
        if (old[0] === value[0] && old[1] === value[1]) continue;
        if (!previewStyles.has(element)) previewStyles.set(element, new Map());
        const saved = previewStyles.get(element);
        saved.set(property, { original: saved.get(property)?.original || old, value });
      }
      for (const name of trackedAttributes) {
        const old = original.attributes.get(name);
        const value = element.getAttribute(name);
        if (old === value) continue;
        if (!previewAttributes.has(element)) previewAttributes.set(element, new Map());
        const saved = previewAttributes.get(element);
        saved.set(name, { original: saved.has(name) ? saved.get(name).original : old, value });
      }
    }
    for (const animation of document.getAnimations({ subtree: true })) {
      if (!animations.has(animation) && !animation.animationName && !animation.transitionProperty)
        previewAnimations.add(animation);
    }
  };
  const restorePreviewOverrides = () => {
    for (const animation of previewAnimations) animation.cancel();
    previewAnimations.clear();
    document.querySelectorAll("body, body *").forEach((element) => {
      element.__achievementsDesignerIconObserver?.disconnect();
      delete element.__achievementsDesignerIconObserver;
      delete element.__achievementsDesignerBackground;
      delete element.__designerGlowApplied;
    });
    for (const [element, properties] of previewStyles) {
      for (const [property, { original, value }] of properties) {
        if (element.style.getPropertyValue(property) !== value[0] ||
            element.style.getPropertyPriority(property) !== value[1]) continue;
        if (original[0]) element.style.setProperty(property, ...original);
        else element.style.removeProperty(property);
      }
    }
    previewStyles.clear();
    for (const [element, attributes] of previewAttributes) {
      for (const [name, { original, value }] of attributes) {
        if (element.getAttribute(name) !== value) continue;
        if (original == null) element.removeAttribute(name);
        else element.setAttribute(name, original);
      }
    }
    previewAttributes.clear();
    document.querySelectorAll(".achievements-designer-background-clip,.achievements-designer-logo," +
      ".achievements-designer-logo-inline,.achievements-designer-decoration").forEach((element) => {
        if (element.__achievementsDesignerPositionFrame)
          cancelAnimationFrame(element.__achievementsDesignerPositionFrame);
        element.remove();
      });
    cachedVisualSurface = null;
    activeGlowSurface = null;
  };
  let receivedNotification = false;
  let motionRevision = 0;
  let motionTimer = null;
  const originalMotionTiming = new WeakMap();
  const originalMotionFrames = new WeakMap();
  const raposoMotionNames = new Set([
    "base-animation", "button-animation", "text-animation",
    "icon-animation", "combinedButtonIconAnimation",
  ]);
  const xboxMotionNames = new Set([
    "containerAnimationFrames", "mainAnimationFrames", "glowAnimationFrames",
    "shimmerAnimationFrames", "titleAnim", "detailAnim", "iconFrames",
    "xboxLogoAnimationFrames", "laurelFrames",
    "loader1Anim", "loader2Anim", "loader3Anim", "loader4Anim", "loader5Anim",
  ]);
  // Xbox packs entry, two text phases and exit into one long timeline. Retiming
  // its moving sections must preserve the common timeline and close deadline.
  // All six authored variants hold their title at 25-45% and description at
  // 50-73%; distribute the remaining hold time between those same sections.
  const xboxMotionOffset = (offset, speed) => {
    const motionFactor = Math.min(1 / speed, 0.95 / 0.57);
    const holdFactor = (1 - 0.57 * motionFactor) / 0.43;
    const segments = [[0.25, motionFactor], [0.45, holdFactor],
      [0.5, motionFactor], [0.73, holdFactor], [1, motionFactor]];
    let start = 0, result = 0;
    for (const [end, factor] of segments) {
      result += (Math.min(offset, end) - start) * factor;
      if (offset <= end) return Math.max(0, Math.min(1, result));
      start = end;
    }
    return 1;
  };
  const refreshXboxArtworkTiming = () => {
    if (!options.xboxLayered) return;
    const banner = surface()?.querySelector(".achievement-banner");
    const layer = banner?.querySelector(".achievements-designer-blurred-background");
    if (layer) syncXboxBackgroundReveal(banner, layer);
  };
  const applyAnimationSpeed = (data, deferUntilLayout = false) => {
    const revision = ++motionRevision;
    clearTimeout(motionTimer);
    motionTimer = null;
    const speed = Number(options.animationSpeed) / 100;
    if (!Number.isFinite(speed) || speed <= 0) return;
    if (speed === 1) {
      for (const animation of document.getAnimations({ subtree: true })) {
        const original = originalMotionTiming.get(animation);
        if (!original) continue;
        try {
          animation.effect.updateTiming({ duration: original.duration });
          const frames = originalMotionFrames.get(animation);
          if (frames) animation.effect.setKeyframes(frames);
        } catch {}
        originalMotionTiming.delete(animation);
        originalMotionFrames.delete(animation);
      }
      refreshXboxArtworkTiming();
      return;
    }
    const adjusted = new WeakSet();
    const displayDuration = Math.min(60000,
      Math.max(1000, Number(data?.durationMs) || 8000));
    const maxMotionDuration = Math.min(5000, displayDuration / 2);
    const now = () => window.__achievementsPreviewClock?.now() ?? performance.now();
    const until = now() + displayDuration;
    const scan = () => {
      if (revision !== motionRevision) return;
      let xboxChanged = false;
      for (const animation of document.getAnimations({ subtree: true })) {
        if (adjusted.has(animation)) continue;
        adjusted.add(animation);
        const effect = animation.effect;
        const timing = originalMotionTiming.get(animation) || effect?.getTiming?.();
        const duration = Number(timing?.duration);
        if (!Number.isFinite(duration) || duration < 30) continue;
        const xboxTimeline = options.xboxLayered && xboxMotionNames.has(animation.animationName);
        const raposoCycle = raposoMotionNames.has(animation.animationName);
        if (!xboxTimeline && !raposoCycle &&
            (duration > maxMotionDuration || Number(timing?.iterations) !== 1)) continue;
        try {
          originalMotionTiming.set(animation, timing);
          if (xboxTimeline) {
            const frames = originalMotionFrames.get(animation) || effect.getKeyframes();
            originalMotionFrames.set(animation, frames);
            effect.setKeyframes(frames.map(({ computedOffset, ...frame }) => ({
              ...frame, offset: xboxMotionOffset(frame.offset ?? computedOffset, speed),
            })));
            xboxChanged = true;
          } else effect.updateTiming({ duration: duration / speed });
        } catch {}
      }
      if (xboxChanged) refreshXboxArtworkTiming();
      if (now() < until) motionTimer = setTimeout(scan, 100);
    };
    // Stock handlers set their timeline and measure/restart the plate in RAF.
    // Read the final width and duration, rather than pinning the pre-payload ones.
    if (deferUntilLayout) requestAnimationFrame(() => requestAnimationFrame(scan));
    else scan();
  };
  const onNotification = (data) => {
    receivedNotification = true;
    applyAnimationSpeed(data, true);
    queueMicrotask(() => update(data));
    requestAnimationFrame(() => update(data));
  };
  window.__achievementsDesignerApplyPreview = (nextOptions, data) => {
    if (!window.__achievementsPreviewClock) return;
    restorePreviewOverrides();
    options = nextOptions || {};
    capturePlacementGeometry();
    receivedNotification = true;
    update(data);
    applyAnimationSpeed(data);
  };
  capturePlacementGeometry();
  document.addEventListener("DOMContentLoaded", capturePlacementGeometry, { once: true });
  if (window.api?.onNotification) window.api.onNotification(onNotification);
  else window.electronAPI?.onNotification?.(onNotification);
  let attempts = 0;
  const catchFirstNotification = setInterval(() => {
    if (receivedNotification || attempts++ > 120) {
      clearInterval(catchFirstNotification);
      return;
    }
    const last = window.api?.getLastNotification?.();
    if (last) {
      clearInterval(catchFirstNotification);
      onNotification(last);
    }
  }, 25);
})();
