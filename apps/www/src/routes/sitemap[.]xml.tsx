import { createFileRoute } from "@tanstack/react-router";
import { ProfileIndexResponse, utcDayKey } from "@tokenmaxxing/api-contract";

import { textResponse } from "../lib/http";
import { fetchPublicJson } from "../lib/public-api";
import { siteUrl } from "../lib/site";
import { buildSitemapXml, STATIC_SITEMAP_PATHS, type SitemapEntry } from "./-sitemap";

type ProfileIndex = typeof ProfileIndexResponse.Type;

interface SitemapCache {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<unknown>;
}

interface SitemapRouteDeps {
  /** Where a finished sitemap is kept between requests; null for none. */
  cache(): SitemapCache | null;
  /** One page of the public profile index, after the login `after` (null for the first). */
  loadProfiles(after: string | null): Promise<ProfileIndex | null>;
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
  loadProfiles: (after) =>
    fetchPublicJson(
      after === null ? "/profiles" : `/profiles?after=${encodeURIComponent(after)}`,
      ProfileIndexResponse,
    ),
  now: () => new Date(),
};

interface PublicProfiles {
  /** False when a page failed to load, so some profiles are missing. */
  complete: boolean;
  entries: ProfileIndex["entries"][number][];
}

/**
 * Every public profile, from the API's profile index: each visible user with
 * usage (the users the all-time leaderboard ranks), so hidden (shadow-banned)
 * and empty profiles never reach the sitemap. The home page links only the
 * top of the ranking until "Load more" is pressed, which a crawler never
 * does: the sitemap is how the rest are found.
 *
 * The index is by login and unranked, so a page costs a few rows read per
 * user rather than a pass over all usage. Pages are still read one after
 * another, each from the login the last one named. A page that fails or does
 * not move on ends the read, and the profiles loaded so far are still listed.
 */
async function loadPublicProfiles(
  loadProfiles: SitemapRouteDeps["loadProfiles"],
  limit: number,
): Promise<PublicProfiles> {
  const entries: ProfileIndex["entries"][number][] = [];
  let after: string | null = null;

  do {
    let page: ProfileIndex | null;
    try {
      page = await loadProfiles(after);
    } catch (error) {
      console.warn("Sitemap profile page failed", { after, error });
      return { complete: false, entries };
    }
    // A cursor that does not move on would never end; a missing index (an
    // API without the endpoint yet) must not pass for an empty one.
    const next: string | null = page?.nextAfter ?? null;
    if (page === null || (next !== null && after !== null && next <= after)) {
      console.warn("Sitemap profile page unusable", { after });
      return { complete: false, entries };
    }

    entries.push(...page.entries);
    after = next;
  } while (after !== null && entries.length < limit);

  return { complete: true, entries };
}

/**
 * The sitemap is built at most once an hour per edge location: a crawler
 * that fetches it (several do, daily or more) gets the stored copy instead of
 * setting off a read of the whole profile index. Only a complete sitemap is
 * stored, so one missing profiles is rebuilt on the next request.
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
    const profiles: SitemapEntry[] = [];
    // `lastDate` is the user's local day, which can run a day ahead of UTC;
    // a sitemap <lastmod> must not be in the future.
    const today = utcDayKey(deps.now());
    const loaded = await loadPublicProfiles((after) => deps.loadProfiles(after), profileLimit);
    // Logins are unique and the pages are disjoint, but a rename between two
    // page reads can list a user twice; a URL belongs in the sitemap once.
    const seen = new Set<string>();
    for (const entry of loaded.entries) {
      if (seen.has(entry.login) || seen.size >= profileLimit) {
        continue;
      }
      seen.add(entry.login);
      profiles.push({
        lastModified: entry.lastDate > today ? today : entry.lastDate,
        path: `/${encodeURIComponent(entry.login)}`,
      });
    }

    const response = textResponse(buildSitemapXml([...pages, ...profiles]), {
      cacheControl: loaded.complete ? SITEMAP_CACHE_CONTROL : PARTIAL_SITEMAP_CACHE_CONTROL,
      contentType: "application/xml; charset=utf-8",
    });

    return loaded.complete ? storeCachedSitemap(cache, cacheKey, response) : response;
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
