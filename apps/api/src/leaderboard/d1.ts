import { Effect, Layer } from "effect";

import { Drizzle } from "../database";
import { topUsers } from "../usage/ranking";
import { LeaderboardRepository, LeaderboardService, makeLeaderboardService } from "./service";

const makeD1LeaderboardRepository = Effect.fn("makeD1LeaderboardRepository")(function* () {
  const database = yield* Drizzle;

  return LeaderboardRepository.of({
    list: (input) => database.use((db) => topUsers(db, input)),
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
