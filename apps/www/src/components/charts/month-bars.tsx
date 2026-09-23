import { useMemo } from "react";

import { cn } from "../../lib/cn";
import { formatMonth, formatMonthLong, formatUsd } from "../../lib/format";
import { BarChart, ColumnSpotlight, hiddenWhenNarrow } from "./axis";
import {
  barCenter,
  barLayout,
  barX,
  CHART_WIDTH,
  linearScale,
  maxValue,
  niceMax,
  round2,
} from "./scale";
import { segmentTooltipRows, type ChartSegment } from "./series";
import { anchorLeft, ChartLiveRegion, ChartTooltip } from "./tooltip";
import { useChartCursor } from "./use-chart-cursor";

/** Spend per calendar month with value labels above each bar. */

interface MonthPoint {
  /** YYYY-MM */
  month: string;
  segments: ChartSegment[];
  value: number;
}

const HEIGHT = 220;

function MonthBars({ months }: { months: readonly MonthPoint[] }) {
  const cursor = useChartCursor(months.length);
  const hovered = cursor.active;

  const max = useMemo(() => niceMax(maxValue(months, (point) => point.value)), [months]);
  const y = linearScale(max, HEIGHT - 26);
  const layout = barLayout(months.length, 0.55, 44);

  const active = hovered === null ? undefined : months[hovered];
  const centerOf = (index: number) => barCenter(layout, index) / CHART_WIDTH;

  return (
    <BarChart
      ariaLabel={`Monthly spend across ${months.length} months`}
      columns={months.length}
      format={formatUsd}
      height={HEIGHT}
      labels={months.map((point, index) => ({
        center: centerOf(index),
        key: point.month,
        label: formatMonth(point.month),
      }))}
      max={max}
      onColumn={cursor.setActive}
      overlay={
        <>
          {months.map((point, index) =>
            point.value > 0 ? (
              <span
                aria-hidden="true"
                className={cn(
                  "pointer-events-none absolute -translate-x-1/2 whitespace-nowrap font-medium text-muted-foreground",
                  hiddenWhenNarrow(index, months.length) && "max-sm:hidden",
                )}
                key={point.month}
                style={{ left: `${centerOf(index) * 100}%`, top: HEIGHT - y(point.value) - 16 }}
              >
                {formatUsd(point.value)}
              </span>
            ) : null,
          )}
          <ChartLiveRegion>
            {active !== undefined && hovered !== null ? (
              <ChartTooltip
                className="w-56 -translate-y-full"
                rows={segmentTooltipRows(active.segments, (segment) => formatUsd(segment.value))}
                style={{
                  left: anchorLeft(centerOf(hovered), 11),
                  top: `${HEIGHT - y(active.value) - 12}px`,
                }}
                subtitle={`${formatUsd(active.value)} total`}
                title={formatMonthLong(active.month)}
              />
            ) : null}
          </ChartLiveRegion>
        </>
      }
      surfaceProps={cursor.surfaceProps}
      y={y}
    >
      {months.map((point, index) => {
        const x = round2(barX(layout, index));
        let stackTop = HEIGHT;
        return point.segments.map((segment) => {
          if (segment.value <= 0) {
            return null;
          }
          const height = y(segment.value);
          stackTop -= height;
          return (
            <rect
              fill={segment.color}
              height={round2(height)}
              key={`${point.month}-${segment.series}`}
              width={round2(layout.barWidth)}
              x={x}
              y={round2(stackTop)}
            />
          );
        });
      })}
      <ColumnSpotlight active={hovered} height={HEIGHT} slot={layout.slot} />
    </BarChart>
  );
}

export { MonthBars };

export type { MonthPoint };
