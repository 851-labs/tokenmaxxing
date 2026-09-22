import { Effect, Layer } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { makeTestDatabase, type TestDatabase } from "../testing/sqlite-d1";
import { buildService } from "../testing/effect";
import { seedSourceStats, seedUsage, seedUser } from "../testing/seed";
import { ProfilesRepositoryLive } from "./d1";
import { ProfilesRepository } from "./service";

// Just after the fixtures' last active day, so the latest run is still current.
const statsWindow = { today: "2026-07-07", until: "2026-07-08" };
const until = statsWindow.until;

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
        topModel: null,
        totalSpendUsd: 0,
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
        topModel: { model: "gpt-5", spendUsd: 8 },
        totalSpendUsd: 12,
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

      const rows = await Effect.runPromise(repository.daily("user", { groupBy: "model", until }));

      expect(rows.map((row) => [row.date, row.key, row.costUsd])).toEqual([
        ["2026-07-01", "gpt-5", 1],
        ["2026-07-01", "o3", 2],
        ["2026-07-02", "gpt-5", 8],
        ["2026-07-02", "opus", 4],
        ["2026-07-03", "gpt-5", 16],
      ]);
      expect(rows[0]).toEqual({
        costUsd: 1,
        date: "2026-07-01",
        key: "gpt-5",
        outputTokens: 1,
        totalTokens: 10,
      });
    });

    it("groups by source", async () => {
      const repository = await makeRepository();

      const rows = await Effect.runPromise(repository.daily("user", { groupBy: "source", until }));

      expect(rows.map((row) => [row.date, row.key, row.costUsd, row.totalTokens])).toEqual([
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
        repository.daily("user", { groupBy: "source", until: "2026-07-01" }),
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
