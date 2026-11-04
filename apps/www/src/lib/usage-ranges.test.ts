import { describe, expect, it } from "vite-plus/test";

import { USAGE_RANGE_OPTIONS, usageRangeWindow } from "./usage-ranges";

describe("usageRangeWindow", () => {
  const loaded = { firstDate: "2026-01-01", lastDate: "2026-11-03" };

  it("ends every range on the last loaded day", () => {
    expect(usageRangeWindow(loaded, "2w")).toEqual({
      firstDate: "2026-10-21",
      lastDate: "2026-11-03",
    });
    expect(usageRangeWindow(loaded, "2m").firstDate).toBe("2026-09-05");
  });

  it("covers everything loaded for year to date, and clamps longer ranges to it", () => {
    expect(usageRangeWindow(loaded, "ytd")).toEqual(loaded);
    expect(usageRangeWindow({ firstDate: "2026-01-01", lastDate: "2026-01-10" }, "3m")).toEqual({
      firstDate: "2026-01-01",
      lastDate: "2026-01-10",
    });
  });

  it("offers every range the API aggregates, shortest first", () => {
    expect(USAGE_RANGE_OPTIONS.map((option) => option.value)).toEqual([
      "2w",
      "1m",
      "2m",
      "3m",
      "6m",
      "ytd",
    ]);
  });
});
