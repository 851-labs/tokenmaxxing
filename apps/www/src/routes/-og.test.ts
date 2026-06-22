import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ProfileDailyResponse, ProfileResponse } from "@tokenmaxxing/api-contract";

import type { OgBrowser, OgR2Bucket, OgRuntimeEnv } from "../lib/og-runtime";
import { ProfileOgCard } from "./og-card/$login";
import { makeOgImageHandler, ogCacheKey, VERSIONED_CACHE_CONTROL } from "./og/{$login}[.]png";

type Daily = typeof ProfileDailyResponse.Type;
type Profile = typeof ProfileResponse.Type;

const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const PNG_FROM_BROWSER = new Uint8Array([...PNG_SIGNATURE, 1]);
const PNG_FROM_CACHE = new Uint8Array([...PNG_SIGNATURE, 2]);
const PNG_FROM_PRIOR_CACHE = new Uint8Array([...PNG_SIGNATURE, 3]);

describe("profile OG card", () => {
  it("renders the stats html card", () => {
    const stats = renderToStaticMarkup(createElement(ProfileOgCard, { data: ogData() }));

    expect(stats).toContain('id="og-card"');
    expect(stats).toContain("pondorasti");
    expect(stats).toContain("Total spend");
    expect(stats).toContain("Top spend model");
  });
});

describe("profile OG image route", () => {
  it("returns cached png bytes without calling Browser Run", async () => {
    const key = ogCacheKey("pondorasti", "abc");
    const bucket = memoryBucket([[key, PNG_FROM_CACHE]]);
    const captureScreenshot = screenshotSpy(PNG_FROM_BROWSER);
    const response = await requestOgImage("https://tokenmaxxing.sh/og/pondorasti.png?v=abc", {
      captureScreenshot,
      env: { BUCKET: bucket },
    });
    const bytes = new Uint8Array(await response.arrayBuffer());

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toBe(VERSIONED_CACHE_CONTROL);
    expect(response.headers.get("x-og-source")).toBe("cache");
    expect(Array.from(bytes)).toEqual(Array.from(PNG_FROM_CACHE));
    expect(captureScreenshot).not.toHaveBeenCalled();
  });

  it("captures, stores, and returns png bytes on cache miss", async () => {
    const bucket = memoryBucket();
    const browser = browserBinding();
    const captureScreenshot = screenshotSpy(PNG_FROM_BROWSER);
    const response = await requestOgImage("https://tokenmaxxing.sh/og/pondorasti.png?v=abc", {
      captureScreenshot,
      env: { BROWSER: browser, BUCKET: bucket },
    });
    const bytes = new Uint8Array(await response.arrayBuffer());

    expect(Array.from(bytes)).toEqual(Array.from(PNG_FROM_BROWSER));
    expect(response.headers.get("x-og-source")).toBe("browser");
    expect(captureScreenshot).toHaveBeenCalledWith(
      browser,
      "https://tokenmaxxing.sh/og-card/pondorasti",
    );
    expect(bucket.putCalls.map((call) => call.key)).toEqual([ogCacheKey("pondorasti", "abc")]);
  });

  it("falls back to the latest prior cached image when Browser Run fails", async () => {
    const currentKey = ogCacheKey("pondorasti", "new");
    const priorKey = ogCacheKey("pondorasti", "old");
    const bucket = memoryBucket([[priorKey, PNG_FROM_PRIOR_CACHE]]);
    const captureScreenshot = vi.fn<(browser: OgBrowser, url: string) => Promise<Uint8Array>>(
      async () => {
        throw new Error("browser failed");
      },
    );
    const response = await requestOgImage("https://tokenmaxxing.sh/og/pondorasti.png?v=new", {
      captureScreenshot,
      env: { BROWSER: browserBinding(), BUCKET: bucket },
    });
    const bytes = new Uint8Array(await response.arrayBuffer());

    expect(currentKey).not.toBe(priorKey);
    expect(Array.from(bytes)).toEqual(Array.from(PNG_FROM_PRIOR_CACHE));
    expect(response.headers.get("x-og-source")).toBe("prior-cache");
    expect(response.headers.get("x-og-error")).toBe("browser failed");
  });

  it("marks fallback png bytes when Browser Run is unavailable", async () => {
    const response = await requestOgImage("https://tokenmaxxing.sh/og/pondorasti.png", {
      env: {},
    });
    const bytes = new Uint8Array(await response.arrayBuffer());

    expect(Array.from(bytes.slice(0, PNG_SIGNATURE.length))).toEqual(Array.from(PNG_SIGNATURE));
    expect(response.headers.get("x-og-source")).toBe("fallback");
    expect(response.headers.get("x-og-error")).toBe("Cloudflare Browser binding is unavailable");
  });

  it("returns 404 for a missing profile", async () => {
    const captureScreenshot = screenshotSpy(PNG_FROM_BROWSER);
    const handler = makeOgImageHandler({
      captureScreenshot,
      getRuntimeEnv: async () => ({ BROWSER: browserBinding() }),
      loadProfileOgData: async () => null,
    });

    const response = await handler({
      params: { login: "missing" },
      request: new Request("https://tokenmaxxing.sh/og/missing.png"),
    });

    expect(response.status).toBe(404);
    expect(captureScreenshot).not.toHaveBeenCalled();
  });
});

async function requestOgImage(
  url: string,
  options: {
    captureScreenshot?: (browser: OgBrowser, url: string) => Promise<Uint8Array>;
    env?: OgRuntimeEnv;
  } = {},
): Promise<Response> {
  const handler = makeOgImageHandler({
    captureScreenshot: options.captureScreenshot ?? (async () => PNG_FROM_BROWSER),
    getRuntimeEnv: async () => options.env ?? {},
    loadProfileOgData: async () => ogData(),
  });

  return handler({ params: { login: "pondorasti" }, request: new Request(url) });
}

function browserBinding(): OgBrowser {
  return {
    quickAction: async () =>
      new Response(PNG_FROM_BROWSER, {
        headers: { "content-type": "image/png" },
      }),
  };
}

function screenshotSpy(result: Uint8Array) {
  return vi.fn<(browser: OgBrowser, url: string) => Promise<Uint8Array>>(async () => result);
}

function memoryBucket(entries: Array<[string, Uint8Array]> = []) {
  const store = new Map<string, { bytes: Uint8Array; uploaded: Date }>();
  let uploadedOffset = 0;
  for (const [key, bytes] of entries) {
    uploadedOffset += 1;
    store.set(key, { bytes, uploaded: new Date(1_000 + uploadedOffset) });
  }

  const putCalls: Array<{ key: string; value: ArrayBuffer | Uint8Array }> = [];
  const bucket: OgR2Bucket & { putCalls: typeof putCalls } = {
    get: async (key) => {
      const object = store.get(key);
      if (object === undefined) {
        return null;
      }

      return {
        arrayBuffer: async () =>
          object.bytes.buffer.slice(
            object.bytes.byteOffset,
            object.bytes.byteOffset + object.bytes.byteLength,
          ) as ArrayBuffer,
        key,
        uploaded: object.uploaded,
      };
    },
    list: async ({ prefix }) => ({
      objects: [...store.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, object]) => ({ key, uploaded: object.uploaded })),
    }),
    put: async (key, value) => {
      putCalls.push({ key, value });
      store.set(key, {
        bytes: value instanceof Uint8Array ? value : new Uint8Array(value),
        uploaded: new Date(2_000 + putCalls.length),
      });
    },
    putCalls,
  };

  return bucket;
}

function ogData(): { daily: Daily; profile: Profile } {
  return { daily: daily(), profile: profile() };
}

function profile(): Profile {
  return {
    stats: {
      activeDays: 7,
      avgSpendPerActiveDay: 12.34,
      currentStreakDays: 3,
      deviceCount: 2,
      firstDate: "2026-01-01",
      lastDate: "2026-06-21",
      longestStreakDays: 12,
      peakDay: { date: "2026-06-20", spendUsd: 42 },
      sessionCount: 14,
      sources: ["claude", "codex"],
      topModel: { model: "claude-opus", spendUsd: 42 },
      totalSpendUsd: 123.45,
      totalTokens: 987_654,
    },
    user: {
      avatarUrl: "https://github.com/pondorasti.png",
      id: "user_123",
      login: "pondorasti",
      name: null,
    },
  };
}

function daily(): Daily {
  return {
    days: [
      {
        costUsd: 12.34,
        date: "2026-06-21",
        key: "claude-opus",
        outputTokens: 200,
        totalTokens: 300,
      },
    ],
    range: {
      first: "2026-01-01",
      last: "2026-06-21",
    },
  };
}
