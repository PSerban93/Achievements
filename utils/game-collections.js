const crypto = require("crypto");
const path = require("path");
const {
  readJsonWithBackupSync,
  writeJsonAtomic,
} = require("./atomic-json-store");

const COLLECTIONS_FORMAT_VERSION = 1;
const MAX_COLLECTIONS = 100;
const MAX_GAMES_PER_COLLECTION = 50000;
const MAX_COLLECTION_NAME_LENGTH = 64;
const DEFAULT_COLLECTION_COLOR = "#8be9fd";
const ALLOWED_COLLECTION_ICONS = new Set([
  "folder",
  "star",
  "heart",
  "gamepad",
  "trophy",
  "users",
  "clock",
  "bookmark",
]);

function normalizeText(value, maxLength = 255) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, maxLength);
}

function normalizePlatform(value) {
  return normalizeText(value, 80).toLowerCase() || "unknown";
}

function normalizeColor(value) {
  const color = normalizeText(value, 16);
  return /^#[0-9a-f]{6}$/i.test(color)
    ? color.toLowerCase()
    : DEFAULT_COLLECTION_COLOR;
}

function normalizeIcon(value) {
  const icon = normalizeText(value, 32).toLowerCase();
  return ALLOWED_COLLECTION_ICONS.has(icon) ? icon : "folder";
}

function normalizeCollectionName(value) {
  return normalizeText(value, MAX_COLLECTION_NAME_LENGTH);
}

function normalizeCollectionImageFile(value, collectionId) {
  const fileName = normalizeText(value, 120);
  const id = normalizeText(collectionId, 80);
  if (!fileName || !/^[a-f0-9-]{36}$/i.test(id)) return "";
  return new RegExp(`^${id}-[a-f0-9]{12}\\.(?:png|jpg|gif|webp)$`, "i").test(
    fileName,
  )
    ? fileName
    : "";
}

function normalizeGameReference(value) {
  if (!value || typeof value !== "object") return null;
  const configName = normalizeText(value.configName, 255);
  if (!configName) return null;
  return {
    configName,
    appid: normalizeText(value.appid, 160),
    platform: normalizePlatform(value.platform),
  };
}

function buildGameReferenceKey(value) {
  const game = normalizeGameReference(value);
  if (!game) return "";
  return [
    game.platform,
    game.appid.toLowerCase(),
    game.configName.toLocaleLowerCase("en-US"),
  ].join("::");
}

function normalizeCollection(value) {
  if (!value || typeof value !== "object") return null;
  const id = normalizeText(value.id, 80);
  const name = normalizeCollectionName(value.name);
  if (!id || !name) return null;

  const games = [];
  const seen = new Set();
  for (const entry of (Array.isArray(value.games) ? value.games : []).slice(
    0,
    MAX_GAMES_PER_COLLECTION,
  )) {
    const game = normalizeGameReference(entry);
    const key = buildGameReferenceKey(game);
    if (!game || !key || seen.has(key)) continue;
    seen.add(key);
    games.push(game);
  }

  const createdAt = normalizeText(value.createdAt, 64) || new Date().toISOString();
  const updatedAt = normalizeText(value.updatedAt, 64) || createdAt;
  return {
    id,
    name,
    color: normalizeColor(value.color),
    icon: normalizeIcon(value.icon),
    imageFile: normalizeCollectionImageFile(value.imageFile, id),
    createdAt,
    updatedAt,
    games,
  };
}

function normalizeCollectionsPayload(value) {
  const collections = [];
  const ids = new Set();
  const names = new Set();
  const source = Array.isArray(value?.collections) ? value.collections : [];
  for (const entry of source.slice(0, MAX_COLLECTIONS)) {
    const collection = normalizeCollection(entry);
    if (!collection) continue;
    const nameKey = collection.name.toLocaleLowerCase("en-US");
    if (ids.has(collection.id) || names.has(nameKey)) continue;
    ids.add(collection.id);
    names.add(nameKey);
    collections.push(collection);
  }
  return { version: COLLECTIONS_FORMAT_VERSION, collections };
}

function clonePayload(value) {
  return JSON.parse(JSON.stringify(value));
}

function createGameCollectionsStore(options = {}) {
  const filePath = String(options.filePath || "").trim();
  if (!filePath || !path.isAbsolute(filePath)) {
    throw new Error("An absolute collections file path is required.");
  }

  const initialRead = readJsonWithBackupSync(filePath, { fallback: {} });
  let state = normalizeCollectionsPayload(initialRead?.value || {});
  let mutationQueue = Promise.resolve();

  const persist = async (payload) => {
    await writeJsonAtomic(filePath, payload, { backup: true });
  };

  const mutate = (operation) => {
    const task = mutationQueue.then(async () => {
      const draft = clonePayload(state);
      const result = await operation(draft);
      const nextState = normalizeCollectionsPayload(draft);
      await persist(nextState);
      state = nextState;
      return result;
    });
    mutationQueue = task.catch(() => {});
    return task;
  };

  const findById = (payload, id) =>
    payload.collections.find((entry) => entry.id === normalizeText(id, 80));

  return {
    get filePath() {
      return filePath;
    },

    list() {
      return clonePayload(state);
    },

    create(input = {}) {
      return mutate((draft) => {
        if (draft.collections.length >= MAX_COLLECTIONS) {
          throw new Error(`A maximum of ${MAX_COLLECTIONS} collections is supported.`);
        }
        const name = normalizeCollectionName(input.name);
        if (!name) throw new Error("Collection name is required.");
        const nameKey = name.toLocaleLowerCase("en-US");
        if (
          nameKey === "all games" ||
          draft.collections.some(
            (entry) => entry.name.toLocaleLowerCase("en-US") === nameKey,
          )
        ) {
          throw new Error("A collection with this name already exists.");
        }
        const now = new Date().toISOString();
        const collection = {
          id: crypto.randomUUID(),
          name,
          color: normalizeColor(input.color),
          icon: normalizeIcon(input.icon),
          imageFile: "",
          createdAt: now,
          updatedAt: now,
          games: [],
        };
        draft.collections.push(collection);
        return clonePayload(collection);
      });
    },

    update(id, input = {}) {
      return mutate((draft) => {
        const collection = findById(draft, id);
        if (!collection) throw new Error("Collection not found.");
        const name = normalizeCollectionName(input.name ?? collection.name);
        if (!name) throw new Error("Collection name is required.");
        const nameKey = name.toLocaleLowerCase("en-US");
        if (
          nameKey === "all games" ||
          draft.collections.some(
            (entry) =>
              entry.id !== collection.id &&
              entry.name.toLocaleLowerCase("en-US") === nameKey,
          )
        ) {
          throw new Error("A collection with this name already exists.");
        }
        collection.name = name;
        collection.color = normalizeColor(input.color ?? collection.color);
        collection.icon = normalizeIcon(input.icon ?? collection.icon);
        collection.updatedAt = new Date().toISOString();
        return clonePayload(collection);
      });
    },

    remove(id) {
      return mutate((draft) => {
        const normalizedId = normalizeText(id, 80);
        const before = draft.collections.length;
        draft.collections = draft.collections.filter(
          (entry) => entry.id !== normalizedId,
        );
        return before !== draft.collections.length;
      });
    },

    setImageFile(id, fileName = "") {
      return mutate((draft) => {
        const collection = findById(draft, id);
        if (!collection) throw new Error("Collection not found.");
        const normalized = fileName
          ? normalizeCollectionImageFile(fileName, collection.id)
          : "";
        if (fileName && !normalized) {
          throw new Error("Invalid collection image file.");
        }
        const previousImageFile = collection.imageFile || "";
        collection.imageFile = normalized;
        collection.updatedAt = new Date().toISOString();
        return { previousImageFile, imageFile: normalized };
      });
    },

    addGames(id, entries = []) {
      return mutate((draft) => {
        const collection = findById(draft, id);
        if (!collection) throw new Error("Collection not found.");
        const existing = new Set(collection.games.map(buildGameReferenceKey));
        let added = 0;
        for (const entry of Array.isArray(entries) ? entries : []) {
          const game = normalizeGameReference(entry);
          const key = buildGameReferenceKey(game);
          if (!game || !key || existing.has(key)) continue;
          if (collection.games.length >= MAX_GAMES_PER_COLLECTION) {
            throw new Error(
              `A maximum of ${MAX_GAMES_PER_COLLECTION} games per collection is supported.`,
            );
          }
          existing.add(key);
          collection.games.push(game);
          added += 1;
        }
        if (added) collection.updatedAt = new Date().toISOString();
        return { added, collection: clonePayload(collection) };
      });
    },

    removeGames(id, entries = []) {
      return mutate((draft) => {
        const collection = findById(draft, id);
        if (!collection) throw new Error("Collection not found.");
        const keys = new Set(
          (Array.isArray(entries) ? entries : [])
            .map(buildGameReferenceKey)
            .filter(Boolean),
        );
        const before = collection.games.length;
        collection.games = collection.games.filter(
          (entry) => !keys.has(buildGameReferenceKey(entry)),
        );
        const removed = before - collection.games.length;
        if (removed) collection.updatedAt = new Date().toISOString();
        return { removed, collection: clonePayload(collection) };
      });
    },

    removeConfig(config) {
      const target = normalizeGameReference(config);
      if (!target) return Promise.resolve({ removed: 0 });
      return mutate((draft) => {
        let removed = 0;
        const targetName = target.configName.toLocaleLowerCase("en-US");
        const targetKey = buildGameReferenceKey(target);
        for (const collection of draft.collections) {
          const before = collection.games.length;
          collection.games = collection.games.filter(
            (entry) =>
              buildGameReferenceKey(entry) !== targetKey &&
              entry.configName.toLocaleLowerCase("en-US") !== targetName,
          );
          if (before !== collection.games.length) {
            removed += before - collection.games.length;
            collection.updatedAt = new Date().toISOString();
          }
        }
        return { removed };
      });
    },

    renameConfig(previous, next) {
      const oldGame = normalizeGameReference(previous);
      const newGame = normalizeGameReference(next);
      if (!oldGame || !newGame) return Promise.resolve({ updated: 0 });
      return mutate((draft) => {
        const oldKey = buildGameReferenceKey(oldGame);
        const oldName = oldGame.configName.toLocaleLowerCase("en-US");
        let updated = 0;
        for (const collection of draft.collections) {
          let changed = false;
          collection.games = collection.games.map((entry) => {
            if (
              buildGameReferenceKey(entry) !== oldKey &&
              entry.configName.toLocaleLowerCase("en-US") !== oldName
            ) {
              return entry;
            }
            updated += 1;
            changed = true;
            return newGame;
          });
          if (changed) collection.updatedAt = new Date().toISOString();
        }
        return { updated };
      });
    },
  };
}

module.exports = {
  ALLOWED_COLLECTION_ICONS,
  COLLECTIONS_FORMAT_VERSION,
  DEFAULT_COLLECTION_COLOR,
  MAX_COLLECTIONS,
  MAX_GAMES_PER_COLLECTION,
  buildGameReferenceKey,
  createGameCollectionsStore,
  normalizeCollectionName,
  normalizeCollectionImageFile,
  normalizeCollectionsPayload,
  normalizeGameReference,
};
