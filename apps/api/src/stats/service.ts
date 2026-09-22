import { Context } from "effect";
import { Effect } from "effect";
import { Option } from "effect";

import type { StatsResponse } from "@tokenmaxxing/api-contract";

import type { JsonCache } from "../cloudflare/edge-cache";
import type { DatabaseError } from "../database";
import { latestUsageDateKey, trailingWindowStart } from "../date-keys";

const STATS_RANK_LIMIT = 10;
const THIRTY_DAYS = 30;
const STATS_2026_START = "2026-01-01";
/** /stats is a global aggregate over every usage row; minutes of staleness are fine. */
const STATS_CACHE_TTL_SECONDS = 300;

type StatsSnapshot = Omit<
  typeof StatsResponse.Type,
  "generatedAt" | "last30dSince" | "year2026Since"
>;

interface StatsServiceShape {
  getStats(): Effect.Effect<typeof StatsResponse.Type, never, any>;
}

interface StatsRepositoryShape {
  snapshot(input: {
    last30dSince: string;
    limit: number;
    /** Inclusive YYYY-MM-DD upper bound applied to every aggregate. */
    until: string;
  }): Effect.Effect<StatsSnapshot, DatabaseError, any>;
}

class StatsService extends Context.Service<StatsService, StatsServiceShape>()(
  "@tokenmaxxing/api/StatsService",
) {}

class StatsRepository extends Context.Service<StatsRepository, StatsRepositoryShape>()(
  "@tokenmaxxing/api/StatsRepository",
) {}

const makeStatsService = Effect.fn("makeStatsService")(function* (
  options: {
    cache?: JsonCache<typeof StatsResponse.Type> | undefined;
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
      const last30dSince = statsWindowStart(generatedAt);
      const snapshot = yield* repository
        .snapshot({
          last30dSince,
          limit: STATS_RANK_LIMIT,
          until: latestUsageDateKey(generatedAt),
        })
        .pipe(Effect.orDie);

      const stats = {
        ...snapshot,
        generatedAt: generatedAt.toISOString(),
        last30dSince,
        year2026Since: STATS_2026_START,
      };
      if (cache !== undefined) {
        yield* cache.set(stats);
      }

      return stats;
    }),
  });
});

function statsWindowStart(now: Date): string {
  return trailingWindowStart(THIRTY_DAYS, now);
}

export {
  makeStatsService,
  STATS_2026_START,
  STATS_CACHE_TTL_SECONDS,
  STATS_RANK_LIMIT,
  StatsRepository,
  StatsService,
  statsWindowStart,
};

export type { StatsRepositoryShape, StatsSnapshot };
