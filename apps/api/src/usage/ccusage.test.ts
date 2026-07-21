import type { RawUsageReportInput } from "@tokenmaxxing/api-contract";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { parseRawUsageReports } from "./ccusage";

describe("parseRawUsageReports", () => {
  it("preserves GPT-5.6 tier model names and calculated cost", async () => {
    const reports: RawUsageReportInput[] = [
      {
        command: [
          "ccusage@^20.0.17",
          "codex",
          "daily",
          "--json",
          "--breakdown",
          "--mode",
          "calculate",
        ],
        payload: {
          daily: [
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
          ],
        },
        reportKind: "daily",
        source: "codex",
      },
    ];

    const result = await Effect.runPromise(parseRawUsageReports(reports));

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      cacheReadTokens: 23_162_112,
      model: "gpt-5.6-sol",
      source: "codex",
      totalTokens: 25_040_594,
    });
    expect(result.rows[0]?.costUsd).toBeCloseTo(58.78);
  });

  it("preserves reasoning-inclusive Gemini totals and count-only sessions", async () => {
    const reports: RawUsageReportInput[] = [
      {
        command: ["ccusage@^20.0.17", "gemini", "daily", "--json"],
        payload: {
          daily: [
            {
              date: "2026-07-21",
              modelBreakdowns: [
                {
                  cacheReadTokens: 16_000,
                  inputTokens: 1_632,
                  modelName: "gemini-3.5-flash-high",
                  outputTokens: 300,
                },
              ],
              totalCost: 0.007_908,
              totalTokens: 17_972,
            },
          ],
        },
        reportKind: "daily",
        source: "antigravity-cli",
      },
      {
        command: ["tokenmaxxing", "antigravity", "session", "--count-only"],
        payload: { sessions: [null, null] },
        reportKind: "session",
        source: "antigravity-cli",
      },
    ];

    const result = await Effect.runPromise(parseRawUsageReports(reports));

    expect(result.rows).toEqual([
      {
        cacheCreationTokens: 0,
        cacheReadTokens: 16_000,
        costUsd: 0.007_908,
        date: "2026-07-21",
        inputTokens: 1_632,
        model: "gemini-3.5-flash-high",
        outputTokens: 300,
        source: "antigravity-cli",
        totalTokens: 17_972,
      },
    ]);
    expect(result.sourceStats).toEqual([{ sessionCount: 2, source: "antigravity-cli" }]);
  });

  it("saturates duplicate counters from untrusted raw reports", async () => {
    const result = await Effect.runPromise(
      parseRawUsageReports([
        {
          command: ["ccusage@^20.0.17", "gemini", "daily", "--json"],
          payload: {
            daily: [
              {
                date: "2026-07-21",
                modelBreakdowns: [
                  { inputTokens: Number.MAX_SAFE_INTEGER, modelName: "model-a" },
                  { inputTokens: Number.MAX_SAFE_INTEGER, modelName: "model-a" },
                ],
              },
            ],
          },
          reportKind: "daily",
          source: "gemini",
        },
      ]),
    );

    expect(result.rows[0]).toMatchObject({
      inputTokens: Number.MAX_SAFE_INTEGER,
      totalTokens: Number.MAX_SAFE_INTEGER,
    });
  });
});
