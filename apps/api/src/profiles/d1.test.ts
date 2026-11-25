import { Effect, Layer, Option } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { makeTestDatabase, type TestDatabase } from "../testing/sqlite-d1";
import { buildService } from "../testing/effect";
import { seedAccount, seedLoginAlias, seedSourceStats, seedUsage, seedUser } from "../testing/seed";
import { ProfilesRepositoryLive } from "./d1";
import { ProfilesRepository } from "./service";

// Just after the fixtures' last active day, so the latest run is still current.
const statsWindow = { today: "2026-07-07", until: "2026-07-08" };
const until = statsWindow.until;
const since = "2026-01-01";

describe("D1 profiles repository", () => {
  let database: TestDatabase;

  beforeEach(() => {
    database = makeTestDatabase();
    seedUser(database.sqlite, { id: "user" });
    seedUser(database.sqlite, { id: "other" });
  });

  afterEach(() => database.close());

  function makeRepository() {
    return buildService(
      ProfilesRepository,
      ProfilesRepositoryLive.pipe(Layer.provide(database.drizzleLayer)),
    );
  }

  function usage(
    deviceId: string,
    date: string,
    source: string,
    model: string,
    costUsd: number,
    totalTokens = 10,
    userId = "user",
  ) {
    seedUsage(database.sqlite, {
      costUsd,
      date,
      deviceId,
      model,
      outputTokens: 1,
      source,
      totalTokens,
      userId,
    });
  }

  describe("stats", () => {
    it("returns empty stats for a user without usage", async () => {
      const repository = await makeRepository();

      expect(await Effect.runPromise(repository.stats("user", statsWindow))).toEqual({
        activeDays: 0,
        avgSpendPerActiveDay: 0,
        currentStreakDays: 0,
        deviceCount: 0,
        firstDate: null,
        lastDate: null,
        longestStreakDays: 0,
        peakDay: null,
        sessionCount: 0,
        sources: [],
        spendUsd: 0,
        topModel: null,
        totalTokens: 0,
      });
    });

    it("aggregates totals, peak day, top model, sources and streaks", async () => {
      usage("laptop", "2026-07-01", "codex", "gpt-5", 1, 100);
      usage("laptop", "2026-07-02", "codex", "gpt-5", 2, 100);
      usage("laptop", "2026-07-02", "claude", "opus", 3, 100);
      usage("desktop", "2026-07-03", "claude", "opus", 1, 100);
      usage("desktop", "2026-07-05", "codex", "gpt-5", 4, 100);
      usage("desktop", "2026-07-06", "codex", "gpt-5", 1, 100);
      usage("elsewhere", "2026-07-04", "codex", "gpt-5", 1_000, 1_000, "other");
      const repository = await makeRepository();

      const stats = await Effect.runPromise(repository.stats("user", statsWindow));

      expect(stats).toMatchObject({
        activeDays: 5,
        avgSpendPerActiveDay: 12 / 5,
        currentStreakDays: 2,
        deviceCount: 2,
        firstDate: "2026-07-01",
        lastDate: "2026-07-06",
        longestStreakDays: 3,
        peakDay: { date: "2026-07-02", spendUsd: 5 },
        sources: ["claude", "codex"],
        spendUsd: 12,
        topModel: { model: "gpt-5", spendUsd: 8 },
        totalTokens: 600,
      });
    });

    it("adds day-level session estimates only for device/sources without reported stats", async () => {
      // laptop/codex reports real session counts; its day rows must not add more.
      seedSourceStats(database.sqlite, {
        deviceId: "laptop",
        sessionCount: 10,
        source: "codex",
        userId: "user",
      });
      usage("laptop", "2026-07-01", "codex", "gpt-5", 1);
      usage("laptop", "2026-07-02", "codex", "gpt-5", 1);
      // laptop/claude has no stats: one estimated session per day, not per model.
      usage("laptop", "2026-07-01", "claude", "opus", 1);
      usage("laptop", "2026-07-01", "claude", "sonnet", 1);
      usage("laptop", "2026-07-02", "claude", "opus", 1);
      // desktop/codex has no stats even though laptop/codex does.
      usage("desktop", "2026-07-01", "codex", "gpt-5", 1);
      seedSourceStats(database.sqlite, {
        deviceId: "elsewhere",
        sessionCount: 99,
        source: "codex",
        userId: "other",
      });
      const repository = await makeRepository();

      const stats = await Effect.runPromise(repository.stats("user", statsWindow));

      expect(stats.sessionCount).toBe(10 + 2 + 1);
    });
  });

  describe("findUserByLogin", () => {
    it("matches logins case-insensitively", async () => {
      seedUser(database.sqlite, { id: "martin", login: "martinxjonsson" });
      const repository = await makeRepository();

      const exact = await Effect.runPromise(repository.findUserByLogin("martinxjonsson"));
      const mixed = await Effect.runPromise(repository.findUserByLogin("MartinXJonsson"));

      expect(Option.map(exact, (found) => found.user.id)).toEqual(Option.some("martin"));
      expect(Option.map(mixed, (found) => found.user.login)).toEqual(Option.some("martinxjonsson"));
      expect(Option.isNone(await Effect.runPromise(repository.findUserByLogin("missing")))).toBe(
        true,
      );
    });

    it("resolves an old login to its owner's current profile, case-insensitively", async () => {
      seedUser(database.sqlite, { id: "alex", login: "alex-dev" });
      seedLoginAlias(database.sqlite, "alex", "alex");
      seedLoginAlias(database.sqlite, "alexander", "alex");
      const repository = await makeRepository();

      const byAlias = await Effect.runPromise(repository.findUserByLogin("Alex"));
      const byOlder = await Effect.runPromise(repository.findUserByLogin("alexander"));
      const byCurrent = await Effect.runPromise(repository.findUserByLogin("alex-dev"));

      for (const found of [byAlias, byOlder, byCurrent]) {
        expect(Option.map(found, ({ user }) => [user.id, user.login])).toEqual(
          Option.some(["alex", "alex-dev"]),
        );
      }
    });

    it("prefers a current login over an alias of the same name", async () => {
      // Only reachable through legacy data: a merge recording a login whose
      // case variant is current elsewhere. The current holder wins.
      seedUser(database.sqlite, { id: "current", login: "sam" });
      seedUser(database.sqlite, { id: "former", login: "sam-new" });
      seedLoginAlias(database.sqlite, "sam", "former");
      const repository = await makeRepository();

      const found = await Effect.runPromise(repository.findUserByLogin("sam"));

      expect(Option.map(found, ({ user }) => user.id)).toEqual(Option.some("current"));
    });

    it("reports the stored GitHub login, not the tokenmaxxing one", async () => {
      seedUser(database.sqlite, { id: "bob", login: "bob-2" });
      seedAccount(database.sqlite, { login: "Bob", providerAccountId: "gh-1", userId: "bob" });
      // A later linked GitHub identity and a Google one never replace the first.
      seedAccount(database.sqlite, {
        createdAt: 5,
        login: "bob-alt",
        providerAccountId: "gh-2",
        userId: "bob",
      });
      seedAccount(database.sqlite, {
        login: null,
        provider: "google",
        providerAccountId: "g-1",
        userId: "bob",
      });
      seedUser(database.sqlite, { id: "carol", login: "carol" });
      seedAccount(database.sqlite, {
        provider: "google",
        providerAccountId: "g-2",
        userId: "carol",
      });
      const repository = await makeRepository();

      const bob = await Effect.runPromise(repository.findUserByLogin("bob-2"));
      const carol = await Effect.runPromise(repository.findUserByLogin("carol"));

      expect(Option.map(bob, (found) => found.githubLogin)).toEqual(Option.some("Bob"));
      expect(Option.map(carol, (found) => found.githubLogin)).toEqual(Option.some(null));
    });
  });

  describe("daily", () => {
    beforeEach(() => {
      usage("laptop", "2026-07-01", "codex", "gpt-5", 1);
      usage("laptop", "2026-07-01", "codex", "o3", 2);
      usage("laptop", "2026-07-02", "claude", "opus", 4);
      usage("unregistered", "2026-07-02", "codex", "gpt-5", 8);
      usage("unregistered", "2026-07-03", "codex", "gpt-5", 16);
      usage("elsewhere", "2026-07-02", "codex", "gpt-5", 1_000, 10, "other");
    });

    it("groups by model, ordered by date then key", async () => {
      const repository = await makeRepository();

      const rows = await Effect.runPromise(
        repository.daily("user", { groupBy: "model", since, until }),
      );

      expect(rows.map((row) => [row.date, row.key, row.spendUsd])).toEqual([
        ["2026-07-01", "gpt-5", 1],
        ["2026-07-01", "o3", 2],
        ["2026-07-02", "gpt-5", 8],
        ["2026-07-02", "opus", 4],
        ["2026-07-03", "gpt-5", 16],
      ]);
      expect(rows[0]).toEqual({
        date: "2026-07-01",
        key: "gpt-5",
        outputTokens: 1,
        spendUsd: 1,
        totalTokens: 10,
      });
    });

    it("groups by source", async () => {
      const repository = await makeRepository();

      const rows = await Effect.runPromise(
        repository.daily("user", { groupBy: "source", since, until }),
      );

      expect(rows.map((row) => [row.date, row.key, row.spendUsd, row.totalTokens])).toEqual([
        ["2026-07-01", "codex", 3, 20],
        ["2026-07-02", "claude", 4, 10],
        ["2026-07-02", "codex", 8, 10],
        ["2026-07-03", "codex", 16, 10],
      ]);
    });

    it("applies since and until as an inclusive window", async () => {
      const repository = await makeRepository();

      const sinceOnly = await Effect.runPromise(
        repository.daily("user", { groupBy: "source", since: "2026-07-02", until }),
      );
      const untilOnly = await Effect.runPromise(
        repository.daily("user", { groupBy: "source", since, until: "2026-07-01" }),
      );
      const both = await Effect.runPromise(
        repository.daily("user", {
          groupBy: "source",
          since: "2026-07-02",
          until: "2026-07-02",
        }),
      );

      expect(sinceOnly.map((row) => row.date)).toEqual(["2026-07-02", "2026-07-02", "2026-07-03"]);
      expect(untilOnly.map((row) => row.date)).toEqual(["2026-07-01"]);
      expect(both.map((row) => [row.date, row.key])).toEqual([
        ["2026-07-02", "claude"],
        ["2026-07-02", "codex"],
      ]);
    });
  });
});
