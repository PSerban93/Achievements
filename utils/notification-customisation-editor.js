(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.AchievementsNotificationEditor = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // Labels only: stored fields and their pixel/percentage units stay unchanged.
  const labelAliases = Object.freeze({
    scale: "sanScale", radius: "sanRoundness", roundness: "sanRoundness",
    displayTime: "sanDuration", displaytime: "sanDuration",
    iconRadius: "sanImageRoundness", iconroundness: "sanImageRoundness",
    backgroundMode: "bgstyle", backgroundBlur: "blur",
    background: "primarycolor", background2: "secondarycolor",
    gradientAngle: "gradientangle", fontFamily: "fontfamily",
    text: "titlefontcolor", mutedText: "descfontcolor",
    rarityColor: "rarityColor", percentbadgecolor: "rarityColor",
    rarityTextColor: "rarityTextColor", percentbadgefontcolor: "rarityTextColor",
    rarityPosition: "rarityPosition", percentbadgepos: "rarityPosition",
    percentbadgex: "rarityOffsetX", percentbadgey: "rarityOffsetY",
  });
  const groupAliases = Object.freeze({
    layout: "sanLayout", image: "sanImage",
  });
  const nativeSections = [
    ["layout", ["scale", "displayTime", "animationSpeed", "radius", "width", "height", "padding", "gap"]],
    ["background", ["backgroundMode", "backgroundImage", "background", "background2", "gradientAngle", "backgroundBlur", "backgroundCoverTransparency", "opacity"]],
    ["image", ["achievementImage", "iconSize", "iconRadius", "iconPosition", "iconOffsetX", "iconOffsetY"]],
    ["logo", ["logoMode", "logoLibrary", "logoImage", "logoSize", "logoPosition", "logoOffsetX", "logoOffsetY"]],
    ["decoration", ["decorationMode", "decorationImage", "decorationSize", "decorationPosition", "decorationOffsetX", "decorationOffsetY"]],
    ["text", ["fontFamily", "customFont", "fontWeight", "text", "titleSize", "textAlign", "titleCase", "showDescription", "mutedText", "detailSize", "descriptionLines"]],
    ["badge", ["rarityMode", "rarityPosition", "rarityOffsetX", "rarityOffsetY", "rarityColor", "rarityTextColor"]],
    ["effects", ["useoutline", "accent", "borderWidth", "shadow", "glow", "glowcolor", "glowsize", "glowanim", "fontshadow", "fontshadowcolor", "fontshadowx", "fontshadowy"]],
  ];
  function buildNativeDefinitions(definitions) {
    const byKey = new Map(definitions.map((item) => [item[1], item]));
    const ordered = [];
    for (const [group, keys] of nativeSections) {
      for (const key of keys) {
        const item = byKey.get(key);
        if (!item) continue;
        ordered.push([group, ...item.slice(1)]);
        byKey.delete(key);
      }
    }
    // Preserve future existing controls; this adapter never adds SAN controls.
    ordered.push(...byKey.values());
    return ordered;
  }
  function getNativeControlStates(values = {}) {
    const result = {};
    const style = values.backgroundMode === "colors" && values.gradient
      ? "gradient" : values.backgroundMode;
    const state = (fields, available, parent, reason = "requires-choice") => {
      for (const field of fields) result[field] = {
        available, reason: available ? "" : `${reason}:${parent}`,
        dependencies: [parent],
      };
    };
    state(["iconSize", "iconRadius", "iconOffsetX", "iconOffsetY", "achievementImage"], values.iconPosition !== "hidden", "iconPosition");
    state(["background"], style !== "inherit", "backgroundMode");
    state(["background2", "gradientAngle"], ["gradient", "image", "gamecover"].includes(style), "backgroundMode");
    state(["backgroundBlur", "backgroundCoverTransparency"], ["image", "gamecover"].includes(style), "backgroundMode");
    state(["logoSize", "logoPosition", "logoOffsetX", "logoOffsetY"], values.logoMode === "custom", "logoMode");
    state(["decorationSize", "decorationPosition", "decorationOffsetX", "decorationOffsetY"], values.decorationMode === "custom", "decorationMode");
    state(["mutedText", "detailSize", "descriptionLines"], values.showDescription === true, "showDescription", "requires");
    const rarityEnabled = values.rarityMode !== "off";
    state(["rarityPosition", "rarityOffsetX", "rarityOffsetY", "rarityColor", "rarityTextColor"], rarityEnabled, "rarityMode");
    if (rarityEnabled) state(["rarityOffsetX", "rarityOffsetY"], values.rarityPosition !== "inherit", "rarityPosition");
    for (const [parent, fields] of [
      ["useoutline", ["accent", "borderWidth"]],
      ["glow", ["glowcolor", "glowsize", "glowanim"]],
      ["fontshadow", ["fontshadowcolor", "fontshadowx", "fontshadowy"]],
    ]) state(fields, values[parent] === true, parent, "requires");
    return result;
  }
  return Object.freeze({ labelAliases, groupAliases, buildNativeDefinitions, getNativeControlStates });
});
