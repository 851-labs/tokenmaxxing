import { usageDays } from "@tokenmaxxing/db";
import { sql, type AnyColumn, type SQL } from "drizzle-orm";
import { Effect } from "effect";

import { DatabaseError } from "../database";

/**
 * Aggregate SQL fragments over `usage_days`. Sums use SQLite's `total()`, not
 * `sum()`: `sum()` over integer columns throws "integer overflow" once the
 * result passes int64 (fabricated rows took `/internal` down that way), while
 * `total()` sums as a float that cannot overflow and is 0.0 over no rows, so
 * callers never patch nulls in JS. Each accessor builds a fresh fragment, so
 * the result can be `.as(...)`-aliased per query without sharing state.
 */

function sumOf(column: AnyColumn): SQL<number> {
  return sql<number>`total(${column})`;
}

function countDistinct(column: AnyColumn): SQL<number> {
  return sql<number>`count(distinct ${column})`;
}

const usageAggregates = {
  activeDays: () => countDistinct(usageDays.date),
  cacheCreationTokens: () => sumOf(usageDays.cacheCreationTokens),
  cacheReadTokens: () => sumOf(usageDays.cacheReadTokens),
  deviceCount: () => countDistinct(usageDays.deviceId),
  firstDate: () => sql<string | null>`min(${usageDays.date})`,
  inputTokens: () => sumOf(usageDays.inputTokens),
  lastDate: () => sql<string | null>`max(${usageDays.date})`,
  outputTokens: () => sumOf(usageDays.outputTokens),
  rowCount: () => sql<number>`count(*)`,
  spendUsd: () => sumOf(usageDays.costUsd),
  totalTokens: () => sumOf(usageDays.totalTokens),
  userCount: () => countDistinct(usageDays.userId),
};

/** Picks the fragment a spend/tokens ranking orders by. */
function usageMetric(metric: "spend" | "tokens"): SQL<number> {
  return metric === "spend" ? usageAggregates.spendUsd() : usageAggregates.totalTokens();
}

/** An ungrouped aggregate query always yields exactly one row. */
function singleAggregateRow<A>(rows: readonly A[]): Effect.Effect<A, DatabaseError> {
  const [row] = rows;
  return row === undefined
    ? Effect.fail(new DatabaseError({ cause: "Aggregate query returned no rows." }))
    : Effect.succeed(row);
}

export { singleAggregateRow, sumOf, usageAggregates, usageMetric };
