import type { UsageDayInput } from "@tokenmaxxing/api-contract";
import { sql } from "drizzle-orm";
import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { Drizzle } from "../database";
import { buildService } from "../testing/effect";
import { makeTestDatabase } from "../testing/sqlite-d1";
import {
  implausibleModelName,
  implausibleUsageReason,
  MAX_COST_USD_PER_ROW,
  MAX_TOKENS,
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
    // The most output (2.6B) and cache writes (675M) on one row.
    const heaviestOutput = {
      ...row,
      cacheCreationTokens: 643_000_000,
      costUsd: 1_099,
      inputTokens: 4_820_000_000,
      model: "claude-opus-5-5",
      outputTokens: 2_570_000_000,
      totalTokens: 8_030_000_000,
    };
    const heaviestCacheWrites = {
      ...row,
      cacheCreationTokens: 675_182_267,
      cacheReadTokens: 12_300_000_000,
      costUsd: 7_124,
      inputTokens: 150_000,
      model: "claude-opus-5-5",
      outputTokens: 64_700_000,
      totalTokens: 13_000_000_000,
    };
    // The most uncached input (8.3B).
    const heaviestInput = {
      ...row,
      cacheReadTokens: 1_200_000_000,
      costUsd: 94,
      inputTokens: 8_300_000_000,
      model: "gpt-5.6",
      outputTokens: 500_000_000,
      totalTokens: 10_000_000_000,
    };

    for (const day of [
      row,
      heaviestTokens,
      priciest,
      costOnly,
      fast,
      heaviestOutput,
      heaviestCacheWrites,
      heaviestInput,
    ]) {
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

  it("rejects the fabricated 2026-11 uploads", () => {
    // sadfrwsd: ~1,800 identical rows under made-up model names.
    const spam = {
      ...row,
      costUsd: 682_787.04,
      inputTokens: 40_258_642_912,
      model: "aarush-kamat-on-top",
      outputTokens: 120_453_951_683,
      totalTokens: 160_712_594_595,
    };
    expect(implausibleUsageReason(spam)).toBe("tokens");
    expect(implausibleUsageReason({ ...spam, model: "<script>alert('hi')</script>" })).toBe(
      "model",
    );
    // Within every token cap, but $648k on 1.8B tokens.
    expect(
      implausibleUsageReason({
        ...row,
        costUsd: 648_876.38,
        inputTokens: 892_000_000,
        model: "claude-vesper-6",
        outputTokens: 903_000_000,
        totalTokens: 1_795_368_572,
      }),
    ).toBe("cost");
  });

  it("bounds every token field", () => {
    expect(MAX_TOKENS).toEqual({
      cacheCreationTokens: 10_000_000_000,
      cacheReadTokens: MAX_TOKENS_PER_ROW,
      inputTokens: 25_000_000_000,
      outputTokens: 10_000_000_000,
      totalTokens: MAX_TOKENS_PER_ROW,
    });
    for (const [field, max] of Object.entries(MAX_TOKENS)) {
      expect(implausibleUsageReason({ ...row, [field]: max })).toBeNull();
      expect(implausibleUsageReason({ ...row, [field]: max + 1 })).toBe("tokens");
      expect(implausibleUsageReason({ ...row, [field]: -1 })).toBe("tokens");
      expect(implausibleUsageReason({ ...row, [field]: 1.5 })).toBe("tokens");
      expect(implausibleUsageReason({ ...row, [field]: Number.MAX_SAFE_INTEGER + 2 })).toBe(
        "tokens",
      );
    }
  });

  it("judges the model name before the counts", () => {
    expect(implausibleUsageReason({ ...row, costUsd: 1e300, model: "{" })).toBe("model");
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

describe("implausibleModelName", () => {
  it("accepts real model names, however messy", () => {
    for (const model of [
      "claude-opus-4-6",
      "claude-sonnet-4-5-20250929",
      "anthropic/claude-opus-4.7",
      "amanai/claude-opus-5.5",
      "gemini-claude-opus-4-5-thinking-high",
      "claude-opus-7-SELENIUM",
      "claude-opus-4-8-xhigh",
      "gpt-6.1-sol",
      "glm-5.3-flash",
      "ri.language-model-service..language-model.anthropic-claude-5-opus",
      "opus",
      "haiku",
      "o3",
      "k3",
      "unknown",
      "<synthetic>",
      "claude-opus-5-5[1m]",
      "kimi/k3[1m]",
      "~anthropic/claude-opus-latest",
      "@cf/zai-org/glm-5.3",
      "stepfun/step-3.7-flash:free",
      "[pi] gpt-5.6-terra@272k",
      "deepseek-v4-1-flash-(baseten)-0",
      "Grok 4.6 (Auto Balanced)",
      "GPT 5 High (ChatGPT Subscription)",
      "CLI Proxy (eli.gift)/gpt-6-astra",
      "MiniMaxAI/MiniMax-M3",
    ]) {
      expect(implausibleModelName(model), model).toBe(false);
    }
  });

  it("rejects names that cannot be model ids", () => {
    for (const model of [
      // Uploaded by sadfrwsd, 2026-11.
      "<script>alert('hi')</script>",
      "{",
      "]",
      ",",
      ">",
      "~",
      "`",
      "-",
      "6",
      "r",
      "https://abstracteducation.loan/-owns-you",
      "-https://abstracteducation.loan/ on top long live aarush kamat",
      // No letter, or nothing at all.
      "",
      "   ",
      "4.5",
      // Markup and quotes.
      "<b>opus</b>",
      'gpt-"5"',
      '{"model":"gpt-5"}',
      // Control, invisible and look-alike characters.
      "gpt-5\n",
      "gpt-5\u0000",
      "gpt\u200b-5",
      "cl\u0430ude-opus-4-6",
      "\u202egpt-5",
      // URLs.
      "http://example.com/gpt-5",
      "proxy+https://example.com",
      // Only Claude Code's own marker may use angle brackets.
      "<Synthetic>",
      "<synthetic>x",
    ]) {
      expect(implausibleModelName(model), JSON.stringify(model)).toBe(true);
    }
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
