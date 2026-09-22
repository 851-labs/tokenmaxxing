import { Context } from "effect";
import { Effect } from "effect";

import type { DatabaseError } from "../database";

/**
 * Scheduled housekeeping for short-lived auth rows. Reads already ignore
 * expired sessions and login requests; this only keeps the tables small.
 * CLI tokens never expire, so they are out of scope by design.
 */

interface PurgeResult {
  cliLoginRequests: number;
  sessions: number;
}

interface CleanupServiceShape {
  purgeExpired(now: Date): Effect.Effect<PurgeResult, never, any>;
}

interface CleanupRepositoryShape {
  /** One batch: delete sessions and CLI login requests with expires_at <= now. */
  deleteExpired(now: Date): Effect.Effect<PurgeResult, DatabaseError, any>;
}

class CleanupService extends Context.Service<CleanupService, CleanupServiceShape>()(
  "@tokenmaxxing/api/CleanupService",
) {}

class CleanupRepository extends Context.Service<CleanupRepository, CleanupRepositoryShape>()(
  "@tokenmaxxing/api/CleanupRepository",
) {}

const makeCleanupService = Effect.fn("makeCleanupService")(function* () {
  const repository = yield* CleanupRepository;

  return CleanupService.of({
    purgeExpired: Effect.fn("CleanupService.purgeExpired")(function* (now) {
      const purged = yield* repository.deleteExpired(now).pipe(Effect.orDie);
      yield* Effect.logInfo("purged expired auth rows", purged);

      return purged;
    }),
  });
});

export { CleanupRepository, CleanupService, makeCleanupService };

export type { CleanupRepositoryShape, PurgeResult };
