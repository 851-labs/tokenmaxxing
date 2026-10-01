// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { nextCursorIndex, useChartCursor } from "./use-chart-cursor";

describe("nextCursorIndex", () => {
  it("enters from the nearest end when nothing is active", () => {
    expect(nextCursorIndex(null, 5, "ArrowRight")).toBe(0);
    expect(nextCursorIndex(null, 5, "ArrowLeft")).toBe(4);
  });

  it("moves one datum at a time and clamps at the ends", () => {
    expect(nextCursorIndex(2, 5, "ArrowRight")).toBe(3);
    expect(nextCursorIndex(2, 5, "ArrowUp")).toBe(1);
    expect(nextCursorIndex(4, 5, "ArrowRight")).toBe(4);
    expect(nextCursorIndex(0, 5, "ArrowLeft")).toBe(0);
  });

  it("jumps to the ends and dismisses", () => {
    expect(nextCursorIndex(2, 5, "Home")).toBe(0);
    expect(nextCursorIndex(2, 5, "End")).toBe(4);
    expect(nextCursorIndex(2, 5, "Escape")).toBeNull();
  });

  it("uses custom steps for grid layouts", () => {
    const grid = { ArrowDown: 1, ArrowLeft: -7, ArrowRight: 7, ArrowUp: -1 };
    expect(nextCursorIndex(10, 30, "ArrowRight", grid)).toBe(17);
    expect(nextCursorIndex(3, 30, "ArrowLeft", grid)).toBe(0);
    expect(nextCursorIndex(10, 30, "ArrowDown", grid)).toBe(11);
  });

  it("ignores unrelated keys and empty charts", () => {
    expect(nextCursorIndex(2, 5, "a")).toBeUndefined();
    expect(nextCursorIndex(null, 0, "ArrowRight")).toBeUndefined();
  });
});

/** A chart surface whose every pointerdown picks datum 1, as a tap on a bar does. */
function Harness() {
  const cursor = useChartCursor(3);
  return (
    <>
      <svg
        {...cursor.surfaceProps}
        onPointerDown={(event) => {
          cursor.surfaceProps.onPointerDown(event);
          cursor.setActive(1);
        }}
      >
        <rect />
      </svg>
      <output>{String(cursor.active)}</output>
      <p>elsewhere</p>
    </>
  );
}

describe("useChartCursor pointer dismissal", () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() => root.render(<Harness />));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const active = () => container.querySelector("output")?.textContent;
  const fire = (target: EventTarget, type: string, init: PointerEventInit = {}) =>
    act(() => {
      target.dispatchEvent(new PointerEvent(type, { bubbles: true, ...init }));
    });
  const press = (pointerType: string) =>
    fire(container.querySelector("rect")!, "pointerdown", { pointerType });
  // React derives pointerleave from pointerout towards an outside element.
  const leave = (pointerType: string) =>
    fire(container.querySelector("rect")!, "pointerout", {
      pointerType,
      relatedTarget: container.querySelector("p"),
    });

  it("hides when a mouse leaves the chart", () => {
    press("mouse");
    leave("mouse");
    expect(active()).toBe("null");
  });

  it("keeps a tapped datum open through the pointerleave that ends every tap", () => {
    press("touch");
    leave("touch");
    expect(active()).toBe("1");
  });

  it("hides a tapped datum on a tap elsewhere, but not on another tap in the chart", () => {
    press("touch");
    press("touch");
    expect(active()).toBe("1");
    fire(container.querySelector("p")!, "pointerdown", { pointerType: "touch" });
    expect(active()).toBe("null");
  });

  it("hides a tapped datum when the page or a scroller inside it scrolls", () => {
    press("touch");
    act(() => {
      document.dispatchEvent(new Event("scroll"));
    });
    // The page has not moved since the tap: a scroll settling, not a new one.
    expect(active()).toBe("1");
    act(() => {
      window.scrollTo(0, 100);
      document.dispatchEvent(new Event("scroll"));
    });
    expect(active()).toBe("null");

    press("touch");
    act(() => {
      container.querySelector("p")!.dispatchEvent(new Event("scroll"));
    });
    expect(active()).toBe("null");
  });
});
