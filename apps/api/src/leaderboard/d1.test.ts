import { Effect, Layer } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { ProfilesRepositoryLive } from "../profiles/d1";
import { ProfilesRepository } from "../profiles/service";
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
    // Inserted out of id order so ties cannot pass by insertion order. Seeded
    // logins equal ids, and public rows only carry the login.
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

    expect(bySpend.map((entry) => [entry.rank, entry.user.login])).toEqual([
      [1, "bravo"],
      [2, "charlie"],
      [3, "alpha"],
    ]);
    expect(byTokens.map((entry) => entry.user.login)).toEqual(["alpha", "charlie", "bravo"]);
  });

  it("breaks ties by ascending user id", async () => {
    for (const id of ["delta", "bravo", "charlie", "alpha"]) {
      usage(id, "2026-07-01", 5, 50);
    }
    const leaderboard = await makeLeaderboard();

    const entries = await Effect.runPromise(
      leaderboard.list({ limit: 10, metric: "spend", since: null, until }),
    );

    expect(entries.map((entry) => entry.user.login)).toEqual([
      "alpha",
      "bravo",
      "charlie",
      "delta",
    ]);
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

    expect(entries.map((entry) => entry.user.login)).toEqual(["bravo", "charlie"]);
  });

  it("skips the first `offset` ranks and keeps later ranks", async () => {
    usage("alpha", "2026-07-01", 1, 1);
    usage("bravo", "2026-07-01", 4, 4);
    usage("charlie", "2026-07-01", 3, 3);
    usage("delta", "2026-07-01", 2, 2);
    const leaderboard = await makeLeaderboard();

    const second = await Effect.runPromise(
      leaderboard.list({ limit: 2, metric: "spend", offset: 2, since: null, until }),
    );
    const past = await Effect.runPromise(
      leaderboard.list({ limit: 2, metric: "spend", offset: 4, since: null, until }),
    );

    expect(second.map((entry) => [entry.rank, entry.user.login])).toEqual([
      [3, "delta"],
      [4, "alpha"],
    ]);
    expect(past).toEqual([]);
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
        user: expect.objectContaining({ login: "bravo" }),
      }),
      expect.objectContaining({
        activeDays: 1,
        lastDate: "2026-07-01",
        rank: 2,
        spendUsd: 1,
        totalTokens: 1,
        user: expect.objectContaining({ login: "alpha" }),
      }),
    ]);
  });

  it("ranks ties identically on the leaderboard and profiles", async () => {
    for (const id of ["delta", "bravo", "charlie", "alpha"]) {
      usage(id, "2026-07-01", 5, 50);
    }
    const leaderboard = await makeLeaderboard();
    const profiles = await buildService(
      ProfilesRepository,
      ProfilesRepositoryLive.pipe(Layer.provide(database.drizzleLayer)),
    );

    const entries = await Effect.runPromise(
      leaderboard.list({ limit: 10, metric: "spend", since: null, until }),
    );
    const profileRanks = await Promise.all(
      entries.map((entry) =>
        Effect.runPromise(
          profiles.leaderboardRank({ since: null, until, userId: entry.user.login }),
        ),
      ),
    );

    expect(entries.map((entry) => entry.user.login)).toEqual([
      "alpha",
      "bravo",
      "charlie",
      "delta",
    ]);
    expect(profileRanks).toEqual(entries.map((entry) => entry.rank));
  });

  it("counts the ranked users and finds one user's rank on the same board", async () => {
    usage("alpha", "2026-06-30", 100, 100);
    usage("bravo", "2026-07-01", 4, 4);
    usage("charlie", "2026-07-01", 3, 3);
    usage("delta", "2026-07-01", 2, 2);
    seedUser(database.sqlite, { id: "banned", shadowBannedAt: 1 });
    usage("banned", "2026-07-01", 1_000, 1_000);
    const leaderboard = await makeLeaderboard();
    const summary = (userId: string | null, since: string | null = null) =>
      Effect.runPromise(leaderboard.summary({ metric: "spend", since, until, userId }));
    const board = await Effect.runPromise(
      leaderboard.list({ limit: 10, metric: "spend", since: null, until }),
    );

    // Every ranked user's summary rank matches their leaderboard row.
    for (const entry of board) {
      expect(await summary(entry.user.login)).toEqual({ total: 4, userRank: entry.rank });
    }
    expect(board.map((entry) => entry.user.login)).not.toContain("banned");
    expect(await summary("banned")).toEqual({ total: 4, userRank: null });
    expect(await summary(null)).toEqual({ total: 4, userRank: null });
    // alpha's only usage falls before the window.
    expect(await summary("alpha", "2026-07-01")).toEqual({ total: 3, userRank: null });
    expect(await summary("delta", "2026-07-01")).toEqual({ total: 3, userRank: 3 });
    expect(await summary(null, "2027-01-01")).toEqual({ total: 0, userRank: null });
  });
});
