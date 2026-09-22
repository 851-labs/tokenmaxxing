import { usageDays } from "@tokenmaxxing/db";
import { asc, desc, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { Effect, Layer, Schema } from "effect";

import { StatsResponse } from "@tokenmaxxing/api-contract";

import { makeEdgeJsonCache } from "../cloudflare/edge-cache";
import { Drizzle } from "../database";
import { YEAR_2026_START } from "../date-keys";
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
    snapshot: ({ last30dSince, limit, until }) =>
      Effect.gen(function* () {
        // One D1 round trip. Batched rows come back as objects keyed by
        // column name, so every statement here must select unique names.
        const [
          allTime,
          last30d,
          year2026,
          daily,
          allTimeModelsBySpend,
          allTimeModelsByTokens,
          last30dModelsBySpend,
          last30dModelsByTokens,
          year2026ModelsBySpend,
          year2026ModelsByTokens,
          allTimeSources,
          last30dSources,
          year2026Sources,
          topUsersBySpend,
          topUsersByTokens,
          dailyByModel,
        ] = yield* database.use((db) =>
          db.batch([
            totals(db, null, until),
            totals(db, last30dSince, until),
            totals(db, YEAR_2026_START, until),
            dailyTotals(db, until),
            rankedBy(db, usageDays.model, null, until, "spend", limit),
            rankedBy(db, usageDays.model, null, until, "tokens", limit),
            rankedBy(db, usageDays.model, last30dSince, until, "spend", limit),
            rankedBy(db, usageDays.model, last30dSince, until, "tokens", limit),
            rankedBy(db, usageDays.model, YEAR_2026_START, until, "spend", limit),
            rankedBy(db, usageDays.model, YEAR_2026_START, until, "tokens", limit),
            rankedBy(db, usageDays.source, null, until, "tokens", limit),
            rankedBy(db, usageDays.source, last30dSince, until, "tokens", limit),
            rankedBy(db, usageDays.source, YEAR_2026_START, until, "tokens", limit),
            topUsers(db, { limit, metric: "spend", since: null, until }),
            topUsers(db, { limit, metric: "tokens", since: null, until }),
            dailyModels(db, until),
          ]),
        );

        const [allTimeTotals, last30dTotals, year2026Totals] = yield* Effect.all([
          singleAggregateRow(allTime),
          singleAggregateRow(last30d),
          singleAggregateRow(year2026),
        ]);

        return {
          allTime: allTimeTotals,
          daily,
          dailyByModel,
          last30d: last30dTotals,
          peaks: {
            spend: peakDay(daily, (day) => day.spendUsd),
            tokens: peakDay(daily, (day) => day.totalTokens),
          },
          sources: {
            allTime: allTimeSources,
            last30d: last30dSources,
            year2026: year2026Sources,
          },
          topModels: {
            allTimeBySpend: allTimeModelsBySpend,
            allTimeByTokens: allTimeModelsByTokens,
            last30dBySpend: last30dModelsBySpend,
            last30dByTokens: last30dModelsByTokens,
            year2026BySpend: year2026ModelsBySpend,
            year2026ByTokens: year2026ModelsByTokens,
          },
          topUsers: {
            bySpend: topUsersBySpend.map(withoutRank),
            byTokens: topUsersByTokens.map(withoutRank),
          },
          year2026: year2026Totals,
        };
      }),
  });
});

function totals(db: DrizzleD1Database, since: string | null, until: string) {
  return visibleUsage(
    db
      .select({
        activeDates: usageAggregates.activeDays(),
        cacheCreationTokens: usageAggregates.cacheCreationTokens(),
        cacheReadTokens: usageAggregates.cacheReadTokens(),
        deviceCount: usageAggregates.deviceCount(),
        firstDate: usageAggregates.firstDate(),
        inputTokens: usageAggregates.inputTokens(),
        lastDate: usageAggregates.lastDate(),
        outputTokens: usageAggregates.outputTokens(),
        rowCount: usageAggregates.rowCount(),
        totalSpendUsd: usageAggregates.spendUsd(),
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
        costUsd: usageAggregates.spendUsd(),
        date: usageDays.date,
        key: usageDays.model,
        outputTokens: usageAggregates.outputTokens(),
        rowCount: usageAggregates.rowCount(),
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
