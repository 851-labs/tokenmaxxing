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
      loadProfiles: async () => [{ avatarUrl: null, login: "pondorasti" }],
    })();
    const xml = await response.text();

    expect(response.headers.get("content-type")).toContain("application/xml");
    expect(xml).toContain("<loc>https://tokenmaxxing.sh/stats</loc>");
    expect(xml).toContain("<loc>https://tokenmaxxing.sh/pondorasti</loc>");
    expect(xml).not.toContain("/design");
    expect(xml).not.toContain("/settings");
  });

  it("lists every visible profile, not only leaderboard entries", async () => {
    const response = await makeSitemapHandler({
      loadProfiles: async () => [
        { avatarUrl: null, login: "top-user" },
        { avatarUrl: null, login: "no-usage-yet" },
      ],
    })();
    const xml = await response.text();

    expect(xml).toContain("<loc>https://tokenmaxxing.sh/top-user</loc>");
    expect(xml).toContain("<loc>https://tokenmaxxing.sh/no-usage-yet</loc>");
  });

  it("still lists the static pages when profiles are unavailable", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    onTestFinished(() => warn.mockRestore());
    const response = await makeSitemapHandler({
      loadProfiles: async () => {
        throw new Error("API down");
      },
    })();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=300");
    expect(await response.text()).toContain("<loc>https://tokenmaxxing.sh/privacy</loc>");
    expect(warn).toHaveBeenCalledExactlyOnceWith("Sitemap profile load failed", {
      error: expect.any(Error),
    });
  });
});
