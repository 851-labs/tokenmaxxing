/**
 * Shared chart math, model-series selection, and number
 * formatting. Charts are pure SVG; everything here is deterministic and
 * unit-testable.
 */

/** Shared bar-chart geometry so the charts can't drift apart. */
const CHART_WIDTH = 940;
/** Left gutter (px) reserved for the value-axis labels. */
const CHART_AXIS = 44;
/** Gridline count; `CHART_TICKS + 1` lines render, including the baseline. */
const CHART_TICKS = 4;

function linearScale(domainMax: number, rangeMax: number) {
  const safeMax = domainMax <= 0 ? 1 : domainMax;

  return (value: number) => (value / safeMax) * rangeMax;
}

/**
 * Slot width and bar width shared by the vertical bar charts. `fill` is the
 * fraction of the slot the bar occupies, capped at `cap` and floored at `floor`.
 */
function barLayout(count: number, fill: number, cap: number, floor = 0) {
  const slot = (CHART_WIDTH - CHART_AXIS) / Math.max(count, 1);
  const barWidth = Math.max(Math.min(slot * fill, cap), floor);

  return { barWidth, slot };
}

/** "Nice" axis max so gridlines land on round numbers. */
function niceMax(value: number): number {
  if (value <= 0) {
    return 1;
  }

  const exponent = Math.floor(Math.log10(value));
  const fraction = value / 10 ** exponent;
  const niceFraction = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10;

  return niceFraction * 10 ** exponent;
}

const MODEL_SERIES_LIMIT = 10;
const OTHER_MODEL_SERIES = "Other";
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

interface ModelSeriesSelection {
  label(model: string): string;
  order: readonly string[];
}

/**
 * Keep the highest-value raw model names and collapse only the remaining long
 * tail. Ranking across the full chart range keeps stack positions stable from
 * day to day.
 */
function selectModelSeries<Row extends { key: string }>(
  rows: readonly Row[],
  value: (row: Row) => number,
  limit = MODEL_SERIES_LIMIT,
): ModelSeriesSelection {
  const valueByModel = new Map<string, number>();
  for (const row of rows) {
    valueByModel.set(row.key, (valueByModel.get(row.key) ?? 0) + value(row));
  }

  const ranked = [...valueByModel.entries()]
    .sort(
      ([leftModel, leftValue], [rightModel, rightValue]) =>
        rightValue - leftValue || leftModel.localeCompare(rightModel),
    )
    .map(([model]) => model);
  const safeLimit = Math.max(Math.floor(limit), 1);
  const hasOverflow = ranked.length > safeLimit;
  const visible = ranked.slice(0, hasOverflow ? safeLimit - 1 : safeLimit);
  const visibleSet = new Set(visible);
  const order = hasOverflow
    ? [...visible.filter((model) => model !== OTHER_MODEL_SERIES), OTHER_MODEL_SERIES]
    : visible;

  return {
    label: (model) => (visibleSet.has(model) ? model : OTHER_MODEL_SERIES),
    order,
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

const usd0 = new Intl.NumberFormat("en-US", {
  currency: "USD",
  maximumFractionDigits: 0,
  style: "currency",
});

const usd2 = new Intl.NumberFormat("en-US", {
  currency: "USD",
  maximumFractionDigits: 2,
  minimumFractionDigits: 2,
  style: "currency",
});

function formatUsd(value: number): string {
  return value >= 100 ? usd0.format(value) : usd2.format(value);
}

function formatTokens(value: number): string {
  if (value >= 1e12) {
    return `${(value / 1e12).toFixed(2)}T`;
  }
  if (value >= 1e9) {
    return `${(value / 1e9).toFixed(2)}B`;
  }
  if (value >= 1e6) {
    return `${(value / 1e6).toFixed(1)}M`;
  }
  if (value >= 1e3) {
    return `${(value / 1e3).toFixed(1)}K`;
  }

  return value.toFixed(0);
}

const monthLabel = new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" });
const monthLongLabel = new Intl.DateTimeFormat("en-US", {
  month: "long",
  timeZone: "UTC",
  year: "numeric",
});
const dayLabel = new Intl.DateTimeFormat("en-US", {
  day: "numeric",
  month: "short",
  timeZone: "UTC",
  weekday: "short",
  year: "numeric",
});

/** Opaque YYYY-MM-DD keys render via UTC so no local-tz shifting occurs. */
function formatDay(date: string): string {
  return dayLabel.format(new Date(`${date}T00:00:00Z`));
}

function formatMonth(month: string): string {
  return monthLabel.format(new Date(`${month}-01T00:00:00Z`));
}

/** Full month + year, e.g. "June 2026" — used in tooltips. */
function formatMonthLong(month: string): string {
  return monthLongLabel.format(new Date(`${month}-01T00:00:00Z`));
}

/** Every YYYY-MM-DD between two inclusive bounds (pure string walking). */
function enumerateDays(first: string, last: string): string[] {
  const out: string[] = [];
  const cursor = new Date(`${first}T00:00:00Z`);
  const end = new Date(`${last}T00:00:00Z`);
  while (cursor.getTime() <= end.getTime()) {
    out.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return out;
}

export {
  barLayout,
  CHART_AXIS,
  CHART_TICKS,
  CHART_WIDTH,
  enumerateDays,
  formatDay,
  formatMonth,
  formatMonthLong,
  formatTokens,
  formatUsd,
  linearScale,
  niceMax,
  selectModelSeries,
  seriesColors,
};
