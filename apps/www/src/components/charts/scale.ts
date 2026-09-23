/**
 * Shared chart geometry. Charts are pure SVG; everything here is
 * deterministic and unit-testable.
 */

/**
 * ViewBox width of every bar chart's plot. The plot SVG stretches to its box
 * horizontally (text lives outside it, in HTML), so this only sets bar
 * proportions; heights are real pixels.
 */
const CHART_WIDTH = 940;
/** Gridline count; `CHART_TICKS + 1` lines render, including the baseline. */
const CHART_TICKS = 4;

interface BarLayout {
  barWidth: number;
  slot: number;
}

function linearScale(domainMax: number, rangeMax: number) {
  const safeMax = domainMax <= 0 ? 1 : domainMax;

  return (value: number) => (value / safeMax) * rangeMax;
}

/**
 * Slot width and bar width shared by the vertical bar charts. `fill` is the
 * fraction of the slot the bar occupies, capped at `cap` and floored at `floor`.
 */
function barLayout(count: number, fill: number, cap: number, floor = 0): BarLayout {
  const slot = CHART_WIDTH / Math.max(count, 1);
  const barWidth = Math.max(Math.min(slot * fill, cap), floor);

  return { barWidth, slot };
}

/** Left edge of column `index` — where its full-height hover target starts. */
function slotX(layout: BarLayout, index: number): number {
  return layout.slot * index;
}

/** Left edge of the bar centred inside column `index`. */
function barX(layout: BarLayout, index: number): number {
  return slotX(layout, index) + (layout.slot - layout.barWidth) / 2;
}

/** Horizontal centre of column `index`. */
function barCenter(layout: BarLayout, index: number): number {
  return barX(layout, index) + layout.barWidth / 2;
}

/** Column under a pointer `fraction` (0–1) of the way across the plot. */
function columnAt(fraction: number, count: number): number {
  return Math.min(Math.max(Math.floor(fraction * count), 0), count - 1);
}

/** Two decimals are sub-pixel at any size and keep server-rendered SVG compact. */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Largest value, or 0 for none. A loop rather than `Math.max(...values)`,
 * whose spread overflows the call stack on long series.
 */
function maxValue<T>(items: Iterable<T>, value: (item: T) => number): number {
  let max = 0;
  for (const item of items) {
    max = Math.max(max, value(item));
  }

  return max;
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

export {
  barCenter,
  barLayout,
  barX,
  CHART_TICKS,
  CHART_WIDTH,
  columnAt,
  linearScale,
  maxValue,
  niceMax,
  round2,
  slotX,
};

export type { BarLayout };
