import { createFileRoute } from "@tanstack/react-router";

import { textResponse } from "../lib/http";
import { siteUrl } from "../lib/site";

const ROBOTS_CACHE_CONTROL = "public, max-age=3600";

function buildRobotsTxt(): string {
  return ["User-agent: *", "Allow: /", "", `Sitemap: ${siteUrl("/sitemap.xml")}`, ""].join("\n");
}

function handleRobotsTxtRequest(): Response {
  return textResponse(buildRobotsTxt(), { cacheControl: ROBOTS_CACHE_CONTROL });
}

const Route = createFileRoute("/robots.txt")({
  server: {
    handlers: {
      GET: handleRobotsTxtRequest,
    },
  },
});

export { buildRobotsTxt, handleRobotsTxtRequest, Route };
