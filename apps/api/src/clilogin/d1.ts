import { cliLoginRequests, cliTokens, devices } from "@tokenmaxxing/db";
import { and, eq, gt, sql } from "drizzle-orm";
import { Effect, Layer, Option } from "effect";

import { AuthRepositoryLive } from "../auth/d1";
import { Drizzle, firstRow } from "../database";
import { CliLoginRepository, CliLoginService, makeCliLoginService } from "./service";

const makeD1CliLoginRepository = Effect.fn("makeD1CliLoginRepository")(function* () {
  const database = yield* Drizzle;

  const findRequestWhere = (where: ReturnType<typeof eq>) =>
    database
      .use((db) => db.select().from(cliLoginRequests).where(where).limit(1))
      .pipe(Effect.map(firstRow));

  return CliLoginRepository.of({
    insertRequest: (input) =>
      Effect.gen(function* () {
        yield* database.use((db) =>
          db.insert(cliLoginRequests).values({
            id: input.id,
            code: input.code,
            deviceCodeHash: input.deviceCodeHash,
            status: "pending",
            deviceArch: input.deviceArch ?? null,
            deviceId: input.deviceId,
            deviceName: input.deviceName,
            devicePlatform: input.devicePlatform,
            deviceVersion: input.deviceVersion ?? null,
            expiresAt: input.expiresAt,
            createdAt: input.createdAt,
          }),
        );
      }),
    findRequestByCode: (code) => findRequestWhere(eq(cliLoginRequests.code, code)),
    findRequestByDeviceCodeHash: (deviceCodeHash) =>
      findRequestWhere(eq(cliLoginRequests.deviceCodeHash, deviceCodeHash)),
    approveRequest: ({ now, requestId, userId }) =>
      database
        .use((db) =>
          db
            .update(cliLoginRequests)
            .set({ status: "approved", userId })
            .where(
              and(
                eq(cliLoginRequests.id, requestId),
                eq(cliLoginRequests.status, "pending"),
                gt(cliLoginRequests.expiresAt, now),
              ),
            )
            .returning(),
        )
        .pipe(Effect.map(firstRow)),
    claimApprovedRequest: ({ now, requestId }) =>
      database
        .use((db) =>
          db
            .delete(cliLoginRequests)
            .where(
              and(
                eq(cliLoginRequests.id, requestId),
                eq(cliLoginRequests.status, "approved"),
                gt(cliLoginRequests.expiresAt, now),
              ),
            )
            .returning(),
        )
        .pipe(Effect.map(firstRow)),
    deleteRequest: (id) =>
      Effect.gen(function* () {
        yield* database.use((db) => db.delete(cliLoginRequests).where(eq(cliLoginRequests.id, id)));
      }),
    findDeviceOwner: (deviceId) =>
      database
        .use((db) =>
          db
            .select({ userId: devices.userId })
            .from(devices)
            .where(eq(devices.id, deviceId))
            .limit(1),
        )
        .pipe(Effect.map((rows) => firstRow(rows).pipe(Option.map((row) => row.userId)))),
    issueCliToken: (input) =>
      Effect.gen(function* () {
        const [, inserted] = yield* database.use((db) =>
          db.batch([
            db
              .insert(devices)
              .values({
                arch: input.deviceArch,
                id: input.deviceId,
                userId: input.userId,
                name: input.deviceName,
                platform: input.devicePlatform,
                version: input.deviceVersion,
                createdAt: input.now,
              })
              .onConflictDoUpdate({
                target: devices.id,
                set: {
                  arch: input.deviceArch,
                  name: input.deviceName,
                  platform: input.devicePlatform,
                  version: input.deviceVersion,
                },
                // Never re-home a device (and its usage history) that
                // belongs to someone else.
                setWhere: eq(devices.userId, input.userId),
              }),
            // Guarded insert: only mint when the device is the user's, so a
            // racing claim on the same device id cannot bind this token to
            // another account's device.
            db
              .insert(cliTokens)
              .select(
                db
                  .select({
                    id: sql<string>`${input.tokenId}`.as("id"),
                    tokenHash: sql<string>`${input.tokenHash}`.as("token_hash"),
                    userId: devices.userId,
                    deviceId: devices.id,
                    name: sql<string>`${input.deviceName}`.as("name"),
                    createdAt: sql<number>`${input.now.getTime()}`.as("created_at"),
                    lastUsedAt: sql<null>`null`.as("last_used_at"),
                    revokedAt: sql<null>`null`.as("revoked_at"),
                  })
                  .from(devices)
                  .where(and(eq(devices.id, input.deviceId), eq(devices.userId, input.userId))),
              )
              .returning({ id: cliTokens.id }),
          ]),
        );

        return inserted.length > 0;
      }),
  });
});

const CliLoginRepositoryLive = Layer.effect(CliLoginRepository, makeD1CliLoginRepository());

const CliLoginServiceLive = Layer.effect(CliLoginService, makeCliLoginService()).pipe(
  Layer.provide([CliLoginRepositoryLive, AuthRepositoryLive]),
);

export { CliLoginRepositoryLive, CliLoginServiceLive };
