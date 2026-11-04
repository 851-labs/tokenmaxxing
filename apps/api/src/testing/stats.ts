import type { StatsRangeStarts } from "../stats/service";

/** Range starts for stats snapshots: every trailing range from `trailing`, plus year to date. */
function statsRangeStartsFrom(trailing: string, ytd: string): StatsRangeStarts {
  return { "1m": trailing, "2m": trailing, "2w": trailing, "3m": trailing, "6m": trailing, ytd };
}

export { statsRangeStartsFrom };
