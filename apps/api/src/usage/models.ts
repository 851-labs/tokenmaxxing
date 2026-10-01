import { stripModelPath, type UsageDayInput } from "@tokenmaxxing/api-contract";

/**
 * ccusage labels a source's models `[label] model` by its own adapter name.
 * Oh My Pi is read through the `pi` adapter, so its models arrive as `[pi] …`
 * (and a ccusage named Pi store would label them `[omp] …`).
 */
const CCUSAGE_MODEL_LABELS = new Map<string, readonly string[]>([["omp", ["omp", "pi"]]]);

/**
 * Strips the agent's own `[source]` label, then any local filesystem path: the
 * label first, since a path behind it does not start like one.
 */
function normalizeCcusageModelName(source: string, model: string): string {
  return stripModelPath(stripSourcePrefix(source, model));
}

function stripSourcePrefix(source: string, model: string): string {
  const prefix = /^\[([^\]]+)\]/.exec(model);
  const sourceKey = source.toLowerCase();
  const labels = CCUSAGE_MODEL_LABELS.get(sourceKey) ?? [sourceKey];
  if (prefix?.[1] === undefined || !labels.includes(prefix[1].toLowerCase())) {
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
