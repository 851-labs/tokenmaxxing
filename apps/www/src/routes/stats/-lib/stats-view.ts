import type { StatsResponse } from "@tokenmaxxing/api-contract";

import {
  buildStackedSeriesChart,
  seriesColors,
  type StackedSeriesChart,
} from "../../../components/charts/series";
import { addDays, enumerateDays } from "../../../lib/dates";

/** Pure view-model for the /stats page: window selection and chart series. */

type Stats = typeof StatsResponse.Type;
type StatsTotals = Stats["last30d"];
type StatsDailyModelPoint = Stats["dailyByModel"][number];
type StatsRankedMetric = Stats["sources"]["last30d"][number];

const STATS_WINDOWS = ["30d", "2026"] as const;

type StatsWindow = (typeof STATS_WINDOWS)[number];

interface StatsWindowView {
  /** Inclusive chart bounds, or null before any usage exists. */
  chartRange: { first: string; last: string } | null;
  dailyByModel: StatsDailyModelPoint[];
  label: string;
  modelsBySpend: readonly StatsRankedMetric[];
  modelsByTokens: readonly StatsRankedMetric[];
  sources: readonly StatsRankedMetric[];
  totals: StatsTotals;
}

interface AggregateCharts {
  sessions: StackedSeriesChart;
  spend: StackedSeriesChart;
  tokens: StackedSeriesChart;
}

/**
 * The latest date a real row can carry: the server's UTC date plus one day,
 * since no time zone runs more than a day ahead of UTC (UTC+14). Dates are
 * opaque per-user local buckets, so the *viewer's* "today" is no bound at all
 * — but rows past this one are corrupt (production has seen year 3089) and
 * would stretch the chart across centuries.
 */
function latestPlausibleDate(generatedAt: string): string {
  return addDays(generatedAt.slice(0, 10), 1);
}

/** The slice of the stats payload for one window, clamped to plausible dates. */
function selectStatsWindow(data: Stats, window: StatsWindow): StatsWindowView {
  const is2026 = window === "2026";
  const since = is2026 ? data.year2026Since : data.last30dSince;
  const totals = is2026 ? data.year2026 : data.last30d;
  const latest = latestPlausibleDate(data.generatedAt);
  const chartLast =
    totals.lastDate === null ? null : totals.lastDate > latest ? latest : totals.lastDate;
  const chartFirst =
    totals.firstDate === null || totals.firstDate < since ? since : totals.firstDate;

  return {
    chartRange:
      chartLast === null || totals.firstDate === null || chartFirst > chartLast
        ? null
        : { first: chartFirst, last: chartLast },
    dailyByModel: data.dailyByModel.filter((row) => row.date >= since && row.date <= latest),
    label: is2026 ? "2026" : "30d",
    modelsBySpend: is2026 ? data.topModels.year2026BySpend : data.topModels.last30dBySpend,
    modelsByTokens: is2026 ? data.topModels.year2026ByTokens : data.topModels.last30dByTokens,
    sources: is2026 ? data.sources.year2026 : data.sources.last30d,
    totals,
  };
}

/** Spend, token, and session stacks over every day of the window's usage range. */
function deriveAggregateCharts(view: StatsWindowView): AggregateCharts {
  const rows = view.dailyByModel;
  const days =
    view.chartRange === null ? [] : enumerateDays(view.chartRange.first, view.chartRange.last);
  const colors = seriesColors(rows);

  return {
    sessions: buildStackedSeriesChart(rows, days, colors, (row) => row.rowCount),
    spend: buildStackedSeriesChart(rows, days, colors, (row) => row.costUsd),
    tokens: buildStackedSeriesChart(rows, days, colors, (row) => row.totalTokens),
  };
}

function formatUsageRange(range: StatsWindowView["chartRange"]): string {
  return range === null ? "No usage yet" : `${range.first} to ${range.last}`;
}

export {
  deriveAggregateCharts,
  formatUsageRange,
  latestPlausibleDate,
  selectStatsWindow,
  STATS_WINDOWS,
};

export type { AggregateCharts, StatsRankedMetric, StatsTotals, StatsWindow, StatsWindowView };
