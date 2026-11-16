import { Context, Effect } from "effect";

import type {
  LeaderboardEntry,
  LeaderboardMetric,
  LeaderboardWindow,
} from "@tokenmaxxing/api-contract";

import type { DatabaseError } from "../database";
import { latestUsageDateKey } from "../date-keys";
import { leaderboardWindowStart } from "../usage/ranking";

/**
 * Public rankings. Windows are computed as UTC date strings and compared
 * lexicographically against the opaque YYYY-MM-DD day keys — a user's
 * "today" can wobble ±1 day at window edges (local-time buckets); accepted.
 * Every window, including all-time, is capped at UTC today + 1 so rows dated
 * in the future can never count.
 */

/** Rows per page. */
const LEADERBOARD_PAGE_SIZE = 100;

interface LeaderboardPage {
  entries: (typeof LeaderboardEntry.Type)[];
  /** The offset of the next page; null when this is the last one. */
  nextOffset: number | null;
  /** Users ranked under the page's metric and window. */
  total: number;
  /** The viewer's rank under the same metric and window; null when signed out or unranked. */
  viewerRank: number | null;
}

interface LeaderboardServiceShape {
  list(
    metric: typeof LeaderboardMetric.Type,
    window: typeof LeaderboardWindow.Type,
    /** Ranks to skip; the page starts at rank `offset + 1`. */
    offset?: number,
    /** The signed-in viewer, whose rank the page reports; null when signed out. */
    viewerId?: string | null,
  ): Effect.Effect<LeaderboardPage>;
}

interface LeaderboardRankingInput {
  metric: typeof LeaderboardMetric.Type;
  /** Inclusive YYYY-MM-DD lower bound; null = all time. */
  since: string | null;
  /** Inclusive YYYY-MM-DD upper bound. */
  until: string;
}

interface LeaderboardRepositoryShape {
  list(
    input: LeaderboardRankingInput & {
      limit: number;
      /** Ranks to skip; defaults to 0. */
      offset?: number;
    },
  ): Effect.Effect<(typeof LeaderboardEntry.Type)[], DatabaseError>;
  /** The ranking's size and one user's rank in it (null when unranked or no user). */
  summary(
    input: LeaderboardRankingInput & { userId: string | null },
  ): Effect.Effect<{ total: number; userRank: number | null }, DatabaseError>;
}

class LeaderboardService extends Context.Service<LeaderboardService, LeaderboardServiceShape>()(
  "@tokenmaxxing/api/LeaderboardService",
) {}

class LeaderboardRepository extends Context.Service<
  LeaderboardRepository,
  LeaderboardRepositoryShape
>()("@tokenmaxxing/api/LeaderboardRepository") {}

const makeLeaderboardService = Effect.fn("makeLeaderboardService")(function* () {
  const repository = yield* LeaderboardRepository;

  return LeaderboardService.of({
    list: Effect.fn("LeaderboardService.list")(function* (
      metric,
      window,
      offset = 0,
      viewerId = null,
    ) {
      const now = new Date();
      const ranking = {
        metric,
        since: leaderboardWindowStart(window, now),
        until: latestUsageDateKey(now),
      };
      const [rows, summary] = yield* Effect.all(
        [
          // One extra row says whether another page follows.
          repository.list({ ...ranking, limit: LEADERBOARD_PAGE_SIZE + 1, offset }),
          repository.summary({ ...ranking, userId: viewerId }),
        ],
        { concurrency: "unbounded" },
      ).pipe(Effect.orDie);
      const hasMore = rows.length > LEADERBOARD_PAGE_SIZE;

      return {
        entries: hasMore ? rows.slice(0, LEADERBOARD_PAGE_SIZE) : rows,
        nextOffset: hasMore ? offset + LEADERBOARD_PAGE_SIZE : null,
        total: summary.total,
        viewerRank: summary.userRank,
      };
    }),
  });
});

export { LEADERBOARD_PAGE_SIZE, LeaderboardRepository, LeaderboardService, makeLeaderboardService };

export type { LeaderboardPage, LeaderboardRepositoryShape };
