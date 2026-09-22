import {
  devices,
  usageDays,
  usageRawBatches,
  usageSourceStats,
  type NewDevice,
} from "@tokenmaxxing/db";
import { and, eq, inArray, lt, notInArray } from "drizzle-orm";
import { Effect, Layer } from "effect";

import { batchNonEmpty, Drizzle } from "../database";
import { RawUsageObjectStore } from "./raw-store";
import {
  makeUsageService,
  UsageRepository,
  UsageService,
  type UsageDevice,
  type UsageServiceCheckIn,
} from "./service";

const makeD1UsageRepository = Effect.fn("makeD1UsageRepository")(function* () {
  const database = yield* Drizzle;
  const rawStore = yield* RawUsageObjectStore;

  return UsageRepository.of({
    checkInDevice: (deviceId, device, service, checkedInAt) =>
      Effect.gen(function* () {
        yield* database.use((db) =>
          db
            .update(devices)
            .set(checkInColumns(device, service, checkedInAt))
            .where(eq(devices.id, deviceId)),
        );
      }),
    upsertChunk: (userId, deviceId, rows, syncedAt) =>
      Effect.gen(function* () {
        if (rows.length === 0) {
          return;
        }

        yield* database.use((db) => {
          const statements = rows.map((row) =>
            db
              .insert(usageDays)
              .values({
                deviceId,
                userId,
                date: row.date,
                source: row.source,
                model: row.model,
                inputTokens: row.inputTokens,
                outputTokens: row.outputTokens,
                cacheCreationTokens: row.cacheCreationTokens,
                cacheReadTokens: row.cacheReadTokens,
                totalTokens: row.totalTokens,
                costUsd: row.costUsd,
                syncedAt,
              })
              .onConflictDoUpdate({
                target: [usageDays.deviceId, usageDays.date, usageDays.source, usageDays.model],
                set: {
                  userId,
                  inputTokens: row.inputTokens,
                  outputTokens: row.outputTokens,
                  cacheCreationTokens: row.cacheCreationTokens,
                  cacheReadTokens: row.cacheReadTokens,
                  totalTokens: row.totalTokens,
                  costUsd: row.costUsd,
                  syncedAt,
                },
              }),
          );
          return batchNonEmpty(db, statements);
        });
      }),
    pruneChunk: (deviceId, scopes, syncedAt) =>
      Effect.gen(function* () {
        if (scopes.length === 0) {
          return;
        }

        yield* database.use((db) => {
          const statements = scopes.map((scope) =>
            db
              .delete(usageDays)
              .where(
                and(
                  eq(usageDays.deviceId, deviceId),
                  eq(usageDays.date, scope.date),
                  eq(usageDays.source, scope.source),
                  lt(usageDays.syncedAt, syncedAt),
                  ...(scope.models.length === 0
                    ? []
                    : [notInArray(usageDays.model, [...scope.models])]),
                ),
              ),
          );
          return batchNonEmpty(db, statements);
        });
      }),
    touchDevice: (deviceId, device, syncedAt) =>
      Effect.gen(function* () {
        yield* database.use((db) =>
          db
            .update(devices)
            .set({
              arch: device.arch ?? null,
              lastSyncAt: syncedAt,
              name: device.name,
              platform: device.platform,
              version: device.version ?? null,
            })
            .where(eq(devices.id, deviceId)),
        );
      }),
    upsertSourceStats: (userId, deviceId, stats, syncedAt) =>
      Effect.gen(function* () {
        if (stats.length === 0) {
          return;
        }

        yield* database.use((db) => {
          const statements = stats.map((stat) =>
            db
              .insert(usageSourceStats)
              .values({
                deviceId,
                userId,
                source: stat.source,
                sessionCount: stat.sessionCount,
                syncedAt,
              })
              .onConflictDoUpdate({
                target: [usageSourceStats.deviceId, usageSourceStats.source],
                set: {
                  userId,
                  sessionCount: stat.sessionCount,
                  syncedAt,
                },
              }),
          );
          return batchNonEmpty(db, statements);
        });
      }),
    upsertRawReports: (userId, deviceId, reports, capturedAt) =>
      Effect.gen(function* () {
        if (reports.length === 0) {
          return;
        }

        // A re-ingested payload keeps its first object: the id pins device +
        // payload hash, so the content is identical, while the key embeds the
        // owner at first ingest — rewriting it after the device changed hands
        // would strand the original object with no row pointing at it.
        const storedKeys = new Map<string, string>();
        for (let offset = 0; offset < reports.length; offset += ID_LOOKUP_CHUNK_SIZE) {
          const ids = reports
            .slice(offset, offset + ID_LOOKUP_CHUNK_SIZE)
            .map((report) => report.id);
          const rows = yield* database.use((db) =>
            db
              .select({ id: usageRawBatches.id, objectKey: usageRawBatches.objectKey })
              .from(usageRawBatches)
              .where(inArray(usageRawBatches.id, ids)),
          );
          for (const row of rows) {
            storedKeys.set(row.id, row.objectKey);
          }
        }
        const pending = reports.map((report) => ({
          ...report,
          objectKey: storedKeys.get(report.id) ?? report.objectKey,
        }));

        for (const report of reports.filter((report) => !storedKeys.has(report.id))) {
          yield* rawStore.putObject({
            key: report.objectKey,
            payloadBytes: report.payloadBytes,
            payloadHash: report.payloadHash,
            payloadJson: report.payloadJson,
          });
        }

        yield* database.use((db) => {
          const statements = pending.map((report) =>
            db
              .insert(usageRawBatches)
              .values({
                id: report.id,
                userId,
                deviceId,
                source: report.source,
                reportKind: report.reportKind,
                ccusageCommand: report.ccusageCommand,
                payloadHash: report.payloadHash,
                objectKey: report.objectKey,
                payloadBytes: report.payloadBytes,
                capturedAt,
                processedAt: report.processedAt,
                parserVersion: report.parserVersion,
              })
              .onConflictDoUpdate({
                target: usageRawBatches.id,
                set: {
                  userId,
                  source: report.source,
                  reportKind: report.reportKind,
                  ccusageCommand: report.ccusageCommand,
                  payloadHash: report.payloadHash,
                  objectKey: report.objectKey,
                  payloadBytes: report.payloadBytes,
                  capturedAt,
                  processedAt: report.processedAt,
                  parserVersion: report.parserVersion,
                },
              }),
          );
          return batchNonEmpty(db, statements);
        });
      }),
  });
});

/** D1 caps bound parameters at 100 per statement. */
const ID_LOOKUP_CHUNK_SIZE = 90;

const UsageRepositoryLive = Layer.effect(UsageRepository, makeD1UsageRepository());

const UsageServiceLive = Layer.effect(UsageService, makeUsageService()).pipe(
  Layer.provide(UsageRepositoryLive),
);

/** Device columns written on each check-in: identity plus service telemetry. */
function checkInColumns(
  device: UsageDevice,
  service: UsageServiceCheckIn,
  checkedInAt: Date,
): Partial<NewDevice> {
  return {
    arch: device.arch ?? null,
    lastCheckInAt: checkedInAt,
    name: device.name,
    platform: device.platform,
    ...(service.autoUpdate === undefined
      ? {}
      : {
          serviceAutoUpdateAttemptedAt: optionalDate(service.autoUpdate.attemptedAt),
          serviceAutoUpdateCompletedAt: optionalDate(service.autoUpdate.completedAt),
          serviceAutoUpdateCurrentVersion: service.autoUpdate.currentVersion ?? null,
          serviceAutoUpdateEnabled: service.autoUpdate.enabled,
          serviceAutoUpdateError: service.autoUpdate.error ?? null,
          serviceAutoUpdateInstalledVersion: service.autoUpdate.installedVersion ?? null,
          serviceAutoUpdateLatestVersion: service.autoUpdate.latestVersion ?? null,
          serviceAutoUpdateManager: service.autoUpdate.manager,
          serviceAutoUpdateReason: service.autoUpdate.reason,
          serviceAutoUpdateStatus: service.autoUpdate.status,
        }),
    serviceBackend: service.backend ?? null,
    serviceError: service.error ?? null,
    serviceReloadRequired: service.reloadRequired ?? null,
    serviceRepairAttemptedAt: optionalDate(service.repairAttemptedAt),
    serviceRepairCompletedAt: optionalDate(service.repairCompletedAt),
    serviceRepairError: service.repairError ?? null,
    serviceRepairReason: service.repairReason ?? null,
    serviceRepairStatus: service.repairStatus ?? null,
    serviceRunnerTarget: service.runnerTarget ?? null,
    serviceRunnerVersion: service.runnerVersion ?? null,
    serviceSchedulerActive: service.schedulerActive ?? null,
    serviceStatus: service.status,
    serviceTemplateVersion: service.templateVersion ?? null,
    version: device.version ?? null,
  };
}

function optionalDate(value: string | null | undefined): Date | null {
  if (value === undefined || value === null) {
    return null;
  }

  const date = new Date(value);

  return Number.isFinite(date.getTime()) ? date : null;
}

export { UsageRepositoryLive, UsageServiceLive };
