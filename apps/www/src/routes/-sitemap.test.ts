import { describe, expect, it, onTestFinished, vi } from "vite-plus/test";

import { INDEXABLE_ROBOTS } from "../lib/seo";
import { Route as HomeRoute } from "./(home)/index";
import { Route as PrivacyRoute } from "./privacy";
import { buildRobotsTxt, handleRobotsTxtRequest } from "./robots[.]txt";
import { buildSitemapXml, STATIC_SITEMAP_PATHS } from "./-sitemap";
import { makeSitemapHandler, MAX_SITEMAP_URLS, type SitemapRouteDeps } from "./sitemap[.]xml";
import { Route as StatsRoute } from "./stats/route";
import { Route as TermsRoute } from "./terms";

type ProfileIndex = NonNullable<Awaited<ReturnType<SitemapRouteDeps["loadProfiles"]>>>;

const NOW = () => new Date("2026-06-22T12:00:00.000Z");
const PAGE_SIZE = 1_000;

function profile(login: string, lastDate = "2026-06-01"): ProfileIndex["entries"][number] {
  return { lastDate, login };
}

/** One page holding every given profile. */
function onePage(entries: ProfileIndex["entries"]): SitemapRouteDeps["loadProfiles"] {
  return async () => ({ entries, nextAfter: null });
}

/**
 * `total` profiles (`user-00001` first) served a page at a time by login,
 * the way the API pages its profile index.
 */
function pagedProfiles(total: number) {
  const logins = Array.from({ length: total }, (_, index) => loginOf(index + 1));
  const calls: (string | null)[] = [];
  const loadProfiles = async (after: string | null): Promise<ProfileIndex> => {
    calls.push(after);
    const start = after === null ? 0 : logins.findIndex((login) => login > after);
    const rest = start === -1 ? [] : logins.slice(start);
    const entries = rest.slice(0, PAGE_SIZE).map((login) => profile(login));

    return { entries, nextAfter: rest.length > PAGE_SIZE ? (entries.at(-1)?.login ?? null) : null };
  };

  return { calls, loadProfiles };
}

function loginOf(index: number): string {
  return `user-${String(index).padStart(5, "0")}`;
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
      loadProfiles: onePage([profile("pondorasti", "2026-06-21")]),
      now: NOW,
    })();
    const xml = await response.text();

    expect(response.headers.get("content-type")).toContain("application/xml");
    expect(xml).toContain("<loc>https://tokenmaxxing.sh/stats</loc>");
    expect(xml).toContain(
      "<loc>https://tokenmaxxing.sh/pondorasti</loc><lastmod>2026-06-21</lastmod>",
    );
    expect(xml).not.toContain("/design");
    expect(xml).not.toContain("/settings");
  });

  it("never dates a profile after UTC today", async () => {
    const response = await makeSitemapHandler({
      loadProfiles: onePage([
        // A user east of UTC is already on the 23rd.
        profile("ahead", "2026-06-23"),
        profile("earlier", "2026-06-01"),
        profile("today", "2026-06-22"),
      ]),
      now: NOW,
    })();
    const xml = await response.text();

    expect(xml).toContain("<loc>https://tokenmaxxing.sh/ahead</loc><lastmod>2026-06-22</lastmod>");
    expect(xml).toContain("<loc>https://tokenmaxxing.sh/today</loc><lastmod>2026-06-22</lastmod>");
    expect(xml).toContain(
      "<loc>https://tokenmaxxing.sh/earlier</loc><lastmod>2026-06-01</lastmod>",
    );
    expect(xml).not.toContain("2026-06-23");
  });

  it("still lists the static pages when the profile index is unavailable", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    onTestFinished(() => warn.mockRestore());
    const response = await makeSitemapHandler({
      loadProfiles: async () => {
        throw new Error("API down");
      },
      now: NOW,
    })();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=300");
    expect(locs(await response.text())).toEqual(
      STATIC_SITEMAP_PATHS.map((path) => new URL(path, "https://tokenmaxxing.sh").toString()),
    );
    expect(warn).toHaveBeenCalledExactlyOnceWith("Sitemap profile page failed", {
      after: null,
      error: expect.any(Error),
    });
  });

  it("does not take a missing profile index for an empty one", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    onTestFinished(() => warn.mockRestore());
    const { cache, stored } = memoryCache();

    // fetchPublicJson resolves null on a 404, e.g. an API without the endpoint yet.
    const response = await makeSitemapHandler({
      cache: () => cache,
      loadProfiles: async () => null,
      now: NOW,
    })();

    expect(locs(await response.text())).toHaveLength(STATIC_SITEMAP_PATHS.length);
    expect(response.headers.get("cache-control")).toBe("public, max-age=300");
    expect(stored.size).toBe(0);
    expect(warn).toHaveBeenCalledExactlyOnceWith("Sitemap profile page unusable", {
      after: null,
    });
  });
});

describe("sitemap profiles", () => {
  it("lists every public profile, reading the index a page at a time", async () => {
    const { calls, loadProfiles } = pagedProfiles(2_523);

    const response = await makeSitemapHandler({ loadProfiles, now: NOW })();
    const urls = locs(await response.text());

    expect(urls).toHaveLength(STATIC_SITEMAP_PATHS.length + 2_523);
    expect(urls).toContain(`https://tokenmaxxing.sh/${loginOf(1)}`);
    expect(urls).toContain(`https://tokenmaxxing.sh/${loginOf(1_001)}`);
    expect(urls).toContain(`https://tokenmaxxing.sh/${loginOf(2_523)}`);
    expect(new Set(urls).size).toBe(urls.length);
    // One page at a time, each after the login the last one named.
    expect(calls).toEqual([null, loginOf(1_000), loginOf(2_000)]);
    expect(response.headers.get("cache-control")).toBe(
      "public, max-age=3600, stale-while-revalidate=86400",
    );
  });

  it("reads a single page once", async () => {
    const { calls, loadProfiles } = pagedProfiles(40);

    const response = await makeSitemapHandler({ loadProfiles, now: NOW })();

    expect(locs(await response.text())).toHaveLength(STATIC_SITEMAP_PATHS.length + 40);
    expect(calls).toEqual([null]);
  });

  it("stops, with what it has, at a page whose cursor does not move on", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    onTestFinished(() => warn.mockRestore());
    const { calls, loadProfiles } = pagedProfiles(2_523);
    const stuck: SitemapRouteDeps["loadProfiles"] = async (after) => {
      const page = await loadProfiles(after);
      return after === loginOf(1_000) ? { ...page, nextAfter: loginOf(1_000) } : page;
    };

    const response = await makeSitemapHandler({ loadProfiles: stuck, now: NOW })();

    expect(calls).toEqual([null, loginOf(1_000)]);
    expect(locs(await response.text())).toHaveLength(STATIC_SITEMAP_PATHS.length + 1_000);
    expect(response.headers.get("cache-control")).toBe("public, max-age=300");
    expect(warn).toHaveBeenCalledExactlyOnceWith("Sitemap profile page unusable", {
      after: loginOf(1_000),
    });
  });

  it("lists a profile once when a rename moves it between pages", async () => {
    const { loadProfiles } = pagedProfiles(1_500);
    const renamed: SitemapRouteDeps["loadProfiles"] = async (after) => {
      const page = await loadProfiles(after);
      // user-00005 renamed to a later login and showed up again, then renamed back.
      return after === null ? page : { ...page, entries: [profile(loginOf(5)), ...page.entries] };
    };

    const urls = locs(
      await (await makeSitemapHandler({ loadProfiles: renamed, now: NOW })()).text(),
    );

    expect(urls.filter((url) => url === `https://tokenmaxxing.sh/${loginOf(5)}`)).toHaveLength(1);
    expect(urls).toHaveLength(STATIC_SITEMAP_PATHS.length + 1_500);
  });

  it("keeps the pages it has, and retries soon, when a later page fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    onTestFinished(() => warn.mockRestore());
    const { loadProfiles } = pagedProfiles(2_523);
    const flaky: SitemapRouteDeps["loadProfiles"] = async (after) => {
      if (after === loginOf(2_000)) {
        throw new Error("API down");
      }
      return loadProfiles(after);
    };

    const response = await makeSitemapHandler({ loadProfiles: flaky, now: NOW })();
    const urls = locs(await response.text());

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=300");
    expect(urls).toContain(`https://tokenmaxxing.sh/${loginOf(1)}`);
    expect(urls).toContain(`https://tokenmaxxing.sh/${loginOf(2_000)}`);
    expect(urls).not.toContain(`https://tokenmaxxing.sh/${loginOf(2_001)}`);
    expect(warn).toHaveBeenCalledExactlyOnceWith("Sitemap profile page failed", {
      after: loginOf(2_000),
      error: expect.any(Error),
    });
  });

  it("stops at the sitemap protocol's 50,000 URL limit", async () => {
    const { calls, loadProfiles } = pagedProfiles(MAX_SITEMAP_URLS + 1_500);

    const response = await makeSitemapHandler({ loadProfiles, now: NOW })();
    const urls = locs(await response.text());

    expect(urls).toHaveLength(MAX_SITEMAP_URLS);
    // It stops reading once it has enough, and keeps the first logins.
    expect(calls).toHaveLength(50);
    expect(urls).toContain(`https://tokenmaxxing.sh/${loginOf(1)}`);
    expect(urls).not.toContain(`https://tokenmaxxing.sh/${loginOf(MAX_SITEMAP_URLS)}`);
    expect(response.headers.get("cache-control")).toBe(
      "public, max-age=3600, stale-while-revalidate=86400",
    );
  });
});

describe("sitemap cache", () => {
  it("builds the sitemap once and serves the stored copy after that", async () => {
    const { cache, stored } = memoryCache();
    const { calls, loadProfiles } = pagedProfiles(1_500);
    const handler = makeSitemapHandler({ cache: () => cache, loadProfiles, now: NOW });

    const built = await (await handler()).text();
    const served = await handler();

    expect([...stored.keys()]).toEqual(["https://tokenmaxxing.sh/sitemap.xml"]);
    expect(calls).toEqual([null, loginOf(1_000)]);
    expect(await served.text()).toBe(built);
    expect(served.headers.get("content-type")).toContain("application/xml");
  });

  it("does not store a sitemap that is missing profiles", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    onTestFinished(() => warn.mockRestore());
    const { cache, stored } = memoryCache();
    let down = true;
    const { loadProfiles } = pagedProfiles(1_500);
    const handler = makeSitemapHandler({
      cache: () => cache,
      loadProfiles: async (after) => {
        if (down && after !== null) {
          throw new Error("API down");
        }
        return loadProfiles(after);
      },
      now: NOW,
    });

    expect(locs(await (await handler()).text())).toHaveLength(STATIC_SITEMAP_PATHS.length + 1_000);
    expect(stored.size).toBe(0);

    down = false;
    expect(locs(await (await handler()).text())).toHaveLength(STATIC_SITEMAP_PATHS.length + 1_500);
    expect(stored.size).toBe(1);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("still answers when the cache is down", async () => {
    const { loadProfiles } = pagedProfiles(40);
    const broken = {
      match: async () => {
        throw new Error("cache down");
      },
      put: async () => {
        throw new Error("cache down");
      },
    };

    const response = await makeSitemapHandler({ cache: () => broken, loadProfiles, now: NOW })();

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
