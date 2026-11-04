import { STATS_OTHER_MODEL_KEY } from "@tokenmaxxing/api-contract";
import type { StatsSeriesPoint } from "@tokenmaxxing/api-contract";

/**
 * Shrinks (date, key) cells to what the /stats charts draw. Each range's chart
 * stacks its metric's top series plus "Other", so keeping every key that ranks
 * in the top `limit` by spend or tokens within any range — and summing the
 * rest into one `STATS_OTHER_MODEL_KEY` cell per day — changes no pixel of any
 * range while dropping the long tail of one-off model ids (tens of thousands
 * in production).
 */

const CHARTED_METRICS = [
  (row: StatsSeriesPoint) => row.spendUsd,
  (row: StatsSeriesPoint) => row.totalTokens,
] as const;

function collapseChartSeries(
  rows: readonly StatsSeriesPoint[],
  limit: number,
  /** Inclusive YYYY-MM-DD start of every range the rows are charted over. */
  rangeStarts: readonly string[],
): StatsSeriesPoint[] {
  const kept = new Set<string>();
  for (const since of new Set(rangeStarts)) {
    const inRange = rows.filter((row) => row.date >= since);
    for (const metric of CHARTED_METRICS) {
      for (const key of topKeys(inRange, metric, limit)) {
        kept.add(key);
      }
    }
  }

  const cells = new Map<string, StatsSeriesPoint>();
  for (const row of rows) {
    const key = kept.has(row.key) ? row.key : STATS_OTHER_MODEL_KEY;
    const cellKey = `${row.date}\u0000${key}`;
    const cell = cells.get(cellKey);
    cells.set(
      cellKey,
      cell === undefined
        ? { ...row, key }
        : {
            ...cell,
            spendUsd: cell.spendUsd + row.spendUsd,
            totalTokens: cell.totalTokens + row.totalTokens,
          },
    );
  }

  return [...cells.values()]
    .map((cell) => ({ ...cell, spendUsd: roundCents(cell.spendUsd) }))
    .sort((left, right) => compareText(left.date, right.date) || compareText(left.key, right.key));
}

/**
 * Chart cells carry spend to the cent: sub-cent digits change no pixel and
 * would make up a tenth of the payload.
 */
function roundCents(usd: number): number {
  return Math.round(usd * 100) / 100;
}

/**
 * The `limit` highest-`metric` keys; ties break by name, matching the order
 * www ranks series in. "Other" is never a real key to rank.
 */
function topKeys(
  rows: readonly StatsSeriesPoint[],
  metric: (row: StatsSeriesPoint) => number,
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

export { collapseChartSeries, roundCents };
