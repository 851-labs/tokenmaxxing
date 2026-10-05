import type { UsageDayInput } from "@tokenmaxxing/api-contract";
import { sql, type SQL } from "drizzle-orm";

/**
 * Plausibility limits for one `usage_days` row (device, date, source, model).
 * The wire schema only proves a row is well-formed; these bounds reject rows
 * no real agent could produce, so fabricated uploads (2026-10-05: $2.7e296
 * and 8.6e15-token days) never reach storage, aggregates or the leaderboard.
 *
 * Calibrated against prod on 2026-10-05, excluding shadow-banned users:
 * - Tokens: the largest legitimate row is 110.7B total tokens (108.8B cache
 *   reads) and p99.99 is 23.4B, so 1T per row leaves ~9x headroom.
 * - Cost per token: the priciest model a coding agent bills through ccusage's
 *   LiteLLM table is o1-pro at $600/M output tokens; the highest legitimate
 *   row is $60/M (`claude-opus-4-7-fast`). $2,000/M is >3x o1-pro and ~33x
 *   what anyone has actually paid.
 * - Cost allowance: a few sources report cost on zero-token rows (up to
 *   $86.50), so every row may carry $250 on top of its per-token ceiling.
 * - Absolute cost: the largest legitimate row is $131k (p99.99 $15.2k), so
 *   $1M per row leaves ~7.6x headroom.
 *
 * A row outside these bounds is dropped at ingest (never the whole sync, as
 * with undecodable rows), and the cost freeze never keeps a stored cost that
 * exceeds them.
 */

const MAX_TOKENS_PER_ROW = 1_000_000_000_000;

const MAX_USD_PER_TOKEN = 0.002;

const COST_ALLOWANCE_USD = 250;

const MAX_COST_USD_PER_ROW = 1_000_000;

type UsageTokenField =
  | "cacheCreationTokens"
  | "cacheReadTokens"
  | "inputTokens"
  | "outputTokens"
  | "totalTokens";

type ImplausibleUsageReason = "cost" | "tokens";

const TOKEN_FIELDS: readonly UsageTokenField[] = [
  "cacheCreationTokens",
  "cacheReadTokens",
  "inputTokens",
  "outputTokens",
  "totalTokens",
];

/**
 * Tokens a row's cost may be billed against: `totalTokens` can exceed the
 * component sum (reasoning tokens ccusage prices but omits) or trail it.
 */
function billableTokens(row: Pick<UsageDayInput, UsageTokenField>): number {
  return Math.max(
    row.totalTokens,
    row.inputTokens + row.outputTokens + row.cacheCreationTokens + row.cacheReadTokens,
  );
}

/** The highest cost a row with these token counts may carry. */
function maxCostUsd(row: Pick<UsageDayInput, UsageTokenField>): number {
  return Math.min(
    MAX_COST_USD_PER_ROW,
    billableTokens(row) * MAX_USD_PER_TOKEN + COST_ALLOWANCE_USD,
  );
}

/** Why a row is implausible, or null when it is within every limit. */
function implausibleUsageReason(row: UsageDayInput): ImplausibleUsageReason | null {
  for (const field of TOKEN_FIELDS) {
    const value = row[field];
    if (!Number.isSafeInteger(value) || value < 0 || value > MAX_TOKENS_PER_ROW) {
      return "tokens";
    }
  }
  if (!Number.isFinite(row.costUsd) || row.costUsd < 0 || row.costUsd > maxCostUsd(row)) {
    return "cost";
  }

  return null;
}

interface UsageTokenColumns {
  cacheCreationTokens: SQL;
  cacheReadTokens: SQL;
  inputTokens: SQL;
  outputTokens: SQL;
  totalTokens: SQL;
}

/**
 * {@link maxCostUsd} in SQL over the given token columns. The limits are our
 * own constants, inlined so the expression binds no parameters.
 */
function maxCostUsdSql(columns: UsageTokenColumns): SQL<number> {
  const billable = sql`max(${columns.totalTokens}, ${columns.inputTokens} + ${columns.outputTokens} + ${columns.cacheCreationTokens} + ${columns.cacheReadTokens})`;
  return sql<number>`min(${sql.raw(String(MAX_COST_USD_PER_ROW))}, ${billable} * ${sql.raw(String(MAX_USD_PER_TOKEN))} + ${sql.raw(String(COST_ALLOWANCE_USD))})`;
}

export {
  COST_ALLOWANCE_USD,
  implausibleUsageReason,
  MAX_COST_USD_PER_ROW,
  MAX_TOKENS_PER_ROW,
  MAX_USD_PER_TOKEN,
  maxCostUsd,
  maxCostUsdSql,
};

export type { ImplausibleUsageReason, UsageTokenColumns };
