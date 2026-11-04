import { describe, expect, it } from "vite-plus/test";

import { bucketDays } from "./day-buckets";

describe("bucketDays", () => {
  it("keeps one bar per day while the range fits", () => {
    const bucketing = bucketDays("2026-10-21", "2026-11-03");

    expect(bucketing.size).toBe(1);
    expect(bucketing.buckets).toHaveLength(14);
    expect(bucketing.buckets.at(0)).toEqual({ first: "2026-10-21", last: "2026-10-21" });
    expect(bucketing.bucketOf("2026-11-03")).toBe("2026-11-03");
  });

  it("widens bars to stay under the bar limit, like 2-day bars for 3 months", () => {
    const bucketing = bucketDays("2026-08-06", "2026-11-03");

    expect(bucketing.size).toBe(2);
    expect(bucketing.buckets).toHaveLength(45);
    expect(bucketing.buckets.at(-1)).toEqual({ first: "2026-11-02", last: "2026-11-03" });
  });

  it("aligns buckets to the last day and leaves only the oldest one partial", () => {
    const bucketing = bucketDays("2026-01-01", "2026-01-10", 3);

    expect(bucketing.size).toBe(4);
    expect(bucketing.buckets).toEqual([
      { first: "2026-01-01", last: "2026-01-02" },
      { first: "2026-01-03", last: "2026-01-06" },
      { first: "2026-01-07", last: "2026-01-10" },
    ]);
    expect(bucketing.bucketOf("2026-01-02")).toBe("2026-01-01");
    expect(bucketing.bucketOf("2026-01-03")).toBe("2026-01-03");
    expect(bucketing.bucketOf("2026-01-06")).toBe("2026-01-03");
    expect(bucketing.bucketOf("2026-01-10")).toBe("2026-01-07");
  });

  it("places dates outside the range in no bucket", () => {
    const bucketing = bucketDays("2026-01-01", "2026-01-10", 3);

    expect(bucketing.bucketOf("2025-12-31")).toBeUndefined();
    expect(bucketing.bucketOf("2026-01-11")).toBeUndefined();
  });

  it("returns no buckets for an inverted range", () => {
    expect(bucketDays("2026-01-02", "2026-01-01").buckets).toEqual([]);
  });
});
