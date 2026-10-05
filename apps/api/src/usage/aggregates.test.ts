import { Effect, Layer } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { AdminRepositoryLive } from "../admin/d1";
import { AdminRepository } from "../admin/service";
import { LeaderboardRepositoryLive } from "../leaderboard/d1";
import { LeaderboardRepository } from "../leaderboard/service";
import { ProfilesRepositoryLive } from "../profiles/d1";
import { ProfilesRepository } from "../profiles/service";
import { StatsRepositoryLive } from "../stats/d1";
import { StatsRepository } from "../stats/service";
import { buildService } from "../testing/effect";
import { makeTestDatabase, type TestDatabase } from "../testing/sqlite-d1";
import { seedUser } from "../testing/seed";

/**
 * 2026-10-05 in prod: fabricated rows pushed one user's `sum(total_tokens)`
 * past int64, and SQLite's `sum()` threw "integer overflow", taking down
 * `/internal`. Every aggregate read must survive rows like that.
 */

const until = "2026-12-31";

/** Three of these overflow int64 (9.22e18) when summed as integers. */
const HUGE_TOKENS = 4_000_000_000_000_000_000n;

describe("usage aggregates over int64-overflowing rows", () => {
  let database: TestDatabase;

  beforeEach(() => {
    database = makeTestDatabase();
    seedUser(database.sqlite, { id: "alpha" });
    const insert = database.sqlite.prepare(
      `insert into usage_days (
        device_id, user_id, date, source, model, input_tokens, output_tokens,
        cache_creation_tokens, cache_read_tokens, total_tokens, cost_usd, synced_at
      ) values ('alpha-device', 'alpha', ?, 'codex', 'gpt-5', 0, 0, 0, ?, ?, 1e296, 0)`,
    );
    for (const date of ["2026-07-01", "2026-07-02", "2026-07-03"]) {
      insert.run(date, HUGE_TOKENS, HUGE_TOKENS);
    }
  });

  afterEach(() => database.close());

  it("reproduces the prod failure with SQLite's sum()", () => {
    expect(() => database.sqlite.prepare("select sum(total_tokens) from usage_days").get()).toThrow(
      /integer overflow/,
    );
  });

  it("loads the admin snapshots", async () => {
    const repository = await buildService(
      AdminRepository,
      AdminRepositoryLive.pipe(Layer.provide(database.drizzleLayer)),
    );

    const [alpha] = await Effect.runPromise(repository.listUserSnapshots());

    expect(alpha?.usage.totalTokens).toBe(1.2e19);
    expect(alpha?.deviceUsage[0]?.totalTokens).toBe(1.2e19);
    expect(alpha!.usage.totalSpendUsd / 3e296).toBeCloseTo(1);
  });

  it("ranks the leaderboard", async () => {
    const repository = await buildService(
      LeaderboardRepository,
      LeaderboardRepositoryLive.pipe(Layer.provide(database.drizzleLayer)),
    );

    const entries = await Effect.runPromise(
      repository.list({ limit: 10, metric: "tokens", since: null, until }),
    );

    expect(entries.map((entry) => entry.totalTokens)).toEqual([1.2e19]);
  });

  it("builds the stats snapshot", async () => {
    const repository = await buildService(
      StatsRepository,
      StatsRepositoryLive.pipe(Layer.provide(database.drizzleLayer)),
    );

    const snapshot = await Effect.runPromise(
      repository.snapshot({
        limit: 10,
        until,
        windows: { last30d: "2026-07-01", ytd: "2026-01-01" },
      }),
    );

    expect(snapshot.windows.ytd.totals.totalTokens).toBe(1.2e19);
    expect(snapshot.windows.ytd.totals.cacheReadTokens).toBe(1.2e19);
  });

  it("reads profile stats, rank and daily rows", async () => {
    const repository = await buildService(
      ProfilesRepository,
      ProfilesRepositoryLive.pipe(Layer.provide(database.drizzleLayer)),
    );

    const stats = await Effect.runPromise(
      repository.stats("alpha", { today: "2026-07-03", until }),
    );
    const rank = await Effect.runPromise(
      repository.leaderboardRank({ since: null, until, userId: "alpha" }),
    );
    const daily = await Effect.runPromise(
      repository.daily("alpha", { groupBy: "model", since: "2026-07-01", until }),
    );

    expect(stats.totalTokens).toBe(1.2e19);
    expect(rank).toBe(1);
    expect(daily.map((row) => row.totalTokens)).toEqual([4e18, 4e18, 4e18]);
  });
});
