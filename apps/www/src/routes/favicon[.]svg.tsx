import { createFileRoute } from "@tanstack/react-router";

import { buildFaviconSvg, FAVICON_CACHE_CONTROL, faviconSvgResponse } from "../lib/favicon-svg";

function handleDefaultFaviconRequest(): Response {
  return faviconSvgResponse(buildFaviconSvg(null), FAVICON_CACHE_CONTROL, "default");
}

const Route = createFileRoute("/favicon.svg")({
  server: {
    handlers: {
      GET: handleDefaultFaviconRequest,
    },
  },
});

export { handleDefaultFaviconRequest, Route };
