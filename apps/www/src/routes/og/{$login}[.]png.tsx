import { createFileRoute } from "@tanstack/react-router";

import { profileOgVersion } from "../../lib/og";
import { loadProfileOgData, type ProfileOgData } from "../../lib/og-data";
import {
  captureOgCardScreenshot,
  ogCacheKey,
  PREVIEW_CACHE_CONTROL,
  renderOgImage,
  TRANSIENT_CACHE_CONTROL,
  VERSIONED_CACHE_CONTROL,
  type OgImageDeps,
} from "../../lib/og-image";
import { getOgRuntimeEnv } from "../../lib/og-runtime";

interface OgRouteContext {
  context?: unknown;
  params: {
    login: string;
  };
  request: Request;
}

interface OgRouteDeps extends OgImageDeps {
  loadProfileOgData(login: string): Promise<ProfileOgData | null>;
}

const defaultDeps: OgRouteDeps = {
  captureScreenshot: captureOgCardScreenshot,
  getRuntimeEnv: getOgRuntimeEnv,
  loadProfileOgData,
};

/**
 * A profile's Open Graph PNG. The profile is resolved first: an API failure
 * serves only the neutral fallback and a hidden profile 404s, both before any
 * cached card is read (see `renderOgImage`).
 */
function makeOgImageHandler(deps: OgRouteDeps = defaultDeps) {
  return function handleOgImageRequest({ context, params, request }: OgRouteContext) {
    return renderOgImage(deps, {
      context,
      request,
      resolveTarget: async () => {
        const data = await deps.loadProfileOgData(params.login);
        if (data === null) {
          return null;
        }

        const login = data.profile.user.login;
        return {
          cardPath: `/og-card/${encodeURIComponent(login)}`,
          currentVersion: profileOgVersion(data.profile),
          scope: login,
        };
      },
    });
  };
}

const handleOgImageRequest = makeOgImageHandler();

const Route = createFileRoute("/og/{$login}.png")({
  server: {
    handlers: {
      GET: handleOgImageRequest,
    },
  },
});

export {
  captureOgCardScreenshot,
  handleOgImageRequest,
  makeOgImageHandler,
  ogCacheKey,
  PREVIEW_CACHE_CONTROL,
  Route,
  TRANSIENT_CACHE_CONTROL,
  VERSIONED_CACHE_CONTROL,
};

export type { OgRouteContext, OgRouteDeps };
