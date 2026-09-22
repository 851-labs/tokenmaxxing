import { useMemo } from "react";

import { cn } from "../../lib/cn";
import { formatMonth, formatMonthLong, formatUsd } from "../../lib/format";
import { ChartGrid, ColumnHitArea } from "./axis";
import { barCenter, barLayout, barX, CHART_WIDTH, linearScale, maxValue, niceMax } from "./scale";
import { segmentTooltipRows, type ChartSegment } from "./series";
import { anchorLeft, ChartLiveRegion, ChartTooltip } from "./tooltip";
import { CHART_FOCUS_CLASS_NAME, useChartCursor } from "./use-chart-cursor";

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

  return (
    <div className="relative">
      <svg
        aria-label={`Monthly spend across ${months.length} months`}
        className={cn("block w-full select-none", CHART_FOCUS_CLASS_NAME)}
        role="img"
        viewBox={`0 0 ${CHART_WIDTH} ${HEIGHT + 24}`}
        {...cursor.surfaceProps}
      >
        <ChartGrid baseline={HEIGHT} format={formatUsd} max={max} y={y} />
        {months.map((point, index) => {
          const hasValue = point.value > 0;
          const totalHeight = y(point.value);
          const x = barX(layout, index);
          const center = barCenter(layout, index);
          let stackTop = HEIGHT;
          return (
            <g key={point.month} onPointerEnter={() => cursor.setActive(index)}>
              <ColumnHitArea height={HEIGHT} index={index} layout={layout} />
              {hasValue ? (
                <>
                  {point.segments.map((segment) => {
                    const height = y(segment.value);
                    stackTop -= height;
                    return (
                      <rect
                        fill={segment.color}
                        height={Math.max(height, 0)}
                        key={segment.series}
                        opacity={hovered === null || hovered === index ? 1 : 0.45}
                        width={layout.barWidth}
                        x={x}
                        y={stackTop}
                      />
                    );
                  })}
                  <text
                    className="fill-current text-muted-foreground"
                    fontSize={10}
                    fontWeight={500}
                    textAnchor="middle"
                    x={center}
                    y={HEIGHT - totalHeight - 6}
                  >
                    {formatUsd(point.value)}
                  </text>
                </>
              ) : null}
              <text
                className="fill-current opacity-45"
                fontSize={10}
                textAnchor="middle"
                x={center}
                y={HEIGHT + 16}
              >
                {formatMonth(point.month)}
              </text>
            </g>
          );
        })}
      </svg>
      <ChartLiveRegion>
        {active !== undefined && hovered !== null ? (
          <ChartTooltip
            className="w-56 -translate-y-full"
            rows={segmentTooltipRows(active.segments, (segment) => formatUsd(segment.value))}
            style={{
              left: anchorLeft(barCenter(layout, hovered) / CHART_WIDTH, 11),
              top: `${HEIGHT - y(active.value) - 12}px`,
            }}
            subtitle={`${formatUsd(active.value)} total`}
            title={formatMonthLong(active.month)}
          />
        ) : null}
      </ChartLiveRegion>
    </div>
  );
}

export { MonthBars };

export type { MonthPoint };
