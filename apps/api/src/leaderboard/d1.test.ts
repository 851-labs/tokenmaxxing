import { Effect, Layer } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { ProfilesRepositoryLive } from "../profiles/d1";
import { ProfilesRepository } from "../profiles/service";
import { StatsRepositoryLive } from "../stats/d1";
import { StatsRepository } from "../stats/service";
import { makeTestDatabase, type TestDatabase } from "../testing/sqlite-d1";
import { buildService } from "../testing/effect";
import { seedUsage, seedUser } from "../testing/seed";
import { LeaderboardRepositoryLive } from "./d1";
import { LeaderboardRepository } from "./service";

const until = "2026-12-31";

describe("D1 leaderboard ranking", () => {
  let database: TestDatabase;

  beforeEach(() => {
    database = makeTestDatabase();
    // Inserted out of id order so ties cannot pass by insertion order.
    for (const id of ["delta", "charlie", "bravo", "alpha"]) {
      seedUser(database.sqlite, { id });
    }
  });

  afterEach(() => database.close());

  function usage(userId: string, date: string, costUsd: number, totalTokens: number) {
    seedUsage(database.sqlite, {
      costUsd,
      date,
      deviceId: `${userId}-device`,
      totalTokens,
      userId,
    });
  }

  function makeLeaderboard() {
    return buildService(
      LeaderboardRepository,
      LeaderboardRepositoryLive.pipe(Layer.provide(database.drizzleLayer)),
    );
  }

  it("orders by the chosen metric", async () => {
    usage("alpha", "2026-07-01", 1, 400);
    usage("bravo", "2026-07-01", 3, 100);
    usage("charlie", "2026-07-01", 2, 300);
    const leaderboard = await makeLeaderboard();

    const bySpend = await Effect.runPromise(
      leaderboard.list({ limit: 10, metric: "spend", since: null, until }),
    );
    const byTokens = await Effect.runPromise(
      leaderboard.list({ limit: 10, metric: "tokens", since: null, until }),
    );

    expect(bySpend.map((entry) => [entry.rank, entry.user.id])).toEqual([
      [1, "bravo"],
      [2, "charlie"],
      [3, "alpha"],
    ]);
    expect(byTokens.map((entry) => entry.user.id)).toEqual(["alpha", "charlie", "bravo"]);
  });

  it("breaks ties by ascending user id", async () => {
    for (const id of ["delta", "bravo", "charlie", "alpha"]) {
      usage(id, "2026-07-01", 5, 50);
    }
    const leaderboard = await makeLeaderboard();

    const entries = await Effect.runPromise(
      leaderboard.list({ limit: 10, metric: "spend", since: null, until }),
    );

    expect(entries.map((entry) => entry.user.id)).toEqual(["alpha", "bravo", "charlie", "delta"]);
  });

  it("applies the limit after ordering", async () => {
    usage("alpha", "2026-07-01", 1, 1);
    usage("bravo", "2026-07-01", 4, 4);
    usage("charlie", "2026-07-01", 3, 3);
    usage("delta", "2026-07-01", 2, 2);
    const leaderboard = await makeLeaderboard();

    const entries = await Effect.runPromise(
      leaderboard.list({ limit: 2, metric: "spend", since: null, until }),
    );

    expect(entries.map((entry) => entry.user.id)).toEqual(["bravo", "charlie"]);
  });

  it("windows usage by an inclusive since date", async () => {
    usage("alpha", "2026-06-30", 100, 100);
    usage("alpha", "2026-07-01", 1, 1);
    usage("bravo", "2026-07-02", 2, 2);
    usage("charlie", "2026-06-29", 50, 50);
    const leaderboard = await makeLeaderboard();

    const entries = await Effect.runPromise(
      leaderboard.list({ limit: 10, metric: "spend", since: "2026-07-01", until }),
    );

    expect(entries).toEqual([
      expect.objectContaining({
        activeDays: 1,
        lastDate: "2026-07-02",
        rank: 1,
        spendUsd: 2,
        user: expect.objectContaining({ id: "bravo" }),
      }),
      expect.objectContaining({
        activeDays: 1,
        lastDate: "2026-07-01",
        rank: 2,
        spendUsd: 1,
        totalTokens: 1,
        user: expect.objectContaining({ id: "alpha" }),
      }),
    ]);
  });

  it("ranks ties identically on the leaderboard, profiles and stats top users", async () => {
    for (const id of ["delta", "bravo", "charlie", "alpha"]) {
      usage(id, "2026-07-01", 5, 50);
    }
    const leaderboard = await makeLeaderboard();
    const profiles = await buildService(
      ProfilesRepository,
      ProfilesRepositoryLive.pipe(Layer.provide(database.drizzleLayer)),
    );
    const stats = await buildService(
      StatsRepository,
      StatsRepositoryLive.pipe(Layer.provide(database.drizzleLayer)),
    );

    const entries = await Effect.runPromise(
      leaderboard.list({ limit: 10, metric: "spend", since: null, until }),
    );
    const snapshot = await Effect.runPromise(
      stats.snapshot({ last30dSince: "2026-06-01", limit: 10, until }),
    );
    const profileRanks = await Promise.all(
      entries.map((entry) =>
        Effect.runPromise(profiles.leaderboardRank({ since: null, until, userId: entry.user.id })),
      ),
    );

    const leaderboardOrder = entries.map((entry) => entry.user.id);
    expect(snapshot.topUsers.bySpend.map((row) => row.user.id)).toEqual(leaderboardOrder);
    expect(snapshot.topUsers.byTokens.map((row) => row.user.id)).toEqual(leaderboardOrder);
    expect(profileRanks).toEqual(entries.map((entry) => entry.rank));
  });
});
