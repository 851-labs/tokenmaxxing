import { describe, expect, it } from "vite-plus/test";

import {
  addDays,
  calendarYearEnd,
  calendarYearStart,
  dateFromDayNumber,
  dayNumber,
  enumerateDays,
  enumerateMonths,
  weekdayMondayFirst,
  weekdaySundayFirst,
} from "./dates";

describe("day numbers", () => {
  it("counts days from the Unix epoch", () => {
    expect(dayNumber("1970-01-01")).toBe(0);
    expect(dayNumber("1969-12-31")).toBe(-1);
    expect(dayNumber("2000-03-01")).toBe(11_017);
  });

  it("round-trips across leap days and century rules", () => {
    for (const date of ["2024-02-29", "2000-02-29", "1900-03-01", "2026-12-31", "2100-02-28"]) {
      expect(dateFromDayNumber(dayNumber(date))).toBe(date);
    }
  });

  it("adds days across month and year boundaries", () => {
    expect(addDays("2024-02-28", 1)).toBe("2024-02-29");
    expect(addDays("2025-02-28", 1)).toBe("2025-03-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
  });
});

describe("calendar walking", () => {
  it("enumerates inclusive day ranges", () => {
    expect(enumerateDays("2024-02-27", "2024-03-01")).toEqual([
      "2024-02-27",
      "2024-02-28",
      "2024-02-29",
      "2024-03-01",
    ]);
    expect(enumerateDays("2026-06-21", "2026-06-21")).toEqual(["2026-06-21"]);
    expect(enumerateDays("2026-06-22", "2026-06-21")).toEqual([]);
  });

  it("enumerates inclusive month ranges across years", () => {
    expect(enumerateMonths("2025-11-15", "2026-02-03")).toEqual([
      "2025-11",
      "2025-12",
      "2026-01",
      "2026-02",
    ]);
  });

  it("derives weekdays from the date key alone", () => {
    expect(weekdaySundayFirst("1970-01-01")).toBe(4); // Thursday
    expect(weekdaySundayFirst("2026-06-21")).toBe(0); // Sunday
    expect(weekdayMondayFirst("2026-06-21")).toBe(6);
    expect(weekdayMondayFirst("2026-06-15")).toBe(0); // Monday
    expect(weekdaySundayFirst("1969-12-28")).toBe(0); // Sunday before the epoch
  });

  it("finds calendar year bounds", () => {
    expect(calendarYearStart("2026-06-21")).toBe("2026-01-01");
    expect(calendarYearEnd("2026-06-21")).toBe("2026-12-31");
  });
});
