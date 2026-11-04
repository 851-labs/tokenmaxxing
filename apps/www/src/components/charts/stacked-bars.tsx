import { useMemo, useState } from "react";

import { cn } from "../../lib/cn";
import { formatDayRange, formatMonth, formatPercent, percentOf } from "../../lib/format";
import { barAnchor, BarChart, ColumnSpotlight, type AxisLabel } from "./axis";
import {
  barCenter,
  type BarLayout,
  barX,
  CHART_WIDTH,
  filledBarLayout,
  linearScale,
  maxValue,
  niceMax,
  round2,
} from "./scale";
import {
  MODEL_SERIES_LIMIT,
  segmentTooltipRows,
  type LegendEntry,
  type StackedDay,
} from "./series";
import { ChartLiveRegion, ChartTooltip } from "./tooltip";
import { useChartCursor } from "./use-chart-cursor";

/**
 * A metric over time, one bar per day (or per multi-day bucket) stacked by
 * model. Hover (or arrow keys) reveals the per-series breakdown.
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
/** Space between neighboring bars, in plot units (about 2–4 px on screen). */
const BAR_GAP = 4;

/**
 * One path per series rather than one rect per (day, series): a year of
 * daily bars is a few dozen elements instead of thousands, which keeps the
 * server-rendered HTML small and hover cheap.
 */
function seriesPaths(
  days: readonly StackedDay[],
  mode: StackedBarsMode,
  y: (value: number) => number,
  layout: BarLayout,
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
  totalLabel = (total) => `${valueFormatter(total)} total`,
  valueFormatter,
}: {
  ariaLabel: string;
  days: readonly StackedDay[];
  highlight?: string | null;
  mode?: StackedBarsMode;
  /** The tooltip line under the date; defaults to "<total> total". */
  totalLabel?: (total: number) => string;
  valueFormatter: ValueFormatter;
}) {
  const cursor = useChartCursor(days.length);
  const hovered = cursor.active;

  const max = useMemo(
    () => (mode === "share" ? PERCENT_MAX : niceMax(maxValue(days, (day) => day.total))),
    [days, mode],
  );
  const y = useMemo(() => linearScale(max, PLOT_HEIGHT), [max]);
  const layout = useMemo(() => filledBarLayout(days.length, BAR_GAP), [days.length]);
  const axisFormatter = mode === "share" ? formatPercentAxis : valueFormatter;
  const paths = useMemo(() => seriesPaths(days, mode, y, layout), [days, layout, mode, y]);

  const monthLabels = useMemo(
    (): AxisLabel[] =>
      days.flatMap((day, index) => {
        const month = index === 0 ? day.date : monthStartIn(day);
        return month === undefined
          ? []
          : [
              {
                center: barCenter(layout, index) / CHART_WIDTH,
                key: day.date,
                label: formatMonth(month),
              },
            ];
      }),
    [days, layout],
  );

  const active = hovered === null ? undefined : days[hovered];

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
          {active !== undefined && hovered !== null ? (
            <ChartTooltip
              anchor={barAnchor(layout, hovered, 0, HEIGHT)}
              placement="beside"
              rows={segmentTooltipRows(active.segments, (segment) =>
                mode === "share"
                  ? formatPercent(percentOf(segment.value, active.total))
                  : valueFormatter(segment.value),
              )}
              subtitle={totalLabel(active.total)}
              title={formatDayRange(active.date, active.endDate ?? active.date)}
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

/** The month whose 1st falls inside the bar, if any; a bar spans at most one month start. */
function monthStartIn(day: StackedDay): string | undefined {
  if (day.date.endsWith("-01")) {
    return day.date;
  }
  const last = day.endDate ?? day.date;

  return last.slice(0, 7) === day.date.slice(0, 7) ? undefined : last;
}

function formatPercentAxis(value: number): string {
  return formatPercent(value, 0);
}

const LEGEND_ROW_CLASS_NAME = "flex items-center gap-3 rounded px-2 py-1 text-sm";

/**
 * Ranked, vertical legend that sits beside the chart: rank · dot · series · share.
 * Invisible rows pad it to the series limit, so it keeps one height as the
 * charted range changes and switching ranges never shifts the page.
 */
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
          className={cn(LEGEND_ROW_CLASS_NAME, "hover:bg-muted")}
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
      {Array.from({ length: Math.max(MODEL_SERIES_LIMIT - entries.length, 0) }, (_, index) => (
        <li aria-hidden="true" className={cn(LEGEND_ROW_CLASS_NAME, "invisible")} key={index}>
          {"\u00a0"}
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
