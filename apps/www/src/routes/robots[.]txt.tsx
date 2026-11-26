import { createFileRoute } from "@tanstack/react-router";

import { textResponse } from "../lib/http";
import { siteUrl } from "../lib/site";

const ROBOTS_CACHE_CONTROL = "public, max-age=3600";

/**
 * Everything is crawlable on purpose; nothing here is kept out of search by
 * a `Disallow`.
 *
 * - Pages that must stay out of results (/login, /login/cli, /settings,
 *   /internal, /design, the /og-card templates, empty profiles and 404s)
 *   say so with a `noindex` robots meta tag. A crawler only sees that tag if
 *   it may fetch the page, so disallowing one of them would undo it: a
 *   blocked URL that is linked from elsewhere can still be listed, bare.
 * - The image routes (/og.png, /og/{login}.png, /favicon.svg,
 *   /favicon/{login}.svg, and embeds such as a README card) have to stay
 *   fetchable: link-preview bots and Google's favicon fetcher obey
 *   robots.txt, and a blocked image is a broken card.
 * - Files that are not pages (llms.txt) carry an `X-Robots-Tag: noindex`
 *   header instead.
 *
 * The sitemap lists only the indexable pages.
 */
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
