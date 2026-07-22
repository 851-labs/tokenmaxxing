import { describe, expect, it } from "vitest";
import type { UsageDayInput } from "@tokenmaxxing/api-contract";

import { normalizeCcusageModelName, normalizeUsageDays } from "./models";

describe("normalizeCcusageModelName", () => {
  it.each([
    ["pi", "[pi] gpt-5.5", "gpt-5.5"],
    ["pi", "[PI]    gpt-5.5", "gpt-5.5"],
    ["openclaw", "[openclaw]deepseek-v4", "deepseek-v4"],
    ["pi", "gpt-5.5", "gpt-5.5"],
    ["pi", "[preview] gpt-5.5", "[preview] gpt-5.5"],
    ["pi", "[pi]   ", "[pi]   "],
  ])("normalizes %s model %s as %s", (source, model, expected) => {
    expect(normalizeCcusageModelName(source, model)).toBe(expected);
  });
});

describe("normalizeUsageDays", () => {
  it("merges canonical collisions after normalization", () => {
    const rows = [
      usageDay({
        cacheReadTokens: 10,
        costUsd: 2,
        inputTokens: 20,
        model: "[pi] gpt-5.5",
        outputTokens: 30,
        totalTokens: 60,
      }),
      usageDay({
        cacheCreationTokens: 5,
        costUsd: 3,
        inputTokens: 40,
        model: "gpt-5.5",
        outputTokens: 50,
        totalTokens: 95,
      }),
    ];

    expect(normalizeUsageDays(rows)).toEqual([
      usageDay({
        cacheCreationTokens: 5,
        cacheReadTokens: 10,
        costUsd: 5,
        inputTokens: 60,
        model: "gpt-5.5",
        outputTokens: 80,
        totalTokens: 155,
      }),
    ]);
  });

  it("keeps identical model names separate across sources", () => {
    const rows = [
      usageDay({ model: "[pi] gpt-5.5" }),
      usageDay({ model: "[openclaw] gpt-5.5", source: "openclaw" }),
    ];

    expect(normalizeUsageDays(rows)).toHaveLength(2);
  });
});

function usageDay(overrides: Partial<UsageDayInput> = {}): UsageDayInput {
  return {
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    costUsd: 0,
    date: "2026-07-09",
    inputTokens: 0,
    model: "gpt-5.5",
    outputTokens: 0,
    source: "pi",
    totalTokens: 0,
    ...overrides,
  };
}
