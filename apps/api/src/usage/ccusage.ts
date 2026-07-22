import type {
  RawUsageReportInput,
  SourceUsageStatsInput,
  UsageDayInput,
} from "@tokenmaxxing/api-contract";
import { Effect, Option, Schema } from "effect";

const PARSER_VERSION = "ccusage-v20-raw-3";

const CcusageModelBreakdown = Schema.Struct({
  cacheCreationTokens: Schema.optional(Schema.Number),
  cacheReadTokens: Schema.optional(Schema.Number),
  cost: Schema.optional(Schema.Number),
  inputTokens: Schema.optional(Schema.Number),
  modelName: Schema.String,
  outputTokens: Schema.optional(Schema.Number),
});

type CcusageModelBreakdown = typeof CcusageModelBreakdown.Type;

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

const CcusageSessionReport = Schema.Struct({
  sessions: Schema.Array(Schema.Unknown),
});

const decodeDailyReport = Schema.decodeUnknownEffect(CcusageDailyReport);
const decodeSessionReport = Schema.decodeUnknownEffect(CcusageSessionReport);

interface ParsedRawUsageReports {
  persistableReports: PersistableDailyReport[];
  rows: UsageDayInput[];
  sourceStats: SourceUsageStatsInput[];
}

type PersistableDailyReport = Omit<RawUsageReportInput, "reportKind"> & {
  reportKind: "daily";
};

function parseRawUsageReports(
  reports: readonly RawUsageReportInput[],
): Effect.Effect<ParsedRawUsageReports> {
  return Effect.gen(function* () {
    const persistableReports: PersistableDailyReport[] = [];
    const rows: UsageDayInput[] = [];
    const sourceStats: SourceUsageStatsInput[] = [];

    for (const report of reports) {
      if (report.reportKind === "daily") {
        const decoded = yield* decodeDailyReport(report.payload).pipe(Effect.option);
        if (Option.isSome(decoded)) {
          persistableReports.push({
            command: report.command,
            payload: decoded.value,
            reportKind: "daily",
            source: report.source,
          });
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

    return { persistableReports, rows, sourceStats };
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
        totalTokens: tokensOf(entry),
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
      });
    }
  }

  return entries;
}

export { parseRawUsageReports, PARSER_VERSION };

export type { PersistableDailyReport };
