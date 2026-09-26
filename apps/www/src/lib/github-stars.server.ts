import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { coerceOgRuntimeEnv, type OgR2Bucket } from "./og-runtime";
import { GITHUB_REPO } from "./site";

/**
 * The repo's GitHub star count, fetched by the www worker and cached, so
 * visitors' browsers never call api.github.com (whose 60/hour anonymous
 * limit they would share with every other site they visit).
 *
 * The worker's anonymous calls share Cloudflare egress IPs that are often
 * over that limit too, so reads are stale-while-revalidate: a request serves
 * the last good count from the fastest layer (isolate memo → colo Cache API →
 * R2) and never awaits GitHub. A stale count schedules one background refresh
 * via `waitUntil`; a failed refresh keeps the old count and backs off. Only a
 * successful fetch ever writes R2, so the last good count survives outages
 * and colo cache evictions.
 */

interface EdgeCacheLike {
  match(key: string): Promise<Response | undefined>;
  put(key: string, response: Response): Promise<void>;
}

type StarsBucket = Pick<OgR2Bucket, "get" | "put">;

type StarsFetchResult =
  | { readonly _tag: "Fetched"; readonly stars: number }
  | { readonly _tag: "Failed"; readonly reason: string; readonly retryAt: number | null };

interface StarsDeps {
  bucket: StarsBucket | undefined;
  cache: EdgeCacheLike | undefined;
  fetchStars: (now: number) => Promise<StarsFetchResult>;
  now: () => number;
  waitUntil: (promise: Promise<unknown>) => void;
}

/** A successful fetch: the only thing ever persisted to R2. */
const StarsSnapshot = Schema.Struct({ fetchedAt: Schema.Number, stars: Schema.Number });
type StarsSnapshot = typeof StarsSnapshot.Type;

/** What the colo cache and the isolate memo hold: the snapshot plus the backoff. */
const StarsState = Schema.Struct({
  retryAt: Schema.Number,
  snapshot: Schema.NullOr(StarsSnapshot),
});
type StarsState = typeof StarsState.Type;

const RepoResponse = Schema.Struct({ stargazers_count: Schema.Number });

const R2_KEY = "site/github-stars.json";
/** Cache API key only — never routed. */
const CACHE_KEY = "https://tokenmaxxing.sh/__cache/github-stars/v2";
/** Staleness lives in `fetchedAt`; the colo TTL only bounds how long an idle entry lingers. */
const CACHE_TTL_SECONDS = 24 * 60 * 60;
const FRESH_MS = 60 * 60 * 1000;
/** After a failed refresh, wait this long (or until GitHub's reset hint, capped). */
const BACKOFF_MS = 15 * 60 * 1000;
const MAX_BACKOFF_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5_000;
/** Covers a refresh the runtime cancelled (past `waitUntil`'s limit) before it could clear its flag. */
const REFRESH_LEASE_MS = 60 * 1000;

/** Per-isolate memo in front of the colo cache. */
let memo: StarsState | undefined;
/** When this isolate's in-flight refresh started, so concurrent stale requests share one. */
let refreshingSince: number | undefined;

async function fetchGithubStars(
  now: number = Date.now(),
  fetchImpl: typeof fetch = fetch,
): Promise<StarsFetchResult> {
  let response: Response;
  try {
    response = await fetchImpl(`https://api.github.com/repos/${GITHUB_REPO}`, {
      headers: {
        accept: "application/vnd.github+json",
        // GitHub rejects API requests without a User-Agent.
        "user-agent": "tokenmaxxing.sh",
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    return { _tag: "Failed", reason: String(error), retryAt: null };
  }

  if (!response.ok) {
    return {
      _tag: "Failed",
      reason: `HTTP ${response.status}`,
      retryAt: rateLimitRetryAt(response.headers, now),
    };
  }

  const body = await response.json().catch(() => undefined);
  return Option.match(Schema.decodeUnknownOption(RepoResponse)(body), {
    onNone: () => ({ _tag: "Failed", reason: "unexpected response body", retryAt: null }),
    onSome: (repo) => ({ _tag: "Fetched", stars: repo.stargazers_count }),
  });
}

/** GitHub's own hint for when to retry: `retry-after` seconds, else an exhausted quota's reset. */
function rateLimitRetryAt(headers: Headers, now: number): number | null {
  const retryAfter = Number(headers.get("retry-after") ?? Number.NaN);
  if (Number.isFinite(retryAfter) && retryAfter >= 0) {
    return now + retryAfter * 1000;
  }

  const reset = Number(headers.get("x-ratelimit-reset") ?? Number.NaN);
  if (headers.get("x-ratelimit-remaining") === "0" && Number.isFinite(reset)) {
    return reset * 1000;
  }

  return null;
}

/** When the next GitHub attempt may run: at least the default backoff, at most the cap. */
function backoffUntil(now: number, hint: number | null): number {
  return Math.min(now + MAX_BACKOFF_MS, Math.max(now + BACKOFF_MS, hint ?? 0));
}

function isFresh(snapshot: StarsSnapshot | null, now: number): boolean {
  return snapshot !== null && now - snapshot.fetchedAt < FRESH_MS;
}

/**
 * The last good star count, or null before the first successful fetch (the
 * badge then omits it). Never waits on GitHub.
 */
async function cachedGithubStars(overrides: Partial<StarsDeps> = {}): Promise<number | null> {
  const deps = await resolveDeps(overrides);
  const state = memo ?? (await loadState(deps));
  const now = deps.now();

  const refreshInFlight = refreshingSince !== undefined && now - refreshingSince < REFRESH_LEASE_MS;
  if (!isFresh(state.snapshot, now) && now >= state.retryAt && !refreshInFlight) {
    refreshingSince = now;
    deps.waitUntil(
      refreshStars(deps).finally(() => {
        refreshingSince = undefined;
      }),
    );
  }

  return state.snapshot?.stars ?? null;
}

/** Cold isolate: the colo cache, else R2 (copied up into the colo cache). */
async function loadState(deps: StarsDeps): Promise<StarsState> {
  const cached = await readColoState(deps.cache);
  if (cached !== null) {
    memo = cached;
    return cached;
  }

  const state: StarsState = { retryAt: 0, snapshot: await readSnapshot(deps.bucket) };
  memo = state;
  if (state.snapshot !== null) {
    deps.waitUntil(writeColoState(deps.cache, state));
  }

  return state;
}

/**
 * Background refresh. Another colo may already have refreshed R2, so check it
 * before spending a GitHub request. Concurrent refreshes across colos all
 * write good counts, so last-writer-wins is fine.
 */
async function refreshStars(deps: StarsDeps): Promise<void> {
  const stored = await readSnapshot(deps.bucket);
  if (stored !== null && isFresh(stored, deps.now())) {
    await commit(deps, { retryAt: 0, snapshot: stored });
    return;
  }

  const attemptedAt = deps.now();
  const result = await deps.fetchStars(attemptedAt).catch((error: unknown): StarsFetchResult => ({
    _tag: "Failed",
    reason: String(error),
    retryAt: null,
  }));

  if (result._tag === "Fetched") {
    const snapshot: StarsSnapshot = { fetchedAt: attemptedAt, stars: result.stars };
    await deps.bucket
      ?.put(R2_KEY, new TextEncoder().encode(JSON.stringify(snapshot)), {
        httpMetadata: { contentType: "application/json" },
      })
      .catch((error: unknown) => console.warn("github stars: R2 write failed", error));
    await commit(deps, { retryAt: 0, snapshot });
    return;
  }

  const retryAt = backoffUntil(attemptedAt, result.retryAt);
  console.warn("github stars: refresh failed; serving the last good count", {
    reason: result.reason,
    retryAt: new Date(retryAt).toISOString(),
  });
  // Keep the newest good count we know of; a failure never replaces it.
  const snapshot = newest(stored, memo?.snapshot ?? null);
  await commit(deps, { retryAt, snapshot });
}

async function commit(deps: StarsDeps, state: StarsState): Promise<void> {
  memo = state;
  await writeColoState(deps.cache, state);
}

function newest(a: StarsSnapshot | null, b: StarsSnapshot | null): StarsSnapshot | null {
  if (a === null || b === null) {
    return a ?? b;
  }

  return a.fetchedAt >= b.fetchedAt ? a : b;
}

async function readSnapshot(bucket: StarsBucket | undefined): Promise<StarsSnapshot | null> {
  const object = await bucket?.get(R2_KEY).catch(() => null);
  if (object === null || object === undefined) {
    return null;
  }

  const text = await object.arrayBuffer().then(
    (buffer) => new TextDecoder().decode(buffer),
    () => "",
  );
  return Option.getOrNull(Schema.decodeUnknownOption(Schema.fromJsonString(StarsSnapshot))(text));
}

async function readColoState(cache: EdgeCacheLike | undefined): Promise<StarsState | null> {
  const hit = await cache?.match(CACHE_KEY).catch(() => undefined);
  if (hit === undefined) {
    return null;
  }

  return Option.getOrNull(
    Schema.decodeUnknownOption(StarsState)(await hit.json().catch(() => undefined)),
  );
}

async function writeColoState(cache: EdgeCacheLike | undefined, state: StarsState): Promise<void> {
  await cache
    ?.put(
      CACHE_KEY,
      Response.json(state, {
        headers: { "cache-control": `public, max-age=${CACHE_TTL_SECONDS}` },
      }),
    )
    .catch(() => undefined);
}

async function resolveDeps(overrides: Partial<StarsDeps>): Promise<StarsDeps> {
  const runtime =
    "bucket" in overrides && overrides.waitUntil !== undefined
      ? undefined
      : await loadWorkersRuntime();

  return {
    bucket: "bucket" in overrides ? overrides.bucket : coerceOgRuntimeEnv(runtime?.env)?.BUCKET,
    cache: "cache" in overrides ? overrides.cache : colocationCache(),
    fetchStars: overrides.fetchStars ?? fetchGithubStars,
    now: overrides.now ?? Date.now,
    waitUntil: overrides.waitUntil ?? runtime?.waitUntil ?? detached,
  };
}

async function loadWorkersRuntime(): Promise<typeof import("cloudflare:workers") | undefined> {
  try {
    return await import("cloudflare:workers");
  } catch {
    return undefined;
  }
}

/** Outside workerd there is no request lifetime to extend; just let it run. */
function detached(promise: Promise<unknown>): void {
  promise.catch(() => undefined);
}

function colocationCache(): EdgeCacheLike | undefined {
  return (globalThis as { caches?: { default?: EdgeCacheLike } }).caches?.default;
}

/** Test hook: forget the per-isolate memo and in-flight refresh. */
function resetGithubStarsMemo(): void {
  memo = undefined;
  refreshingSince = undefined;
}

export { cachedGithubStars, fetchGithubStars, resetGithubStarsMemo };

export type { EdgeCacheLike, StarsBucket, StarsDeps, StarsFetchResult };
