"use strict";

// Keep the historical Uplay schema IDs while retaining the original Steam IDs.
function normalizeUplayAchievementName(name) {
  if (typeof name !== "string") return name;
  let value = name.trim();
  const achievement = value.match(/Ach_(.+)$/i);
  if (achievement?.[1]) value = achievement[1];
  const numbered = value.match(/^(.*)_(\d+)$/);
  if (numbered?.[1] && /[A-Za-z]/.test(numbered[1])) value = numbered[2];
  return value;
}

function normalizeUplaySchema(entries) {
  const namesByTarget = new Map();
  for (const entry of entries) {
    const name = String(entry?.name ?? "").trim();
    const target = normalizeUplayAchievementName(name).toLowerCase();
    if (!namesByTarget.has(target)) namesByTarget.set(target, new Set());
    namesByTarget.get(target).add(name);
  }
  return entries.map((entry) => {
    if (typeof entry?.name !== "string") return entry;
    const original = entry.name.trim();
    const target = normalizeUplayAchievementName(original);
    // Never turn distinct achievements into duplicate schema IDs.
    const name = namesByTarget.get(target.toLowerCase()).size > 1 ? original : target;
    const aliases = new Set(Array.isArray(entry.uplayNameAliases)
      ? entry.uplayNameAliases.filter((value) => typeof value === "string" && value.trim()) : []);
    if (original !== name) aliases.add(original);
    return { ...entry, name, ...(aliases.size ? { uplayNameAliases: [...aliases] } : {}) };
  });
}

function createUplayNameResolver(entries) {
  const exact = new Map(), aliases = new Map(), normalized = new Map();
  const key = (value) => String(value ?? "").trim().toLowerCase();
  const add = (index, candidate, name) => {
    const id = key(candidate);
    if (!id) return;
    if (!index.has(id)) index.set(id, name);
    else if (index.get(id) !== name) index.set(id, null);
  };
  for (const entry of entries) {
    const name = String(entry?.name ?? "").trim();
    if (!name) continue;
    add(exact, name, name);
    add(normalized, normalizeUplayAchievementName(name), name);
    for (const alias of Array.isArray(entry.uplayNameAliases) ? entry.uplayNameAliases : []) {
      if (typeof alias !== "string") continue;
      add(aliases, alias, name);
      add(normalized, normalizeUplayAchievementName(alias), name);
    }
  }
  return (rawName) => {
    const id = key(rawName);
    if (exact.has(id)) return exact.get(id);
    if (aliases.has(id)) return aliases.get(id);
    return normalized.get(key(normalizeUplayAchievementName(String(rawName ?? "")))) || null;
  };
}

function mergeUplaySnapshotEntries(previous, entry) {
  const earned = [previous, entry].some((item) => item?.earned === true || item?.earned === 1);
  const times = [previous, entry].filter((item) => item?.earned === true || item?.earned === 1)
    .map((item) => Number(item?.earned_time)).filter((time) => Number.isFinite(time) && time > 0);
  const merged = { ...previous, ...entry, earned, earned_time: earned && times.length ? Math.min(...times) : 0 };
  for (const field of ["progress", "max_progress"]) {
    const values = [previous?.[field], entry?.[field]].filter((value) => value != null)
      .map(Number).filter(Number.isFinite);
    if (values.length) merged[field] = Math.max(...values);
  }
  return merged;
}

function alignUplaySnapshot(snapshot, resolveName) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return snapshot;
  const mapped = new Map();
  let changed = false;
  for (const [rawName, entry] of Object.entries(snapshot)) {
    const name = resolveName(rawName) || rawName;
    changed ||= name !== rawName;
    if (!mapped.has(name)) { mapped.set(name, entry); continue; }
    changed = true;
    mapped.set(name, mergeUplaySnapshotEntries(mapped.get(name), entry));
  }
  return changed ? Object.fromEntries(mapped) : snapshot;
}

module.exports = { normalizeUplayAchievementName, normalizeUplaySchema, createUplayNameResolver, alignUplaySnapshot, mergeUplaySnapshotEntries };
