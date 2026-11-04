import type { ProfileDailyResponse, UsageRangeId } from "@tokenmaxxing/api-contract";

import { bucketedStackedCharts } from "../../../components/charts/trend";
import type { MonthPoint } from "../../../components/charts/month-bars";
import {
  bucketSeries,
  buildSegments,
  buildStackedSeriesCharts,
  type ChartSegment,
  type StackedSeriesChart,
} from "../../../components/charts/series";
import { usageRangeWindow } from "../../../lib/usage-ranges";
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
  /** The calendar year containing the range's last day, opened on that day. */
  heatmap: { first: string; focus: string; last: string };
  monthlySpend: MonthPoint[];
  monthlyTokens: MonthPoint[];
  /** Per-day spend segments for the heatmap tooltip. */
  segmentsByDate: Map<string, ChartSegment[]>;
  spend: StackedSeriesChart;
  /** date -> total spend. */
  spendByDate: Map<string, number>;
  /** Monday-first: [0] = Mon … [6] = Sun. */
  spendByWeekday: number[];
  tokens: StackedSeriesChart;
}

interface ProfileTrendCharts {
  /** Days per bar. */
  bucketDays: number;
  spend: StackedSeriesChart;
  tokens: StackedSeriesChart;
}

interface ProfileWindowStats {
  /** Days in the window with any usage row. */
  activeDays: number;
  spendUsd: number;
  /** Highest-spend raw model name in the window, or null without usage. */
  topModel: string | null;
  totalTokens: number;
}

/**
 * The stat cards that follow the time range, summed from the daily rows the
 * same way the lifetime stats are: an active day is any day with a usage row,
 * and the top model ranks raw model names by spend.
 */
function deriveWindowStats(rows: readonly DailyRow[], window: DailyRange): ProfileWindowStats {
  const dates = new Set<string>();
  const spendByModel = new Map<string, number>();
  let spendUsd = 0;
  let totalTokens = 0;
  for (const row of rows) {
    if (row.date < window.firstDate || row.date > window.lastDate) {
      continue;
    }
    dates.add(row.date);
    spendUsd += row.spendUsd;
    totalTokens += row.totalTokens;
    spendByModel.set(row.key, (spendByModel.get(row.key) ?? 0) + row.spendUsd);
  }

  let topModel: string | null = null;
  let topSpend = Number.NEGATIVE_INFINITY;
  for (const [model, spend] of spendByModel) {
    if (spend > topSpend || (spend === topSpend && topModel !== null && model < topModel)) {
      topModel = model;
      topSpend = spend;
    }
  }

  return { activeDays: dates.size, spendUsd, topModel, totalTokens };
}

/** Spend and token stacks over the range, bucketed to a readable bar count. */
function deriveProfileTrendCharts(
  rows: readonly DailyRow[],
  range: DailyRange,
  usageRange: UsageRangeId,
): ProfileTrendCharts {
  const { bucketDays, charts } = bucketedStackedCharts(rows, usageRangeWindow(range, usageRange), {
    spend: (row) => row.spendUsd,
    tokens: (row) => row.totalTokens,
  });

  return { bucketDays, spend: charts.spend, tokens: charts.tokens };
}

function deriveProfileCharts(rows: readonly DailyRow[], range: DailyRange): ProfileCharts {
  const days = enumerateDays(range.firstDate, range.lastDate);
  const {
    charts: { spend, tokens },
    colors,
  } = buildStackedSeriesCharts(rows, days, {
    spend: (row) => row.spendUsd,
    tokens: (row) => row.totalTokens,
  });
  const spendOrder = spend.selection.order;

  const spendByWeekday = [0, 0, 0, 0, 0, 0, 0];
  for (const row of rows) {
    const weekday = weekdayMondayFirst(row.date);
    spendByWeekday[weekday] = (spendByWeekday[weekday] ?? 0) + row.spendUsd;
  }

  const segmentsByDate = new Map(
    [...spend.buckets.values.entries()].map(([date, values]) => [
      date,
      buildSegments(spendOrder, colors, values),
    ]),
  );

  const months = enumerateMonths(range.firstDate, range.lastDate);
  function deriveMonths(chart: StackedSeriesChart, value: (row: DailyRow) => number): MonthPoint[] {
    const byMonth = bucketSeries(rows, chart.selection, value, (row) => row.date.slice(0, 7));
    return months.map((month) => ({
      month,
      segments: buildSegments(chart.selection.order, colors, byMonth.values.get(month)),
      value: byMonth.totals.get(month) ?? 0,
    }));
  }

  return {
    heatmap: {
      first: calendarYearStart(range.lastDate),
      focus: range.lastDate,
      last: calendarYearEnd(range.lastDate),
    },
    monthlySpend: deriveMonths(spend, (row) => row.spendUsd),
    monthlyTokens: deriveMonths(tokens, (row) => row.totalTokens),
    segmentsByDate,
    spend,
    spendByDate: spend.buckets.totals,
    spendByWeekday,
    tokens,
  };
}

export { deriveProfileCharts, deriveProfileTrendCharts, deriveWindowStats };

export type { DailyRange, DailyRow, ProfileCharts, ProfileTrendCharts, ProfileWindowStats };
