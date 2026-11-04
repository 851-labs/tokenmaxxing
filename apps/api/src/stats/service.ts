import { Context, Effect, Option } from "effect";

import { USAGE_RANGE_DAYS, UsageRangeId } from "@tokenmaxxing/api-contract";
import type { StatsResponse } from "@tokenmaxxing/api-contract";

import type { JsonCache } from "../cloudflare/edge-cache";
import type { DatabaseError } from "../database";
import { latestUsageDateKey, trailingWindowStart, yearStartDayKey } from "../date-keys";

const STATS_RANK_LIMIT = 10;
/**
 * /stats is a global aggregate over every usage row, recomputed for six
 * ranges on a miss; ten minutes of staleness is fine.
 */
const STATS_CACHE_TTL_SECONDS = 600;

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
  const cache = options.cache;

  return StatsService.of({
    getStats: Effect.fn("StatsService.getStats")(function* () {
      if (cache !== undefined) {
        const cached = yield* cache.get;
        if (Option.isSome(cached)) {
          return cached.value;
        }
      }

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
  STATS_RANK_LIMIT,
  StatsRepository,
  statsRangeStarts,
  StatsService,
};

export type { StatsRangeStarts, StatsRepositoryShape, StatsSnapshot };
