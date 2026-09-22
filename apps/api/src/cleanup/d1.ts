import { cliLoginRequests, sessions } from "@tokenmaxxing/db";
import { lte } from "drizzle-orm";
import { Effect, Layer } from "effect";

import { Drizzle } from "../database";
import { CleanupRepository, CleanupService, makeCleanupService } from "./service";

const makeD1CleanupRepository = Effect.fn("makeD1CleanupRepository")(function* () {
  const database = yield* Drizzle;

  return CleanupRepository.of({
    deleteExpired: (now) =>
      Effect.gen(function* () {
        const [expiredSessions, expiredRequests] = yield* database.use((db) =>
          db.batch([
            db.delete(sessions).where(lte(sessions.expiresAt, now)).returning({ id: sessions.id }),
            db
              .delete(cliLoginRequests)
              .where(lte(cliLoginRequests.expiresAt, now))
              .returning({ id: cliLoginRequests.id }),
          ]),
        );

        return { cliLoginRequests: expiredRequests.length, sessions: expiredSessions.length };
      }),
  });
});

const CleanupRepositoryLive = Layer.effect(CleanupRepository, makeD1CleanupRepository());

const CleanupServiceLive = Layer.effect(CleanupService, makeCleanupService()).pipe(
  Layer.provide(CleanupRepositoryLive),
);

export { CleanupRepositoryLive, CleanupServiceLive };
