import { describe, expect, it, onTestFinished, vi } from "vite-plus/test";

import { makeSitemapHandler } from "./sitemap[.]xml";
import { buildRobotsTxt } from "./robots[.]txt";
import { buildSitemapXml } from "./-sitemap";

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
