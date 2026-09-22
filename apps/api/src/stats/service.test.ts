import { Effect, Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { StatsResponse } from "@tokenmaxxing/api-contract";
import type { StatsTotals, StatsWindow } from "@tokenmaxxing/api-contract";

import { type EdgeCacheLike, makeEdgeJsonCache } from "../cloudflare/edge-cache";
import {
  makeStatsService,
  StatsRepository,
  statsWindowStarts,
  type StatsSnapshot,
  type StatsWindowStarts,
} from "./service";

const emptyTotals: StatsTotals = {
  activeDays: 0,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
  deviceCount: 0,
  firstDate: null,
  inputTokens: 0,
  lastDate: null,
  outputTokens: 0,
  rowCount: 0,
  spendUsd: 0,
  totalTokens: 0,
  userCount: 0,
};

function emptyWindow(since: string | null): StatsWindow {
  return { modelsBySpend: [], modelsByTokens: [], since, sources: [], totals: emptyTotals };
}

const emptySnapshot: StatsSnapshot = {
  daily: [],
  dailyByModel: [],
  peaks: { spend: null, tokens: null },
  topUsers: { bySpend: [], byTokens: [] },
  windows: {
    allTime: emptyWindow(null),
    last30d: emptyWindow("2026-06-10"),
    ytd: emptyWindow("2026-01-01"),
  },
};

describe("statsWindowStarts", () => {
  it("derives year-to-date from the current UTC year instead of a fixed year", () => {
    expect(statsWindowStarts(new Date("2027-01-05T12:00:00.000Z"))).toEqual({
      allTime: null,
      last30d: "2026-12-07",
      ytd: "2027-01-01",
    });
  });
});

describe("StatsService.getStats", () => {
  it("asks for every window plus the future-date ceiling, and adds generatedAt", async () => {
    const calls: Array<{ limit: number; until: string; windows: StatsWindowStarts }> = [];
    const service = await Effect.runPromise(
      makeStatsService({
        now: () => new Date("2026-07-09T20:00:00.000Z"),
      }).pipe(
        Effect.provideService(StatsRepository, {
          snapshot: (input) =>
            Effect.sync(() => {
              calls.push(input);
              return emptySnapshot;
            }),
        }),
      ),
    );

    const response = await Effect.runPromise(service.getStats());

    expect(calls).toEqual([
      {
        limit: 10,
        until: "2026-07-10",
        windows: { allTime: null, last30d: "2026-06-10", ytd: "2026-01-01" },
      },
    ]);
    expect(response.generatedAt).toBe("2026-07-09T20:00:00.000Z");
    expect(response.windows.allTime.totals.totalTokens).toBe(0);
  });

  it("serves repeat reads from the edge cache without touching D1", async () => {
    const edge = memoryEdgeCache();
    let snapshots = 0;
    let clock = new Date("2026-07-09T20:00:00.000Z");
    const service = await Effect.runPromise(
      makeStatsService({
        cache: makeEdgeJsonCache({
          cache: edge,
          decode: Schema.decodeUnknownOption(StatsResponse),
          key: "https://api.tokenmaxxing.sh/__cache/stats",
          ttlSeconds: 300,
        }),
        now: () => clock,
      }).pipe(
        Effect.provideService(StatsRepository, {
          snapshot: () =>
            Effect.sync(() => {
              snapshots += 1;
              return emptySnapshot;
            }),
        }),
      ),
    );

    const first = await Effect.runPromise(service.getStats());
    clock = new Date("2026-07-09T20:01:00.000Z");
    const second = await Effect.runPromise(service.getStats());

    expect(snapshots).toBe(1);
    expect(second).toEqual(first);
    expect(edge.puts[0]?.headers.get("cache-control")).toBe("public, max-age=300");

    // Undecodable entries (e.g. an older response shape) fall through to D1.
    edge.entries.set("https://api.tokenmaxxing.sh/__cache/stats", Response.json({ stale: true }));
    const third = await Effect.runPromise(service.getStats());
    expect(snapshots).toBe(2);
    expect(third.generatedAt).toBe("2026-07-09T20:01:00.000Z");
  });
});

function memoryEdgeCache() {
  const entries = new Map<string, Response>();
  const puts: Response[] = [];
  const cache: EdgeCacheLike & { entries: typeof entries; puts: typeof puts } = {
    entries,
    match: async (key) => entries.get(key)?.clone(),
    put: async (key, response) => {
      puts.push(response.clone());
      entries.set(key, response);
    },
    puts,
  };

  return cache;
}
