import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { Effect, Layer } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Drizzle } from "./database";
import { LeaderboardRepositoryLive } from "./leaderboard/d1";
import { LeaderboardRepository } from "./leaderboard/service";
import { ProfilesRepositoryLive } from "./profiles/d1";
import { ProfilesRepository } from "./profiles/service";
import { StatsRepositoryLive } from "./stats/d1";
import { StatsRepository } from "./stats/service";

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

    const entries = await run(leaderboard.list({ limit: 10, metric: "tokens", since: null }));
    const visibleRank = await run(profiles.leaderboardRank("visible"));
    const bannedRank = await run(profiles.leaderboardRank("banned"));
    const hidden = await run(stats.snapshot({ last30dSince: "2026-06-10", limit: 10 }));

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

    const restoredBannedRank = await run(profiles.leaderboardRank("banned"));
    const restoredVisibleRank = await run(profiles.leaderboardRank("visible"));
    const restored = await run(stats.snapshot({ last30dSince: "2026-06-10", limit: 10 }));
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
});

function run<A, E>(effect: Effect.Effect<A, E, any>): Promise<A> {
  return Effect.runPromise(effect as Effect.Effect<A, E, never>);
}

function d1Database(sqlite: DatabaseSync): D1Database {
  return {
    prepare: (query: string) => d1Statement(sqlite, query),
  } as unknown as D1Database;
}

function d1Statement(
  sqlite: DatabaseSync,
  query: string,
  parameters: SQLInputValue[] = [],
): D1PreparedStatement {
  return {
    all: async () => ({ results: sqlite.prepare(query).all(...parameters) }),
    bind: (...values: unknown[]) => d1Statement(sqlite, query, values as SQLInputValue[]),
    raw: async () => {
      const statement = sqlite.prepare(query);
      statement.setReturnArrays(true);
      return statement.all(...parameters);
    },
    run: async () => sqlite.prepare(query).run(...parameters),
  } as unknown as D1PreparedStatement;
}
