import { useMemo } from "react";

import { cn } from "../../lib/cn";
import { formatUsd } from "../../lib/format";
import { ChartGrid, ColumnHitArea } from "./axis";
import { barCenter, barLayout, barX, CHART_WIDTH, linearScale, maxValue, niceMax } from "./scale";
import { anchorLeft, ChartLiveRegion, ChartTooltip } from "./tooltip";
import { CHART_FOCUS_CLASS_NAME, useChartCursor } from "./use-chart-cursor";

/** Spend bucketed by weekday (Monday-first); hovering a bar dims the others. */

/** Monday-first axis tick labels, matching the screenshot (M T W T F S S). */
const WEEKDAY_LABELS = ["M", "T", "W", "T", "F", "S", "S"];
/** Monday-first short names for tooltips. */
const WEEKDAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const HEIGHT = 180;
const BAR_AREA = HEIGHT - 12;
/** Fixed dark-blue tint; non-hovered bars dim while another bar is hovered. */
const ACCENT = "#2563eb";

/** `spend` is length-7, Monday-first: spend[0] = Mon … spend[6] = Sun. */
function WeekdayBars({ spend }: { spend: readonly number[] }) {
  const cursor = useChartCursor(WEEKDAY_LABELS.length);
  const hovered = cursor.active;

  const max = useMemo(() => niceMax(maxValue(spend, (value) => value)), [spend]);

  const y = linearScale(max, BAR_AREA);
  const layout = barLayout(WEEKDAY_LABELS.length, 0.55, 64);

  return (
    <div className="relative">
      <svg
        aria-label="Spend by weekday"
        className={cn("block w-full select-none", CHART_FOCUS_CLASS_NAME)}
        role="img"
        viewBox={`0 0 ${CHART_WIDTH} ${HEIGHT + 24}`}
        {...cursor.surfaceProps}
      >
        <ChartGrid baseline={HEIGHT} format={formatUsd} max={max} y={y} />
        {WEEKDAY_LABELS.map((label, index) => {
          const value = spend[index] ?? 0;
          const height = Math.max(y(value), 2);
          return (
            <g key={`${label}-${index}`} onPointerEnter={() => cursor.setActive(index)}>
              <ColumnHitArea height={HEIGHT} index={index} layout={layout} />
              <rect
                fill={ACCENT}
                height={height}
                opacity={hovered === null || hovered === index ? 1 : 0.45}
                width={layout.barWidth}
                x={barX(layout, index)}
                y={HEIGHT - height}
              />
              <text
                className="fill-current opacity-45"
                fontSize={10}
                textAnchor="middle"
                x={barCenter(layout, index)}
                y={HEIGHT + 16}
              >
                {label}
              </text>
            </g>
          );
        })}
      </svg>
      <ChartLiveRegion>
        {hovered === null ? null : (
          <ChartTooltip
            className="w-56 -translate-y-full"
            style={{
              left: anchorLeft(barCenter(layout, hovered) / CHART_WIDTH, 11),
              top: `${HEIGHT - y(spend[hovered] ?? 0) - 12}px`,
            }}
            subtitle={`${formatUsd(spend[hovered] ?? 0)} total`}
            title={WEEKDAY_NAMES[hovered]}
          />
        )}
      </ChartLiveRegion>
    </div>
  );
}

export { WeekdayBars };
