import { describe, expect, it } from "vitest";

import { OG_IMAGE_HEIGHT, OG_IMAGE_WIDTH } from "../lib/og";
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

  it("uses pondorasti profile image as the non-profile OG fallback", () => {
    const head = rootHead();

    expect(metaContent(head.meta, "property", "og:image")).toBe(DEFAULT_OG_IMAGE_URL);
    expect(metaContent(head.meta, "property", "og:image:width")).toBe(String(OG_IMAGE_WIDTH));
    expect(metaContent(head.meta, "property", "og:image:height")).toBe(String(OG_IMAGE_HEIGHT));
    expect(metaContent(head.meta, "name", "twitter:card")).toBe("summary_large_image");
    expect(metaContent(head.meta, "name", "twitter:image")).toBe(DEFAULT_OG_IMAGE_URL);
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
