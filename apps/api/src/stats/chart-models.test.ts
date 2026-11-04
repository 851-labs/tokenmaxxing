import { describe, expect, it } from "vite-plus/test";

import type { StatsSeriesPoint } from "@tokenmaxxing/api-contract";

import { collapseChartSeries } from "./chart-models";

function cell(
  date: string,
  key: string,
  { spendUsd = 0, totalTokens = 0 }: Partial<StatsSeriesPoint> = {},
): StatsSeriesPoint {
  return { date, key, spendUsd, totalTokens };
}

describe("collapseChartSeries", () => {
  it("keeps every key when none fall outside the limit", () => {
    const rows = [cell("2026-07-01", "b", { spendUsd: 1 }), cell("2026-07-01", "a")];

    expect(collapseChartSeries(rows, 2, ["2026-01-01"])).toEqual([
      cell("2026-07-01", "a"),
      cell("2026-07-01", "b", { spendUsd: 1 }),
    ]);
  });

  it("keeps each metric's top keys and sums the rest into Other per day", () => {
    const rows = [
      cell("2026-07-01", "spendy", { spendUsd: 100 }),
      cell("2026-07-01", "tokeny", { totalTokens: 1_000 }),
      cell("2026-07-01", "tail-1", { spendUsd: 1, totalTokens: 10 }),
      cell("2026-07-02", "tail-2", { spendUsd: 2, totalTokens: 20 }),
      cell("2026-07-02", "tail-1", { spendUsd: 3, totalTokens: 30 }),
    ];

    expect(collapseChartSeries(rows, 1, ["2026-01-01"])).toEqual([
      cell("2026-07-01", "Other", { spendUsd: 1, totalTokens: 10 }),
      cell("2026-07-01", "spendy", { spendUsd: 100 }),
      cell("2026-07-01", "tokeny", { totalTokens: 1_000 }),
      cell("2026-07-02", "Other", { spendUsd: 5, totalTokens: 50 }),
    ]);
  });

  it("keeps a key that tops only a short recent range", () => {
    const rows = [
      cell("2026-03-01", "old-giant", { spendUsd: 1_000, totalTokens: 1_000 }),
      cell("2026-07-01", "old-giant", { spendUsd: 1, totalTokens: 1 }),
      cell("2026-07-01", "newcomer", { spendUsd: 5, totalTokens: 5 }),
      cell("2026-07-01", "tail", { spendUsd: 2, totalTokens: 2 }),
    ];

    // Year to date only "old-giant" ranks; since July "newcomer" does too.
    expect(collapseChartSeries(rows, 1, ["2026-01-01"]).map((row) => row.key)).toEqual([
      "old-giant",
      "Other",
      "old-giant",
    ]);
    expect(
      collapseChartSeries(rows, 1, ["2026-01-01", "2026-06-20"]).map((row) => row.key),
    ).toEqual(["old-giant", "Other", "newcomer", "old-giant"]);
  });

  it("breaks ranking ties by name and never ranks a literal Other", () => {
    const rows = [
      cell("2026-07-01", "Other", { spendUsd: 99, totalTokens: 99 }),
      cell("2026-07-01", "zeta", { spendUsd: 5, totalTokens: 5 }),
      cell("2026-07-01", "alpha", { spendUsd: 5, totalTokens: 5 }),
    ];
    const collapsed = collapseChartSeries(rows, 1, ["2026-01-01"]);

    expect(collapsed.map((row) => row.key)).toEqual(["Other", "alpha"]);
    expect(collapsed[0]).toMatchObject({ spendUsd: 104, totalTokens: 104 });
  });
});
