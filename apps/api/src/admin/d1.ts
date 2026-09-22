import { cliTokens, devices, usageDays, userAccounts, users, type Device } from "@tokenmaxxing/db";
import { and, asc, eq, inArray } from "drizzle-orm";
import { Effect, Layer } from "effect";

import { DeviceId, UserId } from "@tokenmaxxing/api-contract";

import { Drizzle } from "../database";
import { usageAggregates } from "../usage/aggregates";
import type { AdminDeviceSnapshot, AdminUserSnapshot } from "./fleet";
import { NpmRegistryLive } from "./npm-registry";
import { AdminRepository, AdminService, makeAdminService } from "./service";

const makeD1AdminRepository = Effect.fn("makeD1AdminRepository")(function* () {
  const database = yield* Drizzle;

  return AdminRepository.of({
    hasAnyVerifiedEmail: (userId, emails) =>
      Effect.gen(function* () {
        const rows = yield* database.use((db) =>
          db
            .select({ userId: userAccounts.userId })
            .from(userAccounts)
            .where(
              and(
                eq(userAccounts.userId, userId),
                inArray(userAccounts.email, [...emails]),
                eq(userAccounts.emailVerified, true),
              ),
            )
            .limit(1),
        );

        return rows.length > 0;
      }),
    listUserSnapshots: () =>
      Effect.gen(function* () {
        // One D1 round trip. Batched rows come back as objects keyed by
        // column name, so every statement here must select unique names.
        const [
          userRows,
          accountRows,
          deviceRows,
          tokenRows,
          usageRows,
          sourceRows,
          deviceUsageRows,
          deviceSourceRows,
        ] = yield* database.use((db) =>
          db.batch([
            db
              .select({
                avatarUrl: users.avatarUrl,
                createdAt: users.createdAt,
                id: users.id,
                login: users.login,
                name: users.name,
                shadowBannedAt: users.shadowBannedAt,
                shadowBannedByUserId: users.shadowBannedByUserId,
                updatedAt: users.updatedAt,
              })
              .from(users)
              .orderBy(asc(users.login)),
            db
              .select({
                email: userAccounts.email,
                emailVerified: userAccounts.emailVerified,
                login: userAccounts.login,
                provider: userAccounts.provider,
                userId: userAccounts.userId,
              })
              .from(userAccounts)
              .orderBy(asc(userAccounts.provider)),
            db.select().from(devices),
            db
              .select({
                deviceId: cliTokens.deviceId,
                lastUsedAt: cliTokens.lastUsedAt,
                revokedAt: cliTokens.revokedAt,
                userId: cliTokens.userId,
              })
              .from(cliTokens),
            db
              .select({ ...usageSummaryColumns(), userId: usageDays.userId })
              .from(usageDays)
              .groupBy(usageDays.userId),
            db
              .selectDistinct({
                source: usageDays.source,
                userId: usageDays.userId,
              })
              .from(usageDays)
              .orderBy(asc(usageDays.source)),
            db
              .select({
                ...usageSummaryColumns(),
                deviceId: usageDays.deviceId,
                userId: usageDays.userId,
              })
              .from(usageDays)
              .groupBy(usageDays.userId, usageDays.deviceId),
            db
              .selectDistinct({
                deviceId: usageDays.deviceId,
                source: usageDays.source,
                userId: usageDays.userId,
              })
              .from(usageDays)
              .orderBy(asc(usageDays.source)),
          ]),
        );

        const accountsByUser = groupBy(accountRows, (row) => row.userId);
        const devicesByUser = groupBy(deviceRows, (row) => row.userId);
        const tokensByUser = groupBy(tokenRows, (row) => row.userId);
        const usageByUser = new Map(usageRows.map((row) => [row.userId, row]));
        const sourcesByUser = groupBy(sourceRows, (row) => row.userId);
        const deviceUsageByUser = groupBy(deviceUsageRows, (row) => row.userId);
        const sourcesByDevice = groupBy(deviceSourceRows, (row) => row.deviceId);

        return userRows.map((user): AdminUserSnapshot => {
          const usage = usageByUser.get(user.id);

          return {
            accounts: (accountsByUser.get(user.id) ?? []).map(
              ({ userId: _userId, ...account }) => account,
            ),
            devices: (devicesByUser.get(user.id) ?? []).map(toAdminDeviceSnapshot),
            deviceUsage: (deviceUsageByUser.get(user.id) ?? []).map(
              ({ userId: _userId, ...row }) => ({
                ...row,
                sources: (sourcesByDevice.get(row.deviceId) ?? []).map((source) => source.source),
              }),
            ),
            sources: (sourcesByUser.get(user.id) ?? []).map((row) => row.source).sort(),
            shadowBan:
              user.shadowBannedAt === null || user.shadowBannedByUserId === null
                ? null
                : {
                    at: user.shadowBannedAt.toISOString(),
                    byUserId: UserId.make(user.shadowBannedByUserId),
                  },
            tokens: (tokensByUser.get(user.id) ?? []).map((token) => ({
              deviceId: token.deviceId,
              lastUsedAt: token.lastUsedAt?.toISOString() ?? null,
              revokedAt: token.revokedAt?.toISOString() ?? null,
            })),
            usage: {
              activeDays: usage?.activeDays ?? 0,
              lastUsageDate: usage?.lastUsageDate ?? null,
              totalSpendUsd: usage?.totalSpendUsd ?? 0,
              totalTokens: usage?.totalTokens ?? 0,
            },
            user: {
              avatarUrl: user.avatarUrl,
              createdAt: user.createdAt.toISOString(),
              id: user.id,
              login: user.login,
              name: user.name,
              updatedAt: user.updatedAt.toISOString(),
            },
          };
        });
      }),
    setShadowBan: (input) =>
      Effect.gen(function* () {
        const rows = yield* database.use((db) =>
          db
            .update(users)
            .set({
              shadowBannedAt: input.at,
              shadowBannedByUserId: input.byUserId,
              updatedAt: new Date(),
            })
            .where(eq(users.id, input.userId))
            .returning({ id: users.id }),
        );

        return rows.length > 0;
      }),
  });
});

const AdminRepositoryLive = Layer.effect(AdminRepository, makeD1AdminRepository());

const AdminServiceLive = Layer.effect(AdminService, makeAdminService()).pipe(
  Layer.provide(Layer.mergeAll(AdminRepositoryLive, NpmRegistryLive)),
);

/** Admin totals include shadow-banned users' usage: moderation needs the full picture. */
function usageSummaryColumns() {
  return {
    activeDays: usageAggregates.activeDays(),
    lastUsageDate: usageAggregates.lastDate(),
    totalSpendUsd: usageAggregates.spendUsd(),
    totalTokens: usageAggregates.totalTokens(),
  };
}

/** Every device column except the owner, with timestamps as ISO strings. */
function toAdminDeviceSnapshot({
  createdAt,
  id,
  lastCheckInAt,
  lastSyncAt,
  serviceAutoUpdateAttemptedAt,
  serviceAutoUpdateCompletedAt,
  serviceRepairAttemptedAt,
  serviceRepairCompletedAt,
  userId: _userId,
  ...device
}: Device): AdminDeviceSnapshot {
  return {
    ...device,
    createdAt: createdAt.toISOString(),
    id: DeviceId.make(id),
    lastCheckInAt: isoOrNull(lastCheckInAt),
    lastSyncAt: isoOrNull(lastSyncAt),
    serviceAutoUpdateAttemptedAt: isoOrNull(serviceAutoUpdateAttemptedAt),
    serviceAutoUpdateCompletedAt: isoOrNull(serviceAutoUpdateCompletedAt),
    serviceRepairAttemptedAt: isoOrNull(serviceRepairAttemptedAt),
    serviceRepairCompletedAt: isoOrNull(serviceRepairCompletedAt),
  };
}

function isoOrNull(value: Date | null): string | null {
  return value?.toISOString() ?? null;
}

function groupBy<A, K>(values: readonly A[], key: (value: A) => K): Map<K, A[]> {
  const grouped = new Map<K, A[]>();
  for (const value of values) {
    const groupKey = key(value);
    const existing = grouped.get(groupKey);
    if (existing === undefined) {
      grouped.set(groupKey, [value]);
    } else {
      existing.push(value);
    }
  }

  return grouped;
}

export { AdminRepositoryLive, AdminServiceLive };
