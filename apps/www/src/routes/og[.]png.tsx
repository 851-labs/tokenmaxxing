import { createFileRoute } from "@tanstack/react-router";

import { SITE_OG_VERSION } from "../lib/og";
import {
  captureOgCardScreenshot,
  renderOgImage,
  SITE_OG_CACHE_SCOPE,
  type OgImageDeps,
  type OgImageTarget,
} from "../lib/og-image";
import { getOgRuntimeEnv } from "../lib/og-runtime";

/** The site-wide Open Graph image: a screenshot of `/og-card`. */

const SITE_OG_TARGET: OgImageTarget = {
  cardPath: "/og-card",
  currentVersion: SITE_OG_VERSION,
  scope: SITE_OG_CACHE_SCOPE,
};

const defaultDeps: OgImageDeps = {
  captureScreenshot: captureOgCardScreenshot,
  getRuntimeEnv: getOgRuntimeEnv,
};

function makeSiteOgImageHandler(deps: OgImageDeps = defaultDeps) {
  return function handleSiteOgImageRequest({
    context,
    request,
  }: {
    context?: unknown;
    request: Request;
  }): Promise<Response> {
    return renderOgImage(deps, {
      context,
      request,
      resolveTarget: async () => SITE_OG_TARGET,
    });
  };
}

const Route = createFileRoute("/og.png")({
  server: {
    handlers: {
      GET: makeSiteOgImageHandler(),
    },
  },
});

export { makeSiteOgImageHandler, Route };
