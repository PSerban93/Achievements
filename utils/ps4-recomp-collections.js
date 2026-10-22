"use strict";

// Collections need explicit ownership rules. Single-game detection never uses
// these titles or executable names to guess another installation's game.
const PORTS = [
  { port: "uncharted", launcher: "Uncharted.exe", settings: "uncharted-launcher", env: "BB", marker: "uncharted", games: [
    ["u1", "Uncharted: Drake's Fortune Remastered", 0], ["u2", "Uncharted 2: Among Thieves Remastered", 1], ["u3", "Uncharted 3: Drake's Deception Remastered", 2]] },
  { port: "prototype", launcher: "", settings: "prototype-port", settingsName: "launcher.json", env: "THEORDER", resetLogOnStart: true, games: [
    ["p1", "PROTOTYPE", 0], ["p2", "PROTOTYPE 2", 1]] },
];
function collection(port) { return PORTS.find((entry) => entry.port === port) || null; }
function identify(source) {
  if (/big2-ps4_Shipping\.elf/.test(source) && /big3-ps4_Shipping\.elf/.test(source)) return collection("uncharted");
  if (/prototype2_ps4f\.elf/.test(source) && /THEORDER_EBOOT/.test(source) && /boot-linked\.bin/.test(source)) return collection("prototype");
  return null;
}
function gameFromText(text, port = "uncharted") {
  if (port === "prototype") {
    if (/prototype2_ps4f(?:\.elf|[\\/].*boot-linked\.bin)/i.test(text)) return "p2";
    if (/(?:eboot\.bin|[\\/]out[\\/]boot-linked\.bin)/i.test(text)) return "p1";
    return "";
  }
  if (port !== "uncharted") return "";
  if (/big2(?:-ps4_Shipping\.elf|[\\/].*boot-linked\.bin)/i.test(text)) return "u2";
  if (/big3(?:-ps4_Shipping\.elf|[\\/].*boot-linked\.bin)/i.test(text)) return "u3";
  if (/(?:eboot\.bin|[\\/]eboot[\\/].*boot-linked\.bin)/i.test(text)) return "u1";
  return "";
}
function expectedTitle(port, game) {
  if (port === "uncharted") return { u1: /drake.?s fortune/i, u2: /among thieves/i, u3: /drake.?s deception/i }[game];
  if (port === "prototype") return { p1: /^\s*prototype(?:\s*[™®])?\s*$/i, p2: /^\s*prototype\s*2(?:\s*[™®])?\s*$/i }[game];
  return null;
}
module.exports = { PORTS, collection, identify, gameFromText, expectedTitle };
