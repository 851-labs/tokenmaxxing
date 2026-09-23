import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { GITHUB_REPO } from "./site";

/**
 * The repo's GitHub star count, fetched by the www worker and cached, so
 * visitors' browsers never call api.github.com (whose 60/hour anonymous
 * limit they would share with every other site they visit).
 */

interface EdgeCacheLike {
  match(key: string): Promise<Response | undefined>;
  put(key: string, response: Response): Promise<void>;
}

interface StarsCacheOptions {
  cache?: EdgeCacheLike | undefined;
  fetchStars?: () => Promise<number | null>;
  now?: () => number;
}

/** Cache API key only — never routed. */
const CACHE_KEY = "https://tokenmaxxing.sh/__cache/github-stars";
const HIT_TTL_SECONDS = 60 * 60;
/** Keep a failure (rate limit, outage) briefly so it isn't retried per request. */
const MISS_TTL_SECONDS = 10 * 60;
const FETCH_TIMEOUT_MS = 2_000;

const RepoResponse = Schema.Struct({ stargazers_count: Schema.Number });
const CachedStars = Schema.Struct({ stars: Schema.NullOr(Schema.Number) });

/** Per-isolate memo in front of the colo cache (and the only cache in vite dev). */
let memo: { expiresAt: number; stars: number | null } | undefined;

function colocationCache(): EdgeCacheLike | undefined {
  return (globalThis as { caches?: { default?: EdgeCacheLike } }).caches?.default;
}

async function fetchGithubStars(fetchImpl: typeof fetch = fetch): Promise<number | null> {
  try {
    const response = await fetchImpl(`https://api.github.com/repos/${GITHUB_REPO}`, {
      headers: {
        accept: "application/vnd.github+json",
        // GitHub rejects API requests without a User-Agent.
        "user-agent": "tokenmaxxing.sh",
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      return null;
    }

    return Option.match(Schema.decodeUnknownOption(RepoResponse)(await response.json()), {
      onNone: () => null,
      onSome: (repo) => repo.stargazers_count,
    });
  } catch {
    return null;
  }
}

/** The star count, or null when GitHub is unavailable (the badge then omits it). */
async function cachedGithubStars({
  cache = colocationCache(),
  fetchStars = fetchGithubStars,
  now = Date.now,
}: StarsCacheOptions = {}): Promise<number | null> {
  if (memo !== undefined && memo.expiresAt > now()) {
    return memo.stars;
  }

  const hit = await cache?.match(CACHE_KEY).catch(() => undefined);
  const cached =
    hit === undefined
      ? Option.none()
      : Schema.decodeUnknownOption(CachedStars)(await hit.json().catch(() => undefined));
  if (Option.isSome(cached)) {
    // The colo entry's TTL bounds staleness; the memo only saves lookups.
    memo = { expiresAt: now() + MISS_TTL_SECONDS * 1000, stars: cached.value.stars };
    return cached.value.stars;
  }

  const stars = await fetchStars();
  const ttlSeconds = stars === null ? MISS_TTL_SECONDS : HIT_TTL_SECONDS;
  memo = { expiresAt: now() + ttlSeconds * 1000, stars };
  await cache
    ?.put(
      CACHE_KEY,
      Response.json({ stars }, { headers: { "cache-control": `public, max-age=${ttlSeconds}` } }),
    )
    .catch(() => undefined);

  return stars;
}

/** Test hook: forget the per-isolate memo. */
function resetGithubStarsMemo(): void {
  memo = undefined;
}

export { cachedGithubStars, fetchGithubStars, resetGithubStarsMemo };

export type { EdgeCacheLike };
