import { USAGE_RANGE_DAYS, type UsageRangeId } from "@tokenmaxxing/api-contract";

import type { SegmentedOption } from "../components/ui/segmented-control";
import { addDays } from "./dates";

/**
 * The time ranges profiles and /stats filter by, as the filter bars offer
 * them. The ids and day counts live in the API contract so the server's
 * /stats ranges and the client's always agree.
 */

const DEFAULT_USAGE_RANGE: UsageRangeId = "2m";

const USAGE_RANGE_OPTIONS = [
  { label: "2W", value: "2w" },
  { label: "1M", value: "1m" },
  { label: "2M", value: "2m" },
  { label: "3M", value: "3m" },
  { label: "6M", value: "6m" },
  { label: "YTD", value: "ytd" },
] as const satisfies readonly SegmentedOption<UsageRangeId>[];

interface DayWindow {
  /** Inclusive YYYY-MM-DD bounds. */
  firstDate: string;
  lastDate: string;
}

/**
 * The range's trailing window ending on `loaded.lastDate`, clamped to the
 * loaded days; `ytd` is everything loaded (which starts on Jan 1).
 */
function usageRangeWindow(loaded: DayWindow, range: UsageRangeId): DayWindow {
  const days = USAGE_RANGE_DAYS[range];
  if (days === null) {
    return loaded;
  }
  const first = addDays(loaded.lastDate, -(days - 1));

  return {
    firstDate: first > loaded.firstDate ? first : loaded.firstDate,
    lastDate: loaded.lastDate,
  };
}

export { DEFAULT_USAGE_RANGE, USAGE_RANGE_OPTIONS, usageRangeWindow };

export type { DayWindow };
