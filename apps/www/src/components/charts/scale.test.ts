import { describe, expect, it } from "vite-plus/test";

import { CHART_WIDTH, selectModelSeries, stackedBarLayout } from "./scale";

describe("stackedBarLayout", () => {
  it.each([320, 720, 1100])("keeps a 2–3px gutter at a rendered width of %i", (width) => {
    for (const count of [14, 30, 46, 54, 60, 61]) {
      const { barWidth, slot } = stackedBarLayout(count, width);
      const gapPixels = ((slot - barWidth) * width) / CHART_WIDTH;
      expect(gapPixels).toBeGreaterThanOrEqual(2 - 1e-10);
      expect(gapPixels).toBeLessThan(3);
    }
  });

  it("fills large slots without the old width cap and fits crowded charts", () => {
    expect(stackedBarLayout(9, 940).barWidth).toBeGreaterThan(64);
    const crowded = stackedBarLayout(365, 320);
    expect(crowded.barWidth).toBeGreaterThan(0);
    expect(crowded.barWidth).toBeLessThanOrEqual(crowded.slot);
  });
});

describe("selectModelSeries", () => {
  it("keeps raw model names when they fit within the limit", () => {
    const rows = [
      { key: "glm-5-turbo", value: 20 },
      { key: "deepseek-v4", value: 10 },
    ];

    const selection = selectModelSeries(rows, (row) => row.value);

    expect(selection.order).toEqual(["glm-5-turbo", "deepseek-v4"]);
    expect(selection.label("glm-5-turbo")).toBe("glm-5-turbo");
    expect(selection.label("deepseek-v4")).toBe("deepseek-v4");
  });

  it("reserves the final slot for the long tail", () => {
    const rows = Array.from({ length: 11 }, (_, index) => ({
      key: `model-${String(index + 1).padStart(2, "0")}`,
      value: 11 - index,
    }));

    const selection = selectModelSeries(rows, (row) => row.value);

    expect(selection.order).toEqual([
      "model-01",
      "model-02",
      "model-03",
      "model-04",
      "model-05",
      "model-06",
      "model-07",
      "model-08",
      "model-09",
      "Other",
    ]);
    expect(selection.label("model-09")).toBe("model-09");
    expect(selection.label("model-10")).toBe("Other");
    expect(selection.label("model-11")).toBe("Other");
  });
});
