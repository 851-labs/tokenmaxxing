import { useMemo } from "react";

import { formatUsd } from "../../lib/format";
import { BarChart, ColumnSpotlight } from "./axis";
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
import { anchorLeft, ChartLiveRegion, ChartTooltip } from "./tooltip";
import { useChartCursor } from "./use-chart-cursor";

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
  const centerOf = (index: number) => barCenter(layout, index) / CHART_WIDTH;

  return (
    <BarChart
      ariaLabel="Spend by weekday"
      columns={WEEKDAY_LABELS.length}
      format={formatUsd}
      height={HEIGHT}
      labels={WEEKDAY_NAMES.map((name, index) => ({
        center: centerOf(index),
        key: name,
        label: WEEKDAY_LABELS[index] ?? name,
      }))}
      max={max}
      onColumn={cursor.setActive}
      overlay={
        <ChartLiveRegion>
          {hovered === null ? null : (
            <ChartTooltip
              className="w-56 -translate-y-full"
              style={{
                left: anchorLeft(centerOf(hovered), 11),
                top: `${HEIGHT - y(spend[hovered] ?? 0) - 12}px`,
              }}
              subtitle={`${formatUsd(spend[hovered] ?? 0)} total`}
              title={WEEKDAY_NAMES[hovered]}
            />
          )}
        </ChartLiveRegion>
      }
      surfaceProps={cursor.surfaceProps}
      y={y}
    >
      {WEEKDAY_NAMES.map((name, index) => {
        const height = Math.max(y(spend[index] ?? 0), 2);
        return (
          <rect
            fill={ACCENT}
            height={round2(height)}
            key={name}
            width={round2(layout.barWidth)}
            x={round2(barX(layout, index))}
            y={round2(HEIGHT - height)}
          />
        );
      })}
      <ColumnSpotlight active={hovered} height={HEIGHT} slot={layout.slot} />
    </BarChart>
  );
}

export { WeekdayBars };
