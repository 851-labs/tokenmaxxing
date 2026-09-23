import {
  DeviceId,
  type RawUsageReportInput,
  TokenId,
  type UsageDayInput,
  UserId,
} from "@tokenmaxxing/api-contract";
import { Effect, Layer } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { makeTestDatabase, type TestDatabase } from "../testing/sqlite-d1";
import { buildService } from "../testing/effect";
import { makeMemoryBucket, type MemoryBucket } from "../testing/r2";
import { seedUsage } from "../testing/seed";
import { UsageRepositoryLive } from "./d1";
import { makeUsageService, type StoredRawUsageReport, UsageRepository } from "./service";

describe("D1 usage repository", () => {
  let database: TestDatabase;
  let bucket: MemoryBucket;

  beforeEach(() => {
    database = makeTestDatabase();
    bucket = makeMemoryBucket();
  });

  afterEach(() => database.close());

  function makeRepository() {
    return buildService(
      UsageRepository,
      UsageRepositoryLive.pipe(Layer.provide(Layer.merge(database.drizzleLayer, bucket.layer))),
    );
  }

  function usageRows() {
    return database.sqlite
      .prepare(
        `select device_id as deviceId, user_id as userId, date, source, model,
          input_tokens as inputTokens, total_tokens as totalTokens, cost_usd as costUsd,
          synced_at as syncedAt
         from usage_days
         order by device_id, date, source, model`,
      )
      .all();
  }

  describe("pruneChunk", () => {
    it("prunes only older models omitted from covered device/day/source slices", async () => {
      const seed = (deviceId: string, date: string, source: string, model: string, at: number) =>
        seedUsage(database.sqlite, { date, deviceId, model, source, syncedAt: at, userId: "user" });
      seed("device", "2026-07-21", "codex", "keep", 500);
      seed("device", "2026-07-21", "codex", "stale", 500);
      seed("device", "2026-07-21", "codex", "newer", 1_500);
      seed("device", "2026-07-21", "claude", "other-source", 500);
      seed("device", "2026-07-20", "codex", "other-date", 500);
      seed("other-device", "2026-07-21", "codex", "other-device", 500);

      const repository = await makeRepository();
      await Effect.runPromise(
        repository.pruneChunk(
          "device",
          [{ date: "2026-07-21", models: ["keep"], source: "codex" }],
          new Date(1_000),
        ),
      );

      expect(
        database.sqlite
          .prepare(
            `select device_id, date, source, model
             from usage_days
             order by device_id, date, source, model`,
          )
          .all(),
      ).toEqual([
        { date: "2026-07-20", device_id: "device", model: "other-date", source: "codex" },
        { date: "2026-07-21", device_id: "device", model: "other-source", source: "claude" },
        { date: "2026-07-21", device_id: "device", model: "keep", source: "codex" },
        { date: "2026-07-21", device_id: "device", model: "newer", source: "codex" },
        {
          date: "2026-07-21",
          device_id: "other-device",
          model: "other-device",
          source: "codex",
        },
      ]);
    });

    it("removes all older rows when a covered slice contains no models", async () => {
      seedUsage(database.sqlite, {
        date: "2026-07-21",
        deviceId: "device",
        model: "stale-a",
        syncedAt: 500,
        userId: "user",
      });
      seedUsage(database.sqlite, {
        date: "2026-07-21",
        deviceId: "device",
        model: "stale-b",
        syncedAt: 500,
        userId: "user",
      });

      const repository = await makeRepository();
      await Effect.runPromise(
        repository.pruneChunk(
          "device",
          [{ date: "2026-07-21", models: [], source: "codex" }],
          new Date(1_000),
        ),
      );

      expect(database.sqlite.prepare("select model from usage_days").all()).toEqual([]);
    });

    // Regression: `notInArray` bound one parameter per model, so a day with
    // more than ~96 models broke D1's 100-parameter statement limit.
    it("keeps a day's full model list within D1's bound-parameter limit", async () => {
      const models = Array.from({ length: 256 }, (_, index) => `model-${index}`);
      for (const model of [...models, "stale"]) {
        seedUsage(database.sqlite, {
          date: "2026-07-21",
          deviceId: "device",
          model,
          syncedAt: 500,
          userId: "user",
        });
      }

      const repository = await makeRepository();
      await Effect.runPromise(
        repository.pruneChunk(
          "device",
          [{ date: "2026-07-21", models, source: "codex" }],
          new Date(1_000),
        ),
      );

      const remaining = database.sqlite.prepare("select model from usage_days").all();
      expect(remaining).toHaveLength(256);
      expect(remaining).not.toContainEqual({ model: "stale" });
      expect(Math.max(...database.executed.map((query) => query.parameters.length))).toBeLessThan(
        10,
      );
    });
  });

  describe("trailing-window re-sync", () => {
    const identity = {
      deviceId: DeviceId.make("device"),
      tokenId: TokenId.make("token"),
      user: { avatarUrl: null, id: UserId.make("user"), login: "alex", name: null },
    };
    const device = { name: "Mac.localdomain", platform: "darwin" };

    function claudeReport(days: ReadonlyArray<[string, ReadonlyArray<[string, number]>]>) {
      return {
        command: ["ccusage@^20.0.19", "claude", "daily", "--json", "--breakdown"],
        payload: {
          daily: days.map(([date, models]) => ({
            date,
            modelBreakdowns: models.map(([modelName, cost]) => ({
              cost,
              inputTokens: 10,
              modelName,
              outputTokens: 20,
            })),
          })),
        },
        reportKind: "daily",
        source: "claude",
      } satisfies RawUsageReportInput;
    }

    function spendByDeviceDay() {
      return database.sqlite
        .prepare(
          `select device_id as deviceId, date, round(sum(cost_usd), 2) as costUsd,
             count(*) as models
           from usage_days
           group by device_id, date
           order by device_id, date`,
        )
        .all();
    }

    it("corrects re-sent days without touching other devices or days outside the window", async () => {
      seedUsage(database.sqlite, {
        costUsd: 209.07,
        date: "2026-09-15",
        deviceId: "other-device",
        model: "claude-opus-5",
        source: "claude",
        syncedAt: 1,
        userId: "user",
      });
      let clock = Date.parse("2026-09-15T23:40:00.000Z");
      const service = await Effect.runPromise(
        makeUsageService({ now: () => new Date((clock += 60_000)) }).pipe(
          Effect.provide(UsageRepositoryLive),
          Effect.provide(Layer.merge(database.drizzleLayer, bucket.layer)),
        ),
      );

      // Incremental runs on 09-14 and 09-15 while ccusage still dropped a model.
      await Effect.runPromise(
        service.ingestRaw(identity, device, [claudeReport([["2026-09-14", [["opus", 3.57]]]])]),
      );
      await Effect.runPromise(
        service.ingestRaw(identity, device, [
          claudeReport([
            [
              "2026-09-15",
              [
                ["opus", 1.56],
                ["stale", 0.99],
              ],
            ],
          ]),
        ]),
      );

      // A later reconciliation window starts at 09-15 and sees the full day.
      clock = Date.parse("2026-09-22T23:40:00.000Z");
      const window = claudeReport([
        [
          "2026-09-15",
          [
            ["opus", 1.56],
            ["fable", 268.19],
          ],
        ],
        ["2026-09-22", [["fable", 301.76]]],
      ]);
      await Effect.runPromise(service.ingestRaw(identity, device, [window]));
      const afterFirst = spendByDeviceDay();
      await Effect.runPromise(service.ingestRaw(identity, device, [window]));

      expect(afterFirst).toEqual([
        { costUsd: 3.57, date: "2026-09-14", deviceId: "device", models: 1 },
        { costUsd: 269.75, date: "2026-09-15", deviceId: "device", models: 2 },
        { costUsd: 301.76, date: "2026-09-22", deviceId: "device", models: 1 },
        { costUsd: 209.07, date: "2026-09-15", deviceId: "other-device", models: 1 },
      ]);
      expect(spendByDeviceDay()).toEqual(afterFirst);
    });
  });

  describe("upsertChunk", () => {
    const rows: UsageDayInput[] = [
      usageDay({ costUsd: 1.5, date: "2026-07-20", model: "gpt-5", totalTokens: 100 }),
      usageDay({ costUsd: 2.5, date: "2026-07-21", model: "gpt-5", totalTokens: 200 }),
      usageDay({ costUsd: 0.5, date: "2026-07-21", model: "o3", totalTokens: 50 }),
    ];

    it("is idempotent: syncing the same chunk twice leaves the same totals", async () => {
      const repository = await makeRepository();

      await Effect.runPromise(repository.upsertChunk("user", "device", rows, new Date(1_000)));
      const first = totals();
      await Effect.runPromise(repository.upsertChunk("user", "device", rows, new Date(2_000)));

      expect(totals()).toEqual(first);
      expect(first).toEqual({ costUsd: 4.5, rowCount: 3, totalTokens: 350 });
      expect(usageRows().map((row) => row.syncedAt)).toEqual([2_000, 2_000, 2_000]);
    });

    it("replaces a key's values with the latest sync (last write wins)", async () => {
      const repository = await makeRepository();

      await Effect.runPromise(repository.upsertChunk("user", "device", rows, new Date(1_000)));
      await Effect.runPromise(
        repository.upsertChunk(
          "user",
          "device",
          [usageDay({ costUsd: 9, date: "2026-07-21", model: "o3", totalTokens: 900 })],
          new Date(2_000),
        ),
      );

      expect(totals()).toEqual({ costUsd: 13, rowCount: 3, totalTokens: 1_200 });
    });

    it("reassigns the row to the uploading user on conflict", async () => {
      const repository = await makeRepository();

      await Effect.runPromise(repository.upsertChunk("old-owner", "device", rows, new Date(1_000)));
      await Effect.runPromise(repository.upsertChunk("new-owner", "device", rows, new Date(2_000)));

      expect(usageRows().map((row) => row.userId)).toEqual(["new-owner", "new-owner", "new-owner"]);
    });

    it("keys rows by device so two devices never overwrite each other", async () => {
      const repository = await makeRepository();

      await Effect.runPromise(repository.upsertChunk("user", "device-a", rows, new Date(1_000)));
      await Effect.runPromise(repository.upsertChunk("user", "device-b", rows, new Date(1_000)));

      expect(totals()).toEqual({ costUsd: 9, rowCount: 6, totalTokens: 700 });
    });

    it("does nothing for an empty chunk", async () => {
      const repository = await makeRepository();

      await Effect.runPromise(repository.upsertChunk("user", "device", [], new Date(1_000)));

      expect(totals().rowCount).toBe(0);
    });
  });

  describe("upsertSourceStats", () => {
    it("upserts per (device, source), replacing counts and owner", async () => {
      const repository = await makeRepository();

      await Effect.runPromise(
        repository.upsertSourceStats(
          "old-owner",
          "device",
          [
            { sessionCount: 3, source: "codex" },
            { sessionCount: 5, source: "claude" },
          ],
          new Date(1_000),
        ),
      );
      await Effect.runPromise(
        repository.upsertSourceStats(
          "new-owner",
          "device",
          [{ sessionCount: 4, source: "codex" }],
          new Date(2_000),
        ),
      );
      await Effect.runPromise(
        repository.upsertSourceStats(
          "new-owner",
          "other-device",
          [{ sessionCount: 7, source: "codex" }],
          new Date(2_000),
        ),
      );

      expect(
        database.sqlite
          .prepare(
            `select device_id as deviceId, user_id as userId, source,
              session_count as sessionCount, synced_at as syncedAt
             from usage_source_stats order by device_id, source`,
          )
          .all(),
      ).toEqual([
        {
          deviceId: "device",
          sessionCount: 5,
          source: "claude",
          syncedAt: 1_000,
          userId: "old-owner",
        },
        {
          deviceId: "device",
          sessionCount: 4,
          source: "codex",
          syncedAt: 2_000,
          userId: "new-owner",
        },
        {
          deviceId: "other-device",
          sessionCount: 7,
          source: "codex",
          syncedAt: 2_000,
          userId: "new-owner",
        },
      ]);
    });
  });

  describe("upsertRawReports", () => {
    it("stores the payload in R2 and indexes it in D1", async () => {
      const repository = await makeRepository();
      const report = rawReport("hash-a", "users/user/devices/device/ccusage/codex/daily/a.json");

      await Effect.runPromise(
        repository.upsertRawReports("user", "device", [report], new Date(1_000)),
      );

      expect(bucket.objects.get(report.objectKey)).toEqual({
        customMetadata: { payloadBytes: String(report.payloadBytes), payloadHash: "hash-a" },
        value: report.payloadJson,
      });
      expect(rawRows()).toEqual([
        {
          capturedAt: 1_000,
          deviceId: "device",
          id: "device:hash-a",
          objectKey: report.objectKey,
          userId: "user",
        },
      ]);
    });

    it("dedupes a re-ingested payload to one row and one object", async () => {
      const repository = await makeRepository();
      const report = rawReport("hash-a", "users/user/devices/device/ccusage/codex/daily/a.json");

      await Effect.runPromise(
        repository.upsertRawReports("user", "device", [report], new Date(1_000)),
      );
      await Effect.runPromise(
        repository.upsertRawReports("user", "device", [report], new Date(2_000)),
      );

      expect(bucket.puts).toEqual([report.objectKey]);
      expect([...bucket.objects.keys()]).toEqual([report.objectKey]);
      expect(rawRows()).toEqual([
        {
          capturedAt: 2_000,
          deviceId: "device",
          id: "device:hash-a",
          objectKey: report.objectKey,
          userId: "user",
        },
      ]);
    });

    it("keeps the original object when a re-homed device re-ingests a payload", async () => {
      const repository = await makeRepository();
      const firstKey = "users/old-owner/devices/device/ccusage/codex/daily/a.json";
      const secondKey = "users/new-owner/devices/device/ccusage/codex/daily/a.json";

      await Effect.runPromise(
        repository.upsertRawReports(
          "old-owner",
          "device",
          [rawReport("hash-a", firstKey)],
          new Date(1_000),
        ),
      );
      await Effect.runPromise(
        repository.upsertRawReports(
          "new-owner",
          "device",
          [rawReport("hash-a", secondKey)],
          new Date(2_000),
        ),
      );

      expect([...bucket.objects.keys()]).toEqual([firstKey]);
      expect(rawRows()).toEqual([
        {
          capturedAt: 2_000,
          deviceId: "device",
          id: "device:hash-a",
          objectKey: firstKey,
          userId: "new-owner",
        },
      ]);
    });

    it("looks up existing reports across D1's bound-parameter limit", async () => {
      const repository = await makeRepository();
      const reports = Array.from({ length: 95 }, (_, index) =>
        rawReport(`hash-${index}`, `objects/${index}.json`),
      );

      await Effect.runPromise(
        repository.upsertRawReports("user", "device", reports, new Date(1_000)),
      );
      await Effect.runPromise(
        repository.upsertRawReports("user", "device", reports, new Date(2_000)),
      );

      expect(bucket.puts).toHaveLength(95);
      expect(rawRows()).toHaveLength(95);
    });
  });

  function totals() {
    return database.sqlite
      .prepare(
        `select count(*) as rowCount, sum(total_tokens) as totalTokens, sum(cost_usd) as costUsd
         from usage_days`,
      )
      .get() as { costUsd: number | null; rowCount: number; totalTokens: number | null };
  }

  function rawRows() {
    return database.sqlite
      .prepare(
        `select id, user_id as userId, device_id as deviceId, object_key as objectKey,
          captured_at as capturedAt
         from usage_raw_batches order by id`,
      )
      .all();
  }
});

function usageDay(
  overrides: Pick<UsageDayInput, "costUsd" | "date" | "model" | "totalTokens">,
): UsageDayInput {
  return {
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    inputTokens: overrides.totalTokens,
    outputTokens: 0,
    source: "codex",
    ...overrides,
  };
}

function rawReport(payloadHash: string, objectKey: string): StoredRawUsageReport {
  const payloadJson = JSON.stringify({ daily: [], hash: payloadHash });

  return {
    ccusageCommand: "ccusage codex daily --json",
    id: `device:${payloadHash}`,
    objectKey,
    parserVersion: "test",
    payloadBytes: payloadJson.length,
    payloadHash,
    payloadJson,
    processedAt: new Date(1_000),
    reportKind: "daily",
    source: "codex",
  };
}
