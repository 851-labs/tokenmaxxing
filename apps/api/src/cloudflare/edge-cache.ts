import { Data, Effect, Option } from "effect";

/**
 * Colo-local JSON cache over the Workers Cache API (`caches.default`).
 * Shared by every isolate in a data center, unlike module state. A no-op
 * wherever `caches` is absent (Node tests, workers.dev), and every cache
 * fault degrades to a miss — the cache must never fail a request.
 */

class EdgeCacheError extends Data.TaggedError("EdgeCacheError")<{
  readonly cause: unknown;
}> {}

interface EdgeCacheLike {
  match(key: string): Promise<Response | undefined>;
  put(key: string, response: Response): Promise<void>;
}

interface JsonCache<A> {
  get: Effect.Effect<Option.Option<A>>;
  set(value: A): Effect.Effect<void>;
}

interface EdgeJsonCacheOptions<A> {
  /** Validates cached JSON; a decode miss (e.g. schema drift across a deploy) is a cache miss. */
  decode: (json: unknown) => Option.Option<A>;
  /** Absolute URL used as the cache key; never a real route. */
  key: string;
  ttlSeconds: number;
  /** Overrides `caches.default`; tests pass an in-memory cache. */
  cache?: EdgeCacheLike | null | undefined;
}

function makeEdgeJsonCache<A>(options: EdgeJsonCacheOptions<A>): JsonCache<A> {
  const cache = options.cache === undefined ? defaultEdgeCache() : options.cache;
  if (cache === null) {
    return { get: Effect.succeedNone, set: () => Effect.void };
  }

  const attempt = <B>(run: () => Promise<B>) =>
    Effect.tryPromise({ try: run, catch: (cause) => new EdgeCacheError({ cause }) });

  return {
    get: Effect.gen(function* () {
      const response = yield* attempt(() => cache.match(options.key));
      if (response === undefined) {
        return Option.none<A>();
      }

      return options.decode(yield* attempt(() => response.json()));
    }).pipe(
      Effect.catchTag("EdgeCacheError", (error) =>
        Effect.logWarning("edge cache read failed", error.cause).pipe(Effect.as(Option.none<A>())),
      ),
    ),
    set: (value) =>
      attempt(() =>
        cache.put(
          options.key,
          new Response(JSON.stringify(value), {
            headers: {
              "cache-control": `public, max-age=${options.ttlSeconds}`,
              "content-type": "application/json",
            },
          }),
        ),
      ).pipe(
        Effect.catchTag("EdgeCacheError", (error) =>
          Effect.logWarning("edge cache write failed", error.cause),
        ),
      ),
  };
}

function defaultEdgeCache(): EdgeCacheLike | null {
  const storage = (globalThis as { caches?: { default?: EdgeCacheLike } }).caches;
  return storage?.default ?? null;
}

export { EdgeCacheError, makeEdgeJsonCache };

export type { EdgeCacheLike, JsonCache };
