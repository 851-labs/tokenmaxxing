import geistRegular from "@fontsource/geist-sans/files/geist-sans-latin-400-normal.woff2?inline";
import geistSemibold from "@fontsource/geist-sans/files/geist-sans-latin-600-normal.woff2?inline";
import { createFileRoute } from "@tanstack/react-router";

import {
  parseReadmeCardOptions,
  renderReadmeCard,
  renderReadmeCardPlaceholder,
} from "../../lib/readme-card";
import type { ReadmeCardData, ReadmeCardFonts } from "../../lib/readme-card";
import { loadReadmeCardData } from "../../lib/readme-card-data";

interface ReadmeCardRouteContext {
  params: {
    login: string;
  };
  request: Request;
}

interface ReadmeCardRouteDeps {
  fonts: ReadmeCardFonts | null;
  loadReadmeCardData(login: string): Promise<ReadmeCardData | null>;
}

// GitHub's camo proxy honours these, so READMEs refresh roughly every half hour.
const CARD_CACHE_CONTROL = "public, max-age=1800, stale-while-revalidate=86400";
const MISSING_CACHE_CONTROL = "public, max-age=300";
const ERROR_CACHE_CONTROL = "public, max-age=60";

const defaultDeps: ReadmeCardRouteDeps = {
  fonts: { regular: geistRegular, semibold: geistSemibold },
  loadReadmeCardData,
};

function makeReadmeCardHandler(deps: ReadmeCardRouteDeps = defaultDeps) {
  return async function handleReadmeCardRequest({ params, request }: ReadmeCardRouteContext) {
    const options = parseReadmeCardOptions(new URL(request.url).searchParams);
    try {
      const data = await deps.loadReadmeCardData(params.login);
      if (data === null) {
        return svgResponse(
          renderReadmeCardPlaceholder(params.login, options.theme, "missing", deps.fonts),
          { cacheControl: MISSING_CACHE_CONTROL },
        );
      }

      return svgResponse(renderReadmeCard(data, options, deps.fonts), {
        cacheControl: CARD_CACHE_CONTROL,
      });
    } catch (error) {
      console.warn("README card load failed", { error, login: params.login });
      return svgResponse(
        renderReadmeCardPlaceholder(params.login, options.theme, "unavailable", deps.fonts),
        { cacheControl: ERROR_CACHE_CONTROL },
      );
    }
  };
}

// Always 200: GitHub's camo proxy shows a broken image for any other status.
function svgResponse(body: string, init: { cacheControl: string }): Response {
  return new Response(body, {
    headers: {
      "cache-control": init.cacheControl,
      "content-security-policy":
        "default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'",
      "content-type": "image/svg+xml; charset=utf-8",
    },
  });
}

const handleReadmeCardRequest = makeReadmeCardHandler();

const Route = createFileRoute("/card/{$login}.svg")({
  server: {
    handlers: {
      GET: handleReadmeCardRequest,
    },
  },
});

export { CARD_CACHE_CONTROL, handleReadmeCardRequest, makeReadmeCardHandler, Route };

export type { ReadmeCardRouteContext, ReadmeCardRouteDeps };
