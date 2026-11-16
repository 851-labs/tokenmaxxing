import { Effect, Layer } from "effect";

import { Drizzle } from "../database";
import { rankingSummary, topUsers } from "../usage/ranking";
import { LeaderboardRepository, LeaderboardService, makeLeaderboardService } from "./service";

const makeD1LeaderboardRepository = Effect.fn("makeD1LeaderboardRepository")(function* () {
  const database = yield* Drizzle;

  return LeaderboardRepository.of({
    list: (input) => database.use((db) => topUsers(db, input)),
    summary: (input) =>
      database
        .use((db) => rankingSummary(db, input))
        .pipe(
          // An aggregate without GROUP BY always yields exactly one row.
          Effect.map(([row]) => ({ total: row?.total ?? 0, userRank: row?.userRank ?? null })),
        ),
  });
});

const LeaderboardRepositoryLive = Layer.effect(
  LeaderboardRepository,
  makeD1LeaderboardRepository(),
);

const LeaderboardServiceLive = Layer.effect(LeaderboardService, makeLeaderboardService()).pipe(
  Layer.provide(LeaderboardRepositoryLive),
);

export { LeaderboardRepositoryLive, LeaderboardServiceLive };
