import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";

import type { StatsResponse } from "@tokenmaxxing/api-contract";

import { makeStatsService, StatsRepository, statsWindowStart, type StatsSnapshot } from "./service";

interface TestStatsService {
  getStats(): Effect.Effect<typeof StatsResponse.Type, never>;
}

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
  it("adds generatedAt and the last-30d lower bound", async () => {
    const calls: Array<{ last30dSince: string; limit: number }> = [];
    const service = (await Effect.runPromise(
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
    )) as unknown as TestStatsService;

    const response = await Effect.runPromise(service.getStats());

    expect(calls).toEqual([{ last30dSince: "2026-06-10", limit: 10 }]);
    expect(response.generatedAt).toBe("2026-07-09T20:00:00.000Z");
    expect(response.last30dSince).toBe("2026-06-10");
    expect(response.year2026Since).toBe("2026-01-01");
    expect(response.allTime.totalTokens).toBe(0);
  });
});
