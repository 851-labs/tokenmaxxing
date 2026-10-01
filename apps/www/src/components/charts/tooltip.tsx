import { useLayoutEffect, useRef, type ReactNode } from "react";

import type { TooltipRow } from "./series";
import { placeTooltip, tooltipBounds, type TooltipPlacement } from "./tooltip-placement";

/**
 * The shared hover tooltip for every dashboard chart: a floating card with a
 * title, optional subtitle, and optional colour-swatched rows. It owns its
 * placement too: charts only say what it points at, and the card measures its
 * real size, then sits beside or above that anchor, flipping and clamping so
 * it stays inside the chart frame and the viewport.
 */

/**
 * What the card points at: a box in its positioned container (CSS lengths,
 * so bar charts can use plot percentages), or a getter for a rendered mark.
 */
type TooltipAnchor =
  | { height: number; left: number | string; top: number; width: number | string }
  | (() => Element | null | undefined);

/** Widest the card grows for long labels before they truncate. */
const MAX_CARD_WIDTH = "20rem";

function ChartTooltip({
  anchor,
  offset = 12,
  placement = "above",
  rows,
  subtitle,
  title,
}: {
  anchor: TooltipAnchor;
  /** Gap (px) between the anchor and the card. */
  offset?: number;
  placement?: TooltipPlacement;
  rows?: TooltipRow[];
  subtitle?: ReactNode;
  title: ReactNode;
}) {
  const anchorBoxRef = useRef<HTMLSpanElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const anchorBox = typeof anchor === "function" ? null : anchor;
  const resolveAnchor = typeof anchor === "function" ? anchor : () => anchorBoxRef.current;

  // Measure before paint on every render (the datum or its rows may change),
  // and again whenever the card, the frame or the viewport moves or resizes.
  useLayoutEffect(() => {
    const card = cardRef.current;
    const container = card?.offsetParent;
    if (card === null || !(container instanceof HTMLElement)) {
      return;
    }
    const frame = card.closest<HTMLElement>("[data-chart-frame]") ?? container;

    const position = () => {
      const target = resolveAnchor();
      if (target === null || target === undefined) {
        return;
      }
      const bounds = tooltipBounds(frame.getBoundingClientRect(), {
        height: window.innerHeight,
        width: document.documentElement.clientWidth,
      });
      // Measure at the origin with the width cap applied, so the size is the
      // card's own and not squeezed by wherever it sat last time.
      card.style.left = "0px";
      card.style.top = "0px";
      card.style.maxWidth = `min(${MAX_CARD_WIDTH}, ${bounds.right - bounds.left}px)`;
      const size = card.getBoundingClientRect();
      const origin = container.getBoundingClientRect();
      const spot = placeTooltip({
        anchor: target.getBoundingClientRect(),
        bounds,
        card: size,
        offset,
        placement,
      });
      card.style.left = `${spot.left - origin.left}px`;
      card.style.top = `${spot.top - origin.top}px`;
      card.dataset["side"] = spot.side;
    };

    position();
    const observer = new ResizeObserver(position);
    observer.observe(card);
    observer.observe(frame);
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, { capture: true, passive: true });
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, { capture: true });
    };
  });

  return (
    <>
      {anchorBox === null ? null : (
        <span
          aria-hidden="true"
          className="pointer-events-none invisible absolute"
          ref={anchorBoxRef}
          style={anchorBox}
        />
      )}
      <div
        className="pointer-events-none absolute top-0 left-0 z-10 w-max border border-border bg-card p-3 text-xs shadow-lg"
        data-chart-tooltip=""
        ref={cardRef}
      >
        <p className="truncate font-medium">{title}</p>
        {subtitle !== undefined ? (
          <p className="mt-1 truncate text-muted-foreground">{subtitle}</p>
        ) : null}
        {rows !== undefined && rows.length > 0 ? (
          <ul className="mt-2 flex flex-col gap-1">
            {rows.map((row) => (
              <li className="flex items-center gap-2" key={row.label}>
                {row.color !== undefined ? (
                  <span className="size-2 shrink-0" style={{ background: row.color }} />
                ) : null}
                <span className="min-w-0 flex-1 truncate">{row.label}</span>
                <span className="shrink-0 pl-2 text-muted-foreground tabular-nums">
                  {row.value}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </>
  );
}

/**
 * Always-mounted polite live region around a chart's tooltip, so keyboard
 * users hear the datum they move to. It is static (not positioned), so the
 * tooltip still anchors to the chart's `relative` container.
 */
function ChartLiveRegion({ children }: { children: ReactNode }) {
  return (
    <div aria-atomic="true" aria-live="polite">
      {children}
    </div>
  );
}

export { ChartLiveRegion, ChartTooltip };

export type { TooltipAnchor };
