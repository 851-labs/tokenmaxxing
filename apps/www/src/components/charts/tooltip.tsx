import type { CSSProperties, ReactNode } from "react";

import { cn } from "../../lib/cn";

/**
 * The shared hover tooltip for every dashboard chart: a floating card with a
 * title, optional subtitle, and optional colour-swatched rows. Presentational
 * only — each chart positions it via `style`/`className`, since the
 * pointer-to-datum math differs per chart. Centralising the card keeps all
 * four charts visually identical.
 */

interface TooltipRow {
  color?: string;
  label: string;
  value: string;
}

/** Card width (rem) the anchored charts render at — kept in sync with the clamp. */
const CARD_REM = 14;
const BAR_GUTTER_REM = 0.75;

/**
 * Left offset (a CSS string) that centres a tooltip on the point at `fraction`
 * (0–1) across the chart, clamped so the card never spills past either edge of
 * its relative container.
 */
function anchorLeft(fraction: number, cardRem: number = CARD_REM): string {
  const pct = Math.min(Math.max(fraction, 0), 1) * 100;

  return `clamp(0rem, calc(${pct}% - ${cardRem / 2}rem), calc(100% - ${cardRem}rem))`;
}

/**
 * Position a bar-chart tooltip beside the hovered bar: to the right in the
 * first half of the chart, and to the left in the second half.
 */
function anchorBesideBar(centerFraction: number, edgeFraction: number = centerFraction): string {
  const pct = Math.min(Math.max(edgeFraction, 0), 1) * 100;
  const offset = centerFraction < 0.5 ? BAR_GUTTER_REM : -(CARD_REM + BAR_GUTTER_REM);

  return `clamp(0rem, calc(${pct}% + ${offset}rem), calc(100% - ${CARD_REM}rem))`;
}

function ChartTooltip({
  className,
  rows,
  style,
  subtitle,
  title,
}: {
  className?: string;
  rows?: TooltipRow[];
  style?: CSSProperties;
  subtitle?: ReactNode;
  title: ReactNode;
}) {
  return (
    <div
      className={cn(
        "pointer-events-none absolute top-0 z-10 border border-border bg-card p-3 text-xs shadow-lg",
        className,
      )}
      style={style}
    >
      <p className="font-medium">{title}</p>
      {subtitle !== undefined ? <p className="mt-1 text-muted-foreground">{subtitle}</p> : null}
      {rows !== undefined && rows.length > 0 ? (
        <ul className="mt-2 flex flex-col gap-1">
          {rows.map((row) => (
            <li className="flex items-center gap-2" key={row.label}>
              {row.color !== undefined ? (
                <span className="size-2 shrink-0" style={{ background: row.color }} />
              ) : null}
              <span className="flex-1 truncate">{row.label}</span>
              <span className="text-muted-foreground">{row.value}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export { anchorBesideBar, anchorLeft, ChartTooltip };
