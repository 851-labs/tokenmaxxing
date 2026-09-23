import {
  MAX_REPORT_DAYS,
  TokenCount,
  UsageDateKey,
  UsdAmount,
  type RawUsageReportInput,
  type SourceUsageStatsInput,
  type UsageDayInput,
  type UsageSource,
} from "@tokenmaxxing/api-contract";
import { Effect, Option, Schema } from "effect";

const PARSER_VERSION = "ccusage-v20-raw-5";

const MAX_MODELS_PER_DAY = 256;

const CcusageModelName = Schema.String.check(Schema.isMaxLength(256));

const CcusageModelBreakdown = Schema.Struct({
  cacheCreationTokens: Schema.optional(TokenCount),
  cacheReadTokens: Schema.optional(TokenCount),
  cost: Schema.optional(UsdAmount),
  inputTokens: Schema.optional(TokenCount),
  modelName: CcusageModelName,
  outputTokens: Schema.optional(TokenCount),
});

type CcusageModelBreakdown = typeof CcusageModelBreakdown.Type;

const CcusageModelEntry = Schema.Struct({
  cacheCreationTokens: Schema.optional(TokenCount),
  cacheReadTokens: Schema.optional(TokenCount),
  inputTokens: Schema.optional(TokenCount),
  outputTokens: Schema.optional(TokenCount),
  totalTokens: Schema.optional(TokenCount),
});

type CcusageModelEntry = typeof CcusageModelEntry.Type;

const CcusageDay = Schema.Struct({
  cacheCreationTokens: Schema.optional(TokenCount),
  cacheReadTokens: Schema.optional(TokenCount),
  costUSD: Schema.optional(UsdAmount),
  date: UsageDateKey,
  inputTokens: Schema.optional(TokenCount),
  modelBreakdowns: Schema.optional(
    Schema.Array(CcusageModelBreakdown).check(Schema.isMaxLength(MAX_MODELS_PER_DAY)),
  ),
  models: Schema.optional(
    Schema.Record(CcusageModelName, CcusageModelEntry).check(
      Schema.isMaxProperties(MAX_MODELS_PER_DAY),
    ),
  ),
  modelsUsed: Schema.optional(
    Schema.Array(CcusageModelName).check(Schema.isMaxLength(MAX_MODELS_PER_DAY)),
  ),
  outputTokens: Schema.optional(TokenCount),
  totalCost: Schema.optional(UsdAmount),
  totalTokens: Schema.optional(TokenCount),
});

type CcusageDay = typeof CcusageDay.Type;

/**
 * Days are decoded one by one so a single malformed day cannot sink a report.
 * The contract already rejects reports over the day cap; this is a backstop.
 */
const CcusageDailyReport = Schema.Struct({
  daily: Schema.Array(Schema.Unknown).check(Schema.isMaxLength(MAX_REPORT_DAYS)),
});

const CcusageSessionReport = Schema.Struct({
  sessions: Schema.Array(Schema.Unknown),
});

const decodeDailyReport = Schema.decodeUnknownEffect(CcusageDailyReport);
const decodeDay = Schema.decodeUnknownEffect(CcusageDay);
const decodeSessionReport = Schema.decodeUnknownEffect(CcusageSessionReport);

interface ParsedRawUsageReports {
  coveredDays: CoveredUsageDay[];
  persistableReports: PersistableDailyReport[];
  rows: UsageDayInput[];
  sourceStats: SourceUsageStatsInput[];
}

interface CoveredUsageDay {
  date: string;
  source: UsageSource;
}

type PersistableDailyReport = Omit<RawUsageReportInput, "reportKind"> & {
  reportKind: "daily";
};

interface ParseRawUsageOptions {
  /**
   * Inclusive upper bound for accepted day keys. Later days are dropped: they
   * are neither stored, persisted in the raw report, nor treated as covered.
   */
  latestDate: string;
}

/**
 * Turns raw report envelopes into structured rows. Each daily report is
 * authoritative for its source, so when a payload carries several daily
 * reports for one source the last decodable one wins — concatenating them
 * would sum the same days twice and break idempotent re-syncs.
 */
function parseRawUsageReports(
  reports: readonly RawUsageReportInput[],
  options: ParseRawUsageOptions,
): Effect.Effect<ParsedRawUsageReports> {
  return Effect.gen(function* () {
    const dailyBySource = new Map<UsageSource, PersistableDailyReport & { days: CcusageDay[] }>();
    const sourceStats: SourceUsageStatsInput[] = [];

    for (const report of reports) {
      if (report.reportKind === "daily") {
        const decoded = yield* decodeDailyReport(report.payload).pipe(Effect.option);
        if (Option.isNone(decoded)) {
          continue;
        }

        const days: CcusageDay[] = [];
        for (const rawDay of decoded.value.daily) {
          const day = yield* decodeDay(rawDay).pipe(Effect.option);
          if (Option.isSome(day) && day.value.date <= options.latestDate) {
            days.push(day.value);
          }
        }

        // Delete first so the surviving report keeps the position of the last one.
        dailyBySource.delete(report.source);
        dailyBySource.set(report.source, {
          command: report.command,
          days,
          payload: { daily: days },
          reportKind: "daily",
          source: report.source,
        });
      } else {
        const decoded = yield* decodeSessionReport(report.payload).pipe(Effect.option);
        if (Option.isSome(decoded)) {
          sourceStats.push({
            sessionCount: decoded.value.sessions.length,
            source: report.source,
          });
        }
      }
    }

    const coveredDays = new Map<string, CoveredUsageDay>();
    const persistableReports: PersistableDailyReport[] = [];
    const rows: UsageDayInput[] = [];
    for (const { days, ...report } of dailyBySource.values()) {
      persistableReports.push(report);
      for (const day of days) {
        coveredDays.set(JSON.stringify([report.source, day.date]), {
          date: day.date,
          source: report.source,
        });
      }
      rows.push(...aggregateDays(report.source, days));
    }

    return { coveredDays: [...coveredDays.values()], persistableReports, rows, sourceStats };
  });
}

function aggregateDays(source: UsageSource, days: readonly CcusageDay[]): UsageDayInput[] {
  const merged = new Map<string, UsageDayInput>();

  const add = (row: UsageDayInput) => {
    const key = `${row.date} ${row.model}`;
    const existing = merged.get(key);
    if (existing === undefined) {
      merged.set(key, row);
      return;
    }

    merged.set(key, {
      ...existing,
      cacheCreationTokens: existing.cacheCreationTokens + row.cacheCreationTokens,
      cacheReadTokens: existing.cacheReadTokens + row.cacheReadTokens,
      costUsd: existing.costUsd + row.costUsd,
      inputTokens: existing.inputTokens + row.inputTokens,
      outputTokens: existing.outputTokens + row.outputTokens,
      totalTokens: existing.totalTokens + row.totalTokens,
    });
  };

  for (const day of days) {
    const dayCost = day.totalCost ?? day.costUSD ?? 0;
    const entries = collectModelEntries(day);

    if (entries.length === 0) {
      add({
        cacheCreationTokens: day.cacheCreationTokens ?? 0,
        cacheReadTokens: day.cacheReadTokens ?? 0,
        costUsd: dayCost,
        date: day.date,
        inputTokens: day.inputTokens ?? 0,
        model: day.modelsUsed?.length === 1 ? day.modelsUsed[0]! : "unknown",
        outputTokens: day.outputTokens ?? 0,
        source,
        totalTokens: day.totalTokens ?? 0,
      });
      continue;
    }

    const tokensOf = (entry: ModelTotals) =>
      entry.inputTokens + entry.outputTokens + entry.cacheCreationTokens + entry.cacheReadTokens;
    const totalTokens = modelTotalTokens(day.totalTokens, entries, tokensOf);
    const knownCost = entries.reduce((sum, entry) => sum + (entry.cost ?? 0), 0);
    const unpriced = entries.filter((entry) => entry.cost === undefined);
    const unpricedWeight = unpriced.reduce((sum, entry) => sum + tokensOf(entry), 0);
    const remainder = Math.max(dayCost - knownCost, 0);
    // With every entry priced, any day-level surplus (e.g. reasoning tokens
    // ccusage prices but omits from the breakdown) is spread over all entries
    // by token weight instead of being dropped.
    const surplusWeight = entries.reduce((sum, entry) => sum + tokensOf(entry), 0);
    const surplusShare = (entry: ModelTotals) =>
      unpriced.length > 0
        ? 0
        : surplusWeight > 0
          ? (remainder * tokensOf(entry)) / surplusWeight
          : remainder / entries.length;

    for (const [index, entry] of entries.entries()) {
      const cost =
        entry.cost === undefined
          ? unpricedWeight > 0
            ? (remainder * tokensOf(entry)) / unpricedWeight
            : remainder / unpriced.length
          : entry.cost + surplusShare(entry);
      add({
        cacheCreationTokens: entry.cacheCreationTokens,
        cacheReadTokens: entry.cacheReadTokens,
        costUsd: cost,
        date: day.date,
        inputTokens: entry.inputTokens,
        model: entry.model,
        outputTokens: entry.outputTokens,
        source,
        totalTokens: totalTokens[index]!,
      });
    }
  }

  return [...merged.values()].sort((a, b) =>
    a.date === b.date ? a.model.localeCompare(b.model) : a.date.localeCompare(b.date),
  );
}

interface ModelTotals {
  cacheCreationTokens: number;
  cacheReadTokens: number;
  cost: number | undefined;
  inputTokens: number;
  model: string;
  outputTokens: number;
  totalTokens: number | undefined;
}

function collectModelEntries(day: CcusageDay): ModelTotals[] {
  const entries: ModelTotals[] = [];
  if (day.modelBreakdowns !== undefined && day.modelBreakdowns.length > 0) {
    for (const breakdown of day.modelBreakdowns) {
      entries.push({
        cacheCreationTokens: breakdown.cacheCreationTokens ?? 0,
        cacheReadTokens: breakdown.cacheReadTokens ?? 0,
        cost: breakdown.cost,
        inputTokens: breakdown.inputTokens ?? 0,
        model: breakdown.modelName,
        outputTokens: breakdown.outputTokens ?? 0,
        totalTokens: undefined,
      });
    }
  } else if (day.models !== undefined && Object.keys(day.models).length > 0) {
    for (const [model, entry] of Object.entries(day.models)) {
      entries.push({
        cacheCreationTokens: entry.cacheCreationTokens ?? 0,
        cacheReadTokens: entry.cacheReadTokens ?? 0,
        cost: undefined,
        inputTokens: entry.inputTokens ?? 0,
        model,
        outputTokens: entry.outputTokens ?? 0,
        totalTokens: entry.totalTokens,
      });
    }
  }

  return entries;
}

/** Preserve day-level tokens that ccusage does not expose in per-model fields. */
function modelTotalTokens<T extends { totalTokens: number | undefined }>(
  dayTotalTokens: number | undefined,
  entries: readonly T[],
  visibleTokensOf: (entry: T) => number,
): number[] {
  const totals = entries.map((entry) => Math.max(visibleTokensOf(entry), entry.totalTokens ?? 0));
  const knownTotal = totals.reduce((sum, total) => sum + total, 0);
  const unreported = Math.max(0, Math.trunc(dayTotalTokens ?? knownTotal) - knownTotal);
  if (unreported === 0) {
    return totals;
  }

  const weight = totals.reduce((sum, total) => sum + total, 0);
  const shares = totals.map((total) =>
    weight > 0 ? (unreported * total) / weight : unreported / totals.length,
  );
  const allocated = shares.map(Math.floor);
  let remainder = unreported - allocated.reduce((sum, total) => sum + total, 0);
  const allocationOrder = shares
    .map((share, index) => ({ fraction: share - Math.floor(share), index }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index);
  for (const { index } of allocationOrder) {
    if (remainder === 0) {
      break;
    }
    allocated[index]! += 1;
    remainder -= 1;
  }

  return totals.map((total, index) => total + allocated[index]!);
}

export { parseRawUsageReports, PARSER_VERSION };

export type { CoveredUsageDay, ParseRawUsageOptions, PersistableDailyReport };
