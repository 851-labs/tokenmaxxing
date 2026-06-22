import { cliTokens, devices, usageDays, userAccounts, users } from "@tokenmaxxing/db";
import { and, asc, eq, sql } from "drizzle-orm";
import { Effect } from "effect";
import { Layer } from "effect";

import type { OAuthProviderId } from "@tokenmaxxing/api-contract";

import { Drizzle } from "../database";
import { AdminRepository, type AdminUserSnapshot } from "./service";

const makeD1AdminRepository = Effect.fn("makeD1AdminRepository")(function* () {
  const database = yield* Drizzle;

  return AdminRepository.of({
    hasVerifiedEmail: (userId, email) =>
      Effect.gen(function* () {
        const rows = yield* database.use((db) =>
          db
            .select({ userId: userAccounts.userId })
            .from(userAccounts)
            .where(
              and(
                eq(userAccounts.userId, userId),
                eq(userAccounts.email, email),
                eq(userAccounts.emailVerified, true),
              ),
            )
            .limit(1),
        );

        return rows.length > 0;
      }),
    listUserSnapshots: () =>
      Effect.gen(function* () {
        const userRows = yield* database.use((db) =>
          db
            .select({
              avatarUrl: users.avatarUrl,
              createdAt: users.createdAt,
              id: users.id,
              login: users.login,
              name: users.name,
              updatedAt: users.updatedAt,
            })
            .from(users)
            .orderBy(asc(users.login)),
        );
        const accountRows = yield* database.use((db) =>
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
        );
        const deviceRows = yield* database.use((db) =>
          db
            .select({
              arch: devices.arch,
              createdAt: devices.createdAt,
              id: devices.id,
              lastCheckInAt: devices.lastCheckInAt,
              lastSyncAt: devices.lastSyncAt,
              name: devices.name,
              platform: devices.platform,
              serviceAutoUpdateAttemptedAt: devices.serviceAutoUpdateAttemptedAt,
              serviceAutoUpdateCompletedAt: devices.serviceAutoUpdateCompletedAt,
              serviceAutoUpdateCurrentVersion: devices.serviceAutoUpdateCurrentVersion,
              serviceAutoUpdateEnabled: devices.serviceAutoUpdateEnabled,
              serviceAutoUpdateError: devices.serviceAutoUpdateError,
              serviceAutoUpdateInstalledVersion: devices.serviceAutoUpdateInstalledVersion,
              serviceAutoUpdateLatestVersion: devices.serviceAutoUpdateLatestVersion,
              serviceAutoUpdateManager: devices.serviceAutoUpdateManager,
              serviceAutoUpdateReason: devices.serviceAutoUpdateReason,
              serviceAutoUpdateStatus: devices.serviceAutoUpdateStatus,
              serviceBackend: devices.serviceBackend,
              serviceError: devices.serviceError,
              serviceReloadRequired: devices.serviceReloadRequired,
              serviceRepairAttemptedAt: devices.serviceRepairAttemptedAt,
              serviceRepairCompletedAt: devices.serviceRepairCompletedAt,
              serviceRepairError: devices.serviceRepairError,
              serviceRepairReason: devices.serviceRepairReason,
              serviceRepairStatus: devices.serviceRepairStatus,
              serviceRunnerTarget: devices.serviceRunnerTarget,
              serviceRunnerVersion: devices.serviceRunnerVersion,
              serviceSchedulerActive: devices.serviceSchedulerActive,
              serviceStatus: devices.serviceStatus,
              serviceTemplateVersion: devices.serviceTemplateVersion,
              userId: devices.userId,
              version: devices.version,
            })
            .from(devices),
        );
        const tokenRows = yield* database.use((db) =>
          db
            .select({
              deviceId: cliTokens.deviceId,
              lastUsedAt: cliTokens.lastUsedAt,
              revokedAt: cliTokens.revokedAt,
              userId: cliTokens.userId,
            })
            .from(cliTokens),
        );
        const usageRows = yield* database.use((db) =>
          db
            .select({
              activeDays: sql<number>`count(distinct ${usageDays.date})`,
              lastUsageDate: sql<string | null>`max(${usageDays.date})`,
              totalSpendUsd: sql<number | null>`sum(${usageDays.costUsd})`,
              totalTokens: sql<number | null>`sum(${usageDays.totalTokens})`,
              userId: usageDays.userId,
            })
            .from(usageDays)
            .groupBy(usageDays.userId),
        );
        const sourceRows = yield* database.use((db) =>
          db
            .selectDistinct({
              source: usageDays.source,
              userId: usageDays.userId,
            })
            .from(usageDays)
            .orderBy(asc(usageDays.source)),
        );
        const deviceUsageRows = yield* database.use((db) =>
          db
            .select({
              activeDays: sql<number>`count(distinct ${usageDays.date})`,
              deviceId: usageDays.deviceId,
              lastUsageDate: sql<string | null>`max(${usageDays.date})`,
              totalSpendUsd: sql<number | null>`sum(${usageDays.costUsd})`,
              totalTokens: sql<number | null>`sum(${usageDays.totalTokens})`,
              userId: usageDays.userId,
            })
            .from(usageDays)
            .groupBy(usageDays.userId, usageDays.deviceId),
        );
        const deviceSourceRows = yield* database.use((db) =>
          db
            .selectDistinct({
              deviceId: usageDays.deviceId,
              source: usageDays.source,
              userId: usageDays.userId,
            })
            .from(usageDays)
            .orderBy(asc(usageDays.source)),
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
            accounts: (accountsByUser.get(user.id) ?? []).map((account) => ({
              email: account.email,
              emailVerified: account.emailVerified,
              login: account.login,
              provider: account.provider as OAuthProviderId,
            })),
            devices: (devicesByUser.get(user.id) ?? []).map((device) => ({
              arch: device.arch,
              createdAt: device.createdAt.toISOString(),
              id: device.id,
              lastCheckInAt: device.lastCheckInAt?.toISOString() ?? null,
              lastSyncAt: device.lastSyncAt?.toISOString() ?? null,
              name: device.name,
              platform: device.platform,
              serviceAutoUpdateAttemptedAt:
                device.serviceAutoUpdateAttemptedAt?.toISOString() ?? null,
              serviceAutoUpdateCompletedAt:
                device.serviceAutoUpdateCompletedAt?.toISOString() ?? null,
              serviceAutoUpdateCurrentVersion: device.serviceAutoUpdateCurrentVersion,
              serviceAutoUpdateEnabled: device.serviceAutoUpdateEnabled,
              serviceAutoUpdateError: device.serviceAutoUpdateError,
              serviceAutoUpdateInstalledVersion: device.serviceAutoUpdateInstalledVersion,
              serviceAutoUpdateLatestVersion: device.serviceAutoUpdateLatestVersion,
              serviceAutoUpdateManager:
                device.serviceAutoUpdateManager as AdminUserSnapshot["devices"][number]["serviceAutoUpdateManager"],
              serviceAutoUpdateReason:
                device.serviceAutoUpdateReason as AdminUserSnapshot["devices"][number]["serviceAutoUpdateReason"],
              serviceAutoUpdateStatus:
                device.serviceAutoUpdateStatus as AdminUserSnapshot["devices"][number]["serviceAutoUpdateStatus"],
              serviceBackend: device.serviceBackend,
              serviceError: device.serviceError,
              serviceReloadRequired: device.serviceReloadRequired,
              serviceRepairAttemptedAt: device.serviceRepairAttemptedAt?.toISOString() ?? null,
              serviceRepairCompletedAt: device.serviceRepairCompletedAt?.toISOString() ?? null,
              serviceRepairError: device.serviceRepairError,
              serviceRepairReason:
                device.serviceRepairReason as AdminUserSnapshot["devices"][number]["serviceRepairReason"],
              serviceRepairStatus:
                device.serviceRepairStatus as AdminUserSnapshot["devices"][number]["serviceRepairStatus"],
              serviceRunnerTarget: device.serviceRunnerTarget,
              serviceRunnerVersion: device.serviceRunnerVersion,
              serviceSchedulerActive: device.serviceSchedulerActive,
              serviceStatus:
                device.serviceStatus as AdminUserSnapshot["devices"][number]["serviceStatus"],
              serviceTemplateVersion: device.serviceTemplateVersion,
              version: device.version,
            })),
            deviceUsage: (deviceUsageByUser.get(user.id) ?? []).map((row) => ({
              activeDays: row.activeDays,
              deviceId: row.deviceId,
              lastUsageDate: row.lastUsageDate ?? null,
              sources: (sourcesByDevice.get(row.deviceId) ?? []).map((source) => source.source),
              totalSpendUsd: row.totalSpendUsd ?? 0,
              totalTokens: row.totalTokens ?? 0,
            })),
            sources: (sourcesByUser.get(user.id) ?? []).map((row) => row.source).sort(),
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
  });
});

const AdminRepositoryLive = Layer.effect(AdminRepository, makeD1AdminRepository());

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

export { AdminRepositoryLive };
