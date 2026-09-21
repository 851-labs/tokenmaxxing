import { describe, expect, it } from "vite-plus/test";

import { usageStreaks } from "./streaks";

describe("usageStreaks", () => {
  it("returns zero streaks for an empty profile", () => {
    expect(usageStreaks([])).toEqual({ currentStreakDays: 0, longestStreakDays: 0 });
  });

  it("deduplicates dates and finds longest plus latest streak", () => {
    expect(
      usageStreaks([
        "2026-06-01",
        "2026-06-01",
        "2026-06-02",
        "2026-06-04",
        "2026-06-05",
        "2026-06-06",
      ]),
    ).toEqual({ currentStreakDays: 3, longestStreakDays: 3 });
  });

  it("keeps the latest streak distinct from the longest streak", () => {
    expect(
      usageStreaks(["2026-06-01", "2026-06-02", "2026-06-03", "2026-06-05", "2026-06-06"]),
    ).toEqual({ currentStreakDays: 2, longestStreakDays: 3 });
  });
});
