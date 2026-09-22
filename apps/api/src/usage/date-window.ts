import { dayNumberToDateKey, utcDayNumber } from "@tokenmaxxing/api-contract";

/**
 * Server-side day windows over opaque YYYY-MM-DD usage keys. Keys are the
 * user's local-time buckets, so a device's "today" can run one calendar day
 * ahead of UTC (UTC+14 at most) — anything later cannot be real usage yet.
 */

const MAX_USAGE_DAYS_AHEAD_OF_UTC = 1;

/** Inclusive upper bound for usage day keys accepted at ingest and read back. */
function latestUsageDateKey(now: Date): string {
  return dayNumberToDateKey(utcDayNumber(now) + MAX_USAGE_DAYS_AHEAD_OF_UTC);
}

/** Inclusive lower bound covering the trailing `days` UTC calendar days. */
function trailingWindowStart(now: Date, days: number): string {
  return dayNumberToDateKey(utcDayNumber(now) - (days - 1));
}

export { latestUsageDateKey, MAX_USAGE_DAYS_AHEAD_OF_UTC, trailingWindowStart };
