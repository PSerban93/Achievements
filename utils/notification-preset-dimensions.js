(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.AchievementsNativeDimensions = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  // Editor dimensions describe the transparent viewport, not the animated plate.
  // Detect the authored animation/structure, including renamed custom clones.
  function identify(html, css) {
    if (/\baward-shell\b/.test(html) && /\bhex-particle-container\b/.test(html))
      return "tiger";
    if (/@keyframes\s+base-animation\b/.test(css)) return "raposo";
    if (/@keyframes\s+ps4AchievementInBottom\b/.test(css)) return "ps4";
    if (/@keyframes\s+ach_in_anim\b/.test(css)) return "default";
    if (/@keyframes\s+open-close-banner\b/.test(css)) return "xbox360";
    if (/\bachievement-banner\b/.test(html) && /\bachievement-loader\b/.test(html)) return "xbox";
    if (/@keyframes\s+expandCircle\b/.test(css) && /\bnotification\b/.test(html)) return "xqjan";
    if (/\bhellblade-shell\b/.test(html)) return "hellblade";
    if (/\bbat-shell\b/.test(html)) return "batman";
    if (/\bdock\b/.test(html) && /--panel\s*:/.test(css)) return "epic";
    if (/\.ach\s*\{[^}]*max-width:\s*450px/.test(css)) return "ps5steam";
    if (/\bachievement-container\b/.test(html) && /\bicon-container\b/.test(html)) return "content";
    return null;
  }
  function imageLayout(html, css) {
    const has = (name) => new RegExp(`class=["'][^"']*\\b${name}\\b`, "i").test(html);
    if (has("ach-inner")) return { layout: ".ach-inner", item: ".ach-inner > .icon" };
    if (has("icon-container")) return { layout: ".achievement-content", item: ".achievement-content > .icon-container" };
    if (has("arcade-card") && has("ani_icon")) return { layout: ".arcade-card", item: ".arcade-card > .ani_icon" };
    if (has("ach") && has("icon") && /\.ach\s*\{[^}]*display:\s*flex/.test(css))
      return { layout: ".ach", item: ".ach > .icon" };
    return null;
  }
  function imageCapabilities(html, css) {
    return {
      size: /<img\b/i.test(html) && /\b(?:icon|achicon|achievement-icon|icon-container|ani_icon|badge)\b/i.test(html),
      layout: imageLayout(html, css),
    };
  }
  const profiles = {
    ps4: { insetX: 27, insetY: 52, plateWidth: 373, plateHeight: 73,
      padding: 10, border: 1.5, icon: 50, text: 50 },
    raposo: { insetX: 40, insetY: 80, plateWidth: 360, plateHeight: 70,
      padding: 8, border: 0, icon: 65, text: 54 },
    tiger: { insetX: 120, insetY: 157, plateWidth: 600, plateHeight: 63,
      padding: 0, border: 0, icon: 130, text: 63 },
    default: { insetX: 50, insetY: 40, plateWidth: 400, plateHeight: 75,
      padding: 0, border: 0, icon: 100, text: 63 },
    xbox360: { insetX: 40, insetY: 66, plateWidth: 560, plateHeight: 84,
      padding: 7, border: 0, icon: 70, text: 70 },
    xqjan: { insetX: 30, insetY: 60, plateWidth: 420, plateHeight: 90,
      padding: 0, border: 0, icon: 64, text: 54 },
    epic: { insetX: 24, insetY: 10, plateWidth: 386, plateHeight: 86,
      padding: 12, border: 1, icon: 86, text: 48 },
    ps5steam: { insetX: 0, insetY: 0, plateWidth: 450, plateHeight: 90,
      padding: 15, border: 0, icon: 60, text: 60 },
    content: { insetX: 0, insetY: 0, plateWidth: 380, plateHeight: 100,
      padding: 18, border: 2, icon: 64, text: 64 },
    hellblade: { insetX: 0, insetY: 0, plateWidth: 540, plateHeight: 154,
      padding: 0, border: 0, icon: 60, text: 66 },
    batman: { insetX: 0, insetY: 35, plateWidth: 500, plateHeight: 150,
      padding: 0, border: 1, icon: 34, text: 40 },
    xbox: { insetX: 0, insetY: 60, plateWidth: 700, plateHeight: 100,
      padding: 0, border: 0, icon: 80, text: 100 },
  };
  function resolveSize(profile, width, height, values = {}, fields = []) {
    const spec = profiles[profile];
    if (!spec) return { width, height };
    const changed = new Set(fields);
    const number = (key, fallback) => changed.has(key) && Number.isFinite(Number(values[key]))
      ? Number(values[key]) : fallback;
    const padding = number("padding", spec.padding);
    const border = number("borderWidth", spec.border);
    const hidden = changed.has("iconPosition") && values.iconPosition === "hidden";
    const icon = hidden ? 0 : number("iconSize", spec.icon);
    const above = changed.has("iconPosition") && values.iconPosition === "top";
    const gap = number("gap", 10);
    const textChanged = ["titleSize", "detailSize", "descriptionLines", "showDescription", "gap"].some((key) => changed.has(key));
    const text = textChanged
      ? Math.ceil(number("titleSize", 18) * 1.35 +
          (changed.has("showDescription") && values.showDescription === false ? 0
            : number("detailSize", 14) * 1.45 * number("descriptionLines", 2) + gap))
      : spec.text;
    const contentHeight = above ? icon + gap + text : Math.max(icon, text);
    let minHeight = spec.insetY + contentHeight + padding * 2 + border * 2;
    // These icons overhang the plate; their size must not inflate its body.
    if (profile === "raposo") minHeight = spec.insetY + Math.max(text + padding * 2 + border * 2, icon - 5);
    if (profile === "tiger") minHeight = Math.max(220, spec.insetY + text + padding * 2 + border * 2, icon + 90);
    if (profile === "default") minHeight = Math.max(115, spec.insetY + text + (textChanged ? 12 : 0) + padding * 2 + border * 2, icon + 15);
    if (profile === "xqjan") minHeight = 60 + Math.max(90, text + padding * 2, changed.has("iconSize") ? Math.ceil(icon * 1.3 + 16) : 80);
    if (profile === "epic") minHeight = 10 + Math.max(icon, text + padding * 2 + border * 2);
    if (profile === "batman") minHeight = Math.max(185, width * 1572 / 4499 + 35, 93 + icon + 35, 42 + text + 35);
    if (profile === "hellblade") minHeight = Math.max(154, 47 + icon + 30, 42 + text + 30);
    if (profile === "xbox") minHeight = 60 + Math.max(100, icon + 20, text + padding * 2);
    let minWidth = profile === "tiger" ? 320
      : spec.insetX + Math.max(240, (above ? Math.max(icon, 140) : icon + gap + 140) + padding * 2 + border * 2);
    const fittedHeight = Math.min(640, Math.max(height, minHeight));
    if (profile === "xbox360") minWidth = Math.max(minWidth, fittedHeight - spec.insetY + spec.insetX);
    if (profile === "epic") minWidth = 24 + icon + 140 + padding * 2;
    if (profile === "xbox") minWidth = Math.max(100, icon + 20) + 160 + 48;
    return {
      width: Math.min(900, Math.max(width, minWidth)),
      height: fittedHeight,
    };
  }
  function keyframes(css, name, replace) {
    const match = new RegExp(`@keyframes\\s+${name}\\s*\\{`).exec(css);
    if (!match) return "";
    let end = match.index + match[0].length;
    let depth = 1;
    while (end < css.length && depth) {
      if (css[end] === "{") depth++;
      else if (css[end] === "}") depth--;
      end++;
    }
    return depth ? "" : replace(css.slice(match.index, end));
  }
  function overrides(profile, width, height, css, fields = [], values = {}) {
    if (!profiles[profile]) return "";
    const changed = new Set(fields);
    const resizedX = changed.has("width"), resizedY = changed.has("height");
    if (!resizedX && !resizedY) return "";
    const spec = profiles[profile];
    const w = resizedX ? width - spec.insetX : spec.plateWidth;
    const h = resizedY ? height - spec.insetY : spec.plateHeight;
    const vars = `:root{--achievements-plate-width:${w}px;--achievements-plate-height:${h}px}`;
    if (profile === "ps4") return `${vars}\n.ach{box-sizing:border-box!important;width:${w}px!important;height:${h}px!important;min-width:0!important;min-height:0!important}`;
    if (profile === "raposo") {
      // Normal declarations let the animation own width/height at every phase.
      const collapsed = changed.has("iconSize") ? Math.max(90, Number(values.iconSize) + 26) : 90;
      return `${vars}\n.ach{width:var(--achievements-plate-width);height:var(--achievements-plate-height)}\n` +
        keyframes(css, "base-animation", (block) => block
          .replace(/width:\s*90px\b/g, `width:${collapsed}px`)
          .replace(/width:\s*360px\b/g, "width:var(--achievements-plate-width)")
          .replace(/height:\s*(70|76|83)px\b/g, (_, value) => `height:calc(var(--achievements-plate-height) + ${Number(value) - 70}px)`));
    }
    if (profile === "default") {
      const collapsed = Math.min(w, 65 * h / 75);
      const compressed = Math.min(w, 50 * h / 75);
      const frames = ["ach_in_anim", "ach_current", "ach_out_anim"].map((name) =>
        keyframes(css, name, (block) => block
          .replace(/width:\s*400px\b/g, "width:var(--achievements-plate-width)")
          .replace(/width:\s*380px\b/g, "width:calc(var(--achievements-plate-width) - 20px)")
          .replace(/width:\s*65px\b/g, `width:${collapsed}px`)
          .replace(/width:\s*50px\b/g, `width:${compressed}px`))).join("\n");
      return `${vars}\n.ach{width:var(--achievements-plate-width);${resizedY ? `height:${h}px!important;` : ""}}\n${frames}`;
    }
    if (profile === "xbox360") {
      const frames = keyframes(css, "open-close-banner", (block) => block
        .replace(/width:\s*10em\b/g, "width:var(--achievements-plate-width)")
        .replace(/width:\s*1\.5em\b/g, "width:var(--achievements-plate-height)"));
      return `${vars}\n.ach{height:${h}px!important;min-height:0!important}\n` +
        `.ach .text_wrap{top:50%!important;translate:0 -50%;width:calc(100% - 4em)!important}` +
        `.ach .icon{top:calc((${h}px - ${changed.has("iconSize") ? Number(values.iconSize) : 70}px - ${(changed.has("padding") ? Number(values.padding) : 7) * 2}px)/2)}\n${frames}`;
    }
    if (profile === "xqjan") {
      const circle = changed.has("iconSize") ? Math.max(80, Math.ceil(Number(values.iconSize) * 1.3 + 16)) : 80;
      const frames = keyframes(css, "expandCircle", (block) => block
        .replace(/width:\s*420px\b/g, "width:var(--achievements-plate-width)")
        .replace(/height:\s*90px\b/g, "height:var(--achievements-plate-height)")) + "\n" +
        keyframes(css, "retractCircle", (block) => block.replace(/(width|height):\s*80px\b/g, `$1:${circle}px`));
      return `${vars}\n.notification{width:${circle}px;height:${circle}px}\n${frames}`;
    }
    if (profile === "epic") {
      const icon = changed.has("iconSize") ? Number(values.iconSize) : 86;
      return `${vars}\n.dock{--icon:${icon}px!important;--panel:${w - icon}px!important;height:${h}px!important}` +
        `.dock .clip{height:${h}px!important}.dock > .icon{top:calc((${h}px - var(--icon))/2)!important}`;
    }
    if (profile === "ps5steam" || profile === "content") {
      const target = profile === "content" ? ".achievement-container > .achievement" : ".ach";
      return `${vars}\n${target}{${resizedX ? `width:${w}px!important;max-width:none!important;` : ""}${resizedY ? `height:${h}px!important;` : ""}box-sizing:border-box!important}`;
    }
    if (profile === "batman" || profile === "hellblade") {
      const shell = profile === "batman" ? ".bat-shell" : ".hellblade-shell";
      return `${vars}\n${shell}{width:${w}px!important;height:${h}px!important}` +
        (profile === "batman" && resizedX ? ".bat-shell .copy{width:calc(100% - 76px)!important;max-width:none!important}" : "");
    }
    if (profile === "xbox") {
      const diameter = Math.max(100, changed.has("iconSize") ? Number(values.iconSize) + 20 : 100);
      // The preset measures text and writes --ach-width on .ach itself. An
      // inherited variable cannot override that local value, even !important.
      return `:root{--achievements-xbox-diameter:${diameter}px}` +
        `.ach{${resizedX ? `--ach-width:${width - 48}px!important;` : ""}${resizedY ? `height:${h + 60}px!important;` : ""}}` +
        (resizedY ? `.ach::after,.achievement-banner,.ach .text_wrap{height:${h}px!important}` +
          `.achievement-banner .icon img:not(.laurel-wreath){top:${(h - diameter) / 2}px!important}` +
          `.achievement-banner .achievement-trophy{top:${(h - diameter) / 2}px!important}` +
          `.achievement-banner .laurel-wreath{bottom:${(h - diameter) / 2 - 6}px!important}` : "");
    }
    // Tiger's content expands via Web Animations. Never pin its width with
    // !important; change the endpoint and keep the card centred by its own size.
    return `${vars}\n:root{--achievements-panel-width:${w}px}\n` +
      `.award-shell{width:${resizedX ? width : 720}px!important;height:${resizedY ? height : 220}px!important}` +
      `.overlay .award-container{width:${w + 50}px!important;height:${h + 17}px!important;margin-left:${-(w + 50) / 2}px!important;margin-top:${-(h + 17) / 2}px!important}` +
      `.award-container .content{height:${h}px!important}` +
      `.award-container .achievement-title,.award-container .achievement-desc{width:${Math.max(0, w - 74)}px!important;max-width:none!important}`;
  }
  function adaptHtml(profile, html) {
    // Explicit multiline descriptions take precedence over the authored
    // horizontal marquee. Keep title marquees and entry/exit motion intact.
    if (profile === "ps4") return html.replace(/if\s*\(dOverflowY > 1\)/g,
      "if (dOverflowY > 1 && !window.__achievementsDesignerOptions?.descriptionLinesChanged)");
    if (profile === "xbox360") return html.replace(/if\s*\(overflowY > 1 \|\| overflowX > 2\)/g,
      "if ((overflowY > 1 || overflowX > 2) && !window.__achievementsDesignerOptions?.descriptionLinesChanged)");
    if (["batman", "hellblade", "epic"].includes(profile) &&
        !html.includes("window.__achievementsDesignerOptions?.descriptionLinesChanged) return;")) return html.replace(
      /(resetMarquee\(container, inner\);)/g,
      "$1\n          if ((inner.classList.contains('desc') || inner.classList.contains('desc-inner')) && window.__achievementsDesignerOptions?.descriptionLinesChanged) return;");
    if (profile !== "tiger") return html;
    return html.replace(/\{\s*width:\s*"600px"\s*\}/g,
      '{ width: getComputedStyle(content).getPropertyValue("--achievements-panel-width").trim() || "600px" }');
  }
  function adaptCss(profile, css) {
    if (profile !== "xbox") return css;
    return css
      .replace(/((?:width|height):\s*)100px\b/g, "$1var(--achievements-xbox-diameter,100px)")
      .replace(/(--ach-collapsed-width:\s*)100px\b/g, "$1var(--achievements-xbox-diameter,100px)")
      .replace(/(height:\s*)160px\b/g, "$1calc(var(--achievements-xbox-diameter,100px) + 60px)")
      .replace(/(border-radius:\s*)50px\b/g, "$1calc(var(--achievements-xbox-diameter,100px)/2)")
      .replace(/(left:\s*)110px\b/g, "$1calc(var(--achievements-xbox-diameter,100px) + 10px)")
      .replace(/calc\(var\(--ach-width(?:,\s*700px)?\) - 130px\)/g,
        "calc(var(--ach-width,700px) - var(--achievements-xbox-diameter,100px) - 30px)");
  }
  function imageOverrides(profile, selector, size, layout, css = "") {
    if (profile === "raposo") {
      const frames = keyframes(css, "combinedButtonIconAnimation", (block) => block
        .replace(/(width|height):\s*65px\b/g, `$1:${size}px`)
        .replace(/(width|height):\s*75px\b/g, `$1:${size + 10}px`));
      return `.ach .icon{width:${size}px;height:${size}px}.ach .icon img{width:${Math.max(1, size - 5)}px!important;height:${Math.max(1, size - 5)}px!important}\n${frames}`;
    }
    if (profile === "xbox") {
      const diameter = Math.max(100, size + 20);
      return `:root{--achievements-xbox-diameter:${diameter}px}` +
        `.achievement-banner .icon img:not(.laurel-wreath){width:${size}px!important;height:${size}px!important;margin-top:${(diameter - size) / 2}px!important;margin-left:${(diameter - size) / 2}px!important}` +
        `.achievement-trophy:before{top:${diameter / 2 - 18}px!important;left:${diameter / 2 - 30}px!important}` +
        `.laurel-wreath{left:${diameter / 2}px!important;width:${diameter * 0.96}px!important}`;
    }
    if (profile === "epic") return `.dock{--icon:${size}px!important}.dock > .icon{width:${size}px!important;height:${size}px!important}.dock .icon img{width:100%!important;height:100%!important}`;
    const slot = layout?.item || (profile === "tiger" ? ".award-container .badge"
      : ["hellblade", "batman"].includes(profile) ? `${selector} .icon-frame`
        : `${selector} .icon`);
    const shape = profile === "tiger" ? `${slot},${slot} .badge-hex` : slot;
    return `${shape}{box-sizing:border-box!important;width:${size}px!important;height:${size}px!important;${layout ? `flex:0 0 ${size}px!important;` : ""}}` +
      (profile === "tiger" ? `${slot} img{width:calc(100% - 24px)!important;height:calc(100% - 24px)!important}`
        : `${slot} img{width:100%!important;height:100%!important;object-fit:cover!important}`) +
      (profile === "default" ? `.ach .text_wrap{left:${Math.max(90, size - 10)}px!important;right:20px!important;max-width:none!important}` : "");
  }
  function textOverrides(profile, html, css, values = {}, fields = []) {
    const changed = new Set(fields);
    const rules = [];
    const align = changed.has("textAlign") && ["left", "center", "right"].includes(values.textAlign)
      ? values.textAlign : null;
    const multiline = changed.has("descriptionLines");
    const resized = changed.has("width");
    const typography = ["titleSize", "detailSize", "descriptionLines"].some((key) => changed.has(key));
    // A flex text column must occupy the remaining width before its children
    // can align to the new notification edges. Only touch authored flex rows.
    if ((resized || align) && /class=["'][^"']*\btext_wrap\b/.test(html) &&
        /\.ach\s*\{[^}]*display:\s*flex/.test(css))
      rules.push(".ach > .text_wrap{flex:1 1 auto!important;min-width:0!important;max-width:none!important}");
    if ((resized || align) && /class=["'][^"']*\bach-inner\b/.test(html))
      rules.push(".ach-inner > .text_wrap{flex:1 1 auto!important;min-width:0!important;max-width:none!important}");
    if (align) rules.push(".title .title-inner,.desc .desc-inner{padding-right:0!important}");
    if (align && profile === "raposo") rules.push(".ach .detail{max-width:100%!important}");
    if (align && profile === "xbox") {
      const justify = { left: "flex-start", center: "center", right: "flex-end" }[align];
      rules.push(`.ach .text_wrap .title,.ach .text_wrap .detail{justify-content:${justify}!important}`);
    }
    if (align && ["batman", "hellblade"].includes(profile))
      rules.push(`.title-wrap,.desc-wrap{text-align:${align}!important}.copy .title,.copy .desc{padding-right:0!important}`);
    if (align && profile === "xqjan")
      rules.push(`.notification .text{align-items:stretch!important;text-align:${align}!important}`);
    if (typography && ["batman", "hellblade"].includes(profile)) {
      rules.push(".copy{height:auto!important}.copy .title-wrap,.copy .desc-wrap{height:auto!important;min-height:0!important}");
      if (changed.has("titleSize")) rules.push(".copy .title{line-height:1.2!important}");
      if (changed.has("detailSize") || multiline) rules.push(".copy .desc{line-height:1.35!important}");
    }
    if (typography && profile === "default")
      rules.push(".ach .text_wrap{max-height:none!important}");
    if (multiline) {
      rules.push(".detail,.desc,.achievement-description,.achievement-desc,#desc{max-height:none!important}",
        ".detail .detail-inner,.desc .desc-inner{display:inline!important;white-space:normal!important}");
      if (profile === "xbox") rules.push(".ach .text_wrap .detail{height:auto!important;top:50%!important;translate:0 -50%;line-height:1.35!important}");
    }
    return rules.join("\n");
  }
  return { identify, resolveSize, overrides, adaptHtml, adaptCss, imageLayout, imageCapabilities, imageOverrides, textOverrides };
});
