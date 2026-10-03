(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.AchievementsSanCapabilities = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // Describes the bundled HTML/CSS, not the contents of a user's .san archive.
  // Unsupported keys (including SAN's native OS preset) render with Default.
  const commonFeatures = {
    background: true, image: true, imageBorder: true, imageMask: true,
    text: true, textShadow: true, notificationBorder: true, glow: true,
    rarityText: true, rarityBadge: true, hiddenIndicator: true,
    specialIconAnimation: true, platinumImage: true,
    decorationShadow: true,
  };
  function definition(key, options = {}) {
    return Object.freeze({
      key,
      features: Object.freeze({
        ...commonFeatures,
        logo: options.logo === true,
        decoration: options.decoration || "none",
        decorationScale: options.decorationScale === true,
        decorationShadow: ["text", "points"].includes(options.decoration),
        tertiaryColour: options.tertiaryColour === true,
      }),
      compactOffset: options.compactOffset === true,
      compactHiddenRows: Object.freeze(options.compactHiddenRows || []),
      screenshotHiddenRows: Object.freeze(options.screenshotHiddenRows || []),
      fastHiddenRows: Object.freeze(options.fastHiddenRows || []),
      fastDurationBelow: options.fastDurationBelow || 0,
      points: Object.freeze({
        supported: Boolean(options.points),
        // Empty for Xbox One, matching SAN. These are simulated SAN points.
        unit: options.points?.unit || "",
        targets: Object.freeze(options.points?.targets || []),
        selectors: Object.freeze(options.points?.selectors || []),
        rule: options.points?.rule || "unsupported",
      }),
    });
  }
  const presets = Object.freeze({
    default: definition("default", {
      logo: true, decoration: "text", decorationScale: true,
      screenshotHiddenRows: ["unlockmsg"],
    }),
    xqjan: definition("xqjan", {
      logo: true, tertiaryColour: true, fastDurationBelow: 8,
      fastHiddenRows: ["unlockmsg"], screenshotHiddenRows: ["unlockmsg"],
    }),
    steamdeck: definition("steamdeck", {
      decoration: "text", decorationScale: true, compactOffset: true,
    }),
    epicgames: definition("epicgames", {
      decoration: "points", decorationScale: true, compactOffset: true,
      tertiaryColour: true,
      points: { unit: " XP", targets: ["xpwrapper"],
        selectors: [".wrapper#xpwrapper"], rule: "dedicated-points-area" },
    }),
    xboxone: definition("xboxone", {
      logo: true, decoration: "points-marker", fastDurationBelow: 8,
      screenshotHiddenRows: ["unlockmsg"],
      points: { targets: ["title", "desc"], rule: "decoration-in-content",
        selectors: [
          "body:not([ss]) .wrapper#achcontent:has(#unlockmsg):has(#decoration) #title:not(:empty)",
          "body[ss] .wrapper#achcontent:has(#title):has(#decoration) #desc",
        ] },
    }),
    xbox360: definition("xbox360", {
      logo: true, decoration: "points-marker", tertiaryColour: true,
      compactHiddenRows: ["desc"],
      points: { unit: "G", targets: ["title", "desc"], rule: "decoration-in-content",
        selectors: [".wrapper#achcontent:has(#unlockmsg):has(#decoration) #title:not(:empty)"] },
    }),
    ps5: definition("ps5", {
      logo: true, decoration: "text", decorationScale: true,
      compactOffset: true, tertiaryColour: true,
    }),
    ps4: definition("ps4", {
      logo: true, decoration: "text", decorationScale: true,
      compactHiddenRows: ["desc"], tertiaryColour: true,
    }),
    ps3: definition("ps3", {
      decoration: "text", decorationScale: true, compactHiddenRows: ["desc"],
    }),
    windows: definition("windows", { logo: true }),
    gfwl: definition("gfwl", {
      logo: true, decoration: "points-marker", tertiaryColour: true,
      points: { unit: "G", targets: ["title", "desc"], rule: "decoration-in-unlock-row",
        selectors: [".wrapper#achcontent > #unlockmsg:has(> #decoration) + #title:not(:empty)"] },
    }),
  });
  function getPresetDefinition(key) {
    const normalized = String(key || "default").toLowerCase();
    return Object.prototype.hasOwnProperty.call(presets, normalized)
      ? presets[normalized] : presets.default;
  }
  function getTransitionLimit(preset, displaytime) {
    const duration = Number(displaytime);
    const durationMs = Math.max(1000, (Number.isFinite(duration) ? duration : 8) * 1000);
    // Steam's title enters at 12*t for 2*t and exits at D/2 - 4*t.
    // Reserve 150ms of readable hold between those phases. Fast layouts do
    // not have the intermediate title exit, so retain their common limit.
    const limit = getPresetDefinition(preset).key === "xqjan" && durationMs >= 8000
      ? (durationMs - 300) / 36 : durationMs / 24;
    return Math.max(50, Math.min(5000, Math.floor(limit / 25) * 25));
  }
  function getIcons(customisation) {
    const key = String(customisation.preset || "default").toLowerCase();
    return customisation.customicons?.[customisation.preset] ||
      customisation.customicons?.[key] || {};
  }
  function getTextLayout(preset, customisation = {}, context = {}) {
    const profile = getPresetDefinition(preset);
    const icons = getIcons(customisation);
    const screenshotSettings = context.screenshotMode === true && customisation.elemsmatch !== true;
    const normalElements = typeof customisation.elementsLayout === "string"
      ? customisation.elementsLayout.split(",") : customisation.elems;
    const elements = screenshotSettings && Array.isArray(customisation.sselems)
      ? customisation.sselems : Array.isArray(normalElements)
        ? normalElements : screenshotSettings && Array.isArray(icons.sselems)
          ? icons.sselems : Array.isArray(icons.elems) ? icons.elems : ["unlockmsg", "title", "desc"];
    const filtered = elements.filter((item) => item !== null);
    const offset = profile.compactOffset && filtered.length < 3 ? 1 : 0;
    const compact = filtered.length < 3;
    const fast = profile.fastDurationBelow > 0 &&
      Number(customisation.displaytime ?? 10) < profile.fastDurationBelow;
    const rows = ["unlockmsg", "title", "desc"].map((elementId, index) => {
      const omitted = Boolean(offset && index === 0);
      return {
        elementId, position: index + 1 - (index ? offset : 0),
        content: omitted ? "" : filtered[index - offset] || "",
        omitted,
        cssHidden: (compact && profile.compactHiddenRows.includes(elementId)) ||
          (context.screenshotMode === true && profile.screenshotHiddenRows.includes(elementId)) ||
          (fast && profile.fastHiddenRows.includes(elementId)),
      };
    });
    return { rows, elements: filtered, offset };
  }
  function getTextRows(preset, customisation = {}, context = {}) {
    return getTextLayout(preset, customisation, context).rows;
  }
  function getDecorationPosition(customisation, context = {}) {
    const ss = context.screenshotMode === true && customisation.elemsmatch !== true;
    for (const key of ss ? ["ssdecorationpos", "decorationpos"] : ["decorationpos"]) {
      if (!Object.prototype.hasOwnProperty.call(customisation, key)) continue;
      const number = Number(customisation[key]);
      if (Number.isFinite(number)) return number;
    }
    const number = Number(getIcons(customisation).index?.decoration);
    return Number.isFinite(number) ? number : 0;
  }
  function getPointsAvailability(preset, customisation = {}, context = {}) {
    const profile = getPresetDefinition(preset);
    if (!profile.points.supported) return { supported: false, available: false, reason: "points-not-supported" };
    if (typeof customisation.showpoints === "boolean") {
      return { supported: true, available: customisation.showpoints,
        reason: customisation.showpoints ? "" : "points-disabled" };
    }
    // In the renderer use the real selectors, including screenshot layout and
    // :empty. In the editor evaluate the corresponding prospective row layout.
    if (typeof context.matchesSelector === "function") {
      const available = profile.points.selectors.some(context.matchesSelector);
      return { supported: true, available, reason: available ? "" : "points-layout-inactive" };
    }
    if (profile.points.rule === "dedicated-points-area")
      return { supported: true, available: true, reason: "" };
    if (customisation.showdecoration !== true)
      return { supported: true, available: false, reason: "requires-decoration" };
    const rows = getTextRows(preset, customisation, context);
    const position = getDecorationPosition(customisation, context);
    // CSS :has(#decoration) sees a marker even on a CSS-hidden row.
    const marker = rows.find((row) => !row.omitted && row.position === position);
    if (!marker || (profile.points.rule === "decoration-in-unlock-row" && marker.elementId !== "unlockmsg"))
      return { supported: true, available: false, reason: "requires-decoration-row" };
    const target = rows.find((row) => row.elementId ===
      (profile.key === "xboxone" && context.screenshotMode === true ? "desc" : "title"));
    const available = Boolean(target && !target.omitted && !target.cssHidden && target.content);
    return { supported: true, available, reason: available ? "" : "requires-points-text-row" };
  }

  // Stable codes are for the next UI/localisation step; they are never shown
  // as untranslated user-facing text. Dependencies name existing SAN fields.
  const rules = {};
  function rule(fields, specification) {
    for (const key of ["requires", "excludes", "states"]) {
      if (specification[key]) Object.freeze(specification[key]);
    }
    if (specification.values) {
      Object.values(specification.values).forEach(Object.freeze);
      Object.freeze(specification.values);
    }
    for (const field of fields) rules[field] = Object.freeze(specification);
  }
  rule(["logoImage", "logoscale", "replacelogo"], { feature: "logo" });
  rule(["tertiarycolor"], { feature: "tertiaryColour" });
  rule(["showdecoration"], { feature: "decoration" });
  rule(["decorationpos"], { feature: "decoration", requires: ["showdecoration"] });
  rule(["decorationscale"], { feature: "decorationScale", requires: ["showdecoration"] });
  rule(["decorationshadow"], { feature: "decorationShadow", requires: ["showdecoration", "fontshadow"] });
  rule(["imageSource", "usegameicon", "usecustomimgicon"], { feature: "image" });
  rule(["gameIconImage"], { requires: ["usegameicon"], excludes: ["usecustomimgicon"] });
  rule(["achievementImage"], { requires: ["usecustomimgicon"] });
  rule(["iconanim"], { states: ["rare", "platinum"] });
  rule(["iconshadowcolor", "iconanimcolor"], { requires: ["iconanim"], states: ["rare", "platinum"] });
  rule(["platinumImage"], { states: ["platinum"], values: { imageSource: ["original"] } });
  rule(["iconborderrarity", "iconBorderImage", "iconborderpos", "iconborderscale", "iconborderx", "iconbordery"], { requires: ["showiconborder"] });
  rule(["iconBorderBronzeImage", "iconBorderSilverImage"], { requires: ["showiconborder", "iconborderrarity"] });
  rule(["glowrarity", "glowsize", "glowanim"], { requires: ["glow"] });
  // SAN's animation keyframes replace the static filter and its X/Y offsets.
  rule(["glowx", "glowy"], { requires: ["glow"], values: { glowanim: ["off"] } });
  rule(["glowspeed"], { requires: ["glow"], values: { glowanim: ["pulse", "double", "focus", "orbit", "fluorescent", "rainbow"] } });
  rule(["glowcolor"], { requires: ["glow"], excludes: ["glowrarity"] });
  rule(["glowcolorbronze", "glowcolorsilver", "glowcolorgold"], { requires: ["glow", "glowrarity"] });
  rule(["outlinecolor", "outlinewidth"], { requires: ["useoutline"] });
  rule(["fontshadowcolor", "fontshadowx", "fontshadowy", "fontshadowscale"], { requires: ["fontshadow"] });
  rule(["fontoutlinecolor", "fontoutlinescale"], { requires: ["fontoutline"] });
  rule(["unlockmsgfontsize", "titlefontsize", "descfontsize"], { requires: ["usecustomfontsizes"] });
  rule(["fontsize"], { excludes: ["usecustomfontsizes"] });
  rule(["unlockmsgfontcolor", "titlefontcolor", "descfontcolor"], { requires: ["usecustomfontcolors"] });
  rule(["fontcolor"], { excludes: ["usecustomfontcolors"] });
  rule(["customtext"], { excludes: ["usegametitle"] });
  rule(["usegametitleunlockmsg"], { requires: ["usecustomtext"], excludes: ["usegametitle"] });
  rule(["usegametitletitle", "usegametitledesc"], { requires: ["usecustomtext"] });
  rule(["customtextunlockmsg"], { requires: ["usecustomtext"], excludes: ["usegametitle", "usegametitleunlockmsg"] });
  rule(["customtexttitle"], { requires: ["usecustomtext"], excludes: ["usegametitletitle"] });
  rule(["customtextdesc"], { requires: ["usecustomtext"], excludes: ["usegametitledesc"] });
  rule(["percentbadgeimg", "percentbadgefontsize", "percentbadgepos", "percentbadgeroundness", "percentbadgex", "percentbadgey", "percentbadgecolor"], { requires: ["percentbadge"] });
  rule(["percentbadgefontcolor"], { requires: ["percentbadge"], excludes: ["percentbadgeimg"] });
  rule(["rarityBronzeImage", "raritySilverImage", "rarityGoldImage"], { requires: ["percentbadge", "percentbadgeimg"] });
  rule(["maskImage"], { requires: ["mask"] });
  rule(["gradientangle"], { values: { bgstyle: ["gradient"] } });
  rule(["brightness"], { values: { bgstyle: ["gameart"] } });
  rule(["bgimgbrightness"], { values: { bgstyle: ["bgimg"] } });
  rule(["blur"], { values: { bgstyle: ["bgimg", "gameart"] } });
  rule(["hiddeniconpos", "hiddenIndicatorImage"], { requires: ["showhiddenicon"] });
  rule(["usepercent"], { points: true });
  rule(["pointsDisplay"], { feature: "points" });
  rule(["percentpos"], { values: { showpercent: ["rare", "rareonly", "all"] } });
  rule(["decorationImage"], { decorationAsset: true });
  const controlRules = Object.freeze(rules);
  function getControlStates(preset, customisation = {}, context = {}) {
    const profile = getPresetDefinition(preset);
    const state = context.sampleState || "normal";
    const result = {};
    for (const [field, spec] of Object.entries(controlRules)) {
      let reason = "";
      if (spec.feature === "points" ? !profile.points.supported :
          spec.feature && (!profile.features[spec.feature] || profile.features[spec.feature] === "none"))
        reason = "not-supported-by-preset";
      else if (spec.states && !spec.states.includes(state)) reason = "notification-type";
      else if (spec.points) reason = getPointsAvailability(preset, customisation, context).reason;
      else if (spec.decorationAsset && !["text", "points"].includes(profile.features.decoration) &&
          !(profile.features.logo && customisation.replacelogo === true)) reason = "requires-logo-replacement";
      if (!reason) {
        const missing = spec.requires?.find((key) => customisation[key] !== true);
        const excluded = spec.excludes?.find((key) => customisation[key] === true);
        const wrongValue = Object.entries(spec.values || {}).find(([key, values]) => !values.includes(customisation[key]));
        if (missing) reason = `requires:${missing}`;
        else if (excluded) reason = `overridden-by:${excluded}`;
        else if (wrongValue) reason = `requires-value:${wrongValue[0]}`;
      }
      const dependencies = [...(spec.requires || []), ...(spec.excludes || []), ...Object.keys(spec.values || {})];
      if (spec.points && profile.points.rule !== "dedicated-points-area" && profile.points.supported)
        dependencies.push("showdecoration", "decorationpos", "elementsLayout");
      if (spec.decorationAsset && !["text", "points"].includes(profile.features.decoration))
        dependencies.push("replacelogo");
      result[field] = { available: !reason, reason, dependencies };
    }
    return result;
  }
  return Object.freeze({ version: 1, presets, controlRules, getPresetDefinition, getTransitionLimit,
    getTextLayout, getTextRows, getDecorationPosition, getPointsAvailability, getControlStates });
});
