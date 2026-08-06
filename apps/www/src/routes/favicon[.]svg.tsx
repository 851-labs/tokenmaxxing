import { createFileRoute } from "@tanstack/react-router";

import {
  buildFaviconSvg,
  faviconSvgResponse,
  PROFILE_FAVICON_CACHE_CONTROL,
} from "../lib/favicon-svg";

function handleDefaultFaviconRequest(): Response {
  return faviconSvgResponse(buildFaviconSvg(null), PROFILE_FAVICON_CACHE_CONTROL, "default");
}

const Route = createFileRoute("/favicon.svg")({
  server: {
    handlers: {
      GET: handleDefaultFaviconRequest,
    },
  },
});

export { handleDefaultFaviconRequest, Route };
