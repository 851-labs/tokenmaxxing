import { Effect } from "effect";

import { InvalidUsage } from "@tokenmaxxing/api-contract";
import type { UsageDayInput } from "@tokenmaxxing/api-contract";

/**
 * Server-side sanity ceilings for a single `(date, source, model)` usage row.
 * The CLI computes and uploads these aggregates locally; the server previously
 * stored them verbatim, so a client could forge arbitrary spend/tokens. These
 * bounds reject obviously fabricated rows while leaving generous headroom for
 * legitimate (even heavy) coding-agent usage.
 */
const MAX_USAGE_DAY_TOKENS = 1_000_000_000;
const MAX_USAGE_DAY_COST_USD = 100_000;
const MAX_MODEL_NAME_LENGTH = 200;
const MAX_SOURCE_LENGTH = 64;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function sanitizeUsageDays(
  days: readonly UsageDayInput[],
): Effect.Effect<UsageDayInput[], InvalidUsage> {
  return Effect.gen(function* () {
    const sanitized: UsageDayInput[] = [];

    for (let index = 0; index < days.length; index += 1) {
      const day = days[index]!;
      const model = day.model.trim();
      const source = day.source.trim();

      if (model.length === 0) {
        yield* reject(index, "model name is empty");
      }
      if (model.length > MAX_MODEL_NAME_LENGTH) {
        yield* reject(index, `model name exceeds ${MAX_MODEL_NAME_LENGTH} characters`);
      }
      if (hasControlCharacters(model)) {
        yield* reject(index, "model name contains control characters");
      }
      if (
        source.length === 0 ||
        source.length > MAX_SOURCE_LENGTH ||
        hasControlCharacters(source)
      ) {
        yield* reject(index, "source is empty, oversized, or contains control characters");
      }
      if (!DATE_PATTERN.test(day.date)) {
        yield* reject(index, `date must be YYYY-MM-DD, got ${JSON.stringify(day.date)}`);
      }

      for (const [label, value] of tokenFields(day)) {
        if (!Number.isFinite(value) || value < 0) {
          yield* reject(index, `${label} must be finite and non-negative`);
        }
        if (value > MAX_USAGE_DAY_TOKENS) {
          yield* reject(index, `${label} ${value} exceeds daily ceiling ${MAX_USAGE_DAY_TOKENS}`);
        }
      }

      if (!Number.isFinite(day.costUsd) || day.costUsd < 0) {
        yield* reject(index, "costUsd must be finite and non-negative");
      }
      if (day.costUsd > MAX_USAGE_DAY_COST_USD) {
        yield* reject(
          index,
          `costUsd ${day.costUsd} exceeds daily ceiling ${MAX_USAGE_DAY_COST_USD}`,
        );
      }

      sanitized.push({ ...day, model, source });
    }

    return sanitized;
  });
}

function tokenFields(day: UsageDayInput): ReadonlyArray<[string, number]> {
  return [
    ["inputTokens", day.inputTokens],
    ["outputTokens", day.outputTokens],
    ["cacheCreationTokens", day.cacheCreationTokens],
    ["cacheReadTokens", day.cacheReadTokens],
    ["totalTokens", day.totalTokens],
  ];
}

function reject(index: number, reason: string): Effect.Effect<never, InvalidUsage> {
  return Effect.fail(new InvalidUsage({ message: `usage day ${index}: ${reason}` }));
}

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }

  return false;
}

export { MAX_MODEL_NAME_LENGTH, MAX_USAGE_DAY_COST_USD, MAX_USAGE_DAY_TOKENS, sanitizeUsageDays };
