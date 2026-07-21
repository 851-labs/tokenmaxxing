import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { estimateCost, loadOpenRouterPricing, matchPricing, normalizeModelKey } from "./openrouter";

const MODELS_PAYLOAD = {
  data: [
    {
      id: "anthropic/claude-sonnet-4.6",
      pricing: { completion: "0.000015", input_cache_read: "0.0000003", prompt: "0.000003" },
    },
    {
      id: "google/gemini-3.6-flash",
      pricing: { completion: "0.0000075", input_cache_read: "0.00000015", prompt: "0.0000015" },
    },
    // No pricing object — skipped.
    { id: "broken/entry" },
  ],
};

function okFetch(payload: unknown = MODELS_PAYLOAD) {
  return () => Promise.resolve(new Response(JSON.stringify(payload), { status: 200 }));
}

describe("normalizeModelKey", () => {
  it("matches agy model ids to openrouter ids", () => {
    expect(normalizeModelKey("anthropic/claude-sonnet-4.6")).toBe("claudesonnet46");
    expect(normalizeModelKey("claude-sonnet-4-6")).toBe("claudesonnet46");
    expect(normalizeModelKey("gemini-3.6-flash")).toBe("gemini36flash");
    expect(normalizeModelKey("google/gemini-3.6-flash")).toBe("gemini36flash");
  });
});

describe("matchPricing + estimateCost", () => {
  const table = {
    claudesonnet46: { completion: 0.000015, inputCacheRead: 0.0000003, prompt: 0.000003 },
  };

  it("prices input, output, and cached tokens", () => {
    const pricing = matchPricing(table, "claude-sonnet-4-6");
    expect(pricing).toBeDefined();
    expect(
      estimateCost({ cacheReadTokens: 500, inputTokens: 1_000, outputTokens: 100 }, pricing),
    ).toBeCloseTo(0.00465, 8);
  });

  it("estimates 0 for unknown models", () => {
    expect(
      estimateCost(
        { cacheReadTokens: 500, inputTokens: 1_000, outputTokens: 100 },
        matchPricing(table, "some-other-model"),
      ),
    ).toBe(0);
  });
});

describe("loadOpenRouterPricing", () => {
  let cacheDir: string;

  beforeEach(async () => {
    cacheDir = await mkdtemp(join(tmpdir(), "tokenmaxxing-openrouter-"));
  });

  afterEach(async () => {
    await rm(cacheDir, { force: true, recursive: true });
  });

  it("fetches, parses, and caches the pricing table", async () => {
    const table = await loadOpenRouterPricing(cacheDir, { fetchFn: okFetch(), now: 1_000 });

    expect(matchPricing(table, "claude-sonnet-4-6")?.prompt).toBe(0.000003);
    expect(matchPricing(table, "gemini-3.6-flash")?.completion).toBe(0.0000075);

    const cached = JSON.parse(await readFile(join(cacheDir, "openrouter-pricing.json"), "utf8"));
    expect(cached.fetchedAt).toBe(1_000);
    expect(cached.prices["claudesonnet46"]).toBeDefined();
  });

  it("serves a fresh cache without fetching", async () => {
    await writeFile(
      join(cacheDir, "openrouter-pricing.json"),
      JSON.stringify({
        fetchedAt: 1_000,
        prices: { claudesonnet46: { completion: 1, inputCacheRead: 1, prompt: 1 } },
      }),
    );
    let fetched = false;
    const fetchFn = () => {
      fetched = true;
      return Promise.resolve(new Response("{}", { status: 200 }));
    };

    const table = await loadOpenRouterPricing(cacheDir, { fetchFn, now: 1_001 });

    expect(fetched).toBe(false);
    expect(table["claudesonnet46"]?.prompt).toBe(1);
  });

  it("falls back to a stale cache when the fetch fails", async () => {
    await writeFile(
      join(cacheDir, "openrouter-pricing.json"),
      JSON.stringify({
        fetchedAt: 1_000,
        prices: { claudesonnet46: { completion: 2, inputCacheRead: 2, prompt: 2 } },
      }),
    );
    const fetchFn = () => Promise.reject(new Error("offline"));

    const table = await loadOpenRouterPricing(cacheDir, {
      fetchFn,
      now: 1_000 + 48 * 60 * 60 * 1000,
    });

    expect(table["claudesonnet46"]?.prompt).toBe(2);
  });

  it("degrades to an empty table when fetch and cache both fail", async () => {
    const fetchFn = () => Promise.reject(new Error("offline"));
    expect(await loadOpenRouterPricing(cacheDir, { fetchFn })).toEqual({});
  });

  it("degrades on malformed payloads", async () => {
    const table = await loadOpenRouterPricing(cacheDir, {
      fetchFn: okFetch({ unexpected: true }),
    });
    expect(table).toEqual({});
  });
});
