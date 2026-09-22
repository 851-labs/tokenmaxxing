import type { DatabaseSync } from "node:sqlite";

import { Effect, Layer } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { LeaderboardRepositoryLive } from "./leaderboard/d1";
import { LeaderboardRepository } from "./leaderboard/service";
import { ProfilesRepositoryLive } from "./profiles/d1";
import { ProfilesRepository } from "./profiles/service";
import { StatsRepositoryLive } from "./stats/d1";
import { StatsRepository } from "./stats/service";
import { makeTestDatabase, type TestDatabase } from "./testing/sqlite-d1";
import { buildService } from "./testing/effect";
import { seedUsage, seedUser } from "./testing/seed";

const until = "2026-09-23";

describe("public usage visibility", () => {
  let database: TestDatabase;
  let sqlite: DatabaseSync;

  beforeEach(() => {
    database = makeTestDatabase();
    sqlite = database.sqlite;

    seedUser(sqlite, { id: "visible" });
    seedUser(sqlite, { id: "banned", shadowBannedAt: 1, shadowBannedByUserId: "admin" });

    seedUsage(sqlite, {
      costUsd: 1,
      date: "2026-07-09",
      deviceId: "visible-device",
      model: "visible-model",
      source: "codex",
      totalTokens: 100,
      userId: "visible",
    });
    seedUsage(sqlite, {
      costUsd: 100,
      date: "2026-07-09",
      deviceId: "banned-device",
      model: "fake-model",
      source: "fake-source",
      totalTokens: 10_000,
      userId: "banned",
    });
  });

  afterEach(() => database.close());

  it("excludes banned usage from every leaderboard and stats branch, then restores it", async () => {
    const leaderboard = await buildService(
      LeaderboardRepository,
      LeaderboardRepositoryLive.pipe(Layer.provide(database.drizzleLayer)),
    );
    const stats = await buildService(
      StatsRepository,
      StatsRepositoryLive.pipe(Layer.provide(database.drizzleLayer)),
    );
    const profiles = await buildService(
      ProfilesRepository,
      ProfilesRepositoryLive.pipe(Layer.provide(database.drizzleLayer)),
    );

    const entries = await Effect.runPromise(
      leaderboard.list({ limit: 10, metric: "tokens", since: null, until }),
    );
    const visibleRank = await Effect.runPromise(
      profiles.leaderboardRank({ since: "2026-06-10", until, userId: "visible" }),
    );
    const bannedRank = await Effect.runPromise(
      profiles.leaderboardRank({ since: "2026-06-10", until, userId: "banned" }),
    );
    const hidden = await Effect.runPromise(
      stats.snapshot({ last30dSince: "2026-06-10", limit: 10, until }),
    );

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

    const restoredBannedRank = await Effect.runPromise(
      profiles.leaderboardRank({ since: "2026-06-10", until, userId: "banned" }),
    );
    const restoredVisibleRank = await Effect.runPromise(
      profiles.leaderboardRank({ since: "2026-06-10", until, userId: "visible" }),
    );
    const restored = await Effect.runPromise(
      stats.snapshot({ last30dSince: "2026-06-10", limit: 10, until }),
    );
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
    seedUsage(sqlite, {
      costUsd: 1000,
      date: "2026-05-01",
      deviceId: "visible-old-device",
      model: "visible-model",
      source: "codex",
      totalTokens: 1,
      userId: "visible",
    });

    const profiles = await buildService(
      ProfilesRepository,
      ProfilesRepositoryLive.pipe(Layer.provide(database.drizzleLayer)),
    );

    const allTimeVisibleRank = await Effect.runPromise(
      profiles.leaderboardRank({ since: null, until, userId: "visible" }),
    );
    const recentVisibleRank = await Effect.runPromise(
      profiles.leaderboardRank({ since: "2026-06-10", until, userId: "visible" }),
    );
    const recentBannedRank = await Effect.runPromise(
      profiles.leaderboardRank({ since: "2026-06-10", until, userId: "banned" }),
    );

    expect(allTimeVisibleRank).toBe(1);
    expect(recentVisibleRank).toBe(2);
    expect(recentBannedRank).toBe(1);
  });

  it("exposes only public user fields, and no rank on stats top users", async () => {
    seedUser(sqlite, {
      avatarUrl: "https://avatar.example/tied",
      id: "tied",
      login: "tied",
      name: "Tied",
    });
    seedUsage(sqlite, {
      costUsd: 1,
      date: "2026-07-08",
      deviceId: "tied-device",
      model: "visible-model",
      source: "codex",
      totalTokens: 100_000,
      userId: "tied",
    });
    const leaderboard = await buildService(
      LeaderboardRepository,
      LeaderboardRepositoryLive.pipe(Layer.provide(database.drizzleLayer)),
    );
    const stats = await buildService(
      StatsRepository,
      StatsRepositoryLive.pipe(Layer.provide(database.drizzleLayer)),
    );

    const [first] = await Effect.runPromise(
      leaderboard.list({ limit: 10, metric: "tokens", since: "2026-06-10", until }),
    );
    const snapshot = await Effect.runPromise(
      stats.snapshot({ last30dSince: "2026-06-10", limit: 10, until }),
    );
    const user = {
      avatarUrl: "https://avatar.example/tied",
      id: "tied",
      login: "tied",
      name: "Tied",
    };

    expect(first).toEqual({
      activeDays: 1,
      lastDate: "2026-07-08",
      rank: 1,
      spendUsd: 1,
      totalTokens: 100_000,
      user,
    });
    expect(snapshot.topUsers.byTokens[0]).toEqual({
      activeDays: 1,
      lastDate: "2026-07-08",
      spendUsd: 1,
      totalTokens: 100_000,
      user,
    });
  });
});

describe("future-dated usage rows", () => {
  let database: TestDatabase;

  beforeEach(() => {
    database = makeTestDatabase();
    const { sqlite } = database;
    seedUser(sqlite, { id: "honest" });
    seedUser(sqlite, { id: "timetraveler" });
    const usage = (deviceId: string, userId: string, date: string, tokens: number, cost: number) =>
      seedUsage(sqlite, {
        costUsd: cost,
        date,
        deviceId,
        model: "gpt-5",
        totalTokens: tokens,
        userId,
      });
    usage("honest-device", "honest", "2026-09-20", 100, 10);
    usage("tt-device", "timetraveler", "2026-09-20", 1, 1);
    usage("tt-device", "timetraveler", "9999-12-31", 1_000_000, 1_000_000);
  });

  afterEach(() => database.close());

  it("never counts rows after the ceiling in any window, stat, or profile", async () => {
    const leaderboard = await buildService(
      LeaderboardRepository,
      LeaderboardRepositoryLive.pipe(Layer.provide(database.drizzleLayer)),
    );
    const stats = await buildService(
      StatsRepository,
      StatsRepositoryLive.pipe(Layer.provide(database.drizzleLayer)),
    );
    const profiles = await buildService(
      ProfilesRepository,
      ProfilesRepositoryLive.pipe(Layer.provide(database.drizzleLayer)),
    );

    for (const since of [null, "2026-08-25", "2026-09-17"]) {
      const entries = await Effect.runPromise(
        leaderboard.list({ limit: 10, metric: "spend", since, until }),
      );
      expect(entries.map((entry) => [entry.user.login, entry.spendUsd])).toEqual([
        ["honest", 10],
        ["timetraveler", 1],
      ]);
      expect(
        await Effect.runPromise(profiles.leaderboardRank({ since, until, userId: "honest" })),
      ).toBe(1);
    }

    const snapshot = await Effect.runPromise(
      stats.snapshot({ last30dSince: "2026-08-25", limit: 10, until }),
    );
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

    const profile = await Effect.runPromise(
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
    const daily = await Effect.runPromise(
      profiles.daily("timetraveler", { groupBy: "model", until: "2026-09-23" }),
    );
    expect(daily.map((row) => row.date)).toEqual(["2026-09-20"]);
  });
});
