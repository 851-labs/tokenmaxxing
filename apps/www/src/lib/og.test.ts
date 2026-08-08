import { describe, expect, it } from "vitest";
import type { ProfileResponse } from "@tokenmaxxing/api-contract";

import {
  profileOgDescription,
  profileOgImagePath,
  profileOgImageUrl,
  profileOgVersion,
  profileUrl,
} from "./og";

type Profile = typeof ProfileResponse.Type;

describe("profile OG helpers", () => {
  it("fingerprints profile stats that affect the card", () => {
    const base = profile({
      activeDays: 7,
      lastDate: "2026-06-21",
      totalSpendUsd: 123.45,
      totalTokens: 987_654,
    });

    expect(profileOgVersion(base)).toBe("2026-06-21-12345-987654-7-owner.starred-s4");
    expect(
      profileOgVersion(
        profile({
          activeDays: 8,
          lastDate: "2026-06-21",
          totalSpendUsd: 123.45,
          totalTokens: 987_654,
        }),
      ),
    ).not.toBe(profileOgVersion(base));
  });

  it("builds sane metadata for an empty profile", () => {
    const empty = profile({
      activeDays: 0,
      lastDate: null,
      totalSpendUsd: 0,
      totalTokens: 0,
    });

    expect(profileOgDescription(empty)).toBe("pondorasti has not synced usage yet.");
    expect(profileOgImagePath(empty)).toBe("/og/pondorasti.png?v=none-0-0-0-owner.starred-s4");
  });

  it("encodes logins in image and profile URLs", () => {
    const subject = profile({ login: "alex test" });

    expect(profileOgImageUrl(subject, "https://example.com")).toBe(
      "https://example.com/og/alex%20test.png?v=2026-06-21-12345-987654-7-owner.starred-s4",
    );
    expect(profileUrl(subject, "https://example.com")).toBe("https://example.com/alex%20test");
  });
});

function profile({
  activeDays = 7,
  lastDate = "2026-06-21",
  login = "pondorasti",
  totalSpendUsd = 123.45,
  totalTokens = 987_654,
}: {
  activeDays?: number;
  lastDate?: string | null;
  login?: string;
  totalSpendUsd?: number;
  totalTokens?: number;
} = {}): Profile {
  return {
    badges: ["owner", "starred"],
    stats: {
      activeDays,
      avgSpendPerActiveDay: activeDays === 0 ? 0 : totalSpendUsd / activeDays,
      currentStreakDays: activeDays === 0 ? 0 : 3,
      deviceCount: activeDays === 0 ? 0 : 2,
      firstDate: activeDays === 0 ? null : "2026-01-01",
      lastDate,
      leaderboardRank: activeDays === 0 ? null : 7,
      longestStreakDays: activeDays === 0 ? 0 : 12,
      peakDay: activeDays === 0 ? null : { date: "2026-06-20", spendUsd: 42 },
      sessionCount: activeDays === 0 ? 0 : 14,
      sources: activeDays === 0 ? [] : ["claude", "codex"],
      topModel: activeDays === 0 ? null : { model: "claude-opus", spendUsd: 42 },
      totalSpendUsd,
      totalTokens,
    },
    user: {
      avatarUrl: "https://github.com/pondorasti.png",
      id: "user_123",
      login,
      name: null,
    },
  };
}
