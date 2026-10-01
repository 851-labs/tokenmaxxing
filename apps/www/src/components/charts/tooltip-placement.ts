/**
 * Where a chart tooltip goes, as a pure function of measured boxes (all in
 * viewport/client px), so the edge cases are unit-testable without a DOM.
 * `ChartTooltip` measures the real card, anchor and frame and applies this.
 */

interface Rect {
  bottom: number;
  left: number;
  right: number;
  top: number;
}

interface Size {
  height: number;
  width: number;
}

/**
 * `above`: centred over the anchor, flipping below when the viewport has no
 * room above. `beside`: vertically centred next to the anchor, on the side
 * with more room (right of bars in the first half, left in the second).
 */
type TooltipPlacement = "above" | "beside";

type TooltipSide = "above" | "below" | "left" | "right";

interface TooltipPosition {
  left: number;
  side: TooltipSide;
  top: number;
}

/** Minimum distance (px) between the card and the edge of the screen. */
const TOOLTIP_GUTTER = 8;

/**
 * The box the card must stay inside: horizontally the chart frame ∩ the
 * viewport, so it never adds horizontal page scroll; vertically just the
 * viewport, since cards may float over the chart's title. Inset by `gutter`
 * against the viewport edges.
 */
function tooltipBounds(frame: Rect, viewport: Size, gutter: number = TOOLTIP_GUTTER): Rect {
  const left = Math.max(frame.left, gutter);
  const right = Math.min(frame.right, viewport.width - gutter);

  return {
    bottom: viewport.height - gutter,
    left,
    right: Math.max(right, left),
    top: gutter,
  };
}

/** `value` pulled into [min, max]; `min` wins when the range is empty. */
function clamp(value: number, min: number, max: number): number {
  return Math.max(Math.min(value, max), min);
}

function placeTooltip({
  anchor,
  bounds,
  card,
  offset,
  placement,
}: {
  anchor: Rect;
  bounds: Rect;
  card: Size;
  /** Gap (px) between the anchor and the card. */
  offset: number;
  placement: TooltipPlacement;
}): TooltipPosition {
  const clampX = (left: number) => clamp(left, bounds.left, bounds.right - card.width);
  const clampY = (top: number) => clamp(top, bounds.top, bounds.bottom - card.height);

  if (placement === "above") {
    const above = anchor.top - offset - card.height;
    const below = anchor.bottom + offset;
    const fitsAbove = above >= bounds.top;
    const fitsBelow = below + card.height <= bounds.bottom;
    const side: TooltipSide =
      fitsAbove || (!fitsBelow && anchor.top - bounds.top >= bounds.bottom - anchor.bottom)
        ? "above"
        : "below";

    return {
      left: clampX((anchor.left + anchor.right) / 2 - card.width / 2),
      side,
      top: clampY(side === "above" ? above : below),
    };
  }

  // The side facing the frame's centre always has the most room, so there is
  // nothing better to flip to: when even it is too narrow, clamp over the bar.
  const side: TooltipSide =
    (anchor.left + anchor.right) / 2 <= (bounds.left + bounds.right) / 2 ? "right" : "left";

  return {
    left: clampX(side === "right" ? anchor.right + offset : anchor.left - offset - card.width),
    side,
    top: clampY((anchor.top + anchor.bottom) / 2 - card.height / 2),
  };
}

export { placeTooltip, TOOLTIP_GUTTER, tooltipBounds };

export type { Rect, Size, TooltipPlacement, TooltipPosition, TooltipSide };
