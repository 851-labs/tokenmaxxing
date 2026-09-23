import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  cachedGithubStars,
  fetchGithubStars,
  resetGithubStarsMemo,
  type EdgeCacheLike,
} from "./github-stars.server";

function memoryCache() {
  const entries = new Map<string, Response>();
  const puts: Response[] = [];
  const cache: EdgeCacheLike & { puts: Response[] } = {
    match: async (key) => entries.get(key)?.clone(),
    put: async (key, response) => {
      puts.push(response.clone());
      entries.set(key, response);
    },
    puts,
  };

  return cache;
}

afterEach(() => resetGithubStarsMemo());

describe("fetchGithubStars", () => {
  it("reads stargazers_count with the User-Agent GitHub requires", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ stargazers_count: 1234 }));

    await expect(fetchGithubStars(fetchImpl as unknown as typeof fetch)).resolves.toBe(1234);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.github.com/repos/851-labs/tokenmaxxing");
    expect(new Headers(init.headers).get("user-agent")).toBe("tokenmaxxing.sh");
  });

  it("returns null when rate-limited, malformed or unreachable", async () => {
    const limited = async () => Response.json({ message: "rate limited" }, { status: 403 });
    const malformed = async () => Response.json({ stars: "lots" });
    const offline = async () => {
      throw new TypeError("fetch failed");
    };

    for (const fetchImpl of [limited, malformed, offline]) {
      await expect(fetchGithubStars(fetchImpl as unknown as typeof fetch)).resolves.toBeNull();
    }
  });
});

describe("cachedGithubStars", () => {
  it("fetches once, then serves the colo cache and the isolate memo", async () => {
    const cache = memoryCache();
    const fetchStars = vi.fn(async () => 42);

    await expect(cachedGithubStars({ cache, fetchStars })).resolves.toBe(42);
    await expect(cachedGithubStars({ cache, fetchStars })).resolves.toBe(42);
    resetGithubStarsMemo();
    await expect(cachedGithubStars({ cache, fetchStars })).resolves.toBe(42);

    expect(fetchStars).toHaveBeenCalledTimes(1);
    expect(cache.puts[0]?.headers.get("cache-control")).toBe("public, max-age=3600");
  });

  it("caches a failure briefly instead of retrying GitHub per request", async () => {
    const cache = memoryCache();
    const fetchStars = vi.fn(async () => null);
    let clock = 0;
    const now = () => clock;

    await expect(cachedGithubStars({ cache, fetchStars, now })).resolves.toBeNull();
    await expect(cachedGithubStars({ cache, fetchStars, now })).resolves.toBeNull();
    expect(fetchStars).toHaveBeenCalledTimes(1);
    expect(cache.puts[0]?.headers.get("cache-control")).toBe("public, max-age=600");

    // Without a colo cache (vite dev) the memo alone expires on schedule.
    resetGithubStarsMemo();
    await cachedGithubStars({ cache: undefined, fetchStars, now });
    clock += 10 * 60 * 1000 + 1;
    await cachedGithubStars({ cache: undefined, fetchStars, now });
    expect(fetchStars).toHaveBeenCalledTimes(3);
  });
});
