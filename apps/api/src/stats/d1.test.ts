import { Effect, Layer } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { makeTestDatabase, type TestDatabase } from "../testing/sqlite-d1";
import { buildService } from "../testing/effect";
import { latestUsageDateKey } from "../date-keys";
import { seedUsage, seedUser } from "../testing/seed";
import { seedStatsFixture } from "../testing/stats-fixture";
import { StatsRepositoryReference } from "../testing/stats-reference";
import { StatsRepositoryLive } from "./d1";
import { statsRangeStartsFrom } from "../testing/stats";
import { StatsRepository, statsRangeStarts, type StatsRangeStarts } from "./service";

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

  async function snapshot(
    ranges: StatsRangeStarts,
    until = "2026-12-31",
    repository = StatsRepositoryLive,
  ) {
    const stats = await buildService(
      StatsRepository,
      repository.pipe(Layer.provide(database.drizzleLayer)),
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

  it("reads only visible users' days, in six statements whatever the ranges", async () => {
    usage("alpha", "2026-06-30", "gpt-5", 10, 100);

    await snapshot(statsRangeStarts(new Date("2026-07-09T20:00:00.000Z")), "2026-07-10");

    expect(database.executed).toHaveLength(6);
    const plans = database.executed.map((query) => database.queryPlan(query));
    // Driven from users, so a banned user's rows are never read, and never
    // from the date index, which fetches every row of the window one by one.
    for (const plan of plans) {
      expect(plan).toContain("SCAN users");
      expect(plan.join("\n")).toMatch(
        /SEARCH usage_days USING (COVERING )?INDEX usage_days_user_date_cost_tokens_idx \(user_id=\? AND date>\? AND date<\?\)/u,
      );
    }
    // The per-day totals need nothing outside that index.
    expect(plans[0]?.join("\n")).toContain("USING COVERING INDEX");
  });

  it("ranks exact ties as SQLite did and leaves out keys with no rows in the range", async () => {
    for (const model of ["delta", "bravo", "echo", "alpha", "charlie"]) {
      usage("alpha", "2026-07-01", model, 5, 50);
    }
    usage("bravo", "2026-07-02", "zulu", 9, 5);
    usage("bravo", "2026-06-01", "older", 100, 1_000);
    const ranges = statsRangeStartsFrom("2026-07-01", "2026-01-01");

    const result = await snapshot(ranges);

    const { "1m": month, ytd } = result.ranges;
    expect(month.modelsBySpend.map((row) => row.key)).toEqual([
      "zulu",
      "echo",
      "delta",
      "charlie",
      "bravo",
      "alpha",
    ]);
    expect(month.modelsByTokens.map((row) => row.key).at(-1)).toBe("zulu");
    expect(ytd.modelsBySpend[0]).toEqual({
      key: "older",
      rowCount: 1,
      spendUsd: 100,
      totalTokens: 1_000,
      userCount: 1,
    });
    expect(result).toEqual(await snapshot(ranges, "2026-12-31", StatsRepositoryReference));
  });
});

/**
 * The snapshot must not differ from one plain aggregate per range and ranking
 * (`StatsRepositoryReference`) in any number, down to the last bit of a float
 * sum. The fixture is shaped like production; set `STATS_FIXTURE_SCALE` to
 * seed more rows (27 is production's size, about 330k rows, and takes a
 * while).
 */
describe("D1 stats snapshot against the per-range reference", () => {
  const scale = Number(process.env.STATS_FIXTURE_SCALE ?? 1);

  it.each([
    // Year to date is the longest range.
    "2026-11-26",
    // Early January: the trailing ranges reach back past a days-old year to date.
    "2027-01-05",
  ])("matches it exactly as of %s", { timeout: 120_000 }, async (today) => {
    const database = makeTestDatabase();
    seedStatsFixture(database.sqlite, {
      rows: 6_500 * scale,
      seed: 7,
      today,
      users: Math.round(140 * Math.sqrt(scale)),
      whaleRows: 6_000 * scale,
    });
    const now = new Date(`${today}T20:00:00.000Z`);
    const input = { limit: 10, ranges: statsRangeStarts(now), until: latestUsageDateKey(now) };
    const snapshotFrom = async (repository: typeof StatsRepositoryLive) => {
      const stats = await buildService(
        StatsRepository,
        repository.pipe(Layer.provide(database.drizzleLayer)),
      );
      return Effect.runPromise(stats.snapshot(input));
    };

    const snapshot = await snapshotFrom(StatsRepositoryLive);

    expect(snapshot).toEqual(await snapshotFrom(StatsRepositoryReference));
    // Guards the comparison itself: every range ranked and charted something.
    for (const range of Object.values(snapshot.ranges)) {
      expect(range.modelsBySpend).toHaveLength(10);
      expect(range.totals.userCount).toBeGreaterThan(10);
    }
    expect(snapshot.dailyByModel.some((cell) => cell.key === "Other")).toBe(true);
    database.close();
  });
});
