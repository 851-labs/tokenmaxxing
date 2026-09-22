/**
 * Shared chart geometry. Charts are pure SVG; everything here is
 * deterministic and unit-testable.
 */

/** Shared bar-chart geometry so the charts can't drift apart. */
const CHART_WIDTH = 940;
/** Left gutter (px) reserved for the value-axis labels. */
const CHART_AXIS = 44;
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
  const slot = (CHART_WIDTH - CHART_AXIS) / Math.max(count, 1);
  const barWidth = Math.max(Math.min(slot * fill, cap), floor);

  return { barWidth, slot };
}

/** Left edge of column `index` — where its full-height hover target starts. */
function slotX(layout: BarLayout, index: number): number {
  return CHART_AXIS + layout.slot * index;
}

/** Left edge of the bar centred inside column `index`. */
function barX(layout: BarLayout, index: number): number {
  return slotX(layout, index) + (layout.slot - layout.barWidth) / 2;
}

/** Horizontal centre of column `index`. */
function barCenter(layout: BarLayout, index: number): number {
  return barX(layout, index) + layout.barWidth / 2;
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
  CHART_AXIS,
  CHART_TICKS,
  CHART_WIDTH,
  linearScale,
  maxValue,
  niceMax,
  slotX,
};

export type { BarLayout };
