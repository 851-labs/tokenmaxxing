import { useMemo, useState } from "react";

import { formatDay, formatMonth, formatPercent, percentOf } from "../../lib/format";
import { BarChart, ColumnSpotlight, type AxisLabel } from "./axis";
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
import { segmentTooltipRows, type LegendEntry, type StackedDay } from "./series";
import { anchorBesideBar, ChartLiveRegion, ChartTooltip } from "./tooltip";
import { useChartCursor } from "./use-chart-cursor";

/**
 * Daily metric, one bar per day stacked by model. Hover (or arrow keys)
 * reveals the per-series breakdown.
 */

type ValueFormatter = (value: number) => string;
type StackedBarsMode = "absolute" | "share";

interface SeriesPath {
  color: string;
  /** Every non-empty segment of the series as one path. */
  d: string;
  series: string;
}

const HEIGHT = 280;
const TOP_PADDING = 14;
const PLOT_HEIGHT = HEIGHT - TOP_PADDING;
const PERCENT_MAX = 100;

/**
 * One path per series rather than one rect per (day, series): a year of
 * daily bars is a few dozen elements instead of thousands, which keeps the
 * server-rendered HTML small and hover cheap.
 */
function seriesPaths(
  days: readonly StackedDay[],
  mode: StackedBarsMode,
  y: (value: number) => number,
  layout: ReturnType<typeof barLayout>,
): SeriesPath[] {
  const paths = new Map<string, SeriesPath>();
  const width = round2(layout.barWidth);
  days.forEach((day, index) => {
    const x = round2(barX(layout, index));
    let stackTop = HEIGHT;
    for (const segment of day.segments) {
      if (segment.value <= 0) {
        continue;
      }
      const height = y(mode === "share" ? percentOf(segment.value, day.total) : segment.value);
      stackTop -= height;
      const path = paths.get(segment.series) ?? {
        color: segment.color,
        d: "",
        series: segment.series,
      };
      path.d += `M${x} ${round2(stackTop)}h${width}v${round2(height)}h-${width}z`;
      paths.set(segment.series, path);
    }
  });

  return [...paths.values()];
}

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
  const y = useMemo(() => linearScale(max, PLOT_HEIGHT), [max]);
  const layout = useMemo(() => barLayout(days.length, 0.72, 16, 1.25), [days.length]);
  const axisFormatter = mode === "share" ? formatPercentAxis : valueFormatter;
  const paths = useMemo(() => seriesPaths(days, mode, y, layout), [days, layout, mode, y]);

  const monthLabels = useMemo(
    (): AxisLabel[] =>
      days.flatMap((day, index) =>
        day.date.endsWith("-01") || index === 0
          ? [
              {
                center: barCenter(layout, index) / CHART_WIDTH,
                key: day.date,
                label: formatMonth(day.date),
              },
            ]
          : [],
      ),
    [days, layout],
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
    <BarChart
      ariaLabel={ariaLabel}
      columns={days.length}
      format={axisFormatter}
      height={HEIGHT}
      labels={monthLabels}
      max={max}
      onColumn={cursor.setActive}
      overlay={
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
      }
      surfaceProps={cursor.surfaceProps}
      y={y}
    >
      {paths.map((path) => (
        <path
          d={path.d}
          fill={path.color}
          key={path.series}
          opacity={highlight !== null && path.series !== highlight ? 0.12 : undefined}
        />
      ))}
      <ColumnSpotlight active={hovered} height={HEIGHT} slot={layout.slot} />
    </BarChart>
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
