import * as Schema from "effect/Schema";

/**
 * Usage `date` values are opaque `YYYY-MM-DD` day keys (ccusage local-time
 * buckets). They are never parsed into `Date` objects: day arithmetic runs on
 * integer day numbers (days since 1970-01-01 in the proleptic Gregorian
 * calendar) computed from the key's digits, so a key can neither shift across
 * timezones nor throw on malformed input. API-side windows live in
 * apps/api/src/date-keys.ts.
 */

const DATE_KEY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    return isLeapYear(year) ? 29 : 28;
  }

  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

/** Day number for a calendar-valid key; `undefined` for anything else. */
function dayNumberOf(value: string): number | undefined {
  const match = DATE_KEY_PATTERN.exec(value);
  if (match === null) {
    return undefined;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    return undefined;
  }

  // Howard Hinnant's days_from_civil, with years starting in March.
  const shiftedYear = month <= 2 ? year - 1 : year;
  const era = Math.floor(shiftedYear / 400);
  const yearOfEra = shiftedYear - era * 400;
  const monthFromMarch = (month + 9) % 12;
  const dayOfYear = Math.floor((153 * monthFromMarch + 2) / 5) + day - 1;
  const dayOfEra =
    yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;

  return era * 146_097 + dayOfEra - 719_468;
}

/** Inverse of {@link dayNumberOf} (civil_from_days). */
function dateKeyOf(dayNumber: number): string {
  const shifted = dayNumber + 719_468;
  const era = Math.floor(shifted / 146_097);
  const dayOfEra = shifted - era * 146_097;
  const yearOfEra = Math.floor(
    (dayOfEra -
      Math.floor(dayOfEra / 1_460) +
      Math.floor(dayOfEra / 36_524) -
      Math.floor(dayOfEra / 146_096)) /
      365,
  );
  const dayOfYear =
    dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100));
  const monthFromMarch = Math.floor((5 * dayOfYear + 2) / 153);
  const day = dayOfYear - Math.floor((153 * monthFromMarch + 2) / 5) + 1;
  const month = monthFromMarch < 10 ? monthFromMarch + 3 : monthFromMarch - 9;
  const year = yearOfEra + era * 400 + (month <= 2 ? 1 : 0);

  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function isDateKey(value: string): boolean {
  return dayNumberOf(value) !== undefined;
}

/** The UTC calendar day containing `now`. */
function utcDayKey(now: Date): string {
  return dateKeyOf(Math.floor(now.getTime() / MS_PER_DAY));
}

/**
 * Moves `key` by `days` calendar days (negative moves backwards). Keys that
 * are not calendar-valid are returned unchanged; check {@link isDateKey}
 * first where that matters.
 */
function shiftDayKey(key: string, days: number): string {
  const dayNumber = dayNumberOf(key);
  return dayNumber === undefined ? key : dateKeyOf(dayNumber + days);
}

/**
 * Wire schema for day keys: `YYYY-MM-DD` that names a real calendar day.
 * The decoded value stays a plain string.
 */
const DateKey = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/),
  Schema.makeFilter((value: string) => isDateKey(value) || "expected a calendar date"),
);

export { DateKey, isDateKey, shiftDayKey, utcDayKey };
