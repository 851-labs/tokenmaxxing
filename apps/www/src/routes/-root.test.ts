import { describe, expect, it } from "vite-plus/test";

import { OG_IMAGE_HEIGHT, OG_IMAGE_WIDTH, SITE_OG_IMAGE_URL } from "../lib/og";
import { DEFAULT_FAVICON_URL, faviconUrlFromMatches } from "../lib/favicon";
import { DEFAULT_OG_IMAGE_URL, rootHead } from "./__root";

describe("root metadata", () => {
  it("keeps the touch icon in route metadata and the favicon in one reactive slot", () => {
    const head = rootHead();

    expect(linkHref(head.links, "icon")).toBeUndefined();
    expect(linkHref(head.links, "apple-touch-icon")).toBe("/apple-touch-icon.png");
    expect(faviconUrlFromMatches([{ routeId: "__root__" }])).toBe(DEFAULT_FAVICON_URL);
    expect(DEFAULT_FAVICON_URL).toBe("/favicon.svg?v=10");
  });

  it("uses the site card, not any one user's profile, as the default OG image", () => {
    const head = rootHead();

    expect(DEFAULT_OG_IMAGE_URL).toBe(SITE_OG_IMAGE_URL);
    expect(DEFAULT_OG_IMAGE_URL).toMatch(/^https:\/\/tokenmaxxing\.sh\/og\.png\?v=site-s\d+$/);
    expect(metaContent(head.meta, "property", "og:image")).toBe(DEFAULT_OG_IMAGE_URL);
    expect(metaContent(head.meta, "property", "og:image:width")).toBe(String(OG_IMAGE_WIDTH));
    expect(metaContent(head.meta, "property", "og:image:height")).toBe(String(OG_IMAGE_HEIGHT));
    expect(metaContent(head.meta, "name", "twitter:card")).toBe("summary_large_image");
    expect(metaContent(head.meta, "name", "twitter:image")).toBe(DEFAULT_OG_IMAGE_URL);
  });

  it("leaves og:url and canonical to each page", () => {
    const head = rootHead();

    expect(metaContent(head.meta, "property", "og:url")).toBeUndefined();
    expect(linkHref(head.links, "canonical")).toBeUndefined();
  });
});

function linkHref(links: ReturnType<typeof rootHead>["links"], rel: string): string | undefined {
  return links.find((entry) => entry.rel === rel)?.href;
}

function metaContent(
  meta: ReturnType<typeof rootHead>["meta"],
  key: "name" | "property",
  value: string,
): string | undefined {
  const match = meta.find((entry) => key in entry && entry[key] === value);
  return match === undefined || !("content" in match) ? undefined : match.content;
}
