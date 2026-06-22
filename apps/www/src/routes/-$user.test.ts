import { describe, expect, it } from "vitest";
import type { ProfileDailyResponse, ProfileDailyRow } from "@tokenmaxxing/api-contract";

import { deriveCharts } from "./$user";

type DailyRange = (typeof ProfileDailyResponse.Type)["range"];
type DailyRow = typeof ProfileDailyRow.Type;

describe("deriveCharts", () => {
  it("fills sparse usage rows across the server-provided chart range", () => {
    const range: DailyRange = {
      first: "2026-06-19",
      last: "2026-06-21",
    };
    const rows: DailyRow[] = [
      {
        costUsd: 12,
        date: "2026-06-19",
        key: "claude-opus-4",
        outputTokens: 200,
        totalTokens: 300,
      },
    ];

    const derived = deriveCharts(rows, range);

    expect(derived.heatmap).toEqual({
      first: "2026-01-01",
      last: "2026-12-31",
    });
    expect(derived.spendDays.map((day) => [day.date, day.total])).toEqual([
      ["2026-06-19", 12],
      ["2026-06-20", 0],
      ["2026-06-21", 0],
    ]);
    expect(derived.tokenDays.map((day) => [day.date, day.total])).toEqual([
      ["2026-06-19", 300],
      ["2026-06-20", 0],
      ["2026-06-21", 0],
    ]);
    expect(derived.months.map((month) => [month.month, month.value])).toEqual([["2026-06", 12]]);
  });

  it("renders the heatmap across the full calendar year", () => {
    const range: DailyRange = {
      first: "2026-01-01",
      last: "2026-06-21",
    };

    const derived = deriveCharts([], range);

    expect(derived.heatmap).toEqual({
      first: "2026-01-01",
      last: "2026-12-31",
    });
    expect(derived.spendDays.at(0)?.date).toBe("2026-01-01");
    expect(derived.spendDays.at(-1)?.date).toBe("2026-06-21");
  });

  it("renders every month from range start through range end", () => {
    const range: DailyRange = {
      first: "2026-01-01",
      last: "2026-06-21",
    };

    const derived = deriveCharts([], range);

    expect(derived.months.map((month) => month.month)).toEqual([
      "2026-01",
      "2026-02",
      "2026-03",
      "2026-04",
      "2026-05",
      "2026-06",
    ]);
  });

  it("keeps versioned Opus models as separate series", () => {
    const range: DailyRange = {
      first: "2026-06-21",
      last: "2026-06-21",
    };
    const rows: DailyRow[] = [
      dailyRow({ costUsd: 20, key: "claude-opus-4-8", totalTokens: 200 }),
      dailyRow({ costUsd: 10, key: "claude-opus-4-7", totalTokens: 100 }),
    ];

    const derived = deriveCharts(rows, range);

    expect(derived.spendLegend.map((entry) => entry.series)).toEqual([
      "Claude Opus 4.8",
      "Claude Opus 4.7",
    ]);
    expect(
      derived.spendDays[0]?.segments
        .filter((segment) => segment.value > 0)
        .map((segment) => [segment.series, segment.value]),
    ).toEqual([
      ["Claude Opus 4.8", 20],
      ["Claude Opus 4.7", 10],
    ]);
  });
});

function dailyRow({
  costUsd,
  key,
  totalTokens,
}: {
  costUsd: number;
  key: string;
  totalTokens: number;
}): DailyRow {
  return {
    costUsd,
    date: "2026-06-21",
    key,
    outputTokens: 0,
    totalTokens,
  };
}
