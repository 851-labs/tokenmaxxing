import { describe, expect, it } from "vite-plus/test";

import { usageStreaks } from "./streaks";

const today = "2026-06-06";

describe("usageStreaks", () => {
  it("returns zero streaks for an empty profile", () => {
    expect(usageStreaks([], today)).toEqual({ currentStreakDays: 0, longestStreakDays: 0 });
  });

  it("deduplicates dates and finds longest plus current streak", () => {
    expect(
      usageStreaks(
        ["2026-06-01", "2026-06-01", "2026-06-02", "2026-06-04", "2026-06-05", "2026-06-06"],
        today,
      ),
    ).toEqual({ currentStreakDays: 3, longestStreakDays: 3 });
  });

  it("keeps the current streak distinct from the longest streak", () => {
    expect(
      usageStreaks(["2026-06-01", "2026-06-02", "2026-06-03", "2026-06-05", "2026-06-06"], today),
    ).toEqual({ currentStreakDays: 2, longestStreakDays: 3 });
  });

  it("sorts unordered input", () => {
    expect(usageStreaks(["2026-06-06", "2026-06-04", "2026-06-05"], today)).toEqual({
      currentStreakDays: 3,
      longestStreakDays: 3,
    });
  });

  it("keeps a streak alive through yesterday in the earliest timezone", () => {
    // UTC today is 06-06; a UTC-12 user may still be on 06-05 and not have
    // used anything yet, so a run ending 06-04 is still their current streak.
    expect(usageStreaks(["2026-06-03", "2026-06-04"], today)).toEqual({
      currentStreakDays: 2,
      longestStreakDays: 2,
    });
  });

  it("drops a lapsed streak to zero but keeps the longest", () => {
    expect(usageStreaks(["2026-06-01", "2026-06-02", "2026-06-03"], today)).toEqual({
      currentStreakDays: 0,
      longestStreakDays: 3,
    });
  });

  it("counts tomorrow's key from timezones ahead of UTC", () => {
    expect(usageStreaks(["2026-06-05", "2026-06-06", "2026-06-07"], today)).toEqual({
      currentStreakDays: 3,
      longestStreakDays: 3,
    });
  });

  it("ignores keys beyond the ingest ceiling instead of extending streaks", () => {
    expect(usageStreaks(["2026-06-06", "2026-06-08", "9999-12-31"], today)).toEqual({
      currentStreakDays: 1,
      longestStreakDays: 1,
    });
  });

  it("walks month, year, and leap-day boundaries without Date parsing", () => {
    expect(
      usageStreaks(["2024-02-27", "2024-02-28", "2024-02-29", "2024-03-01"], "2024-03-01"),
    ).toEqual({ currentStreakDays: 4, longestStreakDays: 4 });
    expect(usageStreaks(["2025-02-28", "2025-03-01"], "2025-03-01")).toEqual({
      currentStreakDays: 2,
      longestStreakDays: 2,
    });
    expect(usageStreaks(["2025-12-30", "2025-12-31", "2026-01-01"], "2026-01-01")).toEqual({
      currentStreakDays: 3,
      longestStreakDays: 3,
    });
  });

  it("ignores malformed legacy keys instead of throwing", () => {
    expect(
      usageStreaks(
        ["", "garbage", "2026-13-01", "2026-02-30", "2026-6-5", "2026-06-05T00:00", "2026-06-06"],
        today,
      ),
    ).toEqual({ currentStreakDays: 1, longestStreakDays: 1 });
  });

  it("returns zeros when today is not a valid key", () => {
    expect(usageStreaks(["2026-06-06"], "not-a-date")).toEqual({
      currentStreakDays: 0,
      longestStreakDays: 0,
    });
  });
});
