(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.AchievementsSanEditor = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  const modeFields = Object.freeze({
    glowrarity: ["single", "rarity"], iconborderrarity: ["single", "rarity"],
    percentbadgeimg: ["percentage", "image"],
    usecustomfontsizes: ["uniform", "rows"], usecustomfontcolors: ["uniform", "rows"],
  });
  const sections = [
    ["sanLayout", ["scale", "displaytime", "transition", "roundness"]],
    ["background", ["bgstyle", "backgroundImage", "primarycolor", "secondarycolor", "tertiarycolor", "gradientangle", "brightness", "bgimgbrightness", "blur", "opacity", "bgonly", "mask", "maskImage"]],
    ["sanImage", ["imageSource", "achievementImage", "gameIconImage", "iconscale", "iconroundness"]],
    ["imageBorder", ["showiconborder", "iconborderrarity", "iconBorderImage", "iconBorderBronzeImage", "iconBorderSilverImage", "iconborderpos", "iconborderscale", "iconborderx", "iconbordery"]],
    ["logo", ["replacelogo", "logoImage", "logoscale"]],
    ["decoration", ["showdecoration", "decorationImage", "decorationpos", "decorationscale"]],
    ["text", ["elementsLayout", "unlockSource", "customtextunlockmsg", "titleSource", "customtexttitle", "descriptionSource", "customtextdesc", "fontfamily", "customFont", "usecustomfontsizes", "fontsize", "unlockmsgfontsize", "titlefontsize", "descfontsize", "usecustomfontcolors", "fontcolor", "unlockmsgfontcolor", "titlefontcolor", "descfontcolor", "textvspace", "showhiddenicon", "hiddeniconpos", "hiddenIndicatorImage"]],
    ["rarity", ["pointsDisplay", "showpercent", "percentpos"]],
    ["badge", ["percentbadge", "percentbadgeimg", "rarityBronzeImage", "raritySilverImage", "rarityGoldImage", "percentbadgecolor", "percentbadgefontcolor", "percentbadgefontsize", "percentbadgeroundness", "percentbadgepos", "percentbadgex", "percentbadgey"]],
    ["effects", ["useoutline", "outlinecolor", "outlinewidth", "glow", "glowrarity", "glowcolor", "glowcolorbronze", "glowcolorsilver", "glowcolorgold", "glowsize", "glowx", "glowy", "glowanim", "glowspeed", "fontoutline", "fontoutlinecolor", "fontoutlinescale", "fontshadow", "fontshadowcolor", "fontshadowscale", "fontshadowx", "fontshadowy", "decorationshadow"]],
    ["special", ["iconanim", "iconshadowcolor", "iconanimcolor", "platinumImage"]],
  ];
  const removed = new Set(["usepercent", "usegameicon", "usecustomimgicon", "bgachicon", "customtext", "usegametitle", "usecustomtext", "usegametitleunlockmsg", "usegametitletitle", "usegametitledesc"]);
  const labelAliases = Object.freeze({ scale: "sanScale", roundness: "sanRoundness",
    transition: "sanTransition", displaytime: "sanDuration", iconroundness: "sanImageRoundness",
    decorationpos: "sanDecorationRow", percentpos: "sanPercentageRow", hiddeniconpos: "sanHiddenRow",
    iconanim: "sanSpecialAnimation", iconshadowcolor: "sanSpecialShadow", iconanimcolor: "sanSpecialColour",
    glowrarity: "sanGlowMode", iconborderrarity: "sanBorderMode", percentbadgeimg: "sanBadgeContent",
    usecustomfontsizes: "sanTextSizeMode", usecustomfontcolors: "sanTextColourMode",
    gameIconImage: "sanGameOverride", textvspace: "sanRowSpacing" });
  function buildDefinitions(definitions) {
    const byKey = new Map(definitions.filter((item) => !removed.has(item[1])).map((item) => [item[1], item]));
    // SAN-only fields stay out of the shared native effects definitions.
    for (const definition of [
      ["background", "bgonly", "Apply opacity only to the background", "boolean"],
      ["effects", "glowx", "Glow offset X", "range", [-300, 300, 1, ""]],
      ["effects", "glowy", "Glow offset Y", "range", [-300, 300, 1, ""]],
      ["effects", "glowspeed", "Glow animation timing", "range", [1, 300, 1, ""]],
      ["effects", "fontoutline", "Text outline", "boolean"],
      ["effects", "fontoutlinecolor", "Text outline colour", "color"],
      ["effects", "fontoutlinescale", "Text outline width", "range", [0, 20, 0.1, " px"]],
      ["effects", "fontshadowscale", "Text shadow blur", "range", [0, 30, 0.1, " px"]],
    ]) byKey.set(definition[1], definition);
    byKey.set("imageSource", ["sanImage", "imageSource", "Image source", "select", [["Achievement image", "original"], ["Game portrait", "game"], ["Custom image", "custom"]]]);
    byKey.set("pointsDisplay", ["rarity", "pointsDisplay", "Points display", "select", [["Off", "off"], ["Rarity percentage", "percentage"], ["SAN points (XP/G)", "points"]]]);
    byKey.set("showhiddenicon", ["text", "showhiddenicon", "Show hidden achievement indicator", "boolean"]);
    byKey.set("hiddenIndicatorImage", ["text", "hiddenIndicatorImage", "Hidden achievement indicator image", "asset"]);
    for (const key of ["unlockSource", "titleSource", "descriptionSource"])
      byKey.set(key, ["text", key, key, "select", [["Default text", "default"], ["Custom text", "custom"], ["Game name", "game"]]]);
    for (const [key, values] of Object.entries(modeFields)) {
      const item = byKey.get(key);
      const labels = {
        single: key === "iconborderrarity" ? "Single image" : "Single colour",
        rarity: "By rarity", uniform: "Same for all rows",
        rows: "Separate for each row", percentage: "Percentage", image: "Image",
      };
      byKey.set(key, [item[0], key, item[2], "select", values.map((value) => [labels[value], value])]);
    }
    for (const key of ["decorationpos", "percentpos", "hiddeniconpos"]) {
      const item = byKey.get(key);
      byKey.set(key, [item[0], key, item[2], "select", [["None", "0"], ["Row 1", "1"], ["Row 2", "2"], ["Row 3", "3"]]]);
    }
    const bg = byKey.get("bgstyle");
    byKey.set("bgstyle", [...bg.slice(0, 4), [...bg[4], ["Achievement image", "achievement"]]]);
    return sections.flatMap(([group, keys]) => keys.filter((key) => byKey.has(key)).map((key) => [group, ...byKey.get(key).slice(1)]));
  }
  function toEditorValues(source, profile, capabilities) {
    const values = { ...source };
    values.imageSource = source.usecustomimgicon ? "custom" : source.usegameicon ? "game" : "original";
    values.bgstyle = source.bgstyle === "bgimg" && source.bgachicon ? "achievement" : source.bgstyle;
    values.pointsDisplay = capabilities.getPointsAvailability(profile.key, source).available
      ? source.usepercent ? "percentage" : "points" : "off";
    values.unlockSource = source.usegametitle || (source.usecustomtext && source.usegametitleunlockmsg)
      ? "game" : (source.usecustomtext && source.customtextunlockmsg) || source.customtext ? "custom" : "default";
    values.titleSource = source.usecustomtext && source.usegametitletitle ? "game" : source.usecustomtext && source.customtexttitle ? "custom" : "default";
    values.descriptionSource = source.usecustomtext && source.usegametitledesc ? "game" : source.usecustomtext && source.customtextdesc ? "custom" : "default";
    values.customtextunlockmsg = source.customtextunlockmsg || source.customtext || "";
    for (const [key, modes] of Object.entries(modeFields)) values[key] = source[key] === true ? modes[1] : modes[0];
    return values;
  }
  function toSanValues(editor) {
    const values = { ...editor };
    for (const [key, modes] of Object.entries(modeFields)) values[key] = editor[key] === modes[1];
    values.usegameicon = editor.imageSource === "game";
    values.usecustomimgicon = editor.imageSource === "custom";
    values.bgachicon = editor.bgstyle === "achievement";
    if (values.bgachicon) values.bgstyle = "bgimg";
    values.showpoints = editor.pointsDisplay !== "off";
    values.usepercent = editor.pointsDisplay === "percentage";
    values.usecustomtext = [editor.unlockSource, editor.titleSource, editor.descriptionSource].some((value) => value !== "default");
    values.usegametitle = false;
    values.customtext = "";
    for (const [source, text, game] of [["unlockSource", "customtextunlockmsg", "usegametitleunlockmsg"], ["titleSource", "customtexttitle", "usegametitletitle"], ["descriptionSource", "customtextdesc", "usegametitledesc"]]) {
      values[game] = editor[source] === "game";
      if (editor[source] !== "custom") values[text] = "";
    }
    for (const key of ["decorationpos", "percentpos", "hiddeniconpos"]) values[key] = Number(editor[key]) || 0;
    return values;
  }
  function patchForField(key, values) {
    if (key === "imageSource") return { usegameicon: values.usegameicon, usecustomimgicon: values.usecustomimgicon };
    if (key === "pointsDisplay") return { showpoints: values.showpoints, usepercent: values.usepercent };
    if (key === "bgstyle") return { bgstyle: values.bgstyle, bgachicon: values.bgachicon };
    if (["unlockSource", "titleSource", "descriptionSource", "customtextunlockmsg", "customtexttitle", "customtextdesc"].includes(key)) {
      return Object.fromEntries(["usecustomtext", "usegametitle", "customtext", "usegametitleunlockmsg", "usegametitletitle", "usegametitledesc", "customtextunlockmsg", "customtexttitle", "customtextdesc"].map((field) => [field, values[field]]));
    }
    return null;
  }
  // Legacy points selectors depend on row contents and decoration markers.
  // Preserve the editor's displayed mode when an edit changes those conditions.
  const legacyPointsFields = Object.freeze([
    "elems", "sselems", "elemsmatch", "showdecoration", "decorationpos", "ssdecorationpos",
    "showhiddenicon", "hiddeniconpos", "sshiddeniconpos", "showpercent", "percentpos", "sspercentpos",
    "usecustomtext", "usegametitle", "usegametitleunlockmsg", "usegametitletitle", "usegametitledesc",
    "customtext", "customtextunlockmsg", "customtexttitle", "customtextdesc", "displaytime",
  ]);
  function pointsPatchForChanges(profile, values, patch = {}, assets = {}) {
    if (!profile?.points?.supported) return null;
    const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
    const changesLayout = legacyPointsFields.some((field) => has(patch, field));
    if (!has(patch, "showpoints") && !changesLayout && !has(assets, "decorationImage")) return null;
    return patchForField("pointsDisplay", values);
  }
  return Object.freeze({ buildDefinitions, toEditorValues, toSanValues, patchForField,
    pointsPatchForChanges, labelAliases, modeFields });
});
