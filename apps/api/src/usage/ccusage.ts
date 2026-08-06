import type {
  RawUsageReportInput,
  SourceUsageStatsInput,
  UsageDayInput,
} from "@tokenmaxxing/api-contract";
import { Effect, Option, Schema } from "effect";

const PARSER_VERSION = "ccusage-v20-raw-4";

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
  coveredDays: CoveredUsageDay[];
  persistableReports: PersistableDailyReport[];
  rows: UsageDayInput[];
  sourceStats: SourceUsageStatsInput[];
}

interface CoveredUsageDay {
  date: string;
  source: string;
}

type PersistableDailyReport = Omit<RawUsageReportInput, "reportKind"> & {
  reportKind: "daily";
};

function parseRawUsageReports(
  reports: readonly RawUsageReportInput[],
): Effect.Effect<ParsedRawUsageReports> {
  return Effect.gen(function* () {
    const coveredDays = new Map<string, CoveredUsageDay>();
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
          for (const day of decoded.value.daily) {
            coveredDays.set(JSON.stringify([report.source, day.date]), {
              date: day.date,
              source: report.source,
            });
          }
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

    return { coveredDays: [...coveredDays.values()], persistableReports, rows, sourceStats };
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
    const totalTokens = modelTotalTokens(day.totalTokens, entries, tokensOf);
    const knownCost = entries.reduce((sum, entry) => sum + (entry.cost ?? 0), 0);
    const unpriced = entries.filter((entry) => entry.cost === undefined);
    const unpricedWeight = unpriced.reduce((sum, entry) => sum + tokensOf(entry), 0);
    const remainder = Math.max(dayCost - knownCost, 0);

    for (const [index, entry] of entries.entries()) {
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

export type { CoveredUsageDay, PersistableDailyReport };
