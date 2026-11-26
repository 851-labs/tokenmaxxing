import { describe, expect, it, onTestFinished, vi } from "vite-plus/test";

import { INDEXABLE_ROBOTS } from "../lib/seo";
import { Route as HomeRoute } from "./(home)/index";
import { Route as PrivacyRoute } from "./privacy";
import { buildRobotsTxt, handleRobotsTxtRequest } from "./robots[.]txt";
import { buildSitemapXml, STATIC_SITEMAP_PATHS } from "./-sitemap";
import { makeSitemapHandler, MAX_SITEMAP_URLS, type SitemapRouteDeps } from "./sitemap[.]xml";
import { Route as StatsRoute } from "./stats/route";
import { Route as TermsRoute } from "./terms";

type Leaderboard = NonNullable<Awaited<ReturnType<SitemapRouteDeps["loadLeaderboard"]>>>;

const NOW = () => new Date("2026-06-22T12:00:00.000Z");
const PAGE_SIZE = 100;

function ranked(login: string, rank: number): Leaderboard["entries"][number] {
  return {
    activeDays: 1,
    lastDate: "2026-06-01",
    rank,
    spendUsd: 1,
    totalTokens: 1,
    user: { avatarUrl: null, login, name: null },
  };
}

/** A ranking of `total` users (`user-1` is rank 1) served a page at a time, the way the API pages it. */
function pagedLeaderboard(total: number) {
  const offsets: number[] = [];
  const loadLeaderboard = async (offset: number): Promise<Leaderboard> => {
    offsets.push(offset);
    const entries = Array.from(
      { length: Math.max(0, Math.min(PAGE_SIZE, total - offset)) },
      (_, index) => ranked(`user-${offset + index + 1}`, offset + index + 1),
    );

    return {
      entries,
      metric: "spend",
      nextOffset: offset + PAGE_SIZE < total ? offset + PAGE_SIZE : null,
      total,
      window: "all",
    };
  };

  return { loadLeaderboard, offsets };
}

/** A Workers-style cache holding at most the one sitemap. */
function memoryCache() {
  const stored = new Map<string, Response>();

  return {
    cache: {
      match: async (request: Request) => stored.get(request.url)?.clone(),
      put: async (request: Request, response: Response) => {
        stored.set(request.url, response);
      },
    },
    stored,
  };
}

function locs(xml: string): string[] {
  return [...xml.matchAll(/<loc>([^<]*)<\/loc>/g)].map((match) => match[1] ?? "");
}

describe("sitemap", () => {
  it("renders absolute, escaped URLs with optional lastmod", () => {
    const xml = buildSitemapXml([{ path: "/" }, { lastModified: "2026-06-21", path: "/a&b" }]);

    expect(xml).toContain("<url><loc>https://tokenmaxxing.sh/</loc></url>");
    expect(xml).toContain(
      "<url><loc>https://tokenmaxxing.sh/a&amp;b</loc><lastmod>2026-06-21</lastmod></url>",
    );
  });

  it("is the sitemap robots.txt points at", async () => {
    expect(buildRobotsTxt()).toContain("Sitemap: https://tokenmaxxing.sh/sitemap.xml");

    const response = await makeSitemapHandler({
      loadLeaderboard: async () => ({
        entries: [
          {
            activeDays: 3,
            lastDate: "2026-06-21",
            rank: 1,
            spendUsd: 10,
            totalTokens: 100,
            user: { avatarUrl: null, id: "user_1", login: "pondorasti", name: null },
          },
        ],
        metric: "spend",
        window: "all",
      }),
      now: () => new Date("2026-06-22T12:00:00.000Z"),
    })();
    const xml = await response.text();

    expect(response.headers.get("content-type")).toContain("application/xml");
    expect(xml).toContain("<loc>https://tokenmaxxing.sh/stats</loc>");
    expect(xml).toContain("<loc>https://tokenmaxxing.sh/pondorasti</loc>");
    expect(xml).not.toContain("/design");
    expect(xml).not.toContain("/settings");
  });

  it("never dates a profile after UTC today", async () => {
    const entry = (login: string, lastDate: string | null) => ({
      activeDays: 1,
      lastDate,
      rank: 1,
      spendUsd: 1,
      totalTokens: 1,
      user: { avatarUrl: null, login, name: null },
    });
    const response = await makeSitemapHandler({
      loadLeaderboard: async () => ({
        entries: [
          // A user east of UTC is already on the 23rd.
          entry("ahead", "2026-06-23"),
          entry("today", "2026-06-22"),
          entry("earlier", "2026-06-01"),
          entry("idle", null),
        ],
        metric: "spend",
        window: "all",
      }),
      now: () => new Date("2026-06-22T12:00:00.000Z"),
    })();
    const xml = await response.text();

    expect(xml).toContain("<loc>https://tokenmaxxing.sh/ahead</loc><lastmod>2026-06-22</lastmod>");
    expect(xml).toContain("<loc>https://tokenmaxxing.sh/today</loc><lastmod>2026-06-22</lastmod>");
    expect(xml).toContain(
      "<loc>https://tokenmaxxing.sh/earlier</loc><lastmod>2026-06-01</lastmod>",
    );
    expect(xml).toContain("<url><loc>https://tokenmaxxing.sh/idle</loc></url>");
    expect(xml).not.toContain("2026-06-23");
  });

  it("still lists the static pages when the leaderboard is unavailable", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    onTestFinished(() => warn.mockRestore());
    const response = await makeSitemapHandler({
      loadLeaderboard: async () => {
        throw new Error("API down");
      },
      now: () => new Date("2026-06-22T12:00:00.000Z"),
    })();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=300");
    expect(await response.text()).toContain("<loc>https://tokenmaxxing.sh/privacy</loc>");
    expect(warn).toHaveBeenCalledExactlyOnceWith("Sitemap leaderboard load failed", {
      error: expect.any(Error),
    });
  });
});

describe("sitemap profiles", () => {
  it("lists every ranked profile, not only the leaderboard's first page", async () => {
    const { loadLeaderboard, offsets } = pagedLeaderboard(523);

    const response = await makeSitemapHandler({ loadLeaderboard, now: NOW })();
    const urls = locs(await response.text());

    expect(urls).toHaveLength(STATIC_SITEMAP_PATHS.length + 523);
    expect(urls).toContain("https://tokenmaxxing.sh/user-1");
    expect(urls).toContain("https://tokenmaxxing.sh/user-101");
    expect(urls).toContain("https://tokenmaxxing.sh/user-523");
    expect(new Set(urls).size).toBe(urls.length);
    // One page at a time, each from the offset the last one named.
    expect(offsets).toEqual([0, 100, 200, 300, 400, 500]);
    expect(response.headers.get("cache-control")).toBe(
      "public, max-age=3600, stale-while-revalidate=86400",
    );
  });

  it("reads a single page once", async () => {
    const { loadLeaderboard, offsets } = pagedLeaderboard(40);

    const response = await makeSitemapHandler({ loadLeaderboard, now: NOW })();

    expect(locs(await response.text())).toHaveLength(STATIC_SITEMAP_PATHS.length + 40);
    expect(offsets).toEqual([0]);
  });

  it("stops, with what it has, at a page whose next offset does not move on", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    onTestFinished(() => warn.mockRestore());
    const { loadLeaderboard, offsets } = pagedLeaderboard(523);
    const stuck: SitemapRouteDeps["loadLeaderboard"] = async (offset) => {
      const page = await loadLeaderboard(offset);
      return offset === 200 ? { ...page, nextOffset: 200 } : page;
    };

    const response = await makeSitemapHandler({ loadLeaderboard: stuck, now: NOW })();

    expect(offsets).toEqual([0, 100, 200]);
    expect(locs(await response.text())).toHaveLength(STATIC_SITEMAP_PATHS.length + 200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=300");
    expect(warn).toHaveBeenCalledExactlyOnceWith("Sitemap leaderboard page unusable", {
      offset: 200,
    });
  });

  it("lists a profile once when the ranking shifts between pages", async () => {
    const { loadLeaderboard } = pagedLeaderboard(150);
    const shifted: SitemapRouteDeps["loadLeaderboard"] = async (offset) => {
      const page = await loadLeaderboard(offset);
      // user-100 dropped a rank while the pages were being read.
      return offset === 0 ? page : { ...page, entries: [ranked("user-100", 101), ...page.entries] };
    };

    const urls = locs(
      await (await makeSitemapHandler({ loadLeaderboard: shifted, now: NOW })()).text(),
    );

    expect(urls.filter((url) => url === "https://tokenmaxxing.sh/user-100")).toHaveLength(1);
    expect(urls).toHaveLength(STATIC_SITEMAP_PATHS.length + 150);
  });

  it("keeps the pages it has, and retries soon, when a later page fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    onTestFinished(() => warn.mockRestore());
    const { loadLeaderboard } = pagedLeaderboard(523);
    const flaky: SitemapRouteDeps["loadLeaderboard"] = async (offset) => {
      if (offset === 300) {
        throw new Error("API down");
      }
      return loadLeaderboard(offset);
    };

    const response = await makeSitemapHandler({ loadLeaderboard: flaky, now: NOW })();
    const urls = locs(await response.text());

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=300");
    expect(urls).toContain("https://tokenmaxxing.sh/user-1");
    expect(urls).toContain("https://tokenmaxxing.sh/user-300");
    expect(urls).not.toContain("https://tokenmaxxing.sh/user-301");
    expect(warn).toHaveBeenCalledExactlyOnceWith("Sitemap leaderboard page failed", {
      error: expect.any(Error),
      offset: 300,
    });
  });

  it("stops at the sitemap protocol's 50,000 URL limit", async () => {
    // One oversized page stands in for a ranking past the limit.
    const entries = Array.from({ length: MAX_SITEMAP_URLS + 10 }, (_, index) =>
      ranked(`user-${index + 1}`, index + 1),
    );

    const response = await makeSitemapHandler({
      loadLeaderboard: async () => ({ entries, metric: "spend", nextOffset: null, window: "all" }),
      now: NOW,
    })();
    const urls = locs(await response.text());

    expect(urls).toHaveLength(MAX_SITEMAP_URLS);
    // The best-ranked profiles are the ones kept.
    expect(urls).toContain("https://tokenmaxxing.sh/user-1");
    expect(urls).not.toContain(`https://tokenmaxxing.sh/user-${MAX_SITEMAP_URLS}`);
  });
});

describe("sitemap cache", () => {
  it("builds the sitemap once and serves the stored copy after that", async () => {
    const { cache, stored } = memoryCache();
    const { loadLeaderboard, offsets } = pagedLeaderboard(150);
    const handler = makeSitemapHandler({ cache: () => cache, loadLeaderboard, now: NOW });

    const built = await (await handler()).text();
    const served = await handler();

    expect([...stored.keys()]).toEqual(["https://tokenmaxxing.sh/sitemap.xml"]);
    expect(offsets).toEqual([0, 100]);
    expect(await served.text()).toBe(built);
    expect(served.headers.get("content-type")).toContain("application/xml");
  });

  it("does not store a sitemap that is missing profiles", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    onTestFinished(() => warn.mockRestore());
    const { cache, stored } = memoryCache();
    let down = true;
    const { loadLeaderboard } = pagedLeaderboard(150);
    const handler = makeSitemapHandler({
      cache: () => cache,
      loadLeaderboard: async (offset) => {
        if (down && offset > 0) {
          throw new Error("API down");
        }
        return loadLeaderboard(offset);
      },
      now: NOW,
    });

    expect(locs(await (await handler()).text())).toHaveLength(STATIC_SITEMAP_PATHS.length + 100);
    expect(stored.size).toBe(0);

    down = false;
    expect(locs(await (await handler()).text())).toHaveLength(STATIC_SITEMAP_PATHS.length + 150);
    expect(stored.size).toBe(1);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("still answers when the cache is down", async () => {
    const { loadLeaderboard } = pagedLeaderboard(40);
    const broken = {
      match: async () => {
        throw new Error("cache down");
      },
      put: async () => {
        throw new Error("cache down");
      },
    };

    const response = await makeSitemapHandler({ cache: () => broken, loadLeaderboard, now: NOW })();

    expect(response.status).toBe(200);
    expect(locs(await response.text())).toHaveLength(STATIC_SITEMAP_PATHS.length + 40);
  });
});

describe("sitemap and page signals agree", () => {
  const STATIC_ROUTES = {
    "/": HomeRoute,
    "/privacy": PrivacyRoute,
    "/stats": StatsRoute,
    "/terms": TermsRoute,
  } satisfies Record<(typeof STATIC_SITEMAP_PATHS)[number], unknown>;

  it("lists only pages that are indexable and canonical at the listed URL", () => {
    for (const path of STATIC_SITEMAP_PATHS) {
      const head = headOf(STATIC_ROUTES[path]);

      expect({ canonical: head.canonical, path }).toEqual({
        canonical: new URL(path, "https://tokenmaxxing.sh").toString(),
        path,
      });
      expect({ path, robots: head.robots }).toEqual({ path, robots: INDEXABLE_ROBOTS });
    }
  });

  it("gives each listed page its own title and a description that fits a snippet", () => {
    const heads = STATIC_SITEMAP_PATHS.map((path) => ({ path, ...headOf(STATIC_ROUTES[path]) }));

    expect(new Set(heads.map((head) => head.title)).size).toBe(heads.length);
    expect(new Set(heads.map((head) => head.description)).size).toBe(heads.length);
    for (const head of heads) {
      expect({ path: head.path, title: head.title?.length ?? 0 }).toEqual({
        path: head.path,
        title: expect.toSatisfy((length: number) => length >= 20 && length <= 60),
      });
      expect({ description: head.description?.length ?? 0, path: head.path }).toEqual({
        description: expect.toSatisfy((length: number) => length >= 70 && length <= 160),
        path: head.path,
      });
    }
  });
});

describe("robots.txt", () => {
  it("blocks nothing: noindex pages must be crawlable and card images fetchable", () => {
    const robots = buildRobotsTxt();

    expect(robots).toBe(
      "User-agent: *\nAllow: /\n\nSitemap: https://tokenmaxxing.sh/sitemap.xml\n",
    );
    expect(robots).not.toMatch(/^Disallow:/m);
  });

  it("is served as plain text", () => {
    const response = handleRobotsTxtRequest();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
  });
});

interface StaticHead {
  canonical: string | undefined;
  description: string | undefined;
  robots: string | undefined;
  title: string | undefined;
}

/** The tags a static route's `head` states; these routes read nothing from the match. */
function headOf(route: { options: { head?: unknown } }): StaticHead {
  const head = (
    route.options.head as () => {
      links?: { href: string; rel: string }[];
      meta?: Record<string, string>[];
    }
  )();
  const meta = head.meta ?? [];

  return {
    canonical: head.links?.find((link) => link.rel === "canonical")?.href,
    description: meta.find((entry) => entry.name === "description")?.content,
    robots: meta.find((entry) => entry.name === "robots")?.content,
    title: meta.find((entry) => "title" in entry)?.title,
  };
}
