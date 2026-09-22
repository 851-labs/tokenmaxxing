import { describe, expect, it } from "vite-plus/test";
import type { ProfileDailyResponse, ProfileDailyRow } from "@tokenmaxxing/api-contract";

import { deriveCharts } from "./$user";

type DailyRange = (typeof ProfileDailyResponse.Type)["range"];
type DailyRow = typeof ProfileDailyRow.Type;

describe("deriveCharts", () => {
  it("preserves every day's spend, tokens, and model totals at different bucket widths", () => {
    const range = { first: "2026-01-01", last: "2026-03-02" };
    const rows = [
      { ...dailyRow({ costUsd: 10, totalTokens: 100, key: "model-a" }), date: "2026-01-01" },
      { ...dailyRow({ costUsd: 20, totalTokens: 200, key: "model-a" }), date: "2026-01-04" },
      { ...dailyRow({ costUsd: 30, totalTokens: 300, key: "model-b" }), date: "2026-01-05" },
      { ...dailyRow({ costUsd: 40, totalTokens: 400, key: "model-b" }), date: "2026-03-02" },
      { ...dailyRow({ costUsd: 999, totalTokens: 999, key: "outside" }), date: "2026-03-03" },
      { ...dailyRow({ costUsd: 999, totalTokens: 999, key: "outside" }), date: "2025-12-31" },
    ];
    for (const size of [1, 2, 3, 5, 6]) {
      const derived = deriveCharts(rows, range, size);
      expect(derived.spendDays.reduce((sum, day) => sum + day.total, 0)).toBe(100);
      expect(derived.tokenDays.reduce((sum, day) => sum + day.total, 0)).toBe(1000);
      expect(derived.spendLegend).toEqual([
        { color: expect.any(String), percent: 70, series: "model-b" },
        { color: expect.any(String), percent: 30, series: "model-a" },
      ]);
      expect(derived.spendByWeekday.reduce((sum, value) => sum + value, 0)).toBe(100);
      expect(derived.spendByDate.has("2026-03-03")).toBe(false);
    }
    const grouped = deriveCharts(rows, range, 3);
    expect(grouped.spendDays[0]).toMatchObject({
      date: "2026-01-01",
      endDate: "2026-01-01",
      total: 10,
    });
    expect(grouped.spendDays[1]).toMatchObject({
      date: "2026-01-02",
      endDate: "2026-01-04",
      total: 20,
    });
    expect(grouped.spendDays.find((bucket) => bucket.date === "2026-02-01")?.total).toBe(0);
    expect(grouped.spendDays.at(-1)).toMatchObject({
      date: "2026-02-28",
      endDate: "2026-03-02",
      total: 40,
    });
  });

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

  it("uses raw model names as separate series", () => {
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
      "claude-opus-4-8",
      "claude-opus-4-7",
    ]);
    expect(
      derived.spendDays[0]?.segments
        .filter((segment) => segment.value > 0)
        .map((segment) => [segment.series, segment.value]),
    ).toEqual([
      ["claude-opus-4-8", 20],
      ["claude-opus-4-7", 10],
    ]);
  });

  it("collapses only models below the chart limit into Other", () => {
    const range: DailyRange = {
      first: "2026-06-21",
      last: "2026-06-21",
    };
    const rows = Array.from({ length: 11 }, (_, index) =>
      dailyRow({
        costUsd: 11 - index,
        key: `model-${String(index + 1).padStart(2, "0")}`,
        totalTokens: 110 - index * 10,
      }),
    );

    const derived = deriveCharts(rows, range);

    expect(derived.spendLegend.map((entry) => entry.series)).toEqual([
      "model-01",
      "model-02",
      "model-03",
      "model-04",
      "model-05",
      "model-06",
      "model-07",
      "model-08",
      "model-09",
      "Other",
    ]);
    expect(
      derived.spendDays[0]?.segments.find((segment) => segment.series === "Other")?.value,
    ).toBe(3);
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
