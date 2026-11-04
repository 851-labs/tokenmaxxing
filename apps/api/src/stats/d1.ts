import { usageDays } from "@tokenmaxxing/db";
import { asc, desc, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { Effect, Layer, Schema } from "effect";

import { STATS_CHART_MODEL_LIMIT, StatsResponse, UsageRangeId } from "@tokenmaxxing/api-contract";
import type { StatsRange } from "@tokenmaxxing/api-contract";

import { makeEdgeJsonCache } from "../cloudflare/edge-cache";
import { Drizzle } from "../database";
import { singleAggregateRow, usageAggregates, usageMetric } from "../usage/aggregates";
import { visibleUsage } from "../usage/visible";
import { collapseChartSeries, roundCents } from "./chart-models";
import {
  makeStatsService,
  STATS_CACHE_TTL_SECONDS,
  StatsRepository,
  StatsService,
} from "./service";

/** Every source is ranked: there are a couple dozen, and the page lists them all. */
const SOURCE_RANK_LIMIT = 64;

const makeD1StatsRepository = Effect.fn("makeD1StatsRepository")(function* () {
  const database = yield* Drizzle;

  return StatsRepository.of({
    snapshot: ({ limit, ranges, until }) =>
      Effect.gen(function* () {
        const rangeIds = UsageRangeId.literals;
        const starts = rangeIds.map((range) => ranges[range]);
        // The daily series cover every range; each range charts from its own start.
        const seriesSince = starts.reduce((earliest, since) =>
          since < earliest ? since : earliest,
        );
        // One D1 round trip. Batched rows come back as objects keyed by
        // column name, so every statement here must select unique names.
        const [daily, dailyModels, dailySources, ...rangeRows] = yield* database.use((db) =>
          db.batch([
            dailyTotals(db, seriesSince, until),
            dailySeries(db, usageDays.model, seriesSince, until),
            dailySeries(db, usageDays.source, seriesSince, until),
            ...rangeIds.flatMap((range) => rangeStatements(db, ranges[range], until, limit)),
          ]),
        );

        const summaries = yield* Effect.forEach(rangeIds, (range, index) =>
          statsRange(
            ranges[range],
            // `rangeStatements` order, RANGE_STATEMENT_COUNT per range.
            rangeRows.slice(
              index * RANGE_STATEMENT_COUNT,
              (index + 1) * RANGE_STATEMENT_COUNT,
            ) as unknown as RangeRows,
          ).pipe(Effect.map((summary) => [range, summary] as const)),
        );

        return {
          daily: daily.map((day) => ({ ...day, spendUsd: roundCents(day.spendUsd) })),
          dailyByModel: collapseChartSeries(dailyModels, STATS_CHART_MODEL_LIMIT, starts),
          dailyBySource: collapseChartSeries(dailySources, STATS_CHART_MODEL_LIMIT, starts),
          ranges: Object.fromEntries(summaries) as Record<UsageRangeId, StatsRange>,
          until,
        };
      }),
  });
});

/** The statements behind one range, in `statsRange` order. */
function rangeStatements(db: DrizzleD1Database, since: string, until: string, limit: number) {
  return [
    totals(db, since, until),
    rankedBy(db, usageDays.model, since, until, "spend", limit),
    rankedBy(db, usageDays.model, since, until, "tokens", limit),
    rankedBy(db, usageDays.source, since, until, "tokens", SOURCE_RANK_LIMIT),
  ] as const;
}

const RANGE_STATEMENT_COUNT = 4;

type AwaitedTuple<T extends readonly unknown[]> = { -readonly [K in keyof T]: Awaited<T[K]> };

type RangeRows = AwaitedTuple<ReturnType<typeof rangeStatements>>;

function statsRange(since: string, [totalRows, modelsBySpend, modelsByTokens, sources]: RangeRows) {
  return singleAggregateRow(totalRows).pipe(
    Effect.map((rangeTotals): StatsRange => ({
      modelsBySpend,
      modelsByTokens,
      since,
      sources,
      totals: rangeTotals,
    })),
  );
}

function totals(db: DrizzleD1Database, since: string, until: string) {
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

/** Spend, tokens and distinct users per day. */
function dailyTotals(db: DrizzleD1Database, since: string, until: string) {
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
    { since, until },
  )
    .groupBy(usageDays.date)
    .orderBy(asc(usageDays.date));
}

/** Spend and tokens per (date, model) or (date, source) cell. */
function dailySeries(
  db: DrizzleD1Database,
  keyColumn: (typeof usageDays)["model" | "source"],
  since: string,
  until: string,
) {
  return visibleUsage(
    db
      .select({
        date: usageDays.date,
        key: sql<string>`${keyColumn}`.as("series_key"),
        spendUsd: usageAggregates.spendUsd(),
        totalTokens: usageAggregates.totalTokens(),
      })
      .from(usageDays)
      .$dynamic(),
    { since, until },
  )
    .groupBy(usageDays.date, sql`series_key`)
    .orderBy(asc(usageDays.date), asc(sql`series_key`));
}

function rankedBy(
  db: DrizzleD1Database,
  keyColumn: (typeof usageDays)["model" | "source"],
  since: string,
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

const StatsRepositoryLive = Layer.effect(StatsRepository, makeD1StatsRepository());

/** Cache API key only — never routed. Entries in an older response shape
 * fail to decode and fall through to D1, so the key survives shape changes. */
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
