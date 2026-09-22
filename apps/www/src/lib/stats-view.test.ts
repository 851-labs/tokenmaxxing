import { describe, expect, it } from "vite-plus/test";
import type { StatsResponse } from "@tokenmaxxing/api-contract";

import {
  deriveAggregateCharts,
  formatUsageRange,
  latestPlausibleDate,
  selectStatsWindow,
} from "./stats-view";

type Stats = typeof StatsResponse.Type;

describe("selectStatsWindow", () => {
  it("bounds dates by the server clock, not the viewer's", () => {
    expect(latestPlausibleDate("2026-06-22T18:30:00.000Z")).toBe("2026-06-23");
    expect(latestPlausibleDate("2026-12-31T23:59:59.000Z")).toBe("2027-01-01");
  });

  it("keeps a user's local tomorrow but drops corrupt far-future rows", () => {
    // generatedAt is 2026-06-22 UTC: a user east of UTC can already be on the
    // 23rd, while year-3089 rows (seen in production) are corrupt.
    const data = stats({
      rows: [row("2026-06-20", 1), row("2026-06-23", 2), row("3089-08-23", 4)],
      totals: { firstDate: "2026-06-20", lastDate: "3089-08-23" },
    });

    const view = selectStatsWindow(data, "30d");
    const charts = deriveAggregateCharts(view);

    expect(view.dailyByModel.map((entry) => entry.date)).toEqual(["2026-06-20", "2026-06-23"]);
    expect(view.chartRange).toEqual({ first: "2026-06-20", last: "2026-06-23" });
    expect(charts.spend.days.map((day) => [day.date, day.total])).toEqual([
      ["2026-06-20", 1],
      ["2026-06-21", 0],
      ["2026-06-22", 0],
      ["2026-06-23", 2],
    ]);
  });

  it("starts the chart at the window start even if totals reach further back", () => {
    const data = stats({
      rows: [row("1970-01-01", 9), row("2026-06-01", 1)],
      totals: { firstDate: "1970-01-01", lastDate: "2026-06-01" },
    });

    expect(selectStatsWindow(data, "30d").chartRange).toEqual({
      first: "2026-05-24",
      last: "2026-06-01",
    });
  });

  it("filters each window by its own start date", () => {
    const data = stats({
      rows: [row("2025-12-31", 1), row("2026-01-01", 2), row("2026-06-01", 3)],
    });

    expect(selectStatsWindow(data, "2026").dailyByModel.map((entry) => entry.date)).toEqual([
      "2026-01-01",
      "2026-06-01",
    ]);
    expect(selectStatsWindow(data, "30d").dailyByModel.map((entry) => entry.date)).toEqual([
      "2026-06-01",
    ]);
  });

  it("charts every day between the window's first and last usage", () => {
    const data = stats({
      rows: [row("2026-06-20", 1), row("2026-06-22", 2)],
      totals: { firstDate: "2026-06-20", lastDate: "2026-06-22" },
    });

    const charts = deriveAggregateCharts(selectStatsWindow(data, "30d"));

    expect(charts.spend.days.map((day) => [day.date, day.total])).toEqual([
      ["2026-06-20", 1],
      ["2026-06-21", 0],
      ["2026-06-22", 2],
    ]);
    expect(charts.sessions.days.map((day) => day.total)).toEqual([1, 0, 1]);
  });

  it("charts nothing before any usage exists", () => {
    const charts = deriveAggregateCharts(selectStatsWindow(stats({ rows: [] }), "30d"));

    expect(charts.spend.days).toEqual([]);
    expect(formatUsageRange(null)).toBe("No usage yet");
    expect(formatUsageRange({ first: "2026-06-01", last: "2026-06-23" })).toBe(
      "2026-06-01 to 2026-06-23",
    );
  });
});

function row(date: string, costUsd: number): Stats["dailyByModel"][number] {
  return { costUsd, date, key: "claude-opus", outputTokens: 0, rowCount: 1, totalTokens: 10 };
}

function stats({
  rows,
  totals = {},
}: {
  rows: Stats["dailyByModel"];
  totals?: Partial<Stats["last30d"]>;
}): Stats {
  const window: Stats["last30d"] = {
    activeDates: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    deviceCount: 0,
    firstDate: null,
    inputTokens: 0,
    lastDate: null,
    outputTokens: 0,
    rowCount: 0,
    totalSpendUsd: 0,
    totalTokens: 0,
    userCount: 0,
    ...totals,
  };

  return {
    allTime: window,
    daily: [],
    dailyByModel: rows,
    generatedAt: "2026-06-22T00:00:00.000Z",
    last30d: window,
    last30dSince: "2026-05-24",
    peaks: { spend: null, tokens: null },
    sources: { allTime: [], last30d: [], year2026: [] },
    topModels: {
      allTimeBySpend: [],
      allTimeByTokens: [],
      last30dBySpend: [],
      last30dByTokens: [],
      year2026BySpend: [],
      year2026ByTokens: [],
    },
    topUsers: { bySpend: [], byTokens: [] },
    year2026: window,
    year2026Since: "2026-01-01",
  };
}
