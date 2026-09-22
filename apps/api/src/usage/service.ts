import { Context, Effect } from "effect";

import { DeviceMissing } from "@tokenmaxxing/api-contract";
import type {
  CliIdentity,
  RawUsageReportInput,
  SourceUsageStatsInput,
  SyncUsageResponse,
  UsageCheckInInput,
  UsageDayInput,
  UsageSource,
} from "@tokenmaxxing/api-contract";

import { sha256Hex } from "../auth/crypto";
import type { DatabaseError } from "../database";
import { latestUsageDateKey } from "../date-keys";
import {
  parseRawUsageReports,
  PARSER_VERSION,
  type CoveredUsageDay,
  type PersistableDailyReport,
} from "./ccusage";
import { normalizeUsageDays } from "./models";
import type { RawUsageStorageError } from "./raw-store";

/**
 * Usage ingestion: normalized daily reports are stored first, then current
 * structured rows and aggregate source stats are upserted idempotently.
 * Legacy session reports are counted in memory and never persisted. The
 * deviceId always comes from the presenting token, so payloads cannot write
 * into another device's history. Days later than UTC today + 1 are dropped
 * (not rejected): a skewed device clock should not block its real history.
 */

type SyncResult = typeof SyncUsageResponse.Type;

type UsageDevice = (typeof UsageCheckInInput.Type)["device"];

type UsageServiceCheckIn = (typeof UsageCheckInInput.Type)["service"];

interface StoredRawUsageReport {
  ccusageCommand: string;
  id: string;
  objectKey: string;
  parserVersion: string;
  payloadBytes: number;
  payloadHash: string;
  payloadJson: string;
  processedAt: Date;
  reportKind: "daily";
  source: string;
}

interface UsageServiceShape {
  checkIn(
    identity: typeof CliIdentity.Type,
    device: UsageDevice,
    service: UsageServiceCheckIn,
  ): Effect.Effect<{ checkedInAt: string }, DeviceMissing>;
  ingestRaw(
    identity: typeof CliIdentity.Type,
    device: UsageDevice,
    reports: readonly RawUsageReportInput[],
    sourceStats?: readonly SourceUsageStatsInput[],
  ): Effect.Effect<SyncResult, DeviceMissing>;
  syncBatch(
    identity: typeof CliIdentity.Type,
    device: UsageDevice,
    days: readonly UsageDayInput[],
    sourceStats?: readonly SourceUsageStatsInput[],
  ): Effect.Effect<SyncResult, DeviceMissing>;
}

interface UsageReplacementScope {
  date: string;
  models: readonly string[];
  source: UsageSource;
}

interface UsageRepositoryShape {
  checkInDevice(
    deviceId: string,
    device: UsageDevice,
    service: UsageServiceCheckIn,
    checkedInAt: Date,
  ): Effect.Effect<void, DatabaseError>;
  /** One db.batch of single-row upserts (D1 binds ~100 params/statement). */
  upsertChunk(
    userId: string,
    deviceId: string,
    rows: readonly UsageDayInput[],
    syncedAt: Date,
  ): Effect.Effect<void, DatabaseError>;
  /** Removes models omitted by an authoritative raw daily report. */
  pruneChunk(
    deviceId: string,
    scopes: readonly UsageReplacementScope[],
    syncedAt: Date,
  ): Effect.Effect<void, DatabaseError>;
  touchDevice(
    deviceId: string,
    device: UsageDevice,
    syncedAt: Date,
  ): Effect.Effect<void, DatabaseError>;
  upsertSourceStats(
    userId: string,
    deviceId: string,
    stats: readonly SourceUsageStatsInput[],
    syncedAt: Date,
  ): Effect.Effect<void, DatabaseError>;
  upsertRawReports(
    userId: string,
    deviceId: string,
    reports: readonly StoredRawUsageReport[],
    capturedAt: Date,
  ): Effect.Effect<void, DatabaseError | RawUsageStorageError>;
}

class UsageService extends Context.Service<UsageService, UsageServiceShape>()(
  "@tokenmaxxing/api/UsageService",
) {}

class UsageRepository extends Context.Service<UsageRepository, UsageRepositoryShape>()(
  "@tokenmaxxing/api/UsageRepository",
) {}

const UPSERT_CHUNK_SIZE = 40;

const makeUsageService = Effect.fn("makeUsageService")(function* (
  options: { now?: () => Date } = {},
) {
  const repository = yield* UsageRepository;
  const now = options.now ?? (() => new Date());

  return UsageService.of({
    checkIn: Effect.fn("UsageService.checkIn")(function* (identity, device, service) {
      const deviceId = yield* requireDeviceId(identity);
      const checkedInAt = now();
      yield* repository.checkInDevice(deviceId, device, service, checkedInAt).pipe(Effect.orDie);

      return {
        checkedInAt: checkedInAt.toISOString(),
      };
    }),
    ingestRaw: Effect.fn("UsageService.ingestRaw")(function* (
      identity,
      device,
      reports,
      sourceStats = [],
    ) {
      const deviceId = yield* requireDeviceId(identity);
      const syncedAt = now();
      const parsed = yield* parseRawUsageReports(reports, {
        latestDate: latestUsageDateKey(syncedAt),
      });
      const rawReports = yield* prepareRawReports(
        identity.user.id,
        deviceId,
        parsed.persistableReports,
        syncedAt,
      );

      yield* repository
        .upsertRawReports(identity.user.id, deviceId, rawReports, syncedAt)
        .pipe(Effect.orDie);

      const upserted = yield* writeStructuredUsage(
        repository,
        identity.user.id,
        deviceId,
        device,
        parsed.rows,
        mergeSourceStats(parsed.sourceStats, sourceStats),
        syncedAt,
        parsed.coveredDays,
      );

      return {
        received: reports.length,
        syncedAt: syncedAt.toISOString(),
        upserted,
      };
    }),
    syncBatch: Effect.fn("UsageService.syncBatch")(function* (
      identity,
      device,
      days,
      sourceStats = [],
    ) {
      const deviceId = yield* requireDeviceId(identity);
      const syncedAt = now();
      const latestDate = latestUsageDateKey(syncedAt);

      const upserted = yield* writeStructuredUsage(
        repository,
        identity.user.id,
        deviceId,
        device,
        days.filter((day) => day.date <= latestDate),
        sourceStats,
        syncedAt,
      );

      return {
        received: days.length,
        syncedAt: syncedAt.toISOString(),
        upserted,
      };
    }),
  });
});

function requireDeviceId(identity: typeof CliIdentity.Type): Effect.Effect<string, DeviceMissing> {
  const deviceId = identity.deviceId;
  if (deviceId !== null) {
    return Effect.succeed(deviceId);
  }

  return Effect.fail(
    new DeviceMissing({
      message: "This token has no device; run `tokenmaxxing login` to mint a new one.",
    }),
  );
}

function prepareRawReports(
  userId: string,
  deviceId: string,
  reports: readonly PersistableDailyReport[],
  processedAt: Date,
): Effect.Effect<StoredRawUsageReport[]> {
  return Effect.forEach(reports, (report) =>
    Effect.gen(function* () {
      const payloadJson = JSON.stringify(report.payload) ?? "null";
      const ccusageCommand = report.command.join(" ");
      const payloadHash = yield* sha256Hex(
        `${report.source}\n${report.reportKind}\n${ccusageCommand}\n${payloadJson}`,
      );

      return {
        ccusageCommand,
        id: `${deviceId}:${payloadHash}`,
        objectKey: rawReportObjectKey({
          deviceId,
          payloadHash,
          reportKind: report.reportKind,
          source: report.source,
          userId,
        }),
        parserVersion: PARSER_VERSION,
        payloadBytes: textEncoder.encode(payloadJson).byteLength,
        payloadHash,
        payloadJson,
        processedAt,
        reportKind: report.reportKind,
        source: report.source,
      };
    }),
  );
}

function rawReportObjectKey(input: {
  deviceId: string;
  payloadHash: string;
  reportKind: "daily";
  source: string;
  userId: string;
}): string {
  return [
    "users",
    encodeKeyPart(input.userId),
    "devices",
    encodeKeyPart(input.deviceId),
    "ccusage",
    encodeKeyPart(input.source),
    input.reportKind,
    `${input.payloadHash}.json`,
  ].join("/");
}

function encodeKeyPart(value: string): string {
  return encodeURIComponent(value);
}

function mergeSourceStats(
  legacyStats: readonly SourceUsageStatsInput[],
  explicitStats: readonly SourceUsageStatsInput[],
): SourceUsageStatsInput[] {
  const merged = new Map<UsageSource, SourceUsageStatsInput>();
  for (const stat of legacyStats) {
    merged.set(stat.source, stat);
  }
  for (const stat of explicitStats) {
    merged.set(stat.source, stat);
  }

  return [...merged.values()];
}

function writeStructuredUsage(
  repository: UsageRepositoryShape,
  userId: string,
  deviceId: string,
  device: UsageDevice,
  days: readonly UsageDayInput[],
  sourceStats: readonly SourceUsageStatsInput[],
  syncedAt: Date,
  coveredDays: readonly CoveredUsageDay[] = [],
) {
  return Effect.gen(function* () {
    const normalizedDays = normalizeUsageDays(days);
    for (let offset = 0; offset < normalizedDays.length; offset += UPSERT_CHUNK_SIZE) {
      yield* repository
        .upsertChunk(
          userId,
          deviceId,
          normalizedDays.slice(offset, offset + UPSERT_CHUNK_SIZE),
          syncedAt,
        )
        .pipe(Effect.orDie);
    }
    const replacementScopes = buildReplacementScopes(coveredDays, normalizedDays);
    for (let offset = 0; offset < replacementScopes.length; offset += UPSERT_CHUNK_SIZE) {
      yield* repository
        .pruneChunk(deviceId, replacementScopes.slice(offset, offset + UPSERT_CHUNK_SIZE), syncedAt)
        .pipe(Effect.orDie);
    }
    yield* repository.upsertSourceStats(userId, deviceId, sourceStats, syncedAt).pipe(Effect.orDie);
    yield* repository.touchDevice(deviceId, device, syncedAt).pipe(Effect.orDie);

    return normalizedDays.length;
  });
}

function buildReplacementScopes(
  coveredDays: readonly CoveredUsageDay[],
  normalizedDays: readonly UsageDayInput[],
): UsageReplacementScope[] {
  const scopes = new Map<string, { date: string; models: Set<string>; source: UsageSource }>();
  for (const coveredDay of coveredDays) {
    scopes.set(JSON.stringify([coveredDay.date, coveredDay.source]), {
      date: coveredDay.date,
      models: new Set(),
      source: coveredDay.source,
    });
  }
  for (const day of normalizedDays) {
    scopes.get(JSON.stringify([day.date, day.source]))?.models.add(day.model);
  }

  return [...scopes.values()].map((scope) => ({
    date: scope.date,
    models: [...scope.models].sort(),
    source: scope.source,
  }));
}

const textEncoder = new TextEncoder();

export { makeUsageService, UsageRepository, UsageService };

export type { StoredRawUsageReport, UsageReplacementScope, UsageRepositoryShape };
