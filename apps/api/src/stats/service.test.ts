import { Effect, Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { StatsResponse } from "@tokenmaxxing/api-contract";

import { type EdgeCacheLike, makeEdgeJsonCache } from "../cloudflare/edge-cache";
import { makeStatsService, StatsRepository, statsWindowStart, type StatsSnapshot } from "./service";

const emptySnapshot: StatsSnapshot = {
  allTime: {
    activeDates: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    deviceCount: 0,
    firstDate: null,
    inputTokens: 0,
    lastDate: null,
    outputTokens: 0,
    rowCount: 0,
    totalSpendUsd: 0,
    totalTokens: 0,
    userCount: 0,
  },
  daily: [],
  dailyByModel: [],
  last30d: {
    activeDates: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    deviceCount: 0,
    firstDate: null,
    inputTokens: 0,
    lastDate: null,
    outputTokens: 0,
    rowCount: 0,
    totalSpendUsd: 0,
    totalTokens: 0,
    userCount: 0,
  },
  peaks: {
    spend: null,
    tokens: null,
  },
  sources: {
    allTime: [],
    last30d: [],
    year2026: [],
  },
  topModels: {
    allTimeBySpend: [],
    allTimeByTokens: [],
    last30dBySpend: [],
    last30dByTokens: [],
    year2026BySpend: [],
    year2026ByTokens: [],
  },
  topUsers: {
    bySpend: [],
    byTokens: [],
  },
  year2026: {
    activeDates: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    deviceCount: 0,
    firstDate: null,
    inputTokens: 0,
    lastDate: null,
    outputTokens: 0,
    rowCount: 0,
    totalSpendUsd: 0,
    totalTokens: 0,
    userCount: 0,
  },
};

describe("statsWindowStart", () => {
  it("covers trailing 30 calendar days inclusive of today", () => {
    expect(statsWindowStart(new Date("2026-07-09T20:00:00.000Z"))).toBe("2026-06-10");
  });
});

describe("StatsService.getStats", () => {
  it("adds generatedAt, the last-30d lower bound, and the future-date ceiling", async () => {
    const calls: Array<{ last30dSince: string; limit: number; until: string }> = [];
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

    expect(calls).toEqual([{ last30dSince: "2026-06-10", limit: 10, until: "2026-07-10" }]);
    expect(response.generatedAt).toBe("2026-07-09T20:00:00.000Z");
    expect(response.last30dSince).toBe("2026-06-10");
    expect(response.year2026Since).toBe("2026-01-01");
    expect(response.allTime.totalTokens).toBe(0);
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
