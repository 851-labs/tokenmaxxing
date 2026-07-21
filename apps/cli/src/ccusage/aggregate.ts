import type { UsageDayInput } from "@tokenmaxxing/api-contract";

import type { CcusageDay } from "./schema";

interface ModelTotals {
  cacheCreationTokens: number;
  cacheReadTokens: number;
  cost: number | undefined;
  inputTokens: number;
  model: string;
  outputTokens: number;
  totalTokens: number;
}

/**
 * Pure transform from ccusage daily reports to the sync payload: one row
 * per (date, model), tagged with the source. Handles the three per-source
 * dialects (see schema.ts):
 *
 *   - modelBreakdowns array (claude): per-model rows; missing per-model
 *     costs are filled by distributing the day cost over token weight.
 *   - models record (codex): per-model token rows, day cost distributed
 *     over token weight.
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

    // Entries without their own cost split the day's remainder by token
    // weight (exact for single-model days, the overwhelming case).
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

interface SourceSummary {
  days: number;
  models: number;
  rows: number;
  spendUsd: number;
}

function distributeDayTotal(entries: ModelTotals[], dayTotal: number | undefined): void {
  const resolvedDayTotal = tokenCount(dayTotal);
  const knownTotal = entries.reduce((sum, entry) => addTokens(sum, entry.totalTokens), 0);
  let remainder = Math.max(resolvedDayTotal - knownTotal, 0);
  if (remainder === 0) {
    return;
  }

  const weight = knownTotal;
  for (const [index, entry] of entries.entries()) {
    const isLast = index === entries.length - 1;
    const share = isLast
      ? remainder
      : Math.min(
          remainder,
          weight > 0
            ? Math.floor((resolvedDayTotal - knownTotal) * (entry.totalTokens / weight))
            : Math.floor((resolvedDayTotal - knownTotal) / entries.length),
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
