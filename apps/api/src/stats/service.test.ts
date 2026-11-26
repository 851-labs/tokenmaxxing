import { Effect, Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { StatsResponse } from "@tokenmaxxing/api-contract";
import type { StatsRange, StatsTotals } from "@tokenmaxxing/api-contract";

import { type EdgeCacheLike, makeEdgeJsonCache } from "../cloudflare/edge-cache";
import { AfterResponse } from "../after-response";
import { makeTestLogger } from "../testing/logger";
import {
  makeStatsService,
  statsRangeStarts,
  StatsRepository,
  type StatsRangeStarts,
  type StatsSnapshot,
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

function emptyRange(since: string): StatsRange {
  return {
    modelsBySpend: [],
    modelsByTokens: [],
    since,
    sources: [],
    totals: emptyTotals,
  };
}

const emptySnapshot: StatsSnapshot = {
  daily: [],
  dailyByModel: [],
  dailyBySource: [],
  ranges: {
    "1m": emptyRange("2026-06-10"),
    "2m": emptyRange("2026-05-11"),
    "2w": emptyRange("2026-06-26"),
    "3m": emptyRange("2026-04-11"),
    "6m": emptyRange("2026-01-09"),
    ytd: emptyRange("2026-01-01"),
  },
  until: "2026-07-10",
};

describe("statsRangeStarts", () => {
  it("ends every trailing range today and starts year to date on Jan 1", () => {
    expect(statsRangeStarts(new Date("2026-07-09T20:00:00.000Z"))).toEqual({
      "1m": "2026-06-10",
      "2m": "2026-05-11",
      "2w": "2026-06-26",
      "3m": "2026-04-11",
      "6m": "2026-01-09",
      ytd: "2026-01-01",
    });
  });

  it("derives year to date from the current UTC year, even when trailing ranges reach back", () => {
    expect(statsRangeStarts(new Date("2027-01-05T12:00:00.000Z"))).toMatchObject({
      "1m": "2026-12-07",
      ytd: "2027-01-01",
    });
  });
});

describe("StatsService.getStats", () => {
  it("asks for every range plus the future-date ceiling, and adds generatedAt", async () => {
    const calls: Array<{ limit: number; ranges: StatsRangeStarts; until: string }> = [];
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
        ranges: {
          "1m": "2026-06-10",
          "2m": "2026-05-11",
          "2w": "2026-06-26",
          "3m": "2026-04-11",
          "6m": "2026-01-09",
          ytd: "2026-01-01",
        },
        until: "2026-07-10",
      },
    ]);
    expect(response.generatedAt).toBe("2026-07-09T20:00:00.000Z");
    expect(response.ranges.ytd.totals.totalTokens).toBe(0);
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

describe("StatsService.getStats stale-while-revalidate", () => {
  const cacheKey = "https://api.tokenmaxxing.sh/__cache/stats";

  /** A service over an edge cache whose clock and D1 snapshot count tests control. */
  async function swrService(
    options: {
      fail?: () => boolean;
      runAfterResponse?: (effect: Effect.Effect<void>) => Effect.Effect<void>;
    } = {},
  ) {
    const state = { clock: new Date("2026-07-09T20:00:00.000Z"), snapshots: 0 };
    const service = await Effect.runPromise(
      makeStatsService({
        cache: makeEdgeJsonCache({
          cache: memoryEdgeCache(),
          decode: Schema.decodeUnknownOption(StatsResponse),
          key: cacheKey,
          ttlSeconds: 86_400,
        }),
        now: () => state.clock,
      }).pipe(
        Effect.provideService(StatsRepository, {
          snapshot: () =>
            Effect.suspend(() => {
              state.snapshots += 1;
              return options.fail?.() === true
                ? Effect.die(new Error("D1 unavailable"))
                : Effect.succeed(emptySnapshot);
            }),
        }),
      ),
    );
    const { runAfterResponse } = options;
    const read = () =>
      Effect.runPromise(
        runAfterResponse === undefined
          ? service.getStats()
          : service
              .getStats()
              .pipe(Effect.provideService(AfterResponse, { run: runAfterResponse })),
      );
    const at = (iso: string) => {
      state.clock = new Date(iso);
    };

    return { at, read, state };
  }

  it("serves a stale snapshot at once and rebuilds it after the response", async () => {
    const deferred: Array<Effect.Effect<void>> = [];
    const { at, read, state } = await swrService({
      runAfterResponse: (effect) => Effect.sync(() => void deferred.push(effect)),
    });

    const first = await read();
    at("2026-07-09T20:11:00.000Z");
    const stale = await read();

    expect(stale.generatedAt).toBe(first.generatedAt);
    expect(state.snapshots).toBe(1);
    expect(deferred).toHaveLength(1);

    await Effect.runPromise(deferred[0]!);
    expect(state.snapshots).toBe(2);
    expect((await read()).generatedAt).toBe("2026-07-09T20:11:00.000Z");
  });

  it("schedules one rebuild however many stale reads arrive meanwhile", async () => {
    const deferred: Array<Effect.Effect<void>> = [];
    const { at, read } = await swrService({
      runAfterResponse: (effect) => Effect.sync(() => void deferred.push(effect)),
    });

    await read();
    at("2026-07-09T20:30:00.000Z");
    await Promise.all([read(), read(), read()]);
    expect(deferred).toHaveLength(1);

    // Once it settles, the next stale read may schedule another.
    await Effect.runPromise(deferred[0]!);
    at("2026-07-09T20:50:00.000Z");
    await read();
    expect(deferred).toHaveLength(2);
  });

  it("serves a fresh snapshot without scheduling anything", async () => {
    const deferred: Array<Effect.Effect<void>> = [];
    const { at, read, state } = await swrService({
      runAfterResponse: (effect) => Effect.sync(() => void deferred.push(effect)),
    });

    await read();
    at("2026-07-09T20:09:59.000Z");
    await read();

    expect([state.snapshots, deferred.length]).toEqual([1, 0]);
  });

  it("rebuilds a stale snapshot inline where nothing runs after the response", async () => {
    const { at, read, state } = await swrService();

    await read();
    at("2026-07-09T20:11:00.000Z");

    expect((await read()).generatedAt).toBe("2026-07-09T20:11:00.000Z");
    expect(state.snapshots).toBe(2);
  });

  it("logs a failed background rebuild, keeps the stale snapshot, and retries later", async () => {
    const logs = makeTestLogger();
    let failing = false;
    const deferred: Array<Effect.Effect<void>> = [];
    const { at, read } = await swrService({
      fail: () => failing,
      runAfterResponse: (effect) => Effect.sync(() => void deferred.push(effect)),
    });

    const first = await read();
    failing = true;
    at("2026-07-09T20:11:00.000Z");
    await read();
    await Effect.runPromise(deferred[0]!.pipe(Effect.provide(logs.layer)));

    expect(logs.entries.map((entry) => entry.message)).toEqual(["stats rebuild failed"]);
    expect((await read()).generatedAt).toBe(first.generatedAt);
    expect(deferred).toHaveLength(2);
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
