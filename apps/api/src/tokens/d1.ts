import {
  cliTokens,
  devices,
  usageDays,
  usageRawBatches,
  usageSourceStats,
  users,
} from "@tokenmaxxing/db";
import { and, desc, eq, isNull } from "drizzle-orm";
import { Effect } from "effect";
import { Layer } from "effect";
import { Option } from "effect";

import { Drizzle } from "../database";
import { RawUsageObjectStore } from "../usage/raw-store";
import { TokensRepository } from "./service";

const makeD1TokensRepository = Effect.fn("makeD1TokensRepository")(function* () {
  const database = yield* Drizzle;
  const rawStore = yield* RawUsageObjectStore;

  return TokensRepository.of({
    findIdentityByHash: (tokenHash, now) =>
      Effect.gen(function* () {
        const rows = yield* database.use((db) =>
          db
            .select({ token: cliTokens, user: users })
            .from(cliTokens)
            .innerJoin(users, eq(cliTokens.userId, users.id))
            .where(and(eq(cliTokens.tokenHash, tokenHash), isNull(cliTokens.revokedAt)))
            .limit(1),
        );
        const row = rows[0];
        if (row === undefined) {
          return Option.none();
        }

        // Freshness bookkeeping only; failures here must not fail auth.
        // Hour granularity is plenty, and skips a D1 write on almost every
        // CLI request.
        if (isLastUsedStale(row.token.lastUsedAt, now)) {
          yield* database
            .use((db) =>
              db.update(cliTokens).set({ lastUsedAt: now }).where(eq(cliTokens.id, row.token.id)),
            )
            .pipe(Effect.ignore);
        }

        return Option.some({
          deviceId: row.token.deviceId,
          tokenId: row.token.id,
          user: {
            avatarUrl: row.user.avatarUrl,
            id: row.user.id,
            login: row.user.login,
            name: row.user.name,
          },
        });
      }),
    listDevices: (userId) =>
      Effect.gen(function* () {
        const rows = yield* database.use((db) =>
          db
            .select()
            .from(devices)
            .where(eq(devices.userId, userId))
            .orderBy(desc(devices.createdAt)),
        );

        return rows.map((row) => ({
          arch: row.arch,
          createdAt: row.createdAt.toISOString(),
          id: row.id,
          lastSyncAt: row.lastSyncAt?.toISOString() ?? null,
          name: row.name,
          platform: row.platform,
          version: row.version,
        }));
      }),
    listTokens: (userId) =>
      Effect.gen(function* () {
        const rows = yield* database.use((db) =>
          db
            .select()
            .from(cliTokens)
            .where(and(eq(cliTokens.userId, userId), isNull(cliTokens.revokedAt)))
            .orderBy(desc(cliTokens.createdAt)),
        );

        return rows.map((row) => ({
          createdAt: row.createdAt.toISOString(),
          deviceId: row.deviceId,
          id: row.id,
          lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
          name: row.name,
          revokedAt: row.revokedAt?.toISOString() ?? null,
        }));
      }),
    deleteDevice: (userId, deviceId, now) =>
      Effect.gen(function* () {
        const rawBatchRows = yield* database.use((db) =>
          db
            .select({ objectKey: usageRawBatches.objectKey })
            .from(usageRawBatches)
            .where(and(eq(usageRawBatches.userId, userId), eq(usageRawBatches.deviceId, deviceId))),
        );
        const rawObjectKeys = new Set(rawBatchRows.map((row) => row.objectKey));
        // Objects before rows: if the batch below fails, a retry finds the
        // rows again and re-deleting missing objects is a no-op. The reverse
        // order would strand objects with no row left to find them by.
        yield* rawStore.deleteObjects([...rawObjectKeys]);

        const [deletedDevices, , , , deletedRawBatches] = yield* database.use((db) =>
          db.batch([
            db
              .delete(devices)
              .where(and(eq(devices.id, deviceId), eq(devices.userId, userId)))
              .returning({ id: devices.id }),
            db
              .delete(usageDays)
              .where(and(eq(usageDays.userId, userId), eq(usageDays.deviceId, deviceId))),
            db
              .delete(usageSourceStats)
              .where(
                and(eq(usageSourceStats.userId, userId), eq(usageSourceStats.deviceId, deviceId)),
              ),
            db
              .update(cliTokens)
              .set({ revokedAt: now })
              .where(
                and(
                  eq(cliTokens.userId, userId),
                  eq(cliTokens.deviceId, deviceId),
                  isNull(cliTokens.revokedAt),
                ),
              ),
            db
              .delete(usageRawBatches)
              .where(
                and(eq(usageRawBatches.userId, userId), eq(usageRawBatches.deviceId, deviceId)),
              )
              .returning({ objectKey: usageRawBatches.objectKey }),
          ]),
        );
        // An ingest that landed between the lookup and the batch.
        yield* rawStore.deleteObjects(
          deletedRawBatches
            .map((row) => row.objectKey)
            .filter((objectKey) => !rawObjectKeys.has(objectKey)),
        );

        return deletedDevices.length > 0;
      }),
    revokeToken: (userId, tokenId, now) =>
      Effect.gen(function* () {
        const rows = yield* database.use((db) =>
          db
            .update(cliTokens)
            .set({ revokedAt: now })
            .where(
              and(
                eq(cliTokens.id, tokenId),
                eq(cliTokens.userId, userId),
                isNull(cliTokens.revokedAt),
              ),
            )
            .returning({ id: cliTokens.id }),
        );

        return rows.length > 0;
      }),
  });
});

const TokensRepositoryLive = Layer.effect(TokensRepository, makeD1TokensRepository());

const LAST_USED_REFRESH_MS = 60 * 60 * 1000;

function isLastUsedStale(lastUsedAt: Date | null, now: Date): boolean {
  return lastUsedAt === null || now.getTime() - lastUsedAt.getTime() >= LAST_USED_REFRESH_MS;
}

export { isLastUsedStale, TokensRepositoryLive };
