import * as Schema from "effect/Schema";
import { createFileRoute } from "@tanstack/react-router";
import { ProfileIdentityResponse } from "@tokenmaxxing/api-contract";

import { resolveApiUrl } from "../../lib/config";
import { PROFILE_FAVICON_LAYOUT_VERSION } from "../../lib/favicon";
import {
  avatarFetchUrl,
  buildFaviconSvg,
  faviconSvgResponse,
  PROFILE_FAVICON_CACHE_CONTROL,
  responseImageDataUrl,
  TRANSIENT_FAVICON_CACHE_CONTROL,
} from "../../lib/favicon-svg";
import type { FaviconFallbackReason } from "../../lib/favicon-svg";

type ProfileFaviconIdentity = typeof ProfileIdentityResponse.Type;

interface ProfileFaviconRouteContext {
  params: {
    login: string;
  };
  request: Request;
}

interface FaviconCache {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<unknown>;
}

interface ProfileFaviconRouteDeps {
  cache(): FaviconCache | null;
  fetchAvatar(url: string, init: RequestInit): Promise<Response>;
  loadIdentity(login: string, signal: AbortSignal): Promise<ProfileFaviconIdentity | null>;
}

const UPSTREAM_TIMEOUT_MS = 2_500;
const NOT_FOUND_CACHE_CONTROL = "public, max-age=60";

const defaultDeps: ProfileFaviconRouteDeps = {
  cache: defaultFaviconCache,
  fetchAvatar: (url, init) => fetch(url, init),
  loadIdentity: loadProfileFaviconIdentity,
};

function makeProfileFaviconHandler(overrides: Partial<ProfileFaviconRouteDeps> = {}) {
  const deps = { ...defaultDeps, ...overrides };

  return async function handleProfileFaviconRequest({
    params,
    request,
  }: ProfileFaviconRouteContext): Promise<Response> {
    const cache = deps.cache();
    const cacheKey = canonicalFaviconRequest(request);
    const cached = await readCachedFavicon(cache, cacheKey);
    if (cached !== null) {
      return cached;
    }

    let identity: ProfileFaviconIdentity | null;
    try {
      identity = await deps.loadIdentity(params.login, upstreamSignal());
    } catch (error) {
      console.warn("Profile favicon identity load failed", { error, login: params.login });
      return storeCachedFavicon(
        cache,
        cacheKey,
        withDevFallbackDetail(
          faviconSvgResponse(
            buildFaviconSvg(null),
            TRANSIENT_FAVICON_CACHE_CONTROL,
            "fallback",
            "identity-load-failed",
          ),
          error,
        ),
      );
    }

    if (identity === null) {
      return storeCachedFavicon(
        cache,
        cacheKey,
        new Response("Not found", {
          headers: { "cache-control": NOT_FOUND_CACHE_CONTROL },
          status: 404,
        }),
      );
    }

    let avatarDataUrl: string | null = null;
    let transientAvatarFailure = false;
    let fallbackReason: FaviconFallbackReason | undefined;
    const fetchUrl = identity.avatarUrl === null ? null : avatarFetchUrl(identity.avatarUrl);
    if (fetchUrl !== null) {
      try {
        const avatarResponse = await deps.fetchAvatar(fetchUrl, {
          headers: {
            accept: "image/avif,image/webp,image/png,image/jpeg,image/gif",
          },
          redirect: "manual",
          signal: upstreamSignal(),
        });
        avatarDataUrl = await responseImageDataUrl(avatarResponse);
        transientAvatarFailure = avatarDataUrl === null;
        fallbackReason = avatarDataUrl === null ? "avatar-response-rejected" : undefined;
      } catch (error) {
        console.warn("Profile favicon avatar fetch failed", { error, login: identity.login });
        avatarDataUrl = null;
        transientAvatarFailure = true;
        fallbackReason = "avatar-fetch-failed";
      }
    } else if (identity.avatarUrl !== null) {
      transientAvatarFailure = true;
      fallbackReason = "avatar-url-rejected";
    }

    const response = faviconSvgResponse(
      buildFaviconSvg(avatarDataUrl),
      transientAvatarFailure ? TRANSIENT_FAVICON_CACHE_CONTROL : PROFILE_FAVICON_CACHE_CONTROL,
      avatarDataUrl === null ? "fallback" : "profile",
      fallbackReason,
    );
    return storeCachedFavicon(cache, cacheKey, response);
  };
}

async function loadProfileFaviconIdentity(
  login: string,
  signal: AbortSignal,
): Promise<ProfileFaviconIdentity | null> {
  const apiUrl = resolveApiUrl().replace(/\/$/, "");
  const headers = new Headers({ accept: "application/json" });

  const response = await fetch(`${apiUrl}/profiles/${encodeURIComponent(login)}/identity`, {
    headers,
    redirect: "manual",
    signal,
  });
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`Failed to load favicon identity ${login}: ${response.status}`);
  }

  return Schema.decodeUnknownPromise(ProfileIdentityResponse)(await response.json());
}

function canonicalFaviconRequest(request: Request): Request {
  const url = new URL(request.url);
  url.hash = "";
  url.search = "";
  url.searchParams.set("v", PROFILE_FAVICON_LAYOUT_VERSION);
  return new Request(url, { method: "GET" });
}

function upstreamSignal(): AbortSignal {
  return AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);
}

function defaultFaviconCache(): FaviconCache | null {
  if (import.meta.env.DEV) {
    return null;
  }

  const cacheStorage = (globalThis as { caches?: { default?: FaviconCache } }).caches;
  return cacheStorage?.default ?? null;
}

function withDevFallbackDetail(response: Response, error: unknown): Response {
  if (import.meta.env.DEV) {
    const message = error instanceof Error ? error.message : String(error);
    response.headers.set("x-favicon-debug", message.slice(0, 200));
  }
  return response;
}

async function readCachedFavicon(
  cache: FaviconCache | null,
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

async function storeCachedFavicon(
  cache: FaviconCache | null,
  request: Request,
  response: Response,
): Promise<Response> {
  if (cache !== null) {
    try {
      await cache.put(request, response.clone());
    } catch {
      // A cache outage must not make a best-effort browser asset fail.
    }
  }

  return response;
}

const handleProfileFaviconRequest = makeProfileFaviconHandler();

const Route = createFileRoute("/favicon/{$login}.svg")({
  server: {
    handlers: {
      GET: handleProfileFaviconRequest,
    },
  },
});

export {
  canonicalFaviconRequest,
  handleProfileFaviconRequest,
  loadProfileFaviconIdentity,
  makeProfileFaviconHandler,
  Route,
};

export type {
  FaviconCache,
  ProfileFaviconIdentity,
  ProfileFaviconRouteContext,
  ProfileFaviconRouteDeps,
};
