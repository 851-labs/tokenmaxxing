import { createFileRoute } from "@tanstack/react-router";
import { ProfileIdentityResponse } from "@tokenmaxxing/api-contract";

import { fetchPublicProfile } from "../../lib/public-api";
import {
  parseReadmeCardOptions,
  README_CARD_LAYOUT_VERSION,
  renderReadmeCard,
  renderReadmeCardPlaceholder,
} from "../../lib/readme-card";
import type { ReadmeCardOptions } from "../../lib/readme-card";
import { loadReadmeCardData } from "../../lib/readme-card-data";
import type { LoadedReadmeCard, ReadmeCardIdentity } from "../../lib/readme-card-data";

interface ReadmeCardRouteContext {
  params: {
    login: string;
  };
  request: Request;
}

interface ReadmeCardCache {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<unknown>;
}

interface ReadmeCardRouteDeps {
  cache(): ReadmeCardCache | null;
  loadCard(identity: ReadmeCardIdentity): Promise<LoadedReadmeCard | null>;
  loadIdentity(login: string, signal: AbortSignal): Promise<ReadmeCardIdentity | null>;
}

const IDENTITY_TIMEOUT_MS = 2_500;

// GitHub's image proxy (camo) honours this, so a README shows numbers at most
// about an hour old: up to 30 minutes in the edge cache here, then up to 30
// in camo. A profile that was just hidden disappears from READMEs within the
// camo half hour, since visibility is checked here on every request.
const CARD_CACHE_CONTROL = "public, max-age=1800";
const MISSING_CACHE_CONTROL = "public, max-age=300";
const TRANSIENT_CACHE_CONTROL = "public, max-age=60";

const defaultDeps: ReadmeCardRouteDeps = {
  cache: defaultReadmeCardCache,
  loadCard: (identity) => loadReadmeCardData(identity),
  loadIdentity: (login, signal) =>
    fetchPublicProfile(login, "/identity", ProfileIdentityResponse, { signal }),
};

/**
 * A profile's stats as an SVG for a GitHub README. Always answers 200 with an
 * image: GitHub's proxy shows a broken image for any other status, so a
 * missing or hidden profile and an API failure get a small placeholder card.
 *
 * Visibility is checked on every request, before the cache: a cached card
 * must not keep serving a profile that was just hidden (shadow-banned) or
 * removed. The cache only saves the stats reads, the avatar fetch and the
 * render. An old login (a renamed user) is answered with the current
 * profile's card rather than a redirect, so READMEs keep working unchanged.
 */
function makeReadmeCardHandler(overrides: Partial<ReadmeCardRouteDeps> = {}) {
  const deps = { ...defaultDeps, ...overrides };

  return async function handleReadmeCardRequest({
    params,
    request,
  }: ReadmeCardRouteContext): Promise<Response> {
    const options = parseReadmeCardOptions(new URL(request.url).searchParams);
    const placeholder = (reason: "missing" | "unavailable") =>
      svgResponse(
        renderReadmeCardPlaceholder(params.login, options.theme, reason),
        reason === "missing" ? MISSING_CACHE_CONTROL : TRANSIENT_CACHE_CONTROL,
      );

    let identity: ReadmeCardIdentity | null;
    try {
      identity = await deps.loadIdentity(params.login, AbortSignal.timeout(IDENTITY_TIMEOUT_MS));
    } catch (error) {
      console.warn("README card identity load failed", { error, login: params.login });
      return placeholder("unavailable");
    }
    if (identity === null) {
      return placeholder("missing");
    }

    const cache = deps.cache();
    const cacheKey = canonicalReadmeCardRequest(request, identity.login, options);
    const cached = await readCachedCard(cache, cacheKey);
    if (cached !== null) {
      return cached;
    }

    let card: LoadedReadmeCard | null;
    try {
      card = await deps.loadCard(identity);
    } catch (error) {
      console.warn("README card load failed", { error, login: identity.login });
      return placeholder("unavailable");
    }
    // Hidden or removed between the identity read and the stats reads.
    if (card === null) {
      return placeholder("missing");
    }

    const response = svgResponse(
      renderReadmeCard(card.data, options),
      card.avatarFailed ? TRANSIENT_CACHE_CONTROL : CARD_CACHE_CONTROL,
    );
    return storeCachedCard(cache, cacheKey, response);
  };
}

/**
 * One cache entry per profile and card variant: keyed by the canonical login
 * and the parsed options, whatever the URL's case, old login, parameter
 * order or unknown parameters.
 */
function canonicalReadmeCardRequest(
  request: Request,
  login: string,
  options: ReadmeCardOptions,
): Request {
  const url = new URL(request.url);
  url.pathname = `/card/${encodeURIComponent(login)}.svg`;
  url.hash = "";
  url.search = "";
  url.searchParams.set("hide", options.hideSpend ? "spend" : "");
  url.searchParams.set("layout", options.layout);
  url.searchParams.set("theme", options.theme);
  url.searchParams.set("v", README_CARD_LAYOUT_VERSION);
  return new Request(url, { method: "GET" });
}

function svgResponse(body: string, cacheControl: string): Response {
  return new Response(body, {
    headers: {
      "cache-control": cacheControl,
      // The card needs nothing but its own inline styles and avatar. Setting a
      // policy here replaces the site-wide one, so framing is denied again.
      "content-security-policy":
        "default-src 'none'; img-src data:; style-src 'unsafe-inline'; frame-ancestors 'none'",
      "content-type": "image/svg+xml; charset=utf-8",
    },
  });
}

function defaultReadmeCardCache(): ReadmeCardCache | null {
  if (import.meta.env.DEV) {
    return null;
  }

  const cacheStorage = (globalThis as { caches?: { default?: ReadmeCardCache } }).caches;
  return cacheStorage?.default ?? null;
}

async function readCachedCard(
  cache: ReadmeCardCache | null,
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

async function storeCachedCard(
  cache: ReadmeCardCache | null,
  request: Request,
  response: Response,
): Promise<Response> {
  if (cache !== null) {
    try {
      await cache.put(request, response.clone());
    } catch {
      // A cache outage must not cost the card.
    }
  }

  return response;
}

const handleReadmeCardRequest = makeReadmeCardHandler();

const Route = createFileRoute("/card/{$login}.svg")({
  server: {
    handlers: {
      GET: handleReadmeCardRequest,
    },
  },
});

export {
  canonicalReadmeCardRequest,
  CARD_CACHE_CONTROL,
  handleReadmeCardRequest,
  makeReadmeCardHandler,
  Route,
};

export type { ReadmeCardCache, ReadmeCardRouteContext, ReadmeCardRouteDeps };
