import { describe, expect, it } from "vite-plus/test";

import { isLastUsedStale } from "./d1";

describe("isLastUsedStale", () => {
  const now = new Date("2026-09-22T12:00:00.000Z");

  it("refreshes a never-used token", () => {
    expect(isLastUsedStale(null, now)).toBe(true);
  });

  it("skips the write within the hour and refreshes after it", () => {
    expect(isLastUsedStale(new Date("2026-09-22T11:30:00.000Z"), now)).toBe(false);
    expect(isLastUsedStale(new Date("2026-09-22T11:00:00.000Z"), now)).toBe(true);
  });
});
