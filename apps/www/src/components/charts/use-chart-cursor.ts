import { useState, type KeyboardEvent } from "react";

/**
 * The active datum of a chart, driven by pointer hover *and* the keyboard:
 * the chart surface is one tab stop, arrow keys move between data points,
 * Home/End jump to the ends, and Escape (or blur) dismisses the tooltip.
 */

/** Index delta per key; charts laid out in a grid (the heatmap) override it. */
type CursorSteps = Partial<Record<string, number>>;

const LINEAR_STEPS: CursorSteps = {
  ArrowDown: 1,
  ArrowLeft: -1,
  ArrowRight: 1,
  ArrowUp: -1,
};

/** Tailwind classes that make the focused chart surface visible. */
const CHART_FOCUS_CLASS_NAME =
  "outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

function nextCursorIndex(
  current: number | null,
  count: number,
  key: string,
  steps: CursorSteps = LINEAR_STEPS,
): number | null | undefined {
  if (count === 0) {
    return undefined;
  }
  if (key === "Escape") {
    return null;
  }
  if (key === "Home") {
    return 0;
  }
  if (key === "End") {
    return count - 1;
  }

  const step = steps[key];
  if (step === undefined) {
    return undefined;
  }

  const from = current ?? (step > 0 ? -1 : count);
  return Math.min(Math.max(from + step, 0), count - 1);
}

function useChartCursor(count: number, steps?: CursorSteps) {
  const [active, setActive] = useState<number | null>(null);

  const onKeyDown = (event: KeyboardEvent) => {
    const next = nextCursorIndex(active, count, event.key, steps);
    if (next === undefined) {
      return;
    }

    event.preventDefault();
    setActive(next);
  };

  return {
    active,
    setActive,
    surfaceProps: {
      onBlur: () => setActive(null),
      onKeyDown,
      onPointerLeave: () => setActive(null),
      tabIndex: 0,
    },
  };
}

export { CHART_FOCUS_CLASS_NAME, nextCursorIndex, useChartCursor };

export type { CursorSteps };
