import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { Context, Effect, Layer } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { Drizzle } from "./database";
import { LeaderboardRepositoryLive } from "./leaderboard/d1";
import { LeaderboardRepository } from "./leaderboard/service";
import { ProfilesRepositoryLive } from "./profiles/d1";
import { ProfilesRepository } from "./profiles/service";
import { StatsRepositoryLive } from "./stats/d1";
import { StatsRepository } from "./stats/service";

const until = "2026-09-23";

describe("public usage visibility", () => {
  let sqlite: DatabaseSync;

  beforeEach(() => {
    sqlite = new DatabaseSync(":memory:");
    sqlite.exec(`
      create table users (
        id text primary key,
        login text not null unique,
        name text,
        avatar_url text,
        shadow_banned_at integer,
        shadow_banned_by_user_id text,
        created_at integer not null,
        updated_at integer not null
      );
      create table usage_days (
        device_id text not null,
        user_id text not null,
        date text not null,
        source text not null,
        model text not null,
        input_tokens integer not null default 0,
        output_tokens integer not null default 0,
        cache_creation_tokens integer not null default 0,
        cache_read_tokens integer not null default 0,
        total_tokens integer not null default 0,
        cost_usd real not null default 0,
        synced_at integer not null,
        primary key (device_id, date, source, model)
      );
    `);

    const insertUser = sqlite.prepare(
      `insert into users (
        id, login, name, avatar_url, shadow_banned_at, shadow_banned_by_user_id,
        created_at, updated_at
      ) values (?, ?, null, null, ?, ?, 0, 0)`,
    );
    insertUser.run("visible", "visible", null, null);
    insertUser.run("banned", "banned", 1, "admin");

    const insertUsage = sqlite.prepare(
      `insert into usage_days (
        device_id, user_id, date, source, model, input_tokens, output_tokens,
        cache_creation_tokens, cache_read_tokens, total_tokens, cost_usd, synced_at
      ) values (?, ?, '2026-07-09', ?, ?, 0, 0, 0, 0, ?, ?, 0)`,
    );
    insertUsage.run("visible-device", "visible", "codex", "visible-model", 100, 1);
    insertUsage.run("banned-device", "banned", "fake-source", "fake-model", 10_000, 100);
  });

  afterEach(() => sqlite.close());

  it("excludes banned usage from every leaderboard and stats branch, then restores it", async () => {
    const drizzleLayer = Drizzle.layer({ raw: Effect.succeed(d1Database(sqlite)) });
    const leaderboard = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* LeaderboardRepository;
      }).pipe(Effect.provide(LeaderboardRepositoryLive.pipe(Layer.provide(drizzleLayer)))),
    );
    const stats = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* StatsRepository;
      }).pipe(Effect.provide(StatsRepositoryLive.pipe(Layer.provide(drizzleLayer)))),
    );
    const profiles = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* ProfilesRepository;
      }).pipe(Effect.provide(ProfilesRepositoryLive.pipe(Layer.provide(drizzleLayer)))),
    );

    const entries = await run(
      leaderboard.list({ limit: 10, metric: "tokens", since: null, until }),
    );
    const visibleRank = await run(
      profiles.leaderboardRank({ since: "2026-06-10", until, userId: "visible" }),
    );
    const bannedRank = await run(
      profiles.leaderboardRank({ since: "2026-06-10", until, userId: "banned" }),
    );
    const hidden = await run(stats.snapshot({ last30dSince: "2026-06-10", limit: 10, until }));

    expect(entries.map((entry) => [entry.rank, entry.user.login])).toEqual([[1, "visible"]]);
    expect(visibleRank).toBe(1);
    expect(bannedRank).toBeNull();
    expect(hidden.allTime).toMatchObject({
      deviceCount: 1,
      rowCount: 1,
      totalSpendUsd: 1,
      totalTokens: 100,
      userCount: 1,
    });
    expect(hidden.daily).toEqual([
      { date: "2026-07-09", spendUsd: 1, totalTokens: 100, userCount: 1 },
    ]);
    expect(hidden.dailyByModel.map((row) => row.key)).toEqual(["visible-model"]);
    expect(hidden.sources.allTime.map((row) => row.key)).toEqual(["codex"]);
    expect(hidden.topModels.allTimeByTokens.map((row) => row.key)).toEqual(["visible-model"]);
    expect(hidden.topUsers.byTokens.map((row) => row.user.login)).toEqual(["visible"]);
    expect(hidden.peaks.tokens).toMatchObject({ totalTokens: 100, userCount: 1 });

    sqlite.prepare("update users set shadow_banned_at = null where id = 'banned'").run();

    const restoredBannedRank = await run(
      profiles.leaderboardRank({ since: "2026-06-10", until, userId: "banned" }),
    );
    const restoredVisibleRank = await run(
      profiles.leaderboardRank({ since: "2026-06-10", until, userId: "visible" }),
    );
    const restored = await run(stats.snapshot({ last30dSince: "2026-06-10", limit: 10, until }));
    expect(restoredBannedRank).toBe(1);
    expect(restoredVisibleRank).toBe(2);
    expect(restored.allTime).toMatchObject({
      deviceCount: 2,
      rowCount: 2,
      totalSpendUsd: 101,
      totalTokens: 10_100,
      userCount: 2,
    });
    expect(restored.topUsers.byTokens[0]?.user.login).toBe("banned");
  });

  it("applies the same date window as the leaderboard", async () => {
    sqlite.prepare("update users set shadow_banned_at = null where id = 'banned'").run();
    sqlite
      .prepare(
        `insert into usage_days (
          device_id, user_id, date, source, model, input_tokens, output_tokens,
          cache_creation_tokens, cache_read_tokens, total_tokens, cost_usd, synced_at
        ) values (
          'visible-old-device', 'visible', '2026-05-01', 'codex', 'visible-model',
          0, 0, 0, 0, 1, 1000, 0
        )`,
      )
      .run();

    const drizzleLayer = Drizzle.layer({ raw: Effect.succeed(d1Database(sqlite)) });
    const profiles = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* ProfilesRepository;
      }).pipe(Effect.provide(ProfilesRepositoryLive.pipe(Layer.provide(drizzleLayer)))),
    );

    const allTimeVisibleRank = await run(
      profiles.leaderboardRank({ since: null, until, userId: "visible" }),
    );
    const recentVisibleRank = await run(
      profiles.leaderboardRank({ since: "2026-06-10", until, userId: "visible" }),
    );
    const recentBannedRank = await run(
      profiles.leaderboardRank({ since: "2026-06-10", until, userId: "banned" }),
    );

    expect(allTimeVisibleRank).toBe(1);
    expect(recentVisibleRank).toBe(2);
    expect(recentBannedRank).toBe(1);
  });
});

describe("future-dated usage rows", () => {
  let sqlite: DatabaseSync;

  beforeEach(() => {
    sqlite = new DatabaseSync(":memory:");
    sqlite.exec(`
      create table users (
        id text primary key,
        login text not null unique,
        name text,
        avatar_url text,
        shadow_banned_at integer,
        shadow_banned_by_user_id text,
        created_at integer not null,
        updated_at integer not null
      );
      create table devices (id text primary key, name text not null);
      create table usage_source_stats (
        device_id text not null,
        user_id text not null,
        source text not null,
        session_count integer not null
      );
      create table usage_days (
        device_id text not null,
        user_id text not null,
        date text not null,
        source text not null,
        model text not null,
        input_tokens integer not null default 0,
        output_tokens integer not null default 0,
        cache_creation_tokens integer not null default 0,
        cache_read_tokens integer not null default 0,
        total_tokens integer not null default 0,
        cost_usd real not null default 0,
        synced_at integer not null,
        primary key (device_id, date, source, model)
      );
      insert into users values ('honest', 'honest', null, null, null, null, 0, 0);
      insert into users values ('timetraveler', 'timetraveler', null, null, null, null, 0, 0);
    `);

    const insertUsage = sqlite.prepare(
      `insert into usage_days (
        device_id, user_id, date, source, model, input_tokens, output_tokens,
        cache_creation_tokens, cache_read_tokens, total_tokens, cost_usd, synced_at
      ) values (?, ?, ?, 'codex', 'gpt-5', 0, 0, 0, 0, ?, ?, 0)`,
    );
    insertUsage.run("honest-device", "honest", "2026-09-20", 100, 10);
    insertUsage.run("tt-device", "timetraveler", "2026-09-20", 1, 1);
    insertUsage.run("tt-device", "timetraveler", "9999-12-31", 1_000_000, 1_000_000);
  });

  afterEach(() => sqlite.close());

  it("never counts rows after the ceiling in any window, stat, or profile", async () => {
    const drizzleLayer = Drizzle.layer({ raw: Effect.succeed(d1Database(sqlite)) });
    const provide = <I, S>(tag: Context.Key<I, S>, layer: Layer.Layer<I, never, Drizzle>) =>
      Effect.runPromise(
        Effect.gen(function* () {
          return yield* tag;
        }).pipe(Effect.provide(layer.pipe(Layer.provide(drizzleLayer)))),
      );
    const leaderboard = await provide(LeaderboardRepository, LeaderboardRepositoryLive);
    const stats = await provide(StatsRepository, StatsRepositoryLive);
    const profiles = await provide(ProfilesRepository, ProfilesRepositoryLive);

    for (const since of [null, "2026-08-25", "2026-09-17"]) {
      const entries = await run(leaderboard.list({ limit: 10, metric: "spend", since, until }));
      expect(entries.map((entry) => [entry.user.login, entry.spendUsd])).toEqual([
        ["honest", 10],
        ["timetraveler", 1],
      ]);
      expect(await run(profiles.leaderboardRank({ since, until, userId: "honest" }))).toBe(1);
    }

    const snapshot = await run(stats.snapshot({ last30dSince: "2026-08-25", limit: 10, until }));
    for (const totals of [snapshot.allTime, snapshot.last30d, snapshot.year2026]) {
      expect(totals).toMatchObject({ lastDate: "2026-09-20", totalSpendUsd: 11, totalTokens: 101 });
    }
    expect(snapshot.daily.map((row) => row.date)).toEqual(["2026-09-20"]);
    expect(snapshot.dailyByModel.map((row) => row.date)).toEqual(["2026-09-20"]);
    expect(snapshot.peaks.spend).toMatchObject({ date: "2026-09-20", spendUsd: 11 });
    expect(snapshot.topUsers.bySpend.map((row) => row.user.login)).toEqual([
      "honest",
      "timetraveler",
    ]);

    const profile = await run(
      profiles.stats("timetraveler", { today: "2026-09-22", until: "2026-09-23" }),
    );
    expect(profile).toMatchObject({
      activeDays: 1,
      currentStreakDays: 1,
      lastDate: "2026-09-20",
      longestStreakDays: 1,
      peakDay: { date: "2026-09-20", spendUsd: 1 },
      totalSpendUsd: 1,
      totalTokens: 1,
    });
    const daily = await run(
      profiles.daily("timetraveler", { groupBy: "model", until: "2026-09-23" }),
    );
    expect(daily.map((row) => row.date)).toEqual(["2026-09-20"]);
  });
});

function run<A, E>(effect: Effect.Effect<A, E, any>): Promise<A> {
  return Effect.runPromise(effect as Effect.Effect<A, E, never>);
}

function d1Database(sqlite: DatabaseSync): D1Database {
  return {
    // Like D1, batched statements come back as `{ results }` of row OBJECTS
    // (drizzle maps them positionally via Object.keys), not raw arrays.
    batch: async (statements: TestD1Statement[]) =>
      statements.map((statement) => ({ results: statement.objects() })),
    prepare: (query: string) => d1Statement(sqlite, query),
  } as unknown as D1Database;
}

interface TestD1Statement {
  objects(): unknown[];
}

function d1Statement(
  sqlite: DatabaseSync,
  query: string,
  parameters: SQLInputValue[] = [],
): D1PreparedStatement {
  const statement = {
    all: async () => ({ results: sqlite.prepare(query).all(...parameters) }),
    bind: (...values: unknown[]) => d1Statement(sqlite, query, values as SQLInputValue[]),
    objects: () => sqlite.prepare(query).all(...parameters),
    raw: async () => {
      const prepared = sqlite.prepare(query);
      prepared.setReturnArrays(true);
      return prepared.all(...parameters);
    },
    run: async () => sqlite.prepare(query).run(...parameters),
  } satisfies TestD1Statement & Record<string, unknown>;

  return statement as unknown as D1PreparedStatement;
}
