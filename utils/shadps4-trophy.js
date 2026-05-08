const fs = require("fs");
const path = require("path");
const cheerio = require("cheerio");

// Map index -> language key (best-effort, fallback english)
const PS4_LANG_MAP = {
  trop: "english", // TROP.XML
  "00": "japanese",
  "01": "english",
  "02": "french",
  "03": "spanish",
  "04": "german",
  "05": "italian",
  "06": "dutch",
  "07": "portuguese",
  "08": "russian",
  "09": "koreana",
  "10": "tchinese",
  "11": "schinese",
  "12": "finnish",
  "13": "swedish",
  "14": "danish",
  "15": "norwegian",
  "16": "polish",
  "17": "brazilian",
  "18": "english",
  "19": "turkish",
  "20": "latam",
  "21": "arabic",
  "22": "french",
  "23": "czech",
  "24": "hungarian",
  "25": "greek",
  "26": "romanian",
  "27": "thai",
  "28": "vietnamese",
  "29": "indonesian",
  "30": "ukrainian",
};

function ttypeToLabel(ttype) {
  const t = String(ttype || "").toLowerCase().trim();
  if (t === "p" || t === "platinum") return "platinum";
  if (t === "g" || t === "gold") return "gold";
  if (t === "s" || t === "silver") return "silver";
  if (t === "b" || t === "bronze") return "bronze";
  return t || "unknown";
}

function mapLangFromFilename(filename) {
  const base = path.basename(filename).toLowerCase();
  if (base === "trop.xml") return "english";
  const match = base.match(/trop_(\d{2})\.xml$/);
  if (!match) return "";
  return PS4_LANG_MAP[match[1]] || "";
}

function parseXmlFile(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  return cheerio.load(raw, { xmlMode: true, decodeEntities: false });
}

function readLangFiles(xmlDir) {
  const files = fs
    .readdirSync(xmlDir)
    .filter((f) => /^trop(_\d{2})?\.xml$/i.test(f));
  files.sort();
  return files;
}

function parsePs4TrophySetDir(trophyDir) {
  // trophyDir expected: .../TrophyFiles/trophy00
  const xmlDir = path.join(trophyDir, "Xml");
  const iconsDir = path.join(trophyDir, "Icons");
  const xmlFiles = readLangFiles(xmlDir);
  if (!xmlFiles.length) throw new Error("No TROP*.XML found");

  const baseFile =
    xmlFiles.find((f) => f.toLowerCase() === "trop_01.xml") ||
    xmlFiles.find((f) => f.toLowerCase() === "trop.xml") ||
    xmlFiles[0];
  const baseDoc = parseXmlFile(path.join(xmlDir, baseFile));
  const npcommid = baseDoc("npcommid").first().text().trim() || "";
  const titleName = baseDoc("title-name").first().text().trim() || npcommid;
  const appid = path.basename(path.dirname(path.dirname(trophyDir))); // CUSA*

  const trophies = new Map(); // id -> trophy obj

  // Helper to ensure entry exists
  const ensureEntry = (id) => {
    const key = String(id);
    if (!trophies.has(key)) {
      trophies.set(key, {
        id: key,
        hidden: 0,
        imageId: Number(key),
        displayName: {},
        description: {},
      });
    }
    return trophies.get(key);
  };

  // Process language files
  for (const file of xmlFiles) {
    const langKey = mapLangFromFilename(file) || "english";
    const $ = parseXmlFile(path.join(xmlDir, file));
    $("trophy").each((_, el) => {
      const id = $(el).attr("id");
      if (id === undefined) return;
      const entry = ensureEntry(id);
      const hiddenAttr = ($(el).attr("hidden") || "no").toLowerCase();
      if (hiddenAttr === "yes") entry.hidden = 1;
      const trophyType = ttypeToLabel($(el).attr("ttype") || entry.trophyType);
      if (trophyType) entry.trophyType = trophyType;
      const name = $(el).children("name").first().text().trim();
      const detail = $(el).children("detail").first().text().trim();
      if (name) entry.displayName[langKey] = name;
      if (detail) entry.description[langKey] = detail;
    });
  }

  // Fill missing langs with english fallback
  for (const entry of trophies.values()) {
    const enName = entry.displayName.english || "";
    const enDesc = entry.description.english || "";
    for (const lang of Object.values(PS4_LANG_MAP)) {
      if (!lang) continue;
      if (!entry.displayName[lang]) entry.displayName[lang] = enName;
      if (!entry.description[lang]) entry.description[lang] = enDesc;
    }
    // Also ensure english exists
    if (!entry.displayName.english) entry.displayName.english = enName || "";
    if (!entry.description.english) entry.description.english = enDesc || "";
    if (!entry.trophyType) entry.trophyType = "unknown";
  }

  return {
    appid,
    npcommid,
    title: titleName,
    trophies: Array.from(trophies.values()).sort((a, b) => Number(a.id) - Number(b.id)),
    xmlDir,
    iconsDir,
    trophyDir,
  };
}

function buildSchemaFromPs4(parsed) {
  if (!parsed?.trophies) return [];
  return parsed.trophies.map((t) => {
    const pad = String(t.imageId ?? t.id).padStart(3, "0");
    const iconPath = `img/TROP${pad}.PNG`;
    return {
      name: String(t.id),
      displayName: t.displayName || { english: "" },
      description: t.description || { english: "" },
      hidden: Number(t.hidden) ? 1 : 0,
      trophyType: ttypeToLabel(t.trophyType),
      icon: iconPath,
      icon_gray: iconPath,
      imageId: Number(t.imageId ?? t.id),
    };
  });
}

function buildSnapshotFromPs4(parsed, prev = {}) {
  const snapshot = { ...prev };
  if (!parsed?.trophies) return snapshot;
  // Scan all XML files for unlockstate
  const xmlFiles = readLangFiles(parsed.xmlDir);
  for (const file of xmlFiles) {
    const $ = parseXmlFile(path.join(parsed.xmlDir, file));
    $("trophy").each((_, el) => {
      const id = $(el).attr("id");
      if (id === undefined) return;
      const unlocked =
        (($(el).attr("unlockstate") || "").toLowerCase() === "true") ||
        (($(el).attr("unlocked") || "").toLowerCase() === "yes");
      const tsRaw = $(el).attr("timestamp");
      const ts = tsRaw ? Number(tsRaw) : null;
      const key = String(id);
      const prevEntry = snapshot[key] || {};
      if (unlocked) {
        snapshot[key] = {
          ...prevEntry,
          earned: true,
          earned_time: ts || prevEntry.earned_time || null,
        };
      } else if (!snapshot[key]) {
        snapshot[key] = { earned: false, earned_time: 0 };
      }
    });
  }
  for (const [key, entry] of Object.entries(snapshot)) {
    if (!entry || typeof entry !== "object") continue;
    if (entry.earned_time == null) {
      snapshot[key] = { ...entry, earned_time: 0 };
    }
  }
  return snapshot;
}

function buildSnapshotFromPs4ProgressFile(progressXmlPath, prev = {}) {
  const snapshot = { ...prev };
  if (!progressXmlPath || !fs.existsSync(progressXmlPath)) return snapshot;
  const $ = parseXmlFile(progressXmlPath);
  $("trophy").each((_, el) => {
    const id = $(el).attr("id");
    if (id === undefined) return;
    const unlocked =
      (($(el).attr("unlockstate") || "").toLowerCase() === "true") ||
      (($(el).attr("unlocked") || "").toLowerCase() === "yes");
    const tsRaw = $(el).attr("timestamp");
    const ts = tsRaw ? Number(tsRaw) : null;
    const key = String(id);
    const prevEntry = snapshot[key] || {};
    if (unlocked) {
      snapshot[key] = {
        ...prevEntry,
        earned: true,
        earned_time: ts || prevEntry.earned_time || null,
      };
    } else if (!snapshot[key]) {
      snapshot[key] = { earned: false, earned_time: 0 };
    }
  });
  for (const [key, entry] of Object.entries(snapshot)) {
    if (!entry || typeof entry !== "object") continue;
    if (entry.earned_time == null) {
      snapshot[key] = { ...entry, earned_time: 0 };
    }
  }
  return snapshot;
}

module.exports = {
  parsePs4TrophySetDir,
  buildSchemaFromPs4,
  buildSnapshotFromPs4,
  buildSnapshotFromPs4ProgressFile,
  PS4_LANG_MAP,
  mapLangFromFilename,
  ttypeToLabel,
};
