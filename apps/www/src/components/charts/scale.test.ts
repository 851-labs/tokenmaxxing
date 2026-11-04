import { describe, expect, it } from "vite-plus/test";

import { CHART_WIDTH, filledBarLayout } from "./scale";

describe("filledBarLayout", () => {
  it("fills each slot but for the gap", () => {
    const layout = filledBarLayout(14, 4);

    expect(layout.slot).toBeCloseTo(CHART_WIDTH / 14);
    expect(layout.barWidth).toBeCloseTo(CHART_WIDTH / 14 - 4);
  });

  it("shrinks the gap to a quarter slot so dense bars stay visible", () => {
    const layout = filledBarLayout(470, 4);

    expect(layout.slot).toBe(2);
    expect(layout.barWidth).toBe(1.5);
  });
});
