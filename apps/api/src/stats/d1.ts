import { usageDays, users, type User } from "@tokenmaxxing/db";
import { and, asc, desc, eq, gte, isNull, sql, type SQL } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { Effect } from "effect";
import { Layer } from "effect";

import type { StatsTotals } from "@tokenmaxxing/api-contract";

import { Drizzle } from "../database";
import { STATS_2026_START, StatsRepository } from "./service";

type StatsTotalsValue = typeof StatsTotals.Type;

const EMPTY_TOTALS: StatsTotalsValue = {
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
};

const makeD1StatsRepository = Effect.fn("makeD1StatsRepository")(function* () {
  const database = yield* Drizzle;

  return StatsRepository.of({
    snapshot: ({ last30dSince, limit }) =>
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
            totals(db, null),
            totals(db, last30dSince),
            totals(db, STATS_2026_START),
            dailyTotals(db),
            rankedBy(db, usageDays.model, null, "spend", limit),
            rankedBy(db, usageDays.model, null, "tokens", limit),
            rankedBy(db, usageDays.model, last30dSince, "spend", limit),
            rankedBy(db, usageDays.model, last30dSince, "tokens", limit),
            rankedBy(db, usageDays.model, STATS_2026_START, "spend", limit),
            rankedBy(db, usageDays.model, STATS_2026_START, "tokens", limit),
            rankedBy(db, usageDays.source, null, "tokens", limit),
            rankedBy(db, usageDays.source, last30dSince, "tokens", limit),
            rankedBy(db, usageDays.source, STATS_2026_START, "tokens", limit),
            usersBy(db, "spend", limit),
            usersBy(db, "tokens", limit),
            dailyModels(db),
          ]),
        );

        return {
          allTime: allTime[0] ?? EMPTY_TOTALS,
          daily,
          dailyByModel,
          last30d: last30d[0] ?? EMPTY_TOTALS,
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
            bySpend: topUsersBySpend.map(toUserMetric),
            byTokens: topUsersByTokens.map(toUserMetric),
          },
          year2026: year2026[0] ?? EMPTY_TOTALS,
        };
      }),
  });
});

function totals(db: DrizzleD1Database, since: string | null) {
  const base = db
    .select({
      activeDates: sql<number>`count(distinct ${usageDays.date})`,
      cacheCreationTokens: sql<number>`coalesce(sum(${usageDays.cacheCreationTokens}), 0)`,
      cacheReadTokens: sql<number>`coalesce(sum(${usageDays.cacheReadTokens}), 0)`,
      deviceCount: sql<number>`count(distinct ${usageDays.deviceId})`,
      firstDate: sql<string | null>`min(${usageDays.date})`,
      inputTokens: sql<number>`coalesce(sum(${usageDays.inputTokens}), 0)`,
      lastDate: sql<string | null>`max(${usageDays.date})`,
      outputTokens: sql<number>`coalesce(sum(${usageDays.outputTokens}), 0)`,
      rowCount: sql<number>`count(*)`,
      totalSpendUsd: sql<number>`coalesce(sum(${usageDays.costUsd}), 0)`,
      totalTokens: sql<number>`coalesce(sum(${usageDays.totalTokens}), 0)`,
      userCount: sql<number>`count(distinct ${usageDays.userId})`,
    })
    .from(usageDays)
    .innerJoin(users, eq(usageDays.userId, users.id));

  return since === null
    ? base.where(isNull(users.shadowBannedAt))
    : base.where(and(isNull(users.shadowBannedAt), gte(usageDays.date, since)));
}

function dailyTotals(db: DrizzleD1Database) {
  return db
    .select({
      date: usageDays.date,
      spendUsd: sql<number>`coalesce(sum(${usageDays.costUsd}), 0)`,
      totalTokens: sql<number>`coalesce(sum(${usageDays.totalTokens}), 0)`,
      userCount: sql<number>`count(distinct ${usageDays.userId})`,
    })
    .from(usageDays)
    .innerJoin(users, eq(usageDays.userId, users.id))
    .where(isNull(users.shadowBannedAt))
    .groupBy(usageDays.date)
    .orderBy(asc(usageDays.date));
}

function dailyModels(db: DrizzleD1Database) {
  return db
    .select({
      costUsd: sql<number>`coalesce(sum(${usageDays.costUsd}), 0)`,
      date: usageDays.date,
      key: usageDays.model,
      outputTokens: sql<number>`coalesce(sum(${usageDays.outputTokens}), 0)`,
      rowCount: sql<number>`count(*)`,
      totalTokens: sql<number>`coalesce(sum(${usageDays.totalTokens}), 0)`,
    })
    .from(usageDays)
    .innerJoin(users, eq(usageDays.userId, users.id))
    .where(isNull(users.shadowBannedAt))
    .groupBy(usageDays.date, usageDays.model)
    .orderBy(asc(usageDays.date), asc(usageDays.model));
}

function rankedBy(
  db: DrizzleD1Database,
  keyColumn: typeof usageDays.model | typeof usageDays.source,
  since: string | null,
  orderBy: "spend" | "tokens",
  limit: number,
) {
  const conditions: SQL[] = [isNull(users.shadowBannedAt)];
  if (since !== null) {
    conditions.push(gte(usageDays.date, since));
  }

  const spendUsd = sql<number>`coalesce(sum(${usageDays.costUsd}), 0)`.as("spend_usd");
  const totalTokens = sql<number>`coalesce(sum(${usageDays.totalTokens}), 0)`.as(
    "total_tokens_sum",
  );

  return db
    .select({
      key: sql<string>`${keyColumn}`.as("rank_key"),
      rowCount: sql<number>`count(*)`,
      spendUsd,
      totalTokens,
      userCount: sql<number>`count(distinct ${usageDays.userId})`,
    })
    .from(usageDays)
    .innerJoin(users, eq(usageDays.userId, users.id))
    .where(and(...conditions))
    .groupBy(sql`rank_key`)
    .orderBy(orderBy === "spend" ? desc(spendUsd) : desc(totalTokens))
    .limit(limit);
}

function usersBy(db: DrizzleD1Database, orderBy: "spend" | "tokens", limit: number) {
  const spendUsd = sql<number>`coalesce(sum(${usageDays.costUsd}), 0)`.as("spend_usd");
  const totalTokens = sql<number>`coalesce(sum(${usageDays.totalTokens}), 0)`.as(
    "total_tokens_sum",
  );

  return db
    .select({
      activeDays: sql<number>`count(distinct ${usageDays.date})`,
      lastDate: sql<string | null>`max(${usageDays.date})`,
      spendUsd,
      totalTokens,
      user: users,
    })
    .from(usageDays)
    .innerJoin(users, eq(usageDays.userId, users.id))
    .where(isNull(users.shadowBannedAt))
    .groupBy(usageDays.userId)
    .orderBy(orderBy === "spend" ? desc(spendUsd) : desc(totalTokens))
    .limit(limit);
}

function toUserMetric(row: {
  activeDays: number;
  lastDate: string | null;
  spendUsd: number;
  totalTokens: number;
  user: User;
}) {
  return {
    activeDays: row.activeDays,
    lastDate: row.lastDate,
    spendUsd: row.spendUsd,
    totalTokens: row.totalTokens,
    user: {
      avatarUrl: row.user.avatarUrl,
      id: row.user.id,
      login: row.user.login,
      name: row.user.name,
    },
  };
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

export { StatsRepositoryLive };
