import { describe, expect, it } from "vite-plus/test";

import { makeSitemapHandler } from "../routes/sitemap[.]xml";
import { buildRobotsTxt } from "../routes/robots[.]txt";
import { buildSitemapXml } from "./sitemap";

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
    })();
    const xml = await response.text();

    expect(response.headers.get("content-type")).toContain("application/xml");
    expect(xml).toContain("<loc>https://tokenmaxxing.sh/stats</loc>");
    expect(xml).toContain("<loc>https://tokenmaxxing.sh/pondorasti</loc>");
    expect(xml).not.toContain("/design");
    expect(xml).not.toContain("/settings");
  });

  it("still lists the static pages when the leaderboard is unavailable", async () => {
    const response = await makeSitemapHandler({
      loadLeaderboard: async () => {
        throw new Error("API down");
      },
    })();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=300");
    expect(await response.text()).toContain("<loc>https://tokenmaxxing.sh/privacy</loc>");
  });
});
