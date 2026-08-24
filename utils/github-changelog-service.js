"use strict";

const fs = require("fs");
const path = require("path");

const { writeJsonAtomic } = require("./atomic-json-store");

const DEFAULT_CACHE_TTL_MS = 30 * 60 * 1000;
const MAX_RELEASES = 500;
const MAX_RELEASE_BODY_CHARS = 200000;

function normalizeRelease(entry = {}) {
  if (!entry || entry.draft === true) return null;
  const tag = String(entry.tag_name || entry.tag || "").trim();
  if (!tag) return null;
  return {
    id: String(entry.id || tag),
    tag,
    name: String(entry.name || tag).trim() || tag,
    body: String(entry.body || "").slice(0, MAX_RELEASE_BODY_CHARS),
    url: String(entry.html_url || entry.url || ""),
    publishedAt: String(
      entry.published_at || entry.publishedAt || entry.created_at || "",
    ),
    prerelease: entry.prerelease === true,
  };
}

function hasNextPage(linkHeader) {
  return String(linkHeader || "")
    .split(",")
    .some((part) => /rel="next"/i.test(part));
}

function createGitHubChangelogService(options = {}) {
  const httpClient = options.httpClient;
  const cachePath = path.resolve(String(options.cachePath || ""));
  const owner = String(options.owner || "PSerban93");
  const repo = String(options.repo || "Achievements");
  const logger = options.logger || null;
  const cacheTtlMs = Math.max(
    60000,
    Number(options.cacheTtlMs) || DEFAULT_CACHE_TTL_MS,
  );
  let memoryCache = null;
  let inFlight = null;

  async function readCache() {
    if (memoryCache?.releases?.length) return memoryCache;
    try {
      const parsed = JSON.parse(await fs.promises.readFile(cachePath, "utf8"));
      if (!Array.isArray(parsed?.releases)) return null;
      memoryCache = {
        fetchedAt: Number(parsed.fetchedAt) || 0,
        releases: parsed.releases.map(normalizeRelease).filter(Boolean),
      };
      return memoryCache;
    } catch {
      return null;
    }
  }

  async function fetchReleases() {
    if (!httpClient || typeof httpClient.get !== "function") {
      throw new Error("GitHub HTTP client is unavailable");
    }
    const releases = [];
    for (let page = 1; page <= 5 && releases.length < MAX_RELEASES; page += 1) {
      const response = await httpClient.get(
        `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases`,
        {
          params: { per_page: 100, page },
          headers: {
            Accept: "application/vnd.github+json",
            "User-Agent": "Achievements-Changelog",
            "X-GitHub-Api-Version": "2022-11-28",
          },
          timeout: 15000,
        },
      );
      const pageItems = Array.isArray(response?.data) ? response.data : [];
      releases.push(...pageItems.map(normalizeRelease).filter(Boolean));
      if (pageItems.length < 100 || !hasNextPage(response?.headers?.link)) break;
    }
    const payload = {
      fetchedAt: Date.now(),
      releases: releases.slice(0, MAX_RELEASES),
    };
    memoryCache = payload;
    await writeJsonAtomic(cachePath, payload, { backup: true });
    logger?.info?.("changelog:fetch-complete", {
      releases: payload.releases.length,
    });
    return payload;
  }

  async function list(options = {}) {
    const force = options.force === true;
    const cached = await readCache();
    if (
      !force &&
      cached?.releases?.length &&
      Date.now() - cached.fetchedAt <= cacheTtlMs
    ) {
      return { ...cached, source: "cache", stale: false };
    }
    if (!inFlight) {
      inFlight = fetchReleases().finally(() => {
        inFlight = null;
      });
    }
    try {
      const fresh = await inFlight;
      return { ...fresh, source: "github", stale: false };
    } catch (error) {
      logger?.warn?.("changelog:fetch-failed", {
        error: error?.message || String(error),
      });
      if (cached?.releases?.length) {
        return { ...cached, source: "cache", stale: true };
      }
      throw error;
    }
  }

  return { list };
}

module.exports = {
  createGitHubChangelogService,
  normalizeRelease,
};
