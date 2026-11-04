import { Context, Effect, Option } from "effect";

import { USAGE_RANGE_DAYS, UsageRangeId } from "@tokenmaxxing/api-contract";
import type { StatsResponse } from "@tokenmaxxing/api-contract";

import { AfterResponse } from "../after-response";
import type { JsonCache } from "../cloudflare/edge-cache";
import type { DatabaseError } from "../database";
import { latestUsageDateKey, trailingWindowStart, yearStartDayKey } from "../date-keys";

const STATS_RANK_LIMIT = 10;
/**
 * /stats is a global aggregate over every usage row, recomputed for six
 * ranges (seconds of D1 time) when it goes stale. A snapshot is fresh for ten
 * minutes; after that it is still served while a rebuild runs after the
 * response (stale-while-revalidate), so no visitor waits on the rebuild
 * unless their data center holds no snapshot at all.
 */
const STATS_FRESH_SECONDS = 600;
/** How long the edge keeps a snapshot it may serve stale. */
const STATS_CACHE_TTL_SECONDS = 86_400;

type StatsSnapshot = Omit<StatsResponse, "generatedAt">;

/** Inclusive YYYY-MM-DD lower bound per range. */
type StatsRangeStarts = Record<UsageRangeId, string>;

interface StatsServiceShape {
  getStats(): Effect.Effect<StatsResponse>;
}

interface StatsRepositoryShape {
  snapshot(input: {
    limit: number;
    /** Inclusive YYYY-MM-DD upper bound applied to every aggregate. */
    until: string;
    ranges: StatsRangeStarts;
  }): Effect.Effect<StatsSnapshot, DatabaseError>;
}

class StatsService extends Context.Service<StatsService, StatsServiceShape>()(
  "@tokenmaxxing/api/StatsService",
) {}

class StatsRepository extends Context.Service<StatsRepository, StatsRepositoryShape>()(
  "@tokenmaxxing/api/StatsRepository",
) {}

const makeStatsService = Effect.fn("makeStatsService")(function* (
  options: {
    cache?: JsonCache<StatsResponse> | undefined;
    now?: () => Date;
  } = {},
) {
  const repository = yield* StatsRepository;
  const now = options.now ?? (() => new Date());
  const { cache } = options;
  // One background rebuild per isolate at a time; concurrent stale reads
  // keep serving the stale snapshot instead of piling on D1.
  let rebuilding = false;

  const rebuild = Effect.gen(function* () {
    const generatedAt = now();
    const snapshot = yield* repository
      .snapshot({
        limit: STATS_RANK_LIMIT,
        until: latestUsageDateKey(generatedAt),
        ranges: statsRangeStarts(generatedAt),
      })
      .pipe(Effect.orDie);

    const stats = { ...snapshot, generatedAt: generatedAt.toISOString() };
    if (cache !== undefined) {
      yield* cache.set(stats);
    }

    return stats;
  });

  const rebuildAfterResponse = (afterResponse: AfterResponse["Service"]) =>
    Effect.suspend(() => {
      if (rebuilding) {
        return Effect.void;
      }
      rebuilding = true;

      return afterResponse.run(
        rebuild.pipe(
          Effect.asVoid,
          Effect.catchCause((cause) => Effect.logWarning("stats rebuild failed", cause)),
          Effect.ensuring(Effect.sync(() => (rebuilding = false))),
        ),
      );
    });

  return StatsService.of({
    getStats: Effect.fn("StatsService.getStats")(function* () {
      const cached = cache === undefined ? Option.none() : yield* cache.get;
      if (Option.isNone(cached)) {
        return yield* rebuild;
      }

      // An unparseable timestamp reads as stale.
      const ageMs = now().getTime() - Date.parse(cached.value.generatedAt);
      if (ageMs < STATS_FRESH_SECONDS * 1000) {
        return cached.value;
      }
      // Looked up per call: the worker provides it per request (see AfterResponse).
      const afterResponse = yield* Effect.serviceOption(AfterResponse);
      if (Option.isNone(afterResponse)) {
        return yield* rebuild;
      }

      yield* rebuildAfterResponse(afterResponse.value);
      return cached.value;
    }),
  });
});

function statsRangeStarts(now: Date): StatsRangeStarts {
  const starts = {} as StatsRangeStarts;
  for (const range of UsageRangeId.literals) {
    const days = USAGE_RANGE_DAYS[range];
    starts[range] = days === null ? yearStartDayKey(now) : trailingWindowStart(days, now);
  }

  return starts;
}

export {
  makeStatsService,
  STATS_CACHE_TTL_SECONDS,
  STATS_FRESH_SECONDS,
  STATS_RANK_LIMIT,
  StatsRepository,
  statsRangeStarts,
  StatsService,
};

export type { StatsRangeStarts, StatsRepositoryShape, StatsSnapshot };
