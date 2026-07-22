import type { UsageDayInput } from "@tokenmaxxing/api-contract";

function normalizeCcusageModelName(source: string, model: string): string {
  const prefix = /^\[([^\]]+)\]/.exec(model);
  if (prefix?.[1]?.toLowerCase() !== source.toLowerCase()) {
    return model;
  }

  const normalized = model.slice(prefix[0].length).trimStart();
  return normalized.length === 0 ? model : normalized;
}

function normalizeUsageDays(days: readonly UsageDayInput[]): UsageDayInput[] {
  const merged = new Map<string, UsageDayInput>();

  for (const day of days) {
    const model = normalizeCcusageModelName(day.source, day.model);
    const key = JSON.stringify([day.date, day.source, model]);
    const existing = merged.get(key);
    if (existing === undefined) {
      merged.set(key, { ...day, model });
      continue;
    }

    merged.set(key, {
      ...existing,
      cacheCreationTokens: existing.cacheCreationTokens + day.cacheCreationTokens,
      cacheReadTokens: existing.cacheReadTokens + day.cacheReadTokens,
      costUsd: existing.costUsd + day.costUsd,
      inputTokens: existing.inputTokens + day.inputTokens,
      outputTokens: existing.outputTokens + day.outputTokens,
      totalTokens: existing.totalTokens + day.totalTokens,
    });
  }

  return [...merged.values()].sort(
    (left, right) =>
      left.date.localeCompare(right.date) ||
      left.source.localeCompare(right.source) ||
      left.model.localeCompare(right.model),
  );
}

export { normalizeCcusageModelName, normalizeUsageDays };
