import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import type { ProfileResponse } from "@tokenmaxxing/api-contract";

import { ProfileOgCard, SiteOgCard } from "./og-cards";
import { formatTokens, formatUsd } from "../../../lib/format";

type Profile = typeof ProfileResponse.Type;

describe("OG cards", () => {
  it("formats profile values exactly like the profile page", () => {
    const html = renderToStaticMarkup(
      createElement(ProfileOgCard, { data: { profile: profile() } }),
    );

    expect(html).toContain(`>${formatUsd(123.45)}<`);
    expect(html).toContain(`>${formatTokens(987_654)}<`);
  });

  it("renders the site-wide card", () => {
    const html = renderToStaticMarkup(createElement(SiteOgCard));

    expect(html).toContain('id="og-card"');
    expect(html).toContain("The best place to track token usage");
    expect(html).toContain("tokenmaxxing bootstrap");
  });
});

function profile(): Profile {
  return {
    stats: {
      activeDays: 7,
      avgSpendPerActiveDay: 12.34,
      currentStreakDays: 3,
      deviceCount: 2,
      firstDate: "2026-01-01",
      lastDate: "2026-06-21",
      leaderboardRank: 7,
      longestStreakDays: 12,
      peakDay: { date: "2026-06-20", spendUsd: 42 },
      sessionCount: 14,
      sources: ["claude", "codex"],
      topModel: { model: "claude-opus", spendUsd: 42 },
      spendUsd: 123.45,
      totalTokens: 987_654,
    },
    user: { avatarUrl: null, login: "pondorasti", name: null },
  };
}
