import { Layer } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { makeTestDatabase, type TestDatabase } from "../testing/sqlite-d1";
import { buildService, runTest } from "../testing/effect";
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

    return runTest(stats.snapshot({ last30dSince: "2026-07-01", limit, until: "2026-12-31" }));
  }

  it("limits and tie-breaks top users by ascending user id", async () => {
    usage("charlie", "2026-07-02", "gpt-5", 5, 50);
    usage("alpha", "2026-07-02", "gpt-5", 5, 50);
    usage("bravo", "2026-07-02", "gpt-5", 5, 50);

    const result = await snapshot(2);

    expect(result.topUsers.bySpend.map((row) => row.user.id)).toEqual(["alpha", "bravo"]);
    expect(result.topUsers.byTokens.map((row) => row.user.id)).toEqual(["alpha", "bravo"]);
  });

  it("splits all-time, last-30-day and 2026 windows", async () => {
    usage("alpha", "2025-12-31", "legacy", 100, 1_000);
    usage("alpha", "2026-06-30", "gpt-5", 10, 100);
    usage("bravo", "2026-07-01", "opus", 1, 10);

    const result = await snapshot(10);

    expect([
      result.allTime.totalSpendUsd,
      result.year2026.totalSpendUsd,
      result.last30d.totalSpendUsd,
    ]).toEqual([111, 11, 1]);
    expect(result.allTime).toMatchObject({
      firstDate: "2025-12-31",
      lastDate: "2026-07-01",
      userCount: 2,
    });
    expect(result.topModels.allTimeBySpend.map((row) => row.key)).toEqual([
      "legacy",
      "gpt-5",
      "opus",
    ]);
    expect(result.topModels.year2026BySpend.map((row) => row.key)).toEqual(["gpt-5", "opus"]);
    expect(result.topModels.last30dBySpend.map((row) => row.key)).toEqual(["opus"]);
    expect(result.peaks.spend).toMatchObject({ date: "2025-12-31", spendUsd: 100 });
  });
});
