import { describe, expect, it } from "vite-plus/test";

import { nextCursorIndex } from "./use-chart-cursor";

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
