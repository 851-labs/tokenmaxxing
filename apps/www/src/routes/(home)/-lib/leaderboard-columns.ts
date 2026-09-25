import type { LeaderboardMetric } from "@tokenmaxxing/api-contract";

/** Hidden below `sm`, a regular table cell from `sm` up. */
const DESKTOP_ONLY_CELL = "hidden sm:table-cell";

/**
 * Visibility classes for a metric column (Spend or Tokens). Phones only have
 * room for one metric, so below `sm` the table shows just the column the
 * leaderboard is ranked by; from `sm` up both columns show. Header and body
 * cells share the result so labels always line up with their values.
 */
function metricColumnClassName(
  column: LeaderboardMetric,
  selected: LeaderboardMetric,
): string | undefined {
  return column === selected ? undefined : DESKTOP_ONLY_CELL;
}

export { DESKTOP_ONLY_CELL, metricColumnClassName };
