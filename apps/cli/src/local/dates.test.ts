import { afterEach, describe, expect, it, vi } from "vitest";

import { localDay, onOrAfter } from "./dates";

// 2026-07-22T00:30:00Z — straddles the UTC day boundary for local-time tests.
const AFTER_MIDNIGHT_UTC = 1_784_680_200;

describe("localDay", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("buckets in local time, not UTC", () => {
    vi.stubEnv("TZ", "UTC");
    expect(localDay(AFTER_MIDNIGHT_UTC)).toBe("2026-07-22");

    vi.stubEnv("TZ", "America/New_York");
    expect(localDay(AFTER_MIDNIGHT_UTC)).toBe("2026-07-21");
  });

  it("zero-pads month and day", () => {
    vi.stubEnv("TZ", "UTC");
    // 2026-01-05T12:00:00Z
    expect(localDay(1_767_614_400)).toBe("2026-01-05");
  });
});

describe("onOrAfter", () => {
  it("compares YYYY-MM-DD strings inclusively", () => {
    expect(onOrAfter("2026-07-20", undefined)).toBe(true);
    expect(onOrAfter("2026-07-20", "2026-07-20")).toBe(true);
    expect(onOrAfter("2026-07-21", "2026-07-20")).toBe(true);
    expect(onOrAfter("2026-07-19", "2026-07-20")).toBe(false);
  });
});
