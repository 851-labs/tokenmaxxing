import { describe, expect, it } from "vite-plus/test";

import {
  formatCompact,
  formatDateTimeUtc,
  formatDay,
  formatInteger,
  formatMonth,
  formatMonthLong,
  formatPercent,
  formatTokens,
  formatUsd,
  percentOf,
} from "./format";

describe("number formatters", () => {
  it("shows cents below $100 and whole dollars from $100", () => {
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(42.5)).toBe("$42.50");
    expect(formatUsd(99.994)).toBe("$99.99");
    expect(formatUsd(100)).toBe("$100");
    expect(formatUsd(12_345.67)).toBe("$12,346");
  });

  it("abbreviates token counts by magnitude", () => {
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(987_654)).toBe("987.7K");
    expect(formatTokens(12_300_000)).toBe("12.3M");
    expect(formatTokens(1_234_000_000)).toBe("1.23B");
    expect(formatTokens(2_500_000_000_000)).toBe("2.50T");
  });

  it("groups integers and rounds fractions away", () => {
    expect(formatInteger(1_234_567)).toBe("1,234,567");
    expect(formatInteger(2.6)).toBe("3");
  });

  it("formats percentages and guards a zero total", () => {
    expect(formatPercent(12.345)).toBe("12.3%");
    expect(formatPercent(50, 0)).toBe("50%");
    expect(percentOf(1, 4)).toBe(25);
    expect(percentOf(5, 0)).toBe(0);
  });

  it("compacts large counts", () => {
    expect(formatCompact(1_234)).toBe("1.2K");
  });
});

describe("date formatters", () => {
  it("renders opaque date keys without local-time shifting", () => {
    expect(formatDay("2026-06-21")).toBe("Sun, Jun 21, 2026");
    expect(formatMonth("2026-07")).toBe("Jul");
    expect(formatMonth("2026-07-01")).toBe("Jul");
    expect(formatMonthLong("2026-06")).toBe("June 2026");
  });

  it("prints timestamps deterministically in UTC", () => {
    // ICU may join the time and day period with a narrow no-break space.
    expect(formatDateTimeUtc("2026-06-21T18:05:00.000Z")).toMatch(/^Jun 21, 2026, 6:05\sPM UTC$/);
    expect(formatDateTimeUtc("not a date")).toBe("not a date");
  });
});
