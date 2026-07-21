import type {
  RawUsageReportInput,
  SourceUsageStatsInput,
  UsageDayInput,
} from "@tokenmaxxing/api-contract";
import { Effect, Option, Schema } from "effect";

const PARSER_VERSION = "ccusage-v20-raw-2";

const CcusageModelBreakdown = Schema.Struct({
  cacheCreationTokens: Schema.optional(Schema.Number),
  cacheReadTokens: Schema.optional(Schema.Number),
  cost: Schema.optional(Schema.Number),
  inputTokens: Schema.optional(Schema.Number),
  modelName: Schema.String,
  outputTokens: Schema.optional(Schema.Number),
  reasoningTokens: Schema.optional(Schema.Number),
  totalTokens: Schema.optional(Schema.Number),
});

type CcusageModelBreakdown = typeof CcusageModelBreakdown.Type;

const CcusageModelEntry = Schema.Struct({
  cacheCreationTokens: Schema.optional(Schema.Number),
  cacheReadTokens: Schema.optional(Schema.Number),
  inputTokens: Schema.optional(Schema.Number),
  outputTokens: Schema.optional(Schema.Number),
  reasoningTokens: Schema.optional(Schema.Number),
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

const CcusageSessionReport = Schema.Struct({
  sessions: Schema.Array(Schema.Unknown),
});

const decodeDailyReport = Schema.decodeUnknownEffect(CcusageDailyReport);
const decodeSessionReport = Schema.decodeUnknownEffect(CcusageSessionReport);

interface ParsedRawUsageReports {
  rows: UsageDayInput[];
  sourceStats: SourceUsageStatsInput[];
}

function parseRawUsageReports(
  reports: readonly RawUsageReportInput[],
): Effect.Effect<ParsedRawUsageReports> {
  return Effect.gen(function* () {
    const rows: UsageDayInput[] = [];
    const sourceStats: SourceUsageStatsInput[] = [];

    for (const report of reports) {
      if (report.reportKind === "daily") {
        const decoded = yield* decodeDailyReport(report.payload).pipe(Effect.option);
        if (Option.isSome(decoded)) {
          rows.push(...aggregateDays(report.source, decoded.value.daily));
        }
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

    return { rows, sourceStats };
  });
}

function aggregateDays(source: string, days: readonly CcusageDay[]): UsageDayInput[] {
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
      cacheCreationTokens: addTokens(existing.cacheCreationTokens, row.cacheCreationTokens),
      cacheReadTokens: addTokens(existing.cacheReadTokens, row.cacheReadTokens),
      costUsd: existing.costUsd + row.costUsd,
      inputTokens: addTokens(existing.inputTokens, row.inputTokens),
      outputTokens: addTokens(existing.outputTokens, row.outputTokens),
      totalTokens: addTokens(existing.totalTokens, row.totalTokens),
    });
  };

  for (const day of days) {
    const dayCost = day.totalCost ?? day.costUSD ?? 0;
    const entries = collectModelEntries(day);

    if (entries.length === 0) {
      const inputTokens = tokenCount(day.inputTokens);
      const outputTokens = tokenCount(day.outputTokens);
      const cacheCreationTokens = tokenCount(day.cacheCreationTokens);
      const cacheReadTokens = tokenCount(day.cacheReadTokens);
      const componentTokens = addTokens(
        inputTokens,
        outputTokens,
        cacheCreationTokens,
        cacheReadTokens,
      );
      add({
        cacheCreationTokens,
        cacheReadTokens,
        costUsd: dayCost,
        date: day.date,
        inputTokens,
        model: day.modelsUsed?.length === 1 ? day.modelsUsed[0]! : "unknown",
        outputTokens,
        source,
        totalTokens: Math.max(tokenCount(day.totalTokens), componentTokens),
      });
      continue;
    }

    distributeDayTotal(entries, day.totalTokens);

    const tokensOf = (entry: ModelTotals) => entry.totalTokens;
    const knownCost = entries.reduce((sum, entry) => sum + (entry.cost ?? 0), 0);
    const unpriced = entries.filter((entry) => entry.cost === undefined);
    const unpricedWeight = unpriced.reduce((sum, entry) => sum + tokensOf(entry), 0);
    const remainder = Math.max(dayCost - knownCost, 0);

    for (const entry of entries) {
      const cost =
        entry.cost ??
        (unpricedWeight > 0
          ? (remainder * tokensOf(entry)) / unpricedWeight
          : remainder / unpriced.length);
      add({
        cacheCreationTokens: entry.cacheCreationTokens,
        cacheReadTokens: entry.cacheReadTokens,
        costUsd: cost,
        date: day.date,
        inputTokens: entry.inputTokens,
        model: entry.model,
        outputTokens: entry.outputTokens,
        source,
        totalTokens: entry.totalTokens,
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
  totalTokens: number;
}

function collectModelEntries(day: CcusageDay): ModelTotals[] {
  const entries: ModelTotals[] = [];
  if (day.modelBreakdowns !== undefined && day.modelBreakdowns.length > 0) {
    for (const breakdown of day.modelBreakdowns) {
      const inputTokens = tokenCount(breakdown.inputTokens);
      const outputTokens = tokenCount(breakdown.outputTokens);
      const cacheCreationTokens = tokenCount(breakdown.cacheCreationTokens);
      const cacheReadTokens = tokenCount(breakdown.cacheReadTokens);
      const componentTokens = addTokens(
        inputTokens,
        outputTokens,
        cacheCreationTokens,
        cacheReadTokens,
        tokenCount(breakdown.reasoningTokens),
      );
      entries.push({
        cacheCreationTokens,
        cacheReadTokens,
        cost: breakdown.cost,
        inputTokens,
        model: breakdown.modelName,
        outputTokens,
        totalTokens: Math.max(tokenCount(breakdown.totalTokens), componentTokens),
      });
    }
  } else if (day.models !== undefined && Object.keys(day.models).length > 0) {
    for (const [model, entry] of Object.entries(day.models)) {
      const inputTokens = tokenCount(entry.inputTokens);
      const outputTokens = tokenCount(entry.outputTokens);
      const cacheCreationTokens = tokenCount(entry.cacheCreationTokens);
      const cacheReadTokens = tokenCount(entry.cacheReadTokens);
      const componentTokens = addTokens(
        inputTokens,
        outputTokens,
        cacheCreationTokens,
        cacheReadTokens,
        tokenCount(entry.reasoningTokens),
      );
      entries.push({
        cacheCreationTokens,
        cacheReadTokens,
        cost: undefined,
        inputTokens,
        model,
        outputTokens,
        totalTokens: Math.max(tokenCount(entry.totalTokens), componentTokens),
      });
    }
  }

  return entries;
}

function distributeDayTotal(entries: ModelTotals[], dayTotal: number | undefined): void {
  const resolvedDayTotal = tokenCount(dayTotal);
  const knownTotal = entries.reduce((sum, entry) => addTokens(sum, entry.totalTokens), 0);
  const extra = Math.max(resolvedDayTotal - knownTotal, 0);
  let remainder = extra;
  if (remainder === 0) {
    return;
  }

  for (const [index, entry] of entries.entries()) {
    const isLast = index === entries.length - 1;
    const share = isLast
      ? remainder
      : Math.min(
          remainder,
          knownTotal > 0
            ? Math.floor(extra * (entry.totalTokens / knownTotal))
            : Math.floor(extra / entries.length),
        );
    entry.totalTokens = addTokens(entry.totalTokens, share);
    remainder -= share;
  }
}

function tokenCount(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return 0;
  }

  return Math.min(Math.trunc(value), Number.MAX_SAFE_INTEGER);
}

function addTokens(...values: readonly number[]): number {
  let total = 0;
  for (const value of values) {
    const normalized = tokenCount(value);
    if (normalized >= Number.MAX_SAFE_INTEGER - total) {
      return Number.MAX_SAFE_INTEGER;
    }
    total += normalized;
  }

  return total;
}

export { parseRawUsageReports, PARSER_VERSION };
