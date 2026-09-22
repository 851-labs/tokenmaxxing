import type {
  StatsChartPoint,
  StatsResponse,
  StatsWindow,
  StatsWindowId,
} from "@tokenmaxxing/api-contract";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

import {
  buildStackedSeriesChart,
  seriesColors,
  type StackedSeriesChart,
} from "../../../components/charts/series";
import { addDays, enumerateDays } from "../../../lib/dates";

/** Pure view-model for the /stats page: window selection and chart series. */

/** The page's tabs, each backed by one of the API's stats windows. */
const STATS_TAB_WINDOWS = {
  "30d": "last30d",
  ytd: "ytd",
} as const satisfies Record<string, StatsWindowId>;

type StatsTab = keyof typeof STATS_TAB_WINDOWS;

/**
 * `?window=` values. `2026` links predate year-to-date and now open `ytd`;
 * TanStack's default search parser JSON-parses a bare `2026` into a number,
 * so the legacy value arrives as either type.
 */
const StatsTabParam = Schema.Union([
  Schema.Literals(["30d", "ytd"]),
  Schema.Literals(["2026", 2026]).pipe(
    Schema.decodeTo(
      Schema.Literal("ytd"),
      SchemaTransformation.transform<"ytd", "2026" | 2026>({
        decode: () => "ytd",
        encode: () => "2026",
      }),
    ),
  ),
]);

interface StatsWindowView {
  /** Inclusive chart bounds, or null before any usage exists. */
  chartRange: { first: string; last: string } | null;
  dailyByModel: StatsChartPoint[];
  label: string;
  window: StatsWindow;
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

/** One window of the stats payload, with chart rows clamped to plausible dates. */
function selectStatsWindow(data: StatsResponse, tab: StatsTab): StatsWindowView {
  const window = data.windows[STATS_TAB_WINDOWS[tab]];
  const { totals } = window;
  const { since } = window;
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
    dailyByModel: window.dailyByModel.filter((row) => row.date >= since && row.date <= latest),
    label: tab === "ytd" ? ytdLabel(data) : "30d",
    window,
  };
}

/** The server's current year, e.g. "2026" — `ytd.since` is always Jan 1 of it. */
function ytdLabel(data: StatsResponse): string {
  return data.windows.ytd.since.slice(0, 4);
}

/** Spend, token, and session stacks over every day of the window's usage range. */
function deriveAggregateCharts(view: StatsWindowView): AggregateCharts {
  const rows = view.dailyByModel;
  const days =
    view.chartRange === null ? [] : enumerateDays(view.chartRange.first, view.chartRange.last);
  const colors = seriesColors(rows);

  return {
    sessions: buildStackedSeriesChart(rows, days, colors, (row) => row.rowCount),
    spend: buildStackedSeriesChart(rows, days, colors, (row) => row.spendUsd),
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
  StatsTabParam,
  ytdLabel,
};

export type { AggregateCharts, StatsTab, StatsWindowView };
