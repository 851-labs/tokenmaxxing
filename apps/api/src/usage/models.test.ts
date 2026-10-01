import { describe, expect, it } from "vite-plus/test";
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
    [
      "pi",
      "[pi] /home/alice/models/gemma-4-12B-it-qat-UD-Q4_K_XL.gguf",
      "gemma-4-12B-it-qat-UD-Q4_K_XL.gguf",
    ],
    ["hermes", "/Users/alice/maple-mlx/maple-2bit-mlx", "maple-2bit-mlx"],
    ["omp", "[pi] claude-sonnet-4-6", "claude-sonnet-4-6"],
    ["omp", "[omp] gpt-5.5", "gpt-5.5"],
    ["omp", "[openclaw] gpt-5.5", "[openclaw] gpt-5.5"],
    ["pi", "[omp] gpt-5.5", "[omp] gpt-5.5"],
    ["constructor", "[constructor] gpt-5.5", "gpt-5.5"],
    ["omp", "[pi] /home/alice/models/qwen3-coder-30b-Q4_K_M.gguf", "qwen3-coder-30b-Q4_K_M.gguf"],
    ["omp", "[pi] ~/models/qwen3-coder-30b-Q4_K_M.gguf", "qwen3-coder-30b-Q4_K_M.gguf"],
    ["omp", "[omp] C:\\Users\\alice\\models\\phi-5.gguf", "phi-5.gguf"],
    ["omp", "[pi] openai/gpt-5.5", "openai/gpt-5.5"],
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

  it("merges paths that strip to the same model name", () => {
    const rows = [
      usageDay({ costUsd: 1, model: "/home/alice/Downloads/gemma.gguf", totalTokens: 10 }),
      usageDay({ costUsd: 2, model: "/home/alice/models/gemma.gguf", totalTokens: 20 }),
    ];

    expect(normalizeUsageDays(rows)).toEqual([
      usageDay({ costUsd: 3, model: "gemma.gguf", totalTokens: 30 }),
    ]);
  });

  it("keeps identical model names separate across sources", () => {
    const rows = [
      usageDay({ model: "[pi] gpt-5.5" }),
      usageDay({ model: "[hermes] gpt-5.5", source: "hermes" }),
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
