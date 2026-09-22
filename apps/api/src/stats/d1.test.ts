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
        windows: { allTime: null, last30d: "2026-07-01", ytd: "2026-01-01" },
      }),
    );
  }

  it("limits and tie-breaks top users by ascending user id", async () => {
    usage("charlie", "2026-07-02", "gpt-5", 5, 50);
    usage("alpha", "2026-07-02", "gpt-5", 5, 50);
    usage("bravo", "2026-07-02", "gpt-5", 5, 50);

    const result = await snapshot(2);

    expect(result.topUsers.bySpend.map((row) => row.user.login)).toEqual(["alpha", "bravo"]);
    expect(result.topUsers.byTokens.map((row) => row.user.login)).toEqual(["alpha", "bravo"]);
  });

  it("splits all-time, last-30-day and year-to-date windows", async () => {
    usage("alpha", "2025-12-31", "legacy", 100, 1_000);
    usage("alpha", "2026-06-30", "gpt-5", 10, 100);
    usage("bravo", "2026-07-01", "opus", 1, 10);

    const result = await snapshot(10);

    const { allTime, last30d, ytd } = result.windows;
    expect([allTime.totals.spendUsd, ytd.totals.spendUsd, last30d.totals.spendUsd]).toEqual([
      111, 11, 1,
    ]);
    expect([allTime.since, last30d.since, ytd.since]).toEqual([null, "2026-07-01", "2026-01-01"]);
    expect(allTime.totals).toMatchObject({
      firstDate: "2025-12-31",
      lastDate: "2026-07-01",
      userCount: 2,
    });
    expect(allTime.modelsBySpend.map((row) => row.key)).toEqual(["legacy", "gpt-5", "opus"]);
    expect(ytd.modelsBySpend.map((row) => row.key)).toEqual(["gpt-5", "opus"]);
    expect(last30d.modelsBySpend.map((row) => row.key)).toEqual(["opus"]);
    // Each window pairs its own sources and token ranking with its totals.
    expect(last30d.modelsByTokens.map((row) => row.key)).toEqual(["opus"]);
    expect(last30d.sources.map((row) => row.totalTokens)).toEqual([10]);
    expect(result.peaks.spend).toMatchObject({ date: "2025-12-31", spendUsd: 100 });
  });
});
