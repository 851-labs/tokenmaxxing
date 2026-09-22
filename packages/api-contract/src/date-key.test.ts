import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { DateKey, isDateKey, shiftDayKey, utcDayKey } from "./date-key";

const MS_PER_DAY = 86_400_000;

describe("date keys", () => {
  it("shifts across every day of several centuries and leap rules", () => {
    // Test-only oracle: the implementation itself never touches Date.
    const oracle = (dayNumber: number) =>
      new Date(dayNumber * MS_PER_DAY).toISOString().slice(0, 10);
    const mismatches: string[] = [];
    let key = oracle(-25_575);
    expect(key).toBe("1899-12-24");
    for (let dayNumber = -25_575; dayNumber <= 157_000; dayNumber += 1) {
      const expected = oracle(dayNumber);
      if (key !== expected) {
        mismatches.push(`${key} != ${expected}`);
        break;
      }
      if (shiftDayKey(shiftDayKey(key, 37), -37) !== key) {
        mismatches.push(`${key} does not round-trip`);
        break;
      }
      key = shiftDayKey(key, 1);
    }
    expect(mismatches).toEqual([]);
  });

  it("shifts by arbitrary offsets in both directions", () => {
    expect(shiftDayKey("2024-02-28", 1)).toBe("2024-02-29");
    expect(shiftDayKey("2025-02-28", 1)).toBe("2025-03-01");
    expect(shiftDayKey("2026-01-01", -1)).toBe("2025-12-31");
    expect(shiftDayKey("2026-06-12", -29)).toBe("2026-05-14");
    expect(shiftDayKey("2026-06-12", 0)).toBe("2026-06-12");
    expect(shiftDayKey("2000-03-01", -1)).toBe("2000-02-29");
    expect(shiftDayKey("1900-03-01", -1)).toBe("1900-02-28");
  });

  it("returns malformed keys unchanged instead of throwing", () => {
    for (const key of ["", "garbage", "2026-02-30", "2026-6-1"]) {
      expect(shiftDayKey(key, 1)).toBe(key);
    }
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
    }
  });

  it("formats the UTC calendar day of an instant", () => {
    expect(utcDayKey(new Date("2026-06-21T23:59:59.999Z"))).toBe("2026-06-21");
    expect(utcDayKey(new Date("2026-06-22T00:00:00.000Z"))).toBe("2026-06-22");
    expect(utcDayKey(new Date(0))).toBe("1970-01-01");
    expect(utcDayKey(new Date(-1))).toBe("1969-12-31");
  });

  it("decodes as a plain string and rejects impossible dates", async () => {
    await expect(Schema.decodeUnknownPromise(DateKey)("2026-06-21")).resolves.toBe("2026-06-21");
    await expect(Schema.decodeUnknownPromise(DateKey)("2026-02-30")).rejects.toThrow();
    await expect(Schema.decodeUnknownPromise(DateKey)("21/06/2026")).rejects.toThrow();
    await expect(Schema.decodeUnknownPromise(DateKey)(20_260_621)).rejects.toThrow();
  });
});
