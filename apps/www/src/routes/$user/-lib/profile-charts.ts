import type { ProfileDailyResponse } from "@tokenmaxxing/api-contract";

import type { MonthPoint } from "../../../components/charts/month-bars";
import {
  bucketSeries,
  buildSegments,
  buildStackedSeriesChart,
  seriesColors,
  type ChartSegment,
  type StackedSeriesChart,
} from "../../../components/charts/series";
import {
  calendarYearEnd,
  calendarYearStart,
  enumerateDays,
  enumerateMonths,
  weekdayMondayFirst,
} from "../../../lib/dates";

/** Pure view-model for the profile dashboard's charts. */

type DailyResponse = typeof ProfileDailyResponse.Type;
type DailyRow = DailyResponse["days"][number];
type DailyRange = DailyResponse["range"];

interface ProfileCharts {
  /** The calendar year containing the range's last day. */
  heatmap: { first: string; last: string };
  months: MonthPoint[];
  /** Per-day spend segments for the heatmap tooltip. */
  segmentsByDate: Map<string, ChartSegment[]>;
  spend: StackedSeriesChart;
  /** date -> total spend. */
  spendByDate: Map<string, number>;
  /** Monday-first: [0] = Mon … [6] = Sun. */
  spendByWeekday: number[];
  tokens: StackedSeriesChart;
}

function deriveProfileCharts(rows: readonly DailyRow[], range: DailyRange): ProfileCharts {
  const colors = seriesColors(rows);
  const days = enumerateDays(range.first, range.last);
  const spend = buildStackedSeriesChart(rows, days, colors, (row) => row.costUsd);
  const tokens = buildStackedSeriesChart(rows, days, colors, (row) => row.totalTokens);
  const spendOrder = spend.selection.order;

  const spendByWeekday = [0, 0, 0, 0, 0, 0, 0];
  for (const row of rows) {
    const weekday = weekdayMondayFirst(row.date);
    spendByWeekday[weekday] = (spendByWeekday[weekday] ?? 0) + row.costUsd;
  }

  const segmentsByDate = new Map(
    [...spend.buckets.values.entries()].map(([date, values]) => [
      date,
      buildSegments(spendOrder, colors, values),
    ]),
  );

  const byMonth = bucketSeries(
    rows,
    spend.selection,
    (row) => row.costUsd,
    (row) => row.date.slice(0, 7),
  );
  const months = enumerateMonths(range.first, range.last).map((month) => ({
    month,
    segments: buildSegments(spendOrder, colors, byMonth.values.get(month)),
    value: byMonth.totals.get(month) ?? 0,
  }));

  return {
    heatmap: { first: calendarYearStart(range.last), last: calendarYearEnd(range.last) },
    months,
    segmentsByDate,
    spend,
    spendByDate: spend.buckets.totals,
    spendByWeekday,
    tokens,
  };
}

export { deriveProfileCharts };

export type { DailyRange, DailyRow, ProfileCharts };
