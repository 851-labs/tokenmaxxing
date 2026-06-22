import { createFileRoute } from "@tanstack/react-router";

import { SITE_ORIGIN } from "../lib/og";

const ROBOTS_CACHE_CONTROL = "public, max-age=3600";

function buildRobotsTxt(): string {
  const sitemapUrl = new URL("/sitemap.xml", SITE_ORIGIN).toString();
  return ["User-agent: *", "Allow: /", "", `Sitemap: ${sitemapUrl}`, ""].join("\n");
}

function handleRobotsTxtRequest(): Response {
  return new Response(buildRobotsTxt(), {
    headers: {
      "cache-control": ROBOTS_CACHE_CONTROL,
      "content-type": "text/plain; charset=utf-8",
    },
  });
}

const Route = createFileRoute("/robots.txt")({
  server: {
    handlers: {
      GET: handleRobotsTxtRequest,
    },
  },
});

export { buildRobotsTxt, handleRobotsTxtRequest, Route };
