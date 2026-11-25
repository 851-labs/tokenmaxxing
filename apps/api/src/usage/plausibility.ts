import type { UsageDayInput } from "@tokenmaxxing/api-contract";
import { sql, type SQL } from "drizzle-orm";

/**
 * Plausibility limits for one `usage_days` row (device, date, source, model).
 * The wire schema only proves a row is well-formed; these bounds reject rows
 * no real agent could produce, so fabricated uploads never reach storage,
 * aggregates or the leaderboard. Past uploads they stop: 2026-10-05, $2.7e296
 * and 8.6e15-token days; 2026-11, about 1,800 rows of 40B input + 120B output
 * tokens and $683k each, under names like `<script>alert('hi')</script>`,
 * `{`, a backtick and `https://…`.
 *
 * Re-calibrated against prod on 2026-11-25, excluding shadow-banned users
 * (160k rows, 524 users). Real heavy usage is cache reads; uncached input and
 * output need actual prompting and generation, so they get tighter caps:
 * - Uncached input: the largest row is 8.3B, so 25B leaves ~3x headroom.
 * - Output: the largest row is 2.6B and the next 0.27B, so 10B leaves ~4x.
 * - Cache writes: the largest row is 675M, so 10B leaves ~15x.
 * - Cache reads and total: the largest row is 110.7B total (108.8B cache
 *   reads), so 500B leaves ~4.5x.
 * - Cost per token: the priciest model a coding agent bills through ccusage's
 *   LiteLLM table is o1-pro at $600/M output tokens; the highest legitimate
 *   row is $60/M (`claude-opus-4-7-fast`). $2,000/M is >3x o1-pro and ~33x
 *   what anyone has actually paid.
 * - Cost allowance: a few sources report cost on zero-token rows (up to
 *   $86.50), so every row may carry $250 on top of its per-token ceiling.
 * - Absolute cost: the largest row is $131k and the next $33k, so $250k
 *   leaves ~2x.
 * - Model names: see {@link implausibleModelName}.
 * These limits reject 23 stored rows of non-banned users: 18 fabricated
 * ones from two accounts and 5 zero-usage rows named "".
 *
 * A row outside these bounds is dropped at ingest (never the whole sync, as
 * with undecodable rows), and the cost freeze never keeps a stored cost that
 * exceeds them.
 */

const MAX_INPUT_TOKENS_PER_ROW = 25_000_000_000;

const MAX_OUTPUT_TOKENS_PER_ROW = 10_000_000_000;

const MAX_CACHE_CREATION_TOKENS_PER_ROW = 10_000_000_000;

const MAX_TOKENS_PER_ROW = 500_000_000_000;

const MAX_USD_PER_TOKEN = 0.002;

const COST_ALLOWANCE_USD = 250;

const MAX_COST_USD_PER_ROW = 250_000;

type UsageTokenField =
  | "cacheCreationTokens"
  | "cacheReadTokens"
  | "inputTokens"
  | "outputTokens"
  | "totalTokens";

type ImplausibleUsageReason = "cost" | "model" | "tokens";

const MAX_TOKENS: Readonly<Record<UsageTokenField, number>> = {
  cacheCreationTokens: MAX_CACHE_CREATION_TOKENS_PER_ROW,
  cacheReadTokens: MAX_TOKENS_PER_ROW,
  inputTokens: MAX_INPUT_TOKENS_PER_ROW,
  outputTokens: MAX_OUTPUT_TOKENS_PER_ROW,
  totalTokens: MAX_TOKENS_PER_ROW,
};

const TOKEN_FIELDS = Object.keys(MAX_TOKENS) as readonly UsageTokenField[];

/** Claude Code's marker for messages it made up itself (errors, interrupts). */
const SYNTHETIC_MODEL = "<synthetic>";

const PRINTABLE_ASCII = /^[\x20-\x7e]+$/u;

const MARKUP_CHARACTER = /[<>{}"'`]/u;

const LETTER = /[a-z]/iu;

const URL_SCHEME = /[a-z][a-z\d+.-]*:\/\//iu;

/**
 * Whether a (normalized) model name cannot be a real model id. Real names are
 * messy: provider prefixes (`anthropic/…`, `@cf/…`, `~openai/gpt-latest`),
 * display names with spaces and parentheses (`Grok 4.6 (Auto)`), `[1m]`
 * suffixes and bare aliases (`opus`, `o3`). So this rejects only what none of
 * the 1,870 names in prod (2026-11-25, non-banned users) have: non-printable
 * or non-ASCII characters, markup and quote characters, no letter at all
 * (`{`, `-`, `6`), a single character, or a URL. `<synthetic>` is the one
 * name with angle brackets, written by Claude Code itself.
 */
function implausibleModelName(model: string): boolean {
  if (model === SYNTHETIC_MODEL) {
    return false;
  }

  return (
    model.length < 2 ||
    !PRINTABLE_ASCII.test(model) ||
    MARKUP_CHARACTER.test(model) ||
    !LETTER.test(model) ||
    URL_SCHEME.test(model)
  );
}

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
  if (implausibleModelName(row.model)) {
    return "model";
  }
  for (const field of TOKEN_FIELDS) {
    const value = row[field];
    if (!Number.isSafeInteger(value) || value < 0 || value > MAX_TOKENS[field]) {
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
  implausibleModelName,
  implausibleUsageReason,
  MAX_COST_USD_PER_ROW,
  MAX_TOKENS,
  MAX_TOKENS_PER_ROW,
  MAX_USD_PER_TOKEN,
  maxCostUsd,
  maxCostUsdSql,
};

export type { ImplausibleUsageReason, UsageTokenColumns };
