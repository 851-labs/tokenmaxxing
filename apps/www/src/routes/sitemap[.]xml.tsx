import { createFileRoute } from "@tanstack/react-router";

import { runApi } from "../lib/api";
import { SITE_ORIGIN } from "../lib/og";

/**
 * /sitemap.xml — public profile pages (sourced from the all-time leaderboard)
 * plus the static marketing/legal routes. Authenticated, internal, and
 * asset routes (login/settings/og/og-card) are intentionally excluded.
 */

const STATIC_PATHS = ["/", "/privacy", "/terms"] as const;

const CACHE_CONTROL = "public, max-age=3600, stale-while-revalidate=86400";

interface SitemapUrl {
  loc: string;
  lastmod?: string;
}

async function loadProfileUrls(): Promise<SitemapUrl[]> {
  try {
    const result = await runApi((client) =>
      client.leaderboard.list({ query: { metric: "spend", window: "all" } }),
    );

    return result.entries.map((entry) => ({
      loc: new URL(`/${encodeURIComponent(entry.user.login)}`, SITE_ORIGIN).toString(),
      ...(entry.lastDate === null ? {} : { lastmod: entry.lastDate }),
    }));
  } catch {
    // API failure must not break the sitemap — fall back to static URLs only.
    return [];
  }
}

function staticUrls(): SitemapUrl[] {
  return STATIC_PATHS.map((path) => ({
    loc: new URL(path, SITE_ORIGIN).toString(),
  }));
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function renderUrl(url: SitemapUrl): string {
  const lastmod = url.lastmod === undefined ? "" : `<lastmod>${escapeXml(url.lastmod)}</lastmod>`;
  return `<url><loc>${escapeXml(url.loc)}</loc>${lastmod}</url>`;
}

function renderSitemap(urls: SitemapUrl[]): string {
  const body = urls.map(renderUrl).join("");
  return `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${body}</urlset>`;
}

async function handleSitemapRequest(): Promise<Response> {
  const urls = [...staticUrls(), ...(await loadProfileUrls())];

  return new Response(renderSitemap(urls), {
    headers: {
      "cache-control": CACHE_CONTROL,
      "content-type": "application/xml; charset=utf-8",
    },
  });
}

const Route = createFileRoute("/sitemap.xml")({
  server: {
    handlers: {
      GET: handleSitemapRequest,
    },
  },
});

export { handleSitemapRequest, Route };
