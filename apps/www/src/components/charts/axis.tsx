import { CHART_AXIS, CHART_TICKS, CHART_WIDTH, slotX, type BarLayout } from "./scale";

/**
 * Horizontal gridlines + right-aligned value labels shared by the bar charts.
 * Passing `y` + `baseline` (rather than a fixed range) keeps each chart's own
 * headroom: charts scale `y` to different plot heights but share this axis.
 */
function ChartGrid({
  baseline,
  format,
  max,
  y,
}: {
  /** y pixel of the value=0 line (each chart's HEIGHT). */
  baseline: number;
  format: (value: number) => string;
  max: number;
  /** The chart's `linearScale` fn. */
  y: (value: number) => number;
}) {
  return (
    <>
      {Array.from({ length: CHART_TICKS + 1 }, (_, tick) => {
        const value = (max / CHART_TICKS) * tick;
        const yPos = baseline - y(value);
        return (
          <g key={tick}>
            <line
              stroke="currentColor"
              strokeOpacity={tick === 0 ? 0.28 : 0.09}
              x1={CHART_AXIS}
              x2={CHART_WIDTH}
              y1={yPos}
              y2={yPos}
            />
            <text
              className="fill-current opacity-45"
              fontSize={10}
              textAnchor="end"
              x={CHART_AXIS - 6}
              y={yPos + 3}
            >
              {format(value)}
            </text>
          </g>
        );
      })}
    </>
  );
}

/** Invisible hover target spanning the full height of column `index`. */
function ColumnHitArea({
  height,
  index,
  layout,
}: {
  height: number;
  index: number;
  layout: BarLayout;
}) {
  return (
    <rect fill="transparent" height={height} width={layout.slot} x={slotX(layout, index)} y={0} />
  );
}

export { ChartGrid, ColumnHitArea };
