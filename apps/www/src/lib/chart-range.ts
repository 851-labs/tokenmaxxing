const TIME_RANGE_VALUES = ["2w", "1m", "2m", "3m", "6m", "max"] as const;
type TimeRange = (typeof TIME_RANGE_VALUES)[number];
interface DateRange {
  first: string;
  last: string;
}

const TIME_RANGES: { value: TimeRange; label: string; days: number | null }[] = [
  { value: "2w", label: "Last 2 weeks", days: 14 },
  { value: "1m", label: "Last month", days: 30 },
  { value: "2m", label: "Last 2 months", days: 60 },
  { value: "3m", label: "Last 3 months", days: 90 },
  { value: "6m", label: "Last 6 months", days: 180 },
  { value: "max", label: "2026", days: null },
];

const TARGET_BUCKET_COUNT = 60;

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/** Calendar arithmetic on opaque local-day keys, without timezone conversion. */
function shiftDay(date: string, offset: number): string {
  let year = Number(date.slice(0, 4));
  let month = Number(date.slice(5, 7));
  let day = Number(date.slice(8, 10)) + offset;
  while (day < 1) {
    month--;
    if (month < 1) {
      month = 12;
      year--;
    }
    day += daysInMonth(year, month);
  }
  while (day > daysInMonth(year, month)) {
    day -= daysInMonth(year, month);
    month++;
    if (month > 12) {
      month = 1;
      year++;
    }
  }
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function calendarDays(first: string, last: string): string[] {
  const days: string[] = [];
  for (let day = first; day <= last; day = shiftDay(day, 1)) {
    days.push(day);
  }
  return days;
}

/** Monday = 0; January 1 of year 1 was a Monday in the Gregorian calendar. */
function weekdayIndex(date: string): number {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const priorYears = year - 1;
  let ordinal =
    365 * priorYears +
    Math.floor(priorYears / 4) -
    Math.floor(priorYears / 100) +
    Math.floor(priorYears / 400) +
    Number(date.slice(8, 10)) -
    1;
  for (let m = 1; m < month; m++) ordinal += daysInMonth(year, m);
  return ordinal % 7;
}

function chartRange(value: TimeRange, today: string, firstDate: string | null) {
  const days = TIME_RANGES.find((option) => option.value === value)?.days ?? null;
  const first =
    days === null
      ? firstDate !== null && firstDate < today
        ? firstDate
        : today
      : shiftDay(today, 1 - days);
  const range = { first, last: today };
  const length = calendarDays(first, today).length;
  const bucketDays = Math.max(1, Math.ceil(length / TARGET_BUCKET_COUNT));
  return { range, bucketDays };
}

/**
 * Match the observed Vercel leaderboard density: roughly 60 bars, anchored
 * to the last day, with both range endpoints represented. On 2026-09-21,
 * its 90/180/355-day windows rendered 46/61/60 bars (2/3/6-day spacing).
 * Sum every day into a bucket, including the partial buckets at the start.
 */
function chartBuckets(range: DateRange, bucketDays: number): DateRange[] {
  if (range.first > range.last) return [];
  const step = Math.max(1, Math.floor(bucketDays));
  const ends: string[] = [];
  for (let last = range.last; last > range.first; last = shiftDay(last, -step)) {
    ends.push(last);
  }
  ends.push(range.first);
  ends.reverse();
  return ends.map((last, index) => ({
    first: index === 0 ? range.first : shiftDay(ends[index - 1]!, 1),
    last,
  }));
}

const MONTH_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

function formatRangeDate(date: string, withYear = true): string {
  const label = `${MONTH_NAMES[Number(date.slice(5, 7)) - 1]} ${Number(date.slice(8, 10))}`;
  return withYear ? `${label}, ${date.slice(0, 4)}` : label;
}

function formatDateRange(first: string, last: string): string {
  return first === last
    ? formatRangeDate(first)
    : `${formatRangeDate(first, first.slice(0, 4) !== last.slice(0, 4))} – ${formatRangeDate(last)}`;
}

export {
  calendarDays,
  chartBuckets,
  chartRange,
  formatDateRange,
  formatRangeDate,
  shiftDay,
  TIME_RANGES,
  TIME_RANGE_VALUES,
  weekdayIndex,
};
export type { DateRange, TimeRange };
