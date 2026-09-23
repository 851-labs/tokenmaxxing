import { Effect, Option, Result } from "effect";
import { describe, expect, it, vi } from "vite-plus/test";

import { BadRequest, MIN_USAGE_DATE_KEY, UserId, UserNotFound } from "@tokenmaxxing/api-contract";

import { shiftDayKey } from "../date-keys";
import {
  makeProfilesService,
  MAX_DAILY_RANGE_DAYS,
  profileDailyBounds,
  profileDailyRange,
  ProfilesRepository,
} from "./service";

describe("profileDailyBounds", () => {
  const now = new Date("2026-06-21T23:30:00.000Z");
  const bounds = (query: { since?: string; until?: string }, at = now) =>
    Effect.runSync(Effect.result(profileDailyBounds(query, at)));

  it("defaults to the UTC year to date, read up to the ingest ceiling", () => {
    expect(bounds({})).toEqual(Result.succeed({ since: "2026-01-01", until: "2026-06-22" }));
    // On Dec 31 UTC the ceiling is already next year; the default stays on this one.
    expect(bounds({}, new Date("2026-12-31T12:00:00.000Z"))).toEqual(
      Result.succeed({ since: "2026-01-01", until: "2027-01-01" }),
    );
  });

  it("passes explicit bounds within the ceiling through unchanged", () => {
    expect(bounds({ since: "2026-06-20", until: "2026-06-22" })).toEqual(
      Result.succeed({ since: "2026-06-20", until: "2026-06-22" }),
    );
  });

  it("defaults `since` to the start of an explicit past `until`'s year", () => {
    expect(bounds({ until: "2025-03-01" })).toEqual(
      Result.succeed({ since: "2025-01-01", until: "2025-03-01" }),
    );
  });

  it("clamps an absurd range to the ceiling and the ingest floor", () => {
    expect(bounds({ since: "0001-01-01", until: "9999-12-31" })).toEqual(
      Result.succeed({ since: MIN_USAGE_DATE_KEY, until: "2026-06-22" }),
    );
    // A range wholly before the floor collapses onto its `until`, still ordered.
    expect(bounds({ until: "2020-06-01" })).toEqual(
      Result.succeed({ since: "2020-06-01", until: "2020-06-01" }),
    );
  });

  it("caps the span once the floor is further back than the maximum", () => {
    const later = new Date("2031-06-21T12:00:00.000Z");

    expect(bounds({ since: "2024-01-01" }, later)).toEqual(
      Result.succeed({
        since: shiftDayKey("2031-06-22", -(MAX_DAILY_RANGE_DAYS - 1)),
        until: "2031-06-22",
      }),
    );
  });

  it("rejects an inverted range, including one that starts past the ceiling", () => {
    expect(bounds({ since: "2026-06-10", until: "2026-06-01" })).toEqual(
      Result.fail(
        new BadRequest({
          message: "Invalid date range: `since` (2026-06-10) is after `until` (2026-06-01).",
        }),
      ),
    );
    expect(bounds({ since: "9999-01-01" })).toEqual(
      Result.fail(
        new BadRequest({
          message: "Invalid date range: `since` (9999-01-01) is after `until` (2026-06-22).",
        }),
      ),
    );
  });
});

describe("profileDailyRange", () => {
  const now = new Date("2026-06-21T23:30:00.000Z");
  const bounds = { since: "2026-01-01", until: "2026-06-22" };

  it("ends on UTC today when no row is ahead of it", () => {
    expect(profileDailyRange({}, bounds, [{ date: "2026-06-20" }], now)).toEqual({
      firstDate: "2026-01-01",
      lastDate: "2026-06-21",
    });
  });

  it("extends to a row dated on a local day already ahead of UTC", () => {
    expect(
      profileDailyRange({}, bounds, [{ date: "2026-06-21" }, { date: "2026-06-22" }], now),
    ).toEqual({ firstDate: "2026-01-01", lastDate: "2026-06-22" });
  });

  it("never ends before it starts", () => {
    expect(profileDailyRange({}, { since: "2026-06-22", until: "2026-06-22" }, [], now)).toEqual({
      firstDate: "2026-06-22",
      lastDate: "2026-06-22",
    });
  });

  it("echoes an explicit `until` (already capped)", () => {
    expect(
      profileDailyRange(
        { until: "2026-06-22" },
        { since: "2026-06-20", until: "2026-06-22" },
        [],
        now,
      ),
    ).toEqual({ firstDate: "2026-06-20", lastDate: "2026-06-22" });
  });
});

const profileStats = {
  activeDays: 1,
  avgSpendPerActiveDay: 2,
  currentStreakDays: 1,
  deviceCount: 1,
  firstDate: "2026-06-21",
  lastDate: "2026-06-21",
  longestStreakDays: 1,
  peakDay: { date: "2026-06-21", spendUsd: 2 },
  sessionCount: 1,
  sources: ["codex"],
  spendUsd: 2,
  topModel: { model: "gpt-5", spendUsd: 2 },
  totalTokens: 100,
};

async function makeProfileService(
  shadowBanned: boolean,
  onLeaderboardRank?: (input: { since: string | null; userId: string }) => void,
  onDaily?: (query: { since?: string | undefined; until?: string | undefined }) => void,
) {
  return Effect.runPromise(
    makeProfilesService().pipe(
      Effect.provideService(ProfilesRepository, {
        daily: (_userId, query) => {
          onDaily?.(query);
          return Effect.succeed([
            {
              date: "2026-06-21",
              key: "gpt-5",
              outputTokens: 20,
              spendUsd: 2,
              totalTokens: 100,
            },
          ]);
        },
        findUserByLogin: (login) =>
          Effect.succeed(
            login === "target"
              ? Option.some({
                  shadowBanned,
                  user: {
                    avatarUrl: null,
                    id: UserId.make("user_target"),
                    login: "target",
                    name: null,
                  },
                })
              : Option.none(),
          ),
        leaderboardRank: (input) => {
          onLeaderboardRank?.(input);
          return Effect.succeed(7);
        },
        stats: () => Effect.succeed(profileStats),
      }),
    ),
  );
}

describe("ProfilesService shadow-ban visibility", () => {
  it("loads profile identity without calculating stats or rank", async () => {
    const stats = vi.fn(() => Effect.succeed(profileStats));
    const leaderboardRank = vi.fn(() => Effect.succeed(7));
    const service = await Effect.runPromise(
      makeProfilesService().pipe(
        Effect.provideService(ProfilesRepository, {
          daily: () => Effect.succeed([]),
          findUserByLogin: () =>
            Effect.succeed(
              Option.some({
                shadowBanned: false,
                user: {
                  avatarUrl: "https://avatars.githubusercontent.com/u/1?v=4",
                  id: UserId.make("user_target"),
                  login: "target",
                  name: null,
                },
              }),
            ),
          leaderboardRank,
          stats,
        }),
      ),
    );

    await expect(Effect.runPromise(service.getIdentity("target", null))).resolves.toEqual({
      avatarUrl: "https://avatars.githubusercontent.com/u/1?v=4",
      login: "target",
    });
    expect(stats).not.toHaveBeenCalled();
    expect(leaderboardRank).not.toHaveBeenCalled();
  });

  it("calculates rank with the default 30-day leaderboard window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-12T22:30:00Z"));
    let rankInput: { since: string | null; userId: string } | undefined;

    try {
      const service = await makeProfileService(false, (input) => {
        rankInput = input;
      });

      await Effect.runPromise(service.getProfile("target", null));

      expect(rankInput).toEqual({
        since: "2026-05-14",
        until: "2026-06-13",
        userId: "user_target",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps visible profiles public without exposing the internal user id", async () => {
    const service = await makeProfileService(false);
    const profile = await Effect.runPromise(service.getProfile("target", null));

    expect(profile).toMatchObject({ stats: { leaderboardRank: 7 } });
    expect(profile.user).toEqual({ avatarUrl: null, login: "target", name: null });
  });

  it("returns not found for anonymous and other viewers of a banned profile", async () => {
    const service = await makeProfileService(true);

    await expect(Effect.runPromise(service.getIdentity("target", null))).rejects.toBeInstanceOf(
      UserNotFound,
    );
    await expect(
      Effect.runPromise(service.getIdentity("target", UserId.make("user_other"))),
    ).rejects.toBeInstanceOf(UserNotFound);
    await expect(Effect.runPromise(service.getProfile("target", null))).rejects.toBeInstanceOf(
      UserNotFound,
    );
    await expect(
      Effect.runPromise(
        service.getDaily("target", { groupBy: "model" }, UserId.make("user_other")),
      ),
    ).rejects.toBeInstanceOf(UserNotFound);
  });

  it("returns the normal identity, profile, and daily data to the banned owner", async () => {
    const service = await makeProfileService(true);

    await expect(
      Effect.runPromise(service.getIdentity("target", UserId.make("user_target"))),
    ).resolves.toEqual({
      avatarUrl: null,
      login: "target",
    });
    await expect(
      Effect.runPromise(service.getProfile("target", UserId.make("user_target"))),
    ).resolves.toMatchObject({ stats: { totalTokens: 100 }, user: { login: "target" } });
    await expect(
      Effect.runPromise(
        service.getDaily("target", { groupBy: "model" }, UserId.make("user_target")),
      ),
    ).resolves.toMatchObject({ days: [{ totalTokens: 100 }] });
  });
});

describe("ProfilesService.getDaily", () => {
  it("queries exactly the range it reports, from year start to the ceiling", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-21T23:30:00Z"));
    const queries: Array<{ since?: string | undefined; until?: string | undefined }> = [];

    try {
      const service = await makeProfileService(false, undefined, (query) => queries.push(query));
      const response = await Effect.runPromise(
        service.getDaily("target", { groupBy: "model" }, null),
      );

      // The stub's only row is 2026-06-21 (UTC today), so the range ends there.
      expect(response.range).toEqual({ firstDate: "2026-01-01", lastDate: "2026-06-21" });
      expect(queries).toEqual([{ groupBy: "model", since: "2026-01-01", until: "2026-06-22" }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("covers a user whose local today is already ahead of UTC", async () => {
    vi.useFakeTimers();
    // 2026-06-20 UTC, but the stub's row is dated 2026-06-21 (e.g. UTC+12).
    vi.setSystemTime(new Date("2026-06-20T18:00:00Z"));

    try {
      const service = await makeProfileService(false);
      const response = await Effect.runPromise(
        service.getDaily("target", { groupBy: "model" }, null),
      );

      expect(response.days.map((day) => day.date)).toEqual(["2026-06-21"]);
      expect(response.range.lastDate).toBe("2026-06-21");
    } finally {
      vi.useRealTimers();
    }
  });

  it("passes explicit bounds through unchanged", async () => {
    const queries: Array<{ since?: string | undefined; until?: string | undefined }> = [];
    const service = await makeProfileService(false, undefined, (query) => queries.push(query));

    const response = await Effect.runPromise(
      service.getDaily(
        "target",
        { groupBy: "model", since: "2026-06-20", until: "2026-06-22" },
        null,
      ),
    );

    expect(response.range).toEqual({ firstDate: "2026-06-20", lastDate: "2026-06-22" });
    expect(queries).toEqual([{ groupBy: "model", since: "2026-06-20", until: "2026-06-22" }]);
  });

  it("fails an inverted range without querying", async () => {
    const onDaily = vi.fn();
    const service = await makeProfileService(false, undefined, onDaily);

    await expect(
      Effect.runPromise(
        service.getDaily(
          "target",
          { groupBy: "model", since: "2026-06-22", until: "2026-06-20" },
          null,
        ),
      ),
    ).rejects.toBeInstanceOf(BadRequest);
    expect(onDaily).not.toHaveBeenCalled();
  });
});
