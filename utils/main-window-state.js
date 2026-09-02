"use strict";

const DEFAULT_MAIN_WINDOW_BOUNDS = Object.freeze({
  width: 1000,
  height: 1000,
});

function toFiniteInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number) : null;
}

function normalizeMainWindowBounds(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const width = toFiniteInteger(value.width);
  const height = toFiniteInteger(value.height);
  if (width === null || height === null || width <= 0 || height <= 0) {
    return null;
  }

  const x = toFiniteInteger(value.x);
  const y = toFiniteInteger(value.y);
  return {
    ...(x === null ? {} : { x }),
    ...(y === null ? {} : { y }),
    width,
    height,
  };
}

function shouldStartMainWindowMaximized(preferences) {
  return preferences?.startMaximized === true;
}

function resolveMainWindowStartupPresentation(
  preferences,
  { forceShow = false } = {},
) {
  const shouldShow = forceShow === true || preferences?.startInTray !== true;
  return {
    shouldShow,
    shouldMaximize:
      shouldShow && shouldStartMainWindowMaximized(preferences),
  };
}

function normalizeWorkArea(display) {
  const source = display?.workArea;
  if (!source || typeof source !== "object") return null;
  const x = toFiniteInteger(source.x);
  const y = toFiniteInteger(source.y);
  const width = toFiniteInteger(source.width);
  const height = toFiniteInteger(source.height);
  if (
    x === null ||
    y === null ||
    width === null ||
    height === null ||
    width <= 0 ||
    height <= 0
  ) {
    return null;
  }
  return { x, y, width, height };
}

function getIntersectionArea(bounds, area) {
  if (!bounds || bounds.x === undefined || bounds.y === undefined) return 0;
  const left = Math.max(bounds.x, area.x);
  const top = Math.max(bounds.y, area.y);
  const right = Math.min(bounds.x + bounds.width, area.x + area.width);
  const bottom = Math.min(bounds.y + bounds.height, area.y + area.height);
  return Math.max(0, right - left) * Math.max(0, bottom - top);
}

function clamp(value, minimum, maximum) {
  if (maximum < minimum) return minimum;
  return Math.min(Math.max(value, minimum), maximum);
}

function resolveMainWindowBounds(
  savedBounds,
  displays = [],
  primaryDisplay = null,
) {
  const normalized = normalizeMainWindowBounds(savedBounds);
  if (!normalized) return { ...DEFAULT_MAIN_WINDOW_BOUNDS };

  const areas = (Array.isArray(displays) ? displays : [])
    .map(normalizeWorkArea)
    .filter(Boolean);
  const primaryArea = normalizeWorkArea(primaryDisplay) || areas[0] || null;
  if (!areas.length && primaryArea) areas.push(primaryArea);
  if (!areas.length) return normalized;

  let targetArea = null;
  let largestIntersection = 0;
  for (const area of areas) {
    const intersection = getIntersectionArea(normalized, area);
    if (intersection > largestIntersection) {
      largestIntersection = intersection;
      targetArea = area;
    }
  }
  if (!targetArea) targetArea = primaryArea || areas[0];

  const width = clamp(normalized.width, 1, targetArea.width);
  const height = clamp(normalized.height, 1, targetArea.height);

  if (
    largestIntersection <= 0 ||
    normalized.x === undefined ||
    normalized.y === undefined
  ) {
    return {
      x: targetArea.x + Math.max(0, Math.round((targetArea.width - width) / 2)),
      y:
        targetArea.y + Math.max(0, Math.round((targetArea.height - height) / 2)),
      width,
      height,
    };
  }

  return {
    x: clamp(normalized.x, targetArea.x, targetArea.x + targetArea.width - width),
    y: clamp(
      normalized.y,
      targetArea.y,
      targetArea.y + targetArea.height - height,
    ),
    width,
    height,
  };
}

module.exports = {
  DEFAULT_MAIN_WINDOW_BOUNDS,
  normalizeMainWindowBounds,
  resolveMainWindowBounds,
  resolveMainWindowStartupPresentation,
  shouldStartMainWindowMaximized,
};
