import type { PointerEvent, ReactNode } from "react";

import { cn } from "../../lib/cn";
import { CHART_TICKS, CHART_WIDTH, columnAt } from "./scale";
import { CHART_FOCUS_CLASS_NAME, type ChartSurfaceProps } from "./use-chart-cursor";

/**
 * The frame shared by the bar charts: value labels in a fixed HTML gutter,
 * a plot SVG that stretches to the remaining width, and an HTML label row
 * under it. Only bars and gridlines scale with the plot, so text renders at
 * its real size on a phone and on a wide desktop alike.
 */

interface AxisLabel {
  /** Horizontal centre as a 0–1 fraction of the plot. */
  center: number;
  key: string;
  label: string;
}

/** Past this many labels, narrow screens show every n-th one. */
const NARROW_LABEL_LIMIT = 6;

/** Whether label `index` of `count` is dropped on narrow screens to avoid overlap. */
function hiddenWhenNarrow(index: number, count: number): boolean {
  return count > NARROW_LABEL_LIMIT && index % Math.ceil(count / NARROW_LABEL_LIMIT) !== 0;
}

function BarChart({
  ariaLabel,
  children,
  columns,
  format,
  height,
  labels,
  max,
  onColumn,
  overlay,
  surfaceProps,
  y,
}: {
  ariaLabel: string;
  /** SVG marks in plot coordinates: x spans `CHART_WIDTH`, y spans `height` px. */
  children: ReactNode;
  /** Column count, so a pointer anywhere in a column activates it. */
  columns: number;
  format: (value: number) => string;
  /** Plot height in px; y = height is the value-0 baseline. */
  height: number;
  labels: readonly AxisLabel[];
  max: number;
  onColumn: (index: number) => void;
  /** HTML positioned over the plot (value labels, the tooltip). */
  overlay?: ReactNode;
  surfaceProps: ChartSurfaceProps;
  /** The chart's `linearScale` fn. */
  y: (value: number) => number;
}) {
  const ticks = Array.from({ length: CHART_TICKS + 1 }, (_, tick) => {
    const value = (max / CHART_TICKS) * tick;
    return { top: height - y(value), value };
  });
  const activateColumn = (event: PointerEvent<SVGSVGElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    if (columns > 0 && box.width > 0) {
      onColumn(columnAt((event.clientX - box.left) / box.width, columns));
    }
  };

  return (
    <div className="flex text-[10px] leading-none">
      <div aria-hidden="true" className="relative w-11 shrink-0" style={{ height }}>
        {ticks.map(({ top, value }) => (
          <span
            className="absolute right-1.5 -translate-y-1/2 whitespace-nowrap tabular-nums opacity-45"
            key={value}
            style={{ top }}
          >
            {format(value)}
          </span>
        ))}
      </div>
      <div className="relative min-w-0 flex-1">
        <svg
          aria-label={ariaLabel}
          className={cn("block w-full touch-pan-y select-none", CHART_FOCUS_CLASS_NAME)}
          height={height}
          onPointerDown={activateColumn}
          onPointerMove={activateColumn}
          preserveAspectRatio="none"
          role="img"
          viewBox={`0 0 ${CHART_WIDTH} ${height}`}
          {...surfaceProps}
        >
          {ticks.map(({ top }, tick) => (
            <line
              key={tick}
              stroke="currentColor"
              strokeOpacity={tick === 0 ? 0.28 : 0.09}
              vectorEffect="non-scaling-stroke"
              x1={0}
              x2={CHART_WIDTH}
              y1={top}
              y2={top}
            />
          ))}
          {children}
        </svg>
        <div aria-hidden="true" className="relative h-6">
          {labels.map((label, index) => (
            <span
              className={cn(
                "absolute top-2 -translate-x-1/2 whitespace-nowrap opacity-45",
                hiddenWhenNarrow(index, labels.length) && "max-sm:hidden",
              )}
              key={label.key}
              style={{ left: `${label.center * 100}%` }}
            >
              {label.label}
            </span>
          ))}
        </div>
        {overlay}
      </div>
    </div>
  );
}

/**
 * Fades every column but `active` by covering the rest of the plot with the
 * page background, so hover needs no per-bar re-render.
 */
function ColumnSpotlight({
  active,
  height,
  slot,
}: {
  active: number | null;
  height: number;
  slot: number;
}) {
  if (active === null) {
    return null;
  }

  const start = slot * active;
  const end = start + slot;
  return (
    <g className="pointer-events-none fill-background" opacity={0.55}>
      <rect height={height} width={start} x={0} y={0} />
      <rect height={height} width={Math.max(CHART_WIDTH - end, 0)} x={end} y={0} />
    </g>
  );
}

export { BarChart, ColumnSpotlight, hiddenWhenNarrow };

export type { AxisLabel };
