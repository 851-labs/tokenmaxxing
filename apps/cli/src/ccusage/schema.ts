import { Schema } from "effect";

/**
 * The shape of `ccusage <source> daily --json --breakdown --mode calculate`
 * (v20, focused per-source commands — NOT the unified report, which buckets
 * by `period` and mixes agents). Each source emits a different dialect:
 *
 *   claude    totalCost + modelBreakdowns[{modelName, …, cost}]
 *   codex     costUSD   + models{name: {tokens…}} (no per-model cost)
 *   opencode  totalCost + modelsUsed[] only (day totals, no breakdown)
 *
 * Deliberately lenient: only `date` is required, every count defaults at
 * the aggregation step, and unknown keys are ignored.
 */

const CcusageModelBreakdown = Schema.Struct({
  cacheCreationTokens: Schema.optional(Schema.Number),
  cacheReadTokens: Schema.optional(Schema.Number),
  cost: Schema.optional(Schema.Number),
  inputTokens: Schema.optional(Schema.Number),
  modelName: Schema.String,
  outputTokens: Schema.optional(Schema.Number),
});

type CcusageModelBreakdown = typeof CcusageModelBreakdown.Type;

/** codex-style per-model entry: token counts only, cost lives on the day. */
const CcusageModelEntry = Schema.Struct({
  cacheCreationTokens: Schema.optional(Schema.Number),
  cacheReadTokens: Schema.optional(Schema.Number),
  inputTokens: Schema.optional(Schema.Number),
  outputTokens: Schema.optional(Schema.Number),
  totalTokens: Schema.optional(Schema.Number),
});

type CcusageModelEntry = typeof CcusageModelEntry.Type;

const CcusageDay = Schema.Struct({
  cacheCreationTokens: Schema.optional(Schema.Number),
  cacheReadTokens: Schema.optional(Schema.Number),
  costUSD: Schema.optional(Schema.Number),
  date: Schema.String,
  inputTokens: Schema.optional(Schema.Number),
  modelBreakdowns: Schema.optional(Schema.Array(CcusageModelBreakdown)),
  models: Schema.optional(Schema.Record(Schema.String, CcusageModelEntry)),
  modelsUsed: Schema.optional(Schema.Array(Schema.String)),
  outputTokens: Schema.optional(Schema.Number),
  totalCost: Schema.optional(Schema.Number),
  totalTokens: Schema.optional(Schema.Number),
});

type CcusageDay = typeof CcusageDay.Type;

const CcusageDailyReport = Schema.Struct({
  daily: Schema.Array(CcusageDay),
});

type CcusageDailyReport = typeof CcusageDailyReport.Type;

/**
 * Session entries stay `Unknown` at decode time because each source emits a
 * different dialect and only the count is read locally. They are NEVER
 * uploaded as-is: `sanitizeSessionReport` (./sanitize.ts) reduces them to an
 * allowlisted aggregate shape with a hashed session identifier first.
 */
const CcusageSessionReport = Schema.Struct({
  sessions: Schema.Array(Schema.Unknown),
});

type CcusageSessionReport = typeof CcusageSessionReport.Type;

const decodeDailyReport = Schema.decodeUnknownEffect(CcusageDailyReport);
const decodeSessionReport = Schema.decodeUnknownEffect(CcusageSessionReport);

export {
  CcusageDailyReport,
  CcusageDay,
  CcusageSessionReport,
  decodeDailyReport,
  decodeSessionReport,
};
