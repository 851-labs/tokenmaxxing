import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vite-plus/test";

import {
  cachedGithubStars,
  fetchGithubStars,
  resetGithubStarsMemo,
  type EdgeCacheLike,
  type StarsBucket,
  type StarsDeps,
  type StarsFetchResult,
} from "./github-stars.server";

const R2_KEY = "site/github-stars.json";
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const T0 = Date.UTC(2026, 8, 25, 12);

function memoryCache() {
  const entries = new Map<string, Response>();
  const puts: Response[] = [];
  const cache: EdgeCacheLike & { evict(): void; puts: Response[]; state(): Promise<unknown> } = {
    evict: () => entries.clear(),
    match: async (key) => entries.get(key)?.clone(),
    put: async (key, response) => {
      puts.push(response.clone());
      entries.set(key, response);
    },
    puts,
    state: async () => [...entries.values()][0]?.clone().json(),
  };

  return cache;
}

function memoryBucket(initial?: string) {
  const entries = new Map<string, string>(initial === undefined ? [] : [[R2_KEY, initial]]);
  const puts: string[] = [];
  const bucket: StarsBucket & { puts: string[]; stored(): unknown } = {
    get: async (key) => {
      const text = entries.get(key);
      return text === undefined
        ? null
        : { arrayBuffer: async () => new TextEncoder().encode(text).buffer as ArrayBuffer };
    },
    put: async (key, value) => {
      const text = new TextDecoder().decode(value);
      puts.push(text);
      entries.set(key, text);
      return {};
    },
    puts,
    stored: () => {
      const text = entries.get(R2_KEY);
      return text === undefined ? undefined : JSON.parse(text);
    },
  };

  return bucket;
}

function snapshot(stars: number, fetchedAt: number): string {
  return JSON.stringify({ fetchedAt, stars });
}

/** Fakes for every dependency; `settle()` drains the background work `waitUntil` received. */
function setup({
  bucket = memoryBucket(),
  cache = memoryCache(),
  fetchStars = vi.fn(async (): Promise<StarsFetchResult> => ({ _tag: "Fetched", stars: 42 })),
}: {
  bucket?: ReturnType<typeof memoryBucket>;
  cache?: ReturnType<typeof memoryCache>;
  fetchStars?: StarsDeps["fetchStars"];
} = {}) {
  const pending: Array<Promise<unknown>> = [];
  const clock = { now: T0 };
  const deps: Partial<StarsDeps> = {
    bucket,
    cache,
    fetchStars,
    now: () => clock.now,
    waitUntil: (promise) => pending.push(promise),
  };

  return {
    bucket,
    cache,
    clock,
    fetchStars,
    pending,
    settle: async () => {
      while (pending.length > 0) {
        await pending.shift();
      }
    },
    stars: () => cachedGithubStars(deps),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });

  return { promise, resolve };
}

const failed = (retryAt: number | null = null): StarsFetchResult => ({
  _tag: "Failed",
  reason: "HTTP 403",
  retryAt,
});

let warn: MockInstance<typeof console.warn>;

beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  resetGithubStarsMemo();
  warn.mockRestore();
});

describe("fetchGithubStars", () => {
  it("reads stargazers_count with the User-Agent GitHub requires", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ stargazers_count: 1234 }));

    await expect(fetchGithubStars(T0, fetchImpl as unknown as typeof fetch)).resolves.toEqual({
      _tag: "Fetched",
      stars: 1234,
    });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.github.com/repos/851-labs/tokenmaxxing");
    expect(new Headers(init.headers).get("user-agent")).toBe("tokenmaxxing.sh");
  });

  it("fails on errors, malformed bodies and network errors", async () => {
    const outage = async () => new Response("bad gateway", { status: 502 });
    const malformed = async () => Response.json({ stars: "lots" });
    const notJson = async () => new Response("<html>");
    const offline = async () => {
      throw new TypeError("fetch failed");
    };

    for (const fetchImpl of [outage, malformed, notJson, offline]) {
      await expect(
        fetchGithubStars(T0, fetchImpl as unknown as typeof fetch),
      ).resolves.toMatchObject({ _tag: "Failed", retryAt: null });
    }
  });

  it("reads GitHub's retry hints from rate-limit responses", async () => {
    const respond = (headers: Record<string, string>) => async () =>
      Response.json({ message: "API rate limit exceeded" }, { headers, status: 403 });

    await expect(
      fetchGithubStars(T0, respond({ "retry-after": "120" }) as unknown as typeof fetch),
    ).resolves.toMatchObject({ _tag: "Failed", retryAt: T0 + 120 * 1000 });

    const reset = (T0 + 40 * MINUTE) / 1000;
    await expect(
      fetchGithubStars(
        T0,
        respond({
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": String(reset),
        }) as unknown as typeof fetch,
      ),
    ).resolves.toMatchObject({ _tag: "Failed", reason: "HTTP 403", retryAt: reset * 1000 });

    // A reset with quota left isn't a rate limit hint.
    await expect(
      fetchGithubStars(
        T0,
        respond({
          "x-ratelimit-remaining": "12",
          "x-ratelimit-reset": String(reset),
        }) as unknown as typeof fetch,
      ),
    ).resolves.toMatchObject({ _tag: "Failed", retryAt: null });
  });
});

describe("cachedGithubStars", () => {
  it("cold start returns null and refreshes in the background into every layer", async () => {
    const app = setup();

    await expect(app.stars()).resolves.toBeNull();
    expect(app.pending).toHaveLength(1);
    await app.settle();

    expect(app.bucket.stored()).toEqual({ fetchedAt: T0, stars: 42 });
    await expect(app.cache.state()).resolves.toEqual({
      retryAt: 0,
      snapshot: { fetchedAt: T0, stars: 42 },
    });
    expect(app.cache.puts[0]?.headers.get("cache-control")).toBe("public, max-age=86400");

    await expect(app.stars()).resolves.toBe(42);
    resetGithubStarsMemo();
    await expect(app.stars()).resolves.toBe(42);
    expect(app.pending).toHaveLength(0);
    expect(app.fetchStars).toHaveBeenCalledTimes(1);
  });

  it("falls back to R2 when the colo cache is empty, and copies it up", async () => {
    const app = setup({ bucket: memoryBucket(snapshot(7, T0 - 10 * MINUTE)) });

    await expect(app.stars()).resolves.toBe(7);
    await app.settle();

    expect(app.fetchStars).not.toHaveBeenCalled();
    await expect(app.cache.state()).resolves.toEqual({
      retryAt: 0,
      snapshot: { fetchedAt: T0 - 10 * MINUTE, stars: 7 },
    });
  });

  it("serves the stale count immediately and runs one refresh at a time", async () => {
    const response = deferred<StarsFetchResult>();
    const fetchStars = vi.fn(() => response.promise);
    const app = setup({ bucket: memoryBucket(snapshot(7, T0 - 2 * HOUR)), fetchStars });

    await expect(app.stars()).resolves.toBe(7);
    await expect(app.stars()).resolves.toBe(7);
    expect(app.pending).toHaveLength(2); // the colo copy-up and one refresh

    response.resolve({ _tag: "Fetched", stars: 9 });
    await app.settle();

    await expect(app.stars()).resolves.toBe(9);
    expect(fetchStars).toHaveBeenCalledTimes(1);
    expect(app.bucket.stored()).toEqual({ fetchedAt: T0, stars: 9 });
  });

  it("starts another refresh once a cancelled one's lease lapses", async () => {
    const fetchStars = vi.fn(() => new Promise<StarsFetchResult>(() => undefined));
    const app = setup({ bucket: memoryBucket(snapshot(7, T0 - 2 * HOUR)), fetchStars });

    await app.stars();
    await vi.waitFor(() => expect(fetchStars).toHaveBeenCalledTimes(1));
    app.clock.now += 30 * 1000;
    await app.stars();
    app.clock.now += 31 * 1000;
    await app.stars();
    await vi.waitFor(() => expect(fetchStars).toHaveBeenCalledTimes(2));
  });

  it("keeps the last good count when a refresh fails, and logs it", async () => {
    const fetchStars = vi.fn(async () => failed());
    const app = setup({ bucket: memoryBucket(snapshot(7, T0 - 2 * HOUR)), fetchStars });

    await expect(app.stars()).resolves.toBe(7);
    await app.settle();

    await expect(app.stars()).resolves.toBe(7);
    expect(app.bucket.puts).toEqual([]);
    expect(app.bucket.stored()).toEqual({ fetchedAt: T0 - 2 * HOUR, stars: 7 });
    await expect(app.cache.state()).resolves.toEqual({
      retryAt: T0 + 15 * MINUTE,
      snapshot: { fetchedAt: T0 - 2 * HOUR, stars: 7 },
    });
    expect(warn).toHaveBeenCalledWith("github stars: refresh failed; serving the last good count", {
      reason: "HTTP 403",
      retryAt: new Date(T0 + 15 * MINUTE).toISOString(),
    });
  });

  it("treats a thrown fetch or a corrupt R2 object as a miss, not a crash", async () => {
    const fetchStars = vi.fn(async (): Promise<StarsFetchResult> => {
      throw new Error("boom");
    });
    const app = setup({ bucket: memoryBucket("{not json"), fetchStars });

    await expect(app.stars()).resolves.toBeNull();
    await app.settle();

    await expect(app.stars()).resolves.toBeNull();
    expect(fetchStars).toHaveBeenCalledTimes(1);
    expect(app.bucket.puts).toEqual([]);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("backs off after a failure, across isolates in the colo", async () => {
    const fetchStars = vi.fn(async () => failed());
    const app = setup({ fetchStars });

    await app.stars();
    await app.settle();
    app.clock.now += 14 * MINUTE;
    await app.stars();
    // A fresh isolate reads the backoff from the colo cache.
    resetGithubStarsMemo();
    await expect(app.stars()).resolves.toBeNull();
    await app.settle();
    expect(fetchStars).toHaveBeenCalledTimes(1);

    app.clock.now += 1 * MINUTE;
    await app.stars();
    await app.settle();
    expect(fetchStars).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("waits for GitHub's rate-limit reset, capped at an hour", async () => {
    const fetchStars = vi
      .fn<StarsDeps["fetchStars"]>()
      .mockResolvedValueOnce(failed(T0 + 40 * MINUTE))
      .mockResolvedValueOnce(failed(T0 + 10 * HOUR))
      .mockResolvedValue({ _tag: "Fetched", stars: 5 });
    const app = setup({ fetchStars });

    await app.stars();
    await app.settle();
    app.clock.now = T0 + 39 * MINUTE;
    await app.stars();
    await app.settle();
    expect(fetchStars).toHaveBeenCalledTimes(1);

    app.clock.now = T0 + 40 * MINUTE;
    await app.stars();
    await app.settle();
    expect(fetchStars).toHaveBeenCalledTimes(2);

    app.clock.now = T0 + 99 * MINUTE;
    await app.stars();
    await app.settle();
    expect(fetchStars).toHaveBeenCalledTimes(2);

    app.clock.now = T0 + 100 * MINUTE;
    await app.stars();
    await app.settle();
    await expect(app.stars()).resolves.toBe(5);
    expect(fetchStars).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("adopts a count another colo already refreshed instead of calling GitHub", async () => {
    const bucket = memoryBucket(snapshot(7, T0 - 2 * HOUR));
    const app = setup({ bucket });
    await app.cache.put(
      "https://tokenmaxxing.sh/__cache/github-stars/v2",
      Response.json({ retryAt: 0, snapshot: { fetchedAt: T0 - 2 * HOUR, stars: 7 } }),
    );
    await bucket.put(R2_KEY, new TextEncoder().encode(snapshot(8, T0 - 5 * MINUTE)));

    await expect(app.stars()).resolves.toBe(7);
    await app.settle();

    await expect(app.stars()).resolves.toBe(8);
    expect(app.fetchStars).not.toHaveBeenCalled();
  });
});
