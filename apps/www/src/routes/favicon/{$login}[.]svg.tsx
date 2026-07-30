import { createFileRoute } from "@tanstack/react-router";

import { resolveApiUrl } from "../../lib/config";
import {
  buildFaviconSvg,
  faviconSvgResponse,
  PROFILE_FAVICON_CACHE_CONTROL,
  responseImageDataUrl,
} from "../../lib/favicon-svg";

interface ProfileFaviconRouteContext {
  params: {
    login: string;
  };
  request: Request;
}

interface ProfileFaviconData {
  avatarUrl: string | null;
  login: string;
}

interface ProfileFaviconRouteDeps {
  fetchAvatar(url: string): Promise<Response>;
  loadProfile(login: string): Promise<ProfileFaviconData | null>;
}

const defaultDeps: ProfileFaviconRouteDeps = {
  fetchAvatar: (url) =>
    fetch(url, {
      headers: {
        accept: "image/avif,image/webp,image/png,image/jpeg,image/gif",
      },
    }),
  loadProfile: loadProfileFaviconData,
};

function makeProfileFaviconHandler(deps: ProfileFaviconRouteDeps = defaultDeps) {
  return async function handleProfileFaviconRequest({
    params,
  }: ProfileFaviconRouteContext): Promise<Response> {
    const profile = await deps.loadProfile(params.login);
    if (profile === null) {
      return new Response("Not found", {
        headers: {
          "cache-control": "public, max-age=60",
        },
        status: 404,
      });
    }

    let avatarDataUrl: string | null = null;
    if (profile.avatarUrl !== null && isSafeAvatarUrl(profile.avatarUrl)) {
      try {
        avatarDataUrl = await responseImageDataUrl(await deps.fetchAvatar(profile.avatarUrl));
      } catch {
        avatarDataUrl = null;
      }
    }

    return faviconSvgResponse(
      buildFaviconSvg(avatarDataUrl),
      PROFILE_FAVICON_CACHE_CONTROL,
      avatarDataUrl === null ? "fallback" : "profile",
    );
  };
}

async function loadProfileFaviconData(login: string): Promise<ProfileFaviconData | null> {
  const apiUrl = resolveApiUrl().replace(/\/$/, "");
  const response = await fetch(`${apiUrl}/profiles/${encodeURIComponent(login)}`);
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`Failed to load favicon profile ${login}: ${response.status}`);
  }

  const payload = (await response.json()) as {
    user: {
      avatarUrl: string | null;
      login: string;
    };
  };
  return payload.user;
}

function isSafeAvatarUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
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
  handleProfileFaviconRequest,
  isSafeAvatarUrl,
  loadProfileFaviconData,
  makeProfileFaviconHandler,
  Route,
};

export type { ProfileFaviconData, ProfileFaviconRouteContext, ProfileFaviconRouteDeps };
