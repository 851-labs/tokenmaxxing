import { useMemo, useState } from "react";

import { cn } from "../../lib/cn";
import { formatDay, formatMonth, formatPercent, percentOf } from "../../lib/format";
import { ChartGrid, ColumnHitArea } from "./axis";
import {
  barCenter,
  barLayout,
  barX,
  CHART_WIDTH,
  linearScale,
  maxValue,
  niceMax,
  slotX,
} from "./scale";
import { segmentTooltipRows, type LegendEntry, type StackedDay } from "./series";
import { anchorBesideBar, ChartLiveRegion, ChartTooltip } from "./tooltip";
import { CHART_FOCUS_CLASS_NAME, useChartCursor } from "./use-chart-cursor";

/**
 * Daily metric, one bar per day stacked by model. Hover (or arrow keys)
 * reveals the per-series breakdown.
 */

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
  days: readonly StackedDay[];
  highlight?: string | null;
  mode?: StackedBarsMode;
  valueFormatter: ValueFormatter;
}) {
  const cursor = useChartCursor(days.length);
  const hovered = cursor.active;

  const max = useMemo(
    () => (mode === "share" ? PERCENT_MAX : niceMax(maxValue(days, (day) => day.total))),
    [days, mode],
  );
  const y = linearScale(max, PLOT_HEIGHT);
  const layout = barLayout(days.length, 0.72, 16, 1.25);
  const axisFormatter = mode === "share" ? formatPercentAxis : valueFormatter;

  const monthStarts = useMemo(
    () =>
      days.flatMap((day, index) =>
        day.date.endsWith("-01") || index === 0 ? [{ date: day.date, index }] : [],
      ),
    [days],
  );

  const active = hovered === null ? undefined : days[hovered];
  const activePosition =
    hovered === null
      ? null
      : (() => {
          const x = barX(layout, hovered);
          const center = barCenter(layout, hovered);
          return {
            center: center / CHART_WIDTH,
            edge: (center < CHART_WIDTH / 2 ? x + layout.barWidth : x) / CHART_WIDTH,
          };
        })();

  return (
    <div className="relative">
      <svg
        aria-label={ariaLabel}
        className={cn("block w-full select-none", CHART_FOCUS_CLASS_NAME)}
        role="img"
        viewBox={`0 0 ${CHART_WIDTH} ${HEIGHT + 24}`}
        {...cursor.surfaceProps}
      >
        <ChartGrid baseline={HEIGHT} format={axisFormatter} max={max} y={y} />

        {days.map((day, index) => {
          const x = barX(layout, index);
          let stackTop = HEIGHT;
          return (
            <g key={day.date} onPointerEnter={() => cursor.setActive(index)}>
              <ColumnHitArea height={HEIGHT} index={index} layout={layout} />
              {day.segments.map((segment) => {
                const chartValue =
                  mode === "share" ? percentOf(segment.value, day.total) : segment.value;
                const height = y(chartValue);
                stackTop -= height;
                const dimmedBySeries = highlight !== null && segment.series !== highlight;
                const dimmedByDay = hovered !== null && hovered !== index;
                return (
                  <rect
                    fill={segment.color}
                    height={Math.max(height, 0)}
                    key={segment.series}
                    opacity={dimmedBySeries ? 0.12 : dimmedByDay ? 0.45 : 1}
                    width={layout.barWidth}
                    x={x}
                    y={stackTop}
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
            x={slotX(layout, index) + layout.slot / 2}
            y={HEIGHT + 16}
          >
            {formatMonth(date)}
          </text>
        ))}
      </svg>

      <ChartLiveRegion>
        {active !== undefined && activePosition !== null ? (
          <ChartTooltip
            className="w-56 -translate-y-1/2"
            rows={segmentTooltipRows(active.segments, (segment) =>
              mode === "share"
                ? formatPercent(percentOf(segment.value, active.total))
                : valueFormatter(segment.value),
            )}
            style={{
              left: anchorBesideBar(activePosition.center, activePosition.edge),
              top: "50%",
            }}
            subtitle={`${valueFormatter(active.total)} total`}
            title={formatDay(active.date)}
          />
        ) : null}
      </ChartLiveRegion>
    </div>
  );
}

function formatPercentAxis(value: number): string {
  return formatPercent(value, 0);
}

/** Ranked, vertical legend that sits beside the chart: rank · dot · series · share. */
function Legend({
  entries,
  onHover,
}: {
  entries: readonly LegendEntry[];
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
          <span className="tabular-nums text-muted-foreground">{formatPercent(entry.percent)}</span>
        </li>
      ))}
    </ol>
  );
}

/**
 * A titled stacked-bar chart with its legend. Owns the legend-hover highlight
 * so hovering one panel's legend re-renders only that panel.
 */
function StackedChartPanel({
  ariaLabel,
  days,
  legend,
  mode,
  title,
  valueFormatter,
}: {
  ariaLabel: string;
  days: readonly StackedDay[];
  legend: readonly LegendEntry[];
  mode?: StackedBarsMode;
  title: string;
  valueFormatter: ValueFormatter;
}) {
  const [highlight, setHighlight] = useState<string | null>(null);

  return (
    <section className="bg-background p-5">
      <h2 className="font-medium">{title}</h2>
      <div className="mt-4 flex flex-col gap-6 lg:flex-row lg:items-center">
        <div className="min-w-0 flex-1">
          <StackedBars
            ariaLabel={ariaLabel}
            days={days}
            highlight={highlight}
            mode={mode}
            valueFormatter={valueFormatter}
          />
        </div>
        <Legend entries={legend} onHover={setHighlight} />
      </div>
    </section>
  );
}

export { Legend, StackedBars, StackedChartPanel };

export type { StackedBarsMode };
