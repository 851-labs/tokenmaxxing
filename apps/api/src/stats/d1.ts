import { usageDays, users } from "@tokenmaxxing/db";
import { asc, sql, type SQL } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { Effect, Layer, Schema } from "effect";

import { STATS_CHART_MODEL_LIMIT, StatsResponse, UsageRangeId } from "@tokenmaxxing/api-contract";
import type { StatsRange, StatsRankedMetric } from "@tokenmaxxing/api-contract";

import { makeEdgeJsonCache } from "../cloudflare/edge-cache";
import { Drizzle } from "../database";
import { singleAggregateRow, usageAggregates } from "../usage/aggregates";
import { visibleUsageByUser } from "../usage/visible";
import { collapseChartSeries, roundCents } from "./chart-models";
import {
  makeStatsService,
  STATS_CACHE_TTL_SECONDS,
  StatsRepository,
  StatsService,
} from "./service";

/** Every source is ranked: there are a couple dozen, and the page lists them all. */
const SOURCE_RANK_LIMIT = 64;

/** Inclusive YYYY-MM-DD bounds of the rows a statement reads. */
interface UsageWindow {
  since: string;
  until: string;
}

type Aggregates<Field extends string> = Record<Field, () => SQL<number>>;

/** What a range's totals sum or count. Its day fields come from the daily series. */
const TOTAL_AGGREGATES = {
  cacheCreationTokens: usageAggregates.cacheCreationTokens,
  cacheReadTokens: usageAggregates.cacheReadTokens,
  deviceCount: usageAggregates.deviceCount,
  inputTokens: usageAggregates.inputTokens,
  outputTokens: usageAggregates.outputTokens,
  rowCount: usageAggregates.rowCount,
  spendUsd: usageAggregates.spendUsd,
  totalTokens: usageAggregates.totalTokens,
  userCount: usageAggregates.userCount,
} satisfies Aggregates<string>;

/** What a range reports per ranked model or source. */
const RANKED_AGGREGATES = {
  rowCount: usageAggregates.rowCount,
  spendUsd: usageAggregates.spendUsd,
  totalTokens: usageAggregates.totalTokens,
  userCount: usageAggregates.userCount,
} satisfies Aggregates<string>;

/**
 * The snapshot is six statements, however many ranges there are. Every range
 * ends on `until`, so the ranges nest: the longest one's rows hold all the
 * others, and each range's figure is the same aggregate with a
 * `FILTER (WHERE date >= <its start>)`. One statement carries every range's
 * totals, and one each every range's model and source figures, where each
 * range used to run four statements of its own (27 in all). The aggregates and
 * the rows they cover are the same, so no number moves; only the top-N cut
 * moves into the worker.
 *
 * Cost is the point. The batch is one D1 transaction, and D1 fails every
 * route's queries for seconds once a database uses too much CPU within ten
 * seconds. The 27 statements took about 6.4 seconds of D1 time and 14.8M rows
 * read, and did that on almost every rebuild. These six took about 2 seconds
 * and 1.7M rows (production, November 2026, 156k visible rows in the window),
 * and each added statement or aggregate costs in proportion.
 */
const makeD1StatsRepository = Effect.fn("makeD1StatsRepository")(function* () {
  const database = yield* Drizzle;

  return StatsRepository.of({
    snapshot: ({ limit, ranges, until }) =>
      Effect.gen(function* () {
        const rangeIds = UsageRangeId.literals;
        const starts = rangeIds.map((range) => ranges[range]);
        // The earliest start: its rows hold every range, and the daily series
        // chart each range from its own start.
        const window: UsageWindow = {
          since: starts.reduce((earliest, since) => (since < earliest ? since : earliest)),
          until,
        };
        // One D1 round trip, one consistent read. Batched rows come back as
        // objects keyed by column name, so every statement here must select
        // unique names.
        const [daily, dailyModels, dailySources, totalRows, models, sources] = yield* database.use(
          (db) =>
            db.batch([
              dailyTotals(db, window),
              dailySeries(db, usageDays.model, window),
              dailySeries(db, usageDays.source, window),
              rangeTotals(db, window, starts),
              rangeKeys(db, usageDays.model, window, starts),
              rangeKeys(db, usageDays.source, window, starts),
            ]),
        );
        const totals = yield* singleAggregateRow(totalRows);

        const summaries = rangeIds.map((range, index): [UsageRangeId, StatsRange] => {
          const since = ranges[range];
          // Date-ascending, one row per day with visible usage.
          const days = daily.filter((day) => day.date >= since);

          return [
            range,
            {
              modelsBySpend: rankedKeys(models, index, "spendUsd", limit),
              modelsByTokens: rankedKeys(models, index, "totalTokens", limit),
              since,
              sources: rankedKeys(sources, index, "totalTokens", SOURCE_RANK_LIMIT),
              totals: {
                ...rangeValues(totals, TOTAL_AGGREGATES, index),
                activeDays: days.length,
                firstDate: days[0]?.date ?? null,
                lastDate: days.at(-1)?.date ?? null,
              },
            },
          ];
        });

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

/** The result column holding `field` for the range at `index`. */
function rangeColumn(field: string, index: number): string {
  return `${field}_${index}`;
}

/** Every aggregate once per range start, each over that range's rows only. */
function rangeColumns(aggregates: Aggregates<string>, starts: readonly string[]) {
  const columns: Record<string, SQL.Aliased<number>> = {};
  starts.forEach((since, index) => {
    for (const [field, aggregate] of Object.entries(aggregates)) {
      columns[rangeColumn(field, index)] =
        sql<number>`${aggregate()} filter (where ${usageDays.date} >= ${since})`.as(
          rangeColumn(field, index),
        );
    }
  });

  return columns;
}

/** One range's values out of a `rangeColumns` row. */
function rangeValues<Field extends string>(
  row: Readonly<Record<string, unknown>>,
  aggregates: Aggregates<Field>,
  index: number,
): Record<Field, number> {
  const values = {} as Record<Field, number>;
  for (const field of Object.keys(aggregates) as Field[]) {
    values[field] = Number(row[rangeColumn(field, index)]);
  }

  return values;
}

/**
 * The `limit` keys with the most `metric` in one range, out of rows covering
 * every range. A key with no rows in the range is not part of it. Exact ties
 * go to the later key: SQL leaves their order open, and that is the order
 * SQLite returned them in when `order by <metric> desc limit` made this cut.
 */
function rankedKeys(
  rows: ReadonlyArray<Readonly<Record<string, unknown>>>,
  index: number,
  metric: "spendUsd" | "totalTokens",
  limit: number,
): StatsRankedMetric[] {
  return rows
    .map((row) => ({ key: String(row.key), ...rangeValues(row, RANKED_AGGREGATES, index) }))
    .filter((row) => row.rowCount > 0)
    .sort(
      (left, right) =>
        right[metric] - left[metric] || (left.key > right.key ? -1 : left.key < right.key ? 1 : 0),
    )
    .slice(0, limit);
}

/** Each range's sums, row count and distinct users and devices, as one row. */
function rangeTotals(db: DrizzleD1Database, window: UsageWindow, starts: readonly string[]) {
  return visibleUsageByUser(
    db.select(rangeColumns(TOTAL_AGGREGATES, starts)).from(users).$dynamic(),
    window,
  );
}

/** Each range's `RANKED_AGGREGATES` per model or source seen in the window. */
function rangeKeys(
  db: DrizzleD1Database,
  keyColumn: (typeof usageDays)["model" | "source"],
  window: UsageWindow,
  starts: readonly string[],
) {
  return visibleUsageByUser(
    db
      .select({
        key: sql<string>`${keyColumn}`.as("rank_key"),
        ...rangeColumns(RANKED_AGGREGATES, starts),
      })
      .from(users)
      .$dynamic(),
    window,
  ).groupBy(sql`rank_key`);
}

/** Spend, tokens and distinct users per day. */
function dailyTotals(db: DrizzleD1Database, window: UsageWindow) {
  return visibleUsageByUser(
    db
      .select({
        date: usageDays.date,
        spendUsd: usageAggregates.spendUsd(),
        totalTokens: usageAggregates.totalTokens(),
        userCount: usageAggregates.userCount(),
      })
      .from(users)
      .$dynamic(),
    window,
  )
    .groupBy(usageDays.date)
    .orderBy(asc(usageDays.date));
}

/** Spend and tokens per (date, model) or (date, source) cell. */
function dailySeries(
  db: DrizzleD1Database,
  keyColumn: (typeof usageDays)["model" | "source"],
  window: UsageWindow,
) {
  return visibleUsageByUser(
    db
      .select({
        date: usageDays.date,
        key: sql<string>`${keyColumn}`.as("series_key"),
        spendUsd: usageAggregates.spendUsd(),
        totalTokens: usageAggregates.totalTokens(),
      })
      .from(users)
      .$dynamic(),
    window,
  )
    .groupBy(usageDays.date, sql`series_key`)
    .orderBy(asc(usageDays.date), asc(sql`series_key`));
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
