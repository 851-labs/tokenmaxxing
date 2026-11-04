import type { DayWindow } from "../../lib/usage-ranges";
import { bucketDays } from "./day-buckets";
import { buildStackedSeriesCharts, type StackedSeriesChart } from "./series";

/**
 * Stacked trend charts over a day window, in equal N-day bars sized so the
 * bar count stays readable (see `bucketDays`). Top series and legend shares
 * cover only the window, so a series that dominated months ago doesn't crowd
 * a recent view.
 */

interface BucketedCharts<Metric extends string> {
  /** Days per bar. */
  bucketDays: number;
  charts: Record<Metric, StackedSeriesChart>;
}

function bucketedStackedCharts<Row extends { date: string; key: string }, Metric extends string>(
  rows: readonly Row[],
  window: DayWindow,
  metrics: Readonly<Record<Metric, (row: Row) => number>>,
): BucketedCharts<Metric> {
  const bucketing = bucketDays(window.firstDate, window.lastDate);
  const bucketed = rows.flatMap((row) => {
    const bucket = bucketing.bucketOf(row.date);
    return bucket === undefined ? [] : [{ ...row, date: bucket }];
  });
  const { charts } = buildStackedSeriesCharts(
    bucketed,
    bucketing.buckets.map((bucket) => bucket.first),
    metrics,
  );
  for (const chart of Object.values<StackedSeriesChart>(charts)) {
    chart.days = chart.days.map((day, index) => ({
      ...day,
      endDate: bucketing.buckets[index]?.last ?? day.date,
    }));
  }

  return { bucketDays: bucketing.size, charts };
}

export { bucketedStackedCharts };

export type { BucketedCharts };
