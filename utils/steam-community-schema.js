"use strict";

function text(value) { return typeof value === "string" ? value.trim() : ""; }

function readQueries(html) {
  const match = String(html || "").match(/<script\b[^>]*\bid=["']valve-ssr-data["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!match) throw new Error("SteamCommunity achievement data is unavailable");
  const raw = JSON.parse(match[1])?.renderContext?.queryData;
  const cache = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (!Array.isArray(cache?.queries)) throw new Error("SteamCommunity returned invalid query data");
  return cache.queries;
}

function findQuery(queries, appid, kind) {
  return queries.find((item) => Array.isArray(item?.queryKey) && item.queryKey[0] === "achievements" &&
    String(item.queryKey[1]) === String(appid) && item.queryKey[2] === kind && item.state?.status === "success")?.state?.data;
}

function titleFromQueries(queries, appid) {
  const info = queries.find((item) => item?.queryKey?.[0] === "StoreItem" &&
    item.queryKey[1] === `app_${appid}` && item.queryKey[2] === "default_info" && item.state?.status === "success")?.state?.data;
  return String(info?.appid ?? info?.id) === String(appid) ? text(info.name) : "";
}

function parseSteamCommunityTitle(html, appid) {
  return titleFromQueries(readQueries(html), appid) || null;
}

function parseSteamCommunitySchema(html, appid) {
  const queries = readQueries(html);
  const schema = findQuery(queries, appid, "schema");
  if (String(schema?.appid) !== String(appid) || !Array.isArray(schema.groups)) {
    throw new Error("SteamCommunity returned no schema for the requested AppID");
  }
  const percentages = findQuery(queries, appid, "globalpercentages")?.percentages || {};
  const rows = [], seen = new Set();
  for (const group of schema.groups) {
    if (!Array.isArray(group?.achievements)) throw new Error("SteamCommunity returned an invalid achievement group");
    for (const entry of group.achievements) {
      const apiName = text(entry?.api_name);
      if (!apiName || !text(entry.name) || seen.has(apiName) || typeof entry.hidden !== "boolean" ||
          typeof entry.icon_achieved !== "string" || typeof entry.icon_unachieved !== "string") {
        throw new Error("SteamCommunity returned incomplete or duplicate achievement entries");
      }
      seen.add(apiName);
      const percent = percentages[entry.internal_key];
      const rarityPercent = percent !== null && percent !== undefined && percent !== "" &&
        Number.isFinite(Number(percent)) && Number(percent) >= 0 && Number(percent) <= 100 ? Number(percent) : null;
      rows.push({ apiName, nameEN: text(entry.name), descEN: text(entry.description),
        hidden: entry.hidden ? 1 : 0, iconUrl: text(entry.icon_achieved), iconGrayUrl: text(entry.icon_unachieved), rarityPercent });
    }
  }
  return { rows, title: titleFromQueries(queries, appid), language: text(schema.language),
    schemaHash: schema.schema_hash, schemaVersion: schema.schema_version,
    // HTTP 200 + [] is also returned for nonexistent AppIDs. It is not absence proof.
    outcome: rows.length ? "success" : "ambiguous" };
}

function mergeSteamCommunityLanguage(rows, translated, lang) {
  const byId = new Map();
  for (const row of translated) byId.set(row.apiName, byId.has(row.apiName) ? null : row);
  return rows.map((row) => {
    const match = byId.get(row.apiName);
    return match ? { ...row, displayName: { ...row.displayName, [lang]: match.nameEN },
      description: { ...row.description, [lang]: match.descEN } } : row;
  });
}

module.exports = { parseSteamCommunitySchema, parseSteamCommunityTitle, mergeSteamCommunityLanguage };
