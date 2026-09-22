import { describe, expect, it } from "vite-plus/test";

import { leaderboardWindowStart } from "./ranking";

describe("leaderboardWindowStart", () => {
  const now = new Date("2026-06-12T22:30:00Z");

  it("returns null for the all-time window", () => {
    expect(leaderboardWindowStart("all", now)).toBeNull();
  });

  it("covers the trailing 7 calendar days inclusive of today", () => {
    expect(leaderboardWindowStart("7d", now)).toBe("2026-06-06");
  });

  it("covers the trailing 30 calendar days inclusive of today", () => {
    expect(leaderboardWindowStart("30d", now)).toBe("2026-05-14");
  });

  it("produces zero-padded keys that compare lexicographically", () => {
    const start = leaderboardWindowStart("30d", new Date("2026-01-05T03:00:00Z"));
    expect(start).toBe("2025-12-07");
    // The whole windowing scheme rests on string comparison matching date
    // order for zero-padded ISO days.
    expect(start !== null && start < "2026-01-05").toBe(true);
  });
});
