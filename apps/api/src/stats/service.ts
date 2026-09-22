import { Context, Effect, Option } from "effect";

import type { StatsResponse, StatsWindowId } from "@tokenmaxxing/api-contract";

import type { JsonCache } from "../cloudflare/edge-cache";
import type { DatabaseError } from "../database";
import { latestUsageDateKey, trailingWindowStart, yearStartDayKey } from "../date-keys";

const STATS_RANK_LIMIT = 10;
const THIRTY_DAYS = 30;
/** /stats is a global aggregate over every usage row; minutes of staleness are fine. */
const STATS_CACHE_TTL_SECONDS = 300;

type StatsSnapshot = Omit<StatsResponse, "generatedAt">;

/** Inclusive YYYY-MM-DD lower bound per window. */
type StatsWindowStarts = Record<StatsWindowId, string>;

interface StatsServiceShape {
  getStats(): Effect.Effect<StatsResponse>;
}

interface StatsRepositoryShape {
  snapshot(input: {
    limit: number;
    /** Inclusive YYYY-MM-DD upper bound applied to every aggregate. */
    until: string;
    windows: StatsWindowStarts;
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
          windows: statsWindowStarts(generatedAt),
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

function statsWindowStarts(now: Date): StatsWindowStarts {
  return {
    last30d: trailingWindowStart(THIRTY_DAYS, now),
    ytd: yearStartDayKey(now),
  };
}

export {
  makeStatsService,
  STATS_CACHE_TTL_SECONDS,
  STATS_RANK_LIMIT,
  StatsRepository,
  StatsService,
  statsWindowStarts,
};

export type { StatsRepositoryShape, StatsSnapshot, StatsWindowStarts };
