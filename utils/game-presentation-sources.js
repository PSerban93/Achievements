"use strict";

// Native identifiers stay in their platform namespace. Collection product
// IDs are presentation identities only, never replacements for subgame IDs.
function steamId(config) {
  const platform = String(config.platform || "").toLowerCase();
  const value = ["steam", "steam-official", "markerpatch", "madnesspatch"].includes(platform)
    ? config.appid : config.steamAppId || config.steam_appid || config.steam_app_id;
  return /^\d+$/.test(String(value || "")) ? String(value) : "";
}
function gamesDbSources(config) {
  const platform = String(config.platform || "").toLowerCase(), appid = String(config.appid || "");
  let provider = "", ids = [];
  if (["steam", "steam-official", "markerpatch", "madnesspatch"].includes(platform)) { provider = "steam"; ids = [steamId(config)]; }
  else if (["gog", "gog-official"].includes(platform)) { provider = "gog"; ids = [/^\d+$/.test(appid) ? appid : ""]; }
  else if (["epic", "epic-official"].includes(platform)) { provider = "epic"; ids = [config.epic_app_name]; }
  else if (["uplay", "ubisoft-official"].includes(platform)) { provider = "uplay"; ids = [/^\d+$/.test(appid) ? appid : ""]; }
  else if (["ea", "ea-official"].includes(platform)) { provider = "origin"; ids = [config.ea_offer_id]; }
  else if (platform === "xbox-pc") { provider = "xboxone"; ids = [config.xbox_title_id || appid].filter(id => /^\d+$/.test(String(id))); }
  else if (["xenia", "x360recomp", "xlivelessness"].includes(platform)) {
    provider = "xboxone";
    const id = String(config.xlln_title_id || config.x360_recomp_title_id || appid).replace(/^0x/i, "");
    ids = /^[\da-f]{8}$/i.test(id) ? [String(parseInt(id, 16))] : [];
  } else if (["shadps4", "ps4recomp", "kytyps5", "rpcs3", "ps3recomp"].includes(platform)) {
    provider = "psn";
    const collection = platform === "ps4recomp" && require("./ps4-recomp-collections").collection(config.ps4_recomp_port);
    const collectionId = collection && /^[A-Z]{2}\d{4}-(CUSA\d{5})_\d{2}-[A-Z0-9]+$/i.exec(config.ps_content_id || "")?.[1];
    const id = String(collectionId || config.ps4_recomp_title_id || config.kytyps5_title_id || config.ps3_recomp_title_id || appid).toUpperCase();
    if (/^(?:CUSA|PPSA)\d{5}(?:_\d{2})?$/.test(id)) ids = [id.includes("_") ? id : id + "_00"];
    else if (/^NP[A-Z]{2}\d{5}(?:_\d{2})?$/.test(id) && !id.startsWith("NPWR")) ids = [id];
  }
  return [...new Set(ids.filter(id => typeof id === "string" && /^[\w.:-]{1,180}$/.test(id)))].map(id => ({ platform: provider, id }));
}
const complete = data => !!(data?.description && data?.genres?.length && data?.releaseDate &&
  data?.developers?.length && data?.publishers?.length);
module.exports = { steamId, gamesDbSources, complete };
