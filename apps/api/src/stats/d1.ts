import { usageDays } from "@tokenmaxxing/db";
import { asc, desc, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { Effect, Layer, Schema } from "effect";

import { StatsResponse } from "@tokenmaxxing/api-contract";
import type { StatsWindow } from "@tokenmaxxing/api-contract";

import { makeEdgeJsonCache } from "../cloudflare/edge-cache";
import { Drizzle } from "../database";
import { singleAggregateRow, usageAggregates, usageMetric } from "../usage/aggregates";
import { topUsers } from "../usage/ranking";
import { visibleUsage } from "../usage/visible";
import {
  makeStatsService,
  STATS_CACHE_TTL_SECONDS,
  StatsRepository,
  StatsService,
} from "./service";

const makeD1StatsRepository = Effect.fn("makeD1StatsRepository")(function* () {
  const database = yield* Drizzle;

  return StatsRepository.of({
    snapshot: ({ limit, until, windows }) =>
      Effect.gen(function* () {
        // One D1 round trip. Batched rows come back as objects keyed by
        // column name, so every statement here must select unique names.
        const [daily, dailyByModel, topUsersBySpend, topUsersByTokens, ...windowRows] =
          yield* database.use((db) =>
            db.batch([
              dailyTotals(db, until),
              dailyModels(db, until),
              topUsers(db, { limit, metric: "spend", since: null, until }),
              topUsers(db, { limit, metric: "tokens", since: null, until }),
              ...windowStatements(db, windows.allTime, until, limit),
              ...windowStatements(db, windows.last30d, until, limit),
              ...windowStatements(db, windows.ytd, until, limit),
            ]),
          );
        const [allTime, last30d, ytd] = yield* Effect.all([
          statsWindow(windows.allTime, [
            windowRows[0],
            windowRows[1],
            windowRows[2],
            windowRows[3],
          ]),
          statsWindow(windows.last30d, [
            windowRows[4],
            windowRows[5],
            windowRows[6],
            windowRows[7],
          ]),
          statsWindow(windows.ytd, [windowRows[8], windowRows[9], windowRows[10], windowRows[11]]),
        ]);

        return {
          daily,
          dailyByModel,
          peaks: {
            spend: peakDay(daily, (day) => day.spendUsd),
            tokens: peakDay(daily, (day) => day.totalTokens),
          },
          topUsers: {
            bySpend: topUsersBySpend.map(withoutRank),
            byTokens: topUsersByTokens.map(withoutRank),
          },
          windows: { allTime, last30d, ytd },
        };
      }),
  });
});

/** The four statements behind one stats window, in `statsWindow` order. */
function windowStatements(
  db: DrizzleD1Database,
  since: string | null,
  until: string,
  limit: number,
) {
  return [
    totals(db, since, until),
    rankedBy(db, usageDays.model, since, until, "spend", limit),
    rankedBy(db, usageDays.model, since, until, "tokens", limit),
    rankedBy(db, usageDays.source, since, until, "tokens", limit),
  ] as const;
}

type AwaitedTuple<T extends readonly unknown[]> = { -readonly [K in keyof T]: Awaited<T[K]> };

type WindowRows = AwaitedTuple<ReturnType<typeof windowStatements>>;

function statsWindow(
  since: string | null,
  [totalRows, modelsBySpend, modelsByTokens, sources]: WindowRows,
) {
  return singleAggregateRow(totalRows).pipe(
    Effect.map((windowTotals): StatsWindow => ({
      modelsBySpend,
      modelsByTokens,
      since,
      sources,
      totals: windowTotals,
    })),
  );
}

function totals(db: DrizzleD1Database, since: string | null, until: string) {
  return visibleUsage(
    db
      .select({
        activeDays: usageAggregates.activeDays(),
        cacheCreationTokens: usageAggregates.cacheCreationTokens(),
        cacheReadTokens: usageAggregates.cacheReadTokens(),
        deviceCount: usageAggregates.deviceCount(),
        firstDate: usageAggregates.firstDate(),
        inputTokens: usageAggregates.inputTokens(),
        lastDate: usageAggregates.lastDate(),
        outputTokens: usageAggregates.outputTokens(),
        rowCount: usageAggregates.rowCount(),
        spendUsd: usageAggregates.spendUsd(),
        totalTokens: usageAggregates.totalTokens(),
        userCount: usageAggregates.userCount(),
      })
      .from(usageDays)
      .$dynamic(),
    { since, until },
  );
}

function dailyTotals(db: DrizzleD1Database, until: string) {
  return visibleUsage(
    db
      .select({
        date: usageDays.date,
        spendUsd: usageAggregates.spendUsd(),
        totalTokens: usageAggregates.totalTokens(),
        userCount: usageAggregates.userCount(),
      })
      .from(usageDays)
      .$dynamic(),
    { until },
  )
    .groupBy(usageDays.date)
    .orderBy(asc(usageDays.date));
}

function dailyModels(db: DrizzleD1Database, until: string) {
  return visibleUsage(
    db
      .select({
        date: usageDays.date,
        key: usageDays.model,
        outputTokens: usageAggregates.outputTokens(),
        rowCount: usageAggregates.rowCount(),
        spendUsd: usageAggregates.spendUsd(),
        totalTokens: usageAggregates.totalTokens(),
      })
      .from(usageDays)
      .$dynamic(),
    { until },
  )
    .groupBy(usageDays.date, usageDays.model)
    .orderBy(asc(usageDays.date), asc(usageDays.model));
}

function rankedBy(
  db: DrizzleD1Database,
  keyColumn: (typeof usageDays)["model" | "source"],
  since: string | null,
  until: string,
  orderBy: "spend" | "tokens",
  limit: number,
) {
  return visibleUsage(
    db
      .select({
        key: sql<string>`${keyColumn}`.as("rank_key"),
        rowCount: usageAggregates.rowCount(),
        spendUsd: usageAggregates.spendUsd(),
        totalTokens: usageAggregates.totalTokens(),
        userCount: usageAggregates.userCount(),
      })
      .from(usageDays)
      .$dynamic(),
    { since, until },
  )
    .groupBy(sql`rank_key`)
    .orderBy(desc(usageMetric(orderBy)))
    .limit(limit);
}

/** Stats lists top users without the leaderboard's rank column. */
function withoutRank<Row extends { rank: number }>({ rank: _rank, ...row }: Row) {
  return row;
}

/** The busiest day by `metric`; the earliest one wins a tie. */
function peakDay<Day extends { date: string }>(
  days: readonly Day[],
  metric: (day: Day) => number,
): Day | null {
  let peak: Day | null = null;
  for (const day of days) {
    if (peak === null || metric(day) > metric(peak)) {
      peak = day;
    }
  }

  return peak;
}

const StatsRepositoryLive = Layer.effect(StatsRepository, makeD1StatsRepository());

/** Cache API key only — never routed. Byte-identical to the key the worker
 * used before, so deploys don't cold-start the colo caches. */
const STATS_CACHE_KEY = "https://api.tokenmaxxing.sh/__cache/stats";

// Suspended so `caches.default` is resolved when the layer builds (worker
// init), not at module load.
const StatsServiceLive = Layer.effect(
  StatsService,
  Effect.suspend(() =>
    makeStatsService({
      cache: makeEdgeJsonCache({
        decode: Schema.decodeUnknownOption(StatsResponse),
        key: STATS_CACHE_KEY,
        ttlSeconds: STATS_CACHE_TTL_SECONDS,
      }),
    }),
  ),
).pipe(Layer.provide(StatsRepositoryLive));

export { StatsRepositoryLive, StatsServiceLive };
