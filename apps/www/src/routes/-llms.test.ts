import { describe, expect, it } from "vite-plus/test";

import { buildLlmsTxt, handleLlmsTxtRequest } from "./llms[.]txt";

describe("llms.txt", () => {
  it("is served as markdown and kept out of search results", () => {
    const response = handleLlmsTxtRequest();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(response.headers.get("x-robots-tag")).toBe("noindex");
  });

  it("points at the public pages and the sitemap that lists every profile", () => {
    const llms = buildLlmsTxt();

    expect(llms).toContain("[Leaderboard](https://tokenmaxxing.sh/)");
    expect(llms).toContain("[Stats](https://tokenmaxxing.sh/stats)");
    expect(llms).toContain("`https://tokenmaxxing.sh/{login}`");
    expect(llms).toContain("[sitemap](https://tokenmaxxing.sh/sitemap.xml)");
  });
});
