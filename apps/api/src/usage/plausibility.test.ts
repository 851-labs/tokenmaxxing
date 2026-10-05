import type { UsageDayInput } from "@tokenmaxxing/api-contract";
import { sql } from "drizzle-orm";
import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { Drizzle } from "../database";
import { buildService } from "../testing/effect";
import { makeTestDatabase } from "../testing/sqlite-d1";
import {
  implausibleUsageReason,
  MAX_COST_USD_PER_ROW,
  MAX_TOKENS_PER_ROW,
  maxCostUsd,
  maxCostUsdSql,
} from "./plausibility";

const row: UsageDayInput = {
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
  costUsd: 1,
  date: "2026-10-03",
  inputTokens: 1_000,
  model: "gpt-5.5",
  outputTokens: 1_000,
  source: "codex",
  totalTokens: 2_000,
};

describe("implausibleUsageReason", () => {
  it("accepts the heaviest legitimate prod rows", () => {
    // gillkyle, 2026-07-20: 110.7B tokens, mostly cache reads.
    const heaviestTokens = {
      ...row,
      cacheReadTokens: 108_837_765_888,
      costUsd: 18_175.5,
      inputTokens: 1_762_035_793,
      outputTokens: 145_007_160,
      totalTokens: 110_744_808_841,
    };
    // The priciest row: $131k on 66.6B gpt-5.5 tokens.
    const priciest = {
      ...row,
      cacheReadTokens: 63_923_203_840,
      costUsd: 131_053.43,
      inputTokens: 2_448_585_715,
      outputTokens: 273_894_654,
      totalTokens: 66_645_684_209,
    };
    // A source that reports cost without tokens.
    const costOnly = { ...row, costUsd: 86.5, inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    // claude-opus-4-7-fast: the highest legitimate $/token ($60/M).
    const fast = { ...row, costUsd: 53.34, inputTokens: 886_313, outputTokens: 0, totalTokens: 0 };

    for (const day of [row, heaviestTokens, priciest, costOnly, fast]) {
      expect(implausibleUsageReason(day)).toBeNull();
    }
  });

  it("rejects the fabricated 2026-10-05 uploads", () => {
    expect(implausibleUsageReason({ ...row, costUsd: 2.7397e296 })).toBe("cost");
    expect(
      implausibleUsageReason({
        ...row,
        inputTokens: 8_590_000_000_000_000,
        totalTokens: 8_590_000_000_000_000,
      }),
    ).toBe("tokens");
  });

  it("bounds every token field", () => {
    for (const field of [
      "cacheCreationTokens",
      "cacheReadTokens",
      "inputTokens",
      "outputTokens",
      "totalTokens",
    ] as const) {
      expect(implausibleUsageReason({ ...row, [field]: MAX_TOKENS_PER_ROW })).toBeNull();
      expect(implausibleUsageReason({ ...row, [field]: MAX_TOKENS_PER_ROW + 1 })).toBe("tokens");
      expect(implausibleUsageReason({ ...row, [field]: -1 })).toBe("tokens");
      expect(implausibleUsageReason({ ...row, [field]: 1.5 })).toBe("tokens");
      expect(implausibleUsageReason({ ...row, [field]: Number.MAX_SAFE_INTEGER + 2 })).toBe(
        "tokens",
      );
    }
  });

  it("caps cost by tokens, a per-row allowance and an absolute ceiling", () => {
    expect(maxCostUsd({ ...row, inputTokens: 0, outputTokens: 0, totalTokens: 0 })).toBe(250);
    // $2,000 per million tokens, plus the allowance.
    expect(maxCostUsd({ ...row, inputTokens: 1_000_000, outputTokens: 0, totalTokens: 0 })).toBe(
      2_250,
    );
    // totalTokens above the component sum counts (unreported reasoning tokens).
    expect(maxCostUsd({ ...row, totalTokens: 1_000_000 })).toBe(2_250);
    expect(maxCostUsd({ ...row, totalTokens: MAX_TOKENS_PER_ROW })).toBe(MAX_COST_USD_PER_ROW);

    // 2,000 tokens allow $254.
    expect(implausibleUsageReason({ ...row, costUsd: 254 })).toBeNull();
    expect(implausibleUsageReason({ ...row, costUsd: 254.01 })).toBe("cost");
    expect(implausibleUsageReason({ ...row, costUsd: 255, totalTokens: 2_000_000 })).toBeNull();
    expect(implausibleUsageReason({ ...row, costUsd: -0.01 })).toBe("cost");
    expect(implausibleUsageReason({ ...row, costUsd: Number.NaN })).toBe("cost");
    expect(implausibleUsageReason({ ...row, costUsd: Number.POSITIVE_INFINITY })).toBe("cost");
  });
});

describe("maxCostUsdSql", () => {
  it("computes the same ceiling as maxCostUsd", async () => {
    const database = makeTestDatabase();
    const drizzle = await buildService(Drizzle, database.drizzleLayer);
    const cases = [
      { ...row, inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      { ...row, totalTokens: 1_000_000 },
      { ...row, cacheReadTokens: 66_000_000_000, totalTokens: 1 },
      { ...row, totalTokens: MAX_TOKENS_PER_ROW },
    ];

    for (const day of cases) {
      const [result] = await Effect.runPromise(
        drizzle.use((db) =>
          db.all<{ ceiling: number }>(
            sql`select ${maxCostUsdSql({
              cacheCreationTokens: sql`${day.cacheCreationTokens}`,
              cacheReadTokens: sql`${day.cacheReadTokens}`,
              inputTokens: sql`${day.inputTokens}`,
              outputTokens: sql`${day.outputTokens}`,
              totalTokens: sql`${day.totalTokens}`,
            })} as ceiling`,
          ),
        ),
      );

      expect(result).toEqual({ ceiling: maxCostUsd(day) });
    }
    database.close();
  });
});
