import { Effect, Layer } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { makeTestDatabase, type TestDatabase } from "../testing/sqlite-d1";
import { buildService } from "../testing/effect";
import { seedUsage, seedUser } from "../testing/seed";
import { StatsRepositoryLive } from "./d1";
import { statsRangeStartsFrom } from "../testing/stats";
import { StatsRepository, type StatsRangeStarts } from "./service";

describe("D1 stats snapshot", () => {
  let database: TestDatabase;

  beforeEach(() => {
    database = makeTestDatabase();
    for (const id of ["charlie", "bravo", "alpha"]) {
      seedUser(database.sqlite, { id });
    }
  });

  afterEach(() => database.close());

  function usage(
    userId: string,
    date: string,
    model: string,
    costUsd: number,
    totalTokens: number,
    source = "codex",
  ) {
    seedUsage(database.sqlite, {
      costUsd,
      date,
      deviceId: `${userId}-device`,
      model,
      source,
      totalTokens,
      userId,
    });
  }

  async function snapshot(ranges: StatsRangeStarts, until = "2026-12-31") {
    const stats = await buildService(
      StatsRepository,
      StatsRepositoryLive.pipe(Layer.provide(database.drizzleLayer)),
    );

    return Effect.runPromise(stats.snapshot({ limit: 10, ranges, until }));
  }

  it("aggregates each range exactly and shares one daily series", async () => {
    usage("alpha", "2025-12-31", "legacy", 100, 1_000);
    usage("alpha", "2026-06-30", "gpt-5", 10, 100);
    usage("bravo", "2026-07-01", "opus", 1, 10, "claude");
    usage("charlie", "2026-07-01", "opus", 2, 20, "claude");

    const result = await snapshot(statsRangeStartsFrom("2026-07-01", "2026-01-01"));

    const { "1m": month, ytd } = result.ranges;
    expect([ytd.totals.spendUsd, month.totals.spendUsd]).toEqual([13, 3]);
    expect([month.since, ytd.since]).toEqual(["2026-07-01", "2026-01-01"]);
    expect(ytd.totals).toMatchObject({
      firstDate: "2026-06-30",
      lastDate: "2026-07-01",
      userCount: 3,
    });
    expect(ytd.modelsBySpend.map((row) => row.key)).toEqual(["gpt-5", "opus"]);
    expect(month.modelsBySpend.map((row) => [row.key, row.userCount])).toEqual([["opus", 2]]);
    expect(month.modelsByTokens.map((row) => row.key)).toEqual(["opus"]);
    expect(month.sources.map((row) => [row.key, row.totalTokens])).toEqual([["claude", 30]]);
    expect(ytd.sources.map((row) => row.key)).toEqual(["codex", "claude"]);

    // One series for every range, from the earliest range start.
    expect(result.daily).toEqual([
      { date: "2026-06-30", spendUsd: 10, totalTokens: 100, userCount: 1 },
      { date: "2026-07-01", spendUsd: 3, totalTokens: 30, userCount: 2 },
    ]);
    expect(result.dailyByModel).toEqual([
      { date: "2026-06-30", key: "gpt-5", spendUsd: 10, totalTokens: 100 },
      { date: "2026-07-01", key: "opus", spendUsd: 3, totalTokens: 30 },
    ]);
    expect(result.dailyBySource.map((row) => [row.date, row.key])).toEqual([
      ["2026-06-30", "codex"],
      ["2026-07-01", "claude"],
    ]);
    expect(result.until).toBe("2026-12-31");
  });

  it("starts the daily series at a trailing range that reaches back before Jan 1", async () => {
    usage("alpha", "2025-12-20", "gpt-5", 3, 30);
    usage("alpha", "2026-01-02", "gpt-5", 4, 40);

    const result = await snapshot(statsRangeStartsFrom("2025-12-08", "2026-01-01"), "2026-01-06");

    expect(result.daily.map((row) => row.date)).toEqual(["2025-12-20", "2026-01-02"]);
    expect(result.ranges["1m"].totals.spendUsd).toBe(7);
    expect(result.ranges.ytd.totals.spendUsd).toBe(4);
  });
});
