import { usageDays } from "@tokenmaxxing/db";
import { asc, desc, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { Effect, Layer } from "effect";

import { STATS_CHART_MODEL_LIMIT, UsageRangeId } from "@tokenmaxxing/api-contract";
import type { StatsRange } from "@tokenmaxxing/api-contract";

import { Drizzle } from "../database";
import { collapseChartSeries, roundCents } from "../stats/chart-models";
import { StatsRepository } from "../stats/service";
import { singleAggregateRow, usageAggregates, usageMetric } from "../usage/aggregates";
import { visibleUsage } from "../usage/visible";

/**
 * The /stats snapshot computed the plain way: every range gets its own totals
 * query and its own ranking queries, each a single unconditional aggregate
 * over that range's rows (27 statements for six ranges). This is how the
 * snapshot was built before the rebuild was folded into six statements, and
 * it is far too heavy for production: about 6 seconds of D1 time, enough to
 * overload the database. It stays as the oracle the real repository is
 * compared against, since each of its numbers is one obvious aggregate.
 */

const SOURCE_RANK_LIMIT = 64;

const makeReferenceStatsRepository = Effect.fn("makeReferenceStatsRepository")(function* () {
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

const StatsRepositoryReference = Layer.effect(StatsRepository, makeReferenceStatsRepository());

export { StatsRepositoryReference };
