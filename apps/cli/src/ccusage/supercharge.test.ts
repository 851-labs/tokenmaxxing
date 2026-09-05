import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { collectSuperchargeDays, superchargeDailyReport } from "./supercharge";

function turn(
  sessionId: string,
  eventId: string,
  timestampSec: number,
  model: string,
  tokens: Record<string, number>,
): string {
  return JSON.stringify({
    timestamp: timestampSec,
    method: "_x.ai/session/update",
    params: {
      sessionId,
      update: {
        sessionUpdate: "turn_completed",
        usage: {
          inputTokens: tokens.input ?? 0,
          outputTokens: tokens.output ?? 0,
          cachedReadTokens: tokens.cachedRead ?? 0,
          cacheCreationTokens: tokens.cacheCreation ?? 0,
          reasoningTokens: tokens.reasoning ?? 0,
          costUsdTicks: Math.round((tokens.costUsd ?? 0) * 1e10),
          modelUsage: {
            [model]: {
              inputTokens: tokens.input ?? 0,
              outputTokens: tokens.output ?? 0,
              totalTokens: (tokens.input ?? 0) + (tokens.output ?? 0),
              cachedReadTokens: tokens.cachedRead ?? 0,
              cacheCreationTokens: tokens.cacheCreation ?? 0,
              reasoningTokens: tokens.reasoning ?? 0,
              costUsdTicks: Math.round((tokens.costUsd ?? 0) * 1e10),
            },
          },
        },
      },
    },
    _meta: { eventId },
  });
}

describe("collectSuperchargeDays", () => {
  it("parses turn_completed records across sessions into per-model days", async () => {
    const listSessionFiles = () =>
      Effect.succeed([
        "/root/sessions/proj-a/s1/updates.jsonl",
        "/root/sessions/proj-b/s2/updates.jsonl",
      ]);
    const readUpdates = (path: string) =>
      Effect.succeed(
        path.includes("proj-a/s1")
          ? [
              turn("s1", "e1", 1750000000, "gpt-5.6-luna", {
                input: 100,
                output: 20,
                costUsd: 0.01,
              }),
              turn("s1", "e2", 1750000000, "gpt-5.6-luna", {
                input: 50,
                output: 5,
                costUsd: 0.005,
              }),
            ].join("\n")
          : turn("s2", "e3", 1750086400, "grok-4.6-build", {
              input: 200,
              output: 30,
              cachedRead: 100,
              costUsd: 0.02,
            }),
      );

    const result = await Effect.runPromise(
      collectSuperchargeDays({ listSessionFiles, readUpdates }),
    );

    expect(result.sessions).toBe(2);
    expect(result.days).toHaveLength(3);
    expect(result.days[0]?.model).toBe("gpt-5.6-luna");
    expect(result.days[0]?.usage.costUsd).toBeCloseTo(0.01);
  });

  it("skips records with no usage and dedupes repeated turns", async () => {
    const line = turn("s1", "e1", 1750000000, "gpt-5.6-luna", {
      input: 100,
      output: 20,
      costUsd: 0.01,
    });
    const listSessionFiles = () => Effect.succeed(["/root/sessions/p/s1/updates.jsonl"]);
    const readUpdates = () => Effect.succeed([line, line].join("\n"));

    const result = await Effect.runPromise(
      collectSuperchargeDays({ listSessionFiles, readUpdates }),
    );
    expect(result.days).toHaveLength(1);
  });
});

describe("superchargeDailyReport", () => {
  it("aggregates days by date+model", () => {
    const report = superchargeDailyReport([
      {
        date: "2026-08-06",
        model: "gpt-5.6-luna",
        usage: {
          inputTokens: 100,
          outputTokens: 20,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          costUsd: 0.01,
          reasoningTokens: 0,
        },
      },
      {
        date: "2026-08-06",
        model: "gpt-5.6-luna",
        usage: {
          inputTokens: 50,
          outputTokens: 5,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          costUsd: 0.005,
          reasoningTokens: 0,
        },
      },
      {
        date: "2026-08-07",
        model: "grok-4.6-build",
        usage: {
          inputTokens: 200,
          outputTokens: 30,
          cacheCreationTokens: 0,
          cacheReadTokens: 100,
          costUsd: 0.02,
          reasoningTokens: 0,
        },
      },
    ]);

    expect(report.daily).toHaveLength(2);
    const luna = report.daily.find((d) => d.date === "2026-08-06");
    expect(luna?.inputTokens).toBe(150);
    expect(luna?.outputTokens).toBe(25);
    expect(luna?.totalCost).toBeCloseTo(0.015);
    expect(luna?.modelBreakdowns?.[0]?.modelName).toBe("gpt-5.6-luna");
    expect(luna?.modelBreakdowns?.[0]?.cost).toBeCloseTo(0.015);
  });
});
