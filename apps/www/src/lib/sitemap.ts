import { siteUrl } from "./site";

/** Public, indexable pages. Signed-in, internal, and OG-card routes stay out. */
const STATIC_SITEMAP_PATHS = ["/", "/stats", "/privacy", "/terms"] as const;

interface SitemapEntry {
  /** YYYY-MM-DD, when known. */
  lastModified?: string | null;
  path: string;
}

function buildSitemapXml(entries: readonly SitemapEntry[]): string {
  const urls = entries.map((entry) => {
    const lastModified =
      entry.lastModified === undefined || entry.lastModified === null
        ? ""
        : `<lastmod>${escapeXml(entry.lastModified)}</lastmod>`;
    return `  <url><loc>${escapeXml(siteUrl(entry.path))}</loc>${lastModified}</url>`;
  });

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls,
    "</urlset>",
    "",
  ].join("\n");
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export { buildSitemapXml, STATIC_SITEMAP_PATHS };

export type { SitemapEntry };
