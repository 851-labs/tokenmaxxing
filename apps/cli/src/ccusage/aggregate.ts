import type { UsageDayInput } from "@tokenmaxxing/api-contract";

import type { CcusageDay } from "./schema";

/**
 * Pure transform from ccusage daily reports to the sync payload: one row
 * per (date, model), tagged with the source. Handles the three per-source
 * dialects (see schema.ts):
 *
 *   - modelBreakdowns array (claude): per-model rows; missing per-model
 *     costs are filled by distributing the day cost over token weight.
 *   - models record (codex): per-model token rows, day cost distributed
 *     over token weight.
 *   - agent summaries (including Hermes): per-model rows plus a day-level
 *     total that may include reasoning tokens omitted from the breakdown.
 *   - neither (opencode): one row from the day totals — attributed to the
 *     single entry of modelsUsed when unambiguous, else "unknown".
 *
 * Duplicate (date, model) pairs sum.
 */

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

    interface ModelTotals {
      cacheCreationTokens: number;
      cacheReadTokens: number;
      cost: number | undefined;
      inputTokens: number;
      model: string;
      outputTokens: number;
      totalTokens: number | undefined;
    }

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

    // Entries without their own cost split the day's remainder by token
    // weight (exact for single-model days, the overwhelming case).
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

interface SourceSummary {
  days: number;
  models: number;
  rows: number;
  spendUsd: number;
}

function summarize(rows: readonly UsageDayInput[]): SourceSummary {
  const days = new Set<string>();
  const models = new Set<string>();
  let spendUsd = 0;
  for (const row of rows) {
    days.add(row.date);
    models.add(row.model);
    spendUsd += row.costUsd;
  }

  return {
    days: days.size,
    models: models.size,
    rows: rows.length,
    spendUsd,
  };
}

export { aggregateDays, summarize };

export type { SourceSummary };
