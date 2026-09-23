import { QueryClient } from "@tanstack/react-query";
import { createMemoryHistory, createRouter } from "@tanstack/react-router";
import { describe, expect, it } from "vite-plus/test";

import { OG_IMAGE_HEIGHT, OG_IMAGE_WIDTH, SITE_OG_IMAGE_URL } from "../lib/og";
import { DEFAULT_FAVICON_URL, faviconUrlFromMatches } from "../lib/favicon";
import { routeTree } from "../routeTree.gen";
import { DEFAULT_OG_IMAGE_URL, NOT_FOUND_TITLE, rootHead } from "./__root";

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

describe("not-found metadata", () => {
  it("titles the 404 page and keeps it out of search results", () => {
    const head = rootHead({ notFound: true });

    expect(titleOf(head.meta)).toBe("Page not found — tokenmaxxing.sh");
    expect(metaContent(head.meta, "name", "robots")).toBe("noindex");
    expect(metaContent(rootHead().meta, "name", "robots")).toBeUndefined();
  });

  it("applies when the router renders its not-found page", async () => {
    // `$user` takes one segment, so two segments match no route.
    expect(await loadedTitles("/not/a-page")).toEqual([NOT_FOUND_TITLE]);
    expect(await loadedTitles("/privacy")).not.toContain(NOT_FOUND_TITLE);
  });
});

/** Every <title> the real router's matches carry after loading `href`. */
async function loadedTitles(href: string): Promise<string[]> {
  const router = createRouter({
    context: { queryClient: new QueryClient() },
    history: createMemoryHistory({ initialEntries: [href] }),
    routeTree,
  });
  await router.load();

  return router.state.matches.flatMap((match) =>
    (match.meta ?? []).flatMap((entry) =>
      entry !== undefined && "title" in entry && typeof entry.title === "string"
        ? [entry.title]
        : [],
    ),
  );
}

function titleOf(meta: ReturnType<typeof rootHead>["meta"]): string | undefined {
  const match = meta.find((entry) => "title" in entry);
  return match === undefined || !("title" in match) ? undefined : match.title;
}

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
