import { isDateKey } from "@tokenmaxxing/api-contract";

import { MAX_USAGE_DAYS_AHEAD_OF_UTC, shiftDayKey } from "../date-keys";

/**
 * Streaks over opaque YYYY-MM-DD usage keys, using string day arithmetic (no
 * `Date` parsing; zero-padded keys sort and compare lexicographically).
 * Malformed keys and keys beyond the ingest ceiling are ignored rather than
 * trusted, so legacy bad rows cannot fail a profile.
 *
 * `currentStreakDays` is the run ending on the latest active day, but only
 * while that run is still alive: its last day must be no earlier than
 * "yesterday" for the user. Keys are local-time buckets and the server does
 * not know the user's timezone, so "yesterday" is measured from the earliest
 * local date anywhere (UTC today - 1, i.e. UTC-12), making it UTC today - 2.
 * A lapsed run reports 0 — the field name promises a current streak.
 */

const GRACE_DAYS_BEHIND_UTC = 2;

interface UsageStreaks {
  currentStreakDays: number;
  longestStreakDays: number;
}

function usageStreaks(dates: readonly string[], todayUtc: string): UsageStreaks {
  if (!isDateKey(todayUtc)) {
    return { currentStreakDays: 0, longestStreakDays: 0 };
  }

  const latestAccepted = shiftDayKey(todayUtc, MAX_USAGE_DAYS_AHEAD_OF_UTC);
  const activeDays = [
    ...new Set(dates.filter((date) => isDateKey(date) && date <= latestAccepted)),
  ].sort();

  let latestRun = 0;
  let longest = 0;
  let previous: string | null = null;
  for (const date of activeDays) {
    latestRun = previous !== null && date === shiftDayKey(previous, 1) ? latestRun + 1 : 1;
    longest = Math.max(longest, latestRun);
    previous = date;
  }

  const alive = previous !== null && previous >= shiftDayKey(todayUtc, -GRACE_DAYS_BEHIND_UTC);

  return {
    currentStreakDays: alive ? latestRun : 0,
    longestStreakDays: longest,
  };
}

export { usageStreaks };

export type { UsageStreaks };
