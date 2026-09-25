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

  describe("cost freeze across re-syncs", () => {
    const identity = {
      deviceId: DeviceId.make("device"),
      tokenId: TokenId.make("token"),
      user: { avatarUrl: null, id: UserId.make("user"), login: "alex", name: null },
    };
    const device = { name: "Mac.localdomain", platform: "darwin" };
    // 2026-05-06 in prod: identical tokens, priced Fast in July and Standard
    // after the user's Codex config went back to the default tier.
    const gpt55Tokens = {
      cacheReadTokens: 316_000_000,
      inputTokens: 18_500_000,
      outputTokens: 807_056,
      totalTokens: 335_307_056,
    };

    function codexReport(days: ReadonlyArray<[string, number, Record<string, object>]>) {
      return {
        command: ["ccusage@^20.0.19", "codex", "daily", "--json", "--breakdown"],
        payload: {
          daily: days.map(([date, costUSD, models]) => ({ costUSD, date, models })),
        },
        reportKind: "daily",
        source: "codex",
      } satisfies RawUsageReportInput;
    }

    async function makeService(at: string) {
      let clock = Date.parse(at);
      return Effect.runPromise(
        makeUsageService({ now: () => new Date((clock += 60_000)) }).pipe(
          Effect.provide(UsageRepositoryLive),
          Effect.provide(Layer.merge(database.drizzleLayer, bucket.layer)),
        ),
      );
    }

    function costs() {
      return database.sqlite
        .prepare(
          `select date, model, total_tokens as totalTokens, cost_usd as costUsd
           from usage_days order by date, model`,
        )
        .all();
    }

    it("keeps a Fast-priced gpt-5.5 day when a later upload re-prices it as Standard", async () => {
      const july = await makeService("2026-07-10T12:00:00.000Z");
      await Effect.runPromise(
        july.ingestRaw(identity, device, [
          codexReport([["2026-05-06", 753.12, { "gpt-5.5": gpt55Tokens }]]),
        ]),
      );

      const september = await makeService("2026-09-23T12:00:00.000Z");
      const repriced = codexReport([["2026-05-06", 301.25, { "gpt-5.5": gpt55Tokens }]]);
      await Effect.runPromise(september.ingestRaw(identity, device, [repriced]));

      expect(costs()).toEqual([
        { costUsd: 753.12, date: "2026-05-06", model: "gpt-5.5", totalTokens: 335_307_056 },
      ]);
      // The raw payload still records exactly what the client sent.
      const objects = [...bucket.objects.values()].map((object) => object.value);
      expect(objects).toHaveLength(2);
      expect(objects).toContain(JSON.stringify(repriced.payload));
    });

    it("takes the new cost when a re-sent day carries more usage", async () => {
      const first = await makeService("2026-05-06T12:00:00.000Z");
      await Effect.runPromise(
        first.ingestRaw(identity, device, [
          codexReport([["2026-05-06", 753.12, { "gpt-5.5": gpt55Tokens }]]),
        ]),
      );

      const later = await makeService("2026-05-07T12:00:00.000Z");
      const grown = { ...gpt55Tokens, outputTokens: 907_056, totalTokens: 335_407_056 };
      await Effect.runPromise(
        later.ingestRaw(identity, device, [
          codexReport([["2026-05-06", 301.5, { "gpt-5.5": grown }]]),
        ]),
      );

      expect(costs()).toEqual([
        { costUsd: 301.5, date: "2026-05-06", model: "gpt-5.5", totalTokens: 335_407_056 },
      ]);
    });

    it("prunes dropped models but keeps surviving models' frozen cost", async () => {
      const gpt5Tokens = { inputTokens: 1_000, outputTokens: 100, totalTokens: 1_100 };
      const first = await makeService("2026-05-06T12:00:00.000Z");
      await Effect.runPromise(
        first.ingestRaw(identity, device, [
          codexReport([
            [
              "2026-05-06",
              // Unpriced `models` entries split the day cost by token weight.
              753.12 + 0.01,
              { "gpt-5": gpt5Tokens, "gpt-5.5": gpt55Tokens },
            ],
          ]),
        ]),
      );
      const [, before] = costs() as { costUsd: number }[];

      const later = await makeService("2026-09-23T12:00:00.000Z");
      const window = codexReport([["2026-05-06", 301.25, { "gpt-5.5": gpt55Tokens }]]);
      await Effect.runPromise(later.ingestRaw(identity, device, [window]));
      const afterFirst = costs();
      await Effect.runPromise(later.ingestRaw(identity, device, [window]));

      expect(afterFirst).toEqual([
        {
          costUsd: before!.costUsd,
          date: "2026-05-06",
          model: "gpt-5.5",
          totalTokens: 335_307_056,
        },
      ]);
      expect(costs()).toEqual(afterFirst);
    });

    it("freezes cost on the legacy structured sync path too", async () => {
      const day = {
        cacheCreationTokens: 0,
        date: "2026-05-06",
        model: "gpt-5.5",
        source: "codex" as const,
        ...gpt55Tokens,
      };
      const july = await makeService("2026-07-10T12:00:00.000Z");
      await Effect.runPromise(july.syncBatch(identity, device, [{ ...day, costUsd: 753.12 }]));

      const september = await makeService("2026-09-23T12:00:00.000Z");
      await Effect.runPromise(
        september.syncBatch(identity, device, [
          { ...day, costUsd: 301.25 },
          { ...day, costUsd: 12, date: "2026-09-23", totalTokens: 1_000 },
        ]),
      );

      expect(costs()).toEqual([
        { costUsd: 753.12, date: "2026-05-06", model: "gpt-5.5", totalTokens: 335_307_056 },
        { costUsd: 12, date: "2026-09-23", model: "gpt-5.5", totalTokens: 1_000 },
      ]);
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

    it("replaces a key's usage and cost when its token counts change", async () => {
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

    it("keeps the stored cost when a re-sync only re-prices unchanged tokens", async () => {
      const repository = await makeRepository();

      await Effect.runPromise(repository.upsertChunk("user", "device", rows, new Date(1_000)));
      await Effect.runPromise(
        repository.upsertChunk(
          "user",
          "device",
          rows.map((row) => ({ ...row, costUsd: row.costUsd * 2.5 })),
          new Date(2_000),
        ),
      );

      expect(totals()).toEqual({ costUsd: 4.5, rowCount: 3, totalTokens: 350 });
      // syncedAt still advances, so pruning treats the rows as re-sent.
      expect(usageRows().map((row) => row.syncedAt)).toEqual([2_000, 2_000, 2_000]);
    });

    it("takes the incoming cost when any token count changes", async () => {
      const repository = await makeRepository();
      const base = usageDay({ costUsd: 1, date: "2026-07-21", model: "gpt-5", totalTokens: 100 });
      const changes: Partial<UsageDayInput>[] = [
        { inputTokens: 101 },
        { outputTokens: 1 },
        { cacheCreationTokens: 1 },
        { cacheReadTokens: 1 },
        { totalTokens: 101 },
      ];

      for (const [index, change] of changes.entries()) {
        const row = { ...base, model: `model-${index}` };
        await Effect.runPromise(repository.upsertChunk("user", "device", [row], new Date(1_000)));
        await Effect.runPromise(
          repository.upsertChunk(
            "user",
            "device",
            [{ ...row, ...change, costUsd: 3 }],
            new Date(2_000),
          ),
        );
      }

      expect(usageRows().map((row) => row.costUsd)).toEqual([3, 3, 3, 3, 3]);
    });

    it("prices a previously unpriced row even when its tokens are unchanged", async () => {
      const repository = await makeRepository();
      const unpriced = usageDay({ costUsd: 0, date: "2026-07-21", model: "new", totalTokens: 100 });

      await Effect.runPromise(
        repository.upsertChunk("user", "device", [unpriced], new Date(1_000)),
      );
      await Effect.runPromise(
        repository.upsertChunk("user", "device", [{ ...unpriced, costUsd: 4 }], new Date(2_000)),
      );

      expect(usageRows()).toMatchObject([{ costUsd: 4, model: "new" }]);
    });

    it("keeps a priced row's cost when a re-sync of the same tokens comes back unpriced", async () => {
      const repository = await makeRepository();
      const priced = usageDay({ costUsd: 4, date: "2026-07-21", model: "gpt-5", totalTokens: 100 });

      await Effect.runPromise(repository.upsertChunk("user", "device", [priced], new Date(1_000)));
      await Effect.runPromise(
        repository.upsertChunk("user", "device", [{ ...priced, costUsd: 0 }], new Date(2_000)),
      );

      expect(usageRows()).toMatchObject([{ costUsd: 4 }]);
    });

    it("decides per row in a mixed chunk of new, re-priced and changed rows", async () => {
      const repository = await makeRepository();

      await Effect.runPromise(repository.upsertChunk("user", "device", rows, new Date(1_000)));
      await Effect.runPromise(
        repository.upsertChunk(
          "user",
          "device",
          [
            // Re-priced only: frozen.
            { ...rows[0]!, costUsd: 99 },
            // More usage on the same day: takes the incoming cost.
            usageDay({ costUsd: 3.75, date: "2026-07-21", model: "gpt-5", totalTokens: 300 }),
            // Untouched existing row.
            rows[2]!,
            // Brand-new key: inserted as sent.
            usageDay({ costUsd: 7, date: "2026-07-22", model: "gpt-5", totalTokens: 70 }),
          ],
          new Date(2_000),
        ),
      );

      expect(usageRows().map((row) => [row.date, row.model, row.inputTokens, row.costUsd])).toEqual(
        [
          ["2026-07-20", "gpt-5", 100, 1.5],
          ["2026-07-21", "gpt-5", 300, 3.75],
          ["2026-07-21", "o3", 50, 0.5],
          ["2026-07-22", "gpt-5", 70, 7],
        ],
      );
    });

    it("keeps a full chunk within D1's bound-parameter limit", async () => {
      const repository = await makeRepository();
      const chunk = Array.from({ length: 40 }, (_, index) =>
        usageDay({ costUsd: 1, date: "2026-07-21", model: `model-${index}`, totalTokens: 10 }),
      );

      await Effect.runPromise(repository.upsertChunk("user", "device", chunk, new Date(1_000)));
      await Effect.runPromise(repository.upsertChunk("user", "device", chunk, new Date(2_000)));

      expect(totals()).toEqual({ costUsd: 40, rowCount: 40, totalTokens: 400 });
      expect(
        Math.max(...database.executed.map((query) => query.parameters.length)),
      ).toBeLessThanOrEqual(100);
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
