import { Effect, Layer } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { makeTestDatabase, type TestDatabase } from "../testing/sqlite-d1";
import { buildService } from "../testing/effect";
import { seedUsage, seedUser } from "../testing/seed";
import { StatsRepositoryLive } from "./d1";
import { StatsRepository } from "./service";

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
  ) {
    seedUsage(database.sqlite, {
      costUsd,
      date,
      deviceId: `${userId}-device`,
      model,
      totalTokens,
      userId,
    });
  }

  async function snapshot(limit: number) {
    const stats = await buildService(
      StatsRepository,
      StatsRepositoryLive.pipe(Layer.provide(database.drizzleLayer)),
    );

    return Effect.runPromise(
      stats.snapshot({
        limit,
        until: "2026-12-31",
        windows: { last30d: "2026-07-01", ytd: "2026-01-01" },
      }),
    );
  }

  it("splits last-30-day and year-to-date windows", async () => {
    usage("alpha", "2025-12-31", "legacy", 100, 1_000);
    usage("alpha", "2026-06-30", "gpt-5", 10, 100);
    usage("bravo", "2026-07-01", "opus", 1, 10);

    const result = await snapshot(10);

    const { last30d, ytd } = result.windows;
    expect([ytd.totals.spendUsd, last30d.totals.spendUsd]).toEqual([11, 1]);
    expect([last30d.since, ytd.since]).toEqual(["2026-07-01", "2026-01-01"]);
    expect(ytd.totals).toMatchObject({
      firstDate: "2026-06-30",
      lastDate: "2026-07-01",
      userCount: 2,
    });
    expect(ytd.modelsBySpend.map((row) => row.key)).toEqual(["gpt-5", "opus"]);
    expect(last30d.modelsBySpend.map((row) => row.key)).toEqual(["opus"]);
    // Each window pairs its own sources, token ranking and chart rows with its totals.
    expect(last30d.modelsByTokens.map((row) => row.key)).toEqual(["opus"]);
    expect(last30d.sources.map((row) => row.totalTokens)).toEqual([10]);
    expect(ytd.dailyByModel).toEqual([
      { date: "2026-06-30", key: "gpt-5", rowCount: 1, spendUsd: 10, totalTokens: 100 },
      { date: "2026-07-01", key: "opus", rowCount: 1, spendUsd: 1, totalTokens: 10 },
    ]);
    expect(last30d.dailyByModel.map((row) => row.key)).toEqual(["opus"]);
  });

  it("charts a 30-day window that starts before year-to-date", async () => {
    usage("alpha", "2025-12-20", "gpt-5", 3, 30);
    usage("alpha", "2026-01-02", "gpt-5", 4, 40);

    const stats = await buildService(
      StatsRepository,
      StatsRepositoryLive.pipe(Layer.provide(database.drizzleLayer)),
    );
    const result = await Effect.runPromise(
      stats.snapshot({
        limit: 10,
        until: "2026-01-06",
        windows: { last30d: "2025-12-08", ytd: "2026-01-01" },
      }),
    );

    expect(result.windows.last30d.dailyByModel.map((row) => row.date)).toEqual([
      "2025-12-20",
      "2026-01-02",
    ]);
    expect(result.windows.ytd.dailyByModel.map((row) => row.date)).toEqual(["2026-01-02"]);
  });
});
