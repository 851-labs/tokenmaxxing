import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
} from "react";

/**
 * The active datum of a chart, driven by pointer hover, touch *and* the
 * keyboard: the chart surface is one tab stop, arrow keys move between data
 * points, Home/End jump to the ends, and Escape (or blur) dismisses the
 * tooltip. A mouse dismisses it by leaving the surface; a tap keeps it open
 * until the next tap outside the surface or any scroll.
 */

/** Index delta per key; charts laid out in a grid (the heatmap) override it. */
type CursorSteps = Partial<Record<string, number>>;

/** Props that make an element the chart's single keyboard/pointer surface. */
interface ChartSurfaceProps {
  onBlur: () => void;
  onKeyDown: (event: KeyboardEvent) => void;
  onPointerDown: (event: PointerEvent) => void;
  onPointerLeave: (event: PointerEvent) => void;
  ref: RefObject<SVGSVGElement | null>;
  tabIndex: number;
}

const LINEAR_STEPS: CursorSteps = {
  ArrowDown: 1,
  ArrowLeft: -1,
  ArrowRight: 1,
  ArrowUp: -1,
};

/** Page scroll (px) since a tap that dismisses its tooltip. */
const SCROLL_SLOP = 4;

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
  /** Whether the datum was picked by touch/pen, which has no hover to end. */
  const [pinned, setPinned] = useState(false);
  const surfaceRef = useRef<SVGSVGElement>(null);
  const open = active !== null;

  useEffect(() => {
    if (!open || !pinned) {
      return;
    }

    const dismiss = () => setActive(null);
    const dismissOutside = (event: globalThis.PointerEvent) => {
      if (!(event.target instanceof Node) || !surfaceRef.current?.contains(event.target)) {
        dismiss();
      }
    };
    // A scroll that settles just after the tap (momentum, scroll-into-view)
    // still fires an event, so the page must have moved since the tap.
    const pageX = window.scrollX;
    const pageY = window.scrollY;
    const dismissOnScroll = (event: Event) => {
      const isPage = event.target === document || event.target === window;
      if (
        !isPage ||
        Math.abs(window.scrollX - pageX) + Math.abs(window.scrollY - pageY) > SCROLL_SLOP
      ) {
        dismiss();
      }
    };
    document.addEventListener("pointerdown", dismissOutside, true);
    window.addEventListener("scroll", dismissOnScroll, { capture: true, passive: true });
    return () => {
      document.removeEventListener("pointerdown", dismissOutside, true);
      window.removeEventListener("scroll", dismissOnScroll, { capture: true });
    };
  }, [open, pinned]);

  const onKeyDown = (event: KeyboardEvent) => {
    const next = nextCursorIndex(active, count, event.key, steps);
    if (next === undefined) {
      return;
    }

    event.preventDefault();
    setPinned(false);
    setActive(next);
  };

  const surfaceProps: ChartSurfaceProps = {
    onBlur: () => setActive(null),
    onKeyDown,
    onPointerDown: (event) => setPinned(event.pointerType !== "mouse"),
    // Touch fires pointerleave right after every tap; only a mouse hovers.
    onPointerLeave: (event) => {
      if (event.pointerType === "mouse") {
        setActive(null);
      }
    },
    ref: surfaceRef,
    tabIndex: 0,
  };

  return { active, setActive, surfaceProps };
}

export { CHART_FOCUS_CLASS_NAME, nextCursorIndex, useChartCursor };

export type { ChartSurfaceProps, CursorSteps };
