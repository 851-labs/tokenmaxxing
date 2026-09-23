import { describe, expect, it } from "vite-plus/test";

import { scrollOffsetToReveal } from "./heatmap";

describe("scrollOffsetToReveal", () => {
  const viewport = { left: 100, right: 400 };

  it("leaves a visible cell alone", () => {
    expect(scrollOffsetToReveal(viewport, { left: 200, right: 211 })).toBe(0);
  });

  it("scrolls right to reveal a cell past the edge, with a column of context", () => {
    expect(scrollOffsetToReveal(viewport, { left: 600, right: 611 })).toBe(211 + 13);
  });

  it("scrolls back left for a cell before the edge", () => {
    expect(scrollOffsetToReveal(viewport, { left: 50, right: 61 })).toBe(-50 - 13);
  });
});
