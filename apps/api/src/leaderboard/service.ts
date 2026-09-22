import { Context } from "effect";
import { Effect } from "effect";

import type {
  LeaderboardEntry,
  LeaderboardMetric,
  LeaderboardWindow,
} from "@tokenmaxxing/api-contract";

import type { DatabaseError } from "../database";
import { latestUsageDateKey, trailingWindowStart } from "../date-keys";

/**
 * Public rankings. Windows are computed as UTC date strings and compared
 * lexicographically against the opaque YYYY-MM-DD day keys — a user's
 * "today" can wobble ±1 day at window edges (local-time buckets); accepted.
 * Every window, including all-time, is capped at UTC today + 1 so rows dated
 * in the future can never count.
 */

const LEADERBOARD_LIMIT = 100;

interface LeaderboardServiceShape {
  list(
    metric: typeof LeaderboardMetric.Type,
    window: typeof LeaderboardWindow.Type,
  ): Effect.Effect<(typeof LeaderboardEntry.Type)[], never, any>;
}

interface LeaderboardRepositoryShape {
  list(input: {
    limit: number;
    metric: typeof LeaderboardMetric.Type;
    /** Inclusive YYYY-MM-DD lower bound; null = all time. */
    since: string | null;
    /** Inclusive YYYY-MM-DD upper bound. */
    until: string;
  }): Effect.Effect<(typeof LeaderboardEntry.Type)[], DatabaseError, any>;
}

class LeaderboardService extends Context.Service<LeaderboardService, LeaderboardServiceShape>()(
  "@tokenmaxxing/api/LeaderboardService",
) {}

class LeaderboardRepository extends Context.Service<
  LeaderboardRepository,
  LeaderboardRepositoryShape
>()("@tokenmaxxing/api/LeaderboardRepository") {}

/** Inclusive lower bound covering the trailing `days` calendar days (UTC). */
function windowStart(window: typeof LeaderboardWindow.Type, now: Date): string | null {
  if (window === "all") {
    return null;
  }

  return trailingWindowStart(window === "30d" ? 30 : 7, now);
}

const makeLeaderboardService = Effect.fn("makeLeaderboardService")(function* () {
  const repository = yield* LeaderboardRepository;

  return LeaderboardService.of({
    list: Effect.fn("LeaderboardService.list")(function* (metric, window) {
      const now = new Date();
      return yield* repository
        .list({
          limit: LEADERBOARD_LIMIT,
          metric,
          since: windowStart(window, now),
          until: latestUsageDateKey(now),
        })
        .pipe(Effect.orDie);
    }),
  });
});

export { LeaderboardRepository, LeaderboardService, makeLeaderboardService, windowStart };

export type { LeaderboardRepositoryShape };
