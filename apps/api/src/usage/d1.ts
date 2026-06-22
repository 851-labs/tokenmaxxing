import { devices, usageDays, usageRawBatches, usageSourceStats } from "@tokenmaxxing/db";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { Layer } from "effect";

import { Drizzle } from "../database";
import { RawUsageObjectStore } from "./raw-store";
import { UsageRepository } from "./service";

const makeD1UsageRepository = Effect.fn("makeD1UsageRepository")(function* () {
  const database = yield* Drizzle;
  const rawStore = yield* RawUsageObjectStore;

  return UsageRepository.of({
    checkInDevice: (deviceId, device, service, checkedInAt) =>
      Effect.gen(function* () {
        yield* database.use((db) =>
          db
            .update(devices)
            .set({
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
            })
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
          const [first, ...rest] = statements;

          return db.batch([first!, ...rest]);
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
          const [first, ...rest] = statements;

          return db.batch([first!, ...rest]);
        });
      }),
    upsertRawReports: (userId, deviceId, reports, capturedAt) =>
      Effect.gen(function* () {
        if (reports.length === 0) {
          return;
        }

        for (const report of reports) {
          yield* rawStore.putObject({
            key: report.objectKey,
            payloadBytes: report.payloadBytes,
            payloadHash: report.payloadHash,
            payloadJson: report.payloadJson,
          });
        }

        yield* database.use((db) => {
          const statements = reports.map((report) =>
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
          const [first, ...rest] = statements;

          return db.batch([first!, ...rest]);
        });
      }),
  });
});

const UsageRepositoryLive = Layer.effect(UsageRepository, makeD1UsageRepository());

function optionalDate(value: string | null | undefined): Date | null {
  if (value === undefined || value === null) {
    return null;
  }

  const date = new Date(value);

  return Number.isFinite(date.getTime()) ? date : null;
}

export { UsageRepositoryLive };
