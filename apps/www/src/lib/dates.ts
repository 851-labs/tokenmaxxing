/**
 * Calendar walking over opaque YYYY-MM-DD keys. Dates are ccusage local-time
 * buckets, so they are never turned into `Date` objects here: everything is
 * integer day arithmetic (Hinnant's civil-date algorithms), which is
 * timezone-free by construction.
 */

/** Days since 1970-01-01 for a YYYY-MM-DD key. */
function dayNumber(date: string): number {
  const month = Number(date.slice(5, 7));
  const day = Number(date.slice(8, 10));
  const year = Number(date.slice(0, 4)) - (month <= 2 ? 1 : 0);
  const era = Math.floor(year / 400);
  const yearOfEra = year - era * 400;
  const dayOfYear = Math.floor((153 * ((month + 9) % 12) + 2) / 5) + day - 1;
  const dayOfEra =
    yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;

  return era * 146_097 + dayOfEra - 719_468;
}

/** Inverse of `dayNumber`. */
function dateFromDayNumber(value: number): string {
  const shifted = value + 719_468;
  const era = Math.floor(shifted / 146_097);
  const dayOfEra = shifted - era * 146_097;
  const yearOfEra = Math.floor(
    (dayOfEra -
      Math.floor(dayOfEra / 1460) +
      Math.floor(dayOfEra / 36_524) -
      Math.floor(dayOfEra / 146_096)) /
      365,
  );
  const dayOfYear =
    dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100));
  const shiftedMonth = Math.floor((5 * dayOfYear + 2) / 153);
  const day = dayOfYear - Math.floor((153 * shiftedMonth + 2) / 5) + 1;
  const month = shiftedMonth < 10 ? shiftedMonth + 3 : shiftedMonth - 9;
  const year = yearOfEra + era * 400 + (month <= 2 ? 1 : 0);

  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
}

function addDays(date: string, days: number): string {
  return dateFromDayNumber(dayNumber(date) + days);
}

/** Every YYYY-MM-DD between two inclusive bounds. */
function enumerateDays(first: string, last: string): string[] {
  const start = dayNumber(first);
  const end = dayNumber(last);

  return Array.from({ length: Math.max(end - start + 1, 0) }, (_, offset) =>
    dateFromDayNumber(start + offset),
  );
}

/** Every YYYY-MM between the months of two inclusive bounds. */
function enumerateMonths(first: string, last: string): string[] {
  const months: string[] = [];
  let year = Number(first.slice(0, 4));
  let month = Number(first.slice(5, 7));
  const endYear = Number(last.slice(0, 4));
  const endMonth = Number(last.slice(5, 7));
  while (year < endYear || (year === endYear && month <= endMonth)) {
    months.push(`${pad(year, 4)}-${pad(month, 2)}`);
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }

  return months;
}

/** 0 = Sunday … 6 = Saturday. 1970-01-01 was a Thursday. */
function weekdaySundayFirst(date: string): number {
  return mod(dayNumber(date) + 4, 7);
}

/** 0 = Monday … 6 = Sunday. */
function weekdayMondayFirst(date: string): number {
  return mod(dayNumber(date) + 3, 7);
}

function calendarYearStart(date: string): string {
  return `${date.slice(0, 4)}-01-01`;
}

function calendarYearEnd(date: string): string {
  return `${date.slice(0, 4)}-12-31`;
}

function mod(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

export {
  addDays,
  calendarYearEnd,
  calendarYearStart,
  dateFromDayNumber,
  dayNumber,
  enumerateDays,
  enumerateMonths,
  weekdayMondayFirst,
  weekdaySundayFirst,
};
