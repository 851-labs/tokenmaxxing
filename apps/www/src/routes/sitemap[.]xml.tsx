import { createFileRoute } from "@tanstack/react-router";
import { LeaderboardResponse } from "@tokenmaxxing/api-contract";

import { textResponse } from "../lib/http";
import { fetchPublicJson } from "../lib/public-api";
import { buildSitemapXml, STATIC_SITEMAP_PATHS, type SitemapEntry } from "../lib/sitemap";

type Leaderboard = typeof LeaderboardResponse.Type;

interface SitemapRouteDeps {
  loadLeaderboard(): Promise<Leaderboard | null>;
}

const SITEMAP_CACHE_CONTROL = "public, max-age=3600, stale-while-revalidate=86400";
/** Retry soon when the profile list couldn't be loaded. */
const PARTIAL_SITEMAP_CACHE_CONTROL = "public, max-age=300";

const defaultDeps: SitemapRouteDeps = {
  loadLeaderboard: () =>
    fetchPublicJson("/leaderboard?metric=spend&window=all", LeaderboardResponse),
};

function makeSitemapHandler(deps: SitemapRouteDeps = defaultDeps) {
  return async function handleSitemapRequest(): Promise<Response> {
    const pages: SitemapEntry[] = STATIC_SITEMAP_PATHS.map((path) => ({ path }));
    let profiles: SitemapEntry[] = [];
    let complete = true;
    try {
      const leaderboard = await deps.loadLeaderboard();
      profiles = (leaderboard?.entries ?? []).map((entry) => ({
        lastModified: entry.lastDate,
        path: `/${encodeURIComponent(entry.user.login)}`,
      }));
    } catch (error) {
      console.warn("Sitemap leaderboard load failed", { error });
      complete = false;
    }

    return textResponse(buildSitemapXml([...pages, ...profiles]), {
      cacheControl: complete ? SITEMAP_CACHE_CONTROL : PARTIAL_SITEMAP_CACHE_CONTROL,
      contentType: "application/xml; charset=utf-8",
    });
  };
}

const Route = createFileRoute("/sitemap.xml")({
  server: {
    handlers: {
      GET: makeSitemapHandler(),
    },
  },
});

export { makeSitemapHandler, Route };

export type { SitemapRouteDeps };
