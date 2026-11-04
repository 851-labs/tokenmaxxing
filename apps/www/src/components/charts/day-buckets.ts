import { dateFromDayNumber, dayNumber } from "../../lib/dates";

/**
 * Fixed-size day buckets for trend charts: a long range is split into equal
 * N-day bars so the bar count stays readable at any zoom, the way a year of
 * daily bars would not.
 */

/** About two months of daily bars; longer ranges widen each bar instead. */
const MAX_TREND_BARS = 62;

interface DayBucket {
  /** First day the bar covers; also its key. */
  first: string;
  /** Last day the bar covers, inclusive. */
  last: string;
}

interface DayBucketing {
  /** The bucket key (its first day) a date falls in, or undefined outside the range. */
  bucketOf(date: string): string | undefined;
  /** Oldest first. */
  buckets: DayBucket[];
  /** Days per bucket. Only the oldest bucket can be shorter. */
  size: number;
}

/**
 * Split the inclusive range into the fewest equal buckets that keep at most
 * `maxBars` bars. Buckets are aligned to the range's last day, so the newest
 * bar is always a full bucket ending on it; when the span doesn't divide
 * evenly, the oldest bucket is the partial one.
 */
function bucketDays(first: string, last: string, maxBars = MAX_TREND_BARS): DayBucketing {
  const start = dayNumber(first);
  const end = dayNumber(last);
  const span = Math.max(end - start + 1, 0);
  const size = Math.max(Math.ceil(span / Math.max(Math.floor(maxBars), 1)), 1);
  const count = Math.ceil(span / size);
  const buckets = Array.from({ length: count }, (_, index) => {
    const bucketEnd = end - (count - 1 - index) * size;

    return {
      first: dateFromDayNumber(Math.max(bucketEnd - size + 1, start)),
      last: dateFromDayNumber(bucketEnd),
    };
  });

  return {
    bucketOf: (date) => {
      const day = dayNumber(date);
      if (day < start || day > end) {
        return undefined;
      }

      return buckets[count - 1 - Math.floor((end - day) / size)]?.first;
    },
    buckets,
    size,
  };
}

export { bucketDays, MAX_TREND_BARS };

export type { DayBucket, DayBucketing };
