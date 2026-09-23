import { STATS_OTHER_MODEL_KEY } from "@tokenmaxxing/api-contract";
import type { StatsChartPoint } from "@tokenmaxxing/api-contract";

/**
 * Shrinks a window's (date, model) cells to what the /stats charts draw.
 * Each chart stacks its own metric's top models plus "Other", so keeping every
 * model that ranks in the top `limit` of any charted metric — and summing the
 * rest into one `STATS_OTHER_MODEL_KEY` cell per day — changes no pixel while
 * dropping the long tail of one-off model ids (over a thousand in production).
 */

const CHARTED_METRICS = [
  (row: StatsChartPoint) => row.spendUsd,
  (row: StatsChartPoint) => row.totalTokens,
  (row: StatsChartPoint) => row.rowCount,
] as const;

function collapseChartModels(rows: readonly StatsChartPoint[], limit: number): StatsChartPoint[] {
  const kept = new Set<string>();
  for (const metric of CHARTED_METRICS) {
    for (const model of topModels(rows, metric, limit)) {
      kept.add(model);
    }
  }

  const cells = new Map<string, StatsChartPoint>();
  for (const row of rows) {
    const key = kept.has(row.key) ? row.key : STATS_OTHER_MODEL_KEY;
    const cellKey = `${row.date}\u0000${key}`;
    const cell = cells.get(cellKey);
    if (cell === undefined) {
      cells.set(cellKey, { ...row, key });
    } else {
      cells.set(cellKey, {
        ...cell,
        rowCount: cell.rowCount + row.rowCount,
        spendUsd: cell.spendUsd + row.spendUsd,
        totalTokens: cell.totalTokens + row.totalTokens,
      });
    }
  }

  return [...cells.values()].sort(
    (left, right) => compareText(left.date, right.date) || compareText(left.key, right.key),
  );
}

/**
 * The `limit` highest-`metric` models; ties break by name, matching the
 * order www ranks series in. "Other" is never a real model to rank.
 */
function topModels(
  rows: readonly StatsChartPoint[],
  metric: (row: StatsChartPoint) => number,
  limit: number,
): string[] {
  const totals = new Map<string, number>();
  for (const row of rows) {
    if (row.key !== STATS_OTHER_MODEL_KEY) {
      totals.set(row.key, (totals.get(row.key) ?? 0) + metric(row));
    }
  }

  return [...totals.entries()]
    .sort(([leftKey, left], [rightKey, right]) => right - left || leftKey.localeCompare(rightKey))
    .slice(0, limit)
    .map(([key]) => key);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export { collapseChartModels };
