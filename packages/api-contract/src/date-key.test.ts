import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  DateKey,
  dateKeyToDayNumber,
  dayNumberToDateKey,
  isDateKey,
  utcDateKey,
  utcDayNumber,
} from "./date-key";

describe("date keys", () => {
  it("anchors day numbers at the Unix epoch", () => {
    expect(dateKeyToDayNumber("1970-01-01")).toBe(0);
    expect(dateKeyToDayNumber("1969-12-31")).toBe(-1);
    expect(dayNumberToDateKey(0)).toBe("1970-01-01");
  });

  it("round-trips every day across several centuries and leap rules", () => {
    const start = dateKeyToDayNumber("1899-12-25")!;
    const end = dateKeyToDayNumber("2401-01-05")!;
    const mismatches: number[] = [];
    for (let dayNumber = start; dayNumber <= end; dayNumber += 1) {
      const key = dayNumberToDateKey(dayNumber);
      // Test-only oracle: the implementation itself never touches Date.
      const expected = new Date(dayNumber * 86_400_000).toISOString().slice(0, 10);
      if (key !== expected || dateKeyToDayNumber(key) !== dayNumber) {
        mismatches.push(dayNumber);
      }
    }
    expect(mismatches).toEqual([]);
  });

  it("accepts only real calendar days in YYYY-MM-DD form", () => {
    for (const valid of ["2024-02-29", "2000-02-29", "2026-12-31", "0001-01-01", "9999-12-31"]) {
      expect(isDateKey(valid)).toBe(true);
    }
    for (const invalid of [
      "",
      "2026-6-1",
      "2026-06-1",
      "20260601",
      "2026/06/01",
      "2026-06-01T00:00:00Z",
      " 2026-06-01",
      "2026-00-10",
      "2026-13-01",
      "2026-06-00",
      "2026-06-31",
      "2025-02-29",
      "1900-02-29",
      "+02026-06-01",
      "２０２６-06-01",
    ]) {
      expect(isDateKey(invalid)).toBe(false);
      expect(dateKeyToDayNumber(invalid)).toBeUndefined();
    }
  });

  it("formats the UTC calendar day of an instant", () => {
    const now = new Date("2026-06-21T23:59:59.999Z");
    expect(utcDateKey(now)).toBe("2026-06-21");
    expect(utcDayNumber(now)).toBe(dateKeyToDayNumber("2026-06-21"));
    expect(utcDateKey(new Date("2026-06-22T00:00:00.000Z"))).toBe("2026-06-22");
  });

  it("decodes as a plain string and rejects impossible dates", async () => {
    await expect(Schema.decodeUnknownPromise(DateKey)("2026-06-21")).resolves.toBe("2026-06-21");
    await expect(Schema.decodeUnknownPromise(DateKey)("2026-02-30")).rejects.toThrow();
    await expect(Schema.decodeUnknownPromise(DateKey)("21/06/2026")).rejects.toThrow();
    await expect(Schema.decodeUnknownPromise(DateKey)(20_260_621)).rejects.toThrow();
  });
});
