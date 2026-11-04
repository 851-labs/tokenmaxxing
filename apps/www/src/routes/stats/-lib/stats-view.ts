import type {
  StatsDailyPoint,
  StatsRange,
  StatsRankedMetric,
  StatsResponse,
  StatsSeriesPoint,
  UsageRangeId,
} from "@tokenmaxxing/api-contract";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

import { bucketDays } from "../../../components/charts/day-buckets";
import { OTHER_MODEL_SERIES } from "../../../components/charts/model-colors";
import type { StackedDay, StackedSeriesChart } from "../../../components/charts/series";
import { bucketedStackedCharts } from "../../../components/charts/trend";
import { agentLabel } from "../../../lib/agents";
import { addDays, dayNumber } from "../../../lib/dates";
import { percentOf } from "../../../lib/format";
import type { DayWindow } from "../../../lib/usage-ranges";

/**
 * Pure view-model for /stats: one range of the stats payload, measured by one
 * metric, as the page's cards, series charts with their ranked tables, and the
 * active-users chart.
 */

const StatsMetric = Schema.Literals(["tokens", "spend"]);

type StatsMetric = typeof StatsMetric.Type;

const DEFAULT_STATS_METRIC: StatsMetric = "tokens";

/**
 * Pre-range `?window=` links: `30d` opens one month, `ytd` (and the older
 * `2026`, which TanStack's default parser turns into a number) year to date.
 */
const LegacyStatsWindow = Schema.Union([
  Schema.Literal("30d").pipe(
    Schema.decodeTo(
      Schema.Literal("1m"),
      SchemaTransformation.transform<"1m", "30d">({ decode: () => "1m", encode: () => "30d" }),
    ),
  ),
  Schema.Literal("ytd"),
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

/** One series in a section's chart, as its table row. */
interface SeriesRow {
  color: string;
  key: string;
  label: string;
  /** Share of the range's selected metric, 0–100. */
  percent: number;
  spendUsd: number;
  totalTokens: number;
  /** Distinct users in the range; null for "Other", whose users overlap the named rows'. */
  userCount: number | null;
}

interface SeriesSection {
  chart: StackedSeriesChart;
  rows: SeriesRow[];
}

interface StatsCards {
  /** The range's busiest day by the selected metric, or null without usage. */
  busiestDay: { date: string; value: number } | null;
  /** Cache-read share of all tokens, 0–100. */
  cacheReadPercent: number;
  spendPerUser: number;
  spendUsd: number;
  topAgent: string | null;
  topModel: string | null;
  totalTokens: number;
  userCount: number;
}

interface StatsView {
  /** Average daily active users per bar. */
  activeUsers: StackedDay[];
  agents: SeriesSection;
  /** Days per bar, shared by every chart. */
  bucketDays: number;
  cards: StatsCards;
  models: SeriesSection;
  /** The days the range covers, or null before any usage exists. */
  window: DayWindow | null;
}

const ACTIVE_USERS_SERIES = "Active users";
const ACTIVE_USERS_COLOR = "#2563eb";

function metricOf(metric: StatsMetric): (row: { spendUsd: number; totalTokens: number }) => number {
  return metric === "spend" ? (row) => row.spendUsd : (row) => row.totalTokens;
}

/**
 * The range's charted days: from its start through the server's UTC today.
 * Devices whose local day already leads UTC can date usage tomorrow; that
 * sliver counts in the range's totals but would draw as a near-empty last
 * bar, so charts end today.
 */
function rangeWindow(data: StatsResponse, range: StatsRange): DayWindow | null {
  const today = data.generatedAt.slice(0, 10);
  const last = data.daily.at(-1)?.date;
  if (last === undefined || last < range.since) {
    return null;
  }

  return { firstDate: range.since, lastDate: last > today ? today : last };
}

function inWindow<Row extends { date: string }>(rows: readonly Row[], window: DayWindow): Row[] {
  return rows.filter((row) => row.date >= window.firstDate && row.date <= window.lastDate);
}

function deriveStatsView(
  data: StatsResponse,
  rangeId: UsageRangeId,
  metric: StatsMetric,
): StatsView {
  const range = data.ranges[rangeId];
  const window = rangeWindow(data, range);
  const value = metricOf(metric);
  // Ends before it starts: charts over it have no bars.
  const empty: DayWindow = { firstDate: range.since, lastDate: addDays(range.since, -1) };
  const days = window === null ? [] : inWindow(data.daily, window);

  const models = seriesSection(
    window === null ? [] : inWindow(data.dailyByModel, window),
    window ?? empty,
    value,
    [...range.modelsByTokens, ...range.modelsBySpend],
    (key) => key,
  );
  const agents = seriesSection(
    window === null ? [] : inWindow(data.dailyBySource, window),
    window ?? empty,
    value,
    range.sources,
    agentLabel,
  );
  const topAgent = [...range.sources].sort((left, right) => value(right) - value(left))[0];
  const topModel = (metric === "spend" ? range.modelsBySpend : range.modelsByTokens)[0];
  const busiest = days.reduce<StatsDailyPoint | undefined>(
    (best, day) => (best === undefined || value(day) > value(best) ? day : best),
    undefined,
  );
  const { totals } = range;

  return {
    activeUsers: window === null ? [] : activeUserDays(days, window),
    agents: agents.section,
    bucketDays: models.bucketDays,
    cards: {
      busiestDay: busiest === undefined ? null : { date: busiest.date, value: value(busiest) },
      cacheReadPercent: percentOf(totals.cacheReadTokens, totals.totalTokens),
      spendPerUser: totals.userCount === 0 ? 0 : totals.spendUsd / totals.userCount,
      spendUsd: totals.spendUsd,
      topAgent: topAgent === undefined ? null : agentLabel(topAgent.key),
      topModel: topModel?.key ?? null,
      totalTokens: totals.totalTokens,
      userCount: totals.userCount,
    },
    models: models.section,
    window,
  };
}

/**
 * A stacked chart of the window's series by the selected metric, plus one
 * table row per charted series (the chart's legend, with users and both
 * metrics). Ranked rows come from the server, which counts distinct users.
 */
function seriesSection(
  rows: readonly StatsSeriesPoint[],
  window: DayWindow,
  value: (row: { spendUsd: number; totalTokens: number }) => number,
  ranked: readonly StatsRankedMetric[],
  labelOf: (key: string) => string,
): { bucketDays: number; section: SeriesSection } {
  const { bucketDays: size, charts } = bucketedStackedCharts(rows, window, { value });
  const chart = charts.value;
  const rankedByKey = new Map(ranked.map((row) => [row.key, row]));

  const sums = new Map<string, { spendUsd: number; totalTokens: number }>();
  let total = 0;
  for (const row of rows) {
    const series = chart.selection.label(row.key);
    const sum = sums.get(series) ?? { spendUsd: 0, totalTokens: 0 };
    sum.spendUsd += row.spendUsd;
    sum.totalTokens += row.totalTokens;
    sums.set(series, sum);
    total += value(row);
  }

  const colors = new Map(chart.legend.map((entry) => [entry.series, entry.color]));
  const tableRows = chart.selection.order.flatMap((series): SeriesRow[] => {
    const sum = sums.get(series);
    const color = colors.get(series);
    if (sum === undefined || color === undefined) {
      return [];
    }

    return [
      {
        color,
        key: series,
        label: series === OTHER_MODEL_SERIES ? "Other" : labelOf(series),
        percent: percentOf(value(sum), total),
        spendUsd: sum.spendUsd,
        totalTokens: sum.totalTokens,
        userCount:
          series === OTHER_MODEL_SERIES ? null : (rankedByKey.get(series)?.userCount ?? null),
      },
    ];
  });

  return { bucketDays: size, section: { chart, rows: tableRows } };
}

/** Average daily active users per bar, over the same buckets as the series charts. */
function activeUserDays(days: readonly StatsDailyPoint[], window: DayWindow): StackedDay[] {
  const bucketing = bucketDays(window.firstDate, window.lastDate);
  const users = new Map<string, number>();
  for (const day of days) {
    const bucket = bucketing.bucketOf(day.date);
    if (bucket !== undefined) {
      users.set(bucket, (users.get(bucket) ?? 0) + day.userCount);
    }
  }

  return bucketing.buckets.map((bucket) => {
    const span = dayNumber(bucket.last) - dayNumber(bucket.first) + 1;
    const average = (users.get(bucket.first) ?? 0) / span;

    return {
      date: bucket.first,
      endDate: bucket.last,
      segments: [{ color: ACTIVE_USERS_COLOR, series: ACTIVE_USERS_SERIES, value: average }],
      total: average,
    };
  });
}

export { DEFAULT_STATS_METRIC, deriveStatsView, LegacyStatsWindow, StatsMetric };

export type { SeriesRow, SeriesSection, StatsCards, StatsView };
