import { describe, expect, it } from "vitest";

import { selectModelSeries } from "./scale";

describe("selectModelSeries", () => {
  it("keeps raw model names when they fit within the limit", () => {
    const rows = [
      { date: "2026-06-21", key: "glm-5-turbo", value: 20 },
      { date: "2026-06-21", key: "deepseek-v4", value: 10 },
    ];

    const selection = selectModelSeries(rows, (row) => row.value);

    expect(selection.order).toEqual(["glm-5-turbo", "deepseek-v4"]);
    expect(selection.label("glm-5-turbo")).toBe("glm-5-turbo");
    expect(selection.label("deepseek-v4")).toBe("deepseek-v4");
  });

  it("reserves the final slot for the long tail", () => {
    const rows = Array.from({ length: 11 }, (_, index) => ({
      date: "2026-06-21",
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

  it("surfaces a newly adopted model ahead of the lifetime long tail", () => {
    // Eleven legacy models with months of history, then one new model that
    // carries all of the trailing 30 days but little lifetime volume.
    const rows = [
      ...Array.from({ length: 11 }, (_, index) => ({
        date: "2026-01-15",
        key: `legacy-${String(index + 1).padStart(2, "0")}`,
        value: 100 - index,
      })),
      { date: "2026-06-21", key: "claude-fable-5-1", value: 40 },
    ];

    const selection = selectModelSeries(rows, (row) => row.value);

    expect(selection.order).toEqual([
      "claude-fable-5-1",
      "legacy-01",
      "legacy-02",
      "legacy-03",
      "legacy-04",
      "legacy-05",
      "legacy-06",
      "legacy-07",
      "legacy-08",
      "Other",
    ]);
    expect(selection.label("claude-fable-5-1")).toBe("claude-fable-5-1");
    expect(selection.label("legacy-09")).toBe("Other");
  });

  it("counts the trailing window back from the newest charted row", () => {
    const rows = [
      { date: "2026-05-22", key: "old-model", value: 10 },
      { date: "2026-05-23", key: "new-model", value: 9 },
      { date: "2026-06-21", key: "new-model", value: 1 },
    ];

    const selection = selectModelSeries(rows, (row) => row.value);

    // 2026-05-22 falls outside the 30-day window ending 2026-06-21, so
    // new-model owns the whole recent share and outranks old-model.
    expect(selection.order).toEqual(["new-model", "old-model"]);
  });
});
