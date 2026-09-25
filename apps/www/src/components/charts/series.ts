import { STATS_CHART_MODEL_LIMIT } from "@tokenmaxxing/api-contract";

import { assignModelColors, modelColor, OTHER_MODEL_SERIES } from "./model-colors";

/**
 * Model-series selection and the pure transforms that turn daily usage rows
 * into stacked-chart days, month buckets, legends, and tooltip rows.
 */

interface ChartSegment {
  color: string;
  series: string;
  value: number;
}

interface StackedDay {
  date: string;
  /** Series pre-sorted by overall rank. */
  segments: ChartSegment[];
  total: number;
}

interface LegendEntry {
  color: string;
  series: string;
  /** Share of charted metric, 0–100. */
  percent: number;
}

interface TooltipRow {
  color?: string;
  label: string;
  value: string;
}

interface ModelSeriesSelection {
  label(model: string): string;
  order: readonly string[];
}

/** Per-bucket totals plus per-bucket, per-series sums. */
interface SeriesBuckets {
  totals: Map<string, number>;
  values: Map<string, Map<string, number>>;
}

interface StackedSeriesChart {
  buckets: SeriesBuckets;
  days: StackedDay[];
  legend: LegendEntry[];
  selection: ModelSeriesSelection;
}

interface SeriesRow {
  date: string;
  key: string;
}

/** The API keeps enough models per stats chart for exactly this many series. */
const MODEL_SERIES_LIMIT = STATS_CHART_MODEL_LIMIT;

/**
 * Keep the highest-value raw model names and collapse only the remaining long
 * tail. Ranking across the full chart range keeps stack positions stable from
 * day to day. Rows already keyed "Other" (the API pre-collapses the stats
 * long tail) are never ranked as a model and always make the tail visible.
 */
function selectModelSeries<Row extends { key: string }>(
  rows: readonly Row[],
  value: (row: Row) => number,
  limit = MODEL_SERIES_LIMIT,
): ModelSeriesSelection {
  const valueByModel = new Map<string, number>();
  let hasCollapsedTail = false;
  for (const row of rows) {
    if (row.key === OTHER_MODEL_SERIES) {
      hasCollapsedTail = true;
    } else {
      valueByModel.set(row.key, (valueByModel.get(row.key) ?? 0) + value(row));
    }
  }

  const ranked = [...valueByModel.entries()]
    .sort(
      ([leftModel, leftValue], [rightModel, rightValue]) =>
        rightValue - leftValue || leftModel.localeCompare(rightModel),
    )
    .map(([model]) => model);
  const safeLimit = Math.max(Math.floor(limit), 1);
  const hasOverflow = hasCollapsedTail || ranked.length > safeLimit;
  const visible = ranked.slice(0, hasOverflow ? safeLimit - 1 : safeLimit);
  const visibleSet = new Set(visible);

  return {
    label: (model) => (visibleSet.has(model) ? model : OTHER_MODEL_SERIES),
    order: hasOverflow ? [...visible, OTHER_MODEL_SERIES] : visible,
  };
}

function seriesColor(colors: ReadonlyMap<string, string>, series: string): string {
  return colors.get(series) ?? modelColor(series);
}

/**
 * Sum `value` per bucket (the row's date by default) and per selected series
 * within each bucket.
 */
function bucketSeries<Row extends SeriesRow>(
  rows: readonly Row[],
  selection: ModelSeriesSelection,
  value: (row: Row) => number,
  bucketOf: (row: Row) => string = (row) => row.date,
): SeriesBuckets {
  const totals = new Map<string, number>();
  const values = new Map<string, Map<string, number>>();
  for (const row of rows) {
    const bucket = bucketOf(row);
    const amount = value(row);
    const series = selection.label(row.key);
    totals.set(bucket, (totals.get(bucket) ?? 0) + amount);
    const bySeries = values.get(bucket) ?? new Map<string, number>();
    bySeries.set(series, (bySeries.get(series) ?? 0) + amount);
    values.set(bucket, bySeries);
  }

  return { totals, values };
}

/** One segment per series in `order`, zero-filled where a bucket has no value. */
function buildSegments(
  order: readonly string[],
  colors: ReadonlyMap<string, string>,
  values: ReadonlyMap<string, number> | undefined,
): ChartSegment[] {
  return order.map((series) => ({
    color: seriesColor(colors, series),
    series,
    value: values?.get(series) ?? 0,
  }));
}

function buildStackedDays(
  days: readonly string[],
  order: readonly string[],
  colors: ReadonlyMap<string, string>,
  buckets: SeriesBuckets,
): StackedDay[] {
  return days.map((date) => ({
    date,
    segments: buildSegments(order, colors, buckets.values.get(date)),
    total: buckets.totals.get(date) ?? 0,
  }));
}

/** Ranked legend entries for every series with a non-zero share. */
function buildLegend(days: readonly StackedDay[]): LegendEntry[] {
  const bySeries = new Map<string, { color: string; value: number }>();
  let total = 0;
  for (const day of days) {
    for (const segment of day.segments) {
      const entry = bySeries.get(segment.series) ?? { color: segment.color, value: 0 };
      entry.value += segment.value;
      bySeries.set(segment.series, entry);
      total += segment.value;
    }
  }

  return [...bySeries.entries()]
    .filter(([, entry]) => entry.value > 0)
    .sort(([, a], [, b]) => b.value - a.value)
    .map(([series, entry]) => ({
      color: entry.color,
      percent: total > 0 ? (entry.value / total) * 100 : 0,
      series,
    }));
}

/**
 * One stacked chart per metric over the same rows. Each metric selects its
 * own top series; colors are assigned once across all of them, so a model
 * wears one color on the page and never shares it within a chart.
 */
function buildStackedSeriesCharts<Row extends SeriesRow, Metric extends string>(
  rows: readonly Row[],
  dates: readonly string[],
  metrics: Readonly<Record<Metric, (row: Row) => number>>,
): { charts: Record<Metric, StackedSeriesChart>; colors: ReadonlyMap<string, string> } {
  const entries = (Object.entries(metrics) as [Metric, (row: Row) => number][]).map(
    ([metric, value]) => ({ metric, selection: selectModelSeries(rows, value), value }),
  );
  const colors = assignModelColors(entries.map(({ selection }) => selection.order));
  const charts = {} as Record<Metric, StackedSeriesChart>;
  for (const { metric, selection, value } of entries) {
    const buckets = bucketSeries(rows, selection, value);
    const days = buildStackedDays(dates, selection.order, colors, buckets);
    charts[metric] = { buckets, days, legend: buildLegend(days), selection };
  }

  return { charts, colors };
}

/** Non-zero segments, largest first, as tooltip rows. */
function segmentTooltipRows(
  segments: readonly ChartSegment[],
  format: (segment: ChartSegment) => string,
): TooltipRow[] {
  return segments
    .filter((segment) => segment.value > 0)
    .sort((a, b) => b.value - a.value)
    .map((segment) => ({ color: segment.color, label: segment.series, value: format(segment) }));
}

export {
  bucketSeries,
  buildLegend,
  buildSegments,
  buildStackedDays,
  buildStackedSeriesCharts,
  MODEL_SERIES_LIMIT,
  segmentTooltipRows,
  selectModelSeries,
};

export type {
  ChartSegment,
  LegendEntry,
  ModelSeriesSelection,
  SeriesBuckets,
  StackedDay,
  StackedSeriesChart,
  TooltipRow,
};
