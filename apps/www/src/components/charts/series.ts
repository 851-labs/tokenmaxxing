import { STATS_CHART_MODEL_LIMIT, STATS_OTHER_MODEL_KEY } from "@tokenmaxxing/api-contract";

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
const OTHER_MODEL_SERIES = STATS_OTHER_MODEL_KEY;
const OTHER_MODEL_SERIES_COLOR = "#9ca3af";

const DYNAMIC_SERIES_COLORS = [
  "#f59e0b",
  "#2563eb",
  "#dc2626",
  "#16a34a",
  "#9333ea",
  "#0891b2",
  "#ea580c",
  "#db2777",
  "#65a30d",
  "#7c3aed",
  "#0d9488",
  "#475569",
] as const;

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

/** Stable raw-model color assignment shared by every metric on a page. */
function seriesColors<Row extends { key: string }>(rows: readonly Row[]): Map<string, string> {
  const models = [...new Set(rows.map((row) => row.key))].sort((a, b) => a.localeCompare(b));
  const colors = new Map<string, string>();
  for (const [index, model] of models.entries()) {
    colors.set(
      model,
      DYNAMIC_SERIES_COLORS[index % DYNAMIC_SERIES_COLORS.length] ?? OTHER_MODEL_SERIES_COLOR,
    );
  }
  colors.set(OTHER_MODEL_SERIES, OTHER_MODEL_SERIES_COLOR);

  return colors;
}

function seriesColor(colors: ReadonlyMap<string, string>, series: string): string {
  return colors.get(series) ?? OTHER_MODEL_SERIES_COLOR;
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
function buildLegend(
  days: readonly StackedDay[],
  colors: ReadonlyMap<string, string>,
): LegendEntry[] {
  const valueBySeries = new Map<string, number>();
  let total = 0;
  for (const day of days) {
    for (const segment of day.segments) {
      valueBySeries.set(segment.series, (valueBySeries.get(segment.series) ?? 0) + segment.value);
      total += segment.value;
    }
  }

  return [...colors.keys()]
    .map((series) => ({
      color: seriesColor(colors, series),
      percent: total > 0 ? ((valueBySeries.get(series) ?? 0) / total) * 100 : 0,
      series,
      value: valueBySeries.get(series) ?? 0,
    }))
    .filter((entry) => entry.value > 0)
    .sort((a, b) => b.value - a.value)
    .map(({ color, percent, series }) => ({ color, percent, series }));
}

/** Select series by `value`, then build zero-filled stacked days and a legend. */
function buildStackedSeriesChart<Row extends SeriesRow>(
  rows: readonly Row[],
  dates: readonly string[],
  colors: ReadonlyMap<string, string>,
  value: (row: Row) => number,
): StackedSeriesChart {
  const selection = selectModelSeries(rows, value);
  const buckets = bucketSeries(rows, selection, value);
  const days = buildStackedDays(dates, selection.order, colors, buckets);

  return { buckets, days, legend: buildLegend(days, colors), selection };
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
  buildStackedSeriesChart,
  MODEL_SERIES_LIMIT,
  OTHER_MODEL_SERIES,
  OTHER_MODEL_SERIES_COLOR,
  segmentTooltipRows,
  selectModelSeries,
  seriesColor,
  seriesColors,
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
