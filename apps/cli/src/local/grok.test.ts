import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { aggregateGrokTurns, collectGrokUsage, readGrokTurns } from "./grok";

const TS_DAY_1 = 1_784_550_000; // bucketed via injected dayOf
const TS_DAY_2 = 1_784_640_000;

function dayOf(ts: number): string {
  return ts < 1_784_600_000 ? "2026-07-19" : "2026-07-20";
}

function turnCompleted(ts: number, modelUsage: Record<string, unknown>): string {
  return JSON.stringify({
    params: {
      sessionId: "sess-1",
      update: { sessionUpdate: "turn_completed", usage: { modelUsage } },
    },
    timestamp: ts,
  });
}

describe("aggregateGrokTurns", () => {
  it("buckets per-model usage by day and converts ticks to USD", () => {
    const days = aggregateGrokTurns(
      [
        {
          modelUsage: {
            "grok-4.5-build": {
              cachedReadTokens: 80_000,
              costUsdTicks: 500_000_000,
              inputTokens: 92_065,
              outputTokens: 633,
            },
          },
          ts: TS_DAY_1,
        },
        {
          modelUsage: {
            "grok-4.5-build": {
              cachedReadTokens: 40_000,
              costUsdTicks: 21_456_000,
              inputTokens: 41_423,
              outputTokens: 346,
            },
            "grok-4.20": { inputTokens: 1_000, outputTokens: 50 },
          },
          ts: TS_DAY_1,
        },
        {
          modelUsage: { "grok-4.5-build": { inputTokens: 10, outputTokens: 5 } },
          ts: TS_DAY_2,
        },
      ],
      { dayOf },
    );

    expect(days).toHaveLength(2);
    expect(days[0]?.date).toBe("2026-07-19");
    expect(days[0]?.totalCost).toBe(0.52);
    expect(days[0]?.modelBreakdowns).toEqual([
      {
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        cost: 0,
        inputTokens: 1_000,
        modelName: "grok-4.20",
        outputTokens: 50,
      },
      {
        cacheCreationTokens: 0,
        cacheReadTokens: 120_000,
        cost: 0.52,
        inputTokens: 13_488,
        modelName: "grok-4.5-build",
        outputTokens: 979,
      },
    ]);
    expect(days[1]?.date).toBe("2026-07-20");
  });

  it("filters days before --since", () => {
    const days = aggregateGrokTurns(
      [
        { modelUsage: { grok: { inputTokens: 5, outputTokens: 5 } }, ts: TS_DAY_1 },
        { modelUsage: { grok: { inputTokens: 5, outputTokens: 5 } }, ts: TS_DAY_2 },
      ],
      { dayOf, since: "2026-07-20" },
    );

    expect(days.map((day) => day.date)).toEqual(["2026-07-20"]);
  });

  it("skips turns without any token usage", () => {
    const days = aggregateGrokTurns(
      [
        { modelUsage: { grok: {} }, ts: TS_DAY_1 },
        { modelUsage: { grok: { inputTokens: 1 } }, ts: TS_DAY_1 },
      ],
      { dayOf },
    );

    expect(days).toHaveLength(1);
    expect(days[0]?.modelBreakdowns?.[0]?.inputTokens).toBe(1);
  });
});

describe("readGrokTurns", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "tokenmaxxing-grok-"));
  });

  afterEach(async () => {
    await rm(dir, { force: true, recursive: true });
  });

  it("parses only valid turn_completed lines", async () => {
    const file = join(dir, "updates.jsonl");
    const lines = [
      JSON.stringify({ params: { update: { sessionUpdate: "agent_message_chunk" } } }),
      turnCompleted(TS_DAY_1, { "grok-4.5-build": { inputTokens: 100, outputTokens: 10 } }),
      `{"params":{"update":{"sessionUpdate":"turn_completed" BROKEN`,
      // Millisecond timestamps are rejected — seconds only.
      turnCompleted(TS_DAY_1 * 1000, { grok: { inputTokens: 1 } }),
      // Missing modelUsage.
      JSON.stringify({
        params: { update: { sessionUpdate: "turn_completed", usage: {} } },
        timestamp: TS_DAY_1,
      }),
      turnCompleted(TS_DAY_2, { "grok-4.20": { inputTokens: 200, outputTokens: 20 } }),
    ];
    await writeFile(file, `${lines.join("\n")}\n`);

    const turns = await readGrokTurns(file);
    expect(turns).toHaveLength(2);
    expect(turns.map((turn) => turn.ts)).toEqual([TS_DAY_1, TS_DAY_2]);
  });
});

describe("collectGrokUsage", () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "tokenmaxxing-grok-home-"));
  });

  afterEach(async () => {
    await rm(home, { force: true, recursive: true });
  });

  it("returns empty when the sessions dir is missing", async () => {
    expect(await collectGrokUsage({ home })).toEqual({ days: [], sessionIds: [] });
  });

  it("aggregates across sessions and counts sessions with turns", async () => {
    const project = join(home, "sessions", "%2Ftmp%2Fproject");
    const sessionA = join(project, "019f3706-db91-77b1-82b1-32ed3cacf1f5");
    const sessionB = join(project, "019f84e6-1fd1-78a2-9a48-9e51f675d3b3");
    const sessionEmpty = join(project, "empty-session");
    await mkdir(sessionA, { recursive: true });
    await mkdir(sessionB, { recursive: true });
    await mkdir(sessionEmpty, { recursive: true });
    await writeFile(join(home, "sessions", "session_search.sqlite"), "not a dir");
    await writeFile(
      join(sessionA, "updates.jsonl"),
      `${turnCompleted(TS_DAY_1, { "grok-4.5-build": { inputTokens: 100, outputTokens: 10 } })}\n`,
    );
    await writeFile(
      join(sessionB, "updates.jsonl"),
      `${turnCompleted(TS_DAY_1, { "grok-4.5-build": { inputTokens: 300, outputTokens: 30 } })}\n`,
    );

    const report = await collectGrokUsage({ dayOf, home });

    expect(report.sessionIds).toEqual([
      "019f3706-db91-77b1-82b1-32ed3cacf1f5",
      "019f84e6-1fd1-78a2-9a48-9e51f675d3b3",
    ]);
    expect(report.days).toHaveLength(1);
    expect(report.days[0]?.modelBreakdowns?.[0]?.inputTokens).toBe(400);
    expect(report.days[0]?.modelBreakdowns?.[0]?.outputTokens).toBe(40);
  });

  it("drops sessions without turns in the --since range", async () => {
    const project = join(home, "sessions", "%2Ftmp%2Fproject");
    const sessionA = join(project, "old-session");
    await mkdir(sessionA, { recursive: true });
    await writeFile(
      join(sessionA, "updates.jsonl"),
      `${turnCompleted(TS_DAY_1, { grok: { inputTokens: 1, outputTokens: 1 } })}\n`,
    );

    const report = await collectGrokUsage({ dayOf, home, since: "2026-07-20" });
    expect(report).toEqual({ days: [], sessionIds: [] });
  });
});
