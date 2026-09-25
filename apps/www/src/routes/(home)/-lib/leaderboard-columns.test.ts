import { describe, expect, it } from "vite-plus/test";

import { DESKTOP_ONLY_CELL, metricColumnClassName } from "./leaderboard-columns";

describe("metricColumnClassName", () => {
  it("always shows the column the leaderboard is ranked by", () => {
    expect(metricColumnClassName("spend", "spend")).toBeUndefined();
    expect(metricColumnClassName("tokens", "tokens")).toBeUndefined();
  });

  it("hides the other metric column below sm", () => {
    expect(metricColumnClassName("tokens", "spend")).toBe(DESKTOP_ONLY_CELL);
    expect(metricColumnClassName("spend", "tokens")).toBe(DESKTOP_ONLY_CELL);
  });
});
