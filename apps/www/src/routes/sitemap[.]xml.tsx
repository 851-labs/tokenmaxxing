import { createFileRoute } from "@tanstack/react-router";
import { LeaderboardResponse, utcDayKey } from "@tokenmaxxing/api-contract";

import { textResponse } from "../lib/http";
import { fetchPublicJson } from "../lib/public-api";
import { siteUrl } from "../lib/site";
import { buildSitemapXml, STATIC_SITEMAP_PATHS, type SitemapEntry } from "./-sitemap";

type Leaderboard = typeof LeaderboardResponse.Type;

interface SitemapCache {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<unknown>;
}

interface SitemapRouteDeps {
  /** Where a finished sitemap is kept between requests; null for none. */
  cache(): SitemapCache | null;
  /** One page of the all-time ranking, starting after `offset` ranks. */
  loadLeaderboard(offset: number): Promise<Leaderboard | null>;
  now(): Date;
}

const SITEMAP_CACHE_CONTROL = "public, max-age=3600, stale-while-revalidate=86400";
/** Retry soon when the profile list couldn't be loaded in full. */
const PARTIAL_SITEMAP_CACHE_CONTROL = "public, max-age=300";

/** The sitemap protocol's cap on one file; past it the list needs an index. */
const MAX_SITEMAP_URLS = 50_000;

/** One entry for the whole site, whatever URL or query the request used. */
const SITEMAP_CACHE_KEY = siteUrl("/sitemap.xml");

const defaultDeps: SitemapRouteDeps = {
  cache: defaultSitemapCache,
  loadLeaderboard: (offset) =>
    fetchPublicJson(`/leaderboard?metric=spend&window=all&offset=${offset}`, LeaderboardResponse),
  now: () => new Date(),
};

interface RankedProfiles {
  /** False when a page failed to load, so some profiles are missing. */
  complete: boolean;
  entries: Leaderboard["entries"];
}

/**
 * Every ranked profile, not only the leaderboard's first page. The all-time
 * ranking holds each visible user with usage, so hidden (shadow-banned) and
 * empty profiles never reach the sitemap. The home page links only the top of
 * it until "Load more" is pressed, which a crawler never does: the sitemap is
 * how the rest are found.
 *
 * Pages are read one after another, each from the offset the last one named.
 * Every page is a ranking query over all usage, and the database runs one
 * query at a time: read together they would hold up every other request for
 * as long as they take. A later page that fails ends the read, and the
 * profiles loaded so far are still listed.
 */
async function loadRankedProfiles(
  loadLeaderboard: SitemapRouteDeps["loadLeaderboard"],
  limit: number,
): Promise<RankedProfiles> {
  const first = await loadLeaderboard(0);
  const entries = [...(first?.entries ?? [])];

  let offset = first?.nextOffset ?? null;
  while (offset !== null && entries.length < limit) {
    let page: Leaderboard | null;
    try {
      page = await loadLeaderboard(offset);
    } catch (error) {
      console.warn("Sitemap leaderboard page failed", { error, offset });
      return { complete: false, entries };
    }
    // An offset that does not move on would never end.
    const next: number | null = page?.nextOffset ?? null;
    if (page === null || (next !== null && next <= offset)) {
      console.warn("Sitemap leaderboard page unusable", { offset });
      return { complete: false, entries };
    }

    entries.push(...page.entries);
    offset = next;
  }

  return { complete: true, entries };
}

/**
 * The sitemap is built at most once an hour per edge location: a crawler
 * that fetches it (several do, daily or more) gets the stored copy instead of
 * setting off a read of the whole ranking. Only a complete sitemap is stored,
 * so one missing profiles is rebuilt on the next request.
 */
function makeSitemapHandler(overrides: Partial<SitemapRouteDeps> = {}) {
  const deps = { ...defaultDeps, ...overrides };

  return async function handleSitemapRequest(): Promise<Response> {
    const cache = deps.cache();
    const cacheKey = new Request(SITEMAP_CACHE_KEY, { method: "GET" });
    const cached = await readCachedSitemap(cache, cacheKey);
    if (cached !== null) {
      return cached;
    }

    const pages: SitemapEntry[] = STATIC_SITEMAP_PATHS.map((path) => ({ path }));
    const profileLimit = MAX_SITEMAP_URLS - pages.length;
    let profiles: SitemapEntry[] = [];
    let complete = true;
    // `lastDate` is the user's local day, which can run a day ahead of UTC;
    // a sitemap <lastmod> must not be in the future.
    const today = utcDayKey(deps.now());
    try {
      const ranked = await loadRankedProfiles(
        (offset) => deps.loadLeaderboard(offset),
        profileLimit,
      );
      complete = ranked.complete;
      // The ranking can shift between two page reads, which repeats a user
      // across pages; a URL belongs in the sitemap once.
      const seen = new Set<string>();
      for (const entry of ranked.entries) {
        if (seen.has(entry.user.login) || seen.size >= profileLimit) {
          continue;
        }
        seen.add(entry.user.login);
        profiles.push({
          lastModified: entry.lastDate !== null && entry.lastDate > today ? today : entry.lastDate,
          path: `/${encodeURIComponent(entry.user.login)}`,
        });
      }
    } catch (error) {
      console.warn("Sitemap leaderboard load failed", { error });
      profiles = [];
      complete = false;
    }

    const response = textResponse(buildSitemapXml([...pages, ...profiles]), {
      cacheControl: complete ? SITEMAP_CACHE_CONTROL : PARTIAL_SITEMAP_CACHE_CONTROL,
      contentType: "application/xml; charset=utf-8",
    });

    return complete ? storeCachedSitemap(cache, cacheKey, response) : response;
  };
}

function defaultSitemapCache(): SitemapCache | null {
  if (import.meta.env.DEV) {
    return null;
  }

  const cacheStorage = (globalThis as { caches?: { default?: SitemapCache } }).caches;
  return cacheStorage?.default ?? null;
}

async function readCachedSitemap(
  cache: SitemapCache | null,
  request: Request,
): Promise<Response | null> {
  if (cache === null) {
    return null;
  }

  try {
    return (await cache.match(request)) ?? null;
  } catch {
    return null;
  }
}

async function storeCachedSitemap(
  cache: SitemapCache | null,
  request: Request,
  response: Response,
): Promise<Response> {
  if (cache !== null) {
    try {
      await cache.put(request, response.clone());
    } catch {
      // A cache outage must not cost a crawler the sitemap.
    }
  }

  return response;
}

const Route = createFileRoute("/sitemap.xml")({
  server: {
    handlers: {
      GET: makeSitemapHandler(),
    },
  },
});

export { makeSitemapHandler, MAX_SITEMAP_URLS, Route };

export type { SitemapCache, SitemapRouteDeps };
