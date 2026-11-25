import { describe, expect, it } from "vite-plus/test";
import type { ProfileResponse } from "@tokenmaxxing/api-contract";

import { profilePageSchema } from "./jsonld";

type Profile = typeof ProfileResponse.Type;

describe("profilePageSchema", () => {
  it("links the stored GitHub account, not the tokenmaxxing username", () => {
    const schema = profilePageSchema(profile({ githubLogin: "Bob", login: "bob-2" }));

    expect(schema.mainEntity).toMatchObject({
      identifier: "bob-2",
      sameAs: ["https://github.com/Bob"],
      url: "https://tokenmaxxing.sh/bob-2",
    });
  });

  it("omits sameAs when no GitHub account is linked", () => {
    const schema = profilePageSchema(profile({ githubLogin: null, login: "carol" }));

    expect(schema.mainEntity).not.toHaveProperty("sameAs");
  });
});

function profile(user: { githubLogin: string | null; login: string }): Profile {
  return {
    stats: {
      activeDays: 0,
      avgSpendPerActiveDay: 0,
      currentStreakDays: 0,
      deviceCount: 0,
      firstDate: null,
      lastDate: null,
      leaderboardRank: null,
      longestStreakDays: 0,
      peakDay: null,
      sessionCount: 0,
      sources: [],
      spendUsd: 0,
      topModel: null,
      totalTokens: 0,
    },
    user: { avatarUrl: null, name: null, ...user },
  };
}
