import { createFileRoute } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { ProfileIdentityResponse } from "@tokenmaxxing/api-contract";

import { textResponse } from "../lib/http";
import { fetchPublicJson } from "../lib/public-api";
import { buildSitemapXml, STATIC_SITEMAP_PATHS, type SitemapEntry } from "./-sitemap";

type ProfileIdentity = typeof ProfileIdentityResponse.Type;

interface SitemapRouteDeps {
  loadProfiles(): Promise<readonly ProfileIdentity[] | null>;
}

const SITEMAP_CACHE_CONTROL = "public, max-age=3600, stale-while-revalidate=86400";
/** Retry soon when the profile list couldn't be loaded. */
const PARTIAL_SITEMAP_CACHE_CONTROL = "public, max-age=300";

const defaultDeps: SitemapRouteDeps = {
  loadProfiles: () => fetchPublicJson("/profiles", Schema.Array(ProfileIdentityResponse)),
};

function makeSitemapHandler(deps: SitemapRouteDeps = defaultDeps) {
  return async function handleSitemapRequest(): Promise<Response> {
    const pages: SitemapEntry[] = STATIC_SITEMAP_PATHS.map((path) => ({ path }));
    let profiles: SitemapEntry[] = [];
    let complete = true;
    try {
      const identities = await deps.loadProfiles();
      profiles = (identities ?? []).map((profile) => ({
        path: `/${encodeURIComponent(profile.login)}`,
      }));
    } catch (error) {
      console.warn("Sitemap profile load failed", { error });
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
