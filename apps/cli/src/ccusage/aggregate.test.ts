import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { aggregateDays, summarize } from "./aggregate";
import { decodeDailyReport, decodeSessionReport } from "./schema";

/** Mirrors the verified `ccusage claude daily --json --breakdown` v20 shape. */
const claudeFixture = {
  daily: [
    {
      date: "2026-06-10",
      inputTokens: 355_038,
      outputTokens: 1_438_433,
      cacheCreationTokens: 6_058_989,
      cacheReadTokens: 652_827_808,
      totalTokens: 660_680_268,
      totalCost: 851.14,
      modelsUsed: ["claude-fable-5", "claude-haiku-4-5-20251001"],
      modelBreakdowns: [
        {
          modelName: "claude-fable-5",
          inputTokens: 355_038,
          outputTokens: 1_438_433,
          cacheCreationTokens: 6_058_989,
          cacheReadTokens: 652_827_808,
          cost: 841.29,
        },
        {
          modelName: "claude-haiku-4-5-20251001",
          inputTokens: 6_637,
          outputTokens: 327_616,
          cacheCreationTokens: 2_865_086,
          cacheReadTokens: 46_241_604,
          cost: 9.85,
        },
      ],
    },
    {
      date: "2026-06-11",
      inputTokens: 1_000,
      outputTokens: 2_000,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      totalTokens: 3_000,
      totalCost: 1.25,
      modelBreakdowns: [
        {
          modelName: "claude-fable-5",
          inputTokens: 1_000,
          outputTokens: 2_000,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          cost: 1.25,
        },
      ],
    },
  ],
  totals: {
    inputTokens: 356_038,
    totalCost: 852.39,
  },
};

/** Sources without breakdowns or with sparse fields must still aggregate. */
const sparseFixture = {
  daily: [
    {
      date: "2026-06-09",
      totalTokens: 5_000,
      totalCost: 0.5,
    },
    {
      date: "2026-06-09",
      inputTokens: 100,
      modelBreakdowns: [{ modelName: "gpt-5.5", inputTokens: 100, outputTokens: 50 }],
    },
  ],
};

/** codex calculate-mode dialect: costUSD + models record, no per-model cost. */
const codexFixture = {
  daily: [
    {
      date: "2026-05-06",
      inputTokens: 28_136_328,
      outputTokens: 643_983,
      cacheCreationTokens: 0,
      cacheReadTokens: 336_649_216,
      totalTokens: 365_429_527,
      costUSD: 820.81,
      models: {
        "gpt-5.5": {
          inputTokens: 28_136_328,
          outputTokens: 643_983,
          cacheCreationTokens: 0,
          cacheReadTokens: 336_649_216,
          totalTokens: 365_429_527,
          isFallback: false,
        },
      },
    },
  ],
};

/** opencode calculate-mode dialect: day totals + modelsUsed only. */
const opencodeFixture = {
  daily: [
    {
      date: "2026-02-20",
      inputTokens: 15_930_898,
      outputTokens: 670_900,
      cacheCreationTokens: 0,
      cacheReadTokens: 180_602_880,
      totalTokens: 197_204_678,
      totalCost: 68.88,
      modelsUsed: ["gpt-5.3-codex"],
    },
    {
      date: "2026-02-21",
      totalTokens: 1_000,
      totalCost: 1.0,
      modelsUsed: ["gpt-5.3-codex", "opus-4-5"],
    },
  ],
};

/** Mirrors the ccusage v20 Pi agent-summary daily shape. */
const piFixture = {
  daily: [
    {
      date: "2026-07-01",
      inputTokens: 1_200,
      outputTokens: 300,
      cacheCreationTokens: 100,
      cacheReadTokens: 2_400,
      totalTokens: 4_000,
      totalCost: 0.42,
      modelsUsed: ["[pi] claude-sonnet-4"],
      modelBreakdowns: [
        {
          modelName: "[pi] claude-sonnet-4",
          inputTokens: 1_200,
          outputTokens: 300,
          cacheCreationTokens: 100,
          cacheReadTokens: 2_400,
          cost: 0.42,
        },
      ],
    },
  ],
};

describe("decodeDailyReport", () => {
  it("parses the verified v20 focused-command shape", async () => {
    const report = await Effect.runPromise(decodeDailyReport(claudeFixture));
    expect(report.daily).toHaveLength(2);
    expect(report.daily[0]?.modelBreakdowns).toHaveLength(2);
  });

  it("tolerates sparse fields and unknown keys", async () => {
    const report = await Effect.runPromise(decodeDailyReport(sparseFixture));
    expect(report.daily).toHaveLength(2);
    expect(report.daily[0]?.modelBreakdowns).toBeUndefined();
  });

  it("rejects output with no daily array", async () => {
    const exit = await Effect.runPromiseExit(decodeDailyReport({ data: [] }));
    expect(exit._tag).toBe("Failure");
  });
});

describe("decodeSessionReport", () => {
  it("parses a session report without caring about session contents", async () => {
    const report = await Effect.runPromise(
      decodeSessionReport({
        sessions: [
          {
            projectPath: "-Users-alexandru-repos-tokenmaxxing",
            sessionId: "526bf0dc-1b30-4d8a-983c-ce90ed476fe8",
          },
          {
            sessionFile: "rollout-2026-02-09T12-05-23",
          },
        ],
      }),
    );

    expect(report.sessions).toHaveLength(2);
  });

  it("rejects output with no sessions array", async () => {
    const exit = await Effect.runPromiseExit(decodeSessionReport({ daily: [] }));
    expect(exit._tag).toBe("Failure");
  });
});

describe("aggregateDays", () => {
  it("explodes breakdowns into one row per (date, model) tagged with the source", async () => {
    const report = await Effect.runPromise(decodeDailyReport(claudeFixture));
    const rows = aggregateDays("claude", report.daily);

    expect(rows).toHaveLength(3);
    const fable = rows.find((row) => row.date === "2026-06-10" && row.model === "claude-fable-5");
    expect(fable).toMatchObject({
      cacheReadTokens: 652_827_808,
      costUsd: 841.29,
      source: "claude",
      // Per-model totalTokens is reconstructed from the four counters.
      totalTokens: 355_038 + 1_438_433 + 6_058_989 + 652_827_808,
    });
  });

  it("falls back to an unknown-model row when a day has no breakdowns, then merges duplicates", async () => {
    const report = await Effect.runPromise(decodeDailyReport(sparseFixture));
    const rows = aggregateDays("codex", report.daily);

    expect(rows.map((row) => row.model).sort()).toEqual(["gpt-5.5", "unknown"]);
    const unknown = rows.find((row) => row.model === "unknown");
    expect(unknown).toMatchObject({ costUsd: 0.5, date: "2026-06-09", totalTokens: 5_000 });
  });

  it("explodes the codex models record and attributes the day cost", async () => {
    const report = await Effect.runPromise(decodeDailyReport(codexFixture));
    const rows = aggregateDays("codex", report.daily);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      costUsd: 820.81,
      date: "2026-05-06",
      model: "gpt-5.5",
      source: "codex",
      totalTokens: 365_429_527,
    });
  });

  it("preserves GPT-5.6 tier model names and calculated cost", () => {
    const rows = aggregateDays("codex", [
      {
        costUSD: 58.78,
        date: "2026-07-11",
        models: {
          "gpt-5.6-sol": {
            cacheReadTokens: 23_162_112,
            inputTokens: 1_799_323,
            outputTokens: 79_159,
            totalTokens: 25_040_594,
          },
        },
      },
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      cacheReadTokens: 23_162_112,
      model: "gpt-5.6-sol",
      source: "codex",
      totalTokens: 25_040_594,
    });
    expect(rows[0]?.costUsd).toBeCloseTo(58.78);
  });

  it("attributes opencode day totals to the single used model, unknown when ambiguous", async () => {
    const report = await Effect.runPromise(decodeDailyReport(opencodeFixture));
    const rows = aggregateDays("opencode", report.daily);

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ costUsd: 68.88, model: "gpt-5.3-codex" });
    expect(rows[1]).toMatchObject({ costUsd: 1.0, model: "unknown" });
  });

  it("decodes and aggregates Pi agent-summary reports", async () => {
    const report = await Effect.runPromise(decodeDailyReport(piFixture));
    const rows = aggregateDays("pi", report.daily);

    expect(rows).toEqual([
      {
        cacheCreationTokens: 100,
        cacheReadTokens: 2_400,
        costUsd: 0.42,
        date: "2026-07-01",
        inputTokens: 1_200,
        model: "[pi] claude-sonnet-4",
        outputTokens: 300,
        source: "pi",
        totalTokens: 4_000,
      },
    ]);
  });

  it("distributes day cost over token weight when breakdowns lack per-model cost", () => {
    const rows = aggregateDays("codex", [
      {
        date: "2026-05-07",
        costUSD: 100,
        models: {
          "gpt-5.5": { inputTokens: 750 },
          "gpt-5.4": { inputTokens: 250 },
        },
      },
    ]);

    expect(rows.find((row) => row.model === "gpt-5.5")?.costUsd).toBeCloseTo(75);
    expect(rows.find((row) => row.model === "gpt-5.4")?.costUsd).toBeCloseTo(25);
  });

  it("sums duplicate (date, model) pairs", () => {
    const rows = aggregateDays("claude", [
      {
        date: "2026-06-10",
        modelBreakdowns: [
          { modelName: "claude-fable-5", inputTokens: 10, cost: 1 },
          { modelName: "claude-fable-5", inputTokens: 5, cost: 0.5 },
        ],
      },
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ costUsd: 1.5, inputTokens: 15 });
  });
});

describe("summarize", () => {
  it("counts distinct days and models and sums spend", async () => {
    const report = await Effect.runPromise(decodeDailyReport(claudeFixture));
    const summary = summarize(aggregateDays("claude", report.daily));

    expect(summary).toEqual({
      days: 2,
      models: 2,
      rows: 3,
      spendUsd: 841.29 + 9.85 + 1.25,
    });
  });
});
