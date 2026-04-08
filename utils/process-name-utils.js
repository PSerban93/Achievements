const path = require("path");

function splitProcessNameString(value) {
  return String(value || "")
    .split(/[\r\n,;]+/g)
    .map((part) => String(part || "").trim())
    .filter(Boolean);
}

function toProcessNameItems(value, splitString = false, target = []) {
  if (Array.isArray(value)) {
    value.forEach((item) => toProcessNameItems(item, splitString, target));
    return target;
  }
  if (typeof value === "string") {
    const items = splitString ? splitProcessNameString(value) : [value.trim()];
    items.filter(Boolean).forEach((item) => target.push(item));
    return target;
  }
  if (value == null) return target;
  const raw = String(value).trim();
  if (raw) target.push(raw);
  return target;
}

function normalizeProcessExecutableName(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    return path.basename(raw.replace(/\//g, "\\")).toLowerCase();
  } catch {
    return raw.toLowerCase();
  }
}

function normalizeProcessNameList(value, opts = {}) {
  const splitString = opts?.splitString === true;
  const items = toProcessNameItems(value, splitString, []);
  const seen = new Set();
  const normalized = [];
  for (const item of items) {
    const trimmed = String(item || "").trim();
    if (!trimmed) continue;
    const key = normalizeProcessExecutableName(trimmed) || trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(trimmed);
  }
  return normalized;
}

function normalizeProcessNameValue(value, opts = {}) {
  const list = normalizeProcessNameList(value, opts);
  if (!list.length) return "";
  if (list.length === 1) return list[0];
  return list;
}

function hasProcessNameValue(value, opts = {}) {
  return normalizeProcessNameList(value, opts).length > 0;
}

function getPrimaryProcessName(value, opts = {}) {
  const list = normalizeProcessNameList(value, opts);
  return list[0] || "";
}

function getProcessExecutableNames(value, opts = {}) {
  return normalizeProcessNameList(value, opts)
    .map((item) => normalizeProcessExecutableName(item))
    .filter(Boolean);
}

function getProcessNameSignature(value, opts = {}) {
  const list = getProcessExecutableNames(value, opts).slice().sort();
  return list.join("|");
}

function processNameValuesEqual(a, b, opts = {}) {
  return getProcessNameSignature(a, opts) === getProcessNameSignature(b, opts);
}

function serializeProcessNameForUi(value) {
  return normalizeProcessNameList(value).join(", ");
}

module.exports = {
  getPrimaryProcessName,
  getProcessExecutableNames,
  getProcessNameSignature,
  hasProcessNameValue,
  normalizeProcessExecutableName,
  normalizeProcessNameList,
  normalizeProcessNameValue,
  processNameValuesEqual,
  serializeProcessNameForUi,
  splitProcessNameString,
};
