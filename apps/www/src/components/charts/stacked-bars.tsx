import { useMemo, useState } from "react";

import { ChartGrid } from "./axis";
import { barLayout, CHART_AXIS, CHART_WIDTH, formatDay, linearScale, niceMax } from "./scale";
import { anchorBesideBar, ChartTooltip } from "./tooltip";

/**
 * Daily metric, one bar per day stacked by model. Hover reveals the
 * per-series breakdown.
 */

interface StackedDay {
  date: string;
  /** series -> metric value, series pre-sorted by overall rank. */
  segments: { color: string; series: string; value: number }[];
  total: number;
}

type ValueFormatter = (value: number) => string;
type StackedBarsMode = "absolute" | "share";

const HEIGHT = 280;
const TOP_PADDING = 14;
const PLOT_HEIGHT = HEIGHT - TOP_PADDING;
const PERCENT_MAX = 100;

function StackedBars({
  ariaLabel,
  days,
  highlight = null,
  mode = "absolute",
  valueFormatter,
}: {
  ariaLabel: string;
  days: StackedDay[];
  highlight?: string | null;
  mode?: StackedBarsMode;
  valueFormatter: ValueFormatter;
}) {
  const [hovered, setHovered] = useState<number | null>(null);

  const max = useMemo(
    () => (mode === "share" ? PERCENT_MAX : niceMax(Math.max(...days.map((day) => day.total), 0))),
    [days, mode],
  );
  const y = linearScale(max, PLOT_HEIGHT);
  const { barWidth, slot } = barLayout(days.length, 0.72, 16, 1.25);
  const axisFormatter = mode === "share" ? formatPercentAxis : valueFormatter;

  const monthStarts = useMemo(
    () =>
      days.flatMap((day, index) =>
        day.date.endsWith("-01") || index === 0 ? [{ date: day.date, index }] : [],
      ),
    [days],
  );

  const active = hovered === null ? null : days[hovered];
  const activePosition =
    hovered === null
      ? null
      : (() => {
          const x = CHART_AXIS + slot * hovered + (slot - barWidth) / 2;
          const center = x + barWidth / 2;
          return {
            center: center / CHART_WIDTH,
            edge: (center < CHART_WIDTH / 2 ? x + barWidth : x) / CHART_WIDTH,
          };
        })();

  return (
    <div className="relative">
      <svg
        aria-label={ariaLabel}
        className="block w-full select-none"
        onPointerLeave={() => setHovered(null)}
        role="img"
        viewBox={`0 0 ${CHART_WIDTH} ${HEIGHT + 24}`}
      >
        <ChartGrid baseline={HEIGHT} format={axisFormatter} max={max} y={y} />

        {days.map((day, index) => {
          const x = CHART_AXIS + slot * index + (slot - barWidth) / 2;
          let cursor = HEIGHT;
          return (
            <g key={day.date} onPointerEnter={() => setHovered(index)}>
              {/* Invisible hover target spanning the full column height. */}
              <rect
                fill="transparent"
                height={HEIGHT}
                width={slot}
                x={CHART_AXIS + slot * index}
                y={0}
              />
              {day.segments.map((segment) => {
                const chartValue =
                  mode === "share"
                    ? day.total === 0
                      ? 0
                      : (segment.value / day.total) * PERCENT_MAX
                    : segment.value;
                const height = y(chartValue);
                cursor -= height;
                const dimmedBySeries = highlight !== null && segment.series !== highlight;
                const dimmedByDay = hovered !== null && hovered !== index;
                return (
                  <rect
                    fill={segment.color}
                    height={Math.max(height, 0)}
                    key={segment.series}
                    opacity={dimmedBySeries ? 0.12 : dimmedByDay ? 0.45 : 1}
                    width={barWidth}
                    x={x}
                    y={cursor}
                  />
                );
              })}
            </g>
          );
        })}

        {monthStarts.map(({ date, index }) => (
          <text
            className="fill-current opacity-45"
            fontSize={10}
            key={date}
            textAnchor="middle"
            x={CHART_AXIS + slot * index + slot / 2}
            y={HEIGHT + 16}
          >
            {formatDay(date).split(" ")[1]}
          </text>
        ))}
      </svg>

      {active !== null && active !== undefined && activePosition !== null ? (
        <ChartTooltip
          className="w-56 -translate-y-1/2"
          rows={active.segments
            .filter((segment) => segment.value > 0)
            .sort((a, b) => b.value - a.value)
            .map((segment) => ({
              color: segment.color,
              label: segment.series,
              value:
                mode === "share"
                  ? `${active.total === 0 ? "0.0" : ((segment.value / active.total) * 100).toFixed(1)}%`
                  : valueFormatter(segment.value),
            }))}
          style={{ left: anchorBesideBar(activePosition.center, activePosition.edge), top: "50%" }}
          subtitle={`${valueFormatter(active.total)} total`}
          title={formatDay(active.date)}
        />
      ) : null}
    </div>
  );
}

function formatPercentAxis(value: number): string {
  return `${value.toFixed(0)}%`;
}

interface LegendEntry {
  color: string;
  series: string;
  /** Share of charted metric, 0–100. */
  percent: number;
}

/** Ranked, vertical legend that sits beside the chart: rank · dot · series · share. */
function Legend({
  entries,
  onHover,
}: {
  entries: LegendEntry[];
  onHover?: (series: string | null) => void;
}) {
  return (
    <ol
      className="flex w-full select-none flex-col gap-1 lg:w-60 lg:shrink-0"
      onPointerLeave={() => onHover?.(null)}
    >
      {entries.map((entry, index) => (
        <li
          className="flex items-center gap-3 rounded px-2 py-1 text-sm hover:bg-muted"
          key={entry.series}
          onPointerEnter={() => onHover?.(entry.series)}
        >
          <span className="w-5 shrink-0 text-right tabular-nums text-muted-foreground">
            {index + 1}
          </span>
          <span className="size-2.5 shrink-0 rounded-full" style={{ background: entry.color }} />
          <span className="flex-1 truncate">{entry.series}</span>
          <span className="tabular-nums text-muted-foreground">{entry.percent.toFixed(1)}%</span>
        </li>
      ))}
    </ol>
  );
}

export { Legend, StackedBars };

export type { StackedDay };
