import { useLayoutEffect, useMemo, useRef, useState } from "react";

import { cn } from "../../lib/cn";
import { enumerateDays, weekdaySundayFirst } from "../../lib/dates";
import { formatDay, formatMonth, formatUsd } from "../../lib/format";
import { maxValue } from "./scale";
import { segmentTooltipRows, type ChartSegment } from "./series";
import { ChartLiveRegion, ChartTooltip } from "./tooltip";
import { CHART_FOCUS_CLASS_NAME, useChartCursor, type CursorSteps } from "./use-chart-cursor";

/**
 * GitHub-style activity heatmap: daily spend intensity, weeks left to
 * right, Mon/Wed/Fri row labels, 5-step scale on the day's spend.
 */

interface HeatmapProps {
  /** date -> spend */
  byDate: ReadonlyMap<string, number>;
  first: string;
  last: string;
  segmentsByDate: ReadonlyMap<string, ChartSegment[]>;
}

interface CellPosition {
  /** Pixel position of the cell within the rendered chart container. */
  left: number;
  top: number;
}

const CELL = 11;
const GAP = 2;
const LEFT = 28;
const TOP = 16;
/** Fixed green tint; rendered at varying opacity by intensity. */
const ACCENT = "#22c55e";
const OPACITIES = [0, 0.25, 0.5, 0.75, 1] as const;
/** Columns are weeks and rows are weekdays, so ←/→ move a week and ↑/↓ a day. */
const HEATMAP_STEPS: CursorSteps = {
  ArrowDown: 1,
  ArrowLeft: -7,
  ArrowRight: 7,
  ArrowUp: -1,
};

function Heatmap({ byDate, first, last, segmentsByDate }: HeatmapProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  const { allDays, cells, leadingBlanks, max, monthLabels, weeks } = useMemo(() => {
    const days = enumerateDays(first, last);
    // Pad so the first column starts on Sunday.
    const blanks = weekdaySundayFirst(first);
    const padded: (string | null)[] = [...Array.from({ length: blanks }, () => null), ...days];
    const weekCount = Math.ceil(padded.length / 7);
    const grid = Array.from({ length: weekCount }, (_, week) =>
      Array.from({ length: 7 }, (_, dow) => padded[week * 7 + dow] ?? null),
    );

    const labels: { label: string; week: number }[] = [];
    grid.forEach((column, week) => {
      const firstOfMonth = column.find((day) => day?.endsWith("-01"));
      if (firstOfMonth !== undefined && firstOfMonth !== null) {
        labels.push({ label: formatMonth(firstOfMonth), week });
      }
    });
    if (labels.length === 0 && days[0] !== undefined) {
      labels.push({ label: formatMonth(days[0]), week: 0 });
    }

    return {
      allDays: days,
      cells: grid,
      leadingBlanks: blanks,
      max: maxValue(days, (day) => byDate.get(day) ?? 0),
      monthLabels: labels,
      weeks: weekCount,
    };
  }, [byDate, first, last]);

  const cursor = useChartCursor(allDays.length, HEATMAP_STEPS);
  const activeDay = cursor.active === null ? undefined : allDays[cursor.active];
  const [position, setPosition] = useState<CellPosition | null>(null);

  // Tooltip placement needs the rendered cell's box, so measure before paint.
  useLayoutEffect(() => {
    const root = rootRef.current;
    const cell =
      activeDay === undefined
        ? null
        : (root?.querySelector<SVGRectElement>(`[data-day="${activeDay}"]`) ?? null);
    if (root === null || cell === null) {
      setPosition(null);
      return;
    }

    if (document.activeElement === svgRef.current) {
      cell.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
    const rootRect = root.getBoundingClientRect();
    const cellRect = cell.getBoundingClientRect();
    setPosition({
      left: cellRect.left - rootRect.left + cellRect.width / 2,
      top: cellRect.top - rootRect.top,
    });
  }, [activeDay]);

  const intensity = (value: number): number => {
    if (value <= 0 || max <= 0) {
      return 0;
    }
    const ratio = value / max;

    return ratio > 0.75 ? 4 : ratio > 0.5 ? 3 : ratio > 0.25 ? 2 : 1;
  };

  const width = LEFT + weeks * (CELL + GAP);
  const height = TOP + 7 * (CELL + GAP);
  const activeValue = activeDay === undefined ? 0 : (byDate.get(activeDay) ?? 0);

  return (
    <div className="relative" ref={rootRef}>
      <div className="overflow-x-auto">
        <svg
          aria-label={`Daily spend heatmap from ${formatDay(first)} to ${formatDay(last)}`}
          className={cn("block h-auto w-full select-none", CHART_FOCUS_CLASS_NAME)}
          height={height}
          preserveAspectRatio="xMinYMin meet"
          ref={svgRef}
          role="img"
          style={{ minWidth: width }}
          viewBox={`0 0 ${width} ${height}`}
          width={width}
          {...cursor.surfaceProps}
        >
          {monthLabels.map(({ label, week }) => (
            <text
              className="fill-current opacity-45"
              fontSize={9}
              key={`${label}-${week}`}
              x={LEFT + week * (CELL + GAP)}
              y={10}
            >
              {label}
            </text>
          ))}
          {(["Mon", "Wed", "Fri"] as const).map((label, index) => (
            <text
              className="fill-current opacity-45"
              fontSize={9}
              key={label}
              x={0}
              y={TOP + (index * 2 + 1) * (CELL + GAP) + CELL - 2}
            >
              {label}
            </text>
          ))}
          {cells.map((column, week) =>
            column.map((day, dow) => {
              if (day === null) {
                return null;
              }
              const level = intensity(byDate.get(day) ?? 0);
              const dayIndex = week * 7 + dow - leadingBlanks;
              return (
                <rect
                  data-day={day}
                  fill={level === 0 ? "currentColor" : ACCENT}
                  height={CELL}
                  key={day}
                  onPointerEnter={() => cursor.setActive(dayIndex)}
                  opacity={level === 0 ? 0.08 : OPACITIES[level]}
                  width={CELL}
                  x={LEFT + week * (CELL + GAP)}
                  y={TOP + dow * (CELL + GAP)}
                />
              );
            }),
          )}
        </svg>
      </div>
      <ChartLiveRegion>
        {activeDay !== undefined && position !== null ? (
          <ChartTooltip
            className="w-56 -translate-x-1/2 -translate-y-full"
            rows={segmentTooltipRows(segmentsByDate.get(activeDay) ?? [], (segment) =>
              formatUsd(segment.value),
            )}
            style={{ left: `${position.left}px`, top: `${position.top - 4}px` }}
            subtitle={activeValue > 0 ? `${formatUsd(activeValue)} spent` : "No spend"}
            title={formatDay(activeDay)}
          />
        ) : null}
      </ChartLiveRegion>
    </div>
  );
}

export { Heatmap };
