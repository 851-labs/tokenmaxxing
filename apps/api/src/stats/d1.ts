import { usageDays } from "@tokenmaxxing/db";
import { asc, desc, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { Effect, Layer, Schema } from "effect";

import { STATS_CHART_MODEL_LIMIT, StatsResponse } from "@tokenmaxxing/api-contract";
import type { StatsChartPoint, StatsWindow } from "@tokenmaxxing/api-contract";

import { makeEdgeJsonCache } from "../cloudflare/edge-cache";
import { Drizzle } from "../database";
import { singleAggregateRow, usageAggregates, usageMetric } from "../usage/aggregates";
import { visibleUsage } from "../usage/visible";
import { collapseChartModels } from "./chart-models";
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
        // The chart rows cover both windows; each window slices its own.
        const chartSince = windows.last30d < windows.ytd ? windows.last30d : windows.ytd;
        const [chartRows, ...windowRows] = yield* database.use((db) =>
          db.batch([
            dailyModels(db, chartSince, until),
            ...windowStatements(db, windows.last30d, until, limit),
            ...windowStatements(db, windows.ytd, until, limit),
          ]),
        );
        const [last30d, ytd] = yield* Effect.all([
          statsWindow(windows.last30d, chartRows, [
            windowRows[0],
            windowRows[1],
            windowRows[2],
            windowRows[3],
          ]),
          statsWindow(windows.ytd, chartRows, [
            windowRows[4],
            windowRows[5],
            windowRows[6],
            windowRows[7],
          ]),
        ]);

        return { windows: { last30d, ytd } };
      }),
  });
});

/** The four statements behind one stats window, in `statsWindow` order. */
function windowStatements(db: DrizzleD1Database, since: string, until: string, limit: number) {
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
  since: string,
  chartRows: readonly StatsChartPoint[],
  [totalRows, modelsBySpend, modelsByTokens, sources]: WindowRows,
) {
  return singleAggregateRow(totalRows).pipe(
    Effect.map((windowTotals): StatsWindow => ({
      dailyByModel: collapseChartModels(
        chartRows.filter((row) => row.date >= since),
        STATS_CHART_MODEL_LIMIT,
      ),
      modelsBySpend,
      modelsByTokens,
      since,
      sources,
      totals: windowTotals,
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

function dailyModels(db: DrizzleD1Database, since: string, until: string) {
  return visibleUsage(
    db
      .select({
        date: usageDays.date,
        key: usageDays.model,
        rowCount: usageAggregates.rowCount(),
        spendUsd: usageAggregates.spendUsd(),
        totalTokens: usageAggregates.totalTokens(),
      })
      .from(usageDays)
      .$dynamic(),
    { since, until },
  )
    .groupBy(usageDays.date, usageDays.model)
    .orderBy(asc(usageDays.date), asc(usageDays.model));
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
