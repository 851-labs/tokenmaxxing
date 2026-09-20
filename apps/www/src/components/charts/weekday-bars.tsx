import { useMemo, useState } from "react";

import { ChartGrid } from "./axis";
import { barLayout, CHART_AXIS, CHART_WIDTH, formatUsd, linearScale, niceMax } from "./scale";
import { anchorLeft, ChartTooltip } from "./tooltip";

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
function WeekdayBars({ spend }: { spend: number[] }) {
  const [hovered, setHovered] = useState<number | null>(null);

  const max = useMemo(() => niceMax(Math.max(...spend, 0)), [spend]);

  const y = linearScale(max, BAR_AREA);
  const { barWidth, slot } = barLayout(WEEKDAY_LABELS.length, 0.55, 64);

  const activeTooltip =
    hovered === null
      ? null
      : (() => {
          const x = CHART_AXIS + slot * hovered + (slot - barWidth) / 2;
          return {
            left: anchorLeft((x + barWidth / 2) / CHART_WIDTH, 11),
            top: HEIGHT - y(spend[hovered] ?? 0) - 12,
          };
        })();

  return (
    <div className="relative">
      <svg
        aria-label="Spend by weekday"
        className="block w-full select-none"
        onPointerLeave={() => setHovered(null)}
        role="img"
        viewBox={`0 0 ${CHART_WIDTH} ${HEIGHT + 24}`}
      >
        <ChartGrid baseline={HEIGHT} format={formatUsd} max={max} y={y} />
        {WEEKDAY_LABELS.map((label, index) => {
          const value = spend[index] ?? 0;
          const height = Math.max(y(value), 2);
          const x = CHART_AXIS + slot * index + (slot - barWidth) / 2;
          return (
            <g key={`${label}-${index}`} onPointerEnter={() => setHovered(index)}>
              {/* Invisible hover target spanning the full column. */}
              <rect
                fill="transparent"
                height={HEIGHT}
                width={slot}
                x={CHART_AXIS + slot * index}
                y={0}
              />
              <rect
                fill={ACCENT}
                height={height}
                opacity={hovered === null || hovered === index ? 1 : 0.45}
                width={barWidth}
                x={x}
                y={HEIGHT - height}
              />
              <text
                className="fill-current opacity-45"
                fontSize={10}
                textAnchor="middle"
                x={x + barWidth / 2}
                y={HEIGHT + 16}
              >
                {label}
              </text>
            </g>
          );
        })}
      </svg>
      {hovered !== null && activeTooltip !== null ? (
        <ChartTooltip
          className="w-56 -translate-y-full"
          style={{ left: activeTooltip.left, top: `${activeTooltip.top}px` }}
          subtitle={`${formatUsd(spend[hovered] ?? 0)} total`}
          title={WEEKDAY_NAMES[hovered]}
        />
      ) : null}
    </div>
  );
}

export { WeekdayBars };
