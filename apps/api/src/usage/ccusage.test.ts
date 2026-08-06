import type { RawUsageReportInput } from "@tokenmaxxing/api-contract";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { parseRawUsageReports } from "./ccusage";

describe("parseRawUsageReports", () => {
  it("preserves Hermes reasoning tokens omitted from model breakdowns", async () => {
    const reports: RawUsageReportInput[] = [
      {
        command: [
          "ccusage@^20.0.19",
          "hermes",
          "daily",
          "--json",
          "--breakdown",
          "--mode",
          "calculate",
        ],
        payload: {
          daily: [
            {
              cacheCreationTokens: 20,
              cacheReadTokens: 50,
              date: "2025-06-15",
              inputTokens: 1_200,
              messageCount: 42,
              modelBreakdowns: [
                {
                  cacheCreationTokens: 20,
                  cacheReadTokens: 50,
                  cost: 0.34,
                  inputTokens: 1_200,
                  modelName: "claude-sonnet-4-20250514",
                  outputTokens: 300,
                },
              ],
              modelsUsed: ["claude-sonnet-4-20250514"],
              outputTokens: 300,
              totalCost: 0.34,
              totalTokens: 1_580,
            },
          ],
        },
        reportKind: "daily",
        source: "hermes",
      },
    ];

    const result = await Effect.runPromise(parseRawUsageReports(reports));

    expect(result.rows).toEqual([
      {
        cacheCreationTokens: 20,
        cacheReadTokens: 50,
        costUsd: 0.34,
        date: "2025-06-15",
        inputTokens: 1_200,
        model: "claude-sonnet-4-20250514",
        outputTokens: 300,
        source: "hermes",
        totalTokens: 1_580,
      },
    ]);
  });

  it("preserves GPT-5.6 tier model names and calculated cost", async () => {
    const reports: RawUsageReportInput[] = [
      {
        command: [
          "ccusage@^20.0.19",
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

    expect(result.coveredDays).toEqual([{ date: "2026-07-11", source: "codex" }]);
    expect(result.persistableReports).toEqual(reports);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      cacheReadTokens: 23_162_112,
      model: "gpt-5.6-sol",
      source: "codex",
      totalTokens: 25_040_594,
    });
    expect(result.rows[0]?.costUsd).toBeCloseTo(58.78);
  });

  it("normalizes daily reports and never marks legacy session reports for persistence", async () => {
    const result = await Effect.runPromise(
      parseRawUsageReports([
        {
          command: ["ccusage@^20", "claude", "daily", "--json"],
          payload: {
            daily: [
              {
                date: "2026-07-22",
                projectPath: "/Users/alex/secret-client",
                totalTokens: 100,
              },
            ],
          },
          reportKind: "daily",
          source: "claude",
        },
        {
          command: ["ccusage@^20", "claude", "session", "--json"],
          payload: {
            sessions: [
              {
                projectPath: "/Users/alex/secret-client",
                sessionId: "-Users-alex-secret-client",
              },
            ],
          },
          reportKind: "session",
          source: "claude",
        },
      ]),
    );

    expect(result.persistableReports).toEqual([
      {
        command: ["ccusage@^20", "claude", "daily", "--json"],
        payload: { daily: [{ date: "2026-07-22", totalTokens: 100 }] },
        reportKind: "daily",
        source: "claude",
      },
    ]);
    expect(result.coveredDays).toEqual([{ date: "2026-07-22", source: "claude" }]);
    expect(result.sourceStats).toEqual([{ sessionCount: 1, source: "claude" }]);
    expect(JSON.stringify(result.persistableReports)).not.toContain("secret-client");
  });

  it("drops invalid daily reports instead of persisting unknown payloads", async () => {
    const result = await Effect.runPromise(
      parseRawUsageReports([
        {
          command: ["ccusage@^20", "codex", "daily", "--json"],
          payload: { projectPath: "/Users/alex/secret-client" },
          reportKind: "daily",
          source: "codex",
        },
      ]),
    );

    expect(result).toEqual({
      coveredDays: [],
      persistableReports: [],
      rows: [],
      sourceStats: [],
    });
  });
});
