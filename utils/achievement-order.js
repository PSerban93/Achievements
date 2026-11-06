(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.AchievementOrder = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function isPlatinum(achievement) {
    return achievement?.synthetic_platinum === true ||
      /^(p|platinum)$/i.test(String(achievement?.trophyType || achievement?.trophy_type || "").trim());
  }

  function comparePlatinumRarity(aIsPlatinum, bIsPlatinum, direction = "asc") {
    const platinumFirst = Number(bIsPlatinum === true) - Number(aIsPlatinum === true);
    return direction === "desc" ? -platinumFirst : platinumFirst;
  }

  // Equivalent to placing Platinum first in source order, then stably grouping
  // unlocked before locked. Name/time sorts are handled by the renderers.
  function compareDefaultOrder(a, b, aUnlocked = false, bUnlocked = false) {
    return Number(bUnlocked) - Number(aUnlocked) ||
      comparePlatinumRarity(isPlatinum(a), isPlatinum(b));
  }

  return { isPlatinum, comparePlatinumRarity, compareDefaultOrder };
});
