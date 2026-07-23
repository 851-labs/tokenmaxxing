import { Effect, Option } from "effect";
import { describe, expect, it, vi } from "vitest";

import { UserNotFound } from "@tokenmaxxing/api-contract";
import type { ProfileDailyResponse, ProfileResponse } from "@tokenmaxxing/api-contract";

import { makeProfilesService, profileDailyRange, ProfilesRepository } from "./service";

describe("profileDailyRange", () => {
  const now = new Date("2026-06-21T23:30:00.000Z");

  it("defaults profile charts to 2026 year-to-date in UTC", () => {
    expect(profileDailyRange({}, now)).toEqual({
      first: "2026-01-01",
      last: "2026-06-21",
    });
  });

  it("uses explicit query bounds as the response chart range", () => {
    expect(
      profileDailyRange(
        {
          since: "2026-06-20",
          until: "2026-06-22",
        },
        now,
      ),
    ).toEqual({
      first: "2026-06-20",
      last: "2026-06-22",
    });
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
  topModel: { model: "gpt-5", spendUsd: 2 },
  totalSpendUsd: 2,
  totalTokens: 100,
};

interface TestProfilesService {
  getProfile(
    login: string,
    viewerUserId: string | null,
  ): Effect.Effect<typeof ProfileResponse.Type, UserNotFound>;
  getDaily(
    login: string,
    query: { groupBy: "model"; since?: string; until?: string },
    viewerUserId: string | null,
  ): Effect.Effect<typeof ProfileDailyResponse.Type, UserNotFound>;
}

async function makeProfileService(
  shadowBanned: boolean,
  onLeaderboardRank?: (input: { since: string | null; userId: string }) => void,
): Promise<TestProfilesService> {
  return (await Effect.runPromise(
    makeProfilesService().pipe(
      Effect.provideService(ProfilesRepository, {
        daily: () =>
          Effect.succeed([
            {
              costUsd: 2,
              date: "2026-06-21",
              key: "gpt-5",
              outputTokens: 20,
              totalTokens: 100,
            },
          ]),
        findUserByLogin: (login) =>
          Effect.succeed(
            login === "target"
              ? Option.some({
                  shadowBanned,
                  user: {
                    avatarUrl: null,
                    id: "user_target",
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
  )) as unknown as TestProfilesService;
}

describe("ProfilesService shadow-ban visibility", () => {
  it("calculates rank with the default 30-day leaderboard window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-12T22:30:00Z"));
    let rankInput: { since: string | null; userId: string } | undefined;

    try {
      const service = await makeProfileService(false, (input) => {
        rankInput = input;
      });

      await Effect.runPromise(service.getProfile("target", null));

      expect(rankInput).toEqual({ since: "2026-05-14", userId: "user_target" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps visible profiles public", async () => {
    const service = await makeProfileService(false);

    await expect(Effect.runPromise(service.getProfile("target", null))).resolves.toMatchObject({
      stats: { leaderboardRank: 7 },
      user: { id: "user_target", login: "target" },
    });
  });

  it("returns not found for anonymous and other viewers of a banned profile", async () => {
    const service = await makeProfileService(true);

    await expect(Effect.runPromise(service.getProfile("target", null))).rejects.toBeInstanceOf(
      UserNotFound,
    );
    await expect(
      Effect.runPromise(service.getDaily("target", { groupBy: "model" }, "user_other")),
    ).rejects.toBeInstanceOf(UserNotFound);
  });

  it("returns the normal profile and daily data to the banned owner", async () => {
    const service = await makeProfileService(true);

    await expect(
      Effect.runPromise(service.getProfile("target", "user_target")),
    ).resolves.toMatchObject({ stats: { totalTokens: 100 }, user: { login: "target" } });
    await expect(
      Effect.runPromise(service.getDaily("target", { groupBy: "model" }, "user_target")),
    ).resolves.toMatchObject({ days: [{ totalTokens: 100 }] });
  });
});
