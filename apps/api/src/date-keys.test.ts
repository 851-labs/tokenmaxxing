import { describe, expect, it } from "vite-plus/test";

import { latestUsageDateKey, trailingWindowStart, utcDayKey } from "./date-keys";

describe("date-key windows", () => {
  const now = new Date("2026-06-12T22:30:00Z");

  it("covers the trailing calendar days inclusive of today", () => {
    expect(trailingWindowStart(1, now)).toBe(utcDayKey(now));
    expect(trailingWindowStart(7, now)).toBe("2026-06-06");
    expect(trailingWindowStart(30, now)).toBe("2026-05-14");
    expect(trailingWindowStart(30, new Date("2026-01-05T03:00:00Z"))).toBe("2025-12-07");
  });

  it("caps usage at UTC today + 1 for timezones ahead of UTC", () => {
    expect(latestUsageDateKey(now)).toBe("2026-06-13");
    expect(latestUsageDateKey(new Date("2026-12-31T23:59:59Z"))).toBe("2027-01-01");
  });
});
