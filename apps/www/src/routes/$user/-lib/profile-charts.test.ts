import { describe, expect, it } from "vite-plus/test";

import { modelColor } from "../../../components/charts/model-colors";
import { deriveProfileCharts, type DailyRange, type DailyRow } from "./profile-charts";

describe("deriveProfileCharts", () => {
  it("fills sparse usage rows across the server-provided chart range", () => {
    const range: DailyRange = {
      firstDate: "2026-06-19",
      lastDate: "2026-06-21",
    };
    const rows: DailyRow[] = [
      {
        spendUsd: 12,
        date: "2026-06-19",
        key: "claude-opus-4",
        outputTokens: 200,
        totalTokens: 300,
      },
    ];

    const derived = deriveProfileCharts(rows, range);

    expect(derived.heatmap).toEqual({
      first: "2026-01-01",
      focus: "2026-06-21",
      last: "2026-12-31",
    });
    expect(derived.spend.days.map((day) => [day.date, day.total])).toEqual([
      ["2026-06-19", 12],
      ["2026-06-20", 0],
      ["2026-06-21", 0],
    ]);
    expect(derived.tokens.days.map((day) => [day.date, day.total])).toEqual([
      ["2026-06-19", 300],
      ["2026-06-20", 0],
      ["2026-06-21", 0],
    ]);
    expect(derived.months.map((month) => [month.month, month.value])).toEqual([["2026-06", 12]]);
  });

  it("renders the heatmap across the full calendar year, opened on the last day", () => {
    const range: DailyRange = {
      firstDate: "2026-01-01",
      lastDate: "2026-06-21",
    };

    const derived = deriveProfileCharts([], range);

    expect(derived.heatmap).toEqual({
      first: "2026-01-01",
      focus: "2026-06-21",
      last: "2026-12-31",
    });
    expect(derived.spend.days.at(0)?.date).toBe("2026-01-01");
    expect(derived.spend.days.at(-1)?.date).toBe("2026-06-21");
  });

  it("renders every month from range start through range end", () => {
    const range: DailyRange = {
      firstDate: "2026-01-01",
      lastDate: "2026-06-21",
    };

    const derived = deriveProfileCharts([], range);

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
      firstDate: "2026-06-21",
      lastDate: "2026-06-21",
    };
    const rows: DailyRow[] = [
      dailyRow({ spendUsd: 20, key: "claude-opus-4-8", totalTokens: 200 }),
      dailyRow({ spendUsd: 10, key: "claude-opus-4-7", totalTokens: 100 }),
    ];

    const derived = deriveProfileCharts(rows, range);

    expect(derived.spend.legend.map((entry) => entry.series)).toEqual([
      "claude-opus-4-8",
      "claude-opus-4-7",
    ]);
    expect(
      derived.spend.days[0]?.segments
        .filter((segment) => segment.value > 0)
        .map((segment) => [segment.series, segment.value]),
    ).toEqual([
      ["claude-opus-4-8", 20],
      ["claude-opus-4-7", 10],
    ]);
  });

  it("colors models by identity, the same as /stats, across every chart", () => {
    const range: DailyRange = { firstDate: "2026-06-21", lastDate: "2026-06-21" };
    const rows: DailyRow[] = [
      dailyRow({ spendUsd: 20, key: "claude-opus-5", totalTokens: 100 }),
      dailyRow({ spendUsd: 10, key: "gpt-5.6-sol", totalTokens: 300 }),
    ];

    const derived = deriveProfileCharts(rows, range);
    const segments = [
      ...derived.spend.legend,
      ...derived.tokens.legend,
      ...(derived.segmentsByDate.get("2026-06-21") ?? []),
      ...(derived.months[0]?.segments ?? []),
    ];

    expect(segments).toHaveLength(8);
    for (const segment of segments) {
      expect(segment.color, segment.series).toBe(modelColor(segment.series));
    }
  });

  it("collapses only models below the chart limit into Other", () => {
    const range: DailyRange = {
      firstDate: "2026-06-21",
      lastDate: "2026-06-21",
    };
    const rows = Array.from({ length: 11 }, (_, index) =>
      dailyRow({
        spendUsd: 11 - index,
        key: `model-${String(index + 1).padStart(2, "0")}`,
        totalTokens: 110 - index * 10,
      }),
    );

    const derived = deriveProfileCharts(rows, range);

    expect(derived.spend.legend.map((entry) => entry.series)).toEqual([
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
      derived.spend.days[0]?.segments.find((segment) => segment.series === "Other")?.value,
    ).toBe(3);
  });

  it("buckets spend by Monday-first weekday from the opaque date key", () => {
    const range: DailyRange = { firstDate: "2026-06-15", lastDate: "2026-06-21" };
    const rows: DailyRow[] = [
      { ...dailyRow({ spendUsd: 5, key: "a", totalTokens: 1 }), date: "2026-06-15" }, // Monday
      { ...dailyRow({ spendUsd: 7, key: "a", totalTokens: 1 }), date: "2026-06-21" }, // Sunday
    ];

    expect(deriveProfileCharts(rows, range).spendByWeekday).toEqual([5, 0, 0, 0, 0, 0, 7]);
  });

  it("builds heatmap tooltip segments only for days with usage", () => {
    const range: DailyRange = { firstDate: "2026-06-20", lastDate: "2026-06-21" };
    const rows = [dailyRow({ spendUsd: 4, key: "claude-opus-4-8", totalTokens: 10 })];

    const derived = deriveProfileCharts(rows, range);

    expect([...derived.segmentsByDate.keys()]).toEqual(["2026-06-21"]);
    expect(derived.segmentsByDate.get("2026-06-21")).toEqual([
      { color: expect.any(String), series: "claude-opus-4-8", value: 4 },
    ]);
    expect(derived.spendByDate.get("2026-06-21")).toBe(4);
  });
});

function dailyRow({
  spendUsd,
  key,
  totalTokens,
}: {
  spendUsd: number;
  key: string;
  totalTokens: number;
}): DailyRow {
  return {
    spendUsd,
    date: "2026-06-21",
    key,
    outputTokens: 0,
    totalTokens,
  };
}
