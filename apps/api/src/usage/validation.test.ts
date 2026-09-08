import { describe, expect, it } from "vitest";
import { Effect } from "effect";

import { InvalidUsage } from "@tokenmaxxing/api-contract";
import type { UsageDayInput } from "@tokenmaxxing/api-contract";

import { MAX_MODEL_NAME_LENGTH, sanitizeUsageDays } from "./validation";

describe("sanitizeUsageDays", () => {
  it("passes through plausible rows and trims model/source whitespace", async () => {
    const result = await Effect.runPromise(
      sanitizeUsageDays([usageDay({ model: "  gpt-5.5  ", source: " codex " })]),
    );

    expect(result).toEqual([usageDay({ model: "gpt-5.5", source: "codex" })]);
  });

  it("rejects a fabricated token total above the daily ceiling", async () => {
    await expect(
      Effect.runPromise(
        sanitizeUsageDays([
          usageDay({
            model: "totally fake model",
            totalTokens: 69_000_000_000_000,
            inputTokens: 46_000_000_000_000,
            outputTokens: 23_000_000_000_000,
            costUsd: 420_000_000,
          }),
        ]),
      ),
    ).rejects.toBeInstanceOf(InvalidUsage);
  });

  it("rejects a fabricated cost above the daily ceiling", async () => {
    await expect(
      Effect.runPromise(sanitizeUsageDays([usageDay({ costUsd: 420_000_000 })])),
    ).rejects.toBeInstanceOf(InvalidUsage);
  });

  it("rejects negative and non-finite token counts", async () => {
    await expect(
      Effect.runPromise(sanitizeUsageDays([usageDay({ totalTokens: -1 })])),
    ).rejects.toBeInstanceOf(InvalidUsage);

    await expect(
      Effect.runPromise(sanitizeUsageDays([usageDay({ inputTokens: Number.NaN })])),
    ).rejects.toBeInstanceOf(InvalidUsage);
  });

  it("rejects empty, oversized, and control-character model names", async () => {
    await expect(
      Effect.runPromise(sanitizeUsageDays([usageDay({ model: "   " })])),
    ).rejects.toBeInstanceOf(InvalidUsage);

    await expect(
      Effect.runPromise(
        sanitizeUsageDays([usageDay({ model: "a".repeat(MAX_MODEL_NAME_LENGTH + 1) })]),
      ),
    ).rejects.toBeInstanceOf(InvalidUsage);

    await expect(
      Effect.runPromise(sanitizeUsageDays([usageDay({ model: "bad\u0007name" })])),
    ).rejects.toBeInstanceOf(InvalidUsage);
  });

  it("rejects malformed dates", async () => {
    await expect(
      Effect.runPromise(sanitizeUsageDays([usageDay({ date: "not-a-date" })])),
    ).rejects.toBeInstanceOf(InvalidUsage);
  });

  it("accepts a realistic heavy usage day", async () => {
    const result = await Effect.runPromise(
      sanitizeUsageDays([
        usageDay({
          costUsd: 42.5,
          inputTokens: 10_000_000,
          model: "claude-opus-4",
          outputTokens: 2_000_000,
          source: "claude",
          totalTokens: 12_000_000,
        }),
      ]),
    );

    expect(result).toHaveLength(1);
  });
});

function usageDay(overrides: Partial<UsageDayInput> = {}): UsageDayInput {
  return {
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    costUsd: 0,
    date: "2026-09-08",
    inputTokens: 0,
    model: "gpt-5.5",
    outputTokens: 0,
    source: "codex",
    totalTokens: 0,
    ...overrides,
  };
}
