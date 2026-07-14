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
});
