import type { RawUsageReportInput } from "@tokenmaxxing/api-contract";
import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";

import {
  CCUSAGE_FIXTURE_SOURCES,
  ccusageDailyCommand,
  ccusageDailyFixture,
} from "../testing/ccusage-fixtures";
import { parseRawUsageReports } from "./ccusage";
import { normalizeCcusageModelName, normalizeUsageDays } from "./models";

const options = { latestDate: "2026-09-23" };

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

    const result = await Effect.runPromise(parseRawUsageReports(reports, options));

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

    const result = await Effect.runPromise(parseRawUsageReports(reports, options));

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
      parseRawUsageReports(
        [
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
        ],
        options,
      ),
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
      parseRawUsageReports(
        [
          {
            command: ["ccusage@^20", "codex", "daily", "--json"],
            payload: { projectPath: "/Users/alex/secret-client" },
            reportKind: "daily",
            source: "codex",
          },
        ],
        options,
      ),
    );

    expect(result).toEqual({
      coveredDays: [],
      persistableReports: [],
      rows: [],
      sourceStats: [],
    });
  });
  it("keeps only the last daily report per source instead of summing duplicates", async () => {
    const report = (totalTokens: number, date = "2026-07-20"): RawUsageReportInput => ({
      command: ["ccusage@^20", "claude", "daily", "--json"],
      payload: { daily: [{ date, modelsUsed: ["claude-opus-4"], totalCost: 1, totalTokens }] },
      reportKind: "daily",
      source: "claude",
    });

    const result = await Effect.runPromise(
      parseRawUsageReports(
        [
          report(100),
          {
            command: ["ccusage@^20", "codex", "daily", "--json"],
            payload: { daily: [{ date: "2026-07-20", totalTokens: 7 }] },
            reportKind: "daily",
            source: "codex",
          },
          report(250, "2026-07-21"),
        ],
        options,
      ),
    );

    expect(result.rows.map(({ date, source, totalTokens }) => [source, date, totalTokens])).toEqual(
      [
        ["codex", "2026-07-20", 7],
        ["claude", "2026-07-21", 250],
      ],
    );
    expect(result.coveredDays).toEqual([
      { date: "2026-07-20", source: "codex" },
      { date: "2026-07-21", source: "claude" },
    ]);
    expect(result.persistableReports.map((persisted) => persisted.source)).toEqual([
      "codex",
      "claude",
    ]);
  });

  it("is idempotent when the same report is sent twice in one payload", async () => {
    const report: RawUsageReportInput = {
      command: ["ccusage@^20", "codex", "daily", "--json"],
      payload: { daily: [{ costUSD: 2, date: "2026-07-20", totalTokens: 10 }] },
      reportKind: "daily",
      source: "codex",
    };

    const once = await Effect.runPromise(parseRawUsageReports([report], options));
    const twice = await Effect.runPromise(parseRawUsageReports([report, report], options));

    expect(twice).toEqual(once);
  });

  it("drops days after the ingest ceiling from rows, coverage, and persisted payloads", async () => {
    const result = await Effect.runPromise(
      parseRawUsageReports(
        [
          {
            command: ["ccusage@^20", "codex", "daily", "--json"],
            payload: {
              daily: [
                { date: "2026-09-23", totalTokens: 1 },
                { date: "2026-09-24", totalTokens: 2 },
                { date: "9999-12-31", totalTokens: 3 },
              ],
            },
            reportKind: "daily",
            source: "codex",
          },
        ],
        options,
      ),
    );

    expect(result.rows.map((row) => row.date)).toEqual(["2026-09-23"]);
    expect(result.coveredDays).toEqual([{ date: "2026-09-23", source: "codex" }]);
    expect(result.persistableReports[0]?.payload).toEqual({
      daily: [{ date: "2026-09-23", totalTokens: 1 }],
    });
  });

  it("drops malformed days individually and keeps the rest of the report", async () => {
    const result = await Effect.runPromise(
      parseRawUsageReports(
        [
          {
            command: ["ccusage@^20", "claude", "daily", "--json"],
            payload: {
              daily: [
                { date: "2026-07-20", totalTokens: 10 },
                { date: "not-a-date", totalTokens: 10 },
                { date: "2026-02-30", totalTokens: 10 },
                { date: "2026-07-21", totalTokens: -5 },
                { date: "2026-07-22", totalTokens: 1.5 },
                { date: "2026-07-23", totalCost: -1 },
                { date: "2026-07-24", totalCost: "NaN" },
                { date: "2026-07-25", modelsUsed: ["m".repeat(257)] },
                null,
              ],
            },
            reportKind: "daily",
            source: "claude",
          },
        ],
        options,
      ),
    );

    expect(result.rows.map((row) => row.date)).toEqual(["2026-07-20"]);
    expect(result.coveredDays).toEqual([{ date: "2026-07-20", source: "claude" }]);
  });

  it("keeps day-level cost that exceeds fully priced model breakdowns", async () => {
    const result = await Effect.runPromise(
      parseRawUsageReports(
        [
          {
            command: ["ccusage@^20", "hermes", "daily", "--json"],
            payload: {
              daily: [
                {
                  date: "2026-07-20",
                  modelBreakdowns: [
                    { cost: 1, inputTokens: 300, modelName: "model-a", outputTokens: 0 },
                    { cost: 2, inputTokens: 100, modelName: "model-b", outputTokens: 0 },
                  ],
                  totalCost: 5,
                },
              ],
            },
            reportKind: "daily",
            source: "hermes",
          },
        ],
        options,
      ),
    );

    const costs = Object.fromEntries(result.rows.map((row) => [row.model, row.costUsd]));
    expect(costs["model-a"]).toBeCloseTo(1 + 2 * 0.75);
    expect(costs["model-b"]).toBeCloseTo(2 + 2 * 0.25);
    expect(result.rows.reduce((sum, row) => sum + row.costUsd, 0)).toBeCloseTo(5);
  });
});

describe("parseRawUsageReports with captured ccusage sources", () => {
  const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);

  it.each(CCUSAGE_FIXTURE_SOURCES)(
    "keeps %s day totals, costs, and model names",
    async (source) => {
      const payload = ccusageDailyFixture(source);
      const result = await Effect.runPromise(
        parseRawUsageReports(
          [{ command: ccusageDailyCommand(source), payload, reportKind: "daily", source }],
          options,
        ),
      );
      const rows = normalizeUsageDays(result.rows);

      expect(rows.length).toBeGreaterThan(0);
      expect(new Set(rows.map((row) => row.source))).toEqual(new Set([source]));
      expect(result.coveredDays).toEqual(payload.daily.map(({ date }) => ({ date, source })));
      expect(new Set(rows.map((row) => row.model))).toEqual(
        new Set(
          payload.daily.flatMap((day) =>
            day.modelBreakdowns.map(({ modelName }) =>
              normalizeCcusageModelName(source, modelName),
            ),
          ),
        ),
      );
      // Reasoning tokens some adapters only count in the day total stay counted.
      expect(sum(rows.map((row) => row.totalTokens))).toBe(
        sum(payload.daily.map((day) => day.totalTokens)),
      );
      expect(sum(rows.map((row) => row.costUsd))).toBeCloseTo(
        sum(payload.daily.map((day) => day.totalCost)),
        10,
      );
    },
  );

  it("strips OpenClaw's own model prefix", async () => {
    const result = await Effect.runPromise(
      parseRawUsageReports(
        [
          {
            command: ccusageDailyCommand("openclaw"),
            payload: ccusageDailyFixture("openclaw"),
            reportKind: "daily",
            source: "openclaw",
          },
        ],
        options,
      ),
    );

    expect(result.rows.map((row) => row.model)).toContain("[openclaw] gpt-5.5");
    expect(normalizeUsageDays(result.rows).map(({ date, model }) => [date, model])).toEqual([
      ["2026-09-10", "claude-sonnet-4-6"],
      ["2026-09-10", "gpt-5.5"],
      ["2026-09-11", "claude-sonnet-4-6"],
    ]);
  });
});
