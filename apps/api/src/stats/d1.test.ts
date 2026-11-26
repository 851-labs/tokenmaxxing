import { Effect, Layer } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { makeTestDatabase, type TestDatabase } from "../testing/sqlite-d1";
import { buildService } from "../testing/effect";
import { latestUsageDateKey } from "../date-keys";
import { seedUsage, seedUser } from "../testing/seed";
import { seedStatsFixture, STATS_FIXTURE_WHALE_ID } from "../testing/stats-fixture";
import { StatsRepositoryReference } from "../testing/stats-reference";
import { StatsRepositoryLive } from "./d1";
import { statsRangeStartsFrom } from "../testing/stats";
import {
  StatsRepository,
  statsRangeStarts,
  type StatsRangeStarts,
  type StatsSnapshot,
} from "./service";

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
    // Each range start is bound once per statement, however many aggregates
    // filter on it: six starts plus the window's two bounds.
    expect(database.executed.map((query) => query.parameters.length)).toEqual([2, 2, 2, 8, 8, 8]);
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

  it("leaves out keys with no rows in the range", async () => {
    usage("alpha", "2026-07-01", "recent", 5, 50);
    usage("bravo", "2026-06-01", "older", 100, 1_000);

    const result = await snapshot(statsRangeStartsFrom("2026-07-01", "2026-01-01"));

    const { "1m": month, ytd } = result.ranges;
    expect(month.modelsBySpend.map((row) => row.key)).toEqual(["recent"]);
    expect(month.sources.map((row) => [row.key, row.rowCount])).toEqual([["codex", 1]]);
    expect(ytd.modelsBySpend).toEqual([
      { key: "older", rowCount: 1, spendUsd: 100, totalTokens: 1_000, userCount: 1 },
      { key: "recent", rowCount: 1, spendUsd: 5, totalTokens: 50, userCount: 1 },
    ]);
  });

  it("orders exact ties by key, later first, also where they straddle the limit", async () => {
    // Twelve models tied on spend and tokens, two more above and below them.
    const tied = [
      "m03",
      "m11",
      "m07",
      "m01",
      "m12",
      "m05",
      "m09",
      "m02",
      "m10",
      "m06",
      "m04",
      "m08",
    ];
    for (const model of tied) {
      usage("alpha", "2026-07-01", model, 5, 50);
    }
    usage("bravo", "2026-07-02", "top", 9, 500);
    usage("bravo", "2026-07-02", "bottom", 1, 1);

    const { ytd } = (await snapshot(statsRangeStartsFrom("2026-07-01", "2026-01-01"))).ranges;

    // Limit 10: the leader, then the nine latest of the twelve tied keys.
    const cut = ["top", "m12", "m11", "m10", "m09", "m08", "m07", "m06", "m05", "m04"];
    expect(ytd.modelsBySpend.map((row) => row.key)).toEqual(cut);
    expect(ytd.modelsByTokens.map((row) => row.key)).toEqual(cut);
  });

  it("counts nothing of a shadow-banned user, on a device a visible user shares too", async () => {
    seedUser(database.sqlite, { id: "banned", shadowBannedAt: 1 });
    const row = (userId: string, deviceId: string, date: string, model: string, source: string) =>
      seedUsage(database.sqlite, {
        costUsd: 2,
        date,
        deviceId,
        inputTokens: 7,
        model,
        source,
        totalTokens: 20,
        userId,
      });
    row("alpha", "shared-device", "2026-06-01", "gpt-5", "codex");
    // In the month only the banned user has rows, some of them on the shared device.
    row("banned", "shared-device", "2026-07-02", "gpt-5", "codex");
    row("banned", "banned-device", "2026-07-03", "banned-model", "banned-source");

    const result = await snapshot(statsRangeStartsFrom("2026-07-01", "2026-01-01"));

    const { "1m": month, ytd } = result.ranges;
    expect(month).toMatchObject({ modelsBySpend: [], modelsByTokens: [], sources: [] });
    expect(month.totals).toEqual({
      activeDays: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      deviceCount: 0,
      firstDate: null,
      inputTokens: 0,
      lastDate: null,
      outputTokens: 0,
      rowCount: 0,
      spendUsd: 0,
      totalTokens: 0,
      userCount: 0,
    });
    expect(ytd.totals).toMatchObject({
      activeDays: 1,
      deviceCount: 1,
      inputTokens: 7,
      lastDate: "2026-06-01",
      rowCount: 1,
      spendUsd: 2,
      userCount: 1,
    });
    expect(ytd.modelsBySpend.map((model) => [model.key, model.userCount])).toEqual([["gpt-5", 1]]);
    expect(ytd.sources.map((source) => source.key)).toEqual(["codex"]);
    expect(result.daily.map((day) => day.date)).toEqual(["2026-06-01"]);
    expect(result.dailyByModel.map((cell) => cell.key)).toEqual(["gpt-5"]);
  });
});

/**
 * The snapshot must not differ from one plain aggregate per range and ranking
 * (`StatsRepositoryReference`). Keys, order, dates, counts and token sums are
 * compared exactly. Spend is a float sum, and SQLite's compensated `total()`
 * does not promise the same last bit when two plans read the same rows in a
 * different order, so spend is held to `SPEND_RELATIVE_TOLERANCE`, and chart
 * cells, which are rounded to cents, to one cent.
 *
 * The fixture is shaped like production; set `STATS_FIXTURE_SCALE` to seed
 * more rows (27 is production's size, about 330k rows, and takes a while).
 */
describe("D1 stats snapshot against the per-range reference", () => {
  const scale = Number(process.env.STATS_FIXTURE_SCALE ?? 1);
  let database: TestDatabase;

  beforeEach(() => {
    database = makeTestDatabase();
  });

  afterEach(() => database.close());

  it.each([
    // Year to date is the longest range.
    "2026-11-26",
    // Early January: the trailing ranges reach back past a days-old year to date.
    "2027-01-05",
  ])("matches it as of %s", { timeout: 120_000 }, async (today) => {
    const fixture = seedStatsFixture(database.sqlite, {
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

    // The comparison can only catch banned rows leaking into a range if the
    // range has some: rows of ordinary banned users, not only the whale's, and
    // rows of both the banned and the visible user of the shared device.
    const rowsIn = database.sqlite.prepare(
      `select count(*) as row_count, count(distinct usage_days.user_id) as user_count
       from usage_days inner join users on users.id = usage_days.user_id
       where usage_days.date >= ? and usage_days.date <= ? and usage_days.user_id <> ?
         and (users.shadow_banned_at is not null) = ? and usage_days.device_id like ?`,
    );
    const shared = fixture.sharedDevice!;
    expect(shared).not.toBeNull();
    for (const since of Object.values(input.ranges)) {
      const count = (banned: 0 | 1, device: string) =>
        rowsIn.get(since, input.until, STATS_FIXTURE_WHALE_ID, banned, device);
      expect(Number(count(1, "%")?.user_count)).toBeGreaterThanOrEqual(3);
      expect(Number(count(1, shared.deviceId)?.row_count)).toBeGreaterThan(0);
      expect(Number(count(0, shared.deviceId)?.row_count)).toBeGreaterThan(0);
    }

    const snapshot = await snapshotFrom(StatsRepositoryLive);

    expectSameSnapshot(snapshot, await snapshotFrom(StatsRepositoryReference));
    // Guards the comparison itself: every range ranked and charted something.
    for (const range of Object.values(snapshot.ranges)) {
      expect(range.modelsBySpend).toHaveLength(10);
      expect(range.totals.userCount).toBeGreaterThan(10);
    }
    expect(snapshot.dailyByModel.some((cell) => cell.key === "Other")).toBe(true);
  });
});

/** About 45 ulps: far below any digit shown, far above what summation order can move. */
const SPEND_RELATIVE_TOLERANCE = 1e-14;
/**
 * Chart cells are rounded to cents, so a last-bit difference either leaves a
 * cell alone or, on a half-cent boundary, moves it by one cent. The slack on
 * top covers the float error in that one-cent difference.
 */
const CENT_TOLERANCE = 0.01 + 1e-9;

function expectSameSnapshot(actual: StatsSnapshot, expected: StatsSnapshot) {
  // Everything but spend, exactly.
  const withoutSpend = (snapshot: StatsSnapshot): unknown =>
    JSON.parse(JSON.stringify(snapshot, (key, value) => (key === "spendUsd" ? null : value)));
  expect(withoutSpend(actual)).toEqual(withoutSpend(expected));

  const exactSpend = (snapshot: StatsSnapshot) =>
    Object.values(snapshot.ranges).flatMap((range) => [
      range.totals.spendUsd,
      ...[...range.modelsBySpend, ...range.modelsByTokens, ...range.sources].map(
        (row) => row.spendUsd,
      ),
    ]);
  const centSpend = (snapshot: StatsSnapshot) =>
    [...snapshot.daily, ...snapshot.dailyByModel, ...snapshot.dailyBySource].map(
      (cell) => cell.spendUsd,
    );
  const apart = (left: number[], right: number[], allowed: (value: number) => number) =>
    left.flatMap((value, index) =>
      Math.abs(value - right[index]!) <= allowed(Math.abs(value)) ? [] : [[value, right[index]]],
    );
  expect(
    apart(exactSpend(actual), exactSpend(expected), (value) => value * SPEND_RELATIVE_TOLERANCE),
  ).toEqual([]);
  expect(apart(centSpend(actual), centSpend(expected), () => CENT_TOLERANCE)).toEqual([]);
}
