import { shiftDayKey, utcDayKey } from "@tokenmaxxing/api-contract";

/**
 * Server-side windows over opaque YYYY-MM-DD usage keys, built on the
 * contract's string day arithmetic (keys are never parsed into Dates).
 * Zero-padded keys compare lexicographically, which every bound relies on.
 * Keys are the user's local-time buckets, so a device's "today" can run one
 * calendar day ahead of UTC (UTC+14 at most) — anything later is not real
 * usage yet.
 */

const YEAR_2026_START = "2026-01-01";

const MAX_USAGE_DAYS_AHEAD_OF_UTC = 1;

/** Inclusive lower bound covering the trailing `days` calendar days, today (UTC) included. */
function trailingWindowStart(days: number, now: Date): string {
  return shiftDayKey(utcDayKey(now), -(days - 1));
}

/** Inclusive upper bound for usage day keys accepted at ingest and read back. */
function latestUsageDateKey(now: Date): string {
  return shiftDayKey(utcDayKey(now), MAX_USAGE_DAYS_AHEAD_OF_UTC);
}

export {
  latestUsageDateKey,
  MAX_USAGE_DAYS_AHEAD_OF_UTC,
  shiftDayKey,
  trailingWindowStart,
  utcDayKey,
  YEAR_2026_START,
};
