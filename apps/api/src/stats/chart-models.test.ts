import { describe, expect, it } from "vite-plus/test";

import type { StatsChartPoint } from "@tokenmaxxing/api-contract";

import { collapseChartModels } from "./chart-models";

function cell(
  date: string,
  key: string,
  { rowCount = 1, spendUsd = 0, totalTokens = 0 }: Partial<StatsChartPoint> = {},
): StatsChartPoint {
  return { date, key, rowCount, spendUsd, totalTokens };
}

describe("collapseChartModels", () => {
  it("keeps every model when none fall outside the limit", () => {
    const rows = [cell("2026-07-01", "b", { spendUsd: 1 }), cell("2026-07-01", "a")];

    expect(collapseChartModels(rows, 2)).toEqual([
      cell("2026-07-01", "a"),
      cell("2026-07-01", "b", { spendUsd: 1 }),
    ]);
  });

  it("keeps each metric's top models and sums the rest into Other per day", () => {
    const rows = [
      cell("2026-07-01", "spendy", { spendUsd: 100 }),
      cell("2026-07-01", "tokeny", { totalTokens: 1_000 }),
      cell("2026-07-01", "busy", { rowCount: 50 }),
      cell("2026-07-01", "tail-1", { rowCount: 2, spendUsd: 1, totalTokens: 10 }),
      cell("2026-07-02", "tail-2", { rowCount: 3, spendUsd: 2, totalTokens: 20 }),
      cell("2026-07-02", "tail-1", { rowCount: 4, spendUsd: 3, totalTokens: 30 }),
    ];

    expect(collapseChartModels(rows, 1)).toEqual([
      cell("2026-07-01", "Other", { rowCount: 2, spendUsd: 1, totalTokens: 10 }),
      cell("2026-07-01", "busy", { rowCount: 50 }),
      cell("2026-07-01", "spendy", { spendUsd: 100 }),
      cell("2026-07-01", "tokeny", { totalTokens: 1_000 }),
      cell("2026-07-02", "Other", { rowCount: 7, spendUsd: 5, totalTokens: 50 }),
    ]);
  });

  it("breaks ranking ties by model name and never ranks a literal Other", () => {
    const rows = [
      cell("2026-07-01", "Other", { rowCount: 99, spendUsd: 99, totalTokens: 99 }),
      cell("2026-07-01", "zeta", { spendUsd: 5, totalTokens: 5 }),
      cell("2026-07-01", "alpha", { spendUsd: 5, totalTokens: 5 }),
    ];

    expect(collapseChartModels(rows, 1).map((row) => row.key)).toEqual(["Other", "alpha"]);
    expect(collapseChartModels(rows, 1)[0]).toMatchObject({ rowCount: 100, spendUsd: 104 });
  });
});
