import { describe, expect, it, vi } from "vite-plus/test";

import { makeSiteOgImageHandler } from "../routes/og[.]png";
import { SITE_OG_VERSION } from "./og";
import {
  ogCacheKey,
  PREVIEW_CACHE_CONTROL,
  renderOgImage,
  SITE_OG_CACHE_SCOPE,
  TRANSIENT_CACHE_CONTROL,
  VERSIONED_CACHE_CONTROL,
  type OgImageDeps,
} from "./og-image";
import type { OgBrowser, OgR2Bucket } from "./og-runtime";

const PNG_FROM_BROWSER = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1]);
const PNG_FROM_CACHE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 2]);
const SITE_KEY = ogCacheKey(SITE_OG_CACHE_SCOPE, SITE_OG_VERSION);

describe("site OG image route", () => {
  it("captures the current card and caches it immutably for its own version", async () => {
    const { bucket, captureScreenshot, handler } = setup();

    const response = await handler({ request: siteRequest(SITE_OG_VERSION) });

    expect(response.headers.get("x-og-source")).toBe("browser");
    expect(response.headers.get("cache-control")).toBe(VERSIONED_CACHE_CONTROL);
    expect(captureScreenshot).toHaveBeenCalledWith(browser, "https://tokenmaxxing.sh/og-card");
    expect(bucket.putKeys).toEqual([SITE_KEY]);
  });

  it("ignores a spoofed ?v=: no screenshot, no R2 write, preview caching", async () => {
    const { bucket, captureScreenshot, handler } = setup([[SITE_KEY, PNG_FROM_CACHE]]);

    const response = await handler({ request: siteRequest("attacker-chosen") });
    const bytes = new Uint8Array(await response.arrayBuffer());

    expect(response.headers.get("x-og-source")).toBe("cache");
    expect(response.headers.get("cache-control")).toBe(PREVIEW_CACHE_CONTROL);
    expect(Array.from(bytes)).toEqual(Array.from(PNG_FROM_CACHE));
    expect(captureScreenshot).not.toHaveBeenCalled();
    expect(bucket.putKeys).toEqual([]);
  });

  it("never mints a key per spoofed version", async () => {
    const { bucket, captureScreenshot, handler } = setup();

    for (const version of ["a", "b", "c"]) {
      await handler({ request: siteRequest(version) });
    }

    expect(captureScreenshot).toHaveBeenCalledOnce();
    expect(bucket.putKeys).toEqual([SITE_KEY]);
  });
});

describe("renderOgImage target resolution", () => {
  it("serves only the neutral fallback, briefly cached, when the loader fails", async () => {
    const getRuntimeEnv = vi.fn<OgImageDeps["getRuntimeEnv"]>(async () => ({
      BROWSER: browser,
      BUCKET: memoryBucket([[ogCacheKey("pondorasti", "old"), PNG_FROM_CACHE]]),
    }));
    const captureScreenshot = vi.fn<OgImageDeps["captureScreenshot"]>(async () => PNG_FROM_BROWSER);

    const response = await renderOgImage(
      { captureScreenshot, getRuntimeEnv },
      {
        request: new Request("https://tokenmaxxing.sh/og/pondorasti.png?v=old"),
        resolveTarget: async () => {
          throw new Error("API unavailable");
        },
      },
    );

    expect(response.headers.get("x-og-source")).toBe("fallback");
    expect(response.headers.get("cache-control")).toBe(TRANSIENT_CACHE_CONTROL);
    expect(response.headers.get("x-og-error")).toBe("API unavailable");
    expect(getRuntimeEnv).not.toHaveBeenCalled();
    expect(captureScreenshot).not.toHaveBeenCalled();
  });

  it("404s an unknown target before reading any cache", async () => {
    const getRuntimeEnv = vi.fn<OgImageDeps["getRuntimeEnv"]>(async () => ({}));

    const response = await renderOgImage(
      { captureScreenshot: async () => PNG_FROM_BROWSER, getRuntimeEnv },
      {
        request: new Request("https://tokenmaxxing.sh/og/ghost.png"),
        resolveTarget: async () => null,
      },
    );

    expect(response.status).toBe(404);
    expect(getRuntimeEnv).not.toHaveBeenCalled();
  });
});

const browser: OgBrowser = { quickAction: async () => new Response(PNG_FROM_BROWSER) };

function setup(entries: Array<[string, Uint8Array]> = []) {
  const bucket = memoryBucket(entries);
  const captureScreenshot = vi.fn<OgImageDeps["captureScreenshot"]>(async () => PNG_FROM_BROWSER);
  const handler = makeSiteOgImageHandler({
    captureScreenshot,
    getRuntimeEnv: async () => ({ BROWSER: browser, BUCKET: bucket }),
  });

  return { bucket, captureScreenshot, handler };
}

function siteRequest(version: string): Request {
  return new Request(`https://tokenmaxxing.sh/og.png?${new URLSearchParams({ v: version })}`);
}

function memoryBucket(entries: Array<[string, Uint8Array]> = []) {
  const store = new Map(entries);
  const putKeys: string[] = [];
  const bucket: OgR2Bucket & { putKeys: string[] } = {
    get: async (key) => {
      const bytes = store.get(key);
      return bytes === undefined
        ? null
        : { arrayBuffer: async () => bytes.slice().buffer as ArrayBuffer, key };
    },
    list: async ({ prefix }) => ({
      objects: [...store.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key })),
    }),
    put: async (key, value) => {
      putKeys.push(key);
      store.set(key, value instanceof Uint8Array ? value : new Uint8Array(value));
    },
    putKeys,
  };

  return bucket;
}
