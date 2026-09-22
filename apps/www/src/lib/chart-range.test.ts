import { describe, expect, it } from "vite-plus/test";

import { calendarDays, chartBuckets, chartRange, shiftDay, weekdayIndex } from "./chart-range";

describe("chart ranges", () => {
  it.each([
    ["2w", "2026-09-08", 14, 1, 14],
    ["1m", "2026-08-23", 30, 1, 30],
    ["2m", "2026-07-24", 60, 1, 60],
    ["3m", "2026-06-24", 90, 2, 46],
    ["6m", "2026-03-26", 180, 3, 61],
  ] as const)(
    "matches Vercel's observed bar count for %s",
    (value, first, count, bucketDays, bars) => {
      const selected = chartRange(value, "2026-09-21", "2026-01-01");
      expect(selected).toEqual({ range: { first, last: "2026-09-21" }, bucketDays });
      expect(calendarDays(selected.range.first, selected.range.last)).toHaveLength(count);
      const buckets = chartBuckets(selected.range, selected.bucketDays);
      expect(buckets).toHaveLength(bars);
      expect(buckets.flatMap((bucket) => calendarDays(bucket.first, bucket.last))).toEqual(
        calendarDays(first, selected.range.last),
      );
    },
  );

  it("adapts Maximum to the available history and excludes future dates", () => {
    expect(chartRange("max", "2026-09-21", "2026-01-01")).toEqual({
      range: { first: "2026-01-01", last: "2026-09-21" },
      bucketDays: 5,
    });
    expect(chartBuckets({ first: "2026-01-01", last: "2026-09-21" }, 5)).toHaveLength(54);
    expect(chartRange("max", "2026-09-21", "2026-09-01").bucketDays).toBe(1);
    expect(chartRange("max", "2026-09-21", "2026-06-01").bucketDays).toBe(2);
    expect(chartRange("max", "2026-09-21", "2026-12-01").range.first).toBe("2026-09-21");
    expect(chartRange("max", "2026-09-21", null).range.first).toBe("2026-09-21");
  });

  it("walks leap days, year boundaries and DST dates as calendar keys", () => {
    expect(shiftDay("2024-03-01", -1)).toBe("2024-02-29");
    expect(shiftDay("2100-03-01", -1)).toBe("2100-02-28");
    expect(shiftDay("2026-01-01", -1)).toBe("2025-12-31");
    expect(calendarDays("2026-03-07", "2026-03-10")).toEqual([
      "2026-03-07",
      "2026-03-08",
      "2026-03-09",
      "2026-03-10",
    ]);
    expect(weekdayIndex("2026-09-21")).toBe(0);
    expect(weekdayIndex("2026-09-20")).toBe(6);
  });

  it("matches Vercel's measured endpoints for longer ranges", () => {
    const threeMonths = chartRange("3m", "2026-09-20", null);
    const threeMonthBuckets = chartBuckets(threeMonths.range, threeMonths.bucketDays);
    expect(threeMonthBuckets.slice(0, 3).map((bucket) => bucket.last)).toEqual([
      "2026-06-23",
      "2026-06-24",
      "2026-06-26",
    ]);
    expect(threeMonthBuckets.at(-1)?.last).toBe("2026-09-20");

    const sixMonths = chartRange("6m", "2026-09-20", null);
    expect(
      chartBuckets(sixMonths.range, sixMonths.bucketDays)
        .slice(0, 3)
        .map((bucket) => bucket.last),
    ).toEqual(["2026-03-25", "2026-03-27", "2026-03-30"]);

    const maximum = chartRange("max", "2026-09-20", "2025-10-01");
    const maximumBuckets = chartBuckets(maximum.range, maximum.bucketDays);
    expect(maximum.bucketDays).toBe(6);
    expect(maximumBuckets).toHaveLength(60);
    expect(maximumBuckets.slice(0, 3).map((bucket) => bucket.last)).toEqual([
      "2025-10-01",
      "2025-10-07",
      "2025-10-13",
    ]);
  });

  it("keeps every day exactly once across leap years and year boundaries", () => {
    for (const range of [
      { first: "2024-02-26", last: "2024-03-02" },
      { first: "2025-12-31", last: "2026-01-06" },
    ]) {
      for (const step of [1, 2, 3, 6, 7]) {
        const buckets = chartBuckets(range, step);
        expect(buckets.flatMap((bucket) => calendarDays(bucket.first, bucket.last))).toEqual(
          calendarDays(range.first, range.last),
        );
      }
    }
    expect(chartBuckets({ first: "2026-01-01", last: "2026-01-01" }, 5)).toEqual([
      { first: "2026-01-01", last: "2026-01-01" },
    ]);
    expect(chartBuckets({ first: "2026-01-02", last: "2026-01-01" }, 5)).toEqual([]);
  });
});
